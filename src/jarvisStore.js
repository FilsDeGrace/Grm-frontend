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
  UNSUPPORTED:        "UNSUPPORTED",
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

// ── INTENT CLASSIFIER ────────────────────────────────────────────────────────

/**
 * Classify user text into a structured intent object.
 * Expanded over the old ChatLayout version:
 *   - GREETING intent for hi/hello/thanks/casual
 *   - HELP intent for "what can you do"
 *   - NL build patterns: "8 odds ticket", "5-leg BTTS", "make me a 6 leg parley"
 *   - Inline market + legs detection for one-shot builds
 */
export function classifyIntent(text) {
  const t = text.toLowerCase().trim();

  // ── Greetings & social (must be first — short strings) ──────────────────
  if (/^(hi+|hey+|hello+|hiya|sup|yo|what'?s up|howdy|greetings|good\s*(morning|evening|afternoon|day))\b/i.test(t)) {
    return { intent: INTENT.GREETING };
  }
  if (/^(thanks?|thank you|cheers|nice one|cool|great|ok+|okay|got it|perfect|sounds good|awesome|sweet)\b/i.test(t)) {
    return { intent: INTENT.GREETING, polarity: "positive" };
  }

  // ── Help ────────────────────────────────────────────────────────────────
  if (/what\s*(can|do)\s*(you|u)\s*(do|help|know)|how\s*(do|does)\s*(this|it)\s*work|help me|what.*jarvis.*do|jarvis.*help/i.test(t)) {
    return { intent: INTENT.HELP };
  }

  // ── Code / link detection ────────────────────────────────────────────────
  // ── Code / link detection ────────────────────────────────────────────────
  // Broad detection — handles all realistic user approaches:
  //   - Raw SB/LL links
  //   - "Analyze slip", "analyse slip", "check slip", "check this code", "what about this slip"
  //   - Bare code (4-12 chars alphanumeric, case-insensitive, must contain a digit)
  //   - "Analyze [code]", "analyze slip [code]", "check [code]"
  if (SB_LINK_RE.test(t)) return { intent: INTENT.CODE_ANALYZE, platform: "SB", raw: text };
  if (LL_LINK_RE.test(t)) return { intent: INTENT.CODE_ANALYZE, platform: "LL", raw: text };
  if (/analyz[es]?\s*(slip|this|my|a\s*slip|bet|ticket|code)?|what.*(about|s)\s*(this|my)\s*(slip|code|ticket)|analyse\s*(slip|this|my|a\s*slip|bet|ticket|code)?/i.test(t)) {
    const inlineCode = text.trim().match(/\b([A-Za-z0-9]{4,12})\b/g)
      ?.find(c => c.length >= 4 && /[0-9]/.test(c));
    return { intent: INTENT.CODE_ANALYZE, code: inlineCode || null, raw: text };
  }
  // "check" only triggers CODE_ANALYZE when paired with slip/code/ticket keywords, not generic "check my rollover"
  if (/check\s+(slip|this\s*slip|my\s*slip|a\s*slip|this\s*code|my\s*code|this\s*ticket|my\s*ticket|this\s*bet|my\s*bet)/i.test(t)) {
    const inlineCode = text.trim().match(/\b([A-Za-z0-9]{4,12})\b/g)
      ?.find(c => c.length >= 4 && /[0-9]/.test(c));
    return { intent: INTENT.CODE_ANALYZE, code: inlineCode || null, raw: text };
  }
  // Bare booking code — standalone message (4-12 chars, must have at least one digit)
  const bareCode = text.trim().match(/^([A-Za-z0-9]{4,12})$/);
  if (bareCode && /[0-9]/.test(bareCode[1])) {
    return { intent: INTENT.CODE_ANALYZE, code: bareCode[1].toUpperCase(), raw: text };
  }

  // ── Navigation ───────────────────────────────────────────────────────────
  if (/go to custom|custom tab|custom list|open custom/i.test(t))         return { intent: INTENT.NAVIGATE_CUSTOM };
  if (/custom strategy|my strategies|use strategy|btts strategy|show strategies/i.test(t)) return { intent: INTENT.NAVIGATE_CUSTOM_STRATEGY };
  if (/engine picks|go to engine|engine tab|open engine/i.test(t))        return { intent: INTENT.NAVIGATE_ENGINE };

  // ── Rollover ─────────────────────────────────────────────────────────────
  if (/analytics|rollover stats|rollover history|my performance|rollover chart/i.test(t)) return { intent: INTENT.ROLLOVER_ANALYTICS };
  if (/rollover|today.s rollover|my chain|rollover pick|check my chain/i.test(t))         return { intent: INTENT.ROLLOVER_STATUS };
  // Remix / Add more legs — must be before generic build detection
  if (/^(remix|remix again|regenerate|try again|another one|new version)$/i.test(t))       return { intent: INTENT.REMIX };
  if (/add\s*(more\s*)?legs?|more\s*legs?|add\s*\d+\s*legs?/i.test(t))                    return { intent: INTENT.ADD_MORE_LEGS, raw: text };
  // Odds correction — "I said 8 odds", "make it 10 odds", "no I want X odds", "change to X odds"
  const oddsCorrection = t.match(/(?:i said|make it|no\s*(?:i want)?|change(?:\s*it)?\s*to|i\s*want)\s*(?:an?\s*)?(\d+(?:\.\d+)?)\s*(?:x|×|odds)/i);
  if (oddsCorrection) return { intent: INTENT.ODDS_CORRECTION, targetOdds: oddsCorrection[1], raw: text };

  // ── Strategy / saved ─────────────────────────────────────────────────────
  if (/my saved strategy|use strategy|saved filter|apply strategy/i.test(t)) return { intent: INTENT.STRATEGY };
  if (/my parleys|saved parleys|show tickets|parley \d|ticket \d/i.test(t))  return { intent: INTENT.SAVED_PARLEYS };

  // ── CL9: High-confidence simple requests — skip the flow entirely ───────────
  // "surest parlay", "safest ticket", "give me your best picks", etc.
  // These have clear intent: Jarvis picks, all fixtures, auto legs. No questions needed.
  if (/\b(surest|safest|best|strongest|most confident|sure)\b.*(parlay|ticket|picks?|slip|bet)/i.test(t) ||
      /\b(give me|build me|make me).*(surest|safest|best|sure).*(parlay|ticket|picks?)/i.test(t) ||
      /\b(quick|fast|just build|just make).*(parlay|ticket|slip)/i.test(t)) {
    return { intent: INTENT.BUILD_PARLEY, autoJarvis: true };
  }

  // ── NL build patterns (one-shot: "8 odds ticket", "5 leg BTTS parley") ──
  // Parse inline legs and/or market from the message so Jarvis can build
  // without asking any follow-up questions.
  const nlBuild = _parseNLBuild(t);
  if (nlBuild) return { intent: INTENT.BUILD_PARLEY, ...nlBuild };

  // ── Generic build trigger (no NL params — will use flow) ─────────────────
  if (/build|parley|make a ticket|create a slip|new ticket|make ticket/i.test(t)) {
    return { intent: INTENT.BUILD_PARLEY };
  }

  // ── Fixtures ─────────────────────────────────────────────────────────────
  const leagueMatch = t.match(/\b(premier league|la liga|serie a|bundesliga|ligue 1|championship|liga|eredivisie|mls|primera division|superliga)\b/i);
  if (/today.s fixtures|today.s games|what.s playing|fixtures|games today|matches today/i.test(t) && !leagueMatch) return { intent: INTENT.FIXTURES_TODAY };
  if (leagueMatch && /fixtures|games|matches/i.test(t)) return { intent: INTENT.FIXTURES_FILTERED, league: leagueMatch[1] };
  if (/fixtures|games today|what.s on/i.test(t)) return { intent: INTENT.FIXTURES_TODAY };

  // ── Match analysis ────────────────────────────────────────────────────────
  // Strip opinion/question prefixes first so "what do you think of X vs Y"
  // extracts clean team names rather than contaminating `home`.
  const strippedForMatch = t
    .replace(/^(what do you think of|thoughts on|opinion on|tell me about|how about|analyse|analyze|analysis of|model pick for|how will|what.s.+pick for)\s+/i, "");
  const matchVs = strippedForMatch.match(/^(.+?)\s+(?:vs\.?|versus|against|v\.?)\s+(.+?)(?:\??$| —)/i);
  if (matchVs) {
    const needsJarvis = /jarvis|research|injuries|squad news|news/i.test(t);
    return {
      intent: needsJarvis ? INTENT.JARVIS_ANALYSIS : INTENT.MATCH_ANALYSIS,
      home: matchVs[1].trim(),
      away: matchVs[2].trim(),
      naturalQuery: t, // pass original for Gemini context
    };
  }

  // ── CL10: Natural football/betting questions — route to Gemini via UNKNOWN ─
  // Broad natural language that doesn't fit a hardcoded pattern but is clearly
  // football or betting related. Don't intercept — let Gemini handle them.
  // (Returning UNKNOWN here is intentional — handleUnknown calls /api/jarvis-chat)
  if (/\b(form|in form|good bet|safe bet|banker|confident|btts|over|under|goals|clean sheet|both teams|first half|anytime|goalscorer|draw|upset|favourite|underdog|injury|injuries|lineup|squad|suspended|missing|ban|red card)\b/i.test(t)) {
    return { intent: INTENT.UNKNOWN };
  }

  return { intent: INTENT.UNKNOWN };
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
function _parseNLBuild(t) {
  // Must contain a build-related word to qualify
  const hasBuildWord = /ticket|parley|slip|acca|accumulator|bet|pick|build|create|make|generate/i.test(t);
  // OR a direct legs/odds pattern with no other matching intent
  const hasLegsOdds  = /\d+\s*(?:leg|fold|way|odds|x)/i.test(t);
  // OR a custom/engine pool reference with a market
  const hasPoolRef   = /custom|my list|my games|engine/i.test(t);
  if (!hasBuildWord && !hasLegsOdds && !hasPoolRef) return null;

  const result = {};

  // Extract leg count: "5 leg", "6-leg", "5fold", "5 way", "top 10", "top 5"
  const legsM = t.match(/(\d+)\s*(?:leg|fold|way)\b/i) || t.match(/\btop\s*(\d+)\b/i);
  if (legsM) result.legs = parseInt(legsM[1], 10);

  // Extract target odds: "8 odds", "×10", "x10", "10x", "8odds"
  const oddsM = t.match(/(?:×|x|times\s*)?(\d+(?:\.\d+)?)\s*(?:odds|x\b|×)/i)
             || t.match(/\b(\d+(?:\.\d+)?)\s*odds\b/i);
  if (oddsM) result.targetOdds = oddsM[1];

  // Extract market
  const market = _parseMarket(t);
  if (market) result.market = market;

  // Extract league
  const leagueM = t.match(/\b(premier league|la liga|serie a|bundesliga|ligue 1|championship|eredivisie|mls)\b/i);
  if (leagueM) result.league = leagueM[1];

  // Extract pool source — custom list or engine only
  // Handles: "from custom", "in custom", "custom list", "my list", "my games",
  //          "from my custom", "using custom", "engine only", "engine picks", "from engine"
  if (/\b(custom|my list|my games|from my|in my custom|in custom|using custom|from custom)\b/i.test(t)) {
    result.pool = "custom";
  } else if (/\b(engine only|engine picks?|from engine|engine games?|engine fixtures?)\b/i.test(t)) {
    result.pool = "engine";
  }

  // Must have extracted at least one meaningful param
  if (!result.legs && !result.targetOdds && !result.market && !result.league && !result.pool) return null;

  return result;
}

function _parseMarket(t) {
  if (/btts\s*yes|both teams.*score/i.test(t))     return "bttsyes";
  if (/btts\s*no/i.test(t))                         return "bttsno";
  if (/over\s*3\.5|o3\.5/i.test(t))                return "over35";
  if (/over\s*2\.5|o2\.5/i.test(t))                return "over25";
  if (/over\s*1\.5|o1\.5/i.test(t))                return "over15";
  if (/under\s*2\.5|u2\.5/i.test(t))               return "under25";
  if (/under\s*3\.5|u3\.5/i.test(t))               return "under35";
  if (/under\s*1\.5|u1\.5/i.test(t))               return "under15";
  if (/1x2|home.*draw.*away/i.test(t))              return "1X2";
  if (/double chance|dc\b/i.test(t))                return "DC";
  if (/home.*score|home.*goal|h\s*o0\.5/i.test(t)) return "homeo05";
  if (/away.*score|away.*goal|a\s*o0\.5/i.test(t)) return "awayo05";
  if (/model pick|the read|engine pick|jarvis pick|grmread/i.test(t)) return "theRead";
  return null;
}

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
  const q = leagueName.toLowerCase();
  return fixtures.filter(f => (f.league || "").toLowerCase().includes(q));
}

export function getLeagueCountries(fixtures, leagueName) {
  if (!fixtures?.length) return [];
  const q = leagueName.toLowerCase();
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
