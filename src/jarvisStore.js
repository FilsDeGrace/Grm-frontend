/**
 * jarvisStore.js — GRM Pro · Jarvis Shared State & Logic Layer
 * ─────────────────────────────────────────────────────────────
 * Pure JS module — no React, no JSX.
 * Owns:
 *   • All shared utility functions (copyToClipboard, safeImpliedOdds, inferMarket)
 *   • The canonical pool builder (one source of truth, no forks in ChatLayout)
 *   • The intent classifier (expanded: greetings, NL builds, help)
 *   • Booking helpers (share links, code format)
 *   • Constants shared across App, ChatLayout, CodeAnalyzer
 *
 * App.jsx imports this and passes jarvisState + jarvisDispatch as props to ChatLayout.
 * ChatLayout imports classifyIntent, buildPool, etc. from here — no local forks.
 */

// ── SHARED CONSTANTS ─────────────────────────────────────────────────────────

export const INTENT = {
  GREETING:           "GREETING",
  HELP:               "HELP",
  REMIX:              "REMIX",
  ADD_MORE_LEGS:      "ADD_MORE_LEGS",
  ODDS_CORRECTION:    "ODDS_CORRECTION",
  ROLLOVER_ANALYTICS: "ROLLOVER_ANALYTICS",
  BUILD_PARLEY:       "BUILD_PARLEY",
  MATCH_ANALYSIS:     "MATCH_ANALYSIS",
  JARVIS_ANALYSIS:    "JARVIS_ANALYSIS",
  FIXTURES_TODAY:     "FIXTURES_TODAY",
  FIXTURES_FILTERED:  "FIXTURES_FILTERED",
  CODE_ANALYZE:       "CODE_ANALYZE",
  NAVIGATE_CUSTOM:          "NAVIGATE_CUSTOM",
  NAVIGATE_CUSTOM_STRATEGY: "NAVIGATE_CUSTOM_STRATEGY",
  NAVIGATE_ENGINE:          "NAVIGATE_ENGINE",
  SAVED_PARLEYS:      "SAVED_PARLEYS",
  STRATEGY:           "STRATEGY",
  BUILD_WITH_MATCH:   "BUILD_WITH_MATCH",   // "build a parley with X vs Y"
  BUILD_WITH_ROLLOVER:"BUILD_WITH_ROLLOVER", // "build a parley to go with my rollover"
  REBUILD_SLIP:       "REBUILD_SLIP",        // "rebuild this slip with strongest legs"
  MULTI_ADD:          "MULTI_ADD",           // "add Bayern and Barca to my ticket"
  TEAM_FIXTURES:      "TEAM_FIXTURES",       // "Bayern games", "show Arsenal fixtures"
  LEAGUE_TOP:         "LEAGUE_TOP",          // "top 5 Premier League games"
  UNKNOWN:            "UNKNOWN",
};

export const BUILD_STEP = {
  MODE:        "MODE",
  POOL:        "POOL",
  LEGS_TARGET: "LEGS_TARGET",
  CONFIRM:     "CONFIRM",
};

export const MARKET_GROUPS = [
  { group: "RESULT",      items: [{ id:"1X2", label:"1X2 — Home/Draw/Away" }, { id:"DC", label:"Double Chance" }] },
  { group: "GOALS",       items: [
    { id:"over25",  label:"Over 2.5",  mapped:"Over 2.5"  },
    { id:"over15",  label:"Over 1.5",  mapped:"Over 1.5"  },
    { id:"over35",  label:"Over 3.5",  mapped:"Over 3.5"  },
    { id:"under25", label:"Under 2.5", mapped:"Under 2.5" },
    { id:"under35", label:"Under 3.5", mapped:"Under 3.5" },
  ]},
  { group: "BOTH TEAMS",  items: [{ id:"bttsyes", label:"BTTS Yes" }, { id:"bttsno", label:"BTTS No" }] },
  { group: "TEAM TOTALS", items: [{ id:"homeo05", label:"Home to Score (O0.5)" }, { id:"awayo05", label:"Away to Score (O0.5)" }] },
  { group: "NOT MODELLED", items: [
    { id:"corners",       label:"Corners",       untracked:true },
    { id:"correct_score", label:"Correct Score", untracked:true },
    { id:"cards",         label:"Cards",         untracked:true },
  ], muted:true },
];

