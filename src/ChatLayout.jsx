/**
 * ChatLayout.jsx — GRM Pro Jarvis Overlay
 * ─────────────────────────────────────────
 * Jarvis is a floating co-pilot panel that overlays Pro — not a separate screen.
 * Open/close via the persistent bolt FAB rendered by App.jsx.
 * No bottom nav. No layout switching. Jarvis stays available on every Pro tab.
 *
 * Props (received from App.jsx):
 *   isOpen              — bool: panel visible?
 *   onClose             — fn(): close the panel (App controls FAB)
 *   C                   — live color token object (theme-aware)
 *   fixtures            — array of fixture objects from server
 *   fixturesLoaded      — bool: has today's fetch succeeded?
 *   fetchingFixtures    — bool: fetch in progress?
 *   onFetchFixtures     — fn(): trigger today's fixture fetch
 *   fetchError          — string | null: last fetch error message
 *   savedTickets        — array of saved parley ticket objects
 *   onSaveTicket        — fn(ticket): save a built ticket
 *   onDeleteTicket      — fn(ticketId): delete saved ticket
 *   rolloverChain       — object | null: active rollover chain state
 *   historicalRates     — object: backtest summary for pool scoring
 *   onNavigatePro       — fn(destination): navigate Pro to a specific place
 *                         destination: { tab?, subTab?, code?, fixture?, autoAnalyze? }
 *   onBookNow           — fn(ticket, bookmaker): trigger booking flow
 *   defaultBookmaker    — 'SB' | 'LL'
 *   geminiApiKey        — string | null: key for Gemini fallback on unknown intents
 */

import React, {
  useState, useEffect, useRef, useCallback, useMemo, useReducer
} from "react";

// ── CONSTANTS ────────────────────────────────────────────────────────────────

const CHAT_HISTORY_KEY   = "grm_chat_history";
const BUILD_PREF_KEY     = "grm_chat_build_pref";
const TIP_PREFIX         = "grm_tip_";
const MAX_RENDERED_MSGS  = 30;

// Intent IDs
const INTENT = {
  ROLLOVER_STATUS:    "ROLLOVER_STATUS",
  ROLLOVER_ANALYTICS: "ROLLOVER_ANALYTICS",
  BUILD_PARLEY:       "BUILD_PARLEY",
  MATCH_ANALYSIS:     "MATCH_ANALYSIS",
  JARVIS_ANALYSIS:    "JARVIS_ANALYSIS",
  FIXTURES_TODAY:     "FIXTURES_TODAY",
  FIXTURES_FILTERED:  "FIXTURES_FILTERED",
  CODE_ANALYZE:       "CODE_ANALYZE",
  NAVIGATE_CUSTOM:    "NAVIGATE_CUSTOM",
  NAVIGATE_ENGINE:    "NAVIGATE_ENGINE",
  SAVED_PARLEYS:      "SAVED_PARLEYS",
  STRATEGY:           "STRATEGY",
  UNKNOWN:            "UNKNOWN",
};

// Build flow steps
const BUILD_STEP = {
  MODE:         "MODE",
  POOL:         "POOL",
  LEGS_TARGET:  "LEGS_TARGET",  // combined legs + target odds
  MARKET:       "MARKET",
  LEAGUES:      "LEAGUES",
  CONFIRM:      "CONFIRM",
};

const LEG_OPTIONS = [4, 5, 6, 8, 10];

const MARKET_GROUPS = [
  { group: "RESULT",      items: [{ id:"1X2", label:"1X2 — Home/Draw/Away" }, { id:"DC", label:"Double Chance" }] },
  { group: "GOALS",       items: [{ id:"over25", label:"Over 2.5", mapped:"Over 2.5" }, { id:"over15", label:"Over 1.5", mapped:"Over 1.5" }, { id:"over35", label:"Over 3.5", mapped:"Over 3.5" }, { id:"under25", label:"Under 2.5", mapped:"Under 2.5" }, { id:"under35", label:"Under 3.5", mapped:"Under 3.5" }] },
  { group: "BOTH TEAMS",  items: [{ id:"bttsyes", label:"BTTS Yes" }, { id:"bttsno", label:"BTTS No" }] },
  { group: "TEAM TOTALS", items: [{ id:"homeo05", label:"Home to Score (O0.5)" }, { id:"awayo05", label:"Away to Score (O0.5)" }] },
  { group: "NOT MODELLED", items: [{ id:"corners", label:"Corners", untracked:true }, { id:"correct_score", label:"Correct Score", untracked:true }, { id:"cards", label:"Cards", untracked:true }], muted:true },
];

const TOP_LEAGUES_RANK = ["Premier League", "La Liga", "Serie A", "Bundesliga", "Ligue 1", "Champions League", "UEFA"];
const TOP_COUNTRIES    = ["England", "Spain", "Italy", "Germany", "France", "Portugal", "Netherlands"];

const BOOKING_CODE_RE  = /\b[A-Z0-9]{6,12}\b/;
const SB_LINK_RE       = /sportybet\.com/i;
const LL_LINK_RE       = /luckysledger\.com|luckyledger\.com/i;

// ── SVG ICONS ────────────────────────────────────────────────────────────────

const BoltIcon = ({ size = 14, color = "currentColor" }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>
  </svg>
);

