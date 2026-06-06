/**
 * ChatLayout.jsx — GRM Pro Jarvis Overlay
 * ─────────────────────────────────────────
 * View layer only. All logic, pool building, and utilities
 * are imported from jarvisStore.js — no forks, no duplication.
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
 *   rolloverChain       — object | null: REAL active rollover chain (wired from App)
 *   engineFixtureIds    — array of engine-flagged fixture IDs
 *   customFixtureIds    — array of user's custom list fixture IDs
 *   historicalRates     — object: backtest summary for pool scoring
 *   onNavigatePro       — fn(destination): navigate Pro to a specific place
 *   onBookNow           — fn(ticket, bookmaker): trigger booking flow
 *   defaultBookmaker    — 'SB' | 'LL'
 */

import React, {
  useState, useEffect, useRef, useCallback, useMemo,
} from "react";

import {
  INTENT, BUILD_STEP, MARKET_GROUPS, TOP_LEAGUES_RANK, TOP_COUNTRIES,
  SB_LINK_RE, LL_LINK_RE,
  classifyIntent,
  buildParley, legsFromTargetOdds,
  findFixture, getTopFixtures, filterFixturesByLeague, getLeagueCountries,
  copyToClipboard, safeImpliedOdds, openBookingLink, makeDraftCode,
} from "./jarvisStore.js";

// ── LOCAL CONSTANTS ───────────────────────────────────────────────────────────

const CHAT_HISTORY_KEY  = "grm_chat_history";
const BUILD_PREF_KEY    = "grm_chat_build_pref";
const TIP_PREFIX        = "grm_tip_";
const MAX_RENDERED_MSGS = 30;

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

// ── MESSAGE FACTORY ──────────────────────────────────────────────────────────
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