export const TOP_LEAGUES_RANK = ["Premier League","La Liga","Serie A","Bundesliga","Ligue 1","Champions League","UEFA"];
export const TOP_COUNTRIES    = ["England","Spain","Italy","Germany","France","Portugal","Netherlands"];

// ── FAB FEATURE-DISCOVERY TIP CAROUSEL ───────────────────────────────────────
// Short, single-purpose tips shown above the Jarvis FAB while idle, cycling
// through different parts of the app (not just "Ask Jarvis anything").
// Each tip gets its own read-time budget based on text length (~min 4.5s,
// scales up for longer copy) so a short tip doesn't linger and a long tip
// doesn't get cut off mid-read.
export const FAB_FEATURE_TIPS = [
  { id: "fab_tip_custom",   text: "Tip: Go to Custom on Live Model — set your own strategy and build from it." },
  { id: "fab_tip_tools",    text: "Tip: Tools tab → Code Analyzer reads any SportyBet or Lucky's Ledger slip code." },
  { id: "fab_tip_engine",   text: "Tip: The Engine tab only shows fixtures that cleared every confidence threshold." },
  { id: "fab_tip_rollover", text: "Tip: Rollover compounds one slip a day — profit gates lock in gains at steps 3, 5, 7." },
  { id: "fab_tip_perf",     text: "Tip: Performance → Markets — tap any bar to see every pick behind that number." },
  { id: "fab_tip_jarvis",   text: "Ask Jarvis anything" }, // legacy default, kept in rotation
  // #6.1: onboarding tips for filters, themes, and how it works
  { id: "fab_tip_filters",  text: "Tip: Tap Filters to narrow by league, confidence, or data quality." },
  { id: "fab_tip_theme",    text: "Tip: Filters → Change Theme to switch GRM's look and feel." },
  { id: "fab_tip_guide",    text: "Tip: Filters → Learn how it works for a full walkthrough of GRM Pro." },
];

// Minimum and per-character read-time budget (ms) for the tip popup.
// #2-FIX: increased MIN_MS 4500→7000 and PER_CHAR_MS 45→60 so tips are
// readable at a comfortable pace. A ~50 char tip now gets ~7s, ~90 char ~9s.
export function tipReadDuration(text = "") {
  const MIN_MS = 7000;
  const PER_CHAR_MS = 60;
  return Math.max(MIN_MS, Math.min(12000, text.length * PER_CHAR_MS));
}

export const BOOKING_CODE_RE = /\b[A-Z0-9]{6,12}\b/;
export const SB_LINK_RE      = /sportybet\.com/i;
export const LL_LINK_RE      = /luckysledger\.com|luckyledger\.com/i;

export const BOOKIE_LINKS = {
  SB: {
    shareLink: (code) => `https://www.sportybet.com/ng/?shareCode=${code}`,
    appLink:   (code) => `sportybet://share?shareCode=${code}`,
  },
  LL: {
    shareLink: (code) => `https://luckysledger.com/sports?btBookingCode=${code}`,
    appLink:   (code) => `luckysledger://betslip?btBookingCode=${code}`,
  },
};

// ── UTILITY FUNCTIONS ────────────────────────────────────────────────────────

/**
 * Safe clipboard write — execCommand only.
 * N1-FIX: navigator.clipboard.writeText() fires the Android permission prompt
 * at call-time (before the promise resolves/rejects), even with a .catch fallback.
 * Skipping it entirely and using the synchronous execCommand path avoids this.
 * execCommand requires no permission and works in all Android WebViews.
 */
export function copyToClipboard(text, onSuccess, onError) {
  _execCommandCopy(text, onSuccess, onError);
}

function _execCommandCopy(text, onSuccess, onError) {
  try {
    const el = document.createElement("textarea");
    el.value = text;
    el.style.cssText = "position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;pointer-events:none;";
    document.body.appendChild(el);
    el.focus();
    el.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(el);
    if (ok) onSuccess?.(); else onError?.();
  } catch { onError?.(); }
}

/**
 * Convert a win probability (0–100) to implied decimal odds with a 5% margin.
 */
