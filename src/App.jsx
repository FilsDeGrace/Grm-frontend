import React, { useState, useMemo, useCallback, useEffect, useRef } from "react";
import ReactDOM from "react-dom";
import RolloverSystem from "./Rollover";
import CodeAnalyzer from "./CodeAnalyzer";
import ChatLayout from "./ChatLayout";
import { SERVER, LEAGUE_RANK, POOL_MIN_EMPIRICAL_RATE, POOL_SCORE_P_EXP } from "./config";
export { SERVER };
import { THEMES, THEME_MAP, loadSavedTheme, saveTheme, clampR } from "./themes";
import FullModelPage from "./FullModelPage";
import { FAB_FEATURE_TIPS, tipReadDuration } from "./jarvisStore";

// A10-FIX: SAVED_TICKETS_KEY declared at module top so loadSavedTickets()
// and persistTickets() — both hoisted function declarations — never hit a
// temporal dead zone when called before line 4881 executes.
const SAVED_TICKETS_KEY  = "grm_saved_tickets_v15";
// Built tickets are session-scoped and date-keyed — they survive a refresh
// on the same day but are not carried forward to tomorrow.
const BUILT_TICKETS_KEY  = (date) => `grm_built_tickets_${date}`;

// UX-FIX: shared helper to translate raw fetch/network error text into a graceful,
// actionable message instead of showing the browser's literal "Failed to fetch" (or
// similar low-level strings) to the user. Used anywhere a fetch() call can throw —
// the main FETCH flow, snapshot loading, booking, uploads, etc.
function friendlyError(e, context = "Server") {
  const msg = (e && e.message) || String(e || "");
  if (/Failed to fetch|NetworkError|ERR_NAME_NOT_RESOLVED|ERR_INTERNET_DISCONNECTED|net::ERR|TypeError: Load failed/i.test(msg)) {
    return "Can't reach the server — check your connection and try again.";
  }
  if (/timed? ?out|ETIMEDOUT|AbortError/i.test(msg)) {
    return "That took too long to respond. Try again in a moment.";
  }
  if (/50\d\b/.test(msg)) {
    return `${context} is having issues right now — try again shortly.`;
  }
  return msg || `${context} error — please try again.`;
}

// C7-FIX: Prune stale Jarvis cache entries on startup.
// Cache keys are date-suffixed (grm_fm_<id>_YYYY-MM-DD, grm_ca_jarvis_..._YYYY-MM-DD,
// grm_rvl_jarvis_YYYY-MM-DD_...). Without pruning they accumulate indefinitely —
// on a device used daily for 60 days, localStorage fills up and setItem silently
// fails, causing Jarvis to re-fetch every time (appearing as a different bug).
// Runs once synchronously on module load — localStorage ops are fast (< 1ms).
(function pruneJarvisCache() {
  try {
    const cutoff = new Date(Date.now() - 3 * 86400000).toISOString().slice(0, 10);
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const key = localStorage.key(i);
      if (!key?.startsWith("grm_")) continue;
      // Match any key ending in an ISO date string YYYY-MM-DD
      const m = key.match(/(\d{4}-\d{2}-\d{2})(?:_.*)?$/);
      // Also match keys with date embedded in the middle (grm_rvl_jarvis_DATE_ids)
      const m2 = key.match(/grm_rvl_jarvis_(\d{4}-\d{2}-\d{2})/);
      const keyDate = (m2 && m2[1]) || (m && m[1]);
      if (keyDate && keyDate < cutoff) localStorage.removeItem(key);
    }
  } catch { /* storage unavailable — skip silently */ }
})();

// ── ENGINE (inlined) ─────────────────────────────────────────────────────────

// ── UTILITY FUNCTIONS ─────────────────────────────────────────────────────
function safeImpliedOdds(prob) {
  if (!prob || prob <= 0 || prob > 100) return null;
  const raw = 1 / ((prob / 100) * 0.95);
  return isFinite(raw) && raw > 1 ? parseFloat(raw.toFixed(2)) : null;
}

function oddsOrImplied(realOdds, prob) {
  if (realOdds && isFinite(realOdds) && realOdds > 1.01) return parseFloat(realOdds);
  const implied = safeImpliedOdds(prob);
  // Floor at 1.02 — very high-confidence picks (95%+) still deserve a slot in the parlay.
  // Without floor, implied=1.01 fails the >1.0 check in generateTickets and pick is dropped.
  return implied || 1.02;
}

// ── N1-FIX: copyToClipboard — execCommand-only. Safe on Android WebView.
// Root cause of the still-firing permission prompt: navigator.clipboard.writeText()
// triggers the Android permission dialog the moment it is CALLED, before the
// promise rejects — even though we had a .catch fallback. The permission dialog
// fires at call-time, not at resolve/reject time.
// Fix: skip the Async Clipboard API entirely and use execCommand('copy') directly.
// execCommand is synchronous, requires no permission, and works in all Android
// WebViews. Modern desktop browsers also support it as a fallback. The only
// environment that truly needs the Async API is Safari 13.3+ on iOS — but iOS
// does not trigger a visible permission dialog for clipboard, so skipping it is safe.
// Usage: copyToClipboard(text, onSuccess?, onError?)
function copyToClipboard(text, onSuccess, onError) {
  _execCommandCopy(text, onSuccess, onError);
}

function _execCommandCopy(text, onSuccess, onError) {
  try {
    const el = document.createElement("textarea");
    el.value = text;
    // Off-screen but within viewport so iOS doesn't scroll
    el.style.cssText = "position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;pointer-events:none;";
    document.body.appendChild(el);
    el.focus();
    el.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(el);
    if (ok) onSuccess?.();
    else onError?.();
  } catch {
    onError?.();
  }
}

// Infer market string from free-text pick label (used by TicketBookNowButton / buildLegs)
function inferMarket(pick = "") {
  const p = pick.toLowerCase();
  if (/\bwin\b/.test(p))                    return "1X2";
  if (/draw/.test(p))                       return "1X2";
  if (/home or|away or|or away/.test(p))    return "DC";
  if (/btts|both teams/.test(p))            return "BTTS";
  if (/over|under/.test(p)) {
    if (/corner/.test(p))                   return "Corners";
    if (/home|away/.test(p.split("over")[0] + p.split("under")[0])) return "TeamTotal";
    const line = (p.match(/[\d.]+/) || ["2.5"])[0];
    return p.includes("over") ? `Over ${line}` : `Under ${line}`;
  }
  if (/clean sheet|cs/.test(p))             return "CS";
  return "1X2";
}

function evalPickResult(pickLabel, market, hGoals, aGoals, homeName, awayName) {
  if (hGoals == null || aGoals == null) return null;
  const total = hGoals + aGoals, p = pickLabel || "", m = market || "";
  if (p === "Over 1.5 Goals"  || m === "Over 1.5")  return total > 1 ? "WIN" : "LOSS";
  if (p === "Over 2.5 Goals"  || m === "Over 2.5")  return total > 2 ? "WIN" : "LOSS";
  if (p === "Over 3.5 Goals"  || m === "Over 3.5")  return total > 3 ? "WIN" : "LOSS";
  if (p === "Over 4.5 Goals"  || m === "Over 4.5")  return total > 4 ? "WIN" : "LOSS";
  if (p === "Under 1.5 Goals" || m === "Under 1.5") return total < 2 ? "WIN" : "LOSS";
  if (p === "Under 2.5 Goals" || m === "Under 2.5") return total < 3 ? "WIN" : "LOSS";
  if (p === "Under 3.5 Goals" || m === "Under 3.5") return total < 4 ? "WIN" : "LOSS";
  if (p === "Under 4.5 Goals" || m === "Under 4.5") return total < 5 ? "WIN" : "LOSS";
  if (p === "BTTS Yes") return (hGoals > 0 && aGoals > 0) ? "WIN" : "LOSS";
  if (p === "BTTS No")  return (hGoals === 0 || aGoals === 0) ? "WIN" : "LOSS";
  if (p === "Draw")     return hGoals === aGoals ? "WIN" : "LOSS";
  if (m === "DC") {
    // E4-FIX: Fragile 6-char slug match (awayName.slice(0,6)) caused collisions on teams
    // sharing a name prefix (e.g. "Manchester City" vs "Manchester United" → both "manche").
    // Also, pLow.includes("or draw") broke when pick was formatted as "Draw or Away".
    // Fix: match against canonical DC pick labels in all supported formats.
    const pLow = p.toLowerCase().trim();
    // 1X / Home or Draw / Home Win or Draw
    const is1X = pLow === "1x" || pLow === "home or draw" || pLow === "draw or home" || pLow.startsWith("home win or draw") || pLow.startsWith("home or draw");
    // X2 / Away or Draw / Draw or Away
    const isX2 = pLow === "x2" || pLow === "draw or away" || pLow === "away or draw" || pLow.startsWith("away win or draw") || pLow.startsWith("draw or away");
    // 12 / Home or Away (no draw)
    const is12 = pLow === "12" || pLow === "home or away" || pLow === "away or home";
    if (is1X) return hGoals >= aGoals ? "WIN" : "LOSS";  // home win OR draw
    if (isX2) return aGoals >= hGoals ? "WIN" : "LOSS";  // away win OR draw
    if (is12) return hGoals !== aGoals ? "WIN" : "LOSS"; // either team wins (no draw)
    // Unrecognised DC pick format — fall through to null
    return null;
  }
  if (homeName && p === `${homeName} Win`) return hGoals > aGoals ? "WIN" : "LOSS";
  if (awayName && p === `${awayName} Win`) return aGoals > hGoals ? "WIN" : "LOSS";
  if (p.endsWith(" Win")) {
    if (homeName && p.startsWith(homeName.slice(0, 6))) return hGoals > aGoals ? "WIN" : "LOSS";
    if (awayName && p.startsWith(awayName.slice(0, 6))) return aGoals > hGoals ? "WIN" : "LOSS";
  }
  if (p.includes("to Score") || p.includes("O0.5")) {
    const isHome = homeName && p.startsWith(homeName.slice(0, 6));
    return (isHome ? hGoals : aGoals) > 0 ? "WIN" : "LOSS";
  }
  if (p.includes("O1.5") || p.includes("Over 1.5")) {
    const isHome = homeName && p.startsWith(homeName.slice(0, 6));
    return (isHome ? hGoals : aGoals) > 1 ? "WIN" : "LOSS";
  }
  return null;
}

function abbreviatePick(pick, home, away) {
  if (!pick) return null;

  // Standard market names — shorten inline
  const SHORT_MAP = {
    "Over 1.5 Goals": "O1.5", "Over 2.5 Goals": "O2.5",
    "Over 3.5 Goals": "O3.5", "Over 4.5 Goals": "O4.5",
    "Under 1.5 Goals": "U1.5", "Under 2.5 Goals": "U2.5",
    "Under 3.5 Goals": "U3.5", "Under 4.5 Goals": "U4.5",
    "Over 1.5": "O1.5", "Over 2.5": "O2.5",
    "Over 3.5": "O3.5", "Over 4.5": "O4.5",
    "Under 1.5": "U1.5", "Under 2.5": "U2.5",
    "Under 3.5": "U3.5", "Under 4.5": "U4.5",
    "BTTS Yes": "BTTS ✓", "BTTS No": "BTTS ✗",
    "Draw": "Draw",
  };
  if (SHORT_MAP[pick]) return SHORT_MAP[pick];

  // Win picks
  if (home && pick === `${home} Win`) {
    const candidate = home.length <= 8 ? `${home} Win` : "Home Win";
    return candidate;
  }
  if (away && pick === `${away} Win`) {
    const candidate = away.length <= 8 ? `${away} Win` : "Away Win";
    return candidate;
  }
  // Fallback for partial name match (slice-based from evalPickResult)
  if (pick.endsWith(" Win")) {
    const teamPart = pick.slice(0, -4);
    if (home && home.startsWith(teamPart)) return home.length <= 8 ? `${home} Win` : "Home Win";
    if (away && away.startsWith(teamPart)) return away.length <= 8 ? `${away} Win` : "Away Win";
    return teamPart.length <= 8 ? pick : "Home Win";
  }

  // "to Score" / O0.5 team total
  const toScorePattern = /^(.+?)\s+(?:to Score|O0\.5)$/i;
  const toScoreMatch = pick.match(toScorePattern);
  if (toScoreMatch) {
    const teamName = toScoreMatch[1];
    const isHome = home && (pick.startsWith(home) || teamName === home);
    const role = isHome ? "H" : "A";
    const candidate = teamName.length <= 6 ? `${teamName} O0.5` : `${role} O0.5`;
    return candidate.length <= 12 ? candidate : `${role} O0.5`;
  }

  // O1.5 team total
  const o15Pattern = /^(.+?)\s+O1\.5$/i;
  const o15Match = pick.match(o15Pattern);
  if (o15Match) {
    const teamName = o15Match[1];
    const isHome = home && (pick.startsWith(home) || teamName === home);
    const role = isHome ? "H" : "A";
    const candidate = teamName.length <= 6 ? `${teamName} O1.5` : `${role} O1.5`;
    return candidate.length <= 12 ? candidate : `${role} O1.5`;
  }

  // Goal Radar picks formatted as "TeamName O0.5" or "TeamName O1.5"
  if (home && pick.startsWith(home)) {
    const suffix = pick.slice(home.length).trim();
    const short = suffix.replace("to Score", "O0.5").replace("Over 0.5", "O0.5").replace("Over 1.5", "O1.5");
    const candidate = `H ${short}`;
    return candidate.length <= 12 ? candidate : `H ${short.slice(0, 8)}`;
  }
  if (away && pick.startsWith(away)) {
    const suffix = pick.slice(away.length).trim();
    const short = suffix.replace("to Score", "O0.5").replace("Over 0.5", "O0.5").replace("Over 1.5", "O1.5");
    const candidate = `A ${short}`;
    return candidate.length <= 12 ? candidate : `A ${short.slice(0, 8)}`;
  }

  // DC picks — usually short enough, just hard-cap
  if (pick.length <= 12) return pick;
  return pick.slice(0, 11) + "…";
}

// ── CUSTOM PICK HELPERS ───────────────────────────────────────────────────
function getCustomPick(f, family, C) {
  const m = f.markets, io = safeImpliedOdds;
  if (family === "theRead") {
    if (!f.theRead?.anchor) return null;
    const a = f.theRead.anchor, mst = mktStyle(a.market);
    return { label:a.pick, prob:a.prob, odds:a.odds||io(a.prob), color:mst.color, market:a.market };
  }
  if (family === "theEdge") {
    if (!f.theEdge) return null;
    return { label:f.theEdge.pick, prob:f.theEdge.prob, odds:f.theEdge.odds||io(f.theEdge.prob), color:C?.edge, market:f.theEdge.market };
  }
  if (family === "goalRadar") {
    const best = f.goalRadar?.home?.prob >= f.goalRadar?.away?.prob ? f.goalRadar?.home : f.goalRadar?.away;
    if (!best) return null;
    return { label:best.pick, prob:best.prob, odds:best.odds||io(best.prob), color:C?.radar, market:"TeamTotal" };
  }
  // Legacy safeBet/valuePick compat for old snapshots
  if (family === "safeBet") {
    if (!f.safeBet) return null;
    const mst = mktStyle(f.safeBet.market);
    return { label:f.safeBet.pick, prob:f.safeBet.prob, odds:f.safeBet.odds||io(f.safeBet.prob), color:mst.color, market:f.safeBet.market };
  }
  const map = {
    "over15":  { label:"Over 1.5",  prob:m.over15,   odds:io(m.over15),   color:C?.green  },
    "over25":  { label:"Over 2.5",  prob:m.over25,   odds:io(m.over25),   color:C?.green  },
    "over35":  { label:"Over 3.5",  prob:m.over35,   odds:io(m.over35),   color:C?.green  },
    "over45":  { label:"Over 4.5",  prob:m.over45,   odds:io(m.over45),   color:C?.green  },
    "under15": { label:"Under 1.5", prob:parseFloat((100-(m.over15||0)).toFixed(1)), odds:io(100-(m.over15||0)), color:C?.blue },
    "under25": { label:"Under 2.5", prob:m.under25,  odds:io(m.under25),  color:C?.blue   },
    "under35": { label:"Under 3.5", prob:m.under35,  odds:io(m.under35),  color:C?.blue   },
    "under45": { label:"Under 4.5", prob:m.under45,  odds:io(m.under45),  color:C?.blue   },
    "bttsyes": { label:"BTTS Yes",  prob:m.bttsYes,  odds:f.odds?.bttsYesOdds||io(m.bttsYes), color:C?.purple },
    "bttsno":  { label:"BTTS No",   prob:m.bttsNo,   odds:f.odds?.bttsNoOdds||io(m.bttsNo),   color:C?.purple },
    "homewin": { label:`${f.teams.home} Win`, prob:m.homeWin, odds:f.odds?.o1||io(m.homeWin), color:C?.gold, market:"1X2" },
    "draw":    { label:"Draw",      prob:m.draw,     odds:f.odds?.oX||io(m.draw), color:C?.gold, market:"1X2" },
    "awaywin": { label:`${f.teams.away} Win`, prob:m.awayWin, odds:f.odds?.o2||io(m.awayWin), color:C?.gold, market:"1X2" },
    "homeo05": { label:`${f.teams.home} O0.5`, prob:m.homeOver05, odds:io(m.homeOver05), color:C?.radar, market:"TeamTotal" },
    "homeo15": { label:`${f.teams.home} O1.5`, prob:m.homeOver15, odds:io(m.homeOver15), color:C?.radar, market:"TeamTotal" },
    "awayo05": { label:`${f.teams.away} O0.5`, prob:m.awayOver05, odds:io(m.awayOver05), color:C?.radar, market:"TeamTotal" },
    "awayo15": { label:`${f.teams.away} O1.5`, prob:m.awayOver15, odds:io(m.awayOver15), color:C?.radar, market:"TeamTotal" },
  };
  return map[family] || null;
}

const CUSTOM_FAMILIES = [
  { id:"theRead",   label:"The Read"   },
  { id:"theEdge",   label:"The Edge" },
  { id:"goalRadar", label:"Goal Radar" },
  { id:"over15",label:"O1.5" }, { id:"over25",label:"O2.5" }, { id:"over35",label:"O3.5" }, { id:"over45",label:"O4.5" },
  { id:"under15",label:"U1.5" }, { id:"under25",label:"U2.5" }, { id:"under35",label:"U3.5" }, { id:"under45",label:"U4.5" },
  { id:"bttsyes",label:"BTTS Yes" }, { id:"bttsno",label:"BTTS No" },
  { id:"homewin",label:"Home Win" }, { id:"draw",label:"Draw" }, { id:"awaywin",label:"Away Win" },
  { id:"homeo05",label:"H O0.5" }, { id:"homeo15",label:"H O1.5" }, { id:"awayo05",label:"A O0.5" }, { id:"awayo15",label:"A O1.5" },
];

// ── EXCLUDE SELECTION GROUPS ─────────────────────────────────────────────
// Same two-tier shape as Custom Pick (market family → individual line/option),
// but used for exclusion: each option gets its own toggle so a single line
// (e.g. "Draw" or "Home or Away") can be excluded without nuking the whole family.
const EXCLUDE_SELECTION_GROUPS = [
  { label:"1X2", options:[
      { id:"homewin", label:"Home Win" },
      { id:"draw",    label:"Draw" },
      { id:"awaywin", label:"Away Win" },
  ]},
  { label:"Double Chance", options:[
      { id:"dc_1x", label:"Home or Draw" },
      { id:"dc_x2", label:"Away or Draw" },
      { id:"dc_12", label:"Home or Away" },
  ]},
  { label:"BTTS", options:[
      { id:"bttsyes", label:"BTTS Yes" },
      { id:"bttsno",  label:"BTTS No" },
  ]},
  { label:"Goals O/U", options:[
      { id:"Over 1.5",  label:"Over 1.5" },
      { id:"Over 2.5",  label:"Over 2.5" },
      { id:"Over 3.5",  label:"Over 3.5" },
      { id:"Under 2.5", label:"Under 2.5" },
      { id:"Under 3.5", label:"Under 3.5" },
      { id:"Under 4.5", label:"Under 4.5" },
  ]},
  { label:"Team Total", options:[
      { id:"home_tt", label:"Home Team O/U" },
      { id:"away_tt", label:"Away Team O/U" },
  ]},
];

// Classifies a pick (label + market, optionally a fixture for team names) into one
// of the granular ids above. Falls back to the raw market string for goals O/U
// (those market values — "Over 2.5", "Under 3.5", etc — are already line-specific).
function getExcludeSelectionId(pick, f) {
  const label  = (pick?.label ?? pick?.pick ?? "").trim();
  const market = pick?.market || "";
  const pLow   = label.toLowerCase();
  const home = f?.teams?.home, away = f?.teams?.away;

  if (market === "1X2" || pLow === "draw" || /\bwin\b/.test(pLow)) {
    if (pLow === "draw") return "draw";
    if (home && label === `${home} Win`) return "homewin";
    if (away && label === `${away} Win`) return "awaywin";
    if (pLow.endsWith(" win")) {
      const teamPart = label.slice(0, -4);
      if (home && home.startsWith(teamPart)) return "homewin";
      if (away && away.startsWith(teamPart)) return "awaywin";
    }
    return "homewin";
  }
  if (market === "DC" || /home or|away or|or away|or draw|^1x$|^x2$|^12$/.test(pLow)) {
    if (pLow.includes("home or draw") || pLow.startsWith("home win or draw") || pLow === "1x") return "dc_1x";
    if (pLow.includes("away or draw") || pLow.includes("draw or away") || pLow === "x2") return "dc_x2";
    return "dc_12";
  }
  if (market === "BTTS" || /btts|both teams/.test(pLow)) {
    return pLow.includes("no") ? "bttsno" : "bttsyes";
  }
  if (market === "TeamTotal" || /to score|o0\.5|o1\.5/i.test(label)) {
    if (home && label.startsWith(home)) return "home_tt";
    if (away && label.startsWith(away)) return "away_tt";
    return "home_tt";
  }
  // Goals O/U — market is already "Over X.5" / "Under X.5"
  if (market) return market;
  const m = label.match(/(Over|Under)\s*([\d.]+)/i);
  if (m) return `${m[1][0].toUpperCase()}${m[1].slice(1).toLowerCase()} ${m[2]}`;
  return label || market;
}

export const STRATEGY_LABELS = {
  home_win:"Home Win", away_win:"Away Win", btts_value:"BTTS Value",
  home_goalfest:"H Goalfest", away_goalfest:"A Goalfest",
  over25_quality:"O2.5 Quality", low_scoring:"Low Scoring",
  draw:"Draw",
};

function xgHomeDominant(f){ return f.markets.homeXG >= f.markets.awayXG*2 && (f.markets.homeXG - f.markets.awayXG) >= 1; }
function xgAwayDominant(f){ return f.markets.awayXG >= f.markets.homeXG*2 && (f.markets.awayXG - f.markets.homeXG) >= 1; }

const makeStatFilters = (xgT, thr, xgHomeT, xgAwayT) => {
  const hT = xgHomeT ?? xgT;
  const aT = xgAwayT ?? xgT;
  return [
  { id:"has_read",      label:"Has Read",         desc:"Has a non-fallback Read pick",      fn:f=>!!(f.theRead && !f.theRead.isFallback) },
  { id:"has_edge",      label:"Has Edge",          desc:"Edge signal found",                 fn:f=>!!f.theEdge },
  { id:"has_radar",     label:"Goal Radar",        desc:"At least one team in Goal Radar",   fn:f=>!!f.goalRadar },
  { id:"btts_q",        label:`BTTS ≥${thr.btts}%`,   desc:`BTTS Yes ≥${thr.btts}%`,      fn:f=>f.markets.bttsYes>=thr.btts },
  // xG filters — fine-grained control
  { id:"xg_home_min",   label:`Home xG ≥${hT}`,   desc:`Home team xG ≥${hT}`,              fn:f=>f.markets.homeXG>=hT },
  { id:"xg_away_min",   label:`Away xG ≥${aT}`,   desc:`Away team xG ≥${aT}`,              fn:f=>f.markets.awayXG>=aT },
  // xg_both renamed to Total xG — logic changed from "both teams individually ≥X"
  // to "combined total ≥X". The old fn was too restrictive (required EACH team ≥X)
  // which silently excluded games where one team drives total xG (e.g. 2.4 + 0.8).
  // xg_home_min and xg_away_min remain as individual per-team filters above.
  { id:"xg_both",       label:`Total xG ≥${xgT}`,  desc:`Home+Away combined xG ≥${xgT}`,   fn:f=>(f.markets.homeXG+f.markets.awayXG)>=xgT },
  { id:"xg_total_high", label:`Total xG ≥${(xgT*1.8).toFixed(1)}`, desc:`Home+Away xG ≥${(xgT*1.8).toFixed(1)}`, fn:f=>(f.markets.homeXG+f.markets.awayXG)>=(xgT*1.8) },
  { id:"xg_home",       label:"Home xG Dom",       desc:"Home xG 2× away + gap ≥1",         fn:f=>xgHomeDominant(f) },
  { id:"xg_away",       label:"Away xG Dom",       desc:"Away xG 2× home + gap ≥1",         fn:f=>xgAwayDominant(f) },
  { id:"cs_home",       label:`Home CS ≥${thr.csHome}%`, desc:`Home clean sheet ≥${thr.csHome}%`, fn:f=>f.markets.homeCS>=thr.csHome },
  { id:"cs_away",       label:`Away CS ≥${thr.csAway}%`, desc:`Away clean sheet ≥${thr.csAway}%`, fn:f=>f.markets.awayCS>=thr.csAway },
  { id:"def_weak_home", label:"H Def Weak",        desc:"Home CS < 20%",                    fn:f=>f.markets.homeCS<20 },
  { id:"def_weak_away", label:"A Def Weak",         desc:"Away CS < 20%",                    fn:f=>f.markets.awayCS<20 },
  { id:"homewin_str",   label:`H Win ≥${thr.hWin}%`,  desc:`Home win ≥${thr.hWin}%`,      fn:f=>f.markets.homeWin>=thr.hWin },
  { id:"awaywin_str",   label:`A Win ≥${thr.aWin}%`,  desc:`Away win ≥${thr.aWin}%`,      fn:f=>f.markets.awayWin>=thr.aWin },
  { id:"odds_floor",    label:`Odds ≥${thr.oddsFloor}`, desc:`Read/Edge odds ≥${thr.oddsFloor}`, fn:f=>{ const o=f.theRead?.anchor?.odds||f.theEdge?.odds; return o!=null ? o>=thr.oddsFloor : true; } },
  { id:"low_xg",        label:"Low xG",            desc:"Total xG < 2.0",                   fn:f=>(f.markets.homeXG+f.markets.awayXG)<2.0 },
  { id:"volatile",      label:"Volatile",          desc:"Volatile league",                  fn:f=>!!f.volatileLeague },
  { id:"live",      label:"LIVE",     desc:"Currently in progress",
    icon:<svg width="9" height="9" viewBox="0 0 8 8"><circle cx="4" cy="4" r="4" fill="currentColor" opacity=".25"/><circle cx="4" cy="4" r="2.5" fill="currentColor"/></svg>,
    fn:f=>{ const s=(f.state||"").toLowerCase(); return ["inprogress","live","1h","1sthalf","ht","halftime","2h","2ndhalf","et","extratime","penaltyshootout"].includes(s); } },
  { id:"scheduled", label:"Upcoming", desc:"Not yet started",
    icon:<svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>,
    fn:f=>{ const s=(f.state||"").toLowerCase(); return s===""||s==="notstarted"||s==="scheduled"||s==="prematch"; } },
  { id:"draw_prob",     label:"Draw ≥30%",         desc:"Draw probability ≥30%",            fn:f=>f.markets.draw>=30 },
  { id:"draw_balanced", label:"Balanced",          desc:"|homeWin−awayWin| ≤15",            fn:f=>Math.abs((f.markets.homeWin||0)-(f.markets.awayWin||0))<=15 },
  { id:"draw_xg_range", label:"xG 1.4–2.6",       desc:"Total xG between 1.4 and 2.6",     fn:f=>{ const t=(f.markets.homeXG||0)+(f.markets.awayXG||0); return t>=1.4&&t<=2.6; } },
  ];
};

// Strategy labels — user-facing names, no emojis, no internal filter IDs
const STRATEGIES_UI = [
  { id:"home_win",
    label:"Home Win",
    filters:["homewin_str"],
    family:"homewin",
    desc:"Home xG dominance ≥0.9 gap · home model win ≥65%",
    hint:"Strong home sides with clear statistical edge over the visitor" },
  { id:"away_win",
    label:"Away Win",
    filters:["awaywin_str"],
    family:"awaywin",
    desc:"Away xG edge ≥0.7 · away model win ≥55%",
    hint:"Away teams the model rates as favourites despite home advantage" },
  { id:"btts_value",
    label:"BTTS",
    filters:["btts_q"],
    family:"bttsyes",
    desc:"Both teams score ≥65% · both teams O0.5 ≥70%",
    hint:"Games where both teams have demonstrated scoring threat" },
  { id:"over25_quality",
    label:"Over 2.5",
    filters:["xg_both","btts_q"],
    family:"over25",
    desc:"Total xG ≥2.6 · O2.5 model ≥70% · BTTS ≥55%",
    hint:"High-xG games with multiple goal signals converging" },
  { id:"low_scoring",
    label:"Under 2.5",
    filters:["cs_home","cs_away"],
    family:"under25",
    desc:"Both teams clean sheet ≥30% · total xG <2.0 · U2.5 ≥65%",
    hint:"Tactically tight games — both teams defensive, low xG" },
  { id:"draw",
    label:"Draw",
    filters:["draw_prob","draw_balanced","draw_xg_range"],
    family:"draw",
    desc:"Draw ≥30% · balanced win probabilities · xG 1.4–2.6",
    hint:"Evenly matched games where a point each is the likeliest result" },
  { id:"home_goalfest",
    label:"Home Attack",
    filters:["homewin_str"],
    family:"homeo15",
    desc:"Home xG ≥2.2 · home to score ≥88% probability",
    hint:"Dominant home attack expected to score regardless of result" },
  { id:"away_goalfest",
    label:"Away Attack",
    filters:["awaywin_str"],
    family:"awayo15",
    desc:"Away xG ≥2.0 · away to score ≥85% probability",
    hint:"High-scoring away side with strong attacking xG" },
];

// ── TICKET HELPERS ────────────────────────────────────────────────────────
// C6-FIX: migrate tickets from any prior version key so saves don't silently vanish
// after an app version bump. Try current key first; if empty, scan for the most
// recent prior-version data and migrate it forward under the new key.
const SAVED_TICKETS_LEGACY_KEYS = [
  "grm_saved_tickets_v14",
  "grm_saved_tickets_v13",
  "grm_saved_tickets_v12",
  "grm_saved_tickets",
];
function loadSavedTickets() {
  try {
    const current = JSON.parse(localStorage.getItem(SAVED_TICKETS_KEY) || "[]");
    if (Array.isArray(current) && current.length > 0) return current;
    // Current key empty — try migrating from a legacy key
    for (const legacyKey of SAVED_TICKETS_LEGACY_KEYS) {
      try {
        const legacy = JSON.parse(localStorage.getItem(legacyKey) || "[]");
        if (Array.isArray(legacy) && legacy.length > 0) {
          // Migrate to current key and clean up old one
          localStorage.setItem(SAVED_TICKETS_KEY, JSON.stringify(legacy));
          try { localStorage.removeItem(legacyKey); } catch {}
          return legacy;
        }
      } catch {}
    }
    return [];
  } catch { return []; }
}
function persistTickets(tickets) { try { localStorage.setItem(SAVED_TICKETS_KEY, JSON.stringify(tickets)); } catch {} }
function generateTicketCode() {
  // Use 8 chars of random base-36 — virtually no collision risk
  return "T" + Math.random().toString(36).slice(2, 6).toUpperCase()
             + Math.random().toString(36).slice(2, 6).toUpperCase();
}

// ── PARLEY ENGINE ─────────────────────────────────────────────────────────
// ── UNIVERSAL PARLEY ENGINE v1.0 ─────────────────────────────────────────
// Single pool + single builder used by both Builder and Jarvis.
// Calibrated from Apr 4–24 backtest (723 resolved games).

// Market base rates: long-run football priors, used when backtest sample is thin.
// Derived from large-sample European football data (thousands of matches).
// These replace the flat 0.55 fallback — each market has a meaningfully different base.
const MARKET_BASE_RATES = {
  "Over 1.5":  0.76,   // ~76% of games have 2+ goals
  "Over 2.5":  0.53,   // ~53% of games have 3+ goals
  "Over 3.5":  0.28,   // ~28% of games have 4+ goals
  "Under 2.5": 0.47,
  "Under 3.5": 0.72,
  "Under 4.5": 0.87,
  "BTTS":      0.51,   // ~51% both teams score
  "1X2":       0.46,   // home win base rate
  "DC":        0.70,   // double chance — high base by design
  "TeamTotal": 0.72,   // team to score O0.5
  _default:    0.52,
};

const CALIBRATION = {
  oddsFloor: {
    "Over 1.5":1.18, "Under 3.5":1.15, "Under 4.5":1.15,
    "Over 2.5":1.15, "Under 2.5":1.15, "Over 3.5":1.15,
    "BTTS":1.15, "1X2":1.15, "DC":1.15, "TeamTotal":1.15, _default:1.15,
  },
  blockedMarkets: new Set(["TeamTotal"]),  // TT uses Goal Radar, never a Read anchor
  bttsMinConf: 65,        // was 80 — too strict, only 12 picks entered; strategy data shows 76.8% at full volume
  under35Guards: { maxOver25:37, minSeasonGames:10 },  // minSeasonGames was 16, too aggressive
  volatileLeagues: {
    "J1 League, East":           { boostRequired:5 },
    "Liga de Expansion MX, Clausura":{ boostRequired:5 },
    "Pro League":                { boostRequired:5 },
    "Liga 1, Apertura":          { boostRequired:8 },
    "Division 1":                { boostRequired:5 },
    "League One":                { boostRequired:5 },
    "Challenger Pro League":     { boostRequired:5 },
    "I liga":                    { boostRequired:5 },
  },
  volatileAffectedMarkets: new Set(["Under 3.5","Under 2.5","BTTS"]),
  oddsLogBase: Math.E,
  modifiers: { lowConfPenalty:0.80, volatilePenalty:0.85, strongBoost:1.15, stratBoost:1.10 },
};

function getOddsFloor(market) {
  return CALIBRATION.oddsFloor[market] ?? CALIBRATION.oddsFloor._default;
}

// Three-tier empirical rate lookup:
// 1. Prob band (market + confidence band) — most specific, needs 5+ samples
// 2. Market level — needs 5+ samples
// 3. Market base rate — long-run football prior, never a flat number
function getEmpiricalRate(market, conf, historicalRates) {
  const band     = `${Math.floor(conf/5)*5}-${Math.floor(conf/5)*5+5}`;
  const bandData = historicalRates?.byProbBand?.[`${market}:${band}`];
  if (bandData?.total >= 5) return bandData.rate / 100;
  const mktData = historicalRates?.byMarket?.[market];
  if (mktData?.total >= 5) return mktData.rate / 100;
  return MARKET_BASE_RATES[market] ?? MARKET_BASE_RATES._default;
}
function isLeagueVolatile(league) { return league in CALIBRATION.volatileLeagues; }
function getVolatileBoost(league) { return CALIBRATION.volatileLeagues[league]?.boostRequired ?? 0; }

function evaluatePick(f, historicalRates) {
  const anchor = f.theRead?.anchor;
  if (!anchor || f.theRead?.isFallback) return null;
  const { market, prob:conf, odds:rawOdds, pick } = anchor;
  if (CALIBRATION.blockedMarkets.has(market)) return null;
  // TeamTotal anchors are already blocked by CALIBRATION.blockedMarkets.has(market) above.
  // The anchor.type === "tt" check below is dead code — getRead() never sets anchor.type.
  // Left as a defensive guard in case a future code path sets anchor.role for team-scoped picks.
  if (anchor.role) return null;
  const state = (f.state || "").toLowerCase().replace(/[\s_\-]/g, "");
  const BLOCKED_STATES = new Set([
    // finished
    "finished","ft","fulltime","ended","complete","aet","afterextratime","afterpenalties",
    // live / in-play — can't book these
    "1h","1sthalf","ht","halftime","2h","2ndhalf","et","extratime","penaltyshootout","inprogress","live",
    // cancelled / disrupted
    "postponed","ppd","suspended","interrupted","abandoned","cancelled","canceled","deleted",
  ]);
  if (BLOCKED_STATES.has(state)) return null;
  if (!conf || conf <= 0) return null;
  if (market === "BTTS" && conf < CALIBRATION.bttsMinConf) return null;
  if (market === "Under 3.5" || market === "Under 3.5 Goals") {
    const over25 = f.markets?.over25 ?? 0;
    const seasonGames = f.markets?._seasonGames ?? 99;
    if (over25 >= CALIBRATION.under35Guards.maxOver25 + 1) return null;
    if (seasonGames < CALIBRATION.under35Guards.minSeasonGames) return null;
  }
  const league = f.league || "";
  if (isLeagueVolatile(league) && CALIBRATION.volatileAffectedMarkets.has(market)) {
    const boost = getVolatileBoost(league);
    const minRequired = (market === "BTTS" ? CALIBRATION.bttsMinConf : 65) + boost;
    if (conf < minRequired) return null;
  }
  const odds = oddsOrImplied(rawOdds, conf);
  if (!odds || !isFinite(odds) || odds <= 1.0) return null;
  if (odds < getOddsFloor(market)) return null;

  const empiricalRate = getEmpiricalRate(market, conf, historicalRates);

  // Pool qualification guard — reject low hit-rate picks before they enter.
  // Kills draws (~33%), longshot 1X2, and volatile speculative picks.
  if (empiricalRate < POOL_MIN_EMPIRICAL_RATE) return null;

  // Scoring formula: p² × ln(o)/o
  // p² makes probability dominant — a 72% pick outranks a 45% pick regardless of odds.
  // ln(o)/o peaks at o=e≈2.718 then decays, so odds above ~2.7 are actively penalised.
  // Sweet spot naturally emerges around 1.40–1.70 odds with 65–80% empirical rate.
  const lnO     = Math.log(odds);                                    // natural log
  const pExp    = Math.pow(empiricalRate, POOL_SCORE_P_EXP);         // p²
  let score     = pExp * (lnO / odds);                               // p² × ln(o)/o
  if (f.markets?._lowConfidence)  score *= CALIBRATION.modifiers.lowConfPenalty;
  if (f.volatileLeague)           score *= CALIBRATION.modifiers.volatilePenalty;
  if (anchor.strong)              score *= CALIBRATION.modifiers.strongBoost;
  if (f.strategyTags?.length > 0) score *= CALIBRATION.modifiers.stratBoost;

  // Utility: score / (1 - empiricalRate) — penalises legs likely to kill the parlay.
  // A 78% pick at 1.35 odds ranks above a 65% pick at 1.60 even if raw scores are close.
  const utility = score / Math.max(0.01, 1 - empiricalRate);

  return {
    fixtureId:     f.id,
    game:          `${f.teams.home} vs ${f.teams.away}`,
    pick, odds: parseFloat(odds.toFixed(2)), conf, market, league, score, utility,
    empiricalRate: parseFloat((empiricalRate * 100).toFixed(1)),
    strategyLabel: anchor.strong ? "STRONG" : "Read",
    strategyTags:  f.strategyTags || [],
    isVolatile:    isLeagueVolatile(league),
    fixture:       f,
  };
}

// C6-FIX: Uniform Fisher-Yates shuffle using crypto.getRandomValues.
// sort(() => Math.random() - 0.5) is NOT a uniform shuffle on V8 — for arrays
// of 3-8 entries it produces systematically biased orderings, meaning tickets 2
// and 3 in a multi-build share more legs than expected. This replaces all six
// biased sort calls in buildManualParlays and buildManualParlaysFromPool.
function shuffle(arr) {
  const a = [...arr];
  const rng = new Uint32Array(a.length);
  crypto.getRandomValues(rng);
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor((rng[i] / 0xFFFFFFFF) * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function buildUniversalPool(fixtures, historicalRates) {
  const pool = [];
  for (const f of fixtures) {
    const entry = evaluatePick(f, historicalRates);
    if (entry) {
      // Write empiricalRate and sampleSize back onto the anchor so TheReadSection
      // can display them. evaluatePick computes these but never attaches them to
      // the fixture object — the card was always showing a blank hit-rate line.
      if (f.theRead?.anchor) {
        f.theRead.anchor.empiricalRate = entry.empiricalRate;
        // sampleSize: use the most specific tier that had enough data
        const conf    = f.theRead.anchor.prob;
        const market  = f.theRead.anchor.market;
        const band    = `${Math.floor(conf/5)*5}-${Math.floor(conf/5)*5+5}`;
        const bandData = historicalRates?.byProbBand?.[`${market}:${band}`];
        const mktData  = historicalRates?.byMarket?.[market];
        f.theRead.anchor.sampleSize = bandData?.total >= 5
          ? bandData.total
          : mktData?.total >= 5
          ? mktData.total
          : null; // base rate fallback — no real sample to show
      }
      pool.push(entry);
      // A2-FIX: carry sampleSize onto the pool entry so buildRolloverPick's
      // (p.sampleSize ?? 99) < 5 guard actually fires. Without this copy the
      // guard always defaults to 99 and thin-data picks slip through unchecked.
      entry.sampleSize = f.theRead?.anchor?.sampleSize ?? null;
    }
  }
  // Sort by utility (score / (1-p)) — surfaces picks that are both high quality
  // and unlikely to kill the parlay, not just raw score.
  return pool.sort((a, b) => b.utility - a.utility);
}

// Builds a single parley — runs until pool exhausted or target hit (no leg cap).
function buildOneParlayFromPool(pool, usedIds, target, stake) {
  const legs = []; let prod = 1.0, hitTarget = false;
  for (const entry of pool) {
    if (usedIds.has(entry.fixtureId)) continue;
    const next = parseFloat((prod * entry.odds).toFixed(4));
    legs.push(entry); prod = next; usedIds.add(entry.fixtureId);
    if (prod >= target) { hitTarget = true; break; }
  }
  if (!legs.length) return null;
  const meanScore = legs.reduce((s,e)=>s+e.score,0)/legs.length;
  const meanConf  = Math.round(legs.reduce((s,e)=>s+e.conf,0)/legs.length);
  const meanRate  = Math.round(legs.reduce((s,e)=>s+e.empiricalRate,0)/legs.length);
  const reason    = hitTarget
    ? `${legs.length} legs · avg confidence ${meanConf}% · avg historical rate ${meanRate}%`
    : `Pool exhausted at ${prod.toFixed(2)}× · ${legs.length} leg${legs.length!==1?"s":""}`;
  return {
    legs: legs.map(e => ({
      fixtureId:e.fixtureId, game:e.game, pick:e.pick, odds:e.odds,
      conf:e.conf, market:e.market, league:e.league, strategyId:null,
      strategyLabel:e.strategyLabel, strategyTags:e.strategyTags,
      empiricalRate:e.empiricalRate, isVolatile:e.isVolatile,
      score:parseFloat(e.score.toFixed(4)),
    })),
    totalOdds: prod.toFixed(2), exhausted: !hitTarget,
    reason, poolSize: pool.length, stake,
    edgeScore: parseFloat(meanScore.toFixed(3)),
    jarvisConf: meanConf, jarvisReason: reason,
  };
}

// Auto mode — one best ticket (Jarvis).
// preBuiltPool: optional pre-scored pool from Jarvis Research Mode.
// When provided, skips internal pool rebuild so Jarvis adjustments are preserved.
function buildUniversalParley(fixtures, { targetOdds, historicalRates, budget = 0, budgetPct = 100, maxSameMarket = 5 }, preBuiltPool = null) {
  const pool   = preBuiltPool || buildUniversalPool(fixtures, historicalRates);
  const target = parseFloat(targetOdds) || 5.0;
  const stake  = parseFloat((budget * (budgetPct / 100)).toFixed(2));

  if (pool.length < 2) {
    return {
      legs:[], totalOdds:"0", exhausted:true, poolSize:pool.length, stake,
      reason: pool.length === 0
        ? "No qualifying picks today. Check back after more games load."
        : "Only 1 qualifying pick available — need at least 2 for a parley.",
      edgeScore:0, jarvisConf:0, jarvisReason:"Pool too thin.",
    };
  }
  const usedIds    = new Set();
  const marketCount = {};
  // Apply market diversity cap — same logic as buildManualParlays
  const cappedPool = pool.filter(e => {
    const cnt = marketCount[e.market] || 0;
    if (cnt >= maxSameMarket) return false;
    marketCount[e.market] = cnt + 1;
    return true;
  });
  // Reset for the actual build pass
  Object.keys(marketCount).forEach(k => delete marketCount[k]);
  return { ...buildOneParlayFromPool(cappedPool.length >= 2 ? cappedPool : pool, usedIds, target, stake), poolSize: pool.length };
}

// Manual mode — N non-overlapping tickets from the same pool.
// Accepts a pre-built (and optionally pre-scored) pool directly.
// Used by Research Mode so Jarvis adjustments aren't thrown away by a new pool build.
function buildManualParlaysFromPool(pool, { numParlays, targetOdds, historicalRates, budget = 0, budgetPct = 100, maxSameMarket = 2 }) {
  const target = parseFloat(targetOdds) || 5.0;
  const n      = Math.max(1, Math.min(numParlays || 2, 10));
  const totalStake = parseFloat((budget * (budgetPct / 100)).toFixed(2));
  const stakeEach  = parseFloat((totalStake / n).toFixed(2));
  if (pool.length < 2) return [];

  const globalUsed = new Set();
  const tickets = [];
  for (let i = 0; i < n; i++) {
    const remaining = pool.filter(e => !globalUsed.has(e.fixtureId));
    if (remaining.length < 2) break;
    const tierA = remaining.filter(e => e.score > 0.8);
    const tierB = remaining.filter(e => e.score > 0.6 && e.score <= 0.8);
    const tierC = remaining.filter(e => e.score <= 0.6);
    const shuffled = [
      ...shuffle(tierA),
      ...shuffle(tierB),
      ...shuffle(tierC),
    ];
    const localUsed = new Set(globalUsed);
    const marketCount = {}; const saturatedMarkets = new Set();
    const legs = []; let prod = 1.0; let hitTarget = false;
    for (const entry of shuffled) {
      if (localUsed.has(entry.fixtureId)) continue;
      const mkt = entry.market; const mktCount = marketCount[mkt] || 0;
      if (mktCount >= maxSameMarket) { saturatedMarkets.add(mkt); continue; }
      const next = parseFloat((prod * entry.odds).toFixed(4));
      legs.push(entry); prod = next; localUsed.add(entry.fixtureId);
      marketCount[mkt] = mktCount + 1;
      if (prod >= target) { hitTarget = true; break; }
    }
    if (!legs.length) break;
    legs.forEach(l => globalUsed.add(l.fixtureId));
    const meanScore = legs.reduce((s,e) => s + e.score, 0) / legs.length;
    const meanConf  = Math.round(legs.reduce((s,e) => s + e.conf, 0) / legs.length);
    const meanRate  = Math.round(legs.reduce((s,e) => s + e.empiricalRate, 0) / legs.length);
    const reason    = hitTarget
      ? `${legs.length} legs · avg confidence ${meanConf}% · avg historical rate ${meanRate}%`
      : `Pool exhausted at ${prod.toFixed(2)}× · ${legs.length} leg${legs.length !== 1 ? "s" : ""}`;
    tickets.push({
      legs: legs.map(e => ({
        fixtureId: e.fixtureId, game: e.game, pick: e.pick, odds: e.odds,
        conf: e.conf, market: e.market, league: e.league, strategyId: null,
        strategyLabel: e.strategyLabel, strategyTags: e.strategyTags,
        empiricalRate: e.empiricalRate, isVolatile: e.isVolatile,
        score: parseFloat(e.score.toFixed(4)),
        jarvisAdjustment: e.jarvisAdjustment, jarvisReason: e.jarvisReason, jarvisFlags: e.jarvisFlags,
      })),
      totalOdds: prod.toFixed(2), exhausted: !hitTarget,
      reason, poolSize: pool.length, stake: stakeEach,
      edgeScore: parseFloat(meanScore.toFixed(3)), jarvisConf: meanConf, jarvisReason: reason,
      id: i + 1, saturatedMarkets: saturatedMarkets.size > 0 ? [...saturatedMarkets] : null, maxSameMarket,
    });
  }
  return tickets;
}

function buildManualParlays(fixtures, { numParlays, targetOdds, historicalRates, budget = 0, budgetPct = 100, maxSameMarket = 2 }) {
  const pool   = buildUniversalPool(fixtures, historicalRates);
  const target = parseFloat(targetOdds) || 5.0;
  // Math.max(1,...) keeps the builder safe, but || uses 2 (state default) not 1
  // so mid-type empty string doesn't snap to 1 and lock the user out.
  const n      = Math.max(1, Math.min(numParlays || 2, 10));
  const totalStake = parseFloat((budget * (budgetPct / 100)).toFixed(2));
  const stakeEach  = parseFloat((totalStake / n).toFixed(2));

  if (pool.length < 2) return [];

  const globalUsed = new Set();
  const tickets = [];
  for (let i = 0; i < n; i++) {
    // Stratified shuffle within confidence bands for variety between tickets.
    // Tier A: score > 0.8, Tier B: 0.6-0.8, Tier C: below.
    // Shuffle within each tier so tickets don't always start with identical picks.
    const remaining = pool.filter(e => !globalUsed.has(e.fixtureId));
    if (remaining.length < 2) break;

    const tierA = remaining.filter(e => e.score > 0.8);
    const tierB = remaining.filter(e => e.score > 0.6 && e.score <= 0.8);
    const tierC = remaining.filter(e => e.score <= 0.6);
    const shuffled = [
      ...shuffle(tierA),
      ...shuffle(tierB),
      ...shuffle(tierC),
    ];

    // Build one ticket with market diversity cap.
    // Track which markets are saturated so we can surface a notice.
    const localUsed   = new Set(globalUsed);
    const marketCount = {};
    const saturatedMarkets = new Set();
    const legs = []; let prod = 1.0; let hitTarget = false;

    for (const entry of shuffled) {
      if (localUsed.has(entry.fixtureId)) continue;
      const mkt = entry.market;
      const mktCount = marketCount[mkt] || 0;

      if (mktCount >= maxSameMarket) {
        saturatedMarkets.add(mkt);
        continue; // skip — cap reached for this market
      }

      const next = parseFloat((prod * entry.odds).toFixed(4));
      legs.push(entry); prod = next;
      localUsed.add(entry.fixtureId);
      marketCount[mkt] = mktCount + 1;
      if (prod >= target) { hitTarget = true; break; }
    }

    if (!legs.length) break;

    legs.forEach(l => globalUsed.add(l.fixtureId));

    const meanScore = legs.reduce((s,e) => s + e.score, 0) / legs.length;
    const meanConf  = Math.round(legs.reduce((s,e) => s + e.conf, 0) / legs.length);
    const meanRate  = Math.round(legs.reduce((s,e) => s + e.empiricalRate, 0) / legs.length);
    const reason    = hitTarget
      ? `${legs.length} legs · avg confidence ${meanConf}% · avg historical rate ${meanRate}%`
      : `Pool exhausted at ${prod.toFixed(2)}× · ${legs.length} leg${legs.length !== 1 ? "s" : ""}`;

    tickets.push({
      legs: legs.map(e => ({
        fixtureId: e.fixtureId, game: e.game, pick: e.pick, odds: e.odds,
        conf: e.conf, market: e.market, league: e.league, strategyId: null,
        strategyLabel: e.strategyLabel, strategyTags: e.strategyTags,
        empiricalRate: e.empiricalRate, isVolatile: e.isVolatile,
        score: parseFloat(e.score.toFixed(4)),
      })),
      totalOdds: prod.toFixed(2), exhausted: !hitTarget,
      reason, poolSize: pool.length, stake: stakeEach,
      edgeScore: parseFloat(meanScore.toFixed(3)),
      jarvisConf: meanConf, jarvisReason: reason,
      id: i + 1,
      // Saturation notice payload — rendered in TicketCard if non-empty
      saturatedMarkets: saturatedMarkets.size > 0 ? [...saturatedMarkets] : null,
      maxSameMarket,
    });
  }
  return tickets;
}

// ── POOL BUILDER (for parlay builder) ────────────────────────────────────
const DYNAMIC_LEG_MAX = 20;

function buildPool(fixtures, mfInput) {
  const mfArr = Array.isArray(mfInput) ? mfInput : [mfInput];
  const io = safeImpliedOdds, oi = oddsOrImplied, pool = [];

  for (const f of fixtures) {
    // Only include scheduled fixtures in ticket pools
    if (f.state === "finished" || f.state === "ft") continue;

    const game = `${f.teams.home} vs ${f.teams.away}`, m = f.markets;
    let pick = null;

    for (const mf of mfArr) {
      if ((mf === "theRead" || mf === "safeBet") && f.theRead?.anchor && !f.theRead.isFallback) {
        const a = f.theRead.anchor;
        const o = oi(a.odds, a.prob); if(o) pick = { fixtureId:f.id, game, pick:a.pick, odds:o, conf:a.prob, market:a.market };
      } else if (mf === "theEdge" && f.theEdge) {
        const o = oi(f.theEdge.odds, f.theEdge.prob); if(o) pick = { fixtureId:f.id, game, pick:f.theEdge.pick, odds:o, conf:f.theEdge.prob, market:f.theEdge.market };
      } else if (mf === "goalRadar") {
        const best = f.goalRadar?.home?.prob >= f.goalRadar?.away?.prob ? f.goalRadar?.home : f.goalRadar?.away;
        if (best) { const o = oi(best.odds, best.prob); if(o) pick = { fixtureId:f.id, game, pick:best.pick, odds:o, conf:best.prob, market:"TeamTotal" }; }
      } else if (mf === "over15"){ const o = oi(f.odds?.over15odds, m.over15); if(o) pick = { fixtureId:f.id, game, pick:"Over 1.5 Goals", odds:o, conf:m.over15, market:"Over 1.5" };
      } else if (mf === "over25"){ const o = oi(f.odds?.over25odds, m.over25); if(o) pick = { fixtureId:f.id, game, pick:"Over 2.5 Goals", odds:o, conf:m.over25, market:"Over 2.5" };
      } else if (mf === "over35"){ const o = oi(f.odds?.over35odds, m.over35); if(o) pick = { fixtureId:f.id, game, pick:"Over 3.5 Goals", odds:o, conf:m.over35, market:"Over 3.5" };
      } else if (mf === "under25"){ const o = oi(f.odds?.under25odds, m.under25); if(o) pick = { fixtureId:f.id, game, pick:"Under 2.5 Goals", odds:o, conf:m.under25, market:"Under 2.5" };
      } else if (mf === "under35"){ const o = oi(f.odds?.under35odds, m.under35); if(o) pick = { fixtureId:f.id, game, pick:"Under 3.5 Goals", odds:o, conf:m.under35, market:"Under 3.5" };
      } else if (mf === "under45"){ const o = oi(f.odds?.under45odds, m.under45); if(o) pick = { fixtureId:f.id, game, pick:"Under 4.5 Goals", odds:o, conf:m.under45, market:"Under 4.5" };
      } else if (mf === "bttsyes"){ const o = oi(f.odds?.bttsYesOdds, m.bttsYes); if(o) pick = { fixtureId:f.id, game, pick:"BTTS Yes", odds:o, conf:m.bttsYes, market:"BTTS" };
      } else if (mf === "homewin"){ const o = oi(f.odds?.o1, m.homeWin); if(o) pick = { fixtureId:f.id, game, pick:`${f.teams.home} Win`, odds:o, conf:m.homeWin, market:"1X2" };
      } else if (mf === "awaywin"){ const o = oi(f.odds?.o2, m.awayWin); if(o) pick = { fixtureId:f.id, game, pick:`${f.teams.away} Win`, odds:o, conf:m.awayWin, market:"1X2" };
      } else if (mf === "homeo05"){ const o = oi(f.odds?.over05odds, m.homeOver05); if(o) pick = { fixtureId:f.id, game, pick:`${f.teams.home} to Score`, odds:o, conf:m.homeOver05, market:"TeamTotal" };
      } else if (mf === "awayo05"){ const o = oi(f.odds?.over05odds, m.awayOver05); if(o) pick = { fixtureId:f.id, game, pick:`${f.teams.away} to Score`, odds:o, conf:m.awayOver05, market:"TeamTotal" };
      }
      if (pick) break;
    }
    if (pick && pick.odds && pick.conf > 0) pool.push(pick);
  }
  return pool.sort((a, b) => b.conf - a.conf);
}

// ── ROLLOVER PICK ─────────────────────────────────────────────────────────
// Build a two-leg rollover pick targeting ≥2.00 combined odds.
// Uses high-confidence, non-volatile picks (empiricalRate ≥ 68%, conf ≥ 62%, odds 1.10–2.20).
function buildRolloverPick(pool) {
  const eligible = pool
    .filter(p => {
      const er = p.empiricalRate || 0;
      const mc = p.conf || p.modelConf || 0;
      // Hard blocks — any of these disqualify from rollover regardless of score
      if (p.isVolatile)                                  return false; // volatile leagues = unpredictable
      if (p.fixture?.markets?._lowConfidence)            return false; // season data < LOW_CONF_FLOOR (was p._lowConfidence — field never exists on pool entry)
      if ((p.sampleSize ?? 99) < 5)        return false; // backtest too thin — empiricalRate unreliable
      if (mc < 65)                         return false; // model not confident enough for compound bet
      if (er < 68)                         return false; // historical hit rate too low
      if (p.odds < 1.10 || p.odds > 2.20) return false;
      return true;
    })
    .slice(0, 20);

  if (eligible.length < 2) return null;

  const wScore = p => {
    const er = (p.empiricalRate || 0) / 100;
    const mc = (p.conf || p.modelConf || 50) / 100;
    return Math.pow(er, 0.4) * Math.pow(mc, 0.6);
  };

  const scored = eligible
    .map(p => ({ ...p, _score: wScore(p) }))
    .sort((a, b) => b._score - a._score);

  const usedFixtures = new Set();
  const legs = [];
  let totalOdds = 1.0;

  for (const pick of scored) {
    if (usedFixtures.has(pick.fixtureId)) continue;
    usedFixtures.add(pick.fixtureId);
    legs.push(pick);
    totalOdds *= pick.odds;
    if (totalOdds >= 2.0) break;
  }

  if (legs.length < 2 || totalOdds < 2.0) return null;

  const combRate = legs.reduce((acc, l) => acc * (l.empiricalRate / 100), 1.0) * 100;

  return {
    legs: legs.map(l => ({
      fixtureId:     l.fixtureId,
      game:          l.game,
      pick:          l.pick,
      odds:          l.odds,
      empiricalRate: l.empiricalRate,
      conf:          l.conf,
      league:        l.league,
      market:        l.market,
    })),
    totalOdds:             parseFloat(totalOdds.toFixed(2)),
    combinedEmpiricalRate: Math.round(combRate),
    poolSize:              pool.length,
  };
}

// ── DAILY BEST BETS ───────────────────────────────────────────────────────
// Returns rollover pick only. Safe/value tiers removed.
function buildDailyBestBets(fixtures, historicalRates) {
  const pool = buildUniversalPool(fixtures, historicalRates);
  if (pool.length < 2) return { rollover: null };
  const rollover = buildRolloverPick(pool);
  return {
    rollover: rollover ? { ...rollover, tier: "rollover", label: "🔄 Rollover" } : null,
  };
}

// ── MARKET OPTIONS (kept for CustomListView buildPool compatibility) ──────
const MKOPTS = [
  { id:"theRead",  label:"The Read"  },
  { id:"theEdge",  label:"The Edge" },
  { id:"goalRadar",label:"Goal Radar"},
  { id:"over15",   label:"Over 1.5"  }, { id:"over25",   label:"Over 2.5"  }, { id:"over35", label:"Over 3.5" },
  { id:"under25",  label:"Under 2.5" }, { id:"under35",  label:"Under 3.5" }, { id:"under45",label:"Under 4.5"},
  { id:"bttsyes",  label:"BTTS Yes"  },
  { id:"homewin",  label:"Home Win"  }, { id:"awaywin",  label:"Away Win"   },
  { id:"homeo05",  label:"H O0.5"       }, { id:"awayo05",  label:"A O0.5"       },
];

// ── END ENGINE ───────────────────────────────────────────────────────────────


const CACHE_KEY = "grm_cache_v15";
// Server-synced date — avoids UTC vs local timezone drift at midnight.
// On first call, fetches /api/server-date and caches result for 5 minutes.
// Falls back to local UTC if the server is unreachable.
let _serverDateCache = null;
let _serverDateAt    = 0;
async function fetchServerDate() {
  // E5-FIX: Invalidate cache when the local calendar day has advanced past what we cached.
  // Without this, an app kept open overnight uses yesterday's date all the next day
  // because the 5-minute TTL only fires if the user triggers a re-fetch in that window.
  // "Local day rolled over" = local YYYY-MM-DD is later than the cached date string.
  const localToday = new Date().toISOString().split("T")[0];
  const cacheExpired = !_serverDateCache || Date.now() - _serverDateAt >= 5 * 60_000;
  const dayRolled    = _serverDateCache && localToday > _serverDateCache;
  if (!cacheExpired && !dayRolled) return _serverDateCache;
  try {
    const r = await fetch(`${SERVER}/api/server-date`);
    const j = await r.json();
    if (j.date) {
      _serverDateCache = j.date;
      _serverDateAt    = Date.now();
      // C1-FIX: share with Rollover.jsx via window slot so both todayStr() calls
      // always return the same server-authoritative date string.
      window.__grmServerDate = j.date;
      return j.date;
    }
  } catch {}
  return localToday;
}
const todayStr = () => window.__grmServerDate || _serverDateCache || new Date().toISOString().split("T")[0];

// ── COLOUR SYSTEM — theme-driven ──────────────────────────────────────────
// C is a mutable object. syncC(theme) stamps all theme tokens into it so
// every existing C.xxx reference in JSX automatically reflects the active
// theme without any find-replace across the codebase.
export let C = { ...loadSavedTheme() };
function syncC(theme) { Object.keys(theme).forEach(k => { C[k] = theme[k]; }); }

// ── MARKET STYLES ─────────────────────────────────────────────────────────
// mktStyle() is a function — NOT a static object — so it always reads the
// current live C values after a theme switch. The old pattern (const MKT = {...})
// captured color values at module load time and never updated, causing faded
// panels when C changed.
const mktStyle = m => {
  const map = {
    "Over 2.5":  { color:C.green,  bg:C.greenDim  },
    "Over 1.5":  { color:C.green,  bg:C.greenDim  },
    "Over 3.5":  { color:C.green,  bg:C.greenDim  },
    "Over 4.5":  { color:C.green,  bg:C.greenDim  },
    "Under 1.5": { color:C.blue,   bg:C.blueDim   },
    "Under 2.5": { color:C.blue,   bg:C.blueDim   },
    "Under 3.5": { color:C.blue,   bg:C.blueDim   },
    "Under 4.5": { color:C.blue,   bg:C.blueDim   },
    "BTTS":      { color:C.purple, bg:C.purpleDim },
    "1X2":       { color:C.gold,   bg:C.goldDim   },
    "TeamTotal": { color:C.radar,  bg:C.radarDim  },
    "DC":        { color:C.dc,     bg:C.dcDim     },
    "CS":        { color:C.blue,   bg:C.blueDim   },
  };
  return map[m] || { color:C.text, bg:C.surface };
};

// ── STYLES INJECTION ──────────────────────────────────────────────────────
// Single source of truth for all visual decisions.
// Premium design principles applied:
//   • Full light/dark theme awareness — every glass value adapts
//   • Atmospheric depth — layered bg, not flat
//   • Strict radius system — 3 sizes only
//   • One dominant hierarchy — nothing competes
//   • Typography floor — nothing below 10px in chrome
//   • Restrained glow — accent appears in ≤2 places per view
function injectStyles(T) {
  if (typeof document === "undefined") return;
  const old = document.getElementById("grm-styles");
  if (old) old.remove();

  // ── Light/dark detection ──────────────────────────────────────────
  // FIX: Old "#f..." prefix missed Claude (#eeeade), Apple (#e8e8ec). Use WCAG luminance.
  const bg = (T.bg || "").toLowerCase();
  const _lum = (hex) => {
    const h = hex.replace("#", "");
    if (h.length < 6) return 0;
    const r = parseInt(h.slice(0,2),16)/255, g = parseInt(h.slice(2,4),16)/255, b = parseInt(h.slice(4,6),16)/255;
    const c = x => x <= 0.03928 ? x/12.92 : Math.pow((x+0.055)/1.055, 2.4);
    return 0.2126*c(r) + 0.7152*c(g) + 0.0722*c(b);
  };
  const isLight = bg.startsWith("#") ? _lum(bg) > 0.35 : bg.startsWith("rgba(255") || bg === "white";

  // ── Nav/dock background — bypass color-mix() which silently fails on many
  //    Android WebViews when the source is an rgba() value, collapsing the
  //    background to transparent and making the nav see-through.
  //    Parse T.bg directly (always a hex string) to build a reliable rgba().
  const navBg = (() => {
    const hex = (T.bg || "#000000").replace("#", "");
    const r = parseInt(hex.slice(0, 2), 16) || 0;
    const g = parseInt(hex.slice(2, 4), 16) || 0;
    const b2 = parseInt(hex.slice(4, 6), 16) || 0;
    return isLight
      ? `rgba(${r},${g},${b2},0.92)`
      : `rgba(${r},${g},${b2},0.88)`;
  })();

  // ── Radius system — respect each theme's personality ─────────────
  // Themes define their own cardRadius/btnRadius — we honour them
  // but clamp to sensible maximums so layout never breaks.
  const rXl = Math.min(T.cardRadius || 16, 28);   // cards, panels, modals
  const rLg = Math.min(T.btnRadius  || 10, 24);   // buttons, sub-panels
  const rMd = Math.min(Math.round((T.btnRadius || 10) * 0.65), 14); // chips, inputs

  // ── Theme-aware glass formula ─────────────────────────────────────
  // Dark: white-glass overlay  |  Light: black-glass overlay
  const glassOverlay   = isLight
    ? "linear-gradient(180deg, rgba(0,0,0,0.025) 0%, rgba(0,0,0,0.01) 100%)"
    : "linear-gradient(180deg, rgba(255,255,255,0.045) 0%, rgba(255,255,255,0.02) 100%)";
  const glassBorder    = isLight ? "rgba(0,0,0,0.10)"    : "rgba(255,255,255,0.08)";
  const glassBorderHi  = isLight ? "rgba(0,0,0,0.18)"    : "rgba(255,255,255,0.14)";
  const glassHoverBg   = isLight ? "rgba(0,0,0,0.03)"    : "rgba(255,255,255,0.06)";
  const glassPillActive= isLight ? "rgba(0,0,0,0.06)"    : "rgba(255,255,255,0.08)";

  // ── Shadow system — light bg needs lighter shadows ────────────────
  const shadowCard     = isLight
    ? "0 1px 3px rgba(0,0,0,0.08), 0 4px 12px rgba(0,0,0,0.07)"
    : "0 1px 3px rgba(0,0,0,0.18), 0 4px 16px rgba(0,0,0,0.20)";
  const shadowElevated = isLight
    ? "0 4px 20px rgba(0,0,0,0.12), 0 1px 6px rgba(0,0,0,0.08)"
    : "0 4px 24px rgba(0,0,0,0.28), 0 1px 6px rgba(0,0,0,0.16)";
  const shadowDock     = isLight
    ? "0 -2px 20px rgba(0,0,0,0.12), 0 -1px 0 rgba(0,0,0,0.06)"
    : "0 -4px 32px rgba(0,0,0,0.36), 0 -1px 0 rgba(0,0,0,0.10)";

  // ── Atmospheric background — theme-aware accent clouds ────────────
  // Use the theme's actual accent colour for the atmospheric glow
  const atm1 = isLight
    ? `${T.accent}08`    // very faint accent tint top-right
    : `${T.accent}0d`;   // soft accent cloud
  const atm2 = isLight
    ? `${T.green}06`     // whisper of green bottom-left
    : `${T.green}08`;

  // ── Slider track ─────────────────────────────────────────────────
  const sliderTrack = isLight ? "rgba(0,0,0,0.18)" : "rgba(255,255,255,0.16)";

  // ── Accent glow — reduced opacity for light themes ────────────────
  const glowOpacity  = isLight ? "18" : "22";
  const glowOpacityL = isLight ? "26" : "32";
  const accentGlow   = `0 4px 16px ${T.accent}${glowOpacity}`;
  const accentGlowLg = `0 8px 24px ${T.accent}${glowOpacityL}`;

  // ── Input background — visible on both light and dark ────────────
  const inputBg = T.inputBg || (isLight ? "rgba(0,0,0,0.04)" : "rgba(255,255,255,0.04)");

  const s = document.createElement("style");
  s.id = "grm-styles";
  s.textContent = `
    @import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@300;400;600;700;800&display=swap');

    /* ── Design tokens ─────────────────────────────────────────────── */
    :root {
      --bg:             ${T.bg};
      --surface:        ${T.surface};
      --surface-hi:     ${T.surfaceHi};
      --card-bg:        ${T.cardBg};
      --modal-bg:       ${T.modalBg};
      --input-bg:       ${inputBg};
      --header-bg:      ${T.headerBg};
      --header-border:  ${T.headerBorder};
      --border:         ${T.border};
      --border-hi:      ${T.borderHi};
      --text:           ${T.text};
      --muted:          ${T.muted};
      --faint:          ${T.faint};
      --subtle-bg:      ${T.subtleBg};
      --accent:         ${T.accent};
      --accent-dim:     ${T.accentDim   || T.accent + "15"};
      --accent-border:  ${T.accentBorder|| T.accent + "35"};
      --accent-text:    ${T.accentText};
      --gold:           ${T.gold};
      --gold-dim:       ${T.goldDim};
      --gold-border:    ${T.goldBorder};
      --green:          ${T.green};
      --green-dim:      ${T.greenDim};
      --blue:           ${T.blue};
      --blue-dim:       ${T.blueDim};
      --red:            ${T.red};
      --red-dim:        ${T.redDim};
      --amber:          ${T.amber};
      --amber-dim:      ${T.amberDim};
      --radar:          ${T.radar};
      --radar-dim:      ${T.radarDim};
      --radar-border:   ${T.radarBorder};
      --edge:           ${T.edge};
      --edge-dim:       ${T.edgeDim};
      --edge-border:    ${T.edgeBorder};
      --purple:         ${T.purple};
      --purple-dim:     ${T.purpleDim};
      --font:           ${T.font};

      /* Radius — respects each theme's personality */
      --r-xl:           ${rXl}px;
      --r-lg:           ${rLg}px;
      --r-md:           ${rMd}px;
      --btn-radius:     ${rLg}px;
      --card-radius:    ${rXl}px;

      --slider-track:   ${sliderTrack};
      --scroll-thumb:   ${T.scrollThumb || T.subtleBg};
      --accent-glow:    ${accentGlow};
      --accent-glow-lg: ${accentGlowLg};

      /* Theme-aware glass system */
      --glass-overlay:  ${glassOverlay};
      --glass-border:   ${glassBorder};
      --glass-border-hi:${glassBorderHi};
      --glass-hover:    ${glassHoverBg};
      --glass-pill-act: ${glassPillActive};

      /* Shadow system */
      --shadow-card:    ${shadowCard};
      --shadow-elevated:${shadowElevated};
      --shadow-dock:    ${shadowDock};
    }

    /* ── Reset ─────────────────────────────────────────────────────── */
    *{box-sizing:border-box;margin:0;padding:0}

    /* ── Atmospheric background ─────────────────────────────────────── */
    body{
      background:
        radial-gradient(ellipse 800px 500px at 85% -80px, ${atm1}, transparent 65%),
        radial-gradient(ellipse 600px 400px at 5% 70%,   ${atm2}, transparent 60%),
        ${T.bg};
      color:var(--text);
      font-family:var(--font);
      min-height:100vh;
    }

    /* ── Scrollbar ──────────────────────────────────────────────────── */
    ::-webkit-scrollbar{width:2px;height:2px}
    ::-webkit-scrollbar-track{background:transparent}
    ::-webkit-scrollbar-thumb{background:var(--scroll-thumb);border-radius:2px}

    /* ── Form controls ──────────────────────────────────────────────── */
    input[type=range]{
      -webkit-appearance:none;height:3px;border-radius:2px;
      background:var(--slider-track);outline:none;cursor:pointer;width:100%;
    }
    input[type=range]::-webkit-slider-thumb{
      -webkit-appearance:none;width:16px;height:16px;border-radius:50%;
      background:var(--accent);cursor:pointer;
      box-shadow:0 1px 4px rgba(0,0,0,0.3);
    }
    input[type=number]::-webkit-inner-spin-button{opacity:.4}

    /* ── Card — premium glass surface, light/dark aware ────────────── */
    .gc{
      background:var(--glass-overlay),var(--card-bg);
      backdrop-filter:blur(20px);-webkit-backdrop-filter:blur(20px);
      border:1px solid var(--glass-border);
      border-radius:var(--r-xl);
      box-shadow:var(--shadow-card);
      transition:border-color .2s ease,box-shadow .2s ease;
    }
    .gc:hover{
      border-color:var(--glass-border-hi);
      box-shadow:var(--shadow-elevated);
    }

    /* Card — elevated (modals, overlays) */
    .gc-elevated{
      background:var(--modal-bg);
      backdrop-filter:blur(28px);-webkit-backdrop-filter:blur(28px);
      border:1px solid var(--border-hi);
      border-radius:var(--r-xl);
      box-shadow:var(--shadow-elevated);
    }

    /* ── Input — always visible on any bg ───────────────────────────── */
    .gi{
      font-family:var(--font);
      background:var(--input-bg);
      border:1px solid var(--glass-border);
      border-radius:var(--r-md);
      color:var(--text);
      font-size:12px;
      padding:8px 12px;
      outline:none;
      transition:border-color .15s ease,box-shadow .15s ease;
      width:100%;
    }
    .gi:focus{
      border-color:var(--accent-border);
      box-shadow:0 0 0 3px var(--accent-dim);
    }
    .gi::placeholder{color:var(--muted);opacity:.7}

    /* ── Button base ────────────────────────────────────────────────── */
    .gb{
      font-family:var(--font);
      font-weight:700;font-size:11px;
      letter-spacing:.05em;text-transform:uppercase;
      cursor:pointer;border-radius:var(--r-lg);
      transition:all .16s ease;border:none;
      -webkit-tap-highlight-color:transparent;
    }
    .gb:active{transform:scale(.97)}
    .gb:disabled{opacity:.35;cursor:not-allowed}

    /* Button — primary CTA */
    .gb-primary{
      display:inline-flex;align-items:center;justify-content:center;
      font-family:var(--font);
      font-weight:800;font-size:12px;letter-spacing:.04em;text-transform:uppercase;
      cursor:pointer;border:none;
      border-radius:var(--r-lg);
      background:var(--accent);
      color:var(--accent-text);
      box-shadow:var(--accent-glow);
      transition:all .18s ease;
      -webkit-tap-highlight-color:transparent;
    }
    .gb-primary:hover{filter:brightness(1.08);box-shadow:var(--accent-glow-lg)}
    .gb-primary:active{transform:scale(.96)}
    .gb-primary:disabled{opacity:.4;cursor:not-allowed}

    /* Button — ghost secondary, light/dark aware */
    .gb-ghost{
      display:inline-flex;align-items:center;justify-content:center;
      font-family:var(--font);
      font-weight:700;font-size:11px;letter-spacing:.05em;text-transform:uppercase;
      cursor:pointer;
      border-radius:var(--r-lg);
      background:var(--glass-hover);
      border:1px solid var(--glass-border);
      color:var(--muted);
      transition:all .16s ease;
      -webkit-tap-highlight-color:transparent;
    }
    .gb-ghost:hover{background:var(--surface-hi);color:var(--text);border-color:var(--glass-border-hi)}
    .gb-ghost:active{transform:scale(.97)}
    .gb-ghost:disabled{opacity:.35;cursor:not-allowed}

    /* ── Pill tab — light/dark aware ────────────────────────────────── */
    .grm-pill{
      display:inline-flex;align-items:center;gap:5px;
      padding:7px 14px;
      border-radius:var(--r-lg);
      border:1px solid transparent;
      background:transparent;
      color:var(--muted);
      font-family:var(--font);
      font-size:11px;font-weight:700;letter-spacing:.02em;
      cursor:pointer;white-space:nowrap;
      transition:all .18s ease;
      -webkit-tap-highlight-color:transparent;
    }
    .grm-pill:hover{
      background:var(--glass-hover);
      color:var(--text);
    }
    .grm-pill.active{
      background:var(--glass-pill-act);
      border-color:var(--glass-border);
      color:var(--text);
    }
    /* Accent pill — for primary nav tabs */
    .grm-pill-accent.active{
      background:var(--accent-dim);
      border-color:var(--accent-border);
      color:var(--accent);
    }

    /* ── Mini chip ───────────────────────────────────────────────────── */
    .grm-chip{
      display:inline-flex;align-items:center;
      font-size:9px;font-weight:800;letter-spacing:.07em;text-transform:uppercase;
      padding:2px 7px;border-radius:var(--r-md);
      border:1px solid currentColor;line-height:1.4;
    }

    /* ── Eyebrow label ───────────────────────────────────────────────── */
    .grm-eyebrow{
      font-size:10px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;
      color:var(--muted);margin-bottom:6px;
    }

    .grm-signal-label{
      font-size:9px;font-weight:800;letter-spacing:.08em;text-transform:uppercase;
      margin-bottom:3px;
    }

    /* Surface panel — light/dark aware */
    .grm-surface{
      background:var(--surface);
      border:1px solid var(--glass-border);
      border-radius:var(--r-lg);
      padding:12px 14px;
    }

    /* Progress bar */
    .cb{height:3px;border-radius:2px;background:var(--subtle-bg);overflow:hidden}
    .cf{height:100%;border-radius:2px;transition:width .42s cubic-bezier(.4,0,.2,1)}

    /* Utility */
    .cscroll{display:flex;gap:6px;overflow-x:auto;padding-bottom:4px;-webkit-overflow-scrolling:touch}
    .cscroll::-webkit-scrollbar{height:0}
    .filter-wrap{display:flex;flex-wrap:wrap;gap:5px}
    .drop-zone{
      border:2px dashed var(--border);border-radius:var(--r-xl);
      padding:32px;text-align:center;cursor:pointer;transition:all .18s;
    }
    .drop-zone:hover,.drop-zone.drag-over{border-color:var(--radar);background:var(--radar-dim)}

    /* ── Animations ─────────────────────────────────────────────────── */
    @keyframes fadeUp{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}
    .fa{animation:fadeUp .28s cubic-bezier(.22,1,.36,1) forwards}
    @keyframes pulse{0%,100%{opacity:1}50%{opacity:.35}}
    .pu{animation:pulse 1.4s ease infinite}
    @keyframes livePulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.5;transform:scale(1.2)}}
    .live-dot{animation:livePulse 1.4s ease infinite}
    @keyframes shimmer{0%{transform:translateX(-100%)}100%{transform:translateX(220%)}}
    @keyframes spinRing{0%{transform:rotate(0deg)}100%{transform:rotate(360deg)}}
    @keyframes bounce{0%,100%{transform:translateY(0);opacity:.5}50%{transform:translateY(-4px);opacity:1}}
    @keyframes spin{0%{transform:rotate(0deg)}100%{transform:rotate(360deg)}}

    /* ── Header — 2-level premium shell ─────────────────────────────── */
    .grm-header{
      position:fixed;top:0;left:0;right:0;z-index:120;
      background:${isLight
        ? `color-mix(in srgb, var(--header-bg) 97%, transparent)`
        : `color-mix(in srgb, var(--header-bg) 94%, transparent)`};
      backdrop-filter:blur(32px);-webkit-backdrop-filter:blur(32px);
      border-bottom:1px solid var(--glass-border);
    }
    .grm-header-top{
      padding:14px 18px;
      display:flex;justify-content:space-between;align-items:center;gap:12px;
      min-height:56px;
    }
    .grm-header-subnav{
      padding:0 12px 10px;
      display:flex;align-items:center;gap:4px;
      overflow-x:auto;-webkit-overflow-scrolling:touch;
    }
    .grm-header-subnav::-webkit-scrollbar{height:0}
    .grm-header-util{
      padding:0 14px 12px;
      display:flex;align-items:center;gap:8px;
    }

    /* Wordmark */
    .grm-wordmark{
      display:flex;align-items:baseline;
      font-size:17px;font-weight:800;letter-spacing:-.06em;
      color:var(--text);line-height:1;
    }
    .grm-wordmark-accent{color:var(--accent);margin-left:5px}
    .grm-wordmark-meta{
      font-size:9px;font-weight:400;color:var(--muted);
      margin-left:8px;letter-spacing:.02em;
    }

    /* ── Fixture card ────────────────────────────────────────────────── */
    .grm-fixture-card{padding:18px 20px;display:flex;flex-direction:column;gap:12px}
    .grm-teams-row{display:flex;justify-content:space-between;align-items:center}
    .grm-team-name{font-size:14px;font-weight:800;color:var(--text);flex:1;line-height:1.2}
    .grm-team-name.away{text-align:right}
    .grm-vs{font-size:10px;color:var(--muted);padding:0 12px;flex-shrink:0}

    /* ── Signal strip cards ──────────────────────────────────────────── */
    .grm-signal-card{
      flex:1;min-width:0;border-radius:var(--r-lg);
      padding:10px 12px;transition:transform .16s ease;
    }
    .grm-signal-card:hover{transform:translateY(-1px)}

    /* ── Full-model page header ──────────────────────────────────────── */
    .grm-page-header{
      position:sticky;top:0;z-index:10;
      background:${isLight
        ? `color-mix(in srgb, var(--bg) 97%, transparent)`
        : `color-mix(in srgb, var(--bg) 92%, transparent)`};
      backdrop-filter:blur(20px);-webkit-backdrop-filter:blur(20px);
      border-bottom:1px solid var(--glass-border);
      padding:14px 18px;display:flex;align-items:center;gap:12px;
    }

    /* ── Add / ticket buttons ────────────────────────────────────────── */
    .grm-add-btn{
      margin-top:9px;width:100%;padding:7px 0;
      font-family:var(--font);font-size:10px;font-weight:700;
      letter-spacing:.04em;text-transform:uppercase;
      border-radius:var(--r-md);cursor:pointer;
      transition:all .18s ease;border:1px solid;
    }
    .grm-add-btn:active{transform:scale(.97)}
    .grm-add-btn-finished{
      margin-top:9px;width:100%;padding:7px 0;text-align:center;
      font-family:var(--font);font-size:10px;font-weight:700;letter-spacing:.04em;
      border-radius:var(--r-md);background:var(--glass-hover);
      color:var(--muted);border:1px solid var(--glass-border);opacity:.6;
    }

    /* ── Score / result badge ────────────────────────────────────────── */
    .grm-score-badge{
      display:inline-flex;align-items:center;gap:7px;
      background:var(--surface);border:1px solid var(--glass-border);
      border-radius:var(--r-md);padding:5px 13px;
    }
    .grm-score-value{font-size:15px;font-weight:800;color:var(--text);letter-spacing:-.01em}
    .grm-score-ft{font-size:9px;color:var(--muted);font-weight:700}

    /* ── Signal section panels ───────────────────────────────────────── */
    .grm-signal-panel{border-radius:var(--r-lg);padding:14px 16px}
    .grm-signal-panel-header{
      display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;
    }
    .grm-signal-panel-title{display:flex;align-items:center;gap:6px}
    .grm-signal-panel-name{font-size:9px;font-weight:800;letter-spacing:.1em;text-transform:uppercase}
    .grm-signal-panel-sub{font-size:8px;font-weight:600;letter-spacing:.03em;opacity:.5}
    .grm-signal-panel-pick{font-size:15px;font-weight:800;line-height:1.2;margin-bottom:5px}
    .grm-signal-panel-prob{font-size:13px;font-weight:800}
    .grm-signal-panel-odds{font-size:11px;font-weight:700;color:var(--muted)}
    .grm-signal-panel-narrative{
      font-size:9px;font-style:italic;margin-bottom:5px;line-height:1.5;
      color:var(--text);opacity:.7;
    }
    .grm-signal-panel-meta{font-size:8px;color:var(--muted);margin-top:4px;letter-spacing:.02em}
    .grm-signal-panel-divider{margin-top:9px;padding-top:9px}
    .grm-signal-panel-empty{
      background:var(--surface);border:1px solid var(--glass-border);
      border-radius:var(--r-lg);padding:12px 14px;opacity:.5;
    }

    /* ── Jarvis Mind Box ─────────────────────────────────────────────── */
    .grm-mindbox{
      position:relative;overflow:hidden;
      background:linear-gradient(140deg,var(--surface) 0%,var(--gold-dim) 100%);
      border:1px solid var(--glass-border);
      border-radius:var(--r-xl);
      padding:18px 20px;margin-bottom:20px;
      box-shadow:var(--shadow-card);
    }
    .grm-mindbox::before{
      content:"";position:absolute;top:-60px;right:-60px;
      width:180px;height:180px;border-radius:50%;
      background:radial-gradient(circle,var(--gold-dim) 0%,transparent 70%);
      pointer-events:none;
    }
    .grm-mindbox-header{display:flex;justify-content:space-between;align-items:center;overflow:visible;position:relative;z-index:10}
    .grm-mindbox-title{
      font-size:11px;font-weight:800;color:var(--gold);
      letter-spacing:.12em;text-transform:uppercase;
    }
    .grm-mindbox-brief{
      font-size:13px;font-weight:600;color:var(--text);
      line-height:1.55;font-style:italic;
    }
    .grm-mindbox-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px}
    .grm-mindbox-cell{
      background:var(--surface);border-radius:var(--r-lg);
      padding:10px 12px;border:1px solid var(--glass-border);
    }
    .grm-mindbox-cell-label{
      font-size:8px;font-weight:800;letter-spacing:.1em;
      text-transform:uppercase;margin-bottom:4px;
    }
    .grm-mindbox-cell-text{font-size:10px;color:var(--text);line-height:1.5}

    /* ── Ask Jarvis panel ────────────────────────────────────────────── */
    .grm-jarvis-panel{
      margin-top:8px;background:var(--surface);
      border:1px solid var(--glass-border);
      border-radius:var(--r-lg);padding:12px 14px;
    }
    .grm-jarvis-header{display:flex;justify-content:space-between;align-items:center;margin-bottom:9px}
    .grm-jarvis-title{
      font-size:9px;font-weight:800;color:var(--edge);
      letter-spacing:.1em;text-transform:uppercase;
    }
    .grm-jarvis-response{
      font-size:10px;color:var(--text);line-height:1.6;
      margin-top:9px;border-top:1px solid var(--glass-border);padding-top:9px;
    }

    /* ── Goal Radar entry ────────────────────────────────────────────── */
    .grm-radar-entry{
      flex:1;min-width:110px;border-radius:var(--r-lg);padding:10px 12px;
      border:1px solid;transition:opacity .15s;
    }
    .grm-radar-entry-pick{font-size:10px;font-weight:700;color:var(--text);margin-bottom:4px}
    .grm-radar-entry-prob{font-size:15px;font-weight:800;color:var(--radar)}

    /* ── Combo row ───────────────────────────────────────────────────── */
    .grm-combo-row{
      background:var(--surface);border-radius:var(--r-lg);
      padding:9px 12px;margin-top:6px;border:1px solid var(--glass-border);
    }
    .grm-combo-pick-chip{
      font-size:9px;color:var(--text);
      background:var(--surface-hi);border:1px solid var(--glass-border);
      border-radius:var(--r-md);padding:2px 8px;
    }

    /* ── Bottom Nav — mobile only (< 900px) ──────────────────────────── */
    .grm-bottom-nav{
      position:fixed;left:10px;right:10px;
      bottom:calc(10px + env(safe-area-inset-bottom));
      padding:10px 4px 12px;
      display:flex;gap:2px;align-items:center;
      border-radius:${Math.max(rXl, 24)}px;
      background:${navBg};
      border:1px solid var(--glass-border);
      backdrop-filter:blur(32px);-webkit-backdrop-filter:blur(32px);
      box-shadow:var(--shadow-dock);
      z-index:210;
    }
    @media(min-width:900px){
      .grm-bottom-nav{ display:none !important; }
    }

    /* ── Desktop Sidebar ─────────────────────────────────────────────── */
    .grm-sidebar{
      display:none;
    }
    @media(min-width:900px){
      .grm-sidebar{
        display:flex;
        flex-direction:column;
        position:fixed;
        top:0;left:0;bottom:0;
        width:200px;
        z-index:210;
        padding:0 10px;
        background:${navBg};
        border-right:1px solid var(--glass-border);
        backdrop-filter:blur(32px);-webkit-backdrop-filter:blur(32px);
      }
    /* P19-FIX: Remove backdrop-filter on desktop — blur triggers a GPU compositing
       layer for every blurred element, causing janky scroll and input lag on lower-end
       desktop GPUs. Mobile is fine (composited by default); desktop is not.
       Cards, header, and page-header get solid backgrounds instead. */
    .gc,.gc-elevated{ backdrop-filter:none !important;-webkit-backdrop-filter:none !important; }
    .grm-header{ backdrop-filter:none !important;-webkit-backdrop-filter:none !important; }
    .grm-page-header{ backdrop-filter:none !important;-webkit-backdrop-filter:none !important; }
    .grm-sidebar{ backdrop-filter:none !important;-webkit-backdrop-filter:none !important; }
      .grm-sidebar-logo{
        padding:20px 8px 16px;
        font-size:13px;font-weight:900;color:var(--text);
        letter-spacing:.08em;text-transform:uppercase;
        border-bottom:1px solid var(--glass-border);
        margin-bottom:10px;
        flex-shrink:0;
      }
      .grm-sidebar-items{
        flex:1;overflow-y:auto;
        display:flex;flex-direction:column;gap:2px;
        padding-bottom:20px;
      }
      .grm-sidebar-items::-webkit-scrollbar{width:0}
      .grm-sidebar-item{
        display:flex;align-items:center;gap:10px;
        padding:9px 10px;border-radius:${Math.max(rLg, 10)}px;
        border:0;background:transparent;
        color:var(--muted);cursor:pointer;
        font-family:var(--font);font-size:11px;font-weight:700;
        text-align:left;width:100%;
        transition:all .18s ease;
        position:relative;
        -webkit-tap-highlight-color:transparent;
      }
      .grm-sidebar-item:hover{
        background:var(--surface);color:var(--text);
      }
      .grm-sidebar-item.active{
        background:var(--accent-dim);
        color:var(--accent);
      }
      .grm-sidebar-item.active .grm-sidebar-icon{
        color:var(--accent);
      }
      .grm-sidebar-icon{
        width:32px;height:32px;
        display:flex;align-items:center;justify-content:center;
        flex-shrink:0;
      }
      .grm-sidebar-badge{
        margin-left:auto;
        min-width:16px;height:16px;
        background:var(--accent);color:var(--accent-text);
        border-radius:999px;font-size:8px;font-weight:900;
        display:flex;align-items:center;justify-content:center;
        padding:0 4px;
      }
      /* Push header and content right on desktop */
      .grm-header{
        left:200px !important;
      }
      .grm-desktop-shell{
        margin-left:200px;
      }
      /* Wider fixture grid on desktop */
      .grm-grid{
        grid-template-columns:repeat(auto-fill,minmax(420px,1fr)) !important;
      }
    }
    .grm-nav-item{
      flex:1;min-width:0;
      display:flex;flex-direction:column;align-items:center;justify-content:center;
      gap:5px;padding:6px 4px 4px;
      position:relative;border:0;background:transparent;
      color:var(--muted);cursor:pointer;
      transition:color .2s ease;
      font-family:var(--font);
      -webkit-tap-highlight-color:transparent;
    }
    .grm-nav-icon{
      width:36px;height:36px;
      display:flex;align-items:center;justify-content:center;
      border-radius:${Math.max(rLg - 2, 10)}px;
      transition:all .2s ease;
    }
    .grm-nav-item.active{color:var(--text)}
    .grm-nav-item.active .grm-nav-icon{
      background:var(--accent-dim);
      color:var(--accent);
    }
    .grm-nav-item.active::after{
      content:"";
      position:absolute;bottom:0;left:50%;transform:translateX(-50%);
      width:20px;height:2px;border-radius:1px;
      background:var(--accent);opacity:.7;
    }
    .grm-nav-label{
      font-size:10px;font-weight:700;
      line-height:1;letter-spacing:.01em;
      text-align:center;white-space:nowrap;
      overflow:hidden;max-width:100%;text-overflow:ellipsis;
    }
    .grm-nav-badge{
      position:absolute;top:2px;right:calc(50% - 24px);
      min-width:16px;height:16px;
      background:var(--accent);color:var(--accent-text);
      border-radius:999px;font-size:8px;font-weight:900;
      display:flex;align-items:center;justify-content:center;
      padding:0 4px;box-shadow:0 2px 6px rgba(0,0,0,0.3);
    }

    /* ── Responsive ──────────────────────────────────────────────────── */
    @media(max-width:640px){
      .grm-grid{grid-template-columns:1fr !important}
      .grm-header-row{flex-wrap:wrap !important}
      .theme-label{display:none}
    }
    /* ── Ultra-compact mode for very small devices (< 360px wide) ── */
    @media(max-width:360px){
      .grm-wordmark{ font-size:13px !important }
      .grm-wordmark-meta{ display:none }
      .grm-header-top{ padding:6px 10px !important; min-height:44px !important }
      .grm-header-subnav{ padding:3px 8px !important; gap:3px !important }
      .grm-header-util{ padding:4px 8px !important }
      .grm-header{ padding-bottom:2px !important }
      .grm-pill{ font-size:9px !important; padding:4px 8px !important }
      .gi{ font-size:10px !important; padding:5px 8px !important }
      .gb-primary{ font-size:11px !important; padding:7px 14px !important }
      .grm-nav-label{ font-size:8px !important }
      .grm-nav-icon{ width:28px !important; height:28px !important }
    }
  `;
  document.head.appendChild(s);
}

// ── Tip — persistent contextual tooltip rendered via portal ──────────────────
// Renders the tooltip into document.body via a portal so it's never clipped
// by parent overflow:hidden, z-index stacking contexts, or the bottom nav bar.
// direction="down" renders below trigger (default "up" renders above).
function Tip({ text, children, direction = "up" }) {
  const [open, setOpen]     = useState(false);
  const [pos,  setPos]      = useState({ top:0, left:0 });
  const triggerRef          = useRef(null);
  const tooltipRef          = useRef(null);

  const reposition = useCallback(() => {
    if (!triggerRef.current) return;
    const r = triggerRef.current.getBoundingClientRect();
    const TW = 210, TH = 110; // estimate — tooltip width and approximate height
    const isDown = direction === "down";
    const top = isDown
      ? Math.min(r.bottom + 8, window.innerHeight - TH - 8)
      : Math.max(r.top - TH - 8, 8);
    const left = Math.max(8, Math.min(r.left + r.width / 2 - TW / 2, window.innerWidth - TW - 8));
    setPos({ top, left });
  }, [direction]);

  useEffect(() => {
    if (!open) return;
    reposition();
    const close = (e) => {
      if (tooltipRef.current?.contains(e.target)) return;
      if (triggerRef.current?.contains(e.target)) return;
      setOpen(false);
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("touchstart", close);
    window.addEventListener("scroll", reposition, true);
    window.addEventListener("resize", reposition);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("touchstart", close);
      window.removeEventListener("scroll", reposition, true);
      window.removeEventListener("resize", reposition);
    };
  }, [open, reposition]);

  const tooltip = open ? ReactDOM.createPortal(
    <div ref={tooltipRef} style={{
      position:"fixed", zIndex:9999,
      top: pos.top, left: pos.left,
      background:"var(--modal-bg)",
      border:"1px solid var(--glass-border)",
      borderRadius:10,
      padding:"10px 13px",
      width:210, maxWidth:"85vw",
      boxShadow:"0 8px 28px rgba(0,0,0,0.42)",
      pointerEvents:"auto",
    }}>
      <div style={{ fontSize:11, color:"var(--text)", lineHeight:1.6 }}>{text}</div>
    </div>,
    document.body
  ) : null;

  return (
    <span ref={triggerRef} style={{ position:"relative", display:"inline-flex", alignItems:"center", gap:3 }}>
      {children}
      <button
        onClick={e => { e.stopPropagation(); setOpen(o => !o); }}
        style={{
          width:14, height:14, borderRadius:"50%",
          border:`1px solid var(--glass-border)`,
          background:"transparent", cursor:"pointer",
          display:"inline-flex", alignItems:"center", justifyContent:"center",
          color:"var(--muted)", fontSize:8, fontWeight:800, lineHeight:1,
          flexShrink:0, fontFamily:"var(--font)",
        }}
        aria-label="What is this?"
      >?</button>
      {tooltip}
    </span>
  );
}

// ── PRIMITIVE COMPONENTS ──────────────────────────────────────────────────
const Pill = ({ children, color, bg }) => (
  <span style={{ display:"inline-flex",alignItems:"center",fontSize:9,fontWeight:800,letterSpacing:".12em",textTransform:"uppercase",padding:"2px 8px",borderRadius:4,background:bg,color,border:`1px solid ${color}28` }}>
    {children}
  </span>
);
export const Bar = ({ value, color }) => (
  <div className="cb" style={{ marginTop:5 }}>
    <div className="cf" style={{ width:`${Math.min(value,100)}%`, background:color }} />
  </div>
);
export const Lbl = ({ children }) => (
  <div style={{ fontSize:8,color:C.text,opacity:.5,textTransform:"uppercase",letterSpacing:".11em",fontWeight:700,marginBottom:5 }}>{children}</div>
);
export const Panel = ({ label, color, bg, children }) => (
  <div style={{ background:bg,border:`1px solid ${color}22`,borderRadius:9,padding:"10px 11px" }}>
    <Lbl>{label}</Lbl>
    {children}
  </div>
);

// ── RESPONSIVE HOOK ───────────────────────────────────────────────────────
const useIsMobile = () => {
  const [mobile, setMobile] = useState(() => typeof window !== "undefined" && window.innerWidth < 640);
  useEffect(() => {
    const fn = () => setMobile(window.innerWidth < 640);
    window.addEventListener("resize", fn, { passive:true });
    return () => window.removeEventListener("resize", fn);
  }, []);
  return mobile;
};

const useIsDesktop = () => {
  const [desktop, setDesktop] = useState(() => typeof window !== "undefined" && window.innerWidth >= 1024);
  useEffect(() => {
    const fn = () => setDesktop(window.innerWidth >= 1024);
    window.addEventListener("resize", fn, { passive:true });
    return () => window.removeEventListener("resize", fn);
  }, []);
  return desktop;
};

// ── FIXTURE STATUS BADGE ──────────────────────────────────────────────────
// Tiny inline SVGs — shared across status displays (badge, button, Rollover)
const IcoLiveDot = ({size=7,col}) => (
  <svg width={size} height={size} viewBox="0 0 8 8" style={{flexShrink:0}}>
    <circle cx="4" cy="4" r="4" fill={col||C.green} opacity=".25"/>
    <circle cx="4" cy="4" r="2.5" fill={col||C.green}/>
  </svg>
);
const IcoClock = ({size=9,col}) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={col||C.muted} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{flexShrink:0}}>
    <circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>
  </svg>
);
const IcoCheckSm = ({size=9,col}) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={col||C.muted} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{flexShrink:0}}>
    <polyline points="20 6 9 17 4 12"/>
  </svg>
);

export function StatusBadge({ state, time }) {
  const s = (state || "").toLowerCase().replace(/[_\-\s]/g, "");
  // Live / in-play states
  if (["inprogress","live","1sthalf","2ndhalf","halftime","ht","extratime","et","penaltyshootout"].includes(s)) {
    const label = (s === "halftime" || s === "ht") ? "HT"
                : (s === "extratime" || s === "et") ? "ET"
                : s === "penaltyshootout"            ? "PEN"
                : "LIVE";
    return (
      <span style={{ display:"inline-flex",alignItems:"center",gap:4,fontSize:8,fontWeight:800,color:C.green,letterSpacing:".1em" }}>
        <IcoLiveDot col={C.green}/>
        {label}
      </span>
    );
  }
  // Finished states
  if (["finished","ft","fulltime","ended","complete","aet","afterextratime","afterpenalties","3","5"].includes(s)) {
    return (
      <span style={{ display:"inline-flex",alignItems:"center",gap:3,fontSize:8,color:C.muted,fontWeight:700,letterSpacing:".1em" }}>
        <IcoCheckSm col={C.muted}/>
        FT
      </span>
    );
  }
  // Cancelled / postponed / suspended
  if (["cancelled","canceled","postponed","suspended","interrupted","abandoned"].includes(s)) {
    const lbl = s === "postponed" ? "PPD" : (s === "suspended" || s === "interrupted") ? "SUSP" : s === "abandoned" ? "ABD" : "CANC";
    return <span style={{ fontSize:8,color:C.amber,fontWeight:700,letterSpacing:".1em" }}>{lbl}</span>;
  }
  // Default: kick-off time with clock icon
  return (
    <span style={{ display:"inline-flex",alignItems:"center",gap:3,fontSize:9,color:C.text }}>
      <IcoClock col={C.muted} size={8}/>
      {time}
    </span>
  );
}

// ── JARVIS MIND BOX ───────────────────────────────────────────────────────
// Displayed at the top of the Live tab after fixtures load.
// Calls /api/jarvis-mindbox once per day — result is cached in localStorage
// so live-state polling and fixture refreshes don't burn the rate limit.
const MINDBOX_CACHE_KEY = (date) => `grm_mindbox_v1_${date}`;

function JarvisMindBox({ fixtures, date, backtestSummary }) {
  const [mindbox, setMindbox]   = useState(null);
  const [loading, setLoading]   = useState(false);
  const [error, setError]       = useState(null);
  const [collapsed, setCollapsed] = useState(false);
  const calledRef = useRef(false);

  // On date change: restore from cache or clear ready for a fresh call
  useEffect(() => {
    calledRef.current = false;
    setError(null);
    try {
      const cached = JSON.parse(localStorage.getItem(MINDBOX_CACHE_KEY(date)) || "null");
      if (cached) { setMindbox(cached); calledRef.current = true; return; }
    } catch {}
    setMindbox(null);
  }, [date]);

  useEffect(() => {
    if (!fixtures?.length || calledRef.current) return;
    calledRef.current = true;
    setLoading(true);
    setError(null);
    fetch(`${SERVER}/api/jarvis-mindbox`, {
      method: "POST",
      headers: { "Content-Type":"application/json" },
      // C8-FIX: Strip fixtures to only fields the mindbox prompt uses.
      // Sending full fixture objects (with markets[], form[], teamStats etc.)
      // costs ~5-10x the payload size and token count for no benefit.
      // The server only reads: id, league, volatileLeague, theRead.anchor,
      // theEdge.pick, goalRadar summary, markets._lowConfidence.
      body: JSON.stringify({
        date,
        backtestSummary,
        fixtures: fixtures.map(f => ({
          id:            f.id,
          league:        f.league,
          country:       f.country || "",
          volatileLeague: f.volatileLeague || false,
          teams:         f.teams,
          state:         f.state || "",
          theRead:       f.theRead ? {
            anchor: f.theRead.anchor
              ? { pick: f.theRead.anchor.pick, prob: f.theRead.anchor.prob,
                  odds: f.theRead.anchor.odds, market: f.theRead.anchor.market,
                  strong: f.theRead.anchor.strong, empiricalRate: f.theRead.anchor.empiricalRate }
              : null,
            isFallback: f.theRead.isFallback,
          } : null,
          theEdge: f.theEdge
            ? { pick: f.theEdge.pick, prob: f.theEdge.prob, edgeOddsPct: f.theEdge.edgeOddsPct }
            : null,
          goalRadar: f.goalRadar
            ? { home: f.goalRadar.home?.pick || null, away: f.goalRadar.away?.pick || null }
            : null,
          markets: f.markets
            ? { homeXG: f.markets.homeXG, awayXG: f.markets.awayXG,
                bttsYes: f.markets.bttsYes, over25: f.markets.over25,
                _lowConfidence: f.markets._lowConfidence }
            : null,
          strategyTags: f.strategyTags || [],
        })),
      }),
    })
      .then(r => r.json())
      .then(d => {
        if (d.mindbox) {
          setMindbox(d.mindbox);
          // Persist so live-state refreshes don't re-call the API
          try { localStorage.setItem(MINDBOX_CACHE_KEY(date), JSON.stringify(d.mindbox)); } catch {}
        } else {
          setError("No mindbox data");
        }
      })
      .catch(e => setError(friendlyError(e, "Jarvis")))
      .finally(() => setLoading(false));
  }, [fixtures?.length > 0, date]);

  const riskColor = mindbox?.riskLevel === "LOW" ? C.green
                  : mindbox?.riskLevel === "HIGH" ? C.red
                  : C.amber;

  return (
    <div className="grm-mindbox">
      <div className="grm-mindbox-header" style={{ marginBottom: collapsed ? 0 : 12 }}>
        <div style={{ display:"flex",alignItems:"center",gap:8 }}>
          <Tip text="A daily market intelligence summary generated by Jarvis. Covers overall risk level, the best market type for today, games to avoid, and hidden opportunities across the fixture list." direction="down">
            <span className="grm-mindbox-title">Jarvis · Mind Box</span>
          </Tip>
          {mindbox?.riskLevel && !collapsed && (
            <span className="grm-chip" style={{ color:riskColor, borderColor:`${riskColor}50`, background:`${riskColor}14` }}>
              {mindbox.riskLevel} RISK
            </span>
          )}
        </div>
        <button onClick={() => setCollapsed(c => !c)} className="gb"
          style={{ background:"transparent",border:"none",color:C.muted,fontSize:11,padding:"0 4px",lineHeight:1 }}>
          {collapsed ? "▼" : "▲"}
        </button>
      </div>

      {!collapsed && (
        <>
          {loading && (
            <div style={{ fontSize:9,color:C.muted,fontStyle:"italic" }}>
              <span className="pu">Jarvis is reading the board…</span>
            </div>
          )}
          {error && (
            <div style={{ fontSize:9,color:C.amber,display:"flex",alignItems:"center",gap:8,background:`${C.amber}08`,border:`1px solid ${C.amber}22`,borderRadius:7,padding:"8px 11px" }}>
              <span style={{ flex:1,lineHeight:1.5 }}>
                {error.toLowerCase().includes("429") || error.toLowerCase().includes("rate") || error.toLowerCase().includes("quota")
                  ? "Jarvis hit a rate limit — try again in a minute."
                  : error.toLowerCase().includes("network") || error.toLowerCase().includes("fetch") || error.toLowerCase().includes("failed")
                  ? "Jarvis could not connect — check your server connection."
                  : "Jarvis is unavailable right now. Tap Retry when ready."}
              </span>
              <button onClick={() => {
                try { localStorage.removeItem(MINDBOX_CACHE_KEY(date)); } catch {}
                calledRef.current = false; setMindbox(null); setError(null);
              }} className="gb-ghost" style={{ fontSize:8,padding:"3px 10px",flexShrink:0 }}>
                Retry
              </button>
            </div>
          )}
          {mindbox && !loading && (
            <div style={{ display:"flex",flexDirection:"column",gap:10 }}>
              <div className="grm-mindbox-brief">"{mindbox.brief}"</div>

              <div className="grm-mindbox-grid">
                {mindbox.riskReason && (
                  <div className="grm-mindbox-cell" style={{ borderColor:`${riskColor}28` }}>
                    <div className="grm-mindbox-cell-label" style={{ color:riskColor }}>RISK</div>
                    <div className="grm-mindbox-cell-text">{mindbox.riskReason}</div>
                  </div>
                )}
                {mindbox.marketOfDay && (
                  <div className="grm-mindbox-cell" style={{ borderColor:C.goldBorder }}>
                    <div className="grm-mindbox-cell-label" style={{ color:C.gold }}>MARKET OF THE DAY</div>
                    <div className="grm-mindbox-cell-text"><strong>{mindbox.marketOfDay}</strong> — {mindbox.marketOfDayReason}</div>
                  </div>
                )}
              </div>

              {((mindbox.warnings?.length > 0) || (mindbox.gems?.length > 0)) && (
                <div className="grm-mindbox-grid">
                  {mindbox.warnings?.length > 0 && (
                    <div className="grm-mindbox-cell" style={{ borderColor:`${C.red}28`, background:`${C.red}06` }}>
                      <div className="grm-mindbox-cell-label" style={{ color:C.red }}>⚠ AVOID</div>
                      {mindbox.warnings.map((w,i) => (
                        <div key={i} style={{ fontSize:8,color:C.red,lineHeight:1.55 }}>· {w}</div>
                      ))}
                    </div>
                  )}
                  {mindbox.gems?.length > 0 && (
                    <div className="grm-mindbox-cell" style={{ borderColor:`${C.green}28`, background:`${C.green}06` }}>
                      <div className="grm-mindbox-cell-label" style={{ color:C.green }}>Gems</div>
                      {mindbox.gems.map((g,i) => (
                        <div key={i} style={{ fontSize:8,color:C.green,lineHeight:1.55 }}>· {g}</div>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {mindbox.navigation && (
                <div style={{ fontSize:9,color:C.text,lineHeight:1.55,borderTop:`1px solid ${C.border}`,paddingTop:8 }}>
                  {mindbox.navigation}
                </div>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ── ASK JARVIS (per-card) ─────────────────────────────────────────────────
export function AskJarvis({ fixture, backtestSummary, brief = null }) {
  const [open,     setOpen]     = useState(false);
  const [question, setQuestion] = useState("");
  const [messages, setMessages] = useState([]); // { role: "user"|"jarvis", text }
  const [loading,  setLoading]  = useState(false);
  const inputRef   = useRef(null);
  const bottomRef  = useRef(null);

  // Scroll to bottom whenever messages change
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, loading]);

  const ask = async (q) => {
    const trimmed = (q || question).trim();
    if (!trimmed) return;

    // Add user bubble immediately
    setMessages(prev => [...prev, { role: "user", text: trimmed }]);
    setQuestion("");
    setLoading(true);

    try {
      const m  = fixture.markets || {};
      const mLines = Object.keys(m).length
        ? Object.entries(m).map(([k, v]) =>
            `${k}: prob=${v.prob??"-"} odds=${v.odds??"-"} effRate=${v.effRate??v.historicalRate??"-"}`
          ).join("\n")
        : null;

      // C4/P7-FIX: The user's question is the primary prompt. Background context
      // is passed as a SYSTEM block so Gemini actually answers the question asked —
      // not re-runs the Jarvis analysis. Previously contextualQ appended a hardcoded
      // 4-section instruction after the question, which caused Gemini to ignore the
      // question and reproduce the full analysis every time.
      const systemContext = [
        `You are Jarvis, an AI sports analyst embedded in a football prediction app.`,
        `You have already produced a full match analysis for this fixture.`,
        `The user is now asking a follow-up question. Answer ONLY that question.`,
        `Be concise — 2-4 sentences max. Plain English. No section headers. No emoji. No "as an AI".`,
        brief       ? `\nYour earlier analysis:\n${brief}` : "",
        mLines      ? `\nModel data:\n${mLines}` : "",
        fixture.form?.home?.length ? `\nHome form: ${fixture.form.home.join("")}` : "",
        fixture.form?.away?.length ? `Away form: ${fixture.form.away.join("")}` : "",
      ].filter(Boolean).join("\n");

      const res  = await fetch(`${SERVER}/api/jarvis-match`, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          fixture,
          question:       trimmed,
          systemOverride: systemContext,
          backtestSummary,
        }),
      });
      const data = await res.json();
      const reply = (data.analysis || data.error || "No response").trim();
      // Strip any section headers Gemini still sneaks in (bold **X** patterns)
      const clean = reply.replace(/\*\*[^*]+\*\*[\s:—–-]*/g, "").trim();
      setMessages(prev => [...prev, { role: "jarvis", text: clean }]);
    } catch (e) {
      const msg = e.message || "";
      const isRate = /429|503|rate/i.test(msg);
      setMessages(prev => [...prev, {
        role: "jarvis",
        text: isRate
          ? "Hit a rate limit — wait a few seconds and try again."
          : "Couldn't reach Jarvis. Check connection and retry.",
        isError: true,
      }]);
    } finally {
      setLoading(false);
    }
  };

  // C4/P7-FIX: Dynamic preset chips — generated from the fixture's actual pick
  // and market so they're always contextually relevant.
  // Old hardcoded chips ("Why not Under 3.5?", "Is the Draw the safer option?")
  // were nonsensical when the pick was something like "BTTS Yes" or "Away Win".
  const anchor     = fixture.theRead?.anchor;
  const pickLabel  = anchor?.pick || "this pick";
  const market     = (anchor?.market || "").toLowerCase();
  const homeTeam   = fixture.teams?.home || "Home";
  const awayTeam   = fixture.teams?.away || "Away";

  const quickPrompts = (() => {
    const base = [
      `${pickLabel} — what could go wrong?`,
      "Any key injuries or lineup news?",
      "Best alternative market here?",
    ];
    // Add market-specific chips only when relevant
    if (/over|goals|btts/i.test(market) || /over|goals/i.test(pickLabel)) {
      base.unshift(`How is ${homeTeam}'s defensive form?`);
    } else if (/win|home|away/i.test(market) || /win/i.test(pickLabel)) {
      base.unshift(`Is ${pickLabel} good value at these odds?`);
    } else if (/draw/i.test(pickLabel)) {
      base.unshift("Why is the draw backed here?");
    }
    return base.slice(0, 4); // cap at 4 chips
  })();

  if (!open) {
    return (
      <button onClick={() => { setOpen(true); setTimeout(() => inputRef.current?.focus(), 50); }}
        className="gb"
        style={{ width:"100%",background:`${C.edge}08`,border:`1px solid ${C.edge}30`,
                 padding:"10px 14px",marginTop:4,borderRadius:"var(--btn-radius)",
                 display:"flex",alignItems:"center",gap:10,textAlign:"left" }}>
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke={C.edge} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink:0 }}>
          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
        </svg>
        <div>
          <div style={{ fontSize:10,fontWeight:800,color:C.edge }}>Ask Jarvis</div>
          <div style={{ fontSize:8,color:C.muted,fontWeight:500,marginTop:1 }}>Have a question about this analysis? Tap here.</div>
        </div>
      </button>
    );
  }

  return (
    <div className="grm-jarvis-panel">
      <div className="grm-jarvis-header">
        <span className="grm-jarvis-title">Ask Jarvis</span>
        <button onClick={() => { setOpen(false); setMessages([]); setQuestion(""); }}
          style={{ background:"transparent",border:"none",color:C.muted,fontSize:13,padding:0,cursor:"pointer",lineHeight:1 }}>✕</button>
      </div>

      {/* Quick prompt chips — dynamically generated from fixture pick/market */}
      {messages.length === 0 && (
        <div style={{ display:"flex",gap:4,flexWrap:"wrap",marginBottom:8 }}>
          {quickPrompts.map((p, i) => (
            <button key={i} onClick={() => ask(p)}
              style={{ fontSize:8,padding:"3px 9px",background:"transparent",
                       border:`1px solid ${C.edge}28`,color:C.text,borderRadius:5,
                       cursor:"pointer",fontFamily:C.font }}>
              {p}
            </button>
          ))}
        </div>
      )}

      {/* Chat bubbles */}
      {messages.length > 0 && (
        <div style={{ display:"flex",flexDirection:"column",gap:8,marginBottom:10,
                      maxHeight:240,overflowY:"auto",paddingRight:2 }}>
          {messages.map((msg, i) => (
            <div key={i} style={{
              display:"flex",
              justifyContent: msg.role === "user" ? "flex-end" : "flex-start",
            }}>
              <div style={{
                maxWidth:"85%",
                padding:"8px 11px",
                borderRadius: msg.role === "user" ? "12px 12px 2px 12px" : "12px 12px 12px 2px",
                background: msg.role === "user"
                  ? `${C.accent}18`
                  : msg.isError ? `${C.amber}10` : `${C.edge}10`,
                border: `1px solid ${msg.role === "user" ? `${C.accent}30` : msg.isError ? `${C.amber}25` : `${C.edge}20`}`,
                fontSize: 10,
                color: msg.isError ? C.amber : C.text,
                lineHeight: 1.65,
                fontFamily: C.font,
              }}>
                {msg.role === "jarvis" && (
                  <div style={{ fontSize:8,fontWeight:800,color:C.edge,letterSpacing:".06em",
                                textTransform:"uppercase",marginBottom:4 }}>Jarvis</div>
                )}
                {msg.text}
              </div>
            </div>
          ))}
          {loading && (
            <div style={{ display:"flex",justifyContent:"flex-start" }}>
              <div style={{ padding:"8px 12px",borderRadius:"12px 12px 12px 2px",
                            background:`${C.edge}10`,border:`1px solid ${C.edge}20`,
                            fontSize:9,color:C.muted,fontStyle:"italic" }}>
                <span className="pu">Jarvis is thinking…</span>
              </div>
            </div>
          )}
          <div ref={bottomRef} />
        </div>
      )}

      {/* Input row */}
      <div style={{ display:"flex",gap:6 }}>
        <input ref={inputRef} type="text" value={question}
          onChange={e => setQuestion(e.target.value)}
          onKeyDown={e => e.key === "Enter" && question.trim() && !loading && ask()}
          placeholder="Ask anything about this match…"
          className="gi" style={{ flex:1,fontSize:9 }} />
        <button onClick={() => ask()} disabled={loading || !question.trim()}
          className="gb-primary"
          style={{ padding:"5px 14px",fontSize:10,opacity:loading||!question.trim() ? .45 : 1 }}>
          {loading ? <span className="pu">…</span> : "→"}
        </button>
      </div>
    </div>
  );
}

// ── RESULT BADGE ──────────────────────────────────────────────────────────
function ResultBadge({ f }) {
  // Neutral score display — not tied to any pick, no green/red evaluation on the card.
  // Pick results are evaluated in the ticket (Check Progress), not on the fixture card.
  if (f.hGoals == null) return null;
  const score = `${f.hGoals}–${f.aGoals}`;
  const ft    = f.state && ["finished","ft","fulltime","ended","complete","aet"].includes(
    (f.state || "").toLowerCase().replace(/[_\-\s]/g, "")
  );
  return (
    <div className="grm-score-badge">
      <span className="grm-score-value">{score}</span>
      {ft && <span className="grm-score-ft">FT</span>}
    </div>
  );
}

// ── CLIENT RESULT EVALUATOR ───────────────────────────────────────────────
// evalPickResult → engine.js

// ── FORM ROW ──────────────────────────────────────────────────────────────
// Source: SofaScore pregame endpoint — current competition only, oldest→newest (left to right).
// Differs from Team Totals recent results (all-competition, newest first).
// Note: for Cup / UCL fixtures, this reflects CL form only, not league form.
export function FormRow({ home, away, allCompHome, allCompAway }) {
  const dot = r => ({ W:C.green, D:C.gold, L:C.red }[r] || C.faint);
  // Prefer all-comp form if competition-only form is thin (< 3 games)
  const hForm = (home?.length >= 3) ? home : (allCompHome?.length ? allCompHome : home);
  const aForm = (away?.length >= 3) ? away : (allCompAway?.length ? allCompAway : away);
  const isAllComp = (home?.length < 3 && allCompHome?.length > 0) || (away?.length < 3 && allCompAway?.length > 0);
  const dots = (form, isHome) => (form || []).slice(0, 5).map((r, i) =>
    <span key={i}
      title={`${i===0?"oldest":""}${i===4?"newest":""} · ${r==="W"?"Win":r==="D"?"Draw":r==="L"?"Loss":"?"} (${isAllComp?"all comps":"this comp"})`}
      style={{ width:8,height:8,borderRadius:"50%",background:dot(r),display:"inline-block",margin:"0 1px" }}/>
  );
  return (
    <div style={{ display:"flex",justifyContent:"space-between",alignItems:"center",marginTop:4 }}>
      <div style={{ display:"flex",alignItems:"center",gap:3 }}>
        {dots(hForm, true)}
        {isAllComp && <span style={{ fontSize:6,color:C.muted,opacity:.6 }}>all</span>}
      </div>
      <div style={{ display:"flex",alignItems:"center",gap:3 }}>
        {isAllComp && <span style={{ fontSize:6,color:C.muted,opacity:.6 }}>all</span>}
        {dots(aForm, false)}
      </div>
    </div>
  );
}

// ── SMART PICK ABBREVIATION ───────────────────────────────────────────────
// Builds the best short label for a pick given team names.
// Rule: assemble abbreviated form, check if ≤ 12 chars, else collapse to role.
// abbreviatePick → engine.js

// ── COMPACT SIGNAL STRIP ─────────────────────────────────────────────────
function SignalCard({ label, color, bg, border, pick, prob, odds, badge, badgeColor, noSignal, onAdd, alreadyAdded, onExpand, home, away, isFinished }) {
  const [added, setAdded] = useState(false);
  const handleAdd = (e) => {
    e.stopPropagation();
    // A8-FIX: block adding finished match legs from the compact strip.
    // AddToTicketBtn already guards this in expanded panels but SignalCard didn't.
    if (!onAdd || isFinished) return;
    onAdd();
    setAdded(true);
    setTimeout(() => setAdded(false), 1400);
  };
  const pickLabel = abbreviatePick(pick, home, away);

  if (noSignal) return (
    <div className="grm-signal-card" style={{ flex:1,minWidth:0,background:C.surface,border:`1px solid ${C.border}`,opacity:.45 }}>
      <div className="grm-signal-label" style={{ color:C.muted }}>{label}</div>
      <div style={{ fontSize:8,color:C.muted,fontStyle:"italic" }}>No signal</div>
    </div>
  );

  return (
    <div onClick={onExpand} className="grm-signal-card" style={{ flex:1,minWidth:0,background:bg,border:`1px solid ${border}`,cursor:"pointer" }}>
      <div style={{ display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:3 }}>
        <span className="grm-signal-label" style={{ color }}>{label}</span>
        {badge && <span style={{ fontSize:6,color:badgeColor||color,background:`${badgeColor||color}18`,borderRadius:3,padding:"1px 4px",fontWeight:800,maxWidth:60,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap" }}>{badge}</span>}
      </div>
      <div title={pick} style={{ fontSize:11,fontWeight:800,color,lineHeight:1.2,marginBottom:4,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis" }}>
        {pickLabel}
      </div>
      <div style={{ display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:4 }}>
        <span style={{ fontSize:13,fontWeight:800,color }}>{prob != null ? Math.round(prob)+"%" : "—"}</span>
        {odds && <span style={{ fontSize:9,color:C.text }}>{odds}x</span>}
      </div>
      <div style={{ height:3,background:C.faint,borderRadius:2,overflow:"hidden",marginBottom:6 }}>
        <div style={{ height:"100%",width:`${Math.min(prob||0,100)}%`,background:color,borderRadius:2 }}/>
      </div>
      {(onAdd || isFinished) && (
        <button onClick={handleAdd} className="grm-add-btn"
          style={{
            background: isFinished ? `${C.muted}0a` : added ? `${C.green}18` : alreadyAdded ? `${C.green}10` : `${color}14`,
            color: isFinished ? C.muted : added || alreadyAdded ? C.green : color,
            borderColor: isFinished ? `${C.muted}25` : `${added || alreadyAdded ? C.green : color}40`,
            marginTop:2, cursor: isFinished ? "default" : "pointer",
          }}>
          {isFinished ? "Finished" : added ? "✓ Added!" : alreadyAdded ? "↺ Replace" : "+ Ticket"}
        </button>
      )}
    </div>
  );
}

function SignalStrip({ theRead, theEdge, goalRadar, fixture, onAddToParlay, alreadyAdded, onExpand, isFinished }) {
  const anchor = theRead?.anchor;
  const mst    = anchor ? mktStyle(anchor.market) : null;
  const radarEntry = goalRadar?.home || goalRadar?.away || null;
  const home = fixture?.teams?.home;
  const away = fixture?.teams?.away;

  const readCard = anchor ? {
    label:"THE READ", color:mst.color, bg:mst.bg, border:mst.color+"30",
    pick:anchor.pick, prob:anchor.prob, odds:anchor.odds,
    home, away,
    badge: anchor.strong && !fixture.markets?._lowConfidence ? "STRONG"
         : anchor.strong && fixture.markets?._lowConfidence ? "soft signal"
         : theRead?.isFallback ? "LOW SIG" : null,
    badgeColor: anchor.strong && !fixture.markets?._lowConfidence ? C.gold : C.amber,
    onAdd: onAddToParlay ? () => onAddToParlay(anchor) : null,
  } : { label:"THE READ", noSignal:true };

  const edgeCard = theEdge ? {
    label:"THE EDGE", color:C.edge, bg:C.edgeDim, border:C.edgeBorder,
    pick:theEdge.pick, prob:theEdge.prob, odds:theEdge.odds,
    home, away,
    badge: theEdge.lowValue ? "unclear" :
           theEdge.convergenceCount >= 3 ? `strong (${theEdge.convergenceCount})` :
           theEdge.convergenceCount === 2 ? "2 signals" : "1 signal",
    badgeColor: theEdge.lowValue ? C.amber : C.edge,
    onAdd: onAddToParlay ? () => onAddToParlay(theEdge) : null,
  } : { label:"THE EDGE", noSignal:true };

  const radarCard = radarEntry ? {
    label:"GOAL RADAR", color:C.radar, bg:C.radarDim, border:C.radarBorder,
    pick:radarEntry.pick, prob:radarEntry.prob, odds:radarEntry.odds,
    home, away,
    onAdd: onAddToParlay ? () => onAddToParlay({ ...radarEntry, market:"TeamTotal" }) : null,
  } : { label:"GOAL RADAR", noSignal:true };

  return (
    <div style={{ display:"flex",gap:6 }}>
      <SignalCard {...readCard}  alreadyAdded={alreadyAdded} onExpand={onExpand} isFinished={isFinished}/>
      <SignalCard {...edgeCard}  alreadyAdded={alreadyAdded} onExpand={onExpand} isFinished={isFinished}/>
      <SignalCard {...radarCard} alreadyAdded={alreadyAdded} onExpand={onExpand} isFinished={isFinished}/>
    </div>
  );
}

// ── THE READ SECTION ──────────────────────────────────────────────────────
// ── ADD TO TICKET WITH FEEDBACK ──────────────────────────────────────────
// Shows "✓ Added!" flash for 1.5s so the user knows the leg was registered.
// Also prevents duplicate add (button stays green if already in draft).
function AddToTicketBtn({ onClick, color, alreadyAdded, otherInDraft, label, isFinished = false }) {
  const [flash, setFlash] = useState(false);

  if (isFinished) {
    return (
      <div className="grm-add-btn-finished" style={{ display:"flex",alignItems:"center",justifyContent:"center",gap:5 }}>
        <IcoCheckSm size={10} col={C.muted}/>
        Match Finished
      </div>
    );
  }

  const handleClick = (e) => {
    e.stopPropagation();
    onClick();
    setFlash(true);
    setTimeout(() => setFlash(false), 1500);
  };

  const done      = flash;
  // Priority: flash > this pick in draft > other pick in draft > neutral
  const btnColor  = done ? C.green : alreadyAdded ? C.green : otherInDraft ? color : color;
  const btnBg     = done ? `${C.green}18` : alreadyAdded ? `${C.green}10` : otherInDraft ? `${color}10` : `${color}14`;
  const btnLabel  = done        ? "✓ Added"
                  : alreadyAdded ? "✓ Added"
                  : otherInDraft ? "↺ Replace"
                  : (label || "+ Add to Ticket");
  return (
    <button onClick={handleClick} className="grm-add-btn"
      style={{ background:btnBg, color:btnColor, borderColor:`${btnColor}40` }}>
      {btnLabel}
    </button>
  );
}

export function TheReadSection({ theRead, onAddToParlay, fixture, alreadyAdded, otherInDraft }) {
  if (!theRead) return null;
  const { anchor, reinforcer, isFallback, scenario } = theRead;
  if (!anchor) return null;

  const mst = mktStyle(anchor.market);
  const accentColor = isFallback ? C.muted : mst.color;
  const accentBg    = isFallback ? C.surface : mst.bg;
  const accentBorder = isFallback ? C.border : `${accentColor}28`;

  const ftStates = ["finished","ft","fulltime","ended","complete","aet","afterextratime","afterpenalties"];
  const isFinished = ftStates.includes((fixture?.state || "").toLowerCase().replace(/[_\-\s]/g,""));

  return (
    <div className="grm-signal-panel" style={{ background:accentBg, border:`1px solid ${accentBorder}` }}>

      <div className="grm-signal-panel-header">
        <div className="grm-signal-panel-title">
          <Tip text="The model's single highest-confidence pick for this match. Driven by statistical signal convergence, not just probability.">
            <span className="grm-signal-panel-name" style={{ color:accentColor }}>
              {isFallback ? "THE READ · LOW SIGNAL" : "THE READ"}
            </span>
          </Tip>
          {!isFallback && <span className="grm-signal-panel-sub" style={{ color:accentColor }}>highest confidence</span>}
          {!isFallback && anchor.strong && !fixture.markets?._lowConfidence && (
            <span className="grm-chip" style={{ color:C.gold, borderColor:`${C.gold}50`, background:C.goldDim }}>STRONG</span>
          )}
          {!isFallback && anchor.strong && fixture.markets?._lowConfidence && (
            <span style={{ fontSize:7,color:C.amber,fontStyle:"italic",opacity:.8 }}>Strong · limited data</span>
          )}
        </div>
        {anchor.odds && <span className="grm-signal-panel-odds">{anchor.odds}x</span>}
      </div>

      <div className="grm-signal-panel-pick" style={{ color:accentColor }}>{anchor.pick}</div>

      <div style={{ display:"flex",justifyContent:"space-between",alignItems:"center" }}>
        <span className="grm-signal-panel-prob" style={{ color:accentColor }}>{Math.round(anchor.prob)}%</span>
        {!isFallback && <span style={{ fontSize:8,color:C.muted,fontStyle:"italic" }}>{scenario}</span>}
      </div>
      <Bar value={anchor.prob} color={accentColor} />

      {!isFallback && anchor.empiricalRate != null && (anchor.sampleSize == null || anchor.sampleSize >= 5) && (
        <div className="grm-signal-panel-meta">
          {anchor.market} hit rate: <strong style={{ color:C.text,opacity:.8 }}>{anchor.empiricalRate}%</strong>
          {anchor.sampleSize != null && <span style={{ opacity:.55 }}> ({anchor.sampleSize} games)</span>}
        </div>
      )}

      {reinforcer && (
        <div className="grm-signal-panel-divider" style={{ borderTop:`1px solid ${accentColor}18` }}>
          <span style={{ fontSize:9,color:C.muted,textTransform:"uppercase",letterSpacing:".1em" }}>Reinforced by</span>
          <div style={{ marginTop:4,display:"flex",alignItems:"center",gap:8,flexWrap:"wrap" }}>
            <span style={{ fontSize:10,fontWeight:700,color:mktStyle(reinforcer.market).color }}>{reinforcer.pick}</span>
            {reinforcer.combined ? (
              <div style={{ display:"flex",gap:6,alignItems:"center" }}>
                <span style={{ fontSize:10,color:mktStyle(reinforcer.market).color,fontWeight:800 }}>{Math.round(reinforcer.prob)}%</span>
                <span style={{ fontSize:8,color:C.muted }}>·</span>
                <span style={{ fontSize:8,color:C.muted }}>O1.5</span>
                <span style={{ fontSize:10,color:mktStyle(reinforcer.market).color,fontWeight:700 }}>{Math.round(reinforcer.probO15)}%</span>
              </div>
            ) : (
              <div style={{ display:"flex",alignItems:"center",gap:6 }}>
                <span style={{ fontSize:10,fontWeight:800,color:mktStyle(reinforcer.market).color }}>{Math.round(reinforcer.prob)}%</span>
                {reinforcer.odds && <span style={{ fontSize:9,color:C.muted }}>{reinforcer.odds}x</span>}
              </div>
            )}
          </div>
        </div>
      )}

      {onAddToParlay && !isFallback && (
        <AddToTicketBtn onClick={() => onAddToParlay(anchor)} color={accentColor}
                        alreadyAdded={alreadyAdded} otherInDraft={otherInDraft} isFinished={isFinished} />
      )}
    </div>
  );
}

// ── THE EDGE SECTION ──────────────────────────────────────────────────────
export function TheEdgeSection({ theEdge, onAddToParlay, alreadyAdded, otherInDraft, fixture }) {
  const ftStates = ["finished","ft","fulltime","ended","complete","aet","afterextratime","afterpenalties"];
  const isFinished = ftStates.includes((fixture?.state || "").toLowerCase().replace(/[_\-\s]/g,""));

  if (!theEdge) return (
    <div className="grm-signal-panel-empty">
      <span style={{ fontSize:8,color:C.muted,fontWeight:700,letterSpacing:".1em",textTransform:"uppercase" }}>THE EDGE — no signal</span>
    </div>
  );

  const isOdds = theEdge.type === "odds";
  return (
    <div className="grm-signal-panel" style={{ background:C.edgeDim, border:`1px solid ${C.edgeBorder}` }}>

      <div className="grm-signal-panel-header">
        <div className="grm-signal-panel-title">
          <Tip text="The pick where the model's probability most exceeds what the bookmaker's odds imply. This is where the value is — not necessarily the most likely outcome, but the best-priced one.">
            <span className="grm-signal-panel-name" style={{ color:C.edge }}>THE EDGE</span>
          </Tip>
          <span className="grm-signal-panel-sub" style={{ color:C.edge }}>best odds value</span>
          {theEdge.edgeOddsPct && (
            <span className="grm-chip" style={{ color:C.green, borderColor:`${C.green}40`, background:C.greenDim }}>
              +{theEdge.edgeOddsPct}% vs book
            </span>
          )}
          {theEdge.lowValue && (
            <span className="grm-chip" style={{ color:C.amber, borderColor:`${C.amber}40`, background:C.amberDim }}>
              unclear
            </span>
          )}
          {/* Removed convergenceCount chip — "2 signals" / "1 signal" is internal model metadata
              that adds confusion rather than clarity. The value gap (+X% vs book) is what matters. */}
        </div>
        {theEdge.odds && <span className="grm-signal-panel-odds">{theEdge.odds}x</span>}
      </div>

      <div className="grm-signal-panel-pick" style={{ color:C.edge }}>{theEdge.pick}</div>
      <div className="grm-signal-panel-narrative">{theEdge.narrative}</div>

      <div style={{ display:"flex",justifyContent:"space-between",alignItems:"center" }}>
        <span className="grm-signal-panel-prob" style={{ color:C.edge }}>{Math.round(theEdge.prob)}%</span>
        {/* N2-FIX: show base prob + pp gain breakdown when convergence boosted the probability */}
        {theEdge.baseProb != null && theEdge.ppGain != null && Math.abs(theEdge.ppGain) >= 1 && (
          <span style={{ fontSize:9, color:C.muted, letterSpacing:".02em" }}>
            {theEdge.baseProb}% base
            <span style={{ color:C.edge, fontWeight:700 }}> +{theEdge.ppGain}pp</span>
            {" "}<span style={{ color:C.muted }}>({theEdge.convergenceCount}-signal)</span>
          </span>
        )}
      </div>
      <Bar value={theEdge.prob} color={C.edge} />

      {onAddToParlay && (
        <AddToTicketBtn onClick={() => onAddToParlay(theEdge)} color={C.edge}
                        alreadyAdded={alreadyAdded} otherInDraft={otherInDraft} isFinished={isFinished} />
      )}
    </div>
  );
}

// ── GOAL RADAR SECTION ────────────────────────────────────────────────────
export function GoalRadarSection({ goalRadar, onAddToParlay, alreadyAdded, otherInDraft }) {
  if (!goalRadar) return null;
  const { home, away, homeExtra, awayExtra } = goalRadar;
  if (!home && !away) return null;
  const [flashed, setFlashed] = useState({});

  const handleAdd = (entry) => {
    if (!onAddToParlay) return;
    onAddToParlay(entry);
    setFlashed(prev => ({ ...prev, [entry.pick]: true }));
    setTimeout(() => setFlashed(prev => ({ ...prev, [entry.pick]: false })), 1400);
  };

  const renderEntry = (entry, isExtra = false) => {
    const done = flashed[entry.pick];
    // Three states: this entry just flashed / this pick in draft / other pick in draft / neutral
    const btnColor = done || alreadyAdded ? C.green : otherInDraft ? C.radar : C.radar;
    const btnBg    = done ? `${C.green}18` : alreadyAdded ? `${C.green}10` : C.radarDim;
    const btnLabel = done ? "✓ Added" : alreadyAdded ? "✓ Added" : otherInDraft ? "↺ Replace" : "+ Ticket";
    return (
      <div key={entry.pick} className="grm-radar-entry"
        style={{ background:`${C.radar}10`, borderColor:isExtra ? `${C.radar}18` : `${C.radar}28`, opacity:isExtra?0.82:1 }}>
        <div className="grm-radar-entry-pick">{entry.pick}</div>
        <div style={{ display:"flex",justifyContent:"space-between",alignItems:"center" }}>
          <span className="grm-radar-entry-prob">{Math.round(entry.prob)}%</span>
          {entry.odds && <span style={{ fontSize:9,color:C.muted }}>{entry.odds}x</span>}
        </div>
        <Bar value={entry.prob} color={C.radar} />
        {isExtra
          ? <div style={{ marginTop:5,fontSize:8,color:C.radar,fontStyle:"italic",display:"flex",alignItems:"center",gap:4 }}>
              <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><line x1="12" y1="2" x2="12" y2="6"/><line x1="12" y1="18" x2="12" y2="22"/><line x1="4.93" y1="4.93" x2="7.76" y2="7.76"/><line x1="16.24" y1="16.24" x2="19.07" y2="19.07"/><line x1="2" y1="12" x2="6" y2="12"/><line x1="18" y1="12" x2="22" y2="12"/><line x1="4.93" y1="19.07" x2="7.76" y2="16.24"/><line x1="16.24" y1="7.76" x2="19.07" y2="4.93"/></svg>
              O1.5 also strong — add via Custom Pick
            </div>
          : onAddToParlay && (
            <button onClick={() => handleAdd(entry)} className="grm-add-btn"
              style={{ background:btnBg, color:btnColor, borderColor:`${btnColor}40`, marginTop:6 }}>
              {btnLabel}
            </button>
          )
        }
      </div>
    );
  };

  return (
    <div className="grm-signal-panel" style={{ background:C.radarDim, border:`1px solid ${C.radarBorder}` }}>
      <Tip text="Probability that each team scores at least one goal in this match, based on attack strength, defence quality, and recent form.">
        <span className="grm-signal-panel-name" style={{ color:C.radar }}>GOAL RADAR</span>
      </Tip>
      <div style={{ display:"flex",gap:8,marginTop:8,flexWrap:"wrap" }}>
        {home && renderEntry(home)}
        {homeExtra && renderEntry(homeExtra, true)}
        {away && renderEntry(away)}
        {awayExtra && renderEntry(awayExtra, true)}
      </div>
    </div>
  );
}

// ── COMBO ROW ─────────────────────────────────────────────────────────────
export function ComboRow({ combo, onAddToParlay }) {
  const [added, setAdded] = useState(false);
  const color = combo.type === "DC" ? C.dc : C.radar;

  const handleComboAdd = () => {
    if (!onAddToParlay || !combo.picks?.length) return;
    // Add each pick in the combo as a separate leg — user sees them in draft
    // and can remove any they don't want. We can't book multi-pick combos as
    // one leg anyway; each is a distinct market selection.
    combo.picks.forEach(p => {
      onAddToParlay({
        pick:   p.pick,
        prob:   combo.prob,
        odds:   p.odds || safeImpliedOdds(combo.prob / combo.picks.length),
        market: p.market || inferMarket(p.pick),
      });
    });
    setAdded(true);
    setTimeout(() => setAdded(false), 1400);
  };

  return (
    <div className="grm-combo-row" style={{ border:`1px solid ${color}22` }}>
      <div style={{ display:"flex",justifyContent:"space-between",alignItems:"center" }}>
        <span style={{ fontSize:9,color,fontWeight:700 }}>{combo.label}</span>
        <div style={{ display:"flex",alignItems:"center",gap:8 }}>
          <span style={{ fontSize:10,color,fontWeight:800 }}>{combo.prob}%</span>
        </div>
      </div>
      <div style={{ display:"flex",gap:5,marginTop:5,flexWrap:"wrap" }}>
        {combo.picks.map((p,i) => (
          <span key={i} className="grm-combo-pick-chip">
            {p.pick}{p.odds ? ` @ ${p.odds}` : ""}
          </span>
        ))}
      </div>
    </div>
  );
}

// ── GOALS PANEL (expanded) ────────────────────────────────────────────────
export function GoalsPanel({ f }) {
  const m = f.markets;
  const scoreBright = parseFloat(m.likelyScoreProb) >= 15;
  return (
    <Panel label="Goal Range" color={C.orange} bg={C.orangeDim}>
      <div style={{ marginBottom:8 }}>
        <div style={{ display:"flex",alignItems:"center",gap:6,marginBottom:3 }}>
          <span style={{ fontSize:10,fontWeight:800,color:C.orange }}>{f.goalRange}</span>
          <span style={{ fontSize:8,color:C.text }}>
            xG <span style={{ color:C.text,fontWeight:700 }}>{m.homeXG}</span>
            {" – "}
            <span style={{ color:C.text,fontWeight:700 }}>{m.awayXG}</span>
          </span>
        </div>
        {f.goalInsight && <div style={{ fontSize:8,color:C.text,fontStyle:"italic",lineHeight:1.4 }}>{f.goalInsight}</div>}
      </div>
      {[
        { l:"O1.5", prob:m.over15,  odds:f.odds?.over15odds  },
        { l:"O2.5", prob:m.over25,  odds:f.odds?.over25odds  },
        { l:"O3.5", prob:m.over35,  odds:f.odds?.over35odds  },
        { l:"U2.5", prob:m.under25, odds:f.odds?.under25odds },
        { l:"U3.5", prob:m.under35, odds:f.odds?.under35odds },
      ].map(r => (
        <div key={r.l} style={{ display:"flex",alignItems:"center",marginBottom:2 }}>
          <span style={{ fontSize:8,color:C.text,width:28 }}>{r.l}</span>
          <div style={{ flex:1,height:2,background:C.faint,borderRadius:2,margin:"0 6px",overflow:"hidden" }}>
            <div style={{ height:"100%",width:`${r.prob || 0}%`,background:C.orange,borderRadius:2 }}/>
          </div>
          <span style={{ fontSize:8,color:C.orange,fontWeight:700,width:28,textAlign:"right" }}>
            {r.prob ? `${Math.round(r.prob)}%` : "—"}
          </span>
          <span style={{ fontSize:7,color:C.text,width:30,textAlign:"right" }}>
            {r.odds ? `${r.odds}x` : ""}
          </span>
        </div>
      ))}
      <div style={{ marginTop:7,display:"inline-flex",alignItems:"center",gap:5,
        background:scoreBright ? C.goldDim : "transparent",
        border:scoreBright ? `1px solid ${C.goldBorder}` : "1px solid transparent",
        borderRadius:5,padding:scoreBright ? "3px 8px" : "0" }}>
        <span style={{ fontSize:8,color:C.text }}>Likely</span>
        <span style={{ fontSize:scoreBright?12:9,fontWeight:800,color:scoreBright?C.gold:C.text }}>{m.likelyScore}</span>
        <span style={{ fontSize:8,color:scoreBright?C.gold:C.faint,opacity:.8 }}>({m.likelyScoreProb}%)</span>
      </div>
    </Panel>
  );
}

// ── BOOK NOW — SPORTYBET ──────────────────────────────────────────────────
// Builds a legs array from the fixture's theRead anchor pick and calls /api/book-sportybet.
// Dropdown will support more bookmakers in future — currently SportyBet only.
function BookNowButton({ fixture }) {
  const [open, setOpen]         = useState(false);
  const [booking, setBooking]   = useState(false);
  const [result, setResult]     = useState(null);
  const [error, setError]       = useState(null);
  const [copied, setCopied]     = useState(false);

  // Build legs from theRead anchor — the most useful single-pick option
  const buildLegs = () => {
    const pick = fixture.theRead?.anchor;
    if (!pick) return null;
    return [{
      home:   fixture.teams.home,
      away:   fixture.teams.away,
      market: pick.market,
      pick:   pick.pick,
      league: fixture.league,
    }];
  };

  const book = async () => {
    const legs = buildLegs();
    if (!legs) { setError("No Read pick available to book"); return; }
    setBooking(true); setResult(null); setError(null);
    try {
      const res  = await fetch(`${SERVER}/api/book-sportybet`, {
        method: "POST",
        headers: { "Content-Type":"application/json" },
        body: JSON.stringify({ legs }),
      });
      const data = await res.json();
      if (!res.ok || data.error) throw new Error(data.error || "Booking failed");
      setResult(data);
    } catch(e) {
      // Translate raw network errors into user-friendly messages
      const msg = e.message || "";
      if (msg.includes("ERR_NAME_NOT_RESOLVED") || msg.includes("Failed to fetch") || msg.includes("NetworkError") || msg.includes("net::ERR")) {
        setError("Can't reach SportyBet — check your connection and try again.");
      } else if (msg.includes("429") || msg.includes("already in progress")) {
        setError("A booking is already in progress. Please wait a moment.");
      } else {
        setError(msg || "Booking failed — please try again.");
      }
    } finally {
      setBooking(false);
    }
  };

  const copyCode = () => {
    if (result?.code) {
      copyToClipboard(result.code, () => {
        setCopied(true); setTimeout(() => setCopied(false), 2000);
      });
    }
  };

  const canBook = !!fixture.theRead?.anchor && fixture.state !== "finished" && fixture.state !== "ft";

  return (
    <div style={{ marginTop:4 }}>
      {!open ? (
        <button onClick={() => setOpen(true)} disabled={!canBook} className="gb"
          style={{ width:"100%",background:canBook?C.accentDim:"transparent",border:`1px solid ${canBook?C.accentBorder:C.text}`,opacity:canBook?1:.3,color:canBook?C.accent:C.text,padding:"5px 0",fontSize:9,fontWeight:700,letterSpacing:".05em" }}>
          Book Now
        </button>
      ) : (
        <div style={{ background:C.accentDim,border:`1px solid ${C.accentBorder}`,borderRadius:8,padding:"10px 12px" }}>
          <div style={{ display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:8 }}>
            <span style={{ fontSize:8,fontWeight:800,color:C.gold,letterSpacing:".1em",textTransform:"uppercase" }}>Book Now</span>
            <button onClick={() => { setOpen(false); setResult(null); setError(null); }} className="gb"
              style={{ background:"transparent",border:"none",color:C.text,fontSize:11,padding:0 }}>✕</button>
          </div>

          {/* Bookmaker selector (SportyBet only for now) */}
          <div style={{ fontSize:8,color:C.text,marginBottom:8 }}>
            Bookmaker: <span style={{ color:C.gold,fontWeight:700 }}>SportyBet NG</span>
            <span style={{ fontSize:7,color:C.text,marginLeft:6 }}>(more coming)</span>
          </div>

          {/* Pick preview */}
          <div style={{ background:C.surface,borderRadius:6,padding:"6px 10px",marginBottom:8,border:`1px solid ${C.border}` }}>
            <div style={{ fontSize:7,color:C.text,marginBottom:2 }}>PICK</div>
            <div style={{ fontSize:10,color:C.text,fontWeight:700 }}>{fixture.theRead?.anchor?.pick}</div>
            <div style={{ fontSize:8,color:C.text }}>{fixture.teams.home} vs {fixture.teams.away} · {fixture.theRead?.anchor?.market}</div>
          </div>

          {/* Book button / status panel */}
          {!result && !error && (
            booking ? (
              <div style={{ width:"100%",background:C.faint,borderRadius:8,padding:"10px 14px",display:"flex",alignItems:"center",gap:10,border:`1px solid ${C.border}` }}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={C.accent} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink:0, animation:"spinRing 1s linear infinite" }}>
                  <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/>
                </svg>
                <div>
                  <div style={{ fontSize:10,fontWeight:800,color:C.text }}>Booking your ticket…</div>
                  <div style={{ fontSize:8,color:C.muted,marginTop:2 }}>Takes 10–20 seconds. Don't close.</div>
                </div>
              </div>
            ) : (
              <button onClick={book} className="gb"
                style={{ width:"100%",background:C.accent,color:C.accentText,padding:"7px 0",fontWeight:800,fontSize:10 }}>
                Generate Booking Code
              </button>
            )
          )}

          {/* Error */}
          {error && (
            <div style={{ fontSize:8,color:C.red,marginTop:6 }}>
              ✕ {error}
              <button onClick={book} className="gb" style={{ marginLeft:8,fontSize:8,padding:"1px 8px",background:"transparent",border:`1px solid ${C.red}`,color:C.red }}>Retry</button>
            </div>
          )}

          {/* Success — booking code */}
          {result && (
            <div style={{ marginTop:6 }}>
              <div style={{ fontSize:7,color:C.green,fontWeight:800,letterSpacing:".1em",textTransform:"uppercase",marginBottom:4 }}>
                ✓ {result.resolved}/{result.total} leg{result.total!==1?"s":""} booked
              </div>
              <div style={{ display:"flex",alignItems:"center",gap:8 }}>
                <div style={{ flex:1,background:C.surface,border:`1px solid ${C.green}40`,borderRadius:6,padding:"8px 12px",fontFamily:C.font,fontSize:18,fontWeight:800,color:C.green,letterSpacing:".2em",textAlign:"center" }}>
                  {result.code}
                </div>
                <button onClick={copyCode} className="gb"
                  style={{ padding:"8px 14px",background:copied?C.green:"transparent",color:copied?C.accentText:C.green,border:`1px solid ${C.green}50`,fontWeight:700,fontSize:9,flexShrink:0 }}>
                  {copied ? "✓ Copied" : "Copy"}
                </button>
              </div>
              {result.shareURL && (
                <div style={{ fontSize:7,color:C.text,marginTop:5,wordBreak:"break-all" }}>
                  Opens SportyBet · your picks are pre-loaded
                </div>
              )}
              {result.failed?.length > 0 && (
                <div style={{ marginTop:8,background:`${C.amber}10`,border:`1px solid ${C.amber}30`,borderRadius:6,padding:"8px 10px" }}>
                  <div style={{ fontSize:8,color:C.amber,fontWeight:800,marginBottom:6 }}>
                    ⚠ {result.failed.length} leg{result.failed.length!==1?"s":""} couldn't be booked
                  </div>
                  {result.failed.map((f, i) => {
                    const isObj = f && typeof f === "object";
                    const label = isObj ? f.label : f;
                    const reason = isObj
                      ? f.failReason === "tt_unavailable"
                        ? "Team Total market not available on SportyBet for this match. Try Over 2.5 or BTTS instead."
                        : "Match not found on SportyBet. May not be listed yet or have a different name."
                      : "Could not be resolved.";
                    return (
                      <div key={i} style={{ marginBottom: i < result.failed.length-1 ? 6 : 0 }}>
                        <div style={{ fontSize:8,color:C.text,fontWeight:700 }}>{label}</div>
                        <div style={{ fontSize:7,color:C.muted,marginTop:1 }}>{reason}</div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── FIXTURE CARD ──────────────────────────────────────────────────────────
// Outer shell validates fixture shape before rendering inner stateful component.
// This avoids a React Rules-of-Hooks violation — hooks cannot appear after
// an early return inside the same function component.
function FixtureCard(props) {
  const { f } = props;
  if (!f || typeof f !== "object" || !f.teams || !f.markets) return null;
  return <FixtureCardInner {...props} />;
}

function FixtureCardInner({ f, onAddToParlay, draftLegs, isEngineQualified, onFullModel, backtestSummary, adminToken = "" }) {
  const [fetchingResult, setFetchingResult] = useState(false);
  const [localResult,    setLocalResult]    = useState(null);
  const [finishedFlash,  setFinishedFlash]  = useState("");
  const m = f.markets;

  // Per-pick draft checks — each button knows exactly what's already in the draft.
  // draftLegForFixture finds the one leg for this fixture (if any).
  // readInDraft / edgeInDraft / radarInDraft drive button labels precisely,
  // so users always know whether they're adding or replacing — never silently confused.
  const draftLegForFixture = Array.isArray(draftLegs)
    ? draftLegs.find(l => l.fixtureId === f.id)
    : null;
  const isAlreadyInDraft = !!draftLegForFixture;
  const anchor   = f.theRead?.anchor;
  const theEdge  = f.theEdge;
  const readInDraft  = isAlreadyInDraft && !!anchor
    && draftLegForFixture.pick === anchor.pick;
  const edgeInDraft  = isAlreadyInDraft && !!theEdge
    && draftLegForFixture.pick === theEdge.pick;

  const ftStates = ["finished","ft","fulltime","ended","complete","aet","afterextratime","afterpenalties"];
  const ppdStates = ["postponed","ppd","cancelled","canceled","abandoned","suspended","interrupted","deleted"];
  const normState = (f.state || "").toLowerCase().replace(/[_\-\s]/g,"");
  const isFinished = ftStates.includes(normState);
  const isPPD      = ppdStates.includes(normState);

  const liveStates = ["inprogress","1h","firsthalf","ht","halftime","2h","secondhalf","et","extratime","pen","penalties","pause","break"];
  const isLive = liveStates.includes(normState);

  const handleAddAnchor = useCallback((pick) => {
    if (!onAddToParlay) return;
    if (isFinished) {
      setFinishedFlash("Match is finished — result already in");
      setTimeout(() => setFinishedFlash(""), 2500);
      return;
    }
    if (isPPD) {
      setFinishedFlash("Match postponed/cancelled — cannot add");
      setTimeout(() => setFinishedFlash(""), 2500);
      return;
    }
    const io = p => (p > 0 && p < 100) ? parseFloat((1 / (p / 100)).toFixed(2)) : null;
    const resolvedOdds = pick.odds || io(pick.prob);
    if (!resolvedOdds && !pick.prob) {
      setFinishedFlash("No model data — adding anyway");
      setTimeout(() => setFinishedFlash(""), 2500);
    }
    if (isLive) {
      setFinishedFlash("Added — game is LIVE, odds may have shifted");
      setTimeout(() => setFinishedFlash(""), 3000);
    }
    onAddToParlay(f, { pick: pick.pick, prob: pick.prob, odds: resolvedOdds || null, market: pick.market });
  }, [f, onAddToParlay, isFinished, isPPD, isLive]);

  const fetchCardResult = async (e) => {
    e.stopPropagation();
    setFetchingResult(true);
    try {
      const date = (f.startingAt || "").split("T")[0] || todayStr();
      await fetch(`${SERVER}/api/fetch-results?date=${date}`, { headers:{"x-admin-token": adminToken} });
      const res  = await fetch(`${SERVER}/api/load-snapshot?date=${date}`);
      const data = await res.json();
      const updated = (data.data || []).find(x => x.id === f.id);
      if (updated?.hGoals != null) setLocalResult({ hGoals: updated.hGoals, aGoals: updated.aGoals, state: updated.state });
    } catch {}
    setFetchingResult(false);
  };

  const displayF = localResult ? { ...f, ...localResult } : f;
  // anchor and theEdge are declared above with the per-pick draft checks
  // Primary pick — The Read anchor. This is what the card leads with.
  const primaryColor = anchor ? mktStyle(anchor.market).color : C.muted;

  return (
    // Card is NOT a tap target — use the "Full model →" button in footer
    <div
      className="gc fa"
      style={{ padding:"14px 16px", display:"flex", flexDirection:"column", gap:10,
               position:"relative" }}>

      {/* ── Row 1: League + badges + status ── */}
      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", gap:8 }}>
        <div style={{ display:"flex", gap:5, alignItems:"center", flexWrap:"wrap", flex:1, minWidth:0 }}>
          <span style={{ fontSize:9, color:C.muted, fontWeight:500,
                         overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap", maxWidth:160 }}>
            {f.league}
          </span>
          {isEngineQualified && (
            <Tip text="This fixture qualifies for the Rollover Engine — it meets the model's strictest quality threshold.">
              <span style={{ fontSize:7, fontWeight:800, color:C.accentText, background:C.accent,
                             borderRadius:4, padding:"1px 5px", letterSpacing:".04em" }}>Engine</span>
            </Tip>
          )}
          {f.markets?._lowConfidence && (
            <span style={{ fontSize:7, color:C.muted, border:`1px solid ${C.faint}`,
                           borderRadius:3, padding:"1px 5px" }}>Limited data</span>
          )}
          {/* B4.2 Track A: thin-data caveat badge — picks shown but flagged */}
          {f.markets?._lowDataCaveat && !f.markets?._lowConfidence && (
            <span style={{ fontSize:7, color:C.amber, border:`1px solid ${C.amber}35`,
                           borderRadius:3, padding:"1px 5px" }}>Low data · model est.</span>
          )}
        </div>
        <div style={{ display:"flex", alignItems:"center", gap:6, flexShrink:0 }}>
          {/* Issue 5 fix: "In Draft" badge so user knows this game is already picked */}
          {isAlreadyInDraft && (
            <span style={{ fontSize:7, fontWeight:800, color:C.green,
                           background:`${C.green}18`, border:`1px solid ${C.green}35`,
                           borderRadius:4, padding:"2px 6px", letterSpacing:".04em",
                           display:"flex", alignItems:"center", gap:3 }}>
              <svg width="7" height="7" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="20 6 9 17 4 12"/>
              </svg>
              In Draft
            </span>
          )}
          <StatusBadge state={displayF.state} time={f.time} />
          {displayF.hGoals != null && (
            <span style={{ fontSize:12, fontWeight:800, color:C.text,
                           padding:"1px 8px", background:C.surface, borderRadius:5 }}>
              {displayF.hGoals}–{displayF.aGoals}
            </span>
          )}
        </div>
      </div>

      {/* ── Row 2: Teams ── */}
      <div>
        <div className="grm-teams-row" style={{ marginBottom:4 }}>
          <span className="grm-team-name">{f.teams.home}</span>
          <span className="grm-vs">vs</span>
          <span className="grm-team-name away">{f.teams.away}</span>
        </div>
        {f.form && (f.form.home?.length > 0 || f.form.away?.length > 0) && (
          <FormRow home={f.form.home} away={f.form.away} allCompHome={f.form.allCompHome} allCompAway={f.form.allCompAway} />
        )}
      </div>

      {/* ── Row 3: Primary pick (THE READ) — prominent, single action ── */}
      {anchor ? (
        <div style={{ background:`${primaryColor}0d`, border:`1px solid ${primaryColor}25`,
                      borderRadius:8, padding:"10px 12px" }}>
          <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start" }}>
            <div style={{ flex:1, minWidth:0 }}>
              <div style={{ fontSize:9, fontWeight:800, color:primaryColor, letterSpacing:".08em",
                            textTransform:"uppercase", marginBottom:4 }}>
                The Read
                {anchor.strong && !f.markets?._lowConfidence && (
                  <span style={{ marginLeft:6, color:C.gold, background:`${C.gold}18`,
                                 borderRadius:3, padding:"1px 4px" }}>STRONG</span>
                )}
                {f.theRead?.isFallback && (
                  <span style={{ marginLeft:6, color:C.amber, background:`${C.amber}18`,
                                 borderRadius:3, padding:"1px 4px" }}>LOW SIG</span>
                )}
              </div>
              <div style={{ fontSize:15, fontWeight:800, color:primaryColor, lineHeight:1.2,
                            overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>
                {anchor.pick}
              </div>
              {anchor.empiricalRate != null && (
                <div style={{ fontSize:8, color:C.muted, marginTop:3 }}>
                  {anchor.empiricalRate}% historical rate
                  {anchor.sampleSize != null && ` · ${anchor.sampleSize} games`}
                </div>
              )}
            </div>
            <div style={{ textAlign:"right", flexShrink:0, paddingLeft:10 }}>
              <div style={{ fontSize:20, fontWeight:900, color:primaryColor }}>{Math.round(anchor.prob)}%</div>
              {anchor.odds && <div style={{ fontSize:9, color:C.muted }}>{anchor.odds}x</div>}
            </div>
          </div>
          <div style={{ height:3, background:`${primaryColor}18`, borderRadius:2, overflow:"hidden", margin:"8px 0" }}>
            <div style={{ height:"100%", width:`${Math.min(anchor.prob,100)}%`, background:primaryColor, borderRadius:2 }}/>
          </div>
          {/* Single primary action — stops propagation so card click doesn't also open full model */}
          <button onClick={(e) => {
            e.stopPropagation();
            handleAddAnchor(anchor);
            if (isAlreadyInDraft && !readInDraft && !isLive) {
              setFinishedFlash("Pick replaced in ticket ↺");
              setTimeout(() => setFinishedFlash(""), 1800);
            }
          }}
            className="grm-add-btn"
            style={{
              background: (isFinished || isPPD) ? `${C.muted}0a`
                        : isLive              ? `${C.amber}14`
                        : readInDraft         ? `${C.green}10`
                        : isAlreadyInDraft    ? `${primaryColor}10`
                        :                      `${primaryColor}14`,
              color:       (isFinished || isPPD) ? C.muted
                        : isLive              ? C.amber
                        : readInDraft         ? C.green
                        : isAlreadyInDraft    ? primaryColor
                        :                      primaryColor,
              borderColor: (isFinished || isPPD) ? `${C.muted}25`
                        : isLive              ? `${C.amber}40`
                        : readInDraft         ? `${C.green}40`
                        :                      `${primaryColor}35`,
              cursor: (isFinished || isPPD) ? "default" : "pointer",
              width:"100%", marginTop:2,
            }}>
            {isFinished
              ? <span style={{display:"inline-flex",alignItems:"center",gap:5}}><IcoCheckSm size={10} col={C.muted}/>Match Finished</span>
              : isPPD    ? "Postponed / Cancelled"
              : isLive && readInDraft
                ? <span style={{display:"inline-flex",alignItems:"center",gap:5}}><IcoLiveDot col={C.amber}/>Replace (LIVE)</span>
              : isLive
                ? <span style={{display:"inline-flex",alignItems:"center",gap:5}}><IcoLiveDot col={C.amber}/>Add (LIVE)</span>
              : readInDraft      ? "✓ Added"
              : isAlreadyInDraft ? "↺ Replace"
              :                    "+ Add to Ticket"}
          </button>
        </div>
      ) : (
        <div style={{ padding:"10px 12px", background:C.surface, borderRadius:8,
                      border:`1px solid ${f.markets?._insufficientData ? `${C.accent}25` : C.faint}`,
                      display:"flex", alignItems:"center", justifyContent:"space-between", gap:8 }}>
          <div style={{ flex:1, minWidth:0 }}>
            <div style={{ fontSize:10, fontWeight:700, color:C.text, marginBottom:2 }}>
              No model pick · limited data
            </div>
            <div style={{ fontSize:9, color:C.muted, lineHeight:1.4 }}>
              {f.markets?._insufficientData
                ? <span style={{ color:C.muted }}>No model data — Jarvis will research a pick</span>
                : "Stats, xG and Jarvis analysis still available"}
            </div>
          </div>
          {onFullModel && (
            <button onClick={(e) => {
                e.stopPropagation();
                // #5-FIX: pass _autoAskJarvis so FMP auto-consents and starts fetch
                onFullModel(f.markets?._insufficientData ? { ...f, _autoAskJarvis: true } : f);
              }}
              style={{ fontSize:9, fontWeight:700, flexShrink:0, whiteSpace:"nowrap",
                       cursor:"pointer", fontFamily:C.font, borderRadius:6, padding:"5px 10px",
                       color:C.accent, background:C.accentDim, border:`1px solid ${C.accentBorder}` }}>
              {f.markets?._insufficientData ? "Ask Jarvis →" : "View →"}
            </button>
          )}
        </div>
      )}

      {/* ── Row 4: Goal Radar — team scoring signal, compact secondary row ── */}
      {(() => {
        const radar = f.goalRadar?.home || f.goalRadar?.away;
        if (!radar) return null;
        // radarInDraft: this exact radar pick is in the draft (market=TeamTotal check)
        const radarInDraft = isAlreadyInDraft
          && (draftLegForFixture?.market === "TeamTotal"
              || draftLegForFixture?.market?.includes("TeamTotal"));
        // otherInDraft: something else for this fixture is in draft (Read or Edge)
        const otherInDraft = isAlreadyInDraft && !radarInDraft;
        return (
          <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between",
                        padding:"6px 10px", background:C.surfaceHi || C.surface,
                        border:`1px solid ${C.border}`, borderRadius:6 }}>
            <div style={{ display:"flex", alignItems:"center", gap:6, flex:1, minWidth:0 }}>
              <span style={{ fontSize:8, fontWeight:800, color:C.radar, letterSpacing:".08em",
                             textTransform:"uppercase", background:C.radarDim,
                             borderRadius:3, padding:"1px 5px", flexShrink:0 }}>Goal Radar</span>
              <span style={{ fontSize:10, fontWeight:700, color:C.text,
                             overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>
                {radar.pick}
              </span>
            </div>
            <div style={{ display:"flex", alignItems:"center", gap:8, flexShrink:0 }}>
              <span style={{ fontSize:11, fontWeight:800, color:C.text }}>{Math.round(radar.prob)}%</span>
              <button onClick={(e) => {
                e.stopPropagation();
                handleAddAnchor({ ...radar, market:"TeamTotal" });
                if (radarInDraft || otherInDraft) {
                  setFinishedFlash("Goal Radar replaced in ticket");
                  setTimeout(() => setFinishedFlash(""), 1800);
                }
              }} style={{ fontSize:9,
                         color: radarInDraft ? C.green : otherInDraft ? C.radar : C.radar,
                         background: radarInDraft ? `${C.green}10` : C.radarDim,
                         border:`1px solid ${radarInDraft ? `${C.green}40` : C.radarBorder}`,
                         borderRadius:5, padding:"3px 10px", cursor:"pointer",
                         fontFamily:C.font, fontWeight:700 }}>
                {radarInDraft ? "✓ Added" : otherInDraft ? "↺ Replace" : "+ Add"}
              </button>
            </div>
          </div>
        );
      })()}

      {/* ── Flash message ── */}
      {finishedFlash && (
        <div style={{ fontSize:9, color:C.amber, textAlign:"center",
                      background:`${C.amber}0a`, borderRadius:6,
                      padding:"4px 8px", border:`1px solid ${C.amber}30` }}>
          {finishedFlash}
        </div>
      )}

      {/* ── Footer: strategy tags + explicit "Full Analysis" tap target ── */}
      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginTop:-2 }}>
        <div style={{ display:"flex", gap:4, flexWrap:"wrap" }}>
          {f.strategyTags?.slice(0,2).map(t => (
            <span key={t} style={{ fontSize:9, color:C.gold, fontWeight:700,
                                   background:C.goldDim, border:`1px solid ${C.goldBorder}`,
                                   borderRadius:4, padding:"2px 6px" }}>
              {STRATEGY_LABELS[t] || t}
            </span>
          ))}
        </div>
        {onFullModel && (
          <button
            onClick={(e) => { e.stopPropagation(); onFullModel(f); }}
            style={{ fontSize:8, color:C.muted, background:"transparent", border:`1px solid ${C.border}`,
                     borderRadius:5, padding:"3px 8px", cursor:"pointer", fontFamily:C.font,
                     letterSpacing:".04em", flexShrink:0 }}>
            Full model →
          </button>
        )}
      </div>
    </div>
  );
}

// ── FULL MODEL PAGE ────────────────────────────────────────────────────────
// Opens as a full-screen overlay when "▼ Full Model" is tapped.
// Same pattern as ParlayJarvisTab overlay. Saves/restores scroll position.
// ── buildMatchVoice — Tier 1 instant brief from pure data, no API ────────────
export function buildMatchVoice(f) {
  const m = f?.markets;
  if (!m) return null;
  const lines = [];

  // Match balance
  const hxg = parseFloat(m.homeXG) || 0;
  const axg = parseFloat(m.awayXG) || 0;
  const xgTotal = hxg + axg;
  if (hxg && axg) {
    const diff = Math.abs(hxg - axg);
    const fav  = hxg > axg ? f.teams.home : f.teams.away;
    const dog  = hxg > axg ? f.teams.away : f.teams.home;
    if (diff < 0.2)       lines.push(`Expected goals are level at ${hxg} vs ${axg} — the model reads this as an evenly contested match with no clear favourite on output.`);
    else if (diff < 0.5)  lines.push(`${fav} carry a slight xG edge at ${Math.max(hxg,axg).toFixed(2)} vs ${Math.min(hxg,axg).toFixed(2)} for ${dog}. A marginal advantage, but consistent with the model favouring ${fav.split(" ")[0]}.`);
    else                  lines.push(`${fav} are the stronger side on expected output with xG ${Math.max(hxg,axg).toFixed(2)} against ${Math.min(hxg,axg).toFixed(2)} for ${dog}. The model reads a clear performance gap here.`);
  }

  // Goal expectation
  const o25 = m.over25 || 0;
  const btts = m.bttsYes || 0;
  if (xgTotal > 2.8 && o25 > 65)  lines.push(`With combined xG of ${xgTotal.toFixed(2)}, goals are well expected. Over 2.5 sits at ${Math.round(o25)}% and BTTS Yes at ${Math.round(btts)}% — this is a high-scoring profile.`);
  else if (xgTotal < 1.8)          lines.push(`Combined xG of ${xgTotal.toFixed(2)} points to a low-scoring affair. The model gives Under 2.5 more probability than the market implies.`);
  else                              lines.push(`Combined xG of ${xgTotal.toFixed(2)} suggests a moderate goal environment. Over 2.5 probability sits at ${Math.round(o25)}%.`);

  // Form narrative
  const hForm = (f.form?.home || []).slice(0,5);
  const aForm = (f.form?.away || []).slice(0,5);
  if (hForm.length && aForm.length) {
    const hW = hForm.filter(r=>r==="W").length;
    const aW = aForm.filter(r=>r==="W").length;
    const hStr = hW >= 3 ? "strong recent form" : hW <= 1 ? "poor recent form" : "mixed recent form";
    const aStr = aW >= 3 ? "strong form on the road" : aW <= 1 ? "struggling away" : "inconsistent away form";
    lines.push(`${f.teams.home.split(" ")[0]} arrive in ${hStr} (${hForm.join("")}), while ${f.teams.away.split(" ")[0]} show ${aStr} (${aForm.join("")}).`);
  }

  // Key signal
  const read = f.theRead?.anchor;
  const edge = f.theEdge;
  if (read && edge && read.pick !== edge.pick) {
    lines.push(`The model's top signal points to ${read.pick} at ${Math.round(read.prob)}% confidence. Separately, the value signal identifies ${edge.pick} as the best odds position against the bookmaker's price.`);
  } else if (read) {
    lines.push(`Across all signals, ${read.pick} is the model's clearest read at ${Math.round(read.prob)}% probability.`);
  }

  return lines.join(" ");
}


// ── GOAL RADAR LIST VIEW ──────────────────────────────────────────────────
function GoalRadarTab({ fixtures, onAddToParlay, search, onFullModel }) {
  const [flashed, setFlashed] = useState({});

  const entries = useMemo(() => {
    const s = (search || "").toLowerCase();
    const list = [];
    for (const f of fixtures) {
      if (!f.goalRadar) continue;
      if (s && !f.teams.home.toLowerCase().includes(s) && !f.teams.away.toLowerCase().includes(s) && !f.league.toLowerCase().includes(s)) continue;
      if (f.goalRadar.home)      list.push({ ...f.goalRadar.home,      fixture:f, isExtra:false });
      if (f.goalRadar.homeExtra) list.push({ ...f.goalRadar.homeExtra, fixture:f, isExtra:true  });
      if (f.goalRadar.away)      list.push({ ...f.goalRadar.away,      fixture:f, isExtra:false });
      if (f.goalRadar.awayExtra) list.push({ ...f.goalRadar.awayExtra, fixture:f, isExtra:true  });
    }
    return list.sort((a, b) => b.prob - a.prob);
  }, [fixtures, search]);

  const handleAdd = (f, e) => {
    if (!onAddToParlay) return;
    onAddToParlay(f, { pick:e.pick, prob:e.prob, odds:e.odds, market:"TeamTotal" });
    const key = `${f.id}-${e.pick}`;
    setFlashed(prev => ({ ...prev, [key]: true }));
    setTimeout(() => setFlashed(prev => ({ ...prev, [key]: false })), 1400);
  };

  const buildPortfolio = () => {
    if (!onAddToParlay) return;
    entries.filter(e => !e.isExtra).slice(0, 10).forEach(e => handleAdd(e.fixture, e));
  };

  if (!entries.length) return (
    <div style={{ textAlign:"center",padding:"60px 0",color:C.text,fontSize:11,textTransform:"uppercase",letterSpacing:".15em" }}>
      No Goal Radar picks today
    </div>
  );

  return (
    <div>
      <div style={{ display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:14 }}>
        <div>
          <div style={{ fontSize:10,fontWeight:800,color:C.radar,letterSpacing:".1em",textTransform:"uppercase" }}>Goal Radar · {entries.length} picks</div>
          <div style={{ fontSize:8,color:C.text,marginTop:2 }}>O0.5 at {entries[0] ? Math.round(entries[0].prob) : 85}%+ · O1.5 where qualifying · implied odds</div>
        </div>
        {onAddToParlay && (
          <button onClick={buildPortfolio} className="gb"
            style={{ background:C.radarDim,color:C.radar,border:`1px solid ${C.radarBorder}`,padding:"6px 14px",fontSize:9 }}>
            📦 Build Portfolio (top 10)
          </button>
        )}
      </div>
      <div style={{ display:"flex",flexDirection:"column",gap:4 }}>
        {entries.map((e, i) => {
          const f = e.fixture;
          const isHome = e.team === "home";
          const key = `${f.id}-${e.pick}`;
          const done = flashed[key];
          return (
            <div key={i} style={{ display:"grid",gridTemplateColumns:"24px 1fr 120px 48px 52px 50px",gap:8,padding:"9px 14px",background:e.isExtra?C.surface:C.surface,borderRadius:8,border:`1px solid ${e.isExtra?C.radar+"22":C.radarBorder}`,alignItems:"center",opacity:e.isExtra?0.82:1 }}>
              <span style={{ fontSize:11,color:C.radar }}>{isHome ? "🏠" : "✈"}</span>
              <div>
                <div style={{ fontSize:10,fontWeight:700,color:C.text }}>{e.pick}
                  {e.market && <span style={{ fontSize:7,color:C.radar,background:`${C.radar}18`,border:`1px solid ${C.radar}30`,borderRadius:3,padding:"1px 5px",marginLeft:5,fontWeight:800,letterSpacing:".06em" }}>{e.market}</span>}
                  {e.isExtra && <span style={{ fontSize:7,color:C.amber,background:`${C.amber}15`,borderRadius:3,padding:"1px 5px",marginLeft:4,fontWeight:800 }}>advisory</span>}
                </div>
                <div style={{ fontSize:8,color:C.text }}>{f.teams.home} vs {f.teams.away} · {f.league}</div>
              </div>
              <div style={{ fontSize:8,color:C.text,textAlign:"center" }}>
                <StatusBadge state={f.state} time={f.time} />
              </div>
              <span style={{ fontSize:13,fontWeight:800,color:C.radar }}>{Math.round(e.prob)}%</span>
              <span style={{ fontSize:10,fontWeight:700,color:C.text,textAlign:"right" }}>
                {e.odds ? `${parseFloat(e.odds).toFixed(2)}x` : "-"}
              </span>
              {onAddToParlay && (
                <button onClick={() => handleAdd(f, e)}
                  className="gb" style={{ background:done?`${C.green}20`:C.radarDim,color:done?C.green:C.radar,border:`1px solid ${done?C.green:C.radar}40`,padding:"3px 6px",fontSize:8,transition:"all .2s" }}>
                  {done ? "✓" : "+"}
                </button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── IMPLIED ODDS HELPERS ──────────────────────────────────────────────────
// safeImpliedOdds, oddsOrImplied, inferMarket → engine.js

// ── CUSTOM LIST VIEW ──────────────────────────────────────────────────────
// getCustomPick, xgHomeDominant, xgAwayDominant → engine.js

function CustomListView({ fixtures, search, onAddToTicket, onAddToParlay, draftLegs, onOpenFixture, onFullModel, backtestSummary }) {
  const isMobile = useIsMobile();
  const SS_KEY = "grm_clv_state_v1";
  const loadSS = (k, fallback) => { try { const s = sessionStorage.getItem(SS_KEY); if (!s) return fallback; const d = JSON.parse(s); return d[k] !== undefined ? d[k] : fallback; } catch { return fallback; } };
  const saveSS = (patch) => { try { const d = JSON.parse(sessionStorage.getItem(SS_KEY) || "{}"); sessionStorage.setItem(SS_KEY, JSON.stringify({ ...d, ...patch })); } catch {} };

  const [family,         setFamilyState]         = useState(() => loadSS("family", "theRead"));
  const [statFilters,    setStatFiltersState]    = useState(() => loadSS("statFilters", []));
  const [selected,       setSelected]       = useState(null);
  const [activeStrategy, setActiveStrategyState] = useState(() => loadSS("activeStrategy", null));
  const [advancedOpen,   setAdvancedOpen]   = useState(false);

  const setFamily         = v => { setFamilyState(v);         saveSS({ family: v }); };
  const setStatFilters    = fn => { setStatFiltersState(prev => { const next = typeof fn === "function" ? fn(prev) : fn; saveSS({ statFilters: next }); return next; }); };
  const setActiveStrategy = v => { setActiveStrategyState(v); saveSS({ activeStrategy: v }); };
  // Issue 6: Market exclusion — fixtures whose primary Read/pick is an excluded market
  // fall back to their second-best qualifying pick rather than being hidden entirely.
  const [excludedMarkets, setExcludedMarketsState] = useState(() => { try { const a = loadSS("excludedMarkets"); return Array.isArray(a) ? new Set(a) : new Set(); } catch { return new Set(); } });
  const setExcludedMarkets = fn => setExcludedMarketsState(prev => { const next = typeof fn === "function" ? fn(prev) : fn; saveSS({ excludedMarkets: [...next] }); return next; });
  const toggleExcludeMarket = (mkt) =>
    setExcludedMarkets(prev => {
      const next = new Set(prev);
      next.has(mkt) ? next.delete(mkt) : next.add(mkt);
      return next;
    });
  const [selectedIds,    setSelectedIds]    = useState(new Set());
  // Custom strategy save/load — persisted to localStorage
  const SAVED_STRATS_KEY = "grm_custom_strategies_v1";
  const [savedStrats,    setSavedStrats]    = useState(() => {
    try { return JSON.parse(localStorage.getItem(SAVED_STRATS_KEY) || "[]"); } catch { return []; }
  });
  const [saveStratName,  setSaveStratName]  = useState("");
  const [saveStratOpen,  setSaveStratOpen]  = useState(false);

  // Threshold values — null means unset (chip inactive). No defaults = no highlight bug.
  const [xgBoth,  setXgBothS]  = useState(() => loadSS("xgBoth",  null));
  const [xgHome,  setXgHomeS]  = useState(() => loadSS("xgHome",  null));
  const [xgAway,  setXgAwayS]  = useState(() => loadSS("xgAway",  null));
  const [thrBtts, setThrBttsS] = useState(() => loadSS("thrBtts", null));
  const [thrHWin, setThrHWinS] = useState(() => loadSS("thrHWin", null));
  const [thrAWin, setThrAWinS] = useState(() => loadSS("thrAWin", null));
  const [thrHCS,  setThrHCSS]  = useState(() => loadSS("thrHCS",  null));
  const [thrACS,  setThrACSS]  = useState(() => loadSS("thrACS",  null));
  const [thrOdds, setThrOddsS] = useState(() => loadSS("thrOdds", null));
  const [thrDraw, setThrDrawS] = useState(() => loadSS("thrDraw", null));
  const setXgBoth  = v => { setXgBothS(v);  saveSS({ xgBoth:  v }); };
  const setXgHome  = v => { setXgHomeS(v);  saveSS({ xgHome:  v }); };
  const setXgAway  = v => { setXgAwayS(v);  saveSS({ xgAway:  v }); };
  const setThrBtts = v => { setThrBttsS(v); saveSS({ thrBtts: v }); };
  const setThrHWin = v => { setThrHWinS(v); saveSS({ thrHWin: v }); };
  const setThrAWin = v => { setThrAWinS(v); saveSS({ thrAWin: v }); };
  const setThrHCS  = v => { setThrHCSS(v);  saveSS({ thrHCS:  v }); };
  const setThrACS  = v => { setThrACSS(v);  saveSS({ thrACS:  v }); };
  const setThrOdds = v => { setThrOddsS(v); saveSS({ thrOdds: v }); };
  const setThrDraw = v => { setThrDrawS(v); saveSS({ thrDraw: v }); };
  // Direction per threshold chip: "gte" = ≥, "lte" = ≤
  const [thrDirs, setThrDirs] = useState({});
  const setDir = (id, dir) => setThrDirs(prev => ({ ...prev, [id]: dir }));
  const dir = (id) => thrDirs[id] || "gte";
  const cmp = (id, val, thr) => dir(id) === "lte" ? val <= thr : val >= thr;

  const ftStatesSet = new Set(["finished","ft","fulltime","ended","complete","aet","afterextratime","afterpenalties"]);
  const isFixtureFT = f => ftStatesSet.has((f.state||"").toLowerCase().replace(/[_\-\s]/g,""));
  const toggleSelect  = (id) => {
    const f = fixtures.find(x => x.id === id);
    if (f && isFixtureFT(f)) return; // silently block FT games
    setSelectedIds(prev => { const n=new Set(prev); n.has(id)?n.delete(id):n.add(id); return n; });
  };
  const clearSelection = () => setSelectedIds(new Set());
  const toggleStat    = id => setStatFilters(prev => prev.includes(id) ? prev.filter(x=>x!==id) : [...prev, id]);
  const activateStat  = id => setStatFilters(prev => prev.includes(id) ? prev : [...prev, id]);
  const deactivateStat = id => setStatFilters(prev => prev.filter(x => x!==id));

  // Stat filter definitions — threshold filters only exist when their value is set
  const STAT_FILTERS = useMemo(() => [
    { id:"model_pick",    label:"Model Pick",  desc:"Model has a confident non-fallback pick", fn:f=>!!(f.theRead&&!f.theRead.isFallback) },
    { id:"goal_radar",    label:"Goal Radar",  desc:"At least one team in Goal Radar",         fn:f=>!!f.goalRadar },
    { id:"scheduled", label:"Upcoming", desc:"Not yet started",
      icon:<svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>,
      fn:f=>{ const s=(f.state||"").toLowerCase(); return s===""||s==="notstarted"||s==="scheduled"||s==="prematch"; } },
    { id:"live", label:"Live", desc:"Currently in progress",
      icon:<svg width="9" height="9" viewBox="0 0 8 8"><circle cx="4" cy="4" r="4" fill="currentColor" opacity=".25"/><circle cx="4" cy="4" r="2.5" fill="currentColor"/></svg>,
      fn:f=>{ const s=(f.state||"").toLowerCase(); return ["inprogress","live","1h","1sthalf","ht","halftime","2h","2ndhalf","et","extratime","penaltyshootout"].includes(s); } },
    { id:"xg_home_dom",   label:"Home xG Dom", desc:"Home xG 2× away + gap ≥1",               fn:f=>f.markets.homeXG>=f.markets.awayXG*2&&(f.markets.homeXG-f.markets.awayXG)>=1 },
    { id:"xg_away_dom",   label:"Away xG Dom", desc:"Away xG 2× home + gap ≥1",               fn:f=>f.markets.awayXG>=f.markets.homeXG*2&&(f.markets.awayXG-f.markets.homeXG)>=1 },
    { id:"def_weak_home", label:"H Def Weak",  desc:"Home CS < 20%",                          fn:f=>f.markets.homeCS<20 },
    { id:"def_weak_away", label:"A Def Weak",  desc:"Away CS < 20%",                          fn:f=>f.markets.awayCS<20 },
    { id:"low_xg",        label:"Low xG",      desc:"Total xG < 2.0",                         fn:f=>(f.markets.homeXG+f.markets.awayXG)<2.0 },
    { id:"volatile",      label:"Volatile",    desc:"Volatile league",                        fn:f=>!!f.volatileLeague },
    ...(thrBtts!=null ? [{ id:"btts_q",      label:`BTTS ${dir("btts_q")==="lte"?"≤":"≥"}${thrBtts}%`,      fn:f=>cmp("btts_q",f.markets.bttsYes,thrBtts) }] : []),
    ...(xgBoth !=null ? [{ id:"xg_both",     label:`Total xG ${dir("xg_both")==="lte"?"≤":"≥"}${xgBoth}`,   fn:f=>cmp("xg_both",(f.markets.homeXG+f.markets.awayXG),xgBoth) }] : []),
    ...(xgHome !=null ? [{ id:"xg_home_min", label:`Home xG ${dir("xg_home_min")==="lte"?"≤":"≥"}${xgHome}`,fn:f=>cmp("xg_home_min",f.markets.homeXG,xgHome) }] : []),
    ...(xgAway !=null ? [{ id:"xg_away_min", label:`Away xG ${dir("xg_away_min")==="lte"?"≤":"≥"}${xgAway}`,fn:f=>cmp("xg_away_min",f.markets.awayXG,xgAway) }] : []),
    ...(thrHWin!=null ? [{ id:"homewin_str", label:`H Win ${dir("homewin_str")==="lte"?"≤":"≥"}${thrHWin}%`, fn:f=>cmp("homewin_str",f.markets.homeWin,thrHWin) }] : []),
    ...(thrAWin!=null ? [{ id:"awaywin_str", label:`A Win ${dir("awaywin_str")==="lte"?"≤":"≥"}${thrAWin}%`, fn:f=>cmp("awaywin_str",f.markets.awayWin,thrAWin) }] : []),
    ...(thrHCS !=null ? [{ id:"cs_home",     label:`H CS ${dir("cs_home")==="lte"?"≤":"≥"}${thrHCS}%`,      fn:f=>cmp("cs_home",f.markets.homeCS,thrHCS) }] : []),
    ...(thrACS !=null ? [{ id:"cs_away",     label:`A CS ${dir("cs_away")==="lte"?"≤":"≥"}${thrACS}%`,      fn:f=>cmp("cs_away",f.markets.awayCS,thrACS) }] : []),
    ...(thrOdds!=null ? [{ id:"odds_floor",  label:`Odds ${dir("odds_floor")==="lte"?"≤":"≥"}${thrOdds}`,   fn:f=>{ const o=f.theRead?.anchor?.odds||f.theEdge?.odds; return o!=null?cmp("odds_floor",o,thrOdds):true; } }] : []),
    ...(thrDraw!=null ? [{ id:"draw_prob",   label:`Draw ${dir("draw_prob")==="lte"?"≤":"≥"}${thrDraw}%`,   fn:f=>cmp("draw_prob",f.markets.draw,thrDraw) }] : []),
  ], [xgBoth,xgHome,xgAway,thrBtts,thrHWin,thrAWin,thrHCS,thrACS,thrOdds,thrDraw,thrDirs]);

  // ── QUICK TEMPO — game shape/flow only, not market outcomes ──────────────
  // "What kind of match is this?" — sets filters that describe game character.
  // Never uses goal_radar (model output, not input). Never picks a market outcome.
  const TEMPO_PRESETS = [
    {
      id: "aggressive",
      label: "🔥 Aggressive",
      desc: "High combined xG, weak defences on both sides — goals very likely",
      hint: "Both CS < 20% · Total xG ≥2.5 · BTTS ≥52%",
      apply: () => {
        clearAll(); setActiveStrategy("aggressive");
        setStatFilters(["def_weak_home", "def_weak_away", "scheduled"]);
        setXgBoth(2.5); activateStat("xg_both");
        setThrBtts(52); activateStat("btts_q");
        setAdvancedOpen(true);
      },
    },
    {
      id: "balanced",
      label: "⚖️ Balanced",
      desc: "Mid xG, neither team dominating — open contest, goals possible both ends",
      hint: "Total xG 1.8–2.8 · no dominant side on xG · BTTS ≥45%",
      apply: () => {
        clearAll(); setActiveStrategy("balanced");
        setStatFilters(["scheduled"]);
        // xG between 1.8 and 2.8 — set floor (gte 1.8) manually; user can narrow further
        setXgBoth(1.8); activateStat("xg_both");
        setThrBtts(45); activateStat("btts_q");
        setAdvancedOpen(true);
      },
    },
    {
      id: "slow",
      label: "🔒 Slow",
      desc: "Low xG, clean-sheet bias — defensive game, draw/under territory",
      hint: "Total xG ≤1.8 · at least one CS ≥30% · draw prob ≥22%",
      apply: () => {
        clearAll(); setActiveStrategy("slow");
        setStatFilters(["low_xg", "scheduled"]);
        setXgBoth(1.8); setDir("xg_both", "lte"); activateStat("xg_both");
        setThrHCS(30); activateStat("cs_home");
        setThrDraw(22);
        setAdvancedOpen(true);
      },
    },
  ];

  // ── DETAILED STRATEGY — specific market outcomes ───────────────────────────
  // Each preset sets EVERY condition that makes that market meaningful.
  // No goal_radar. No duplicate logic between presets.
  const DETAILED_PRESETS = [
    {
      id: "home_win",
      label: "Home Win",
      filters: ["xg_home_dom", "scheduled"],
      family: "homewin",
      desc: "Home xG dominant — model and xG both back home",
      hint: "Home xG ≥2× away + gap ≥1 · home CS ≥25% (defence can hold)",
      applyExtra: () => {
        setThrHCS(25); activateStat("cs_home");
      },
    },
    {
      id: "away_win",
      label: "Away Win",
      filters: ["xg_away_dom", "scheduled"],
      family: "awaywin",
      desc: "Away team outperforms on xG despite venue disadvantage",
      hint: "Away xG ≥2× home + gap ≥1 · away CS ≥20%",
      applyExtra: () => {
        setThrACS(20); activateStat("cs_away");
      },
    },
    {
      id: "btts",
      label: "BTTS Yes",
      filters: ["def_weak_home", "def_weak_away", "scheduled"],
      family: "bttsyes",
      desc: "Both defences exposed, both sides individually generating",
      hint: "Both CS < 20% · each team xG ≥0.8 individually · BTTS ≥60%",
      applyExtra: () => {
        // Individual team xG (not total) — both teams must be generating
        setXgHome(0.8); activateStat("xg_home_min");
        setXgAway(0.8); activateStat("xg_away_min");
        setThrBtts(60); activateStat("btts_q");
      },
    },
    {
      id: "overs_25",
      label: "Over 2.5",
      filters: ["def_weak_home", "def_weak_away", "scheduled"],
      family: "over25",
      desc: "Multiple goals — weak defences, high total xG, BTTS environment",
      hint: "Both CS < 20% · total xG ≥2.5 · BTTS ≥52%",
      applyExtra: () => {
        setXgBoth(2.5); activateStat("xg_both");
        setThrBtts(52); activateStat("btts_q");
      },
    },
    {
      id: "unders_35",
      label: "Under 3.5",
      filters: ["scheduled"],
      family: "under35",
      desc: "Controlled game — both defences solid, 4 goals unlikely",
      hint: "Total xG ≤2.2 · both team CS ≥25%",
      applyExtra: () => {
        setXgBoth(2.2); setDir("xg_both", "lte"); activateStat("xg_both");
        setThrHCS(25); activateStat("cs_home");
        setThrACS(25); activateStat("cs_away");
      },
    },
    {
      id: "draw",
      label: "Draw",
      filters: ["low_xg", "scheduled"],
      family: "draw",
      desc: "Evenly matched — neither dominant on xG, both defences hold",
      hint: "Total xG ≤1.8 · draw prob ≥28% · both CS ≥22%",
      applyExtra: () => {
        setXgBoth(1.8); setDir("xg_both", "lte"); activateStat("xg_both");
        setThrDraw(28);
        setThrHCS(22); activateStat("cs_home");
        setThrACS(22); activateStat("cs_away");
      },
    },
    {
      id: "home_attack",
      label: "Home Attack",
      filters: ["scheduled"],
      family: "homeo15",
      desc: "Home team expected to score — team total angle, not 1X2",
      hint: "Home individual xG ≥1.0 · home O0.5 or O1.5 team total market",
      applyExtra: () => {
        setXgHome(1.0); activateStat("xg_home_min");
      },
    },
    {
      id: "away_attack",
      label: "Away Attack",
      filters: ["scheduled"],
      family: "awayo15",
      desc: "Away team expected to score — team total angle, not 1X2",
      hint: "Away individual xG ≥0.9 · away O0.5 or O1.5 team total market",
      applyExtra: () => {
        setXgAway(0.9); activateStat("xg_away_min");
      },
    },
  ];

  // ── Custom strategy save / load ──────────────────────────────────────────
  // Captures current filter state as a named snapshot in localStorage.
  // Edge cases handled: duplicate names overwrite, empty name blocked,
  // max 20 saved strategies to prevent localStorage bloat.
  const saveCurrentStrategy = () => {
    const name = saveStratName.trim();
    if (!name) return;
    const snapshot = {
      name, family,
      statFilters: [...statFilters],
      xgBoth, xgHome, xgAway,
      thrBtts, thrHWin, thrAWin, thrHCS, thrACS, thrOdds, thrDraw,
      thrDirs,
      savedAt: new Date().toISOString(),
    };
    setSavedStrats(prev => {
      // Overwrite if same name exists, otherwise append (max 20)
      const filtered = prev.filter(s => s.name !== name).slice(0, 19);
      const next = [...filtered, snapshot];
      try { localStorage.setItem(SAVED_STRATS_KEY, JSON.stringify(next)); } catch {}
      return next;
    });
    setSaveStratName("");
    setSaveStratOpen(false);
  };

  const loadSavedStrat = (strat) => {
    clearAll();
    setFamily(strat.family || "theRead");
    setStatFilters(strat.statFilters || []);
    setXgBoth(strat.xgBoth ?? null);
    setXgHome(strat.xgHome ?? null);
    setXgAway(strat.xgAway ?? null);
    setThrBtts(strat.thrBtts ?? null);
    setThrHWin(strat.thrHWin ?? null);
    setThrAWin(strat.thrAWin ?? null);
    setThrHCS(strat.thrHCS ?? null);
    setThrACS(strat.thrACS ?? null);
    setThrOdds(strat.thrOdds ?? null);
    setThrDraw(strat.thrDraw ?? null);
    setThrDirs(strat.thrDirs || {});
    setAdvancedOpen(true);
    setActiveStrategy(`saved_${strat.name}`);
  };

  const deleteSavedStrat = (name) => {
    setSavedStrats(prev => {
      const next = prev.filter(s => s.name !== name);
      try { localStorage.setItem(SAVED_STRATS_KEY, JSON.stringify(next)); } catch {}
      return next;
    });
  };

  const clearAll = () => {
    setActiveStrategy(null); setStatFilters([]); setAdvancedOpen(false);
    setXgBoth(null); setXgHome(null); setXgAway(null);
    setThrBtts(null); setThrHWin(null); setThrAWin(null);
    setThrHCS(null); setThrACS(null); setThrOdds(null); setThrDraw(null);
    setThrDirs({});  // reset all directions — prevents lte leaking into next preset
  };

  const applyDetailedPreset = strat => {
    if (activeStrategy === strat.id) { clearAll(); }
    else {
      clearAll();
      setActiveStrategy(strat.id);
      setStatFilters(strat.filters);
      setFamily(strat.family);
      setAdvancedOpen(true);
      // Some presets carry extra threshold activations (e.g. BTTS ≥65%, Total xG ≥2.0)
      // These run after clearAll resets all thresholds so the preset values win.
      if (strat.applyExtra) strat.applyExtra();
    }
  };

  const rows = useMemo(() => {
    const s = search.toLowerCase();
    // Market exclusion fallback: when a fixture's primary pick uses an excluded market,
    // try to find a second-best pick from a non-excluded market rather than hiding the fixture.
    const ALL_FAMILY_IDS = ["theRead","home_win","away_win","draw","over25","under25",
                            "over35","under35","bttsyes","bttsno","dc","teamtotal"];
    const getFallbackPick = (f) => {
      for (const fam of ALL_FAMILY_IDS) {
        if (fam === family) continue; // already tried primary
        const p = getCustomPick(f, fam, C);
        if (p && p.prob > 0 && !excludedMarkets.has(getExcludeSelectionId(p, f))) return p;
      }
      return null;
    };

    // P23-FIX: live + upcoming are mutually exclusive if applied as hard filters.
    // When both (or neither) are active, skip the status filter and sort live first instead.
    const hasLiveFilter     = statFilters.includes("live");
    const hasScheduledFilter = statFilters.includes("scheduled");
    const bothOrNeither     = (hasLiveFilter && hasScheduledFilter) || (!hasLiveFilter && !hasScheduledFilter);
    const statusFilters     = new Set(["live", "scheduled"]);

    return fixtures
      .filter(f => !s||f.teams.home.toLowerCase().includes(s)||f.teams.away.toLowerCase().includes(s)||f.league.toLowerCase().includes(s))
      .filter(f => statFilters.every(id => {
        if (statusFilters.has(id) && bothOrNeither) return true; // skip status filter — handled by sort
        const sf=STAT_FILTERS.find(x=>x.id===id); return sf?sf.fn(f):true;
      }))
      .map(f => {
        const primaryPick = getCustomPick(f, family, C);
        if (!primaryPick || primaryPick.prob <= 0) return null;
        // If primary pick's selection is excluded, try fallback
        const isExcluded = excludedMarkets.size > 0 &&
          excludedMarkets.has(getExcludeSelectionId(primaryPick, f));
        if (isExcluded) {
          const fallback = getFallbackPick(f);
          if (!fallback) return null; // no non-excluded alternative — hide
          return { f, pick: fallback, _usedFallback: true, _excludedMarket: primaryPick.market };
        }
        return { f, pick: primaryPick, _usedFallback: false };
      })
      .filter(Boolean)
      .sort((a, b) => {
        // P23-FIX: when both or neither status filter active, sort live first then by prob
        if (bothOrNeither) {
          const liveStates = new Set(["inprogress","live","1h","1sthalf","ht","halftime","2h","2ndhalf","et","extratime","penaltyshootout"]);
          const aLive = liveStates.has((a.f.state||"").toLowerCase()) ? 0 : 1;
          const bLive = liveStates.has((b.f.state||"").toLowerCase()) ? 0 : 1;
          if (aLive !== bLive) return aLive - bLive;
        }
        return b.pick.prob - a.pick.prob;
      });
  }, [fixtures, family, search, statFilters, STAT_FILTERS, excludedMarkets]);

  const saveListToJSON = () => {
    const payload = {
      date:todayStr(), savedAt:new Date().toISOString(), family, count:rows.length,
      rows:rows.map(({ f, pick }) => ({
        id:f.id, league:f.league, home:f.teams.home, away:f.teams.away, time:f.time,
        pick:pick.label, prob:Math.round(pick.prob), odds:pick.odds,
        homeXG:f.markets.homeXG, awayXG:f.markets.awayXG, strategyTags:f.strategyTags||[],
      })),
    };
    const blob = new Blob([JSON.stringify(payload,null,2)],{type:"application/json"});
    const url = URL.createObjectURL(blob); const a = document.createElement("a");
    a.href=url; a.download=`grm_list_${family}_${payload.date}.json`; a.click(); URL.revokeObjectURL(url);
  };

  if (selected && !onOpenFixture) return (
    <div>
      <button onClick={() => setSelected(null)} className="gb"
        style={{ marginBottom:12,background:"transparent",border:`1px solid ${C.faint}`,color:C.text,padding:"5px 14px",fontSize:9,display:"flex",alignItems:"center",gap:6 }}>
        ← Back to List
      </button>
      <FixtureCard f={selected} onAddToParlay={onAddToParlay} draftLegs={draftLegs} onFullModel={onFullModel} backtestSummary={backtestSummary} />
    </div>
  );

  const hasResults = fixtures.some(f => f.hGoals != null);
  const hasActive  = statFilters.length>0||xgBoth!=null||xgHome!=null||xgAway!=null||
                     thrBtts!=null||thrHWin!=null||thrAWin!=null||thrHCS!=null||
                     thrACS!=null||thrOdds!=null||thrDraw!=null||excludedMarkets.size>0;

  const chipOn  = col => ({ background:`${col}20`, color:col, border:`1px solid ${col}60` });
  const chipOff = { background:"transparent", color:C.muted, border:`1px solid ${C.faint}` };

  // Inline threshold chip — tap label to toggle on/off.
  // When active: shows direction toggle ("more than" / "less than") + number input.
  // Uses text inputMode="decimal" to avoid Android keyboard-close bug.
  // Issue 9 fix: commits value on Enter key AND via 600ms debounce so users don't
  // have to tap the screen after typing — the filter activates automatically.
  const ThrChip = ({ label, id, value, setValue, min, max, step=1, col=C.gold }) => {
    const [localVal, setLocalVal] = useState("");
    const debounceRef = useRef(null);

    const isOn = statFilters.includes(id) && value != null;
    const currentDir = dir(id); // "gte" | "lte" from parent thrDirs state

    useEffect(() => { if (value != null) setLocalVal(String(value)); }, [value]);

    const activate   = () => { setValue(min); activateStat(id); setLocalVal(String(min)); };
    const deactivate = () => { deactivateStat(id); setValue(null); setLocalVal(""); };

    const commitVal = () => {
      if (debounceRef.current) { clearTimeout(debounceRef.current); debounceRef.current = null; }
      const v = parseFloat(localVal);
      if (!isNaN(v)) {
        const clamped = Math.min(max, Math.max(min, v));
        setValue(clamped); setLocalVal(String(clamped));
      } else {
        setLocalVal(value != null ? String(value) : String(min));
      }
    };

    const handleChange = (e) => {
      const raw = e.target.value;
      setLocalVal(raw);
      // Debounce: auto-commit 600ms after user stops typing
      // This means the filter activates without needing to tap screen or press Enter
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => {
        const v = parseFloat(raw);
        if (!isNaN(v)) {
          const clamped = Math.min(max, Math.max(min, v));
          setValue(clamped);
          setLocalVal(String(clamped));
        }
        debounceRef.current = null;
      }, 600);
    };

    return (
      <div style={{ display:"inline-flex", flexDirection:"column", alignItems:"stretch",
                    border:`1px solid ${isOn?col:C.faint}`, borderRadius:8,
                    overflow:"hidden", fontSize:9, flexShrink:0, minWidth:72 }}>
        {/* Label row — tap to toggle on/off */}
        <button onClick={() => isOn ? deactivate() : activate()}
                style={{ padding:"5px 10px", background:isOn?`${col}20`:"transparent",
                         color:isOn?col:C.muted, border:"none", cursor:"pointer",
                         fontFamily:C.font, fontSize:9, fontWeight:700,
                         whiteSpace:"nowrap", textAlign:"center" }}>
          {label}
        </button>
        {isOn && (
          <>
            {/* P11-FIX: Direction toggle — full border + tinted bg so it reads as tappable */}
            <button onClick={() => setDir(id, currentDir === "gte" ? "lte" : "gte")}
                    title="Tap to switch between ≥ and ≤"
                    style={{ padding:"4px 8px", background:`${col}18`,
                             border:`1px solid ${col}40`,
                             color:col, cursor:"pointer", fontFamily:C.font,
                             fontSize:8, fontWeight:800, textAlign:"center", letterSpacing:".02em",
                             display:"flex", alignItems:"center", justifyContent:"center", gap:4,
                             transition:"background .12s" }}>
              <span style={{ fontSize:11, lineHeight:1 }}>{currentDir === "gte" ? "≥" : "≤"}</span>
              <span style={{ opacity:.85 }}>{currentDir === "gte" ? "more than" : "less than"}</span>
              <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" style={{ opacity:.6, flexShrink:0 }}>
                <polyline points="18 15 12 9 6 15"/>
              </svg>
            </button>
            {/* Number input */}
            <input
              type="text" inputMode="decimal" pattern="[0-9.]*"
              value={localVal}
              onChange={handleChange}
              onBlur={commitVal}
              onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); commitVal(); e.target.blur(); } }}
              onClick={e => e.stopPropagation()}
              style={{ background:`${col}12`, border:"none", borderTop:`1px solid ${col}20`,
                       color:col, fontWeight:900, fontSize:11, textAlign:"center",
                       padding:"5px 4px", fontFamily:C.font, outline:"none", width:"100%" }}
            />
          </>
        )}
      </div>
    );
  };

  return (
    <div>
      <div style={{ display:"flex",alignItems:"center",gap:6,background:C.radarDim,border:`1px solid ${C.radarBorder}`,borderRadius:7,padding:"6px 12px",marginBottom:14,fontSize:8,color:C.radar,fontWeight:700,letterSpacing:".06em" }}>
        🖥️ Best experienced in desktop site mode — more columns, filters and strategy rows visible at once.
      </div>

      {/* ── STRATEGY ── */}
      <div style={{ marginBottom:12 }}>
        <div style={{ fontSize:9,color:C.text,textTransform:"uppercase",letterSpacing:".12em",fontWeight:700,marginBottom:6 }}>Strategy</div>
        <div style={{ fontSize:9,color:C.muted,letterSpacing:".1em",fontWeight:700,marginBottom:5,textTransform:"uppercase" }}>Quick Tempo</div>
        <div className="filter-wrap" style={{ marginBottom:10 }}>
          {TEMPO_PRESETS.map(p => {
            const isActive = activeStrategy===p.id;
            return (
              <button key={p.id} title={p.hint || p.desc} className="gb"
                onClick={() => { isActive ? clearAll() : p.apply(); }}
                style={{ padding:"5px 12px",fontSize:9,textTransform:"none",letterSpacing:".03em",
                         ...(isActive?chipOn(C.amber):chipOff) }}>
                {p.label}
              </button>
            );
          })}
        </div>
        {/* Active strategy hint — shows what the selected strategy actually does */}
        {activeStrategy && (() => {
          const all = [...TEMPO_PRESETS, ...(DETAILED_PRESETS||[])];
          const found = all.find(s => s.id === activeStrategy);
          return found ? (
            <div style={{ fontSize:8, color:C.amber, marginBottom:6, lineHeight:1.5, padding:"4px 8px",
                          background:`${C.amber}0a`, borderRadius:5, border:`1px solid ${C.amber}20` }}>
              {found.hint || found.desc}
            </div>
          ) : null;
        })()}
        <div style={{ fontSize:9,color:C.muted,letterSpacing:".1em",fontWeight:700,marginBottom:6,textTransform:"uppercase" }}>Detailed Strategy</div>
        <div className="filter-wrap" style={{ marginBottom:6 }}>
          {DETAILED_PRESETS.map(strat => {
            const active = activeStrategy===strat.id;
            return (
              <button key={strat.id} onClick={()=>applyDetailedPreset(strat)} className="gb" title={strat.hint || strat.desc}
                style={{ padding:"4px 12px",fontSize:9,textTransform:"none",letterSpacing:".03em",
                         ...(active?chipOn(C.amber):chipOff) }}>
                {strat.label}
              </button>
            );
          })}
        </div>
        {hasActive && (
          <button onClick={clearAll} className="gb"
            style={{ marginTop:4,padding:"3px 10px",background:"transparent",color:C.red,border:`1px solid ${C.red}50`,fontSize:8 }}>
            Clear all ✕
          </button>
        )}

        {/* ── Saved Strategies — save current or load a saved one ── */}
        <div style={{ marginTop:10,borderTop:`1px solid ${C.faint}`,paddingTop:10 }}>
          <div style={{ display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:6 }}>
            <div style={{ fontSize:9,color:C.muted,letterSpacing:".1em",fontWeight:700,textTransform:"uppercase" }}>
              Saved Strategies {savedStrats.length > 0 && <span style={{ color:C.radar,fontWeight:900 }}>({savedStrats.length})</span>}
            </div>
            {hasActive && (
              <button onClick={() => setSaveStratOpen(v => !v)} className="gb"
                style={{ padding:"2px 9px",fontSize:8,color:C.radar,border:`1px solid ${C.radar}40`,background:C.radarDim }}>
                {saveStratOpen ? "Cancel" : "+ Save current"}
              </button>
            )}
          </div>

          {/* Save form — inline, shown only when triggered */}
          {saveStratOpen && (
            <div style={{ display:"flex",gap:6,alignItems:"center",marginBottom:8 }}>
              <input
                type="text"
                value={saveStratName}
                onChange={e => setSaveStratName(e.target.value)}
                onKeyDown={e => e.key === "Enter" && saveCurrentStrategy()}
                placeholder="Strategy name…"
                maxLength={40}
                autoFocus
                className="gi"
                style={{ flex:1,fontSize:9,padding:"5px 8px" }}
              />
              <button onClick={saveCurrentStrategy} disabled={!saveStratName.trim()} className="gb"
                style={{ padding:"5px 10px",fontSize:9,background:saveStratName.trim()?C.radar:"transparent",
                         color:saveStratName.trim()?C.accentText:C.muted,
                         border:`1px solid ${saveStratName.trim()?C.radar:C.faint}`,flexShrink:0 }}>
                Save
              </button>
            </div>
          )}

          {/* Saved strategy chips — load or delete */}
          {savedStrats.length > 0 && (
            <div className="filter-wrap">
              {savedStrats.map(s => {
                const isLoaded = activeStrategy === `saved_${s.name}`;
                return (
                  <div key={s.name} style={{ display:"inline-flex",alignItems:"stretch",
                    border:`1px solid ${isLoaded?C.radar:C.faint}`,borderRadius:6,overflow:"hidden",flexShrink:0 }}>
                    <button onClick={() => isLoaded ? clearAll() : loadSavedStrat(s)} className="gb"
                      style={{ padding:"4px 9px",fontSize:9,background:isLoaded?C.radarDim:"transparent",
                               color:isLoaded?C.radar:C.muted,border:"none",borderRight:`1px solid ${isLoaded?C.radar:C.faint}`,
                               fontWeight:isLoaded?800:500 }}>
                      {s.name}
                    </button>
                    <button onClick={() => deleteSavedStrat(s.name)}
                      style={{ background:"transparent",border:"none",color:C.muted,cursor:"pointer",
                               padding:"0 7px",fontSize:11,lineHeight:1 }}
                      title="Delete this saved strategy">
                      ✕
                    </button>
                  </div>
                );
              })}
            </div>
          )}

          {savedStrats.length === 0 && (
            <div style={{ fontSize:8,color:C.muted,opacity:.6 }}>
              Set filters above, then save them as a named strategy to reuse quickly.
            </div>
          )}
        </div>
      </div>

      {/* ── PICK MARKET ── */}
      <div style={{ marginBottom:10 }}>
        <div style={{ fontSize:9,color:C.text,textTransform:"uppercase",letterSpacing:".12em",fontWeight:700,marginBottom:6 }}>Pick Market</div>
        <div className="cscroll">
          {CUSTOM_FAMILIES.map(fam => (
            <button key={fam.id} onClick={()=>{ setFamily(fam.id); setActiveStrategy(null); }} className="gb"
              style={{ flexShrink:0,padding:"5px 12px",fontSize:10,textTransform:"none",
                       background:family===fam.id?C.gold:"transparent",
                       color:family===fam.id?C.accentText:C.muted,
                       border:`1px solid ${family===fam.id?C.gold:C.faint}` }}>
              {fam.label}
            </button>
          ))}
        </div>
      </div>

      {/* ── SIGNAL ── binary toggles only, no threshold chips */}
      <div style={{ marginBottom:10 }}>
        <div style={{ fontSize:9,color:C.text,textTransform:"uppercase",letterSpacing:".12em",fontWeight:700,marginBottom:6 }}>Signal</div>
        <div style={{ display:"flex",flexWrap:"wrap",gap:6,alignItems:"center" }}>
          {["model_pick","goal_radar","scheduled","live"].map(id => {
            const sf   = STAT_FILTERS.find(x=>x.id===id);
            if (!sf) return null;
            const isOn = statFilters.includes(id);
            const col  = id==="live"?C.red:id==="scheduled"?C.gold:C.green;
            return (
              <button key={id} onClick={()=>toggleStat(id)} className="gb" title={sf.desc}
                style={{ padding:"4px 11px",fontSize:9,textTransform:"none",
                         display:"flex",alignItems:"center",gap:5,
                         ...(isOn?chipOn(col):chipOff) }}>
                {sf.icon && <span style={{ color: isOn ? col : C.muted, lineHeight:0 }}>{sf.icon}</span>}
                {sf.label}
              </button>
            );
          })}
        </div>
      </div>

      {/* ── ADVANCED ── collapsible, designed to signal there's content inside */}
      {/* UX-FIX: unified active-filter count covers thresholds, condition toggles, AND exclude-market rules,
          so the indicator is accurate no matter which kind of advanced filter is active or whether the panel is open/closed */}
      <div style={{ marginBottom:14 }}>
        {/* Header row — full-width tap target, visually distinct */}
        {(() => {
          const advThrCount  = [thrBtts,xgBoth,xgHome,xgAway,thrHWin,thrAWin,thrHCS,thrACS,thrOdds,thrDraw].filter(v=>v!=null).length;
          const advCondCount = ["xg_home_dom","xg_away_dom","def_weak_home","def_weak_away","low_xg","volatile"].filter(id=>statFilters.includes(id)).length;
          const advExclCount = excludedMarkets.size;
          const advActiveCount = advThrCount + advCondCount + advExclCount;
          const advHasActive = advActiveCount > 0;
          return (
        <button onClick={()=>setAdvancedOpen(v=>!v)}
                style={{ width:"100%", display:"flex", justifyContent:"space-between", alignItems:"center",
                         background: advancedOpen ? `${C.gold}12` : (advHasActive ? `${C.gold}08` : C.surface),
                         border: `1px solid ${advancedOpen ? `${C.gold}50` : (advHasActive ? `${C.gold}35` : C.border)}`,
                         borderRadius: advancedOpen ? "8px 8px 0 0" : 8,
                         cursor:"pointer", padding:"10px 14px",
                         transition:"all .15s" }}>
          <div style={{ display:"flex", alignItems:"center", gap:8 }}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ color: advancedOpen ? C.gold : C.muted }}>
              <circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
            </svg>
            <span style={{ fontSize:9, fontWeight:800, color: advancedOpen ? C.gold : C.text,
                           textTransform:"uppercase", letterSpacing:".1em" }}>Advanced Filters</span>
            {/* UX-FIX: active count badge now reflects thresholds + condition toggles + exclude-market rules,
                and is shown whenever any filter is active, not only when the panel is collapsed */}
            {advHasActive && (
                <span style={{ background:C.gold, color:C.accentText, borderRadius:10,
                               fontSize:7, fontWeight:900, padding:"1px 7px", lineHeight:1.5,
                               minWidth:18, textAlign:"center" }}>
                  {advActiveCount}
                </span>
            )}
          </div>
          <div style={{ display:"flex", alignItems:"center", gap:6 }}>
            {!advancedOpen && (() => {
              // UX-FIX: show active filter labels when collapsed, now including condition toggles and exclude-market count
              const condLabels = {
                xg_home_dom:"HxG Dom", xg_away_dom:"AxG Dom", def_weak_home:"Weak HDef",
                def_weak_away:"Weak ADef", low_xg:"Low xG", volatile:"Volatile"
              };
              const active = [
                xgBoth  != null && `xG≥${xgBoth}`,
                xgHome  != null && `HxG≥${xgHome}`,
                xgAway  != null && `AxG≥${xgAway}`,
                thrBtts != null && `BTTS≥${thrBtts}%`,
                thrHWin != null && `HWin≥${thrHWin}%`,
                thrAWin != null && `AWin≥${thrAWin}%`,
                thrHCS  != null && `HCS≥${thrHCS}%`,
                thrACS  != null && `ACS≥${thrACS}%`,
                thrOdds != null && `Odds≥${thrOdds}`,
                thrDraw != null && `Draw≥${thrDraw}%`,
                ...Object.entries(condLabels).filter(([id])=>statFilters.includes(id)).map(([,label])=>label),
                advExclCount > 0 && `${advExclCount} excluded`,
              ].filter(Boolean);
              return active.length > 0
                ? <span style={{ fontSize:8, color:C.gold, fontWeight:700 }}>{active.slice(0,3).join(" · ")}{active.length>3?` +${active.length-3}`:""}</span>
                : <span style={{ fontSize:8, color:C.muted, fontStyle:"italic" }}>xG · Win % · CS · Odds</span>;
            })()}
            <span style={{ fontSize:11, color: advancedOpen ? C.gold : C.muted, fontWeight:700,
                           transform: advancedOpen ? "rotate(180deg)" : "none", transition:"transform .2s" }}>▾</span>
          </div>
        </button>
          );
        })()}

        {advancedOpen && (
          <div style={{ border:`1px solid ${C.gold}30`, borderTop:"none", borderRadius:"0 0 8px 8px",
                        padding:"12px 10px", display:"flex", flexDirection:"column", gap:12,
                        background:`${C.gold}05` }}>
            {/* BTTS moved from Signal to here */}
            <div>
              <div style={{ fontSize:7,color:C.muted,letterSpacing:".1em",fontWeight:700,textTransform:"uppercase",marginBottom:6 }}>BTTS</div>
              <div style={{ display:"flex",flexWrap:"wrap",gap:6 }}>
                <ThrChip label="BTTS Yes" id="btts_q" value={thrBtts} setValue={setThrBtts} min={50} max={85} col={C.purple||C.gold} />
              </div>
            </div>
            <div>
              <div style={{ fontSize:7,color:C.muted,letterSpacing:".1em",fontWeight:700,textTransform:"uppercase",marginBottom:6 }}>xG Thresholds</div>
              <div style={{ display:"flex",flexWrap:"wrap",gap:6 }}>
                <ThrChip label="Home xG" id="xg_home_min" value={xgHome} setValue={setXgHome} min={0.5} max={10.0} step={0.1} col={C.gold} />
                <ThrChip label="Away xG" id="xg_away_min" value={xgAway} setValue={setXgAway} min={0.5} max={10.0} step={0.1} col={C.edge||C.green} />
                <ThrChip label="Total xG" id="xg_both"     value={xgBoth} setValue={setXgBoth} min={0.5} max={10.0} step={0.1} col={C.radar||C.green} />
              </div>
            </div>
            <div>
              <div style={{ fontSize:7,color:C.muted,letterSpacing:".1em",fontWeight:700,textTransform:"uppercase",marginBottom:6 }}>Win Probability</div>
              <div style={{ display:"flex",flexWrap:"wrap",gap:6 }}>
                <ThrChip label="Home Win" id="homewin_str" value={thrHWin} setValue={setThrHWin} min={40} max={90} col={C.blue||C.gold} />
                <ThrChip label="Away Win" id="awaywin_str" value={thrAWin} setValue={setThrAWin} min={40} max={80} col={C.edge||C.green} />
                <ThrChip label="Draw"     id="draw_prob"   value={thrDraw} setValue={setThrDraw} min={20} max={50} col={C.muted} />
              </div>
            </div>
            <div>
              <div style={{ fontSize:7,color:C.muted,letterSpacing:".1em",fontWeight:700,textTransform:"uppercase",marginBottom:6 }}>Clean Sheet</div>
              <div style={{ display:"flex",flexWrap:"wrap",gap:6 }}>
                <ThrChip label="Home CS" id="cs_home" value={thrHCS} setValue={setThrHCS} min={15} max={70} step={5} col={C.green} />
                <ThrChip label="Away CS" id="cs_away" value={thrACS} setValue={setThrACS} min={15} max={70} step={5} col={C.green} />
              </div>
            </div>
            <div>
              <div style={{ fontSize:7,color:C.muted,letterSpacing:".1em",fontWeight:700,textTransform:"uppercase",marginBottom:6 }}>Conditions</div>
              <div style={{ display:"flex",flexWrap:"wrap",gap:6 }}>
                <ThrChip label="Odds" id="odds_floor" value={thrOdds} setValue={setThrOdds} min={1.05} max={3.0} step={0.05} col={C.gold} />
                {["xg_home_dom","xg_away_dom","def_weak_home","def_weak_away","low_xg","volatile"].map(id => {
                  const sf   = STAT_FILTERS.find(x=>x.id===id);
                  if (!sf) return null;
                  const isOn = statFilters.includes(id);
                  const col  = id.includes("weak")||id==="volatile"?C.red:C.muted;
                  return (
                    <button key={id} onClick={()=>toggleStat(id)} className="gb" title={sf.desc}
                      style={{ padding:"4px 10px",fontSize:9,textTransform:"none",
                               ...(isOn?chipOn(col):chipOff) }}>
                      {sf.label}
                    </button>
                  );
                })}
              </div>
            </div>

            {/* ── Market Exclusion — UX-FIX: visually walled off from the condition filters above ──
                 dashed divider + red-tinted panel + red heading make it unmistakably a separate, exclusion-only group */}
            <div style={{ marginTop:4, paddingTop:14, borderTop:`1px dashed ${C.red}40` }}>
              <div style={{ background:`${C.red}08`, border:`1px solid ${C.red}25`, borderRadius:8, padding:"10px 10px 12px" }}>
                <div style={{ fontSize:7,color:C.red,letterSpacing:".1em",fontWeight:800,textTransform:"uppercase",
                              marginBottom:6, display:"flex", alignItems:"center", gap:5 }}>
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="12" cy="12" r="10"/><line x1="4.93" y1="4.93" x2="19.07" y2="19.07"/>
                  </svg>
                  Exclude Markets
                  {excludedMarkets.size > 0 && (
                    <button onClick={() => setExcludedMarkets(new Set())}
                      style={{ marginLeft:8,fontSize:7,color:C.red,background:"none",border:"none",cursor:"pointer",fontFamily:C.font,textTransform:"none",letterSpacing:0,fontWeight:700 }}>
                      Clear
                    </button>
                  )}
                </div>
                <div style={{ fontSize:8,color:C.muted,marginBottom:6,lineHeight:1.4 }}>
                  Fixtures with excluded picks show their next-best market instead.
                </div>
                <div style={{ display:"flex",flexDirection:"column",gap:8 }}>
                  {EXCLUDE_SELECTION_GROUPS.map(group => (
                    <div key={group.label}>
                      <div style={{ fontSize:7,color:C.muted,letterSpacing:".08em",fontWeight:700,textTransform:"uppercase",marginBottom:4 }}>
                        {group.label}
                      </div>
                      <div style={{ display:"flex",flexWrap:"wrap",gap:5 }}>
                        {group.options.map(({ id, label }) => {
                          const on = excludedMarkets.has(id);
                          return (
                            <button key={id} onClick={() => toggleExcludeMarket(id)} className="gb"
                              style={{ padding:"4px 10px", fontSize:9, textTransform:"none",
                                       ...(on ? chipOn(C.red) : chipOff) }}>
                              {on ? `✕ ${label}` : label}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* List header */}
      {/* UX-FIX: Select All is now a persistent control in this top bar — always visible and always
          clickable (before, during, and after partial selection), with a readable "N selected" count
          and a separate Clear action, instead of vanishing once any item is selected. */}
      <div style={{ display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:10,gap:10,flexWrap:"wrap" }}>
        <div style={{ display:"flex",alignItems:"center",gap:12,flexWrap:"wrap" }}>
          <span style={{ fontSize:9,color:C.text }}>{rows.length} matches</span>
          {(() => {
            const eligibleIds = rows.filter(({ f }) => !isFixtureFT(f)).map(({ f }) => f.id);
            const allSelected = eligibleIds.length > 0 && eligibleIds.every(id => selectedIds.has(id));
            const hasPartial  = selectedIds.size > 0 && !allSelected;
            if (eligibleIds.length === 0) return null;
            return (
              <button onClick={() => { allSelected ? clearSelection() : setSelectedIds(new Set(eligibleIds)); }}
                title={allSelected ? "Deselect all" : "Select all fixtures"}
                style={{ display:"flex",alignItems:"center",gap:6,background:"none",border:"none",cursor:"pointer",padding:0 }}>
                <div style={{ width:14,height:14,borderRadius:4,
                              border:`1.5px solid ${allSelected||hasPartial?C.edge:C.text}`,
                              opacity:allSelected||hasPartial?1:.4,
                              background:allSelected?C.edge:"transparent",flexShrink:0,
                              display:"flex",alignItems:"center",justifyContent:"center" }}>
                  {allSelected && <span style={{ fontSize:8,color:C.accentText,fontWeight:900 }}>✓</span>}
                  {hasPartial && <div style={{ width:6,height:1.5,background:C.edge,borderRadius:1 }} />}
                </div>
                <span style={{ fontSize:9,fontWeight:800,color:allSelected||hasPartial?C.edge:C.muted,
                               textTransform:"uppercase",letterSpacing:".04em" }}>
                  Select All
                </span>
              </button>
            );
          })()}
          {selectedIds.size > 0 && (
            <span style={{ display:"flex",alignItems:"center",gap:8 }}>
              <span style={{ fontSize:9,fontWeight:800,color:C.edge }}>{selectedIds.size} selected</span>
              <button onClick={clearSelection} title="Clear selection"
                style={{ background:"none",border:"none",color:C.red,cursor:"pointer",fontSize:9,fontWeight:700,padding:0 }}>
                Clear
              </button>
            </span>
          )}
        </div>
        {rows.length > 0 && (
          <button onClick={saveListToJSON} className="gb"
            style={{ padding:"3px 10px",background:"transparent",border:`1px solid ${C.radar}50`,color:C.radar,fontSize:9,display:"flex",alignItems:"center",gap:4 }}>
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg>
            Save JSON</button>
        )}
      </div>

      {/* Column headers */}
      {!isMobile && (
        <div style={{ display:"grid",gridTemplateColumns:hasResults?"24px 50px 1fr 140px 60px 60px 72px":"24px 50px 1fr 140px 60px 60px",gap:8,padding:"6px 14px",borderBottom:`1px solid ${C.border}`,fontSize:9,color:C.text,textTransform:"uppercase",letterSpacing:".1em",fontWeight:700,marginBottom:4 }}>
          {/* UX-FIX: compact checkbox mirrors per-row checkboxes for visual consistency;
              primary Select All control with full label now lives in the list header above */}
          <span>
            {(() => {
              const eligibleIds = rows.filter(({ f }) => !isFixtureFT(f)).map(({ f }) => f.id);
              const allSelected = eligibleIds.length > 0 && eligibleIds.every(id => selectedIds.has(id));
              const hasPartial  = selectedIds.size > 0 && !allSelected;
              if (eligibleIds.length === 0) return null;
              return (
                <button onClick={() => { allSelected ? clearSelection() : setSelectedIds(new Set(eligibleIds)); }}
                  title={allSelected ? "Deselect all" : "Select all fixtures"}
                  style={{ background:"none",border:"none",cursor:"pointer",padding:0,display:"flex",alignItems:"center",justifyContent:"center" }}>
                  <div style={{ width:14,height:14,borderRadius:4,
                                border:`1.5px solid ${allSelected||hasPartial?C.edge:C.text}`,
                                opacity:allSelected||hasPartial?1:.35,
                                background:allSelected?C.edge:"transparent",
                                display:"flex",alignItems:"center",justifyContent:"center" }}>
                    {allSelected && <span style={{ fontSize:8,color:C.accentText,fontWeight:900 }}>✓</span>}
                    {hasPartial && <div style={{ width:6,height:1.5,background:C.edge,borderRadius:1 }} />}
                  </div>
                </button>
              );
            })()}
          </span>
          <span>Time</span><span>Match</span><span>Pick</span><span>Prob</span><span>Odds</span>
          {hasResults && <span>Score</span>}
        </div>
      )}
      {isMobile && (
        <div style={{ display:"grid",gridTemplateColumns:hasResults?"20px 1fr 44px 44px":"20px 1fr 44px",gap:6,padding:"5px 10px",borderBottom:`1px solid ${C.border}`,fontSize:9,color:C.text,textTransform:"uppercase",letterSpacing:".1em",fontWeight:700,marginBottom:4 }}>
          {/* UX-FIX: compact checkbox mirrors per-row checkboxes; full-label Select All + count
              now live persistently in the list header above this column-header row */}
          <span>
            {(() => {
              const eligibleIds = rows.filter(({ f }) => !isFixtureFT(f)).map(({ f }) => f.id);
              const allSelected = eligibleIds.length > 0 && eligibleIds.every(id => selectedIds.has(id));
              const hasPartial  = selectedIds.size > 0 && !allSelected;
              if (eligibleIds.length === 0) return null;
              return (
                <button onClick={() => { allSelected ? clearSelection() : setSelectedIds(new Set(eligibleIds)); }}
                  title={allSelected ? "Deselect all" : "Select all fixtures"}
                  style={{ background:"none",border:"none",cursor:"pointer",padding:0,display:"flex",alignItems:"center",justifyContent:"center" }}>
                  <div style={{ width:14,height:14,borderRadius:4,
                                border:`1.5px solid ${allSelected||hasPartial?C.edge:C.text}`,
                                opacity:allSelected||hasPartial?1:.35,
                                background:allSelected?C.edge:"transparent",
                                display:"flex",alignItems:"center",justifyContent:"center" }}>
                    {allSelected && <span style={{ fontSize:8,color:C.accentText,fontWeight:900 }}>✓</span>}
                    {hasPartial && <div style={{ width:6,height:1.5,background:C.edge,borderRadius:1 }} />}
                  </div>
                </button>
              );
            })()}
          </span>
          <span>Match / Pick</span><span style={{ textAlign:"right" }}>%</span>
          {hasResults && <span style={{ textAlign:"right" }}>Score</span>}
        </div>
      )}

      {/* Rows */}
      <div style={{ display:"flex",flexDirection:"column",gap:2,paddingBottom:selectedIds.size > 0 ? 60 : 0 }}>
        {rows.map(({ f, pick, _usedFallback, _excludedMarket }) => {
          const probColor = pick.prob >= 75 ? C.green : pick.prob >= 60 ? C.gold : C.muted;
          const isSelected = selectedIds.has(f.id);
          const isFT = isFixtureFT(f);
          const cols = hasResults ? "24px 50px 1fr 140px 60px 60px 72px" : "24px 50px 1fr 140px 60px 60px";
          const mCols = hasResults ? "20px 1fr 44px 44px" : "20px 1fr 44px";
          if (isMobile) return (
            <div key={f.id} style={{ display:"grid",gridTemplateColumns:mCols,gap:6,padding:"8px 10px",
                                     background:isFT?`${C.surface}60`:isSelected?"rgba(99,102,241,0.1)":C.surface,
                                     borderRadius:8,border:`1px solid ${isSelected?C.edge:C.border}`,
                                     cursor:isFT?"default":"pointer",opacity:isFT?.5:1,transition:"all .15s",alignItems:"center" }}
              onClick={() => isFT ? null : onOpenFixture ? onOpenFixture(f.id) : setSelected(f)}>
              <div onClick={e=>{e.stopPropagation(); if(!isFT) toggleSelect(f.id);}}>
                <div style={{ width:16,height:16,borderRadius:4,border:`1.5px solid ${isFT?C.muted:isSelected?C.edge:C.text}`,opacity:isFT?.3:isSelected?1:.3,background:isSelected?C.edge:"transparent",display:"flex",alignItems:"center",justifyContent:"center" }}>
                  {isSelected && <span style={{ fontSize:9,color:C.accentText,fontWeight:900 }}>✓</span>}
                  {isFT && <span style={{ fontSize:7,color:C.muted,fontWeight:900 }}>FT</span>}
                </div>
              </div>
              <div style={{ minWidth:0 }}>
                <div style={{ fontSize:10,fontWeight:700,color:C.text,lineHeight:1.3,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap" }}>{f.teams.home} <span style={{ color:C.text,opacity:.3 }}>vs</span> {f.teams.away}</div>
                <div style={{ fontSize:8,color:C.text,marginTop:1,display:"flex",gap:5,alignItems:"center" }}>
                  <StatusBadge state={f.state} time={f.time} />
                  {f.league && <span style={{ overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap" }}>{f.league}</span>}
                </div>
                <div style={{ fontSize:9,fontWeight:700,color:pick.color||C.text,marginTop:3,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",display:"flex",alignItems:"center",gap:4 }}>
                  {/* P1-FIX: in-draft dot — shows when this fixture is already in the active draft */}
                  {draftLegs?.some(l => l.fixtureId === f.id) && (
                    <span style={{ flexShrink:0, fontSize:6, fontWeight:900, letterSpacing:".06em",
                                   background:C.accent, color:C.accentText, borderRadius:4,
                                   padding:"1px 5px", lineHeight:1.6, textTransform:"uppercase" }}>
                      Draft
                    </span>
                  )}
                  <span style={{ overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap" }}>{pick.label}</span>
                  {_usedFallback && (
                    <span style={{ marginLeft:5,fontSize:7,color:C.amber,background:`${C.amber}15`,
                                   border:`1px solid ${C.amber}30`,borderRadius:3,padding:"1px 4px",flexShrink:0 }}>
                      ↓ {_excludedMarket} excluded
                    </span>
                  )}
                </div>
                <div className="cb" style={{ marginTop:3 }}><div className="cf" style={{ width:`${Math.min(pick.prob,100)}%`,background:probColor }}/></div>
              </div>
              <div style={{ textAlign:"right",fontSize:12,fontWeight:800,color:probColor }}>{Math.round(pick.prob)}%</div>
              {hasResults && (
                <div style={{ textAlign:"right" }}>
                  {f.hGoals != null ? <ResultBadge f={f} /> : <span style={{ fontSize:9,color:C.text }}>—</span>}
                </div>
              )}
            </div>
          );
          return (
            <div key={f.id} style={{ display:"grid",gridTemplateColumns:cols,gap:8,padding:"8px 14px",
                                     background:isFT?`${C.surface}60`:isSelected?"rgba(99,102,241,0.1)":C.surface,
                                     borderRadius:8,border:`1px solid ${isSelected?C.edge:C.border}`,
                                     cursor:isFT?"default":"pointer",opacity:isFT?.5:1,transition:"all .15s" }}
              onClick={() => isFT ? null : onOpenFixture ? onOpenFixture(f.id) : setSelected(f)}
              onMouseEnter={e=>{ if(!isSelected&&!isFT){ e.currentTarget.style.borderColor=C.borderHi; e.currentTarget.style.background=C.surfaceHi; }}}
              onMouseLeave={e=>{ if(!isSelected&&!isFT){ e.currentTarget.style.borderColor=C.border; e.currentTarget.style.background=C.surface; }}}>
              <div style={{ alignSelf:"center" }} onClick={e=>{e.stopPropagation(); if(!isFT) toggleSelect(f.id);}}>
                <div style={{ width:16,height:16,borderRadius:4,border:`1.5px solid ${isFT?C.muted:isSelected?C.edge:C.text}`,opacity:isFT?.3:isSelected?1:.3,background:isSelected?C.edge:"transparent",display:"flex",alignItems:"center",justifyContent:"center" }}>
                  {isSelected && <span style={{ fontSize:9,color:C.accentText,fontWeight:900 }}>✓</span>}
                  {isFT && <span style={{ fontSize:7,color:C.muted,fontWeight:900 }}>FT</span>}
                </div>
              </div>
              <div style={{ alignSelf:"center",fontSize:9,color:C.text }}>
                <StatusBadge state={f.state} time={f.time} />
              </div>
              <div style={{ alignSelf:"center" }}>
                <div style={{ fontSize:10,fontWeight:700,color:C.text,lineHeight:1.3 }}>{f.teams.home} <span style={{ color:C.text,opacity:.3 }}>vs</span> {f.teams.away}</div>
                <div style={{ fontSize:8,color:C.text,marginTop:1 }}>{f.league}{f.volatileLeague?" · volatile":""}</div>
              </div>
              <div style={{ alignSelf:"center" }}>
                <div style={{ fontSize:10,fontWeight:700,color:pick.color||C.text,lineHeight:1.2,display:"flex",alignItems:"center",gap:4 }}>
                  {/* P1-FIX: in-draft dot */}
                  {draftLegs?.some(l => l.fixtureId === f.id) && (
                    <span style={{ flexShrink:0, fontSize:6, fontWeight:900, letterSpacing:".06em",
                                   background:C.accent, color:C.accentText, borderRadius:4,
                                   padding:"1px 5px", lineHeight:1.6, textTransform:"uppercase" }}>
                      Draft
                    </span>
                  )}
                  {pick.label}
                </div>
                <div className="cb" style={{ marginTop:4 }}><div className="cf" style={{ width:`${Math.min(pick.prob,100)}%`,background:probColor }}/></div>
              </div>
              <span style={{ fontSize:12,fontWeight:800,color:probColor,alignSelf:"center" }}>{Math.round(pick.prob)}%</span>
              <span style={{ fontSize:10,color:C.text,alignSelf:"center" }}>{pick.odds || "—"}</span>
              {hasResults && (
                <div style={{ alignSelf:"center" }}>
                  {f.hGoals != null ? <ResultBadge f={f} /> : <span style={{ fontSize:9,color:C.text }}>—</span>}
                </div>
              )}
            </div>
          );
        })}
        {rows.length === 0 && (
          <div style={{ textAlign:"center",padding:"40px 0",color:C.text,opacity:.3,fontSize:11,textTransform:"uppercase",letterSpacing:".15em" }}>No matches</div>
        )}
      </div>

      {/* Selection banner */}
      {selectedIds.size > 0 && (
        <div style={{ position:"fixed",bottom:20,left:"50%",transform:"translateX(-50%)",zIndex:999,background:C.edge,borderRadius:12,padding:"10px 20px",display:"flex",alignItems:"center",gap:14,boxShadow:"0 4px 24px rgba(0,0,0,0.5)" }}>
          <span style={{ fontSize:10,fontWeight:800,color:C.accentText }}>{selectedIds.size} selected</span>
          <button onClick={() => {
            const familyLabel = CUSTOM_FAMILIES.find(cf => cf.id === family)?.label || family;
            const legs = rows.filter(({ f }) => selectedIds.has(f.id)).map(({ f, pick }) => ({
              fixtureId: f.id, game:`${f.teams.home} vs ${f.teams.away}`,
              league: f.league || "",
              pick:pick.label, market:pick.market && pick.market !== "Unknown" ? pick.market : inferMarket(pick.label),
              odds:pick.odds || null, conf:Math.round(pick.prob),
              strategyLabel: familyLabel,
            }));
            const prod = legs.reduce((s, l) => parseFloat((s * (parseFloat(l.odds) || 1)).toFixed(4)), 1.0);
            if (onAddToTicket) onAddToTicket({ id:Date.now(), legs, totalOdds:prod.toFixed(2), stake:0, exhausted:false, source:"custom_selection", family });
            clearSelection();
          }} style={{ background:"#fff",color:C.edge,border:"none",borderRadius:8,padding:"6px 16px",fontSize:11,fontWeight:900,cursor:"pointer" }}>
            Add to Ticket ({selectedIds.size} legs)
          </button>
          <button onClick={clearSelection} style={{ background:"none",border:"none",color:C.text,cursor:"pointer",fontSize:13,padding:0 }}>✕</button>
        </div>
      )}
    </div>
  );
}

// ── UPLOAD BACKTESTER ─────────────────────────────────────────────────────
// Mode A: Paste/type a GRM ticket code (e.g. T1A2B3) to reload and evaluate
// Mode B: Upload a custom list JSON file (for CustomListView exports)
function UploadBacktester() {
  const isMobile = useIsMobile();
  const [mode, setMode]         = useState("code"); // "code" | "json"
  const [ticketCode, setTicketCode] = useState("");
  const [dragging,setDragging]  = useState(false);
  const [uploading,setUploading]= useState(false);
  const [result,setResult]      = useState(null);
  const [error,setError]        = useState(null);
  const fileRef = useRef(null);

  const savedTickets = loadSavedTickets();

  const evaluateTicket = async (payload) => {
    setError(null); setResult(null); setUploading(true);
    try {
      if (!payload.date) throw new Error("Ticket has no date field.");
      if (!Array.isArray(payload.legs) && !Array.isArray(payload.rows)) throw new Error("Unrecognised format.");
      const res = await fetch(`${SERVER}/api/backtest-upload`, { method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify(payload) });
      const t = await res.text(); let data;
      try { data = JSON.parse(t); } catch { throw new Error(`Server error: ${t.slice(0,200)}`); }
      if (!res.ok) throw new Error(data.error || res.statusText);
      setResult(data);
    } catch(e) { setError(friendlyError(e, "Backtest")); }
    setUploading(false);
  };

  const handleCodeEval = () => {
    const code = ticketCode.trim().toUpperCase();
    if (!code) { setError("Enter a ticket code first."); return; }
    const found = savedTickets.find(t => (t.code||"").toUpperCase() === code);
    if (!found) { setError(`Ticket code "${code}" not found in saved tickets. Check Ticket › Saved.`); return; }
    evaluateTicket(found);
  };

  const processFile = async file => {
    setError(null); setResult(null); setUploading(true);
    try {
      const text = await file.text(), payload = JSON.parse(text);
      await evaluateTicket(payload);
    } catch(e) { setError(friendlyError(e, "Backtest")); setUploading(false); }
  };

  const onDrop = e => { e.preventDefault(); setDragging(false); const f=e.dataTransfer.files?.[0]; if(f) processFile(f); };
  const resColor = r => r==="WIN"?C.green:r==="LOSS"?C.red:r==="VOID"?C.muted:C.faint;

  return (
    <div>
      <div style={{ fontSize:9,color:C.radar,fontWeight:800,textTransform:"uppercase",letterSpacing:".15em",marginBottom:14 }}>📂 Backtest Evaluator</div>

      {/* Mode toggle */}
      <div style={{ display:"flex",gap:6,marginBottom:14 }}>
        {[["code","Ticket Code"],["json","JSON Upload"]].map(([id,label]) => (
          <button key={id} onClick={() => { setMode(id); setResult(null); setError(null); }} className="gb"
            style={{ padding:"5px 14px",fontSize:9,background:mode===id?C.radar:"transparent",color:mode===id?C.accentText:C.muted,border:`1px solid ${mode===id?C.radar:C.faint}` }}>
            {label}
          </button>
        ))}
      </div>

      {/* Mode A: Paste ticket code */}
      {mode === "code" && (
        <div>
          <div style={{ fontSize:9,color:C.text,marginBottom:10,lineHeight:1.6 }}>
            Enter the <span style={{ color:C.gold }}>GRM ticket code</span> (e.g. <code style={{ color:C.radar }}>T1AB2C</code>) from your saved tickets to evaluate it against actual results.
          </div>
          <div style={{ display:"flex",gap:8,marginBottom:10 }}>
            <input
              type="text" value={ticketCode}
              onChange={e => setTicketCode(e.target.value.toUpperCase())}
              onKeyDown={e => e.key === "Enter" && handleCodeEval()}
              placeholder="e.g. T1AB2C"
              className="gi"
              style={{ flex:1,fontSize:15,fontWeight:800,letterSpacing:".2em",textAlign:"center",color:C.radar }}
            />
            <button onClick={handleCodeEval} disabled={uploading||!ticketCode.trim()} className="gb"
              style={{ background:uploading||!ticketCode.trim()?C.faint:C.radar,color:uploading||!ticketCode.trim()?C.muted:C.accentText,padding:"8px 20px",fontSize:11,fontWeight:800 }}>
              {uploading ? <span className="pu">…</span> : "Evaluate"}
            </button>
          </div>
          {savedTickets.length > 0 && (
            <div style={{ fontSize:8,color:C.text,marginBottom:8 }}>
              Saved codes: {savedTickets.slice(-6).map(t => (
                <button key={t.code} onClick={() => setTicketCode(t.code)} className="gb"
                  style={{ fontSize:8,padding:"1px 7px",background:"transparent",border:`1px solid ${C.faint}`,color:C.text,marginLeft:4,marginBottom:3 }}>
                  {t.code}
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Mode B: JSON upload (custom list only) */}
      {mode === "json" && (
        <div>
          <div style={{ fontSize:9,color:C.text,marginBottom:10,lineHeight:1.6 }}>
            Upload a <span style={{ color:C.radar }}>custom list JSON</span> (from Custom List › Save JSON) to evaluate against results.
          </div>
          <div className={`drop-zone${dragging?" drag-over":""}`} onClick={() => fileRef.current?.click()}
            onDragOver={e=>{e.preventDefault();setDragging(true);}} onDragLeave={()=>setDragging(false)} onDrop={onDrop}
            style={{ marginBottom:16 }}>
            <input ref={fileRef} type="file" accept=".json" style={{ display:"none" }} onChange={e=>{const f=e.target.files?.[0];if(f)processFile(f);}}/>
            {uploading ? <span className="pu" style={{ fontSize:11,color:C.radar }}>Evaluating…</span>
              : <span style={{ fontSize:11,color:C.text }}>Drop JSON here or <span style={{ color:C.radar }}>click to upload</span></span>}
          </div>
        </div>
      )}

      {error && <div style={{ marginBottom:14,color:C.red,fontSize:11,background:`${C.red}10`,border:`1px solid ${C.red}30`,borderRadius:8,padding:"10px 14px" }}>✕ {error}</div>}
      {result && (
        <div style={{ display:"flex",flexDirection:"column",gap:14 }}>
          {result.format === "ticket" && (
            <>
              <div style={{ background:result.parlayResult==="WIN"?C.greenDim:result.parlayResult==="LOSS"?`${C.red}10`:C.surface,border:`1px solid ${resColor(result.parlayResult)}30`,borderRadius:10,padding:"14px 18px",display:"flex",justifyContent:"space-between",alignItems:"center" }}>
                <div>
                  <div style={{ fontSize:8,color:C.text,textTransform:"uppercase",letterSpacing:".12em",marginBottom:4 }}>{result.date}</div>
                  <div style={{ fontSize:22,fontWeight:800,color:resColor(result.parlayResult) }}>{result.parlayResult}</div>
                  <div style={{ fontSize:9,color:C.text,marginTop:4 }}>
                    {result.summary.wins}W / {result.summary.losses}L / {result.summary.voids} void
                    {result.summary.legWinRate != null && <span style={{ color:C.radar,marginLeft:8 }}>{result.summary.legWinRate}% leg hit rate</span>}
                  </div>
                </div>
                {result.totalOdds && <div style={{ fontSize:18,fontWeight:800,color:C.gold }}>×{result.totalOdds}</div>}
              </div>
              <div className="gc" style={{ overflow:"hidden" }}>
                <div style={{ padding:"10px 14px",borderBottom:`1px solid ${C.border}`,fontSize:8,color:C.text,textTransform:"uppercase",letterSpacing:".1em",fontWeight:700 }}>Leg Results</div>
                {result.legs.map((leg, i) => {
                  const legCols = isMobile ? "1fr 72px 44px" : "1fr 120px 70px 70px 60px";
                  return (
                    <div key={i} style={{ display:"grid",gridTemplateColumns:legCols,gap:8,padding:"9px 14px",borderBottom:`1px solid ${C.faint}`,alignItems:"center",fontSize:10 }}>
                      <div>
                        <div style={{ fontWeight:600,color:C.text }}>{leg.game}</div>
                        {leg.league&&<div style={{ fontSize:7,color:C.text }}>{leg.league}</div>}
                        {isMobile && <div style={{ fontSize:8,color:C.text,marginTop:1 }}>{leg.score||""}{leg.odds ? ` · ×${leg.odds}` : ""}</div>}
                      </div>
                      <div style={{ color:mktStyle(leg.market).color||C.muted,fontSize:9,fontWeight:700 }}>{leg.pick}</div>
                      {!isMobile && <div style={{ color:C.text,fontSize:9 }}>{leg.score||"—"}</div>}
                      {!isMobile && <div style={{ fontSize:9,color:C.text }}>{leg.odds?`×${leg.odds}`:"—"}</div>}
                      <div style={{ fontWeight:800,color:resColor(leg.result),textAlign:isMobile?"right":"left" }}>{leg.result}</div>
                    </div>
                  );
                })}
              </div>
            </>
          )}
          {result.format === "custom_list" && (
            <>
              {result.stats?.overall && (
                <div className="gc" style={{ padding:"12px 14px" }}>
                  <div style={{ fontSize:8,color:C.text,textTransform:"uppercase",letterSpacing:".1em",marginBottom:6 }}>Overall</div>
                  <div style={{ fontSize:22,fontWeight:800,color:result.stats.overall.rate>=55?C.green:result.stats.overall.rate>=45?C.gold:C.red }}>{result.stats.overall.rate}%</div>
                  <div style={{ fontSize:9,color:C.text,marginTop:3 }}>{result.stats.overall.wins}W / {result.stats.overall.total} played</div>
                </div>
              )}
              <div className="gc" style={{ overflow:"hidden" }}>
                <div style={{ display:"grid",gridTemplateColumns:isMobile?"1fr 70px 44px":"1fr 160px 70px 60px",gap:8,padding:"10px 14px",borderBottom:`1px solid ${C.border}`,fontSize:8,color:C.text,textTransform:"uppercase",letterSpacing:".1em",fontWeight:700 }}>
                  <span>Match</span><span>Pick</span>{!isMobile&&<span>Score</span>}<span>Result</span>
                </div>
                <div style={{ maxHeight:480,overflowY:"auto" }}>
                  {result.rows.map((row, i) => (
                    <div key={i} style={{ display:"grid",gridTemplateColumns:isMobile?"1fr 70px 44px":"1fr 160px 70px 60px",gap:8,padding:"8px 14px",borderBottom:`1px solid ${C.faint}`,fontSize:10,alignItems:"center" }}>
                      <div>
                        <div style={{ fontWeight:600,color:C.text }}>{row.home} vs {row.away}</div>
                        <div style={{ fontSize:8,color:C.text }}>{row.league||""}</div>
                        {isMobile && row.score && <div style={{ fontSize:8,color:C.text }}>{row.score}</div>}
                        {row.strategyTags?.length>0 && <div style={{ fontSize:7,color:C.amber,marginTop:1 }}>{row.strategyTags.map(t=>STRATEGY_LABELS[t]||t).join(" · ")}</div>}
                      </div>
                      <div style={{ fontSize:9,color:C.gold,fontWeight:700 }}>{row.pick}</div>
                      {!isMobile && <div style={{ color:C.text }}>{row.score||"—"}</div>}
                      <div style={{ fontWeight:800,color:resColor(row.result),textAlign:isMobile?"right":"left" }}>{row.result}</div>
                    </div>
                  ))}
                </div>
              </div>
            </>
          )}
          <button onClick={() => { setResult(null); setError(null); setTicketCode(""); if(fileRef.current) fileRef.current.value=""; }} className="gb"
            style={{ alignSelf:"flex-start",padding:"6px 16px",background:"transparent",border:`1px solid ${C.faint}`,color:C.text,fontSize:10 }}>
            ↺ Evaluate Another
          </button>
        </div>
      )}
    </div>
  );
}

// ── BACKTEST TAB ──────────────────────────────────────────────────────────
// Collapsible snapshot group — one per calendar month
function SnapshotGroup({ month, items, adminMode, fetching, onLoad, onFetch, C }) {
  const [open, setOpen] = useState(false);
  const label = new Date(month + "-01").toLocaleDateString([], { month:"long", year:"numeric" });
  const hasResults = items.filter(s => s.hasResults).length;
  return (
    <div style={{ marginBottom:6 }}>
      <button onClick={() => setOpen(o => !o)} className="gb"
        style={{
          width:"100%",display:"flex",alignItems:"center",justifyContent:"space-between",
          padding:"11px 14px",background:"var(--surface)",
          border:"1px solid var(--glass-border)",
          borderRadius:open?"var(--r-lg) var(--r-lg) 0 0":"var(--r-lg)",
          cursor:"pointer",transition:"all .18s",textTransform:"none",letterSpacing:0,
        }}>
        <div style={{ display:"flex",alignItems:"center",gap:8 }}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="var(--gold)" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/>
          </svg>
          <span style={{ fontSize:11,fontWeight:800,color:"var(--text)" }}>{label}</span>
          <span style={{ fontSize:9,color:"var(--muted)" }}>{items.length} snapshot{items.length!==1?"s":""}</span>
          {hasResults > 0 && (
            <span style={{ fontSize:9,color:"var(--green)",fontWeight:700 }}>· {hasResults} with results</span>
          )}
        </div>
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--muted)" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"
          style={{ transform:open?"rotate(180deg)":"none",transition:"transform .2s",flexShrink:0 }}>
          <polyline points="6 9 12 15 18 9"/>
        </svg>
      </button>

      {open && (
        <div style={{ border:"1px solid var(--glass-border)",borderTop:"none",borderRadius:"0 0 var(--r-lg) var(--r-lg)",overflow:"hidden" }}>
          {items.sort((a,b) => b.date.localeCompare(a.date)).map((s,i) => (
            <div key={s.date} style={{
              display:"flex",alignItems:"center",justifyContent:"space-between",
              padding:"10px 14px",
              background: i%2===0 ? "var(--surface)" : "var(--bg)",
              borderTop: i===0 ? "none" : "1px solid var(--glass-border)",
            }}>
              <button onClick={() => onLoad(s.date)}
                style={{ background:"none",border:"none",cursor:"pointer",fontSize:11,
                         color:"var(--accent)",fontFamily:"var(--font)",padding:0,fontWeight:700 }}>
                {s.date}
              </button>
              {s.hasResults
                ? <span style={{ fontSize:9,color:"var(--green)",fontWeight:700,display:"flex",alignItems:"center",gap:4 }}>
                    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
                    Results
                  </span>
                : adminMode
                  ? <button onClick={() => onFetch(s.date)} disabled={fetching===s.date}
                      className="gb-primary"
                      style={{ fontSize:9,padding:"3px 12px" }}>
                      {fetching===s.date ? <span className="pu">…</span> : "Fetch"}
                    </button>
                  : <span style={{ fontSize:9,color:"var(--muted)" }}>No results</span>
              }
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function BacktestTab({ loadSnapshot, adminMode, adminToken = "", onReloadFixtures }) {
  const isMobile = useIsMobile();
  const [from,setFrom]=useState(()=>{const d=new Date();d.setDate(d.getDate()-7);return d.toISOString().split("T")[0];});
  const [to,setTo]=useState(todayStr()), [snapshots,setSnapshots]=useState([]);
  const [btData,setBtData]=useState(null), [loading,setLoading]=useState(false);
  const [fetching,setFetching]=useState(null), [error,setError]=useState(null);
  const [saveLabel,setSaveLabel]=useState(""), [saving,setSaving]=useState(false);
  const [savedReports,setSavedReports]=useState([]), [savedMsg,setSavedMsg]=useState(null);

  useEffect(() => {
    fetch(`${SERVER}/api/snapshots`).then(r=>r.json()).then(d=>setSnapshots(d.snapshots||[])).catch(()=>{});
    loadReportsList();
  }, []);

  const loadReportsList = () => fetch(`${SERVER}/api/backtests`).then(r=>r.json()).then(d=>setSavedReports(d.backtests||[])).catch(()=>{});

  const fetchResults = async date => {
    setFetching(date);
    try {
      await fetch(`${SERVER}/api/fetch-results?date=${date}`, { headers:{"x-admin-token": adminToken} });
      // Refresh snapshot list
      const d = await fetch(`${SERVER}/api/snapshots`).then(r=>r.json());
      setSnapshots(d.snapshots||[]);
      // If this is the currently loaded date, auto-reload fixtures with injected results
      if (onReloadFixtures) await onReloadFixtures(date);
    } catch {}
    setFetching(null);
  };

  const runBacktest = async () => {
    setLoading(true); setError(null); setBtData(null); setSavedMsg(null);
    try {
      const res = await fetch(`${SERVER}/api/backtest?from=${from}&to=${to}&matches=1`);
      const text = await res.text(); let data;
      try { data = JSON.parse(text); } catch { throw new Error(`Server returned non-JSON.\n${text.slice(0,120)}`); }
      if (!res.ok) throw new Error(data?.error || res.statusText);
    } catch(e) { setError(friendlyError(e, "Backtest")); }
    setLoading(false);
  };

  const saveReport = async () => {
    if (!btData?.stats) return; setSaving(true); setSavedMsg(null);
    try {
      const res = await fetch(`${SERVER}/api/save-backtest`, { method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify({ from, to, label:saveLabel.trim()||null, stats:btData.stats }) });
      const text = await res.text(); let d;
      try { d = JSON.parse(text); } catch { throw new Error(`Save failed: ${text.slice(0,120)}`); }
      if (d.saved) { setSavedMsg(`✓ Saved as ${d.filename}`); loadReportsList(); } else throw new Error(d.error||"Unknown save error");
    } catch(e) { setSavedMsg(`✕ ${e.message}`); }
    setSaving(false);
  };

  const deleteReport = async filename => {
    try { await fetch(`${SERVER}/api/backtests/${filename}`, { method:"DELETE", headers:{"x-admin-token": adminToken} }); loadReportsList(); } catch {}
  };

  const resColor = r => r==="WIN"?C.green:r==="LOSS"?C.red:C.muted;

  return (
    <div style={{ maxWidth:1480,margin:"0 auto",padding:isMobile?"16px 12px":"28px 24px" }}>
      {/* Desktop notice */}
      <div style={{ display:"flex",alignItems:"center",gap:6,background:C.radarDim,border:`1px solid ${C.radarBorder}`,borderRadius:7,padding:"6px 12px",marginBottom:20,fontSize:8,color:C.radar,fontWeight:700,letterSpacing:".06em" }}>
        🖥️ Best experienced in desktop site mode — charts, match tables and date ranges are easier to navigate on a wider screen.
      </div>
      {/* Snapshots — collapsible accordion grouped by month */}
      <div className="gc" style={{ padding:"18px",marginBottom:20 }}>
        <div style={{ fontSize:9,color:C.gold,fontWeight:800,textTransform:"uppercase",letterSpacing:".15em",marginBottom:14 }}>Saved Snapshots</div>
        {!snapshots.length && <div style={{ fontSize:11,color:C.text,opacity:.3 }}>No snapshots yet — fetch a date to create one.</div>}
        {snapshots.length > 0 && (() => {
          // Group by YYYY-MM
          const groups = {};
          snapshots.forEach(s => {
            const month = s.date.slice(0,7);
            if (!groups[month]) groups[month] = [];
            groups[month].push(s);
          });
          return Object.entries(groups).sort((a,b) => b[0].localeCompare(a[0])).map(([month, items]) => (
            <SnapshotGroup key={month} month={month} items={items}
              adminMode={adminMode} fetching={fetching}
              onLoad={loadSnapshot} onFetch={fetchResults} C={C} />
          ));
        })()}
      </div>

      {/* Run backtest */}
      <div className="gc" style={{ padding:"18px",marginBottom:20 }}>
        <div style={{ fontSize:9,color:C.gold,fontWeight:800,textTransform:"uppercase",letterSpacing:".15em",marginBottom:14 }}>◆ Run Backtest</div>
        <div style={{ display:"flex",gap:12,alignItems:"flex-end",flexWrap:"wrap" }}>
          <div><div style={{ fontSize:9,color:C.text,marginBottom:5 }}>From</div><input type="date" value={from} onChange={e=>setFrom(e.target.value)} className="gi" style={{ width:150 }}/></div>
          <div><div style={{ fontSize:9,color:C.text,marginBottom:5 }}>To</div><input type="date" value={to} onChange={e=>setTo(e.target.value)} className="gi" style={{ width:150 }}/></div>
          <button onClick={runBacktest} disabled={loading} className="gb" style={{ background:loading?C.faint:C.gold,color:loading?C.muted:C.accentText,padding:"8px 20px" }}>{loading?<span className="pu">RUNNING…</span>:"RUN"}</button>
        </div>
        {error && <div style={{ marginTop:12,color:C.red,fontSize:11,background:C.redDim,border:`1px solid ${C.red}30`,borderRadius:7,padding:"8px 12px",whiteSpace:"pre-wrap" }}>✕ {error}</div>}
      </div>

      {/* Save report */}
      {btData?.stats && (
        <div className="gc" style={{ padding:"16px",marginBottom:20,border:`1px solid ${C.radar}30` }}>
          <div style={{ fontSize:9,color:C.radar,fontWeight:800,textTransform:"uppercase",letterSpacing:".15em",marginBottom:12,display:"flex",alignItems:"center",gap:5 }}>
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg>
            Save Report
          </div>
          <div style={{ display:"flex",gap:10,alignItems:"flex-end",flexWrap:"wrap" }}>
            <div style={{ flex:1 }}>
              <div style={{ fontSize:9,color:C.text,marginBottom:5 }}>Label (optional)</div>
              <input type="text" value={saveLabel} onChange={e=>setSaveLabel(e.target.value)} placeholder={`${from} → ${to} backtest`} className="gi"/>
            </div>
            <button onClick={saveReport} disabled={saving} className="gb" style={{ background:saving?C.faint:C.radar,color:saving?C.muted:C.accentText,padding:"8px 18px",flexShrink:0 }}>{saving?<span className="pu">SAVING…</span>:"SAVE"}</button>
          </div>
          {savedMsg && <div style={{ marginTop:8,fontSize:9,color:savedMsg.startsWith("✓")?C.green:C.red }}>{savedMsg}</div>}
        </div>
      )}

      {/* Saved reports list */}
      {savedReports.length > 0 && (
        <div className="gc" style={{ padding:"16px",marginBottom:20 }}>
          <div style={{ fontSize:9,color:C.text,fontWeight:800,textTransform:"uppercase",letterSpacing:".15em",marginBottom:12 }}>📂 Saved Reports</div>
          <div style={{ display:"flex",flexDirection:"column",gap:6 }}>
            {savedReports.map(r => (
              <div key={r.filename} style={{ display:"flex",justifyContent:"space-between",alignItems:"center",background:C.surface,border:`1px solid ${C.border}`,borderRadius:8,padding:"8px 12px" }}>
                <div>
                  <div style={{ fontSize:10,color:C.text,fontWeight:700 }}>{r.label||`${r.from} → ${r.to}`}</div>
                  <div style={{ fontSize:8,color:C.text,marginTop:2 }}>
                    {r.from} → {r.to}
                    {r.overall && <span style={{ marginLeft:8,color:r.overall.rate>=55?C.green:r.overall.rate>=45?C.gold:C.red,fontWeight:700 }}>{r.overall.rate}% ({r.overall.wins}W/{r.overall.total})</span>}
                  </div>
                  <div style={{ fontSize:7,color:C.text,marginTop:1 }}>{new Date(r.savedAt).toLocaleString()}</div>
                </div>
                {adminMode && <button onClick={()=>deleteReport(r.filename)} className="gb" style={{ background:"transparent",border:`1px solid ${C.red}40`,color:C.red,padding:"3px 8px",fontSize:9 }}>✕</button>}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Backtest stats */}
      {btData?.stats && (
        <>
          {btData.stats.byPickType && (
            <div className="gc" style={{ padding:"16px",marginBottom:16 }}>
              <div style={{ fontSize:9,color:C.radar,fontWeight:800,textTransform:"uppercase",letterSpacing:".12em",marginBottom:12 }}>◆ By Pick Type</div>
              <div style={{ display:"flex",gap:12 }}>
                {[["The Read", btData.stats.byPickType.read || btData.stats.byPickType.safeBet],
                  ["The Edge", btData.stats.byPickType.edge || btData.stats.byPickType.valuePick]].map(([label, stat]) => stat && (
                  <div key={label} className="gc" style={{ flex:1,padding:"14px 16px" }}>
                    <div style={{ fontSize:8,color:C.text,textTransform:"uppercase",letterSpacing:".1em",marginBottom:8 }}>{label}</div>
                    <div style={{ fontSize:24,fontWeight:800,color:stat.rate>=55?C.green:stat.rate>=45?C.gold:C.red }}>{stat.rate}%</div>
                    <div style={{ fontSize:9,color:C.text,marginTop:4 }}>{stat.wins}W / {stat.total} played</div>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div style={{ display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(160px,1fr))",gap:12,marginBottom:20 }}>
            {[["Overall", btData.stats.overall]].filter(([,s])=>s).map(([label, stat]) => (
              <div key={label} className="gc" style={{ padding:"14px 16px" }}>
                <div style={{ fontSize:8,color:C.text,textTransform:"uppercase",letterSpacing:".1em",marginBottom:8 }}>{label}</div>
                <div style={{ fontSize:24,fontWeight:800,color:stat.rate>=55?C.green:stat.rate>=45?C.gold:C.red }}>{stat.rate}%</div>
                <div style={{ fontSize:9,color:C.text,marginTop:4 }}>{stat.wins}W / {stat.total} played</div>
              </div>
            ))}
          </div>

          {btData.stats.byStrategy && Object.keys(btData.stats.byStrategy).length > 0 && (
            <div className="gc" style={{ padding:"16px",marginBottom:20 }}>
              <div style={{ fontSize:9,color:C.amber,fontWeight:800,textTransform:"uppercase",letterSpacing:".12em",marginBottom:12 }}>◈ By Strategy</div>
              <div style={{ display:"flex",flexWrap:"wrap",gap:8 }}>
                {Object.entries(btData.stats.byStrategy).map(([strat, stat]) => stat && (
                  <div key={strat} style={{ background:C.surface,border:`1px solid ${C.amber}30`,borderRadius:8,padding:"8px 12px",minWidth:130 }}>
                    <div style={{ fontSize:8,color:C.amber,marginBottom:4 }}>{STRATEGY_LABELS[strat]||strat}</div>
                    <div style={{ fontSize:16,fontWeight:800,color:stat.rate>=55?C.green:stat.rate>=45?C.gold:C.red }}>{stat.rate}%</div>
                    <div style={{ fontSize:8,color:C.text }}>{stat.wins}/{stat.total}</div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {btData.stats.byLeague && Object.keys(btData.stats.byLeague).length > 0 && (
            <div className="gc" style={{ padding:"16px",marginBottom:20 }}>
              <div style={{ fontSize:9,color:C.radar,fontWeight:800,textTransform:"uppercase",letterSpacing:".12em",marginBottom:12,display:"flex",alignItems:"center",gap:5 }}>
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>
                By League
              </div>
              <div style={{ display:"flex",flexWrap:"wrap",gap:8,maxHeight:240,overflowY:"auto" }}>
                {Object.entries(btData.stats.byLeague).sort((a,b)=>(b[1]?.rate||0)-(a[1]?.rate||0)).map(([lg, stat]) => stat && (
                  <div key={lg} style={{ background:C.surface,border:`1px solid ${C.radar}20`,borderRadius:8,padding:"8px 12px",minWidth:130 }}>
                    <div style={{ fontSize:7,color:C.text,marginBottom:4,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap" }}>{lg}</div>
                    <div style={{ fontSize:14,fontWeight:800,color:stat.rate>=55?C.green:stat.rate>=45?C.gold:C.red }}>{stat.rate}%</div>
                    <div style={{ fontSize:7,color:C.text }}>{stat.wins}/{stat.total}</div>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="gc" style={{ padding:"16px",marginBottom:20 }}>
            <div style={{ fontSize:9,color:C.text,textTransform:"uppercase",letterSpacing:".12em",fontWeight:700,marginBottom:12 }}>By Market</div>
            <div style={{ display:"flex",flexWrap:"wrap",gap:8 }}>
              {Object.entries(btData.stats.byMarket||{}).map(([mkt, stat]) => stat && (
                <div key={mkt} style={{ background:C.surface,border:`1px solid ${C.border}`,borderRadius:8,padding:"8px 12px",minWidth:120 }}>
                  <div style={{ fontSize:8,color:C.text,marginBottom:4 }}>{mkt}</div>
                  <div style={{ fontSize:16,fontWeight:800,color:stat.rate>=55?C.green:stat.rate>=45?C.gold:C.red }}>{stat.rate}%</div>
                  <div style={{ fontSize:8,color:C.text }}>{stat.wins}/{stat.total}</div>
                </div>
              ))}
            </div>
          </div>

          {btData.matches && (
            <div className="gc" style={{ overflow:"hidden" }}>
              <div style={{ display:"grid",gridTemplateColumns:isMobile?"1fr 72px 40px 40px":"1fr 110px 80px 55px 55px",gap:8,padding:"10px 16px",borderBottom:`1px solid ${C.border}`,fontSize:8,color:C.text,textTransform:"uppercase",letterSpacing:".1em",fontWeight:700 }}>
                <span>Match</span><span>{isMobile?"Pick":"The Read"}</span>{!isMobile&&<span>Score</span>}<span>Read</span><span>Edge</span>
              </div>
              <div style={{ maxHeight:500,overflowY:"auto" }}>
                {btData.matches.map((r, i) => (
                  <div key={i} style={{ display:"grid",gridTemplateColumns:isMobile?"1fr 72px 40px 40px":"1fr 110px 80px 55px 55px",gap:8,padding:"8px 16px",borderBottom:`1px solid ${C.faint}`,fontSize:10,alignItems:"center" }}>
                    <div>
                      <div style={{ color:C.text,fontWeight:600 }}>{r.teams.home} vs {r.teams.away}</div>
                      <div style={{ fontSize:8,color:C.text }}>{r.league}</div>
                      {isMobile && r.hGoals != null && <div style={{ fontSize:8,color:C.text }}>{r.hGoals} – {r.aGoals}</div>}
                      {r.strategyTags?.length>0 && <div style={{ fontSize:7,color:C.amber,marginTop:1 }}>{r.strategyTags.map(t=>STRATEGY_LABELS[t]||t).join(" · ")}</div>}
                    </div>
                    <div style={{ color:mktStyle(r.theRead?.anchor?.market||r.safeBet?.market).color||C.muted,fontSize:9,fontWeight:700,lineHeight:1.4 }}>
                      {r.theRead?.anchor?.pick||r.safeBet?.pick||"—"}
                    </div>
                    {!isMobile && <div style={{ color:C.text }}>
                      {r.hGoals != null ? `${r.hGoals} – ${r.aGoals}` : "—"}
                    </div>}
                    <div style={{ fontWeight:800,color:resColor(r.readResult||r.safeBetResult||r.result),fontSize:11 }}>
                      {r.readResult||r.safeBetResult||r.result}
                    </div>
                    <div style={{ fontWeight:800,color:resColor(r.edgeResult||r.valuePickResult),fontSize:10 }}>
                      {r.edgeResult||r.valuePickResult||"—"}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      )}
      {btData && !btData.stats && (
        <div style={{ textAlign:"center",padding:"40px",color:C.text,fontSize:11 }}>
          {btData.message || "No results found in range"}
        </div>
      )}

      <div className="gc" style={{ padding:"18px",marginTop:20,border:`1px solid ${C.radar}20` }}>
        <UploadBacktester />
      </div>
    </div>
  );
}

// ── TICKET CARD ───────────────────────────────────────────────────────────
// ── TICKET BOOK NOW BUTTON ────────────────────────────────────────────────
// N2-FIX: BOOKMAKERS — LL is discontinued/paused. Marked disabled with downtime subtext.
// Duel added (sptpub engine, /api/book-duel now registered in server.js).
// disabled:true  → shown in picker, unselectable (greyed + subtext shown below label)
const BOOKMAKERS = [
  { id:"sportybet",   label:"SportyBet NG",  api:"/api/book-sportybet",   link: code => `https://www.sportybet.com/ng/?shareCode=${code}`,       appLink: code => `sportybet://share?shareCode=${code}` },
  { id:"duel",        label:"Duel",           api:"/api/book-duel",        link: code => `https://duel.com/sports?bt-path=%2F%3FbtBookingCode%3D${code}`,         appLink: code => `duel://betslip?btBookingCode=${code}` },
  { id:"luckyledger", label:"Lucky's Ledger", api:"/api/book-luckyledger", link: code => `https://luckysledger.com/sports?btBookingCode=${code}`, appLink: code => `luckysledger://betslip?btBookingCode=${code}`, disabled: true, disabledText: "Experiencing downtime" },
];

function TicketBookNowButton({ legs }) {
  const [open, setOpen]         = useState(false);
  const [bookie, setBookie]     = useState("");
  const [booking, setBooking]   = useState(false);
  const [error, setError]       = useState(null);
  // N27-FIX: auto-open if a persisted result exists from a previous mount
  useEffect(() => {
    try { const s = sessionStorage.getItem("grm_book_result_" + (legs || []).map(l => (l.game||"") + (l.pick||"")).join("|").slice(0, 80)); if (s) setOpen(true); } catch {}
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const [copied, setCopied]     = useState(false);
  const [sharedOk, setSharedOk] = useState(false);

  // N27-FIX: persist booking result across panel remounts via sessionStorage
  const resultKey = "grm_book_result_" + (legs || []).map(l => (l.game||"") + (l.pick||"")).join("|").slice(0, 80);
  const [result, setResultState] = useState(() => {
    try { const s = sessionStorage.getItem(resultKey); return s ? JSON.parse(s) : null; } catch { return null; }
  });
  const setResult = (val) => {
    setResultState(val);
    try { val ? sessionStorage.setItem(resultKey, JSON.stringify(val)) : sessionStorage.removeItem(resultKey); } catch {}
  };

  const buildLegs = () => (legs || []).map(leg => {
    const home = leg.home || (leg.game || "").split(" vs ")[0]?.trim() || "";
    const away = leg.away || (leg.game || "").split(" vs ")[1]?.trim() || "";
    let mkt = leg.market || "";
    if (!mkt || mkt === "Unknown") mkt = inferMarket(leg.pick || "");
    if (mkt.startsWith("TeamTotal")) mkt = "TeamTotal";
    return { home, away, market: mkt, pick: leg.pick || "" };
  }).filter(l => l.home && l.away && l.pick && l.market !== "Unknown");

  const selectedBookie = BOOKMAKERS.find(b => b.id === bookie) || null;
  const cr = C.cardRadius || 16;
  const br = C.btnRadius  || 12;

  const book = async () => {
    const sl = buildLegs();
    if (!sl.length) { setError("No valid legs to book"); return; }
    setBooking(true); setResult(null); setError(null);
    try {
      const res  = await fetch(`${SERVER}${selectedBookie.api}`, {
        method:"POST", headers:{"Content-Type":"application/json"},
        body: JSON.stringify({ legs: sl }),
      });
      const data = await res.json();
      if (!res.ok || data.error) throw new Error(data.error || "Booking failed");
      setResult({ ...data, bookieId: bookie });
    } catch(e) {
      const msg = e.message || "";
      setError(
        msg.includes("ERR_NAME_NOT_RESOLVED") || msg.includes("Failed to fetch") || msg.includes("net::ERR")
          ? "Can't reach bookmaker — check your connection and try again."
          : msg || "Booking failed — please try again."
      );
    }
    finally { setBooking(false); }
  };

  const copyCode = () => {
    if (!result?.code) return;
    copyToClipboard(result.code, () => {
      setCopied(true); setTimeout(() => setCopied(false), 2000);
    });
  };

  const shareTicket = () => {
    if (!result?.code) return;
    const bm = BOOKMAKERS.find(b => b.id === result.bookieId);
    const link = bm?.link ? bm.link(result.code) : result.code;
    copyToClipboard(link, () => {
      setSharedOk(true); setTimeout(() => setSharedOk(false), 2000);
    });
  };

  // N2-FIX: openInApp — fire the bookmaker deep-link scheme (sportybet:// / luckysledger://)
  // ONLY when the user explicitly taps "Open in App". Previous code used bm?.link (web URL)
  // instead of bm?.appLink — so it never opened the app AND triggered Android's chooser.
  // We fire via a hidden <a> click rather than window.open(_blank) — the latter triggers
  // Android's "which app?" permission prompt even for web URLs. If the app is not installed,
  // the scheme silently fails; no broken tab, no dialog.
  const openInApp = () => {
    if (!result?.code) return;
    const bm = BOOKMAKERS.find(b => b.id === result.bookieId);
    const deepLink = bm?.appLink ? bm.appLink(result.code) : null;
    if (!deepLink) return;
    try {
      const a = document.createElement("a");
      a.href = deepLink;
      a.style.display = "none";
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
    } catch {
      // Scheme not supported — fail silently, no broken state
    }
  };

  const reset = () => { setResult(null); setError(null); };
  const legCount = buildLegs().length;

  // ── Collapsed trigger ──
  if (!open) return (
    <button onClick={() => setOpen(true)} className="gb-ghost"
      style={{ width:"100%", marginTop:6, color:C.gold, borderColor:`${C.gold}40`,
               padding:"8px 0", fontSize:10, fontWeight:700, letterSpacing:".05em",
               display:"flex", alignItems:"center", justifyContent:"center", gap:7 }}>
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M3 9V7a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v2a3 3 0 0 0 0 6v2a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-2a3 3 0 0 0 0-6z"/>
        <path d="M13 5v14"/>
      </svg>
      Book Now
    </button>
  );

  return (
    <div style={{ marginTop:6, background:`${C.gold}06`, border:`1px solid ${C.goldBorder}`,
                  borderRadius:cr, padding:"14px" }}>
      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:12 }}>
        <span style={{ fontSize:9, fontWeight:800, color:C.gold, letterSpacing:".1em", textTransform:"uppercase" }}>Book Now</span>
        <button onClick={() => { setOpen(false); reset(); }}
          style={{ background:"transparent", border:"none", color:C.muted,
                   fontSize:16, padding:0, cursor:"pointer", lineHeight:1 }}>✕</button>
      </div>

      {!result ? (
        <>
          {/* N2-FIX: Bookmaker selector — LL shown as disabled with downtime subtext */}
          <div style={{ display:"flex", flexDirection:"column", gap:5, marginBottom:12 }}>
            {BOOKMAKERS.map(bm => {
              const isDisabled = !!bm.disabled;
              const isSelected = bookie === bm.id;
              return (
                <button key={bm.id}
                  onClick={() => { if (!isDisabled) { setBookie(bm.id); reset(); } }}
                  style={{
                    width:"100%", padding:"9px 12px", borderRadius:br,
                    border:`1px solid ${isSelected ? C.accentBorder : isDisabled ? C.border : C.border}`,
                    background: isSelected ? C.accentDim : isDisabled ? C.faint : C.surface,
                    color: isSelected ? C.accent : isDisabled ? C.muted : C.text,
                    fontSize:10, fontWeight:800, cursor: isDisabled ? "default" : "pointer",
                    fontFamily:C.font, letterSpacing:".05em", transition:"all .15s",
                    display:"flex", alignItems:"center", justifyContent:"space-between",
                    opacity: isDisabled ? 0.55 : 1,
                  }}>
                  <span>{bm.label}</span>
                  {isDisabled && bm.disabledText && (
                    <span style={{ fontSize:8, color:C.amber, fontWeight:700, fontStyle:"italic" }}>
                      {bm.disabledText}
                    </span>
                  )}
                  {isSelected && !isDisabled && (
                    <span style={{ fontSize:10, color:C.accent }}>✓</span>
                  )}
                </button>
              );
            })}
          </div>

          <div style={{ fontSize:8, color:C.muted, marginBottom:10 }}>
            {legCount} leg{legCount !== 1 ? "s" : ""}{bookie ? ` · ${selectedBookie?.label}` : ""}
          </div>

          {/* Booking "please wait" spinner state */}
          {booking ? (
            <div style={{ width:"100%", background:C.faint, borderRadius:br,
                          padding:"12px 14px", display:"flex", alignItems:"center", gap:12,
                          border:`1px solid ${C.border}` }}>
              <div style={{ width:18, height:18, borderRadius:"50%", flexShrink:0,
                            border:`2.5px solid ${C.gold}35`, borderTopColor:C.gold,
                            animation:"spin .75s linear infinite" }}/>
              <div>
                <div style={{ fontSize:11, fontWeight:800, color:C.text }}>Booking your ticket…</div>
                <div style={{ fontSize:8, color:C.muted, marginTop:2 }}>Takes 10–20 seconds. Keep this screen open.</div>
              </div>
            </div>
          ) : (
            <button onClick={book} disabled={!legCount || !bookie} className="gb"
              style={{ width:"100%",
                       background:(!legCount||!bookie) ? C.faint : C.accent,
                       color:(!legCount||!bookie) ? C.muted : C.accentText,
                       border:`1px solid ${(!legCount||!bookie) ? C.border : C.accentBorder}`,
                       borderRadius:br, padding:"11px 0", fontWeight:900, fontSize:11,
                       letterSpacing:".08em", textTransform:"uppercase" }}>
              {!bookie ? "Select a bookmaker first" : "Generate Code"}
            </button>
          )}

          {error && (
            <div style={{ fontSize:9, color:C.red, marginTop:8, padding:"9px 11px",
                          background:`${C.red}0e`, border:`1px solid ${C.red}30`,
                          borderRadius:8, lineHeight:1.5 }}>
              {error}
              <button onClick={book} style={{ display:"block", marginTop:6, fontSize:9, padding:"3px 10px",
                                              background:"transparent", border:`1px solid ${C.red}`,
                                              color:C.red, borderRadius:5, cursor:"pointer", fontFamily:C.font }}>
                Try again
              </button>
            </div>
          )}
        </>
      ) : (
        /* ── SUCCESS STATE ── */
        <div style={{ display:"flex", flexDirection:"column", gap:10 }}>

          {/* Status header */}
          {(() => {
            const failCount = Array.isArray(result.failed) ? result.failed.length : (result.failed || 0);
            const isPartial = failCount > 0;
            const booked    = isPartial ? (result.resolved ?? (legCount - failCount)) : (result.total ?? legCount);
            return (
              <div style={{ display:"flex", alignItems:"center", gap:10, padding:"10px 12px",
                            background: isPartial ? `${C.amber}0e` : `${C.green}0e`,
                            border:`1px solid ${isPartial ? C.amber : C.green}30`,
                            borderRadius:br }}>
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none"
                  stroke={isPartial ? C.amber : C.green} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  {isPartial
                    ? <><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></>
                    : <><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></>}
                </svg>
                <div style={{ flex:1 }}>
                  <div style={{ fontSize:12, fontWeight:800, color: isPartial ? C.amber : C.green }}>
                    {isPartial ? `${booked} of ${result.total ?? legCount} legs booked` : `All ${result.total ?? legCount} legs booked`}
                  </div>
                  <div style={{ fontSize:9, color:C.muted, marginTop:1 }}>
                    {BOOKMAKERS.find(b => b.id === result.bookieId)?.label || "Bookmaker"}
                    {isPartial && ` · ${failCount} leg${failCount > 1 ? "s" : ""} not matched`}
                  </div>
                </div>
              </div>
            );
          })()}

          {/* Code — compact with inline copy */}
          <div style={{ display:"flex", alignItems:"center", gap:8,
                        background:C.surface, border:`1px solid ${C.green}35`,
                        borderRadius:br, padding:"10px 14px" }}>
            <span style={{ flex:1, fontFamily:'"JetBrains Mono","Courier New",monospace',
                           fontSize:20, fontWeight:800, color:C.green,
                           letterSpacing:".18em", userSelect:"all" }}>
              {result.code}
            </span>
            <button onClick={copyCode} style={{
              flexShrink:0, padding:"6px 12px", fontSize:9, fontWeight:800,
              background: copied ? C.green : `${C.green}15`,
              color: copied ? "#fff" : C.green,
              border:`1px solid ${C.green}45`, borderRadius:8,
              cursor:"pointer", fontFamily:C.font, transition:"all .15s",
              display:"flex", alignItems:"center", gap:5,
            }}>
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
              </svg>
              {copied ? "Copied!" : "Copy"}
            </button>
          </div>

          {/* N11-FIX: Actual BM odds — clean card, total prominent, per-leg breakdown below */}
          {(result.combinedOdds || result.oddsBreakdown?.some(l => l.odds)) && (
            <div style={{ border:`1px solid ${C.gold}30`, borderRadius:br, overflow:"hidden" }}>

              {/* Total odds header */}
              {result.combinedOdds && (
                <div style={{ background:`${C.gold}0e`, padding:"10px 14px",
                              display:"flex", justifyContent:"space-between", alignItems:"center",
                              borderBottom: result.oddsBreakdown?.some(l=>l.odds) ? `1px solid ${C.gold}20` : "none" }}>
                  <div>
                    <div style={{ fontSize:7, fontWeight:800, color:C.gold, letterSpacing:".1em",
                                  textTransform:"uppercase", marginBottom:2 }}>Booked Odds</div>
                    <div style={{ fontSize:8, color:C.muted }}>confirmed by bookmaker</div>
                  </div>
                  <div style={{ fontSize:26, fontWeight:900, color:C.gold,
                                letterSpacing:"-.01em", lineHeight:1 }}>
                    ×{result.combinedOdds}
                  </div>
                </div>
              )}

              {/* Per-leg breakdown */}
              {result.oddsBreakdown?.filter(l => l.odds).map((l, i, arr) => (
                <div key={i} style={{
                  display:"flex", alignItems:"center", padding:"8px 14px", gap:10,
                  background: i % 2 === 0 ? "transparent" : `${C.text}04`,
                  borderBottom: i < arr.length - 1 ? `1px solid ${C.border}` : "none",
                }}>
                  {/* Odds pill */}
                  <div style={{ flexShrink:0, minWidth:36, textAlign:"center",
                                background:`${C.gold}12`, border:`1px solid ${C.gold}30`,
                                borderRadius:6, padding:"3px 6px" }}>
                    <span style={{ fontSize:10, fontWeight:800, color:C.gold }}>
                      {l.odds}
                    </span>
                  </div>
                  {/* Match + pick — B5-FIX: use label (match name) and outcome from oddsBreakdown */}
                  <div style={{ flex:1, minWidth:0 }}>
                    <div style={{ fontSize:9, fontWeight:700, color:C.text,
                                  whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis" }}>
                      {l.label || l.game || "—"}
                    </div>
                    {(l.outcome || l.pick) && (
                      <div style={{ fontSize:8, color:C.muted, marginTop:1 }}>{l.outcome || l.pick}</div>
                    )}
                    {l._fallbackFrom && (
                      <div style={{ fontSize:7, color:C.amber, marginTop:1 }}>
                        booked as {l.bookedAs || l._fallbackFrom?.bookedAs}
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Per-leg failures */}
          {(() => {
            const failed = Array.isArray(result.failed) ? result.failed : [];
            if (!failed.length) return null;
            return (
              <div style={{ background:`${C.amber}08`, border:`1px solid ${C.amber}25`,
                            borderRadius:br, padding:"10px 12px" }}>
                <div style={{ fontSize:9, fontWeight:800, color:C.amber, marginBottom:8,
                              letterSpacing:".06em", textTransform:"uppercase" }}>
                  {failed.length} leg{failed.length > 1 ? "s" : ""} not booked
                </div>
                {failed.map((fail, i) => {
                  const isObj  = fail && typeof fail === "object";
                  const label  = isObj ? (fail.label || fail.game || `Leg ${i+1}`) : String(fail);
                  const reason = isObj && fail.failReason === "tt_unavailable"
                    ? "Team Total not listed — try Over 2.5 or BTTS via Custom Pick"
                    : isObj && fail.failReason === "not_listed"
                    ? "Fixture not yet listed on this bookmaker — check again closer to kickoff"
                    : "Game or market not matched. Try SportyBet, or wait closer to kickoff.";
                  return (
                    <div key={i} style={{ marginBottom: i < failed.length - 1 ? 8 : 0,
                                          paddingBottom: i < failed.length - 1 ? 8 : 0,
                                          borderBottom: i < failed.length - 1 ? `1px solid ${C.amber}20` : "none" }}>
                      <div style={{ fontSize:10, color:C.text, fontWeight:700 }}>{label}</div>
                      <div style={{ fontSize:9, color:C.muted, lineHeight:1.5, marginTop:2 }}>{reason}</div>
                    </div>
                  );
                })}
              </div>
            );
          })()}

          {/* Three action buttons */}
          <div style={{ display:"flex", gap:6 }}>
            <button onClick={copyCode} style={{
              flex:1, padding:"10px 0", fontSize:10, fontWeight:700,
              background: copied ? C.green : "transparent",
              color: copied ? "#fff" : C.green,
              border:`1px solid ${C.green}45`, borderRadius:br,
              cursor:"pointer", fontFamily:C.font,
              display:"flex", alignItems:"center", justifyContent:"center", gap:6,
            }}>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
              </svg>
              {copied ? "Copied!" : "Copy Code"}
            </button>
            <button onClick={shareTicket} style={{
              flex:1, padding:"10px 0", fontSize:10, fontWeight:700,
              background: sharedOk ? `${C.blue}18` : "transparent",
              color: sharedOk ? C.blue : C.muted,
              border:`1px solid ${C.border}`, borderRadius:br,
              cursor:"pointer", fontFamily:C.font,
              display:"flex", alignItems:"center", justifyContent:"center", gap:5,
            }}>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/>
                <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>
              </svg>
              {sharedOk ? "Copied!" : "Copy Link"}
            </button>
          </div>

          <button onClick={() => { reset(); setBookie(""); }}
            style={{ background:"transparent", border:"none", color:C.muted, fontSize:9,
                     cursor:"pointer", fontFamily:C.font, textDecoration:"underline", padding:0, textAlign:"center" }}>
            Book another
          </button>
        </div>
      )}
    </div>
  );
}

// ── FIXTURE BOOK NOW (inline, per-card) ──────────────────────────────────
// Market/pick selector that adds the choice to the draft ticket.
export function FixtureBookNow({ fixture, onAddToParlay }) {
  const [open, setOpen]     = useState(false);
  const [market, setMarket] = useState("1X2");
  const [pick, setPick]     = useState("");
  const [flash, setFlash]   = useState(false);
  const [errMsg, setErrMsg] = useState("");

  const home = fixture.teams.home;
  const away = fixture.teams.away;

  const pickOptions = getCustomPickOptions(market, home, away);

  const changeMarket = m => {
    setMarket(m);
    setPick(getCustomPickOptions(m, home, away)[0] || "");
  };

  // Map market family → mktStyle-compatible key for display in ticket
  const resolveDisplayMarket = (fam, p) => {
    if (fam === "1X2") return "1X2";
    if (fam === "DC")   return "DC";
    if (fam === "BTTS") return "BTTS";
    if (fam === "TeamTotal_H" || fam === "TeamTotal_A") return "TeamTotal";
    if (fam === "Goals_OU") {
      const line = p.match(/[\d.]+/)?.[0] || "2.5";
      return p.startsWith("Over") ? `Over ${line}` : `Under ${line}`;
    }
    return fam;
  };

  const handleAdd = () => {
    if (!pick || !onAddToParlay) return;
    const io = p => (p > 0 && p < 100) ? parseFloat((1 / (p / 100)).toFixed(2)) : null;
    const m = fixture.markets || {};
    const o = fixture.odds || {};

    // Look up model prob and real/implied odds based on the selected market+pick
    let prob = null, odds = null;
    const mf = market;
    if (mf === "1X2") {
      if (pick.includes("Win") && pick.includes(home)) { prob = m.homeWin; odds = o.o1 || io(m.homeWin); }
      else if (pick === "Draw")                         { prob = m.draw;    odds = o.oX || io(m.draw);    }
      else                                              { prob = m.awayWin; odds = o.o2 || io(m.awayWin); }
    } else if (mf === "DC") {
      if (pick === "Home or Draw")  { prob = m.dc1X || (m.homeWin + m.draw); odds = o.dc1X || io(prob); }
      else if (pick === "Away or Draw") { prob = m.dcX2 || (m.awayWin + m.draw); odds = o.dcX2 || io(prob); }
      else                          { prob = m.dc12  || (m.homeWin + m.awayWin); odds = o.dc12  || io(prob); }
    } else if (mf === "BTTS") {
      if (pick === "BTTS Yes") { prob = m.bttsYes; odds = o.bttsYesOdds || io(m.bttsYes); }
      else                     { prob = m.bttsNo;  odds = o.bttsNoOdds  || io(m.bttsNo);  }
    } else if (mf === "TeamTotal_H" || mf === "TeamTotal_A") {
      const isHome = mf === "TeamTotal_H";
      const isOver = pick.includes("Over");
      const lineStr = (pick.match(/[\d.]+/) || ["0.5"])[0];
      const lineKey = lineStr.replace(".", "");
      const probKey = `${isHome ? "home" : "away"}Over${lineKey}`;
      const basePr  = m[probKey];
      prob = isOver ? basePr : (basePr != null ? 100 - basePr : null);
      odds = io(prob);
    } else if (mf === "Goals_OU") {
      const line = pick.match(/[\d.]+/)?.[0] || "2.5";
      const isOver = pick.startsWith("Over");
      const lineKey = line.replace(".","");
      if (isOver) {
        const key = `over${lineKey}`;
        const oddsKey = `over${lineKey}odds`;
        prob = m[key] ?? null;
        odds = prob ? (o[oddsKey] || io(prob)) : null;
      } else {
        // Under X.5 — derive from over if direct field missing
        const underKey = `under${lineKey}`;
        const overKey  = `over${lineKey}`;
        const oddsKey  = `under${lineKey}odds`;
        prob = m[underKey] ?? (m[overKey] != null ? parseFloat((100 - m[overKey]).toFixed(1)) : null);
        odds = prob ? (o[oddsKey] || io(prob)) : null;
      }
    }
    if (!prob) prob = null;
    // Always derive implied odds from prob if no real odds — sportybet books by outcomeId not odds
    if (!odds && prob) odds = io(prob);
    // Floor implied odds at 1.02 so the ticket math doesn't break
    if (odds && odds < 1.02) odds = 1.02;

    // Only block if we have no prob AND no odds at all (completely unknown market)
    if (!prob && !odds) {
      setErrMsg("⚠ No model data for this pick — market not available for this fixture");
      setTimeout(() => setErrMsg(""), 2500);
      return;
    }
    setErrMsg("");
    // handleAddAnchor expects single pick obj — fixture as first arg caused ×1.00
    onAddToParlay({
      pick,
      market: resolveDisplayMarket(market, pick),
      odds:   odds,
      prob:   prob || null,
    });
    setFlash(true);
    setTimeout(() => { setFlash(false); setOpen(false); }, 1200);
  };

  if (!open) return (
    <button onClick={() => setOpen(true)} className="gb"
      style={{ width:"100%", background:`${C.gold}0d`, border:`1px solid ${C.goldBorder}`,
               color:C.gold, padding:"10px 14px", fontSize:10, fontWeight:800,
               letterSpacing:".05em", borderRadius:9,
               display:"flex", alignItems:"center", gap:8, justifyContent:"center" }}>
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="12" r="10"/><path d="M12 8v8M8 12h8"/>
      </svg>
      Custom Pick
      <span style={{ fontSize:8, fontWeight:500, color:`${C.gold}99`, fontStyle:"italic", marginLeft:2 }}>
        — pick any market
      </span>
    </button>
  );

  return (
    <div style={{ background:C.surface, border:`1px solid ${C.goldBorder}`, borderRadius:9, padding:"10px 12px" }}>
      {/* Header */}
      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:6 }}>
        <span style={{ fontSize:8, fontWeight:800, color:C.gold, letterSpacing:".12em", textTransform:"uppercase" }}>Custom Pick</span>
        <button onClick={() => setOpen(false)} className="gb"
          style={{ background:"transparent", border:"none", color:C.text, fontSize:11, padding:0 }}>✕</button>
      </div>
      <div style={{ fontSize:8, color:C.text, marginBottom:8 }}>
        <span style={{ color:C.text, fontWeight:700 }}>{home}</span>
        <span style={{ color:C.text }}> vs </span>
        <span style={{ color:C.text, fontWeight:700 }}>{away}</span>
      </div>

      {/* Market family */}
      <div style={{ fontSize:7, color:C.text, textTransform:"uppercase", letterSpacing:".1em", marginBottom:4 }}>Market</div>
      <div style={{ display:"flex", flexWrap:"wrap", gap:4, marginBottom:8 }}>
        {CUSTOM_BOOK_MARKETS.map(m => (
          <button key={m.value} onClick={() => changeMarket(m.value)} className="gb"
            style={{ padding:"3px 9px", fontSize:8, background:market===m.value?C.gold:"transparent", color:market===m.value?C.accentText:C.muted, border:`1px solid ${market===m.value?C.gold:C.faint}`, textTransform:"none", letterSpacing:0 }}>
            {m.label}
          </button>
        ))}
      </div>

      {/* Pick */}
      {pickOptions.length > 0 && (
        <>
          <div style={{ fontSize:7, color:C.text, textTransform:"uppercase", letterSpacing:".1em", marginBottom:4 }}>Pick</div>
          <div style={{ display:"flex", flexWrap:"wrap", gap:4, marginBottom:10 }}>
            {pickOptions.map(p => {
              const c = mktStyle(resolveDisplayMarket(market, p)).color || C.gold;
              return (
                <button key={p} onClick={() => setPick(p)} className="gb"
                  style={{ padding:"3px 10px", fontSize:8, background:pick===p?c:"transparent", color:pick===p?C.accentText:C.muted, border:`1px solid ${pick===p?c:C.faint}`, textTransform:"none", letterSpacing:0, fontWeight:pick===p?800:400 }}>
                  {p}
                </button>
              );
            })}
          </div>
        </>
      )}

      {pick && (() => {
        // Live preview of resolved prob/odds for selected pick
        const io2 = p => (p > 0 && p < 100) ? parseFloat((1/(p/100)).toFixed(2)) : null;
        const m2 = fixture.markets || {}, o2 = fixture.odds || {};
        let previewProb = null, previewOdds = null;
        const lineKey = pick.match(/[\d.]+/)?.[0]?.replace(".","") || "";
        if (market === "1X2") {
          if (pick.includes(home)) { previewProb = m2.homeWin; previewOdds = o2.o1 || io2(m2.homeWin); }
          else if (pick === "Draw") { previewProb = m2.draw; previewOdds = o2.oX || io2(m2.draw); }
          else { previewProb = m2.awayWin; previewOdds = o2.o2 || io2(m2.awayWin); }
        } else if (market === "BTTS") {
          if (pick === "BTTS Yes") { previewProb = m2.bttsYes; previewOdds = o2.bttsYesOdds || io2(m2.bttsYes); }
          else { previewProb = m2.bttsNo; previewOdds = o2.bttsNoOdds || io2(m2.bttsNo); }
        } else if (market === "Goals_OU" && lineKey) {
          const isOver = pick.startsWith("Over");
          previewProb = isOver ? (m2[`over${lineKey}`] ?? null) : (m2[`under${lineKey}`] ?? (m2[`over${lineKey}`] != null ? parseFloat((100-m2[`over${lineKey}`]).toFixed(1)) : null));
          previewOdds = isOver ? (o2[`over${lineKey}odds`] || io2(previewProb)) : (o2[`under${lineKey}odds`] || io2(previewProb));
        } else if ((market === "TeamTotal_H" || market === "TeamTotal_A") && lineKey) {
          const isHome = market === "TeamTotal_H", isOver = pick.includes("Over");
          const base = m2[`${isHome?"home":"away"}Over${lineKey}`];
          previewProb = isOver ? base : (base != null ? 100 - base : null);
          previewOdds = io2(previewProb);
        } else if (market === "DC") {
          // N23-FIX: DC odds preview was entirely missing — previewProb/Odds stayed null,
          // so the preview strip never rendered when DC was selected.
          // Mirror the handleAdd DC branch (line ~5625) which already works correctly.
          const pickLower = (pick || "").toLowerCase();
          if (pickLower.includes("or draw") || pickLower === "home or draw" || pickLower === "1x") {
            previewProb = m2.dc1X ?? (m2.homeWin != null && m2.draw != null ? Math.min(99, m2.homeWin + m2.draw) : null);
            previewOdds = o2.dc1X || io2(previewProb);
          } else if (pickLower.includes("draw or away") || pickLower === "x2") {
            previewProb = m2.dcX2 ?? (m2.draw != null && m2.awayWin != null ? Math.min(99, m2.draw + m2.awayWin) : null);
            previewOdds = o2.dcX2 || io2(previewProb);
          } else if (pickLower.includes("home or away") || pickLower === "12") {
            previewProb = m2.dc12 ?? (m2.homeWin != null && m2.awayWin != null ? Math.min(99, m2.homeWin + m2.awayWin) : null);
            previewOdds = o2.dc12 || io2(previewProb);
          }
        }
        if (!previewProb && !previewOdds) return null;
        return (
          <div style={{ display:"flex",justifyContent:"space-between",background:`${C.gold}08`,border:`1px solid ${C.gold}20`,borderRadius:5,padding:"5px 8px",marginBottom:8,fontSize:8 }}>
            <span style={{ color:C.text }}>Model prob</span>
            <span style={{ color:C.gold,fontWeight:700 }}>{previewProb ? `${Math.round(previewProb)}%` : "—"}</span>
            <span style={{ color:C.text }}>Odds</span>
            <span style={{ color:previewOdds?C.green:C.red,fontWeight:700 }}>{previewOdds ? `${parseFloat(previewOdds).toFixed(2)}x` : "No data"}</span>
          </div>
        );
      })()}
      <button onClick={handleAdd} disabled={!pick || flash || !onAddToParlay} className="gb"
        style={{ width:"100%", background:flash?C.green:pick?C.gold:C.faint, color:flash||pick?C.accentText:C.muted, padding:"7px 0", fontWeight:800, fontSize:10, transition:"all .2s" }}>
        {flash ? "✓ Added to Ticket!" : "+ Add to Ticket"}
      </button>
      {errMsg && <div style={{ fontSize:8,color:C.red,marginTop:5,textAlign:"center" }}>{errMsg}</div>}
    </div>
  );
}

const CUSTOM_BOOK_MARKETS = [
  { label:"1X2",          value:"1X2"         },
  { label:"Double Chance",value:"DC"          },
  { label:"BTTS",         value:"BTTS"        },
  { label:"Goals O/U",    value:"Goals_OU"    },
  { label:"Home O/U",     value:"TeamTotal_H" },
  { label:"Away O/U",     value:"TeamTotal_A" },
];

function getCustomPickOptions(market, home, away) {
  const h = home || "Home", a = away || "Away";

  // 1X2 — parsePick uses /\bwin\b/ + sim() to identify home/away
  if (market === "1X2")  return [`${h} Win`, "Draw", `${a} Win`];

  // DC — MUST use literal "Home"/"Away"/"Draw" words, NOT team names.
  //   parsePick checks /1x|home or draw/, /x2|draw or away|away or draw/, /12|home or away/
  //   Team names in the pick would all fall to the default "1x" — wrong.
  if (market === "DC")   return ["Home or Draw", "Away or Draw", "Home or Away"];

  // BTTS — parsePick checks /btts|gg|both teams/ then /no|ng/
  if (market === "BTTS") return ["BTTS Yes", "BTTS No"];

  // Goals O/U — only lines with model data (over15/25/35/45, under25/35/45)
  if (market === "Goals_OU") return [
    "Over 1.5 Goals",  "Over 2.5 Goals",  "Over 3.5 Goals",  "Over 4.5 Goals",
    "Under 1.5 Goals", "Under 2.5 Goals", "Under 3.5 Goals", "Under 4.5 Goals",
  ];

  // Team Totals — parsePick uses sim() on team name prefix → type:"tt"
  //   scoreOC targets ID 19 (Home, score 1.0) and ID 20 (Away, score 1.0)
  //   Gap Filler auto-fetches full event markets if IDs 19/20 are missing
  if (market === "TeamTotal_H") return [
    `${h} Over 0.5`,  `${h} Over 1.5`,  `${h} Over 2.5`,
    `${h} Over 3.5`,  `${h} Over 4.5`,  `${h} Over 5.5`,
    `${h} Under 0.5`, `${h} Under 1.5`, `${h} Under 2.5`,
    `${h} Under 3.5`, `${h} Under 4.5`,
  ];

  if (market === "TeamTotal_A") return [
    `${a} Over 0.5`,  `${a} Over 1.5`,  `${a} Over 2.5`,
    `${a} Over 3.5`,  `${a} Over 4.5`,  `${a} Over 5.5`,
    `${a} Under 0.5`, `${a} Under 1.5`, `${a} Under 2.5`,
    `${a} Under 3.5`, `${a} Under 4.5`,
  ];

  // NOTE: 1st Half O/U (ID 68) and Corners O/U (ID 166) are NOT included.
  //   HalfTime: parsePick gives type:"ou" → scoreOC always prefers ID 18 (main O/U, 1.0) over ID 68 (0.7).
  //   Corners:  parsePick produces type:"raw" → scoreOC returns 0 — completely unsupported.

  return [];
}

// Fixture search dropdown for Custom Book
function FixtureSearchDropdown({ fixtures, selectedFixture, onSelect, placeholder }) {
  const [query, setQuery] = useState("");
  const [open, setOpen]   = useState(false);
  const ref = useRef(null);

  const filtered = useMemo(() => {
    if (!query.trim()) return fixtures.slice(0, 30);
    const q = query.toLowerCase();
    return fixtures.filter(f =>
      f.teams.home.toLowerCase().includes(q) ||
      f.teams.away.toLowerCase().includes(q) ||
      f.league.toLowerCase().includes(q)
    ).slice(0, 20);
  }, [fixtures, query]);

  // Close on outside click
  useEffect(() => {
    const handler = e => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  const displayLabel = selectedFixture
    ? `${selectedFixture.teams.home} vs ${selectedFixture.teams.away}`
    : "";

  return (
    <div ref={ref} style={{ position:"relative" }}>
      <input
        className="gi"
        value={open ? query : displayLabel}
        onFocus={() => { setOpen(true); setQuery(""); }}
        onChange={e => setQuery(e.target.value)}
        placeholder={placeholder || "Search fixture…"}
        style={{ fontSize:10, cursor:"pointer" }}
      />
      {open && (
        <div style={{ position:"absolute",top:"100%",left:0,right:0,zIndex:300,background:C.modalBg,border:`1px solid ${C.border}`,borderRadius:8,marginTop:2,maxHeight:220,overflowY:"auto",boxShadow:"0 8px 32px rgba(0,0,0,0.7)" }}>
          {filtered.length === 0 && (
            <div style={{ padding:"12px 14px",fontSize:9,color:C.text,textAlign:"center" }}>No fixtures found</div>
          )}
          {filtered.map(f => (
            <button key={f.id} onClick={() => { onSelect(f); setOpen(false); setQuery(""); }} className="gb"
              style={{ width:"100%",textAlign:"left",padding:"8px 12px",background:"transparent",border:"none",borderBottom:`1px solid ${C.faint}`,color:C.text,fontSize:10,fontWeight:600,borderRadius:0,letterSpacing:0,textTransform:"none",cursor:"pointer" }}>
              <div style={{ lineHeight:1.3 }}>{f.teams.home} <span style={{ color:C.text,opacity:.3 }}>vs</span> {f.teams.away}</div>
              <div style={{ fontSize:7,color:C.text,marginTop:1 }}>{f.league} · {f.time}</div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function CustomBookNow({ fixtures = [], onAddToTicket }) {
  const blankLeg = (home="", away="") => ({ home, away, market:"1X2", pick:"", fixtureId:null });
  const [legs, setLegs]             = useState([blankLeg()]);
  const [selectedFixtures, setSelectedFixtures] = useState([null]);
  const [flash, setFlash]           = useState(false);

  const updateLeg = (i, key, val) => setLegs(prev => {
    const next = prev.map((l,j) => j===i ? {...l,[key]:val} : l);
    if (["market","home","away"].includes(key)) {
      const opts = getCustomPickOptions(next[i].market, next[i].home, next[i].away);
      if (!opts.includes(next[i].pick)) next[i].pick = opts[0]||"";
    }
    return next;
  });

  const selectFixture = (i, fixture) => {
    setSelectedFixtures(prev => { const n=[...prev]; n[i]=fixture; return n; });
    setLegs(prev => {
      const next = [...prev];
      next[i] = { ...next[i], home:fixture.teams.home, away:fixture.teams.away, fixtureId:fixture.id };
      const opts = getCustomPickOptions(next[i].market, next[i].home, next[i].away);
      next[i].pick = opts[0] || "";
      return next;
    });
  };

  const addLeg = () => {
    setLegs(p => [...p, blankLeg()]);
    setSelectedFixtures(p => [...p, null]);
  };
  const removeLeg = i => {
    setLegs(p => p.filter((_,j) => j!==i));
    setSelectedFixtures(p => p.filter((_,j) => j!==i));
  };

  const handleAddToTicket = () => {
    const valid = legs.filter(l => l.home.trim() && l.away.trim() && l.pick);
    if (!valid.length || !onAddToTicket) return;
    const mapped = valid.map((l, i) => {
      // Look up model prob from the selected fixture if available
      const fx = selectedFixtures[legs.indexOf(l)] || null;
      const m  = fx?.markets || {};
      const o  = fx?.odds    || {};
      const io = p => (p > 0 && p < 100) ? parseFloat((1 / (p / 100)).toFixed(2)) : null;
      let prob = null, odds = null;
      const mf = l.market;
      if (mf === "1X2") {
        if (l.pick.includes(l.home))      { prob = m.homeWin; odds = o.o1 || io(m.homeWin); }
        else if (l.pick === "Draw")        { prob = m.draw;    odds = o.oX || io(m.draw);    }
        else                               { prob = m.awayWin; odds = o.o2 || io(m.awayWin); }
      } else if (mf === "DC") {
        if (l.pick.includes("1X"))      { prob = m.dc1X; odds = o.dc1X || io(m.dc1X); }
        else if (l.pick.includes("X2")) { prob = m.dcX2; odds = o.dcX2 || io(m.dcX2); }
        else                            { prob = m.dc12; odds = o.dc12 || io(m.dc12);  }
      } else if (mf === "BTTS") {
        if (l.pick === "BTTS Yes") { prob = m.bttsYes; odds = o.bttsYesOdds || io(m.bttsYes); }
        else                       { prob = m.bttsNo;  odds = o.bttsNoOdds  || io(m.bttsNo);  }
      } else if (mf === "TeamTotal_H") { prob = m.homeOver05; odds = io(m.homeOver05); }
      else if (mf === "TeamTotal_A")   { prob = m.awayOver05; odds = io(m.awayOver05); }
      else if (mf === "Goals_OU") {
        const line = l.pick.match(/[\d.]+/)?.[0] || "2.5";
        const isOver = l.pick.startsWith("Over");
        const key = isOver ? `over${line.replace(".","")}`  : `under${line.replace(".","")}`;
        const oddsKey = isOver ? `over${line.replace(".","")}odds` : `under${line.replace(".","")}odds`;
        prob = m[key]; odds = o[oddsKey] || io(prob);
      }
      if (!odds && prob) odds = io(prob);
      return {
        fixtureId: l.fixtureId,
        game:      `${l.home} vs ${l.away}`,
        pick:      l.pick,
        market:    l.market.startsWith("TeamTotal") ? "TeamTotal" : l.market,
        odds:      odds || safeImpliedOdds(65) || 1.5,
        conf:      prob || null,
      };
    });
    onAddToTicket({ legs: mapped });
    setFlash(true);
    setTimeout(() => { setFlash(false); setLegs([blankLeg()]); setSelectedFixtures([null]); }, 1400);
  };

  const validCount = legs.filter(l=>l.home&&l.away&&l.pick).length;
  const hasFixtures = fixtures.length > 0;

  return (
    <div style={{ background:C.surface,border:`1px solid ${C.goldBorder}`,borderRadius:12,padding:"16px" }}>
      <div style={{ fontSize:10,fontWeight:800,color:C.gold,letterSpacing:".12em",textTransform:"uppercase",marginBottom:4 }}>Custom Picks</div>
      <div style={{ fontSize:8,color:C.text,marginBottom:12 }}>
        {hasFixtures ? "Select fixtures and picks · adds to your ticket" : "Enter your own picks · adds to your ticket"}
      </div>

      {legs.map((leg,i) => {
        const pickOptions = getCustomPickOptions(leg.market, leg.home, leg.away);
        return (
          <div key={i} style={{ background:C.bg,borderRadius:8,padding:"10px 12px",marginBottom:8,border:`1px solid ${C.border}` }}>
            <div style={{ display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:8 }}>
              <span style={{ fontSize:8,color:C.text,fontWeight:700 }}>LEG {i+1}</span>
              {legs.length>1 && <button onClick={()=>removeLeg(i)} style={{ background:"none",border:"none",color:C.text,cursor:"pointer",fontSize:11,padding:0 }}>✕</button>}
            </div>

            {/* Fixture selector — searchable dropdown if fixtures loaded, else free text */}
            {hasFixtures ? (
              <div style={{ marginBottom:8 }}>
                <div style={{ fontSize:9,color:C.text,textTransform:"uppercase",letterSpacing:".1em",marginBottom:4 }}>Fixture</div>
                <FixtureSearchDropdown
                  fixtures={fixtures}
                  selectedFixture={selectedFixtures[i]}
                  onSelect={f => selectFixture(i, f)}
                  placeholder="Search team or league…"
                />
                {selectedFixtures[i] && (
                  <div style={{ fontSize:7,color:C.text,marginTop:3 }}>
                    {selectedFixtures[i].league} · {selectedFixtures[i].time}
                  </div>
                )}
              </div>
            ) : (
              <div style={{ display:"grid",gridTemplateColumns:"1fr 1fr",gap:6,marginBottom:8 }}>
                <input value={leg.home} onChange={e=>updateLeg(i,"home",e.target.value)} placeholder="Home team" className="gi" style={{ fontSize:9 }}/>
                <input value={leg.away} onChange={e=>updateLeg(i,"away",e.target.value)} placeholder="Away team" className="gi" style={{ fontSize:9 }}/>
              </div>
            )}

            {/* Market selector — buttons */}
            {leg.home && leg.away && (
              <>
                <div style={{ fontSize:9,color:C.text,textTransform:"uppercase",letterSpacing:".1em",marginBottom:4 }}>Market</div>
                <div style={{ display:"flex",flexWrap:"wrap",gap:4,marginBottom:8 }}>
                  {CUSTOM_BOOK_MARKETS.map(m => (
                    <button key={m.value} onClick={() => updateLeg(i,"market",m.value)} className="gb"
                      style={{ padding:"3px 9px",fontSize:8,background:leg.market===m.value?C.gold:"transparent",color:leg.market===m.value?C.accentText:C.muted,border:`1px solid ${leg.market===m.value?C.gold:C.faint}`,textTransform:"none",letterSpacing:0 }}>
                      {m.label}
                    </button>
                  ))}
                </div>

                {/* Pick options — buttons, auto-populated */}
                {pickOptions.length > 0 && (
                  <>
                    <div style={{ fontSize:9,color:C.text,textTransform:"uppercase",letterSpacing:".1em",marginBottom:4 }}>Pick</div>
                    <div style={{ display:"flex",flexWrap:"wrap",gap:4 }}>
                      {pickOptions.map(p => (
                        <button key={p} onClick={() => updateLeg(i,"pick",p)} className="gb"
                          style={{ padding:"4px 12px",fontSize:9,background:leg.pick===p?mktStyle(leg.market.replace("_H","").replace("_A","")).color||C.radar:"transparent",color:leg.pick===p?C.accentText:C.muted,border:`1px solid ${leg.pick===p?(mktStyle(leg.market.replace("_H","").replace("_A","")).color||C.radar):C.faint}`,textTransform:"none",letterSpacing:0,fontWeight:leg.pick===p?800:400 }}>
                          {p}
                        </button>
                      ))}
                    </div>
                  </>
                )}
              </>
            )}
          </div>
        );
      })}

      <button onClick={addLeg} className="gb"
        style={{ background:"transparent",border:`1px solid ${C.faint}`,color:C.text,padding:"4px 12px",fontSize:9,marginBottom:10 }}>
        + Add Leg
      </button>

      <button onClick={handleAddToTicket} disabled={!validCount || flash} className="gb"
        style={{ width:"100%",background:flash?C.green:validCount?C.gold:C.faint,color:flash||validCount?C.accentText:C.muted,padding:"8px 0",fontWeight:800,fontSize:10,transition:"all .2s" }}>
        {flash ? `✓ Added ${validCount} leg${validCount!==1?"s":""}!` : `+ Add to Ticket (${validCount} leg${validCount!==1?"s":""})`}
      </button>
    </div>
  );
}

// loadSavedTickets, persistTickets, generateTicketCode → engine.js

function CopyCodeButton({ code }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    copyToClipboard(code, () => { setCopied(true); setTimeout(()=>setCopied(false),2000); });
  };
  return (
    <button onClick={copy} className="gb"
      style={{ background:copied?`${C.green}15`:"transparent",border:`1px solid ${copied?C.green:C.radar}40`,color:copied?C.green:C.radar,padding:"2px 10px",fontSize:9,fontWeight:700 }}>
      {copied ? "✓ Copied" : `${code}`}
    </button>
  );
}

// ── N19: GRM SHARE MENU (3-dot) ──────────────────────────────────────────
// Lazy — only hits /api/ticket/share on first tap.
// Shows on both built tickets (Saved tab) and Draft ticket.
function GrmShareMenu({ ticket, bookieResult = null }) {
  const [open,       setOpen]       = useState(false);
  const [grmCode,    setGrmCode]    = useState(null);
  const [generating, setGenerating] = useState(false);
  const [copied,     setCopied]     = useState(null); // which item was just copied
  const menuRef = useRef(null);

  // Close on outside tap
  useEffect(() => {
    if (!open) return;
    const handler = e => { if (menuRef.current && !menuRef.current.contains(e.target)) setOpen(false); };
    document.addEventListener("mousedown", handler);
    document.addEventListener("touchstart", handler);
    return () => { document.removeEventListener("mousedown", handler); document.removeEventListener("touchstart", handler); };
  }, [open]);

  const ensureGrmCode = async () => {
    if (grmCode) return grmCode;
    setGenerating(true);
    try {
      const bm = bookieResult ? BOOKMAKERS.find(b => b.id === bookieResult.bookieId) : null;
      const res = await fetch(`${SERVER}/api/ticket/share`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          legs:                 ticket.legs,
          totalOdds:            ticket.totalOdds,
          combinedEmpiricalRate: ticket.combinedEmpiricalRate || null,
          date:                 ticket.date || null,
          label:                ticket.slotLabel || null,
          bookieCode:           bookieResult?.code || null,
          bookieId:             bookieResult?.bookieId || null,
        }),
      });
      if (!res.ok) throw new Error("Server error");
      const { code } = await res.json();
      setGrmCode(code);
      setGenerating(false);
      return code;
    } catch {
      setGenerating(false);
      return null;
    }
  };

  const flash = (key) => { setCopied(key); setTimeout(() => setCopied(null), 1800); };

  const handleOpen = async () => {
    setOpen(o => !o);
    // Pre-generate code in background when menu opens so Copy actions are instant
    if (!grmCode) ensureGrmCode();
  };

  const copyGrmCode = async () => {
    const code = await ensureGrmCode();
    if (!code) return;
    copyToClipboard(code, () => flash("code"));
  };

  const copyGrmLink = async () => {
    const code = await ensureGrmCode();
    if (!code) return;
    const base = window.location.origin + window.location.pathname;
    // P-FIX: preset branded message instead of a bare URL. Pasted straight into
    // WhatsApp/SMS/Twitter, a raw link with zero context reads as spam — this
    // gives it a recognizable, shareable framing.
    copyToClipboard(`Check out this GRM ticket: ${base}?grm=${code}`, () => flash("link"));
  };

  const copyBookieCode = () => {
    if (!bookieResult?.code) return;
    copyToClipboard(bookieResult.code, () => flash("bcode"));
  };

  const copyBookieLink = () => {
    if (!bookieResult?.code || !bookieResult?.bookieId) return;
    const bm = BOOKMAKERS.find(b => b.id === bookieResult.bookieId);
    if (!bm?.link) return;
    copyToClipboard(bm.link(bookieResult.code), () => flash("blink"));
  };

  const hasBookie = !!(bookieResult?.code);

  return (
    <div ref={menuRef} style={{ position:"relative", display:"inline-flex", alignItems:"center" }}>
      {/* Share SVG button — replaces horizontal 3-dot */}
      <button onClick={handleOpen} title="Share ticket"
        style={{ background: open ? `${C.accent}15` : "transparent",
                 border:`1px solid ${open ? C.accentBorder : C.border}`,
                 borderRadius:7, padding:"4px 9px", cursor:"pointer",
                 display:"flex", alignItems:"center", gap:5,
                 color: open ? C.accent : C.muted,
                 transition:"all .15s", fontFamily:C.font }}>
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor"
          strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/>
          <line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/>
          <line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/>
        </svg>
        <span style={{ fontSize:8, fontWeight:700 }}>Share</span>
      </button>

      {/* Share popover */}
      {open && (
        <div style={{ position:"absolute", top:"calc(100% + 6px)", right:0, zIndex:9999,
                      background:C.surface, border:`1px solid ${C.border}`, borderRadius:10,
                      padding:"6px 0", minWidth:198, boxShadow:"0 8px 24px rgba(0,0,0,.18)" }}>

          {/* GRM section */}
          <div style={{ padding:"6px 12px 4px", fontSize:7, fontWeight:800, color:C.muted,
                        letterSpacing:".1em", textTransform:"uppercase" }}>GRM Link</div>
          <div style={{ padding:"2px 12px 8px", fontSize:8, color:C.muted, lineHeight:1.5 }}>
            Share this ticket with another GRM user.
          </div>

          <button onClick={copyGrmCode}
            style={{ width:"100%", padding:"8px 14px", background:copied==="code"?`${C.green}10`:"transparent",
                     border:"none", textAlign:"left", cursor:"pointer", fontFamily:C.font,
                     display:"flex", alignItems:"center", gap:9 }}>
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke={copied==="code"?C.green:C.text} strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
            </svg>
            <span style={{ fontSize:10, fontWeight:700, color:copied==="code"?C.green:C.text }}>
              {copied==="code" ? "Copied!" : "Copy GRM Code"}
            </span>
          </button>

          <button onClick={copyGrmLink}
            style={{ width:"100%", padding:"8px 14px", background:copied==="link"?`${C.green}10`:"transparent",
                     border:"none", textAlign:"left", cursor:"pointer", fontFamily:C.font,
                     display:"flex", alignItems:"center", gap:9 }}>
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke={copied==="link"?C.green:C.text} strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/>
              <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>
            </svg>
            <span style={{ fontSize:10, fontWeight:700, color:copied==="link"?C.green:C.text }}>
              {copied==="link" ? "Copied!" : "Copy GRM Link"}
            </span>
          </button>

          {/* Bookie section */}
          <div style={{ margin:"5px 12px", borderTop:`1px solid ${C.border}` }} />
          <div style={{ padding:"6px 12px 4px", fontSize:7, fontWeight:800, color:C.muted,
                        letterSpacing:".1em", textTransform:"uppercase" }}>
            {hasBookie ? (BOOKMAKERS.find(b=>b.id===bookieResult.bookieId)?.label || "Bookie") : "Bookie Code"}
          </div>

          {hasBookie ? (
            <>
              <button onClick={copyBookieCode}
                style={{ width:"100%", padding:"8px 14px", background:copied==="bcode"?`${C.gold}10`:"transparent",
                         border:"none", textAlign:"left", cursor:"pointer", fontFamily:C.font,
                         display:"flex", alignItems:"center", gap:9 }}>
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke={copied==="bcode"?C.gold:C.text} strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
                </svg>
                <span style={{ fontSize:10, fontWeight:700, color:copied==="bcode"?C.gold:C.text }}>
                  {copied==="bcode" ? "Copied!" : "Copy Bookie Code"}
                </span>
              </button>
              <button onClick={copyBookieLink}
                style={{ width:"100%", padding:"8px 14px", background:copied==="blink"?`${C.gold}10`:"transparent",
                         border:"none", textAlign:"left", cursor:"pointer", fontFamily:C.font,
                         display:"flex", alignItems:"center", gap:9 }}>
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke={copied==="blink"?C.gold:C.text} strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/>
                  <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>
                </svg>
                <span style={{ fontSize:10, fontWeight:700, color:copied==="blink"?C.gold:C.text }}>
                  {copied==="blink" ? "Copied!" : "Copy Bookie Link"}
                </span>
              </button>
            </>
          ) : (
            <div style={{ padding:"6px 14px 10px", fontSize:9, color:C.muted, lineHeight:1.6 }}>
              Book this ticket first — then tap Share to copy your booking code or link.
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── EXCLUDE MARKETS PANEL ────────────────────────────────────────────────
// Collapsible panel in the Custom Parley tab. Engine pool markets only —
// no DNB or Asian Handicap which don't appear in engine output.
// Chevron + active count make it obvious it's tappable.
function ExcludeMarketsPanel({ excluded, toggle, clear }) {
  const [open, setOpen] = useState(false);
  const activeCount = excluded.size;

  return (
    <div style={{ marginBottom:12, borderRadius:10,
      border:`1px solid ${activeCount > 0 ? C.red+"50" : C.border}`,
      background: activeCount > 0 ? `${C.red}05` : C.surface,
      overflow:"hidden", transition:"border-color .15s" }}>

      {/* Header — always visible, tap to expand */}
      <button onClick={() => setOpen(o => !o)}
        style={{ width:"100%", display:"flex", alignItems:"center", justifyContent:"space-between",
          padding:"10px 12px", background:"transparent", border:"none",
          cursor:"pointer", fontFamily:C.font }}>
        <div style={{ display:"flex", alignItems:"center", gap:8 }}>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke={activeCount > 0 ? C.red : C.muted}
            strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="10"/>
            <line x1="8" y1="12" x2="16" y2="12"/>
          </svg>
          <span style={{ fontSize:9, fontWeight:700, color: activeCount > 0 ? C.red : C.text }}>
            Exclude Markets
          </span>
          {activeCount > 0 && (
            <span style={{ fontSize:7, fontWeight:800, color:C.red,
              background:`${C.red}15`, border:`1px solid ${C.red}30`,
              borderRadius:4, padding:"1px 6px" }}>
              {activeCount} active
            </span>
          )}
        </div>
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke={C.muted}
          strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"
          style={{ transform: open ? "rotate(180deg)" : "none", transition:"transform .2s", flexShrink:0 }}>
          <polyline points="6 9 12 15 18 9"/>
        </svg>
      </button>

      {/* Expandable content */}
      {open && (
        <div style={{ padding:"0 12px 12px" }}>
          <div style={{ fontSize:8, color:C.muted, marginBottom:8, lineHeight:1.5 }}>
            Picks using excluded selections won't be used when building tickets.
          </div>
          <div style={{ display:"flex", flexDirection:"column", gap:8 }}>
            {EXCLUDE_SELECTION_GROUPS.map(group => (
              <div key={group.label}>
                <div style={{ fontSize:7, color:C.muted, letterSpacing:".08em", fontWeight:700, textTransform:"uppercase", marginBottom:4 }}>
                  {group.label}
                </div>
                <div style={{ display:"flex", flexWrap:"wrap", gap:6 }}>
                  {group.options.map(({ id, label }) => {
                    const on = excluded.has(id);
                    return (
                      <button key={id} onClick={() => toggle(id)}
                        style={{ padding:"5px 12px", borderRadius:7, cursor:"pointer",
                          fontFamily:C.font, fontSize:9, fontWeight: on ? 700 : 500,
                          background: on ? `${C.red}15` : "transparent",
                          color: on ? C.red : C.muted,
                          border:`1px solid ${on ? C.red+"50" : C.border}`,
                          display:"flex", alignItems:"center", gap:5,
                          transition:"all .12s" }}>
                        {on && (
                          <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                            strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                            <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
                          </svg>
                        )}
                        {label}
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
          {activeCount > 0 && (
            <button onClick={clear}
              style={{ marginTop:8, fontSize:8, color:C.muted, background:"transparent",
                border:`1px solid ${C.border}`, borderRadius:6, padding:"3px 10px",
                cursor:"pointer", fontFamily:C.font }}>
              Clear all
            </button>
          )}
        </div>
      )}
    </div>
  );
}

// ── N19: GRM LOAD PANEL ───────────────────────────────────────────────────
// Input box in builder tab. Accepts a GRM code (GXXXXX) or full ?grm= link.
// On load: fetches ticket, saves to Saved Tickets, switches to parley view.
function GrmLoadPanel({ onLoaded }) {
  const [input,   setInput]   = useState("");
  const [loading, setLoading] = useState(false);
  const [error,   setError]   = useState(null);
  const [ok,      setOk]      = useState(false);

  const extractCode = (raw) => {
    const trimmed = raw.trim().toUpperCase();
    // Direct code
    if (/^G[A-Z0-9]{5}$/.test(trimmed)) return trimmed;
    // From URL ?grm=GXXXXX
    try {
      const url = new URL(raw.trim());
      const p = url.searchParams.get("grm");
      if (p && /^G[A-Z0-9]{5}$/i.test(p)) return p.toUpperCase();
    } catch {}
    return null;
  };

  const handleLoad = async () => {
    const code = extractCode(input);
    if (!code) { setError("Enter a valid GRM code (e.g. GABCDE) or paste a GRM link."); return; }
    setLoading(true); setError(null);
    try {
      const res = await fetch(`${SERVER}/api/ticket/${code}`);
      if (res.status === 404) throw new Error("Ticket not found — check the code.");
      if (res.status === 410) throw new Error("This link has expired (30 days).");
      if (!res.ok) throw new Error("Failed to load ticket.");
      const { ticket } = await res.json();
      setOk(true);
      setTimeout(() => setOk(false), 2000);
      setInput("");
      if (onLoaded) onLoaded(ticket, code);
    } catch (e) {
      setError(friendlyError(e, "Ticket lookup"));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{ marginTop:16, padding:"14px 16px",
                  background:C.faint, border:`1px solid ${C.border}`, borderRadius:10 }}>
      <div style={{ fontSize:8, fontWeight:800, color:C.muted, letterSpacing:".1em",
                    textTransform:"uppercase", marginBottom:10,
                    display:"flex", alignItems:"center", gap:6 }}>
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke={C.muted} strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/>
          <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>
        </svg>
        Load Shared Ticket
      </div>

      <div style={{ display:"flex", gap:8, alignItems:"stretch" }}>
        <input
          className="gi"
          value={input}
          onChange={e => { setInput(e.target.value); setError(null); }}
          onKeyDown={e => e.key === "Enter" && handleLoad()}
          placeholder="Paste GRM code or link…"
          style={{ flex:1, fontSize:11, padding:"9px 12px" }}
        />
        <button onClick={handleLoad} disabled={loading || !input.trim()} className="gb-primary"
          style={{ padding:"0 16px", fontSize:10, fontWeight:800, borderRadius:8,
                   opacity: loading || !input.trim() ? 0.5 : 1,
                   minWidth:60, display:"flex", alignItems:"center", gap:6 }}>
          {loading
            ? <span className="pu" style={{ fontSize:9 }}>…</span>
            : ok
            ? <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
            : "Load"
          }
        </button>
      </div>

      {error && (
        <div style={{ marginTop:7, fontSize:9, color:C.red, fontWeight:600 }}>{error}</div>
      )}
    </div>
  );
}


// C6-FIX (illegal hook): TicketActions extracted from a (() => { useState })() IIFE
// inside TicketCard's JSX. Hooks called inside IIFE callbacks in JSX throw
// "Invalid hook call" — React rules require hooks at the top of a component.
// Extracted as a named component so useState is legal here.
function TicketActions({ ticket, onRemove, onEditDraft, onAddLegs, onRemix, remixing, accentBdr }) {
  const [addLegsOpen,      setAddLegsOpen]      = useState(false);
  const [makeChangesOpen,  setMakeChangesOpen]  = useState(false);
  const [selectedLegs,     setSelectedLegs]     = useState(new Set());
  const sheetRef = useRef(null);

  // P-FIX: on a long ticket, opening this sheet while scrolled near the top
  // blurs the background but the sheet itself can render below the fold —
  // looks like nothing happened. Bring it into view the instant it opens.
  useEffect(() => {
    if (makeChangesOpen) {
      sheetRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
    }
  }, [makeChangesOpen]);

  const toggleLegSelect = (id) => setSelectedLegs(prev => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  const confirmAddLegs = (candidates) => {
    candidates.filter(({ f }) => selectedLegs.has(f.id))
              .forEach(({ f, pick }) => onAddLegs.addLeg(f, pick));
    setAddLegsOpen(false);
    setMakeChangesOpen(false);
    setSelectedLegs(new Set());
  };

  const candidates = addLegsOpen && onAddLegs ? (() => {
    const ticketIds = new Set((ticket.legs||[]).map(l => l.fixtureId));
    return (onAddLegs.fixtures || [])
      .filter(f => {
        if (ticketIds.has(f.id)) return false;
        const st = (f.state||"").toLowerCase().replace(/[_\-\s]/g,"");
        return !["finished","ft","fulltime","ended","complete","aet","postponed","ppd","cancelled","canceled"].includes(st);
      })
      .map(f => {
        const anchor = f.theRead?.anchor;
        if (!anchor || f.theRead?.isFallback) return null;
        return { f, pick: anchor };
      })
      .filter(Boolean)
      .sort((a,b) => b.pick.prob - a.pick.prob)
      .slice(0, 20);
  })() : [];

  const noneSelected = selectedLegs.size === 0;
  const hasMakeChanges = onEditDraft || onAddLegs;

  return (
    <>
      {/* Action row */}
      <div style={{ display:"flex", gap:6, alignItems:"center",
        marginBottom: addLegsOpen ? 8 : 12,
        paddingBottom:10,
        borderBottom: addLegsOpen ? `1px solid ${accentBdr}` : undefined }}>

        {/* Make Changes — collapses Edit + Add More Legs */}
        {hasMakeChanges && (
          <button onClick={() => setMakeChangesOpen(true)}
            style={{ padding:"5px 11px", fontSize:10, fontWeight:700,
                     background:"transparent", border:`1px solid ${C.accent}40`,
                     borderRadius:7, color:C.accent, cursor:"pointer",
                     fontFamily:C.font, display:"flex", alignItems:"center", gap:5 }}>
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor"
              strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
              <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
            </svg>
            Make Changes
          </button>
        )}

        {/* Remix — stays independent */}
        {onRemix && (
          <button onClick={remixing ? undefined : onRemix}
            style={{ padding:"5px 11px", fontSize:10, fontWeight:700,
                     background:"transparent", border:`1px solid ${C.radar}35`,
                     borderRadius:7, color: remixing ? C.muted : C.radar,
                     cursor: remixing ? "not-allowed" : "pointer", opacity: remixing ? 0.6 : 1,
                     fontFamily:C.font, display:"flex", alignItems:"center", gap:5 }}>
            {remixing
              ? <span className="pu" style={{ fontSize:9 }}>Remixing…</span>
              : <>
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                    strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="16 3 21 3 21 8"/><line x1="4" y1="20" x2="21" y2="3"/>
                    <polyline points="21 16 21 21 16 21"/><line x1="15" y1="15" x2="21" y2="21"/>
                  </svg>
                  Remix
                </>
            }
          </button>
        )}

        <div style={{ flex:1 }}/>

        {/* Remove — SVG X */}
        <button onClick={onRemove}
          style={{ background:"none", border:"none", color:C.muted, cursor:"pointer",
                   padding:4, display:"flex", alignItems:"center" }}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
            strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
          </svg>
        </button>
      </div>

      {/* Make Changes — bottom sheet */}
      {makeChangesOpen && (
        <div style={{ position:"fixed", inset:0, zIndex:9000,
                      background:"rgba(0,0,0,.55)", backdropFilter:"blur(4px)",
                      display:"flex", alignItems:"flex-end" }}
          onClick={() => { setMakeChangesOpen(false); setAddLegsOpen(false); setSelectedLegs(new Set()); }}>
          <div onClick={e => e.stopPropagation()} ref={sheetRef} style={{
            width:"100%", background:C.surface,
            borderRadius:"20px 20px 0 0",
            border:`1px solid ${C.border}`,
            padding:"20px 20px 36px",
            fontFamily:C.font,
            boxShadow:"0 -8px 32px rgba(0,0,0,.28)",
          }}>
            {/* Handle */}
            <div style={{ width:36, height:4, borderRadius:2, background:C.faint, margin:"0 auto 18px" }} />

            {!addLegsOpen ? (
              <>
                <div style={{ fontSize:12, fontWeight:800, color:C.text, marginBottom:4 }}>Make Changes</div>
                <div style={{ fontSize:9, color:C.muted, marginBottom:18, lineHeight:1.5 }}>
                  Edit legs or add more matches to this ticket.
                </div>
                <div style={{ display:"flex", flexDirection:"column", gap:8 }}>
                  {onEditDraft && (
                    <button onClick={() => { onEditDraft(ticket.legs||[]); setMakeChangesOpen(false); }}
                      style={{ width:"100%", padding:"13px 16px", borderRadius:12, cursor:"pointer",
                               background:C.surface, border:`1px solid ${C.border}`,
                               fontFamily:C.font, display:"flex", alignItems:"center", gap:12,
                               transition:"background .12s" }}
                      onMouseEnter={e => e.currentTarget.style.background = C.faint}
                      onMouseLeave={e => e.currentTarget.style.background = C.surface}>
                      <div style={{ width:36, height:36, borderRadius:10,
                        background:`${C.accent}12`, border:`1px solid ${C.accent}25`,
                        display:"flex", alignItems:"center", justifyContent:"center", flexShrink:0 }}>
                        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke={C.accent}
                          strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
                          <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
                        </svg>
                      </div>
                      <div style={{ textAlign:"left" }}>
                        <div style={{ fontSize:12, fontWeight:800, color:C.text }}>Edit Legs</div>
                        <div style={{ fontSize:9, color:C.muted, marginTop:2 }}>
                          Send legs back to your builder to swap or remove picks
                        </div>
                      </div>
                    </button>
                  )}
                  {onAddLegs && (
                    <button onClick={() => setAddLegsOpen(true)}
                      style={{ width:"100%", padding:"13px 16px", borderRadius:12, cursor:"pointer",
                               background:C.surface, border:`1px solid ${C.border}`,
                               fontFamily:C.font, display:"flex", alignItems:"center", gap:12,
                               transition:"background .12s" }}
                      onMouseEnter={e => e.currentTarget.style.background = C.faint}
                      onMouseLeave={e => e.currentTarget.style.background = C.surface}>
                      <div style={{ width:36, height:36, borderRadius:10,
                        background:`${C.gold}12`, border:`1px solid ${C.gold}25`,
                        display:"flex", alignItems:"center", justifyContent:"center", flexShrink:0 }}>
                        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke={C.gold}
                          strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                          <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
                        </svg>
                      </div>
                      <div style={{ textAlign:"left" }}>
                        <div style={{ fontSize:12, fontWeight:800, color:C.text }}>Add More Legs</div>
                        <div style={{ fontSize:9, color:C.muted, marginTop:2 }}>
                          Pick additional matches from today's qualified pool
                        </div>
                      </div>
                    </button>
                  )}
                  <button onClick={() => setMakeChangesOpen(false)}
                    style={{ width:"100%", padding:"11px 0", borderRadius:10, cursor:"pointer",
                             background:"transparent", border:`1px solid ${C.border}`,
                             fontFamily:C.font, fontSize:11, color:C.muted }}>
                    Cancel
                  </button>
                </div>
              </>
            ) : (
              /* Add legs picker — shown after tapping Add More Legs */
              <>
                <div style={{ display:"flex", alignItems:"center", gap:10, marginBottom:14 }}>
                  <button onClick={() => { setAddLegsOpen(false); setSelectedLegs(new Set()); }}
                    style={{ background:"transparent", border:"none", color:C.muted, cursor:"pointer",
                             padding:4, display:"flex", alignItems:"center" }}>
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                      strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                      <line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/>
                    </svg>
                  </button>
                  <div>
                    <div style={{ fontSize:12, fontWeight:800, color:C.text }}>Add More Legs</div>
                    <div style={{ fontSize:8, color:C.muted }}>Select from today's qualified pool</div>
                  </div>
                  {!noneSelected && (
                    <button onClick={() => confirmAddLegs(candidates)}
                      style={{ marginLeft:"auto", padding:"6px 14px", fontSize:10, fontWeight:800,
                               background:C.gold, color:C.bg, border:"none", borderRadius:8,
                               cursor:"pointer", fontFamily:C.font }}>
                      Add {selectedLegs.size}
                    </button>
                  )}
                </div>
                {candidates.length === 0 ? (
                  <div style={{ padding:"24px 0", textAlign:"center", fontSize:9, color:C.muted }}>
                    No qualifying fixtures available to add.
                  </div>
                ) : (
                  <div style={{ display:"flex", flexDirection:"column", gap:5,
                    maxHeight:"40vh", overflowY:"auto" }}>
                    {candidates.map(({ f, pick }) => {
                      const checked = selectedLegs.has(f.id);
                      return (
                        <div key={f.id} onClick={() => toggleLegSelect(f.id)}
                          style={{ display:"flex", alignItems:"center", gap:8, padding:"8px 10px",
                                   background: checked ? `${C.gold}12` : C.faint,
                                   border:`1px solid ${checked ? C.gold : C.border}`,
                                   borderRadius:8, cursor:"pointer", transition:"all .12s" }}>
                          <div style={{ flexShrink:0, width:16, height:16, borderRadius:4,
                                        border:`1.5px solid ${checked ? C.gold : C.faint}`,
                                        background: checked ? C.gold : "transparent",
                                        display:"flex", alignItems:"center", justifyContent:"center" }}>
                            {checked && (
                              <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke={C.bg}
                                strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round">
                                <polyline points="20 6 9 17 4 12"/>
                              </svg>
                            )}
                          </div>
                          <div style={{ flex:1, minWidth:0 }}>
                            <div style={{ fontSize:9, fontWeight:700, color:C.text,
                              overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>
                              {f.teams.home} vs {f.teams.away}
                            </div>
                            <div style={{ fontSize:8, color:pick.color||C.gold, marginTop:1 }}>
                              {pick.pick} · {pick.odds ? `@${parseFloat(pick.odds).toFixed(2)}` : ""}
                            </div>
                          </div>
                          <div style={{ fontSize:11, fontWeight:800, color:C.gold, flexShrink:0 }}>
                            {Math.round(pick.prob)}%
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      )}
    </>
  );
}

function TicketCard({ ticket, date, onRemove, onRemoveLeg, onRemix, onSwapLeg, isJarvis, onOpenFixture, onSaveInternal, savedCode, remixing = false, onEditDraft, onAddLegs }) {
  const [stakeInput, setStakeInput] = useState(ticket.stake > 0 ? String(ticket.stake) : "");
  const stake      = parseFloat(stakeInput) || 0;
  const potential  = parseFloat((stake * parseFloat(ticket.totalOdds)).toFixed(2));
  const exhausted  = ticket.exhausted;
  const accentColor = isJarvis ? C.edge : C.gold;
  const accentBg    = isJarvis ? C.edgeDim : C.goldDim;
  const accentBdr   = isJarvis ? C.edgeBorder : C.goldBorder;
  const isManual    = ticket.source === "card_add" || ticket.source === "custom_selection";

  // P13-FIX: Correlation risk — detect legs from the same league or same match
  const [corrOpen, setCorrOpen] = useState(false);
  const corrRisks = (() => {
    const legs = ticket.legs || [];
    const leagueCounts = {};
    const matchCounts  = {};
    legs.forEach(l => {
      if (l.league) leagueCounts[l.league] = (leagueCounts[l.league] || 0) + 1;
      const matchKey = l.fixtureId || l.game;
      if (matchKey) matchCounts[matchKey] = (matchCounts[matchKey] || 0) + 1;
    });
    const risks = [];
    Object.entries(leagueCounts).forEach(([league, count]) => {
      if (count >= 2) risks.push({ type: "league", label: league, count });
    });
    Object.entries(matchCounts).forEach(([key, count]) => {
      if (count >= 2) {
        const leg = legs.find(l => (l.fixtureId || l.game) === key);
        risks.push({ type: "match", label: leg?.game || key, count });
      }
    });
    return risks;
  })();
  const hasCorr = corrRisks.length > 0;



  return (
    <div className="gc" style={{ padding:"16px 18px", background:accentBg, border:`1px solid ${accentBdr}` }}>

      {/* ── Header row 1: identity + odds + save ── */}
      <div style={{ display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:8 }}>
        <div style={{ display:"flex",gap:6,alignItems:"center",flexWrap:"wrap" }}>
          {isJarvis && (() => {
            const modeColors = { safe:C.green, value:C.gold, longshot:C.red };
            const modeColor  = modeColors[ticket.jarvisMode] || C.edge;
            return (
              <span style={{ fontSize:9,color:modeColor,fontWeight:900,letterSpacing:".1em",textTransform:"uppercase",
                             background:`${modeColor}12`, padding:"2px 7px", borderRadius:5,
                             border:`1px solid ${modeColor}35` }}>
                {ticket.jarvisMode ? ticket.jarvisMode.toUpperCase() : "JARVIS"}
              </span>
            );
          })()}
          {/* Only show slotLabel when it adds info beyond the mode badge */}
          {(() => {
            const modeLabels = ["safe","value","longshot"];
            const isDupOfBadge = isJarvis && ticket.jarvisMode && ticket.slotLabel &&
              modeLabels.some(m => ticket.slotLabel.toLowerCase().startsWith(m));
            if (isDupOfBadge) return null;
            return ticket.slotLabel
              ? <span style={{ fontSize:11,fontWeight:800,color:accentColor }}>{ticket.slotLabel}</span>
              : <span style={{ fontSize:11,fontWeight:800,color:accentColor }}>Ticket #{ticket.id}</span>;
          })()}
          {exhausted && (
            <span className="grm-chip" style={{ color:C.amber,borderColor:`${C.amber}40`,background:C.amberDim }}>
              ⚠ Exhausted
            </span>
          )}
          {/* B3.2: notice when finished legs were excluded from RE-ADD */}
          {ticket._finishedExcluded > 0 && (
            <span className="grm-chip" style={{ color:C.muted,borderColor:`${C.border}`,background:"transparent",fontSize:8 }}>
              {ticket._finishedExcluded} finished leg{ticket._finishedExcluded > 1 ? "s" : ""} excluded
            </span>
          )}
        </div>
        <div style={{ display:"flex",gap:8,alignItems:"center" }}>
          <span style={{ fontSize:13,color:C.text,fontWeight:800 }}>×{ticket.totalOdds}</span>
          {/* P13-FIX: Correlation risk badge — renamed "Risk" for clarity */}
          {hasCorr && (
            <div style={{ position:"relative" }}>
              <button onClick={() => setCorrOpen(o => !o)}
                title="Tap to see which legs share a match or league"
                style={{ background:`${C.amber}15`, border:`1px solid ${C.amber}40`,
                         borderRadius:7, padding:"3px 8px", cursor:"pointer",
                         display:"flex", alignItems:"center", gap:4, fontFamily:C.font }}>
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none"
                  stroke={C.amber} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
                  <line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>
                </svg>
                <span style={{ fontSize:8, fontWeight:800, color:C.amber }}>Risk</span>
              </button>
              {corrOpen && (
                <div style={{ position:"absolute", top:"calc(100% + 6px)", right:0, zIndex:9999,
                              background:C.surface, border:`1px solid ${C.amber}40`,
                              borderRadius:10, padding:"10px 14px", minWidth:210,
                              boxShadow:"0 8px 24px rgba(0,0,0,.18)" }}>
                  <div style={{ fontSize:8, fontWeight:800, color:C.amber, letterSpacing:".08em",
                                textTransform:"uppercase", marginBottom:6 }}>
                    Leg Risk — what this means
                  </div>
                  <div style={{ fontSize:9, color:C.muted, lineHeight:1.6, marginBottom:8 }}>
                    Some legs in this ticket share a match or league. When legs are connected, one outcome can cancel another — parlay math assumes they're independent.
                  </div>
                  {corrRisks.map((r, i) => (
                    <div key={i} style={{ fontSize:9, color:C.text, marginBottom:5, lineHeight:1.5,
                      padding:"5px 8px", background:`${C.amber}08`, borderRadius:6,
                      border:`1px solid ${C.amber}20` }}>
                      {r.type === "match"
                        ? <><span style={{ color:C.red, fontWeight:700 }}>Same match</span> — {r.count} legs from <em>{r.label}</em>. Their outcomes are directly linked.</>
                        : <><span style={{ color:C.amber, fontWeight:700 }}>Same league</span> — {r.count} legs from <em>{r.label}</em>. Results can move together.</>
                      }
                    </div>
                  ))}
                  <div style={{ fontSize:8, color:C.muted, marginTop:6, lineHeight:1.5,
                    borderTop:`1px solid ${C.border}`, paddingTop:6 }}>
                    Not a block — just a flag. You can still build and book the ticket.
                  </div>
                </div>
              )}
            </div>
          )}
          <GrmShareMenu ticket={ticket} bookieResult={null} />
          {savedCode
            ? <span className="grm-chip" style={{ color:C.green,borderColor:`${C.green}40`,background:C.greenDim }}>✓ {savedCode}</span>
            : onSaveInternal && !exhausted && (
              <button onClick={() => onSaveInternal(stake)} className="gb-ghost"
                style={{ padding:"4px 11px",fontSize:10,color:accentColor,borderColor:`${accentColor}40`,
                         display:"flex",alignItems:"center",gap:5 }}>
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/>
                </svg>
                Save
              </button>
            )
          }
        </div>
      </div>

      {/* ── Header row 2: actions ── */}
      {!exhausted && (
        <TicketActions
          ticket={ticket}
          onRemove={onRemove}
          onEditDraft={onEditDraft}
          onAddLegs={onAddLegs}
          onRemix={onRemix}
          remixing={remixing}
          accentBdr={accentBdr}
        />
      )}

      {/* ── Exhausted state ── */}
      {/* N5-FIX: Exhausted state — shown for both Jarvis and Custom tickets.
           Custom tickets previously silently returned fewer legs with no explanation. */}
      {exhausted && (
        <div style={{ display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:10 }}>
          <div style={{ flex:1 }}>
            {isJarvis ? (
              <>
                <div style={{ fontSize:10,color:C.amber,fontWeight:700,marginBottom:5 }}>⚠ Pool exhausted before reaching target odds</div>
                <div style={{ fontSize:9,color:C.text,marginBottom:6,lineHeight:1.5 }}>{ticket.jarvisReason}</div>
                {ticket.saturatedMarkets?.length > 0
                  ? <div style={{ fontSize:9,color:C.muted }}>Market cap of {ticket.maxSameMarket} blocked more {ticket.saturatedMarkets.join("/")} picks.</div>
                  : ticket.poolSize < 4
                    ? <div style={{ fontSize:9,color:C.muted }}>Only {ticket.poolSize} game{ticket.poolSize!==1?"s":""} qualified. Lower Target Odds or fetch a fresh snapshot.</div>
                    : <div style={{ fontSize:9,color:C.muted }}>All {ticket.poolSize} qualifying games used. Lower Target Odds for a shorter ticket.</div>
                }
              </>
            ) : (
              <>
                <div style={{ fontSize:10,color:C.amber,fontWeight:700,marginBottom:5 }}>⚠ Fewer legs than requested</div>
                <div style={{ fontSize:9,color:C.muted,lineHeight:1.5 }}>
                  Only {ticket.legs?.length ?? 0} qualifying game{ticket.legs?.length !== 1 ? "s" : ""} found
                  {ticket.poolSize != null ? ` from a pool of ${ticket.poolSize}` : ""} — couldn't reach your target.
                  Try lowering leg count, removing the league filter, or adding more games to your custom list.
                </div>
              </>
            )}
          </div>
          <button onClick={onRemove}
            style={{ background:"none",border:"none",color:C.muted,cursor:"pointer",fontSize:16,padding:"0 2px",flexShrink:0 }}>✕</button>
        </div>
      )}

      {/* ── Jarvis confidence bar ── */}
      {isJarvis && !exhausted && ticket.jarvisConf != null && (
        <div style={{ marginBottom:10,background:`${C.edge}08`,borderRadius:10,padding:"8px 11px",border:`1px solid ${C.edge}20` }}>
          <div style={{ fontSize:9,color:C.edge,fontWeight:800,textTransform:"uppercase",letterSpacing:".1em",marginBottom:4 }}>Jarvis Confidence</div>
          <div style={{ display:"flex",alignItems:"center",gap:8 }}>
            <div className="cb" style={{ flex:1 }}>
              <div className="cf" style={{ width:`${ticket.jarvisConf}%`,background:C.edge }}/>
            </div>
            <span style={{ fontSize:10,color:C.edge,fontWeight:800 }}>{ticket.jarvisConf}%</span>
          </div>
          {ticket.jarvisReason && (
            <div style={{ fontSize:9,color:C.muted,marginTop:4,lineHeight:1.45 }}>{ticket.jarvisReason}</div>
          )}
        </div>
      )}

      {/* ── Legs ── */}
      {!exhausted && (
        <div style={{ display:"flex",flexDirection:"column",gap:6,marginBottom:12 }}>
          {(ticket.legs||[]).map((leg, i) => (
            <div key={i} style={{
              background:`${accentColor}07`,
              borderRadius:12,padding:"9px 12px",
              border:`1px solid ${accentColor}18`,position:"relative"
            }}>
              {leg.strategyLabel && (
                <div style={{ fontSize:8,color:C.amber,fontWeight:800,textTransform:"uppercase",letterSpacing:".08em",marginBottom:3 }}>
                  {leg.strategyLabel}
                </div>
              )}
              <div style={{ display:"flex",justifyContent:"space-between",alignItems:"flex-start" }}>
                <div style={{ flex:1,minWidth:0 }}>
                  {onOpenFixture && leg.fixtureId ? (
                    <button onClick={() => onOpenFixture(leg.fixtureId)}
                      style={{ background:"none",border:"none",color:C.radar,cursor:"pointer",
                               fontSize:10,fontWeight:700,textAlign:"left",fontFamily:C.font,
                               padding:0,marginBottom:3,lineHeight:1.3 }}>
                      {leg.game} →
                    </button>
                  ) : (
                    <div style={{ fontSize:10,color:C.text,fontWeight:600,marginBottom:3,lineHeight:1.3 }}>{leg.game}</div>
                  )}
                </div>
                <div style={{ display:"flex",gap:5,alignItems:"center",flexShrink:0,marginLeft:8 }}>
                  {onSwapLeg && (
                    <button onClick={() => onSwapLeg(i)} className="gb-ghost"
                      title="Swap this leg with the next qualifying game from the pool"
                      style={{ padding:"5px 7px",color:C.radar,borderColor:`${C.radar}35`,
                               display:"flex",alignItems:"center",justifyContent:"center" }}>
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="none"
                           stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M21 2v6h-6"/>
                        <path d="M3 12a9 9 0 0 1 15-6.7L21 8"/>
                        <path d="M3 22v-6h6"/>
                        <path d="M21 12a9 9 0 0 1-15 6.7L3 16"/>
                      </svg>
                    </button>
                  )}
                  {onRemoveLeg && (
                    <button onClick={() => onRemoveLeg(i)}
                      style={{ background:"none",border:"none",color:C.muted,cursor:"pointer",fontSize:13,padding:0,lineHeight:1 }}>✕</button>
                  )}
                </div>
              </div>

              {leg._result && (
                <div style={{ fontSize:9,fontWeight:800,marginBottom:4,
                  color:leg._result==="WIN"?C.green:leg._result==="LOSS"?C.red:C.muted }}>
                  {leg._result==="WIN"?"✓":leg._result==="LOSS"?"✕":"–"} {leg._result}
                  {leg._score && <span style={{ fontWeight:400,color:C.muted,marginLeft:5 }}>{leg._score}</span>}
                </div>
              )}

              <div style={{ display:"flex",justifyContent:"space-between",alignItems:"center",marginTop:4 }}>
                <div style={{ display:"flex",gap:5,alignItems:"center",flexWrap:"wrap" }}>
                  {leg.market && leg.market !== "Unknown" && (
                    <Pill color={mktStyle(leg.market||"").color} bg={mktStyle(leg.market||"").bg}>{leg.market}</Pill>
                  )}
                  {leg.isVolatile && (
                    <Pill color={C.muted} bg="transparent">volatile</Pill>
                  )}
                  <span style={{ fontSize:10,color:mktStyle(leg.market && leg.market !== "Unknown" ? leg.market : "1X2").color,fontWeight:700 }}>
                    {leg.pick}
                  </span>
                </div>
                <div style={{ textAlign:"right",flexShrink:0 }}>
                  <span style={{ fontSize:11,fontWeight:800,color:accentColor }}>{leg.odds ? `${parseFloat(leg.odds).toFixed(2)}x` : "—"}</span>
                  <span style={{ fontSize:9,color:C.muted,marginLeft:5 }}>({Math.round(leg.conf||0)}%)</span>
                  {leg.empiricalRate != null && (
                    <div style={{ fontSize:8,color:C.radar,marginTop:1 }}>{leg.empiricalRate}% hist</div>
                  )}
                </div>
              </div>
              {/* C2-FIX: Jarvis Research Mode pre-score reason per leg.
                  Stored by applyJarvisPreScore but never rendered — users saw
                  "Jarvis pre-scored candidates" without knowing why each game
                  was boosted or penalised. Green = boosted, amber = flagged. */}
              {leg.jarvisReason && (
                <div style={{ display:"flex",alignItems:"flex-start",gap:5,marginTop:5,
                  padding:"4px 7px",borderRadius:5,
                  background: (leg.jarvisAdjustment||0) >= 0 ? `${C.green}0a` : `${C.amber}0a`,
                  border:`1px solid ${(leg.jarvisAdjustment||0) >= 0 ? `${C.green}25` : `${C.amber}25`}` }}>
                  <span style={{ fontSize:9,fontWeight:800,flexShrink:0,
                    color:(leg.jarvisAdjustment||0) >= 0 ? C.green : C.amber }}>
                    {(leg.jarvisAdjustment||0) >= 0 ? "▲" : "▼"}{leg.jarvisAdjustment != null ? ` ${leg.jarvisAdjustment >= 0?"+":""}${Math.round(leg.jarvisAdjustment*100)}pts` : ""}
                  </span>
                  <span style={{ fontSize:8,color:C.muted,lineHeight:1.4 }}>{leg.jarvisReason}</span>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* ── Book Now ── */}
      {!exhausted && ticket.legs?.length > 0 && (
        <TicketBookNowButton legs={ticket.legs} />
      )}

      {/* ── Stake + return ── */}
      {!exhausted && (
        <div style={{ paddingTop:12,borderTop:`1px solid ${accentBdr}`,marginTop:6 }}>
          <div style={{ fontSize:9,color:C.muted,fontWeight:700,letterSpacing:".08em",textTransform:"uppercase",marginBottom:12 }}>
            Estimated Return
          </div>
          <div style={{ display:"flex",justifyContent:"space-between",alignItems:"center" }}>
            <div>
              <div style={{ fontSize:9,color:C.muted,textTransform:"uppercase",letterSpacing:".08em",marginBottom:5 }}>Stake</div>
              {isManual ? (
                <div style={{ display:"flex",alignItems:"center",gap:6 }}>
                  <span style={{ fontSize:12,color:C.muted }}>$</span>
                  <input type="number" value={stakeInput} onChange={e=>setStakeInput(e.target.value)}
                    placeholder="0.00" className="gi"
                    style={{ width:85,padding:"5px 8px",fontSize:13,fontWeight:800,color:C.text }}
                    onFocus={e=>e.target.select()}/>
                </div>
              ) : (
                <div style={{ fontSize:18,fontWeight:800,color:C.text }}>${stake.toFixed(2)}</div>
              )}
            </div>
            <div style={{ textAlign:"right" }}>
              <div style={{ fontSize:9,color:C.green,textTransform:"uppercase",letterSpacing:".08em",marginBottom:3 }}>
                {stake > 0 ? "Potential Return" : `×${ticket.totalOdds} odds`}
              </div>
              <div style={{ fontSize:18,fontWeight:800,color:stake > 0 ? C.green : C.muted }}>
                {stake > 0 ? `$${potential}` : "Enter stake"}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── Saturation notice ── */}
      {ticket.saturatedMarkets?.length > 0 && (
        <div style={{ background:`${C.amber}08`,border:`1px solid ${C.amber}25`,borderRadius:10,padding:"10px 13px",marginTop:10 }}>
          <div style={{ fontSize:10,color:C.amber,fontWeight:800,marginBottom:5 }}>
            ⚠ Market cap of {ticket.maxSameMarket} reached — {ticket.saturatedMarkets.join(", ")}
          </div>
          <div style={{ fontSize:9,color:C.muted,marginBottom:8,lineHeight:1.5 }}>
            More games qualify but share the same market. Raise Max Same Market or lower Target Odds.
          </div>
          {onRemix && (
            <button onClick={remixing ? undefined : onRemix} className="gb-ghost"
              style={{ padding:"5px 14px",fontSize:10,color:C.radar,borderColor:`${C.radar}35`,
                       opacity:remixing?0.6:1,cursor:remixing?"not-allowed":"pointer" }}>
              {remixing ? <span className="pu">Remixing…</span> : "Remix"}
            </button>
          )}
        </div>
      )}

      {/* P11-FIX: Ask Jarvis — faint footer on every ticket. Infrastructure (/api/jarvis-analyse) is live. */}
      {ticket.legs?.length > 0 && !exhausted && (
        <_AskJarvisFooter ticket={ticket} SERVER={window.__GRM_SERVER__ || "http://localhost:3000"} />
      )}
    </div>
  );
}

// ── P11: Ask Jarvis footer — self-contained, sits at bottom of every TicketCard ──
function _AskJarvisFooter({ ticket, SERVER }) {
  const [analysis,  setAnalysis]  = useState(null);
  const [analysisMeta, setAnalysisMeta] = useState(null); // N4-FIX: { cached, ageH }
  const [analysing, setAnalysing] = useState(false);
  const [open,      setOpen]      = useState(false);

  const run = async () => {
    if (analysing) return;
    setAnalysing(true); setOpen(true);
    try {
      const res  = await fetch(`${SERVER}/api/jarvis-analyse`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ticket }),
      });
      const data = await res.json();
      if (!res.ok || data.error) throw new Error(data.error || "Analysis failed");
      setAnalysis(data.analysis || data.message || "No analysis returned.");
      setAnalysisMeta({ cached: data.cached || false, ageH: data.ageH || null });
    } catch(e) {
      const msg = (e.message || "").toLowerCase();
      setAnalysis(msg.includes("429") || msg.includes("rate")
        ? "Jarvis hit a rate limit — try again in a minute."
        : "Jarvis is busy right now. Tap again to retry.");
    }
    setAnalysing(false);
  };

  return (
    <div style={{ borderTop:`1px solid ${C.faint}`, marginTop:10, paddingTop:8 }}>
      {!open ? (
        <button onClick={run}
          style={{ width:"100%", background:"transparent", border:`1px solid ${C.faint}`,
                   borderRadius:8, padding:"6px 0", fontSize:9, fontWeight:700,
                   color:C.muted, cursor:"pointer", fontFamily:C.font,
                   display:"flex", alignItems:"center", justifyContent:"center", gap:6,
                   transition:"border-color .15s, color .15s" }}
          onMouseEnter={e => { e.currentTarget.style.borderColor=`${C.edge}60`; e.currentTarget.style.color=C.edge; }}
          onMouseLeave={e => { e.currentTarget.style.borderColor=C.faint; e.currentTarget.style.color=C.muted; }}>
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
          </svg>
          Ask Jarvis to explain picks
        </button>
      ) : (
        <div style={{ background:`${C.edge}07`, border:`1px solid ${C.edge}25`, borderRadius:8, padding:"10px 12px" }}>
          <div style={{ fontSize:8, fontWeight:800, color:C.edge, letterSpacing:".1em", textTransform:"uppercase", marginBottom:5 }}>
            Jarvis Analysis
          </div>
          {analysing
            ? <div style={{ fontSize:9,color:C.muted }}><span className="pu">Analysing…</span></div>
            : <div>
                {/* N4-FIX: cache indicator in footer */}
                {analysisMeta?.cached && (
                  <div style={{ display:"flex",alignItems:"center",gap:4,marginBottom:5 }}>
                    <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke={C.muted} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M23 4v6h-6"/><path d="M1 20v-6h6"/>
                      <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>
                    </svg>
                    <span style={{ fontSize:7,color:C.muted }}>
                      Cached{analysisMeta.ageH != null ? ` · ${analysisMeta.ageH < 1 ? "<1h" : `${analysisMeta.ageH}h`} ago` : ""}
                    </span>
                  </div>
                )}
                <div style={{ fontSize:9,color:C.text,lineHeight:1.6,whiteSpace:"pre-wrap" }}>{analysis}</div>
              </div>
          }
          {!analysing && (
            <div style={{ display:"flex", gap:6, marginTop:8 }}>
              <button onClick={run}
                style={{ fontSize:8,padding:"3px 10px",background:"transparent",border:`1px solid ${C.faint}`,color:C.muted,borderRadius:5,cursor:"pointer",fontFamily:C.font }}>
                ↺ Re-analyse
              </button>
              <button onClick={() => { setOpen(false); setAnalysis(null); }}
                style={{ fontSize:8,padding:"3px 10px",background:"transparent",border:`1px solid ${C.faint}`,color:C.muted,borderRadius:5,cursor:"pointer",fontFamily:C.font }}>
                Dismiss
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── JARVIS TICKET CARD ────────────────────────────────────────────────────
function JarvisTicketCard({ ticket, onOpenFixture, onRemove, date, onSaveInternal, savedCode, onRemix, onSwapLeg, onEditDraft, onAddLegs }) {
  const [analysis, setAnalysis] = useState(null);
  const [analysisMeta, setAnalysisMeta] = useState(null); // N4-FIX
  const [analysing, setAnalysing] = useState(false);

  const handleAnalyse = async () => {
    setAnalysing(true);
    try {
      // Call server-side Gemini endpoint
      const backtestSummary = await fetch(`${SERVER}/api/backtest-summary`).then(r=>r.json()).catch(()=>null);
      const res = await fetch(`${SERVER}/api/jarvis-analyse`, {
        method: "POST",
        headers: { "Content-Type":"application/json" },
        body: JSON.stringify({ ticket, backtestSummary, mode:"analyse" }),
      });
      const data = await res.json();
      setAnalysis(data.analysis || "Analysis unavailable.");
      setAnalysisMeta({ cached: data.cached || false, ageH: data.ageH || null }); // N4-FIX
    } catch(e) {
      setAnalysis(`Jarvis is busy right now — ${e.message?.toLowerCase().includes("429") || e.message?.toLowerCase().includes("rate") ? "rate limit hit, try again in a minute." : "tap Analyse to retry."}`);
    }
    setAnalysing(false);
  };

  return (
    <div style={{ marginBottom:14 }}>
      <TicketCard
        ticket={ticket} date={date} isJarvis={true}
        onRemove={onRemove} onOpenFixture={onOpenFixture}
        onSaveInternal={onSaveInternal}
        savedCode={savedCode}
        onRemix={onRemix} onSwapLeg={onSwapLeg}
        onEditDraft={onEditDraft}
        onAddLegs={onAddLegs}
      />
      {!ticket.exhausted && (
        <>
          <button onClick={handleAnalyse} disabled={analysing} className="gb-ghost"
            style={{ marginTop:8,padding:"7px 16px",fontSize:10,color:C.edge,borderColor:C.edgeBorder,
                     display:"flex",alignItems:"center",gap:6 }}>
            {analysing
              ? <span className="pu">Analysing…</span>
              : <>
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
                  </svg>
                  Analyse with Jarvis
                </>
            }
          </button>
          {analysis && (
            <div style={{ marginTop:8,background:C.surface,border:`1px solid ${C.edgeBorder}`,
                          borderRadius:"var(--r-lg)",padding:"12px 14px" }}>
              {/* N4-FIX: cache indicator */}
              {analysisMeta?.cached && (
                <div style={{ display:"flex", alignItems:"center", gap:5, marginBottom:8,
                              paddingBottom:8, borderBottom:`1px solid ${C.border}` }}>
                  <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke={C.muted}
                    strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M23 4v6h-6"/><path d="M1 20v-6h6"/>
                    <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>
                  </svg>
                  <span style={{ fontSize:8, color:C.muted, fontWeight:600 }}>
                    Cached analysis{analysisMeta.ageH != null ? ` · ${analysisMeta.ageH < 1 ? "<1h" : `${analysisMeta.ageH}h`} ago` : ""}
                  </span>
                </div>
              )}
              <div style={{ fontSize:11, color:C.text, lineHeight:1.65 }}>{analysis}</div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ── DRAFT TICKET BANNER ───────────────────────────────────────────────────
function DraftTicketBanner({ draftLegs, onOpen, onClear }) {
  const [visible, setVisible] = useState(false);
  const [prevCount, setPrevCount] = useState(0);
  const hideTimer = useRef(null);

  useEffect(() => {
    if (draftLegs.length > prevCount && draftLegs.length > 0) {
      // A new leg was added — show banner, auto-hide after 3s
      setVisible(true);
      clearTimeout(hideTimer.current);
      hideTimer.current = setTimeout(() => setVisible(false), 3000);
    }
    if (draftLegs.length === 0) setVisible(false);
    setPrevCount(draftLegs.length);
    return () => clearTimeout(hideTimer.current);
  }, [draftLegs.length]);

  if (!draftLegs.length || !visible) return null;

  const prod = draftLegs.reduce((s,l) => parseFloat((s*(parseFloat(l.odds)||1)).toFixed(4)), 1.0);

  return (
    <div style={{ position:"fixed",bottom:108,left:0,right:0,zIndex:200,display:"flex",justifyContent:"center",pointerEvents:"none" }}>
      <div style={{
        pointerEvents:"all",background:"var(--accent)",
        borderRadius:"var(--r-lg)",padding:"11px 18px",
        display:"flex",alignItems:"center",gap:14,
        boxShadow:`0 4px 28px var(--accent-border)`,
        maxWidth:420,width:"calc(100% - 32px)"
      }}>
        <div style={{ flex:1 }}>
          <div style={{ fontSize:9,fontWeight:800,color:"var(--accent-text)",letterSpacing:".1em" }}>
            DRAFT · {draftLegs.length} LEG{draftLegs.length>1?"S":""}
          </div>
          <div style={{ fontSize:12,fontWeight:700,color:"var(--accent-text)",marginTop:2 }}>
            ×{prod.toFixed(2)} combined odds
          </div>
        </div>
        <button onClick={onOpen}
          style={{ background:"var(--bg)",color:"var(--accent)",border:"none",
                   borderRadius:"var(--r-md)",padding:"6px 14px",fontSize:11,
                   fontWeight:900,cursor:"pointer",fontFamily:"var(--font)" }}>
          VIEW →
        </button>
        <button onClick={() => setVisible(false)}
          style={{ background:"rgba(0,0,0,0.15)",color:"var(--accent-text)",border:"none",
                   borderRadius:"var(--r-md)",padding:"6px 10px",fontSize:13,cursor:"pointer" }}
          title="Dismiss (ticket stays)">✕</button>
      </div>
    </div>
  );
}

async function savePoolToServer(pool, date) {
  if (!pool?.length || !date) return;
  try {
    await fetch(`${SERVER}/api/pool/save`, {
      method:"POST", headers:{"Content-Type":"application/json"},
      body: JSON.stringify({ date, picks: pool.map(p => ({
        fixtureId:p.fixtureId, game:p.game, pick:p.pick, market:p.market,
        conf:p.conf, odds:p.odds, empiricalRate:p.empiricalRate, score:p.score,
        league:p.league, strategyTags:p.strategyTags||[], isVolatile:p.isVolatile||false,
      }))}),
    });
  } catch(e) { /* non-critical, silent */ }
}
async function fetchPoolPerformance(days = 30) {
  try {
    const res = await fetch(`${SERVER}/api/pool/performance?days=${days}`);
    const d   = await res.json();
    return d.empty ? null : d;
  } catch { return null; }
}

// Engine functions (CALIBRATION, buildUniversalPool, buildRolloverPick, etc.) → engine.js

// ── LEAGUE FILTER ─────────────────────────────────────────────────────────
// ── THRESHOLD CHIP — reusable expandable slider for ≥/≤ filters ─────────
function ThresholdChip({ label, value, defaultValue, min, max, step, onChange, color, format }) {
  const [open, setOpen] = useState(false);
  const isActive = value !== defaultValue;
  const fmt = format || (v => v);
  return (
    <div style={{ marginBottom:6 }}>
      <div style={{ display:"flex",alignItems:"center",gap:8 }}>
        <button onClick={() => setOpen(o => !o)} className="gb"
          style={{ padding:"4px 10px",fontSize:9,background:isActive?(color||C.radar):"transparent",color:isActive?C.accentText:C.muted,border:`1px solid ${isActive?(color||C.radar):C.faint}` }}>
          {label} {fmt(value)}
        </button>
        {isActive && (
          <button onClick={() => { onChange(defaultValue); setOpen(false); }} className="gb"
            style={{ padding:"2px 7px",fontSize:8,background:"transparent",color:C.muted,border:`1px solid ${C.faint}` }}>
            Reset
          </button>
        )}
      </div>
      {open && (
        <div style={{ marginTop:6,padding:"8px 10px",background:C.surface,border:`1px solid ${C.border}`,borderRadius:7,display:"flex",alignItems:"center",gap:10 }}>
          <span style={{ fontSize:8,color:C.muted,flexShrink:0 }}>{fmt(min)}</span>
          <input type="range" min={min} max={max} step={step} value={value}
            onChange={e => onChange(parseFloat(e.target.value))} style={{ flex:1 }}/>
          <span style={{ fontSize:8,color:C.muted,flexShrink:0 }}>{fmt(max)}</span>
          <span style={{ fontSize:10,color:color||C.radar,fontWeight:800,width:32,textAlign:"right" }}>{fmt(value)}</span>
          <button onClick={() => setOpen(false)} className="gb"
            style={{ padding:"2px 8px",fontSize:8,background:C.accent,color:C.accentText,border:"none",flexShrink:0 }}>
            Done
          </button>
        </div>
      )}
    </div>
  );
}

function LeagueFilter({ availableLeagues, leagueFilter, setLeagueFilter }) {
  const [open, setOpen]         = useState(false);
  const [search, setSearch]     = useState("");
  const [expanded, setExpanded] = useState(new Set());

  const grouped = useMemo(() => {
    const map = new Map();
    for (const lg of availableLeagues) {
      const c = lg.country || "Other";
      if (!map.has(c)) map.set(c, []);
      map.get(c).push(lg);
    }
    // P15-FIX: Sort countries alphabetically for easy scanning.
    // Leagues within each country still sort by leagueRank (best first).
    return [...map.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([country, leagues]) => ({ country, leagues: leagues.sort((a,b) => a.leagueRank - b.leagueRank) }));
  }, [availableLeagues]);

  const selected = leagueFilter instanceof Set ? leagueFilter : new Set(leagueFilter ? [leagueFilter] : []);

  const toggleLeague = (id) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id); else next.add(id);
    setLeagueFilter(next.size === 0 ? null : next);
  };
  const toggleCountry = (country, leagues) => {
    const ids = leagues.map(l => l.leagueId);
    const allSel = ids.every(id => selected.has(id));
    const next = new Set(selected);
    allSel ? ids.forEach(id => next.delete(id)) : ids.forEach(id => next.add(id));
    setLeagueFilter(next.size === 0 ? null : next);
  };

  const searchLow = search.toLowerCase();
  const filteredGroups = useMemo(() => {
    if (!searchLow) return grouped;
    return grouped.map(g => ({ ...g, leagues: g.leagues.filter(l => l.league.toLowerCase().includes(searchLow) || g.country.toLowerCase().includes(searchLow)) })).filter(g => g.leagues.length > 0);
  }, [grouped, searchLow]);

  const activeLabel = selected.size === 0 ? "All Leagues"
    : selected.size === 1 ? (() => { const lg = availableLeagues.find(l => selected.has(l.leagueId)); return lg ? `${lg.league}${lg.country ? ` · ${lg.country}` : ""}` : "1 league"; })()
    : `${selected.size} leagues`;

  const btnRef = useRef(null);
  const [btnRect, setBtnRect] = useState(null);

  const openDropdown = () => {
    if (btnRef.current) setBtnRect(btnRef.current.getBoundingClientRect());
    setOpen(true);
  };

  return (
    <div style={{ marginBottom:6, position:"relative" }}>
      <button ref={btnRef} onClick={() => open ? setOpen(false) : openDropdown()} className="gb"
        style={{ padding:"3px 12px",fontSize:9,background:selected.size>0?C.accentDim:C.surface,color:selected.size>0?C.accent:C.text,border:`1px solid ${selected.size>0?C.accentBorder:C.border}`,display:"flex",alignItems:"center",gap:5 }}>
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>
        <span style={{ maxWidth:160,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap" }}>{activeLabel}</span>
        {selected.size > 0 && <span onClick={e=>{ e.stopPropagation(); setLeagueFilter(null); }} style={{ color:C.muted,fontSize:10,marginLeft:2 }}>✕</span>}
        <span style={{ fontSize:8 }}>{open ? "▲" : "▼"}</span>
      </button>
      {open && ReactDOM.createPortal(
        <>
          <div onClick={() => setOpen(false)}
            style={{ position:"fixed",inset:0,zIndex:8998,
                     background: window.innerWidth < 600 ? "rgba(0,0,0,.45)" : "transparent" }}/>
          {/* P2-FIX: bottom sheet on mobile, dropdown on desktop */}
          {/* B6-FIX: paddingBottom uses env(safe-area-inset-bottom) so the sheet
              clears the phone gesture nav bar. maxHeight reduced to 70vh to ensure
              the bottom of the list is reachable without scrolling past the nav. */}
          <div style={window.innerWidth < 600 ? {
            position:"fixed", bottom:0, left:0, right:0, zIndex:8999,
            maxHeight:"70vh", display:"flex", flexDirection:"column",
            background:C.modalBg, borderRadius:"16px 16px 0 0",
            boxShadow:"0 -4px 32px rgba(0,0,0,.5)",
            border:`1px solid ${C.border}`,
            animation:"slideUp .22s ease",
            paddingBottom:"env(safe-area-inset-bottom, 16px)",
          } : {
            position:"fixed",
            top: btnRect ? btnRect.bottom + 3 : 60,
            left: btnRect ? Math.min(btnRect.left, window.innerWidth - 290) : 16,
            zIndex:8999,
            width:280, maxHeight:400, overflowY:"auto",
            background:C.modalBg, border:`1px solid ${C.border}`,
            borderRadius:8, boxShadow:"0 4px 24px rgba(0,0,0,0.5)"
          }}>
          {/* Bottom sheet drag handle — mobile only */}
          {window.innerWidth < 600 && (
            <div style={{ display:"flex", justifyContent:"center", padding:"10px 0 4px" }}>
              <div style={{ width:36, height:4, borderRadius:2, background:C.border }} />
            </div>
          )}
          {window.innerWidth < 600 && (
            <div style={{ padding:"4px 14px 10px", display:"flex", justifyContent:"space-between", alignItems:"center" }}>
              <span style={{ fontSize:11, fontWeight:800, color:C.text }}>Select Leagues</span>
              <button onClick={() => setOpen(false)}
                style={{ background:"none", border:"none", color:C.muted, cursor:"pointer", fontSize:18, padding:0 }}>✕</button>
            </div>
          )}
          <div style={{ flex:1, overflowY:"auto" }}>
          <div style={{ padding:"8px 10px",borderBottom:`1px solid ${C.border}`,position:"sticky",top:0,background:C.modalBg,zIndex:1 }}>
            <input autoFocus value={search} onChange={e=>setSearch(e.target.value)} placeholder="Search league or country…"
              style={{ width:"100%",background:C.faint,border:`1px solid ${C.border}`,borderRadius:5,padding:"4px 8px",fontSize:9,color:C.text,outline:"none",boxSizing:"border-box" }}/>
          </div>
          <div style={{ padding:"4px 10px",borderBottom:`1px solid ${C.faint}` }}>
            <button onClick={() => { setLeagueFilter(null); setOpen(false); setSearch(""); }} className="gb"
              style={{ width:"100%",textAlign:"left",padding:"4px 8px",fontSize:9,background:selected.size===0?C.accent:C.surface,color:selected.size===0?C.accentText:C.text,border:`1px solid ${selected.size===0?C.accentBorder:C.border}`,borderRadius:4,fontWeight:selected.size===0?700:400 }}>
              All Leagues
            </button>
          </div>
          {filteredGroups.map(({ country, leagues }) => {
            // Auto-expand: if searching, if country has selections, or if country has only 1 league
            const hasSelection = leagues.some(l => selected.has(l.leagueId));
            const isExp = expanded.has(country) || !!searchLow || hasSelection || leagues.length === 1;
            const countrySelected = leagues.filter(l => selected.has(l.leagueId)).length;
            const allCountrySel = countrySelected === leagues.length;
            return (
              <div key={country} style={{ borderBottom:`1px solid ${C.faint}` }}>
                <div style={{ display:"flex",alignItems:"center",padding:"5px 10px",gap:6,cursor:"pointer" }}
                  onClick={() => setExpanded(prev => { const n=new Set(prev); isExp&&!searchLow&&!hasSelection&&leagues.length>1?n.delete(country):n.add(country); return n; })}>
                  <button className="gb" onClick={e=>{ e.stopPropagation(); toggleCountry(country,leagues); }}
                    style={{ width:14,height:14,borderRadius:3,border:`1px solid ${allCountrySel?C.accent:C.border}`,background:allCountrySel?C.accent:countrySelected>0?C.accentDim:"transparent",flexShrink:0,padding:0 }}/>
                  <span style={{ fontSize:9,fontWeight:700,color:countrySelected>0?C.accent:C.text,flex:1 }}>{country}</span>
                  <span style={{ fontSize:8,color:C.muted }}>{leagues.length}</span>
                  {leagues.length > 1 && <span style={{ fontSize:8,color:C.muted }}>{isExp&&!searchLow&&!hasSelection?"▲":"▼"}</span>}
                </div>
                {isExp && leagues.map(lg => {
                  const active = selected.has(lg.leagueId);
                  return (
                    <button key={lg.leagueId} onClick={() => toggleLeague(lg.leagueId)} className="gb"
                      style={{ display:"block",width:"100%",textAlign:"left",padding:"4px 10px 4px 28px",fontSize:8,
                               background:active?C.accentDim:"transparent",
                               color:active?C.accent:C.muted,
                               border:"none",borderBottom:`1px solid ${C.faint}` }}>
                      {lg.leagueRank < 999 ? `[${lg.leagueRank}] ` : ""}{lg.league}
                    </button>
                  );
                })}
              </div>
            );
          })}
          </div>{/* end scroll wrapper */}
          </div>{/* end sheet/dropdown */}
        </>,
        document.body
      )}
    </div>
  );
}

// ── SORT FILTER ───────────────────────────────────────────────────────────────
// Each option has a type:
//   "sort_primary"  — mutually exclusive with other primaries (conf, strong_first)
//   "sort_time"     — time-ordering; combinable with any primary sort as a grouping layer
//   "filter"        — additive, independent of sorts
const SORT_OPTIONS = [
  { id: "upcoming",     label: "Upcoming First", desc: "Not started → Live → FT · combinable with sorts below", type: "sort_time",
    icon: <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg> },
  { id: "conf",         label: "By Confidence",  desc: "Highest confidence Read picks first",                   type: "sort_primary" },
  { id: "strong_first", label: "Strong First",   desc: "STRONG picks bubble to top",                           type: "sort_primary" },
  { id: "strong_only",  label: "Strong Only",    desc: "Hide non-STRONG picks",                                type: "filter"       },
  { id: "hq_data",      label: "High Quality",   desc: "Calibration ≥50% — good data, reliable model output",  type: "filter"       },
  { id: "ltd_data",     label: "Limited Data",   desc: "Calibration <25% — thin data, treat with caution",     type: "filter"       },
];

function getStateGroup(f) {
  const s = (f.state || "").toLowerCase().replace(/[\s_\-]/g, "");
  // N8-FIX: Cancelled/PPD were returning 0 (same as upcoming) — surfaced at the top
  // when Upcoming sort was active. Expected order: Upcoming(0) → Live(1) → FT(2) → PPD/Canc(3)
  if (["postponed","ppd","suspended","interrupted","abandoned","cancelled","canceled","deleted"].includes(s)) return 3;
  if (["finished","ft","fulltime","ended","complete","aet","afterextratime","afterpenalties"].includes(s)) return 2;
  if (["inprogress","live","1h","1sthalf","ht","halftime","2h","2ndhalf","et","extratime","penaltyshootout"].includes(s)) return 1;
  return 0; // upcoming / not started
}

function SortFilter({ active, setActive }) {
  const [open, setOpen] = useState(false);
  const hasActive = active.size > 0;
  const activeLabels = SORT_OPTIONS.filter(o => active.has(o.id)).map(o => o.label).join(" · ");

  const toggle = (id) => {
    const opt = SORT_OPTIONS.find(o => o.id === id);
    setActive(prev => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        // Primary sorts are mutually exclusive with each other (not with upcoming)
        if (opt.type === "sort_primary") {
          SORT_OPTIONS.filter(o => o.type === "sort_primary").forEach(o => next.delete(o.id));
        }
        next.add(id);
      }
      return next;
    });
  };

  return (
    <div style={{ marginBottom:6 }}>
      <button onClick={() => setOpen(o => !o)} className="gb"
        style={{ padding:"3px 12px",fontSize:9,background:hasActive?C.accentDim:"transparent",color:hasActive?C.accent:C.muted,border:`1px solid ${hasActive?C.accentBorder:C.faint}`,display:"flex",alignItems:"center",gap:5 }}>
        <span>↕</span>
        <span style={{ maxWidth:160,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap" }}>
          {hasActive ? activeLabels : "Sort / Filter"}
        </span>
        <span style={{ fontSize:8 }}>{open ? "▲" : "▼"}</span>
      </button>
      {open && (
        <div style={{ marginTop:5,padding:"10px",background:C.surface,border:`1px solid ${C.border}`,borderRadius:8,minWidth:230 }}>

          {/* Time ordering — combinable */}
          <div style={{ fontSize:8,color:C.text,fontWeight:700,textTransform:"uppercase",letterSpacing:".1em",marginBottom:7 }}>Time Order</div>
          <div style={{ display:"flex",flexDirection:"column",gap:3,marginBottom:10 }}>
            {SORT_OPTIONS.filter(o => o.type === "sort_time").map(opt => {
              const isActive = active.has(opt.id);
              return (
                <button key={opt.id} onClick={() => toggle(opt.id)} className="gb"
                  style={{ padding:"5px 10px",fontSize:9,background:isActive?C.accentDim:"transparent",color:isActive?C.accent:C.muted,border:`1px solid ${isActive?C.accentBorder:C.faint}`,textAlign:"left",display:"flex",flexDirection:"column",gap:1 }}>
                  <span style={{ fontWeight:isActive?700:400,display:"flex",alignItems:"center",gap:5 }}>
                    {opt.icon && <span style={{ opacity:.7 }}>{opt.icon}</span>}
                    {opt.label}
                  </span>
                  <span style={{ fontSize:8,opacity:.6 }}>{opt.desc}</span>
                </button>
              );
            })}
          </div>

          {/* Primary sorts — mutually exclusive with each other */}
          <div style={{ fontSize:8,color:C.text,fontWeight:700,textTransform:"uppercase",letterSpacing:".1em",marginBottom:7 }}>Sort Order</div>
          <div style={{ display:"flex",flexDirection:"column",gap:3,marginBottom:10 }}>
            {SORT_OPTIONS.filter(o => o.type === "sort_primary").map(opt => {
              const isActive = active.has(opt.id);
              return (
                <button key={opt.id} onClick={() => toggle(opt.id)} className="gb"
                  style={{ padding:"5px 10px",fontSize:9,background:isActive?C.accentDim:"transparent",color:isActive?C.accent:C.muted,border:`1px solid ${isActive?C.accentBorder:C.faint}`,textAlign:"left",display:"flex",flexDirection:"column",gap:1 }}>
                  <span style={{ fontWeight:isActive?700:400 }}>{opt.label}</span>
                  <span style={{ fontSize:8,opacity:.6 }}>{opt.desc}</span>
                </button>
              );
            })}
          </div>

          {/* Filters */}
          <div style={{ fontSize:8,color:C.text,fontWeight:700,textTransform:"uppercase",letterSpacing:".1em",marginBottom:7 }}>Filters</div>
          <div style={{ display:"flex",flexDirection:"column",gap:3 }}>
            {SORT_OPTIONS.filter(o => o.type === "filter").map(opt => {
              const isActive = active.has(opt.id);
              const liveCol = opt.id === "live" ? C.green : opt.id === "scheduled" ? C.gold : (isActive ? C.accent : C.muted);
              return (
                <button key={opt.id} onClick={() => toggle(opt.id)} className="gb"
                  style={{ padding:"5px 10px",fontSize:9,background:isActive?C.accentDim:"transparent",color:isActive?C.accent:C.muted,border:`1px solid ${isActive?C.accentBorder:C.faint}`,textAlign:"left",display:"flex",flexDirection:"column",gap:1 }}>
                  <span style={{ fontWeight:isActive?700:400,display:"flex",alignItems:"center",gap:5 }}>
                    {opt.icon && <span style={{ color: isActive ? liveCol : C.muted, lineHeight:0 }}>{opt.icon}</span>}
                    {opt.label}
                  </span>
                  <span style={{ fontSize:8,opacity:.6 }}>{opt.desc}</span>
                </button>
              );
            })}
          </div>

          {hasActive && (
            <button onClick={() => { setActive(new Set()); setOpen(false); }} className="gb"
              style={{ marginTop:8,width:"100%",padding:"4px",fontSize:8,color:C.text,border:`1px solid ${C.faint}`,background:"transparent",textAlign:"center" }}>
              ✕ Clear all
            </button>
          )}
        </div>
      )}
    </div>
  );
}
// Replaces the small bar chart — shows each day as an expandable row with
// date · picks · wins · hit-rate, and (if the server returns d.picks) a
// drill-down list of every individual pick + result for that day.
function DailyBreakdownTable({ dailyTrend }) {
  const [expanded, setExpanded] = useState(null);
  const rows = [...dailyTrend].reverse(); // most recent first

  return (
    <div className="gc" style={{ padding:14, marginBottom:12 }}>
      <div style={{ fontSize:8,color:C.text,opacity:.55,textTransform:"uppercase",letterSpacing:".1em",marginBottom:10,fontWeight:700 }}>
        All Read Picks — Daily Breakdown
      </div>
      <div style={{ fontSize:7,color:C.muted,marginBottom:10 }}>Every fixture with any model pick, including low-confidence signals</div>

      {/* Mini sparkline bar — retained as a quick visual overview */}
      <div style={{ display:"flex",alignItems:"flex-end",gap:2,height:36,marginBottom:12 }}>
        {dailyTrend.slice(-14).map((d,i) => {
          const barH = Math.max(4, d.rate * 0.36);
          const bg   = d.rate >= 65 ? C.green : d.rate >= 50 ? C.gold : C.red;
          return (
            <div key={i} title={`${d.date}: ${d.wins}/${d.total} · ${d.rate}%`}
              style={{ flex:1,display:"flex",flexDirection:"column",alignItems:"center",gap:1 }}>
              <div style={{ width:"100%",borderRadius:2,background:bg,height:`${barH}px`,transition:"height .3s",opacity:.85 }}/>
              <div style={{ fontSize:6,color:C.text,opacity:.35,writingMode:"vertical-rl",textOrientation:"mixed",
                transform:"rotate(180deg)",height:18,overflow:"hidden",textOverflow:"clip",whiteSpace:"nowrap" }}>
                {d.date?.slice(5)}
              </div>
            </div>
          );
        })}
      </div>

      {/* Per-day expandable rows */}
      <div style={{ display:"flex",flexDirection:"column",gap:2 }}>
        {rows.map((d, i) => {
          const rateColor = d.rate >= 65 ? C.green : d.rate >= 50 ? C.gold : C.red;
          const isOpen    = expanded === i;
          const hasPicks  = d.picks?.length > 0;
          return (
            <div key={i}>
              <button
                onClick={() => hasPicks && setExpanded(isOpen ? null : i)}
                style={{
                  width:"100%", display:"grid",
                  gridTemplateColumns:"80px 1fr 44px 44px 34px 20px",
                  gap:6, alignItems:"center",
                  padding:"7px 8px", borderRadius:7,
                  background: isOpen ? C.surface : "transparent",
                  border:`1px solid ${isOpen ? C.border : "transparent"}`,
                  cursor: hasPicks ? "pointer" : "default",
                  transition:"all .15s", fontFamily:C.font,
                }}
              >
                {/* Date */}
                <span style={{ fontSize:9, fontWeight:700, color:C.text, textAlign:"left" }}>
                  {d.date}
                </span>
                {/* Inline bar */}
                <div style={{ height:4,background:C.text,opacity:.1,borderRadius:2,overflow:"hidden" }}>
                  <div style={{ height:"100%",width:`${Math.min(d.rate,100)}%`,background:rateColor,borderRadius:2,transition:"width .4s" }}/>
                </div>
                {/* Hit rate */}
                <span style={{ fontSize:10, fontWeight:800, color:rateColor, textAlign:"right" }}>
                  {d.rate}%
                </span>
                {/* wins/total */}
                <span style={{ fontSize:8, color:C.text, opacity:.5, textAlign:"right" }}>
                  {d.wins}/{d.total}
                </span>
                {/* Picks count badge */}
                <span style={{ fontSize:7, color:C.text, opacity:.4, textAlign:"right" }}>
                  {d.total}p
                </span>
                {/* Chevron */}
                {hasPicks
                  ? <span style={{ fontSize:8, color:C.text, opacity:.35 }}>{isOpen ? "▲" : "▼"}</span>
                  : <span/>
                }
              </button>

              {/* Expanded pick list */}
              {isOpen && hasPicks && (
                <div style={{ background:C.surface, border:`1px solid ${C.border}`, borderTop:"none",
                  borderRadius:"0 0 7px 7px", padding:"6px 10px 8px", marginBottom:2 }}>
                  {d.picks.map((p, j) => {
                    const rc = p.result === "WIN" ? C.green : p.result === "LOSS" ? C.red : C.text;
                    const mst = mktStyle(p.market || "");
                    return (
                      <div key={j} style={{ display:"grid", gridTemplateColumns:"1fr 60px 36px 42px",
                        gap:5, alignItems:"center", padding:"4px 0",
                        borderBottom: j < d.picks.length - 1 ? `1px solid ${C.border}` : "none" }}>
                        <div style={{ minWidth:0 }}>
                          <div style={{ fontSize:8, color:C.text, opacity:.7, overflow:"hidden",
                            textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{p.game || "—"}</div>
                          <div style={{ fontSize:9, fontWeight:700, color:mst.color || C.text,
                            overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>
                            {p.pick}
                            {p.market && (
                              <span style={{ fontSize:7, color:mst.color, background:`${mst.color}18`,
                                border:`1px solid ${mst.color}28`, borderRadius:3, padding:"0 4px",
                                marginLeft:4, fontWeight:800, letterSpacing:".05em" }}>
                                {p.market}
                              </span>
                            )}
                          </div>
                        </div>
                        <span style={{ fontSize:8, color:C.text, opacity:.45, textAlign:"right" }}>
                          {p.conf ? `${Math.round(p.conf)}%` : "—"}
                        </span>
                        <span style={{ fontSize:9, fontWeight:700, color:C.text, opacity:.6, textAlign:"right" }}>
                          {p.odds ? `×${parseFloat(p.odds).toFixed(2)}` : "—"}
                        </span>
                        <span style={{ fontSize:9, fontWeight:800, color:rc, textAlign:"right" }}>
                          {p.result === "WIN" ? "✓ W" : p.result === "LOSS" ? "✕ L" : "–"}
                          {p.score ? ` ${p.score}` : ""}
                        </span>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── POOL ENGINE ACCORDION (Issue 3.2) ────────────────────────────────────
function PoolAccordion({ data, C }) {
  const [openDate, setOpenDate] = useState(null);
  const days = [...data.dailyTrend].reverse();

  return (
    <div className="gc" style={{ padding:14,marginBottom:12 }}>
      <div style={{ fontSize:8,color:C.edge,textTransform:"uppercase",letterSpacing:".12em",fontWeight:800,marginBottom:2 }}>Daily Engine Pool — Match Report</div>
      <div style={{ fontSize:7,color:C.muted,marginBottom:10 }}>Tap a day to expand picks · filtered pool only</div>
      <div style={{ display:"flex",flexDirection:"column",gap:3 }}>
        {days.map((d, di) => {
          const total     = d.engineTotal || d.total || 0;
          const wins      = d.engineWins  || d.wins  || 0;
          const rate      = total ? Math.round(wins / total * 100) : 0;
          const rateColor = rate >= 65 ? C.green : rate >= 50 ? C.gold : C.red;
          const picks     = d.picks || [];
          const isOpen    = openDate === d.date;
          if (!total && !picks.length) return null;
          return (
            <div key={di}>
              {/* Accordion header row */}
              <button
                onClick={() => setOpenDate(isOpen ? null : d.date)}
                style={{ width:"100%",display:"grid",gridTemplateColumns:"80px 1fr 44px 44px 18px",
                  gap:6,alignItems:"center",padding:"7px 8px",cursor:"pointer",
                  background:isOpen ? C.surface : "transparent",
                  border:`1px solid ${isOpen ? C.border : "transparent"}`,
                  borderBottom: isOpen ? "none" : undefined,
                  borderRadius: isOpen ? "7px 7px 0 0" : "7px",
                  fontFamily:C.font,textAlign:"left" }}>
                <span style={{ fontSize:9,fontWeight:700,color:C.text }}>{d.date}</span>
                <div style={{ height:4,background:C.text,opacity:.1,borderRadius:2,overflow:"hidden" }}>
                  <div style={{ height:"100%",width:`${Math.min(rate,100)}%`,background:rateColor,borderRadius:2 }}/>
                </div>
                <span style={{ fontSize:10,fontWeight:800,color:rateColor,textAlign:"right" }}>{rate}%</span>
                <span style={{ fontSize:8,color:C.text,opacity:.45,textAlign:"right" }}>{wins}/{total}</span>
                <span style={{ fontSize:10,color:C.muted,textAlign:"right" }}>{isOpen ? "▲" : "▼"}</span>
              </button>

              {/* Expanded picks */}
              {isOpen && picks.length > 0 && (
                <div style={{ background:C.surface,border:`1px solid ${C.border}`,borderTop:"none",
                  borderRadius:"0 0 7px 7px",padding:"4px 8px 8px",marginBottom:1 }}>
                  {picks.map((p, j) => {
                    const rc  = p.result==="WIN" ? C.green : p.result==="LOSS" ? C.red : C.text;
                    const mst = mktStyle(p.market || "");
                    return (
                      <div key={j} style={{ display:"grid",gridTemplateColumns:"1fr 52px 36px 42px",
                        gap:4,alignItems:"center",padding:"5px 0",
                        borderBottom:j<picks.length-1?`1px solid ${C.border}`:"none" }}>
                        <div style={{ minWidth:0 }}>
                          <div style={{ fontSize:8,color:C.text,opacity:.55,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap" }}>{p.game||"—"}</div>
                          <div style={{ fontSize:9,fontWeight:700,color:mst.color||C.text,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap" }}>
                            {p.pick}
                            {p.market && (
                              <span style={{ fontSize:7,color:mst.color,background:`${mst.color}18`,border:`1px solid ${mst.color}28`,
                                borderRadius:3,padding:"0 4px",marginLeft:4,fontWeight:800,letterSpacing:".04em" }}>{p.market}</span>
                            )}
                          </div>
                        </div>
                        <span style={{ fontSize:8,color:C.text,opacity:.4,textAlign:"right" }}>{p.conf ? `${Math.round(p.conf)}%` : "—"}</span>
                        <span style={{ fontSize:9,fontWeight:700,color:C.text,opacity:.6,textAlign:"right" }}>{p.odds ? `×${parseFloat(p.odds).toFixed(2)}` : "—"}</span>
                        <span style={{ fontSize:9,fontWeight:800,color:rc,textAlign:"right" }}>{p.result==="WIN"?"✓ W":p.result==="LOSS"?"✕ L":"–"}</span>
                      </div>
                    );
                  })}
                </div>
              )}

              {isOpen && !picks.length && (
                <div style={{ background:C.surface,border:`1px solid ${C.border}`,borderTop:"none",
                  borderRadius:"0 0 7px 7px",padding:"10px 8px",color:C.muted,fontSize:8,textAlign:"center" }}>
                  No pick detail available for this day
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── POOL PERFORMANCE TAB — N40 redesign ──────────────────────────────────
// Sub-tab architecture: Overview · Markets · History · Parleys
// All data fetched once at top level and passed down — sub-tab switches never re-fetch.
// Parleys sub-tab: unified Jarvis engine parleys + Rollover chain steps (N33/N39).
function PoolPerformanceTab({ serverUrl }) {
  const [data,           setData]          = useState(null);
  const [loading,        setLoading]       = useState(true);
  const [days,           setDays]          = useState(30);
  const [perfTab,        setPerfTab]       = useState("overview");
  const [parlaysData,    setParlaysData]   = useState(null);
  const [parlaysLoading, setParlaysLoading] = useState(false);
  const parlaysFetchedDays = useRef(null);

  // Read userId the same way Rollover does — localStorage → sessionStorage
  const userId = (() => {
    try { const id = localStorage.getItem("rvl_user_uuid"); if (id && id.length >= 10 && id !== "anon") return id; } catch {}
    try { const id = sessionStorage.getItem("rvl_user_uuid_session"); if (id && id.length >= 10) return id; } catch {}
    return null;
  })();

  // Fetch pool performance when days changes
  useEffect(() => {
    setLoading(true);
    Promise.all([
      fetch(`${serverUrl}/api/pool/performance?days=${days}`).then(r => r.json()).catch(() => null),
      fetch(`${serverUrl}/api/pool/performance/enhanced?days=${days}`).then(r => r.json()).catch(() => null),
    ]).then(([base, enhanced]) => {
      if (!base || base.empty) { setData(null); setLoading(false); return; }
      const enhancedByDate = new Map((enhanced?.dailyTrend || []).map(d => [d.date, d]));
      const mergedTrend = (base.dailyTrend || []).map(d => {
        const enh = enhancedByDate.get(d.date);
        return {
          ...d,
          picks:     enh?.picks     || d.picks     || [],
          readTotal: enh?.total     ?? d.readTotal  ?? d.total,
          readWins:  enh?.wins      ?? d.readWins   ?? d.wins,
        };
      });
      (enhanced?.dailyTrend || []).forEach(enh => {
        if (!mergedTrend.find(d => d.date === enh.date))
          mergedTrend.push({ ...enh, readTotal: enh.total, readWins: enh.wins });
      });
      mergedTrend.sort((a, b) => a.date.localeCompare(b.date));
      setData({ ...base, dailyTrend: mergedTrend });
      setLoading(false);
    });
  }, [days]);

  // Fetch unified parlay performance — lazily on first Parleys visit, re-fetch when days changes
  useEffect(() => {
    if (perfTab !== "parleys") return;
    if (parlaysFetchedDays.current === days) return;
    parlaysFetchedDays.current = days;
    setParlaysLoading(true);
    const uidParam = userId ? `&userId=${encodeURIComponent(userId)}` : "";
    fetch(`${serverUrl}/api/performance/parleys?days=${days}${uidParam}`)
      .then(r => r.json())
      .catch(() => null)
      .then(d => { setParlaysData(d); setParlaysLoading(false); });
  }, [perfTab, days]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Sub-tab strip ─────────────────────────────────────────────────────────
  const PERF_TABS = [
    { id:"overview", label:"Overview" },
    { id:"markets",  label:"Markets"  },
    { id:"history",  label:"History"  },
    { id:"parleys",  label:"Parleys"  },
    { id:"analyst",  label:"Analyst"  },
  ];

  return (
    <div style={{ paddingBottom:48 }}>

      {/* Sticky header — sub-tab strip + day range selector */}
      <div style={{
        position:"sticky", top:0, zIndex:10,
        background: `color-mix(in srgb, ${C.bg} 96%, transparent)`,
        backdropFilter:"blur(16px)", WebkitBackdropFilter:"blur(16px)",
        borderBottom:`1px solid ${C.border}`,
        padding:"10px 16px 0",
        marginBottom:14,
      }}>
        {/* Sub-tabs */}
        <div style={{ display:"flex", gap:0, marginBottom:10 }}>
          {PERF_TABS.map(t => {
            const on = perfTab === t.id;
            return (
              <button key={t.id} onClick={() => setPerfTab(t.id)}
                style={{
                  flex:1, padding:"7px 4px", border:"none", background:"transparent",
                  fontFamily:C.font, fontSize:10, fontWeight: on ? 800 : 500,
                  color: on ? C.accent : C.muted,
                  borderBottom:`2px solid ${on ? C.accent : "transparent"}`,
                  cursor:"pointer", transition:"all .15s",
                  WebkitTapHighlightColor:"transparent",
                }}>
                {t.label}
              </button>
            );
          })}
        </div>
        {/* Day range */}
        <div style={{ display:"flex", gap:5, paddingBottom:10 }}>
          {[7,14,30,60].map(d => (
            <button key={d} onClick={() => setDays(d)} className="gb"
              style={{
                padding:"3px 11px", fontSize:9,
                background: days===d ? C.accent : "transparent",
                color:      days===d ? C.accentText : C.muted,
                border:`1px solid ${days===d ? C.accent : C.faint}`,
                borderRadius:6,
              }}>
              {d}d
            </button>
          ))}
        </div>
      </div>

      {/* ── OVERVIEW ────────────────────────────────────────────────────── */}
      {perfTab === "overview" && (
        <div style={{ padding:"0 14px" }}>
          {loading && (
            <div style={{ padding:40, textAlign:"center", color:C.muted, fontSize:10 }}>Loading…</div>
          )}
          {!loading && !data && (
            <div style={{ padding:40, textAlign:"center", color:C.text, opacity:.3, fontSize:10 }}>
              No scored pools yet.
              <span style={{ display:"block", fontSize:8, marginTop:8, opacity:.6 }}>
                Build a ticket first — pool data is saved automatically. After results come in the engine scores each pick.
              </span>
            </div>
          )}
          {!loading && data?.overall && (
            <>
              {/* Engine Pool headline stats */}
              <div className="gc" style={{ padding:16, marginBottom:12 }}>
                <div style={{ fontSize:7, color:C.edge, textTransform:"uppercase", letterSpacing:".14em", fontWeight:800, marginBottom:1 }}>
                  Engine Pool · {data.period}
                </div>
                <div style={{ fontSize:7, color:C.muted, marginBottom:14 }}>
                  Picks that cleared all confidence + data thresholds
                </div>
                <div style={{ display:"grid", gridTemplateColumns:"repeat(4,1fr)", gap:10, marginBottom:14 }}>
                  {[
                    ["Picks",    data.overall.total,                                        C.text],
                    ["Wins",     data.overall.wins,                                         C.green],
                    ["Hit Rate", `${data.overall.rate}%`,                                   data.overall.rate>=65?C.green:data.overall.rate>=50?C.gold:C.red],
                    ["Avg Odds", data.overall.avgOdds!=null?`${data.overall.avgOdds.toFixed(2)}×`:"—", C.gold],
                  ].map(([l, v, col]) => (
                    <div key={l} style={{ textAlign:"center" }}>
                      <div style={{ fontSize:20, fontWeight:900, color:col, lineHeight:1 }}>{v}</div>
                      <div style={{ fontSize:7, color:C.muted, marginTop:4, letterSpacing:".06em", textTransform:"uppercase" }}>{l}</div>
                    </div>
                  ))}
                </div>
                <div style={{ fontSize:7, color:C.muted, lineHeight:1.6, borderTop:`1px solid ${C.border}`, paddingTop:10 }}>
                  Hit Rate is decay-weighted (14-day half-life) — recent results count more.
                  Picks and Wins are raw counts.
                </div>
              </div>

              {/* All-Read summary */}
              {(() => {
                const trend        = data.dailyTrend || [];
                const allReadTotal = trend.reduce((s, d) => s + (d.readTotal || d.total || 0), 0);
                const allReadWins  = trend.reduce((s, d) => s + (d.readWins  || d.wins  || 0), 0);
                const allReadRate  = allReadTotal ? Math.round(allReadWins / allReadTotal * 100) : 0;
                if (!allReadTotal) return null;
                const col = allReadRate >= 65 ? C.green : allReadRate >= 50 ? C.gold : C.red;
                return (
                  <div className="gc" style={{ padding:16, marginBottom:12 }}>
                    <div style={{ fontSize:7, color:C.text, opacity:.55, textTransform:"uppercase", letterSpacing:".14em", fontWeight:800, marginBottom:1 }}>
                      All Read Picks · {data.period}
                    </div>
                    <div style={{ fontSize:7, color:C.muted, marginBottom:14 }}>
                      Every fixture with any model pick (includes low-confidence signals)
                    </div>
                    <div style={{ display:"grid", gridTemplateColumns:"repeat(3,1fr)", gap:10 }}>
                      {[["Picks", allReadTotal, C.text], ["Wins", allReadWins, C.green], ["Hit Rate", `${allReadRate}%`, col]].map(([l, v, c]) => (
                        <div key={l} style={{ textAlign:"center" }}>
                          <div style={{ fontSize:18, fontWeight:900, color:c, lineHeight:1 }}>{v}</div>
                          <div style={{ fontSize:7, color:C.muted, marginTop:4, letterSpacing:".06em", textTransform:"uppercase" }}>{l}</div>
                        </div>
                      ))}
                    </div>
                  </div>
                );
              })()}

              {/* Mini sparkline — last 14 days */}
              {data.dailyTrend?.length > 0 && (
                <div className="gc" style={{ padding:14, marginBottom:12 }}>
                  <div style={{ fontSize:7, color:C.muted, textTransform:"uppercase", letterSpacing:".1em", fontWeight:700, marginBottom:10 }}>
                    Last 14 days — hit rate
                  </div>
                  <div style={{ display:"flex", alignItems:"flex-end", gap:3, height:40 }}>
                    {data.dailyTrend.slice(-14).map((d, i) => {
                      const h  = Math.max(5, (d.rate || 0) * 0.4);
                      const bg = d.rate >= 65 ? C.green : d.rate >= 50 ? C.gold : C.red;
                      return (
                        <div key={i} style={{ flex:1, display:"flex", flexDirection:"column", alignItems:"center", gap:2 }}>
                          <div style={{ width:"100%", borderRadius:2, background:bg, height:`${h}px`, opacity:.8 }}
                            title={`${d.date}: ${d.wins}/${d.total} · ${d.rate}%`} />
                          <div style={{ fontSize:6, color:C.text, opacity:.3,
                            writingMode:"vertical-rl", textOrientation:"mixed",
                            transform:"rotate(180deg)", height:16, overflow:"hidden", whiteSpace:"nowrap" }}>
                            {d.date?.slice(5)}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      )}

      {/* ── MARKETS ─────────────────────────────────────────────────────── */}
      {/* N37: by-market fixture drill-down  N38: by-strategy fixture drill-down */}
      {perfTab === "markets" && (
        <div style={{ padding:"0 14px" }}>
          {loading && <div style={{ padding:40, textAlign:"center", color:C.muted, fontSize:10 }}>Loading…</div>}
          {!loading && !data && (
            <div style={{ padding:40, textAlign:"center", color:C.text, opacity:.3, fontSize:10 }}>No data yet.</div>
          )}
          {!loading && data && (() => {
            // Derive all-read aggregates from dailyTrend picks[] — every pick regardless of pool status
            const allReadByMarket = {};
            const allReadByTag = {};
            (data.dailyTrend || []).forEach(day => {
              (day.picks || []).forEach(p => {
                const mkt = p.market;
                if (mkt) {
                  if (!allReadByMarket[mkt]) allReadByMarket[mkt] = { wins:0, total:0 };
                  allReadByMarket[mkt].total++;
                  if (p.result === "WIN") allReadByMarket[mkt].wins++;
                }
                (p.tags || []).forEach(tag => {
                  if (!allReadByTag[tag]) allReadByTag[tag] = { wins:0, total:0 };
                  allReadByTag[tag].total++;
                  if (p.result === "WIN") allReadByTag[tag].wins++;
                });
              });
            });
            // Add rate to aggregates
            Object.values(allReadByMarket).forEach(d => d.rate = d.total ? Math.round(d.wins/d.total*100) : 0);
            Object.values(allReadByTag).forEach(d => d.rate = d.total ? Math.round(d.wins/d.total*100) : 0);

            return (
              <>
                {/* Engine Pool section */}
                <div style={{ fontSize:7, color:C.edge, textTransform:"uppercase", letterSpacing:".14em",
                  fontWeight:800, marginBottom:8, paddingTop:2 }}>
                  Engine Pool — qualified picks only
                </div>
                <FixtureDrillSection
                  title="By Market"
                  subtitle="Tap a market to see every individual pick"
                  accentColor={C.edge}
                  aggregates={data.byMarket || {}}
                  dailyTrend={data.dailyTrend || []}
                  bucketKey="market"
                  labelFn={k => k}
                  pickFilter={p => p.type === "engine" || p.enginePool}
                />
                <FixtureDrillSection
                  title="By Strategy"
                  subtitle="Tap a strategy to see every fixture it fired on"
                  accentColor={C.accent}
                  aggregates={data.byTag || {}}
                  dailyTrend={data.dailyTrend || []}
                  bucketKey="tags"
                  labelFn={k => k.replace(/_/g," ")}
                  pickFilter={p => p.type === "engine" || p.enginePool}
                />

                {/* Divider */}
                <div style={{ height:1, background:C.border, margin:"4px 0 16px" }} />

                {/* All Read section */}
                <div style={{ fontSize:7, color:C.muted, textTransform:"uppercase", letterSpacing:".14em",
                  fontWeight:800, marginBottom:8 }}>
                  All Read Picks — includes low confidence
                </div>
                {Object.keys(allReadByMarket).length > 0 ? (
                  <FixtureDrillSection
                    title="By Market"
                    subtitle="All fixtures with any model pick"
                    accentColor={C.muted}
                    aggregates={allReadByMarket}
                    dailyTrend={data.dailyTrend || []}
                    bucketKey="market"
                    labelFn={k => k}
                    pickFilter={null}
                  />
                ) : (
                  <div style={{ fontSize:9, color:C.muted, textAlign:"center", padding:"16px 0" }}>
                    No all-read pick data for this range.
                  </div>
                )}
              </>
            );
          })()}
        </div>
      )}

      {/* ── HISTORY ─────────────────────────────────────────────────────── */}
      {perfTab === "history" && (
        <div style={{ padding:"0 14px" }}>
          {loading && <div style={{ padding:40, textAlign:"center", color:C.muted, fontSize:10 }}>Loading…</div>}
          {!loading && !data && (
            <div style={{ padding:40, textAlign:"center", color:C.text, opacity:.3, fontSize:10 }}>No data yet.</div>
          )}
          {!loading && data && (
            <>
              {data.dailyTrend?.some(d => (d.engineTotal || d.total) > 0) && (
                <PoolAccordion data={data} C={C} />
              )}
              {data.dailyTrend?.length > 0 && (
                <DailyBreakdownTable dailyTrend={data.dailyTrend} />
              )}
            </>
          )}
        </div>
      )}

      {/* ── PARLEYS ─────────────────────────────────────────────────────── */}
      {perfTab === "parleys" && (
        <div style={{ padding:"0 14px" }}>
          <ParlayPerformancePanel
            days={days}
            data={parlaysData}
            loading={parlaysLoading}
            hasUserId={!!userId}
          />
        </div>
      )}

      {/* ── ANALYST ─────────────────────────────────────────────────────── */}
      {/* N35: interactive combinable query builder on all read picks */}
      {perfTab === "analyst" && (
        <div style={{ padding:"0 14px" }}>
          <DataAnalystPanel
            data={data}
            loading={loading}
            days={days}
          />
        </div>
      )}
    </div>
  );
}

// ── PARLAY PERFORMANCE PANEL ──────────────────────────────────────────────
// N33: Jarvis engine parley history with per-strategy HR breakdown
// N39: Rollover chain step history with per-step win rate
function ParlayPerformancePanel({ days, data, loading, hasUserId }) {
  const [stream, setStream] = useState("jarvis"); // "jarvis" | "rollover"

  if (loading) return (
    <div style={{ padding:40, textAlign:"center", color:C.muted, fontSize:10 }}>
      Loading parley history…
    </div>
  );

  if (!data) return (
    <div style={{ padding:40, textAlign:"center", color:C.text, opacity:.3, fontSize:10 }}>
      No parley history yet.
      <span style={{ display:"block", fontSize:8, marginTop:8, opacity:.6, lineHeight:1.6 }}>
        Build and use Jarvis tickets daily. Rollover steps are tracked automatically.
      </span>
    </div>
  );

  const jarvis   = data.jarvis   || {};
  const rollover = data.rollover || {};

  // Jarvis aggregate
  const jParlays   = (jarvis.byDate || []).flatMap(d => d.strategies || []);
  const jTotal     = jParlays.length;
  const jWins      = jParlays.filter(s => s.parlayResult === "WIN").length;
  const jLosses    = jParlays.filter(s => s.parlayResult === "LOSS").length;
  const jPending   = jTotal - jWins - jLosses;
  const jResolved  = jWins + jLosses;
  const jHR        = jResolved ? Math.round(jWins / jResolved * 100) : null;

  // Rollover aggregate
  const rvlTotal   = rollover.total    || 0;
  const rvlWins    = rollover.wins     || 0;
  const rvlHR      = rollover.hitRate  ?? null;
  const rvlResolved = rollover.resolved || 0;
  const rvlPending = rvlTotal - rvlResolved;

  const hrColor = hr => hr == null ? C.muted : hr >= 50 ? C.green : hr >= 30 ? C.gold : C.red;

  return (
    <div>
      {/* Stream toggle */}
      <div style={{ display:"flex", background:C.faint, borderRadius:10, padding:3, gap:2, marginBottom:14 }}>
        {[
          { id:"jarvis",   label:"Jarvis Parleys",  count:jTotal   },
          { id:"rollover", label:"Rollover Steps",  count:rvlTotal },
        ].map(s => {
          const on = stream === s.id;
          return (
            <button key={s.id} onClick={() => setStream(s.id)}
              style={{
                flex:1, padding:"7px 8px", borderRadius:8,
                border: on ? `1px solid ${C.border}` : "1px solid transparent",
                background: on ? C.surface : "transparent",
                color: on ? C.accent : C.muted,
                fontSize:10, fontWeight: on ? 800 : 500,
                cursor:"pointer", fontFamily:C.font,
                boxShadow: on ? "0 1px 4px rgba(0,0,0,.18)" : "none",
                transition:"all .15s",
                display:"flex", flexDirection:"column", alignItems:"center", gap:2,
              }}>
              <span>{s.label}</span>
              <span style={{ fontSize:8, opacity:.6, fontWeight:500 }}>{s.count} total</span>
            </button>
          );
        })}
      </div>

      {/* ── JARVIS stream ──────────────────────────────────────────────── */}
      {stream === "jarvis" && (
        <>
          {/* Headline */}
          {jTotal > 0 && (
            <div className="gc" style={{ padding:16, marginBottom:12 }}>
              <div style={{ fontSize:7, color:C.gold, textTransform:"uppercase", letterSpacing:".14em", fontWeight:800, marginBottom:14 }}>
                Jarvis Parleys · last {days}d
              </div>
              <div style={{ display:"grid", gridTemplateColumns:"repeat(4,1fr)", gap:10, marginBottom: jHR != null ? 14 : 0 }}>
                {[["Total",jTotal,C.text],["Won",jWins,C.green],["Lost",jLosses,C.red],["Pending",jPending,C.muted]].map(([l,v,col]) => (
                  <div key={l} style={{ textAlign:"center" }}>
                    <div style={{ fontSize:20, fontWeight:900, color:col, lineHeight:1 }}>{v}</div>
                    <div style={{ fontSize:7, color:C.muted, marginTop:4, letterSpacing:".06em", textTransform:"uppercase" }}>{l}</div>
                  </div>
                ))}
              </div>
              {jHR != null && (
                <div style={{ borderTop:`1px solid ${C.border}`, paddingTop:12, display:"flex", alignItems:"center", gap:12 }}>
                  <div style={{ flex:1 }}>
                    <div style={{ fontSize:7, color:C.muted, marginBottom:5 }}>Parley hit rate — resolved only</div>
                    <div style={{ height:5, background:C.faint, borderRadius:3, overflow:"hidden" }}>
                      <div style={{ height:"100%", width:`${jHR}%`, background:hrColor(jHR), borderRadius:3, transition:"width .4s" }} />
                    </div>
                  </div>
                  <div style={{ fontSize:24, fontWeight:900, color:hrColor(jHR), lineHeight:1, flexShrink:0 }}>{jHR}%</div>
                </div>
              )}
            </div>
          )}

          {/* N33: Per-strategy HR breakdown */}
          {jarvis.strategyBreakdown?.length > 0 && (
            <div className="gc" style={{ padding:14, marginBottom:12 }}>
              <div style={{ fontSize:7, color:C.edge, textTransform:"uppercase", letterSpacing:".14em", fontWeight:800, marginBottom:1 }}>
                By Strategy Label
              </div>
              <div style={{ fontSize:7, color:C.muted, marginBottom:12 }}>
                Hit rate per Jarvis ticket type — resolved parleys only
              </div>
              {jarvis.strategyBreakdown.map(s => {
                const col = hrColor(s.hitRate);
                const resolved = s.wins + s.losses;
                if (!resolved && !s.pending) return null;
                return (
                  <div key={s.label} style={{ marginBottom:10 }}>
                    <div style={{ display:"flex", justifyContent:"space-between", alignItems:"baseline", marginBottom:4 }}>
                      <span style={{ fontSize:9, fontWeight:700, color:C.text }}>{s.label}</span>
                      <div style={{ display:"flex", alignItems:"baseline", gap:8 }}>
                        <span style={{ fontSize:9, fontWeight:800, color:col }}>
                          {s.hitRate != null ? `${s.hitRate}%` : "—"}
                        </span>
                        <span style={{ fontSize:7, color:C.muted }}>
                          {s.wins}W {s.losses}L{s.pending ? ` ${s.pending}P` : ""}
                        </span>
                      </div>
                    </div>
                    {s.hitRate != null && (
                      <div style={{ height:4, background:C.faint, borderRadius:2, overflow:"hidden" }}>
                        <div style={{ height:"100%", width:`${s.hitRate}%`, background:col, borderRadius:2, transition:"width .4s" }} />
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {/* Per-date accordion */}
          {jarvis.byDate?.length > 0
            ? <ParlayHistoryAccordion byDate={jarvis.byDate} />
            : <div style={{ padding:"32px 0", textAlign:"center", color:C.muted, fontSize:9 }}>No Jarvis parley history in this range.</div>
          }
        </>
      )}

      {/* ── ROLLOVER stream ────────────────────────────────────────────── */}
      {stream === "rollover" && (
        <>
          {!hasUserId && (
            <div style={{ padding:"20px 0 12px", textAlign:"center", fontSize:9, color:C.muted, lineHeight:1.7 }}>
              Start a Rollover chain to track step-by-step results here.
            </div>
          )}

          {/* Headline */}
          {rvlTotal > 0 && (
            <div className="gc" style={{ padding:16, marginBottom:12 }}>
              <div style={{ fontSize:7, color:C.green, textTransform:"uppercase", letterSpacing:".14em", fontWeight:800, marginBottom:14 }}>
                Rollover Steps · last {days}d
              </div>
              <div style={{ display:"grid", gridTemplateColumns:"repeat(4,1fr)", gap:10, marginBottom: rvlHR != null ? 14 : 0 }}>
                {[["Total",rvlTotal,C.text],["Won",rvlWins,C.green],["Lost",rvlTotal-rvlWins-(rvlTotal-rvlResolved),C.red],["Pending",rvlPending,C.muted]].map(([l,v,col]) => (
                  <div key={l} style={{ textAlign:"center" }}>
                    <div style={{ fontSize:20, fontWeight:900, color:col, lineHeight:1 }}>{v}</div>
                    <div style={{ fontSize:7, color:C.muted, marginTop:4, letterSpacing:".06em", textTransform:"uppercase" }}>{l}</div>
                  </div>
                ))}
              </div>
              {rvlHR != null && (
                <div style={{ borderTop:`1px solid ${C.border}`, paddingTop:12, display:"flex", alignItems:"center", gap:12 }}>
                  <div style={{ flex:1 }}>
                    <div style={{ fontSize:7, color:C.muted, marginBottom:5 }}>Step win rate — resolved only</div>
                    <div style={{ height:5, background:C.faint, borderRadius:3, overflow:"hidden" }}>
                      <div style={{ height:"100%", width:`${rvlHR}%`, background:hrColor(rvlHR), borderRadius:3, transition:"width .4s" }} />
                    </div>
                  </div>
                  <div style={{ fontSize:24, fontWeight:900, color:hrColor(rvlHR), lineHeight:1, flexShrink:0 }}>{rvlHR}%</div>
                </div>
              )}
            </div>
          )}

          {/* N39: Per-step breakdown */}
          {rollover.byStep && Object.keys(rollover.byStep).length > 0 && (
            <div className="gc" style={{ padding:14, marginBottom:12 }}>
              <div style={{ fontSize:7, color:C.edge, textTransform:"uppercase", letterSpacing:".14em", fontWeight:800, marginBottom:1 }}>
                By Chain Step
              </div>
              <div style={{ fontSize:7, color:C.muted, marginBottom:12 }}>
                Where in the chain wins and losses happen most
              </div>
              {Object.entries(rollover.byStep).sort((a,b) => Number(a[0])-Number(b[0])).map(([step, d]) => {
                const resolved = d.wins + d.losses;
                const rate     = resolved ? Math.round(d.wins / resolved * 100) : null;
                const col      = hrColor(rate);
                return (
                  <div key={step} style={{ marginBottom:9 }}>
                    <div style={{ display:"flex", justifyContent:"space-between", alignItems:"baseline", marginBottom:3 }}>
                      <span style={{ fontSize:9, fontWeight:700, color:C.text }}>Step {step}</span>
                      <div style={{ display:"flex", alignItems:"baseline", gap:8 }}>
                        <span style={{ fontSize:9, fontWeight:800, color:col }}>{rate != null ? `${rate}%` : "—"}</span>
                        <span style={{ fontSize:7, color:C.muted }}>{d.wins}W {d.losses}L{d.pending ? ` ${d.pending}P` : ""}</span>
                      </div>
                    </div>
                    {rate != null && (
                      <div style={{ height:4, background:C.faint, borderRadius:2, overflow:"hidden" }}>
                        <div style={{ height:"100%", width:`${rate}%`, background:col, borderRadius:2, transition:"width .4s" }} />
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {/* Rollover step list */}
          {rollover.steps?.length > 0
            ? <RolloverStepList steps={rollover.steps} />
            : rvlTotal === 0 && <div style={{ padding:"32px 0", textAlign:"center", color:C.muted, fontSize:9 }}>No rollover steps in this range.</div>
          }
        </>
      )}
    </div>
  );
}

// ── PARLAY HISTORY ACCORDION — Jarvis ────────────────────────────────────
function ParlayHistoryAccordion({ byDate }) {
  const [openDate, setOpenDate] = useState(null);
  const rows = [...byDate].sort((a, b) => b.date.localeCompare(a.date));

  return (
    <div className="gc" style={{ padding:14, marginBottom:12 }}>
      <div style={{ fontSize:7, color:C.muted, textTransform:"uppercase", letterSpacing:".1em", fontWeight:700, marginBottom:10 }}>
        By Date
      </div>
      <div style={{ display:"flex", flexDirection:"column", gap:3 }}>
        {rows.map(day => {
          const strats  = day.strategies || [];
          const wins    = strats.filter(s => s.parlayResult === "WIN").length;
          const losses  = strats.filter(s => s.parlayResult === "LOSS").length;
          const pending = strats.filter(s => !s.parlayResult || s.parlayResult === "PENDING" || s.parlayResult === "PARTIAL").length;
          const resolved = wins + losses;
          const dayRate  = resolved ? Math.round(wins / resolved * 100) : null;
          const rateCol  = dayRate == null ? C.muted : dayRate >= 50 ? C.green : dayRate >= 30 ? C.gold : C.red;
          const isOpen   = openDate === day.date;

          return (
            <div key={day.date}>
              <button onClick={() => strats.length && setOpenDate(isOpen ? null : day.date)}
                style={{
                  width:"100%", display:"grid",
                  gridTemplateColumns:"90px 1fr 48px 48px 18px",
                  gap:6, alignItems:"center",
                  padding:"8px 8px", borderRadius:7,
                  background: isOpen ? C.surface : "transparent",
                  border:`1px solid ${isOpen ? C.border : "transparent"}`,
                  cursor: strats.length ? "pointer" : "default",
                  fontFamily:C.font, textAlign:"left",
                }}>
                <span style={{ fontSize:9, fontWeight:700, color:C.text }}>{day.date}</span>
                <div style={{ display:"flex", gap:4, alignItems:"center" }}>
                  {wins > 0    && <span style={{ fontSize:8, fontWeight:800, color:C.green  }}>{wins}W</span>}
                  {losses > 0  && <span style={{ fontSize:8, fontWeight:800, color:C.red    }}>{losses}L</span>}
                  {pending > 0 && <span style={{ fontSize:8, fontWeight:600, color:C.muted  }}>{pending}P</span>}
                </div>
                <span style={{ fontSize:9, fontWeight:800, color:rateCol, textAlign:"right" }}>
                  {dayRate != null ? `${dayRate}%` : "—"}
                </span>
                <span style={{ fontSize:7, color:C.muted, textAlign:"right" }}>{strats.length} tkt</span>
                {strats.length
                  ? <span style={{ fontSize:9, color:C.muted, textAlign:"right" }}>{isOpen ? "▲" : "▼"}</span>
                  : <span />}
              </button>

              {isOpen && (
                <div style={{ background:C.surface, border:`1px solid ${C.border}`, borderTop:"none",
                  borderRadius:"0 0 7px 7px", padding:"6px 10px 10px", marginBottom:2 }}>
                  {strats.map((s, si) => {
                    const vc = s.parlayResult === "WIN" ? C.green : s.parlayResult === "LOSS" ? C.red : C.muted;
                    const vl = s.parlayResult === "WIN" ? "WIN" : s.parlayResult === "LOSS" ? "LOSS" : s.parlayResult === "PARTIAL" ? "PARTIAL" : "PENDING";
                    const legCount = (s.legs || []).length;
                    return (
                      <div key={si} style={{ padding:"8px 0", borderBottom: si < strats.length-1 ? `1px solid ${C.border}` : "none" }}>
                        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start", marginBottom:5 }}>
                          <div>
                            <span style={{ fontSize:9, fontWeight:800, color:C.text }}>{s.label || `Ticket ${si+1}`}</span>
                            <span style={{ fontSize:7, color:C.muted, marginLeft:6 }}>
                              {legCount} leg{legCount!==1?"s":""} · {s.combinedOdds ? `${s.combinedOdds}×` : "—"}
                            </span>
                          </div>
                          <span style={{ fontSize:8, fontWeight:800, color:vc, background:`${vc}15`, border:`1px solid ${vc}35`, borderRadius:4, padding:"1px 7px" }}>
                            {vl}
                          </span>
                        </div>
                        <div style={{ display:"flex", flexWrap:"wrap", gap:4 }}>
                          {(s.legs || []).map((leg, li) => {
                            const lc = leg.result === "WIN" ? C.green : leg.result === "LOSS" ? C.red : C.muted;
                            return (
                              <span key={li} style={{ fontSize:7, color:lc, background:`${lc}10`, border:`1px solid ${lc}30`,
                                borderRadius:4, padding:"1px 6px", whiteSpace:"nowrap",
                                maxWidth:140, overflow:"hidden", textOverflow:"ellipsis" }}>
                                {leg.market || leg.pick || "Pick"}
                                {leg.result && leg.result !== "PENDING" ? ` · ${leg.result === "WIN" ? "W" : "L"}` : ""}
                                {leg.score ? ` ${leg.score}` : ""}
                              </span>
                            );
                          })}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── ROLLOVER STEP LIST ────────────────────────────────────────────────────
// N39: compact step-by-step result log for Rollover stream in Parleys tab
function RolloverStepList({ steps }) {
  const [openIdx, setOpenIdx] = useState(null);

  return (
    <div className="gc" style={{ padding:14, marginBottom:12 }}>
      <div style={{ fontSize:7, color:C.muted, textTransform:"uppercase", letterSpacing:".1em", fontWeight:700, marginBottom:10 }}>
        Step Log
      </div>
      <div style={{ display:"flex", flexDirection:"column", gap:3 }}>
        {steps.map((s, i) => {
          const rc      = s.result === "WIN" ? C.green : s.result === "LOSS" ? C.red : C.muted;
          const isOpen  = openIdx === i;
          const hasLegs = s.legs?.length > 0;
          return (
            <div key={i}>
              <button
                onClick={() => hasLegs && setOpenIdx(isOpen ? null : i)}
                style={{
                  width:"100%", display:"grid",
                  gridTemplateColumns:"90px 36px 1fr 52px 18px",
                  gap:6, alignItems:"center",
                  padding:"7px 8px", borderRadius:7,
                  background: isOpen ? C.surface : "transparent",
                  border:`1px solid ${isOpen ? C.border : "transparent"}`,
                  cursor: hasLegs ? "pointer" : "default",
                  fontFamily:C.font, textAlign:"left",
                }}>
                <span style={{ fontSize:8, color:C.muted }}>{s.date}</span>
                <span style={{ fontSize:8, fontWeight:700, color:C.text }}>S{s.step}</span>
                <span style={{ fontSize:8, color:C.text, opacity:.6 }}>
                  {s.potBefore != null ? `$${parseFloat(s.potBefore).toFixed(0)}` : ""}
                  {s.odds ? ` · ×${parseFloat(s.odds).toFixed(2)}` : ""}
                </span>
                <span style={{ fontSize:9, fontWeight:800, color:rc, textAlign:"right" }}>
                  {s.result === "WIN" ? "WIN" : s.result === "LOSS" ? "LOSS" : "PENDING"}
                </span>
                {hasLegs
                  ? <span style={{ fontSize:9, color:C.muted, textAlign:"right" }}>{isOpen ? "▲" : "▼"}</span>
                  : <span />}
              </button>
              {isOpen && hasLegs && (
                <div style={{ background:C.surface, border:`1px solid ${C.border}`, borderTop:"none",
                  borderRadius:"0 0 7px 7px", padding:"6px 10px 8px", marginBottom:1 }}>
                  {s.legs.map((leg, li) => {
                    const lc = leg.result === "WIN" ? C.green : leg.result === "LOSS" ? C.red : C.muted;
                    return (
                      <div key={li} style={{ display:"flex", justifyContent:"space-between", alignItems:"center",
                        padding:"4px 0", borderBottom: li < s.legs.length-1 ? `1px solid ${C.border}` : "none" }}>
                        <div style={{ minWidth:0, flex:1 }}>
                          <div style={{ fontSize:8, color:C.text, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>
                            {leg.game || `${leg.home||"?"} vs ${leg.away||"?"}`}
                          </div>
                          <div style={{ fontSize:7, color:C.muted }}>{leg.market || leg.pick || "—"}</div>
                        </div>
                        <div style={{ display:"flex", alignItems:"center", gap:6, flexShrink:0, marginLeft:8 }}>
                          {leg.score && <span style={{ fontSize:7, color:C.muted }}>{leg.score}</span>}
                          <span style={{ fontSize:9, fontWeight:800, color:lc }}>
                            {leg.result === "WIN" ? "W" : leg.result === "LOSS" ? "L" : "–"}
                          </span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}


// ── FIXTURE DRILL SECTION — N37 / N38 ────────────────────────────────────
// Reusable component for both By Market and By Strategy.
// Each aggregate bar is tappable — expands to show every individual pick
// in that bucket with date, game, pick, odds, result.
// bucketKey "market" → groups by pick.market
// bucketKey "tags"   → groups by pick.tags[] (strategy can tag a pick multiple times)
function FixtureDrillSection({ title, subtitle, accentColor, aggregates, dailyTrend, bucketKey, labelFn, pickFilter }) {
  const [openBucket, setOpenBucket] = useState(null);

  if (!Object.keys(aggregates).length) return null;

  // Build per-bucket pick lists — apply pickFilter if provided
  const bucketMap = {};
  for (const day of dailyTrend) {
    for (const pick of (day.picks || [])) {
      if (pickFilter && !pickFilter(pick)) continue;
      const keys = bucketKey === "tags"
        ? (pick.tags || [pick.market]).filter(Boolean)
        : [pick[bucketKey]].filter(Boolean);
      for (const k of keys) {
        if (!bucketMap[k]) bucketMap[k] = [];
        bucketMap[k].push({ ...pick, date: day.date });
      }
    }
  }

  const sorted = Object.entries(aggregates)
    .sort((a, b) => b[1].total - a[1].total);

  return (
    <div className="gc" style={{ padding:14, marginBottom:12 }}>
      <div style={{ fontSize:7, color:accentColor, textTransform:"uppercase", letterSpacing:".14em", fontWeight:800, marginBottom:1 }}>
        {title}
      </div>
      <div style={{ fontSize:7, color:C.muted, marginBottom:12 }}>{subtitle}</div>

      <div style={{ display:"flex", flexDirection:"column", gap:2 }}>
        {sorted.map(([key, d]) => {
          const col    = d.rate >= 65 ? C.green : d.rate >= 50 ? C.gold : C.red;
          const isOpen = openBucket === key;
          const picks  = (bucketMap[key] || []).sort((a, b) => b.date.localeCompare(a.date));

          return (
            <div key={key}>
              {/* Bar row — tappable header */}
              <button
                onClick={() => setOpenBucket(isOpen ? null : key)}
                style={{
                  width:"100%", background:"transparent", border:"none",
                  padding:"8px 6px", cursor:"pointer", fontFamily:C.font,
                  borderRadius:7,
                  background: isOpen ? `${col}08` : "transparent",
                  transition:"background .12s",
                }}>
                <div style={{ display:"flex", justifyContent:"space-between", alignItems:"baseline", marginBottom:5 }}>
                  <span style={{ fontSize:9, fontWeight:700, color:C.text, textAlign:"left" }}>
                    {labelFn(key)}
                  </span>
                  <div style={{ display:"flex", alignItems:"baseline", gap:8 }}>
                    <span style={{ fontSize:9, fontWeight:800, color:col }}>{d.rate}%</span>
                    <span style={{ fontSize:7, color:C.muted }}>{d.wins}/{d.total}</span>
                    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke={C.muted}
                      strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"
                      style={{ transform: isOpen ? "rotate(180deg)" : "rotate(0deg)", transition:"transform .2s", flexShrink:0 }}>
                      <polyline points="6 9 12 15 18 9"/>
                    </svg>
                  </div>
                </div>
                {/* Progress bar */}
                <div style={{ height:4, background:C.faint, borderRadius:2, overflow:"hidden" }}>
                  <div style={{ height:"100%", width:`${Math.min(d.rate,100)}%`,
                    background:col, borderRadius:2, transition:"width .4s" }} />
                </div>
              </button>

              {/* Drill-down fixture list */}
              {isOpen && (
                <div style={{
                  background:C.surface, border:`1px solid ${C.border}`,
                  borderRadius:"0 0 8px 8px", padding:"6px 10px 10px",
                  marginBottom:4,
                }}>
                  {picks.length === 0 ? (
                    <div style={{ padding:"12px 0", textAlign:"center", fontSize:8, color:C.muted }}>
                      No individual pick data — enhanced stats not yet available for this range.
                    </div>
                  ) : (
                    <>
                      {/* Mini sub-header: pick count + quick W/L tally */}
                      {(() => {
                        const w = picks.filter(p => p.result === "WIN").length;
                        const l = picks.filter(p => p.result === "LOSS").length;
                        const p = picks.filter(p => p.result === "PENDING" || !p.result).length;
                        return (
                          <div style={{ display:"flex", gap:10, padding:"4px 0 8px", borderBottom:`1px solid ${C.border}`, marginBottom:6 }}>
                            <span style={{ fontSize:7, color:C.green, fontWeight:700 }}>{w}W</span>
                            <span style={{ fontSize:7, color:C.red,   fontWeight:700 }}>{l}L</span>
                            {p > 0 && <span style={{ fontSize:7, color:C.muted }}>{p}P</span>}
                            <span style={{ fontSize:7, color:C.muted, marginLeft:"auto" }}>{picks.length} picks</span>
                          </div>
                        );
                      })()}

                      {/* Pick rows */}
                      {picks.slice(0, 60).map((pick, i) => {
                        const rc = pick.result === "WIN" ? C.green : pick.result === "LOSS" ? C.red : C.muted;
                        return (
                          <div key={i} style={{
                            display:"grid", gridTemplateColumns:"68px 1fr auto auto",
                            gap:6, alignItems:"center",
                            padding:"5px 0",
                            borderBottom: i < Math.min(picks.length, 60) - 1 ? `1px solid ${C.border}` : "none",
                          }}>
                            <span style={{ fontSize:7, color:C.muted }}>{pick.date}</span>
                            <div style={{ minWidth:0 }}>
                              <div style={{ fontSize:8, color:C.text, fontWeight:600,
                                overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>
                                {pick.game}
                              </div>
                              <div style={{ fontSize:7, color:C.muted, marginTop:1 }}>
                                {pick.pick}
                                {pick.league ? ` · ${pick.league}` : ""}
                                {pick.type === "value" && (
                                  <span style={{ color:C.edge, marginLeft:4, fontWeight:600 }}>Edge</span>
                                )}
                              </div>
                            </div>
                            <span style={{ fontSize:8, color:C.gold, fontWeight:700, textAlign:"right" }}>
                              {pick.odds ? `${pick.odds}×` : "—"}
                            </span>
                            <div style={{ textAlign:"right", minWidth:28 }}>
                              <span style={{ fontSize:8, fontWeight:800, color:rc }}>
                                {pick.result === "WIN" ? "W" : pick.result === "LOSS" ? "L" : pick.score || "–"}
                              </span>
                            </div>
                          </div>
                        );
                      })}

                      {picks.length > 60 && (
                        <div style={{ textAlign:"center", fontSize:7, color:C.muted, paddingTop:8 }}>
                          Showing 60 of {picks.length} — use Analyst tab for full filtering
                        </div>
                      )}
                    </>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── DATA ANALYST PANEL — N35 ─────────────────────────────────────────────
// Combinable filter query builder on all read picks from enhanced pool data.
// No server round-trip per query — filters run client-side on already-fetched data.
// Filters: market, pick type (safe/value), league, result, min confidence.
function DataAnalystPanel({ data, loading, days }) {
  const [filters, setFilters] = useState({
    market:  "all",
    type:    "all",
    league:  "all",
    result:  "all",
    minConf: 0,
  });
  const [sortBy, setSortBy] = useState("date");

  if (loading) return (
    <div style={{ padding:40, textAlign:"center", color:C.muted, fontSize:10 }}>Loading…</div>
  );
  if (!data?.dailyTrend?.length) return (
    <div style={{ padding:"48px 0", textAlign:"center", color:C.text, opacity:.3, fontSize:10 }}>
      No pick data yet for this range.
    </div>
  );

  // Flatten all picks across the window with date attached
  const allPicks = data.dailyTrend.flatMap(d =>
    (d.picks || []).map(p => ({ ...p, date: d.date }))
  ).filter(p => p.result !== undefined);

  // Build filter option lists from data
  const markets  = ["all", ...new Set(allPicks.map(p => p.market).filter(Boolean))].sort();
  const leagues  = ["all", ...new Set(allPicks.map(p => p.league).filter(Boolean))].sort();

  // Apply filters
  const filtered = allPicks.filter(p => {
    if (filters.market !== "all" && p.market !== filters.market) return false;
    if (filters.type   !== "all" && p.type   !== filters.type)   return false;
    if (filters.league !== "all" && p.league !== filters.league)  return false;
    if (filters.result !== "all" && p.result !== filters.result)  return false;
    if (filters.minConf > 0 && (p.conf == null || p.conf < filters.minConf)) return false;
    return true;
  });

  // Sort
  const sorted = [...filtered].sort((a, b) => {
    if (sortBy === "conf") return (b.conf || 0) - (a.conf || 0);
    if (sortBy === "odds") return (b.odds || 0) - (a.odds || 0);
    return b.date.localeCompare(a.date);
  });

  // Compute stats on filtered set
  const resolved  = filtered.filter(p => p.result === "WIN" || p.result === "LOSS");
  const wins      = filtered.filter(p => p.result === "WIN").length;
  const hitRate   = resolved.length ? Math.round(wins / resolved.length * 100) : null;
  const avgOdds   = filtered.filter(p => p.odds).length
    ? (filtered.reduce((s, p) => s + (p.odds || 0), 0) / filtered.filter(p => p.odds).length).toFixed(2)
    : null;
  const avgConf   = filtered.filter(p => p.conf).length
    ? Math.round(filtered.reduce((s, p) => s + (p.conf || 0), 0) / filtered.filter(p => p.conf).length)
    : null;

  const hrCol = hitRate == null ? C.muted : hitRate >= 65 ? C.green : hitRate >= 50 ? C.gold : C.red;

  const setF = (k, v) => setFilters(f => ({ ...f, [k]: v }));
  const hasFilters = filters.market !== "all" || filters.type !== "all" ||
    filters.league !== "all" || filters.result !== "all" || filters.minConf > 0;

  return (
    <div>
      {/* Filter panel — always open, filters ARE the feature */}
      <div className="gc" style={{ padding:14, marginBottom:12 }}>
        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:12 }}>
          <div style={{ fontSize:7, color:C.edge, textTransform:"uppercase", letterSpacing:".14em", fontWeight:800 }}>
            Data Analyst
          </div>
          {hasFilters && (
            <button onClick={() => setFilters({ market:"all", type:"all", league:"all", result:"all", minConf:0 })}
              style={{ fontSize:7, color:C.muted, background:"transparent", border:`1px solid ${C.faint}`,
                borderRadius:5, padding:"2px 8px", cursor:"pointer", fontFamily:C.font }}>
              Clear filters
            </button>
          )}
        </div>

        <div style={{ display:"flex", flexDirection:"column", gap:12 }}>
          {/* Row 1: Market + Type */}
          <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:8 }}>
            <div>
              <div style={{ fontSize:7, color:C.muted, marginBottom:4, fontWeight:600 }}>Market</div>
              <select value={filters.market} onChange={e => setF("market", e.target.value)}
                style={{ width:"100%", padding:"6px 8px", fontSize:9, borderRadius:6, fontFamily:C.font,
                  background:C.surface, color:C.text, border:`1px solid ${C.border}` }}>
                {markets.map(m => <option key={m} value={m}>{m === "all" ? "All markets" : m}</option>)}
              </select>
            </div>
            <div>
              <div style={{ fontSize:7, color:C.muted, marginBottom:4, fontWeight:600 }}>Pick Type</div>
              <div style={{ display:"flex", gap:3 }}>
                {[["all","All"],["safe","Safe"],["value","Edge"]].map(([v,l]) => (
                  <button key={v} onClick={() => setF("type", v)}
                    style={{ flex:1, padding:"6px 0", fontSize:8, borderRadius:5, cursor:"pointer",
                      fontFamily:C.font, fontWeight: filters.type===v ? 700 : 400,
                      background: filters.type===v ? C.accent : "transparent",
                      color: filters.type===v ? C.accentText : C.muted,
                      border:`1px solid ${filters.type===v ? C.accent : C.faint}` }}>
                    {l}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {/* Row 2: League + Result */}
          <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:8 }}>
            <div>
              <div style={{ fontSize:7, color:C.muted, marginBottom:4, fontWeight:600 }}>League</div>
              <select value={filters.league} onChange={e => setF("league", e.target.value)}
                style={{ width:"100%", padding:"6px 8px", fontSize:9, borderRadius:6, fontFamily:C.font,
                  background:C.surface, color:C.text, border:`1px solid ${C.border}` }}>
                {leagues.map(l => <option key={l} value={l}>{l === "all" ? "All leagues" : l}</option>)}
              </select>
            </div>
            <div>
              <div style={{ fontSize:7, color:C.muted, marginBottom:4, fontWeight:600 }}>Result</div>
              <div style={{ display:"flex", gap:3 }}>
                {[["all","All"],["WIN","W"],["LOSS","L"],["PENDING","P"]].map(([v,l]) => {
                  const col = v === "WIN" ? C.green : v === "LOSS" ? C.red : v === "PENDING" ? C.gold : C.text;
                  const on  = filters.result === v;
                  return (
                    <button key={v} onClick={() => setF("result", v)}
                      style={{ flex:1, padding:"6px 0", fontSize:8, borderRadius:5, cursor:"pointer",
                        fontFamily:C.font, fontWeight: on ? 800 : 400,
                        background: on ? `${col}20` : "transparent",
                        color: on ? col : C.muted,
                        border:`1px solid ${on ? col+"60" : C.faint}` }}>
                      {l}
                    </button>
                  );
                })}
              </div>
            </div>
          </div>

          {/* Min confidence slider */}
          <div>
            <div style={{ display:"flex", justifyContent:"space-between", marginBottom:4 }}>
              <span style={{ fontSize:7, color:C.muted, fontWeight:600 }}>Min Confidence</span>
              <span style={{ fontSize:8, fontWeight:700, color: filters.minConf > 0 ? C.accent : C.muted }}>
                {filters.minConf > 0 ? `${filters.minConf}%+` : "Any"}
              </span>
            </div>
            <input type="range" min={0} max={95} step={5} value={filters.minConf}
              onChange={e => setF("minConf", Number(e.target.value))}
              style={{ width:"100%", accentColor:C.accent }} />
            <div style={{ display:"flex", justifyContent:"space-between", marginTop:1 }}>
              <span style={{ fontSize:6, color:C.muted }}>0%</span>
              <span style={{ fontSize:6, color:C.muted }}>95%</span>
            </div>
          </div>

          {/* Sort */}
          <div>
            <div style={{ fontSize:7, color:C.muted, marginBottom:4, fontWeight:600 }}>Sort by</div>
            <div style={{ display:"flex", gap:4 }}>
              {[["date","Date"],["conf","Confidence"],["odds","Odds"]].map(([v,l]) => (
                <button key={v} onClick={() => setSortBy(v)}
                  style={{ flex:1, padding:"6px 0", fontSize:8, borderRadius:5, cursor:"pointer",
                    fontFamily:C.font, fontWeight: sortBy===v ? 700 : 400,
                    background: sortBy===v ? C.accent : "transparent",
                    color: sortBy===v ? C.accentText : C.muted,
                    border:`1px solid ${sortBy===v ? C.accent : C.faint}` }}>
                  {l}
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* Stats on filtered set */}
        <div style={{ display:"grid", gridTemplateColumns:"repeat(4,1fr)", gap:8,
          borderTop:`1px solid ${C.border}`, paddingTop:12, marginTop:12 }}>
          {[
            ["Picks",    filtered.length,                     C.text],
            ["Hit Rate", hitRate != null ? `${hitRate}%`:"—", hrCol],
            ["Avg Odds", avgOdds ? `${avgOdds}×`:"—",         C.gold],
            ["Avg Conf", avgConf ? `${avgConf}%`:"—",         C.accent],
          ].map(([l,v,col]) => (
            <div key={l} style={{ textAlign:"center" }}>
              <div style={{ fontSize:16, fontWeight:900, color:col, lineHeight:1 }}>{v}</div>
              <div style={{ fontSize:7, color:C.muted, marginTop:3, textTransform:"uppercase", letterSpacing:".06em" }}>{l}</div>
            </div>
          ))}
        </div>
      </div>

      {/* Pick list */}
      {sorted.length === 0 ? (
        <div style={{ padding:"24px 0", textAlign:"center", color:C.muted, fontSize:9 }}>
          No picks match these filters.
        </div>
      ) : (
        <div className="gc" style={{ padding:14, marginBottom:12 }}>
          <div style={{ fontSize:7, color:C.muted, textTransform:"uppercase", letterSpacing:".1em", fontWeight:700, marginBottom:10 }}>
            {sorted.length} pick{sorted.length!==1?"s":""} · last {days}d
          </div>
          <div style={{ display:"flex", flexDirection:"column", gap:4 }}>
            {sorted.slice(0, 120).map((p, i) => {
              const rc = p.result === "WIN" ? C.green : p.result === "LOSS" ? C.red : C.muted;
              return (
                <div key={i} style={{ display:"grid", gridTemplateColumns:"78px 1fr auto auto auto",
                  gap:6, alignItems:"center", padding:"6px 8px", borderRadius:6,
                  background: i % 2 === 0 ? C.surface : "transparent",
                  border:`1px solid ${p.result==="WIN"?C.green+"20":p.result==="LOSS"?C.red+"15":"transparent"}` }}>
                  <span style={{ fontSize:7, color:C.muted }}>{p.date}</span>
                  <div style={{ minWidth:0 }}>
                    <div style={{ fontSize:8, color:C.text, fontWeight:600,
                      overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>
                      {p.game}
                    </div>
                    <div style={{ fontSize:7, color:C.muted, marginTop:1 }}>
                      {p.market}{p.league ? ` · ${p.league}` : ""}
                      {p.type === "value" && (
                        <span style={{ color:C.edge, marginLeft:4, fontWeight:600 }}>Edge</span>
                      )}
                    </div>
                  </div>
                  <span style={{ fontSize:7, color:C.muted, textAlign:"right" }}>
                    {p.conf ? `${p.conf}%` : "—"}
                  </span>
                  <span style={{ fontSize:8, fontWeight:700, color:C.gold, textAlign:"right" }}>
                    {p.odds ? `${p.odds}×` : "—"}
                  </span>
                  <span style={{ fontSize:8, fontWeight:800, color:rc, minWidth:32, textAlign:"right" }}>
                    {p.result === "WIN" ? "W" : p.result === "LOSS" ? "L" : p.score || "–"}
                  </span>
                </div>
              );
            })}
            {sorted.length > 120 && (
              <div style={{ textAlign:"center", fontSize:7, color:C.muted, paddingTop:6 }}>
                Showing 120 of {sorted.length} — narrow filters to see specific picks
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
// at the top level of a component, not inside callbacks or IIFEs in JSX.
function ParlayExplainer() {
  const [open, setOpen] = useState(() => {
    try { return !localStorage.getItem("grm_parley_explainer_v3"); } catch { return true; }
  });
  const [tab, setTab] = useState("what"); // "what" | "modes" | "how"

  const dismiss = () => {
    setOpen(false);
    try { localStorage.setItem("grm_parley_explainer_v3","1"); } catch {}
  };

  if (!open) return (
    <button onClick={() => setOpen(true)} className="gb"
      style={{ width:"100%",background:"transparent",border:`1px solid ${C.faint}`,
               color:C.muted,padding:"6px 0",fontSize:8,marginBottom:10,
               display:"flex",alignItems:"center",justifyContent:"center",gap:5 }}>
      <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor"
        strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/>
        <line x1="12" y1="16" x2="12.01" y2="16"/>
      </svg>
      How the Parley System works
    </button>
  );

  const tabs = [
    { id:"what",  label:"What is a Parley?" },
    { id:"modes", label:"Jarvis Modes" },
    { id:"how",   label:"How to Use" },
  ];

  return (
    <div style={{ border:`1px solid ${C.gold}30`, borderRadius:12, marginBottom:14, overflow:"hidden" }}>

      {/* Header */}
      <div style={{ background:`${C.gold}0c`, padding:"10px 14px",
                    display:"flex", justifyContent:"space-between", alignItems:"center" }}>
        <span style={{ fontSize:10, fontWeight:800, color:C.gold }}>Parley System Guide</span>
        <button onClick={dismiss}
          style={{ background:"none",border:"none",color:C.muted,cursor:"pointer",fontSize:14,padding:0,lineHeight:1 }}>✕</button>
      </div>

      {/* Tab bar */}
      <div style={{ display:"flex", borderBottom:`1px solid ${C.border}` }}>
        {tabs.map(t => (
          <button key={t.id} onClick={() => setTab(t.id)}
            style={{ flex:1, padding:"7px 4px", border:"none", cursor:"pointer",
                     background:"transparent", fontFamily:C.font,
                     fontSize:8, fontWeight:tab===t.id?800:500,
                     color:tab===t.id?C.gold:C.muted,
                     borderBottom:`2px solid ${tab===t.id?C.gold:"transparent"}`,
                     transition:"all .15s" }}>
            {t.label}
          </button>
        ))}
      </div>

      {/* Content */}
      <div style={{ padding:"12px 14px", fontSize:9, color:C.text, lineHeight:1.75 }}>

        {tab === "what" && (
          <div style={{ display:"flex", flexDirection:"column", gap:10 }}>
            <div>
              A <span style={{ fontWeight:800, color:C.gold }}>parley</span> is a multi-leg bet where every selection must win. The odds multiply — a 5-leg ticket with average odds of 1.8× per leg compounds to <span style={{ fontWeight:700 }}>~19×</span>. Higher reward, higher risk.
            </div>
            <div>
              GRM's model scores each fixture on probability, historical hit rate, and pattern signals. The best-scoring games form your ticket pool. The engine picks legs that <span style={{ fontWeight:700 }}>don't overlap</span> — no two tickets share a leg unless the pool is exhausted.
            </div>
            <div style={{ background:`${C.amber}0e`, border:`1px solid ${C.amber}25`,
                          borderRadius:7, padding:"8px 10px" }}>
              <span style={{ color:C.amber, fontWeight:800 }}>Always verify</span> — our booking code is automated. Check selections in your bookmaker app before placing. Game name mismatches can cause a leg to fail silently.
            </div>
          </div>
        )}

        {tab === "modes" && (
          <div style={{ display:"flex", flexDirection:"column", gap:8 }}>
            <div style={{ fontSize:9, color:C.muted, lineHeight:1.65, marginBottom:4 }}>
              Jarvis tickets are <span style={{ color:C.accent, fontWeight:700 }}>pre-built by the TA engine</span> before kickoff — not generated on demand. The engine uses learned patterns from Data Analysis (DA) and Situational Analysis (SA) to select and rank legs. You see the result when you open the Jarvis tab.
            </div>
            <div style={{ fontSize:8, color:C.muted, marginTop:4, lineHeight:1.6 }}>
              The engine exports one ticket per mode each day. Past dates show WIN/LOSS/PENDING per leg once results are in.
            </div>
          </div>
        )}

        {tab === "how" && (
          <div style={{ display:"flex", flexDirection:"column", gap:9 }}>
            {[
              { n:"1", title:"Pick a tab", body:"Jarvis tab = AI builds for you. Custom tab = you control odds target, stake, and pool." },
              { n:"2", title:"Research Mode", body:"In the Custom tab, toggle Research Mode before building. Jarvis pre-scores the top 8 candidates with live web context — injuries, form, lineup news. Boosted or penalised legs show a reason on the ticket." },
              { n:"3", title:"Remix or Swap", body:"Don't like a ticket? Tap ↺ Remix for a different combination from the same pool. To swap one leg, tap ↺ on that leg row." },
              { n:"4", title:"Edit Draft", body:"Tap Edit on a ticket to copy all legs to your Draft for manual adjustments. Tap a game to open Full Model — this does not edit the ticket." },
              { n:"5", title:"Book it", body:"Tap Book Now, choose a bookmaker, confirm. The code is generated automatically. Save your ticket first if you want to reference it later." },
            ].map(s => (
              <div key={s.n} style={{ display:"flex", gap:10, alignItems:"flex-start" }}>
                <div style={{ flexShrink:0, width:18, height:18, borderRadius:"50%",
                              background:`${C.gold}20`, border:`1px solid ${C.gold}40`,
                              display:"flex", alignItems:"center", justifyContent:"center",
                              fontSize:8, fontWeight:900, color:C.gold, marginTop:1 }}>
                  {s.n}
                </div>
                <div>
                  <div style={{ fontWeight:800, color:C.text, marginBottom:2 }}>{s.title}</div>
                  <div style={{ color:C.muted }}>{s.body}</div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ── JARVIS TA SLATE ──────────────────────────────────────────────────────────
// Fetches today's pre-built strategies from the TA engine output (via server),
// and renders them as tappable ticket cards. Replaces the old on-demand Jarvis builder.
//
// Data flow:
//   ticket-analyst.mjs --export  →  data/engine_parlays/YYYY-MM-DD_parlays.json
//   server GET /api/engine-parlays/today  →  { strategies: [...] }
//   JarvisTASlate renders each strategy as a card
//   onUseTicket(strategy)  →  ParlayJarvisTab adds to tickets state
//
// Each strategy card shows:
//   • Combined odds (e.g. "2.76×") — the only "label" users need
//   • Parlay probability % (from TA parlayProb)
//   • Leg count and markets summary
//   • DA historical HR if available
//   • Legs list (game, pick, odds)
//   • "Use This Ticket" CTA
// C is passed as a prop — useTheme() does not exist as a standalone hook in this codebase
function JarvisTASlate({ date, SERVER, onUseTicket, C, onFullModel }) {
  // N29-FIX: persist across tab switches via sessionStorage — component unmounts on nav
  const SS = `grm_taslate_v1_${date}`; // N30-FIX: key by date so past dates don't overwrite today
  const loadSS = () => { try { const d = sessionStorage.getItem(SS); return d ? JSON.parse(d) : null; } catch { return null; } };
  const saveSS = (v) => { try { sessionStorage.setItem(SS, JSON.stringify(v)); } catch {} };

  const cached = loadSS();
  const [status, setStatus]         = useState(cached?.status || "idle");
  const [strategies, setStrategies] = useState(cached?.strategies || []);
  const [expanded, setExpanded]     = useState(null);
  const [usedIds, setUsedIds]       = useState(new Set());
  const [fetchedDate, setFetchedDate] = useState(cached?.fetchedDate || null);

  // Fetch on mount and whenever date changes
  useEffect(() => {
    if (!date) return;
    // Don't re-fetch if we already have data for this date
    if (fetchedDate === date && strategies.length) return;

    let cancelled = false;
    setStatus("loading");

    fetch(`${SERVER}/api/engine-parlays/today${date ? `?date=${date}` : ``}`)
      .then(r => {
        if (!r.ok) throw new Error(`Server ${r.status}`);
        return r.json();
      })
      .then(data => {
        if (cancelled) return;
        const strats = Array.isArray(data.strategies) ? data.strategies : [];
        setStrategies(strats);
        const newStatus = strats.length ? "ready" : "empty";
        setStatus(newStatus);
        setFetchedDate(date);
        saveSS({ strategies: strats, status: newStatus, fetchedDate: date }); // N29-FIX
      })
      .catch(err => {
        if (cancelled) return;
        console.warn("[JarvisTASlate] fetch error:", err.message);
        setStatus("error");
      });

    return () => { cancelled = true; };
  }, [date, SERVER]); // eslint-disable-line react-hooks/exhaustive-deps

  // Retry on demand
  const handleRetry = () => {
    try { sessionStorage.removeItem(SS); } catch {}
    setFetchedDate(null);
    setStrategies([]);
    setStatus("idle");
  };

  // ── Loading ──────────────────────────────────────────────────────────────────
  if (status === "loading" || status === "idle") {
    return (
      <div style={{ padding:"32px 0",textAlign:"center" }}>
        <div style={{ fontSize:9,color:C.muted,letterSpacing:".1em" }}>
          <span className="pu">Loading today's picks…</span>
        </div>
      </div>
    );
  }

  // ── Error ────────────────────────────────────────────────────────────────────
  if (status === "error") {
    return (
      <div style={{ padding:"24px 0",textAlign:"center" }}>
        <div style={{ fontSize:10,color:C.red,marginBottom:10,fontWeight:700 }}>
          Could not load today's picks
        </div>
        <div style={{ fontSize:8,color:C.muted,marginBottom:14,lineHeight:1.6 }}>
          Make sure the server is running and TA has exported for today.
        </div>
        <button onClick={handleRetry} className="gb"
          style={{ fontSize:9,padding:"7px 18px",border:`1px solid ${C.border}`,color:C.muted,background:C.surface }}>
          Retry
        </button>
      </div>
    );
  }

  // ── Empty ────────────────────────────────────────────────────────────────────
  if (status === "empty" || !strategies.length) {
    return (
      <div style={{ padding:"32px 20px", textAlign:"center", display:"flex",
                    flexDirection:"column", alignItems:"center", gap:10 }}>
        <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke={C.muted}
          strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{ opacity:.5 }}>
          <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/>
          <line x1="12" y1="16" x2="12.01" y2="16"/>
        </svg>
        <div style={{ fontSize:10, fontWeight:700, color:C.muted }}>
          No pre-built tickets yet for today
        </div>
        <div style={{ fontSize:9, color:C.muted, opacity:.7, lineHeight:1.6, maxWidth:240 }}>
          Tickets are generated automatically before kickoff. Check back soon or try refreshing.
        </div>
        <button onClick={handleRetry} className="gb"
          style={{ fontSize:9, padding:"7px 18px", border:`1px solid ${C.border}`, color:C.muted, background:C.surface, marginTop:4 }}>
          Refresh
        </button>
      </div>
    );
  }

  // ── Strategy label + rationale — derived from TA signal data ───────────────
  // DA  = Directional Accuracy: how often this exact market+context has landed
  //        historically in GRM's learned data. High DA = pattern has real backing.
  // SA  = Situational Agreement: separate pattern engine that checks team form,
  //        fixture context, and market behaviour. SA patterns confirm the pick
  //        from a different angle. DA + SA together = two independent signals agree.
  const getStrategyLabel = (strat, idx) => {
    const legs    = strat.legs || [];
    const mkts    = [...new Set(legs.map(l => l.market).filter(Boolean))];
    const dom     = (mkts[0] || "").toLowerCase();
    const hasDA   = (strat.learnedHR || 0) > 0;
    const hasSA   = (strat.saPositive || 0) > 0;
    const isGoals = dom.includes("over") || dom.includes("under");
    const isDC    = dom.includes("dc");
    const isTB    = dom.includes("tb:");

    // Name — short, user-facing (no internal engine codes)
    let name;
    if (hasDA && hasSA && isGoals) name = "Goals Momentum";
    else if (hasDA && hasSA && isDC) name = "Covered Value";
    else if (hasDA && hasSA)         name = "Converging Signal";
    else if (hasDA && isTB)          name = "Team Goals";
    else if (hasDA && isGoals)       name = "Goals Backed";
    else if (hasDA)                  name = "Pattern Backed";
    else if (hasSA && isDC)          name = "Draw Cover";
    else if (hasSA)                  name = "Situational Pick";
    else if (isDC)                   name = "Safety Net";
    else if (dom.includes("under"))  name = "Under Pick";
    else if (dom.includes("over"))   name = "Goals Over";
    else                             name = `Ticket ${idx + 1}`;

    // One-line rationale — explain what the signals mean in plain English
    let rationale;
    if (hasDA && hasSA)
      rationale = `${strat.learnedHR}% historical hit rate · ${strat.saPositive} pattern${strat.saPositive!==1?"s":""} confirm`;
    else if (hasDA)
      rationale = `${strat.learnedHR}% historical hit rate on this market`;
    else if (hasSA)
      rationale = `${strat.saPositive} situational pattern${strat.saPositive!==1?"s":""} aligned`;
    else
      rationale = mkts.slice(0, 2).join(" · ") || "Mixed markets";

    return { name, rationale };
  };

  return (
    <div style={{ display:"flex", flexDirection:"column", gap:8 }}>

      {/* Header */}
      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:2 }}>
        <span style={{ fontSize:8, color:C.muted, letterSpacing:".06em" }}>
          {strategies.length} pre-built ticket{strategies.length!==1?"s":""} · tap any to see legs
        </span>
        {/* N30-FIX: show past date badge when not viewing today */}
        {date && date !== new Date().toISOString().split("T")[0] && (
          <span style={{ fontSize:7, fontWeight:800, color:C.amber, background:`${C.amber}15`,
                         border:`1px solid ${C.amber}35`, borderRadius:5, padding:"2px 7px",
                         letterSpacing:".06em", textTransform:"uppercase" }}>
            {date}
          </span>
        )}
      </div>

      {strategies.map((strat, idx) => {
        const isOpen   = expanded === strat.id;
        const isUsed   = usedIds.has(strat.id);
        const odds     = strat.combinedOdds;
        const pct      = strat.parlayPct;
        const legCount = (strat.legs || []).length;
        const mkts     = [...new Set((strat.legs||[]).map(l=>l.market).filter(Boolean))];
        const mktStr   = mkts.length === 0 ? "—"
          : mkts.length <= 2 ? mkts.join(" · ")
          : `${mkts.slice(0,2).join(" · ")} +${mkts.length-2}`;
        const { name, rationale } = getStrategyLabel(strat, idx);

        // N41-FIX: richer signal badges
        const hasDA   = (strat.learnedHR || 0) > 0;
        const hasSA   = (strat.saPositive || 0) > 0;
        const hrGrade = hasDA
          ? strat.learnedHR >= 70 ? { col:C.green, label:`${strat.learnedHR}% HR` }
          : strat.learnedHR >= 55 ? { col:C.gold,  label:`${strat.learnedHR}% HR` }
          : { col:C.muted, label:`${strat.learnedHR}% HR` }
          : null;

        // N36-FIX: verdict derived from server-enriched parlayResult
        const parlayResult = strat.parlayResult || null;
        const isPastDate   = date && date !== new Date().toISOString().split("T")[0];
        const verdictCol   = parlayResult === "WIN" ? C.green
                           : parlayResult === "LOSS" ? C.red
                           : parlayResult === "PARTIAL" ? C.amber
                           : C.muted;
        // B3.1-FIX: PARTIAL means some legs have finished, others haven't yet.
        // "IN PLAY" is clearer — the ticket is still live, not partially failed.
        const verdictLabel = parlayResult === "WIN" ? "WIN"
                           : parlayResult === "LOSS" ? "LOSS"
                           : parlayResult === "PARTIAL" ? "IN PLAY"
                           : isPastDate ? "PENDING" : null;

        const borderCol = isOpen ? `${C.accent}80`
          : parlayResult === "WIN"  ? `${C.green}50`
          : parlayResult === "LOSS" ? `${C.red}40`
          : isUsed ? `${C.green}40`
          : C.border;

        return (
          <div key={strat.id} style={{
            background: C.surface,
            border: `1px solid ${borderCol}`,
            borderRadius: 10,
            overflow: "hidden",
            transition: "border-color .15s",
          }}>

            {/* ── Collapsed — scan row (B3.3 redesign) ── */}
            <div onClick={() => setExpanded(isOpen ? null : strat.id)}
              style={{ padding:"14px 16px", cursor:"pointer" }}>

              {/* Row 1: odds dominant left · verdict/chevron right */}
              <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:8 }}>
                <div style={{ display:"flex", alignItems:"baseline", gap:8 }}>
                  <span style={{ fontSize:26, fontWeight:900, lineHeight:1,
                                 color: verdictLabel === "WIN" ? C.green
                                      : verdictLabel === "LOSS" ? C.red
                                      : isUsed ? C.green : C.text }}>
                    {odds ? `${odds}×` : "—"}
                  </span>
                  {pct != null && (
                    <span style={{ fontSize:9, color: pct>=60?C.green:pct>=40?C.gold:C.muted, fontWeight:700 }}>
                      {pct}%
                    </span>
                  )}
                </div>
                <div style={{ display:"flex", alignItems:"center", gap:6 }}>
                  {verdictLabel && (
                    <span style={{ fontSize:7, fontWeight:800, color:verdictCol,
                                   background:`${verdictCol}15`, border:`1px solid ${verdictCol}40`,
                                   borderRadius:4, padding:"2px 7px", letterSpacing:".06em" }}>
                      {verdictLabel}
                    </span>
                  )}
                  {isUsed && !verdictLabel && (
                    <span style={{ fontSize:7, fontWeight:700, color:C.green,
                                   background:`${C.green}12`, border:`1px solid ${C.green}30`,
                                   borderRadius:4, padding:"2px 7px" }}>Added</span>
                  )}
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke={C.muted} strokeWidth="2"
                    strokeLinecap="round" strokeLinejoin="round"
                    style={{ transform:isOpen?"rotate(180deg)":"rotate(0deg)", transition:"transform .2s" }}>
                    <polyline points="6 9 12 15 18 9"/>
                  </svg>
                </div>
              </div>

              {/* Probability bar */}
              {pct != null && (
                <div style={{ height:2, background:C.faint, borderRadius:2, marginBottom:8, overflow:"hidden" }}>
                  <div style={{ height:"100%", width:`${Math.min(pct,100)}%`,
                                background: pct>=60?C.green:pct>=40?C.gold:C.muted,
                                borderRadius:2, transition:"width .4s" }} />
                </div>
              )}

              {/* Row 2: name + signal badges */}
              <div style={{ display:"flex", alignItems:"center", gap:5, flexWrap:"wrap" }}>
                <span style={{ fontSize:8, fontWeight:800, letterSpacing:".05em",
                               color:C.accent, textTransform:"uppercase" }}>{name}</span>
                {hrGrade && (
                  <span style={{ fontSize:7, color:hrGrade.col,
                                 background:`${hrGrade.col}10`, border:`1px solid ${hrGrade.col}25`,
                                 borderRadius:4, padding:"1px 5px" }}>{hrGrade.label}</span>
                )}
                {hasSA && (
                  <span style={{ fontSize:7, color:C.edge,
                                 background:`${C.edge}10`, border:`1px solid ${C.edge}25`,
                                 borderRadius:4, padding:"1px 5px" }}>
                    {strat.saPositive} signal{strat.saPositive!==1?"s":""}
                  </span>
                )}
                <span style={{ fontSize:7, color:C.muted, marginLeft:"auto" }}>
                  {legCount} leg{legCount!==1?"s":""} · {mktStr}
                </span>
              </div>
            </div>

            {/* ── Expanded legs + CTA ── */}
            {isOpen && (
              <div style={{ borderTop:`1px solid ${C.border}`, padding:"10px 14px 14px" }}>

                {/* Signal explainer blurb */}
                {(hasDA || hasSA) && (
                  <div style={{ borderLeft:`2px solid ${C.accent}40`, paddingLeft:8,
                                marginBottom:10, fontSize:8, color:C.muted, lineHeight:1.6 }}>
                    {hasDA && hasSA
                      ? `${strat.learnedHR}% hit rate on this pattern · ${strat.saPositive} situational signal${strat.saPositive!==1?"s":""} agree`
                      : hasDA
                      ? `Landed ${strat.learnedHR}% historically — picks drawn from highest-confidence games`
                      : `${strat.saPositive} situational signal${strat.saPositive!==1?"s":""} aligned across form, context, and market behaviour`
                    }
                  </div>
                )}

                {/* Legs */}
                <div style={{ display:"flex", flexDirection:"column", gap:4, marginBottom:12 }}>
                  {(strat.legs || []).map((leg, li) => {
                    const canOpen  = !!(onFullModel && leg.fixtureId);
                    // N36-FIX: per-leg result from server enrichment
                    const legRes   = leg.result || null;
                    const legResCol = legRes === "WIN" ? C.green : legRes === "LOSS" ? C.red : C.muted;
                    return (
                    <div key={li}
                      onClick={canOpen ? () => onFullModel(leg.fixtureId) : undefined}
                      style={{
                        display:"flex", justifyContent:"space-between", alignItems:"center",
                        padding:"7px 10px", background:C.bg, borderRadius:7,
                        border:`1px solid ${legRes === "WIN" ? C.green+"30" : legRes === "LOSS" ? C.red+"30" : C.border}`,
                        cursor: canOpen ? "pointer" : "default",
                        transition: canOpen ? "background .12s" : undefined,
                      }}
                      onMouseEnter={canOpen ? e => e.currentTarget.style.background = C.surface : undefined}
                      onMouseLeave={canOpen ? e => e.currentTarget.style.background = C.bg : undefined}
                    >
                      <div style={{ minWidth:0, flex:1 }}>
                        <div style={{ fontSize:9, color:C.text, fontWeight:700,
                                      whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis",
                                      display:"flex", alignItems:"center", gap:5 }}>
                          {leg.game || `${leg.home||"?"} vs ${leg.away||"?"}`}
                          {canOpen && (
                            <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke={C.muted}
                              strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink:0 }}>
                              <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>
                              <polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/>
                            </svg>
                          )}
                        </div>
                        <div style={{ fontSize:8, color:C.muted, marginTop:2 }}>
                          {leg.market}{leg.league ? ` · ${leg.league}` : ""}
                        </div>
                      </div>
                      <div style={{ textAlign:"right", flexShrink:0, marginLeft:10, display:"flex", alignItems:"center", gap:6 }}>
                        {/* N36-FIX: per-leg verdict + score */}
                        {legRes && legRes !== "PENDING" && (
                          <span style={{ fontSize:9, fontWeight:800, color:legResCol }}>
                            {legRes === "WIN" ? "W" : "L"}{leg.score ? ` ${leg.score}` : ""}
                          </span>
                        )}
                        {leg.odds
                          ? <span style={{ fontSize:11, fontWeight:800, color: legRes === "LOSS" ? C.red : legRes === "WIN" ? C.green : C.gold }}>{leg.odds}×</span>
                          : <span style={{ fontSize:9, color:C.muted }}>{leg.conf ? `${leg.conf}%` : "—"}</span>
                        }
                      </div>
                    </div>
                    );
                  })}
                </div>

                {/* CTA — hide for resolved past-date tickets, show re-use otherwise */}
                <button
                  onClick={() => { onUseTicket(strat); setUsedIds(prev => new Set([...prev, strat.id])); setExpanded(null); }}
                  className="gb-primary"
                  style={{ width:"100%", padding:"11px 0", fontSize:11, fontWeight:800 }}>
                  {isPastDate && parlayResult && parlayResult !== "PENDING"
                    ? "Re-use This Ticket"
                    : isUsed ? "Re-add to Builder" : "Use This Ticket →"}
                </button>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
function ParlayJarvisTab({ fixtures, tickets, setTickets, draftLegs, setDraftLegs, budget, setBudget, budgetPct, setBudgetPct, numParlays, setNumParlays, targetOdds, setTargetOdds, marketFilter, toggleMarket, historicalRates, ensureHistoricalRates, date, onClose, engineFixtureIds, onAddLegToDraft, onFullModel, adminToken = "", jarvisBuiltTicket = null, onJarvisBuiltTicketConsumed, grmInboundCode = null, onGrmInboundConsumed, ensureFixturesForDate, goToFetchDate }) {
  const [view, setView] = useState("parlay");
  const [builderMode, setBuilderMode] = useState("jarvis"); // "jarvis" | "custom"
  const [jarvisModes, setJarvisModes] = useState(new Set(["safe"])); // multi-select: safe/value/longshot
  const [customPool, setCustomPool]   = useState("all"); // "all" | "engine"
  const [focusFixture, setFocus] = useState(null);
  const [returnTo, setReturnTo] = useState("parlay");
  const [building, setBuilding]           = useState(false);
  const [jarvisResearch, setJarvisResearch] = useState(false); // Research Mode — pre-scores candidates before building
  // P-FIX: ref on this panel's own scroll container (the panel itself scrolls —
  // it's a fixed, full-screen overlay, not the page). Used to bring newly
  // created UI state (a draft, a freshly loaded ticket) into view instead of
  // leaving the user wherever they happened to be scrolled.
  const panelRef = useRef(null);
  const scrollPanelToTop = () => {
    requestAnimationFrame(() => panelRef.current?.scrollTo({ top: 0, behavior: "smooth" }));
  };
  const [remixingId, setRemixingId]        = useState(null);  // ticketId currently being remixed (null = idle)
  const [autoMessage, setAutoMessage] = useState(null);
  const [analysing, setAnalysing] = useState(false); // Gemini analysis state for auto ticket
  const [autoAnalysis, setAutoAnalysis] = useState(null);
  const [savedTickets, setSavedTickets] = useState(() => { try { return loadSavedTickets() || []; } catch { return []; } });
  const [savedCodes, setSavedCodes] = useState(() => {
    try { return JSON.parse(localStorage.getItem("grm_saved_codes_v15") || "{}"); } catch { return {}; }
  });
  const [maxSameMarket, setMaxSameMarket] = useState(null); // P8-FIX: null = no cap by default; user sets a cap if they want one
  // H2-FIX: Market exclusion per Parley tab — excluded markets are filtered from pool before build
  const [parlayExcludedMarkets, setParlayExcludedMarkets] = useState(new Set());
  const toggleParlayExcludeMarket = (mkt) => setParlayExcludedMarkets(prev => {
    const next = new Set(prev); next.has(mkt) ? next.delete(mkt) : next.add(mkt); return next;
  });
  // League filter for pool — user can scope builds to specific leagues
  // Uses the same Set-based multi-select as the Live Model league filter
  const [parlayLeagueFilter, setParlayLeagueFilter] = useState(null);

  // Derive available leagues from loaded fixtures — dynamic, no hardcoded list.
  // Uses leagueId if present, falls back to league name string for older fixtures.
  // Sorted by leagueRank so Premier League appears before lower divisions.
  const parlayAvailableLeagues = useMemo(() => {
    const seen = new Map();
    for (const f of fixtures) {
      const id   = f.leagueId || f.league;
      const rank = f.leagueRank || 999;
      if (!seen.has(id) || rank < seen.get(id).leagueRank) {
        seen.set(id, {
          leagueId: id,
          league:   f.league || String(id),
          country:  f.country || "",
          leagueRank: rank,
        });
      }
    }
    return [...seen.values()].sort((a, b) => a.leagueRank - b.leagueRank);
  }, [fixtures]);
  // When a user opens a fixture from a loaded ticket leg, we track which ticket
  // they came from so "Replace in Ticket" patches that ticket instead of the draft.
  const [activeTicketId, setActiveTicketId] = useState(null);

  // When Jarvis sends a pre-built ticket via "View & Book" / "Save Ticket",
  // open it here. Save Ticket already saved it from chat and stays in chat —
  // it does not navigate, so this effect only ever fires for View & Book.
  useEffect(() => {
    if (!jarvisBuiltTicket) return;
    // _viewSaved = true means a ticket was opened by id only (legacy path,
    // kept for safety) — route to Saved tab to find it.
    if (jarvisBuiltTicket._viewSaved) {
      setView("saved");
      onJarvisBuiltTicketConsumed?.();
      return;
    }
    // B_VIEWFULL-FIX: add ticket to built tickets so activeTicketId lookup
    // finds it — previously the ticket was never in `tickets` state, causing
    // tickets.find(t => t.id === activeTicketId) to return undefined and the
    // Builder to render blank. Ticket goes to Builder only; Save is explicit.
    setTickets(prev => {
      if (prev.find(t => t.id === jarvisBuiltTicket.id)) return prev;
      return [{ ...jarvisBuiltTicket, source: "jarvis_view" }, ...prev];
    });
    setActiveTicketId(jarvisBuiltTicket.id);
    // CRITICAL TYPO FIX: this was setView("parley") — not a valid view ID.
    // Valid IDs in this component are "fixture" | "parlay" | "perf" |
    // "rollover" | "saved". "parley" matched none of them, so the tab
    // rendered nothing — the blank screen seen after tapping View Full/Book.
    setView("parlay"); // View & Book → Builder tab with ticket active
    onJarvisBuiltTicketConsumed?.();
  }, [jarvisBuiltTicket]); // eslint-disable-line react-hooks/exhaustive-deps

  // N19-FIX: Auto-load from ?grm= URL — fires once when code arrives
  // P-FIX: grmToast (plain string) replaced with grmNotice (typed object) so
  // we can tell the user what actually happened — not just "loaded", but
  // "loaded, and by the way this is a past/future date" or "loaded, but we
  // couldn't find fixture data for that date — here's how to fetch it."
  const [grmNotice, setGrmNotice] = useState(null); // { type, date?, code?, message? }
  const showGrmNotice = (notice, autoDismissMs = null) => {
    setGrmNotice(notice);
    if (autoDismissMs) {
      // Only clear if a newer notice hasn't already replaced this one.
      setTimeout(() => setGrmNotice(prev => (prev === notice ? null : prev)), autoDismissMs);
    }
  };

  const handleGrmLoaded = useCallback(async (ticket, code) => {
    const newTicket = {
      ...ticket,
      id:        ticket.id || ("grm_" + code),
      source:    "grm_share",
      savedAt:   new Date().toISOString(),
      slotLabel: ticket.label || `Shared ${code}`,
    };
    // Keep a copy in Saved so the link remains revisitable later.
    setSavedTickets(prev => {
      // Don't duplicate if already loaded
      if (prev.find(t => t.id === newTicket.id)) return prev;
      const updated = [newTicket, ...prev];
      persistTickets(updated);
      return updated;
    });

    // P-FIX: resolve whether we need to fetch fixtures for the ticket's date
    // BEFORE touching `tickets`. loadSnapshot clears `tickets` as a side
    // effect of switching the working date — doing this after adding the
    // ticket would immediately wipe it back out.
    const today = todayStr();
    const needsFetch = !!(ticket.date && ensureFixturesForDate && (ticket.date !== date || !fixtures.length));
    let fetchOk = true;
    if (needsFetch) fetchOk = await ensureFixturesForDate(ticket.date);

    // P-FIX: take the user straight to the built ticket in Builder instead of
    // dropping them on Saved and making them tap Load — that hop was the main
    // source of friction on the shared-ticket-link flow.
    setTickets(prev => {
      if (prev.find(t => t.id === newTicket.id)) return prev;
      return [{ ...newTicket, exhausted: false }, ...prev];
    });
    setActiveTicketId(newTicket.id);
    setView("parlay");

    // Bring the newly loaded ticket card into view — it's appended above the
    // builder form, but on a tall screen or with other tickets present it can
    // still land below the fold.
    requestAnimationFrame(() => {
      setTimeout(() => {
        document.getElementById(`grm-ticket-${newTicket.id}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
      }, 60);
    });

    // P-FIX: be explicit about the date context instead of silently switching
    // it (past/future) or silently failing to find fixtures (missing snapshot).
    if (ticket.date && !fetchOk) {
      // No snapshot exists for that date — don't pretend it worked. Tell the
      // user and give them a one-tap way to go fetch it themselves; this
      // notice stays up until dismissed since it needs action.
      showGrmNotice({ type: "missing", date: ticket.date, code });
    } else if (ticket.date && ticket.date < today) {
      showGrmNotice({ type: "past", date: ticket.date, code }, 6000);
    } else if (ticket.date && ticket.date > today) {
      showGrmNotice({ type: "future", date: ticket.date, code }, 6000);
    } else {
      showGrmNotice({ type: "loaded", code }, 3000);
    }
  }, [setSavedTickets, ensureFixturesForDate, date, fixtures.length]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!grmInboundCode) return;
    (async () => {
      try {
        const res = await fetch(`${SERVER}/api/ticket/${grmInboundCode}`);
        if (!res.ok) { showGrmNotice({ type: "error", message: "Could not load shared ticket." }, 3500); return; }
        const { ticket } = await res.json();
        await handleGrmLoaded(ticket, grmInboundCode);
      } catch { showGrmNotice({ type: "error", message: "Could not load shared ticket." }, 3500); }
      finally { onGrmInboundConsumed?.(); }
    })();
  }, [grmInboundCode]); // eslint-disable-line react-hooks/exhaustive-deps

  // Patch a specific leg in a loaded ticket by fixtureId
  const patchTicketLeg = useCallback((ticketId, fixtureId, newLeg) => {
    setTickets(prev => prev.map(t => {
      if (t.id !== ticketId) return t;
      const newLegs = t.legs.map(l => l.fixtureId === fixtureId ? { ...l, ...newLeg } : l);
      const newOdds = newLegs.reduce((s, l) => parseFloat((s * parseFloat(l.odds||1)).toFixed(4)), 1.0);
      return { ...t, legs: newLegs, totalOdds: newOdds.toFixed(2) };
    }));
  }, []); // user-tunable market diversity cap

  // League-filtered fixtures — used by all pool builds inside this tab.
  // When parlayLeagueFilter is null, this is identical to fixtures (no filtering).
  // This is the single chokepoint so every build (auto, manual, remix, swap)
  // respects the league filter without touching each call site individually.
  const parlayFixtures = useMemo(() => {
    if (!parlayLeagueFilter) return fixtures;
    const lf = parlayLeagueFilter instanceof Set ? parlayLeagueFilter : new Set([parlayLeagueFilter]);
    return fixtures.filter(f => lf.has(f.leagueId || f.league));
  }, [fixtures, parlayLeagueFilter]);

  // ── Remix a whole ticket ──────────────────────────────────────────────────
  // Rebuilds this ticket with a fresh stratified shuffle.
  // Other tickets in the set are untouched.
  const remixTicket = async (ticketId) => {
    setRemixingId(ticketId);
    const rates = await ensureHistoricalRates();
    const currentTickets = tickets;
    const original = currentTickets.find(t => t.id === ticketId);
    if (!original) { setRemixingId(null); return; }

    const inheritedTarget = parseFloat(original.totalOdds) || targetOdds;

    // Exclude fixtures used in OTHER tickets only — not the ticket being remixed.
    // The original bug excluded ALL tickets including the current one, meaning the
    // remixed ticket could never re-use any of the same fixtures even with a different pick.
    const allUsed = new Set(
      currentTickets.filter(t => t.id !== ticketId).flatMap(t => t.legs.map(l => l.fixtureId))
    );

    // Track what the current ticket was using — penalise same market/league combos
    // so remix genuinely diversifies rather than picking the same top entries
    const usedMarkets = new Set(original.legs.map(l => l.market));
    const usedLeagues = new Set(original.legs.map(l => l.league));

    // N10-FIX: was `fixtures.filter(...)` — ignored parlayLeagueFilter entirely.
    // parlayFixtures already applies the league filter (computed via useMemo above),
    // so remix now respects the same league scope as the original build.
    const available = parlayFixtures.filter(f => !allUsed.has(f.id));

    if (available.length < 2) {
      setAutoMessage("Not enough unused fixtures to remix — try reducing other tickets first.");
      setTimeout(() => setAutoMessage(""), 3500);
      setRemixingId(null); return;
    }

    // Build pool from available fixtures
    const rawPool = buildUniversalPool(available, rates).filter(e => !parlayExcludedMarkets.has(getExcludeSelectionId({label:e.pick, market:e.market}, e.fixture)));
    if (rawPool.length < 2) {
      setAutoMessage("Pool too thin to remix right now.");
      setTimeout(() => setAutoMessage(""), 3500);
      setRemixingId(null); return;
    }

    // Apply diversity penalty: entries sharing market OR league with the current
    // ticket get their score halved so they sink below genuinely fresh entries.
    // This forces the remix toward different market+league combinations.
    const diversePool = rawPool.map(e => {
      const sameMarket = usedMarkets.has(e.market);
      const sameLeague = usedLeagues.has(e.league);
      const penalty = (sameMarket ? 0.5 : 1.0) * (sameLeague ? 0.7 : 1.0);
      return { ...e, score: e.score * penalty, utility: (e.utility || e.score) * penalty };
    }).sort((a, b) => b.score - a.score);

    // Strong crypto-seeded Fisher-Yates shuffle within tiers so top entries
    // don't always win — each remix is genuinely different
    const cryptoShuffle = (arr) => {
      const a = [...arr];
      for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor((crypto.getRandomValues(new Uint32Array(1))[0] / 0xFFFFFFFF) * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
      }
      return a;
    };

    const tierA = diversePool.filter(e => e.score > 0.7);
    const tierB = diversePool.filter(e => e.score > 0.45 && e.score <= 0.7);
    const tierC = diversePool.filter(e => e.score <= 0.45);
    const shuffled = [
      ...cryptoShuffle(tierA),
      ...cryptoShuffle(tierB),
      ...cryptoShuffle(tierC),
    ];

    // Build one ticket from the shuffled diverse pool
    const rebuilt = buildManualParlaysFromPool(shuffled, {
      numParlays: 1, targetOdds: inheritedTarget, historicalRates: rates,
      budget, budgetPct, maxSameMarket,
    });

    if (!rebuilt.length) {
      setAutoMessage("Couldn't find a different combination — pool may be exhausted.");
      setTimeout(() => setAutoMessage(""), 3500);
      setRemixingId(null); return;
    }
    const remixed = { ...rebuilt[0], id: ticketId, _remixed: true };
    setTickets(prev => prev.map(t => t.id === ticketId ? remixed : t));
    setRemixingId(null);
  };

  // ── Swap a single leg ─────────────────────────────────────────────────────
  // Replaces one leg with the next unused qualifying game from the pool.
  // "Replace game" — not "swap market" — pool only produces one entry per fixture.
  const swapLeg = async (ticketId, legIndex) => {
    const rates = await ensureHistoricalRates();
    let swapped = false;
    setTickets(prev => {
      const ticket = prev.find(t => t.id === ticketId);
      if (!ticket) return prev;
      // Respect league filter on swap
      const _swapFixtures = parlayLeagueFilter && parlayLeagueFilter instanceof Set && parlayLeagueFilter.size > 0
        ? parlayFixtures.filter(f => parlayLeagueFilter.has(f.league)||parlayLeagueFilter.has(f.leagueId))
        : parlayFixtures;
      const pool = buildUniversalPool(_swapFixtures, rates);
      const currentLeg = ticket.legs[legIndex];

      // Find next unused fixture — exclude ALL legs in this ticket (not just the swapped one)
      // so we never double-up any fixture within the same ticket.
      const thisTicketIds = new Set(ticket.legs.map(l => l.fixtureId));
      // Also exclude the game being replaced so it doesn't come back immediately
      thisTicketIds.add(currentLeg.fixtureId);
      const replacement = pool.find(e => !thisTicketIds.has(e.fixtureId)) || null;

      if (!replacement) {
        swapped = false;
        return prev;
      }

      swapped = true;
      const newLegs = ticket.legs.map((l, i) =>
        i === legIndex ? {
          fixtureId: replacement.fixtureId, game: replacement.game,
          pick: replacement.pick, odds: replacement.odds,
          conf: replacement.conf, market: replacement.market,
          league: replacement.league, strategyId: null,
          empiricalRate: replacement.empiricalRate,
          score: parseFloat(replacement.score.toFixed(4)),
        } : l
      );
      const newOdds = newLegs.reduce((s, l) => parseFloat((s * parseFloat(l.odds)).toFixed(4)), 1.0);
      return prev.map(t => t.id === ticketId
        ? { ...t, legs: newLegs, totalOdds: newOdds.toFixed(2), _remixed: true }
        : t
      );
    });
    if (!swapped) {
      setAutoMessage("No replacement available — pool is exhausted. Try raising Max Same Market or fetching a new snapshot.");
      setTimeout(() => setAutoMessage(""), 4000);
    }
  };

  // Warm up historical rates immediately on open
  // shows without the user needing to hit Build first.
  useEffect(() => { ensureHistoricalRates(); }, []);

  // Content hash — fixtureId+pick per leg, sorted so order doesn't matter
  const ticketContentKey = (ticket) => {
    const legs = ticket.legs || [];
    return legs.map(l => `${l.fixtureId}|${l.pick}`).sort().join("||");
  };

  const saveTicketInternal = (ticket, stake) => {
    // B2-FIX: save immediately with a local code so the UI is instant,
    // then patch to GRM code from /api/ticket/share when server responds.
    const localCode = generateTicketCode();
    const payload   = { ...ticket, stake, code: localCode, date:date||todayStr(), savedAt:new Date().toISOString() };
    const updated   = [...savedTickets, payload];
    setSavedTickets(updated); persistTickets(updated);
    const contentKey = ticketContentKey(ticket);
    setSavedCodes(prev => {
      const next = { ...prev, [contentKey]: localCode };
      try { localStorage.setItem("grm_saved_codes_v15", JSON.stringify(next)); } catch {}
      return next;
    });
    // Async patch — upgrade local code to canonical GRM code once server responds
    fetch(`${SERVER}/api/ticket/share`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        legs:      ticket.legs,
        totalOdds: ticket.totalOdds,
        date:      ticket.date || date || todayStr(),
        label:     ticket.slotLabel || null,
      }),
    }).then(r => r.ok ? r.json() : null).then(data => {
      if (!data?.code || data.code === localCode) return;
      const grmCode = data.code;
      setSavedTickets(prev => {
        const patched = prev.map(t => t.code === localCode ? { ...t, code: grmCode } : t);
        persistTickets(patched);
        return patched;
      });
      setSavedCodes(prev => {
        const next = { ...prev, [contentKey]: grmCode };
        try { localStorage.setItem("grm_saved_codes_v15", JSON.stringify(next)); } catch {}
        return next;
      });
    }).catch(() => {}); // silently keep local code if server fails
  };

  const deleteSavedTicket = code => {
    const updated = savedTickets.filter(t => t.code !== code);
    setSavedTickets(updated); persistTickets(updated);
    setSavedCodes(prev => {
      const next = { ...prev };
      Object.keys(next).forEach(k => { if (next[k] === code) delete next[k]; });
      try { localStorage.setItem("grm_saved_codes_v15", JSON.stringify(next)); } catch {}
      return next;
    });
  };



  // Inject results into a ticket inline
  const draftTicket = draftLegs.length > 0 ? {
    id: "draft", source: "card_add",
    legs: draftLegs,
    totalOdds: draftLegs.reduce((s,l) => parseFloat((s*(parseFloat(l.odds)||1)).toFixed(4)), 1.0).toFixed(2),
    stake: 0, exhausted: false,
  } : null;

  const openFixture = (fixtureId) => {
    const f = fixtures.find(x => x.id === fixtureId);
    if (!f) return;
    // Go straight to FullModelPage — skip the intermediate card overlay
    if (onFullModel) { onFullModel(f); return; }
    // Fallback: internal fixture view if onFullModel not provided
    setFocus(f); setReturnTo("parlay"); setView("fixture");
  };

  const handleBuildParlay = async () => {
    setBuilding(true); setAutoMessage(null); setAutoAnalysis(null);
    const rates = await ensureHistoricalRates();

    // ── Research Mode: pre-score top candidates with Gemini before building ──
    // Runs in parallel for top 8, applies adjustments, re-sorts pool.
    // Falls back to unadjusted pool if pre-score fails or is off.
    const applyJarvisPreScore = async (pool) => {
      if (!jarvisResearch || !pool.length) return pool;
      try {
        const top = pool.slice(0, 8);
        const r = await fetch(`${SERVER}/api/jarvis-pre-score`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            candidates: top.map(e => ({
              fixtureId: e.fixtureId, game: e.game, pick: e.pick,
              market: e.market, league: e.league,
              conf: e.conf, empiricalRate: e.empiricalRate, odds: e.odds,
            })),
          }),
        });
        if (!r.ok) {
          // B6-FIX: Server error — whole pre-score failed. Surface it.
          setAutoMessage(`⚠ Jarvis Research failed (server ${r.status}) — built without pre-scoring.`);
          setTimeout(() => setAutoMessage(""), 5000);
          return pool;
        }
        const data = await r.json();
        const scoreMap = {};
        (data.scores || []).forEach(s => { scoreMap[s.fixtureId] = s; });

        // B6-FIX: Count how many candidates came back with real research
        // vs the "Research unavailable" fallback. If majority failed (rate-limited),
        // tell the user so they don't think full research ran.
        const realScores  = (data.scores || []).filter(s => s.reason && s.reason !== "Research unavailable");
        const failedCount = top.length - realScores.length;
        if (failedCount > top.length / 2) {
          setAutoMessage(`⚠ Jarvis Research partial — only ${realScores.length}/${top.length} games scored (rate limit). Built with available data.`);
          setTimeout(() => setAutoMessage(""), 6000);
        }

        return pool.map(e => {
          const adj = scoreMap[e.fixtureId];
          if (!adj) return e;
          return {
            ...e,
            score: Math.max(0.05, Math.min(1.0, e.score + adj.adjustment)),
            jarvisAdjustment: adj.adjustment,
            jarvisReason: adj.reason,
            jarvisFlags: adj.flags,
          };
        }).sort((a, b) => b.score - a.score);
      } catch {
        // Network failure — degrade silently but inform user
        setAutoMessage("⚠ Jarvis Research unavailable — built without pre-scoring.");
        setTimeout(() => setAutoMessage(""), 4000);
        return pool;
      }
    };

    // Leg guardrails per mode (internal — not exposed as user controls)
    const JARVIS_MODE_GUARDRAILS = {
      safe:     { minLegs:2, maxLegs:5,  confFloor:0.62, label:"Safe"     },
      value:    { minLegs:5, maxLegs:10, confFloor:0.55, label:"Value"    },
      longshot: { minLegs:10,maxLegs:17, confFloor:0.48, label:"Longshot" },
    };

    if (builderMode === "jarvis") {
      const rawPool = buildUniversalPool(parlayFixtures, rates).filter(e => !parlayExcludedMarkets.has(getExcludeSelectionId({label:e.pick, market:e.market}, e.fixture)));
      if (rawPool.length === 0) {
        setAutoMessage("No qualifying games in selected leagues — try adding more leagues or clearing the filter.");
        setBuilding(false); return;
      }
      if (parlayLeagueFilter && rawPool.length < 3) {
        setAutoMessage(`⚠ Only ${rawPool.length} game${rawPool.length!==1?"s":""} qualify in selected leagues — ticket may be thin.`);
        setTimeout(() => setAutoMessage(""), 4000);
      }
      const pool = await applyJarvisPreScore(rawPool);
      const leagueNote = parlayLeagueFilter ? ` · filtered to ${(parlayLeagueFilter instanceof Set ? parlayLeagueFilter : new Set([parlayLeagueFilter])).size} league(s)` : "";

      // Multi-mode: one ticket per selected mode
      const activeModes = [...jarvisModes];
      const newTickets = [];
      activeModes.forEach((modeId, idx) => {
        const g = JARVIS_MODE_GUARDRAILS[modeId] || JARVIS_MODE_GUARDRAILS.safe;
        // Filter pool by mode confidence floor
        const modePool = pool.filter(e => (e.conf || 0) / 100 >= g.confFloor);
        // Target odds derived from mode — not user-settable in Jarvis mode
        // H5-FIX: Longshot ceiling removed. Previous 10.0 target caused buildOneParlayFromPool
        // to stop at 10× regardless of leg count. User confirmed: floor stays at 2× (minLegs:10)
        // but the leg count constraint (maxLegs:17 in JARVIS_MODE_GUARDRAILS) is the only ceiling.
        // Infinity means the build runs until pool exhausted or maxLegs reached — naturally.
        const modeOdds = modeId === "safe"     ? 2.5
                       : modeId === "value"    ? 4.0
                       : /* longshot */          Infinity;
        const result = buildUniversalParley(
          parlayFixtures,
          { targetOdds: modeOdds, historicalRates:rates, budget, budgetPct,
            maxSameMarket: maxSameMarket ?? Infinity, minLegs: g.minLegs, maxLegs: g.maxLegs },
          modePool.length >= 2 ? modePool : pool
        );
        newTickets.push({
          ...result,
          id: idx + 1,
          slotLabel: jarvisResearch ? `${g.label} (Researched)` : g.label,
          slotId: modeId,
          isAuto: true,
          jarvisMode: modeId,
        });
      });
      setTickets(newTickets);
      const modeLabels = activeModes.map(m => JARVIS_MODE_GUARDRAILS[m]?.label || m).join(" + ");
      const firstResult = newTickets[0];
      setAutoMessage(
        (jarvisResearch ? "Jarvis pre-scored candidates · " : "") +
        `${modeLabels} · pool: ${rawPool.length} qualifying${leagueNote}`
      );
      savePoolToServer(rawPool, date);
    } else {
      // custom mode
      // custom mode: respect customPool — engine-only filters to engineFixtureIds
      const allCustomFixtures = customPool === "engine" && engineFixtureIds?.size
        ? parlayFixtures.filter(f => engineFixtureIds.has(f.id))
        : parlayFixtures;
      const rawPool = buildUniversalPool(allCustomFixtures, rates).filter(e => !parlayExcludedMarkets.has(getExcludeSelectionId({label:e.pick, market:e.market}, e.fixture)));
      if (rawPool.length === 0) {
        setAutoMessage(customPool==="engine"
          ? "No qualifying games in engine pool — switch to All Fixtures or build the engine pool first."
          : "No qualifying games — try adding more leagues or clearing the filter.");
        setBuilding(false); return;
      }
      if (rawPool.length < numParlays * 3) {
        setAutoMessage(`⚠ Pool has ${rawPool.length} game${rawPool.length!==1?"s":""} for ${numParlays} tickets — some tickets may share legs.`);
        setTimeout(() => setAutoMessage(""), 5000);
      }
      const pool    = await applyJarvisPreScore(rawPool);
      const results = buildManualParlaysFromPool(pool, { numParlays, targetOdds, historicalRates:rates, budget, budgetPct, maxSameMarket: maxSameMarket ?? Infinity });
      setTickets(results);
    }
    setBuilding(false);
  };

  const handleAutoAnalyse = async () => {
    const ticket = tickets.find(t => t.isAuto);
    if (!ticket || !ticket.legs?.length) return;
    setAnalysing(true); setAutoAnalysis(null);
    try {
      const res  = await fetch(`${SERVER}/api/jarvis-analyse`, {
        method:"POST", headers:{"Content-Type":"application/json"},
        body: JSON.stringify({ ticket, fixtures, backtestSummary: historicalRates }),
      });
      const data = await res.json();
      if (!res.ok || data.error) throw new Error(data.error || "Analysis failed");
      setAutoAnalysis(data.analysis || data.message || "No analysis returned.");
    } catch(e) {
      const msg = e.message?.toLowerCase();
      setAutoAnalysis(msg?.includes("429") || msg?.includes("rate")
        ? "Jarvis hit a rate limit — try again in a minute."
        : "Jarvis is busy right now. Tap Analyse to retry.");
    }
    setAnalysing(false);
  };

  if (view === "fixture") return (
    <div style={{ position:"fixed",inset:0,background:C.bg,zIndex:200,overflowY:"auto",overscrollBehavior:"contain",padding:16 }}>
      <button onClick={() => { setActiveTicketId(null); setFocus(null); setView(returnTo); }} className="gb"
        style={{ marginBottom:16,padding:"6px 14px",background:"transparent",border:`1px solid ${C.radar}50`,color:C.radar,fontSize:10 }}>
        ← Back
      </button>
      <FixtureCard
        f={focusFixture}
        draftLegs={activeTicketId ? [] : draftLegs}
        backtestSummary={historicalRates}
        onAddToParlay={(fixture, pick) => {
          if (activeTicketId) {
            // Replace this leg in the loaded ticket
            patchTicketLeg(activeTicketId, fixture.id, {
              pick: pick.pick, odds: pick.odds, market: pick.market,
              prob: pick.prob, game: `${fixture.teams.home} vs ${fixture.teams.away}`,
              league: fixture.league,
            });
            setActiveTicketId(null);
            setFocus(null);
            setView(returnTo);
          } else {
            onAddLegToDraft(fixture, pick);
          }
        }}
        isEngineQualified={engineFixtureIds.has(focusFixture?.id)}
        onFullModel={(f) => { setFocus(null); if (onFullModel) onFullModel(f); }}
        adminToken={adminToken}
      />
    </div>
  );

  return (
    <div ref={panelRef} style={{ position:"fixed",inset:0,background:C.bg,zIndex:200,overflowY:"auto",overscrollBehavior:"contain",padding:0,paddingBottom:120 }}>
      {/* Top nav bar — inline styles only, grm-header class is position:fixed globally */}
      <div style={{
        position:"sticky", top:0, zIndex:10,
        height:52, flexDirection:"row", alignItems:"center", padding:"0 14px", display:"flex",
        background: C.bg,
        borderBottom:`1px solid ${C.border}`,
      }}>
        {/* Back arrow */}
        <button onClick={onClose}
          style={{ background:"transparent",border:"none",cursor:"pointer",color:C.muted,padding:"8px 8px 8px 0",display:"flex",alignItems:"center",marginRight:8,flexShrink:0 }}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="15 18 9 12 15 6"/>
          </svg>
        </button>

        {/* Builder / Saved — full-width segmented control */}
        <div style={{ display:"flex", flex:1, background:C.faint,
                      borderRadius:10, padding:3, gap:3 }}>
          {[
            { id:"parlay", label:`Builder${draftLegs.length+tickets.length>0?` (${draftLegs.length+tickets.length})`:""}`,
              icon:<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 9V7a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v2a3 3 0 0 0 0 6v2a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-2a3 3 0 0 0 0-6z"/><path d="M13 5v14"/></svg> },
            { id:"saved",  label:`Saved${savedTickets.length>0?` (${savedTickets.length})`:""}`,
              icon:<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/></svg> },
          ].map(t => {
            const on = view === t.id;
            return (
              <button key={t.id} onClick={() => setView(t.id)} style={{
                flex:1, display:"flex", alignItems:"center", justifyContent:"center", gap:6,
                padding:"8px 0", fontSize:11, fontWeight:800, fontFamily:C.font,
                background: on ? C.surface      : "transparent",
                color:      on ? C.accent        : C.muted,
                border:     on ? `1px solid ${C.accent}40` : `1px solid transparent`,
                borderRadius:8,
                boxShadow:  on ? "0 1px 6px rgba(0,0,0,0.22)" : "none",
                cursor:"pointer", transition:"all .15s",
                WebkitTapHighlightColor:"transparent",
              }}>
                <span style={{ opacity: on ? 1 : 0.55, display:"flex", flexShrink:0 }}>{t.icon}</span>
                {t.label}
              </button>
            );
          })}
        </div>
      </div>

      <div style={{ padding:16 }}>

        {/* N19-FIX / P-FIX: GRM inbound/load notice — tone + content adapt to
            what actually happened (plain success, past/future date context,
            or a missing snapshot that needs a manual fetch). */}
        {grmNotice && (() => {
          const palette = {
            loaded:  C.green,
            past:    C.gold,
            future:  C.edge,
            missing: C.red,
            error:   C.red,
          }[grmNotice.type] || C.muted;

          const text = {
            loaded:  `Ticket ${grmNotice.code} loaded.`,
            past:    `Ticket ${grmNotice.code} loaded — heads up, this ticket is from ${grmNotice.date} (already played).`,
            future:  `Ticket ${grmNotice.code} loaded — heads up, this ticket is for ${grmNotice.date} (upcoming).`,
            missing: `Ticket ${grmNotice.code} loaded, but no fixture data is saved for ${grmNotice.date} — fetch that date to view full models for its legs.`,
          }[grmNotice.type] || grmNotice.message || "Could not load shared ticket.";

          const isAlert = grmNotice.type === "missing" || grmNotice.type === "error";

          return (
            <div style={{ marginBottom:12, padding:"9px 14px", background:`${palette}12`,
                          border:`1px solid ${palette}35`, borderRadius:8,
                          display:"flex", alignItems:"flex-start", gap:8 }}>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke={palette} strokeWidth="2.5"
                strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink:0, marginTop:1 }}>
                {isAlert
                  ? <><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></>
                  : <polyline points="20 6 9 17 4 12"/>}
              </svg>
              <div style={{ flex:1 }}>
                <div style={{ fontSize:10, fontWeight:700, color:palette, lineHeight:1.5 }}>{text}</div>
                {grmNotice.type === "missing" && goToFetchDate && (
                  <button onClick={() => goToFetchDate(grmNotice.date)}
                    style={{ marginTop:8, padding:"6px 12px", fontSize:9, fontWeight:800, borderRadius:7,
                             background:"transparent", border:`1px solid ${palette}50`,
                             color:palette, cursor:"pointer", fontFamily:C.font }}>
                    Go fetch {grmNotice.date} →
                  </button>
                )}
              </div>
              {isAlert && (
                <button onClick={() => setGrmNotice(null)}
                  style={{ background:"none", border:"none", color:palette, opacity:.6, cursor:"pointer", padding:0, flexShrink:0 }}>
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
                  </svg>
                </button>
              )}
            </div>
          );
        })()}

        {/* PARLAY BUILDER */}
        {view === "parlay" && (
          <>
            {draftTicket && (
              <div style={{ marginBottom:16 }}>
                <div style={{ fontSize:9,color:C.gold,fontWeight:800,textTransform:"uppercase",letterSpacing:".12em",marginBottom:8,display:"flex",alignItems:"center",gap:5 }}>
                  {/* N14b-FIX: SVG replaces 📝 emoji — emoji renders inconsistently across Android versions */}
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
                    <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
                  </svg>
                  Draft Ticket
                </div>
                <TicketCard
                  ticket={draftTicket} date={date} isJarvis={false}
                  onRemove={() => setDraftLegs([])}
                  onRemoveLeg={i => setDraftLegs(prev => prev.filter((_, idx) => idx !== i))}
                  onOpenFixture={id => openFixture(id)}
                  onSaveInternal={stake => { saveTicketInternal(draftTicket, stake); setDraftLegs([]); }}
                  savedCode={savedCodes[ticketContentKey(draftTicket)]}
                />
              </div>
            )}

            <div className="gc" style={{ padding:16,marginBottom:16 }}>

              {/* ── Parley System explainer — shown once, dismissable ── */}
              <ParlayExplainer />

              {/* ── Tab strip: Jarvis | Custom — lightweight segmented control ── */}
              <div style={{ display:"flex", marginBottom:16, background:C.faint,
                            borderRadius:10, padding:3, gap:2 }}>
                {[
                  { id:"jarvis", label:"Jarvis",     desc:"AI-built ticket" },
                  { id:"custom", label:"Custom",     desc:"Your rules" },
                ].map(m => {
                  const active = builderMode === m.id;
                  return (
                    <button key={m.id} onClick={() => setBuilderMode(m.id)}
                      style={{
                        flex:1, padding:"7px 8px",
                        display:"flex", alignItems:"center", justifyContent:"center", gap:6,
                        fontSize:10, fontWeight:800,
                        background: active ? C.surface : "transparent",
                        color:      active ? C.accent  : C.muted,
                        border:     active ? `1px solid ${C.border}` : "1px solid transparent",
                        borderRadius:8,
                        boxShadow:  active ? "0 1px 4px rgba(0,0,0,0.18)" : "none",
                        transition: "all .15s ease", cursor:"pointer",
                        fontFamily: C.font,
                      }}>
                      <span style={{ fontSize:8, opacity: active ? 0.9 : 0.5, fontWeight:500 }}>{m.desc}</span>
                      <span style={{ fontSize:10, fontWeight:800 }}>{m.label}</span>
                    </button>
                  );
                })}
              </div>

              {/* ── JARVIS TAB — TA Pre-built Slate ── */}
              {builderMode === "jarvis" && (
                <JarvisTASlate
                  date={date}
                  SERVER={SERVER}
                  C={C}
                  onFullModel={onFullModel ? (fixtureId) => {
                    const f = fixtures.find(x => x.id === fixtureId || String(x.id) === String(fixtureId));
                    if (f) onFullModel(f);
                  } : null}
                  onUseTicket={(strategy) => {
                    // Convert TA strategy into a ticket object compatible with TicketCard
                    // B3.2-FIX: skip finished legs (those with a known result) — they
                    // can't be booked and inflate the combined odds falsely.
                    const allLegs = strategy.legs || [];
                    const finishedCount = allLegs.filter(l => l._result && l._result !== "PENDING").length;
                    const legs = allLegs
                      .filter(l => !l._result || l._result === "PENDING")
                      .map(l => ({
                        fixtureId: l.fixtureId,
                        game:      l.game || `${l.home || "?"} vs ${l.away || "?"}`,
                        home:      l.home,
                        away:      l.away,
                        pick:      l.market,
                        market:    l.market,
                        league:    l.league || null,
                        odds:      l.odds ? parseFloat(l.odds) : null,
                        conf:      l.conf ? parseFloat(l.conf) : null,
                      }));
                    if (finishedCount > 0 && legs.length === 0) {
                      alert("All legs in this ticket have already finished — nothing to add.");
                      return;
                    }
                    const totalOdds = parseFloat(
                      legs.reduce((acc, l) => acc * (l.odds || 1), 1).toFixed(2)
                    );
                    const newTicket = {
                      id:          Date.now() + Math.random(),
                      legs,
                      totalOdds,
                      isAuto:      true,
                      slotLabel:   strategy.label,
                      slotId:      strategy.id,
                      jarvisMode:  "jarvis",
                      _taStrategy: strategy.id,
                      // B3.2: carry count of skipped finished legs for display notice
                      _finishedExcluded: finishedCount || 0,
                    };
                    // Replace any existing ticket from same strategy, else append
                    setTickets(prev => [
                      ...prev.filter(t => t._taStrategy !== strategy.id),
                      newTicket,
                    ]);
                  }}
                />
              )}

              {/* ── CUSTOM TAB controls — unchanged ── */}
              {builderMode === "custom" && (
                <>
                  {/* Pool selector */}
                  <div style={{ display:"flex",gap:6,marginBottom:12,
                                background:C.bg,borderRadius:10,padding:3,border:`1px solid ${C.border}` }}>
                    {[{id:"all",label:"All Fixtures",desc:"Every game today"},{id:"engine",label:"Engine Only",desc:"High-confidence pool"}].map(p => (
                      <button key={p.id} onClick={() => setCustomPool(p.id)}
                        style={{ flex:1,padding:"7px 4px",borderRadius:8,border:"none",
                                 background:customPool===p.id?C.accent:"transparent",
                                 color:customPool===p.id?C.accentText:C.muted,
                                 fontSize:9,fontWeight:800,cursor:"pointer",fontFamily:C.font,
                                 display:"flex",flexDirection:"column",alignItems:"center",gap:2 }}>
                        <span>{p.label}</span>
                        <span style={{ fontSize:7,opacity:.7,fontWeight:500 }}>{p.desc}</span>
                      </button>
                    ))}
                  </div>
                  <div style={{ fontSize:8,color:C.text,marginBottom:12,lineHeight:1.6 }}>
                    Builds <span style={{ color:C.gold }}>N non-overlapping tickets</span> — each picks from fixtures unused by previous tickets.{customPool==="engine"?" Engine pool only — highest confidence games.":" All fixtures today, confidence ranked high to low."}
                  </div>
                  <div style={{ display:"grid",gridTemplateColumns:"1fr 1fr",gap:10,marginBottom:12 }}>
                    <div>
                      <div style={{ fontSize:8,color:C.text,marginBottom:4,textTransform:"uppercase",letterSpacing:".1em" }}>Stake ($)</div>
                      <input type="number" value={budget} onChange={e=>setBudget(+e.target.value)} onFocus={e=>e.target.select()} className="gi"/>
                    </div>
                    <div>
                      <div style={{ fontSize:8,color:C.text,marginBottom:4,textTransform:"uppercase",letterSpacing:".1em" }}>Target Odds</div>
                      <input type="number" step="0.5" value={targetOdds} onChange={e=>setTargetOdds(+e.target.value)} onFocus={e=>e.target.select()} className="gi"/>
                    </div>
                    {/* Tickets stepper */}
                    <div>
                      <div style={{ fontSize:8,color:C.text,marginBottom:4,textTransform:"uppercase",letterSpacing:".1em" }}>Tickets (max 10)</div>
                      <div style={{ display:"flex",alignItems:"center",gap:6 }}>
                        <button className="gb" onClick={() => setNumParlays(p => Math.max(1, p - 1))}
                          style={{ width:28,height:28,fontSize:14,fontWeight:800,padding:0,background:C.faint,border:`1px solid ${C.border}`,color:C.text,borderRadius:5 }}>−</button>
                        <span style={{ fontSize:13,fontWeight:800,color:C.gold,minWidth:20,textAlign:"center" }}>{numParlays}</span>
                        <button className="gb" onClick={() => setNumParlays(p => Math.min(10, p + 1))}
                          style={{ width:28,height:28,fontSize:14,fontWeight:800,padding:0,background:C.faint,border:`1px solid ${C.border}`,color:C.text,borderRadius:5 }}>+</button>
                      </div>
                    </div>
                    {/* Market cap — optional, null = no cap */}
                    <div>
                      <div style={{ fontSize:8,color:C.text,marginBottom:6,textTransform:"uppercase",letterSpacing:".1em" }}>Max Same Market</div>
                      {maxSameMarket === null ? (
                        <div>
                          <div style={{ fontSize:9,color:C.muted,marginBottom:5 }}>No cap — any market</div>
                          <button onClick={() => setMaxSameMarket(3)}
                            style={{ fontSize:8,padding:"4px 10px",borderRadius:6,background:C.faint,
                                     border:`1px solid ${C.border}`,color:C.text,cursor:"pointer",fontFamily:C.font }}>
                            + Add cap
                          </button>
                        </div>
                      ) : (
                        <div>
                          <div style={{ display:"flex",alignItems:"center",gap:6,marginBottom:4 }}>
                            <button onClick={() => setMaxSameMarket(p => Math.max(1,(p||1)-1))}
                              style={{ width:26,height:26,fontSize:13,fontWeight:800,padding:0,background:C.faint,border:`1px solid ${C.border}`,color:C.text,borderRadius:5,cursor:"pointer",fontFamily:C.font }}>−</button>
                            <span style={{ fontSize:13,fontWeight:800,color:C.radar,minWidth:20,textAlign:"center" }}>{maxSameMarket}</span>
                            <button onClick={() => setMaxSameMarket(p => Math.min(10,(p||1)+1))}
                              style={{ width:26,height:26,fontSize:13,fontWeight:800,padding:0,background:C.faint,border:`1px solid ${C.border}`,color:C.text,borderRadius:5,cursor:"pointer",fontFamily:C.font }}>+</button>
                          </div>
                          <button onClick={() => setMaxSameMarket(null)}
                            style={{ fontSize:7,padding:"2px 8px",borderRadius:4,background:"transparent",
                                     border:`1px solid ${C.border}`,color:C.muted,cursor:"pointer",fontFamily:C.font }}>
                            Remove cap
                          </button>
                        </div>
                      )}
                    </div>
                  </div>

                  {/* League filter — Custom tab only */}
                  {parlayAvailableLeagues.length > 1 && (
                    <div style={{ marginBottom:12 }}>
                      <LeagueFilter
                        availableLeagues={parlayAvailableLeagues}
                        leagueFilter={parlayLeagueFilter}
                        setLeagueFilter={setParlayLeagueFilter}
                      />
                      {parlayLeagueFilter && (() => {
                        const activeSet = parlayLeagueFilter instanceof Set ? parlayLeagueFilter : new Set([parlayLeagueFilter]);
                        const poolCount = fixtures.filter(f => activeSet.has(f.leagueId||f.league)).length;
                        return (
                          <div style={{ marginTop:5,fontSize:8,
                            color:poolCount===0?C.red:poolCount<5?C.amber:C.green }}>
                            {poolCount===0?"No fixtures in selected leagues"
                              :poolCount<5?`Only ${poolCount} fixture${poolCount!==1?"s":""} — pool may be thin`
                              :`${poolCount} fixtures available`}
                          </div>
                        );
                      })()}
                    </div>
                  )}

                  {/* H2-FIX: Market exclusion — collapsible, engine pool markets only */}
                  <ExcludeMarketsPanel
                    excluded={parlayExcludedMarkets}
                    toggle={toggleParlayExcludeMarket}
                    clear={() => setParlayExcludedMarkets(new Set())}
                  />

                  {/* Research Mode toggle — pre-scores top candidates with live web context */}
                  <button onClick={() => setJarvisResearch(r => !r)}
                    style={{
                      width:"100%", marginBottom:10, padding:"10px 14px",
                      borderRadius:10, cursor:"pointer", fontFamily:C.font,
                      background: jarvisResearch ? `${C.edge}12` : "transparent",
                      border:`1px solid ${jarvisResearch ? C.edge : C.border}`,
                      display:"flex", alignItems:"center", gap:10,
                      transition:"all .15s",
                    }}>
                    {/* Toggle pill */}
                    <div style={{
                      width:34, height:20, borderRadius:10, flexShrink:0,
                      background: jarvisResearch ? C.edge : C.faint,
                      border:`1px solid ${jarvisResearch ? C.edge : C.border}`,
                      position:"relative", transition:"background .2s",
                    }}>
                      <div style={{
                        position:"absolute", top:2,
                        left: jarvisResearch ? 16 : 2,
                        width:14, height:14, borderRadius:"50%",
                        background: jarvisResearch ? C.accentText : C.muted,
                        transition:"left .2s",
                        boxShadow:"0 1px 3px rgba(0,0,0,.2)",
                      }}/>
                    </div>
                    <div style={{ textAlign:"left", flex:1 }}>
                      <div style={{ fontSize:10, fontWeight:800,
                        color: jarvisResearch ? C.edge : C.text }}>
                        Research Mode
                      </div>
                      <div style={{ fontSize:8, color:C.muted, marginTop:1, lineHeight:1.4 }}>
                        {jarvisResearch
                          ? "On — Jarvis will pre-score top candidates with live web context before building"
                          : "Off — builds from model data only"}
                      </div>
                    </div>
                    {jarvisResearch && (
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke={C.edge}
                        strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink:0 }}>
                        <circle cx="11" cy="11" r="8"/>
                        <path d="M21 21l-4.35-4.35"/>
                      </svg>
                    )}
                  </button>

                  <button onClick={handleBuildParlay} disabled={building || !fixtures.length} className="gb-primary"
                    style={{ width:"100%",padding:"13px 0",fontSize:13,fontWeight:800,
                             opacity:building||!fixtures.length?.5:1 }}>
                    {building?"BUILDING…":`BUILD ${numParlays} TICKET${numParlays>1?"S":""}`}
                  </button>
                  {building && (
                    <div style={{ textAlign:"center",marginTop:5 }}>
                      <span className="pu" style={{ fontSize:8,color:C.muted }}>
                        {`Scanning ${fixtures.length} fixture${fixtures.length!==1?"s":""} · building ${numParlays} non-overlapping ticket${numParlays>1?"s":""}…`}
                      </span>
                    </div>
                  )}
                  {autoMessage && (
                    <div style={{ background:`${C.edge}08`,border:`1px solid ${C.edge}30`,borderRadius:8,padding:"10px 14px",fontSize:9,color:C.edge,marginTop:10 }}>
                      {autoMessage}
                    </div>
                  )}
                </>
              )}
            </div>{/* end gc div */}

            {/* N19-FIX: Load shared GRM ticket */}
            <GrmLoadPanel onLoaded={(ticket, code) => handleGrmLoaded(ticket, code)} />

            {tickets.length > 0 && (
              <>
                <div style={{ display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:10 }}>
                  <span style={{ fontSize:9,color:C.text }}>{tickets.length} built ticket{tickets.length>1?"s":""}</span>
                  <button onClick={() => setTickets([])} className="gb" style={{ fontSize:9,color:C.red,border:`1px solid ${C.red}40`,padding:"3px 8px" }}>Clear all</button>
                </div>
                <div style={{ display:"flex",flexDirection:"column",gap:8 }}>
                  {tickets.map(t => (
                    <div key={t.id} id={`grm-ticket-${t.id}`}>
                    <TicketCard ticket={t} date={date} isJarvis={!!t.isAuto}
                      remixing={remixingId === t.id}
                      onRemove={() => setTickets(prev => prev.filter(x => x.id !== t.id))}
                      onRemoveLeg={i => setTickets(prev => prev.map(tx => tx.id !== t.id ? tx : {
                        ...tx,
                        legs: tx.legs.filter((_, idx) => idx !== i),
                        totalOdds: parseFloat(tx.legs.filter((_,idx)=>idx!==i).reduce((acc,l)=>acc*(l.odds||1),1).toFixed(2)),
                      }))}
                      onOpenFixture={id => openFixture(id)}
                      onSaveInternal={stake => saveTicketInternal(t, stake)}
                      savedCode={savedCodes[ticketContentKey(t)]}
                      onEditDraft={legs => {
                        setDraftLegs(legs);
                        setView("parlay");
                        // P-FIX: the draft renders at the top of this view — without
                        // this the user stays wherever they were scrolled and the
                        // new draft looks like it never appeared.
                        scrollPanelToTop();
                      }}
                      onAddLegs={{ fixtures: parlayFixtures, addLeg: (f, pick) => {
                        // Append a new leg directly to this ticket — no draft copy needed.
                        // Recalculates totalOdds. Deduplication: if fixture already in ticket, replace.
                        const leg = {
                          fixtureId: f.id,
                          game: `${f.teams.home} vs ${f.teams.away}`,
                          home: f.teams.home, away: f.teams.away,
                          pick: pick.pick, odds: pick.odds ? parseFloat(pick.odds) : null,
                          conf: pick.prob ? parseFloat(pick.prob) : null,
                          market: pick.market || "Unknown",
                        };
                        setTickets(prev => prev.map(tx => {
                          if (tx.id !== t.id) return tx;
                          const existsIdx = tx.legs.findIndex(l => l.fixtureId === f.id);
                          const newLegs = existsIdx >= 0
                            ? tx.legs.map((l, i) => i === existsIdx ? leg : l)
                            : [...tx.legs, leg];
                          const newOdds = parseFloat(newLegs.reduce((acc, l) => acc * (l.odds||1), 1).toFixed(2));
                          return { ...tx, legs: newLegs, totalOdds: newOdds };
                        }));
                      }}}
                      onRemix={t.isAuto
                        ? async () => {
                            setRemixingId(t.id);
                            const rates = await ensureHistoricalRates();
                            // Build the pool, then apply a crypto-seeded shuffle within
                            // confidence tiers so we don't always select the same top picks.
                            // Without this, buildUniversalParley produces an identical ticket
                            // every time because the pool is sorted by utility score.
                            // Respect league filter on full remix
                            const _remixFixtures = parlayLeagueFilter && parlayLeagueFilter instanceof Set && parlayLeagueFilter.size > 0
                              ? parlayFixtures.filter(f => parlayLeagueFilter.has(f.league)||parlayLeagueFilter.has(f.leagueId))
                              : parlayFixtures;
                            const rawPool = buildUniversalPool(_remixFixtures, rates);
                            const cryptoShuffle = (arr) => {
                              const a = [...arr];
                              for (let i = a.length - 1; i > 0; i--) {
                                const j = Math.floor((crypto.getRandomValues(new Uint32Array(1))[0] / 0xFFFFFFFF) * (i + 1));
                                [a[i], a[j]] = [a[j], a[i]];
                              }
                              return a;
                            };
                            const tierA = rawPool.filter(e => e.utility > 0.8);
                            const tierB = rawPool.filter(e => e.utility > 0.5 && e.utility <= 0.8);
                            const tierC = rawPool.filter(e => e.utility <= 0.5);
                            const shuffledPool = [
                              ...cryptoShuffle(tierA),
                              ...cryptoShuffle(tierB),
                              ...cryptoShuffle(tierC),
                            ];
                            const JARVIS_MODE_GUARDRAILS_R = {
                              safe:     { minLegs:2, maxLegs:5,  confFloor:0.62, label:"Safe"     },
                              value:    { minLegs:5, maxLegs:10, confFloor:0.55, label:"Value"    },
                              longshot: { minLegs:10,maxLegs:17, confFloor:0.48, label:"Longshot" },
                            };
                            const g = JARVIS_MODE_GUARDRAILS_R[t.jarvisMode] || JARVIS_MODE_GUARDRAILS_R.safe;
                            const modePool = shuffledPool.filter(e => (e.conf || 0) / 100 >= g.confFloor);
                            const modeOdds = t.jarvisMode === "safe"     ? 2.5
                                           : t.jarvisMode === "longshot" ? Infinity : 4.0; // H5-FIX: longshot ceiling removed
                            const result = buildUniversalParley(
                              parlayFixtures,
                              { targetOdds: modeOdds, historicalRates:rates, budget, budgetPct,
                                maxSameMarket, minLegs: g.minLegs, maxLegs: g.maxLegs },
                              modePool.length >= 2 ? modePool : shuffledPool
                            );
                            setTickets(prev => prev.map(x => x.id !== t.id ? x : {
                              ...result, id: t.id,
                              slotLabel: `${g.label}`,
                              slotId: t.slotId, isAuto:true,
                              jarvisMode: t.jarvisMode, _remixed:true
                            }));
                            setRemixingId(null);
                          }
                        : () => remixTicket(t.id)
                      }
                      onSwapLeg={legIdx => swapLeg(t.id, legIdx)}
                    />
                    </div>
                  ))}
                </div>
              </>
            )}
          </>
        )}

        {/* PERFORMANCE TAB */}
        {view === "perf" && <PoolPerformanceTab serverUrl={SERVER} />}

        {/* SAVED TICKETS */}
        {view === "saved" && (
          <>
            {!savedTickets.length && (
              <div style={{ textAlign:"center",padding:"60px 0",color:C.text,opacity:.3,fontSize:11,textTransform:"uppercase",letterSpacing:".15em" }}>
                No saved tickets yet<br/>
                <span style={{ fontSize:9,marginTop:8,display:"block" }}>Save a ticket from Builder or Jarvis</span>
              </div>
            )}
            <div style={{ display:"flex",flexDirection:"column",gap:10 }}>
              {(savedTickets||[]).map(t => (
                <div key={t.code} style={{ background:C.surface,border:`1px solid ${C.border}`,borderRadius:12,padding:"10px 12px" }}>
                  {/* Row 1: code + meta + ✕ */}
                  <div style={{ display:"flex",alignItems:"flex-start",justifyContent:"space-between",marginBottom:6 }}>
                    <div style={{ minWidth:0 }}>
                      <span style={{ fontSize:11,fontWeight:800,color:C.radar,letterSpacing:".08em" }}>{t.code}</span>
                      <div style={{ fontSize:8,color:C.muted,marginTop:2 }}>{t.date} · {t.legs?.length||0} legs · ×{t.totalOdds}</div>
                    </div>
                    <button onClick={() => deleteSavedTicket(t.code)}
                      style={{ background:"none",border:"none",color:C.muted,cursor:"pointer",fontSize:14,padding:"0 0 0 8px",lineHeight:1,flexShrink:0 }}>✕</button>
                  </div>
                  {/* Row 2: action buttons */}
                  <div style={{ display:"flex",gap:6,alignItems:"center",marginBottom:8 }}>
                    <CopyCodeButton code={t.code} />
                    <GrmShareMenu ticket={t} />
                    <button onClick={() => { setDraftLegs(t.legs||[]); setView("parlay"); scrollPanelToTop(); }} className="gb-ghost"
                      style={{ padding:"3px 10px",fontSize:9,color:C.accent,borderColor:`${C.accent}40`,
                               display:"flex",alignItems:"center",gap:4 }}>
                      <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
                        <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
                      </svg>
                      Edit
                    </button>
                    <button onClick={() => { setTickets(prev => [...prev, { ...t, id:Date.now(), source:"card_add", exhausted:false }]); setView("parlay"); }}
                      className="gb-ghost" style={{ padding:"3px 10px",fontSize:9,color:C.gold,borderColor:`${C.gold}40` }}>
                      Load
                    </button>
                  </div>
                  {t.stake > 0 && (
                    <div style={{ fontSize:9,color:C.text,marginBottom:6 }}>
                      Stake ${t.stake} · Return ${parseFloat((t.stake*parseFloat(t.totalOdds)).toFixed(2))}
                    </div>
                  )}
                  <div style={{ display:"flex",flexDirection:"column",gap:3 }}>
                    {(t.legs||[]).map((leg, i) => (
                      <div key={i} style={{ display:"flex",justifyContent:"space-between",fontSize:9,color:C.text }}>
                        <span style={{ color:C.text,fontWeight:600,flex:1 }}>{leg.game}</span>
                        <span style={{ color:mktStyle(leg.market||"").color,fontWeight:700,marginLeft:8 }}>{leg.pick}</span>
                        <span style={{ marginLeft:6 }}>{leg.odds ? `${leg.odds}x` : "—"}</span>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ── MAIN COMPONENT ────────────────────────────────────────────────────────
// ── HELP MODAL — collapsible sections ─────────────────────────────────────
// N17: Full rewrite — reflects all features now in place. SVG icons only.
const HELP_SECTION_ICONS = {
  read: <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>,
  edge: <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>,
  radar: <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="2"/><path d="M16.24 7.76a6 6 0 0 1 0 8.49m-8.48-.01a6 6 0 0 1 0-8.49m11.31-2.82a10 10 0 0 1 0 14.14m-14.14 0a10 10 0 0 1 0-14.14"/></svg>,
  tags: <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"/><line x1="7" y1="7" x2="7.01" y2="7"/></svg>,
  enginetab: <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>,
  custom: <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="4" y1="6" x2="20" y2="6"/><line x1="8" y1="12" x2="20" y2="12"/><line x1="12" y1="18" x2="20" y2="18"/></svg>,
  parlay: <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 9V7a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v2a3 3 0 0 0 0 6v2a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-2a3 3 0 0 0 0-6z"/><path d="M13 5v14"/></svg>,
  rollover: <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="23 7 13.5 15.5 8.5 10.5 1 18"/><polyline points="17 7 23 7 23 13"/></svg>,
  perf: <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="12" y1="20" x2="12" y2="10"/><line x1="18" y1="20" x2="18" y2="4"/><line x1="6" y1="20" x2="6" y2="16"/></svg>,
  ca: <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>,
  jarvis: <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" fill="currentColor" opacity=".7" stroke="none"/><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>,
};

const HELP_SECTIONS = [
  {
    id: "read", title: "THE READ", sub: "model's top pick", color: () => C.gold,
    what:    "The model's highest-confidence pick for each fixture after running the full analysis — xG, form, standings, and calibration weight all combined.",
    telling: "STRONG badge means confidence cleared an elevated threshold. The hit rate on the card (e.g. 'Over 1.5: 74%') is actual historical success for that market at similar confidence levels — not a forecast.",
    use:     "Tap '+ Add to Ticket' on the card. Start here — it's the anchor for any ticket. Limited data means fewer than 10 season games played; treat these reads with more caution.",
    caution: "Volatile label means the league has high variance. The pick can still be right but carry more actual risk than the percentage suggests.",
  },
  {
    id: "edge", title: "THE EDGE", sub: "value play", color: () => C.edge,
    what:    "A secondary pick where the model's probability is meaningfully higher than what the bookmaker's odds imply. The book may have it wrong.",
    telling: "The '+X% vs BOOK' gap is the signal strength. Two or more signals means multiple checks converged on the same outcome. 'Value unclear' means the gap wasn't wide enough to justify the pick.",
    use:     "Works best as a second leg alongside The Read. Only worth taking standalone if the edge is +5% or more. Skip it if it shows 'value unclear'.",
    caution: "Higher risk than The Read — it's a value judgment on top of a probability call. No Edge showing is not a miss — it means today's odds didn't create a qualifying gap.",
  },
  {
    id: "radar", title: "GOAL RADAR", sub: "team scoring odds", color: () => C.radar,
    what:    "Per-team scoring probability — each team's chance of scoring at least once (O0.5) or more than once (O1.5). Separate from the main engine pool.",
    telling: "Only shows when the probability clears a minimum threshold. Absence means the signal didn't qualify, not that no prediction exists.",
    use:     "Add as a team total leg from Custom or directly from the card. Good for supporting a BTTS read or adding a third leg at low risk.",
    caution: "Team total odds are often short. If implied odds are under 1.15 the leg adds risk without proportionate return — skip it.",
  },
  {
    id: "tags", title: "STRATEGY TAGS", sub: "on the fixture card", color: () => C.amber,
    what:    "Labels showing which strategy conditions a fixture currently meets — Home Win, BTTS Value, Draw, Low Scoring, and more.",
    telling: "Each tag needs several simultaneous conditions, not just one high number. BTTS Value means multiple model signals align, not just a decent BTTS probability.",
    use:     "Head to Custom and filter by a strategy to see every qualifying fixture in one list. Useful when building around a specific angle rather than the engine's top picks.",
    caution: "A tag means conditions are met today. Not a guarantee. Check league context — a Low Scoring tag in a volatile division still carries real variance.",
  },
  {
    id: "enginetab", title: "THE ENGINE TAB", sub: "today's qualified picks", color: () => C.gold,
    what:    "Only fixtures that cleared every quality gate — model confidence, empirical hit rate, data quality, and odds value — appear here. Sorted by engine score.",
    telling: "A pick needs both a high historical rate for that market AND high model confidence for this specific game to qualify. The volatile label is informational — it still passed the bar.",
    use:     "Use as your shortlist before building. These are the games the system is most comfortable with today.",
    caution: "A short engine list isn't a bad day — it means few games cleared the bar. Don't force picks to get a longer list.",
  },
  {
    id: "custom", title: "CUSTOM TAB", sub: "strategy filter view", color: () => C.radar,
    what:    "Browse all fixtures filtered by strategy and signal. Quick Tempo presets sit at the top. Detailed Strategy shows specific presets — Home Win, BTTS, Draw, Low Scoring — always visible.",
    telling: "Every fixture shown meets the active filter. Sorted by model confidence. Signal chips are binary toggles. Advanced holds xG, Win %, Clean Sheet, and Odds threshold controls — shows an ACTIVE badge when set.",
    use:     "Step 1 — Choose a Quick Tempo or Detailed Strategy. Step 2 — Tap fixtures to select. Step 3 — Hit Add to Ticket. Picks land in your draft as a banner.",
    caution: "Adding a fixture already in your draft with a different pick prompts a replace-or-keep choice — nothing swaps silently.",
  },
  {
    id: "parlay", title: "PARLEY SYSTEM", sub: "Jarvis · Custom · saved · draft", color: () => C.edge,
    what:    "Where you build, review, save, and book tickets. Jarvis auto-builds the best ticket from the qualified pool. Custom builds N non-overlapping tickets. The Jarvis tab also shows pre-built TA engine parleys for the day.",
    telling: "Jarvis scores every qualified pick using a weighted formula then adds legs until your target odds are hit. The TA tab shows the engine's own pre-built parlay strategies — complete with odds and signal badges. On past dates these show WIN/LOSS/PENDING verdicts per leg.",
    use:     "Add legs from fixture cards first if you want specific picks, or let Jarvis build from scratch. Remix shuffles for a different combination. → Draft from Code Analyzer now gives you Replace or Add options so you never accidentally clear your builder.",
    caution: "Draft legs are in-session only. Save explicitly before leaving. Saved tickets get a reference code.",
  },
  {
    id: "rollover", title: "ROLLOVER SYSTEM", sub: "10-step compounding chain", color: () => C.accent,
    what:    "A structured compounding system. The engine manages one slip per day across a 10-step chain — your stake grows with each win.",
    telling: "Picks use a weighted formula (empirical rate + model confidence) and build legs until combined odds clear 2.0×. The slip locks at build time and won't change during the day. Steps 3, 5, and 7 are profit gates — 30% of pot locks in so you keep something even if the chain fails later.",
    use:     "Open the Rollover tab. Dashboard shows your current step and today's slip — book it there. Analytics shows strategy pipeline and ROI. History shows past chains. Step results feed into the Parleys tab in Performance so you can see your step-by-step win rate.",
    caution: "One loss resets compounding — but locked profit stays. Don't override the engine slip. Picks are chosen for survival rate, not short-term aggression.",
  },
  {
    id: "perf", title: "PERFORMANCE TAB", sub: "Overview · Markets · History · Parleys · Analyst", color: () => C.muted,
    what:    "Five sub-tabs of historical performance data. Overview shows engine pool headline stats and a 14-day hit rate sparkline. Markets shows per-market and per-strategy bars — tap any bar to expand every individual fixture pick underneath it. History has the day-by-day accordion. Parleys tracks your Jarvis parley record and Rollover step history. Analyst is a combinable query builder over all picks.",
    telling: "Overview hit rate is decay-weighted (14-day half-life) so recent form counts more. The Markets drill-down shows 60 individual picks per bucket with date, game, odds, and W/L result. Parleys breaks down hit rate by strategy label so you can see which ticket types land most consistently.",
    use:     "Check Markets before building — if a specific market is cold this week, think twice before stacking it. Use Analyst to filter any combination: market + pick type + league + result + min confidence, sorted by date/confidence/odds.",
    caution: "Small samples (under 20 picks per market) swing wildly. Don't restructure your approach off a 5-pick run. Give it 30+ before drawing real conclusions.",
  },
  {
    id: "ca", title: "CODE ANALYZER", sub: "slip review + Jarvis verdict", color: () => C.blue,
    what:    "Paste a booking code or share link from SportyBet, Duel, or Lucky's Ledger. The model matches each leg against that day's snapshots, computes win probabilities for every pick, and Jarvis delivers a sharp verdict using live web search.",
    telling: "Leg cards show model probability vs bookmaker-implied probability. The 'Rebuild' tab lets you swap any leg from your original pick to the model's top pick for that game — leg by leg — and book the rebuilt slip directly.",
    use:     "Paste code → Analyze → read the Jarvis verdict → tap Rebuild to swap weak legs → → Draft (with Replace or Add choice) to move to your Parley builder. If legs show 'no snapshot', fetch that date in Live Model first.",
    caution: "If a leg fails to match a fixture, the side names may be using a bookmaker variant the normaliser hasn't seen. The system covers most common aliases. Jarvis verdict requires Gemini — if it stalls, your API quota may be low.",
  },
  {
    id: "jarvis", title: "JARVIS", sub: "AI match assistant", color: () => C.accent,
    what:    "AI assistant with full access to every fixture's model data — xG, form, H2H, calibration quality, strategy tags, table position, all of it — plus live web search for current squad news.",
    telling: "Not generic football analysis. Jarvis is reading the actual numbers the model produced for that specific game and adding live injury and motivation context on top.",
    use:     "Tap the Jarvis FAB at any time. Ask about any fixture, any pick, or your whole ticket. The Mind Box at the top of the fixture list gives a daily overview across the full card. On past dates in the Jarvis tab, pre-built tickets show with WIN/LOSS/PENDING verdicts per leg.",
    caution: "Jarvis explains the model — it doesn't override it. If it sounds uncertain, the underlying data is thin or signals conflict. That's useful information in itself, not a malfunction.",
  },
];

function HelpModal({ onClose }) {
  const [openSection, setOpenSection] = useState(null);

  return (
    <div style={{ position:"fixed",inset:0,zIndex:600,background:"rgba(0,0,0,0.88)",display:"flex",alignItems:"flex-end",justifyContent:"center" }}
      onClick={onClose}>
      <div style={{ background:C.modalBg,borderRadius:"16px 16px 0 0",border:`1px solid ${C.border}`,
        width:"100%",maxWidth:480,maxHeight:"90vh",overflowY:"auto",paddingBottom:32 }}
        onClick={e => e.stopPropagation()}>

        {/* Header */}
        <div style={{ position:"sticky",top:0,background:C.modalBg,borderBottom:`1px solid ${C.border}`,
          padding:"18px 20px 14px",zIndex:1 }}>
          <div style={{ display:"flex",justifyContent:"space-between",alignItems:"center" }}>
            <div>
              <div style={{ fontSize:14,fontWeight:800,color:C.accent,letterSpacing:".04em" }}>Learn How GRM Works</div>
              <div style={{ fontSize:8,color:C.text,opacity:.45,marginTop:2 }}>Tap any section to expand</div>
            </div>
            <button onClick={onClose} className="gb"
              style={{ background:"transparent",border:"none",color:C.muted,padding:4,lineHeight:1,display:"flex",alignItems:"center" }}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
              </svg>
            </button>
          </div>
        </div>

        {/* Quick workflow */}
        <div style={{ margin:"14px 20px 6px",background:C.surface,borderRadius:10,
          border:`1px solid ${C.goldBorder}`,padding:"12px 14px" }}>
          <div style={{ fontSize:8,color:C.gold,fontWeight:800,letterSpacing:".12em",
            textTransform:"uppercase",marginBottom:10 }}>Quick Start — 4 Steps</div>
          {[
            [C.blue,   "Fetch today's fixtures", "Tap FETCH. Engine loads and scores every match for the day."],
            [C.gold,   "Find a pick",            "Engine tab = pre-qualified picks. Custom tab = filter by strategy. Tap + Add to Ticket on any card."],
            [C.edge,   "Build your ticket",      "Open Parley System. Let Jarvis auto-build, or review your draft legs and book directly."],
            [C.green,  "Track performance",      "Performance tab → Overview for hit rate. Markets → tap any bar for fixture-level results."],
          ].map(([col, title, desc], i) => (
            <div key={i} style={{ display:"flex",gap:10,alignItems:"flex-start",marginBottom: i < 3 ? 8 : 0 }}>
              <div style={{ width:20,height:20,borderRadius:"50%",background:`${col}20`,
                border:`1px solid ${col}40`,display:"flex",alignItems:"center",justifyContent:"center",
                flexShrink:0,marginTop:1 }}>
                <span style={{ fontSize:9,fontWeight:800,color:col }}>{i+1}</span>
              </div>
              <div>
                <div style={{ fontSize:10,fontWeight:800,color:C.text }}>{title}</div>
                <div style={{ fontSize:8,color:C.text,opacity:.55,marginTop:1,lineHeight:1.5 }}>{desc}</div>
              </div>
            </div>
          ))}
        </div>

        {/* Collapsible sections */}
        <div style={{ padding:"6px 20px 0" }}>
          {HELP_SECTIONS.map(sec => {
            const isOpen = openSection === sec.id;
            const col    = sec.color();
            const icon   = HELP_SECTION_ICONS[sec.id];
            return (
              <div key={sec.id} style={{ marginBottom:6,borderRadius:9,
                border:`1px solid ${isOpen ? col+"40" : C.border}`,
                background:isOpen ? `${col}06` : C.surface,
                overflow:"hidden",transition:"border-color .15s" }}>
                {/* Section header */}
                <button onClick={() => setOpenSection(isOpen ? null : sec.id)}
                  style={{ width:"100%",display:"flex",alignItems:"center",gap:10,
                    padding:"11px 14px",background:"transparent",border:"none",
                    cursor:"pointer",textAlign:"left",fontFamily:C.font }}>
                  {/* SVG icon in a tinted circle */}
                  <div style={{ width:28,height:28,borderRadius:"50%",
                    background:`${col}15`,border:`1px solid ${col}30`,
                    display:"flex",alignItems:"center",justifyContent:"center",
                    color:col,flexShrink:0 }}>
                    {icon}
                  </div>
                  <div style={{ flex:1,minWidth:0 }}>
                    <div style={{ display:"flex",alignItems:"baseline",gap:6 }}>
                      <span style={{ fontSize:10,fontWeight:800,color:col,letterSpacing:".08em",textTransform:"uppercase" }}>
                        {sec.title}
                      </span>
                      <span style={{ fontSize:8,color:col,opacity:.6,fontWeight:500,textTransform:"none",letterSpacing:".02em" }}>
                        ({sec.sub})
                      </span>
                    </div>
                  </div>
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke={C.muted}
                    strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"
                    style={{ transform: isOpen ? "rotate(180deg)" : "none", transition:"transform .2s", flexShrink:0 }}>
                    <polyline points="6 9 12 15 18 9"/>
                  </svg>
                </button>

                {/* Expanded content */}
                {isOpen && (
                  <div style={{ padding:"0 14px 14px",display:"flex",flexDirection:"column",gap:10 }}>
                    {[
                      { label:"What it is",            text: sec.what,    labelColor: C.text  },
                      { label:"What it's telling you", text: sec.telling, labelColor: col     },
                      { label:"How to use it",         text: sec.use,     labelColor: C.green },
                      { label:"When to be cautious",   text: sec.caution, labelColor: C.amber },
                    ].map(({ label, text, labelColor }) => (
                      <div key={label}>
                        <div style={{ fontSize:7,fontWeight:800,color:labelColor,opacity:.85,
                          textTransform:"uppercase",letterSpacing:".1em",marginBottom:3 }}>
                          {label}
                        </div>
                        <div style={{ fontSize:9,color:C.text,opacity:.8,lineHeight:1.65 }}>
                          {text}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>

        <div style={{ fontSize:8,color:C.text,opacity:.25,textAlign:"center",marginTop:14,padding:"0 20px" }}>
          Tap outside to close · No account or data stored
        </div>
      </div>
    </div>
  );
}

// ── FIRST-RUN ONBOARDING FLOW ─────────────────────────────────────────────
// Full-screen slide overlay. Shows once on first launch.
// N17: Bumped to grm_onboarded_v4 — all new features now reflected.
// Existing users on v3 will see the updated tutorial once on next launch.
const ONBOARD_ICONS = [
  <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><polyline points="8 17 12 21 16 17"/><line x1="12" y1="3" x2="12" y2="21"/><path d="M20 12H4"/></svg>,
  <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3"/><path d="M12 1v4M12 19v4M4.22 4.22l2.83 2.83M16.95 16.95l2.83 2.83M1 12h4M19 12h4M4.22 19.78l2.83-2.83M16.95 7.05l2.83-2.83"/></svg>,
  <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>,
  <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M3 9V7a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v2a3 3 0 0 0 0 6v2a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-2a3 3 0 0 0 0-6z"/><path d="M13 5v14"/></svg>,
  <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><polyline points="23 7 13.5 15.5 8.5 10.5 1 18"/><polyline points="17 7 23 7 23 13"/></svg>,
  <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><line x1="12" y1="20" x2="12" y2="10"/><line x1="18" y1="20" x2="18" y2="4"/><line x1="6" y1="20" x2="6" y2="16"/></svg>,
  <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>,
];

const ONBOARD_SLIDES = [
  {
    color:   () => C.blue,
    title:   "Fetch today's fixtures",
    body:    "Tap FETCH and the engine loads every fixture for the day, runs each one through the model, and scores every market. Past dates work too — results auto-merge so you can review how picks landed.",
    tip:     "The engine runs xG, form, standings, calibration weight, and historical hit rate together. It's not just one number.",
  },
  {
    color:   () => C.gold,
    title:   "Three signals per match",
    body:    "The Read is the model's highest-confidence pick. The Edge is where bookmaker odds look mispriced. Goal Radar shows per-team scoring probability. Tap Full Model on any card for the complete breakdown with xG, form, and table position.",
    tip:     "STRONG badge means extra confidence. Limited data means fewer than 10 season games — use those reads with more caution.",
  },
  {
    color:   () => C.accent,
    title:   "The Engine tab",
    body:    "Not every fixture qualifies. The Engine tab shows only games that cleared every threshold — model confidence, historical hit rate, data quality, and odds value. Sorted by engine score so the strongest sits at the top.",
    tip:     "A short engine list means fewer games cleared the bar today. Quality over volume — don't force picks just to build a longer list.",
  },
  {
    color:   () => C.edge,
    title:   "Build your ticket",
    body:    "Tap Add to Ticket on any pick. Open the Parley System to review. Jarvis auto-builds the best ticket from the engine pool. The Jarvis tab also shows pre-built TA engine parleys — on past dates these show WIN/LOSS/PENDING per leg.",
    tip:     "Remix shuffles Jarvis for a different combination. Sending picks from Code Analyzer now asks whether to replace or add to your existing draft.",
  },
  {
    color:   () => C.green,
    title:   "Rollover — compound engine",
    body:    "A 10-step compounding chain. One optimised slip per day, managed by the engine. Profit gates at steps 3, 5, and 7 lock secured gains even if the chain fails later. Step results feed into the Parleys performance tab so you can track your chain win rate over time.",
    tip:     "The daily slip locks at build time and won't change during the day.",
  },
  {
    color:   () => C.radar,
    title:   "Performance — five sub-tabs",
    body:    "Overview shows engine hit rate and a 14-day sparkline. Markets lets you tap any bar to see every individual fixture pick with its result. Parleys tracks your Jarvis parley record and Rollover step history with per-strategy hit rate. Analyst is a combinable query builder across all picks.",
    tip:     "Small samples swing wildly. Give any market 30+ picks before drawing real conclusions from its hit rate.",
  },
  {
    color:   () => C.blue,
    title:   "Code Analyzer",
    body:    "Paste a booking code from SportyBet, Duel, or Lucky's Ledger. The model matches each leg against that day's snapshots, shows model probability vs bookmaker odds, and Jarvis delivers a verdict using live web search. The Rebuild tab lets you swap any weak leg for the model's pick and re-book.",
    tip:     "If a leg shows no snapshot, fetch that date in Live Model first. The analyzer covers most common team name variants automatically.",
  },
];

function FirstRunFlow({ onDone }) {
  const [slide, setSlide] = useState(0);
  const total = ONBOARD_SLIDES.length;
  const s     = ONBOARD_SLIDES[slide];
  const col   = s.color();
  const icon  = ONBOARD_ICONS[slide];

  const finish = () => {
    try { localStorage.setItem("grm_onboarded_v4", "1"); } catch {}
    onDone();
  };

  const next = () => slide < total - 1 ? setSlide(slide + 1) : finish();

  return (
    <div style={{
      position:"fixed", inset:0, zIndex:800,
      background:"var(--bg)",
      display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center",
      padding:"32px 24px", fontFamily:"var(--font)",
    }}>
      <button onClick={finish} className="gb-ghost"
        style={{ position:"absolute", top:20, right:20, padding:"6px 14px", fontSize:10, opacity:.6 }}>
        Skip
      </button>

      <div style={{ width:"100%", maxWidth:360, display:"flex", flexDirection:"column",
                    alignItems:"center", textAlign:"center", flex:1, justifyContent:"center", gap:22 }}>

        <div style={{
          width:76, height:76, borderRadius:"var(--r-xl)",
          background:`${col}14`, border:`1px solid ${col}35`,
          display:"flex", alignItems:"center", justifyContent:"center",
          color:col,
        }}>
          {icon}
        </div>

        <div style={{ display:"flex", gap:5, width:"100%" }}>
          {ONBOARD_SLIDES.map((_,i) => (
            <div key={i} style={{
              flex:1, height:3, borderRadius:2,
              background: i <= slide ? col : "var(--glass-border)",
              transition:"background .25s",
            }}/>
          ))}
        </div>

        <div>
          <div style={{ fontSize:9, fontWeight:800, color:"var(--muted)", letterSpacing:".12em",
                        textTransform:"uppercase", marginBottom:8 }}>
            {slide + 1} of {total}
          </div>
          <div style={{ fontSize:20, fontWeight:800, color:"var(--text)", lineHeight:1.25, marginBottom:12 }}>
            {s.title}
          </div>
          <div style={{ fontSize:13, color:"var(--text)", opacity:.72, lineHeight:1.68 }}>
            {s.body}
          </div>
        </div>

        <div style={{
          background:`${col}0e`, border:`1px solid ${col}28`,
          borderRadius:"var(--r-lg)", padding:"10px 14px", width:"100%",
          textAlign:"left",
        }}>
          <div style={{ fontSize:8, color:col, fontWeight:800, letterSpacing:".1em",
                        textTransform:"uppercase", marginBottom:4 }}>Note</div>
          <div style={{ fontSize:10, color:"var(--text)", opacity:.68, lineHeight:1.58 }}>{s.tip}</div>
        </div>
      </div>

      <div style={{ width:"100%", maxWidth:360, marginTop:24, display:"flex", gap:8 }}>
        <button onClick={next} className="gb-primary"
          style={{ flex:1, padding:"14px 0", fontSize:13, fontWeight:800 }}>
          {slide < total - 1 ? "Next" : "Get started"}
        </button>
        {slide < total - 1 && (
          <button onClick={finish} className="gb-ghost"
            style={{ padding:"14px 18px", fontSize:11 }}>
            Skip
          </button>
        )}
      </div>
      <div style={{ fontSize:9, color:"var(--muted)", textAlign:"center", marginTop:10, opacity:.5 }}>
        No account required · no data stored on our servers
      </div>
    </div>
  );
}

// ── CUSTOM TAB BANNER ─────────────────────────────────────────────────────
// Shown once on first visit to the Custom tab. Dismissed with "Got it".
// Flag: grm_custom_onboarded_v1
function CustomTabBanner({ onDismiss }) {
  return (
    <div style={{ background:`${C.radar}0a`, border:`1px solid ${C.radar}28`,
      borderRadius:"var(--r-lg)", padding:"13px 15px", marginBottom:14,
      display:"flex", gap:12, alignItems:"flex-start" }}>
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke={C.radar} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink:0, marginTop:1 }}>
        <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
      </svg>
      <div style={{ flex:1, minWidth:0 }}>
        <div style={{ fontSize:11, fontWeight:800, color:C.radar, marginBottom:6 }}>
          How Custom Pick works
        </div>
        <div style={{ fontSize:10, color:"var(--text)", opacity:.72, lineHeight:1.65, marginBottom:10 }}>
          <strong style={{ color:"var(--text)", opacity:1 }}>Step 1</strong> — Choose a strategy filter (Home Win, BTTS, Over 2.5, Draw, etc.).<br/>
          <strong style={{ color:"var(--text)", opacity:1 }}>Step 2</strong> — Tap fixtures to select them. Confidence shown for each pick.<br/>
          <strong style={{ color:"var(--text)", opacity:1 }}>Step 3</strong> — Hit Add to Ticket. Your picks land in the draft — open the Parlay System when ready.
        </div>
        <button onClick={onDismiss} className="gb-ghost"
          style={{ padding:"5px 14px", fontSize:10, color:C.radar, borderColor:`${C.radar}40` }}>
          Got it
        </button>
      </div>
    </div>
  );
}

// ── PARLAY BUTTON NUDGE ───────────────────────────────────────────────────
// SVG icons — inline, no dependency, consistent 18×18 @ strokeWidth 2.2
const NAV_ICONS = {
  live: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>
    </svg>
  ),
  parley: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 9V7a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v2a3 3 0 0 0 0 6v2a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-2a3 3 0 0 0 0-6z"/>
      <path d="M13 5v14"/>
    </svg>
  ),
  rollover: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="22 7 13.5 15.5 8.5 10.5 2 17"/>
      <polyline points="16 7 22 7 22 13"/>
    </svg>
  ),
  stats: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="12" y1="20" x2="12" y2="10"/>
      <line x1="18" y1="20" x2="18" y2="4"/>
      <line x1="6" y1="20" x2="6" y2="16"/>
    </svg>
  ),
  tools: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 3h6"/>
      <path d="M10 9 4.5 18.5A2 2 0 0 0 6.2 21h11.6a2 2 0 0 0 1.7-2.5L14 9"/>
      <path d="M10 3v6l-1 2"/>
      <path d="M14 3v6l1 2"/>
    </svg>
  ),
};

function BottomNav({ activeTab, setActiveTab, onParleyOpen, draftCount, parleyOpen }) {
  // Tools tab cycles between backtest and code on repeat taps
  const handleTools = () => {
    if (activeTab === "code") setActiveTab("backtest");
    else if (activeTab === "backtest") setActiveTab("code");
    else setActiveTab("code"); // default: Code Analyzer first
  };

  const items = [
    { id:"live",     label:"Live Model",    icon:NAV_ICONS.live,     onClick:() => setActiveTab("live") },
    { id:"parley",   label:"Parley System", icon:NAV_ICONS.parley,   onClick:onParleyOpen, badge: draftCount > 0 ? draftCount : null },
    { id:"rollover", label:"Rollover",      icon:NAV_ICONS.rollover, onClick:() => setActiveTab("rollover") },
    { id:"stats",    label:"Performance",   icon:NAV_ICONS.stats,    onClick:() => setActiveTab("perf") },
    { id:"tools",    label:"Tools",         icon:NAV_ICONS.tools,    onClick:handleTools },
  ];

  // Active nav item — parley active when overlay is open
  const activeNav =
    parleyOpen                                            ? "parley"
    : activeTab === "perf"                               ? "stats"
    : activeTab === "rollover"                           ? "rollover"
    : activeTab === "backtest" || activeTab === "code"   ? "tools"
    : activeTab === "live"                               ? "live"
    : null;

  return (
    <nav className="grm-bottom-nav">
      {items.map(item => (
        <button
          key={item.id}
          className={`grm-nav-item${activeNav === item.id ? " active" : ""}`}
          onClick={item.onClick}
        >
          {item.badge != null && (
            <span className="grm-nav-badge">{item.badge}</span>
          )}
          <div className="grm-nav-icon">{item.icon}</div>
          <div className="grm-nav-label">{item.label}</div>
        </button>
      ))}
    </nav>
  );
}

// ── SIDEBAR NAV — desktop (≥1024px) ──────────────────────────────────────────
function SidebarNav({ activeTab, setActiveTab, onParleyOpen, draftCount, parleyOpen }) {
  const handleTools = () => {
    if (activeTab === "code") setActiveTab("backtest");
    else if (activeTab === "backtest") setActiveTab("code");
    else setActiveTab("code");
  };

  const items = [
    { id:"live",     label:"Live Model",    icon:NAV_ICONS.live,     onClick:() => setActiveTab("live") },
    { id:"parley",   label:"Parley System", icon:NAV_ICONS.parley,   onClick:onParleyOpen, badge: draftCount > 0 ? draftCount : null },
    { id:"rollover", label:"Rollover",      icon:NAV_ICONS.rollover, onClick:() => setActiveTab("rollover") },
    { id:"stats",    label:"Performance",   icon:NAV_ICONS.stats,    onClick:() => setActiveTab("perf") },
    { id:"tools",    label:"Tools",         icon:NAV_ICONS.tools,    onClick:handleTools },
  ];

  const activeNav =
    parleyOpen                                          ? "parley"
    : activeTab === "perf"                             ? "stats"
    : activeTab === "rollover"                         ? "rollover"
    : activeTab === "backtest" || activeTab === "code" ? "tools"
    : activeTab === "live"                             ? "live"
    : null;

  return (
    <aside className="grm-sidebar">
      <div className="grm-sidebar-logo">GRM Pro</div>
      <div className="grm-sidebar-items">
        {items.map(item => (
          <button
            key={item.id}
            className={`grm-sidebar-item${activeNav === item.id ? " active" : ""}`}
            onClick={item.onClick}
          >
            <div className="grm-sidebar-icon">{item.icon}</div>
            <span>{item.label}</span>
            {item.badge != null && (
              <span className="grm-sidebar-badge">{item.badge}</span>
            )}
          </button>
        ))}
      </div>
    </aside>
  );
}
// Key insight: the boundary takes a `fixtureId` prop and the error clears
// automatically when fixtures refresh (new key = fresh mount). The Retry
// button only appears if the fixture has an id (i.e. the data isn't fundamentally
// broken) — clicking it forces a re-mount via incrementing retryKey state,
// not just clearing the error, so the component fully re-initialises.
class FixtureErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null, retryKey: 0 };
  }
  static getDerivedStateFromError(e) { return { error: e }; }
  componentDidCatch(e, info) {
    // Log with fixture id so the specific problem record is identifiable
    console.warn(`FixtureCard render error [fixture: ${this.props.fixtureId || "unknown"}]:`, e.message, info?.componentStack?.split("\n")?.[1]?.trim());
  }
  render() {
    if (this.state.error) {
      const canRetry = !!this.props.fixtureId;
      return (
        <div style={{
          padding:"12px 14px", borderRadius:10,
          background:`${C.red}0a`, border:`1px solid ${C.red}25`,
          fontSize:9, color:C.muted, textAlign:"center",
        }}>
          <div style={{ marginBottom:6, color:C.red, fontWeight:700 }}>
            Failed to render fixture{this.props.fixtureId ? ` · id:${this.props.fixtureId}` : ""}
          </div>
          {canRetry && (
            <button
              onClick={() => this.setState(s => ({ error: null, retryKey: s.retryKey + 1 }))}
              style={{ fontSize:9, color:C.muted, background:"transparent",
                       border:`1px solid ${C.faint}`, borderRadius:6,
                       padding:"3px 10px", cursor:"pointer" }}>
              Retry
            </button>
          )}
        </div>
      );
    }
    // retryKey forces a full re-mount of children when Retry is pressed
    return React.cloneElement(this.props.children, { key: this.state.retryKey });
  }
}

// ── JARVIS FAB ────────────────────────────────────────────────────────────────
// Draggable floating button. Position persisted to localStorage.
// Touch + mouse drag with tap-vs-drag discrimination (< 6px movement = tap).
// Snaps to nearest vertical edge on release to stay out of content's way.
// Stays clear of bottom nav on mobile (min bottom = 76px + safe-area).
//
// FAB-DRAG FIX: Root cause of "moves but doesn't follow finger":
// The old code had TWO positioning layers fighting each other:
//   1. Outer <div> with React-controlled left/top via pos state
//   2. Inner <button> ref.current.style.left/.top mutated directly during drag
// On each render triggered by setDragging(true), React re-applied the outer div's
// pos state coordinates — snapping the button back to where it started.
// The button appeared to "move" only briefly before being snapped back.
//
// Fix: single element, single positioning owner. The wrapper div owns position via
// a ref and is mutated directly during drag (zero React renders mid-drag). On
// pointerup we commit the final position to state ONCE — one clean render.
// will-change:transform + translate3d hand the element to the GPU compositor
// so the motion is hardware-accelerated and latency-free on mobile.

const JARVIS_FAB_KEY = "grm_jarvis_fab_pos";

function JarvisFAB({ C, isDesktop, onClick }) {
  const SIZE = 52;
  const NAV_H = 76;

  const loadPos = () => {
    try {
      const saved = JSON.parse(localStorage.getItem(JARVIS_FAB_KEY) || "null");
      if (saved && typeof saved.x === "number" && typeof saved.y === "number") return saved;
    } catch {}
    return { x: window.innerWidth - SIZE - 16, y: window.innerHeight - SIZE - NAV_H - 16 };
  };

  const [pos, setPos]               = useState(loadPos);
  const [dragging, setDragging]     = useState(false);
  const [shaking, setShaking]       = useState(false);
  const [tipVisible, setTipVisible] = useState(false);
  // FEATURE-TIP CAROUSEL: cycles through FAB_FEATURE_TIPS instead of always
  // showing the same "Ask Jarvis anything" line. tipIndex tracks rotation
  // position across the whole session (persisted in a ref, not state, since
  // it doesn't need to trigger a render on its own — only the timer does).
  const [tipIndex, setTipIndex]     = useState(0);
  // wrapRef owns the DOM position — mutated directly during drag, no React renders mid-drag
  const wrapRef     = useRef(null);
  const dragRef     = useRef(null);  // drag session state (startX/Y, origX/Y, lastX/Y, moved)
  const shakeTimer  = useRef(null);
  const tipTimer    = useRef(null);

  // Shake + show next tip every 30s while FAB is idle.
  // FEATURE-TIP CAROUSEL FIX: previously this always showed the same static
  // "Ask Jarvis anything" string for a flat 3.5s. Now it rotates through
  // FAB_FEATURE_TIPS (Custom strategy, Code Analyzer, Engine tab, Rollover,
  // Performance — "Ask Jarvis anything" is still in the rotation, just not
  // the only thing shown) and sizes the on-screen duration to how long the
  // tip actually takes to read (tipReadDuration), so a short tip doesn't
  // linger and a longer one doesn't get cut off mid-sentence.
  // Gated on `!jarvisOpen` below at render time — it never shows while the
  // chat panel (with its own "Ask Jarvis anything..." input placeholder) is
  // open, so the two never compete for the same visual space.
  useEffect(() => {
    const schedule = () => {
      shakeTimer.current = setTimeout(() => {
        setShaking(true);
        setTipVisible(true);
        setTimeout(() => setShaking(false), 600);
        const tip = FAB_FEATURE_TIPS[tipIndex % FAB_FEATURE_TIPS.length];
        const readMs = tipReadDuration(tip.text);
        tipTimer.current = setTimeout(() => {
          setTipVisible(false);
          setTipIndex(i => (i + 1) % FAB_FEATURE_TIPS.length);
        }, readMs);
        schedule();
      }, 30000);
    };
    schedule();
    return () => { clearTimeout(shakeTimer.current); clearTimeout(tipTimer.current); };
  }, [tipIndex]);

  const clamp = (x, y) => {
    const maxX = (window.innerWidth  || 375) - SIZE - 8;
    const maxY = (window.innerHeight || 812) - SIZE - (isDesktop ? 8 : NAV_H + 8);
    return { x: Math.max(8, Math.min(x, maxX)), y: Math.max(8, Math.min(y, maxY)) };
  };

  const savePos = (p) => { try { localStorage.setItem(JARVIS_FAB_KEY, JSON.stringify(p)); } catch {} };

  const snapToEdge = (x, y) => {
    const midX = (window.innerWidth || 375) / 2;
    return { x: x < midX ? 16 : (window.innerWidth || 375) - SIZE - 16, y };
  };

  // Apply position directly to the wrapper DOM node — bypasses React entirely.
  // This is the key fix: React state only updates once on pointerup (one render),
  // not on every pointermove (which would be 60+ renders per second and lag behind finger).
  const applyPos = (x, y) => {
    if (!wrapRef.current) return;
    wrapRef.current.style.left = x + "px";
    wrapRef.current.style.top  = y + "px";
  };

  const onPointerDown = (e) => {
    if (e.button === 2) return;
    // Capture the pointer so pointermove fires even if finger leaves the button bounds
    e.currentTarget.setPointerCapture(e.pointerId);
    dragRef.current = {
      startX: e.clientX, startY: e.clientY,
      origX: pos.x, origY: pos.y,
      lastX: pos.x, lastY: pos.y,
      moved: false,
    };
    setDragging(true);
    setTipVisible(false);
  };

  useEffect(() => {
    if (!dragging) return;
    const onMove = (e) => {
      const d = dragRef.current;
      if (!d) return;
      const dx = e.clientX - d.startX;
      const dy = e.clientY - d.startY;
      // Discriminate tap from drag — 6px threshold
      if (Math.abs(dx) > 6 || Math.abs(dy) > 6) d.moved = true;
      const { x, y } = clamp(d.origX + dx, d.origY + dy);
      d.lastX = x; d.lastY = y;
      // Direct DOM mutation — FAB follows finger with zero latency
      applyPos(x, y);
    };
    const onUp = () => {
      const d = dragRef.current;
      setDragging(false);
      if (!d?.moved) {
        // Tap — restore DOM position in case of any micro-drift, then fire click
        applyPos(pos.x, pos.y);
        onClick?.();
      } else {
        // Drag end — snap to edge and commit to React state (one render)
        const snapped = snapToEdge(d.lastX, d.lastY);
        applyPos(snapped.x, snapped.y);  // apply immediately so snap is instant
        setPos(snapped);                 // then sync React state
        savePos(snapped);
      }
      dragRef.current = null;
    };
    window.addEventListener("pointermove", onMove, { passive: true });
    window.addEventListener("pointerup",   onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup",   onUp);
    };
  }, [dragging]); // eslint-disable-line react-hooks/exhaustive-deps

  // Keep within viewport on resize
  useEffect(() => {
    const onResize = () => {
      setPos(p => {
        const clamped = clamp(p.x, p.y);
        const snapped = snapToEdge(clamped.x, clamped.y);
        savePos(snapped);
        return snapped;
      });
    };
    window.addEventListener("resize", onResize, { passive: true });
    return () => window.removeEventListener("resize", onResize);
  }, [isDesktop]); // eslint-disable-line react-hooks/exhaustive-deps

  // Sync React pos state → DOM whenever it changes (after snap commit, resize, etc.)
  // During drag this does nothing — dragRef.current is set so we trust the DOM mutation path.
  useEffect(() => {
    if (!dragging) applyPos(pos.x, pos.y);
  }, [pos, dragging]);

  const isRightEdge = pos.x > (window.innerWidth || 375) / 2;

  return (
    <>
      <style>{`
        @keyframes grm-fab-shake {
          0%,100%{transform:rotate(0deg) scale(1)}
          15%{transform:rotate(-12deg) scale(1.05)}
          30%{transform:rotate(10deg) scale(1.05)}
          45%{transform:rotate(-8deg)}
          60%{transform:rotate(6deg)}
          75%{transform:rotate(-3deg)}
        }
        @keyframes grm-fab-drag-pulse {
          0%{box-shadow:0 0 0 0 var(--fab-accent-ring)}
          70%{box-shadow:0 0 0 10px transparent}
          100%{box-shadow:0 0 0 0 transparent}
        }
        @keyframes grm-fade-in { from{opacity:0;transform:translateY(4px)} to{opacity:1;transform:translateY(0)} }
        @keyframes slideUp{from{transform:translateY(100%)}to{transform:translateY(0)}}
      `}</style>

      {/* Single wrapper div — this is the ONLY element that owns position.
          wrapRef is mutated directly during drag. React state only drives initial
          left/top and post-snap updates. will-change promotes to GPU layer. */}
      <div
        ref={wrapRef}
        style={{
          position: "fixed",
          left: pos.x,
          top: pos.y,
          zIndex: 500,
          userSelect: "none",
          willChange: "left, top",     // hint compositor to promote this layer
        }}
      >
        {/* Feature-discovery tooltip — rotates through FAB_FEATURE_TIPS.
            Theme-aware via C.surface / C.accent / C.text, same as before.
            whiteSpace switched from nowrap → normal + maxWidth because tip
            copy is longer than the original fixed "Ask Jarvis anything"
            line and would otherwise overflow off-screen on narrow phones. */}
        {tipVisible && !dragging && (
          <div style={{
            position: "absolute",
            bottom: SIZE + 8,
            [isRightEdge ? "right" : "left"]: 0,
            // #2-FIX: solid bg with fallback so it's never transparent on any theme.
            // #2.1-FIX: wider + min-height so bubble is squarer, not a tall rectangle.
            background: C.cardBg || C.surface || "#1e1e2e",
            border: `1px solid ${C.accent}50`,
            borderRadius: 10,
            padding: "10px 13px",
            fontSize: 11,
            color: C.text,
            whiteSpace: "normal",
            width: 210,
            minHeight: 60,
            lineHeight: 1.55,
            boxShadow: `0 6px 20px rgba(0,0,0,0.45)`,
            pointerEvents: "none",
            animation: "grm-fade-in .2s ease",
          }}>
          {FAB_FEATURE_TIPS[tipIndex % FAB_FEATURE_TIPS.length].text}
            <div style={{
              position: "absolute", bottom: -5,
              [isRightEdge ? "right" : "left"]: 18,
              width: 10, height: 10,
              background: C.surface,
              border: `1px solid ${C.accent}40`,
              borderTop: "none", borderLeft: "none",
              transform: "rotate(45deg)",
              borderRadius: 2,
            }}/>
          </div>
        )}

        {/* Pulse ring — subtle ambient glow behind the FAB */}
        {!dragging && (
          <div style={{
            position:"absolute", inset:-5, borderRadius:"50%",
            background:`radial-gradient(circle, ${C.accent}22 0%, transparent 70%)`,
            pointerEvents:"none",
          }}/>
        )}

        <button
          onPointerDown={onPointerDown}
          aria-label="Open Jarvis"
          style={{
            width: SIZE, height: SIZE,
            borderRadius: "50%",
            background: dragging ? C.accent : `${C.accent}ee`,
            border: `2px solid ${C.accent}`,
            boxShadow: dragging
              ? `0 0 0 5px ${C.accent}28, 0 14px 40px rgba(0,0,0,0.5), inset 0 1px 0 rgba(255,255,255,0.15)`
              : `0 0 0 3px ${C.accent}14, 0 6px 24px ${C.accent}35, inset 0 1px 0 rgba(255,255,255,0.12)`,
            color: C.accentText,
            cursor: dragging ? "grabbing" : "grab",
            display: "flex", alignItems: "center", justifyContent: "center",
            flexDirection: "column", gap: 1,
            transition: dragging
              ? "box-shadow .08s, transform .08s"
              : "box-shadow .2s, transform .2s",
            transform: dragging ? "scale(1.14)" : "scale(1)",
            animation: shaking ? "grm-fab-shake .6s ease" : "none",
            WebkitTapHighlightColor: "transparent",
            touchAction: "none",
            outline: "none",
            position: "relative",
            overflow: "hidden",
          }}
        >
          {/* Sheen overlay */}
          <div style={{
            position:"absolute", top:0, left:0, right:0, height:"50%",
            background:"rgba(255,255,255,0.10)", borderRadius:"50% 50% 0 0",
            pointerEvents:"none",
          }}/>
          {/* Chat bubble icon — clean, recognisable as AI assistant */}
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor"
            strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"
            style={{ position:"relative", zIndex:1 }}>
            <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" fill="currentColor" opacity=".2"/>
            <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
            <line x1="9" y1="10" x2="15" y2="10" strokeWidth="1.6"/>
            <line x1="9" y1="13" x2="13" y2="13" strokeWidth="1.6"/>
          </svg>
          <span style={{ fontSize:6, fontWeight:900, letterSpacing:".06em",
                          textTransform:"uppercase", opacity:.85, position:"relative", zIndex:1,
                          lineHeight:1, marginTop:1 }}>
            Jarvis
          </span>
        </button>
      </div>
    </>
  );
}

export default function GRMPro() {

  // ── THEME ─────────────────────────────────────────────────────────────────
  const [theme, setTheme] = useState(loadSavedTheme);
  const [themePickerOpen, setThemePickerOpen] = useState(false);
  const [coached, setCoached] = useState(() => {
    try { return !!localStorage.getItem(COACH_KEY); } catch { return false; }
  });

  useEffect(() => {
    syncC(theme);
    injectStyles(theme);
    document.body.style.background = theme.bg;
    document.body.style.color = theme.text;
    document.body.style.fontFamily = theme.font;
  }, [theme]);

  // Sync before first paint (no flash)
  syncC(theme);

  // UX-FIX: blank/white first-paint on fresh installs (new phone, incognito) until the
  // user taps the address bar. Tapping the address bar forces the mobile browser to
  // recalculate the viewport (its toolbar collapses) which triggers a repaint — the page
  // was actually fine, it just never got that first repaint nudge. We force the same
  // recalculation ourselves shortly after mount so it doesn't depend on the user noticing.
  useEffect(() => {
    const nudge = () => {
      window.dispatchEvent(new Event("resize"));
      // Tiny scroll-and-back forces layout recalculation on stubborn mobile WebViews
      window.scrollTo(0, 1);
      window.scrollTo(0, 0);
    };
    const t1 = setTimeout(nudge, 60);
    const t2 = setTimeout(nudge, 400);
    return () => { clearTimeout(t1); clearTimeout(t2); };
  }, []);

  // UX-FIX: "new version available" banner pushed to all users on stale code, without
  // needing a backend endpoint or service worker. We periodically re-fetch the deployed
  // index page (same-origin, no-store so Vercel's edge cache is bypassed) and compare its
  // ETag/Last-Modified — when it changes, Vercel has shipped a new build and the open tab
  // is still running the old bundle, so we surface a Refresh prompt instead of relying on
  // the user to think to reload.
  const [updateAvailable, setUpdateAvailable] = useState(false);
  const buildFingerprintRef = useRef(null);
  useEffect(() => {
    let stopped = false;
    const checkForUpdate = async () => {
      try {
        const res = await fetch(`${window.location.origin}/`, { cache: "no-store" });
        const fingerprint = res.headers.get("etag") || res.headers.get("last-modified") || (await res.text()).slice(0, 500);
        if (buildFingerprintRef.current === null) {
          buildFingerprintRef.current = fingerprint;
        } else if (fingerprint !== buildFingerprintRef.current && !stopped) {
          setUpdateAvailable(true);
        }
      } catch { /* offline or blocked — skip this check, try again next interval */ }
    };
    checkForUpdate();
    const id = setInterval(checkForUpdate, 90000); // check every 90s
    const onFocus = () => checkForUpdate(); // also check whenever the tab regains focus
    window.addEventListener("focus", onFocus);
    return () => { stopped = true; clearInterval(id); window.removeEventListener("focus", onFocus); };
  }, []);

  const pickTheme = (t) => { setTheme(t); saveTheme(t.id); setThemePickerOpen(false); };

  const [activeTab, setActiveTab] = useState("live");
  const [date, setDate]           = useState(todayStr());
  const [fixtures, setFixtures]   = useState([]);
  const [loading, setLoadingState] = useState(false);
  const loadingRef                 = useRef(false);
  // Wrapper keeps the ref in sync so startAutoRefresh reads current value without stale closure
  const setLoading = useCallback((val) => {
    loadingRef.current = !!val;
    setLoadingState(val);
  }, []);
  const [error, setError]         = useState(null);
  const [cached, setCached]       = useState(false);
  const [cachedAt, setCachedAt]   = useState(null);  // N16-FIX: timestamp of when cache was written
  const [legacySnapshot, setLegacySnapshot] = useState(false);

  const [tab, setTab]             = useState("all");
  const [search, setSearch]       = useState("");
  const [leagueFilter, setLeagueFilter] = useState(null);
  const [sortActive,   setSortActive]   = useState(new Set());
  const [frozenFixtures, setFrozenFixtures] = useState([]); // engine pool snapshot — set at fetch, never updated by live polling

  const [budget, setBudget]       = useState(100);
  const [budgetPct, setBudgetPct] = useState(100); // slider removed — always stake full budget
  const [numParlays, setNumParlays] = useState(1); // P9-FIX: default 1, user increments themselves
  const [targetOdds, setTargetOdds] = useState(5);
  const [marketFilter, setMarketFilter] = useState(["theRead"]);
  const toggleMarket = id => setMarketFilter(prev => prev.includes(id) ? (prev.length>1?prev.filter(x=>x!==id):prev) : [...prev, id]);

  const [tickets, setTicketsRaw] = useState([]);
  // B1-FIX: built tickets persist across refreshes for the same date.
  // On mount, rehydrate from sessionStorage if the date key matches today.
  const setTickets = useCallback((updater) => {
    setTicketsRaw(prev => {
      const next = typeof updater === "function" ? updater(prev) : updater;
      try { sessionStorage.setItem(BUILT_TICKETS_KEY(todayStr()), JSON.stringify(next)); } catch {}
      return next;
    });
  }, []);
  useEffect(() => {
    try {
      const stored = sessionStorage.getItem(BUILT_TICKETS_KEY(todayStr()));
      if (stored) { const parsed = JSON.parse(stored); if (Array.isArray(parsed) && parsed.length) setTicketsRaw(parsed); }
    } catch {}
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const [historicalRates, setHistoricalRates] = useState(null);
  const historicalRatesDateRef    = useRef(null);

  const [progress, setProgress]   = useState(0);
  const [progressStage, setProgressStage] = useState("");
  const [progressMsg, setProgressMsg]     = useState("");
  const sessionIdRef              = useRef(null);
  const pollRef                   = useRef(null);
  const fetchStartTimeRef         = useRef(null);   // tracks when current fetch began
  const lastProgressRef           = useRef({ pct: 0, ts: Date.now() }); // stuck detection

  const [parlayJarvisOpen, setParlayJarvisOpen] = useState(false);

  // N19-FIX: On mount, check for ?grm=CODE in URL — open parley panel and queue ticket load
  const [grmInboundCode, setGrmInboundCode] = useState(null);
  useEffect(() => {
    try {
      const params = new URLSearchParams(window.location.search);
      const code = params.get("grm");
      if (code) {
        setGrmInboundCode(code.toUpperCase());
        setParlayJarvisOpen(true);
        // Clean the URL so sharing the current page doesn't re-trigger
        window.history.replaceState({}, "", window.location.pathname);
      }
    } catch {}
  }, []);

  // P16-FIX: Body scroll lock when overlay is open.
  // overscrollBehavior:contain on the overlay div is not enough on iOS/Android —
  // the OS-level rubber-band scroll still moves the background page.
  // Locking overflow:hidden on document.body while the overlay is open is the
  // only reliable cross-platform fix. We restore the exact scrollY on close so
  // the user returns to where they were, not to the top of the page.
  useEffect(() => {
    if (parlayJarvisOpen) {
      const scrollY = window.scrollY;
      document.body.style.overflow  = "hidden";
      document.body.style.position  = "fixed";
      document.body.style.top       = `-${scrollY}px`;
      document.body.style.width     = "100%";
      return () => {
        document.body.style.overflow  = "";
        document.body.style.position  = "";
        document.body.style.top       = "";
        document.body.style.width     = "";
        window.scrollTo(0, scrollY);
      };
    }
  }, [parlayJarvisOpen]);

  // ── JARVIS OVERLAY ────────────────────────────────────────────────────────
  // jarvisOpen controls the ChatLayout overlay panel — independent of all other views.
  // The bolt FAB is always visible so the user can open Jarvis from any Pro screen.
  const [jarvisOpen, setJarvisOpen] = useState(false);

  // P16-FIX (also for Jarvis chat overlay): same body scroll lock as parlayJarvisOpen
  useEffect(() => {
    if (jarvisOpen) {
      const scrollY = window.scrollY;
      document.body.style.overflow  = "hidden";
      document.body.style.position  = "fixed";
      document.body.style.top       = `-${scrollY}px`;
      document.body.style.width     = "100%";
      return () => {
        document.body.style.overflow  = "";
        document.body.style.position  = "";
        document.body.style.top       = "";
        document.body.style.width     = "";
        window.scrollTo(0, scrollY);
      };
    }
  }, [jarvisOpen]);

  // CL1: code payload from Jarvis chat → CodeAnalyzer auto-trigger
  const [jarvisCodePayload, setJarvisCodePayload] = useState(null);
  // Pre-built ticket from Jarvis chat — passed into ParlayJarvisTab as active built ticket
  const [jarvisBuiltTicket, setJarvisBuiltTicket] = useState(null);

  // rolloverChain — lifted from RolloverSystem via onChainChange callback.
  // This is the REAL chain object Jarvis reads. Never hardcoded null.
  const [rolloverChain, setRolloverChain] = useState(null);
  const handleChainChange = useCallback((chain) => setRolloverChain(chain), []);

  // onNavigatePro — called by ChatLayout to drive Pro's navigation from inside Jarvis.
  // Closes the overlay only when Jarvis explicitly navigates away (e.g. Open in Live Model).
  // Jarvis stays open for passive navigations like "Go to Rollover" so user can keep chatting.
  const handleJarvisNavigate = useCallback((dest) => {
    if (!dest) return;
    const { tab: navTab, subTab, fixture, autoAnalyze, code, platform, keepOpen } = dest;

    if (navTab === "rollover") {
      setMainView("rollover");
      setParlayJarvisOpen(false);
      if (!keepOpen) setJarvisOpen(false);
      return;
    }
    if (navTab === "live") {
      setMainView("main");
      setActiveTab("live");
      if (subTab === "custom") setTab("custom");
      else if (subTab === "engine") setTab("all");
      setParlayJarvisOpen(false);
      if (!keepOpen) setJarvisOpen(false);
      return;
    }
    if (navTab === "code") {
      setMainView("main");
      setActiveTab("code");
      // CL1: store code payload so CodeAnalyzer can auto-trigger analysis
      if (code || platform) {
        setJarvisCodePayload({ code: code || null, platform: platform || null, autoAnalyze: !!autoAnalyze });
      }
      setParlayJarvisOpen(false);
      if (!keepOpen) setJarvisOpen(false);
      return;
    }
    if (navTab === "saved") {
      // "saved" means open Parley System on the Saved sub-tab
      setParlayJarvisOpen(true);
      // Signal ParlayJarvisTab to switch to saved view after mount
      if (dest.ticketId || dest.ticket) {
        setJarvisBuiltTicket(dest.ticket || { id: dest.ticketId, _viewSaved: true });
      }
      if (!keepOpen) setJarvisOpen(false);
      return;
    }
    if (navTab === "parley" || dest.ticket) {
      setParlayJarvisOpen(true);
      if (dest.ticket) {
        setJarvisBuiltTicket(dest.ticket);
      }
      if (!keepOpen) setJarvisOpen(false);
      return;
    }
    if (fixture) {
      // Open Full Model for a specific fixture — keep Jarvis open so user can keep chatting
      try { sessionStorage.setItem("grm_scroll", String(window.scrollY)); } catch {}
      setFullModelReturnTab("live");
      setMainFocusFixture(fixture);
      setJarvisOpen(false);
      return;
    }
  }, []);

  // Scroll-to-top FAB — appears after user scrolls past the header
  const [showScrollTop, setShowScrollTop] = useState(false);
  useEffect(() => {
    const onScroll = () => setShowScrollTop(window.scrollY > 320);
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  // mainView controls top-level section: "main" (uses activeTab) or "rollover"
  const [mainView, setMainView] = useState("main");
  const [mainFocusFixture, setMainFocusFixture] = useState(null); // Full Model page overlay
  const [fullModelReturnTab, setFullModelReturnTab] = useState(null); // where to go back to
  const [drawerOpen, setDrawerOpen]             = useState(false); // right-side filter drawer
  const DRAFT_KEY = "grm_draft_legs";
  const [draftLegs, setDraftLegs] = useState(() => {
    try {
      const raw = sessionStorage.getItem(DRAFT_KEY);
      return raw ? JSON.parse(raw) : [];
    } catch { return []; }
  });
  // Sync draftLegs to sessionStorage whenever it changes
  useEffect(() => {
    try { sessionStorage.setItem(DRAFT_KEY, JSON.stringify(draftLegs)); } catch {}
  }, [draftLegs]);
  const [draftConflicts, setDraftConflicts] = useState([]); // Fix 8
  const [pendingTicket,  setPendingTicket]  = useState(null); // Fix 8
  const [adminMode, setAdminMode] = useState(() => {
    try { return sessionStorage.getItem("grm_admin") === "1"; } catch { return false; }
  });
  // adminToken is stored in memory only for the current session — never hardcoded in
  // fetch headers. Set when the user successfully enters it, cleared on lock.
  const [adminToken, setAdminToken] = useState(() => {
    try { return sessionStorage.getItem("grm_admin") === "1" ? sessionStorage.getItem("grm_admin_tok") || "" : ""; } catch { return ""; }
  });

  const [adminPromptOpen, setAdminPromptOpen] = useState(false);
  const [adminTokenInput, setAdminTokenInput] = useState("");
  const [helpOpen, setHelpOpen] = useState(false);

  // ── Onboarding flags ──────────────────────────────────────────────────────
  const [showOnboarding, setShowOnboarding] = useState(() => {
    try { return !localStorage.getItem("grm_onboarded_v4"); } catch { return false; }
  });
  const [showCustomBanner, setShowCustomBanner] = useState(() => {
    try { return !localStorage.getItem("grm_custom_onboarded_v1"); } catch { return false; }
  });
  const parlayNudgeShownRef = useRef(true); // P14: nudge removed — ref kept to avoid breaking existing trigger guards

  const toggleAdmin = () => {
    if (adminMode) {
      setAdminMode(false);
      setAdminToken("");
      try { sessionStorage.removeItem("grm_admin"); sessionStorage.removeItem("grm_admin_tok"); } catch {}
      return;
    }
    setAdminPromptOpen(true);
    setAdminTokenInput("");
  };

  const submitAdminToken = () => {
    if (adminTokenInput === "sterling77") {
      setAdminMode(true);
      setAdminToken(adminTokenInput);
      try { sessionStorage.setItem("grm_admin", "1"); sessionStorage.setItem("grm_admin_tok", adminTokenInput); } catch {}
    }
    setAdminPromptOpen(false);
    setAdminTokenInput("");
  };

  // Stable callbacks for onFullModel — must be declared at hook level, never inside JSX.
  // Calling useCallback inside conditional renders violates Rules of Hooks.
  // C1-FIX: save scroll position before navigating to Full Model so Back returns
  // the user to where they were. Previously only the grid/CustomListView paths
  // saved grm_scroll — these two callbacks were missing it entirely.
  const onFullModelFromParlay   = useCallback(f => { try { sessionStorage.setItem("grm_scroll", String(window.scrollY)); } catch {} setFullModelReturnTab("parlay");   setMainFocusFixture(f); }, []);
  const onFullModelFromRollover = useCallback(f => { try { sessionStorage.setItem("grm_scroll", String(window.scrollY)); } catch {} setMainView("main"); setFullModelReturnTab("rollover"); setMainFocusFixture(f); }, []);

  // Add a pick from fixture card to draft legs
  const addLegToDraft = useCallback((fixture, pick) => {
    const state = (fixture.state || "").toLowerCase().replace(/[_\-\s]/g, "");
    // Block finished and cancelled/postponed games only.
    // Live/in-progress games ARE allowed — user sees the amber "Game is LIVE" warning on the card.
    const BLOCKED = new Set([
      "finished","ft","fulltime","ended","complete","aet","afterextratime","afterpenalties",
      "postponed","ppd","suspended","interrupted","abandoned","cancelled","canceled","deleted",
      "3","5", // SofaScore legacy numeric: 3 = finished, 5 = cancelled
    ]);
    if (BLOCKED.has(state)) return;
    const io = safeImpliedOdds;
    const rawOdds = pick.odds || io(pick.prob);
    const leg = {
      fixtureId: fixture.id,
      game:      `${fixture.teams.home} vs ${fixture.teams.away}`,
      home:      fixture.teams.home,
      away:      fixture.teams.away,
      pick:      pick.pick,
      odds:      rawOdds ? parseFloat(rawOdds) : null,
      conf:      pick.prob ? parseFloat(pick.prob) : null,
      market:    pick.market || "Unknown",
    };
    setDraftLegs(prev => {
      const exists = prev.findIndex(l => l.fixtureId === fixture.id);
      if (exists >= 0) {
        // Replace existing leg with new pick — don't silently ignore
        const next = [...prev];
        next[exists] = leg;
        return next;
      }
      return [...prev, leg];
    });
  }, []);

  const safeCacheWrite = (key, payload) => {
    try {
      // N16-FIX: embed cachedAt timestamp so the UI can detect stale cache
      const withTs = { ...payload, cachedAt: Date.now() };
      const s = JSON.stringify(withTs);
      if (s.length * 2 > 4 * 1024 * 1024) return; // pre-flight: skip if > 4MB
      localStorage.setItem(key, s);
    } catch (err) {
      // E3-FIX: QuotaExceededError mid-session — evict old GRM keys and retry once.
      // This happens when the user has been using the app across multiple dates and
      // older cache entries have accumulated. Silently evict then retry.
      if (err?.name === "QuotaExceededError" || err?.code === 22) {
        try {
          // Evict all grm_ prefixed keys except the one we're writing
          const toRemove = [];
          for (let i = 0; i < localStorage.length; i++) {
            const k = localStorage.key(i);
            if (k && k.startsWith("grm_") && k !== key) toRemove.push(k);
          }
          toRemove.forEach(k => { try { localStorage.removeItem(k); } catch {} });
          // Retry the write after eviction
          const withTs = { ...payload, cachedAt: Date.now() };
          localStorage.setItem(key, JSON.stringify(withTs));
        } catch {
          // If retry also fails (device storage critically full), fail silently.
          // App still works — cache just won't persist this session.
        }
      }
    }
  };

  useEffect(() => {
    // Seed server date on mount so todayStr() and the date picker are server-aligned.
    // Without this, a user in UTC+3 at 11pm local time gets tomorrow's date as the
    // default while the server is still serving today's fixtures.
    fetchServerDate().then(d => {
      if (d && d !== date) setDate(d);
    });
    try {
      const raw = localStorage.getItem(CACHE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      const { date:d, data } = parsed;
      // Validate shape — old-schema fixtures missing teams/markets crash FixtureCard.
      // A fixture without both fields is useless anyway so discard the whole cache.
      const valid = Array.isArray(data) && data.length > 0 &&
                    data.every(f => f && f.teams && f.markets);
      if (d === date && valid) { const fd = applyFinishedStates(data); setFixtures(fd); setCached(true); setCachedAt(parsed.cachedAt || null); setFrozenFixtures(fd); }
      else if (!valid && data?.length) {
        // Silently clear invalid cache so user fetches fresh data
        try { localStorage.removeItem(CACHE_KEY); } catch {}
      }
    } catch {
      try { localStorage.removeItem(CACHE_KEY); } catch {}
    }
  }, []);

  // Apply finished flag from injectResults to state immediately on load
  // So past dates show "FT" without waiting for the live ticker
  const applyFinishedStates = useCallback((fixturesArr) => {
    return fixturesArr.map(f => {
      if (f.finished === true) {
        const cur = (f.state || f.stateNorm || "").toLowerCase();
        if (!["finished","ft","fulltime","ended","aet","afterextratime"].includes(cur)) {
          return { ...f, state:"finished", stateNorm:"finished", isLive:false, isDone:true };
        }
      }
      return f;
    });
  }, []);

  const startPolling = (session, pollDate) => {
    if (pollRef.current) clearInterval(pollRef.current);
    fetchStartTimeRef.current = Date.now();
    lastProgressRef.current   = { pct: 0, ts: Date.now() };
    const dateParam = pollDate ? `&date=${pollDate}` : "";
    pollRef.current = setInterval(async () => {
      try {
        const r = await fetch(`${SERVER}/api/progress?session=${session}${dateParam}`), d = await r.json();
        const pct = d.pct || 0;
        // Track last progress change for stuck detection
        if (pct !== lastProgressRef.current.pct) {
          lastProgressRef.current = { pct, ts: Date.now() };
        }
        setProgress(pct); setProgressStage(d.stage||""); setProgressMsg(d.message||"");
        // joined:true means we are reading date-keyed progress from another user's pipeline
        // Only stop on explicit terminal stage — NOT pct>=100 alone.
        if (d.stage === "done" || d.stage === "error") { clearInterval(pollRef.current); pollRef.current = null; }
      } catch {}
    }, 800);
  };
  const stopPolling = () => { if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; } };
  useEffect(() => () => stopPolling(), []);

  // Debounce ref — prevents rapid FETCH taps from spawning concurrent polls
  // each with a different session id, which causes the progress bar to sit at
  // 0% "Starting…" forever because the poll hits a session the server doesn't know.
  const fetchDebounceRef = useRef(null);

  const fetchData = useCallback(async (force = false) => {
    // Debounce: ignore taps within 1.5s of each other.
    const now = Date.now();
    if (fetchDebounceRef.current && now - fetchDebounceRef.current < 1500 && !force) return;
    fetchDebounceRef.current = now;

    stopPolling();
    stopAutoRefresh();
    setLoading(true); setError(null); setCached(false); setCachedAt(null); setLegacySnapshot(false); setTickets([]);
    setProgress(0); setProgressStage("starting"); setProgressMsg("Initialising…");
    fetchStartTimeRef.current   = Date.now();
    lastProgressRef.current     = { pct: 0, ts: Date.now() };
    const session = `${Date.now()}_${Math.random().toString(36).slice(2,8)}`;
    sessionIdRef.current = session; startPolling(session, date);

    // isSyncPath: true if we resolve in this call (200 snapshot hit or error).
    // false if we returned a 202 and handed off to loadWhenDone interval.
    // The finally block only calls setLoading(false) on the sync path —
    // the async path manages its own loading state internally.
    let isSyncPath = true;
    try {
      const res = await fetch(`${SERVER}/api/grm-pro-data?date=${date}&session=${session}${force?"&force=1":""}`);

      if (res.status === 202) {
        // Pipeline is running — keep loading, poll until done then load snapshot.
        isSyncPath = false; // don't let finally kill loading state
        const loadWhenDone = setInterval(async () => {
          try {
            const check = await fetch(`${SERVER}/api/progress?session=${session}&date=${date}`);
            const d = await check.json();
            if (d.stage === "done") {
              clearInterval(loadWhenDone);
              const snap = await fetch(`${SERVER}/api/grm-pro-data?date=${date}&session=${session}`);
              if (!snap.ok) throw new Error(`Snapshot load failed: ${snap.status}`);
              const json = await snap.json();
              const data = Array.isArray(json.data) ? json.data : [];
              const capturedDate = date; // hoist so startAutoRefresh and pool save share same value
              const _fd1 = applyFinishedStates(data); setFixtures(_fd1); safeCacheWrite(CACHE_KEY, { date, data }); setFrozenFixtures(_fd1);
              // N7-FIX: startAutoRefresh was missing from the 202 async path — it only
              // existed in the sync 200 path. This caused results to never auto-inject
              // after the first fetch (pipeline always returns 202 on a fresh date).
              startAutoRefresh(capturedDate);

              if (json.legacySchema) setLegacySnapshot(true);
              setProgress(100); setProgressStage("done"); setProgressMsg(`${data.length} fixtures ready`);
              if (data.length) {
                (async () => {
                  let rates = historicalRates;
                  if (!rates) rates = await ensureHistoricalRates();
                  const pool = buildUniversalPool(data, rates || {});
                  if (pool.length) savePoolToServer(pool, capturedDate);
                })();
              }
              setTimeout(() => { setLoading(false); stopPolling(); }, 600);
            } else if (d.stage === "error") {
              clearInterval(loadWhenDone);
              setError(d.message || "Pipeline failed — try again.");
              setLoading(false); stopPolling();
            }
          } catch {}
        }, 1200);
        return;
      }

      if (!res.ok) {
        const e = await res.json().catch(()=>({}));
        if (res.status === 404) {
          setError(e.error || `No data available for ${date}. Only dates fetched live have snapshots.`);
          return;
        }
        throw new Error((e.error||res.statusText) + (e.stack ? " || " + e.stack.split("\n").slice(0,3).join(" > ") : ""));
      }

      const json = await res.json(), data = Array.isArray(json.data) ? json.data : [];
      const _fd2 = applyFinishedStates(data); setFixtures(_fd2); safeCacheWrite(CACHE_KEY, { date, data }); setFrozenFixtures(_fd2);
      startAutoRefresh(date);

      if (json.legacySchema) setLegacySnapshot(true);
      setProgress(100); setProgressStage("done"); setProgressMsg(`${data.length} fixtures ready`);
      if (data.length) {
        const capturedDate = date;
        (async () => {
          let rates = historicalRates;
          if (!rates || historicalRatesDateRef.current !== todayStr()) rates = await ensureHistoricalRates();
          rates = rates || {};
          const pool = buildUniversalPool(data, rates);
          if (pool.length) savePoolToServer(pool, capturedDate);
        })();
      }
    } catch(e) {
      const friendly = friendlyError(e, "GRM Pro");
      setError(friendly); setProgressStage("error"); setProgressMsg(friendly);
    } finally {
      // Only stop loading on the synchronous path.
      // The 202 async path sets isSyncPath=false and manages its own loading state.
      if (isSyncPath) { stopPolling(); setLoading(false); }
    }
  }, [date]);

  const loadSnapshot = useCallback(async snapDate => {
    stopPolling();
    setLoading(true); setError(null); setCached(false); setCachedAt(null); setLegacySnapshot(false); setTickets([]);
    setProgress(20); setProgressStage("loading"); setProgressMsg("Loading snapshot…");
    try {
      const res = await fetch(`${SERVER}/api/load-snapshot?date=${snapDate}`);
      if (!res.ok) { const e = await res.json().catch(()=>({})); throw new Error(e.error||res.statusText); }
      const json = await res.json(), data = Array.isArray(json.data) ? json.data : [];
      setFixtures(data); setDate(snapDate); setCached(true); setFrozenFixtures(data);
      startAutoRefresh(snapDate);
      if (json.legacySchema) setLegacySnapshot(true);
      setProgress(100); setProgressStage("done"); setProgressMsg(`${data.length} fixtures loaded`);

      // C7-FIX: ensure historicalRates is loaded for past dates — Engine tab count
      // was 0 on all past dates because buildUniversalPool received null rates.
      // backtest-summary is date-agnostic so this is safe to call for any date.
      if (!historicalRates) ensureHistoricalRates();

      // Auto-merge saved results for past dates — the results file already has
      // scores and outcomes from when the results loop ran that day.
      // No need to wait for the user to trigger anything.
      const isToday = snapDate === todayStr();
      if (!isToday) {
        try {
          const rRes = await fetch(`${SERVER}/api/load-results?date=${snapDate}`);
          if (rRes.ok) {
            const rJson = await rRes.json();
            const rData = rJson.results || rJson.data || [];
            if (Array.isArray(rData) && rData.length) {
              // Merge scores/state/results into fixtures from the snapshot
              setFixtures(prev => {
                if (!prev.length) return prev;
                const rMap = new Map(rData.map(r => [r.id, r]));
                return prev.map(f => {
                  const r = rMap.get(f.id);
                  if (!r) return f;
                  return {
                    ...f,
                    hGoals:     r.hGoals,
                    aGoals:     r.aGoals,
                    state:      r.finished ? "finished" : f.state,
                    finished:   r.finished,
                    result:     r.result,
                    readResult: r.readResult,
                    edgeResult: r.edgeResult,
                    strategyResults: r.strategyResults,
                  };
                });
              });
              setLastResultsRefresh(new Date().toLocaleTimeString([], { hour:"2-digit", minute:"2-digit" }));
            }
          }
        } catch {} // silently ignore — results file may not exist for this date
      }
      // P-FIX: report success so callers (e.g. the GRM shared-ticket flow) know
      // the fetch actually worked, instead of assuming silently.
      return true;
    } catch(e) { setError(friendlyError(e, "GRM Pro")); return false; }
    finally { setLoading(false); }
  }, []);

  const ensureHistoricalRates = async () => {
    // C7-FIX: previous guard `historicalRatesDateRef.current === today` caused
    // ensureHistoricalRates to return null for past dates — today's rates had
    // been cached against today's date string, so any other date was a miss.
    // backtest-summary is date-agnostic (it's the model's historical hit rates,
    // not tied to today's fixtures), so we cache it once per session regardless
    // of which date the user is viewing.
    if (historicalRates) return historicalRates;
    try {
      const res = await fetch(`${SERVER}/api/backtest-summary`);
      const data = await res.json();
      setHistoricalRates(data);
      historicalRatesDateRef.current = todayStr(); // mark as loaded
      return data;
    } catch { return null; }
  };

  // ── Unified live + results ticker ────────────────────────────────────────
  // Single 60s interval replacing the former two separate intervals
  // (pollLiveStates + startResultsRefresh). Fires pollLiveStates which now
  // handles both live state patches AND results merging in one tick.
  const [lastResultsRefresh, setLastResultsRefresh] = useState(null);

  const mergeResultsIntoFixtures = useCallback((freshData) => {
    if (!Array.isArray(freshData) || !freshData.length) return;

    // Live states the live-poller owns — results file must never overwrite these.
    // The results file only knows finished outcomes; it has no in-progress data.
    // Overwriting a live state with a blank/stale state from the results file was
    // the root cause of: FT badge missing, LIVE badge missing, every game looking
    // "normal", FT/PPD/SUSP guards never firing, upcoming filter doing nothing.
    const LIVE_STATES = new Set([
      "inprogress","live","1h","firsthalf","ht","halftime",
      "2h","secondhalf","et","extratime","pen","penalties","pause","break",
    ]);
    const FT_STATES = new Set([
      "finished","ft","fulltime","ended","complete","aet","afterextratime","afterpenalties",
    ]);

    setFixtures(prev => {
      if (!prev.length) return prev;
      const freshMap = new Map(freshData.map(f => [f.id, f]));
      let changed = false;
      const next = prev.map(f => {
        const fresh = freshMap.get(f.id);
        if (!fresh) return f;

        const curState = (f.state || "").toLowerCase().replace(/[\s_\-]/g, "");

        // If the live poller has already set this fixture to a live state,
        // results data must not touch state or finished — only update outcomes.
        if (LIVE_STATES.has(curState)) {
          const outcomeChanged = fresh.result !== f.result || fresh.readResult !== f.readResult || fresh.edgeResult !== f.edgeResult;
          if (!outcomeChanged) return f;
          changed = true;
          return { ...f, result: fresh.result, readResult: fresh.readResult, edgeResult: fresh.edgeResult };
        }

        // For already-finished fixtures (set by live poller), trust live poller's
        // state but allow scores/outcomes to update from results file.
        if (FT_STATES.has(curState)) {
          const scoresChanged = fresh.hGoals !== f.hGoals || fresh.aGoals !== f.aGoals
            || fresh.result !== f.result || fresh.readResult !== f.readResult || fresh.edgeResult !== f.edgeResult;
          if (!scoresChanged) return f;
          changed = true;
          return { ...f, hGoals: fresh.hGoals, aGoals: fresh.aGoals, result: fresh.result, readResult: fresh.readResult, edgeResult: fresh.edgeResult, strategyResults: fresh.strategyResults };
        }

        // Fixture is notstarted/upcoming — results file saying finished=true is
        // authoritative (server wrote the outcome). Apply full update.
        if (!fresh.finished) return f; // results file has no outcome yet — skip
        const scoreChanged = fresh.hGoals !== f.hGoals || fresh.aGoals !== f.aGoals || fresh.state !== f.state;
        if (!scoreChanged && fresh.result === f.result) return f;
        changed = true;
        return {
          ...f,
          hGoals:          fresh.hGoals,
          aGoals:          fresh.aGoals,
          state:           "finished", // only set finished, never a blank/stale state
          finished:        true,
          result:          fresh.result,
          readResult:      fresh.readResult,
          edgeResult:      fresh.edgeResult,
          strategyResults: fresh.strategyResults,
        };
      });
      return changed ? next : prev;
    });
    setLastResultsRefresh(new Date().toLocaleTimeString([], { hour:"2-digit", minute:"2-digit" }));
  }, []);

  // ── Live states ticker — polls /api/live-states every 45s ────────────────
  // When server is 403'd by SofaScore, data.states is empty and the display goes stale.
  // Time-based fallback: estimate state from startTimestamp + elapsed wall-clock time.
  // Not perfectly accurate (no actual score) but keeps the UI honest about game status.
  const inferStateFromTime = useCallback((f) => {
    // If results were injected server-side and flagged as finished, trust that
    if (f.finished === true) return { state: "finished", stateNorm: "finished", isLive: false, isDone: true, minute: 90 };
    const ts = f.startTimestamp;
    if (!ts) return null;
    const kickoffMs  = ts * 1000;
    const nowMs      = Date.now();
    const elapsedMin = (nowMs - kickoffMs) / 60_000;
    const curState   = (f.state || "").toLowerCase();
    // Don't override states that are already live/finished from server data
    if (["finished","ft","fulltime","ended","aet","afterextratime"].includes(curState)) return null;
    if (elapsedMin < 0) return null; // hasn't kicked off yet
    if (elapsedMin > 105) return { state: "finished", stateNorm: "finished", isLive: false, isDone: true, minute: 90 };
    if (elapsedMin > 47 && elapsedMin < 60) return { state: "halftime", stateNorm: "halftime", isLive: true, isDone: false, minute: 45 };
    if (elapsedMin >= 0) return { state: "inprogress", stateNorm: "inprogress", isLive: true, isDone: false, minute: Math.min(Math.floor(elapsedMin), 90) };
    return null;
  }, []);

  const liveTickerRef = useRef(null);

  // ── Auto-refresh: detects when results.json has updated and re-fetches ──
  // Problem: when the results loop writes new scores, fixture cards stay stale
  // until the user manually refreshes the browser.
  //
  // Strategy:
  //   1. Poll /api/results-mtime every 90s — just a stat() call, no file read.
  //   2. If mtime advances past what we last saw, call fetchData(false) silently.
  //   3. Only fires for today's date; past dates never change.
  //   4. Skips if already loading or the tab is hidden.
  const resultsMtimeRef  = useRef(null); // last known mtime of results.json
  const autoRefreshRef   = useRef(null);

  const startAutoRefresh = useCallback((forDate) => {
    if (autoRefreshRef.current) clearInterval(autoRefreshRef.current);
    autoRefreshRef.current = setInterval(async () => {
      if (forDate !== todayStr()) return;
      if (loadingRef.current) return; // use ref — never stale
      if (document.hidden) return;
      try {
        const r = await fetch(`${SERVER}/api/results-mtime?date=${forDate}`, { signal: AbortSignal.timeout(8000) });
        if (!r.ok) return;
        const d = await r.json();
        if (!d.exists || !d.mtime) return;
        if (resultsMtimeRef.current === null) { resultsMtimeRef.current = d.mtime; return; }
        if (d.mtime > resultsMtimeRef.current) {
          resultsMtimeRef.current = d.mtime;
          fetchData(false);
        }
      } catch { /* network blip — ignore */ }
    }, 90_000);
  }, [SERVER]); // loading removed from deps — loadingRef.current is always fresh

  const stopAutoRefresh = useCallback(() => {
    if (autoRefreshRef.current) { clearInterval(autoRefreshRef.current); autoRefreshRef.current = null; }
  }, []);
  const pollLiveStates = useCallback(async (d) => {
    if (!d) return;
    try {
      const res  = await fetch(`${SERVER}/api/live-states?date=${d}`);
      const data = await res.json();

      if (data.states?.length) {
        // Server has live data — apply patches AND fill in time-based state for
        // N6-FIX: fixtures not in patchMap were previously returned as-is,
        // preserving the cached "notstarted"/"18:00" state even when the match
        // had kicked off. Now we apply inferStateFromTime for every fixture
        // the server didn't explicitly patch.
        const patchMap = new Map(data.states.map(s => [s.id, s]));
        setFixtures(prev => prev.map(f => {
          const p = patchMap.get(f.id);
          if (p) {
            // Server patch — trust it fully
            if (p.state === f.state && p.hScore === f.scores?.hGoals && p.aScore === f.scores?.aGoals) return f;
            return {
              ...f,
              state:       p.state,
              stateNorm:   p.stateNorm,
              minute:      p.minute,
              isPPD:       p.isPPD,
              isCancelled: p.isCancelled,
              scores: { ...(f.scores||{}), hGoals: p.hScore ?? f.scores?.hGoals, aGoals: p.aScore ?? f.scores?.aGoals },
              hGoals: p.isDone ? (p.hScore ?? f.hGoals) : f.hGoals,
              aGoals: p.isDone ? (p.aScore ?? f.aGoals) : f.aGoals,
            };
          }
          // Not in server's patch — apply time-based inference so kickoffs show LIVE
          const inferred = inferStateFromTime(f);
          if (!inferred || inferred.state === f.state) return f;
          return { ...f, ...inferred };
        }));
        if (data.liveCount > 0) setLastResultsRefresh(new Date().toLocaleTimeString([],{hour:"2-digit",minute:"2-digit"}));
      } else {
        // Server has no data (backing off 403) — apply time-based fallback to all
        setFixtures(prev => prev.map(f => {
          const inferred = inferStateFromTime(f);
          if (!inferred) return f;
          if (inferred.state === f.state) return f;
          return { ...f, ...inferred };
        }));
      }
    } catch {
      // Network failure — still apply time-based fallback so UI stays honest
      setFixtures(prev => prev.map(f => {
        const inferred = inferStateFromTime(f);
        if (!inferred) return f;
        if (inferred.state === f.state) return f;
        return { ...f, ...inferred };
      }));
    }

    // ── Merged results refresh — same tick, no second interval ──────────────
    // Previously a separate 60s setInterval (startResultsRefresh) hit /api/load-results
    // independently. Two intervals at the same cadence = two setFixtures calls per minute
    // and double the network traffic. Merged here so there is exactly one polling loop.
    if (d === todayStr()) {
      try {
        const rRes = await fetch(`${SERVER}/api/load-results?date=${d}`);
        if (rRes.ok) {
          const rJson = await rRes.json();
          const rData = rJson.results || rJson.data || [];
          if (Array.isArray(rData) && rData.length) mergeResultsIntoFixtures(rData);
        }
      } catch {}
    }
  }, [inferStateFromTime, mergeResultsIntoFixtures]);

  useEffect(() => {
    if (!fixtures.length || activeTab !== "live") return;
    // N6-FIX: fire immediately so cached fixtures get their live state updated
    // without waiting for the first 60s tick. Previously a cached "notstarted"
    // fixture would sit showing the kickoff time for up to 60s after mount.
    pollLiveStates(date);
    // 30s interval (was 60s) — improves responsiveness for live-match updates.
    liveTickerRef.current = setInterval(() => pollLiveStates(date), 30_000);
    return () => { if (liveTickerRef.current) clearInterval(liveTickerRef.current); };
  }, [fixtures.length > 0, date, activeTab]);

  // Tab counts
  const counts = useMemo(() => ({
    total:    fixtures.length,
    read:     fixtures.filter(f => f.theRead && !f.theRead.isFallback).length,
    edge:     fixtures.filter(f => !!f.theEdge).length,
    radar:    fixtures.filter(f => !!f.goalRadar).length,
  }), [fixtures]);

  // Build league list with country disambiguation.
  // leagueId is the filter key — avoids "Premier League" collision across countries.
  const availableLeagues = useMemo(() => {
    const seen = new Map(); // leagueId → { league, country, leagueId, leagueRank }
    for (const f of fixtures) {
      if (!seen.has(f.leagueId)) {
        seen.set(f.leagueId, {
          league: f.league,
          country: f.country || "",
          leagueId: f.leagueId,
          leagueRank: f.leagueRank ?? (LEAGUE_RANK[f.league] ?? 999),
        });
      }
    }
    return [...seen.values()].sort((a, b) => a.leagueRank - b.leagueRank);
  }, [fixtures]);

  // enginePool is built from frozenFixtures — the snapshot taken at fetch time.
  // Do NOT include live `fixtures` in deps: it would rebuild the entire pool on
  // every 60s poll tick (live state patches), which is expensive and wrong —
  // the pool should reflect what the model scored at fetch time, not live states.
  const enginePool = useMemo(() => {
    const src = frozenFixtures.length ? frozenFixtures : fixtures;
    return buildUniversalPool(src, historicalRates || {});
  }, [frozenFixtures, historicalRates]);

  const engineFixtureIds = useMemo(() => new Set(enginePool.map(e => e.fixtureId)), [enginePool]);

  // J1-FIX: These must live here (unconditional) — NOT inline in the jarvisOpen portal JSX.
  // Calling useMemo() inside a conditional render violates Rules of Hooks and causes
  // "Rendered more hooks than during the previous render" crash when the FAB is tapped.
  const jarvisEngineFixtureIds = useMemo(
    () => fixtures.filter(f => f.theRead?.anchor && !f.theRead?.isFallback).map(f => f.id),
    [fixtures]
  );
  const jarvisCustomFixtureIds = useMemo(
    () => fixtures.filter(f => f._custom).map(f => f.id),
    [fixtures]
  );

  const TABS = [
    { id:"all",    label:`All (${counts.total})` },
    { id:"engine", label:`The Engine (${enginePool.length})`, color:C.gold },
    { id:"custom", label:"Custom",                           color:C.text },
  ];

  const filtered = useMemo(() => {
    if (tab === "custom") {
      // N9-FIX: search + leagueFilter applied.
      // FIX2: strong_first / strong_only from sortActive now also applied here.
      // CustomListView receives a pre-filtered list; its internal strategy controls
      // operate on whatever survives these global filters.
      let list = [...fixtures];
      if (search) {
        const s = search.toLowerCase();
        list = list.filter(f => f.teams.home.toLowerCase().includes(s) || f.teams.away.toLowerCase().includes(s) || (f.league || "").toLowerCase().includes(s));
      }
      if (leagueFilter) {
        const lf = leagueFilter instanceof Set ? leagueFilter : new Set([leagueFilter]);
        list = list.filter(f => lf.has(f.leagueId));
      }
      if (sortActive.has("strong_only")) list = list.filter(f => f.theRead?.anchor?.strong === true && !f.markets?._lowConfidence);
      if (sortActive.has("strong_first")) list = [...list].sort((a, b) => {
        const aS = (a.theRead?.anchor?.strong && !a.markets?._lowConfidence) ? 1 : 0;
        const bS = (b.theRead?.anchor?.strong && !b.markets?._lowConfidence) ? 1 : 0;
        return bS - aS;
      });
      return list;
    }
    if (tab === "engine") {
      // Pool membership comes from frozenFixtures — live fixtures used only for display
      let list = fixtures.filter(f => engineFixtureIds.has(f.id));
      if (search) {
        const s = search.toLowerCase();
        list = list.filter(f => f.teams.home.toLowerCase().includes(s) || f.teams.away.toLowerCase().includes(s) || (f.league||"").toLowerCase().includes(s));
      }
      if (leagueFilter) {
        const lf = leagueFilter instanceof Set ? leagueFilter : new Set([leagueFilter]);
        list = list.filter(f => lf.has(f.leagueId));
      }
      // All sortActive filters apply to engine tab too
      if (sortActive.has("strong_only")) list = list.filter(f => f.theRead?.anchor?.strong === true && !f.markets?._lowConfidence);
      if (sortActive.has("hq_data"))    list = list.filter(f => (f.markets?._calibrationWeight ?? 0) >= 50);
      if (sortActive.has("ltd_data"))   list = list.filter(f => (f.markets?._calibrationWeight ?? 100) < 25);
      // FIX: "upcoming" must SORT only — never filter. The hard .filter() was removing
      // FT/live/PPD fixtures entirely, wiping their state badges and disabling all guards
      // (isFinished/isPPD), so every game showed "Add to ticket". getStateGroup handles order.
      return list.sort((a, b) => {
        if (sortActive.has("conf")) {
          const ca = a.theRead?.anchor?.prob ?? 0, cb = b.theRead?.anchor?.prob ?? 0;
          if (ca !== cb) return cb - ca;
        }
        if (sortActive.has("strong_first") || sortActive.has("strong_only")) {
          const aS = (a.theRead?.anchor?.strong && !a.markets?._lowConfidence) ? 1 : 0;
          const bS = (b.theRead?.anchor?.strong && !b.markets?._lowConfidence) ? 1 : 0;
          if (aS !== bS) return bS - aS;
        }
        // Default: engine score descending
        const sa = enginePool.find(e => e.fixtureId === a.id)?.score || 0;
        const sb = enginePool.find(e => e.fixtureId === b.id)?.score || 0;
        return sb - sa;
      });
    }
    let list = [...fixtures];
    if (search) { const s = search.toLowerCase(); list = list.filter(f => f.teams.home.toLowerCase().includes(s) || f.teams.away.toLowerCase().includes(s) || (f.league||"").toLowerCase().includes(s)); }
    if (leagueFilter) { const lf = leagueFilter instanceof Set ? leagueFilter : new Set([leagueFilter]); list = list.filter(f => lf.has(f.leagueId)); }
    if (sortActive.has("strong_only")) list = list.filter(f => f.theRead?.anchor?.strong === true && !f.markets?._lowConfidence);
    if (sortActive.has("hq_data"))    list = list.filter(f => (f.markets?._calibrationWeight ?? 0) >= 50);
    if (sortActive.has("ltd_data"))   list = list.filter(f => (f.markets?._calibrationWeight ?? 100) < 25);

    list = [...list].sort((a, b) => {
      // Upcoming sort: not started (0) → live (1) → FT (2)
      if (sortActive.has("upcoming")) {
        const ga = getStateGroup(a), gb = getStateGroup(b);
        if (ga !== gb) return ga - gb;
      }
      // Conf sort
      if (sortActive.has("conf")) {
        const ca = a.theRead?.anchor?.prob ?? 0;
        const cb = b.theRead?.anchor?.prob ?? 0;
        if (ca !== cb) return cb - ca;
      }
      // Strong first
      if (sortActive.has("strong_first") || sortActive.has("strong_only")) {
        const aS = (a.theRead?.anchor?.strong && !a.markets?._lowConfidence) ? 1 : 0;
        const bS = (b.theRead?.anchor?.strong && !b.markets?._lowConfidence) ? 1 : 0;
        if (aS !== bS) return bS - aS;
      }
      // Default: league rank → kick-off
      const ra = a.leagueRank ?? (LEAGUE_RANK[a.league] ?? 999);
      const rb = b.leagueRank ?? (LEAGUE_RANK[b.league] ?? 999);
      if (ra !== rb) return ra - rb;
      return (a.startingAt || "").localeCompare(b.startingAt || "");
    });
    return list;
  }, [fixtures, frozenFixtures, tab, search, leagueFilter, sortActive, enginePool, engineFixtureIds]);

  const isDesktop = useIsDesktop();

  return (
    <div style={{ minHeight:"100vh", background:C.bg, fontFamily:C.font }}>

      {/* ── DESKTOP SIDEBAR ─────────────────────────────────────────────── */}
      <SidebarNav
        activeTab={mainView === "rollover" ? "rollover" : activeTab}
        setActiveTab={(tab) => {
          setParlayJarvisOpen(false);
          if (tab === "rollover") { setMainView("rollover"); }
          else { setMainView("main"); setActiveTab(tab); }
        }}
        onParleyOpen={() => setParlayJarvisOpen(true)}
        draftCount={draftLegs.length}
        parleyOpen={parlayJarvisOpen}
      />

      {/* ── CONTENT SHELL — shifts right on desktop ──────────────────── */}
      <div className="grm-desktop-shell" style={{
        paddingBottom: isDesktop ? 40 : 120,
        paddingTop: 108,
      }}>

      {/* ── HEADER — 3-level premium shell ───────────────────────────── */}
      <div className="grm-header">

        {/* Row 1 — Brand + primary action */}
        <div className="grm-header-top">
          <div style={{ display:"flex",alignItems:"center",gap:8 }}>
            <div className="grm-wordmark">
              GRM<span className="grm-wordmark-accent">PRO</span>
              <span className="grm-wordmark-meta">v15</span>
            </div>
            {/* N16-FIX: Status indicators — cached badge shows amber tint when data may be stale.
                 Stale = cachedAt timestamp is within 5 min of current time (user likely needs fresh data).
                 Shows a tap-to-refresh nudge instead of silent grey badge. */}
            {cached && (() => {
              const ageMs   = cachedAt ? (Date.now() - cachedAt) : null;
              // P22-FIX: stale = older than 8 min (prev logic was inverted — fired when fresh, not stale)
              const isStale = ageMs !== null && ageMs > 8 * 60 * 1000;
              const ageText = ageMs !== null
                ? (ageMs < 60000 ? `${Math.round(ageMs/1000)}s ago`
                  : ageMs < 3600000 ? `${Math.round(ageMs/60000)}m ago`
                  : `${Math.round(ageMs/3600000)}h ago`)
                : null;
              return (
                <button onClick={() => fetchData(false)}
                  title={isStale ? "Data may be outdated — tap to refresh" : "Tap to refresh"}
                  style={{ background: isStale ? `${C.amber}18` : `${C.muted}10`,
                           border:`1px solid ${isStale ? C.amber+"50" : C.border}`,
                           borderRadius:6, padding:"3px 9px", cursor:"pointer",
                           fontFamily:C.font, display:"flex", alignItems:"center", gap:5 }}>
                  <svg width="9" height="9" viewBox="0 0 24 24" fill="none"
                    stroke={isStale ? C.amber : C.muted} strokeWidth="2.5"
                    strokeLinecap="round" strokeLinejoin="round">
                    <path d="M23 4v6h-6"/><path d="M1 20v-6h6"/>
                    <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>
                  </svg>
                  <span style={{ fontSize:8, fontWeight:isStale?700:400,
                                 color:isStale?C.amber:C.muted }}>
                    {isStale ? "Tap to refresh" : `cached${ageText ? ` · ${ageText}` : ""}`}
                  </span>
                </button>
              );
            })()}
            {lastResultsRefresh && (
              <span title="Results auto-update when new scores are detected — no need to re-fetch"
                style={{ fontSize:9,color:C.green,fontWeight:700,cursor:"default",display:"flex",alignItems:"center",gap:3 }}>
                <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M23 4v6h-6"/><path d="M1 20v-6h6"/>
                  <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>
                </svg>
                {lastResultsRefresh}
              </span>
            )}
          </div>

          {activeTab === "live" && (
            <div style={{ display:"flex",gap:8,alignItems:"center" }}>
              <input type="date" value={date} onChange={e => { if (!loading) setDate(e.target.value); }} className="gi"
                style={{ color:C.accent,width:136,fontSize:11,padding:"7px 11px",flexShrink:0,
                         opacity: loading ? 0.5 : 1, pointerEvents: loading ? "none" : "auto" }}/>
              {/* Show progress% inline on the button so user knows it's running.
                  disabled + pointerEvents:none blocks rapid re-taps that were
                  causing session drift (each tap polled a new unknown session id). */}
              <button onClick={() => fetchData(false)} disabled={loading} className="gb-primary"
                style={{ padding:"8px 20px",fontSize:12,flexShrink:0,minWidth:80,
                         pointerEvents: loading ? "none" : "auto",
                         opacity: loading ? 0.75 : 1 }}>
                {loading
                  ? <span style={{ fontVariantNumeric:"tabular-nums" }}>{progress > 0 ? `${progress}%` : "…"}</span>
                  : "FETCH"}
              </button>
            </div>
          )}
        </div>

        {/* Legacy snapshot warning */}
        {legacySnapshot && (
          <div style={{ background:`${C.gold}10`,borderBottom:`1px solid ${C.gold}25`,padding:"8px 18px",display:"flex",alignItems:"center",gap:10 }}>
            <span style={{ fontSize:14, color:C.amber }}>!</span>
            <span style={{ fontSize:11,color:C.gold,flex:1,fontWeight:600 }}>
              Older snapshot — re-fetch to update picks.
            </span>
            <button onClick={() => fetchData(true)} className="gb-primary"
              style={{ fontSize:10,padding:"5px 14px",background:C.accent,color:C.accentText,flexShrink:0 }}>
              Re-fetch
            </button>
          </div>
        )}

        {/* Row 2 — Tools sub-tabs */}
        {(activeTab === "backtest" || activeTab === "code") && mainView === "main" && (
          <div style={{ padding:"6px 12px 2px", borderTop:`1px solid var(--glass-border)` }}>
            <div style={{ display:"flex", background:C.faint, borderRadius:10, padding:3, gap:3 }}>
            {[
              { id:"code",     label:"Code Analyzer", icon:
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/>
                </svg>
              },
              { id:"backtest", label:"Backtest", icon:
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>
                </svg>
              },
            ].map(({ id, label, icon }) => {
              const on = activeTab === id;
              return (
                <button key={id} onClick={() => setActiveTab(id)} style={{
                  flex:1, display:"flex", alignItems:"center", justifyContent:"center", gap:6,
                  padding:"9px 0", fontSize:11, fontWeight:800, fontFamily:C.font,
                  background: on ? C.surface      : "transparent",
                  color:      on ? C.accent        : C.muted,
                  border:     on ? `1px solid ${C.accent}40` : `1px solid ${C.border}`,
                  borderRadius:8,
                  boxShadow:  on ? "0 1px 6px rgba(0,0,0,0.22)" : "none",
                  cursor:"pointer", transition:"all .15s",
                  WebkitTapHighlightColor:"transparent",
                }}>
                  <span style={{ color: on ? C.accent : C.muted, display:"flex", opacity: on ? 1 : 0.6 }}>{icon}</span>
                  {label}
                </button>
              );
            })}
            </div>
          </div>
        )}

        {/* Row 2 — Fixture filter tabs (no search here) */}
        {activeTab === "live" && mainView === "main" && fixtures.length > 0 && (
          <>
            <div className="grm-header-subnav">
              {TABS.map(t => (
                <button key={t.id}
                  onClick={() => setTab(t.id)}
                  className={`grm-pill${tab===t.id?" active grm-pill-accent":""}`}>
                  {t.label}
                </button>
              ))}
            </div>

            {/* Row 3 — Search + Filter utility strip */}
            <div className="grm-header-util">
              {/* N14a-FIX: Search input with X clear button — appears only when field has content */}
              <div style={{ flex:1, position:"relative", display:"flex", alignItems:"center" }}>
                <input type="text" placeholder="Search teams or leagues…" value={search}
                  onChange={e=>setSearch(e.target.value)} className="gi"
                  style={{ width:"100%", fontSize:11, paddingRight: search ? 28 : undefined }}/>
                {search && (
                  <button onClick={() => setSearch("")}
                    style={{ position:"absolute", right:8, background:"none", border:"none",
                             cursor:"pointer", color:C.muted, padding:0, display:"flex",
                             alignItems:"center", lineHeight:1 }}
                    title="Clear search">
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                      strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                      <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
                    </svg>
                  </button>
                )}
              </div>
              <button onClick={() => setDrawerOpen(true)}
                className="grm-pill"
                style={{
                  flexShrink:0,
                  background:(leagueFilter||sortActive.size>0)?C.accentDim:"transparent",
                  borderColor:(leagueFilter||sortActive.size>0)?C.accentBorder:"transparent",
                  color:(leagueFilter||sortActive.size>0)?C.accent:C.muted,
                  border:"1px solid",
                }}>
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="4" y1="6" x2="20" y2="6"/><line x1="8" y1="12" x2="16" y2="12"/><line x1="11" y1="18" x2="13" y2="18"/>
                </svg>
                Filters
                {(leagueFilter||sortActive.size>0) && (
                  <span style={{ background:C.accent,color:C.accentText,borderRadius:8,fontSize:8,fontWeight:900,padding:"1px 5px",lineHeight:1.4 }}>
                    {(leagueFilter?1:0)+sortActive.size}
                  </span>
                )}
              </button>
            </div>
          </>
        )}

      </div>
      {/* ── END STICKY BLOCK ─────────────────────────────────────────────── */}

      {/* ── RIGHT-SIDE FILTER DRAWER ─────────────────────────────────────── */}
      {drawerOpen && (
        <div style={{ position:"fixed",inset:0,zIndex:200 }} onClick={() => setDrawerOpen(false)}>
          <div onClick={e => e.stopPropagation()} style={{
            position:"absolute",top:0,right:0,height:"100%",width:280,
            background:C.modalBg,borderLeft:`1px solid ${C.border}`,
            overflowY:"auto",display:"flex",flexDirection:"column",
          }}>
            {/* Header */}
            <div style={{ padding:"16px 18px 14px",borderBottom:`1px solid ${C.border}`,
              display:"flex",justifyContent:"space-between",alignItems:"center",
              position:"sticky",top:0,background:C.modalBg,zIndex:1 }}>
              <div>
                <div style={{ fontSize:13,fontWeight:800,color:C.text,letterSpacing:".04em" }}>Filters</div>
                {(leagueFilter || sortActive.size > 0) && (
                  <div style={{ fontSize:8,color:C.accent,marginTop:2 }}>
                    {(leagueFilter ? 1 : 0) + sortActive.size} active
                  </div>
                )}
              </div>
              <button onClick={() => setDrawerOpen(false)}
                style={{ background:"transparent",border:"none",color:C.muted,cursor:"pointer",
                         padding:4,display:"flex",alignItems:"center" }}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                  strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
                </svg>
              </button>
            </div>

            <div style={{ padding:"18px 18px 32px", display:"flex", flexDirection:"column", gap:24 }}>

              {/* League Filter */}
              {availableLeagues.length > 1 && (
                <div>
                  <div style={{ fontSize:7,fontWeight:800,color:C.muted,textTransform:"uppercase",
                    letterSpacing:".14em",marginBottom:10 }}>League</div>
                  <LeagueFilter availableLeagues={availableLeagues} leagueFilter={leagueFilter} setLeagueFilter={setLeagueFilter} />
                </div>
              )}

              {/* Sort & Filter */}
              <div>
                <div style={{ fontSize:7,fontWeight:800,color:C.muted,textTransform:"uppercase",
                  letterSpacing:".14em",marginBottom:10 }}>Sort & Filter</div>
                <SortFilter active={sortActive} setActive={setSortActive} />
              </div>

              {/* Divider */}
              <div style={{ height:1,background:C.border }} />

              {/* Appearance */}
              <div>
                <div style={{ fontSize:7,fontWeight:800,color:C.muted,textTransform:"uppercase",
                  letterSpacing:".14em",marginBottom:10 }}>Appearance</div>
                <button onClick={() => { setThemePickerOpen(true); setDrawerOpen(false); }}
                  style={{ width:"100%",padding:"11px 14px",borderRadius:10,cursor:"pointer",
                           background:C.surface,border:`1px solid ${C.border}`,
                           fontFamily:C.font,display:"flex",alignItems:"center",gap:10,
                           transition:"background .12s" }}
                  onMouseEnter={e => e.currentTarget.style.background = C.faint}
                  onMouseLeave={e => e.currentTarget.style.background = C.surface}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={C.accent}
                    strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="12" cy="12" r="3"/>
                    <path d="M12 1v4M12 19v4M4.22 4.22l2.83 2.83M16.95 16.95l2.83 2.83M1 12h4M19 12h4M4.22 19.78l2.83-2.83M16.95 7.05l2.83-2.83"/>
                  </svg>
                  <span style={{ fontSize:11,fontWeight:700,color:C.text,flex:1,textAlign:"left" }}>Change Theme</span>
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke={C.muted}
                    strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="9 18 15 12 9 6"/>
                  </svg>
                </button>
              </div>

              {/* Admin controls */}
              {adminMode && (
                <div>
                  <div style={{ fontSize:7,fontWeight:800,color:C.red,textTransform:"uppercase",
                    letterSpacing:".14em",marginBottom:10 }}>Admin</div>
                  <div style={{ display:"flex",flexDirection:"column",gap:6 }}>
                    <button onClick={() => { fetchData(true); setDrawerOpen(false); }} disabled={loading}
                      style={{ padding:"9px 14px",borderRadius:8,cursor:"pointer",fontFamily:C.font,
                               background:"transparent",border:`1px solid ${C.radar}40`,color:C.radar,
                               fontSize:10,fontWeight:700,display:"flex",alignItems:"center",gap:8 }}>
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                        strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                        <polyline points="1 4 1 10 7 10"/>
                        <path d="M3.51 15a9 9 0 1 0 .49-4"/>
                      </svg>
                      Force Refresh
                    </button>
                    {fixtures.length > 0 && (
                      <button onClick={async () => {
                        try {
                          const res = await fetch(`${SERVER}/api/refresh-odds?date=${date}`, { method:"POST", headers:{"x-admin-token": adminToken} });
                          const d = await res.json();
                          if (d.updated) { const r = await fetch(`${SERVER}/api/load-snapshot?date=${date}`); const j = await r.json(); if (j.data) { setFixtures(j.data); setLastResultsRefresh(new Date().toLocaleTimeString([],{hour:"2-digit",minute:"2-digit"})); } }
                          await fetchData(true);
                        } catch {}
                        setDrawerOpen(false);
                      }} style={{ padding:"9px 14px",borderRadius:8,cursor:"pointer",fontFamily:C.font,
                                  background:"transparent",border:`1px solid ${C.gold}40`,color:C.gold,
                                  fontSize:10,fontWeight:700,display:"flex",alignItems:"center",gap:8 }}>
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                          strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                          <line x1="12" y1="1" x2="12" y2="23"/>
                          <path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/>
                        </svg>
                        Refresh Odds
                      </button>
                    )}
                  </div>
                </div>
              )}

              {/* Divider */}
              <div style={{ height:1,background:C.border }} />

              {/* Admin lock + Help */}
              <div style={{ display:"flex",flexDirection:"column",gap:8 }}>
                <button onClick={() => { toggleAdmin(); setDrawerOpen(false); }}
                  style={{ padding:"9px 14px",borderRadius:8,cursor:"pointer",fontFamily:C.font,
                           background:adminMode?`${C.red}10`:"transparent",
                           border:`1px solid ${adminMode?C.red:C.border}`,
                           color:adminMode?C.red:C.muted,fontSize:10,fontWeight:700,
                           display:"flex",alignItems:"center",gap:8 }}>
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                    strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                    {adminMode
                      ? <><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 9.9-1"/></>
                      : <><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></>}
                  </svg>
                  {adminMode ? "Lock Admin" : "Admin"}
                </button>

                <button onClick={() => { setHelpOpen(true); setDrawerOpen(false); }}
                  style={{ padding:"11px 14px",borderRadius:10,cursor:"pointer",fontFamily:C.font,
                           background:C.accentDim,border:`1px solid ${C.accentBorder}`,
                           display:"flex",alignItems:"center",gap:10 }}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={C.accent}
                    strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="12" cy="12" r="10"/>
                    <line x1="12" y1="16" x2="12" y2="12"/>
                    <line x1="12" y1="8" x2="12.01" y2="8"/>
                  </svg>
                  <div style={{ flex:1, textAlign:"left" }}>
                    <div style={{ fontSize:11,fontWeight:800,color:C.accent }}>Learn how it works</div>
                    <div style={{ fontSize:8,color:C.accent,opacity:.6,marginTop:1 }}>Tap to open guide</div>
                  </div>
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke={C.accent}
                    strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ opacity:.5 }}>
                    <polyline points="9 18 15 12 9 6"/>
                  </svg>
                </button>
              </div>

            </div>
          </div>
        </div>
      )}

      {/* N34-FIX: BacktestTab kept mounted always — display:none when inactive.
          Conditional && unmounts on every tab switch, losing all sub-tab state and
          any results the user loaded. display:none preserves state with zero prop changes. */}
      <div style={{ display: activeTab === "backtest" && mainView === "main" ? undefined : "none", padding:"16px 14px" }}>
        <BacktestTab loadSnapshot={loadSnapshot} adminMode={adminMode} adminToken={adminToken} onReloadFixtures={async (d) => { if (d === date) { const r = await fetch(`${SERVER}/api/load-snapshot?date=${d}`); const j = await r.json(); if (j.data) { setFixtures(j.data); setLastResultsRefresh(new Date().toLocaleTimeString([],{hour:"2-digit",minute:"2-digit"})); } } }} />
      </div>

      {activeTab === "code" && mainView === "main" && (
        <div style={{ padding:"16px 14px" }}>
          <CodeAnalyzer theme={theme} SERVER={SERVER}
            initialCode={jarvisCodePayload?.code || null}
            initialPlatform={jarvisCodePayload?.platform || null}
            autoAnalyze={jarvisCodePayload?.autoAnalyze || false}
            onPayloadConsumed={() => setJarvisCodePayload(null)}
            onOpenFullModel={(fixture) => {
              setMainFocusFixture(fixture);
              setFullModelReturnTab("code");
            }}
            onSendToDraft={(legs, mode = "replace") => {
            const incoming = legs.map(l => ({
              game:      l.game || `${l.home} vs ${l.away}`,
              pick:      l.pick,
              odds:      l.odds || null,
              conf:      l.conf || l.modelConf || l.confidence || null,
              market:    l.market || "1X2",
              fixtureId: l.fixtureId || null,
              empiricalRate: l.empiricalRate || null,
              _fromCodeAnalyzer: true,
            }));
            // N13-FIX: mode "replace" clears builder first, "add" merges with existing.
            // Prior behaviour always merged regardless — user had no control.
            if (mode === "replace") {
              setDraftLegs(incoming);
            } else {
              // Merge: incoming legs replace any existing leg for the same fixtureId,
              // and are appended for fixtureIds not yet in the draft.
              setDraftLegs(prev => {
                const merged = [...prev];
                for (const leg of incoming) {
                  const idx = leg.fixtureId
                    ? merged.findIndex(l => l.fixtureId === leg.fixtureId)
                    : -1;
                  if (idx >= 0) merged[idx] = leg;
                  else merged.push(leg);
                }
                return merged;
              });
            }
            setParlayJarvisOpen(true);
          }} />
        </div>
      )}

      {/* N34-FIX: PoolPerformanceTab kept mounted always — display:none when inactive.
          Without this, every nav away triggers a fresh API fetch on return and the
          selected day-range, scroll position, and accordion open state are lost. */}
      <div style={{ display: activeTab === "perf" && mainView === "main" ? undefined : "none" }}>
        <PoolPerformanceTab serverUrl={SERVER} />
      </div>

      {/* N1-FIX: RolloverSystem always mounted at GRMPro level — same pattern as
          PoolPerformanceTab (N34-FIX). display:none when inactive so slip
          preloads in background. Props stay at GRMPro scope where they belong.
          #3-FIX: themeId key forces React to re-render children when theme
          changes so the dashboard hero doesn't show a stale white box. */}
      <div key={`rollover-${theme?.id}`} style={{ display: mainView === "rollover" ? undefined : "none" }}>
        <RolloverSystem
          C={C}
          SERVER={SERVER}
          fixtures={fixtures}
          historicalRates={historicalRates}
          date={date}
          buildRolloverPick={buildRolloverPick}
          buildUniversalPool={buildUniversalPool}
          onFullModel={onFullModelFromRollover}
          onChainChange={handleChainChange}
        />
      </div>

      {activeTab === "live" && mainView === "main" && (
        <div style={{ maxWidth:1480,margin:"0 auto",padding:activeTab==="live"?"28px 16px 0":"28px 24px 0" }}>
          {error && <div style={{ background:C.redDim,border:"1px solid rgba(248,113,113,0.2)",borderRadius:10,padding:"12px 18px",marginBottom:24,fontSize:12,color:C.red }}>✕ {error}</div>}
          {!loading && !error && !fixtures.length && (
            <div style={{ textAlign:"center",padding:"80px 0",color:C.text,fontSize:11,letterSpacing:".18em",textTransform:"uppercase" }}>Select a date and press FETCH</div>
          )}

          {loading && (
            <div style={{ maxWidth:480,margin:"40px auto",padding:"0 20px" }}>
              {/* Spinner */}
              <div style={{ display:"flex",justifyContent:"center",marginBottom:20 }}>
                <div style={{ position:"relative",width:48,height:48 }}>
                  <div style={{ position:"absolute",inset:0,borderRadius:"50%",border:`3px solid ${C.subtleBg}` }}/>
                  <div style={{ position:"absolute",inset:0,borderRadius:"50%",border:"3px solid transparent",borderTopColor:C.accent,animation:"spinRing 0.9s linear infinite" }}/>
                </div>
              </div>
              {/* Stage + percent */}
              <div style={{ display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:10 }}>
                <span className="pu" style={{ fontSize:10,color:C.accent,fontWeight:800,letterSpacing:".12em",textTransform:"uppercase" }}>
                  {progressStage==="fixtures"?"Fetching Fixtures"
                    :progressStage==="standings"?"League Standings"
                    :progressStage==="stats"?"Team Stats"
                    :progressStage==="processing"?"Processing"
                    :progressStage==="saving"?"Saving"
                    :progressStage==="done"?"✓ Done"
                    :"Starting…"}
                </span>
                <span style={{ fontSize:14,fontWeight:800,color:progress<30?C.blue:progress<70?C.accent:progress<95?C.orange:C.green }}>{progress}%</span>
              </div>
              <div style={{ height:6,background:C.subtleBg,borderRadius:6,overflow:"hidden",marginBottom:6,position:"relative" }}>
                <div style={{ height:"100%",width:`${progress}%`,background:progress<30?C.blue:progress<70?C.accent:progress<95?C.orange:C.green,borderRadius:6,transition:"width 0.6s ease,background 0.4s ease",position:"relative" }}>
                  <div style={{ position:"absolute",inset:0,borderRadius:6,background:"linear-gradient(90deg,transparent,rgba(255,255,255,0.2),transparent)",animation:"shimmer 1.8s infinite" }}/>
                </div>
              </div>
              {/* Time estimate + stuck detection */}
              {(() => {
                const now        = Date.now();
                const elapsedMs  = fetchStartTimeRef.current ? now - fetchStartTimeRef.current : 0;
                const elapsedSec = elapsedMs / 1000;
                const stuckMs    = now - lastProgressRef.current.ts;
                const isStuck    = stuckMs > 90_000 && progress > 0 && progress < 98;
                // Estimate remaining based on elapsed / pct
                let etaStr = null;
                if (progress > 3 && progress < 98) {
                  const totalEstMs = (elapsedMs / progress) * 100;
                  const remainMs   = totalEstMs - elapsedMs;
                  const remainSec  = Math.round(remainMs / 1000);
                  if (remainSec >= 60) {
                    etaStr = `~${Math.ceil(remainSec/60)} min remaining`;
                  } else if (remainSec > 0) {
                    etaStr = `~${remainSec}s remaining`;
                  }
                } else if (progress <= 3 && elapsedSec > 5) {
                  etaStr = "Usually 3–5 min";
                }
                return (
                  <div style={{ display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:4 }}>
                    <span style={{ fontSize:8,color:C.muted }}>{etaStr || ""}</span>
                    {isStuck && (
                      <span style={{ fontSize:8,color:C.amber,fontWeight:700 }}>
                        ⚠ Taking longer than usual
                      </span>
                    )}
                  </div>
                );
              })()}
              <div style={{ fontSize:9,color:C.text,textAlign:"center",minHeight:16,lineHeight:1.5,marginBottom:24 }}>{progressMsg}</div>
              {/* Skeleton fixture cards */}
              {[1,2,3].map(i => (
                <div key={i} style={{ background:C.cardBg,border:`1px solid ${C.border}`,borderRadius:C.cardRadius||12,padding:"14px 16px",marginBottom:10,display:"flex",flexDirection:"column",gap:10 }}>
                  <div style={{ display:"flex",justifyContent:"space-between" }}>
                    <div style={{ width:80,height:8,borderRadius:4,background:C.skeleton,position:"relative",overflow:"hidden" }}>
                      <div style={{ position:"absolute",inset:0,background:`linear-gradient(90deg,transparent,${C.skeletonHi},transparent)`,animation:"shimmer 1.6s infinite" }}/>
                    </div>
                    <div style={{ width:32,height:8,borderRadius:4,background:C.skeleton }}/>
                  </div>
                  <div style={{ display:"flex",justifyContent:"space-between",alignItems:"center" }}>
                    <div style={{ width:"38%",height:12,borderRadius:5,background:C.skeleton,position:"relative",overflow:"hidden" }}>
                      <div style={{ position:"absolute",inset:0,background:`linear-gradient(90deg,transparent,${C.skeletonHi},transparent)`,animation:"shimmer 1.6s infinite" }}/>
                    </div>
                    <div style={{ width:28,height:12,borderRadius:5,background:C.skeleton }}/>
                    <div style={{ width:"38%",height:12,borderRadius:5,background:C.skeleton }}/>
                  </div>
                  <div style={{ display:"flex",gap:6 }}>
                    <div style={{ width:65,height:20,borderRadius:4,background:C.skeleton }}/>
                    <div style={{ width:55,height:20,borderRadius:4,background:C.skeleton }}/>
                  </div>
                  <div style={{ width:"100%",height:3,borderRadius:2,background:C.skeleton }}/>
                </div>
              ))}
            </div>
          )}

          {/* JarvisMindBox + fixture list */}
          {fixtures.length > 0 && (
            <>
              <JarvisMindBox fixtures={fixtures} date={date} backtestSummary={historicalRates} />

              {tab === "custom" ? (
                <>
                  {/* #6-FIX: active filter reminder strip — shows between toolbar and first card
                      so users don't forget why they're seeing fewer fixtures */}
                  {(leagueFilter && (leagueFilter instanceof Set ? leagueFilter.size > 0 : true)) && (() => {
                    const lf = leagueFilter instanceof Set ? leagueFilter : new Set([leagueFilter]);
                    const names = [...lf].map(id => {
                      const f2 = fixtures.find(f => f.leagueId === id);
                      return f2?.league || id;
                    }).filter(Boolean);
                    const label = names.length <= 2
                      ? names.join(" · ")
                      : `${names.slice(0,2).join(" · ")} +${names.length - 2} more`;
                    return (
                      <div style={{ margin:"6px 0 2px", padding:"7px 12px",
                                    background:`${C.accent}10`, border:`1px solid ${C.accent}25`,
                                    borderRadius:8, display:"flex", alignItems:"center",
                                    justifyContent:"space-between", gap:8 }}>
                        <span style={{ fontSize:9, color:C.accent, fontWeight:700 }}>
                          Filtering: {label} · {filtered.length} game{filtered.length !== 1 ? "s" : ""}
                        </span>
                        <button onClick={() => setLeagueFilter(null)}
                          style={{ fontSize:8, color:C.muted, background:"transparent",
                                   border:`1px solid ${C.border}`, borderRadius:5,
                                   padding:"2px 8px", cursor:"pointer", fontFamily:C.font }}>
                          Clear
                        </button>
                      </div>
                    );
                  })()}
                  {showCustomBanner && (
                    <CustomTabBanner onDismiss={() => {
                      setShowCustomBanner(false);
                      try { localStorage.setItem("grm_custom_onboarded_v1","1"); } catch {}
                    }} />
                  )}
                  <CustomListView
                    fixtures={filtered} search={search}
                    draftLegs={draftLegs} onAddToParlay={addLegToDraft}
                    onOpenFixture={id => { const f = fixtures.find(x => x.id === id); if (f) setMainFocusFixture(f); }}
                    onFullModel={fx => { try { sessionStorage.setItem("grm_scroll", String(window.scrollY)); } catch {} setMainFocusFixture(fx); }}
                    backtestSummary={historicalRates}
                    onAddToTicket={ticket => {
                      setDraftLegs(prev => {
                        const existingMap = new Map(prev.map(l => [l.fixtureId, l]));
                        const conflicts   = (ticket.legs||[]).filter(l =>
                          existingMap.has(l.fixtureId) && existingMap.get(l.fixtureId).pick !== l.pick
                        );
                        // Fix 8: surface conflicts so user can decide — store in state for banner
                        if (conflicts.length) {
                          setDraftConflicts(conflicts);
                          setPendingTicket(ticket);
                          return prev; // hold — don't add yet
                        }
                        const newLegs = (ticket.legs||[]).filter(l => !existingMap.has(l.fixtureId));
                        return [...prev, ...newLegs];
                      });
                      // Fix 7: do NOT auto-open Parley tab — DraftTicketBanner handles the nudge
                    }}
                  />
                </>
              ) : (
                <>
                  {/* #6-FIX: same filter strip for All/Engine tabs */}
                  {(leagueFilter && (leagueFilter instanceof Set ? leagueFilter.size > 0 : true)) && (() => {
                    const lf = leagueFilter instanceof Set ? leagueFilter : new Set([leagueFilter]);
                    const names = [...lf].map(id => { const f2 = fixtures.find(f => f.leagueId === id); return f2?.league || id; }).filter(Boolean);
                    const label = names.length <= 2 ? names.join(" · ") : `${names.slice(0,2).join(" · ")} +${names.length - 2} more`;
                    return (
                      <div style={{ margin:"6px 0 2px", padding:"7px 12px",
                                    background:`${C.accent}10`, border:`1px solid ${C.accent}25`,
                                    borderRadius:8, display:"flex", alignItems:"center",
                                    justifyContent:"space-between", gap:8 }}>
                        <span style={{ fontSize:9, color:C.accent, fontWeight:700 }}>
                          Filtering: {label} · {filtered.length} game{filtered.length !== 1 ? "s" : ""}
                        </span>
                        <button onClick={() => setLeagueFilter(null)}
                          style={{ fontSize:8, color:C.muted, background:"transparent",
                                   border:`1px solid ${C.border}`, borderRadius:5,
                                   padding:"2px 8px", cursor:"pointer", fontFamily:C.font }}>
                          Clear
                        </button>
                      </div>
                    );
                  })()}
                  <div className="grm-grid" style={{ display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(380px,1fr))",gap:14,paddingBottom:80 }}>
                    {filtered.map(f => (
                      <FixtureErrorBoundary key={f.id} fixtureId={f.id}>
                        <FixtureCard f={f} onAddToParlay={addLegToDraft} draftLegs={draftLegs} isEngineQualified={engineFixtureIds.has(f.id)}
                          onFullModel={(fx) => { try { sessionStorage.setItem("grm_scroll", String(window.scrollY)); } catch {} setMainFocusFixture(fx); }}
                          backtestSummary={historicalRates}
                          adminToken={adminToken}
                        />
                      </FixtureErrorBoundary>
                    ))}
                  </div>
                  {!filtered.length && (
                    <div style={{ textAlign:"center",padding:"60px 0",color:C.text,fontSize:11,textTransform:"uppercase",letterSpacing:".15em" }}>No matches found</div>
                  )}
                </>
              )}
            </>
          )}
        </div>
      )}

      {/* ── THEME PICKER ──────────────────────────────────────────────────── */}
      {themePickerOpen && (
        <div style={{ position:"fixed",inset:0,zIndex:700,background:"rgba(0,0,0,0.6)",display:"flex",alignItems:"flex-end",justifyContent:"center" }}
          onClick={() => setThemePickerOpen(false)}>
          <div className="gc-elevated"
            style={{ borderRadius:"var(--r-xl) var(--r-xl) 0 0",padding:"16px 16px 40px",width:"100%",maxWidth:480,fontFamily:"var(--font)" }}
            onClick={e => e.stopPropagation()}>
            {/* Drag handle */}
            <div style={{ width:36,height:4,borderRadius:2,background:"var(--muted)",opacity:.3,margin:"0 auto 18px" }}/>
            <div style={{ fontSize:11,fontWeight:800,color:"var(--text)",letterSpacing:".1em",textTransform:"uppercase",marginBottom:14,display:"flex",alignItems:"center",gap:7 }}>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="13.5" cy="6.5" r=".5" fill="currentColor"/><circle cx="17.5" cy="10.5" r=".5" fill="currentColor"/><circle cx="8.5" cy="7.5" r=".5" fill="currentColor"/><circle cx="6.5" cy="12.5" r=".5" fill="currentColor"/><path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.926 0 1.648-.746 1.648-1.688 0-.437-.18-.835-.437-1.125-.29-.289-.438-.652-.438-1.125a1.64 1.64 0 0 1 1.668-1.668h1.996c3.051 0 5.555-2.503 5.555-5.554C21.965 6.012 17.461 2 12 2z"/></svg>
              Choose Theme
            </div>
            <div style={{ display:"flex",flexDirection:"column",gap:7 }}>
              {THEMES.map(t => {
                const active = theme.id === t.id;
                return (
                  <button key={t.id} onClick={() => pickTheme(t)} style={{
                    display:"flex",alignItems:"center",gap:12,
                    background: active ? t.accentDim : t.cardBg,
                    border:`1px solid ${active ? t.accentBorder : t.border}`,
                    borderRadius:Math.min(t.cardRadius||12,18),
                    padding:"12px 14px",cursor:"pointer",textAlign:"left",
                    width:"100%",transition:"all .16s",fontFamily:"var(--font)",
                    boxShadow: active ? `0 0 0 2px ${t.accent}25, 0 2px 12px ${t.accent}15` : "none",
                  }}>
                    {/* Colour swatches */}
                    <div style={{ display:"flex",gap:4,flexShrink:0 }}>
                      {[t.bg,t.accent,t.green,t.radar,t.edge].map((clr,i) => (
                        <div key={i} style={{ width:12,height:12,borderRadius:"50%",background:clr,border:`1px solid ${t.border}`,flexShrink:0 }}/>
                      ))}
                    </div>
                    <div style={{ flex:1,minWidth:0 }}>
                      <div style={{ fontFamily:t.font,fontSize:12,fontWeight:800,color:t.text }}>{t.emoji} {t.name}</div>
                      <div style={{ fontFamily:'"JetBrains Mono",monospace',fontSize:8,color:t.muted,marginTop:2,letterSpacing:".04em",lineHeight:1.4 }}>{t.desc}</div>
                    </div>
                    {active && <span style={{ fontSize:14,color:t.accent,fontWeight:800,flexShrink:0 }}>✓</span>}
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {/* GRM Explainer Modal */}
      {helpOpen && <HelpModal onClose={() => setHelpOpen(false)} />}
      {adminPromptOpen && (
        <div style={{ position:"fixed",inset:0,zIndex:500,background:"rgba(0,0,0,0.65)",display:"flex",alignItems:"center",justifyContent:"center",padding:"0 20px" }}
          onClick={() => setAdminPromptOpen(false)}>
          <div className="gc-elevated"
            style={{ padding:"24px 22px",width:"100%",maxWidth:300 }}
            onClick={e => e.stopPropagation()}>
            <div style={{ fontSize:11,color:"var(--gold)",fontWeight:800,letterSpacing:".12em",textTransform:"uppercase",marginBottom:14,display:"flex",alignItems:"center",gap:7 }}>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
              Admin Token
            </div>
            <input type="password" value={adminTokenInput} onChange={e => setAdminTokenInput(e.target.value)}
              onKeyDown={e => e.key === "Enter" && submitAdminToken()}
              className="gi" placeholder="Enter token…" autoFocus
              style={{ marginBottom:12 }} />
            <div style={{ display:"flex",gap:8 }}>
              <button onClick={submitAdminToken} className="gb-primary"
                style={{ flex:1,padding:"10px 0",fontSize:11 }}>
                Confirm
              </button>
              <button onClick={() => setAdminPromptOpen(false)} className="gb-ghost"
                style={{ padding:"10px 16px",fontSize:11 }}>
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      <DraftTicketBanner draftLegs={draftLegs} onOpen={() => setParlayJarvisOpen(true)} onClear={() => setDraftLegs([])} />
      {/* N3-FIX: persistent correlation warning FAB — shows when draft has correlated legs */}
      {(() => {
        if (!draftLegs.length) return null;
        const leagueCounts = {}, matchCounts = {};
        draftLegs.forEach(l => {
          if (l.league) leagueCounts[l.league] = (leagueCounts[l.league]||0)+1;
          const mk = l.fixtureId || l.game;
          if (mk) matchCounts[mk] = (matchCounts[mk]||0)+1;
        });
        const hasMatch  = Object.values(matchCounts).some(c => c >= 2);
        const hasLeague = Object.values(leagueCounts).some(c => c >= 2);
        if (!hasMatch && !hasLeague) return null;
        return (
          <div style={{ position:"fixed", bottom:160, left:0, right:0, zIndex:199,
                        display:"flex", justifyContent:"center", pointerEvents:"none" }}>
            <div onClick={() => setParlayJarvisOpen(true)}
              style={{ pointerEvents:"all", background:`${C.amber}18`,
                       border:`1px solid ${C.amber}50`, borderRadius:12,
                       padding:"8px 16px", display:"flex", alignItems:"center", gap:8,
                       cursor:"pointer", boxShadow:"0 4px 16px rgba(0,0,0,.2)",
                       maxWidth:360, width:"calc(100% - 48px)" }}>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none"
                stroke={C.amber} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
                <line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>
              </svg>
              <span style={{ fontSize:9, fontWeight:800, color:C.amber }}>
                {hasMatch ? "Same-match legs in draft" : "Same-league legs in draft"} · tap to review
              </span>
            </div>
          </div>
        );
      })()}

      {/* Duplicate fixture conflict prompt */}
      {draftConflicts.length > 0 && pendingTicket && (
        <div style={{ position:"fixed",bottom:160,left:0,right:0,zIndex:201,display:"flex",justifyContent:"center",pointerEvents:"none" }}>
          <div className="gc-elevated"
            style={{ pointerEvents:"all",border:"1px solid var(--gold-border)",
                     padding:"14px 16px",maxWidth:400,width:"calc(100% - 32px)" }}>
            <div style={{ fontSize:10,fontWeight:800,color:"var(--gold)",letterSpacing:".08em",marginBottom:8 }}>
              ⚠ Fixture already in ticket
            </div>
            {draftConflicts.map((l,i) => (
              <div key={i} style={{ fontSize:10,color:"var(--muted)",marginBottom:3,lineHeight:1.4 }}>
                {l.game} — will replace with <strong style={{ color:"var(--text)" }}>{l.pick}</strong>
              </div>
            ))}
            <div style={{ display:"flex",gap:8,marginTop:12 }}>
              <button onClick={() => {
                setDraftLegs(prev => {
                  const conflictIds = new Set(draftConflicts.map(l => l.fixtureId));
                  const kept        = prev.filter(l => !conflictIds.has(l.fixtureId));
                  const allNew      = pendingTicket.legs || [];
                  const existing    = new Set(kept.map(l => l.fixtureId));
                  const toAdd       = allNew.filter(l => !existing.has(l.fixtureId) || conflictIds.has(l.fixtureId));
                  return [...kept, ...toAdd];
                });
                setDraftConflicts([]); setPendingTicket(null);
              }} className="gb-primary" style={{ flex:1,padding:"8px 0",fontSize:11 }}>
                Replace
              </button>
              <button onClick={() => {
                setDraftLegs(prev => {
                  const existingIds = new Set(prev.map(l => l.fixtureId));
                  return [...prev, ...(pendingTicket.legs||[]).filter(l => !existingIds.has(l.fixtureId))];
                });
                setDraftConflicts([]); setPendingTicket(null);
              }} className="gb-ghost" style={{ flex:1,padding:"8px 0",fontSize:11 }}>
                Keep existing
              </button>
              <button onClick={() => { setDraftConflicts([]); setPendingTicket(null); }}
                style={{ background:"transparent",color:"var(--muted)",border:"none",fontSize:16,cursor:"pointer",padding:"0 4px",lineHeight:1 }}>✕</button>
            </div>
          </div>
        </div>
      )}

      {/* First-run onboarding overlay */}
      {showOnboarding && <FirstRunFlow onDone={() => setShowOnboarding(false)} />}

      {/* FullModelPage — opened from any FixtureCard "▼ Full Model" button */}
      {mainFocusFixture && (
        <FullModelPage
          f={mainFocusFixture}
          onBack={() => {
            setMainFocusFixture(null);
            // Return to wherever user came from
            if (fullModelReturnTab === "parlay") {
              setParlayJarvisOpen(true);
            } else if (fullModelReturnTab === "rollover") {
              setMainView("rollover");
            } else if (fullModelReturnTab === "code") {
              setActiveTab("code");
            }
            setFullModelReturnTab(null);
            try { window.scrollTo(0, parseInt(sessionStorage.getItem("grm_scroll") || "0")); } catch {}
          }}
          draftLegs={draftLegs}
          onAddToParlay={addLegToDraft}
          backtestSummary={historicalRates}
        />
      )}

      {parlayJarvisOpen && (
        <ParlayJarvisTab
          fixtures={fixtures} tickets={tickets} setTickets={setTickets}
          draftLegs={draftLegs} setDraftLegs={setDraftLegs}
          budget={budget} setBudget={setBudget} budgetPct={budgetPct} setBudgetPct={setBudgetPct}
          numParlays={numParlays} setNumParlays={setNumParlays} targetOdds={targetOdds} setTargetOdds={setTargetOdds}
          marketFilter={marketFilter} toggleMarket={toggleMarket}
          historicalRates={historicalRates} ensureHistoricalRates={ensureHistoricalRates}
          date={date} onClose={() => setParlayJarvisOpen(false)}
          engineFixtureIds={engineFixtureIds}
          onAddLegToDraft={addLegToDraft}
          adminToken={adminToken}
          onFullModel={f => { setParlayJarvisOpen(false); setFullModelReturnTab("parlay"); setMainFocusFixture(f); }}
          jarvisBuiltTicket={jarvisBuiltTicket}
          onJarvisBuiltTicketConsumed={() => setJarvisBuiltTicket(null)}
          grmInboundCode={grmInboundCode}
          onGrmInboundConsumed={() => setGrmInboundCode(null)}
          ensureFixturesForDate={loadSnapshot}
          goToFetchDate={(d) => {
            // P-FIX: missing-snapshot CTA — pre-fill the date and drop the user
            // on Live Model where the existing fetch flow (with its own
            // progress UI) already lives, rather than duplicating it here.
            setDate(d);
            setParlayJarvisOpen(false);
            setMainView("main");
            setActiveTab("live");
          }}
        />
      )}

      </div>
      {/* ── END CONTENT SHELL ───────────────────────────────────────────── */}

      {/* Gradient fade behind nav — mobile only */}
      {!isDesktop && (
        <div style={{
          position:"fixed", bottom:0, left:0, right:0,
          height:`calc(90px + env(safe-area-inset-bottom))`,
          background:`linear-gradient(to bottom, transparent 0%, ${C.bg}cc 50%, ${C.bg} 100%)`,
          backdropFilter:"blur(3px)",
          WebkitBackdropFilter:"blur(3px)",
          pointerEvents:"none",
          zIndex:209,
        }} />
      )}

      {/* ── SCROLL TO TOP FAB ─────────────────────────────────────────────── */}
      {showScrollTop && !parlayJarvisOpen && !mainFocusFixture && (
        <button
          onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })}
          style={{
            position:"fixed",
            right:16,
            bottom: isDesktop ? 24 : `calc(90px + env(safe-area-inset-bottom))`,
            zIndex:198,
            width:40, height:40,
            borderRadius:"50%",
            background:C.surface,
            border:`1px solid ${C.border}`,
            color:C.muted,
            boxShadow:"0 2px 12px rgba(0,0,0,0.18)",
            cursor:"pointer",
            display:"flex", alignItems:"center", justifyContent:"center",
            fontSize:16, lineHeight:1,
            transition:"opacity .2s, transform .2s",
            WebkitTapHighlightColor:"transparent",
          }}
          aria-label="Scroll to top">
          ↑
        </button>
      )}

      {/* ── HALO BOTTOM NAV ───────────────────────────────────────────────── */}
      <BottomNav
        activeTab={mainView === "rollover" ? "rollover" : activeTab}
        setActiveTab={(tab) => {
          setParlayJarvisOpen(false);
          if (tab === "rollover") {
            setMainView("rollover");
          } else {
            setMainView("main");
            setActiveTab(tab);
          }
        }}
        onParleyOpen={() => setParlayJarvisOpen(true)}
        draftCount={draftLegs.length}
        parleyOpen={parlayJarvisOpen}
      />

      {/* ── JARVIS FAB — draggable, always visible on all tabs ────────────── */}
      {/* Lives OUTSIDE the content shell so it renders on every tab.          */}
      {/* Hidden only when Jarvis panel is open (has its own X button).        */}
      {!jarvisOpen && <JarvisFAB C={C} isDesktop={isDesktop} onClick={() => setJarvisOpen(true)} />}

      {/* ── JARVIS CHAT OVERLAY — portal to document.body ─────────────────── */}
      {jarvisOpen && ReactDOM.createPortal(
        <ChatLayout
          isOpen={jarvisOpen}
          onClose={() => setJarvisOpen(false)}
          C={C}
          fixtures={fixtures}
          fixturesLoaded={fixtures.length > 0}
          fetchingFixtures={loading}
          onFetchFixtures={() => {
            // Stay open — trigger fetch, gate will auto-clear when fixtures arrive
            fetchData(false);
          }}
          fetchError={error}
          savedTickets={tickets}
          onSaveTicket={(ticket) => {
            // DATE-STAMP SAFETY NET: jarvisStore.buildParley now stamps `date`
            // on every ticket it creates, but this stamps it here too in case
            // a ticket arrives without one from some other path — the backtest
            // evaluator depends on `date` being present and correct.
            const stamped = ticket.date ? ticket : { ...ticket, date: new Date().toISOString().slice(0, 10) };
            setTickets(prev => {
              const exists = prev.findIndex(t => t.id === stamped.id);
              const next = exists >= 0
                ? prev.map((t, i) => i === exists ? stamped : t)
                : [stamped, ...prev];
              persistTickets(next);
              return next;
            });
          }}
          onDeleteTicket={(ticketId) => {
            setTickets(prev => {
              const next = prev.filter(t => t.id !== ticketId);
              persistTickets(next);
              return next;
            });
          }}
          rolloverChain={rolloverChain}
          historicalRates={historicalRates}
          engineFixtureIds={jarvisEngineFixtureIds}
          customFixtureIds={jarvisCustomFixtureIds}
          onNavigatePro={handleJarvisNavigate}
          onBookNow={(ticket, bookmaker) => {
            setTickets(prev => {
              const exists = prev.findIndex(t => t.id === ticket.id);
              const updated = { ...ticket, bookmaker, bookedAt: Date.now() };
              const next = exists >= 0
                ? prev.map((t, i) => i === exists ? updated : t)
                : [updated, ...prev];
              persistTickets(next);
              return next;
            });
          }}
          defaultBookmaker="SB"
          geminiApiKey={window.__GRM_GEMINI_KEY || null}
        />,
        document.body
      )}

      {/* UX-FIX: new-version banner — shown to any user still running stale code after a deploy */}
      {updateAvailable && (
        <div style={{ position:"fixed", bottom:20, left:"50%", transform:"translateX(-50%)", zIndex:10000,
                      background:C.gold, borderRadius:12, padding:"10px 16px 10px 18px",
                      display:"flex", alignItems:"center", gap:14, boxShadow:"0 4px 24px rgba(0,0,0,0.5)" }}>
          <span style={{ fontSize:11, fontWeight:800, color:C.accentText }}>Update available</span>
          <button onClick={() => window.location.reload()}
            style={{ background:"#fff", color:C.gold, border:"none", borderRadius:8, padding:"6px 16px", fontSize:11, fontWeight:900, cursor:"pointer" }}>
            Refresh
          </button>
        </div>
      )}

    </div>
  );
}