// safeImpliedOdds, classifyIntent, buildPool, findFixture, etc.
// are all imported from jarvisStore.js — no local forks.

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
  rolloverChain = null,        // ← REAL chain wired from App via Rollover callback
  engineFixtureIds = [],       // ← engine-flagged IDs for pool filtering
  customFixtureIds = [],       // ← user's custom list IDs for pool filtering
  historicalRates = null,
  onNavigatePro,
  onBookNow,
  defaultBookmaker = "SB",
}) {
  // ── Message state
  const [messages, setMessages]         = useState(() => safeGet(CHAT_HISTORY_KEY, null));
  const [input, setInput]               = useState("");
  const [isTyping, setIsTyping]         = useState(false);

  // ── Build flow — session-level ref, not embedded in messages.
  // activeBuildMsgId: only the message with this ID renders live build-step UI.
  // All prior build-step messages become inert display cards.
  const [buildFlow, setBuildFlow]               = useState(null);
  const [activeBuildMsgId, setActiveBuildMsgId] = useState(null);

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

  // ── Body scroll lock — prevents Live Model list scrolling behind Jarvis panel
  useEffect(() => {
    if (isOpen) {
      document.body.style.overflow = "hidden";
      document.body.style.touchAction = "none";
    } else {
      document.body.style.overflow = "";
      document.body.style.touchAction = "";
    }
    return () => {
      document.body.style.overflow = "";
      document.body.style.touchAction = "";
    };
  }, [isOpen]);

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

  // ── GREETING / HELP ────────────────────────────────────────────────────────

  async function handleGreeting(polarity) {
    await simulateTyping(300);
    const isPositive = polarity === "positive";
    const text = isPositive
      ? "Any time! What would you like to do next?"
      : "Hey! What can I help you with today?";
    addJarvisMsg({ type: "TEXT", text }, [
      { label: "Build a parley",   text: "Build me a parley"          },
      { label: "Today's fixtures", text: "Today's fixtures"           },
      { label: "My Rollover",      text: "Check my Rollover"          },
    ]);
  }

  async function handleHelp() {
    await simulateTyping(400);
    addJarvisMsg({ type: "HELP_CARD" }, [
      { label: "Build a parley",   text: "Build me a parley"          },
      { label: "Today's fixtures", text: "Today's fixtures"           },
      { label: "My Rollover",      text: "Check my Rollover"          },
      { label: "Analyse a slip",   text: "Analyse a slip"             },
    ]);
  }

  // ── ROLLOVER ─────────────────────────────────────────────────────────────────

  async function handleRolloverStatus() {
    await simulateTyping(600);
    // rolloverChain is now wired from App via onChainChange — never null if active
    if (!rolloverChain) {
      addJarvisMsg({ type: "TEXT", text: "You don't have an active Rollover chain." }, [
        { label: "Start Rollover", action: "NAV_ROLLOVER" },
      ]);
      return;
    }
    const chain = rolloverChain;
    const pick  = chain.todayPick || chain.pick || null;
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

  function startBuildFlow(nlParams = null) {
    // If NL params extracted (legs, market, targetOdds, league) — skip the
    // entire flow and go straight to executeBuild.
    if (nlParams && (nlParams.legs || nlParams.targetOdds || nlParams.market)) {
      const flow = {
        step:    BUILD_STEP.CONFIRM,
        mode:    "jarvis",
        pool:    "all",
        legs:    nlParams.legs    || "auto",
        targetOdds: nlParams.targetOdds || "auto",
        market:  nlParams.market  || "theRead",
        leagues: nlParams.league  || null,
      };
      setBuildFlow(flow);
      const loadingMsg = makeLoadingMsg();
      addMsg(loadingMsg);
      setActiveBuildMsgId(null); // no interactive step — straight to result
      executeBuild(flow, loadingMsg.id);
      return;
    }

    const pref = getBuildPref();
    // Use saved pref to skip MODE step, but still ask POOL
    const newFlow = pref
      ? { step: BUILD_STEP.POOL, mode: pref, prefPopupVisible: true }
      : { step: BUILD_STEP.MODE };

    setBuildFlow(newFlow);

    const msg = makeJarvisMsg({ type: pref ? "BUILD_POOL_SELECT" : "BUILD_MODE_SELECT" });
    addMsg(msg);
    setActiveBuildMsgId(msg.id); // this message owns the active step UI

    if (pref) {
      setTimeout(() => setBuildFlow(prev => prev ? { ...prev, prefPopupVisible: false } : prev), 2500);
    }
  }

  async function handleBuildParley(nlParams = null) {
    await simulateTyping(400);
    startBuildFlow(nlParams);
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
    await simulateTyping(500);

    const loadingMsg = makeLoadingMsg();
    addMsg(loadingMsg);

    try {
      const res = await fetch("/api/jarvis-chat", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({
          message: rawText,
          date:    new Date().toISOString().slice(0, 10),
        }),
      });

      if (res.ok) {
        const { reply } = await res.json();
        if (reply?.trim()) {
          replaceLoadingMsg(loadingMsg.id, makeJarvisMsg(
            { type: "TEXT", text: reply.trim() },
            [
              { label: "Build a parley",   text: "Build me a parley"          },
              { label: "Today's fixtures", text: "Today's fixtures"           },
              { label: "My Rollover",      text: "What's my rollover status?" },
            ]
          ));
          return;
        }
      }
    } catch {
      // Network/server error — fall through to default
    }

    const chips = chatLastAction?.type === "PARLEY_BUILT"
      ? [
          { label: "Remix",         text: "Remix"                 },
          { label: "Add more legs", text: "Add more legs"         },
          { label: "New parley",    text: "Build me a new parley" },
        ]
      : [
          { label: "Build a parley",   text: "Build me a parley"          },
          { label: "Check fixtures",   text: "Today's fixtures"           },
          { label: "My Rollover",      text: "What's my rollover status?" },
        ];

    replaceLoadingMsg(loadingMsg.id, makeJarvisMsg(
      { type: "TEXT", text: "I'm not sure I got that. Here's what I can help with:" },
      chips
    ));
  }

  // ── BUILD FLOW HANDLERS ─────────────────────────────────────────────────────

  function onBuildModeSelect(mode) {
    saveBuildPref(mode);
    const newFlow = { ...buildFlow, mode, step: BUILD_STEP.POOL };
    setBuildFlow(newFlow);
    const msg = makeJarvisMsg({ type: "BUILD_POOL_SELECT" });
    addMsg(msg);
    setActiveBuildMsgId(msg.id);
  }

  function onBuildPoolSelect(pool) {
    // "custom" pool → navigate to custom list first if no customFixtureIds loaded
    if (pool === "custom" && !customFixtureIds?.length) {
      addJarvisMsg({ type: "TEXT", text: "Opening your Custom List — add fixtures there, then come back to build." }, [
        { label: "Open Custom List", action: "NAV_CUSTOM" },
      ]);
      setBuildFlow(null);
      setActiveBuildMsgId(null);
      return;
    }
    const newFlow = { ...buildFlow, pool, step: BUILD_STEP.LEGS_TARGET };
    setBuildFlow(newFlow);
    const msg = makeJarvisMsg({ type: "BUILD_LEGS_TARGET_SELECT" });
    addMsg(msg);
    setActiveBuildMsgId(msg.id);
  }

  // legs + target odds combined — market is NO LONGER mandatory.
  // Jarvis defaults to theRead. User can specify market inline in their first message.
  function onBuildLegsTargetSelect({ legs, targetOdds, market }) {
    const confirmedFlow = {
      ...buildFlow,
      legs,
      targetOdds,
      market: market || "theRead",   // default: best-market (theRead)
      leagues: null,                  // no league gate — user can specify inline
      step: BUILD_STEP.CONFIRM,
    };
    setBuildFlow(confirmedFlow);
    setActiveBuildMsgId(null);  // freeze the legs/target message
    executeBuild(confirmedFlow);
  }

  // Optional: user can still manually open market sheet via chip
  function onBuildMarketSelect(market) {
    setBottomSheet(null);
    if (!buildFlow) return;
    const updatedFlow = { ...buildFlow, market };
    setBuildFlow(updatedFlow);
    if (updatedFlow.legs || updatedFlow.targetOdds) {
      executeBuild({ ...updatedFlow, step: BUILD_STEP.CONFIRM });
    }
  }

  function onBuildLeaguesSelect(leagues) {
    setBottomSheet(null);
    if (!buildFlow) return;
    const updatedFlow = { ...buildFlow, leagues, step: BUILD_STEP.CONFIRM };
    setBuildFlow(updatedFlow);
    executeBuild(updatedFlow);
  }

  async function executeBuild(flow, existingLoadingId = null) {
    // Use passed loadingMsgId (NL path) or create a new one (flow path)
    let loadingId = existingLoadingId;
    if (!loadingId) {
      const loadingMsg = makeLoadingMsg();
      addMsg(loadingMsg);
      loadingId = loadingMsg.id;
    }
    await new Promise(r => setTimeout(r, 1200));

    const { mode, pool, legs, targetOdds, market, leagues } = flow;

    // Determine leg count
    let legCount;
    if (legs && legs !== "auto") {
      legCount = parseInt(legs, 10) || 6;
    } else if (targetOdds && targetOdds !== "auto") {
      legCount = legsFromTargetOdds(targetOdds);
    } else {
      legCount = 6;
    }

    const result = fixturesLoaded && fixtures.length
      ? buildParley({
          fixtures,
          marketFamily:     market || "theRead",
          legCount,
          leagueFilter:     (leagues === "all" || !leagues) ? null : leagues,
          poolSource:       pool || "all",
          engineIds:        engineFixtureIds,
          customFixtureIds: customFixtureIds,
        })
      : null;

    if (!result || !result.ticket.legs.length) {
      replaceLoadingMsg(loadingId, makeJarvisMsg(
        { type: "TEXT", text: "Not enough qualifying games match those filters today. Try fewer legs or wider leagues." },
        [{ label: "Try again", text: "Build me a parley" }, { label: "Wider pool", text: "Build me a parley with all leagues" }]
      ));
      setBuildFlow(null);
      setActiveBuildMsgId(null);
      return;
    }

    const { ticket, partial } = result;
    // Auto-save
    onSaveTicket?.(ticket);

    const finalMsg = makeJarvisMsg({
      type:    "TICKET_CARD",
      ticket,
      partial,
    }, [
      { label: "Remix",         text: "Remix"          },
      { label: "Add more legs", text: "Add more legs"  },
      { label: "New",           text: "Build me a new parley" },
    ]);

    replaceLoadingMsg(loadingId, finalMsg);
    setBuildFlow(null);
    setActiveBuildMsgId(null);
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

    const result = buildParley({
      fixtures,
      marketFamily:     ticket.marketFamily || ticket.legs[0]?.market?.toLowerCase().replace(/\s/g,"") || "theRead",
      legCount:         ticket.legs.length,
      leagueFilter:     ticket.leagueFilter || null,
      poolSource:       ticket.poolSource   || "all",
      engineIds:        engineFixtureIds,
      customFixtureIds: customFixtureIds,
      excludeIds:       ticket.legs.map(l => l.fixtureId), // favour fresh fixtures
    });

    if (!result) {
      replaceLoadingMsg(loadingMsg.id, makeJarvisMsg(
        { type:"TEXT", text:"Not enough fresh fixtures to remix. Try a new parley." },
        [{ label:"New parley", text:"Build me a new parley" }]
      ));
      return;
    }

    const { ticket: newTicket } = result;
    onSaveTicket?.(newTicket);
    replaceLoadingMsg(loadingMsg.id, makeJarvisMsg(
      { type: "TICKET_CARD", ticket: newTicket },
      [{ label: "Remix again", text: "Remix" }, { label: "New parley", text: "Build me a new parley" }]
    ));
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
      case INTENT.GREETING:           handleGreeting(classified.polarity); break;
      case INTENT.HELP:               handleHelp(); break;
      case INTENT.ROLLOVER_STATUS:    handleRolloverStatus(); break;
      case INTENT.ROLLOVER_ANALYTICS: handleRolloverAnalytics(); break;
      // BUILD_PARLEY may carry NL params (legs, market, targetOdds, league)
      case INTENT.BUILD_PARLEY:       handleBuildParley(classified); break;
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
      overscrollBehavior: "contain",
      WebkitOverflowScrolling: "touch",
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
          activeBuildMsgId={activeBuildMsgId}
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
  buildFlow, activeBuildMsgId,
  onBuildModeSelect, onBuildPoolSelect, onBuildLegsTargetSelect,
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
              activeBuildMsgId={activeBuildMsgId}
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
  msg, C, S, buildFlow, activeBuildMsgId,
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
  // Only the message that owns the current active build step gets live controls.
  // All prior build-step messages are rendered as inert (frozen) cards.
  const isActiveBuildStep = activeBuildMsgId != null && msg.id === activeBuildMsgId;

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
        isActiveBuildStep={isActiveBuildStep}
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
  buildFlow, isActiveBuildStep,
  onBuildModeSelect, onBuildPoolSelect, onBuildLegsTargetSelect,
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
            Welcome to GRM Pro.<br/>
            I'm Jarvis — your football co-pilot.<br/><br/>
            Here's what I can do:
          </div>
        </div>
      );

    case "HELP_CARD":
      return (
        <div>
          <div style={{ ...textStyle, marginBottom: 8 }}>Here's what I can help with:</div>
          {[
            ["🏗️", "Build a parley", "Say \"build me a 5-leg BTTS parley\" or just \"build\""],
            ["📋", "Today's fixtures", "Top games with model picks and confidence"],
            ["🔄", "Rollover status", "Your chain, today's pick, gate progress"],
            ["🔍", "Slip analysis", "Paste a booking code or link to analyse it"],
            ["🔎", "Match analysis", "Say \"Arsenal vs Chelsea\" for a model breakdown"],
            ["🧭", "Navigate", "\"Go to engine picks\" or \"open custom list\""],
          ].map(([icon, title, desc]) => (
            <div key={title} style={{ display:"flex", gap:8, marginBottom:6 }}>
              <span style={{ fontSize:13 }}>{icon}</span>
              <div>
                <div style={{ fontSize:11, fontWeight:700, color:C.text }}>{title}</div>
                <div style={{ fontSize:10, color:C.muted, lineHeight:1.4 }}>{desc}</div>
              </div>
            </div>
          ))}
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

    // ── Build flow steps — only interactive if isActiveBuildStep
    case "BUILD_MODE_SELECT":
      if (!isActiveBuildStep) {
        return <div style={{ ...textStyle, color: C.muted, fontStyle:"italic" }}>Build mode selected.</div>;
      }
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
      if (!isActiveBuildStep) {
        return <div style={{ ...textStyle, color: C.muted, fontStyle:"italic" }}>Fixture pool selected.</div>;
      }
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
      if (!isActiveBuildStep) {
        return <div style={{ ...textStyle, color: C.muted, fontStyle:"italic" }}>Legs and odds set.</div>;
      }
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
// "Jarvis choice" option skips both — model auto-selects.
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
          Jarvis choice
        </button>
      </div>
    </div>
  );
}