export function safeImpliedOdds(prob) {
  if (!prob || prob <= 0 || prob > 100) return null;
  const raw = 1 / ((prob / 100) * 0.95);
  return isFinite(raw) && raw > 1 ? parseFloat(raw.toFixed(2)) : null;
}

/**
 * Return real odds if valid, otherwise fall back to implied. Floor at 1.02.
 */
export function oddsOrImplied(realOdds, prob) {
  if (realOdds && isFinite(realOdds) && realOdds > 1.01) return parseFloat(realOdds);
  return safeImpliedOdds(prob) || 1.02;
}

/**
 * Infer a market string from a free-text pick label.
 */
export function inferMarket(pick = "") {
  const p = pick.toLowerCase();
  if (/\bwin\b/.test(p))                                    return "1X2";
  if (/draw/.test(p))                                       return "1X2";
  if (/home or|away or|or away/.test(p))                    return "DC";
  if (/btts|both teams/.test(p))                            return "BTTS";
  if (/over|under/.test(p)) {
    if (/corner/.test(p))                                   return "Corners";
    const line = (p.match(/[\d.]+/) || ["2.5"])[0];
    return p.includes("over") ? `Over ${line}` : `Under ${line}`;
  }
  if (/clean sheet|cs/.test(p))                             return "CS";
  return "1X2";
}


/**
 * Parse a natural-language build request for inline legs/market/odds.
 * Examples:
 *   "create me an 8 odds ticket"        → { targetOdds:"8", legs:"auto", market:null }
 *   "5 leg BTTS parley"                 → { legs:5, market:"bttsyes" }
 *   "6-leg over 2.5 Premier League"     → { legs:6, market:"over25", league:"Premier League" }
 *   "build me a parley, 4 legs"         → { legs:4 }
 * Returns null if no recognisable build pattern found.
 */

// ── CANONICAL POOL BUILDER ───────────────────────────────────────────────────

/**
 * Build a sorted confidence pool from fixtures for a given market family.
 * This is the ONE canonical implementation — replaces the fork in ChatLayout.
 *
 * @param {Array}  fixtures        - Today's fixture array from server
 * @param {string} marketFamily    - e.g. "theRead", "over25", "bttsyes", "1X2" …
 * @param {Array}  engineIds       - Set of fixture IDs flagged by the engine (optional)
 * @param {string} poolSource      - "all" | "engine" | "custom"
 * @param {Array}  customFixtureIds - IDs in user's custom list (optional)
 * @returns {Array} sorted pool entries
 */
