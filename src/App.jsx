import React, { useState, useMemo, useCallback, useEffect, useRef } from "react";
import ReactDOM from "react-dom";
import RolloverSystem from "./Rollover";
import CodeAnalyzer from "./CodeAnalyzer";
import { SERVER, LEAGUE_RANK, POOL_MIN_EMPIRICAL_RATE, POOL_SCORE_P_EXP } from "./config";
import { THEMES, THEME_MAP, loadSavedTheme, saveTheme, clampR } from "./themes";

// A10-FIX: SAVED_TICKETS_KEY declared at module top so loadSavedTickets()
// and persistTickets() — both hoisted function declarations — never hit a
// temporal dead zone when called before line 4881 executes.
const SAVED_TICKETS_KEY = "grm_saved_tickets_v15";

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
    const pLow = p.toLowerCase();
    const awaySlug = (awayName || "").slice(0, 6).toLowerCase();
    const hasDraw  = pLow.includes("or draw");
    const hasAway  = pLow.includes(awaySlug);
    if (hasDraw && hasAway)  return aGoals >= hGoals ? "WIN" : "LOSS";
    if (hasDraw && !hasAway) return hGoals >= aGoals ? "WIN" : "LOSS";
    return hGoals !== aGoals ? "WIN" : "LOSS";
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
function getCustomPick(f, family) {
  const m = f.markets, io = safeImpliedOdds;
  if (family === "theRead") {
    if (!f.theRead?.anchor) return null;
    const a = f.theRead.anchor, mst = mktStyle(a.market);
    return { label:a.pick, prob:a.prob, odds:a.odds||io(a.prob), color:mst.color, market:a.market };
  }
  if (family === "theEdge") {
    if (!f.theEdge) return null;
    return { label:f.theEdge.pick, prob:f.theEdge.prob, odds:f.theEdge.odds||io(f.theEdge.prob), color:C.edge, market:f.theEdge.market };
  }
  if (family === "goalRadar") {
    const best = f.goalRadar?.home?.prob >= f.goalRadar?.away?.prob ? f.goalRadar?.home : f.goalRadar?.away;
    if (!best) return null;
    return { label:best.pick, prob:best.prob, odds:best.odds||io(best.prob), color:C.radar, market:"TeamTotal" };
  }
  // Legacy safeBet/valuePick compat for old snapshots
  if (family === "safeBet") {
    if (!f.safeBet) return null;
    const mst = mktStyle(f.safeBet.market);
    return { label:f.safeBet.pick, prob:f.safeBet.prob, odds:f.safeBet.odds||io(f.safeBet.prob), color:mst.color, market:f.safeBet.market };
  }
  const map = {
    "over15":  { label:"Over 1.5",  prob:m.over15,   odds:io(m.over15),   color:C.green  },
    "over25":  { label:"Over 2.5",  prob:m.over25,   odds:io(m.over25),   color:C.green  },
    "over35":  { label:"Over 3.5",  prob:m.over35,   odds:io(m.over35),   color:C.green  },
    "over45":  { label:"Over 4.5",  prob:m.over45,   odds:io(m.over45),   color:C.green  },
    "under15": { label:"Under 1.5", prob:parseFloat((100-(m.over15||0)).toFixed(1)), odds:io(100-(m.over15||0)), color:C.blue },
    "under25": { label:"Under 2.5", prob:m.under25,  odds:io(m.under25),  color:C.blue   },
    "under35": { label:"Under 3.5", prob:m.under35,  odds:io(m.under35),  color:C.blue   },
    "under45": { label:"Under 4.5", prob:m.under45,  odds:io(m.under45),  color:C.blue   },
    "bttsyes": { label:"BTTS Yes",  prob:m.bttsYes,  odds:f.odds?.bttsYesOdds||io(m.bttsYes), color:C.purple },
    "bttsno":  { label:"BTTS No",   prob:m.bttsNo,   odds:f.odds?.bttsNoOdds||io(m.bttsNo),   color:C.purple },
    "homewin": { label:`${f.teams.home} Win`, prob:m.homeWin, odds:f.odds?.o1||io(m.homeWin), color:C.gold, market:"1X2" },
    "draw":    { label:"Draw",      prob:m.draw,     odds:f.odds?.oX||io(m.draw), color:C.gold, market:"1X2" },
    "awaywin": { label:`${f.teams.away} Win`, prob:m.awayWin, odds:f.odds?.o2||io(m.awayWin), color:C.gold, market:"1X2" },
    "homeo05": { label:`${f.teams.home} O0.5`, prob:m.homeOver05, odds:io(m.homeOver05), color:C.radar, market:"TeamTotal" },
    "homeo15": { label:`${f.teams.home} O1.5`, prob:m.homeOver15, odds:io(m.homeOver15), color:C.radar, market:"TeamTotal" },
    "awayo05": { label:`${f.teams.away} O0.5`, prob:m.awayOver05, odds:io(m.awayOver05), color:C.radar, market:"TeamTotal" },
    "awayo15": { label:`${f.teams.away} O1.5`, prob:m.awayOver15, odds:io(m.awayOver15), color:C.radar, market:"TeamTotal" },
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

const STRATEGY_LABELS = {
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
function loadSavedTickets() { try { return JSON.parse(localStorage.getItem(SAVED_TICKETS_KEY)||"[]"); } catch { return []; } }
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
  if (_serverDateCache && Date.now() - _serverDateAt < 5 * 60_000) return _serverDateCache;
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
  return new Date().toISOString().split("T")[0];
}
const todayStr = () => window.__grmServerDate || _serverDateCache || new Date().toISOString().split("T")[0];

// ── COLOUR SYSTEM — theme-driven ──────────────────────────────────────────
// C is a mutable object. syncC(theme) stamps all theme tokens into it so
// every existing C.xxx reference in JSX automatically reflects the active
// theme without any find-replace across the codebase.
let C = { ...loadSavedTheme() };
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
  const bg = (T.bg || "").toLowerCase();
  const isLight = bg.startsWith("#f") || bg === "#ffffff" || bg === "white"
    || bg.startsWith("rgba(255") || bg === "#ffffff".toLowerCase()
    || ["#f5f4ed","#f5f5f7","#ffffff","#fafafa","#f2f2f2"].some(c => bg.startsWith(c));

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
const Bar = ({ value, color }) => (
  <div className="cb" style={{ marginTop:5 }}>
    <div className="cf" style={{ width:`${Math.min(value,100)}%`, background:color }} />
  </div>
);
const Lbl = ({ children }) => (
  <div style={{ fontSize:8,color:C.text,opacity:.5,textTransform:"uppercase",letterSpacing:".11em",fontWeight:700,marginBottom:5 }}>{children}</div>
);
const Panel = ({ label, color, bg, children }) => (
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

function StatusBadge({ state, time }) {
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
      .catch(e => setError(e.message))
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
function AskJarvis({ fixture, backtestSummary, brief = null }) {
  const [open, setOpen]         = useState(false);
  const [question, setQuestion] = useState("");
  const [response, setResponse] = useState(null);
  const [loading, setLoading]   = useState(false);
  const inputRef = useRef(null);

  const ask = async (q) => {
    const trimmed = (q || question).trim();
    setLoading(true);
    setResponse(null);
    try {
      // Build rich context: existing brief + full markets object so Gemini references real numbers
      const m = fixture.markets || {};
      const hasMarkets = Object.keys(m).length > 0;
      const marketLines = hasMarkets
        ? Object.entries(m).map(([k, v]) =>
            `${k}: prob=${v.prob??"-"} edge=${v.edge??"-"} odds=${v.odds??"-"} effRate=${v.effRate??v.historicalRate??"-"}`
          ).join("\n")
        : null;

      const contextualQ = [
        trimmed || "Give a follow-up summary of your key verdict for this fixture.",
        brief       ? `\n\nYour earlier full analysis:\n${brief}` : "",
        marketLines ? `\n\nModel data (markets):\n${marketLines}` : "",
        fixture.form?.home?.length ? `\nHome form: ${fixture.form.home.join("")}` : "",
        fixture.form?.away?.length ? `Away form: ${fixture.form.away.join("")}` : "",
        `\n\nRespond in exactly these 4 sections, each 2–3 sentences. Use these headers verbatim:\n**Context** — match importance, form, momentum\n**Squad News** — injuries, suspensions, lineup concerns\n**Model Check** — reference specific numbers (xG, probs, edge) from the model data above\n**Verdict** — clearest pick and one risk factor\nPlain English only. No emoji. No "as an AI".`,
      ].filter(Boolean).join("");

      const res = await fetch(`${SERVER}/api/jarvis-match`, {
        method: "POST",
        headers: { "Content-Type":"application/json" },
        body: JSON.stringify({ fixture, question: contextualQ, backtestSummary }),
      });
      const data = await res.json();
      setResponse(data.analysis || data.error || "No response");
    } catch(e) {
      const msg = e.message || "";
      const isGemini = msg.toLowerCase().includes("gemini") || msg.toLowerCase().includes("429") || msg.toLowerCase().includes("503") || msg.toLowerCase().includes("rate");
      setResponse(isGemini
        ? "Jarvis hit a rate limit — try again in a few seconds."
        : "Error contacting Jarvis: " + msg
      );
    } finally {
      setLoading(false);
    }
  };

  const anchor = fixture.theRead?.anchor?.pick || "this pick";
  const quickPrompts = [
    `Why not Under 3.5 instead?`,
    `Is the Draw the safer option?`,
    `${anchor} — what could go wrong?`,
    "Any key injuries or lineup news?",
    "Best alternative market here?",
  ];

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
        <button onClick={() => { setOpen(false); setResponse(null); setQuestion(""); }}
          style={{ background:"transparent",border:"none",color:C.muted,fontSize:13,padding:0,cursor:"pointer",lineHeight:1 }}>✕</button>
      </div>

      {/* Quick prompt chips */}
      <div style={{ display:"flex",gap:4,flexWrap:"wrap",marginBottom:8 }}>
        {quickPrompts.map((p,i) => (
          <button key={i} onClick={() => { setQuestion(p); ask(p); }}
            style={{ fontSize:8,padding:"3px 9px",background:"transparent",
                     border:`1px solid ${C.edge}28`,color:C.text,borderRadius:5,
                     cursor:"pointer",fontFamily:C.font,transition:"border-color .15s" }}>
            {p}
          </button>
        ))}
      </div>

      {/* Custom question */}
      <div style={{ display:"flex",gap:6 }}>
        <input ref={inputRef} type="text" value={question}
          onChange={e => setQuestion(e.target.value)}
          onKeyDown={e => e.key === "Enter" && question.trim() && ask()}
          placeholder="Ask anything about this match…"
          className="gi" style={{ flex:1,fontSize:9 }} />
        <button onClick={() => ask()} disabled={loading || !question.trim()}
          className="gb-primary"
          style={{ padding:"5px 14px",fontSize:10,opacity:loading||!question.trim() ? .45 : 1 }}>
          {loading ? <span className="pu">…</span> : "→"}
        </button>
      </div>

      {loading && (
        <div style={{ fontSize:9,color:C.muted,fontStyle:"italic",marginTop:8 }}>
          <span className="pu">Jarvis is thinking…</span>
        </div>
      )}
      {response && !loading && (
        <div className="grm-jarvis-response">
          {/* Parse structured 4-section response (Context/Squad News/Model Check/Verdict) */}
          {(() => {
            const sectionKeys = ["Context","Squad News","Model Check","Verdict"];
            const sectionColors = { "Context": C.text, "Squad News": C.amber, "Model Check": C.edge, "Verdict": C.green };
            // Split on **Header** markers
            const parts = response.split(/\*\*([^*]+)\*\*/g);
            // parts: ["preamble", "Header", "body", "Header", "body", ...]
            const sections = [];
            for (let i = 1; i < parts.length - 1; i += 2) {
              const hdr = parts[i].trim();
              const body = (parts[i+1] || "").trim();
              if (sectionKeys.some(k => hdr.includes(k))) sections.push({ hdr, body });
            }

            if (sections.length >= 2) {
              // Structured render
              return (
                <div style={{ display:"flex",flexDirection:"column",gap:8 }}>
                  {sections.map(({ hdr, body }, idx) => (
                    <div key={idx} style={{ borderLeft:`2px solid ${sectionColors[sectionKeys.find(k=>hdr.includes(k))]||C.faint}20`,
                                            paddingLeft:8 }}>
                      <div style={{ fontSize:8,fontWeight:800,letterSpacing:".08em",textTransform:"uppercase",
                                    color:sectionColors[sectionKeys.find(k=>hdr.includes(k))]||C.muted,marginBottom:3 }}>
                        {hdr.split("—")[0].trim()}
                      </div>
                      <div style={{ fontSize:9,color:C.text,lineHeight:1.6 }}>{body}</div>
                    </div>
                  ))}
                </div>
              );
            }
            // Fallback: plain text (no sections detected)
            return <span style={{ fontSize:9,lineHeight:1.6 }}>{response}</span>;
          })()}
          {response.includes("rate limit") && (
            <button onClick={() => ask(question)} className="gb-ghost"
              style={{ marginTop:8,display:"block",padding:"4px 14px",fontSize:9 }}>
              ↺ Retry
            </button>
          )}
        </div>
      )}
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
function FormRow({ home, away, allCompHome, allCompAway }) {
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

function TheReadSection({ theRead, onAddToParlay, fixture, alreadyAdded, otherInDraft }) {
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
function TheEdgeSection({ theEdge, onAddToParlay, alreadyAdded, otherInDraft, fixture }) {
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
        {/* Removed: edgeStrength number and convergenceCount chip — internal model metadata */}
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
function GoalRadarSection({ goalRadar, onAddToParlay, alreadyAdded, otherInDraft }) {
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
function ComboRow({ combo, onAddToParlay }) {
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
function GoalsPanel({ f }) {
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
      navigator.clipboard.writeText(result.code).then(() => {
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
                      border:`1px solid ${C.faint}`, display:"flex", alignItems:"center",
                      justifyContent:"space-between", gap:8 }}>
          <div>
            <div style={{ fontSize:10, fontWeight:700, color:C.text, marginBottom:2 }}>
              No model pick today
            </div>
            <div style={{ fontSize:9, color:C.muted, lineHeight:1.4 }}>
              Stats, xG and Jarvis analysis still available
            </div>
          </div>
          {onFullModel && (
            <button onClick={(e) => { e.stopPropagation(); onFullModel(f); }}
              style={{ fontSize:9, color:C.accent, background:C.accentDim,
                       border:`1px solid ${C.accentBorder}`, borderRadius:6,
                       padding:"5px 10px", cursor:"pointer", fontFamily:C.font,
                       fontWeight:700, flexShrink:0, whiteSpace:"nowrap" }}>
              View →
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
function buildMatchVoice(f) {
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

// ── FullModelJarvis — Auto Jarvis tier 2 with caching ────────────────────────
function FullModelJarvis({ f, backtestSummary }) {
  const cacheKey = `grm_fm_${f.id}_${new Date().toISOString().slice(0,10)}`;
  const [brief, setBrief]       = useState(() => { try { return localStorage.getItem(cacheKey) || null; } catch { return null; } });
  const [loading, setLoading]   = useState(false);
  const [error, setError]       = useState(null);
  const [serverCached, setServerCached] = useState(false);
  const [cachedAgeH, setCachedAgeH]     = useState(null);
  const timerRef   = useRef(null);
  const calledRef  = useRef(!!brief);

  const doFetch = async (force = false) => {
    if (timerRef.current) clearTimeout(timerRef.current);
    calledRef.current = true;
    setLoading(true);
    setError(null);
    if (force) { setBrief(null); setServerCached(false); setCachedAgeH(null); }
    try {
      const m = f.markets || {};
      // Pass a richer question with actual model numbers so Ask Jarvis has full context
      const question = [
        `Give a 4-5 sentence analyst briefing. Plain English, no emoji, no "as an AI".`,
        `Find and include any injury concerns, lineup issues, or squad news.`,
        `Note what each team is fighting for (title, relegation, European place) if relevant.`,
        `Flag any red flags the model data might be missing.`,
        f.form?.home?.length ? `Home form (last 5): ${f.form.home.join("")}` : "",
        f.form?.away?.length ? `Away form (last 5): ${f.form.away.join("")}` : "",
        force ? "refresh" : "",  // signals server cache to bypass when force-retried
      ].filter(Boolean).join(" ");

      const res = await fetch(`${SERVER}/api/jarvis-match`, {
        method:"POST",
        headers:{ "Content-Type":"application/json" },
        body: JSON.stringify({ fixture: f, question, backtestSummary }),
      });
      if (!res.ok) throw new Error(`Server ${res.status}`);
      const data = await res.json();
      const text = (data.analysis || "").trim();
      if (text) {
        setBrief(text);
        setServerCached(!!data.cached);
        setCachedAgeH(data.ageH ?? null);
        try { localStorage.setItem(cacheKey, text); } catch {}
      } else {
        setError("Analysis unavailable — check back shortly.");
      }
    } catch (e) {
      setError("Could not reach analysis service.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (calledRef.current) return;
    timerRef.current = setTimeout(() => doFetch(false), 1500);
    return () => clearTimeout(timerRef.current);
  }, [f.id]);

  if (!loading && !brief && !error) return null;

  return (
    <div style={{ marginTop:10, paddingTop:10, borderTop:`1px solid ${C.border}` }}>
      <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:8 }}>
        <div style={{ display:"flex", alignItems:"center", gap:8 }}>
          <div style={{ fontSize:9, fontWeight:800, color:C.edge, letterSpacing:".1em", textTransform:"uppercase" }}>
            Jarvis Analysis
          </div>
          {/* Cached indicator — shows when server returned a cached result */}
          {serverCached && cachedAgeH != null && (
            <span style={{ fontSize:7, color:C.muted, background:C.surface,
                           border:`1px solid ${C.faint}`, borderRadius:4, padding:"1px 6px" }}>
              Cached · {cachedAgeH < 1 ? `${Math.round(cachedAgeH*60)}m ago` : `${cachedAgeH.toFixed(1)}h ago`}
            </span>
          )}
        </div>
        {/* Retry button — always available when not loading */}
        {!loading && (
          <button onClick={() => doFetch(true)}
            style={{ fontSize:8, color:C.muted, background:"transparent",
                     border:`1px solid ${C.faint}`, borderRadius:5,
                     padding:"2px 8px", cursor:"pointer", fontFamily:C.font,
                     display:"flex", alignItems:"center", gap:3 }}>
            <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M23 4v6h-6"/><path d="M1 20v-6h6"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>
            </svg>
            Retry
          </button>
        )}
      </div>
      {loading && (
        <div style={{ fontSize:10, color:C.muted, fontStyle:"italic" }}>
          <span className="pu">Researching match context…</span>
        </div>
      )}
      {error && !loading && (
        <div style={{ fontSize:10, color:C.amber, lineHeight:1.5 }}>{error}</div>
      )}
      {brief && !loading && (() => {
        // Parse structured Jarvis response: **HEADING** sections + body text
        // Handles both the new structured format and the old paragraph format gracefully.
        const sectionColors = {
          "CONTEXT":     C.muted,
          "SQUAD NEWS":  C.amber,
          "MODEL CHECK": C.edge,
          "VERDICT":     C.green,
        };

        // Split on **HEADING** markers
        const raw = brief.trim();
        const hasStructure = /\*\*[A-Z ]+\*\*/.test(raw);

        if (hasStructure) {
          // New structured format
          const parts = raw.split(/(\*\*[A-Z][A-Z ]*\*\*)/).filter(Boolean);
          const sections = [];
          for (let i = 0; i < parts.length; i++) {
            const headingMatch = parts[i].match(/^\*\*([A-Z][A-Z ]*)\*\*$/);
            if (headingMatch) {
              const label = headingMatch[1].trim();
              const body  = (parts[i+1] || "").replace(/^[\s—–-]+/, "").trim();
              sections.push({ label, body, color: sectionColors[label] || C.text });
              i++;
            } else if (parts[i].trim()) {
              // Orphan text before first heading — treat as context
              sections.push({ label: null, body: parts[i].trim(), color: C.text });
            }
          }
          return (
            <div style={{ display:"flex", flexDirection:"column", gap:8 }}>
              {sections.map((sec, i) => (
                <div key={i} style={{
                  padding:"8px 10px",
                  borderLeft: sec.color !== C.text ? `3px solid ${sec.color}` : `3px solid ${C.border}`,
                  borderRadius:"0 6px 6px 0",
                  background: sec.color !== C.text ? `${sec.color}08` : "transparent",
                }}>
                  {sec.label && (
                    <div style={{ fontSize:9, fontWeight:800, color:sec.color,
                                  letterSpacing:".08em", textTransform:"uppercase", marginBottom:4 }}>
                      {sec.label}
                    </div>
                  )}
                  <div style={{ fontSize:11, color:C.text, lineHeight:1.65 }}>
                    {sec.body}
                  </div>
                </div>
              ))}
            </div>
          );
        }

        // Old paragraph format — keep existing rendering as fallback
        const conflictPhrases = /injur|ruled out|doubt|absent|missing|suspend|without|unavailab|concern|caution|contradict|against|red flag|volatile|thin data|limited data|flag|warning|however|despite|but\b|worr/i;
        const supportPhrases  = /back the model|support|confirms|align|strong case|confident|clear pick|solid|endorse|in agreement|on balance|verdict.*back|back.*pick/i;
        const paragraphs = raw.split(/\n{2,}/).filter(Boolean);
        return (
          <div style={{ fontSize:11, color:C.text, lineHeight:1.75 }}>
            {paragraphs.map((para, i) => {
              const isConflict = conflictPhrases.test(para);
              const isSupport  = supportPhrases.test(para);
              const isVerdict  = i === paragraphs.length - 1;
              const accentCol  = isConflict ? C.amber : (isSupport || isVerdict) ? C.green : null;
              return (
                <div key={i}
                  style={{
                    marginBottom: i < paragraphs.length - 1 ? 12 : 0,
                    padding: accentCol ? "8px 10px" : 0,
                    borderLeft: accentCol ? `3px solid ${accentCol}` : "none",
                    borderRadius: accentCol ? "0 6px 6px 0" : 0,
                    background: accentCol ? `${accentCol}08` : "transparent",
                    color: accentCol || C.text,
                  }}>
                  {para}
                </div>
              );
            })}
          </div>
        );
      })()}

      {/* ── Ask Jarvis Chat — contextual follow-up on the analysis ── */}
      {brief && !loading && (
        <div style={{ marginTop:10 }}>
          <AskJarvis fixture={f} backtestSummary={backtestSummary} brief={brief} />
        </div>
      )}
    </div>
  );
}

function FullModelPage({ f, onBack, onAddToParlay, draftLegs, backtestSummary }) {
  const m = f.markets;
  const scrollRef = useRef(null);
  // Per-pick draft checks — same logic as FixtureCardInner.
  const draftLegForFixture = Array.isArray(draftLegs)
    ? draftLegs.find(l => l.fixtureId === f.id)
    : null;
  const isAlreadyInDraft = !!draftLegForFixture;
  const readAnchor   = f.theRead?.anchor;
  const fmEdge       = f.theEdge;
  const readInDraft  = isAlreadyInDraft && !!readAnchor
    && draftLegForFixture.pick === readAnchor.pick;
  const edgeInDraft  = isAlreadyInDraft && !!fmEdge
    && draftLegForFixture.pick === fmEdge.pick;
  const radarInDraft = isAlreadyInDraft
    && (draftLegForFixture?.market === "TeamTotal"
        || draftLegForFixture?.market?.includes("TeamTotal"));
  const matchVoice = buildMatchVoice(f);

  const handleAdd = useCallback((pick) => {
    if (!onAddToParlay) return;
    const io = p => (p > 0 && p < 100) ? parseFloat((1 / (p / 100)).toFixed(2)) : null;
    onAddToParlay(f, {
      pick:   pick.pick,
      prob:   pick.prob,
      odds:   pick.odds || io(pick.prob) || null,
      market: pick.market,
    });
  }, [f, onAddToParlay]);

  const BackBtn = ({ bottom }) => (
    <button onClick={onBack} className="gb-ghost"
      style={{ padding:bottom?"12px 0":"7px 14px", fontSize:11,
               display:"flex", alignItems:"center", gap:6,
               width:bottom?"100%":"auto", justifyContent:bottom?"center":"flex-start",
               flexShrink:0 }}>
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
        <polyline points="15 18 9 12 15 6"/>
      </svg>
      {bottom ? "Back to fixtures" : "Back"}
    </button>
  );

  return (
    <div className="grm-full-model-page" style={{ position:"fixed",inset:0,zIndex:300,background:C.bg,overflowY:"auto",overscrollBehavior:"contain",display:"flex",flexDirection:"column" }}
      ref={scrollRef}>

      {/* ── Sticky header ── */}
      <div className="grm-page-header">
        <BackBtn />
        <div style={{ flex:1, minWidth:0 }}>
          <div style={{ fontSize:13, fontWeight:800, color:C.text, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap", lineHeight:1.2 }}>
            {f.teams.home} <span style={{ color:C.muted, fontWeight:400 }}>vs</span> {f.teams.away}
          </div>
          <div style={{ fontSize:9, color:C.muted, marginTop:2 }}>{f.league}</div>
        </div>
        <StatusBadge state={f.state} time={f.time} />
      </div>

      <div style={{ padding:"16px", display:"flex", flexDirection:"column", gap:14, maxWidth:700, width:"100%", margin:"0 auto" }}>

        {/* ── Zone A: Match identity card ── */}
        <div className="gc" style={{ padding:"16px 18px" }}>
          {/* Teams row */}
          <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:10 }}>
            <span style={{ fontSize:15, fontWeight:800, color:C.text, flex:1, lineHeight:1.25 }}>{f.teams.home}</span>
            <div style={{ textAlign:"center", padding:"0 12px", flexShrink:0 }}>
              {f.hGoals != null
                ? <div style={{ fontSize:18, fontWeight:800, color:C.text }}>{f.hGoals}–{f.aGoals}</div>
                : <div style={{ fontSize:10, color:C.muted }}>vs</div>
              }
              {f.time && <div style={{ fontSize:8, color:C.muted, marginTop:1 }}>{f.time}</div>}
            </div>
            <span style={{ fontSize:15, fontWeight:800, color:C.text, flex:1, textAlign:"right", lineHeight:1.25 }}>{f.teams.away}</span>
          </div>

          {/* Form dots */}
          {f.form && (f.form.home?.length > 0 || f.form.away?.length > 0) && (
            <FormRow home={f.form.home} away={f.form.away} allCompHome={f.form.allCompHome} allCompAway={f.form.allCompAway} />
          )}

          {/* Table position */}
          {f.tablePosition && (f.tablePosition.homePosition || f.tablePosition.awayPosition) && (
            <div style={{ display:"flex", justifyContent:"space-between", marginTop:8, paddingTop:8, borderTop:`1px solid var(--glass-border)` }}>
              <span style={{ fontSize:10, color:C.muted }}>
                <span style={{ color:C.text, fontWeight:700 }}>#{f.tablePosition.homePosition || "—"}</span>
                {f.tablePosition.homePoints != null && <span style={{ color:C.muted }}> · {f.tablePosition.homePoints}pts</span>}
              </span>
              <span style={{ fontSize:10, color:C.muted, textAlign:"right" }}>
                {f.tablePosition.awayPoints != null && <span style={{ color:C.muted }}>{f.tablePosition.awayPoints}pts · </span>}
                <span style={{ color:C.text, fontWeight:700 }}>#{f.tablePosition.awayPosition || "—"}</span>
              </span>
            </div>
          )}

          {/* Strategy tags */}
          {f.strategyTags?.length > 0 && (
            <div style={{ display:"flex", gap:5, flexWrap:"wrap", marginTop:8 }}>
              {f.strategyTags.map(t => (
                <span key={t} className="grm-chip" style={{ color:C.gold, borderColor:`${C.gold}40`, background:C.goldDim }}>
                  {STRATEGY_LABELS[t] || t}
                </span>
              ))}
            </div>
          )}
        </div>

        {/* ── Zone B: Jarvis Analysis (independent researcher) ── */}
        <div className="gc" style={{ padding:"16px 18px" }}>
          <FullModelJarvis f={f} backtestSummary={backtestSummary} />
        </div>

        {/* ── Zone C: xG bar ── */}
        <div className="gc" style={{ padding:"16px 18px" }}>
          <div style={{ fontSize:9, fontWeight:800, color:C.muted, letterSpacing:".1em", textTransform:"uppercase", marginBottom:12 }}>
            Expected Goals
          </div>
          <div style={{ display:"flex", alignItems:"center", gap:14 }}>
            <div style={{ textAlign:"center", minWidth:52 }}>
              <div style={{ fontSize:26, fontWeight:800, color:C.gold, lineHeight:1 }}>{m.homeXG}</div>
              <div style={{ fontSize:9, color:C.muted, marginTop:3 }}>{f.teams.home.split(" ")[0]}</div>
            </div>
            <div style={{ flex:1 }}>
              <div style={{ height:6, background:`var(--glass-border)`, borderRadius:3, overflow:"hidden", position:"relative" }}>
                <div style={{ position:"absolute",left:0,top:0,height:"100%",
                              width:`${(m.homeXG/(m.homeXG+m.awayXG))*100}%`,
                              background:`linear-gradient(90deg,${C.gold},${C.gold}88)`,borderRadius:3 }}/>
              </div>
              {/* Removed: atk/def coefficients — internal model parameters not meaningful to users */}
            </div>
            <div style={{ textAlign:"center", minWidth:52 }}>
              <div style={{ fontSize:26, fontWeight:800, color:C.muted, lineHeight:1 }}>{m.awayXG}</div>
              <div style={{ fontSize:9, color:C.muted, marginTop:3 }}>{f.teams.away.split(" ")[0]}</div>
            </div>
          </div>
          {/* Removed: calibration weight, season games, recent games count — internal pipeline metadata */}
        </div>

        {/* ── Zone D: Signal panels — side by side ── */}
        <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:10 }}>
          <TheReadSection theRead={f.theRead} fixture={f}
            onAddToParlay={onAddToParlay ? handleAdd : null}
            alreadyAdded={readInDraft}
            otherInDraft={isAlreadyInDraft && !readInDraft} />
          <TheEdgeSection theEdge={f.theEdge}
            alreadyAdded={edgeInDraft}
            otherInDraft={isAlreadyInDraft && !edgeInDraft}
            onAddToParlay={onAddToParlay ? (pick) => handleAdd({ ...pick, market: pick.market }) : null}
            fixture={f} />
        </div>

        {/* ── Zone E: Goal Radar — full width ── */}
        {f.goalRadar && (
          <GoalRadarSection goalRadar={f.goalRadar}
            alreadyAdded={radarInDraft}
            otherInDraft={isAlreadyInDraft && !radarInDraft}
            onAddToParlay={onAddToParlay ? (entry) => handleAdd({ ...entry, market:"TeamTotal" }) : null} />
        )}

        {/* ── Custom Pick — between signal panels and stats, at the decision layer ── */}
        <FixtureBookNow fixture={f} onAddToParlay={onAddToParlay ? handleAdd : null} />

        {/* ── Zone F: Stats grid ── */}
        <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:10 }}>
          <Panel label="Match Result" color={C.blue} bg={C.blueDim}>
            {[
              { l:"H", label:`${f.teams.home} Win`, prob:m.homeWin, odds:f.odds?.o1,  market:"1X2" },
              { l:"X", label:"Draw",                 prob:m.draw,    odds:f.odds?.oX,  market:"1X2" },
              { l:"A", label:`${f.teams.away} Win`, prob:m.awayWin, odds:f.odds?.o2,  market:"1X2" },
            ].map(r => (
              <div key={r.l} style={{ display:"flex", alignItems:"center", marginBottom:5, gap:5 }}>
                <span style={{ fontSize:10, color:C.muted, width:14, fontWeight:700 }}>{r.l}</span>
                <div style={{ flex:1, height:4, background:`var(--glass-border)`, borderRadius:2, overflow:"hidden" }}>
                  <div style={{ height:"100%", width:`${r.prob||0}%`, background:C.blue, borderRadius:2 }}/>
                </div>
                <span style={{ fontSize:11, color:C.blue, fontWeight:800, width:34, textAlign:"right" }}>{r.prob ? `${Math.round(r.prob)}%` : "—"}</span>
                {r.odds && <span style={{ fontSize:9, color:C.muted, width:28, textAlign:"right" }}>{r.odds}x</span>}
              </div>
            ))}
          </Panel>
          <GoalsPanel f={f} />
          <Panel label="BTTS" color={C.purple} bg={C.purpleDim}>
            <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:8 }}>
              <div>
                <div style={{ fontSize:9, color:C.muted, marginBottom:3 }}>Yes</div>
                <div style={{ fontSize:22, fontWeight:800, color:m.bttsYes >= 60 ? C.purple : C.muted }}>{Math.round(m.bttsYes)}%</div>
                <div style={{ fontSize:9, color:m.bttsYes >= 60 ? C.purple : C.muted, fontWeight:700 }}>
                  {m.bttsYes >= 60 ? "Qualified" : "Below threshold"}
                </div>
              </div>
              <div style={{ textAlign:"right" }}>
                <div style={{ fontSize:9, color:C.muted, marginBottom:3 }}>No</div>
                <div style={{ fontSize:14, fontWeight:700, color:C.text }}>{Math.round(m.bttsNo)}%</div>
                {f.odds?.bttsYesOdds && <div style={{ fontSize:9, color:C.muted, marginTop:4 }}>{f.odds.bttsYesOdds}x</div>}
              </div>
            </div>
            <Bar value={m.bttsYes} color={C.purple} />
          </Panel>
          <Panel label="Team Totals" color={C.radar} bg={C.radarDim}>
            {[
              { name:f.teams.home, o05:m.homeOver05, o15:m.homeOver15, cs:m.homeCS, stats:f.teamStats?.home },
              { name:f.teams.away, o05:m.awayOver05, o15:m.awayOver15, cs:m.awayCS, stats:f.teamStats?.away },
            ].map(t => (
              <div key={t.name} style={{ marginBottom:10 }}>
                <div style={{ fontSize:11, color:C.radar, fontWeight:700, marginBottom:4 }}>
                  {(t.name||"").split(" ").slice(0,2).join(" ")}
                </div>
                <div style={{ display:"flex", gap:8, flexWrap:"wrap" }}>
                  <span style={{ fontSize:10, color:C.text }}>O0.5 <span style={{ color:(t.o05||0)>=90?C.radar:C.muted, fontWeight:700 }}>{Math.round(t.o05||0)}%</span></span>
                  <span style={{ fontSize:10, color:C.text }}>O1.5 <span style={{ color:(t.o15||0)>=65?C.radar:C.muted, fontWeight:700 }}>{Math.round(t.o15||0)}%</span></span>
                  <span style={{ fontSize:10, color:(t.cs||0)>=30?C.green:C.muted, fontWeight:(t.cs||0)>=30?800:500 }}>CS {Math.round(t.cs||0)}%</span>
                </div>
                {t.stats?.recentResults?.length > 0 && (
                  <div style={{ marginTop:6, display:"flex", gap:3, flexWrap:"wrap" }}>
                    {t.stats.recentResults.map((r, i) => (
                      <div key={i} title={`${r.role} vs ${r.opponent} · ${r.scored}-${r.conceded}`}
                        style={{ display:"flex", alignItems:"center", gap:2, background:`var(--glass-border)`, borderRadius:4, padding:"2px 6px", fontSize:8,
                                 border:`1px solid ${r.outcome==="W"?C.green+"40":r.outcome==="L"?C.red+"40":"var(--glass-border)"}` }}>
                        <span style={{ color:r.outcome==="W"?C.green:r.outcome==="L"?C.red:C.muted, fontWeight:800 }}>{r.outcome}</span>
                        <span style={{ color:C.muted }}>{r.scored}-{r.conceded}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </Panel>
        </div>

        {/* ── Combos ── */}
        {f.combos?.length > 0 && (
          <div className="gc" style={{ padding:"14px 16px" }}>
            <div style={{ fontSize:9, fontWeight:800, color:C.muted, letterSpacing:".1em", textTransform:"uppercase", marginBottom:10 }}>Combo Suggestions</div>
            {f.combos.map((combo, i) => (
              <ComboRow key={i} combo={combo}
                onAddToParlay={onAddToParlay ? handleAdd : null} />
            ))}
          </div>
        )}

        {/* ── Bottom back ── */}
        <BackBtn bottom />
        <div style={{ height:20 }} />
      </div>
    </div>
  );
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
  const [family,         setFamily]         = useState("theRead");
  const [statFilters,    setStatFilters]    = useState([]);
  const [selected,       setSelected]       = useState(null);
  const [activeStrategy, setActiveStrategy] = useState(null);
  const [advancedOpen,   setAdvancedOpen]   = useState(false);
  // Issue 6: Market exclusion — fixtures whose primary Read/pick is an excluded market
  // fall back to their second-best qualifying pick rather than being hidden entirely.
  const [excludedMarkets, setExcludedMarkets] = useState(new Set());
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
  const [xgBoth,  setXgBoth]  = useState(null);
  const [xgHome,  setXgHome]  = useState(null);
  const [xgAway,  setXgAway]  = useState(null);
  const [thrBtts, setThrBtts] = useState(null);
  const [thrHWin, setThrHWin] = useState(null);
  const [thrAWin, setThrAWin] = useState(null);
  const [thrHCS,  setThrHCS]  = useState(null);
  const [thrACS,  setThrACS]  = useState(null);
  const [thrOdds, setThrOdds] = useState(null);
  const [thrDraw, setThrDraw] = useState(null);
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
        const p = getCustomPick(f, fam);
        if (p && p.prob > 0 && !excludedMarkets.has(p.market) && !excludedMarkets.has(fam)) return p;
      }
      return null;
    };

    return fixtures
      .filter(f => !s||f.teams.home.toLowerCase().includes(s)||f.teams.away.toLowerCase().includes(s)||f.league.toLowerCase().includes(s))
      .filter(f => statFilters.every(id => { const sf=STAT_FILTERS.find(x=>x.id===id); return sf?sf.fn(f):true; }))
      .map(f => {
        const primaryPick = getCustomPick(f, family);
        if (!primaryPick || primaryPick.prob <= 0) return null;
        // If primary pick's market is excluded, try fallback
        const isExcluded = excludedMarkets.size > 0 &&
          (excludedMarkets.has(primaryPick.market) || excludedMarkets.has(family));
        if (isExcluded) {
          const fallback = getFallbackPick(f);
          if (!fallback) return null; // no non-excluded alternative — hide
          return { f, pick: fallback, _usedFallback: true, _excludedMarket: primaryPick.market };
        }
        return { f, pick: primaryPick, _usedFallback: false };
      })
      .filter(Boolean)
      .sort((a,b) => b.pick.prob - a.pick.prob);
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
            {/* Direction toggle — tap to switch ≥/≤. Extra hint on first render. */}
            <button onClick={() => setDir(id, currentDir === "gte" ? "lte" : "gte")}
                    title="Tap to switch between ≥ and ≤"
                    style={{ padding:"3px 6px", background:`${col}10`,
                             borderTop:`1px solid ${col}25`, borderBottom:`1px solid ${col}25`,
                             border:"none", borderTop:`1px solid ${col}25`, borderBottom:`1px solid ${col}25`,
                             color:col, cursor:"pointer", fontFamily:C.font,
                             fontSize:8, fontWeight:800, textAlign:"center", letterSpacing:".02em",
                             display:"flex", alignItems:"center", justifyContent:"center", gap:3 }}>
              <span style={{ fontSize:10 }}>{currentDir === "gte" ? "≥" : "≤"}</span>
              <span>{currentDir === "gte" ? "more than" : "less than"}</span>
              <span style={{ fontSize:7, opacity:.6, marginLeft:1 }}>↕</span>
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
      <div style={{ marginBottom:14 }}>
        {/* Header row — full-width tap target, visually distinct */}
        <button onClick={()=>setAdvancedOpen(v=>!v)}
                style={{ width:"100%", display:"flex", justifyContent:"space-between", alignItems:"center",
                         background: advancedOpen ? `${C.gold}12` : C.surface,
                         border: `1px solid ${advancedOpen ? `${C.gold}50` : C.border}`,
                         borderRadius: advancedOpen ? "8px 8px 0 0" : 8,
                         cursor:"pointer", padding:"10px 14px",
                         transition:"all .15s" }}>
          <div style={{ display:"flex", alignItems:"center", gap:8 }}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ color: advancedOpen ? C.gold : C.muted }}>
              <circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
            </svg>
            <span style={{ fontSize:9, fontWeight:800, color: advancedOpen ? C.gold : C.text,
                           textTransform:"uppercase", letterSpacing:".1em" }}>Advanced Filters</span>
            {/* Active count badge — shows when collapsed with active filters */}
            {!advancedOpen && (thrBtts!=null||xgBoth!=null||xgHome!=null||xgAway!=null||thrHWin!=null||thrAWin!=null||thrHCS!=null||thrACS!=null||thrOdds!=null||thrDraw!=null) && (
              <span style={{ background:C.gold, color:C.accentText, borderRadius:10,
                             fontSize:7, fontWeight:900, padding:"1px 6px", lineHeight:1.5 }}>
                ACTIVE
              </span>
            )}
          </div>
          <div style={{ display:"flex", alignItems:"center", gap:6 }}>
            {!advancedOpen && (
              <span style={{ fontSize:8, color:C.muted, fontStyle:"italic" }}>xG · Win % · CS · Odds</span>
            )}
            <span style={{ fontSize:11, color: advancedOpen ? C.gold : C.muted, fontWeight:700,
                           transform: advancedOpen ? "rotate(180deg)" : "none", transition:"transform .2s" }}>▾</span>
          </div>
        </button>

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

            {/* ── Market Exclusion ── */}
            {/* Excluded market: fixture still shows but uses its next-best non-excluded pick */}
            <div>
              <div style={{ fontSize:7,color:C.muted,letterSpacing:".1em",fontWeight:700,textTransform:"uppercase",marginBottom:6 }}>
                Exclude Markets
                {excludedMarkets.size > 0 && (
                  <button onClick={() => setExcludedMarkets(new Set())}
                    style={{ marginLeft:8,fontSize:7,color:C.red,background:"none",border:"none",cursor:"pointer",fontFamily:C.font }}>
                    Clear
                  </button>
                )}
              </div>
              <div style={{ fontSize:8,color:C.muted,marginBottom:6,lineHeight:1.4 }}>
                Fixtures with excluded picks show their next-best market instead.
              </div>
              <div style={{ display:"flex",flexWrap:"wrap",gap:5 }}>
                {[
                  { id:"DC",        label:"Double Chance" },
                  { id:"1X2",       label:"1X2 / Home Win" },
                  { id:"BTTS",      label:"BTTS" },
                  { id:"Over 2.5",  label:"Over 2.5" },
                  { id:"Under 2.5", label:"Under 2.5" },
                  { id:"Over 3.5",  label:"Over 3.5" },
                  { id:"Under 3.5", label:"Under 3.5" },
                  { id:"TeamTotal", label:"Team Total" },
                ].map(({ id, label }) => {
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
          </div>
        )}
      </div>

      {/* List header */}
      <div style={{ display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:10 }}>
        <span style={{ fontSize:9,color:C.text }}>{rows.length} matches</span>
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
          <span>{selectedIds.size > 0 ? <button onClick={clearSelection} style={{ background:"none",border:"none",color:C.red,cursor:"pointer",fontSize:9,padding:0 }}>✕</button> : "☐"}</span>
          <span>Time</span><span>Match</span><span>Pick</span><span>Prob</span><span>Odds</span>
          {hasResults && <span>Score</span>}
        </div>
      )}
      {isMobile && (
        <div style={{ display:"grid",gridTemplateColumns:hasResults?"20px 1fr 44px 44px":"20px 1fr 44px",gap:6,padding:"5px 10px",borderBottom:`1px solid ${C.border}`,fontSize:9,color:C.text,textTransform:"uppercase",letterSpacing:".1em",fontWeight:700,marginBottom:4 }}>
          <span>{selectedIds.size > 0 ? <button onClick={clearSelection} style={{ background:"none",border:"none",color:C.red,cursor:"pointer",fontSize:9,padding:0 }}>✕</button> : "☐"}</span>
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
                <div style={{ fontSize:9,fontWeight:700,color:pick.color||C.text,marginTop:3,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap" }}>
                  {pick.label}
                  {_usedFallback && (
                    <span style={{ marginLeft:5,fontSize:7,color:C.amber,background:`${C.amber}15`,
                                   border:`1px solid ${C.amber}30`,borderRadius:3,padding:"1px 4px" }}>
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
                <div style={{ fontSize:10,fontWeight:700,color:pick.color||C.text,lineHeight:1.2 }}>{pick.label}</div>
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
    } catch(e) { setError(e.message); }
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
    } catch(e) { setError(e.message); setUploading(false); }
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
      setBtData(data);
    } catch(e) { setError(e.message); }
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
const BOOKMAKERS = [
  { id:"sportybet",    label:"SportyBet NG",   api:"/api/book-sportybet",   link: code => `https://www.sportybet.com/ng/?shareCode=${code}`,          appLink: code => `sportybet://share?shareCode=${code}` },
  { id:"luckyledger",  label:"Lucky's Ledger", api:"/api/book-luckyledger", link: code => `https://luckysledger.com/sports?btBookingCode=${code}`,      appLink: code => `luckysledger://betslip?btBookingCode=${code}` },
];

function TicketBookNowButton({ legs }) {
  const [open, setOpen]         = useState(false);
  const [bookie, setBookie]     = useState("");
  const [booking, setBooking]   = useState(false);
  const [result, setResult]     = useState(null);
  const [error, setError]       = useState(null);
  const [copied, setCopied]     = useState(false);
  const [sharedOk, setSharedOk] = useState(false);

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
    navigator.clipboard.writeText(result.code)
      .then(() => { setCopied(true); setTimeout(() => setCopied(false), 2000); });
  };

  const shareTicket = () => {
    if (!result?.code) return;
    const bm = BOOKMAKERS.find(b => b.id === result.bookieId);
    const link = bm?.link ? bm.link(result.code) : result.code;
    navigator.clipboard.writeText(link)
      .then(() => { setSharedOk(true); setTimeout(() => setSharedOk(false), 2000); });
  };

  const openInApp = () => {
    if (!result?.code) return;
    const bm = BOOKMAKERS.find(b => b.id === result.bookieId);
    const link = bm?.link ? bm.link(result.code) : null;
    if (link) window.open(link, "_blank");
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
          {/* Bookmaker selector */}
          <div style={{ display:"flex", gap:6, marginBottom:12,
                        background:C.surface, borderRadius:br+4, padding:4,
                        border:`1px solid ${C.border}` }}>
            {BOOKMAKERS.map(bm => (
              <button key={bm.id} onClick={() => { setBookie(bm.id); reset(); }} style={{
                flex:1, padding:"8px 0", borderRadius:br, border:"none",
                background: bookie===bm.id ? C.accent : "transparent",
                color: bookie===bm.id ? C.accentText : C.muted,
                fontSize:10, fontWeight:800, cursor:"pointer", fontFamily:C.font,
                letterSpacing:".06em", transition:"all .15s",
              }}>{bm.label}</button>
            ))}
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
            <button onClick={openInApp} style={{
              flex:1, padding:"10px 0", fontSize:10, fontWeight:700,
              background:C.accent, color:C.accentText,
              border:"none", borderRadius:br,
              cursor:"pointer", fontFamily:C.font,
              display:"flex", alignItems:"center", justifyContent:"center", gap:6,
            }}>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/>
              </svg>
              Open App
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
function FixtureBookNow({ fixture, onAddToParlay }) {
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
    navigator.clipboard.writeText(code).then(() => { setCopied(true); setTimeout(()=>setCopied(false),2000); });
  };
  return (
    <button onClick={copy} className="gb"
      style={{ background:copied?`${C.green}15`:"transparent",border:`1px solid ${copied?C.green:C.radar}40`,color:copied?C.green:C.radar,padding:"2px 10px",fontSize:9,fontWeight:700 }}>
      {copied ? "✓ Copied" : `${code}`}
    </button>
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
          {ticket.edgeScore > 0 && (
            <span className="grm-chip" style={{ color:C.green,borderColor:`${C.green}40`,background:C.greenDim }}>
              EDGE {ticket.edgeScore.toFixed(1)}
            </span>
          )}
          {exhausted && (
            <span className="grm-chip" style={{ color:C.amber,borderColor:`${C.amber}40`,background:C.amberDim }}>
              ⚠ Exhausted
            </span>
          )}
        </div>
        <div style={{ display:"flex",gap:8,alignItems:"center" }}>
          <span style={{ fontSize:13,color:C.text,fontWeight:800 }}>×{ticket.totalOdds}</span>
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
      {!exhausted && (() => {
        const [addLegsOpen, setAddLegsOpen] = React.useState(false);
        return (
          <>
            <div style={{ display:"flex",gap:6,alignItems:"center",marginBottom:addLegsOpen?8:12,paddingBottom:10,borderBottom:addLegsOpen?`1px solid ${accentBdr}`:undefined }}>
              {onEditDraft && (
                <button onClick={() => onEditDraft(ticket.legs||[])} className="gb-ghost"
                  style={{ padding:"5px 12px",fontSize:10,color:C.accent,borderColor:`${C.accent}40`,
                           display:"flex",alignItems:"center",gap:5 }}>
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
                    <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
                  </svg>
                  Edit
                </button>
              )}
              {onAddLegs && (
                <button onClick={() => setAddLegsOpen(v => !v)} className="gb-ghost"
                  style={{ padding:"5px 12px",fontSize:10,color:addLegsOpen?C.green:C.gold,
                           borderColor:`${addLegsOpen?C.green:C.gold}40`,
                           display:"flex",alignItems:"center",gap:5 }}>
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
                  </svg>
                  {addLegsOpen ? "Done" : "Add Legs"}
                </button>
              )}
              {onRemix && (
                <button onClick={remixing ? undefined : onRemix} className="gb-ghost"
                  style={{ padding:"5px 12px",fontSize:10,color:remixing?C.muted:C.radar,
                           borderColor:`${C.radar}35`,opacity:remixing?0.6:1,
                           cursor:remixing?"not-allowed":"pointer",display:"flex",alignItems:"center",gap:5 }}>
                  {remixing
                    ? <span className="pu">Remixing…</span>
                    : <>
                        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                          <polyline points="16 3 21 3 21 8"/><line x1="4" y1="20" x2="21" y2="3"/>
                          <polyline points="21 16 21 21 16 21"/><line x1="15" y1="15" x2="21" y2="21"/>
                        </svg>
                        {`Remix${ticket._remixed?" ✓":""}`}
                      </>
                  }
                </button>
              )}
              <div style={{ flex:1 }}/>
              <button onClick={onRemove}
                style={{ background:"none",border:"none",color:C.muted,cursor:"pointer",fontSize:16,padding:"0 2px",lineHeight:1 }}>✕</button>
            </div>

            {/* ── Add Legs inline picker ── */}
            {/* Shows fixtures not already in ticket, ranked by confidence.
                Tapping a row appends it as a new leg directly — no draft copy needed.
                Edge cases handled: duplicate fixtures blocked, no live/FT games,
                shows empty state if no qualifying fixtures remain. */}
            {addLegsOpen && onAddLegs && (() => {
              const ticketIds = new Set((ticket.legs||[]).map(l => l.fixtureId));
              const candidates = onAddLegs.fixtures
                .filter(f => {
                  if (ticketIds.has(f.id)) return false; // already in ticket
                  const st = (f.state||"").toLowerCase().replace(/[_\-\s]/g,"");
                  if (["finished","ft","fulltime","ended","complete","aet","postponed","ppd","cancelled","canceled"].includes(st)) return false;
                  return true;
                })
                .map(f => {
                  // Use The Read anchor as the pick — highest signal
                  const anchor = f.theRead?.anchor;
                  if (!anchor || f.theRead?.isFallback) return null;
                  return { f, pick: anchor };
                })
                .filter(Boolean)
                .sort((a,b) => b.pick.prob - a.pick.prob)
                .slice(0, 20);

              return (
                <div style={{ marginBottom:12, padding:"10px 12px", background:`${C.gold}07`,
                              border:`1px solid ${C.gold}25`, borderRadius:8 }}>
                  <div style={{ fontSize:8,fontWeight:800,color:C.gold,letterSpacing:".1em",
                                textTransform:"uppercase",marginBottom:8 }}>
                    Add a leg — tap to append
                  </div>
                  {candidates.length === 0 ? (
                    <div style={{ fontSize:9,color:C.muted }}>No qualifying fixtures available to add.</div>
                  ) : (
                    <div style={{ display:"flex",flexDirection:"column",gap:5 }}>
                      {candidates.map(({ f, pick }) => (
                        <button key={f.id}
                          onClick={() => { onAddLegs.addLeg(f, pick); setAddLegsOpen(false); }}
                          style={{ display:"flex",justifyContent:"space-between",alignItems:"center",
                                   padding:"7px 10px",background:C.surface,border:`1px solid ${C.border}`,
                                   borderRadius:6,cursor:"pointer",fontFamily:C.font,textAlign:"left",
                                   transition:"border-color .15s" }}
                          onMouseEnter={e=>e.currentTarget.style.borderColor=C.gold}
                          onMouseLeave={e=>e.currentTarget.style.borderColor=C.border}>
                          <div style={{ minWidth:0 }}>
                            <div style={{ fontSize:9,fontWeight:700,color:C.text,overflow:"hidden",
                                          textOverflow:"ellipsis",whiteSpace:"nowrap" }}>
                              {f.teams.home} vs {f.teams.away}
                            </div>
                            <div style={{ fontSize:8,color:pick.color||C.gold,marginTop:1 }}>
                              {pick.pick} · {pick.odds ? `@${parseFloat(pick.odds).toFixed(2)}` : ""}
                            </div>
                          </div>
                          <div style={{ fontSize:11,fontWeight:800,color:C.gold,flexShrink:0,marginLeft:8 }}>
                            {Math.round(pick.prob)}%
                          </div>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              );
            })()}
          </>
        );
      })()}

      {/* ── Exhausted state ── */}
      {isJarvis && exhausted && (
        <div style={{ display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:10 }}>
          <div style={{ flex:1 }}>
            <div style={{ fontSize:10,color:C.amber,fontWeight:700,marginBottom:5 }}>⚠ Pool exhausted before reaching target odds</div>
            <div style={{ fontSize:9,color:C.text,marginBottom:6,lineHeight:1.5 }}>{ticket.jarvisReason}</div>
            {ticket.saturatedMarkets?.length > 0
              ? <div style={{ fontSize:9,color:C.muted }}>Market cap of {ticket.maxSameMarket} blocked more {ticket.saturatedMarkets.join("/")} picks.</div>
              : ticket.poolSize < 4
                ? <div style={{ fontSize:9,color:C.muted }}>Only {ticket.poolSize} game{ticket.poolSize!==1?"s":""} qualified. Lower Target Odds or fetch a fresh snapshot.</div>
                : <div style={{ fontSize:9,color:C.muted }}>All {ticket.poolSize} qualifying games used. Lower Target Odds for a shorter ticket.</div>
            }
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
    </div>
  );
}

// ── JARVIS TICKET CARD ────────────────────────────────────────────────────
function JarvisTicketCard({ ticket, onOpenFixture, onRemove, date, onSaveInternal, savedCode, onRemix, onSwapLeg, onEditDraft, onAddLegs }) {
  const [analysis, setAnalysis] = useState(null);
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
                          borderRadius:"var(--r-lg)",padding:"12px 14px",
                          fontSize:11,color:C.text,lineHeight:1.65 }}>
              {analysis}
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
    return [...map.entries()]
      .sort(([,aL],[,bL]) => Math.min(...aL.map(l=>l.leagueRank)) - Math.min(...bL.map(l=>l.leagueRank)))
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
            style={{ position:"fixed",inset:0,zIndex:8998 }}/>
          <div style={{
            position:"fixed",
            top: btnRect ? btnRect.bottom + 3 : 60,
            left: btnRect ? btnRect.left : 16,
            zIndex:8999,
            width:280,maxHeight:400,overflowY:"auto",
            background:C.modalBg,border:`1px solid ${C.border}`,
            borderRadius:8,boxShadow:"0 4px 24px rgba(0,0,0,0.5)"
          }}>
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
          </div>
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

// ── POOL PERFORMANCE TAB ─────────────────────────────────────────────────
function PoolPerformanceTab({ serverUrl }) {
  const [data, setData]         = useState(null);
  const [loading, setLoading]   = useState(true);
  const [days, setDays]         = useState(30);

  useEffect(() => {
    setLoading(true);
    Promise.all([
      fetch(`${serverUrl}/api/pool/performance?days=${days}`).then(r => r.json()).catch(() => null),
      fetch(`${serverUrl}/api/pool/performance/enhanced?days=${days}`).then(r => r.json()).catch(() => null),
    ]).then(([base, enhanced]) => {
      if (!base || base.empty) { setData(null); setLoading(false); return; }

      // Build a map of enhanced picks keyed by date.
      // enhanced.dailyTrend only exists for dates that have a results file —
      // dates without results are absent entirely, not present with empty picks.
      // The old merge used picksMap.get(d.date) || [] which silently zeroed out
      // the per-pick list for any pool-only date (no results file yet).
      const enhancedByDate = new Map(
        (enhanced?.dailyTrend || []).map(d => [d.date, d])
      );

      // Walk every date from the base (pool) endpoint — this is the authoritative
      // set of dates where picks were made. For each day:
      //   • Keep base stats (total/wins/rate) — these are pool-scored, no double-count
      //   • Overlay picks[] from enhanced if available (richer per-pick detail)
      //   • If enhanced also has readTotal/readWins for that day, carry those over
      const mergedTrend = (base.dailyTrend || []).map(d => {
        const enh = enhancedByDate.get(d.date);
        return {
          ...d,
          picks:      enh?.picks      || d.picks      || [],
          readTotal:  enh?.total      ?? d.readTotal   ?? d.total,
          readWins:   enh?.wins       ?? d.readWins    ?? d.wins,
        };
      });

      // Append any enhanced dates that have no corresponding base entry
      // (e.g. days where results arrived but the pool file was missing).
      (enhanced?.dailyTrend || []).forEach(enh => {
        if (!mergedTrend.find(d => d.date === enh.date)) {
          mergedTrend.push({ ...enh, readTotal: enh.total, readWins: enh.wins });
        }
      });

      mergedTrend.sort((a, b) => a.date.localeCompare(b.date));
      setData({ ...base, dailyTrend: mergedTrend });
      setLoading(false);
    });
  }, [days]);

  if (loading) return <div style={{ padding:40,textAlign:"center",color:C.text,fontSize:10 }}>Loading performance data…</div>;

  return (
    <div style={{ paddingBottom:40 }}>

      {!data && (
        <div style={{ padding:40,textAlign:"center",color:C.text,opacity:.3,fontSize:10 }}>
          No scored pools yet.<br/>
          <span style={{ fontSize:8,marginTop:8,display:"block",color:C.text,opacity:.45 }}>
            Pool data is saved each time you build a ticket. After results come in the engine auto-scores each pick.
          </span>
        </div>
      )}

      {data && (<>
      {/* Day selector */}
      <div style={{ display:"flex",gap:6,marginBottom:16 }}>
        {[7,14,30,60].map(d => (
          <button key={d} onClick={() => setDays(d)} className="gb"
            style={{ padding:"4px 12px",fontSize:9,background:days===d?C.edge:"transparent",color:days===d?C.accentText:C.muted,border:`1px solid ${days===d?C.edge:C.faint}` }}>
            {d}d
          </button>
        ))}
      </div>

      {/* Overall */}
      {data.overall && (
        <div className="gc" style={{ padding:14,marginBottom:12 }}>
          {/* Engine Pool — picks that passed all quality thresholds */}
          <div style={{ fontSize:7,color:C.edge,textTransform:"uppercase",letterSpacing:".12em",fontWeight:800,marginBottom:2 }}>Engine Pool · {data.period}</div>
          <div style={{ fontSize:7,color:C.muted,marginBottom:8 }}>Picks that cleared all confidence + data thresholds</div>
          <div style={{ display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:8,marginBottom:8 }}>
            {[["Picks",data.overall.total],["Wins",data.overall.wins],["Hit Rate",`${data.overall.rate}%`],["Avg Odds",data.overall.avgOdds != null ? data.overall.avgOdds.toFixed(2)+"×" : "—"]].map(([l,v])=>(
              <div key={l} style={{ textAlign:"center" }}>
                <div style={{ fontSize:16,fontWeight:800,color:parseFloat(v)>60?C.green:parseFloat(v)<45?C.red:C.gold }}>{v}</div>
                <div style={{ fontSize:7,color:C.text,marginTop:2 }}>{l}</div>
              </div>
            ))}
          </div>
          {/* Decay weighting notice — rate is decay-weighted (14d half-life), counts are raw */}
          <div style={{ fontSize:7,color:C.muted,marginBottom:14,lineHeight:1.5 }}>
            Hit Rate is decay-weighted (14-day half-life) — recent results count more than older ones.
            Picks and Wins are raw counts. A pick from 28 days ago contributes ~25% of a pick from today.
          </div>
          {/* All-Read Overall — summed from daily pick report */}
          {(() => {
            const trend = data.dailyTrend || [];
            const allReadTotal = trend.reduce((s, d) => s + (d.readTotal || d.total || 0), 0);
            const allReadWins  = trend.reduce((s, d) => s + (d.readWins  || d.wins  || 0), 0);
            const allReadRate  = allReadTotal ? Math.round(allReadWins / allReadTotal * 100) : 0;
            if (!allReadTotal) return null;
            return (
              <div style={{ borderTop:`1px solid ${C.border}`,paddingTop:10 }}>
                <div style={{ fontSize:9,color:C.text,textTransform:"uppercase",letterSpacing:".12em",fontWeight:800,marginBottom:2 }}>All Read Picks · same period</div>
                <div style={{ fontSize:7,color:C.muted,marginBottom:8 }}>Every fixture with any model pick (includes low-confidence)</div>
                <div style={{ display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:8 }}>
                  {[["Picks",allReadTotal],["Wins",allReadWins],["Hit Rate",`${allReadRate}%`]].map(([l,v])=>(
                    <div key={l} style={{ textAlign:"center" }}>
                      <div style={{ fontSize:14,fontWeight:800,color:parseFloat(v)>60?C.green:parseFloat(v)<45?C.red:C.gold }}>{v}</div>
                      <div style={{ fontSize:7,color:C.text,marginTop:2 }}>{l}</div>
                    </div>
                  ))}
                </div>
              </div>
            );
          })()}
        </div>
      )}

      {/* By Market */}
      {data.byMarket && Object.keys(data.byMarket).length > 0 && (
        <div className="gc" style={{ padding:14,marginBottom:12 }}>
          <div style={{ fontSize:8,color:C.edge,textTransform:"uppercase",letterSpacing:".1em",marginBottom:2,fontWeight:800 }}>Engine Pool · By Market</div>
          <div style={{ fontSize:7,color:C.muted,marginBottom:10 }}>Picks that cleared all confidence + data thresholds</div>
          {Object.entries(data.byMarket).sort((a,b)=>b[1].total-a[1].total).map(([mkt,d]) => (
            <div key={mkt} style={{ display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:7 }}>
              <div style={{ fontSize:9,color:C.text,minWidth:100 }}>{mkt}</div>
              <div style={{ flex:1,height:4,background:C.faint,borderRadius:4,margin:"0 10px",overflow:"hidden" }}>
                <div style={{ height:"100%",width:`${d.rate}%`,background:d.rate>=65?C.green:d.rate>=50?C.gold:C.red,borderRadius:4,transition:"width .4s" }}/>
              </div>
              <div style={{ fontSize:9,fontWeight:700,color:d.rate>=65?C.green:d.rate>=50?C.gold:C.red,minWidth:36,textAlign:"right" }}>{d.rate}%</div>
              <div style={{ fontSize:8,color:C.text,minWidth:30,textAlign:"right",marginLeft:6 }}>{d.total}</div>
            </div>
          ))}
        </div>
      )}

      {/* By Tag */}
      {data.byTag && Object.keys(data.byTag).length > 0 && (
        <div className="gc" style={{ padding:14,marginBottom:12 }}>
          <div style={{ fontSize:8,color:C.edge,textTransform:"uppercase",letterSpacing:".1em",marginBottom:2,fontWeight:800 }}>Engine Pool · By Strategy</div>
          <div style={{ fontSize:7,color:C.muted,marginBottom:10 }}>Strategy tag hit rates — engine pool games only</div>
          {Object.entries(data.byTag).sort((a,b)=>b[1].total-a[1].total).map(([tag,d]) => (
            <div key={tag} style={{ display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:6 }}>
              <div style={{ fontSize:9,color:C.text,minWidth:120 }}>{tag.replace(/_/g," ")}</div>
              <div style={{ fontSize:9,fontWeight:700,color:d.rate>=65?C.green:d.rate>=50?C.gold:C.red }}>{d.rate}%</div>
              <div style={{ fontSize:8,color:C.text,marginLeft:8 }}>{d.wins}/{d.total}</div>
            </div>
          ))}
        </div>
      )}

      {/* Daily Engine Pool — collapsible accordion by date (Issue 3.2) */}
      {data.dailyTrend?.some(d => (d.engineTotal || d.total) > 0) && (
        <PoolAccordion data={data} C={C} />
      )}

      {/* Daily Pick Report — all Read + Edge picks incl. low-confidence — SECOND */}
      {data.dailyTrend?.length > 0 && (
        <DailyBreakdownTable dailyTrend={data.dailyTrend} />
      )}
      </>)}
    </div>
  );
}


function ParlayJarvisTab({ fixtures, tickets, setTickets, draftLegs, setDraftLegs, budget, setBudget, budgetPct, setBudgetPct, numParlays, setNumParlays, targetOdds, setTargetOdds, marketFilter, toggleMarket, historicalRates, ensureHistoricalRates, date, onClose, engineFixtureIds, onAddLegToDraft, onFullModel, adminToken = "" }) {
  const [view, setView] = useState("parlay");
  const [builderMode, setBuilderMode] = useState("jarvis"); // "jarvis" | "custom"
  const [jarvisModes, setJarvisModes] = useState(new Set(["safe"])); // multi-select: safe/value/longshot
  const [customPool, setCustomPool]   = useState("all"); // "all" | "engine"
  const [focusFixture, setFocus] = useState(null);
  const [returnTo, setReturnTo] = useState("parlay");
  const [building, setBuilding]           = useState(false);
  const [jarvisResearch, setJarvisResearch] = useState(false); // Research Mode — pre-scores candidates before building
  const [remixingId, setRemixingId]        = useState(null);  // ticketId currently being remixed (null = idle)
  const [autoMessage, setAutoMessage] = useState(null);
  const [analysing, setAnalysing] = useState(false); // Gemini analysis state for auto ticket
  const [autoAnalysis, setAutoAnalysis] = useState(null);
  const [savedTickets, setSavedTickets] = useState(() => { try { return loadSavedTickets() || []; } catch { return []; } });
  const [savedCodes, setSavedCodes] = useState(() => {
    try { return JSON.parse(localStorage.getItem("grm_saved_codes_v15") || "{}"); } catch { return {}; }
  });
  const [maxSameMarket, setMaxSameMarket] = useState(2);
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

    const available = fixtures.filter(f => !allUsed.has(f.id));

    if (available.length < 2) {
      setAutoMessage("Not enough unused fixtures to remix — try reducing other tickets first.");
      setTimeout(() => setAutoMessage(""), 3500);
      setRemixingId(null); return;
    }

    // Build pool from available fixtures
    const rawPool = buildUniversalPool(available, rates);
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
    const code    = generateTicketCode();
    const payload = { ...ticket, stake, code, date:date||todayStr(), savedAt:new Date().toISOString() };
    const updated = [...savedTickets, payload];
    setSavedTickets(updated); persistTickets(updated);
    const contentKey = ticketContentKey(ticket);
    setSavedCodes(prev => {
      const next = { ...prev, [contentKey]: code };
      try { localStorage.setItem("grm_saved_codes_v15", JSON.stringify(next)); } catch {}
      return next;
    });
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
      const rawPool = buildUniversalPool(parlayFixtures, rates);
      if (parlayLeagueFilter && rawPool.length === 0) {
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
        const modeOdds = modeId === "safe"     ? 2.5
                       : modeId === "value"    ? 4.0
                       : /* longshot */          10.0;
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
      const rawPool = buildUniversalPool(allCustomFixtures, rates);
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
    <div style={{ position:"fixed",inset:0,background:C.bg,zIndex:200,overflowY:"auto",overscrollBehavior:"contain",padding:0,paddingBottom:120 }}>
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

        {/* Pill tabs — Builder and Saved */}
        <div style={{ display:"flex",gap:4,flex:1 }}>
          {[
            { id:"parlay", label:`Builder${draftLegs.length+tickets.length>0?` (${draftLegs.length+tickets.length})`:""}`,
              icon:<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 9V7a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v2a3 3 0 0 0 0 6v2a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-2a3 3 0 0 0 0-6z"/><path d="M13 5v14"/></svg> },
            { id:"saved",  label:`Saved${savedTickets.length>0?` (${savedTickets.length})`:""}`,
              icon:<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/></svg> },
          ].map(t => (
            <button key={t.id} onClick={() => setView(t.id)}
              className={`grm-pill${view===t.id?" active":""}`}
              style={{ display:"flex",alignItems:"center",gap:5 }}>
              <span style={{ color: view===t.id ? "var(--accent)" : "var(--muted)" }}>{t.icon}</span>
              {t.label}
            </button>
          ))}
        </div>
      </div>

      <div style={{ padding:16 }}>

        {/* PARLAY BUILDER */}
        {view === "parlay" && (
          <>
            {draftTicket && (
              <div style={{ marginBottom:16 }}>
                <div style={{ fontSize:9,color:C.gold,fontWeight:800,textTransform:"uppercase",letterSpacing:".12em",marginBottom:8 }}>📝 Draft Ticket</div>
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
              {(() => {
                const [explainerOpen, setExplainerOpen] = React.useState(() => {
                  try { return !localStorage.getItem("grm_parley_explainer_v2"); } catch { return true; }
                });
                if (!explainerOpen) return (
                  <button onClick={() => setExplainerOpen(true)} className="gb"
                    style={{ width:"100%",background:"transparent",border:`1px solid ${C.faint}`,
                             color:C.muted,padding:"5px 0",fontSize:8,marginBottom:10 }}>
                    ℹ How the Parley System works
                  </button>
                );
                return (
                  <div style={{ background:`${C.gold}08`,border:`1px solid ${C.gold}25`,borderRadius:10,
                                padding:"12px 14px",marginBottom:14,fontSize:9,color:C.text,lineHeight:1.7 }}>
                    <div style={{ display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:8 }}>
                      <span style={{ fontWeight:800,color:C.gold,fontSize:10 }}>How the Parley System works</span>
                      <button onClick={() => {
                        setExplainerOpen(false);
                        try { localStorage.setItem("grm_parley_explainer_v2","1"); } catch {}
                      }} style={{ background:"none",border:"none",color:C.muted,cursor:"pointer",fontSize:13,padding:0 }}>✕</button>
                    </div>
                    <div style={{ display:"flex",flexDirection:"column",gap:7 }}>
                      <div><span style={{ color:C.gold,fontWeight:800 }}>Jarvis tab</span> — AI builds a ticket for you. Choose Safe, Value, or Longshot style. Hit Build, then <span style={{ fontWeight:700 }}>Remix ↺</span> to get a different set of picks from the same pool.</div>
                      <div><span style={{ color:C.gold,fontWeight:800 }}>Custom tab</span> — Build N non-overlapping tickets from all fixtures or the engine pool. Set your target odds and stake.</div>
                      <div><span style={{ color:C.gold,fontWeight:800 }}>Tapping a game in a built ticket</span> opens its Full Model page — this does <span style={{ fontWeight:700 }}>not</span> edit your ticket. To swap a leg, tap <span style={{ fontWeight:700 }}>↺ Swap</span> on that leg. To edit the whole ticket, tap <span style={{ fontWeight:700 }}>Edit</span> — this copies all legs to your draft for manual adjustment.</div>
                      <div><span style={{ color:C.amber,fontWeight:800 }}>⚠ Bookmaker cross-check</span> — Our booking code is automated. Always verify your selections in the bookmaker app before placing. Occasionally a game name may differ and a leg won't resolve correctly.</div>
                    </div>
                  </div>
                );
              })()}

              {/* ── Tab strip: Jarvis | Custom ── */}
              <div style={{ display:"flex",marginBottom:16,background:C.bg,borderRadius:12,padding:3,border:`1px solid ${C.border}`,gap:3 }}>
                {[
                  { id:"jarvis", label:"Jarvis",
                    icon:<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>,
                    desc:"AI-built ticket" },
                  { id:"custom", label:"Custom",
                    icon:<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14M4.93 4.93a10 10 0 0 0 0 14.14"/></svg>,
                    desc:"Your rules" },
                ].map(m => (
                  <button key={m.id} onClick={() => setBuilderMode(m.id)}
                    style={{
                      flex:1,padding:"9px 6px",
                      display:"flex",flexDirection:"column",alignItems:"center",gap:3,
                      fontSize:9,fontWeight:800,
                      background: builderMode===m.id ? C.accent : "transparent",
                      color: builderMode===m.id ? C.accentText : C.muted,
                      border:"none",borderRadius:10,
                      transition:"all .18s ease",cursor:"pointer",
                      fontFamily:C.font,
                    }}>
                    <span style={{ opacity: builderMode===m.id ? 1 : 0.6 }}>{m.icon}</span>
                    <span>{m.label}</span>
                    <span style={{ fontSize:7,opacity:.7,fontWeight:500 }}>{m.desc}</span>
                  </button>
                ))}
              </div>

              {/* ── JARVIS TAB ── */}
              {builderMode === "jarvis" && (
                <>
                  {/* Mode pills — Safe / Value / Longshot (multi-select) */}
                  <div style={{ marginBottom:14 }}>
                    <div style={{ fontSize:8,color:C.muted,fontWeight:700,letterSpacing:".1em",textTransform:"uppercase",marginBottom:7 }}>Ticket Style</div>
                    <div style={{ display:"flex",gap:6 }}>
                      {[
                        { id:"safe",     label:"Safe",     color:C.green,  desc:"2–5 legs · high confidence", legs:[2,5] },
                        { id:"value",    label:"Value",    color:C.gold,   desc:"5–10 legs · confidence + odds edge", legs:[5,10] },
                        { id:"longshot", label:"Longshot", color:C.red,    desc:"10–17 legs · max risk/reward", legs:[10,17] },
                      ].map(pill => {
                        const active = jarvisModes.has(pill.id);
                        return (
                          <button key={pill.id}
                            onClick={() => {
                              setJarvisModes(prev => {
                                const next = new Set(prev);
                                active ? next.delete(pill.id) : next.add(pill.id);
                                return next.size === 0 ? prev : next; // prevent empty selection
                              });
                            }}
                            style={{
                              flex:1,padding:"8px 4px",borderRadius:10,
                              border:`1.5px solid ${active ? pill.color : C.border}`,
                              background: active ? `${pill.color}15` : "transparent",
                              color: active ? pill.color : C.muted,
                              fontSize:10,fontWeight:800,cursor:"pointer",fontFamily:C.font,
                              display:"flex",flexDirection:"column",alignItems:"center",gap:3,
                              transition:"all .15s",
                            }}>
                            <span>{pill.label}</span>
                            <span style={{ fontSize:7,opacity:.7,fontWeight:500,lineHeight:1.3,textAlign:"center" }}>{pill.desc}</span>
                          </button>
                        );
                      })}
                    </div>
                    {jarvisModes.size > 1 && (
                      <div style={{ fontSize:8,color:C.muted,marginTop:5,lineHeight:1.4 }}>
                        Multi-mode: Jarvis builds one ticket per style. Shared legs are labelled and can be replaced individually.
                      </div>
                    )}
                  </div>

                  {/* Stake only — target odds is derived from mode, not user-set */}
                  <div style={{ display:"grid",gridTemplateColumns:"1fr 1fr",gap:10,marginBottom:12 }}>
                    <div>
                      <div style={{ fontSize:8,color:C.text,marginBottom:4,textTransform:"uppercase",letterSpacing:".1em" }}>Stake ($)</div>
                      <input type="number" value={budget} onChange={e=>setBudget(+e.target.value)} onFocus={e=>e.target.select()} className="gi"/>
                    </div>
                    <div style={{ display:"flex",flexDirection:"column",justifyContent:"center",
                                  background:C.faint,borderRadius:8,padding:"8px 12px",border:`1px solid ${C.border}` }}>
                      <div style={{ fontSize:7,color:C.muted,textTransform:"uppercase",letterSpacing:".1em",marginBottom:3 }}>Min Odds</div>
                      <div style={{ fontSize:11,fontWeight:800,color:C.gold }}>
                        {[...jarvisModes].map(m => ({safe:"≥2.0",value:"≥3.5",longshot:"≥8.0"}[m]||"≥2.0")).join(" · ")}
                      </div>
                      <div style={{ fontSize:7,color:C.muted,marginTop:2 }}>Set by style</div>
                    </div>
                  </div>
                </>
              )}

              {/* ── CUSTOM TAB ── */}
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
                </>
              )}

              {/* Research Mode toggle — Jarvis tab only */}
              {builderMode === "jarvis" && <div style={{ display:"flex",alignItems:"center",justifyContent:"space-between",
                            padding:"10px 14px",marginBottom:10,borderRadius:8,
                            background: jarvisResearch ? `${C.gold}12` : C.surface,
                            border:`1px solid ${jarvisResearch ? `${C.gold}40` : C.border}`,
                            cursor:"pointer" }}
                   onClick={() => setJarvisResearch(v => !v)}>
                <div>
                  <div style={{ fontSize:9,fontWeight:800,color:jarvisResearch?C.gold:C.text, display:"flex", alignItems:"center", gap:6 }}>
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ color:jarvisResearch?C.gold:C.muted }}><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
                    Jarvis Research Mode
                  </div>
                  <div style={{ fontSize:8,color:C.muted,marginTop:2 }}>
                    {jarvisResearch
                      ? "Jarvis will search injuries, form & standings before picking — takes ~10s"
                      : "Off — instant build. Toggle on to let Jarvis research candidates first"}
                  </div>
                </div>
                <div style={{ width:36,height:20,borderRadius:10,background:jarvisResearch?C.gold:C.border,
                              position:"relative",transition:"background .2s",flexShrink:0 }}>
                  <div style={{ position:"absolute",top:2,left:jarvisResearch?18:2,width:16,height:16,
                                borderRadius:"50%",background:"#fff",transition:"left .2s",
                                boxShadow:"0 1px 3px rgba(0,0,0,.3)" }} />
                </div>
              </div>}

              {/* ── League Filter — uses same LeagueFilter component as Live Model ── */}
              {parlayAvailableLeagues.length > 1 && (
                <div style={{ marginBottom:12 }}>
                  <LeagueFilter
                    availableLeagues={parlayAvailableLeagues}
                    leagueFilter={parlayLeagueFilter}
                    setLeagueFilter={setParlayLeagueFilter}
                  />
                  {/* Pool size indicator */}
                  {parlayLeagueFilter && (() => {
                    const activeSet = parlayLeagueFilter instanceof Set ? parlayLeagueFilter : new Set([parlayLeagueFilter]);
                    const poolCount = fixtures.filter(f => activeSet.has(f.leagueId||f.league)).length;
                    return (
                      <div style={{ marginTop:5, fontSize:8,
                        color: poolCount===0 ? C.red : poolCount<5 ? C.amber : C.green }}>
                        {poolCount===0 ? "No fixtures in selected leagues"
                          : poolCount<5 ? `Only ${poolCount} fixture${poolCount!==1?"s":""} — pool may be thin`
                          : `${poolCount} fixtures available`}
                      </div>
                    );
                  })()}
                </div>
              )}

              <button onClick={handleBuildParlay} disabled={building || !fixtures.length} className="gb-primary"
                style={{ width:"100%",padding:"13px 0",fontSize:13,fontWeight:800,
                         opacity: building || !fixtures.length ? .5 : 1 }}>
                {building
                  ? (jarvisResearch ? "🔬 RESEARCHING…" : "BUILDING…")
                  : builderMode === "jarvis"
                    ? `BUILD ${[...jarvisModes].map(m=>m.toUpperCase()).join(" + ")} TICKET${jarvisModes.size>1?"S":""}`
                    : `BUILD ${numParlays} TICKET${numParlays>1?"S":""}`}
              </button>
              {building && (
                <div style={{ textAlign:"center",marginTop:5 }}>
                  <span className="pu" style={{ fontSize:8,color:C.muted }}>
                    {jarvisResearch
                      ? "Jarvis is searching injuries, form, standings for top candidates…"
                      : builderMode === "jarvis"
                        ? `Scanning ${fixtures.length} fixture${fixtures.length!==1?"s":""} · scoring qualifying picks for ${[...jarvisModes].join(", ")} mode…`
                        : `Scanning ${fixtures.length} fixture${fixtures.length!==1?"s":""} · building ${numParlays} non-overlapping ticket${numParlays>1?"s":""}…`}
                  </span>
                </div>
              )}
            </div>

            {/* Auto mode — engine message + Gemini analysis */}
            {builderMode === "jarvis" && autoMessage && (
              <div style={{ background:`${C.edge}08`,border:`1px solid ${C.edge}30`,borderRadius:8,padding:"10px 14px",fontSize:9,color:C.edge,marginBottom:12 }}>
                {autoMessage}
              </div>
            )}
            {builderMode === "jarvis" && tickets.some(t=>t.isAuto) && (
              <div style={{ marginBottom:12 }}>
                {!autoAnalysis ? (
                  <button onClick={handleAutoAnalyse} disabled={analysing} className="gb"
                    style={{ width:"100%",background:analysing?C.faint:`${C.edge}18`,color:analysing?C.muted:C.edge,border:`1px solid ${C.edge}40`,padding:"8px 0",fontSize:10,fontWeight:700 }}>
                    {analysing ? <span className="pu">Jarvis analysing…</span> : "Ask Jarvis to Explain Picks"}
                  </button>
                ) : (
                  <div style={{ background:`${C.edge}08`,border:`1px solid ${C.edge}30`,borderRadius:8,padding:"12px 14px" }}>
                    <div style={{ fontSize:8,fontWeight:800,color:C.edge,letterSpacing:".1em",textTransform:"uppercase",marginBottom:6 }}>Jarvis Analysis</div>
                    <div style={{ fontSize:9,color:C.text,lineHeight:1.6,whiteSpace:"pre-wrap" }}>{autoAnalysis}</div>
                    <button onClick={()=>setAutoAnalysis(null)} className="gb"
                      style={{ marginTop:8,background:"transparent",border:`1px solid ${C.faint}`,color:C.text,padding:"3px 10px",fontSize:8 }}>
                      ↺ Re-analyse
                    </button>
                  </div>
                )}
              </div>
            )}

            {tickets.length > 0 && (
              <>
                <div style={{ display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:10 }}>
                  <span style={{ fontSize:9,color:C.text }}>{tickets.length} built ticket{tickets.length>1?"s":""}</span>
                  <button onClick={() => setTickets([])} className="gb" style={{ fontSize:9,color:C.red,border:`1px solid ${C.red}40`,padding:"3px 8px" }}>Clear all</button>
                </div>
                <div style={{ display:"flex",flexDirection:"column",gap:8 }}>
                  {tickets.map(t => (
                    <TicketCard key={t.id} ticket={t} date={date} isJarvis={!!t.isAuto}
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
                                           : t.jarvisMode === "longshot" ? 10.0 : 4.0;
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
                  ))}
                </div>
              </>
            )}
          </>
        )}

        {/* PERFORMANCE TAB */}
        {view === "perf" && <PoolPerformanceTab serverUrl={SERVER} />}

        {/* ROLLOVER TAB */}
        {view === "rollover" && (
          <RolloverSystem
            C={C}
            SERVER={SERVER}
            fixtures={fixtures}
            historicalRates={historicalRates}
            date={date}
            buildRolloverPick={buildRolloverPick}
            buildUniversalPool={buildUniversalPool}
            onFullModel={onFullModelFromParlay}
          />
        )}

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
                <div key={t.code} style={{ background:C.surface,border:`1px solid ${C.border}`,borderRadius:12,padding:"12px 14px" }}>
                  <div style={{ display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:8 }}>
                    <div>
                      <span style={{ fontSize:11,fontWeight:800,color:C.radar,letterSpacing:".08em" }}>{t.code}</span>
                      <span style={{ fontSize:8,color:C.text,marginLeft:8 }}>{t.date} · {t.legs?.length||0} legs · ×{t.totalOdds}</span>
                    </div>
                    <div style={{ display:"flex",gap:6,alignItems:"center",flexWrap:"wrap" }}>
                      <CopyCodeButton code={t.code} />
                      <button onClick={() => {
                        // Edit saved ticket as draft
                        setDraftLegs(t.legs || []);
                        setView("parlay");
                      }} className="gb-ghost"
                        style={{ padding:"3px 10px",fontSize:9,color:C.accent,borderColor:`${C.accent}40`,
                                 display:"flex",alignItems:"center",gap:4 }}>
                        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
                          <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
                        </svg>
                        Edit
                      </button>
                      <button onClick={() => {
                        const reloaded = { ...t, id: Date.now(), source:"card_add", exhausted:false };
                        setTickets(prev => [...prev, reloaded]);
                        setView("parlay");
                      }} className="gb-ghost" style={{ padding:"3px 10px",fontSize:9,color:C.gold,borderColor:`${C.gold}40` }}>
                        Load
                      </button>
                      <button onClick={() => deleteSavedTicket(t.code)}
                        style={{ background:"none",border:"none",color:C.muted,cursor:"pointer",fontSize:14,padding:0 }}>✕</button>
                    </div>
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
const HELP_SECTIONS = [
  {
    id: "read", icon: "read", title: "THE READ", sub: "best pick", color: () => C.gold,
    what:    "The model's main recommendation for each fixture — the pick it's most confident in after running the full analysis.",
    telling: "This went through xG, team form, standings, calibration weight, and historical hit rate for that market. STRONG badge means the confidence cleared an even higher bar than usual. The hit rate shown on each card (e.g. 'Over 1.5 hit rate: 74%') is the real historical success rate for that market at similar confidence — not a model estimate, but actual results from past picks.",
    use:     "Tap '+ Add to Ticket' on the card. Start here for any fixture — it's the lowest-risk anchor for your ticket.",
    caution: "Limited data badge means few match games played (early season or limited history). volatile means the league has high variance — the pick can still be right but risk is higher than the numbers suggest.",
  },
  {
    id: "edge", emoji: "🔮", title: "THE EDGE", sub: "value pick", color: () => C.edge,
    what:    "A secondary pick where the model's probability is meaningfully higher than what the bookmaker's odds are implying.",
    telling: "The book looks like it may have mispriced this outcome. The '+X% vs BOOK' figure shows the gap. Two signals or more means multiple checks converged on the same market.",
    use:     "Works best alongside The Read in a 2-leg ticket. On its own, only worth taking if the edge is solid (+5% or more vs book). If you see 'value unclear', leave it.",
    caution: "More risk than The Read — it's a value call, not just a probability call. No Edge showing doesn't mean the model missed anything — it means the odds don't justify an edge play today.",
  },
  {
    id: "radar", icon: "radar", title: "GOAL RADAR", sub: "team scoring odds", color: () => C.radar,
    what:    "Per-team scoring probability — each team's chance of scoring at least once (O0.5) or more than once (O1.5). These are team total picks, separate from the main engine pool.",
    telling: "Which team the model expects to find the net, and how confidently. Only shows when the probability clears a minimum threshold — if it's not showing, the signal didn't qualify, not that no prediction exists.",
    use:     "Add as a team total leg in Custom or directly from the card. Good for confirming a BTTS read or adding a third leg. The O1.5 advisory (💡) is informational — add it via Custom if you want it in your ticket.",
    caution: "Team total odds are often low. Check the implied odds — if it's under 1.15, there's not enough value in the leg to justify the added risk it brings to a parlay.",
  },
  {
    id: "tags", emoji: "🏷", title: "STRATEGY TAGS", sub: "on the card", color: () => C.amber,
    what:    "Labels on each fixture showing which strategy conditions that game currently meets — Home Win, BTTS Value, Draw, Low Scoring, etc.",
    telling: "Each tag needs several conditions to be true at the same time, not just one high number. So a 'BTTS Value' tag means multiple model signals point the same way, not just a decent BTTS probability.",
    use:     "Head to the Custom tab and filter by a strategy to find every fixture meeting those conditions in one view — useful when you want to build around a specific angle.",
    caution: "A tag means conditions are met today. Not a guarantee. A Low Scoring tag on a volatile league still carries real variance — check the league context before building.",
  },
  {
    id: "enginetab", icon: "engine", title: "THE ENGINE TAB", sub: "today's qualified picks", color: () => C.gold,
    what:    "Only fixtures that cleared every quality gate — model confidence, empirical hit rate, data quality, and odds value — make it here. Sorted by engine score so the strongest picks are always at the top.",
    telling: "The engine scores picks using a weighted formula combining historical win rate and live model confidence. A pick needs both a high empirical rate (historically this market lands) and a high model confidence (this specific game qualifies) to appear here. The 'volatile' label on a card is informational only — it still passed the engine's checks, just flag it as a higher-variance league.",
    use:     "Use this tab as your shortlist before building. These are the games the system is most comfortable with today.",
    caution: "Fewer fixtures here doesn't mean a poor day — it means the bar wasn't cleared by many games. Don't force picks just because you want a longer list.",
  },
  {
    id: "custom", emoji: "🎛", title: "CUSTOM TAB", sub: "strategy filter view", color: () => C.radar,
    what:    "Browse all fixtures filtered by strategy and signal. Quick Tempo presets (one tap, pre-configured) sit at the top. Detailed Strategy shows all specific presets — Home Win, BTTS, Draw, Low Scoring etc — always visible.",
    telling: "Every fixture shown meets the active filter conditions. Sorted by model confidence so the strongest sits at the top. Signal chips (Model Pick, Goal Radar, Upcoming, Live) are binary toggles. Advanced holds all threshold controls — xG, Win %, Clean Sheet, Odds — collapsed by default but shows an ACTIVE badge when filters are set.",
    use:     "Step 1 — Choose a Quick Tempo preset or pick a Detailed Strategy. Step 2 — Tap fixtures to select them (finished games are blocked). Step 3 — Hit Add to Ticket. Your picks land in the draft as a banner — open the Parley System when you're ready.",
    caution: "If you try to add a fixture that's already in your draft with a different pick, you'll get a prompt to replace or keep the existing one — nothing replaces silently.",
  },
  {
    id: "parlay", icon: "parlay", title: "PARLEY SYSTEM", sub: "Jarvis · Custom · saved tickets", color: () => C.edge,
    what:    "Where you build, review, save, and book tickets. Two build modes: Jarvis (auto-builds the single best ticket from the qualified pool) and Custom (builds N non-overlapping tickets from the same pool).",
    telling: "Jarvis scores every qualified pick using a weighted formula — model confidence and empirical hit rate combined — then adds picks one by one until your target odds are hit. Custom does the same but across multiple tickets, making sure fixtures don't repeat.",
    use:     "Add legs from fixture cards first if you want specific picks, or open Jarvis to let it build from scratch. Remix shuffles Jarvis for a different combination. The ✕ on each leg removes it individually. Book directly from any ticket.",
    caution: "Draft legs are in-session only — they're not saved until you explicitly save the ticket. Saved tickets get a code you can use as a reference.",
  },
  {
    id: "rollover", emoji: "🔁", title: "ROLLOVER SYSTEM", sub: "10-step compounding chain", color: () => C.accent,
    what:    "A structured compounding system where the engine manages one slip per day across a 10-step chain. You put in a starting stake, the engine builds the daily pick, and your pot grows with each win.",
    telling: "The engine selects picks using a weighted scoring formula (empirical rate and model confidence combined), then adds legs one by one until combined odds clear 2.0×. The slip is locked for the day — it won't shift even if fixture states change. Steps 3, 5, and 7 are profit gates — 30% of your pot gets locked so you keep something even if the chain fails later.",
    use:     "Open the Rollover tab. Dashboard shows your current step and today's slip — book it there. Analytics shows the strategy pipeline and your ROI progress for the current chain. History shows past chains.",
    caution: "One loss resets the compounding progress for that chain — but locked profit stays. Don't manually override the engine slip just because it looks conservative. The picks are chosen for survival, not aggression.",
  },
  {
    id: "perf", emoji: "📊", title: "PERFORMANCE TAB", sub: "inside the parley system", color: () => C.muted,
    what:    "Historical hit rate for every pick the engine has made — broken down by market, strategy, confidence band, and day. The daily pool view now collapses by date so it's not overwhelming.",
    telling: "Which markets have been reliable, which are cold, and whether the confidence bands are calibrated (65% model confidence should be hitting around 65% of the time). The date filter at the top applies to everything — daily breakdown and all-read picks included.",
    use:     "Check before building tickets. If a specific market is running cold this week, think twice before stacking it. Tap a day row in the pool accordion to expand individual pick results.",
    caution: "Small samples (under 20 picks per market) swing wildly. Don't restructure your whole approach off a 5-pick run. Give it 30+ picks before drawing conclusions.",
  },
  {
    id: "jarvis", emoji: "🤖", title: "JARVIS", sub: "AI match assistant", color: () => C.accent,
    what:    "AI assistant with full access to every fixture's model data — xG, form, H2H, calibration quality, strategy tags, all of it.",
    telling: "Straight-language reasoning behind any pick or concern. It's not summarising generic football knowledge — it's reading the actual numbers the model produced for that specific game.",
    use:     "Tap 'Ask Jarvis' on any fixture card. Ask whatever you want: why this pick, any red flags, is the BTTS backed by both teams' form? The Mind Box at the top of the fixture list gives a daily overview across the whole card.",
    caution: "Jarvis explains the model — it doesn't override it. If it sounds uncertain or hedgy, that's because the underlying data is thin or the signals are conflicting. That's useful information in itself.",
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
              style={{ background:"transparent",border:"none",color:C.text,fontSize:18,padding:0,lineHeight:1 }}>✕</button>
          </div>
        </div>

        {/* Quick workflow */}
        <div style={{ margin:"14px 20px 6px",background:C.surface,borderRadius:10,
          border:`1px solid ${C.goldBorder}`,padding:"12px 14px" }}>
          <div style={{ fontSize:8,color:C.gold,fontWeight:800,letterSpacing:".12em",
            textTransform:"uppercase",marginBottom:10 }}>Quick Start — 3 Steps</div>
          {[
            ["1", C.blue,   "Tap FETCH",          "Load today's fixtures. The engine analyses every match."],
            ["2", C.green,  "Add to Ticket",       "Find a card with THE READ (best pick). Tap + Add to Ticket."],
            ["3", C.radar,  "Build & Book",         "Tap Parley System → Build → Book to SportyBet."],
          ].map(([n, col, title, desc]) => (
            <div key={n} style={{ display:"flex",gap:10,alignItems:"flex-start",marginBottom:8 }}>
              <div style={{ width:20,height:20,borderRadius:"50%",background:`${col}20`,
                border:`1px solid ${col}40`,display:"flex",alignItems:"center",justifyContent:"center",
                flexShrink:0,marginTop:1 }}>
                <span style={{ fontSize:9,fontWeight:800,color:col }}>{n}</span>
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
            return (
              <div key={sec.id} style={{ marginBottom:6,borderRadius:9,
                border:`1px solid ${isOpen ? col+"40" : C.border}`,
                background:isOpen ? `${col}06` : C.surface,
                overflow:"hidden",transition:"border-color .15s" }}>
                {/* Section header — always visible */}
                <button onClick={() => setOpenSection(isOpen ? null : sec.id)}
                  style={{ width:"100%",display:"flex",alignItems:"center",gap:10,
                    padding:"11px 14px",background:"transparent",border:"none",
                    cursor:"pointer",textAlign:"left",fontFamily:C.font }}>
                  <span style={{ fontSize:14,lineHeight:1,flexShrink:0 }}>{sec.emoji}</span>
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
                  <span style={{ fontSize:9,color:C.text,opacity:.35,flexShrink:0 }}>
                    {isOpen ? "▲" : "▼"}
                  </span>
                </button>

                {/* Expanded content */}
                {isOpen && (
                  <div style={{ padding:"0 14px 14px",display:"flex",flexDirection:"column",gap:10 }}>
                    {[
                      { label:"What it is",           text: sec.what,    labelColor: C.text },
                      { label:"What it's telling you", text: sec.telling, labelColor: col   },
                      { label:"How to use it",         text: sec.use,     labelColor: C.green },
                      { label:"When to be cautious",   text: sec.caution, labelColor: C.amber },
                    ].map(({ label, text, labelColor }) => (
                      <div key={label}>
                        <div style={{ fontSize:7,fontWeight:800,color:labelColor,opacity:.8,
                          textTransform:"uppercase",letterSpacing:".1em",marginBottom:3 }}>
                          {label}
                        </div>
                        <div style={{ fontSize:9,color:C.text,opacity:.8,lineHeight:1.6 }}>
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
// Flag: grm_onboarded_v2 in localStorage (bumped from v1 so existing users see updated tutorial).
// Onboarding slide SVG icons — no emoji
const ONBOARD_ICONS = [
  <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>,
  <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3"/><path d="M12 1v4M12 19v4M4.22 4.22l2.83 2.83M16.95 16.95l2.83 2.83M1 12h4M19 12h4M4.22 19.78l2.83-2.83M16.95 7.05l2.83-2.83"/></svg>,
  <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>,
  <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M3 9V7a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v2a3 3 0 0 0 0 6v2a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-2a3 3 0 0 0 0-6z"/><path d="M13 5v14"/></svg>,
  <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><polyline points="23 6 13.5 15.5 8.5 10.5 1 18"/><polyline points="17 6 23 6 23 12"/></svg>,
  <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/></svg>,
];

const ONBOARD_SLIDES = [
  {
    color:   () => C.blue,
    title:   "Fetch today's fixtures",
    body:    "Tap FETCH and the engine loads every fixture for the day, runs each one through the model, and scores every market. Then you have the full picture.",
    tip:     "You can load past dates too. Results auto-merge so you can review how picks landed.",
  },
  {
    color:   () => C.gold,
    title:   "Three signals per match",
    body:    "The Read is the model's highest-confidence pick. The Edge is where the model thinks the bookmaker's odds are wrong. Goal Radar shows which team is expected to score. Tap Full Model on any card for the complete breakdown.",
    tip:     "Strong badge means the model is especially confident. Limited data means fewer than 10 season games — treat with caution.",
  },
  {
    color:   () => C.accent,
    title:   "The Engine tab",
    body:    "Not every fixture qualifies. The Engine tab only shows games that cleared every quality threshold — model confidence, historical hit rate, and odds value. Sorted by engine score.",
    tip:     "A short engine list is not a bad sign. It means fewer games cleared the bar today — quality over volume.",
  },
  {
    color:   () => C.edge,
    title:   "Build your ticket",
    body:    "Tap Add to Ticket on any pick to add it to your draft. Open the Parlay System to review. Jarvis builds the best ticket automatically. Custom lets you hand-pick from the fixture list.",
    tip:     "Remix shuffles Jarvis for a different combination. The X on each leg removes it individually.",
  },
  {
    color:   () => C.green,
    title:   "Rollover compound engine",
    body:    "A 10-step compounding chain. The engine picks one optimised slip per day and manages your stake across steps. Profit gates at steps 3, 5, and 7 lock secured gains even if the chain fails later.",
    tip:     "The daily slip locks at build time. It will not change even if fixture states update during the day.",
  },
  {
    color:   () => C.radar,
    title:   "Book and track",
    body:    "Built a ticket you like? Hit Book Now to send it straight to your bookmaker — picks pre-load automatically. The Performance tab tracks hit rate by market and day.",
    tip:     "Saved tickets get a shareable code. Use it as a reference or to reload a past build.",
  },
];

function FirstRunFlow({ onDone }) {
  const [slide, setSlide] = useState(0);
  const total = ONBOARD_SLIDES.length;
  const s     = ONBOARD_SLIDES[slide];
  const col   = s.color();
  const icon  = ONBOARD_ICONS[slide];

  const finish = () => {
    try { localStorage.setItem("grm_onboarded_v3", "1"); } catch {}
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
      {/* Skip */}
      <button onClick={finish} className="gb-ghost"
        style={{ position:"absolute", top:20, right:20, padding:"6px 14px", fontSize:10, opacity:.6 }}>
        Skip
      </button>

      <div style={{ width:"100%", maxWidth:360, display:"flex", flexDirection:"column",
                    alignItems:"center", textAlign:"center", flex:1, justifyContent:"center", gap:22 }}>

        {/* Icon circle — SVG, no emoji */}
        <div style={{
          width:76, height:76, borderRadius:"var(--r-xl)",
          background:`${col}14`, border:`1px solid ${col}35`,
          display:"flex", alignItems:"center", justifyContent:"center",
          color:col,
        }}>
          {icon}
        </div>

        {/* Step progress */}
        <div style={{ display:"flex", gap:5, width:"100%" }}>
          {ONBOARD_SLIDES.map((_,i) => (
            <div key={i} style={{
              flex:1, height:3, borderRadius:2,
              background: i <= slide ? col : "var(--glass-border)",
              transition:"background .25s",
            }}/>
          ))}
        </div>

        {/* Step counter + title */}
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

        {/* Tip */}
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

      {/* Buttons */}
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
// One-time tooltip above the floating Parley System button.
// Shows after fixtures first load, auto-dismisses after 5s.
// Flag: grm_parlay_nudge_seen
function ParlayNudge({ onDismiss }) {
  useEffect(() => {
    const t = setTimeout(onDismiss, 5000);
    return () => clearTimeout(t);
  }, []);

  return (
    <div style={{ position:"fixed",bottom:100,right:16,zIndex:160,maxWidth:220,
      background:C.modalBg,border:`1px solid ${C.edgeBorder}`,borderRadius:10,
      padding:"10px 12px",boxShadow:`0 4px 20px rgba(0,0,0,0.5)`,
      animation:"fadeUp .3s ease forwards" }}>
      {/* Arrow pointing down to button */}
      <div style={{ position:"absolute",bottom:-7,right:28,width:12,height:12,
        background:C.modalBg,border:`1px solid ${C.edgeBorder}`,
        transform:"rotate(45deg)",borderTop:"none",borderLeft:"none" }}/>
      <div style={{ display:"flex",justifyContent:"space-between",
        alignItems:"flex-start",gap:8,marginBottom:5 }}>
        <span style={{ fontSize:9,fontWeight:800,color:C.edge,letterSpacing:".06em",
          textTransform:"uppercase" }}>Parley System</span>
        <button onClick={onDismiss} style={{ background:"none",border:"none",
          color:C.text,cursor:"pointer",fontSize:11,padding:0,lineHeight:1,flexShrink:0 }}>✕</button>
      </div>
      <div style={{ fontSize:8,color:C.text,opacity:.7,lineHeight:1.55 }}>
        Tap here for today's engine picks, ticket builder and performance history.
      </div>
    </div>
  );
}

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
  const [legacySnapshot, setLegacySnapshot] = useState(false);

  const [tab, setTab]             = useState("all");
  const [search, setSearch]       = useState("");
  const [leagueFilter, setLeagueFilter] = useState(null);
  const [sortActive,   setSortActive]   = useState(new Set());
  const [frozenFixtures, setFrozenFixtures] = useState([]); // engine pool snapshot — set at fetch, never updated by live polling

  const [budget, setBudget]       = useState(100);
  const [budgetPct, setBudgetPct] = useState(100); // slider removed — always stake full budget
  const [numParlays, setNumParlays] = useState(2);
  const [targetOdds, setTargetOdds] = useState(5);
  const [marketFilter, setMarketFilter] = useState(["theRead"]);
  const toggleMarket = id => setMarketFilter(prev => prev.includes(id) ? (prev.length>1?prev.filter(x=>x!==id):prev) : [...prev, id]);

  const [tickets, setTickets]     = useState([]);
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
    try { return !localStorage.getItem("grm_onboarded_v3"); } catch { return false; }
  });
  const [showCustomBanner, setShowCustomBanner] = useState(() => {
    try { return !localStorage.getItem("grm_custom_onboarded_v1"); } catch { return false; }
  });
  const [showParlayNudge, setShowParlayNudge] = useState(false);
  const parlayNudgeShownRef = useRef(false);

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
  const onFullModelFromParlay   = useCallback(f => { setFullModelReturnTab("parlay"); setMainFocusFixture(f); }, []);
  const onFullModelFromRollover = useCallback(f => { setMainView("main"); setFullModelReturnTab("rollover"); setMainFocusFixture(f); }, []);

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
      const s = JSON.stringify(payload);
      if (s.length * 2 > 4*1024*1024) return;
      localStorage.setItem(key, s);
    } catch {}
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
      const { date:d, data } = JSON.parse(raw);
      // Validate shape — old-schema fixtures missing teams/markets crash FixtureCard.
      // A fixture without both fields is useless anyway so discard the whole cache.
      const valid = Array.isArray(data) && data.length > 0 &&
                    data.every(f => f && f.teams && f.markets);
      if (d === date && valid) { const fd = applyFinishedStates(data); setFixtures(fd); setCached(true); setFrozenFixtures(fd); }
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
    setLoading(true); setError(null); setCached(false); setLegacySnapshot(false); setTickets([]);
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
              const _fd1 = applyFinishedStates(data); setFixtures(_fd1); safeCacheWrite(CACHE_KEY, { date, data }); setFrozenFixtures(_fd1);
              if (data.length && !parlayNudgeShownRef.current) {
                try {
                  if (!localStorage.getItem("grm_parlay_nudge_seen")) {
                    parlayNudgeShownRef.current = true;
                    setTimeout(() => setShowParlayNudge(true), 1200);
                  }
                } catch {}
              }
              if (json.legacySchema) setLegacySnapshot(true);
              setProgress(100); setProgressStage("done"); setProgressMsg(`${data.length} fixtures ready`);
              if (data.length) {
                const capturedDate = date;
                (async () => {
                  let rates = historicalRates;
                  if (!rates || historicalRatesDateRef.current !== todayStr()) rates = await ensureHistoricalRates();
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
      if (data.length && !parlayNudgeShownRef.current) {
        try {
          if (!localStorage.getItem("grm_parlay_nudge_seen")) {
            parlayNudgeShownRef.current = true;
            setTimeout(() => setShowParlayNudge(true), 1200);
          }
        } catch {}
      }
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
      setError(e.message); setProgressStage("error"); setProgressMsg(e.message);
    } finally {
      // Only stop loading on the synchronous path.
      // The 202 async path sets isSyncPath=false and manages its own loading state.
      if (isSyncPath) { stopPolling(); setLoading(false); }
    }
  }, [date]);

  const loadSnapshot = useCallback(async snapDate => {
    stopPolling();
    setLoading(true); setError(null); setCached(false); setLegacySnapshot(false); setTickets([]);
    setProgress(20); setProgressStage("loading"); setProgressMsg("Loading snapshot…");
    try {
      const res = await fetch(`${SERVER}/api/load-snapshot?date=${snapDate}`);
      if (!res.ok) { const e = await res.json().catch(()=>({})); throw new Error(e.error||res.statusText); }
      const json = await res.json(), data = Array.isArray(json.data) ? json.data : [];
      setFixtures(data); setDate(snapDate); setCached(true); setFrozenFixtures(data);
      startAutoRefresh(snapDate);
      if (json.legacySchema) setLegacySnapshot(true);
      setProgress(100); setProgressStage("done"); setProgressMsg(`${data.length} fixtures loaded`);

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
    } catch(e) { setError(e.message); }
    finally { setLoading(false); }
  }, []);

  const ensureHistoricalRates = async () => {
    const today = todayStr();
    if (historicalRates && historicalRatesDateRef.current === today) return historicalRates;
    try {
      const res = await fetch(`${SERVER}/api/backtest-summary`);
      const data = await res.json();
      setHistoricalRates(data); historicalRatesDateRef.current = today;
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
    setFixtures(prev => {
      if (!prev.length) return prev;
      const freshMap = new Map(freshData.map(f => [f.id, f]));
      let changed = false;
      const next = prev.map(f => {
        const fresh = freshMap.get(f.id);
        if (!fresh) return f;
        const scoreChanged = fresh.hGoals !== f.hGoals || fresh.aGoals !== f.aGoals || fresh.state !== f.state;
        if (!scoreChanged) return f;
        changed = true;
        return {
          ...f,
          hGoals:      fresh.hGoals,
          aGoals:      fresh.aGoals,
          state:       fresh.state,
          finished:    fresh.finished,
          result:      fresh.result,
          readResult:  fresh.readResult,
          edgeResult:  fresh.edgeResult,
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
        // Server has live data — apply patches normally
        const patchMap = new Map(data.states.map(s => [s.id, s]));
        setFixtures(prev => prev.map(f => {
          const p = patchMap.get(f.id);
          if (!p) return f;
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
        }));
        if (data.liveCount > 0) setLastResultsRefresh(new Date().toLocaleTimeString([],{hour:"2-digit",minute:"2-digit"}));
      } else {
        // Server has no data (backing off 403) — apply time-based fallback
        setFixtures(prev => prev.map(f => {
          const inferred = inferStateFromTime(f);
          if (!inferred) return f;
          if (inferred.state === f.state) return f;
          return { ...f, ...inferred };
        }));
      }
    } catch {
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
    pollLiveStates(date);
    liveTickerRef.current = setInterval(() => pollLiveStates(date), 60_000);
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

  const TABS = [
    { id:"all",    label:`All (${counts.total})` },
    { id:"engine", label:`The Engine (${enginePool.length})`, color:C.gold },
    { id:"custom", label:"Custom",                           color:C.text },
  ];

  const filtered = useMemo(() => {
    if (tab === "custom") return fixtures;
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
      if (sortActive.has("upcoming"))   list = list.filter(f => {
        const s = (f.state||"").toLowerCase().replace(/[\s_\-]/g,"");
        return s===""||s==="notstarted"||s==="scheduled"||s==="prematch";
      });
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
            {/* Status indicators — compact, low-hierarchy */}
            {cached && (
              <span style={{ fontSize:9,color:C.muted,fontWeight:400,opacity:.7 }}>cached</span>
            )}
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
          <div className="grm-header-subnav" style={{ borderTop:`1px solid var(--glass-border)`,paddingTop:2 }}>
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
            ].map(({ id, label, icon }) => (
              <button key={id} onClick={() => setActiveTab(id)}
                className={`grm-pill grm-pill-accent${activeTab===id?" active":""}`}
                style={{ display:"flex",alignItems:"center",gap:6,fontSize:11,padding:"8px 14px" }}>
                <span style={{ color:activeTab===id?"var(--accent)":"var(--muted)",display:"flex" }}>{icon}</span>
                {label}
              </button>
            ))}
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
              <input type="text" placeholder="Search teams or leagues…" value={search}
                onChange={e=>setSearch(e.target.value)} className="gi"
                style={{ flex:1,fontSize:11 }}/>
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
            position:"absolute",top:0,right:0,height:"100%",width:290,
            background:C.modalBg,borderLeft:`1px solid ${C.border}`,
            overflowY:"auto",display:"flex",flexDirection:"column",gap:0,
            transform:"translateX(0)",
          }}>
            {/* Drawer header */}
            <div style={{ padding:"14px 16px",borderBottom:`1px solid ${C.border}`,display:"flex",justifyContent:"space-between",alignItems:"center",position:"sticky",top:0,background:C.modalBg,zIndex:1 }}>
              <span style={{ fontSize:12,fontWeight:800,color:C.text,letterSpacing:".05em" }}>FILTERS</span>
              <button onClick={() => setDrawerOpen(false)} className="gb"
                style={{ background:"transparent",border:"none",color:C.text,fontSize:16,padding:"2px 8px" }}>✕</button>
            </div>

            <div style={{ padding:"14px 16px",display:"flex",flexDirection:"column",gap:14 }}>
              {/* League Filter — all tabs including custom */}
              {availableLeagues.length > 1 && (
                <div>
                  <div style={{ fontSize:8,color:C.text,fontWeight:800,textTransform:"uppercase",letterSpacing:".12em",marginBottom:6 }}>League</div>
                  <LeagueFilter availableLeagues={availableLeagues} leagueFilter={leagueFilter} setLeagueFilter={setLeagueFilter} />
                </div>
              )}

              {/* Sort/Filter — all tabs including custom */}
              <div>
                <div style={{ fontSize:8,color:C.text,fontWeight:800,textTransform:"uppercase",letterSpacing:".12em",marginBottom:6 }}>Sort & Filter</div>
                <SortFilter active={sortActive} setActive={setSortActive} />
              </div>

              {/* Theme */}
              <div>
                <div style={{ fontSize:8,color:C.text,fontWeight:800,textTransform:"uppercase",letterSpacing:".12em",marginBottom:6 }}>Appearance</div>
                <button onClick={() => { setThemePickerOpen(true); setDrawerOpen(false); }} className="gb"
                  style={{ background:C.accentDim,border:`1px solid ${C.accentBorder}`,color:C.accent,padding:"7px 14px",fontSize:10,width:"100%" }}>
                  Change Theme
                </button>
              </div>

              {/* Admin controls — only when adminMode */}
              {adminMode && (
                <div>
                  <div style={{ fontSize:8,color:C.red,fontWeight:800,textTransform:"uppercase",letterSpacing:".12em",marginBottom:6 }}>Admin</div>
                  <div style={{ display:"flex",flexDirection:"column",gap:6 }}>
                    <button onClick={() => { fetchData(true); setDrawerOpen(false); }} disabled={loading} className="gb"
                      style={{ background:"transparent",border:`1px solid ${C.radar}50`,color:C.radar,padding:"7px 12px",fontSize:9 }}>
                      ↺ Force Refresh
                    </button>
                    {fixtures.length > 0 && (
                      <button onClick={async () => {
                        try {
                          const res = await fetch(`${SERVER}/api/refresh-odds?date=${date}`, { method:"POST", headers:{"x-admin-token": adminToken} });
                          const d = await res.json();
                          if (d.updated) { const r = await fetch(`${SERVER}/api/load-snapshot?date=${date}`); const j = await r.json(); if (j.data) { setFixtures(j.data); setLastResultsRefresh(new Date().toLocaleTimeString([],{hour:"2-digit",minute:"2-digit"})); } }
                          // Auto-fetch after odds refresh — no need to manually hit Fetch again
                          await fetchData(true);
                        } catch {}
                        setDrawerOpen(false);
                      }} className="gb"
                        style={{ background:"transparent",border:`1px solid ${C.gold}50`,color:C.gold,padding:"7px 12px",fontSize:9 }}>
                        $ Refresh Odds
                      </button>
                    )}
                  </div>
                </div>
              )}

              {/* Lock/Unlock admin + Help */}
              <div style={{ display:"flex",flexDirection:"column",gap:6,marginTop:4 }}>
                <button onClick={() => { toggleAdmin(); setDrawerOpen(false); }} className="gb"
                  style={{ background:adminMode?C.redDim:"transparent",border:`1px solid ${adminMode?C.red:C.faint}`,color:adminMode?C.red:C.text,padding:"7px 12px",fontSize:9 }}>
                  {adminMode ? "Lock Admin" : "Admin"}
                </button>
                <button onClick={() => { setHelpOpen(true); setDrawerOpen(false); }} className="gb"
                  style={{ background:"transparent",border:`1px solid ${C.faint}`,color:C.text,padding:"7px 12px",fontSize:9 }}>
                  Learn how it works
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {activeTab === "backtest" && mainView === "main" && (
        <div style={{ padding:"16px 14px" }}>
          <BacktestTab loadSnapshot={loadSnapshot} adminMode={adminMode} adminToken={adminToken} onReloadFixtures={async (d) => { if (d === date) { const r = await fetch(`${SERVER}/api/load-snapshot?date=${d}`); const j = await r.json(); if (j.data) { setFixtures(j.data); setLastResultsRefresh(new Date().toLocaleTimeString([],{hour:"2-digit",minute:"2-digit"})); } } }} />
        </div>
      )}

      {activeTab === "code" && mainView === "main" && (
        <div style={{ padding:"16px 14px" }}>
          <CodeAnalyzer theme={theme} SERVER={SERVER}
            onOpenFullModel={(fixture) => {
              setMainFocusFixture(fixture);
              setFullModelReturnTab("code");
            }}
            onSendToDraft={(legs) => {
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
            // Merge: incoming legs replace any existing leg for the same fixtureId,
            // and are appended for fixtureIds not yet in the draft.
            // This preserves picks the user already added from the fixture list.
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
            setParlayJarvisOpen(true);
          }} />
        </div>
      )}

      {/* Stats tab — rendered at GRMPro level via bottom nav */}
      {activeTab === "perf" && mainView === "main" && <PoolPerformanceTab serverUrl={SERVER} />}

      {/* Rollover — rendered at GRMPro level via bottom nav */}
      {mainView === "rollover" && (
        <RolloverSystem
          C={C}
          SERVER={SERVER}
          fixtures={fixtures}
          historicalRates={historicalRates}
          date={date}
          buildRolloverPick={buildRolloverPick}
          buildUniversalPool={buildUniversalPool}
          onFullModel={onFullModelFromRollover}
        />
      )}

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
                  {showCustomBanner && (
                    <CustomTabBanner onDismiss={() => {
                      setShowCustomBanner(false);
                      try { localStorage.setItem("grm_custom_onboarded_v1","1"); } catch {}
                    }} />
                  )}
                  <CustomListView
                    fixtures={fixtures} search={search}
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

      {/* Parlay button one-time nudge */}
      {showParlayNudge && (
        <ParlayNudge onDismiss={() => {
          setShowParlayNudge(false);
          try { localStorage.setItem("grm_parlay_nudge_seen","1"); } catch {}
        }} />
      )}

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
          setParlayJarvisOpen(false); // always close parley overlay on nav switch
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
    </div>
  );
}
