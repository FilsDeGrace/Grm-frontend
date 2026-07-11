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
import { enrichGamesForDate, buildBasketballRolloverPool, buildBasketballRolloverPick } from "./BasketballEngine";
import { toFixtureShape, getPickFamilies, getMarketStyle, getProgressLabel, getSportConfig } from "./sportConfig";

// A10-FIX: SAVED_TICKETS_KEY declared at module top so loadSavedTickets()
// and persistTickets() — both hoisted function declarations — never hit a
// temporal dead zone when called before line 4881 executes.
const SAVED_TICKETS_KEY  = "grm_saved_tickets_v15";
// Built tickets are date-keyed and persist in localStorage — they survive
// refreshes and tab closes, and remain until the user removes them manually.
const BUILT_TICKETS_KEY  = (date) => `grm_built_tickets_${date}`;

// UX-FIX: shared helper to translate raw fetch/network error text into a graceful,
// actionable message instead of showing the browser's literal "Failed to fetch" (or
// similar low-level strings) to the user. Used anywhere a fetch() call can throw —
// the main FETCH flow, snapshot loading, booking, uploads, etc.
//
// Also handles raw bookmaker API error text that leaks through as non-JSON responses
// (e.g. SportyBet / Duel returning plain-text "Internal Server Error" or HTML pages).
// sanitizeBookmakerError() is the booking-specific path — it strips HTML tags, trims
// to a safe length, and maps known bookmaker phrases to actionable user messages.
function friendlyError(e, context = "Server") {
  const msg = (e && e.message) || String(e || "");
  if (/Failed to fetch|NetworkError|ERR_NAME_NOT_RESOLVED|ERR_INTERNET_DISCONNECTED|net::ERR|TypeError: Load failed/i.test(msg)) {
    return "Can't reach the server — check your connection and try again.";
  }
  if (/timed? ?out|ETIMEDOUT|AbortError/i.test(msg)) {
    return "That took too long to respond. Try again in a moment.";
  }
  if (/\b50[0-9]\b/.test(msg)) {
    return `${context} is having issues right now — try again shortly.`;
  }
  if (/\b401\b|unauthori[sz]ed/i.test(msg)) {
    return `${context} rejected the request — session may have expired. Refresh and try again.`;
  }
  if (/\b403\b|forbidden/i.test(msg)) {
    return `${context} denied access — the bookmaker may have blocked this request temporarily.`;
  }
  if (/\b429\b|too many requests|rate.?limit/i.test(msg)) {
    return "Too many requests — wait a moment and try again.";
  }
  return msg || `${context} error — please try again.`;
}