export function buildPool(fixtures, marketFamily, engineIds = [], poolSource = "all", customFixtureIds = []) {
  if (!fixtures?.length) return [];

  const io  = safeImpliedOdds;
  const oi  = oddsOrImplied;

  // Filter fixture set by pool source
  let pool = fixtures.filter(f => f.state !== "finished" && f.state !== "ft" && f.markets);
  if (poolSource === "engine" && engineIds?.length) {
    const eSet = new Set(engineIds);
    pool = pool.filter(f => eSet.has(f.id));
  } else if (poolSource === "custom" && customFixtureIds?.length) {
    const cSet = new Set(customFixtureIds);
    pool = pool.filter(f => cSet.has(f.id));
    // Fallback to full pool if custom list yields nothing
    if (!pool.length) pool = fixtures.filter(f => f.state !== "finished" && f.state !== "ft" && f.markets);
  }

  const entries = [];
  for (const f of pool) {
    const m   = f.markets;
    const g   = `${f.teams?.home} vs ${f.teams?.away}`;
    const fid = f.id;
    let pick  = null;

    switch (marketFamily) {
      case "theRead":
        if (f.theRead?.anchor && !f.theRead.isFallback) {
          const a = f.theRead.anchor;
          pick = { fixtureId:fid, game:g, pick:a.pick, odds:oi(a.odds,a.prob), conf:a.prob, market:a.market, league:f.league };
        }
        break;
      case "over25": {
        const o = oi(f.odds?.over25odds, m.over25);
        if (o && m.over25) pick = { fixtureId:fid, game:g, pick:"Over 2.5 Goals", odds:o, conf:m.over25, market:"Over 2.5", league:f.league };
        break;
      }
      case "over15": {
        const o = oi(f.odds?.over15odds, m.over15);
        if (o && m.over15) pick = { fixtureId:fid, game:g, pick:"Over 1.5 Goals", odds:o, conf:m.over15, market:"Over 1.5", league:f.league };
        break;
      }
      case "over35": {
        const o = oi(f.odds?.over35odds, m.over35);
        if (o && m.over35) pick = { fixtureId:fid, game:g, pick:"Over 3.5 Goals", odds:o, conf:m.over35, market:"Over 3.5", league:f.league };
        break;
      }
      case "under25": {
        const o = oi(f.odds?.under25odds, m.under25);
        if (o && m.under25) pick = { fixtureId:fid, game:g, pick:"Under 2.5 Goals", odds:o, conf:m.under25, market:"Under 2.5", league:f.league };
        break;
      }
      case "under35": {
        const o = oi(f.odds?.under35odds, m.under35);
        if (o && m.under35) pick = { fixtureId:fid, game:g, pick:"Under 3.5 Goals", odds:o, conf:m.under35, market:"Under 3.5", league:f.league };
        break;
      }
      case "bttsyes": {
        const o = oi(f.odds?.bttsYesOdds, m.bttsYes);
        if (o && m.bttsYes) pick = { fixtureId:fid, game:g, pick:"BTTS Yes", odds:o, conf:m.bttsYes, market:"BTTS", league:f.league };
        break;
      }
      case "bttsno": {
        const o = oi(f.odds?.bttsNoOdds, m.bttsNo);
        if (o && m.bttsNo) pick = { fixtureId:fid, game:g, pick:"BTTS No", odds:o, conf:m.bttsNo, market:"BTTS No", league:f.league };
        break;
      }
      case "1X2":
      case "homewin": {
        const o = oi(f.odds?.o1, m.homeWin);
        if (o && m.homeWin) pick = { fixtureId:fid, game:g, pick:`${f.teams?.home} Win`, odds:o, conf:m.homeWin, market:"1X2", league:f.league };
        break;
      }
      case "DC": {
        // Double chance — pick the best DC outcome available
        const dcHome = oi(f.odds?.dcHome, m.homeWin && m.draw ? (m.homeWin + m.draw) / 2 : null);
        if (dcHome && m.homeWin) pick = { fixtureId:fid, game:g, pick:`${f.teams?.home} or Draw`, odds:dcHome, conf:(m.homeWin||0)+(m.draw||0)*0.5, market:"DC", league:f.league };
        break;
      }
      case "homeo05": {
        const o = io(m.homeOver05);
        if (o && m.homeOver05) pick = { fixtureId:fid, game:g, pick:`${f.teams?.home} to Score`, odds:o, conf:m.homeOver05, market:"TeamTotal", league:f.league };
        break;
      }
      case "awayo05": {
        const o = io(m.awayOver05);
        if (o && m.awayOver05) pick = { fixtureId:fid, game:g, pick:`${f.teams?.away} to Score`, odds:o, conf:m.awayOver05, market:"TeamTotal", league:f.league };
        break;
      }
      default:
        // Unknown market family — fall back to theRead
        if (f.theRead?.anchor && !f.theRead.isFallback) {
          const a = f.theRead.anchor;
          pick = { fixtureId:fid, game:g, pick:a.pick, odds:oi(a.odds,a.prob), conf:a.prob, market:a.market, league:f.league };
        }
    }

    if (pick && pick.conf > 0) entries.push(pick);
  }

  return entries.sort((a, b) => b.conf - a.conf);
}

/**
 * Select legs from a sorted pool, respecting league filter and uniqueness.
 */
export function selectLegsFromPool(pool, legCount, leagueFilter = null) {
  let filtered = pool;
  if (leagueFilter && leagueFilter !== "all") {
    const q = leagueFilter.toLowerCase();
    const byLeague = pool.filter(p => (p.league || "").toLowerCase().includes(q));
    if (byLeague.length >= legCount) filtered = byLeague;
    // else fall back to full pool
  }
  const used = new Set();
  const legs = [];
  for (const entry of filtered) {
    if (used.has(entry.fixtureId)) continue;
    used.add(entry.fixtureId);
    legs.push(entry);
    if (legs.length >= legCount) break;
  }
  return legs;
}