function TicketCard({ C, S, ticket, partial, onBookNow, onNavigatePro, defaultBookmaker }) {
  const [bookState, setBookState]           = useState("idle");
  const [bookedCode, setBookedCode]         = useState(null);
  const [bookedPlatform, setBookedPlatform] = useState(null);
  const [bmSheetOpen, setBmSheetOpen]       = useState(false);

  if (!ticket) return null;
  const legs     = ticket.legs || [];
  const showLegs = legs.slice(0, 3);
  const extra    = legs.length - showLegs.length;

  function handleBookSelect(bm) {
    setBmSheetOpen(false);
    // Draft code until real bookmaker API is integrated
    const code = makeDraftCode(bm);
    setBookedCode(code);
    setBookedPlatform(bm);
    setBookState("booked");
    onBookNow?.(ticket, bm);
    // Open the share link immediately so user can complete booking on bookmaker side
    openBookingLink(code, bm);
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
            onClick={() => setBmSheetOpen(true)}
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

      {bookState === "booked" && bookedCode && (
        <BookedRow C={C} code={bookedCode} platform={bookedPlatform} />
      )}

      {/* Bookmaker slide-up sheet */}
      {bmSheetOpen && (
        <BookmakerSheet
          C={C}
          onSelect={handleBookSelect}
          onClose={() => setBmSheetOpen(false)}
        />
      )}
    </div>
  );
}