// Sanitize raw bookmaker error text into a short, user-safe message.
// Called when res.json() fails (backend returned plain text / HTML) OR when
// data.error contains a raw bookmaker API message the backend forwarded as-is.
// Strips HTML tags, collapses whitespace, caps length, then maps known phrases.
function sanitizeBookmakerError(raw, bookmakerLabel = "Bookmaker") {
  if (!raw) return `${bookmakerLabel} returned an error — please try again.`;
  // Strip HTML tags (backend may forward HTML error pages)
  const stripped = String(raw).replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
  const low = stripped.toLowerCase();
  // Map known bookmaker/server phrases to friendly messages
  if (/internal server error|500/i.test(low))
    return `${bookmakerLabel} is having issues right now — try again in a moment.`;
  // 35-FIX: was falling through to the generic "not found" branch below,
  // which drops the "check kickoff time or try another bookmaker" guidance
  // server.js's isNoMatch branch already provides. Checked first so it wins.
  if (/no selections resolved|no confident event match|not priced/i.test(low))
    return `Game(s) not found or not priced on ${bookmakerLabel} — check kickoff time or try another bookmaker.`;
  if (/not found|404/i.test(low))
    return `${bookmakerLabel} couldn't find this fixture — it may not be listed yet.`;
  if (/unauthori[sz]ed|401/i.test(low))
    return `${bookmakerLabel} rejected the session — refresh and try again.`;
  if (/forbidden|403/i.test(low))
    return `${bookmakerLabel} denied this request — try again shortly.`;
  if (/timeout|timed out|etimedout/i.test(low))
    return `${bookmakerLabel} took too long to respond — try again.`;
  if (/rate.?limit|too many/i.test(low))
    return "Too many requests — wait a moment and try again.";
  if (/invalid.?bet|invalid.?selection|market.?not.?avail/i.test(low))
    return "One or more selections aren't available on this bookmaker right now.";
  if (/match.?not.?found|event.?not.?found|fixture.?not.?found/i.test(low))
    return `Match not found on ${bookmakerLabel} — it may not be listed yet.`;
  // Unknown raw text — truncate to 120 chars so nothing scary leaks to UI
  const safe = stripped.length > 120 ? stripped.slice(0, 120) + "…" : stripped;
  // If it looks like it still has HTML remnants or non-human text, replace entirely
  if (/[<>{};]|DOCTYPE|html|script/i.test(safe))
    return `${bookmakerLabel} returned an unexpected response — please try again.`;
  return safe || `${bookmakerLabel} returned an error — please try again.`;
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
// B-FIX (foundation): stamp `.date` onto every fixture at load time. Fixture
// objects didn't carry their own date before — needed both for the Fixture
// Share deep link (A) to know what date a shared fixture came from, and as
// the foundation for Multi-Date Live Model (B), where a single `fixtures`
// array will eventually hold fixtures from more than one date at once.
// Additive only: never overwrites a date a fixture already carries.
function stampFixtureDates(fixturesArr, d) {
  if (!Array.isArray(fixturesArr) || !d) return fixturesArr;
  return fixturesArr.map(f => (f && !f.date) ? { ...f, date: d } : f);
}

// Usage: copyToClipboard(text, onSuccess?, onError?)
export function copyToClipboard(text, onSuccess, onError) {
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
    const a = f.theRead.anchor, mst = mktStyle(a.market, f._sport);
    return { label:a.pick, prob:a.prob, odds:a.odds||io(a.prob), color:mst.color, market:a.market };
  }
  if (family === "theEdge") {
    if (!f.theEdge) return null;
    return { label:f.theEdge.pick, prob:f.theEdge.prob, odds:f.theEdge.odds||io(f.theEdge.prob), color:C?.edge, market:f.theEdge.market };
  }
  if (family === "goalRadar") {
    // football only — f.goalRadar is always null for basketball (set in
    // toFixtureShape), so this naturally returns null for BB without a guard
    const best = f.goalRadar?.home?.prob >= f.goalRadar?.away?.prob ? f.goalRadar?.home : f.goalRadar?.away;
    if (!best) return null;
    return { label:best.pick, prob:best.prob, odds:best.odds||io(best.prob), color:C?.radar, market:"TeamTotal" };
  }

  // ── BASKETBALL / TENNIS — market-odds-only families ───────────────────
  // These resolve directly from f.odds._raw since neither engine currently
  // produces confidence-scored predictions for these markets (see ENGINE GAP
  // notes in sportConfig.js). Each helper below pulls the first matching
  // market+choice pair and converts fractional odds to decimal + implied prob.
  if (f._sport === "basketball" || f._sport === "tennis") {
    const fracToDecimal = (frac) => {
      if (typeof frac === "number") return frac;
      if (typeof frac === "string" && frac.includes("/")) {
        const [n, d] = frac.split("/").map(Number);
        if (!isNaN(n) && !isNaN(d) && d > 0) return parseFloat((n/d + 1).toFixed(2));
      }
      return null;
    };
    const impliedFromDecimal = (dec) => dec > 1 ? Math.round((1/dec) * 100) : null;
    const raw = f.odds?._raw || {};

    // Home/Away handicap — find the "Handicap" market, pick the favourite/dog line
    if (family === "homehandicap" || family === "awayhandicap") {
      const hcMarket = raw["Handicap"] || raw["Handicap (incl. overtime)"] || null;
      if (!hcMarket) return null;
      const isHome = family === "homehandicap";
      // Lines are keyed like "-7.5" / "+7.5" — pick first negative for home, positive for away
      const lineKey = Object.keys(hcMarket).find(k =>
        isHome ? k.trim().startsWith("-") : k.trim().startsWith("+")
      );
      if (!lineKey) return null;
      const dec = fracToDecimal(hcMarket[lineKey]);
      if (dec == null) return null;
      const teamName = isHome ? f.teams.home : f.teams.away;
      return { label:`${teamName} ${lineKey}`, prob:impliedFromDecimal(dec), odds:dec, color:C?.blue, market:"Handicap" };
    }

    // Team Total (radar equivalent) — find "<TeamName> Over/Under" market
    if (family === "teamtotal_home" || family === "teamtotal_away") {
      const isHome   = family === "teamtotal_home";
      const teamName = isHome ? f.teams.home : f.teams.away;
      const marketKey = Object.keys(raw).find(k => k.toLowerCase().includes(teamName.toLowerCase()));
      if (!marketKey) return null;
      const lines = raw[marketKey];
      const firstLine = Object.keys(lines || {})[0];
      if (!firstLine) return null;
      const overFrac = lines[firstLine]?.["Over"] ?? lines[firstLine]?.Over;
      const dec = fracToDecimal(overFrac);
      if (dec == null) return null;
      return { label:`${teamName} O${firstLine}`, prob:impliedFromDecimal(dec), odds:dec, color:C?.radar, market:"Team Total" };
    }

    // Quarter winner — find "<N>(st|nd|rd|th) quarter - 1x2" market
    const Q_ORD = { q1_winner:"1st", q2_winner:"2nd", q3_winner:"3rd", q4_winner:"4th" };
    if (Q_ORD[family]) {
      const ord = Q_ORD[family];
      const marketKey = Object.keys(raw).find(k => k.toLowerCase().includes(`${ord.toLowerCase()} quarter`) && k.toLowerCase().includes("1x2"));
      if (!marketKey) return null;
      const choices = raw[marketKey];
      const dec = fracToDecimal(choices?.["Home"] ?? choices?.["1"]);
      if (dec == null) return null;
      return { label:`${f.teams.home} ${ord} Qtr`, prob:impliedFromDecimal(dec), odds:dec, color:C?.gold, market:"Quarter Winner" };
    }

    // Q1 margin — "1st quarter - winning margin"
    if (family === "q1_margin") {
      const marketKey = Object.keys(raw).find(k => k.toLowerCase().includes("1st quarter") && k.toLowerCase().includes("margin"));
      if (!marketKey) return null;
      const choices = raw[marketKey];
      const dec = fracToDecimal(choices?.["Home by 3+"]);
      if (dec == null) return null;
      return { label:`${f.teams.home} by 3+ (Q1)`, prob:impliedFromDecimal(dec), odds:dec, color:C?.dc, market:"Quarter Margin" };
    }

    // 1st Half Handicap
    if (family === "fh_handicap") {
      const marketKey = Object.keys(raw).find(k => k.toLowerCase().includes("1st half") && k.toLowerCase().includes("handicap"));
      if (!marketKey) return null;
      const choices = raw[marketKey];
      const lineKey = Object.keys(choices || {}).find(k => k.trim().startsWith("-"));
      if (!lineKey) return null;
      const dec = fracToDecimal(choices[lineKey]);
      if (dec == null) return null;
      return { label:`${f.teams.home} ${lineKey} (1H)`, prob:impliedFromDecimal(dec), odds:dec, color:C?.blue, market:"1st Half Handicap" };
    }

    // Tennis set handicap
    if (family === "sethandicap_h" || family === "sethandicap_a") {
      const marketKey = Object.keys(raw).find(k => k.toLowerCase().includes("set handicap"));
      if (!marketKey) return null;
      const choices = raw[marketKey];
      const isHome = family === "sethandicap_h";
      const lineKey = Object.keys(choices || {}).find(k => isHome ? k.trim().startsWith("-") : k.trim().startsWith("+"));
      if (!lineKey) return null;
      const dec = fracToDecimal(choices[lineKey]);
      if (dec == null) return null;
      const teamName = isHome ? f.teams.home : f.teams.away;
      return { label:`${teamName} ${lineKey} sets`, prob:impliedFromDecimal(dec), odds:dec, color:C?.blue, market:"Set Handicap" };
    }

    // homewin / awaywin / over_total / under_total for BB/tennis use the
    // SAME family IDs as football but need different resolution since BB/tennis
    // markets/probability fields differ:
    if (family === "homewin") {
      if (m.homeWin == null) return null;
      return { label:`${f.teams.home} Win`, prob:m.homeWin, odds:f.odds?.o1||io(m.homeWin), color:C?.gold, market:"Moneyline" };
    }
    if (family === "awaywin") {
      if (m.awayWin == null) return null;
      return { label:`${f.teams.away} Win`, prob:m.awayWin, odds:f.odds?.o2||io(m.awayWin), color:C?.gold, market:"Moneyline" };
    }
    if (family === "over_total" && f._totalSignal) {
      return { label:`Over ${f._totalSignal.line}`, prob:f._totalSignal.direction === "OVER" ? f._totalSignal.confidence : 100 - f._totalSignal.confidence, odds:null, color:C?.green, market:"Total" };
    }
    if (family === "under_total" && f._totalSignal) {
      return { label:`Under ${f._totalSignal.line}`, prob:f._totalSignal.direction === "UNDER" ? f._totalSignal.confidence : 100 - f._totalSignal.confidence, odds:null, color:C?.blue, market:"Total" };
    }
    return null; // unrecognised family for this sport — fail safe, no crash
  }

  // ── FOOTBALL — existing logic, completely UNCHANGED below this line ────
  if (family === "dc1x") {
    const prob = m.dc1X ?? (m.homeWin != null && m.draw != null ? Math.min(99, m.homeWin + m.draw) : null);
    if (prob == null) return null;
    return { label:"Home or Draw", prob, odds:f.odds?.dc1X || io(prob), color:C?.gold, market:"DC" };
  }
  if (family === "dc2x") {
    const prob = m.dcX2 ?? (m.draw != null && m.awayWin != null ? Math.min(99, m.draw + m.awayWin) : null);
    if (prob == null) return null;
    return { label:"Away or Draw", prob, odds:f.odds?.dcX2 || io(prob), color:C?.gold, market:"DC" };
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
  { id:"dc1x",label:"DC 1X" }, { id:"dc2x",label:"DC X2" },
  { id:"homeo05",label:"H O0.5" }, { id:"homeo15",label:"H O1.5" }, { id:"awayo05",label:"A O0.5" }, { id:"awayo15",label:"A O1.5" },
];

// ══════════════════════════════════════════════════════════════════════════
// SA PATTERN ENGINE — client-side port of strategy-analyst.mjs's feature
// extraction, so validated patterns from sa-patterns.json can be matched
// against live fixtures. Every formula below is a 1:1 mirror of the offline
// miner (same buckets, same thresholds) so a fixture that would have matched
// a pattern during training matches it here too. Admin-only feature.
// ══════════════════════════════════════════════════════════════════════════

// Market name → how to read its probability/odds off a live fixture.
const SA_MARKETS = {
  "TB:Over 1.5":      { probKey:"over15",  oddsKey:"over15odds"  },
  "TB:Over 2.5":      { probKey:"over25",  oddsKey:"over25odds"  },
  "TB:Under 3.5":     { probKey:"under35", oddsKey:"under35odds" },
  "TB:Under 4.5":     { probKey:"under45", oddsKey:"under45odds" },
  "TB:BTTS":          { probKey:"bttsYes", oddsKey:"bttsYesOdds" },
  "TB:DC1X":          { computeProb: m => (+(m.homeWin??0)) + (+(m.draw??0)), oddsKey:"dc1X" },
  "TB:DCX2":          { computeProb: m => (+(m.draw??0)) + (+(m.awayWin??0)), oddsKey:"dcX2" },
  "TB:1X2-Home":      { probKey:"homeWin", oddsKey:"o1" },
  "TB:1X2-Draw":      { probKey:"draw",    oddsKey:"oX" },
  "TB:1X2-Away":      { probKey:"awayWin", oddsKey:"o2" },
  "TB:Home Over 0.5": { probKey:"homeOver05", oddsKey:null },
  "TB:Home Over 1.5": { probKey:"homeOver15", oddsKey:null },
  "TB:Away Over 0.5": { probKey:"awayOver05", oddsKey:null },
  "TB:Away Over 1.5": { probKey:"awayOver15", oddsKey:null },
  // PE Mix — virtual view: each fixture shows whichever gated market PE assigned
  // as its home market (strongest SA signal for that game today). Not a real market
  // key — handled as a special case in the saRows memo below.
  "PE:Mix":           { _isPEMix: true },
};
const SA_MARKET_LABELS = Object.keys(SA_MARKETS).map(id => ({
  id,
  label: id === "PE:Mix" ? "Mix" : id.replace(/^TB:/, ""),
}));

// Selecting an SA Pattern market should make the normal Pick Market filter
// follow it, so both selectors stay in sync instead of showing two different
// markets at once. CUSTOM_FAMILIES uses different (lowercase, unprefixed)
// ids than SA_MARKETS — this is the explicit mapping between the two schemes.
const SA_TO_FAMILY_ID = {
  "TB:Over 1.5": "over15", "TB:Over 2.5": "over25",
  "TB:Under 3.5": "under35", "TB:Under 4.5": "under45",
  "TB:BTTS": "bttsyes",
  "TB:DC1X": "dc1x", "TB:DCX2": "dc2x",
  "TB:1X2-Home": "homewin", "TB:1X2-Draw": "draw", "TB:1X2-Away": "awaywin",
  "TB:Home Over 0.5": "homeo05", "TB:Home Over 1.5": "homeo15",
  "TB:Away Over 0.5": "awayo05", "TB:Away Over 1.5": "awayo15",
};

function saTheReadToTBMarket(anchor) {
  if (!anchor) return null;
  const mkt = anchor.market, dcV = anchor.dcVariant;
  if (mkt === "DC") return dcV === "1X" ? "TB:DC1X" : dcV === "X2" ? "TB:DCX2" : null;
  const MAP = {
    "Over 1.5":"TB:Over 1.5","Over 2.5":"TB:Over 2.5","Under 3.5":"TB:Under 3.5","Under 4.5":"TB:Under 4.5",
    "BTTS":"TB:BTTS","Home Over 0.5":"TB:Home Over 0.5","Away Over 0.5":"TB:Away Over 0.5",
    "Home Win":"TB:1X2-Home","Away Win":"TB:1X2-Away","Draw":"TB:1X2-Draw",
  };
  return MAP[mkt] ?? null;
}

const saProbBand = p => p>=90?"90+":p>=85?"85-90":p>=80?"80-85":p>=75?"75-80":p>=70?"70-75":p>=65?"65-70":"<65";
const saCalBand = w => w==null?"unknown":w>=80?"80+":w>=60?"60-80":w>=40?"40-60":w>=20?"20-40":"<20";
const saSeasonBand = n => !n?"unknown":n>=30?"30+":n>=20?"20-30":n>=8?"8-20":"<8";
const saGamesUsedBand = n => !n?"unknown":n>=60?"60+":n>=30?"30-60":n>=15?"15-30":"<15";
const saLeagueTier = rank => !rank?"unknown":rank<=10?"elite":rank<=20?"top":rank<=50?"mid":"lower";
const saXgRatioBand = (h,a) => { if(!h||!a||h<=0||a<=0) return "unknown"; const r=Math.max(h/a,a/h); return r>=3?"3+":r>=2?"2-3":r>=1.5?"1.5-2":"<1.5"; };
const saTotalXGBand = t => !t||t<=0?"unknown":t>=4?"4+":t>=3?"3-4":t>=2?"2-3":"<2";
const saOddsDiscrepBand = (modelProb, bkOdds) => {
  if (!bkOdds || bkOdds<=1) return "no-bk";
  const bkP = (1/bkOdds)*100, d = modelProb - bkP;
  return d>15?"strong-edge":d>5?"mild-edge":d>-5?"aligned":d>-15?"mild-against":"strong-against";
};
const saTablePosBand = pos => pos==null?"unknown":pos<=3?"top3":pos<=6?"top6":pos<=10?"mid":"bottom";
const saPosDiffBand  = d => d==null?"unknown":d<=3?"close":d<=7?"mid":"large";
const saBacktestWtBand = w => w==null?"unknown":w>=50?"50+":w>=30?"30-50":w>=15?"15-30":"<15";

// Computes the same feature dimensions strategy-analyst.mjs mined patterns
// against, off a LIVE fixture instead of a snapshot file. Returned object is
// keyed identically to sa-patterns.json's `conditions`, values stringified
// the same way (DIMS in the miner wraps booleans/bands in String()).
function computeSAFeatures(f, market) {
  const def = SA_MARKETS[market];
  if (!def) return null;
  const m = f.markets || {};
  const prob   = def.computeProb ? def.computeProb(m) : +(m[def.probKey] ?? 0);
  const bkOdds = def.oddsKey ? +(f.odds?.[def.oddsKey] ?? 0) : 0;

  const hXG = +(m.homeXG ?? 0), aXG = +(m.awayXG ?? 0);
  const tot = hXG + aXG, gap = Math.abs(hXG - aXG);

  const calW   = m._calibrationWeight ?? null;
  const sGames = m._seasonGames ?? null;
  const gUsed  = m._gamesUsed ?? null;
  const btW    = m._backtestWeight ?? null;
  const isLowConf = !!(m._lowConfidence ?? false);

  const lRank = f.leagueRank ?? null;
  const isVol = !!(f.volatileLeague ?? false);

  const hAtk = +(m.homeAttackStrength ?? 0), aAtk = +(m.awayAttackStrength ?? 0);
  const hDef = +(m.homeDefenceStrength ?? 0), aDef = +(m.awayDefenceStrength ?? 0);

  const tp = f.tablePosition || {};
  const hPos = tp.homePosition ?? null, aPos = tp.awayPosition ?? null;
  const posDiff = (hPos!=null && aPos!=null) ? Math.abs(hPos-aPos) : null;

  const hSt = f.teamStats?.home || {}, aSt = f.teamStats?.away || {};

  const readAnchor     = f.theRead?.anchor;
  const readStrong     = !!(readAnchor?.strong ?? false);
  const readTBMkt      = saTheReadToTBMarket(readAnchor);
  const readMatchesMkt = readTBMkt === market;

  const o25 = +(m.over25 ?? 0), btts = +(m.bttsYes ?? m.btts ?? 0), draw = +(m.draw ?? 0);
  const tags = f.strategyTags || [];

  return {
    probBand: saProbBand(prob),
    leagueTier: saLeagueTier(lRank),
    isEliteLeague: String(lRank!=null && lRank<999 && lRank<=10),
    isTopLeague:   String(lRank!=null && lRank<999 && lRank<=20),
    isVolatile: String(isVol),
    country: f.country || "unknown",
    calBand: saCalBand(calW),
    isHighCalib: String(calW!=null && calW>=70),
    gamesUsedBand: saGamesUsedBand(gUsed),
    isLowConf: String(isLowConf),
    backtestWtBand: saBacktestWtBand(btW),
    seasonBand: saSeasonBand(sGames),
    isLateSeason: String(sGames!=null && sGames>30),
    isEarlySeason: String(sGames!=null && sGames<8),
    xgRatioBand: saXgRatioBand(hXG, aXG),
    totalXGBand: saTotalXGBand(tot),
    xgBalanced: String(gap < 0.5),
    xgDomHome: String(hXG>0 && aXG>0 && hXG>=aXG*2 && gap>=1),
    xgDomAway: String(hXG>0 && aXG>0 && aXG>=hXG*2 && gap>=1),
    highTotalXG: String(tot >= 3),
    lowTotalXG: String(tot > 0 && tot < 1.5),
    xgSourceType: f.xgSource || "unknown",
    homeAttackStrong: String(hAtk >= 1.3),
    awayAttackStrong: String(aAtk >= 1.3),
    homeDefenceWeak: String(hDef >= 1.2),
    awayDefenceWeak: String(aDef >= 1.2),
    homeTablePos: saTablePosBand(hPos),
    awayTablePos: saTablePosBand(aPos),
    tablePosDiff: saPosDiffBand(posDiff),
    homeCsHigh: String((hSt.csRate ?? -1) >= 40),
    awayCsHigh: String((aSt.csRate ?? -1) >= 40),
    homeScoreLow: String((hSt.scoredRate ?? 101) <= 40),
    awayScoreLow: String((aSt.scoredRate ?? 101) <= 40),
    homeFtsHigh: String((hSt.ftsRate ?? -1) >= 40),
    awayFtsHigh: String((aSt.ftsRate ?? -1) >= 40),
    goalRange: f.goalRange || "unknown",
    highO25: String(o25 > 40),
    lowBtts: String(btts > 0 && btts < 35),
    highBtts: String(btts > 55),
    highDraw: String(draw > 30),
    hasBkOdds: String(!!(bkOdds && bkOdds>1)),
    oddsDiscrep: saOddsDiscrepBand(prob, bkOdds),
    readStrong: String(readStrong),
    readMatchesMkt: String(readMatchesMkt),
    hasLowScoring: String(tags.includes("low_scoring")),
    hasOver25Quality: String(tags.includes("over25_quality")),
    hasHomeWin: String(tags.includes("home_win")),
    hasAwayWin: String(tags.includes("away_win")),
    hasBttsValue: String(tags.includes("btts_value")),
    hasDrawTag: String(tags.includes("draw")),
    hasHomeGoalfest: String(tags.includes("home_goalfest")),
    hasAwayGoalfest: String(tags.includes("away_goalfest")),
  };
}

// Matches a fixture's computed features against every pattern for `market`.
// Returns { positive: [...matched, lift desc], avoid: [...matched, worst-first] }.
// Both single-condition and pair-condition patterns are handled the same way
// — every key in `p.conditions` must match the fixture's computed feature.
function matchSAPatterns(f, market, patterns) {
  const feats = computeSAFeatures(f, market);
  if (!feats || !patterns?.length) return { positive: [], avoid: [] };
  const positive = [], avoid = [];
  for (const p of patterns) {
    if (p.market !== market) continue;
    const matches = Object.entries(p.conditions).every(([k, v]) => feats[k] === v);
    if (!matches) continue;
    (p.direction === "positive" ? positive : avoid).push(p);
  }
  positive.sort((a,b) => b.lift - a.lift);
  avoid.sort((a,b) => a.lift - b.lift); // most negative lift first — worst offenders surfaced first within the flagged group
  return { positive, avoid };
}

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

// P-FIX: Correlation risk tracker — replaces the old "same league within one
// ticket" check, which fired on totally unrelated games just because they
// shared a league. The only thing that matters now is whether a leg has
// actually been booked before. Populated EXCLUSIVELY by a successful Book Now
// call (the real bookmaker API booking) — building, saving, or drafting a
// ticket never touches this list.
const BOOKED_LEGS_KEY = "grm_booked_legs_v1";
function loadBookedLegs() {
  try {
    const v = JSON.parse(localStorage.getItem(BOOKED_LEGS_KEY) || "[]");
    return Array.isArray(v) ? v : [];
  } catch { return []; }
}
function persistBookedLegs(legs) {
  try {
    // Cap growth so this doesn't silently bloat localStorage forever.
    localStorage.setItem(BOOKED_LEGS_KEY, JSON.stringify(legs.slice(-300)));
  } catch {}
}
function recordBookedLegs(legs, ticketCode) {
  if (!Array.isArray(legs) || !legs.length) return;
  const stamped = legs
    .filter(l => l.fixtureId || l.game)
    .map(l => ({
      fixtureId: l.fixtureId || l.game,
      game:      l.game,
      pick:      l.pick,
      market:    l.market,
      league:    l.league,
      ticketCode,
      bookedAt:  new Date().toISOString(),
    }));
  if (!stamped.length) return;
  persistBookedLegs([...loadBookedLegs(), ...stamped]);
}

// 38-FIX: "unresolvable on bookmaker" tag — mirrors BOOKED_LEGS_KEY exactly,
// stamped from the same book() handler that feeds recordBookedLegs, using the
// same legBooked[]-derived confirmed/not-confirmed split (37-FIX) rather than
// trying to parse data.failed's mixed shape.
// Design note: the original spec (log #38) called for expiring a tag once the
// leg's *kickoff time* has passed. Checked leg-construction sites across the
// app (e.g. ~line 14667) — legs only carry a `date` (YYYY-MM-DD), never a
// kickoff timestamp, so kickoff-precision expiry isn't buildable without
// threading fixture.time through every leg-construction site first (a much
// bigger, separate change). Shipping with date-level expiry instead: a tag
// goes stale once its leg's `date` is in the past, which is coarser but safe
// (never blocks a same-day rebook attempt) and needs no new data plumbing.
const FAILED_LEGS_KEY = "grm_failed_legs_v1";
function loadFailedLegs() {
  try {
    const v = JSON.parse(localStorage.getItem(FAILED_LEGS_KEY) || "[]");
    return Array.isArray(v) ? v : [];
  } catch { return []; }
}
function persistFailedLegs(legs) {
  try {
    localStorage.setItem(FAILED_LEGS_KEY, JSON.stringify(legs.slice(-300)));
  } catch {}
}
function recordFailedLegs(legs, ticketCode) {
  if (!Array.isArray(legs) || !legs.length) return;
  const stamped = legs
    .filter(l => l.fixtureId || l.game)
    .map(l => ({
      fixtureId: l.fixtureId || l.game,
      game:      l.game,
      pick:      l.pick,
      market:    l.market,
      league:    l.league,
      date:      l.date || null, // used for date-level expiry, see note above
      ticketCode,
      failedAt:  new Date().toISOString(),
    }));
  if (!stamped.length) return;
  persistFailedLegs([...loadFailedLegs(), ...stamped]);
}

// P-FIX: a leg is correlated if it was already booked before (always checked —
// real money risk, can't be toggled off), or — only when cross-ticket checking
// is on — if it also shows up in another ticket the user currently has built
// or saved. Two different games in the same league are NOT correlated; that
// was the bug this replaces.
// 38-FIX: also flags a leg if it previously came back unresolvable from a
// bookmaker (opt-in via unresolvableEnabled, off by default like cross-check),
// unless that tag has gone stale (its leg's date is in the past — see the
// date-level-expiry note on recordFailedLegs above).
function computeCorrelationRisks(ticket, { bookedLegs = [], failedLegs = [], otherTickets = [], crossCheckEnabled = false, unresolvableEnabled = false } = {}) {
  const legs = ticket?.legs || [];
  if (!legs.length) return [];
  const bookedByFixture = new Map();
  bookedLegs.forEach(b => { if (b.fixtureId && !bookedByFixture.has(b.fixtureId)) bookedByFixture.set(b.fixtureId, b); });

  const today = todayStr();
  const failedByFixture = new Map();
  if (unresolvableEnabled) {
    failedLegs.forEach(f => {
      if (!f.fixtureId) return;
      if (f.date && f.date < today) return; // expired — leg's date has passed
      if (!failedByFixture.has(f.fixtureId)) failedByFixture.set(f.fixtureId, f);
    });
  }

  const risks = [];
  legs.forEach(l => {
    const fid = l.fixtureId || l.game;
    if (!fid) return;
    const booked = bookedByFixture.get(fid);
    if (booked) {
      risks.push({ type:"booked", game: l.game || booked.game, pick: l.pick, bookedPick: booked.pick, ticketCode: booked.ticketCode });
    }
    if (unresolvableEnabled) {
      const failed = failedByFixture.get(fid);
      if (failed) {
        risks.push({ type:"unresolvable", game: l.game || failed.game, pick: l.pick, ticketCode: failed.ticketCode });
      }
    }
    if (crossCheckEnabled) {
      const match = otherTickets.find(t => t.id !== ticket.id && (t.legs||[]).some(ol => (ol.fixtureId || ol.game) === fid));
      if (match) {
        risks.push({ type:"session", game: l.game, pick: l.pick, otherLabel: match.slotLabel || match.code || `Ticket #${match.id}` });
      }
    }
  });
  return risks;
}
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

// isPastDate: when true (viewing a historical date), finished games are allowed
// into the engine pool so backtesting works. Live/in-play and cancelled states
// are always blocked regardless of date — they have no bookable outcome.
function evaluatePick(f, historicalRates, isPastDate = false) {
  const anchor = f.theRead?.anchor;
  if (!anchor || f.theRead?.isFallback) return null;
  const { market, prob:conf, odds:rawOdds, pick } = anchor;
  if (CALIBRATION.blockedMarkets.has(market)) return null;
  // TeamTotal anchors are already blocked by CALIBRATION.blockedMarkets.has(market) above.
  // The anchor.type === "tt" check below is dead code — getRead() never sets anchor.type.
  // Left as a defensive guard in case a future code path sets anchor.role for team-scoped picks.
  if (anchor.role) return null;
  const state = (f.state || "").toLowerCase().replace(/[\s_\-]/g, "");
  // FINISHED_STATES: allowed on past dates (needed for backtesting / pool display).
  // Blocked on today — can't book a finished game.
  const FINISHED_STATES = new Set([
    "finished","ft","fulltime","ended","complete","aet","afterextratime","afterpenalties",
  ]);
  // ALWAYS_BLOCKED: live in-play and cancelled states — never valid for pool regardless of date.
  const ALWAYS_BLOCKED = new Set([
    "1h","1sthalf","ht","halftime","2h","2ndhalf","et","extratime","penaltyshootout","inprogress","live",
    "postponed","ppd","suspended","interrupted","abandoned","cancelled","canceled","deleted",
  ]);
  if (ALWAYS_BLOCKED.has(state)) return null;
  if (!isPastDate && FINISHED_STATES.has(state)) return null;
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

function buildUniversalPool(fixtures, historicalRates, isPastDate = false) {
  const pool = [];
  for (const f of fixtures) {
    const entry = evaluatePick(f, historicalRates, isPastDate);
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

// "All Fixtures" pool for the custom builder — literally what the name says:
// every fixture that has a Read (non-fallback), an Edge, or a Goal Radar
// signal, in that priority order, taken at face value. NO quality gate —
// no empirical-rate floor, no odds floor, no blocked-market check. That gate
// (evaluatePick, used by buildUniversalPool) is what makes the Engine pool
// the Engine pool; running fixtures through it first and then calling this
// "All Fixtures" defeats the entire point of the toggle, which is why
// "All Fixtures" was silently converging on the Engine pool before this fix.
function buildSignalPool(fixtures, historicalRates, isPastDate = false) {
  const oi = oddsOrImplied;
  const FINISHED_STATES = new Set(["finished","ft","fulltime","ended","complete","aet","afterextratime","afterpenalties"]);
  const ALWAYS_BLOCKED  = new Set(["1h","1sthalf","ht","halftime","2h","2ndhalf","et","extratime","penaltyshootout","inprogress","live","postponed","ppd","suspended","interrupted","abandoned","cancelled","canceled","deleted"]);
  const pool = [];

  for (const f of fixtures) {
    const state = (f.state || "").toLowerCase().replace(/[\s_\-]/g, "");
    if (ALWAYS_BLOCKED.has(state)) continue;
    if (!isPastDate && FINISHED_STATES.has(state)) continue;

    // Read > Edge > Radar — same priority order as buildPool() elsewhere.
    let sig = null;
    if (f.theRead?.anchor && !f.theRead.isFallback) {
      const a = f.theRead.anchor;
      const o = oi(a.odds, a.prob);
      if (o) sig = { pick:a.pick, conf:a.prob, market:a.market, odds:o, strong:!!a.strong };
    }
    if (!sig && f.theEdge) {
      const o = oi(f.theEdge.odds, f.theEdge.prob);
      if (o) sig = { pick:f.theEdge.pick, conf:f.theEdge.prob, market:f.theEdge.market || "Edge", odds:o, strong:false };
    }
    if (!sig && f.goalRadar) {
      const best = f.goalRadar?.home?.prob >= f.goalRadar?.away?.prob ? f.goalRadar?.home : f.goalRadar?.away;
      if (best) { const o = oi(best.odds, best.prob); if (o) sig = { pick:best.pick, conf:best.prob, market:"TeamTotal", odds:o, strong:false }; }
    }
    if (!sig || !sig.odds || !isFinite(sig.odds) || sig.odds <= 1.0) continue;

    const empiricalRate = getEmpiricalRate(sig.market, sig.conf, historicalRates) || (sig.conf / 100);
    const lnO  = Math.log(sig.odds);
    const pExp = Math.pow(empiricalRate, POOL_SCORE_P_EXP);
    let score  = pExp * (lnO / sig.odds);
    if (sig.strong) score *= CALIBRATION.modifiers.strongBoost;
    const utility = score / Math.max(0.01, 1 - empiricalRate);

    pool.push({
      fixtureId: f.id, game: `${f.teams.home} vs ${f.teams.away}`,
      pick: sig.pick, odds: parseFloat(sig.odds.toFixed(2)), conf: sig.conf, market: sig.market,
      league: f.league || "", score, utility,
      empiricalRate: parseFloat((empiricalRate * 100).toFixed(1)),
      strategyLabel: sig.strong ? "STRONG" : "Read", strategyTags: f.strategyTags || [],
      isVolatile: isLeagueVolatile(f.league || ""), fixture: f,
    });
  }
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

// 49-FIX: single source of truth for league filter matching, used at every
// leagueFilter application site so include/exclude mode stays consistent
// everywhere instead of needing the flip applied at 6+ separate call sites.
function matchesLeagueFilter(leagueId, leagueFilter, mode) {
  if (!leagueFilter) return true;
  const lf = leagueFilter instanceof Set ? leagueFilter : new Set([leagueFilter]);
  if (!lf.size) return true;
  const has = lf.has(leagueId);
  return mode === "exclude" ? !has : has;
}

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
const mktStyle = (m, sport = "football") => {
  if (sport === "football") {
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
  }
  return getMarketStyle(m, sport, C); // sportConfig.js handles basketball/tennis
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

  // S3-FIX: reuse the existing <style> tag rather than removing it and inserting
  // a new one. The old remove()+createElement+appendChild sequence left a single
  // frame with no grm-styles present, causing a visible FOUC on theme switches
  // (especially noticeable on low-end Android). Reusing the element and updating
  // textContent is atomic from the browser's perspective — no unstyled frame.
  const old = document.getElementById("grm-styles");
  const s = old || document.createElement("style");
  if (!old) { s.id = "grm-styles"; document.head.appendChild(s); }
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
    @keyframes grm-risk-shake{0%,100%{transform:translateX(0)}20%{transform:translateX(-3px)}40%{transform:translateX(3px)}60%{transform:translateX(-2px)}80%{transform:translateX(2px)}}

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
    .grm-header-controls{
      padding:0 18px 12px;
      display:flex;align-items:center;flex-wrap:wrap;gap:8px;
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
      padding:18px 20px;margin-top:14px;margin-bottom:20px;
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
      .grm-header-controls{ padding:4px 10px 8px !important; gap:6px !important }
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

export function StatusBadge({ state, time, minute }) {
  const s = (state || "").toLowerCase().replace(/[_\-\s]/g, "");
  // Live / in-play states
  if (["inprogress","live","1sthalf","2ndhalf","halftime","ht","extratime","et","penaltyshootout"].includes(s)) {
    const label = (s === "halftime" || s === "ht") ? "HT"
                : (s === "extratime" || s === "et") ? "ET"
                : s === "penaltyshootout"            ? "PEN"
                : "LIVE";
    // Only "LIVE" carries a meaningful running clock — HT/ET/PEN don't map
    // to a single elapsed-minute number the way regular play does.
    const showMinute = label === "LIVE" && minute != null;
    return (
      <span style={{ display:"inline-flex",alignItems:"center",gap:4,fontSize:8,fontWeight:800,color:C.green,letterSpacing:".1em" }}>
        <IcoLiveDot col={C.green}/>
        {label}{showMinute ? ` ${minute}'` : ""}
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
  const mst    = anchor ? mktStyle(anchor.market, fixture?._sport) : null;
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

  const mst = mktStyle(anchor.market, fixture?._sport);
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
      // S6-FIX: backend (or SportyBet API) may return plain text / HTML on errors
      // instead of JSON. res.json() would throw a SyntaxError exposing raw junk to the UI.
      // Always read as text first, then parse safely.
      const rawText = await res.text();
      let data;
      try { data = JSON.parse(rawText); }
      catch { throw new Error(sanitizeBookmakerError(rawText, "SportyBet")); }
      if (!res.ok || data.error) throw new Error(sanitizeBookmakerError(data.error || `HTTP ${res.status}`, "SportyBet"));
      setResult(data);
    } catch(e) {
      const msg = e.message || "";
      if (/ERR_NAME_NOT_RESOLVED|Failed to fetch|NetworkError|net::ERR/i.test(msg)) {
        setError("Can't reach SportyBet — check your connection and try again.");
      } else if (/429|already in progress/i.test(msg)) {
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
              {(() => {
                const allFailed = Array.isArray(result.failed) ? result.failed : [];
                const realFailed = allFailed.filter(f => !(f && typeof f === "object" && f.isWarning));
                const fallbackBooked = allFailed.filter(f => f && typeof f === "object" && f.isWarning);
                if (!realFailed.length && !fallbackBooked.length) return null;
                return (
                  <>
                    {realFailed.length > 0 && (
                      <div style={{ marginTop:8,background:`${C.amber}10`,border:`1px solid ${C.amber}30`,borderRadius:6,padding:"8px 10px" }}>
                        <div style={{ fontSize:8,color:C.amber,fontWeight:800,marginBottom:6 }}>
                          ⚠ {realFailed.length} leg{realFailed.length!==1?"s":""} couldn't be booked
                        </div>
                        {realFailed.map((f, i) => {
                          const isObj = f && typeof f === "object";
                          const label = isObj ? f.label : f;
                          const reason = isObj
                            ? f.failReason === "tt_unavailable"
                              ? "Team Total market not available on SportyBet for this match. Try Over 2.5 or BTTS instead."
                              : "Match not found on SportyBet. May not be listed yet or have a different name."
                            : "Could not be resolved.";
                          return (
                            <div key={i} style={{ marginBottom: i < realFailed.length-1 ? 6 : 0 }}>
                              <div style={{ fontSize:8,color:C.text,fontWeight:700 }}>{label}</div>
                              <div style={{ fontSize:7,color:C.muted,marginTop:1 }}>{reason}</div>
                            </div>
                          );
                        })}
                      </div>
                    )}
                    {fallbackBooked.length > 0 && (
                      <div style={{ marginTop:8,background:`${C.green}10`,border:`1px solid ${C.green}30`,borderRadius:6,padding:"8px 10px" }}>
                        <div style={{ fontSize:8,color:C.green,fontWeight:800,marginBottom:6 }}>
                          Booked via fallback market
                        </div>
                        {fallbackBooked.map((f, i) => (
                          <div key={i} style={{ marginBottom: i < fallbackBooked.length-1 ? 6 : 0 }}>
                            <div style={{ fontSize:8,color:C.text,fontWeight:700 }}>{f.label || f.game}</div>
                            <div style={{ fontSize:7,color:C.muted,marginTop:1 }}>Original market unavailable — booked on an equivalent goal-band market instead.</div>
                          </div>
                        ))}
                      </div>
                    )}
                  </>
                );
              })()}
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
  const primaryColor = anchor ? mktStyle(anchor.market, f._sport).color : C.muted;

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
          <StatusBadge state={displayF.state} time={f.time} minute={displayF.minute} />
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
                <StatusBadge state={f.state} time={f.time} minute={f.minute} />
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

function CustomListView({ fixtures, search, onAddToTicket, onAddToParlay, draftLegs, onOpenFixture, onFullModel, backtestSummary, adminMode = false, adminToken = "", isPastDate = false, date = null, sortActive = new Set(), setSortActive = () => {} }) {
  const isMobile = useIsMobile();
  const SS_KEY = "grm_clv_state_v1";
  const loadSS = (k, fallback) => { try { const s = sessionStorage.getItem(SS_KEY); if (!s) return fallback; const d = JSON.parse(s); return d[k] !== undefined ? d[k] : fallback; } catch { return fallback; } };
  const saveSS = (patch) => { try { const d = JSON.parse(sessionStorage.getItem(SS_KEY) || "{}"); sessionStorage.setItem(SS_KEY, JSON.stringify({ ...d, ...patch })); } catch {} };

  const [family,         setFamilyState]         = useState(() => loadSS("family", "theRead"));
  const [statFilters,    setStatFiltersState]    = useState(() => loadSS("statFilters", []));
  const [selected,       setSelected]       = useState(null);
  const [activeStrategy, setActiveStrategyState] = useState(() => loadSS("activeStrategy", null));
  const [advancedOpen,   setAdvancedOpen]   = useState(false);
  // Kickoff time filter — "before" (≤ HH:MM) or "after" (≥ HH:MM)
  const [kickoffFilter, setKickoffFilter] = useState(null); // null | { mode:"before"|"after", hour:number }
  // PROB-FIX (2026-07-08): Pick-probability threshold filter — mirrors the kickoff
  // filter's UX exactly (mode toggle + value buttons, not persisted to sessionStorage,
  // same as kickoffFilter). Requested by Sterling to solve two related problems:
  //   1. Pick market: "Select All" has no way to scope to only games ≥ some prob
  //      (e.g. 75%) without this — previously it was all-or-nothing.
  //   2. SA row: sorts by SA Lift descending, not probability, so games with high
  //      lift but low probability sit above games with both. This filter doesn't
  //      change the sort (lift order is intentional — that's the point of SA row),
  //      but it narrows the list to a probability floor/ceiling first, so the
  //      lift-sorted results you see all clear your probability bar too.
  // Filters on `row.pick.prob` — the probability of whichever pick is actually
  // displayed for that row (varies by family on the Pick market; is the SA
  // market's own computed prob on SA rows) — not a raw f.markets.* field.
  const [probFilter, setProbFilter] = useState(null); // null | { mode:"above"|"below", value:number }

  // ── SA Pattern mode (user-facing, collapsible) ────────────────────────
  // Separate from `family`: family picks WHICH market off a fixture's model
  // probabilities; SA Pattern instead filters fixtures by whether they match
  // a validated (out-of-sample tested) historical pattern for a given market.
  // SA4-FIX: moved from admin-only to a collapsible panel visible to all users.
  // PE:Mix de-gated 2026-07-04 (Sterling's call) — no longer admin-only.
  const [saExpanded,  setSaExpanded]  = useState(false); // panel collapsed by default
  const [saMarket,    setSaMarket]    = useState(null); // e.g. "TB:Over 1.5", "PE:Mix", or null = off
  const [saPatterns,  setSaPatterns]  = useState(null); // raw sa-patterns.json payload
  const [saLoading,   setSaLoading]   = useState(false);
  const [saError,     setSaError]     = useState(null);
  // SA-RESET: when adminMode flips (unlock or lock), clear any cached patterns
  // so the fetch useEffect reruns with the correct token on next expansion.
  const prevAdminModeRef = useRef(adminMode);
  useEffect(() => {
    if (prevAdminModeRef.current !== adminMode) {
      prevAdminModeRef.current = adminMode;
      setSaPatterns(null);
      setSaError(null);
    }
  }, [adminMode]);
  // PE Mix home-market assignments — fetched from /api/sa-mix when saMarket === "PE:Mix"
  const [saMixLegs,     setSaMixLegs]     = useState(null); // array of home-assigned legs or null
  const [saMixLoading,  setSaMixLoading]  = useState(false);
  const [saMixError,    setSaMixError]    = useState(null);

  useEffect(() => {
    if (!saExpanded) return;
    if (saLoading) return;
    const isRestricted = saPatterns?.restricted === true;
    // Already have real patterns — nothing to do
    if (saPatterns && !isRestricted) return;
    // Restricted sentinel cached but still not admin — leave the notice showing
    if (isRestricted && !adminMode) return;
    // All other cases: no patterns yet, OR restricted+admin (will fetch with token)
    setSaLoading(true);
    setSaError(null);
    if (isRestricted) setSaPatterns(null); // clear sentinel before refetch
    const token = adminMode ? `?adminToken=${encodeURIComponent(adminToken)}` : "";
    fetch(`${SERVER}/api/sa-patterns${token}`)
      .then(r => {
        if (r.status === 403) throw new Error("patterns_restricted");
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then(d => {
        // Only mark restricted if the server explicitly says so (d.restricted === true)
        // or there's an auth-type error. An empty patterns array is NOT a restriction —
        // it just means no patterns are configured yet; still show the panel to users.
        const isServerRestricted = d?.restricted === true;
        if (d?.patterns?.length) setSaPatterns(d);
        else if (d?.error && isServerRestricted) { setSaError(d.error); setSaPatterns({ patterns: [], restricted: true }); }
        else if (d?.error) { setSaError(d.error); setSaPatterns({ patterns: [] }); }
        else setSaPatterns({ patterns: [], restricted: isServerRestricted });
      })
      .catch(e => {
        setSaPatterns({ patterns: [], restricted: e.message === "patterns_restricted" });
        if (e.message !== "patterns_restricted") setSaError(e.message);
      })
      .finally(() => setSaLoading(false));
  // adminMode and adminToken are the key triggers — when admin unlocks, rerun
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [saExpanded, adminMode, adminToken]);

  // Fetch PE Mix assignments whenever PE:Mix mode is activated or date changes
  useEffect(() => {
    // De-gated 2026-07-04 (Sterling's call): PE:Mix used to be admin-only
    // because it reads internal PE engine data — the whole SA scope (including
    // /api/sa-patterns and this endpoint's backend route) is now public.
    if (saMarket !== "PE:Mix") return;
    if (saMixLoading) return;
    setSaMixLoading(true);
    setSaMixLegs(null);
    setSaMixError(null);
    const dateParam = date ? `?date=${date}` : ``;
    fetch(`${SERVER}/api/sa-mix${dateParam}`)
      .then(r => r.json())
      .then(d => {
        if (d?.homeLegs) setSaMixLegs(d.homeLegs);
        else setSaMixError(d?.error || "No mix data");
      })
      .catch(e => setSaMixError(e.message))
      .finally(() => setSaMixLoading(false));
  }, [saMarket, date]); // eslint-disable-line react-hooks/exhaustive-deps

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
    // Market exclusion fallback: when a fixture's primary pick uses an excluded
    // market, find the genuine next-best pick — the highest-probability
    // non-excluded alternative — rather than hiding the fixture.
    // P-FIX: this used to (1) loop in a FIXED order and return the first valid
    // match instead of the best one, and (2) contain several family ids that
    // didn't actually match getCustomPick's keys ("home_win"/"away_win"/"dc"/
    // "teamtotal" vs the real "homewin"/"awaywin"/"dc1x"+"dc2x"/"homeo05" etc.),
    // so those entries silently returned null every time. Net effect: Draw —
    // early in the list and almost always non-null — won nearly every
    // fallback by default, not by merit. Both are fixed below: correct ids,
    // and the best-probability candidate wins instead of the first one found.
    const ALL_FAMILY_IDS = ["theRead","homewin","awaywin","draw","over25","under25",
                            "over35","under35","bttsyes","bttsno","dc1x","dc2x",
                            "homeo05","homeo15","awayo05","awayo15"];
    const getFallbackPick = (f) => {
      let best = null;
      for (const fam of ALL_FAMILY_IDS) {
        if (fam === family) continue; // already tried primary
        const p = getCustomPick(f, fam, C);
        if (!p || p.prob <= 0) continue;
        if (excludedMarkets.has(getExcludeSelectionId(p, f))) continue;
        if (!best || p.prob > best.prob) best = p;
      }
      return best;
    };

    // P23-FIX: live + upcoming are mutually exclusive if applied as hard filters.
    // When both (or neither) are active, skip the status filter and sort live first instead.
    // PAST-DATE-FIX: on past dates ALL games are finished — "Upcoming" and "Live" filters
    // from a previous session would wipe the list. Skip status filters entirely for past dates.
    const hasLiveFilter     = statFilters.includes("live");
    const hasScheduledFilter = statFilters.includes("scheduled");
    const bothOrNeither     = isPastDate || (hasLiveFilter && hasScheduledFilter) || (!hasLiveFilter && !hasScheduledFilter);
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
      })
      // SIG-FIX: apply sortActive quality filters from Signal section
      .filter(row => {
        if (sortActive.has("strong_only") && !(row.f.theRead?.anchor?.strong === true && !row.f.markets?._lowConfidence)) return false;
        if (sortActive.has("hq_data")    && !((row.f.markets?._calibrationWeight ?? 0) >= 50))   return false;
        if (sortActive.has("ltd_data")   && !((row.f.markets?._calibrationWeight ?? 100) < 25))  return false;
        // KICK-FIX: kickoff time filter — f.time is "HH:MM"
        if (kickoffFilter && row.f.time) {
          const [hh, mm] = row.f.time.split(":").map(Number);
          const mins = hh * 60 + (mm || 0);
          const filterMins = kickoffFilter.hour * 60;
          if (kickoffFilter.mode === "before" && mins > filterMins) return false;
          if (kickoffFilter.mode === "after"  && mins < filterMins) return false;
        }
        // PROB-FIX: pick probability threshold — floor (above) or ceiling (below)
        // on the actually-displayed pick's prob, so Select All can be scoped safely.
        if (probFilter && row.pick?.prob != null) {
          if (probFilter.mode === "above" && row.pick.prob < probFilter.value) return false;
          if (probFilter.mode === "below" && row.pick.prob > probFilter.value) return false;
        }
        return true;
      })
      .sort((a, b) => {
        if (sortActive.has("strong_first")) {
          const aS = a.f.theRead?.anchor?.strong === true && !a.f.markets?._lowConfidence ? 0 : 1;
          const bS = b.f.theRead?.anchor?.strong === true && !b.f.markets?._lowConfidence ? 0 : 1;
          if (aS !== bS) return aS - bS;
        }
        return 0; // maintain existing prob sort above
      });
  }, [fixtures, family, search, statFilters, STAT_FILTERS, excludedMarkets, isPastDate, sortActive, kickoffFilter, probFilter]);

  // SA Pattern mode — separate list, only built when an admin has a market selected.
  // Reuses the same { f, pick } shape as `rows` so the existing row JSX renders it
  // unchanged; pick.label/color come from whichever pattern matched (or a plain
  // market label when only an avoid pattern matched and there's no positive one).
  const saRows = useMemo(() => {
    if (!saMarket) return [];
    const s = search.toLowerCase();
    const def = SA_MARKETS[saMarket];
    if (!def) return [];

    const hasLiveFilter      = statFilters.includes("live");
    const hasScheduledFilter = statFilters.includes("scheduled");
    const bothOrNeither      = isPastDate || (hasLiveFilter && hasScheduledFilter) || (!hasLiveFilter && !hasScheduledFilter);
    const liveStates = new Set(["inprogress","live","1h","1sthalf","ht","halftime","2h","2ndhalf","et","extratime","penaltyshootout"]);
    const isScheduledState = st => st===""||st==="notstarted"||st==="scheduled"||st==="prematch";

    // ── PE:Mix mode — home-market assignments from PE engine ─────────────────
    // Each fixture is shown with whichever gated market PE assigned as its
    // strongest signal. Sorted by combinedZ desc (same order PE uses for tickets).
    if (def._isPEMix) {
      if (!saMixLegs?.length) return [];
      const byGameId = new Map(saMixLegs.map(l => [l.gameId, l]));
      const out = [];
      for (const f of fixtures) {
        const leg = byGameId.get(f.id);
        if (!leg) continue;
        if (s && !f.teams.home.toLowerCase().includes(s) && !f.teams.away.toLowerCase().includes(s) && !f.league.toLowerCase().includes(s)) continue;
        if (!bothOrNeither) {
          const st = (f.state||"").toLowerCase();
          if (hasLiveFilter && !liveStates.has(st)) continue;
          if (hasScheduledFilter && !isScheduledState(st)) continue;
        }
        // ALL-FILTERS-FIX: apply statFilters (non-status) and excludedMarkets to PE:Mix rows
        if (statFilters.some(id => {
          if (["live","scheduled"].includes(id)) return false; // handled above
          const sf = STAT_FILTERS.find(x => x.id === id);
          return sf ? !sf.fn(f) : false;
        })) continue;
        const mktLabel = (leg.market || "").replace(/^TB:/, "");
        const _mixPickId = getExcludeSelectionId({ label: mktLabel, market: mktLabel }, f); // TB: prefix stripped so id matches EXCLUDE_SELECTION_GROUPS
        if (excludedMarkets.size > 0 && excludedMarkets.has(_mixPickId)) continue;
        out.push({
          f,
          pick: {
            label: mktLabel,
            prob:  leg.prob  ?? 0,
            odds:  leg.odds  ?? null,
            color: C.accent,
            market: leg.market,
          },
          _saTier:     leg.sa?.tier ?? null,
          _saZ:        leg.sa?.combinedZ ?? null,
          _saAdjLift:  leg.sa?.adjLift ?? null,
          _saFlagged:  false, // all PE home legs passed the gate — no flagged rows
          _saPositive: [],
          _saAvoid:    [],
        });
      }
      out.sort((a, b) => {
        if (bothOrNeither) {
          const aLive = liveStates.has((a.f.state||"").toLowerCase()) ? 0 : 1;
          const bLive = liveStates.has((b.f.state||"").toLowerCase()) ? 0 : 1;
          if (aLive !== bLive) return aLive - bLive;
        }
        return (b._saZ ?? 0) - (a._saZ ?? 0); // highest combinedZ first
      });
      // MIX-FILTER-FIX: apply Signal quality filters + kickoff to Mix list
      const mixFiltered = out.filter(row => {
        if (sortActive.has("strong_only") && !(row.f.theRead?.anchor?.strong === true && !row.f.markets?._lowConfidence)) return false;
        if (sortActive.has("hq_data")    && !((row.f.markets?._calibrationWeight ?? 0) >= 50))   return false;
        if (sortActive.has("ltd_data")   && !((row.f.markets?._calibrationWeight ?? 100) < 25))  return false;
        if (kickoffFilter && row.f.time) {
          const [hh, mm] = row.f.time.split(":").map(Number);
          const mins = hh * 60 + (mm || 0);
          const filterMins = kickoffFilter.hour * 60;
          if (kickoffFilter.mode === "before" && mins > filterMins) return false;
          if (kickoffFilter.mode === "after"  && mins < filterMins) return false;
        }
        // PROB-FIX: pick probability threshold, same semantics as Pick-market rows
        if (probFilter && row.pick?.prob != null) {
          if (probFilter.mode === "above" && row.pick.prob < probFilter.value) return false;
          if (probFilter.mode === "below" && row.pick.prob > probFilter.value) return false;
        }
        return true;
      });
      if (sortActive.has("strong_first")) {
        mixFiltered.sort((a, b) => {
          const aS = a.f.theRead?.anchor?.strong === true && !a.f.markets?._lowConfidence ? 0 : 1;
          const bS = b.f.theRead?.anchor?.strong === true && !b.f.markets?._lowConfidence ? 0 : 1;
          if (aS !== bS) return aS - bS;
          return (b._saZ ?? 0) - (a._saZ ?? 0); // preserve combinedZ within same tier
        });
      }
      return mixFiltered;
    }

    // ── Standard single-market SA pattern mode ────────────────────────────────
    // SA-USER-FALLBACK: if patterns didn't load (server gated / 403), still show
    // all fixtures for the selected market sorted by prob — no pattern filtering,
    // but users get a useful market-filtered list instead of an empty screen.
    const hasPatterns = saPatterns?.patterns?.length > 0;
    if (!hasPatterns) {
      const out = [];
      for (const f of fixtures) {
        if (s && !f.teams.home.toLowerCase().includes(s) && !f.teams.away.toLowerCase().includes(s) && !f.league.toLowerCase().includes(s)) continue;
        if (!bothOrNeither) {
          const st = (f.state||"").toLowerCase();
          if (hasLiveFilter && !liveStates.has(st)) continue;
          if (hasScheduledFilter && !isScheduledState(st)) continue;
        }
        const m = f.markets || {};
        const prob = def.computeProb ? def.computeProb(m) : +(m[def.probKey] ?? 0);
        if (!prob || prob <= 0) continue;
        // ALL-FILTERS-FIX: statFilters and excludedMarkets
        if (statFilters.some(id => {
          if (["live","scheduled"].includes(id)) return false;
          const sf = STAT_FILTERS.find(x => x.id === id);
          return sf ? !sf.fn(f) : false;
        })) continue;
        const _fbPickLabel = saMarket.replace(/^TB:/,""); const _fbPick = { label: _fbPickLabel, market: _fbPickLabel };
        if (excludedMarkets.size > 0 && excludedMarkets.has(getExcludeSelectionId(_fbPick, f))) continue;
        // PROB-FIX: pick probability threshold — this fallback branch (patterns
        // 403/gated or empty) pre-existingly skips kickoffFilter and sortActive
        // quality filters entirely (not touched here — flagged to Sterling,
        // out of scope for this fix). Applying probFilter here anyway since
        // that's this task and `prob` is already in scope.
        if (probFilter) {
          if (probFilter.mode === "above" && prob < probFilter.value) continue;
          if (probFilter.mode === "below" && prob > probFilter.value) continue;
        }
        const odds = def.oddsKey ? (f.odds?.[def.oddsKey] || null) : null;
        out.push({
          f, pick: { label: saMarket.replace(/^TB:/,""), prob, odds, color: C.accent },
          _saPositive: [], _saAvoid: [], _saFlagged: false,
        });
      }
      out.sort((a, b) => {
        if (bothOrNeither) {
          const aLive = liveStates.has((a.f.state||"").toLowerCase()) ? 0 : 1;
          const bLive = liveStates.has((b.f.state||"").toLowerCase()) ? 0 : 1;
          if (aLive !== bLive) return aLive - bLive;
        }
        return (b.pick.prob ?? 0) - (a.pick.prob ?? 0); // highest prob first
      });
      return out;
    }
    const out = [];
    for (const f of fixtures) {
      if (s && !f.teams.home.toLowerCase().includes(s) && !f.teams.away.toLowerCase().includes(s) && !f.league.toLowerCase().includes(s)) continue;
      if (!bothOrNeither) {
        const st = (f.state||"").toLowerCase();
        if (hasLiveFilter && !liveStates.has(st)) continue;
        if (hasScheduledFilter && !isScheduledState(st)) continue;
      }
      const m = f.markets || {};
      const prob = def.computeProb ? def.computeProb(m) : +(m[def.probKey] ?? 0);
      if (!prob || prob <= 0) continue;
      // ALL-FILTERS-FIX: statFilters (non-status) and excludedMarkets
      if (statFilters.some(id => {
        if (["live","scheduled"].includes(id)) return false;
        const sf = STAT_FILTERS.find(x => x.id === id);
        return sf ? !sf.fn(f) : false;
      })) continue;
      const _saPickLabel = saMarket.replace(/^TB:/,""); const _saPick = { label: _saPickLabel, market: _saPickLabel };
      if (excludedMarkets.size > 0 && excludedMarkets.has(getExcludeSelectionId(_saPick, f))) continue;
      const { positive, avoid } = matchSAPatterns(f, saMarket, saPatterns.patterns);
      if (!positive.length && !avoid.length) continue;
      const odds    = def.oddsKey ? (f.odds?.[def.oddsKey] || null) : null;
      const flagged = positive.length === 0;
      out.push({
        f, pick: { label: saMarket.replace(/^TB:/,""), prob, odds, color: flagged ? C.red : C.green },
        _saPositive: positive, _saAvoid: avoid, _saFlagged: flagged,
      });
    }
    out.sort((a, b) => {
      if (bothOrNeither) {
        const aLive = liveStates.has((a.f.state||"").toLowerCase()) ? 0 : 1;
        const bLive = liveStates.has((b.f.state||"").toLowerCase()) ? 0 : 1;
        if (aLive !== bLive) return aLive - bLive;
      }
      if (a._saFlagged !== b._saFlagged) return a._saFlagged ? 1 : -1;
      return a._saFlagged
        ? (a._saAvoid[0]?.lift||0) - (b._saAvoid[0]?.lift||0)
        : (b._saPositive[0]?.lift||0) - (a._saPositive[0]?.lift||0);
    });
    // SIG-FIX: apply sortActive quality filters to saRows too
    const filtered = out.filter(row => {
      if (sortActive.has("strong_only") && !(row.f.theRead?.anchor?.strong === true && !row.f.markets?._lowConfidence)) return false;
      if (sortActive.has("hq_data")    && !((row.f.markets?._calibrationWeight ?? 0) >= 50))   return false;
      if (sortActive.has("ltd_data")   && !((row.f.markets?._calibrationWeight ?? 100) < 25))  return false;
      // KICK-FIX: kickoff time filter
      if (kickoffFilter && row.f.time) {
        const [hh, mm] = row.f.time.split(":").map(Number);
        const mins = hh * 60 + (mm || 0);
        const filterMins = kickoffFilter.hour * 60;
        if (kickoffFilter.mode === "before" && mins > filterMins) return false;
        if (kickoffFilter.mode === "after"  && mins < filterMins) return false;
      }
      // PROB-FIX: pick probability threshold — narrows the lift-sorted list to a
      // probability floor/ceiling without changing the lift sort order itself.
      if (probFilter && row.pick?.prob != null) {
        if (probFilter.mode === "above" && row.pick.prob < probFilter.value) return false;
        if (probFilter.mode === "below" && row.pick.prob > probFilter.value) return false;
      }
      return true;
    });
    if (sortActive.has("strong_first")) {
      filtered.sort((a, b) => {
        const aS = a.f.theRead?.anchor?.strong === true && !a.f.markets?._lowConfidence ? 0 : 1;
        const bS = b.f.theRead?.anchor?.strong === true && !b.f.markets?._lowConfidence ? 0 : 1;
        return aS - bS;
      });
    }
    return filtered;
  }, [saMarket, saPatterns, saMixLegs, fixtures, search, statFilters, STAT_FILTERS, excludedMarkets, isPastDate, sortActive, kickoffFilter, probFilter]);

  const displayRows = saMarket ? saRows : rows;

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

      {/* ── STRATEGY ANALYST — collapsible, visible to all users ── */}
      {/* SA4-FIX: was admin-only ({adminMode && ...}). Now a collapsed panel
          any user can expand. PE:Mix de-gated 2026-07-04 — no longer admin-only. */}
      <div style={{ marginBottom:10 }}>
        {/* Collapse toggle header */}
        <button
          onClick={() => { setSaExpanded(v => !v); if (saMarket && !saExpanded) setSaMarket(null); }}
          style={{ width:"100%",display:"flex",justifyContent:"space-between",alignItems:"center",
                   background: saExpanded ? `${C.accent}10` : (saMarket ? `${C.accent}08` : C.surface),
                   border:`1px solid ${saExpanded ? `${C.accent}40` : (saMarket ? `${C.accent}30` : C.border)}`,
                   borderRadius: saExpanded ? "8px 8px 0 0" : 8,
                   cursor:"pointer",padding:"9px 13px",transition:"all .15s" }}>
          <div style={{ display:"flex",alignItems:"center",gap:8 }}>
            <span style={{ fontSize:9,color: saMarket ? C.accent : C.text,textTransform:"uppercase",letterSpacing:".12em",fontWeight:700 }}>
              Strategy Analyst
            </span>
            {saMarket && (
              <span style={{ fontSize:8,background:`${C.accent}20`,color:C.accent,border:`1px solid ${C.accent}40`,
                             borderRadius:4,padding:"1px 6px",fontWeight:800 }}>
                {saMarket === "PE:Mix" ? "Mix" : saMarket.replace(/^TB:/,"")}
              </span>
            )}
            {(saLoading || (saMarket === "PE:Mix" && saMixLoading)) && (
              <span style={{ fontSize:8,color:C.muted }}>loading…</span>
            )}
            {saError && !saPatterns?.restricted && <span style={{ fontSize:8,color:C.red }}>{saError}</span>}
            {saMixError && saMarket === "PE:Mix" && <span style={{ fontSize:8,color:C.red }}>{saMixError}</span>}
          </div>
          <span style={{ fontSize:10,color:C.muted,lineHeight:1 }}>{saExpanded ? "▲" : "▼"}</span>
        </button>

        {/* Collapsed hint */}
        {!saExpanded && (
          <div style={{ fontSize:8,color:C.muted,padding:"5px 4px 0",lineHeight:1.5 }}>
            Pattern-based recommendations and insights from the Strategy Analyst engine.
          </div>
        )}

        {/* Expanded body */}
        {saExpanded && (
          <div style={{ border:`1px solid ${C.accent}30`,borderTop:"none",borderRadius:"0 0 8px 8px",
                        padding:"10px 12px 12px",background:`${C.accent}04` }}>
            <div style={{ fontSize:8,color:C.text,opacity:.65,marginBottom:10,lineHeight:1.6 }}>
              Filters fixtures by validated SA patterns — games that have historically performed well (or poorly) for each market.
              Avoid-flagged games (⛑) appear at the bottom.
            </div>
            {/* SA-USER-FIX: always show market buttons to all users */}
            {true && (
            <div className="cscroll" style={{ marginBottom:6 }}>
              {saMarket && (
                <button onClick={() => setSaMarket(null)} className="gb"
                  style={{ flexShrink:0,padding:"5px 12px",fontSize:10,textTransform:"none",
                           background:"transparent",color:C.red,border:`1px solid ${C.red}40` }}>
                  ✕ Off
                </button>
              )}
              {SA_MARKET_LABELS.map(mk => {
                const isMix    = mk.id === "PE:Mix";
                const isOn     = saMarket === mk.id;
                // De-gated 2026-07-04 (Sterling's call) — PE:Mix used to be
                // hidden here (`if (isMix && !adminMode) return null;`) since
                // the backend route was admin-only. Now the whole SA scope is
                // public, so this button shows to everyone.
                return (
                  <button key={mk.id} onClick={() => {
                    const turningOn = !isOn;
                    setSaMarket(turningOn ? mk.id : null);
                    if (turningOn && SA_TO_FAMILY_ID[mk.id]) {
                      setFamily(SA_TO_FAMILY_ID[mk.id]);
                      setActiveStrategy(null);
                    }
                  }} className="gb"
                    style={{ flexShrink:0,padding:"5px 12px",fontSize:10,textTransform:"none",
                             background:isOn ? (isMix ? C.accent : C.red) : "transparent",
                             color:isOn ? "#fff" : isMix ? C.accent : C.muted,
                             border:`1px solid ${isOn ? (isMix ? C.accent : C.red) : isMix ? `${C.accent}50` : C.faint}`,
                             fontWeight: isMix ? 800 : undefined }}>
                    {mk.label}
                  </button>
                );
              })}
            </div>
            )}
            {saMarket === "PE:Mix" && (
              <div style={{ fontSize:8,color:C.text,opacity:.6,marginTop:4 }}>
                PE Mix view — each fixture shown in whichever market the pick engine assigned as its strongest signal today, sorted by combined z-score.
              </div>
            )}
            {saMarket && saMarket !== "PE:Mix" && saPatterns?.patterns?.length > 0 && (
              <div style={{ fontSize:8,color:C.text,opacity:.6,marginTop:4 }}>
                Showing only fixtures matching a validated SA pattern for <strong>{saMarket.replace(/^TB:/,"")}</strong>.
                Games matching only an "avoid" pattern are flagged ⚑ and sorted to the bottom.
              </div>
            )}
          </div>
        )}
      </div>

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
        {/* Sort quality filters — Strong First, Strong Only, High Quality, Limited Data */}
        <div style={{ display:"flex",flexWrap:"wrap",gap:6,marginTop:7 }}>
          {["strong_first","strong_only","hq_data","ltd_data"].map(id => {
            const opt = SORT_OPTIONS.find(o => o.id === id);
            if (!opt) return null;
            const isOn = sortActive.has(id);
            const col  = id==="strong_first"||id==="strong_only" ? C.accent
                       : id==="hq_data"                          ? C.green
                       :                                           C.gold;
            const toggle = () => setSortActive(prev => {
              const next = new Set(prev);
              if (next.has(id)) {
                next.delete(id);
              } else {
                // strong_first and strong_only are mutually exclusive primaries
                if (opt.type === "sort_primary") {
                  SORT_OPTIONS.filter(o => o.type === "sort_primary").forEach(o => next.delete(o.id));
                }
                next.add(id);
              }
              return next;
            });
            return (
              <button key={id} onClick={toggle} className="gb" title={opt.desc}
                style={{ padding:"4px 11px",fontSize:9,textTransform:"none",
                         ...(isOn ? chipOn(col) : chipOff) }}>
                {opt.label}
              </button>
            );
          })}
        </div>
        {/* Kickoff time filter */}
        <div style={{ marginTop:9 }}>
          <div style={{ fontSize:8,color:C.muted,marginBottom:5,textTransform:"uppercase",letterSpacing:".1em",fontWeight:700 }}>
            Kickoff time
            {kickoffFilter && (
              <button onClick={() => setKickoffFilter(null)}
                style={{ marginLeft:8,fontSize:8,background:"none",border:"none",color:C.red,cursor:"pointer",padding:0,fontWeight:700 }}>
                ✕ clear
              </button>
            )}
          </div>
          <div style={{ display:"flex",gap:6,alignItems:"center",flexWrap:"wrap" }}>
            {/* Mode toggle: Before / After */}
            {["before","after"].map(mode => {
              const isActive = kickoffFilter?.mode === mode;
              return (
                <button key={mode} onClick={() => setKickoffFilter(prev =>
                  prev?.mode === mode ? null : { mode, hour: prev?.hour ?? 18 }
                )} className="gb"
                  style={{ padding:"4px 10px",fontSize:9,textTransform:"none",flexShrink:0,
                           ...(isActive ? chipOn(C.accent) : chipOff) }}>
                  {mode === "before" ? "≤ Before" : "≥ After"}
                </button>
              );
            })}
            {/* Hour selector — only shown when a mode is active */}
            {kickoffFilter && (
              <div style={{ display:"flex",gap:4,flexWrap:"wrap" }}>
                {[9,12,14,15,16,17,18,19,20,21,22].map(h => {
                  const isOn = kickoffFilter.hour === h;
                  return (
                    <button key={h} onClick={() => setKickoffFilter(prev => ({ ...prev, hour: h }))}
                      className="gb"
                      style={{ padding:"4px 8px",fontSize:9,textTransform:"none",flexShrink:0,
                               ...(isOn ? chipOn(C.gold) : chipOff) }}>
                      {String(h).padStart(2,"0")}:00
                    </button>
                  );
                })}
              </div>
            )}
          </div>
          {kickoffFilter && (
            <div style={{ fontSize:8,color:C.muted,marginTop:4,lineHeight:1.5 }}>
              {kickoffFilter.mode === "before"
                ? `Showing games kicking off at or before ${String(kickoffFilter.hour).padStart(2,"0")}:00`
                : `Showing games kicking off at or after ${String(kickoffFilter.hour).padStart(2,"0")}:00`}
            </div>
          )}
        </div>
        {/* PROB-FIX (2026-07-08): Pick probability filter — same UX pattern as
            Kickoff time above. Works on both the Pick market list and SA row
            (filters row.pick.prob in both `rows` and `saRows`). Lets you scope
            Select All to only games clearing a probability floor, and lets SA
            row's lift-sorted list be narrowed to also clear a probability bar. */}
        <div style={{ marginTop:9 }}>
          <div style={{ fontSize:8,color:C.muted,marginBottom:5,textTransform:"uppercase",letterSpacing:".1em",fontWeight:700 }}>
            Pick Probability
            {probFilter && (
              <button onClick={() => setProbFilter(null)}
                style={{ marginLeft:8,fontSize:8,background:"none",border:"none",color:C.red,cursor:"pointer",padding:0,fontWeight:700 }}>
                ✕ clear
              </button>
            )}
          </div>
          <div style={{ display:"flex",gap:6,alignItems:"center",flexWrap:"wrap" }}>
            {/* Mode toggle: Above / Below */}
            {["above","below"].map(mode => {
              const isActive = probFilter?.mode === mode;
              return (
                <button key={mode} onClick={() => setProbFilter(prev =>
                  prev?.mode === mode ? null : { mode, value: prev?.value ?? 75 }
                )} className="gb"
                  style={{ padding:"4px 10px",fontSize:9,textTransform:"none",flexShrink:0,
                           ...(isActive ? chipOn(C.accent) : chipOff) }}>
                  {mode === "above" ? "≥ Above" : "≤ Below"}
                </button>
              );
            })}
            {/* Value selector — only shown when a mode is active */}
            {probFilter && (
              <div style={{ display:"flex",gap:4,flexWrap:"wrap" }}>
                {[50,55,60,65,70,75,80,85,90,95].map(v => {
                  const isOn = probFilter.value === v;
                  return (
                    <button key={v} onClick={() => setProbFilter(prev => ({ ...prev, value: v }))}
                      className="gb"
                      style={{ padding:"4px 8px",fontSize:9,textTransform:"none",flexShrink:0,
                               ...(isOn ? chipOn(C.gold) : chipOff) }}>
                      {v}%
                    </button>
                  );
                })}
              </div>
            )}
          </div>
          {probFilter && (
            <div style={{ fontSize:8,color:C.muted,marginTop:4,lineHeight:1.5 }}>
              {probFilter.mode === "above"
                ? `Showing picks at or above ${probFilter.value}% probability`
                : `Showing picks at or below ${probFilter.value}% probability`}
            </div>
          )}
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
          <span style={{ fontSize:9,color:C.text }}>{displayRows.length} matches{saMarket ? (saPatterns?.patterns?.length ? " (SA Pattern)" : ` (${saMarket.replace(/^TB:/,"")})`) : ""}</span>
          {(() => {
            const eligibleIds = displayRows.filter(({ f }) => !isFixtureFT(f)).map(({ f }) => f.id);
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
        {displayRows.length > 0 && (
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
              const eligibleIds = displayRows.filter(({ f }) => !isFixtureFT(f)).map(({ f }) => f.id);
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
              const eligibleIds = displayRows.filter(({ f }) => !isFixtureFT(f)).map(({ f }) => f.id);
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
        {displayRows.map(({ f, pick, _usedFallback, _excludedMarket, _saPositive, _saAvoid, _saFlagged }) => {
          const probColor = pick.prob >= 75 ? C.green : pick.prob >= 60 ? C.gold : C.muted;
          const isSelected = selectedIds.has(f.id);
          const isFT = isFixtureFT(f);
          const cols = hasResults ? "24px 50px 1fr 140px 60px 60px 72px" : "24px 50px 1fr 140px 60px 60px";
          const mCols = hasResults ? "20px 1fr 44px 44px" : "20px 1fr 44px";
          if (isMobile) return (
            <div key={f.id} style={{ display:"grid",gridTemplateColumns:mCols,gap:6,padding:"8px 10px",
                                     background:isFT?`${C.surface}60`:isSelected?"rgba(99,102,241,0.1)":C.surface,
                                     borderRadius:8,border:`1px solid ${isSelected?C.edge:C.border}`,
                                     cursor:"pointer",opacity:isFT?.5:1,transition:"all .15s",alignItems:"center" }}
              onClick={() => isFT ? onFullModel?.(f) : onOpenFixture ? onOpenFixture(f.id) : setSelected(f)}>
              <div onClick={e=>{e.stopPropagation(); if(!isFT) toggleSelect(f.id);}}>
                <div style={{ width:16,height:16,borderRadius:4,border:`1.5px solid ${isFT?C.muted:isSelected?C.edge:C.text}`,opacity:isFT?.3:isSelected?1:.3,background:isSelected?C.edge:"transparent",display:"flex",alignItems:"center",justifyContent:"center" }}>
                  {isSelected && <span style={{ fontSize:9,color:C.accentText,fontWeight:900 }}>✓</span>}
                  {isFT && <span style={{ fontSize:7,color:C.muted,fontWeight:900 }}>FT</span>}
                </div>
              </div>
              <div style={{ minWidth:0 }}>
                <div style={{ fontSize:10,fontWeight:700,color:C.text,lineHeight:1.3,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap" }}>{f.teams.home} <span style={{ color:C.text,opacity:.3 }}>vs</span> {f.teams.away}</div>
                <div style={{ fontSize:8,color:C.text,marginTop:1,display:"flex",gap:5,alignItems:"center" }}>
                  <StatusBadge state={f.state} time={f.time} minute={f.minute} />
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
                  {_saFlagged && (
                    <span title={`Avoid: ${_saAvoid?.[0]?.id||""} (testHR ${_saAvoid?.[0]?.testHR}%)`}
                      style={{ marginLeft:5,fontSize:7,color:C.red,background:`${C.red}15`,
                               border:`1px solid ${C.red}30`,borderRadius:3,padding:"1px 4px",flexShrink:0 }}>
                      ⚠ SA avoid
                    </span>
                  )}
                  {!_saFlagged && _saPositive?.length > 0 && (
                    <span title={`${_saPositive[0].id} — testHR ${_saPositive[0].testHR}% (+${_saPositive[0].lift}pp)`}
                      style={{ marginLeft:5,fontSize:7,color:C.green,background:`${C.green}15`,
                               border:`1px solid ${C.green}30`,borderRadius:3,padding:"1px 4px",flexShrink:0 }}>
                      ✓ SA +{_saPositive[0].lift}pp
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
                                     cursor:"pointer",opacity:isFT?.5:1,transition:"all .15s" }}
              onClick={() => isFT ? onFullModel?.(f) : onOpenFixture ? onOpenFixture(f.id) : setSelected(f)}
              onMouseEnter={e=>{ if(!isSelected){ e.currentTarget.style.borderColor=C.borderHi; e.currentTarget.style.background=isFT?`${C.surface}80`:C.surfaceHi; }}}
              onMouseLeave={e=>{ if(!isSelected){ e.currentTarget.style.borderColor=C.border; e.currentTarget.style.background=isFT?`${C.surface}60`:C.surface; }}}>
              <div style={{ alignSelf:"center" }} onClick={e=>{e.stopPropagation(); if(!isFT) toggleSelect(f.id);}}>
                <div style={{ width:16,height:16,borderRadius:4,border:`1.5px solid ${isFT?C.muted:isSelected?C.edge:C.text}`,opacity:isFT?.3:isSelected?1:.3,background:isSelected?C.edge:"transparent",display:"flex",alignItems:"center",justifyContent:"center" }}>
                  {isSelected && <span style={{ fontSize:9,color:C.accentText,fontWeight:900 }}>✓</span>}
                  {isFT && <span style={{ fontSize:7,color:C.muted,fontWeight:900 }}>FT</span>}
                </div>
              </div>
              <div style={{ alignSelf:"center",fontSize:9,color:C.text }}>
                <StatusBadge state={f.state} time={f.time} minute={f.minute} />
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
                  {_saFlagged && (
                    <span title={`Avoid: ${_saAvoid?.[0]?.id||""} (testHR ${_saAvoid?.[0]?.testHR}%)`}
                      style={{ fontSize:7,color:C.red,background:`${C.red}15`,
                               border:`1px solid ${C.red}30`,borderRadius:3,padding:"1px 4px",flexShrink:0 }}>
                      ⚠ SA avoid
                    </span>
                  )}
                  {!_saFlagged && _saPositive?.length > 0 && (
                    <span title={`${_saPositive[0].id} — testHR ${_saPositive[0].testHR}% (+${_saPositive[0].lift}pp)`}
                      style={{ fontSize:7,color:C.green,background:`${C.green}15`,
                               border:`1px solid ${C.green}30`,borderRadius:3,padding:"1px 4px",flexShrink:0 }}>
                      ✓ SA +{_saPositive[0].lift}pp
                    </span>
                  )}
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
        {displayRows.length === 0 && (
          <div style={{ textAlign:"center",padding:"40px 0",color:C.text,opacity:.3,fontSize:11,textTransform:"uppercase",letterSpacing:".15em" }}>
            {saMarket ? (saPatterns?.patterns?.length ? "No fixtures match SA patterns for this market" : "No fixtures found for this market") : "No matches"}
          </div>
        )}
      </div>

      {/* Selection banner */}
      {selectedIds.size > 0 && (
        <div style={{ position:"fixed",bottom:20,left:"50%",transform:"translateX(-50%)",zIndex:999,background:C.edge,borderRadius:12,padding:"10px 20px",display:"flex",alignItems:"center",gap:14,boxShadow:"0 4px 24px rgba(0,0,0,0.5)" }}>
          <span style={{ fontSize:10,fontWeight:800,color:C.accentText }}>{selectedIds.size} selected</span>
          <button onClick={() => {
            const familyLabel = CUSTOM_FAMILIES.find(cf => cf.id === family)?.label || family;
            // MIX-FIX: use displayRows (not rows) so that when SA Mix (PE:Mix) is
            // active, the correct per-fixture market and pick from saMixLegs is used.
            // Previously this read from `rows` (the normal custom pick market rows),
            // meaning Mix selections were added with whatever market the normal Custom
            // section happened to have active — completely wrong market/pick.
            const legs = displayRows.filter(({ f }) => selectedIds.has(f.id)).map(({ f, pick }) => ({
              fixtureId: f.id, game:`${f.teams.home} vs ${f.teams.away}`,
              league: f.league || "",
              pick:pick.label, market:pick.market && pick.market !== "Unknown" ? pick.market : inferMarket(pick.label),
              odds:pick.odds || null, conf:Math.round(pick.prob),
              strategyLabel: saMarket === "PE:Mix" ? "SA Mix" : familyLabel,
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
  const [mode, setMode]         = useState("code"); // "code" | "json" | "batch"
  const [ticketCode, setTicketCode] = useState("");
  const [dragging,setDragging]  = useState(false);
  const [uploading,setUploading]= useState(false);
  const [result,setResult]      = useState(null);
  const [error,setError]        = useState(null);
  const fileRef = useRef(null);

  // BATCH-EVAL (priority feature — 2026-07-04): evaluate every saved ticket
  // in one call and see hit-rate broken down by trim method (Smart Split vs
  // Top-N vs untagged/manual, etc). Reads straight from the same localStorage
  // Saved Tickets store as the "Ticket Code" mode above (Option B from
  // Alden's notes: evaluator reads Saved Tickets directly, no manual
  // injection step needed).
  const [batchLoading, setBatchLoading] = useState(false);
  const [batchError, setBatchError]     = useState(null);
  const [batchResult, setBatchResult]   = useState(null);
  const [excludedCodes, setExcludedCodes] = useState(() => new Set());

  const savedTickets = loadSavedTickets();

  const evaluateTicket = async (payload) => {
    setError(null); setResult(null); setUploading(true);
    try {
      if (!payload.date) throw new Error("Ticket has no date field.");
      if (!Array.isArray(payload.legs) && !Array.isArray(payload.rows)) throw new Error("Unrecognis                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           