/**
 * Determine leg count from target odds using log estimation.
 * Each leg averages ~1.5 odds → log₁.₅(target).
 */
export function legsFromTargetOdds(targetOdds) {
  const target = parseFloat(targetOdds);
  if (!isFinite(target) || target <= 1) return 6;
  return Math.max(3, Math.min(12, Math.round(Math.log(target) / Math.log(1.5))));
}

/**
 * Build a complete parley from fixtures. One-shot version used by both
 * the quick NL build path and the step-by-step build flow.
 *
 * Returns { ticket, partial } or null if not enough fixtures.
 */
export function buildParley({
  fixtures,
  marketFamily = "theRead",
  legCount     = 6,
  leagueFilter = null,
  poolSource   = "all",
  engineIds    = [],
  customFixtureIds = [],
  excludeIds   = [],
}) {
  const pool = buildPool(fixtures, marketFamily, engineIds, poolSource, customFixtureIds)
    .filter(p => !excludeIds.includes(p.fixtureId));

  const legs = selectLegsFromPool(pool, legCount, leagueFilter);
  if (!legs.length) return null;

  const totalOdds = parseFloat(legs.reduce((acc, l) => acc * (l.odds || 1), 1).toFixed(2));
  const ticket = {
    id:        Date.now(),
    code:      "T" + Math.random().toString(36).slice(2, 6).toUpperCase(),
    mode:      "jarvis",
    legs,
    totalOdds,
    // DATE FIX: every Jarvis-built ticket must carry the date it was built for.
    // Without this, tickets saved from chat have no `date` field, which breaks
    // the backtest evaluator (it groups/filters tickets by date) and any
    // past-date readonly logic that checks ticket.date downstream.
    date:      new Date().toISOString().slice(0, 10),
    createdAt: Date.now(),
    savedAt:   null,
    bookedCode: null,
    marketFamily,
    leagueFilter,
    poolSource,
  };

  return { ticket, partial: legs.length < legCount };
}

// ── FIXTURE HELPERS ──────────────────────────────────────────────────────────