// ── BOOKMAKER SHEET ───────────────────────────────────────────────────────────
// Slide-up selector. LL shown but disabled — experiencing downtime.
// More bookmakers will be added here as they are integrated.

const BOOKMAKERS = [
  {
    id:      "SB",
    name:    "SportyBet",
    active:  true,
    sub:     null,
    icon:    "SB",
  },
  {
    id:      "LL",
    name:    "Lucky's Ledger",
    active:  false,
    sub:     "Experiencing downtime",
    icon:    "LL",
  },
];

function BookmakerSheet({ C, onSelect, onClose }) {
  return (
    <>
      {/* Scrim */}
      <div
        onClick={onClose}
        style={{
          position:"fixed", inset:0, zIndex:3000,
          background:"rgba(0,0,0,0.45)",
        }}
      />
      {/* Sheet */}
      <div style={{
        position:"fixed", left:0, right:0, bottom:0, zIndex:3001,
        background: C.surface2 || C.surface || "#1a1a1a",
        borderRadius:"16px 16px 0 0",
        padding:"0 0 calc(env(safe-area-inset-bottom) + 16px) 0",
        boxShadow:"0 -4px 32px rgba(0,0,0,0.5)",
      }}>
        {/* Handle */}
        <div style={{ display:"flex",justifyContent:"center",padding:"10px 0 4px" }}>
          <div style={{ width:36,height:4,borderRadius:2,background:C.border }} />
        </div>

        {/* Header */}
        <div style={{
          display:"flex",alignItems:"center",justifyContent:"space-between",
          padding:"8px 18px 12px",
        }}>
          <span style={{ fontSize:11,fontWeight:800,letterSpacing:".12em",textTransform:"uppercase",color:C.text }}>
            Select Bookmaker
          </span>
          <button
            onClick={onClose}
            style={{ background:"none",border:"none",color:C.muted,padding:4,cursor:"pointer",lineHeight:1 }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
              <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
          </button>
        </div>

        {/* Bookmaker rows */}
        {BOOKMAKERS.map(bm => (
          <button
            key={bm.id}
            disabled={!bm.active}
            onClick={() => bm.active && onSelect(bm.id)}
            style={{
              display:"flex", alignItems:"center", gap:14,
              width:"100%", padding:"13px 18px",
              background:"none", border:"none",
              borderTop: `1px solid ${C.border}`,
              cursor:   bm.active ? "pointer" : "not-allowed",
              opacity:  bm.active ? 1 : 0.45,
              textAlign:"left",
            }}
          >
            {/* Icon badge */}
            <div style={{
              width:36, height:36, borderRadius:10,
              background: bm.active ? (C.accentDim || C.accent + "22") : (C.border),
              display:"flex", alignItems:"center", justifyContent:"center",
              fontSize:10, fontWeight:800, color: bm.active ? C.accent : C.muted,
              letterSpacing:".04em", flexShrink:0,
            }}>
              {bm.icon}
            </div>

            {/* Name + sub */}
            <div style={{ flex:1, minWidth:0 }}>
              <div style={{ fontSize:13, fontWeight:700, color: bm.active ? C.text : C.muted, letterSpacing:".01em" }}>
                {bm.name}
              </div>
              {bm.sub && (
                <div style={{ fontSize:10, color: C.amber || "#f5a623", marginTop:2 }}>
                  {bm.sub}
                </div>
              )}
            </div>

            {/* Arrow (active only) */}
            {bm.active && (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={C.muted} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="9 18 15 12 9 6"/>
              </svg>
            )}
          </button>
        ))}

        <div style={{ padding:"12px 18px 0", fontSize:10, color:C.muted }}>
          More bookmakers coming soon.
        </div>
      </div>
    </>
  );
}

// ── BOOKED ROW ────────────────────────────────────────────────────────────────
// Shows booking code + Copy Code + Copy Link. Compact, never wraps.

function BookedRow({ C, code, platform }) {
  const [codeCopied, setCodeCopied] = useState(false);
  const [linkCopied, setLinkCopied] = useState(false);

  const bookingLink = platform === "LL"
    ? `https://luckysledger.com/sports?btBookingCode=${code}`
    : `https://www.sportybet.com/ng/?shareCode=${code}`;

  const doCopyCode = () => copyToClipboard(code,
    () => { setCodeCopied(true); setTimeout(() => setCodeCopied(false), 2000); }
  );
  const doCopyLink = () => copyToClipboard(bookingLink,
    () => { setLinkCopied(true); setTimeout(() => setLinkCopied(false), 2000); }
  );

  return (
    <div style={{ display:"flex",alignItems:"center",gap:6,flexWrap:"wrap" }}>
      <span className="grm-booked-badge">BOOKED</span>
      <span style={{ fontSize:11,color:"currentColor",fontWeight:700,letterSpacing:".06em",flex:1,minWidth:0,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap" }}>
        {code}
      </span>
      <button className={`grm-mini-btn-copy${codeCopied ? " copied" : ""}`} onClick={doCopyCode}>
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
        </svg>
        {codeCopied ? "Copied!" : "Code"}
      </button>
      <button className={`grm-mini-btn-copy${linkCopied ? " copied" : ""}`} onClick={doCopyLink}>
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