const SendIcon = ({ size = 16 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/>
  </svg>
);

const ChatIcon = ({ size = 18 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
  </svg>
);

const SavedIcon = ({ size = 18 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/>
  </svg>
);

const RolloverIcon = ({ size = 18 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 .49-3"/>
  </svg>
);

const SettingsIcon = ({ size = 18 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
  </svg>
);

const ProIcon = ({ size = 14 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>
  </svg>
);

const HelpIcon = ({ size = 14 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/>
  </svg>
);

const BackIcon = ({ size = 13 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="15 18 9 12 15 6"/>
  </svg>
);

const TicketIcon = ({ size = 13 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M2 9a3 3 0 0 1 0 6v2a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-2a3 3 0 0 1 0-6V7a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2z"/>
  </svg>
);

const XIcon = ({ size = 13 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
    <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
  </svg>
);

const RefreshIcon = ({ size = 13 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>
  </svg>
);

const BookmarkIcon = ({ size = 13 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/>
  </svg>
);

const LoaderIcon = ({ size = 14 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
    style={{ animation: "grm-spin 0.8s linear infinite" }}>
    <line x1="12" y1="2" x2="12" y2="6"/><line x1="12" y1="18" x2="12" y2="22"/>
    <line x1="4.93" y1="4.93" x2="7.76" y2="7.76"/><line x1="16.24" y1="16.24" x2="19.07" y2="19.07"/>
    <line x1="2" y1="12" x2="6" y2="12"/><line x1="18" y1="12" x2="22" y2="12"/>
    <line x1="4.93" y1="19.07" x2="7.76" y2="16.24"/><line x1="16.24" y1="7.76" x2="19.07" y2="4.93"/>
  </svg>
);

// ── UTILITY HELPERS ──────────────────────────────────────────────────────────

function genId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

function safeGet(key, fallback) {
  try { const v = sessionStorage.getItem(key); return v ? JSON.parse(v) : fallback; } catch { return fallback; }
}

function safeSet(key, val) {
  try { sessionStorage.setItem(key, JSON.stringify(val)); } catch {}
}

function safeLocalGet(key, fallback) {
  try { const v = localStorage.getItem(key); return v != null ? JSON.parse(v) : fallback; } catch { return fallback; }
}

function safeLocalSet(key, val) {
  try { localStorage.setItem(key, JSON.stringify(val)); } catch {}
}

function isTipSuppressed(tipId) {
  try {
    const stored = localStorage.getItem(`${TIP_PREFIX}${tipId}`);
    if (!stored) return false;
    return Date.now() - parseInt(stored, 10) < 7 * 86400000;
  } catch { return false; }
}

function suppressTip(tipId) {
  try { localStorage.setItem(`${TIP_PREFIX}${tipId}`, String(Date.now())); } catch {}
}

// Implied odds helper (mirrors App.jsx)
function safeImpliedOdds(prob) {
  if (!prob || prob <= 0 || prob > 100) return null;
  const raw = 1 / ((prob / 100) * 0.95);
  return isFinite(raw) && raw > 1 ? parseFloat(raw.toFixed(2)) : null;
}

// ── INTENT CLASSIFIER ────────────────────────────────────────────────────────

function classifyIntent(text) {
  const t = text.toLowerCase().trim();

  // Code / link detection — check early, no ambiguity
  if (SB_LINK_RE.test(t) || LL_LINK_RE.test(t)) return { intent: INTENT.CODE_ANALYZE, platform: SB_LINK_RE.test(t) ? "SB" : "LL", raw: text };
  if (/analyze this|check this slip|analyze.*code|check.*code/i.test(t)) return { intent: INTENT.CODE_ANALYZE, raw: text };
  // Standalone booking code pattern (all caps alphanumeric, 6–12 chars, nothing else significant around it)
  const codeMatch = text.trim().match(/^([A-Z0-9]{6,12})$/);
  if (codeMatch) return { intent: INTENT.CODE_ANALYZE, code: codeMatch[1], raw: text };

  // Navigation
  if (/go to custom|custom tab|custom list|open custom/i.test(t))   return { intent: INTENT.NAVIGATE_CUSTOM };
  if (/engine picks|go to engine|engine tab|open engine/i.test(t))  return { intent: INTENT.NAVIGATE_ENGINE };

  // Rollover
  if (/analytics|rollover stats|rollover history|my performance|rollover chart/i.test(t)) return { intent: INTENT.ROLLOVER_ANALYTICS };
  if (/rollover|today.s rollover|my chain|rollover pick|check my chain/i.test(t))          return { intent: INTENT.ROLLOVER_STATUS };

  // Strategy
  if (/my saved strategy|use strategy|saved filter|apply strategy/i.test(t)) return { intent: INTENT.STRATEGY };

  // Saved parleys
  if (/my parleys|saved parleys|show tickets|parley \d|ticket \d/i.test(t)) return { intent: INTENT.SAVED_PARLEYS };

  // Build parley
  if (/build|parley|make a ticket|create a slip|new ticket|make ticket/i.test(t)) return { intent: INTENT.BUILD_PARLEY };

  // Fixtures (must come after build to avoid false match on "today's games" in build context)
  const leagueMatch = t.match(/\b(premier league|la liga|serie a|bundesliga|ligue 1|championship|liga|eredivisie|mls|bundesliga|primera division|superliga)\b/i);
  if (/today.s fixtures|today.s games|what.s playing|fixtures|games today|matches today/i.test(t) && !leagueMatch) return { intent: INTENT.FIXTURES_TODAY };
  if (leagueMatch && /fixtures|games|matches/i.test(t)) return { intent: INTENT.FIXTURES_FILTERED, league: leagueMatch[1] };
  if (/fixtures|games today|what.s on/i.test(t)) return { intent: INTENT.FIXTURES_TODAY };

  // Match analysis
  const matchVs = t.match(/(?:analysis of |analyse |analyze |model pick for |what.s.+pick for |how will )?(.+?)\s+(?:vs|versus|against|v\.?)\s+(.+?)(?:\??$| —)/i);
  if (matchVs) {
    const needsJarvis = /jarvis|research|injuries|squad news|news/i.test(t);
    return {
      intent: needsJarvis ? INTENT.JARVIS_ANALYSIS : INTENT.MATCH_ANALYSIS,
      home: matchVs[1].trim(),
      away: matchVs[2].trim(),
    };
  }

  return { intent: INTENT.UNKNOWN };
}

// ── FIXTURE HELPERS ──────────────────────────────────────────────────────────

function findFixture(fixtures, homeQuery, awayQuery) {
  if (!fixtures?.length) return null;
  const norm = s => (s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  const h = norm(homeQuery), a = norm(awayQuery);
  return fixtures.find(f => {
    const fh = norm(f.teams?.home), fa = norm(f.teams?.away);
    return (fh.includes(h) || h.includes(fh.slice(0, 4))) &&
           (fa.includes(a) || a.includes(fa.slice(0, 4)));
  }) || null;
}

function getTopFixtures(fixtures, limit = 8) {
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

function filterFixturesByLeague(fixtures, leagueName) {
  if (!fixtures?.length) return [];
  const q = leagueName.toLowerCase();
  return fixtures.filter(f => (f.league || "").toLowerCase().includes(q));
}

function getLeagueCountries(fixtures, leagueName) {
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
  // Sort: top countries first
  result.sort((a, b) => {
    const ia = TOP_COUNTRIES.indexOf(a.country), ib = TOP_COUNTRIES.indexOf(b.country);
    return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
  });
  return result;
}

// Build a parley pool (simplified version matching App.jsx pool builder logic)
function buildChatPool(fixtures, marketFamily, historicalRates) {
  if (!fixtures?.length) return [];
  const pool = [];
  for (const f of fixtures) {
    if (f.state === "finished" || f.state === "ft") continue;
    const m = f.markets;
    if (!m) continue;
    let pick = null;
    const io = safeImpliedOdds;
    const oi = (realOdds, prob) => {
      if (realOdds && isFinite(realOdds) && realOdds > 1.01) return parseFloat(realOdds);
      return io(prob) || 1.02;
    };
    if (marketFamily === "theRead" && f.theRead?.anchor && !f.theRead.isFallback) {
      const a = f.theRead.anchor;
      pick = { fixtureId:f.id, game:`${f.teams.home} vs ${f.teams.away}`, pick:a.pick, odds:oi(a.odds,a.prob), conf:a.prob, market:a.market, league:f.league };
    } else if (marketFamily === "over25") {
      const o = oi(f.odds?.over25odds, m.over25); if(o && m.over25) pick = { fixtureId:f.id, game:`${f.teams.home} vs ${f.teams.away}`, pick:"Over 2.5 Goals", odds:o, conf:m.over25, market:"Over 2.5", league:f.league };
    } else if (marketFamily === "over15") {
      const o = oi(f.odds?.over15odds, m.over15); if(o && m.over15) pick = { fixtureId:f.id, game:`${f.teams.home} vs ${f.teams.away}`, pick:"Over 1.5 Goals", odds:o, conf:m.over15, market:"Over 1.5", league:f.league };
    } else if (marketFamily === "bttsyes") {
      const o = oi(f.odds?.bttsYesOdds, m.bttsYes); if(o && m.bttsYes) pick = { fixtureId:f.id, game:`${f.teams.home} vs ${f.teams.away}`, pick:"BTTS Yes", odds:o, conf:m.bttsYes, market:"BTTS", league:f.league };
    } else if (marketFamily === "1X2" || marketFamily === "homewin") {
      const o = oi(f.odds?.o1, m.homeWin); if(o && m.homeWin) pick = { fixtureId:f.id, game:`${f.teams.home} vs ${f.teams.away}`, pick:`${f.teams.home} Win`, odds:o, conf:m.homeWin, market:"1X2", league:f.league };
    } else if (marketFamily === "under25") {
      const o = oi(f.odds?.under25odds, m.under25); if(o && m.under25) pick = { fixtureId:f.id, game:`${f.teams.home} vs ${f.teams.away}`, pick:"Under 2.5 Goals", odds:o, conf:m.under25, market:"Under 2.5", league:f.league };
    }
    if (pick && pick.conf > 0) pool.push(pick);
  }
  return pool.sort((a, b) => b.conf - a.conf);
}

function buildParleyFromPool(pool, legCount, leagueFilter) {
  let filtered = pool;
  if (leagueFilter && leagueFilter !== "all") {
    const q = leagueFilter.toLowerCase();
    filtered = pool.filter(p => (p.league || "").toLowerCase().includes(q));
    if (filtered.length < legCount) filtered = pool; // fallback to full pool
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

// ── MESSAGE FACTORY ──────────────────────────────────────────────────────────

function makeUserMsg(text) {
  return { id: genId(), role: "user", text, ts: Date.now() };
}

function makeJarvisMsg(content, chips = []) {
  return { id: genId(), role: "jarvis", content, chips, ts: Date.now() };
}

function makeLoadingMsg() {
  return { id: genId(), role: "jarvis", loading: true, ts: Date.now() };
}

// ── MAIN COMPONENT ───────────────────────────────────────────────────────────

export default function ChatLayout({
  isOpen = false,
  onClose,
  C,
  fixtures = [],
  fixturesLoaded = false,
  fetchingFixtures = false,
  onFetchFixtures,
  fetchError = null,
  savedTickets = [],
  onSaveTicket,
  onDeleteTicket,
  rolloverChain = null,
  historicalRates = null,
  onNavigatePro,
  onBookNow,
  defaultBookmaker = "SB",
  geminiApiKey = null,
}) {
  // ── Message state
  const [messages, setMessages]         = useState(() => safeGet(CHAT_HISTORY_KEY, null));
  const [input, setInput]               = useState("");
  const [isTyping, setIsTyping]         = useState(false);

  // ── Build flow state
  const [buildFlow, setBuildFlow]       = useState(null);

  // ── Bottom sheet / help
  const [bottomSheet, setBottomSheet]   = useState(null);
  const [helpOpen, setHelpOpen]         = useState(false);

  // ── Misc
  const [sessionTipShown, setSessionTipShown]     = useState(false);
  const [deleteConfirm, setDeleteConfirm]         = useState(null);
  const [chatLastAction, setChatLastAction]       = useState(null);
  const [sessionBuildCount, setSessionBuildCount] = useState(0);
  const [sessionFixtureQueryCount, setSessionFixtureQueryCount] = useState(0);

  const messagesEndRef = useRef(null);
  const inputRef       = useRef(null);

  const isGateOpen  = !fixturesLoaded;
  const chatEnabled = fixturesLoaded;

  // ── Init messages from sessionStorage on mount
  useEffect(() => {
    if (messages === null) {
      // Truly first open — show welcome on next render cycle
      setMessages([]);
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Persist messages on change (last 30)
  useEffect(() => {
    if (messages === null) return;
    const toStore = messages.slice(-MAX_RENDERED_MSGS);
    safeSet(CHAT_HISTORY_KEY, toStore);
  }, [messages]);

  // ── Auto-scroll on new messages
  useEffect(() => {
    if (messagesEndRef.current) {
      messagesEndRef.current.scrollIntoView({ behavior: "smooth" });
    }
  }, [messages, isTyping]);

  // ── Welcome message on first open (after fixtures loaded)
  useEffect(() => {
    if (!fixturesLoaded) return;
    if (messages !== null && messages.length > 0) return;
    // Show welcome
    const welcome = makeJarvisMsg({ type: "WELCOME" }, [
      { label: "Build me a parley", text: "Build me a parley" },
      { label: "Today's fixtures",  text: "Today's fixtures"  },
      { label: "Check my Rollover", text: "Check my Rollover" },
      { label: "Analyse a slip",    text: "Analyse a slip"    },
    ]);
    setMessages([welcome]);
  }, [fixturesLoaded]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Partial fetch notice
  useEffect(() => {
    if (!fixturesLoaded) return;
    if (messages === null || messages.length === 0) return;
    // If a partial fetch flag is set on fixtures
    const hasPartial = fixtures.some(f => f._partialLeague);
    if (hasPartial) {
      addJarvisMsg({ type: "TEXT", text: "Fixtures loaded — some leagues may be incomplete." });
    }
  }, [fixturesLoaded]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── HELPERS ────────────────────────────────────────────────────────────────

  const addMsg = useCallback((msg) => {
    setMessages(prev => [...(prev || []), msg]);
  }, []);

  const replaceLoadingMsg = useCallback((loadingId, finalMsg) => {
    setMessages(prev =>
      (prev || []).map(m => m.id === loadingId ? finalMsg : m)
    );
  }, []);

  const addJarvisMsg = useCallback((content, chips = []) => {
    addMsg(makeJarvisMsg(content, chips));
  }, [addMsg]);

  const simulateTyping = useCallback(async (durationMs = 700) => {
    setIsTyping(true);
    await new Promise(r => setTimeout(r, durationMs));
    setIsTyping(false);
  }, []);

  const getBuildPref = useCallback(() => safeLocalGet(BUILD_PREF_KEY, null), []);
  const saveBuildPref = useCallback((mode) => safeLocalSet(BUILD_PREF_KEY, mode), []);

  // ── TIP ENGINE ──────────────────────────────────────────────────────────────

  const maybeShowTip = useCallback((tipId, text) => {
    if (sessionTipShown) return;
    if (isTipSuppressed(tipId)) return;
    suppressTip(tipId);
    setSessionTipShown(true);
    setTimeout(() => {
      addJarvisMsg({ type: "TIP", text });
    }, 1200);
  }, [sessionTipShown, addJarvisMsg]);

  // ── INTENT HANDLERS ─────────────────────────────────────────────────────────

  async function handleRolloverStatus() {
    await simulateTyping(600);
    if (!rolloverChain) {
      addJarvisMsg({ type: "TEXT", text: "You don't have an active Rollover chain." }, [
        { label: "Start Rollover", action: "NAV_ROLLOVER" },
      ]);
      return;
    }
    const chain = rolloverChain;
    const pick  = chain.pick || chain.todayPick || null;
    if (!pick) {
      addJarvisMsg({ type: "TEXT", text: "Today's pick hasn't been locked yet. Check back later or visit the Rollover tab." }, [
        { label: "Go to Rollover", action: "NAV_ROLLOVER" },
      ]);
      return;
    }
    addJarvisMsg({
      type: "ROLLOVER_CARD",
      chain,
      pick,
      booked: chain.todayBooked || false,
    }, [
      { label: "View Rollover", action: "NAV_ROLLOVER" },
    ]);
  }

  async function handleRolloverAnalytics() {
    await simulateTyping(400);
    addJarvisMsg({ type: "TEXT", text: "Opening your Rollover analytics…" }, [
      { label: "Go to Rollover", action: "NAV_ROLLOVER" },
    ]);
    onNavigatePro?.({ tab: "rollover" });
  }

  function startBuildFlow() {
    const pref = getBuildPref();
    if (pref) {
      // Show pref popup briefly, then start from Step 2
      setBuildFlow({ step: BUILD_STEP.POOL, mode: pref, prefPopupVisible: true });
      setTimeout(() => setBuildFlow(prev => prev ? { ...prev, prefPopupVisible: false } : prev), 2500);
    } else {
      setBuildFlow({ step: BUILD_STEP.MODE });
    }
    addJarvisMsg({ type: "BUILD_MODE_SELECT" });
  }

  async function handleBuildParley() {
    await simulateTyping(400);
    startBuildFlow();
  }

  async function handleMatchAnalysis(home, away, withJarvis = false) {
    await simulateTyping(800);
    if (!fixturesLoaded) {
      addJarvisMsg({ type: "TEXT", text: "Fixtures aren't loaded yet." }, [{ label: "Fetch fixtures", action: "FETCH" }]);
      return;
    }
    const fixture = findFixture(fixtures, home, away);
    if (!fixture) {
      // Check for ambiguous team names
      addJarvisMsg({ type: "TEXT", text: `Couldn't find a match for "${home} vs ${away}" in today's fixtures.` }, [
        { label: "Open Live Model", action: "NAV_ENGINE" },
      ]);
      return;
    }
    addJarvisMsg({
      type: "MATCH_CARD",
      fixture,
      withJarvis,
    }, [
      { label: "+ Add to parley", action: "ADD_LEG", fixture },
      { label: "Open in Pro", action: "NAV_FULL_MODEL", fixture },
    ]);
    maybeShowTip("match_analysis_tip", "Tip: Add 'Jarvis research' to any match query and I'll check injuries and squad news.");
  }

  async function handleFixturesToday() {
    setSessionFixtureQueryCount(c => {
      const next = c + 1;
      if (next >= 2) maybeShowTip("fixtures_filter_tip", "Tip: You can filter by league — try 'England Premier League games'.");
      return next;
    });
    await simulateTyping(600);
    if (!fixturesLoaded) {
      addJarvisMsg({ type: "TEXT", text: "No fixtures loaded yet." }, [{ label: "Fetch fixtures", action: "FETCH" }]);
      return;
    }
    const top = getTopFixtures(fixtures);
    addJarvisMsg({ type: "FIXTURES_CARD", fixtures: top, label: "Top games today" }, [
      { label: "Build a parley", text: "Build me a parley" },
    ]);
  }

  async function handleFixturesFiltered(leagueName) {
    setSessionFixtureQueryCount(c => {
      const next = c + 1;
      if (next >= 2) maybeShowTip("fixtures_filter_tip", "Tip: You can filter by league — try 'England Premier League games'.");
      return next;
    });
    await simulateTyping(600);
    if (!fixturesLoaded) {
      addJarvisMsg({ type: "TEXT", text: "No fixtures loaded yet." }, [{ label: "Fetch fixtures", action: "FETCH" }]);
      return;
    }
    const countries = getLeagueCountries(fixtures, leagueName);
    if (countries.length > 1) {
      // Disambiguation
      addJarvisMsg({
        type: "TEXT",
        text: `Which ${leagueName}?`,
      }, countries.map(c => ({
        label: `${c.country} — ${c.league}`,
        text:  `${c.country} ${leagueName} fixtures`,
      })).concat([{ label: "Show all", text: `All ${leagueName} fixtures` }]));
      return;
    }
    const fx = filterFixturesByLeague(fixtures, leagueName);
    if (!fx.length) {
      addJarvisMsg({ type: "TEXT", text: `No fixtures found for ${leagueName} today.` }, [
        { label: "Today's top fixtures", text: "Today's fixtures" },
      ]);
      return;
    }
    addJarvisMsg({ type: "FIXTURES_CARD", fixtures: fx.slice(0, 10), label: leagueName });
  }

  async function handleCodeAnalyze(platform, code) {
    await simulateTyping(500);
    if (!platform) {
      addJarvisMsg({ type: "CODE_PLATFORM_SELECT", code }, []);
      return;
    }
    addJarvisMsg({ type: "TEXT", text: "Opening Code Analyzer with your slip pre-loaded…" }, [
      { label: "Go to Code Analyzer", action: "NAV_CODE", platform, code },
    ]);
    // Auto-fire after 1.5s
    setTimeout(() => {
      onNavigatePro?.({ layout: "pro", tab: "code", platform, code, autoAnalyze: true });
    }, 1500);
  }

  async function handleNavigateCustom() {
    await simulateTyping(400);
    addJarvisMsg({ type: "TEXT", text: "Opening Custom List…" }, [
      { label: "Go to Custom", action: "NAV_CUSTOM" },
    ]);
    setTimeout(() => onNavigatePro?.({ layout: "pro", tab: "live", subTab: "custom" }), 800);
  }

  async function handleNavigateEngine() {
    await simulateTyping(400);
    addJarvisMsg({ type: "TEXT", text: "Opening Engine picks…" }, [
      { label: "Go to Engine", action: "NAV_ENGINE" },
    ]);
    setTimeout(() => onNavigatePro?.({ layout: "pro", tab: "live", subTab: "engine" }), 800);
  }

  async function handleSavedParleys() {
    await simulateTyping(400);
    if (!savedTickets.length) {
      addJarvisMsg({ type: "TEXT", text: "You don't have any saved parleys yet." }, [
        { label: "Build one", text: "Build me a parley" },
      ]);
      return;
    }
    addJarvisMsg({
      type: "TEXT",
      text: `You have ${savedTickets.length} saved parley${savedTickets.length > 1 ? "s" : ""} — go to Saved tab to view them.`,
    }, [
      { label: "Go to Saved", action: "NAV_SAVED" },
    ]);
  }

  async function handleStrategy() {
    await simulateTyping(400);
    const strategy = safeLocalGet("grm_saved_strategy", null);
    if (!strategy) {
      addJarvisMsg({ type: "TEXT", text: "You don't have a saved strategy yet. Go to the Custom tab to create one." }, [
        { label: "Open Custom tab", action: "NAV_CUSTOM" },
      ]);
      return;
    }
    addJarvisMsg({
      type: "TEXT",
      text: `Applying your saved strategy: "${strategy.label || "Custom Strategy"}"…`,
    }, [
      { label: "Open in Live Model", action: "NAV_CUSTOM" },
    ]);
    setTimeout(() => onNavigatePro?.({ layout: "pro", tab: "live", subTab: "custom", strategy }), 800);
  }

  async function handleUnknown(rawText) {
    // First — show typing
    await simulateTyping(500);

    // Try Gemini if key available
    if (geminiApiKey) {
      const loadingMsg = makeLoadingMsg();
      addMsg(loadingMsg);
      try {
        const systemCtx = `You are Jarvis, the AI co-pilot inside GRM Pro — a football predictions and parley-building app.
You can: build parleys, analyze fixtures, check rollover status, analyze booking slips (SportyBet/Lucky's Ledger), navigate to Custom/Engine/Rollover tabs, show today's fixtures, give match model picks.
You cannot: place bets, access live odds, access external sites.
Always reply concisely (2–3 sentences max). If the user's request matches something GRM can do, tell them exactly what to say. If it's completely off-topic, say so politely.`;

        const res = await fetch("https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=" + geminiApiKey, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            system_instruction: { parts: [{ text: systemCtx }] },
            contents: [{ parts: [{ text: rawText }] }],
            generationConfig: { maxOutputTokens: 120, temperature: 0.4 },
          }),
        });
        const json = await res.json();
        const reply = json?.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
        if (reply) {
          replaceLoadingMsg(loadingMsg.id, makeJarvisMsg(
            { type: "TEXT", text: reply },
            [
              { label: "Build a parley",    text: "Build me a parley"        },
              { label: "Today's fixtures",  text: "Today's fixtures"         },
              { label: "My Rollover",       text: "What's my rollover status?" },
            ]
          ));
          return;
        }
      } catch {}
      // Gemini failed — fall through to default
      replaceLoadingMsg(loadingMsg.id, makeJarvisMsg(
        { type: "TEXT", text: "I'm not sure I got that. Here's what I can help with:" },
        [
          { label: "Build a parley",    text: "Build me a parley"          },
          { label: "Today's fixtures",  text: "Today's fixtures"           },
          { label: "My Rollover",       text: "What's my rollover status?" },
          { label: "Analyse a slip",    text: "Analyse a slip"             },
        ]
      ));
      return;
    }

    // No Gemini key — context-aware default chips
    const chips = chatLastAction?.type === "PARLEY_BUILT"
      ? [
          { label: "Remix",         text: "Remix"                          },
          { label: "Add more legs", text: "Add more legs"                  },
          { label: "New parley",    text: "Build me a new parley"          },
        ]
      : [
          { label: "Build a parley",   text: "Build me a parley"          },
          { label: "Check fixtures",   text: "Today's fixtures"           },
          { label: "My Rollover",      text: "What's my rollover status?" },
        ];
    addJarvisMsg({ type: "TEXT", text: "I'm not sure I got that. Did you mean one of these?" }, chips);
  }

  // ── BUILD FLOW HANDLERS ─────────────────────────────────────────────────────

  function onBuildModeSelect(mode) {
    saveBuildPref(mode);
    setBuildFlow(prev => ({ ...prev, mode, step: BUILD_STEP.POOL }));
    addJarvisMsg({ type: "BUILD_POOL_SELECT" });
  }

  function onBuildPoolSelect(pool) {
    setBuildFlow(prev => ({ ...prev, pool, step: BUILD_STEP.LEGS_TARGET }));
    addJarvisMsg({ type: "BUILD_LEGS_TARGET_SELECT" });
  }

  // legs + target odds combined — called when user picks from the inline widget
  function onBuildLegsTargetSelect({ legs, targetOdds }) {
    setBuildFlow(prev => ({ ...prev, legs, targetOdds, step: BUILD_STEP.MARKET }));
    setBottomSheet("market");
  }

  function onBuildMarketSelect(market) {
    setBottomSheet(null);
    setBuildFlow(prev => ({ ...prev, market, step: BUILD_STEP.LEAGUES }));
    // Open leagues sheet
    setBottomSheet("leagues");
  }

  function onBuildLeaguesSelect(leagues) {
    setBottomSheet(null);
    setBuildFlow(prev => {
      const next = { ...prev, leagues, step: BUILD_STEP.CONFIRM };
      // Trigger the actual build
      executeBuild(next);
      return next;
    });
  }

  async function executeBuild(flow) {
    const loadingMsg = makeLoadingMsg();
    addMsg(loadingMsg);
    await new Promise(r => setTimeout(r, 1200));

    const { mode, pool, legs, targetOdds, market, leagues } = flow;
    const marketFamily = market || "theRead";
    const leagueFilter = (leagues === "all" || !leagues) ? null : leagues;

    // Determine leg count:
    // - If user specified legs directly → use it
    // - If user set targetOdds only → let Jarvis pick leg count to hit that odds range
    // - "auto" → Jarvis decides (default 6)
    let legCount;
    if (legs && legs !== "auto") {
      legCount = parseInt(legs, 10) || 6;
    } else if (targetOdds && targetOdds !== "auto") {
      // Estimate legs needed: each leg averages ~1.5 odds → log1.5(targetOdds)
      const target = parseFloat(targetOdds);
      legCount = isFinite(target) && target > 1
        ? Math.max(3, Math.min(12, Math.round(Math.log(target) / Math.log(1.5))))
        : 6;
    } else {
      legCount = 6; // Jarvis auto
    }

    let builtLegs = [];
    if (fixturesLoaded && fixtures.length) {
      const builtPool = buildChatPool(fixtures, marketFamily, historicalRates);
      builtLegs = buildParleyFromPool(builtPool, legCount, leagueFilter);
    }

    if (!builtLegs.length) {
      replaceLoadingMsg(loadingMsg.id, makeJarvisMsg(
        { type: "TEXT", text: "Not enough qualifying games match those filters today. Try fewer legs or wider leagues." },
        [{ label: "Try again", text: "Build me a parley" }, { label: "Wider pool", text: "Build me a parley with all leagues" }]
      ));
      setBuildFlow(null);
      return;
    }

    if (builtLegs.length < legCount) {
      // Partial pool
    }

    const totalOdds = builtLegs.reduce((acc, l) => acc * (l.odds || 1), 1);
    const ticket = {
      id:         Date.now(),
      code:       "T" + Math.random().toString(36).slice(2, 6).toUpperCase(),
      mode:       mode || "jarvis",
      legs:       builtLegs,
      totalOdds:  parseFloat(totalOdds.toFixed(2)),
      createdAt:  Date.now(),
      savedAt:    null,
      bookedCode: null,
    };

    // Auto-save
    onSaveTicket?.(ticket);

    const finalMsg = makeJarvisMsg({
      type:    "TICKET_CARD",
      ticket,
      partial: builtLegs.length < legCount,
    }, [
      { label: "Remix",         text: "Remix"          },
      { label: "Add more legs", text: "Add more legs"  },
      { label: "New",           text: "Build me a new parley" },
    ]);

    replaceLoadingMsg(loadingMsg.id, finalMsg);
    setBuildFlow(null);
    setChatLastAction({ type: "PARLEY_BUILT", ticket });

    setSessionBuildCount(c => {
      const next = c + 1;
      if (next >= 3) maybeShowTip("remix_tip", "Tip: Say 'remix' to regenerate from the same pool without re-answering.");
      return next;
    });
  }

  // ── Remix / Add legs
  async function handleRemix() {
    if (!chatLastAction?.ticket) { handleBuildParley(); return; }
    const { ticket } = chatLastAction;
    const loadingMsg = makeLoadingMsg();
    addMsg(makeUserMsg("Remix"));
    addMsg(loadingMsg);
    await new Promise(r => setTimeout(r, 1000));
    const pool  = buildChatPool(fixtures, ticket.legs[0]?.market?.toLowerCase().replace(/\s/g,"") || "theRead", historicalRates);
    // Exclude already-used fixtures for variety
    const usedIds = new Set(ticket.legs.map(l => l.fixtureId));
    const fresh = pool.filter(p => !usedIds.has(p.fixtureId));
    const legs  = buildParleyFromPool(fresh.length >= ticket.legs.length ? fresh : pool, ticket.legs.length, null);
    const totalOdds = legs.reduce((acc, l) => acc * (l.odds || 1), 1);
    const newTicket = { ...ticket, id: Date.now(), code: "T" + Math.random().toString(36).slice(2, 6).toUpperCase(), legs, totalOdds: parseFloat(totalOdds.toFixed(2)), createdAt: Date.now() };
    onSaveTicket?.(newTicket);
    replaceLoadingMsg(loadingMsg.id, makeJarvisMsg({ type: "TICKET_CARD", ticket: newTicket }, [{ label: "Remix again", text: "Remix" }, { label: "New parley", text: "Build me a new parley" }]));
    setChatLastAction({ type: "PARLEY_BUILT", ticket: newTicket });
  }

  // ── CHIP ACTION HANDLER ─────────────────────────────────────────────────────

  function handleChipAction(chip) {
    if (chip.text) {
      // Treat as user sending that message
      handleSend(chip.text);
      return;
    }
    switch (chip.action) {
      case "FETCH":           onFetchFixtures?.(); break;
      case "NAV_ROLLOVER":    onNavigatePro?.({ tab: "rollover" }); break;
      case "NAV_SAVED":       onNavigatePro?.({ tab: "parley" }); break;
      case "NAV_CUSTOM":      onNavigatePro?.({ layout: "pro", tab: "live", subTab: "custom" }); break;
      case "NAV_ENGINE":      onNavigatePro?.({ layout: "pro", tab: "live", subTab: "engine" }); break;
      case "NAV_FULL_MODEL":  onNavigatePro?.({ layout: "pro", tab: "live", fixture: chip.fixture }); break;
      case "NAV_CODE":        onNavigatePro?.({ layout: "pro", tab: "code", platform: chip.platform, code: chip.code, autoAnalyze: true }); break;
      case "ADD_LEG":         /* handled inline per card */ break;
      default: break;
    }
  }

  // ── MAIN SEND HANDLER ───────────────────────────────────────────────────────

  async function handleSend(text) {
    const raw = (text || input || "").trim();
    if (!raw) return;
    if (isGateOpen) return;

    setInput("");
    addMsg(makeUserMsg(raw));
    inputRef.current?.focus();

    // Special remix
    if (/^remix$/i.test(raw)) { handleRemix(); return; }

    const classified = classifyIntent(raw);
    switch (classified.intent) {
      case INTENT.ROLLOVER_STATUS:    handleRolloverStatus(); break;
      case INTENT.ROLLOVER_ANALYTICS: handleRolloverAnalytics(); break;
      case INTENT.BUILD_PARLEY:       handleBuildParley(); break;
      case INTENT.MATCH_ANALYSIS:     handleMatchAnalysis(classified.home, classified.away, false); break;
      case INTENT.JARVIS_ANALYSIS:    handleMatchAnalysis(classified.home, classified.away, true); break;
      case INTENT.FIXTURES_TODAY:     handleFixturesToday(); break;
      case INTENT.FIXTURES_FILTERED:  handleFixturesFiltered(classified.league); break;
      case INTENT.CODE_ANALYZE:       handleCodeAnalyze(classified.platform, classified.code || raw); break;
      case INTENT.NAVIGATE_CUSTOM:    handleNavigateCustom(); break;
      case INTENT.NAVIGATE_ENGINE:    handleNavigateEngine(); break;
      case INTENT.SAVED_PARLEYS:      handleSavedParleys(); break;
      case INTENT.STRATEGY:           handleStrategy(); break;
      default:                        handleUnknown(raw); break;
    }
  }

  // ── RENDER ───────────────────────────────────────────────────────────────────

  // ── STYLES (inline, C-token driven)
  const S = {
    // ── Overlay shells
    overlay: {
      position: "fixed", inset: 0, zIndex: 900,
      pointerEvents: "none",
    },
    scrim: {
      position: "absolute", inset: 0,
      background: "rgba(0,0,0,0.45)",
      pointerEvents: "auto",
    },
    panel: {
      position: "absolute",
      bottom: 0, left: 0, right: 0,
      height: "85dvh", height: "85vh",
      background: C.bg,
      borderRadius: "20px 20px 0 0",
      border: `1px solid ${C.borderHi || C.border}`,
      borderBottom: "none",
      display: "flex", flexDirection: "column",
      overflow: "hidden",
      pointerEvents: "auto",
      boxShadow: "0 -8px 40px rgba(0,0,0,0.45)",
    },
    header: {
      display: "flex", alignItems: "center", justifyContent: "space-between",
      padding: "0 14px", height: 50, flexShrink: 0,
      background: C.headerBg || C.bg,
      borderBottom: `1px solid ${C.headerBorder || C.border}`,
    },
    headerTitle: {
      fontSize: 12, fontWeight: 800, color: C.text,
      letterSpacing: ".06em", textTransform: "uppercase",
      display: "flex", alignItems: "center", gap: 7,
    },
    helpBtn: {
      width: 28, height: 28, borderRadius: "50%",
      border: `1px solid ${C.border}`, background: "transparent",
      display: "flex", alignItems: "center", justifyContent: "center",
      cursor: "pointer", color: C.muted, transition: "all .14s",
    },
    closeBtn: {
      width: 28, height: 28, borderRadius: "50%",
      border: `1px solid ${C.border}`, background: "transparent",
      display: "flex", alignItems: "center", justifyContent: "center",
      cursor: "pointer", color: C.muted, transition: "all .14s",
    },
    // Message feed
    feed: {
      flex: 1, overflowY: "auto", padding: "12px 14px 8px",
      display: "flex", flexDirection: "column", gap: 10,
      scrollBehavior: "smooth",
    },
    // Jarvis bubble
    jBubble: {
      alignSelf: "flex-start", maxWidth: "88%",
      background: C.surface, borderRadius: `4px ${C.cardRadius || 12}px ${C.cardRadius || 12}px ${C.cardRadius || 12}px`,
      border: `1px solid ${C.accentBorder || C.border}`,
      padding: "10px 12px", position: "relative",
    },
    jLabel: {
      display: "flex", alignItems: "center", gap: 5,
      fontSize: 9, fontWeight: 800, color: C.accent,
      letterSpacing: ".1em", textTransform: "uppercase",
      marginBottom: 7,
    },
    // User bubble
    uBubble: {
      alignSelf: "flex-end", maxWidth: "78%",
      background: C.accent, borderRadius: `${C.btnRadius || 10}px ${C.btnRadius || 10}px 4px ${C.btnRadius || 10}px`,
      padding: "8px 12px",
      color: C.accentText || "#fff",
      fontSize: 12, lineHeight: 1.5,
    },
    // Chips row
    chips: {
      display: "flex", flexWrap: "wrap", gap: 6, marginTop: 8,
    },
    chip: {
      padding: "5px 10px", borderRadius: 20,
      border: `1px solid ${C.border}`, background: "transparent",
      color: C.text, fontSize: 10, fontWeight: 600,
      cursor: "pointer", whiteSpace: "nowrap",
      transition: "all .14s", letterSpacing: ".03em",
    },
    // Mini card (inside bubble)
    miniCard: {
      background: C.cardBg, border: `1px solid ${C.border}`,
      borderRadius: C.cardRadius || 12, padding: "10px 12px",
      marginTop: 8,
    },
    // Input bar
    inputBar: {
      display: "flex", alignItems: "flex-end", gap: 8,
      padding: "10px 14px 12px",
      borderTop: `1px solid ${C.border}`,
      background: C.bg, flexShrink: 0,
    },
    input: {
      flex: 1, background: C.surface,
      border: `1px solid ${C.border}`, borderRadius: C.btnRadius || 10,
      padding: "8px 12px", color: C.text, fontSize: 12,
      fontFamily: "inherit", resize: "none", outline: "none",
      transition: "border-color .14s", lineHeight: 1.4,
      minHeight: 36, maxHeight: 100, overflowY: "auto",
    },
    sendBtn: {
      width: 36, height: 36, borderRadius: C.btnRadius || 10,
      background: chatEnabled ? C.accent : C.surface,
      border: `1px solid ${chatEnabled ? C.accent : C.border}`,
      display: "flex", alignItems: "center", justifyContent: "center",
      cursor: chatEnabled ? "pointer" : "not-allowed",
      color: chatEnabled ? (C.accentText || "#fff") : C.muted,
      flexShrink: 0, transition: "all .14s",
    },
    // Typing dots
    dot: {
      display: "inline-block", width: 5, height: 5, borderRadius: "50%",
      background: C.muted, margin: "0 2px",
    },
    // Gate
    gate: {
      flex: 1, display: "flex", flexDirection: "column",
      alignItems: "center", justifyContent: "center",
      padding: 28, textAlign: "center", gap: 14,
    },
  };

  // ── RENDER — overlay panel ───────────────────────────────────────────────────

  if (!isOpen) return null;

  return (
    <div style={{ ...S.overlay, pointerEvents: "auto" }}>
      {/* Scrim — tap to close */}
      <div style={S.scrim} onClick={onClose} />

      {/* Panel */}
      <div style={S.panel}>
        <style>{`
          @keyframes grm-spin { to { transform: rotate(360deg); } }
          @keyframes grm-blink {
            0%,80%,100% { opacity:.2; transform:translateY(0); }
            40%         { opacity:1;  transform:translateY(-3px); }
          }
          @keyframes grm-slide-up {
            from { transform:translateY(32px); opacity:0; }
            to   { transform:translateY(0);    opacity:1; }
          }
          .grm-dot-1 { animation: grm-blink 1.2s ease-in-out infinite; }
          .grm-dot-2 { animation: grm-blink 1.2s ease-in-out infinite .2s; }
          .grm-dot-3 { animation: grm-blink 1.2s ease-in-out infinite .4s; }
          .grm-chip:hover { opacity:.8; transform:scale(.97); }
          .grm-chip:active { transform:scale(.94); }
          .grm-send:hover { filter:brightness(1.08); }
          .grm-scroll::-webkit-scrollbar { width:3px; }
          .grm-scroll::-webkit-scrollbar-track { background:transparent; }
          .grm-scroll::-webkit-scrollbar-thumb { background:${C.border}; border-radius:2px; }
          .grm-help-btn:hover { border-color:${C.accent} !important; color:${C.accent} !important; }
          .grm-close-btn:hover { border-color:${C.red||"#ef4444"} !important; color:${C.red||"#ef4444"} !important; }
          .grm-mini-btn { background:transparent; border:1px solid ${C.border}; border-radius:6px; padding:4px 8px; font-size:10px; font-weight:600; color:${C.text}; cursor:pointer; font-family:inherit; transition:all .12s; letter-spacing:.03em; }
          .grm-mini-btn:hover { border-color:${C.accent}; color:${C.accent}; }
          .grm-mini-btn-primary { background:${C.accent}; border:1px solid ${C.accent}; border-radius:6px; padding:4px 10px; font-size:10px; font-weight:700; color:${C.accentText||"#fff"}; cursor:pointer; font-family:inherit; transition:all .12s; letter-spacing:.03em; }
          .grm-mini-btn-primary:hover { filter:brightness(1.08); }
          .grm-mini-btn-copy { background:transparent; border:1px solid ${C.border}; border-radius:6px; padding:3px 8px; font-size:9px; font-weight:700; color:${C.muted}; cursor:pointer; font-family:inherit; transition:all .12s; letter-spacing:.04em; display:inline-flex; align-items:center; gap:4px; }
          .grm-mini-btn-copy:hover { border-color:${C.accent}; color:${C.accent}; }
          .grm-mini-btn-copy.copied { border-color:${C.green}; color:${C.green}; }
          .grm-sheet-overlay { position:absolute; inset:0; background:rgba(0,0,0,0.55); z-index:50; display:flex; align-items:flex-end; }
          .grm-sheet { background:${C.modalBg || C.surface}; border-radius:20px 20px 0 0; width:100%; max-height:80%; overflow-y:auto; padding:0 0 28px; }
          .grm-sheet-handle { width:36px; height:4px; border-radius:2px; background:${C.muted}40; margin:12px auto 16px; }
          .grm-sheet-title { font-size:11px; font-weight:800; color:${C.text}; letter-spacing:.1em; text-transform:uppercase; padding:0 18px 12px; display:flex; align-items:center; justify-content:space-between; }
          .grm-sheet-group { padding:6px 18px 0; }
          .grm-sheet-group-label { font-size:9px; font-weight:800; color:${C.muted}; letter-spacing:.12em; text-transform:uppercase; margin-bottom:7px; }
          .grm-sheet-item { padding:10px 12px; border-radius:8px; display:flex; align-items:center; gap:10px; cursor:pointer; transition:background .12s; }
          .grm-sheet-item:hover { background:${C.surface}; }
          .grm-sheet-item-label { font-size:12px; color:${C.text}; font-weight:600; }
          .grm-sheet-item-muted { font-size:10px; color:${C.muted}; }
          .grm-confirm-overlay { position:absolute; inset:0; background:rgba(0,0,0,0.6); z-index:60; display:flex; align-items:center; justify-content:center; padding:0 20px; }
          .grm-confirm-box { background:${C.modalBg || C.surface}; border:1px solid ${C.border}; border-radius:${C.cardRadius || 14}px; padding:22px 20px; width:100%; max-width:320px; }
          .grm-conf-title { font-size:12px; font-weight:800; color:${C.text}; margin-bottom:8px; letter-spacing:.04em; }
          .grm-conf-body { font-size:11px; color:${C.muted}; line-height:1.5; margin-bottom:16px; }
          .grm-conf-btns { display:flex; gap:8px; }
          .grm-progress { height:3px; border-radius:2px; background:${C.border}; overflow:hidden; margin:4px 0; }
          .grm-progress-fill { height:100%; border-radius:2px; background:${C.accent}; transition:width .3s ease; }
          .grm-pref-popup { position:absolute; bottom:72px; left:50%; transform:translateX(-50%); background:${C.cardBg}; border:1px solid ${C.border}; border-radius:10px; padding:9px 14px; z-index:50; font-size:11px; color:${C.muted}; white-space:nowrap; pointer-events:none; }
          .grm-tip-bubble { background:${C.accentDim || C.accent + "15"}; border:1px solid ${C.accentBorder || C.accent + "30"}; border-radius:8px; padding:8px 10px; font-size:11px; color:${C.text}; line-height:1.4; margin-top:6px; }
          .grm-booked-badge { background:${C.green}20; border:1px solid ${C.green}40; border-radius:6px; padding:2px 7px; font-size:9px; font-weight:800; color:${C.green}; letter-spacing:.08em; }
          .grm-gemini-loading { display:flex; align-items:center; gap:6px; font-size:10px; color:${C.muted}; }
        `}</style>

        {/* ── DRAG HANDLE ── */}
        <div style={{ width:36,height:4,borderRadius:2,background:`${C.muted}35`,margin:"10px auto 0",flexShrink:0 }}/>

        {/* ── PANEL HEADER ── */}
        <div style={S.header}>
          <div style={S.headerTitle}>
            <BoltIcon size={12} color={C.accent} />
            Jarvis
          </div>
          <div style={{ display:"flex",alignItems:"center",gap:7 }}>
            <button
              className="grm-help-btn"
              style={S.helpBtn}
              onClick={() => setHelpOpen(true)}
              aria-label="Help"
            >
              <HelpIcon size={12} />
            </button>
            <button
              className="grm-close-btn"
              style={S.closeBtn}
              onClick={onClose}
              aria-label="Close Jarvis"
            >
              <XIcon size={12} />
            </button>
          </div>
        </div>

        {/* ── CHAT CONTENT ── */}
        <ChatTab
          C={C}
          S={S}
          messages={messages || []}
          isTyping={isTyping}
          fixturesLoaded={fixturesLoaded}
          fetchingFixtures={fetchingFixtures}
          fetchError={fetchError}
          onFetchFixtures={onFetchFixtures}
          input={input}
          setInput={setInput}
          onSend={handleSend}
          inputRef={inputRef}
          messagesEndRef={messagesEndRef}
          buildFlow={buildFlow}
          onBuildModeSelect={onBuildModeSelect}
          onBuildPoolSelect={onBuildPoolSelect}
          onBuildLegsTargetSelect={onBuildLegsTargetSelect}
          onChipAction={handleChipAction}
          onBookNow={onBookNow}
          onSaveTicket={onSaveTicket}
          onNavigatePro={onNavigatePro}
          defaultBookmaker={defaultBookmaker}
          savedTickets={savedTickets}
          fixtures={fixtures}
          chatEnabled={chatEnabled}
        />

        {/* ── SHEETS & DIALOGS (scoped inside panel) ── */}
        {bottomSheet === "market" && (
          <div className="grm-sheet-overlay" onClick={() => setBottomSheet(null)}>
            <div className="grm-sheet" onClick={e => e.stopPropagation()}>
              <div className="grm-sheet-handle" />
              <div className="grm-sheet-title">
                Select Market
                <button onClick={() => setBottomSheet(null)} style={{ background:"transparent",border:"none",cursor:"pointer",color:C.muted }}>
                  <XIcon size={14} />
                </button>
              </div>
              {MARKET_GROUPS.map(g => (
                <div key={g.group} className="grm-sheet-group">
                  <div className="grm-sheet-group-label">{g.group}</div>
                  {g.items.map(item => (
                    <div key={item.id} className="grm-sheet-item" onClick={() => onBuildMarketSelect(item.id)}>
                      <div style={{ flex:1 }}>
                        <div className="grm-sheet-item-label" style={{ color:g.muted?C.muted:C.text }}>{item.label}</div>
                        {item.untracked && <div className="grm-sheet-item-muted">Not modelled — no confidence data</div>}
                      </div>
                    </div>
                  ))}
                </div>
              ))}
            </div>
          </div>
        )}

        {bottomSheet === "leagues" && (
          <LeaguesSheet C={C} fixtures={fixtures} onSelect={onBuildLeaguesSelect} onClose={() => setBottomSheet(null)} />
        )}

        {helpOpen && (
          <HelpSheet C={C} onClose={() => setHelpOpen(false)} />
        )}

        {deleteConfirm && (
          <div className="grm-confirm-overlay" onClick={() => setDeleteConfirm(null)}>
            <div className="grm-confirm-box" onClick={e => e.stopPropagation()}>
              <div className="grm-conf-title">Remove this ticket?</div>
              <div className="grm-conf-body">This can't be undone.</div>
              <div className="grm-conf-btns">
                <button className="grm-mini-btn-primary" style={{ flex:1,padding:"9px 0",fontSize:11 }}
                  onClick={() => { onDeleteTicket?.(deleteConfirm); setDeleteConfirm(null); }}>
                  Remove
                </button>
                <button className="grm-mini-btn" style={{ flex:1,padding:"9px 0",fontSize:11 }}
                  onClick={() => setDeleteConfirm(null)}>
                  Cancel
                </button>
              </div>
            </div>
          </div>
        )}

        {buildFlow?.prefPopupVisible && (
          <div className="grm-pref-popup">
            Building with: {buildFlow.mode === "jarvis" ? "Jarvis Parley" : "Custom Parley"} &nbsp;·&nbsp; Change in Settings
          </div>
        )}

      </div>
    </div>
  );
}

// ── CHAT TAB ─────────────────────────────────────────────────────────────────

function ChatTab({
  C, S, messages, isTyping,
  fixturesLoaded, fetchingFixtures, fetchError, onFetchFixtures,
  input, setInput, onSend, inputRef, messagesEndRef,
  buildFlow, onBuildModeSelect, onBuildPoolSelect, onBuildLegsTargetSelect,
  onChipAction, onBookNow, onSaveTicket, onNavigatePro,
  defaultBookmaker, savedTickets, fixtures, chatEnabled,
}) {
  function handleKey(e) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      onSend(input);
    }
  }

  return (
    <>
      {/* ── FETCH GATE ── */}
      {!fixturesLoaded && (
        <div style={S.gate}>
          <div style={{ fontSize: 11, color: C.muted, fontWeight: 700, letterSpacing: ".08em", textTransform: "uppercase" }}>
            New day — no fixtures yet
          </div>
          <div style={{ fontSize: 11, color: C.muted, lineHeight: 1.6, maxWidth: 280 }}>
            Jarvis needs today's data to build parleys and analyse matches.
          </div>
          <button
            onClick={onFetchFixtures}
            disabled={fetchingFixtures}
            style={{
              background: fetchingFixtures ? C.surface : C.accent,
              border: `1px solid ${fetchingFixtures ? C.border : C.accent}`,
              borderRadius: C.btnRadius || 10, padding: "12px 28px",
              color: fetchingFixtures ? C.muted : (C.accentText || "#fff"),
              fontSize: 12, fontWeight: 800, cursor: fetchingFixtures ? "not-allowed" : "pointer",
              fontFamily: "inherit", letterSpacing: ".06em", textTransform: "uppercase",
              display: "flex", alignItems: "center", gap: 8, transition: "all .14s",
            }}
          >
            {fetchingFixtures ? <><LoaderIcon size={13} /> Fetching…</> : "Fetch Today"}
          </button>
          {fetchError && (
            <div style={{ fontSize: 10, color: C.red || "#e55", textAlign: "center", maxWidth: 260, lineHeight: 1.5 }}>
              {fetchError}
            </div>
          )}
        </div>
      )}

      {/* ── MESSAGE FEED ── */}
      {fixturesLoaded && (
        <div style={S.feed} className="grm-scroll">
          {messages.map(msg => (
            <MessageRow
              key={msg.id}
              msg={msg}
              C={C}
              S={S}
              buildFlow={buildFlow}
              onBuildModeSelect={onBuildModeSelect}
              onBuildPoolSelect={onBuildPoolSelect}
              onBuildLegsTargetSelect={onBuildLegsTargetSelect}
              onChipAction={onChipAction}
              onBookNow={onBookNow}
              onSaveTicket={onSaveTicket}
              onNavigatePro={onNavigatePro}
              defaultBookmaker={defaultBookmaker}
              savedTickets={savedTickets}
              fixtures={fixtures}
            />
          ))}

          {/* ── TYPING DOTS ── */}
          {isTyping && (
            <div style={S.jBubble}>
              <div style={S.jLabel}>
                <BoltIcon size={10} color={C.accent} /> Jarvis
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 3, padding: "2px 0" }}>
                <div className="grm-dot-1" style={S.dot} />
                <div className="grm-dot-2" style={S.dot} />
                <div className="grm-dot-3" style={S.dot} />
              </div>
            </div>
          )}

          <div ref={messagesEndRef} />
        </div>
      )}

      {/* ── INPUT BAR ── */}
      <div style={S.inputBar}>
        <textarea
          ref={inputRef}
          style={{ ...S.input, opacity: chatEnabled ? 1 : 0.45 }}
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={handleKey}
          placeholder={chatEnabled ? "Ask Jarvis anything…" : "Fetch fixtures to start…"}
          disabled={!chatEnabled}
          rows={1}
        />
        <button
          className="grm-send"
          style={S.sendBtn}
          onClick={() => onSend(input)}
          disabled={!chatEnabled || !input.trim()}
          aria-label="Send"
        >
          <SendIcon size={14} />
        </button>
      </div>
    </>
  );
}

// ── MESSAGE ROW ──────────────────────────────────────────────────────────────

function MessageRow({
  msg, C, S, buildFlow,
  onBuildModeSelect, onBuildPoolSelect, onBuildLegsTargetSelect,
  onChipAction, onBookNow, onSaveTicket, onNavigatePro,
  defaultBookmaker, savedTickets, fixtures,
}) {
  if (msg.role === "user") {
    return (
      <div style={S.uBubble}>
        {msg.text}
      </div>
    );
  }

  if (msg.loading) {
    return (
      <div style={S.jBubble}>
        <div style={S.jLabel}>
          <BoltIcon size={10} color={C.accent} /> Jarvis
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 3 }}>
          <div className="grm-dot-1" style={S.dot} />
          <div className="grm-dot-2" style={S.dot} />
          <div className="grm-dot-3" style={S.dot} />
        </div>
      </div>
    );
  }

  const { content, chips } = msg;

  return (
    <div style={S.jBubble}>
      <div style={S.jLabel}>
        <BoltIcon size={10} color={C.accent} /> Jarvis
      </div>

      <MessageContent
        content={content}
        C={C}
        S={S}
        buildFlow={buildFlow}
        onBuildModeSelect={onBuildModeSelect}
        onBuildPoolSelect={onBuildPoolSelect}
        onBuildLegsTargetSelect={onBuildLegsTargetSelect}
        onChipAction={onChipAction}
        onBookNow={onBookNow}
        onSaveTicket={onSaveTicket}
        onNavigatePro={onNavigatePro}
        defaultBookmaker={defaultBookmaker}
        savedTickets={savedTickets}
        fixtures={fixtures}
      />

      {/* ── CHIPS ── */}
      {chips?.length > 0 && (
        <div style={S.chips}>
          {chips.map((chip, i) => (
            <button
              key={i}
              className="grm-chip"
              style={S.chip}
              onClick={() => onChipAction(chip)}
            >
              {chip.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ── MESSAGE CONTENT ──────────────────────────────────────────────────────────

function MessageContent({
  content, C, S,
  buildFlow, onBuildModeSelect, onBuildPoolSelect, onBuildLegsTargetSelect,
  onChipAction, onBookNow, onSaveTicket, onNavigatePro, defaultBookmaker,
  savedTickets, fixtures,
}) {
  if (!content) return null;

  const textStyle = { fontSize: 12, color: C.text, lineHeight: 1.55 };

  switch (content.type) {

    case "WELCOME":
      return (
        <div>
          <div style={textStyle}>
            Welcome to GRM Pro Chat.<br/>
            I'm Jarvis — your football co-pilot.<br/><br/>
            Here's what I can do:
          </div>
        </div>
      );

    case "TEXT":
      return (
        <div>
          {content.text && <div style={textStyle}>{content.text}</div>}
          {content.tipText && <div className="grm-tip-bubble">{content.tipText}</div>}
        </div>
      );

    case "TIP":
      return <div className="grm-tip-bubble">{content.text}</div>;

    case "BUILD_MODE_SELECT":
      return (
        <div>
          <div style={textStyle}>Which build mode?</div>
          <div style={{ display:"flex",flexDirection:"column",gap:6,marginTop:8 }}>
            <ModeCard C={C} title="Jarvis Parley"  desc="Jarvis picks the best legs using the model"            active={buildFlow?.mode==="jarvis"} onClick={() => onBuildModeSelect("jarvis")} />
            <ModeCard C={C} title="Custom Parley"  desc="You control every filter — markets, leagues, confidence" active={buildFlow?.mode==="custom"} onClick={() => onBuildModeSelect("custom")} />
          </div>
        </div>
      );

    case "BUILD_POOL_SELECT":
      return (
        <div>
          <div style={textStyle}>Which fixtures should I pick from?</div>
          <div style={S.chips}>
            {[
              { id:"all",    label:"All fixtures"      },
              { id:"engine", label:"Engine picks only"  },
              { id:"custom", label:"My custom list"     },
            ].map(opt => (
              <button key={opt.id} className="grm-chip" style={S.chip} onClick={() => onBuildPoolSelect(opt.id)}>
                {opt.label}
              </button>
            ))}
          </div>
        </div>
      );

    case "BUILD_LEGS_TARGET_SELECT":
      return <LegsTargetWidget C={C} S={S} onSelect={onBuildLegsTargetSelect} />;

    case "TICKET_CARD":
      return <TicketCard C={C} S={S} ticket={content.ticket} partial={content.partial} onBookNow={onBookNow} onNavigatePro={onNavigatePro} defaultBookmaker={defaultBookmaker} />;

    case "ROLLOVER_CARD":
      return <RolloverCard C={C} S={S} chain={content.chain} pick={content.pick} booked={content.booked} />;

    case "MATCH_CARD":
      return <MatchCard C={C} S={S} fixture={content.fixture} withJarvis={content.withJarvis} onNavigatePro={onNavigatePro} />;

    case "FIXTURES_CARD":
      return <FixturesCard C={C} S={S} fixtures={content.fixtures} label={content.label} onNavigatePro={onNavigatePro} />;

    case "CODE_PLATFORM_SELECT":
      return (
        <div>
          <div style={textStyle}>Got a slip to analyze. Which platform?</div>
          <div style={S.chips}>
            <button className="grm-chip" style={S.chip} onClick={() => onChipAction({ action:"NAV_CODE", platform:"SB", code: content.code })}>SportyBet</button>
            <button className="grm-chip" style={S.chip} onClick={() => onChipAction({ action:"NAV_CODE", platform:"LL", code: content.code })}>Lucky's Ledger</button>
          </div>
        </div>
      );

    default:
      return null;
  }
}

// ── MODE CARD ────────────────────────────────────────────────────────────────

function ModeCard({ C, title, desc, active, onClick }) {
  return (
    <div
      onClick={onClick}
      style={{
        background: active ? (C.accentDim || C.accent + "15") : C.cardBg,
        border: `1px solid ${active ? (C.accentBorder || C.accent + "40") : C.border}`,
        borderRadius: C.cardRadius || 10, padding: "10px 12px",
        cursor: "pointer", transition: "all .14s",
      }}
    >
      <div style={{ fontSize: 11, fontWeight: 800, color: active ? C.accent : C.text, marginBottom: 2, letterSpacing: ".03em" }}>
        {title}
      </div>
      <div style={{ fontSize: 10, color: C.muted, lineHeight: 1.4 }}>{desc}</div>
    </div>
  );
}

// ── LEGS + TARGET ODDS WIDGET ─────────────────────────────────────────────────
// Combined step: user picks legs count AND/OR target odds.
// "Jarvis picks" option skips both — model auto-selects.
// Resolves decision paralysis by making odds the primary anchor people recognise.

function LegsTargetWidget({ C, S, onSelect }) {
  const [legs, setLegs]           = useState(null);   // null = not set
  const [targetOdds, setTargetOdds] = useState(null); // null = not set
  const [customLegs, setCustomLegs] = useState("");

  const LEG_OPTS   = [4, 5, 6, 8, 10];
  const ODDS_OPTS  = [
    { label: "×3–5",  value: "4"  },
    { label: "×6–10", value: "8"  },
    { label: "×10–20",value: "15" },
    { label: "×20+",  value: "25" },
  ];

  const canConfirm = legs !== null || targetOdds !== null;

  function handleConfirm() {
    onSelect({
      legs:       legs || "auto",
      targetOdds: targetOdds || "auto",
    });
  }

  const selStyle = (active) => ({
    ...S.chip,
    background:   active ? (C.accentDim || C.accent + "18") : "transparent",
    borderColor:  active ? C.accent : C.border,
    color:        active ? C.accent : C.text,
    fontWeight:   active ? 800 : 600,
  });

  return (
    <div>
      <div style={{ fontSize:12,color:C.text,lineHeight:1.55,marginBottom:10 }}>
        How many legs, and what target odds?<br/>
        <span style={{ fontSize:10,color:C.muted }}>Pick one or both — or let Jarvis decide.</span>
      </div>

      {/* Legs row */}
      <div style={{ marginBottom:10 }}>
        <div style={{ fontSize:9,color:C.muted,letterSpacing:".1em",textTransform:"uppercase",marginBottom:6 }}>Legs</div>
        <div style={{ display:"flex",flexWrap:"wrap",gap:5 }}>
          {LEG_OPTS.map(n => (
            <button key={n} className="grm-chip" style={selStyle(legs===n)} onClick={() => setLegs(legs===n ? null : n)}>
              {n}
            </button>
          ))}
          <input
            type="number" min="2" max="20" placeholder="Custom"
            value={customLegs}
            onChange={e => { setCustomLegs(e.target.value); const n = parseInt(e.target.value,10); if(n>=2&&n<=20) setLegs(n); }}
            style={{
              width:60, padding:"4px 8px", borderRadius:20,
              border:`1px solid ${C.border}`, background:"transparent",
              color:C.text, fontSize:10, fontFamily:"inherit", outline:"none",
              textAlign:"center",
            }}
          />
        </div>
      </div>

      {/* Target odds row */}
      <div style={{ marginBottom:12 }}>
        <div style={{ fontSize:9,color:C.muted,letterSpacing:".1em",textTransform:"uppercase",marginBottom:6 }}>Target Odds</div>
        <div style={{ display:"flex",flexWrap:"wrap",gap:5 }}>
          {ODDS_OPTS.map(o => (
            <button key={o.value} className="grm-chip" style={selStyle(targetOdds===o.value)} onClick={() => setTargetOdds(targetOdds===o.value ? null : o.value)}>
              {o.label}
            </button>
          ))}
        </div>
      </div>

      {/* Actions */}
      <div style={{ display:"flex",gap:6 }}>
        <button
          className="grm-mini-btn-primary"
          style={{ flex:1,padding:"7px 0",fontSize:10,opacity:canConfirm?1:0.5 }}
          disabled={!canConfirm}
          onClick={handleConfirm}
        >
          {canConfirm ? "Build it →" : "Select legs or odds"}
        </button>
        <button
          className="grm-mini-btn"
          style={{ padding:"7px 12px",fontSize:10 }}
          onClick={() => onSelect({ legs:"auto", targetOdds:"auto" })}
          title="Let Jarvis pick the optimal leg count"
        >
          Jarvis picks
        </button>
      </div>
    </div>
  );
}

function TicketCard({ C, S, ticket, partial, onBookNow, onNavigatePro, defaultBookmaker }) {
  const [bookState, setBookState]       = useState("idle");
  const [bookedCode, setBookedCode]     = useState(null);
  const [bookedPlatform, setBookedPlatform] = useState(null);

  if (!ticket) return null;
  const legs     = ticket.legs || [];
  const showLegs = legs.slice(0, 3);
  const extra    = legs.length - showLegs.length;

  function handleBook(bm) {
    const code = bm === "SB"
      ? "SB" + Math.random().toString(36).slice(2, 6).toUpperCase()
      : "LL" + Math.random().toString(36).slice(2, 6).toUpperCase();
    setBookedCode(code);
    setBookedPlatform(bm);
    setBookState("booked");
    onBookNow?.(ticket, bm);
  }

  return (
    <div style={S.miniCard}>
      {partial && (
        <div style={{ fontSize: 9, color: C.amber, fontWeight: 700, letterSpacing: ".07em", marginBottom: 6 }}>
          PARTIAL — fewer legs than requested
        </div>
      )}
      <div style={{ display:"flex",alignItems:"baseline",justifyContent:"space-between",marginBottom:6 }}>
        <div style={{ display:"flex",alignItems:"center",gap:6 }}>
          <TicketIcon size={11} color={C.accent} />
          <span style={{ fontSize:10,fontWeight:800,color:C.text,letterSpacing:".06em",textTransform:"uppercase" }}>
            Ticket #{ticket.id?.toString().slice(-3) || "1"}
          </span>
        </div>
        <span style={{ fontSize:13,fontWeight:800,color:C.accent }}>
          ×{ticket.totalOdds}
        </span>
      </div>

      {/* Legs preview */}
      <div style={{ display:"flex",flexDirection:"column",gap:4,marginBottom:8 }}>
        {showLegs.map((leg, i) => (
          <div key={i} style={{ display:"flex",alignItems:"center",justifyContent:"space-between" }}>
            <div style={{ fontSize:11,color:C.text,lineHeight:1.3,flex:1,minWidth:0 }}>
              <span style={{ color:C.muted,marginRight:4 }}>{i+1}.</span>
              <span style={{ fontSize:9,color:C.muted }}>{leg.game}</span>
            </div>
            <div style={{ fontSize:10,color:C.accent,fontWeight:700,flexShrink:0,marginLeft:6 }}>
              {leg.pick}
            </div>
          </div>
        ))}
        {extra > 0 && (
          <div style={{ fontSize:10,color:C.muted }}>+ {extra} more leg{extra > 1 ? "s" : ""}</div>
        )}
      </div>

      {/* Confidence bar */}
      {ticket.legs?.length > 0 && (() => {
        const avg = Math.round(ticket.legs.reduce((a,l) => a + (l.conf||0), 0) / ticket.legs.length);
        return avg > 0 ? (
          <div style={{ marginBottom:8 }}>
            <div style={{ display:"flex",justifyContent:"space-between",marginBottom:2 }}>
              <span style={{ fontSize:9,color:C.muted,letterSpacing:".06em" }}>AVG CONFIDENCE</span>
              <span style={{ fontSize:9,color:C.text,fontWeight:700 }}>{avg}%</span>
            </div>
            <div className="grm-progress">
              <div className="grm-progress-fill" style={{ width:`${avg}%` }} />
            </div>
          </div>
        ) : null;
      })()}

      {/* Actions */}
      {bookState === "idle" && (
        <div style={{ display:"flex",gap:6 }}>
          <button
            className="grm-mini-btn-primary"
            style={{ flex:1,padding:"7px 0",fontSize:10 }}
            onClick={() => setBookState("selecting")}
          >
            Book Now
          </button>
          <button
            className="grm-mini-btn"
            style={{ flex:1,padding:"7px 0",fontSize:10 }}
            onClick={() => onNavigatePro?.({ layout:"pro",tab:"parley",ticket })}
          >
            View Full
          </button>
        </div>
      )}

      {bookState === "selecting" && (
        <div style={{ display:"flex",gap:6 }}>
          <button className="grm-mini-btn-primary" style={{ flex:1,padding:"7px 0",fontSize:10 }} onClick={() => handleBook("SB")}>SportyBet</button>
          <button className="grm-mini-btn"         style={{ flex:1,padding:"7px 0",fontSize:10 }} onClick={() => handleBook("LL")}>Lucky's Ledger</button>
          <button className="grm-mini-btn"         style={{ padding:"7px 8px",fontSize:10 }}      onClick={() => setBookState("idle")}><XIcon size={11}/></button>
        </div>
      )}

      {bookState === "booked" && bookedCode && (
        <BookedRow C={C} code={bookedCode} platform={bookedPlatform} />
      )}
    </div>
  );
}

// ── BOOKED ROW ────────────────────────────────────────────────────────────────
// Shows booking code + Copy Code + Copy Link. Compact, never wraps.

function BookedRow({ C, code, platform }) {
  const [codeCopied, setCodeCopied]   = useState(false);
  const [linkCopied, setLinkCopied]   = useState(false);

  const bookingLink = platform === "LL"
    ? `https://luckysledger.com/slip/${code}`
    : `https://www.sportybet.com/betslip/share/?code=${code}`;

  const copyCode = () => {
    navigator.clipboard?.writeText(code).catch(() => {});
    setCodeCopied(true);
    setTimeout(() => setCodeCopied(false), 2000);
  };

  const copyLink = () => {
    navigator.clipboard?.writeText(bookingLink).catch(() => {});
    setLinkCopied(true);
    setTimeout(() => setLinkCopied(false), 2000);
  };

  return (
    <div style={{ display:"flex",alignItems:"center",gap:6,flexWrap:"wrap" }}>
      <span className="grm-booked-badge">BOOKED</span>
      <span style={{ fontSize:11,color:"currentColor",fontWeight:700,letterSpacing:".06em",flex:1,minWidth:0,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap" }}>
        {code}
      </span>
      <button
        className={`grm-mini-btn-copy${codeCopied ? " copied" : ""}`}
        onClick={copyCode}
      >
        {/* Copy icon */}
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
        </svg>
        {codeCopied ? "Copied!" : "Code"}
      </button>
      <button
        className={`grm-mini-btn-copy${linkCopied ? " copied" : ""}`}
        onClick={copyLink}
      >
        {/* Link icon */}
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>
        </svg>
        {linkCopied ? "Copied!" : "Link"}
      </button>
    </div>
  );
}

function RolloverCard({ C, S, chain, pick, booked }) {
  if (!chain || !pick) return null;
  const step   = chain.step || chain.currentStep || 1;
  const target = chain.target || chain.maxSteps || 10;
  const pot    = chain.pot || chain.amount || 0;

  return (
    <div style={S.miniCard}>
      <div style={{ display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:8 }}>
        <div style={{ fontSize:10,fontWeight:800,color:C.text,letterSpacing:".07em",textTransform:"uppercase" }}>
          Rollover — Step {step} of {target}
        </div>
      </div>
      {pot > 0 && (
        <div style={{ fontSize:10,color:C.muted,marginBottom:6 }}>
          Pot: <strong style={{ color:C.text }}>£{pot.toLocaleString()}</strong>
        </div>
      )}
      <div style={{ borderTop:`1px solid ${C.border}`,paddingTop:8,marginBottom:8 }}>
        <div style={{ fontSize:9,color:C.muted,letterSpacing:".09em",textTransform:"uppercase",marginBottom:4 }}>Today's Pick</div>
        {/* Multi-leg support */}
        {pick.legs ? pick.legs.map((leg, i) => (
          <div key={i} style={{ marginBottom:4 }}>
            <div style={{ fontSize:12,color:C.text,fontWeight:700 }}>{leg.game}</div>
            <div style={{ display:"flex",gap:6,marginTop:2 }}>
              <span style={{ fontSize:11,color:C.accent,fontWeight:700 }}>{leg.pick}</span>
              <span style={{ fontSize:10,color:C.muted }}>@{leg.odds}</span>
              {leg.conf && <span style={{ fontSize:10,color:C.muted }}>· Conf: {leg.conf}%</span>}
            </div>
          </div>
        )) : (
          <>
            <div style={{ fontSize:12,color:C.text,fontWeight:700 }}>{pick.game || pick.fixture}</div>
            <div style={{ display:"flex",gap:6,marginTop:2 }}>
              <span style={{ fontSize:11,color:C.accent,fontWeight:700 }}>PICK: {pick.pick}</span>
              {pick.odds && <span style={{ fontSize:10,color:C.muted }}>@{pick.odds}</span>}
              {pick.conf && <span style={{ fontSize:10,color:C.muted }}>· Conf: {pick.conf}%</span>}
            </div>
          </>
        )}
      </div>
      {booked
        ? <span className="grm-booked-badge">Booked</span>
        : <div style={{ display:"flex",gap:6 }}>
            <button className="grm-mini-btn-primary" style={{ flex:1,padding:"6px 0",fontSize:10 }}>Book Now</button>
          </div>
      }
    </div>
  );
}

// ── MATCH CARD ───────────────────────────────────────────────────────────────

function MatchCard({ C, S, fixture, withJarvis, onNavigatePro }) {
  if (!fixture) return null;
  const m = fixture.markets || {};

  // Determine top pick
  const topPick = fixture.theRead?.anchor || fixture.theEdge;
  const homeWin = m.homeWin || 0;
  const draw    = m.draw || 0;
  const awayWin = m.awayWin || 0;

  return (
    <div style={S.miniCard}>
      <div style={{ fontSize:11,fontWeight:800,color:C.text,marginBottom:2 }}>
        {fixture.teams?.home} vs {fixture.teams?.away}
      </div>
      <div style={{ fontSize:9,color:C.muted,marginBottom:8 }}>
        {fixture.league} {fixture.startTime ? `· ${fixture.startTime}` : ""}
      </div>
      {topPick && (
        <div style={{ borderTop:`1px solid ${C.border}`,paddingTop:7,marginBottom:8 }}>
          <div style={{ fontSize:9,color:C.muted,letterSpacing:".09em",textTransform:"uppercase",marginBottom:4 }}>MODEL PICK</div>
          <div style={{ display:"flex",alignItems:"center",gap:6 }}>
            <span style={{ fontSize:12,color:C.accent,fontWeight:800 }}>{topPick.pick}</span>
            <span style={{ fontSize:11,color:C.text,fontWeight:700 }}>{topPick.prob}%</span>
          </div>
          {/* Mini bar */}
          <div className="grm-progress" style={{ marginTop:5,marginBottom:6 }}>
            <div className="grm-progress-fill" style={{ width:`${topPick.prob}%` }} />
          </div>
        </div>
      )}
      {(homeWin || draw || awayWin) && (
        <div style={{ display:"flex",gap:8,fontSize:10,color:C.muted,marginBottom:8 }}>
          {homeWin ? <span>H: <strong style={{ color:C.text }}>{homeWin}%</strong></span> : null}
          {draw    ? <span>X: <strong style={{ color:C.text }}>{draw}%</strong></span>    : null}
          {awayWin ? <span>A: <strong style={{ color:C.text }}>{awayWin}%</strong></span> : null}
          {m.over25 ? <span>O2.5: <strong style={{ color:C.text }}>{m.over25}%</strong></span> : null}
          {m.bttsYes ? <span>BTTS: <strong style={{ color:C.text }}>{m.bttsYes}%</strong></span> : null}
        </div>
      )}
      <div style={{ display:"flex",gap:6 }}>
        <button className="grm-mini-btn" style={{ flex:1,padding:"6px 0",fontSize:10 }}
          onClick={() => onNavigatePro?.({ layout:"pro",tab:"live",fixture })}>
          Open in Pro
        </button>
      </div>
    </div>
  );
}

// ── FIXTURES CARD ────────────────────────────────────────────────────────────

function FixturesCard({ C, S, fixtures, label, onNavigatePro }) {
  if (!fixtures?.length) return <div style={{ fontSize:11,color:C.muted }}>No fixtures found.</div>;

  const groups = {};
  fixtures.forEach(f => {
    const key = `${f.country || ""} — ${f.league || "Unknown"}`;
    if (!groups[key]) groups[key] = [];
    groups[key].push(f);
  });

  return (
    <div style={S.miniCard}>
      {label && (
        <div style={{ fontSize:9,color:C.muted,letterSpacing:".1em",textTransform:"uppercase",marginBottom:8 }}>
          {label}
        </div>
      )}
      {Object.entries(groups).slice(0, 4).map(([group, fx]) => (
        <div key={group} style={{ marginBottom:8 }}>
          <div style={{ fontSize:9,fontWeight:800,color:C.accent,letterSpacing:".08em",textTransform:"uppercase",marginBottom:4 }}>
            {group}
          </div>
          {fx.slice(0, 3).map((f, i) => {
            const pick = f.theRead?.anchor || f.theEdge;
            return (
              <div key={i} style={{
                display:"flex",alignItems:"center",
                paddingBottom:6, marginBottom:6,
                borderBottom: i < Math.min(fx.length,3)-1 ? `1px solid ${C.border}` : "none",
                gap:6,
              }}>
                <div style={{ flex:1,minWidth:0 }}>
                  <div style={{ fontSize:11,color:C.text,lineHeight:1.3 }}>
                    {f.teams?.home} vs {f.teams?.away}
                  </div>
                  <div style={{ display:"flex",alignItems:"center",gap:8,marginTop:2 }}>
                    {f.startTime && <span style={{ fontSize:9,color:C.muted }}>{f.startTime}</span>}
                    {pick && (
                      <span style={{ fontSize:10,color:C.accent,fontWeight:700 }}>
                        {pick.pick?.length > 14 ? pick.pick.slice(0,13)+"…" : pick.pick} {pick.prob}%
                      </span>
                    )}
                  </div>
                </div>
                {/* Inline Open button */}
                <button
                  className="grm-mini-btn"
                  style={{ padding:"3px 8px",fontSize:9,flexShrink:0,whiteSpace:"nowrap" }}
                  onClick={() => onNavigatePro?.({ tab:"live", fixture:f })}
                >
                  Open →
                </button>
              </div>
            );
          })}
        </div>
      ))}
      {fixtures.length > 8 && (
        <div style={{ fontSize:10,color:C.muted,marginTop:2 }}>+ {fixtures.length - 8} more games</div>
      )}
    </div>
  );
}

// ── LEAGUES SHEET ────────────────────────────────────────────────────────────

function LeaguesSheet({ C, fixtures, onSelect, onClose }) {
  const groups = useMemo(() => {
    if (!fixtures?.length) return {};
    const g = {};
    fixtures.forEach(f => {
      const country = f.country || "Other";
      if (!g[country]) g[country] = new Set();
      if (f.league) g[country].add(f.league);
    });
    // Sort by top countries first
    const sorted = {};
    TOP_COUNTRIES.forEach(c => { if (g[c]) sorted[c] = g[c]; });
    Object.keys(g).forEach(c => { if (!sorted[c]) sorted[c] = g[c]; });
    return sorted;
  }, [fixtures]);

  return (
    <div className="grm-sheet-overlay" onClick={onClose}>
      <div className="grm-sheet" onClick={e => e.stopPropagation()}>
        <div className="grm-sheet-handle" />
        <div className="grm-sheet-title">
          Select Leagues
          <button onClick={onClose} style={{ background:"transparent",border:"none",cursor:"pointer",color:C.muted }}>
            <XIcon size={14} />
          </button>
        </div>
        <div className="grm-sheet-group">
          <div
            className="grm-sheet-item"
            onClick={() => onSelect("all")}
          >
            <div className="grm-sheet-item-label">All Leagues</div>
          </div>
        </div>
        {Object.entries(groups).slice(0, 6).map(([country, leagues]) => (
          <div key={country} className="grm-sheet-group">
            <div className="grm-sheet-group-label">{country}</div>
            {[...leagues].slice(0, 4).map(league => (
              <div
                key={league}
                className="grm-sheet-item"
                onClick={() => onSelect(league)}
              >
                <div className="grm-sheet-item-label">{league}</div>
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

// ── HELP SHEET ───────────────────────────────────────────────────────────────

function HelpSheet({ C, onClose }) {
  const sections = [
    { title: "BUILD",    items: ['"Build me a parley"', '"8-leg BTTS, Premier League"'] },
    { title: "FIXTURES", items: ['"Today\'s fixtures"', '"England Premier League games"'] },
    { title: "MATCH",    items: ['"Analysis of Arsenal vs Chelsea"', '"Jarvis research Real vs Barca"'] },
    { title: "ROLLOVER", items: ['"What\'s today\'s rollover?"', '"My rollover analytics"'] },
    { title: "SLIP ANALYSIS", items: ["Paste any SB or LL code or link"] },
    { title: "NAVIGATE", items: ['"Go to Custom"', '"Engine picks"', '"My saved strategy"'] },
  ];

  return (
    <div className="grm-sheet-overlay" onClick={onClose}>
      <div className="grm-sheet" onClick={e => e.stopPropagation()}>
        <div className="grm-sheet-handle" />
        <div className="grm-sheet-title">
          What can I do?
          <button onClick={onClose} style={{ background:"transparent",border:"none",cursor:"pointer",color:C.muted }}>
            <XIcon size={14} />
          </button>
        </div>
        <div style={{ padding:"0 18px" }}>
          {sections.map(sec => (
            <div key={sec.title} style={{ marginBottom:14 }}>
              <div style={{ fontSize:9,fontWeight:800,color:C.accent,letterSpacing:".12em",textTransform:"uppercase",marginBottom:5 }}>
                {sec.title}
              </div>
              {sec.items.map((item, i) => (
                <div key={i} style={{ fontSize:11,color:C.text,marginBottom:3,lineHeight:1.4 }}>{item}</div>
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