export function findFixture(fixtures, homeQuery, awayQuery) {
  if (!fixtures?.length) return null;
  const norm = s => (s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  const h = norm(homeQuery), a = norm(awayQuery);
  return fixtures.find(f => {
    const fh = norm(f.teams?.home), fa = norm(f.teams?.away);
    return (fh.includes(h) || h.includes(fh.slice(0, 4))) &&
           (fa.includes(a) || a.includes(fa.slice(0, 4)));
  }) || null;
}

/**
 * Find all fixtures matching a partial team name query.
 * Returns array of matches (may be multiple if name is ambiguous).
 * e.g. "Bayern" → [FC Bayern München vs X, Bayern Leverkusen vs Y]
 */
export function findFixturesByTeam(fixtures, query) {
  if (!fixtures?.length || !query) return [];
  const norm = s => (s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  const q = norm(query);
  if (q.length < 3) return [];
  return fixtures.filter(f => {
    const h = norm(f.teams?.home || "");
    const a = norm(f.teams?.away || "");
    return h.includes(q) || a.includes(q);
  });
}

/**
 * Split a natural language string on "and", "plus", "also", "as well as", ","
 * and extract team name queries. Used for multi-add intent.
 * e.g. "Bayern and Barcelona" → ["Bayern", "Barcelona"]
 * e.g. "Barca match, the PSG game and Arsenal" → ["Barca", "PSG", "Arsenal"]
 */
export function splitMultiTeamQuery(text) {
  // Strip common noise words: "match", "game", "fixture", "the", "add"
  const cleaned = text
    .replace(/\b(add|the|match|game|fixture|fixtures|games|and the|plus the)\b/gi, " ")
    .replace(/\s+/g, " ").trim();
  // Split on conjunctions and commas
  const parts = cleaned.split(/\s*(?:,|\band\b|\bplus\b|\balso\b|\bas well as\b)\s*/i);
  return parts
    .map(p => p.trim())
    .filter(p => p.length >= 3);
}

export function getTopFixtures(fixtures, limit = 8) {
  if (!fixtures?.length) return [];
  const rank = f => {
    const ln = (f.league || "").toLowerCase();
    for (let i = 0; i < TOP_LEAGUES_RANK.length; i++) {
      if (ln.includes(TOP_LEAGUES_RANK[i].toLowerCase())) return i;
    }
    return 99;
  };
  return [...fixtures]
    .filter(f => f.state !== "finished" && f.state !== "ft")
    .sort((a, b) => rank(a) - rank(b))
    .slice(0, limit);
}

export function filterFixturesByLeague(fixtures, leagueName) {
  if (!fixtures?.length) return [];
  const q = leagueName.toLowerCase().trim();
  // First try exact contains match (handles "Premier League", "Bundesliga" etc.)
  let res = fixtures.filter(f => (f.league || "").toLowerCase().includes(q));
  if (res.length) return res;
  // Fallback: user may have typed "England Premier League" (from disambiguation chip)
  // Try stripping a leading country token and matching on remaining league name
  const parts = q.split(/\s+/);
  if (parts.length > 1) {
    // Try progressively shorter suffixes: "england premier league" → "premier league"
    for (let i = 1; i < parts.length; i++) {
      const sub = parts.slice(i).join(" ");
      if (sub.length < 4) continue;
      res = fixtures.filter(f => {
        const fl = (f.league || "").toLowerCase();
        const fc = (f.country || "").toLowerCase();
        const prefix = parts.slice(0, i).join(" ");
        return fl.includes(sub) && fc.includes(prefix);
      });
      if (res.length) return res;
    }
  }
  return [];
}

export function getLeagueCountries(fixtures, leagueName) {
  if (!fixtures?.length) return [];
  const q = leagueName.toLowerCase().trim();

  // If the query already has a country prefix (e.g. "England Premier League"),
  // try the full query first. If it returns exactly one country, no disambiguation needed.
  // filterFixturesByLeague's country-prefix fallback will resolve the actual fixtures.
  const parts = q.split(/\s+/);
  if (parts.length > 1) {
    // Check if first word(s) look like a country name by trying a country-scoped match
    const firstWord = parts[0];
    const rest = parts.slice(1).join(" ");
    const countryScoped = fixtures.filter(f =>
      (f.league || "").toLowerCase().includes(rest) &&
      (f.country || "").toLowerCase().includes(firstWord)
    );
    if (countryScoped.length > 0) {
      // Already country-scoped — no disambiguation needed, return single entry
      const f0 = countryScoped[0];
      return [{ country: f0.country || "Unknown", league: f0.league }];
    }
  }

  const seen = new Map();
  fixtures.forEach(f => {
    if ((f.league || "").toLowerCase().includes(q)) {
      const country = f.country || "Unknown";
      if (!seen.has(country)) seen.set(country, f.league);
    }
  });
  const result = [...seen.entries()].map(([country, league]) => ({ country, league }));
  result.sort((a, b) => {
    const ia = TOP_COUNTRIES.indexOf(a.country), ib = TOP_COUNTRIES.indexOf(b.country);
    return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
  });
  return result;
}

// ── BOOKING HELPERS ──────────────────────────────────────────────────────────

/**
 * Open the bookmaker's share link for a ticket.
 * If the ticket has a real booking code, uses that.
 * Otherwise opens the parley builder with a best-effort deep link.
 * NOTE: Real bookmaker API booking is not implemented here — this opens
 * the web/app link which is the correct integration point for SB/LL.
 */
export function openBookingLink(code, platform) {
  const bm = platform === "LL" ? BOOKIE_LINKS.LL : BOOKIE_LINKS.SB;
  const url = bm.shareLink(code);
  try {
    window.open(url, "_blank", "noopener,noreferrer");
  } catch {
    // Fallback: navigate in same tab if popup blocked
    window.location.href = url;
  }
}

/**
 * Generate a placeholder booking code for local display.
 * Real booking codes must come from the bookmaker API.
 * This is labelled clearly as a local draft code until API integration is done.
 */
export function makeDraftCode(platform = "SB") {
  return platform + Math.random().toString(36).slice(2, 6).toUpperCase();
}
