import { useState, useEffect, useCallback, useRef } from "react";

const GATE_STEPS   = new Set([3, 5, 7, 9]);
const ROLLOVER_MAX = 10;
// Server-synced date — avoids UTC vs local timezone drift at midnight.
// C1-FIX: todayStr unified — Rollover now reads from window.__grmServerDate,
// the same slot App.jsx writes after its fetchServerDate() resolves.
// This prevents the two files returning different dates for the same moment
// when the user is in a timezone where local UTC differs from server UTC.
let _rolloverServerDateCache = null;
let _rolloverServerDateAt    = 0;
async function fetchRolloverServerDate(SERVER) {
  if (window.__grmServerDate) return window.__grmServerDate;
  if (_rolloverServerDateCache && Date.now() - _rolloverServerDateAt < 5 * 60_000)
    return _rolloverServerDateCache;
  try {
    const r = await fetch(`${SERVER}/api/server-date`);
    const j = await r.json();
    if (j.date) {
      _rolloverServerDateCache = j.date;
      _rolloverServerDateAt    = Date.now();
      window.__grmServerDate   = j.date;
      return j.date;
    }
  } catch {}
  return new Date().toISOString().split("T")[0];
}
const todayStr = () =>
  window.__grmServerDate ||
  _rolloverServerDateCache ||
  new Date().toISOString().split("T")[0];
const RVL_ONBOARD_KEY  = "rvl_onboarded_v1";
const RVL_CAPITAL_KEY  = "rvl_starting_capital";
const RVL_UUID_KEY     = "rvl_user_uuid";

// Generate or retrieve a stable device UUID
function getOrCreateUUID() {
  // E1-FIX: never return "anon" (4 chars) — server rejects userId.length < 6 with 400,
  // silently breaking the entire Rollover feature in private mode / Safari ITP.
  // Strategy: try localStorage first, then sessionStorage (survives the tab, not the session),
  // then generate an in-memory ID. The generated fallback won't persist across refreshes
  // in private mode, but it will at least work for the current session without server errors.
  const SESSION_KEY = RVL_UUID_KEY + "_session";
  const makeId = () =>
    typeof crypto?.randomUUID === "function"
      ? crypto.randomUUID()
      : "u-" + Math.random().toString(36).slice(2,10) + Math.random().toString(36).slice(2,10);

  // 1. Try localStorage (normal mode)
  try {
    let id = localStorage.getItem(RVL_UUID_KEY);
    if (id && id.length >= 10 && id !== "anon") return id;
    id = makeId();
    localStorage.setItem(RVL_UUID_KEY, id);
    return id;
  } catch { /* localStorage blocked */ }

  // 2. Try sessionStorage (private mode — survives tab, not restart)
  try {
    let id = sessionStorage.getItem(SESSION_KEY);
    if (id && id.length >= 10) return id;
    id = makeId();
    sessionStorage.setItem(SESSION_KEY, id);
    return id;
  } catch { /* sessionStorage also blocked */ }

  // 3. In-memory last resort — won't persist but won't break the server
  return makeId();
}

const GATE_TABLE = [
  { step:1,  target:"×2",    saveRate:null,  desc:"Double your starting stake" },
  { step:2,  target:"×4",    saveRate:null,  desc:"Grow to 4× your base" },
  { step:3,  target:"×8",    saveRate:0.30,  desc:"First profit gate — 30% locked" },
  { step:4,  target:"×16",   saveRate:null,  desc:"Continue compounding" },
  { step:5,  target:"×32",   saveRate:0.30,  desc:"Second profit gate — 30% locked" },
  { step:6,  target:"×64",   saveRate:null,  desc:"Continue compounding" },
  { step:7,  target:"×128",  saveRate:0.30,  desc:"Third profit gate — 30% locked" },
  { step:8,  target:"×256",  saveRate:null,  desc:"Continue compounding" },
  { step:9,  target:"×512",  saveRate:0.30,  desc:"Fourth profit gate — 30% locked" },
  { step:10, target:"×1024", saveRate:1.00,  desc:"Final step — full cashout" },
];

// ── STYLES ──────────────────────────────────────────────────────────────────
// CSS custom properties on :root are set by App.jsx's injectStyles().
// Rollover consumes them directly via var(--xxx).
function injectRolloverStyles(C) {
  const id = "rollover-v4-styles";
  const old = document.getElementById(id);
  if (old) old.remove();
  const s = document.createElement("style");
  s.id = id;
  s.textContent = `
    @keyframes rvl-fadeUp  { from{opacity:0;transform:translateY(10px)} to{opacity:1;transform:none} }
    @keyframes rvl-shimmer { 0%{transform:translateX(-100%)} 100%{transform:translateX(220%)} }
    @keyframes rvl-spin    { to{transform:rotate(360deg)} }
    @keyframes rvl-pulse   { 0%,100%{opacity:1} 50%{opacity:.42} }
    @keyframes rvl-glow    {
      0%,100%{box-shadow:0 0 12px var(--green)40}
      50%    {box-shadow:0 0 28px var(--green)80}
    }

    .rvl-card {
      border-radius:var(--r-xl);
      transition:border-color .18s,background .18s,box-shadow .18s;
    }
    .rvl-btn {
      font-family:var(--font);
      font-weight:800; letter-spacing:.05em; text-transform:uppercase;
      cursor:pointer; border:none; transition:all .16s;
      border-radius:var(--r-lg);
      -webkit-tap-highlight-color:transparent;
    }
    .rvl-btn:active   { transform:scale(.97); }
    .rvl-btn:disabled { opacity:.35; cursor:not-allowed; }
    .rvl-fade  { animation:rvl-fadeUp .3s cubic-bezier(.22,1,.36,1) forwards; }
    .rvl-pulse { animation:rvl-pulse 1.6s ease infinite; }
    .rvl-spin  { animation:rvl-spin 1s linear infinite; }

    /* ── Rollover header shell — matches App.jsx grm-header ─────────── */
    .rvl-header {
      position:sticky; top:0; z-index:10;
      background:color-mix(in srgb, var(--header-bg) 94%, transparent);
      backdrop-filter:blur(32px); -webkit-backdrop-filter:blur(32px);
      border-bottom:1px solid var(--glass-border);
      padding:14px 18px 0;
    }

    /* Header top row */
    .rvl-header-top {
      display:flex; align-items:center; justify-content:space-between;
      margin-bottom:12px;
    }
    .rvl-wordmark {
      font-size:15px; font-weight:800; letter-spacing:-.05em;
      color:var(--text); line-height:1;
      font-family:'Azeret Mono',monospace;
    }
    .rvl-wordmark-accent { color:var(--green); margin-left:4px; }
    .rvl-wordmark-meta {
      font-size:9px; font-weight:400; color:var(--muted);
      margin-left:8px; letter-spacing:.02em;
    }

    /* ── Tab bar — larger, premium, icon + label ─────────────────────── */
    .rvl-tab-bar {
      display:flex; gap:4px;
    }

    .rvl-tab {
      flex:1; display:flex; align-items:center; justify-content:center; gap:6px;
      padding:10px 8px 12px;
      font-size:11px; font-weight:700; letter-spacing:.02em;
      cursor:pointer; border:none; background:none;
      font-family:var(--font); position:relative;
      transition:color .18s; color:var(--muted);
      -webkit-tap-highlight-color:transparent;
    }
    .rvl-tab:hover { color:var(--text); }
    .rvl-tab.rvl-active { color:var(--text); font-weight:800; }

    /* Active indicator line */
    .rvl-tab::after {
      content:""; position:absolute; bottom:0; left:20%; right:20%;
      height:2px; border-radius:1px;
      transform:scaleX(0);
      transition:transform .22s cubic-bezier(.34,1.56,.64,1);
      background:var(--green);
    }
    .rvl-tab.rvl-active::after { transform:scaleX(1); }

    /* Tab icon — inherits colour from parent */
    .rvl-tab-icon {
      width:18px; height:18px;
      display:flex; align-items:center; justify-content:center;
      transition:color .18s;
    }
    .rvl-tab.rvl-active .rvl-tab-icon { color:var(--green); }

    /* ── Step tracker ───────────────────────────────────────────────── */
    .rvl-step-chip  { display:flex; flex-direction:column; align-items:center; gap:3px; flex-shrink:0; }
    .rvl-step-inner {
      width:34px; height:34px; border-radius:var(--r-md);
      display:flex; align-items:center; justify-content:center;
      font-weight:900; font-size:11px; transition:all .22s;
    }

    /* ── Other layout classes ───────────────────────────────────────── */
    .rvl-leg-row {
      display:flex; align-items:flex-start; gap:12px; padding:12px 0;
      border-bottom:1px solid var(--glass-border);
    }
    .rvl-leg-row:last-child { border-bottom:none; }

    .rvl-pipe-row {
      display:grid; grid-template-columns:28px 48px 40px 1fr auto;
      gap:8px; align-items:center; padding:10px 12px;
      border-radius:var(--r-lg);
      margin-bottom:4px; cursor:pointer; transition:background .14s;
    }

    .rvl-skel { overflow:hidden; position:relative; }
    .rvl-skel::after {
      content:""; position:absolute; inset:0;
      background:linear-gradient(90deg,transparent,var(--glass-border) 50%,transparent);
      animation:rvl-shimmer 1.4s ease infinite;
    }

    .rvl-bar  { height:4px; border-radius:2px; overflow:hidden; }
    .rvl-fill { height:100%; border-radius:2px; transition:width .6s cubic-bezier(.4,0,.2,1); }
    .rvl-conn { height:2px; flex:1; position:relative; top:-14px; margin:0 -1px; }

    .rvl-coll-btn {
      background:none; border:none; cursor:pointer; width:100%;
      display:flex; align-items:center; gap:8px;
      font-family:var(--font); transition:opacity .14s;
      -webkit-tap-highlight-color:transparent;
    }
    .rvl-coll-btn:hover { opacity:.75; }

    .rvl-hist-row {
      border-radius:var(--r-lg); padding:14px 16px;
      display:flex; justify-content:space-between; align-items:center;
      margin-bottom:8px; border:1px solid transparent;
    }
    .rvl-roi-bar  { height:6px; border-radius:3px; overflow:hidden; background:var(--subtle-bg); }
    .rvl-roi-fill { height:100%; border-radius:3px; transition:width .8s cubic-bezier(.4,0,.2,1); }

    /* ── Draft B: Hero strip ─────────────────────────────────────────── */
    .rvlb-hero {
      padding:24px 18px 20px;
      border-bottom:1px solid var(--glass-border);
      background:var(--bg);
      position:relative; overflow:hidden;
    }
    .rvlb-hero-ghost {
      position:absolute; right:-8px; top:-14px;
      font-size:100px; font-weight:900; line-height:1;
      font-family:'Azeret Mono',monospace;
      color:var(--text); opacity:.04;
      letter-spacing:-.08em; pointer-events:none; user-select:none;
    }
    .rvlb-hero-label {
      font-size:8px; font-weight:800; letter-spacing:.2em;
      text-transform:uppercase; color:var(--muted); margin-bottom:6px;
    }
    .rvlb-hero-number {
      font-size:72px; font-weight:900; line-height:1;
      font-family:'Azeret Mono',monospace; letter-spacing:-.06em;
    }
    .rvlb-hero-sub { font-size:10px; color:var(--muted); margin-top:8px; }
    .rvlb-stat-tile {
      flex:1; padding:10px 12px;
      background:var(--surface);
      border:1px solid var(--glass-border);
      border-radius:var(--r-md);
    }
    .rvlb-stat-key {
      font-size:7px; font-weight:700; color:var(--muted);
      letter-spacing:.12em; text-transform:uppercase; margin-bottom:3px;
    }
    .rvlb-stat-val {
      font-size:14px; font-weight:900;
      font-family:'Azeret Mono',monospace; letter-spacing:-.03em; line-height:1;
    }

    /* ── Draft B: Timeline ───────────────────────────────────────────── */
    .rvlb-tl-row { display:flex; gap:14px; }
    .rvlb-tl-spine {
      display:flex; flex-direction:column; align-items:center;
      flex-shrink:0; width:32px;
    }
    .rvlb-tl-dot {
      width:32px; height:32px; border-radius:50%;
      display:flex; align-items:center; justify-content:center;
      font-size:11px; font-weight:900; flex-shrink:0;
      font-family:'Azeret Mono',monospace; transition:all .22s;
    }
    .rvlb-tl-dot-done    { background:rgba(34,197,94,.12); color:var(--green); border:2px solid var(--green); }
    .rvlb-tl-dot-current { background:var(--accent); color:var(--accent-text); border:2px solid var(--accent); animation:rvl-glow 2.2s ease infinite; }
    .rvlb-tl-dot-future  { background:var(--surface); color:var(--muted); border:1.5px solid var(--glass-border); }
    .rvlb-tl-line        { width:2px; flex:1; min-height:24px; background:var(--glass-border); transition:background .3s; margin:0 auto; }
    .rvlb-tl-line-done   { background:var(--green); }
    .rvlb-tl-content     { flex:1; padding:6px 0 20px; }
    .rvlb-tl-step-label  { font-size:8px; font-weight:700; color:var(--muted); letter-spacing:.12em; text-transform:uppercase; margin-bottom:2px; }
    .rvlb-tl-target      { font-size:20px; font-weight:900; line-height:1; font-family:'Azeret Mono',monospace; letter-spacing:-.04em; }
    .rvlb-tl-desc        { font-size:9px; color:var(--muted); margin-top:4px; line-height:1.55; }
    .rvlb-gate-badge {
      display:inline-flex; align-items:center; gap:4px;
      border-radius:var(--r-sm); padding:3px 8px; margin-top:5px;
      font-size:7px; font-weight:900; letter-spacing:.08em; text-transform:uppercase;
    }

    /* ── Draft B: tabs sit below hero strip, no icons ────────────────── */
    .rvlb-tabs { display:flex; border-bottom:1px solid var(--glass-border); }
    .rvlb-tab {
      flex:1; padding:12px 0; text-align:center;
      font-size:10px; font-weight:800; letter-spacing:.1em; text-transform:uppercase;
      color:var(--muted); cursor:pointer; border:none; background:none;
      font-family:var(--font); position:relative; transition:color .18s;
      -webkit-tap-highlight-color:transparent;
    }
    .rvlb-tab:hover { color:var(--text); }
    .rvlb-tab.rvlb-active { color:var(--green); }
    .rvlb-tab::after {
      content:""; position:absolute; bottom:0; left:25%; right:25%;
      height:2px; border-radius:1px; background:var(--green);
      transform:scaleX(0); transition:transform .22s cubic-bezier(.34,1.56,.64,1);
    }
    .rvlb-tab.rvlb-active::after { transform:scaleX(1); }
  `;
  document.head.appendChild(s);
}

// ── PRIMITIVES ───────────────────────────────────────────────────────────────
function Lbl({ children, color, size = 9, style = {} }) {
  return (
    <div style={{ fontSize:size, fontWeight:800, letterSpacing:".12em",
                  textTransform:"uppercase", color:color||"inherit",
                  opacity:color?1:0.5, ...style }}>
      {children}
    </div>
  );
}

function Val({ children, color, size = 22, style = {} }) {
  return (
    <div style={{ fontSize:size, fontWeight:900, color:color||"inherit",
                  lineHeight:1, fontVariantNumeric:"tabular-nums", ...style }}>
      {children}
    </div>
  );
}

function SBadge({ status, C }) {
  const map = {
    WON:     { bg:`${C.green}20`, border:`${C.green}50`, color:C.green, lbl:"Won"     },
    CURRENT: { bg:`${C.gold}18`,  border:`${C.gold}55`,  color:C.gold,  lbl:"Active"  },
    LOST:    { bg:`${C.red}18`,   border:`${C.red}45`,   color:C.red,   lbl:"Lost"    },
    VOID:    { bg:`${C.amber||C.gold}18`, border:`${C.amber||C.gold}45`, color:C.amber||C.gold, lbl:"Void" },
    PENDING: { bg:C.border,       border:C.border,       color:C.muted, lbl:"Pending" },
  };
  const s = map[status] || map.PENDING;
  return (
    <span style={{ fontSize:8, fontWeight:900, letterSpacing:".1em", padding:"3px 8px",
                   borderRadius:6, background:s.bg, border:`1px solid ${s.border}`, color:s.color }}>
      {s.lbl.toUpperCase()}
    </span>
  );
}

function Skeleton({ C, height = 80, radius }) {
  return (
    <div className="rvl-skel"
         style={{ height, background:C.skeleton||C.surface, borderRadius:radius||14,
                  border:`1px solid ${C.border}` }} />
  );
}

// ── STEP TRACKER ─────────────────────────────────────────────────────────────
function StepTracker({ chain, C }) {
  const cur = chain?.step || 0;
  return (
    <div style={{ overflowX:"auto", paddingBottom:4 }}>
      <div style={{ display:"flex", alignItems:"flex-start",
                    minWidth:"max-content", padding:"2px 0 6px" }}>
        {Array.from({ length:ROLLOVER_MAX }, (_,i) => {
          const n      = i + 1;
          const past   = n <= cur;
          const active = n === cur + 1;
          const gate   = GATE_STEPS.has(n);
          const borderCol = past ? C.green : active ? C.gold : (C.borderHi||C.border);
          const textCol   = past ? C.green : active ? C.gold : C.muted;
          const bgCol     = past ? `${C.green}18` : active ? `${C.gold}18` : C.surface;
          return (
            <div key={n} style={{ display:"flex", alignItems:"center" }}>
              <div className="rvl-step-chip">
                <div className="rvl-step-inner"
                     style={{ background:bgCol, border:`2px solid ${borderCol}`, color:textCol,
                              boxShadow:active?`0 0 10px ${C.gold}35`:"none" }}>
                  {past ? (
                    <svg width="13" height="13" viewBox="0 0 13 13" fill="none">
                      <path d="M2.5 6.5l3 3 5-5" stroke={C.green} strokeWidth="2.2"
                            strokeLinecap="round" strokeLinejoin="round"/>
                    </svg>
                  ) : n}
                </div>
                {gate ? (
                  <div style={{ fontSize:7, fontWeight:900, letterSpacing:".08em",
                                padding:"2px 4px", borderRadius:4, marginTop:1,
                                background:(active||past)?`${C.gold}22`:`${C.muted}18`,
                                color:(active||past)?C.gold:C.muted,
                                border:`1px solid ${(active||past)?`${C.gold}40`:C.border}` }}>
                    GATE
                  </div>
                ) : (
                  <div style={{ fontSize:7, fontWeight:800, marginTop:2,
                                color:textCol, opacity:active?1:.6 }}>
                    STEP
                  </div>
                )}
              </div>
              {i < ROLLOVER_MAX-1 && (
                <div className="rvl-conn"
                     style={{ width:12,
                              background:n<cur?C.green:n===cur?C.gold:C.border,
                              opacity:n>=cur+1?0.35:1 }} />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── TIMELINE STEP — Draft B dashboard ────────────────────────────────────────
function TimelineStep({ row, state, stepData, isLast, C, pick, isPast, blocked, onBook, fixtures, onFullModel }) {
  const isDone    = state === "done";
  const isCurrent = state === "current";
  const isGate    = GATE_STEPS.has(row.step);
  const numCol    = isDone ? C.green : isCurrent ? (C.accent||C.gold) : C.muted;
  const dotClass  = isDone ? "rvlb-tl-dot rvlb-tl-dot-done" : isCurrent ? "rvlb-tl-dot rvlb-tl-dot-current" : "rvlb-tl-dot rvlb-tl-dot-future";
  const lineClass = "rvlb-tl-line" + (isDone ? " rvlb-tl-line-done" : "");

  return (
    <div className="rvlb-tl-row">
      <div className="rvlb-tl-spine">
        <div className={dotClass}>
          {isDone ? (
            <svg width="13" height="13" viewBox="0 0 13 13" fill="none">
              <path d="M2.5 6.5l3 3 5-5" stroke={C.green} strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          ) : row.step}
        </div>
        {!isLast && <div className={lineClass} />}
      </div>

      <div className="rvlb-tl-content">
        <div className="rvlb-tl-step-label">Step {row.step}</div>
        <div className="rvlb-tl-target" style={{ color:numCol }}>{row.target}</div>

        {isGate && (
          <div className="rvlb-gate-badge"
               style={{ background:`${C.gold}18`, border:`1px solid ${C.gold}40`, color:C.gold }}>
            <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0110 0v4"/>
            </svg>
            {row.saveRate === 1 ? "Full cashout" : `${Math.round((row.saveRate||0)*100)}% saved`}
          </div>
        )}

        <div className="rvlb-tl-desc">{row.desc}</div>

        {/* Done step: compact result summary */}
        {isDone && stepData && (
          <div style={{ marginTop:6, display:"flex", alignItems:"center", gap:8, flexWrap:"wrap" }}>
            {stepData.date && <span style={{ fontSize:8, color:C.muted }}>{stepData.date}</span>}
            {stepData.odds && <span style={{ fontSize:9, fontWeight:800, color:C.green }}>×{stepData.odds}</span>}
            <SBadge status={stepData.result==="WIN"?"WON":stepData.result==="LOSS"?"LOST":stepData.result==="VOID"?"VOID":"PENDING"} C={C} />
          </div>
        )}

        {/* Current step: inline slip */}
        {isCurrent && (
          <div style={{ marginTop:14 }}>
            {/* No pick */}
            {!pick && (
              <div style={{ padding:"14px", background:C.surface,
                            border:`1.5px dashed ${C.border}`, borderRadius:10, textAlign:"center" }}>
                <div style={{ fontSize:10, fontWeight:800, color:C.text, marginBottom:4 }}>
                  {isPast ? "No Slip That Day" : "No Qualifying Slip Yet"}
                </div>
                <div style={{ fontSize:9, color:C.muted, lineHeight:1.6 }}>
                  {isPast
                    ? "Pool was too thin or this date wasn't active."
                    : "Engine couldn't clear ≥2.0× today. Check back when new fixtures load."}
                </div>
              </div>
            )}

            {pick && (
              <div style={{ background:C.surface, border:`1px solid ${C.border}`, borderRadius:12, overflow:"hidden" }}>
                {/* Below-target banner */}
                {pick.belowTarget && (
                  <div style={{ padding:"8px 14px", background:`${C.amber||C.gold}12`,
                                borderBottom:`1px solid ${C.amber||C.gold}30` }}>
                    <div style={{ fontSize:9, fontWeight:800, color:C.amber||C.gold }}>⚠ Below 2.0× target — thin pool day</div>
                    <div style={{ fontSize:8, color:C.muted, marginTop:2, lineHeight:1.5 }}>
                      Engine couldn't clear threshold. Booking is your call.
                    </div>
                  </div>
                )}

                {/* Slip header */}
                <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", padding:"12px 14px 0" }}>
                  <div style={{ fontSize:9, fontWeight:800, color:C.green, letterSpacing:".08em", textTransform:"uppercase" }}>
                    {isPast ? "Past Slip" : "Today's Engine Slip"}
                  </div>
                  <div style={{ textAlign:"right" }}>
                    <div style={{ fontSize:18, fontWeight:900, fontFamily:"'Azeret Mono',monospace",
                                  color:pick.belowTarget?(C.amber||C.gold):C.gold, letterSpacing:"-.03em" }}>
                      ×{pick.totalOdds}
                    </div>
                    <div style={{ fontSize:8, color:C.muted }}>{pick.combinedEmpiricalRate}% · {pick.legs?.length} legs</div>
                  </div>
                </div>

                {/* Legs */}
                <div style={{ padding:"0 14px" }}>
                  {(pick.legs||[]).map((l,i) => {
                    const fix = fixtures?.find(f => f.id === l.fixtureId) || null;
                    return (
                      <LegRow key={i} leg={l} index={i} C={C}
                              onFullModel={fix && onFullModel ? () => onFullModel(fix) : null} />
                    );
                  })}
                </div>

                {/* Blocked banner */}
                {blocked && (
                  <div style={{ margin:"0 14px 14px", background:`${C.red}12`,
                                border:`1px solid ${C.red}35`, borderRadius:8,
                                padding:"10px 12px", textAlign:"center" }}>
                    <div style={{ fontSize:10, fontWeight:900, color:C.red, marginBottom:4 }}>
                      ⛔ {hasLiveLeg(pick.legs) ? "Match in progress" : "Match has finished"}
                    </div>
                    <div style={{ fontSize:8, color:C.muted, lineHeight:1.6 }}>
                      This slip can no longer be booked. Come back tomorrow.
                    </div>
                  </div>
                )}

                {/* CTA */}
                {!isPast && !blocked && (
                  <div style={{ padding:"0 14px 14px" }}>
                    <button onClick={onBook} className="rvl-btn"
                            style={{ width:"100%", padding:"15px 0", fontSize:12, marginTop:4,
                                     background:C.accent, color:C.accentText,
                                     boxShadow:`0 4px 18px ${C.accent}40` }}>
                      Place {pick.totalOdds}× Slip
                    </button>
                    <div style={{ textAlign:"center", fontSize:8, color:C.muted, opacity:.5, marginTop:8 }}>
                      Result tracked automatically
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ── LEG ROW — shows both hit rate AND model confidence ────────────────────────
function LegRow({ leg, index, C, showStatus = false }) {
  const conf = leg.conf || leg.modelConf || null;
  const er   = leg.empiricalRate || null;

  // Live/FT detection for booking block
  const state = (leg.state || "").toLowerCase().replace(/[\s_\-]/g,"");
  const LIVE_STATES = new Set(["inprogress","live","1h","1sthalf","ht","halftime","2h","2ndhalf","et","extratime","penaltyshootout"]);
  const FT_STATES   = new Set(["finished","ft","fulltime","ended","complete","aet","afterextratime","afterpenalties"]);
  const isLive = LIVE_STATES.has(state);
  const isFT   = FT_STATES.has(state);
  const isBlocked = isLive || isFT;

  // Result badge for scored legs
  const resultColor = leg.result === "WIN"  ? C.green
                    : leg.result === "LOSS" ? C.red
                    : leg.result === "VOID" ? (C.amber||C.gold)
                    : null;

  return (
    <div className="rvl-leg-row" style={{ opacity: isBlocked ? 0.6 : 1 }}>
      <div style={{ width:26, height:26, borderRadius:8, flexShrink:0,
                    background: isBlocked ? `${C.red}18` : `${C.gold}18`,
                    border:`1px solid ${isBlocked ? `${C.red}40` : `${C.gold}35`}`,
                    display:"flex", alignItems:"center", justifyContent:"center" }}>
        <span style={{ fontSize:9, fontWeight:900, color:isBlocked?C.red:C.gold }}>{index+1}</span>
      </div>
      <div style={{ flex:1, minWidth:0 }}>
        <div style={{ display:"flex", alignItems:"center", gap:6, flexWrap:"wrap" }}>
          <div style={{ fontSize:12, fontWeight:800, color:isBlocked?C.muted:C.text,
                        whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis" }}>
            {leg.pick}<span style={{ color:C.gold, marginLeft:5 }}>@{leg.odds}</span>
          </div>
          {isLive && (
            <span style={{ fontSize:8, fontWeight:900, color:C.red,
                           background:`${C.red}15`, border:`1px solid ${C.red}35`,
                           borderRadius:4, padding:"2px 7px", flexShrink:0,
                           display:"inline-flex", alignItems:"center", gap:4 }}>
              <svg width="6" height="6" viewBox="0 0 6 6"><circle cx="3" cy="3" r="3" fill="currentColor" className="live-dot"/></svg>
              LIVE
            </span>
          )}
          {isFT && (
            <span style={{ fontSize:8, fontWeight:800, color:C.muted,
                           background:`var(--glass-border)`, border:`1px solid var(--glass-border)`,
                           borderRadius:4, padding:"2px 7px", flexShrink:0 }}>
              FT
            </span>
          )}
          {showStatus && resultColor && (
            <span style={{ fontSize:7, fontWeight:900, color:resultColor,
                           background:`${resultColor}18`, border:`1px solid ${resultColor}40`,
                           borderRadius:4, padding:"1px 5px", flexShrink:0 }}>
              {leg.result === "WIN" ? "✓ WIN" : leg.result === "LOSS" ? "✕ LOSS" : "— VOID"}
            </span>
          )}
        </div>
        <div style={{ fontSize:9, color:C.muted, marginTop:2,
                      whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis" }}>
          {leg.game}
        </div>
        <div style={{ fontSize:8, color:C.muted, opacity:.7, marginTop:1 }}>{leg.league}</div>
      </div>
      {/* Both confidence + hit rate */}
      <div style={{ textAlign:"right", flexShrink:0, minWidth:56 }}>
        {conf != null && (
          <div style={{ marginBottom:4 }}>
            <div style={{ fontSize:11, fontWeight:900, color:C.gold }}>{Math.round(conf)}%</div>
            <div style={{ fontSize:7, fontWeight:800, color:C.muted, marginTop:1 }}>MODEL</div>
          </div>
        )}
        {er != null && (
          <div>
            <div style={{ fontSize:11, fontWeight:900, color:C.green }}>{er}%</div>
            <div style={{ fontSize:7, fontWeight:800, color:C.muted, marginTop:1 }}>HIT RATE</div>
          </div>
        )}
      </div>
    </div>
  );
}

// ── CHECK IF ANY LEG IS LIVE/FT ──────────────────────────────────────────────
function hasBlockedLegs(legs = []) {
  return legs.some(l => {
    const s = (l.state || "").toLowerCase().replace(/[\s_\-]/g,"");
    return ["inprogress","live","1h","1sthalf","ht","halftime","2h","2ndhalf",
            "et","extratime","penaltyshootout",
            "finished","ft","fulltime","ended","complete","aet",
            "afterextratime","afterpenalties"].includes(s);
  });
}

function hasLiveLegs(legs = []) {
  return legs.some(l => {
    const s = (l.state || "").toLowerCase().replace(/[\s_\-]/g,"");
    return ["inprogress","live","1h","1sthalf","ht","halftime","2h","2ndhalf",
            "et","extratime","penaltyshootout"].includes(s);
  });
}
const hasLiveLeg = hasLiveLegs; // alias used in TimelineStep

// ── BOOK MODAL ───────────────────────────────────────────────────────────────
// N2-FIX: BOOKIE_META — LL discontinued/paused. Marked disabled with downtime subtext.
// Duel added (sptpub engine, route now registered in server.js).
const BOOKIE_META = {
  sportybet:   { label:"SportyBet NG",   link: code => `https://www.sportybet.com/ng/?shareCode=${code}`,              app: code => `sportybet://share?shareCode=${code}` },
  duel:        { label:"Duel",           link: code => `https://duel.com/sports?bt-path=%2F%3FbtBookingCode%3D${code}`, app: code => `duel://betslip?btBookingCode=${code}` },
  luckyledger: { label:"Lucky's Ledger", link: code => `https://luckysledger.com/sports?btBookingCode=${code}`,        app: code => `luckysledger://betslip?btBookingCode=${code}`, disabled: true, disabledText: "Experiencing downtime" },
};

// Persist booking result to sessionStorage so it survives tab-switches.
const RVL_BOOK_KEY = "grm_rvl_last_booking";
function loadPersistedBooking() {
  try { return JSON.parse(sessionStorage.getItem(RVL_BOOK_KEY) || "null"); } catch { return null; }
}
function persistBooking(d) {
  try { sessionStorage.setItem(RVL_BOOK_KEY, JSON.stringify(d)); } catch {}
}
function clearPersistedBooking() {
  try { sessionStorage.removeItem(RVL_BOOK_KEY); } catch {}
}

function BookModal({ pick, C, SERVER, onClose, onBooked }) {
  const [bookie,   setBookie]   = useState("sportybet");
  const [booking,  setBooking]  = useState(false);
  const [done,     setDone]     = useState(() => loadPersistedBooking());
  const [err,      setErr]      = useState(null);
  const [copied,   setCopied]   = useState(false);
  const [sharedOk, setSharedOk] = useState(false);
  const cr = Math.max(C.cardRadius||12, 14);
  const br = C.btnRadius || 10;

  // ── Edge case analysis on legs ──
  const legs = pick?.legs || [];
  const liveLeg   = legs.find(l => l.status === "live"  || l.statusCode === "live"  || l.live === true);
  const finLeg    = legs.find(l => l.status === "ft"    || l.finished === true      || l.statusCode === "ft");
  const soonLeg   = legs.find(l => {
    if (!l.kickoff && !l.time) return false;
    const ko = new Date(l.kickoff || l.time);
    return (ko - Date.now()) < 30 * 60 * 1000 && (ko - Date.now()) > 0;
  });
  const hasLiveLegs  = !!liveLeg;
  const hasFinLegs   = !!finLeg;
  const hasSoonLegs  = !!soonLeg;
  const allBlocked   = hasLiveLegs || hasFinLegs;

  const book = async () => {
    if (allBlocked) return;
    setBooking(true); setErr(null);
    try {
      const mapped = legs.map(l => {
        const parts = (l.game || "").split(" vs ");
        return {
          home:   (l.home || parts[0] || "").trim(),
          away:   (l.away || parts[1] || "").trim(),
          pick:   l.pick,
          market: l.market || "",
        };
      }).filter(l => l.home && l.away && l.pick);

      if (!mapped.length) throw new Error("No valid legs to book — check leg data.");

      const res = await fetch(`${SERVER}/api/book-${bookie}`, {
        method:"POST", headers:{"Content-Type":"application/json"},
        body: JSON.stringify({ legs: mapped }),
      });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error || "Booking failed");
      const enriched = { ...d, bookieId: bookie };
      setDone(enriched);
      persistBooking(enriched);      // persist so tab-switch doesn't lose it
      if (onBooked) onBooked(enriched);
    } catch(e) {
      // N1/N20-FIX: translate raw error strings into user-friendly messages
      const msg = e.message || "";
      setErr(
        msg.includes("Failed to fetch") || msg.includes("ERR_NAME_NOT_RESOLVED") || msg.includes("ERR_") || msg.includes("NetworkError")
          ? "Can't reach bookmaker — check your connection and try again."
          : msg.includes("429") || msg.includes("already in progress")
          ? "A booking is already in progress. Please wait a moment."
          : msg || "Booking failed — please try again."
      );
    }
    finally { setBooking(false); }
  };

  // N1-FIX: execCommand-only clipboard — navigator.clipboard.writeText triggers Android
  // permission dialog at call-time (before promise resolves). execCommand is synchronous,
  // requires no permission, and works in all Android WebViews.
  const _copyText = (text, onOk) => {
    try {
      const el = document.createElement("textarea");
      el.value = text;
      el.style.cssText = "position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;pointer-events:none;";
      document.body.appendChild(el);
      el.focus(); el.select();
      document.execCommand("copy");
      document.body.removeChild(el);
      onOk?.();
    } catch {}
  };

  const copyCode = () => {
    if (!done?.code) return;
    _copyText(done.code, () => { setCopied(true); setTimeout(() => setCopied(false), 2000); });
  };

  const copyLink = () => {
    if (!done?.code) return;
    const bm = BOOKIE_META[done.bookieId];
    const link = bm?.link ? bm.link(done.code) : done.code;
    _copyText(link, () => { setSharedOk(true); setTimeout(() => setSharedOk(false), 2000); });
  };

  const shareTicket = async () => {
    if (!done?.code) return;
    const bm = BOOKIE_META[done.bookieId];
    const link = bm?.link ? bm.link(done.code) : done.code;
    if (navigator.share) {
      try {
        await navigator.share({ title:"My Rollover Slip", text:`${bm?.label || "Bookmaker"} code: ${done.code}`, url: link });
        setSharedOk(true); setTimeout(() => setSharedOk(false), 2000);
      } catch {}
    } else {
      copyLink();
    }
  };

  const resetBooking = () => {
    setDone(null); setErr(null);
    clearPersistedBooking();
  };

  const meta = BOOKIE_META[bookie] || BOOKIE_META.sportybet;

  return (
    <div onClick={e => e.target===e.currentTarget && onClose()}
         style={{ position:"fixed", inset:0, background:"rgba(0,0,0,.82)", zIndex:500,
                  display:"flex", alignItems:"flex-end", justifyContent:"center",
                  backdropFilter:"blur(10px)" }}>
      <div className="rvl-fade"
           style={{ background:C.modalBg||C.bg, borderRadius:`${cr*2}px ${cr*2}px 0 0`,
                    border:`1px solid ${C.border}`, padding:"20px 18px 36px",
                    width:"100%", maxWidth:480, color:C.text,
                    maxHeight:"90vh", overflowY:"auto" }}>

        <div style={{ width:36, height:4, borderRadius:2, background:C.text,
                      opacity:.18, margin:"0 auto 18px" }} />
        <div style={{ display:"flex", justifyContent:"space-between",
                      alignItems:"center", marginBottom:16 }}>
          <div>
            <Lbl color={C.gold}>Rollover Execution</Lbl>
            <div style={{ fontSize:14, fontWeight:900, color:C.text, marginTop:4 }}>
              {done ? "Booking Code Ready" : "Confirm & Book Slip"}
            </div>
          </div>
          <button onClick={onClose}
                  style={{ background:"none", border:"none", color:C.text,
                           fontSize:20, cursor:"pointer", opacity:.45 }}>✕</button>
        </div>

        {/* ── EDGE CASE: live or FT legs ── */}
        {allBlocked && !done && (
          <div style={{ display:"flex", flexDirection:"column", gap:12 }}>
            <div style={{ background:`${C.red}12`, border:`1px solid ${C.red}40`,
                          borderRadius:cr, padding:"18px 16px" }}>
              <div style={{ fontSize:12, fontWeight:900, color:C.red, marginBottom:10 }}>
                {hasLiveLegs ? "Match In Progress" : "Match Already Finished"}
              </div>
              {legs.map((l,i) => {
                const isLive = l.status==="live" || l.live===true;
                const isFt   = l.status==="ft"   || l.finished===true;
                const game   = l.game || `Leg ${i+1}`;
                if (!isLive && !isFt) return null;
                return (
                  <div key={i} style={{ fontSize:9, color:C.muted, marginBottom:6,
                                        padding:"6px 10px", background:`${C.red}08`,
                                        borderRadius:6, borderLeft:`3px solid ${C.red}` }}>
                    <span style={{ color:C.red, fontWeight:800 }}>{isLive ? "🔴 LIVE" : "⚫ FT"}</span>
                    {" "}{game} — {l.pick}
                    <div style={{ marginTop:3, color:C.muted }}>
                      {isLive
                        ? "This match has kicked off and can no longer be added to a slip."
                        : "This match has finished and cannot be booked."}
                    </div>
                  </div>
                );
              }).filter(Boolean)}
              <div style={{ fontSize:9, color:C.gold, fontWeight:700, marginTop:10 }}>
                Come back tomorrow — the engine builds a fresh qualifying slip each day.
              </div>
            </div>
            <button onClick={onClose} className="rvl-btn"
                    style={{ width:"100%", padding:"13px 0", fontSize:11,
                             background:C.surface, color:C.text,
                             border:`1px solid ${C.border}` }}>
              Close
            </button>
          </div>
        )}

        {/* ── EDGE CASE: kickoff within 30 min warning (non-blocking) ── */}
        {!allBlocked && hasSoonLegs && !done && (
          <div style={{ background:`${C.amber}0e`, border:`1px solid ${C.amber}35`,
                        borderRadius:br, padding:"10px 12px", marginBottom:12,
                        fontSize:9, color:C.amber, lineHeight:1.5 }}>
            <span style={{ fontWeight:800 }}>⚠ Kickoff soon —</span> one or more games kick off within 30 minutes.
            Book now or you may miss the window.
          </div>
        )}

        {/* ── NORMAL BOOKING FLOW ── */}
        {!allBlocked && !done && (
          <div style={{ display:"flex", flexDirection:"column", gap:12 }}>

            {/* Leg list with status indicators */}
            <div style={{ background:C.surface, borderRadius:cr,
                          padding:"4px 14px", border:`1px solid ${C.border}` }}>
              {legs.map((l,i) => {
                const isLive = l.status==="live" || l.live===true;
                const isFt   = l.status==="ft"   || l.finished===true;
                const isSoon = !isLive && !isFt && (() => {
                  const ko = new Date(l.kickoff || l.time || 0);
                  return (ko - Date.now()) < 30*60*1000 && (ko - Date.now()) > 0;
                })();
                return (
                  <div key={i} style={{ borderBottom: i < legs.length-1 ? `1px solid ${C.border}` : "none" }}>
                    <LegRow leg={l} index={i} C={C} />
                    {(isLive || isFt || isSoon) && (
                      <div style={{ fontSize:8, marginTop:-6, marginBottom:6, paddingLeft:2,
                                    color: isLive||isFt ? C.red : C.amber, fontWeight:700 }}>
                        {isLive ? "🔴 LIVE — cannot book" : isFt ? "⚫ FT — cannot book" : "⚠ Kicks off soon"}
                      </div>
                    )}
                  </div>
                );
              })}
              <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center",
                            padding:"10px 2px 8px", borderTop:`1px solid ${C.border}` }}>
                <span style={{ fontSize:9, fontWeight:800, color:C.green }}>
                  {pick.combinedEmpiricalRate}% combined · {legs.length} leg{legs.length!==1?"s":""}
                </span>
                <span style={{ fontSize:16, fontWeight:900, color:pick.belowTarget?C.amber||C.gold:C.gold }}>
                  ×{pick.totalOdds}
                  {pick.belowTarget && <span style={{ fontSize:8, color:C.amber||C.gold, marginLeft:4 }}>⚠ below target</span>}
                </span>
              </div>
            </div>

            {/* N2-FIX: Bookmaker selector — LL shown as disabled with downtime subtext */}
            <div style={{ display:"flex", flexDirection:"column", gap:5 }}>
              {Object.entries(BOOKIE_META).map(([id, m]) => {
                const isDisabled = !!m.disabled;
                const isSelected = bookie === id;
                return (
                  <button key={id}
                    onClick={() => { if (!isDisabled) { setBookie(id); setErr(null); } }}
                    style={{ width:"100%", padding:"9px 12px", fontSize:10, fontWeight:800,
                             background: isSelected ? C.accentDim : isDisabled ? C.faint : C.surface,
                             color: isSelected ? C.accent : isDisabled ? C.muted : C.text,
                             border:`1px solid ${isSelected ? C.accentBorder : C.border}`,
                             borderRadius:br, cursor: isDisabled ? "default" : "pointer",
                             fontFamily:C.font, transition:"all .15s", opacity: isDisabled ? 0.55 : 1,
                             display:"flex", alignItems:"center", justifyContent:"space-between" }}>
                    <span>{m.label}</span>
                    {isDisabled && m.disabledText && (
                      <span style={{ fontSize:8, color:C.amber, fontWeight:700, fontStyle:"italic" }}>
                        {m.disabledText}
                      </span>
                    )}
                    {isSelected && !isDisabled && (
                      <span style={{ fontSize:10, color:C.accent }}>✓</span>
                    )}
                  </button>
                );
              })}
            </div>

            {/* Booking spinner or button */}
            {booking ? (
              <div style={{ display:"flex", alignItems:"center", gap:12, padding:14,
                            background:C.surface, borderRadius:cr, border:`1px solid ${C.border}` }}>
                <div className="rvl-spin"
                     style={{ width:20, height:20, borderRadius:"50%", flexShrink:0,
                              border:`2px solid ${C.border}`, borderTopColor:C.accent }} />
                <div>
                  <div style={{ fontSize:11, fontWeight:800, color:C.text }}>Booking your ticket…</div>
                  <div style={{ fontSize:9, color:C.muted, marginTop:2 }}>Takes 10–20 seconds. Keep this screen open.</div>
                </div>
              </div>
            ) : (
              <button onClick={book} className="rvl-btn"
                      style={{ width:"100%", padding:"16px 0", fontSize:12,
                               background:C.accent, color:C.accentText,
                               boxShadow:`0 4px 18px ${C.accent}40` }}>
                Generate Booking Code
              </button>
            )}

            {err && (
              <div style={{ color:C.red, fontSize:9, background:`${C.red}12`,
                            padding:10, borderRadius:10, border:`1px solid ${C.red}30`,
                            lineHeight:1.5 }}>
                {err}
                <button onClick={book}
                        style={{ display:"block", marginTop:6, fontSize:9, padding:"3px 10px",
                                 background:"transparent", border:`1px solid ${C.red}`,
                                 color:C.red, borderRadius:5, cursor:"pointer", fontFamily:C.font }}>
                  Try again
                </button>
              </div>
            )}
          </div>
        )}

        {/* ── SUCCESS ── Persists across tab-switches, cleared only by "Book another" ── */}
        {done && (
          <div style={{ display:"flex", flexDirection:"column", gap:10 }}>

            {/* Status header */}
            {(() => {
              const failCount = Array.isArray(done.failed) ? done.failed.length : 0;
              const isPartial = failCount > 0;
              const booked    = isPartial ? (done.resolved ?? (legs.length - failCount)) : (done.total ?? legs.length);
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
                  <div>
                    <div style={{ fontSize:12, fontWeight:800, color: isPartial ? C.amber : C.green }}>
                      {isPartial ? `${booked} of ${done.total ?? legs.length} legs booked` : `All ${done.total ?? legs.length} legs booked`}
                    </div>
                    <div style={{ fontSize:9, color:C.muted, marginTop:1 }}>
                      {BOOKIE_META[done.bookieId]?.label || "Bookmaker"}
                      {isPartial && ` · ${failCount} leg${failCount>1?"s":""} not matched`}
                    </div>
                  </div>
                </div>
              );
            })()}

            {/* Code box — compact with inline copy */}
            <div style={{ display:"flex", alignItems:"center", gap:8,
                          background:C.surface, border:`1px solid ${C.green}35`,
                          borderRadius:br, padding:"10px 14px" }}>
              <span style={{ flex:1, fontFamily:'"JetBrains Mono","Courier New",monospace',
                             fontSize:22, fontWeight:800, color:C.green,
                             letterSpacing:".18em", userSelect:"all" }}>
                {done.code}
              </span>
              <button onClick={copyCode}
                style={{ flexShrink:0, padding:"6px 12px", fontSize:9, fontWeight:800,
                         background: copied ? C.green : `${C.green}15`,
                         color: copied ? "#fff" : C.green,
                         border:`1px solid ${C.green}45`, borderRadius:8,
                         cursor:"pointer", fontFamily:C.font, transition:"all .15s",
                         display:"flex", alignItems:"center", gap:5 }}>
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
                </svg>
                {copied ? "Copied!" : "Copy"}
              </button>
            </div>

            {/* Per-leg failures */}
            {Array.isArray(done.failed) && done.failed.length > 0 && (
              <div style={{ background:`${C.amber}08`, border:`1px solid ${C.amber}25`,
                            borderRadius:br, padding:"10px 12px" }}>
                <div style={{ fontSize:9, fontWeight:800, color:C.amber, marginBottom:8,
                              letterSpacing:".06em", textTransform:"uppercase" }}>
                  {done.failed.length} leg{done.failed.length>1?"s":""} not booked
                </div>
                {done.failed.map((fail, i) => {
                  const isObj  = fail && typeof fail === "object";
                  const label  = isObj ? (fail.label || fail.game || `Leg ${i+1}`) : String(fail);
                  const reason = isObj && fail.failReason === "not_listed"
                    ? "Fixture not found on this bookmaker — it may not be listed yet."
                    : "Game or market not matched. Cross-check in your bookmaker app — it may not be listed.";
                  return (
                    <div key={i} style={{ marginBottom: i<done.failed.length-1?8:0,
                                          paddingBottom: i<done.failed.length-1?8:0,
                                          borderBottom: i<done.failed.length-1?`1px solid ${C.amber}20`:"none" }}>
                      <div style={{ fontSize:10, color:C.text, fontWeight:700 }}>{label}</div>
                      <div style={{ fontSize:9, color:C.muted, lineHeight:1.5, marginTop:2 }}>{reason}</div>
                    </div>
                  );
                })}
              </div>
            )}

            {/* Three action buttons */}
            <div style={{ display:"flex", gap:6 }}>
              <button onClick={copyCode}
                style={{ flex:1, padding:"10px 0", fontSize:10, fontWeight:700,
                         background: copied ? C.green : "transparent",
                         color: copied ? "#fff" : C.green,
                         border:`1px solid ${C.green}45`, borderRadius:br,
                         cursor:"pointer", fontFamily:C.font,
                         display:"flex", alignItems:"center", justifyContent:"center", gap:5 }}>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
                </svg>
                {copied ? "Copied!" : "Copy Code"}
              </button>
              <button onClick={() => { const bm = BOOKIE_META[done.bookieId]; if (bm?.link) window.open(bm.link(done.code), "_blank"); }}
                style={{ flex:1, padding:"10px 0", fontSize:10, fontWeight:700,
                         background:C.accent, color:C.accentText,
                         border:"none", borderRadius:br,
                         cursor:"pointer", fontFamily:C.font,
                         display:"flex", alignItems:"center", justifyContent:"center", gap:5 }}>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/>
                </svg>
                Open App
              </button>
              <button onClick={copyLink}
                style={{ flex:1, padding:"10px 0", fontSize:10, fontWeight:700,
                         background: sharedOk ? `${C.blue||C.edge}18` : "transparent",
                         color: sharedOk ? (C.blue||C.edge) : C.muted,
                         border:`1px solid ${C.border}`, borderRadius:br,
                         cursor:"pointer", fontFamily:C.font,
                         display:"flex", alignItems:"center", justifyContent:"center", gap:5 }}>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/>
                  <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>
                </svg>
                {sharedOk ? "Copied!" : "Copy Link"}
              </button>
            </div>

            <button onClick={resetBooking}
              style={{ background:"transparent", border:"none", color:C.muted, fontSize:9,
                       cursor:"pointer", fontFamily:C.font, textDecoration:"underline",
                       padding:0, textAlign:"center" }}>
              Book another bookmaker
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

// ── DELETE + RESTART MODAL ────────────────────────────────────────────────────
// After delete, shows capital input before restarting
function DeleteModal({ C, SERVER, userId, onClose, onDeleted }) {
  const [busy, setBusy] = useState(false);
  const [err,  setErr]  = useState(null);
  const cr = Math.max(C.cardRadius||12, 14);

  const doArchive = async () => {
    setBusy(true); setErr(null);
    try {
      // Archive only — no capital input here. WelcomeFlow handles that.
      const res = await fetch(`${SERVER}/api/rollover/user/${userId}/archive`, {
        method:"POST", headers:{"Content-Type":"application/json", "X-User-ID": userId},
      });
      if (!res.ok) { const d = await res.json().catch(()=>{}); throw new Error(d?.error||"Archive failed"); }
      if (onDeleted) onDeleted();
    } catch(e) { setErr(e.message); }
    finally    { setBusy(false); }
  };

  return (
    <div onClick={e => e.target===e.currentTarget && onClose()}
         style={{ position:"fixed", inset:0, background:"rgba(0,0,0,.82)", zIndex:500,
                  display:"flex", alignItems:"flex-end", justifyContent:"center",
                  backdropFilter:"blur(10px)" }}>
      <div className="rvl-fade"
           style={{ background:C.modalBg||C.bg, borderRadius:`${cr*2}px ${cr*2}px 0 0`,
                    border:`1px solid ${C.border}`, padding:"20px 18px 36px",
                    width:"100%", maxWidth:480, color:C.text }}>
        <div style={{ width:36, height:4, borderRadius:2, background:C.text,
                      opacity:.18, margin:"0 auto 18px" }} />
        <div style={{ textAlign:"center", marginBottom:20 }}>
          <div style={{ fontSize:32, marginBottom:10, display:"flex", justifyContent:"center" }}>
            <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke={C.red} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
          </div>
          <div style={{ fontSize:14, fontWeight:900, color:C.red, marginBottom:8 }}>
            Delete Current Chain?
          </div>
          <div style={{ fontSize:10, color:C.muted, lineHeight:1.75 }}>
            This archives your chain history and starts fresh.<br/>
            You'll set new starting capital on the next screen.<br/>
            <strong style={{ color:C.text }}>Locked profit history is always preserved.</strong>
          </div>
        </div>
        {err && (
          <div style={{ color:C.red, fontSize:9, textAlign:"center",
                        background:`${C.red}12`, padding:10, borderRadius:10,
                        border:`1px solid ${C.red}30`, marginBottom:12 }}>
            ✕ {err}
          </div>
        )}
        <div style={{ display:"flex", gap:10 }}>
          <button onClick={onClose} className="rvl-btn"
                  style={{ flex:1, padding:"14px 0", fontSize:11,
                           background:C.surface, color:C.text, border:`1px solid ${C.border}` }}>
            Cancel
          </button>
          <button onClick={doArchive} disabled={busy} className="rvl-btn"
                  style={{ flex:1, padding:"14px 0", fontSize:11,
                           background:`${C.red}18`, color:C.red, border:`1px solid ${C.red}50` }}>
            {busy ? "Archiving…" : "Yes, Delete Chain"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── WELCOME / ONBOARDING ──────────────────────────────────────────────────────
function WelcomeFlow({ C, SERVER, userId, onComplete }) {
  const [stage,   setStage]   = useState("intro");
  const [capital, setCapital] = useState("");
  const [busy,    setBusy]    = useState(false);
  const [err,     setErr]     = useState(null);

  const start = async () => {
    const amt = parseFloat(capital);
    if (!amt || amt <= 0) { setErr("Enter a valid amount to continue."); return; }
    setBusy(true); setErr(null);
    try {
      // Init chain on server with starting capital
      const res = await fetch(`${SERVER}/api/rollover/user/${userId}/init`, {
        method:"POST", headers:{"Content-Type":"application/json", "X-User-ID": userId},
        body: JSON.stringify({ startingCapital: amt }),
      });
      if (!res.ok) { const d = await res.json().catch(()=>{}); throw new Error(d?.error||"Could not start chain"); }
      try {
        localStorage.setItem(RVL_ONBOARD_KEY, "1");
        localStorage.setItem(RVL_CAPITAL_KEY, String(amt));
      } catch {}
      setStage("starting");
      setTimeout(() => onComplete(), 1200);
    } catch(e) { setErr(e.message); }
    finally    { setBusy(false); }
  };

  const cr = Math.max(C.cardRadius||12, 14);

  // Inline SVG icons — no emoji, consistent with the rest of the product
  const Ico = {
    chain:   <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{ color:C.green }}><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>,
    target:  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/></svg>,
    trend:   <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="23 6 13.5 15.5 8.5 10.5 1 18"/><polyline points="17 6 23 6 23 12"/></svg>,
    lock:    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>,
    phone:   <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="5" y="2" width="14" height="20" rx="2" ry="2"/><line x1="12" y1="18" x2="12.01" y2="18"/></svg>,
    rocket:  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09z"/><path d="m12 15-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z"/><path d="M9 12H4s.55-3.03 2-4c1.62-1.08 5 0 5 0"/><path d="M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5"/></svg>,
  };

  if (stage === "starting") {
    return (
      <div style={{ display:"flex", flexDirection:"column", alignItems:"center",
                    justifyContent:"center", minHeight:300, gap:16 }}>
        <div className="rvl-spin"
             style={{ width:40, height:40, borderRadius:"50%",
                      border:`3px solid ${C.border}`, borderTopColor:C.green }} />
        <div style={{ fontSize:12, fontWeight:800, color:C.green }}>Starting your chain…</div>
      </div>
    );
  }

  return (
    <div className="rvl-fade"
         style={{ display:"flex", flexDirection:"column", gap:0, color:C.text }}>

      {/* Hero */}
      <div style={{ textAlign:"center", padding:"32px 20px 24px",
                    background:`linear-gradient(135deg, ${C.surface} 0%, ${C.bg} 100%)`,
                    borderBottom:`1px solid ${C.border}` }}>
        <div style={{ display:"flex", justifyContent:"center", marginBottom:12 }}>{Ico.chain}</div>
        <div style={{ fontSize:20, fontWeight:900, color:C.text, marginBottom:8,
                      letterSpacing:"-.02em" }}>
          Welcome to the<br/>
          <span style={{ color:C.green }}>Rollover System</span>
        </div>
        <div style={{ fontSize:10, color:C.muted, lineHeight:1.75, maxWidth:320, margin:"0 auto" }}>
          A structured 10-step compounding chain. The engine picks one optimised slip per day.
          Win each step and your pot grows. Profit gates lock secured gains along the way.
        </div>
      </div>

      {/* How it works — 3 cards */}
      <div style={{ padding:"20px 16px", display:"flex", flexDirection:"column", gap:10 }}>
        {[
          { ico: Ico.target, title:"Engine-optimised daily slip",
            body:"Every morning the engine scans all fixtures and builds the highest-confidence parlay that clears ≥2.0× odds. One slip, one decision per day." },
          { ico: Ico.trend, title:"10 steps, compounding up",
            body:"Each step doubles the previous stake. Win all 10 and you've grown your pot by ×1024. Profit gates at steps 3, 5, 7, and 9 lock 30% of your pot permanently." },
          { ico: Ico.lock, title:"Protected at every gate",
            body:"Even if the chain fails after step 5, everything locked at steps 3 and 5 is yours to keep. The system protects your gains as you climb." },
        ].map((it,i) => (
          <div key={i} style={{ display:"flex", gap:12, padding:"12px 14px",
                                background:C.surface, borderRadius:cr,
                                border:`1px solid ${C.border}` }}>
            <span style={{ flexShrink:0, lineHeight:1.3, color:C.green }}>{it.ico}</span>
            <div>
              <div style={{ fontSize:11, fontWeight:800, color:C.text, marginBottom:4 }}>{it.title}</div>
              <div style={{ fontSize:9, color:C.muted, lineHeight:1.65 }}>{it.body}</div>
            </div>
          </div>
        ))}

        {/* Device warning */}
        <div style={{ display:"flex", gap:10, padding:"10px 14px",
                      background:`${C.amber||C.gold}0C`, borderRadius:cr,
                      border:`1px solid ${C.amber||C.gold}30` }}>
          <span style={{ flexShrink:0, lineHeight:1.3, color:C.amber||C.gold }}>{Ico.phone}</span>
          <div style={{ fontSize:8, color:C.muted, lineHeight:1.65 }}>
            <strong style={{ color:C.text }}>Device-tied chain.</strong> Your rollover progress is saved to this device.
            Don't clear your browser data or you'll lose your chain state.
          </div>
        </div>

        {/* Capital input */}
        {stage === "intro" && (
          <div style={{ marginTop:8 }}>
            <div style={{ fontSize:10, color:C.text, fontWeight:800, marginBottom:6,
                          textAlign:"center", letterSpacing:".04em" }}>
              ENTER YOUR STARTING CAPITAL
            </div>
            <div style={{ fontSize:9, color:C.muted, textAlign:"center", marginBottom:14 }}>
              This is the amount you'll stake on Step 1. The engine compounds it from here.
            </div>
            <div style={{ position:"relative", marginBottom:12 }}>
              <span style={{ position:"absolute", left:16, top:"50%", transform:"translateY(-50%)",
                             fontSize:18, fontWeight:900, color:C.gold }}>$</span>
              <input
                type="number" min="1" step="0.50" value={capital}
                onChange={e => { setCapital(e.target.value); setErr(null); }}
                onKeyDown={e => e.key === "Enter" && capital && start()}
                placeholder="e.g. 5.00"
                autoFocus
                style={{ width:"100%", background:C.surface, border:`2px solid ${C.gold}60`,
                         borderRadius:14, padding:"16px 16px 16px 40px",
                         fontSize:24, fontWeight:900, color:C.text, outline:"none",
                         fontFamily:C.font, textAlign:"center", boxSizing:"border-box" }}
              />
            </div>
            {err && (
              <div style={{ color:C.red, fontSize:9, textAlign:"center", marginBottom:10 }}>{err}</div>
            )}
            <button onClick={start} disabled={busy || !capital || parseFloat(capital) <= 0}
                    className="rvl-btn"
                    style={{ width:"100%", padding:"16px 0", fontSize:13,
                             display:"flex", alignItems:"center", justifyContent:"center", gap:8,
                             background: (!capital || parseFloat(capital) <= 0) ? C.faint||C.border : C.green,
                             color: (!capital || parseFloat(capital) <= 0) ? C.muted : C.accentText,
                             boxShadow: (!capital || parseFloat(capital) <= 0) ? "none" : `0 4px 20px ${C.green}40` }}>
              <span style={{ color:"inherit" }}>{Ico.rocket}</span>
              {busy ? "Starting…" : "Start My Rollover Chain"}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

// ── HERO CARD ─────────────────────────────────────────────────────────────────
// C3-FIX: Single source of truth for starting capital.
// Old chains used startingPot, new chains use startingCapital, HeroCard
// used riskPot as fallback. All three normalised here so old and new chains
// always display correctly without scattered fallback chains.
function getStartingCapital(chain) {
  return chain?.startingCapital ?? chain?.startingPot ?? chain?.riskPot ?? 0;
}

function HeroCard({ chain, C }) {
  const completedSteps = chain?.step || 0;
  const nextStep  = completedSteps + 1;
  const budget    = chain?.riskPot ?? chain?.startingPot ?? 0;
  const startCap  = getStartingCapital(chain);
  const locked    = chain?.lockedProfit ?? 0;
  const pct       = (completedSteps / ROLLOVER_MAX) * 100;
  const targetRow = GATE_TABLE[Math.min(Math.max(0, nextStep - 1), 9)];

  return (
    <div className="rvl-card"
         style={{ background:C.surface, border:`1px solid ${C.border}`,
                  padding:"20px 18px 16px", position:"relative", overflow:"hidden" }}>
      <div style={{ position:"absolute", top:-50, right:-50, width:130, height:130,
                    borderRadius:"50%", background:`${C.green}06`, pointerEvents:"none" }} />
      <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:12, marginBottom:16 }}>
        <div>
          <Lbl style={{ marginBottom:4 }}>Engine Pot</Lbl>
          <Val size={26} color={C.text}>${budget.toLocaleString()}</Val>
          <div style={{ fontSize:8, color:C.muted, marginTop:3 }}>Current stake at risk</div>
        </div>
        <div style={{ textAlign:"right" }}>
          <Lbl style={{ marginBottom:4 }}>Locked Profit</Lbl>
          <Val size={21} color={locked>0?C.green:C.text}>
            {locked>0?`+$${locked.toLocaleString()}`:"$0"}
          </Val>
          <div style={{ fontSize:8, color:C.muted, marginTop:3 }}>
            {locked>0?"Secured at gates":"Locks at step 3"}
          </div>
        </div>
      </div>
      <div style={{ display:"flex", justifyContent:"space-between",
                    alignItems:"center", marginBottom:8 }}>
        <div style={{ fontSize:11, fontWeight:800,
                      color:completedSteps===0?C.muted:completedSteps===ROLLOVER_MAX?C.green:C.gold }}>
          {completedSteps === 0
            ? "Ready to start rollover"
            : completedSteps === ROLLOVER_MAX
            ? "🏁 Chain complete"
            : `Step ${nextStep} of ${ROLLOVER_MAX}`}
        </div>
        {completedSteps > 0 && completedSteps < ROLLOVER_MAX && (
          <div style={{ fontSize:9, fontWeight:700, color:C.muted }}>{ROLLOVER_MAX - completedSteps} left</div>
        )}
      </div>
      <div className="rvl-bar" style={{ background:`${C.border}80` }}>
        <div className="rvl-fill"
             style={{ width:`${pct}%`, background:pct===100?C.green:`linear-gradient(90deg,${C.green},${C.gold})` }} />
      </div>
      <div style={{ display:"flex", gap:6, marginTop:10, flexWrap:"wrap" }}>
        {GATE_STEPS.has(nextStep + 1) && (
          <span style={{ fontSize:8, fontWeight:900, padding:"3px 8px", borderRadius:6,
                         background:`${C.gold}18`, color:C.gold, border:`1px solid ${C.gold}40` }}>
            <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor" style={{ color:C.gold }}><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg> Gate next
          </span>
        )}
        {GATE_STEPS.has(nextStep) && locked > 0 && (
          <span style={{ fontSize:8, fontWeight:900, padding:"3px 8px", borderRadius:6,
                         background:`${C.green}18`, color:C.green, border:`1px solid ${C.green}40` }}>
            ✓ Profit locked at gate
          </span>
        )}
        {targetRow && (
          <span style={{ fontSize:8, fontWeight:800, padding:"3px 8px", borderRadius:6,
                         background:C.border, color:C.muted, border:`1px solid ${C.border}` }}>
            {targetRow.target} target
          </span>
        )}
      </div>
    </div>
  );
}

// ── SLIP CARD ─────────────────────────────────────────────────────────────────
function SlipCard({ pick, date, C, SERVER, onRefresh, fixtures = [], onFullModel = null }) {
  // B3-FIX: Build cache key from date + sorted fixtureIds so the cache is specific
  // to this exact slip. A different pool/date always gets a fresh analysis.
  const jarvisCacheKey = pick?.legs?.length
    ? `grm_rvl_jarvis_${date}_${(pick.legs).map(l=>l.fixtureId).sort().join("_")}`
    : null;

  const [modal, setModal]             = useState(() => !!loadPersistedBooking()); // auto-open if code persisted
  const [jarvisText, setJarvisText]   = useState(() => {
    if (!jarvisCacheKey) return null;
    try { return localStorage.getItem(jarvisCacheKey) || null; } catch { return null; }
  });
  const [jarvisLoading, setJarvisLoading] = useState(false);
  const [jarvisOpen, setJarvisOpen]   = useState(true); // expanded by default
  const today    = todayStr();
  const isFuture = date > today;
  const isPast   = date < today;
  const blocked  = pick ? hasBlockedLegs(pick.legs || []) : false;

  // Auto-fetch Jarvis analysis once when the slip is ready and it's today's slip
  useEffect(() => {
    if (!pick?.legs?.length || isPast || isFuture || jarvisText || jarvisLoading) return;
    const go = async () => {
      setJarvisLoading(true);
      try {
        const res = await fetch(`${SERVER}/api/jarvis-rollover-analyse`, {
          method:"POST", headers:{"Content-Type":"application/json"},
          body: JSON.stringify({
            legs: pick.legs,
            totalOdds: pick.totalOdds,
            combinedEmpiricalRate: pick.combinedEmpiricalRate,
          }),
        });
        const d = await res.json();
        const text = d.analysis || d.error || "No analysis returned.";
        setJarvisText(text);
        // B3-FIX: Write to cache so tab switches don't re-fetch
        if (jarvisCacheKey && d.analysis) {
          try { localStorage.setItem(jarvisCacheKey, text); } catch {}
        }
      } catch(e) {
        const m = (e.message || "").toLowerCase();
        setJarvisText(m.includes("429") || m.includes("rate")
          ? "Jarvis hit a rate limit — tap ↺ to retry."
          : "Jarvis couldn't connect. Tap ↺ to retry.");
      }
      setJarvisLoading(false);
    };
    go();
  }, [pick]);

  if (isFuture) {
    return (
      <div className="rvl-card"
           style={{ border:`2px dashed ${C.border}`, padding:"44px 20px", textAlign:"center" }}>
        <div style={{ fontSize:28, marginBottom:10 }}>📅</div>
        <div style={{ fontSize:12, fontWeight:800, color:C.text, marginBottom:6 }}>Future Date</div>
        <div style={{ fontSize:10, color:C.muted, lineHeight:1.7 }}>
          No rollover slip is generated in advance.<br/>
          The engine builds today's slip from live fixture data each morning.<br/><br/>
          <span style={{ color:C.gold, fontWeight:700 }}>
            Switch back to {new Date(today + "T00:00:00").toLocaleDateString("en-GB", { weekday:"short", day:"numeric", month:"short" })} to see your active slip.
          </span>
        </div>
      </div>
    );
  }

  if (!pick) {
    return (
      <div className="rvl-card"
           style={{ border:`2px dashed ${C.border}`, padding:"44px 20px", textAlign:"center" }}>
        <div style={{ marginBottom:10, display:"flex", justifyContent:"center" }}>
          <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke={C.muted} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
        </div>
        <div style={{ fontSize:12, fontWeight:800, color:C.text, marginBottom:6 }}>
          {isPast ? "No Slip That Day" : "No Qualifying Slip Yet"}
        </div>
        <div style={{ fontSize:10, color:C.muted, lineHeight:1.7 }}>
          {isPast
            ? <>The engine didn't generate a qualifying slip on {new Date(date + "T00:00:00").toLocaleDateString("en-GB", { weekday:"short", day:"numeric", month:"short" })}.<br/>Pool may have been too thin or the date wasn't active.</>
            : <>Engine couldn't find a qualifying ≥2.0× sequence today.<br/>Check back when new fixtures load.</>
          }
        </div>
      </div>
    );
  }

  const cr        = Math.max(C.cardRadius||12, 12);
  const dateLabel = isPast
    ? new Date(date + "T00:00:00").toLocaleDateString("en-GB", { weekday:"short", day:"numeric", month:"short" })
    : "Today's";

  return (
    <>
      <div className="rvl-card"
           style={{ background:C.surface, border:`1px solid ${C.border}`, overflow:"hidden" }}>
        <div style={{ display:"flex", justifyContent:"space-between",
                      alignItems:"center", padding:"16px 16px 0" }}>
          <div>
            <Lbl color={isPast ? C.muted : C.green}>
              {isPast ? "Past Slip — Read Only" : "Engine Optimised Slip"}
            </Lbl>
            <div style={{ fontSize:12, fontWeight:900, color:C.text, marginTop:4 }}>
              {dateLabel} Rollover Selection
            </div>
          </div>
          <div style={{ textAlign:"right" }}>
            <Lbl>Target Odds</Lbl>
            <Val size={20} color={pick.belowTarget ? (C.amber||C.gold) : C.gold} style={{ marginTop:3 }}>
              ×{pick.totalOdds}
            </Val>
            {pick.belowTarget && (
              <div style={{ fontSize:7, color:C.amber||C.gold, fontWeight:800, marginTop:2 }}>
                ⚠ BELOW 2.0 TARGET
              </div>
            )}
          </div>
        </div>

        {/* Below-target warning banner */}
        {pick.belowTarget && (
          <div style={{ margin:"10px 16px 0",
                        background:`${C.amber||C.gold}12`, border:`1px solid ${C.amber||C.gold}35`,
                        borderRadius:8, padding:"8px 12px" }}>
            <div style={{ fontSize:9, color:C.amber||C.gold, fontWeight:800, marginBottom:3 }}>
              ⚠ Pool too thin today — slip shown below 2.0× target
            </div>
            <div style={{ fontSize:8, color:C.muted, lineHeight:1.6 }}>
              The engine couldn't find enough qualifying picks to clear 2.0×. You can still book this slip,
              but understand the target odds are lower than usual. Tomorrow's pool may be stronger.
            </div>
          </div>
        )}

        <div style={{ padding:"0 16px" }}>
          {pick.legs.map((l,i) => {
            const fixture = fixtures.find(f => f.id === l.fixtureId) || null;
            return (
              <LegRow key={i} leg={l} index={i} C={C}
                onFullModel={fixture && onFullModel ? () => onFullModel(fixture) : null} />
            );
          })}
        </div>

        {/* ── JARVIS ANALYSIS ── auto-loads, expandable ── */}
        {!isPast && (
          <div style={{ margin:"8px 16px 0", borderRadius:10, overflow:"hidden",
                        border:`1px solid ${C.gold}30`, background:`${C.gold}08` }}>
            <button onClick={() => setJarvisOpen(v => !v)}
                    style={{ width:"100%", display:"flex", justifyContent:"space-between",
                             alignItems:"center", background:"transparent", border:"none",
                             cursor:"pointer", padding:"10px 14px", color:C.text }}>
              <div style={{ display:"flex", alignItems:"center", gap:8 }}>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" style={{ color:C.gold, flexShrink:0 }}><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>
                <span style={{ fontSize:10, fontWeight:800, color:C.gold, letterSpacing:".06em" }}>
                  JARVIS SCOUTING REPORT
                </span>
                {jarvisLoading && (
                  <div style={{ width:10, height:10, borderRadius:"50%",
                                border:`2px solid ${C.gold}40`, borderTopColor:C.gold,
                                animation:"rvl-spin .8s linear infinite", flexShrink:0 }} />
                )}
              </div>
              <div style={{ display:"flex", alignItems:"center", gap:8 }}>
                {jarvisText && !jarvisLoading && (
                  <button onClick={e => { e.stopPropagation(); setJarvisText(null); }}
                          style={{ background:"transparent", border:"none", color:C.muted,
                                   cursor:"pointer", fontSize:9, padding:"0 4px" }}>↺</button>
                )}
                <span style={{ fontSize:9, color:C.muted,
                               transform:jarvisOpen?"rotate(180deg)":"none", transition:"transform .2s" }}>▼</span>
              </div>
            </button>
            {jarvisOpen && (
              <div style={{ padding:"0 14px 14px", borderTop:`1px solid ${C.gold}20` }}>
                {jarvisLoading ? (
                  <div style={{ fontSize:9, color:C.muted, marginTop:10, lineHeight:1.7, fontStyle:"italic" }}>
                    Searching for news, injuries, league standings…
                  </div>
                ) : jarvisText ? (
                  <div style={{ marginTop:10 }}>
                    {/* Per-leg pre-score context — compact pills above narrative */}
                    {pick.legs?.some(l => l.jarvisReason) && (
                      <div style={{ marginBottom:10, padding:"8px 10px", background:`${C.gold}08`,
                                    borderRadius:6, border:`1px solid ${C.gold}20` }}>
                        <div style={{ fontSize:7, fontWeight:800, color:C.gold, letterSpacing:".1em",
                                      textTransform:"uppercase", marginBottom:6 }}>Pre-score</div>
                        {pick.legs.map((l, i) => l.jarvisReason ? (
                          <div key={i} style={{ display:"flex", alignItems:"flex-start", gap:6,
                                                marginBottom:4, lineHeight:1.5 }}>
                            <span style={{ fontSize:8, fontWeight:800, flexShrink:0, minWidth:32,
                              color: l.jarvisAdjustment > 0 ? C.green : l.jarvisAdjustment < 0 ? C.amber : C.muted }}>
                              {l.jarvisAdjustment > 0 ? `+${(l.jarvisAdjustment*100).toFixed(0)}` : `${(l.jarvisAdjustment*100).toFixed(0)}`}pts
                            </span>
                            <span style={{ fontSize:8, color:C.muted }}>
                              <span style={{ color:C.text, fontWeight:700 }}>Leg {i+1}</span> — {l.jarvisReason}
                            </span>
                          </div>
                        ) : null)}
                      </div>
                    )}

                    {/* Structured Jarvis renderer — parses **HEADING** markers into
                        colored section blocks. Handles both rollover LEG format
                        and the App.jsx CONTEXT/SQUAD NEWS/MODEL CHECK/VERDICT format. */}
                    {(() => {
                      const raw = jarvisText.trim();
                      const hasStructure = /\*\*[A-Z]/.test(raw);

                      // Color map for section headings
                      const headingColor = (label) => {
                        const l = label.toUpperCase();
                        if (l.includes("VERDICT") || l.includes("OVERALL")) return C.green;
                        if (l.includes("SQUAD") || l.includes("NEWS") || l.includes("INJURY")) return C.amber;
                        if (l.includes("MODEL") || l.includes("CHECK")) return C.edge;
                        if (l.includes("CONTEXT") || l.startsWith("LEG")) return C.muted;
                        return C.gold;
                      };

                      if (hasStructure) {
                        // Split on **HEADING** patterns
                        const parts = raw.split(/(\*\*[^\*]+\*\*)/).filter(Boolean);
                        const sections = [];
                        for (let i = 0; i < parts.length; i++) {
                          const hm = parts[i].match(/^\*\*([^\*]+)\*\*$/);
                          if (hm) {
                            const label = hm[1].trim();
                            const body  = (parts[i + 1] || "").replace(/^[\s—–\-:]+/, "").trim();
                            sections.push({ label, body, color: headingColor(label) });
                            i++;
                          } else if (parts[i].trim()) {
                            sections.push({ label: null, body: parts[i].trim(), color: C.muted });
                          }
                        }
                        return (
                          <div style={{ display:"flex", flexDirection:"column", gap:8 }}>
                            {sections.map((sec, si) => (
                              <div key={si} style={{
                                padding:"8px 10px",
                                borderLeft:`3px solid ${sec.color}`,
                                borderRadius:"0 6px 6px 0",
                                background:`${sec.color}08`,
                              }}>
                                {sec.label && (
                                  <div style={{ fontSize:8, fontWeight:800, color:sec.color,
                                                letterSpacing:".08em", textTransform:"uppercase",
                                                marginBottom:4, fontFamily:C.font }}>
                                    {sec.label}
                                  </div>
                                )}
                                <div style={{ fontSize:10, color:C.text, lineHeight:1.65, fontFamily:C.font }}>
                                  {sec.body}
                                </div>
                              </div>
                            ))}
                          </div>
                        );
                      }

                      // Fallback: plain paragraph rendering for unstructured text
                      return (
                        <div>
                          {raw.split(/\n{2,}/).filter(Boolean).map((para, pi) => (
                            <div key={pi} style={{ fontSize:10, color:C.text,
                                                    lineHeight:1.7, marginBottom:8,
                                                    fontFamily:C.font }}>
                              {para.trim()}
                            </div>
                          ))}
                        </div>
                      );
                    })()}
                  </div>
                ) : (
                  <div style={{ fontSize:9, color:C.muted, marginTop:10, fontStyle:"italic" }}>
                    Loading analysis…
                  </div>
                )}
              </div>
            )}
          </div>
        )}
        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center",
                      padding:"10px 16px 14px", background:`${C.green}09`,
                      borderTop:`1px solid ${C.green}20` }}>
          <span style={{ fontSize:9, fontWeight:800, color:C.green }}>
            {pick.combinedEmpiricalRate}% combined · {pick.legs.length} legs
          </span>
          <span style={{ fontSize:9, color:C.muted }}>Engine selected</span>
        </div>

        {!isPast && (
          <div style={{ padding:"0 14px 14px" }}>
            {blocked ? (
              <div>
                <div style={{ background:`${C.red}12`, border:`1px solid ${C.red}35`,
                              borderRadius:10, padding:"12px 14px", marginBottom:8,
                              textAlign:"center" }}>
                  <div style={{ fontSize:10, fontWeight:900, color:C.red, marginBottom:4 }}>
                    ⛔ {hasLiveLegs(pick.legs) ? "A game has already kicked off" : "A game has already finished"}
                  </div>
                  <div style={{ fontSize:8, color:C.muted, lineHeight:1.6 }}>
                    This slip can no longer be booked. Come back tomorrow for a fresh slip.
                  </div>
                </div>
                <button disabled className="rvl-btn"
                        style={{ width:"100%", padding:"14px 0", fontSize:11,
                                 background:C.faint||C.border, color:C.muted }}>
                  ⛔ Booking Unavailable
                </button>
              </div>
            ) : (
              <button onClick={() => setModal(true)} className="rvl-btn"
                      style={{ width:"100%", padding:"16px 0", fontSize:12,
                               background:C.accent, color:C.accentText,
                               boxShadow:`0 4px 18px ${C.accent}40` }}>
                ▶ Book Rollover Slip
              </button>
            )}
            <div style={{ textAlign:"center", fontSize:8, color:C.muted, opacity:.6, marginTop:8 }}>
              Result tracked automatically via results loop
            </div>
          </div>
        )}
      </div>
      {modal && (
        <BookModal pick={pick} C={C} SERVER={SERVER}
                   onClose={() => setModal(false)}
                   onBooked={() => { onRefresh(); /* keep modal open — user reads code then closes manually */ }} />
      )}
    </>
  );
}

// ── DASHBOARD PAGE — Draft B ──────────────────────────────────────────────────
// Hero strip (big multiplier) → tabs → vertical timeline with inline slip
function DashboardPage({ chain, pick, date, C, SERVER, userId, onRefresh, loading, onDelete, fixtures, onFullModel }) {
  const [delOpen, setDelOpen] = useState(false);
  const [modal,   setModal]   = useState(() => !!loadPersistedBooking());

  if (loading) {
    return (
      <div style={{ display:"flex", flexDirection:"column", gap:0 }} className="rvl-fade">
        {/* Hero skeleton */}
        <div style={{ padding:"24px 18px 20px", borderBottom:`1px solid ${C.border}` }}>
          <Skeleton C={C} height={100} radius={10}/>
        </div>
        <div style={{ padding:14, display:"flex", flexDirection:"column", gap:14 }}>
          <Skeleton C={C} height={64}/><Skeleton C={C} height={220}/>
        </div>
      </div>
    );
  }

  const completedSteps = chain?.step || 0;
  const budget         = chain?.riskPot ?? chain?.startingPot ?? 0;
  const startCap       = getStartingCapital(chain);
  const locked         = chain?.lockedProfit ?? 0;
  const multiplier     = startCap > 0 ? (budget / startCap) : 1;
  const steps          = chain?.steps || [];
  const blocked        = pick ? hasBlockedLegs(pick.legs || []) : false;
  const today          = todayStr();
  const isPast         = date < today;

  const nextStepRow = GATE_TABLE[Math.min(Math.max(0, completedSteps), 9)];
  const nextGateRow = GATE_TABLE.find(r => r.saveRate && r.step > completedSteps);

  // Which steps to show in timeline: completed + current + 2 future, min 4
  const visibleUpTo = Math.max(Math.min(completedSteps + 3, ROLLOVER_MAX), 4);
  const timelineRows = GATE_TABLE.slice(0, visibleUpTo);

  const getStepState = (stepNum) => {
    const sd = steps.find(s => s.step === stepNum);
    if (sd?.result === "WIN" || sd?.result === "LOSS" || sd?.result === "VOID") return "done";
    if (completedSteps >= stepNum) return "done";
    if (completedSteps + 1 === stepNum) return "current";
    return "future";
  };

  return (
    <div style={{ display:"flex", flexDirection:"column" }} className="rvl-fade">

      {/* ── HERO STRIP ── */}
      <div className="rvlb-hero">
        {completedSteps > 0 && (
          <div className="rvlb-hero-ghost" aria-hidden="true">
            {`${multiplier.toFixed(1)}×`}
          </div>
        )}
        {completedSteps > 0 && (
          <div style={{
            position:"absolute", right:14, top:10,
            fontSize:7, fontWeight:800, letterSpacing:".14em",
            textTransform:"uppercase", color:"var(--muted)", opacity:.5,
            fontFamily:"var(--font)",
          }}>
            Achieved
          </div>
        )}

        {!chain && (
          <>
            <div className="rvlb-hero-label">Current Multiplier</div>
            <div className="rvlb-hero-number" style={{ color:C.muted, fontSize:48 }}>Not started</div>
            <div className="rvlb-hero-sub">Set your capital below to begin</div>
          </>
        )}

        {chain && completedSteps === 0 && (
          <>
            <div className="rvlb-hero-label">Current Target</div>
            <div className="rvlb-hero-number"
                 style={{ fontFamily:"'Azeret Mono',monospace",
                          background:`linear-gradient(135deg, ${C.text} 40%, ${C.accent||C.gold})`,
                          WebkitBackgroundClip:"text", WebkitTextFillColor:"transparent" }}>
              {GATE_TABLE[0].target}
            </div>
            <div className="rvlb-hero-sub">Step 1 of {ROLLOVER_MAX} — win your first slip to start compounding</div>
          </>
        )}

        {chain && completedSteps > 0 && completedSteps < ROLLOVER_MAX && (
          <>
            <div className="rvlb-hero-label">Current Target</div>
            <div className="rvlb-hero-number"
                 style={{ fontFamily:"'Azeret Mono',monospace",
                          background:`linear-gradient(135deg, ${C.text} 40%, ${C.accent||C.gold})`,
                          WebkitBackgroundClip:"text", WebkitTextFillColor:"transparent" }}>
              {nextStepRow?.target || `${multiplier.toFixed(1)}×`}
            </div>
            <div className="rvlb-hero-sub">
              Step {completedSteps + 1} of {ROLLOVER_MAX} · ${budget.toLocaleString()} from ${startCap.toLocaleString()}
            </div>
          </>
        )}

        {chain && completedSteps === ROLLOVER_MAX && (
          <>
            <div className="rvlb-hero-label">Chain Complete</div>
            <div className="rvlb-hero-number" style={{ color:C.green }}>{multiplier.toFixed(1)}×</div>
            <div className="rvlb-hero-sub">🏁 Full cashout — congratulations</div>
          </>
        )}

        {/* Stat tiles */}
        {chain && (
          <div style={{ display:"flex", gap:8, marginTop:16 }}>
            <div className="rvlb-stat-tile">
              <div className="rvlb-stat-key">Next gate</div>
              {nextGateRow
                ? <div className="rvlb-stat-val" style={{ color:C.gold }}>
                    {nextGateRow.target}
                    <span style={{ fontSize:9, fontWeight:500, color:C.muted, marginLeft:4 }}>
                      {Math.round((nextGateRow.saveRate||0)*100)}% locked
                    </span>
                  </div>
                : <div className="rvlb-stat-val" style={{ color:C.muted }}>—</div>
              }
            </div>
            <div className="rvlb-stat-tile">
              <div className="rvlb-stat-key">Today's target</div>
              <div className="rvlb-stat-val" style={{ color:C.green }}>
                {nextStepRow?.target || "—"}
                {budget > 0 && nextStepRow && (
                  <span style={{ fontSize:9, fontWeight:500, color:C.muted, marginLeft:4 }}>
                    +${(budget).toLocaleString()}
                  </span>
                )}
              </div>
            </div>
          </div>
        )}
      </div>

      {/* ── TIMELINE ── */}
      {chain && (
        <div style={{ padding:"18px 14px 0" }}>
          <div style={{ fontSize:8, fontWeight:800, color:C.muted, letterSpacing:".14em",
                        textTransform:"uppercase", marginBottom:14,
                        display:"flex", alignItems:"center", gap:8 }}>
            Journey
            <span style={{ flex:1, height:1, background:C.border, display:"block" }} />
            <span style={{ fontSize:8, color:C.muted, letterSpacing:".04em",
                           textTransform:"none", fontWeight:500 }}>
              {completedSteps} / {ROLLOVER_MAX}
            </span>
          </div>

          {timelineRows.map((row, i) => {
            const state    = getStepState(row.step);
            const stepData = steps.find(s => s.step === row.step);
            return (
              <TimelineStep
                key={row.step}
                row={row}
                state={state}
                stepData={stepData}
                isLast={i === timelineRows.length - 1}
                C={C}
                pick={state === "current" ? pick : null}
                isPast={isPast}
                blocked={blocked}
                onBook={() => setModal(true)}
                fixtures={fixtures}
                onFullModel={onFullModel}
              />
            );
          })}

          {visibleUpTo < ROLLOVER_MAX && (
            <div style={{ display:"flex", alignItems:"center", gap:12, padding:"4px 0 18px", opacity:.55 }}>
              <div style={{ display:"flex", flexDirection:"column", alignItems:"center", width:34, gap:2 }}>
                <div style={{ width:2, height:8, background:C.border, borderRadius:1 }} />
                <div style={{ width:2, height:8, background:C.border, borderRadius:1, opacity:.5 }} />
              </div>
              <div style={{ fontSize:9, color:C.muted }}>
                +{ROLLOVER_MAX - visibleUpTo} more step{ROLLOVER_MAX-visibleUpTo!==1?"s":""}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Delete chain */}
      {chain && (
        <div style={{ padding:"4px 14px 8px" }}>
          <button onClick={() => setDelOpen(true)} className="rvl-btn"
                  style={{ width:"100%", padding:"12px 0", fontSize:10,
                           background:"transparent", color:C.red,
                           border:`1px solid ${C.red}40`, opacity:.75,
                           display:"flex", alignItems:"center", justifyContent:"center", gap:6 }}>
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/>
              <path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a1 1 0 011-1h4a1 1 0 011 1v2"/>
            </svg>
            Delete Chain &amp; Start Fresh
          </button>
        </div>
      )}

      {modal && pick && (
        <BookModal pick={pick} C={C} SERVER={SERVER}
                   onClose={() => setModal(false)}
                   onBooked={() => { onRefresh(); }} />
      )}
      {delOpen && (
        <DeleteModal C={C} SERVER={SERVER} userId={userId}
                     onClose={() => setDelOpen(false)}
                     onDeleted={() => { setDelOpen(false); onDelete(); }} />
      )}
      <div style={{ height:20 }} />
    </div>
  );
}

// ── ANALYTICS PAGE (replaces Pipeline) ───────────────────────────────────────
// Shows: pipeline table, daily step results, model conf per leg, hit rate, ROI
function AnalyticsPage({ chain, C, SERVER, loading }) {
  const [expanded,   setExpanded]   = useState(null);
  const [jarvisOpen, setJarvisOpen] = useState(false);
  const [jarvisTxt,  setJarvisTxt]  = useState(null);
  const [jarvisLoading, setJarvisLoading] = useState(false);

  const steps  = chain?.steps || [];
  const cur    = chain?.step  || 0;
  const nextStep = cur + 1;
  const budget   = chain?.riskPot ?? chain?.startingPot ?? 0;
  const locked   = chain?.lockedProfit ?? 0;
  const startCap = getStartingCapital(chain); // C3-FIX: use shared helper
  const cr       = Math.max(C.cardRadius||10, 8);

  // ROI = (budget + locked - startCap) / startCap * 100
  const currentValue = budget + locked;
  const roi = startCap > 0 ? ((currentValue - startCap) / startCap * 100) : 0;
  const roiPct = Math.min(Math.abs(roi), 100);

  const getStatus = r => {
    const sd = steps.find(s => s.step === r);
    if (sd?.result === "WIN")     return "WON";
    if (sd?.result === "LOSS")    return "LOST";
    if (sd?.result === "VOID")    return "VOID";
    if (sd?.result === "PENDING") return "CURRENT";
    const hasPending = steps.some(s => s.result === "PENDING");
    if (!hasPending && r === nextStep) return "CURRENT";
    return "PENDING";
  };

  const askJarvis = async () => {
    if (jarvisTxt) { setJarvisOpen(v => !v); return; }
    setJarvisLoading(true); setJarvisOpen(true);
    try {
      const res = await fetch(`${SERVER}/api/jarvis-analyse`, {
        method:"POST", headers:{"Content-Type":"application/json"},
        body: JSON.stringify({ mode:"rollover_analytics", chain }),
      });
      const d = await res.json();
      setJarvisTxt(d.analysis || d.message || "No analysis available.");
    } catch(e) {
      const m = e.message?.toLowerCase();
      setJarvisTxt(m?.includes("429") || m?.includes("rate")
        ? "Jarvis hit a rate limit — try again in a minute."
        : "Jarvis couldn't connect. Try again.");
    }
    setJarvisLoading(false);
  };

  if (loading) {
    return (
      <div style={{ display:"flex", flexDirection:"column", gap:12 }} className="rvl-fade">
        <Skeleton C={C} height={100}/><Skeleton C={C} height={180}/><Skeleton C={C} height={300}/>
      </div>
    );
  }

  if (!chain) {
    return (
      <div style={{ display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center",
                    gap:10, padding:"60px 20px", color:C.muted, textAlign:"center" }} className="rvl-fade">
        <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke={C.muted} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
        </svg>
        <span style={{ fontSize:11, fontWeight:700 }}>No active chain to analyse</span>
        <span style={{ fontSize:10 }}>Start a chain from the Dashboard to see analytics.</span>
      </div>
    );
  }

  return (
    <div style={{ display:"flex", flexDirection:"column", gap:14 }} className="rvl-fade">

      {/* ── WIN RATE RING ── */}
      <div className="rvl-card"
           style={{ background:C.surface, border:`1px solid ${C.border}`, padding:20 }}>
        {(() => {
          const wins     = steps.filter(s => s.result === "WIN").length;
          const played   = steps.filter(s => s.result === "WIN" || s.result === "LOSS").length;
          const hitRate  = played > 0 ? Math.round((wins / played) * 100) : 0;
          const r        = 50;
          const circ     = 2 * Math.PI * r;
          const dash     = circ * (hitRate / 100);
          const ringCol  = hitRate >= 60 ? C.green : hitRate >= 40 ? C.gold : C.red;
          return (
            <div style={{ display:"flex", alignItems:"center", gap:20 }}>
              {/* Ring */}
              <div style={{ flexShrink:0 }}>
                <svg width="120" height="120" viewBox="0 0 120 120">
                  <circle cx="60" cy="60" r={r} fill="none"
                    stroke={C.border} strokeWidth="10"/>
                  <circle cx="60" cy="60" r={r} fill="none"
                    stroke={ringCol} strokeWidth="10"
                    strokeDasharray={`${dash} ${circ}`}
                    strokeLinecap="round"
                    transform="rotate(-90 60 60)"
                    style={{ transition:"stroke-dasharray .8s cubic-bezier(.4,0,.2,1)" }}/>
                  <text x="60" y="54" textAnchor="middle"
                    fill={C.text} fontSize="22" fontWeight="900"
                    fontFamily="'Azeret Mono',monospace">
                    {hitRate}%
                  </text>
                  <text x="60" y="70" textAnchor="middle"
                    fill={C.muted} fontSize="9"
                    fontFamily="'JetBrains Mono',monospace">
                    hit rate
                  </text>
                </svg>
              </div>
              {/* Breakdown bars beside ring */}
              <div style={{ flex:1, display:"flex", flexDirection:"column", gap:10 }}>
                {[
                  { lbl:"Wins",    val:wins,           pct:played>0?(wins/played*100):0,    col:C.green },
                  { lbl:"Losses",  val:played-wins,    pct:played>0?((played-wins)/played*100):0, col:C.red },
                  { lbl:"Steps",   val:`${cur}/${ROLLOVER_MAX}`, pct:(cur/ROLLOVER_MAX)*100, col:C.gold },
                ].map((it,i) => (
                  <div key={i}>
                    <div style={{ display:"flex", justifyContent:"space-between", marginBottom:4 }}>
                      <span style={{ fontSize:9, fontWeight:700, color:C.muted, letterSpacing:".08em", textTransform:"uppercase" }}>{it.lbl}</span>
                      <span style={{ fontSize:11, fontWeight:900, color:it.col, fontFamily:"'Azeret Mono',monospace" }}>{it.val}</span>
                    </div>
                    <div className="rvl-bar" style={{ background:`${it.col}18` }}>
                      <div className="rvl-fill" style={{ width:`${it.pct}%`, background:it.col }}/>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          );
        })()}
      </div>

      {/* ── ROI SUMMARY ── */}
      <div className="rvl-card"
           style={{ background:C.surface, border:`1px solid ${C.border}`, padding:16 }}>
        <Lbl style={{ marginBottom:12 }}>Current Chain Analytics</Lbl>
        <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:10, marginBottom:14 }}>
          {[
            { lbl:"Active Step",    val:cur===0?"—":`${nextStep} / ${ROLLOVER_MAX}`, col:C.gold },
            { lbl:"Starting Capital", val:`$${startCap.toLocaleString()}`,                col:C.text },
            { lbl:"Current Value",  val:`$${currentValue.toLocaleString()}`,              col:currentValue>startCap?C.green:C.text },
            { lbl:"Locked Profit",  val:locked>0?`+$${locked.toLocaleString()}`:"$0", col:locked>0?C.green:C.text },
          ].map((it,i) => (
            <div key={i} style={{ background:`${C.bg}60`, borderRadius:cr+2,
                                  padding:"10px 12px", border:`1px solid ${C.border}` }}>
              <Lbl style={{ marginBottom:4 }}>{it.lbl}</Lbl>
              <Val size={15} color={it.col}>{it.val}</Val>
            </div>
          ))}
        </div>
        {/* ROI bar */}
        <div style={{ marginBottom:6 }}>
          <div style={{ display:"flex", justifyContent:"space-between", marginBottom:6 }}>
            <Lbl>Chain ROI</Lbl>
            <span style={{ fontSize:11, fontWeight:900,
                           color:roi>=0?C.green:C.red }}>
              {roi >= 0 ? "+" : ""}{roi.toFixed(1)}%
            </span>
          </div>
          <div className="rvl-roi-bar">
            <div className="rvl-roi-fill"
                 style={{ width:`${roiPct}%`,
                          background:roi>=0?`linear-gradient(90deg,${C.green},${C.gold})`:C.red }} />
          </div>
        </div>
      </div>

      {/* ── JARVIS ANALYSIS ── */}
      <div className="rvl-card"
           style={{ background:C.surface, border:`1px solid ${C.border}`, overflow:"hidden" }}>
        <button className="rvl-coll-btn" onClick={askJarvis}
                style={{ padding:"14px 16px", color:C.text }}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={C.gold} strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink:0 }}>
              <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>
            </svg>
          <div style={{ flex:1, textAlign:"left" }}>
            <div style={{ fontSize:11, fontWeight:800, color:C.text }}>
              {jarvisTxt ? "Jarvis Analysis" : "Ask Jarvis to Analyse This Chain"}
            </div>
            <div style={{ fontSize:9, color:C.muted, marginTop:2 }}>
              {jarvisLoading ? "Thinking…" : jarvisTxt ? "Tap to expand / collapse" : "Tap for AI insights on your current chain"}
            </div>
          </div>
          {jarvisLoading
            ? <div className="rvl-spin" style={{ width:16, height:16, borderRadius:"50%", border:`2px solid ${C.border}`, borderTopColor:C.gold, flexShrink:0 }} />
            : <span style={{ fontSize:11, color:C.muted, transform:jarvisOpen?"rotate(180deg)":"none", transition:"transform .2s" }}>▼</span>
          }
        </button>
        {jarvisOpen && jarvisTxt && (
          <div className="rvl-fade"
               style={{ padding:"0 16px 16px", borderTop:`1px solid ${C.border}` }}>
            <div style={{ fontSize:9, color:C.text, lineHeight:1.7, whiteSpace:"pre-wrap", marginTop:12 }}>
              {jarvisTxt}
            </div>
            <button onClick={() => { setJarvisTxt(null); setJarvisOpen(false); }} className="rvl-btn"
                    style={{ marginTop:10, padding:"5px 14px", fontSize:8,
                             background:"transparent", border:`1px solid ${C.faint||C.border}`,
                             color:C.muted }}>
              ↺ Refresh analysis
            </button>
          </div>
        )}
      </div>

      {/* ── DAILY STEP RESULTS ── */}
      {steps.length > 0 && (
        <div className="rvl-card"
             style={{ background:C.surface, border:`1px solid ${C.border}`, padding:14 }}>
          <Lbl style={{ marginBottom:10 }}>Daily Step Results</Lbl>
          <div style={{ display:"flex", flexDirection:"column", gap:6 }}>
            {steps.map((sd, i) => {
              const isOpen = expanded === `step-${sd.step}`;
              const resCol = sd.result==="WIN"?C.green:sd.result==="LOSS"?C.red:sd.result==="VOID"?(C.amber||C.gold):C.muted;
              const legs   = sd.legs || [];
              return (
                <div key={i}>
                  <button onClick={() => legs.length && setExpanded(isOpen ? null : `step-${sd.step}`)}
                          style={{ width:"100%", display:"grid", gridTemplateColumns:"32px 1fr auto 60px 20px",
                                   gap:8, alignItems:"center", padding:"9px 10px",
                                   background:isOpen?C.bg:"transparent", borderRadius:cr,
                                   border:`1px solid ${isOpen?C.border:"transparent"}`,
                                   cursor:legs.length?"pointer":"default",
                                   fontFamily:C.font, textAlign:"left" }}>
                    <div style={{ width:26, height:26, borderRadius:7,
                                  background:`${resCol}18`, border:`1px solid ${resCol}35`,
                                  display:"flex", alignItems:"center", justifyContent:"center" }}>
                      <span style={{ fontSize:9, fontWeight:900, color:resCol }}>{sd.step}</span>
                    </div>
                    <div>
                      <div style={{ fontSize:10, fontWeight:800, color:C.text }}>{sd.date||"—"}</div>
                      <div style={{ fontSize:8, color:C.muted, marginTop:1 }}>
                        {legs.length} leg{legs.length!==1?"s":""}{sd.odds?` · ×${sd.odds}`:""}
                      </div>
                    </div>
                    <SBadge status={sd.result==="WIN"?"WON":sd.result==="LOSS"?"LOST":sd.result==="VOID"?"VOID":sd.result==="PENDING"?"CURRENT":"PENDING"} C={C} />
                    <span style={{ fontSize:12, fontWeight:900, color:resCol, textAlign:"right" }}>
                      {sd.odds?`×${sd.odds}`:"—"}
                    </span>
                    {legs.length > 0
                      ? <span style={{ fontSize:9, color:C.muted }}>{isOpen?"▲":"▼"}</span>
                      : <span/>
                    }
                  </button>
                  {isOpen && legs.length > 0 && (
                    <div className="rvl-fade"
                         style={{ background:C.bg, border:`1px solid ${C.border}`,
                                  borderTop:"none", borderRadius:`0 0 ${cr}px ${cr}px`,
                                  padding:"0 14px 10px" }}>
                      {legs.map((l,j) => <LegRow key={j} leg={l} index={j} C={C} showStatus={true} />)}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* ── STRATEGY PIPELINE ── */}
      <div className="rvl-card"
           style={{ background:C.surface, border:`1px solid ${C.border}`, padding:14 }}>
        <Lbl style={{ marginBottom:10 }}>Strategy Pipeline</Lbl>
        <div style={{ display:"grid", gridTemplateColumns:"28px 48px 40px 1fr auto",
                      gap:8, padding:"0 12px 8px" }}>
          {["#","TARGET","SAVE","WHAT IT MEANS","STATUS"].map((h,i) => (
            <div key={i} style={{ fontSize:7, fontWeight:800, letterSpacing:".1em", color:C.muted }}>{h}</div>
          ))}
        </div>
        <div style={{ borderTop:`1px solid ${C.border}`, paddingTop:6 }}>
          {GATE_TABLE.map(row => {
            const status  = getStatus(row.step);
            const isCurr  = status === "CURRENT";
            const isGate  = GATE_STEPS.has(row.step);
            const isOpen  = expanded === `pipe-${row.step}`;
            const sd      = steps.find(s => s.step === row.step);
            const numCol  = status==="WON"?C.green:status==="LOST"?C.red:status==="VOID"?(C.amber||C.gold):isCurr?C.gold:C.muted;
            const descCol = status==="PENDING"?C.muted:C.text;
            return (
              <div key={row.step}>
                <div className="rvl-pipe-row"
                     onClick={() => setExpanded(isOpen ? null : `pipe-${row.step}`)}
                     style={{ background:isCurr?`${C.gold}10`:"transparent",
                              border:`1px solid ${isCurr?`${C.gold}45`:"transparent"}` }}>
                  <div>
                    <span style={{ fontSize:11, fontWeight:900, color:numCol }}>{row.step}</span>
                    {isGate && (
                      <div style={{ fontSize:6, fontWeight:900,
                                    color:(isCurr||status==="WON")?C.gold:C.muted, marginTop:1 }}>
                        GATE
                      </div>
                    )}
                  </div>
                  <span style={{ fontSize:11, fontWeight:800,
                                 color:status==="PENDING"?C.muted:C.text,
                                 opacity:status==="PENDING"?.55:1 }}>
                    {row.target}
                  </span>
                  <span style={{ fontSize:10, fontWeight:800,
                                 color:row.saveRate?C.gold:C.muted, opacity:row.saveRate?1:.4 }}>
                    {row.saveRate?`${Math.round(row.saveRate*100)}%`:"—"}
                  </span>
                  <span style={{ fontSize:9, color:descCol,
                                 opacity:status==="PENDING"?0.6:1,
                                 overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>
                    {row.desc}
                  </span>
                  <SBadge status={status} C={C} />
                </div>
                {isOpen && (
                  <div className="rvl-fade"
                       style={{ margin:"0 10px 8px", padding:12,
                                background:`${C.bg}80`, borderRadius:cr,
                                border:`1px solid ${C.border}` }}>
                    <div style={{ fontSize:9, lineHeight:1.75, color:C.text, opacity:.85 }}>
                      {row.saveRate
                        ? `Gate step. Winning here locks ${Math.round(row.saveRate*100)}% of your pot permanently — kept regardless of future steps.`
                        : `Regular step. Win the engine-selected slip to reach ${row.target}. No profit locks here.`}
                    </div>
                    {sd && (
                      <div style={{ marginTop:8, display:"flex", gap:8, flexWrap:"wrap" }}>
                        {sd.date && <span style={{ fontSize:8, color:C.muted }}>{sd.date}</span>}
                        {sd.odds && <span style={{ fontSize:8, fontWeight:800, color:C.gold }}>×{sd.odds} odds</span>}
                        {sd.result === "VOID" && (
                          <span style={{ fontSize:8, color:C.amber||C.gold, fontWeight:800 }}>
                            VOID — postponed/cancelled legs
                          </span>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* ── SYSTEM RULES ── */}
      <div className="rvl-card"
           style={{ background:C.surface, border:`1px solid ${C.border}`, padding:14 }}>
        <Lbl style={{ marginBottom:10 }}>System Rules</Lbl>
        <div style={{ display:"flex", flexDirection:"column", gap:8 }}>
          {[
            { ico:<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="3"/></svg>,
              rule:"Target ≥2.0× total odds per step",   sub:"Engine stops adding legs once threshold is cleared" },
            { ico:<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>,
              rule:"Below-target slips shown with warning", sub:"Pool may be thin some days — slip still shown, booking your call" },
            { ico:<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0110 0v4"/></svg>,
              rule:"Follow the save gate strictly",       sub:"Lock profit at every gate milestone" },
            { ico:<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg>,
              rule:"Max 10 steps per rollover chain",     sub:"Full cashout at step 10" },
            { ico:<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><line x1="4.93" y1="4.93" x2="19.07" y2="19.07"/></svg>,
              rule:"VOID: postponed or cancelled legs",   sub:"Chain pauses — step not lost, just skipped" },
            { ico:<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>,
              rule:"Quality over quantity",               sub:"High empirical hit rate beats raw odds" },
            { ico:<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>,
              rule:"Discipline is your edge",             sub:"Stick to the system — avoid emotional overrides" },
          ].map((r,i) => (
            <div key={i} style={{ display:"flex", gap:10, alignItems:"flex-start" }}>
              <span style={{ flexShrink:0, lineHeight:1.4, color:C.muted, marginTop:1 }}>{r.ico}</span>
              <div>
                <div style={{ fontSize:10, fontWeight:800, color:C.text }}>{r.rule}</div>
                <div style={{ fontSize:8, color:C.muted, marginTop:2 }}>{r.sub}</div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ── HISTORY PAGE ──────────────────────────────────────────────────────────────
function HistoryPage({ history, C, loading }) {
  const [filter, setFilter] = useState("all");
  const filtered = history.filter(h =>
    filter === "won" ? !!h.completedAt :
    filter === "lost" ? (!h.completedAt && !h.voidAt) :
    filter === "void" ? !!h.voidAt :
    true
  );
  const total   = history.reduce((a,h) => a + (h.totalLocked||0), 0);
  const wins    = history.filter(h => h.completedAt).length;
  const winRate = history.length > 0 ? Math.round((wins / history.length) * 100) : 0;

  if (loading) {
    return (
      <div style={{ display:"flex", flexDirection:"column", gap:10 }} className="rvl-fade">
        {[1,2,3].map(i => <Skeleton key={i} C={C} height={72}/>)}
      </div>
    );
  }

  return (
    <div style={{ display:"flex", flexDirection:"column", gap:14 }} className="rvl-fade">
      {history.length > 0 && (
        <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr 1fr", gap:10 }}>
          {[
            { lbl:"Total Profit",  val:`$${total.toLocaleString()}`, col:total>0?C.green:C.text },
            { lbl:"Win Rate",      val:`${winRate}%`,          col:winRate>=60?C.green:C.text },
            { lbl:"Chains Run",    val:history.length,         col:C.text },
          ].map((it,i) => (
            <div key={i} className="rvl-card"
                 style={{ background:C.surface, border:`1px solid ${C.border}`,
                          padding:"12px 10px", textAlign:"center" }}>
              <Lbl style={{ marginBottom:4 }}>{it.lbl}</Lbl>
              <Val size={15} color={it.col}>{it.val}</Val>
            </div>
          ))}
        </div>
      )}
      {history.length > 0 && (
        <div style={{ display:"flex", gap:6 }}>
          {["all","won","lost","void"].map(f => (
            <button key={f} onClick={() => setFilter(f)} className="rvl-btn"
                    style={{ padding:"6px 12px", fontSize:9,
                             background:filter===f?C.accent:C.surface,
                             color:filter===f?C.accentText:C.text,
                             border:`1px solid ${filter===f?C.accent:C.border}` }}>
              {f.toUpperCase()}
            </button>
          ))}
        </div>
      )}
      {filtered.length === 0 ? (
        <div className="rvl-card"
             style={{ border:`2px dashed ${C.border}`, padding:"50px 20px", textAlign:"center" }}>
          <div style={{ display:"flex", justifyContent:"center", marginBottom:10, color:C.muted, opacity:.5 }}>
            <svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="22 12 16 12 14 15 10 15 8 12 2 12"/><path d="M5.45 5.11L2 12v6a2 2 0 002 2h16a2 2 0 002-2v-6l-3.45-6.89A2 2 0 0016.76 4H7.24a2 2 0 00-1.79 1.11z"/></svg>
          </div>
          <div style={{ fontSize:12, fontWeight:800, color:C.text, marginBottom:6 }}>
            {history.length === 0 ? "No Completed Chains Yet" : "No matches for this filter"}
          </div>
          <div style={{ fontSize:9, color:C.muted, lineHeight:1.7 }}>
            {history.length === 0
              ? "Complete your first rollover chain to see results here."
              : "Try a different filter."}
          </div>
        </div>
      ) : filtered.map((h,i) => {
        const won   = !!h.completedAt;
        const isVoid = !!h.voidAt;
        const dt    = new Date(h.completedAt||h.lostAt||h.voidAt||Date.now())
                        .toLocaleDateString("en-US", {month:"short", day:"numeric", year:"numeric"});
        const stps  = h.step != null ? `${h.step} / ${ROLLOVER_MAX} steps` : "—";
        const col   = won ? C.green : isVoid ? (C.amber||C.gold) : C.red;
        return (
          <div key={i} className="rvl-hist-row rvl-fade"
               style={{ background:C.surface, borderColor:`${col}22`,
                        animationDelay:`${i*40}ms` }}>
            <div style={{ display:"flex", alignItems:"center", gap:12, minWidth:0 }}>
              <div style={{ width:36, height:36, borderRadius:10, flexShrink:0,
                            background:`${col}18`, border:`1px solid ${col}35`,
                            display:"flex", alignItems:"center", justifyContent:"center" }}>
                <span style={{ fontSize:14, color:col }}>
                  {won ? "✓" : isVoid ? "—" : "✕"}
                </span>
              </div>
              <div style={{ minWidth:0 }}>
                <div style={{ fontSize:11, fontWeight:900, color:C.text }}>Chain #{history.length - i}</div>
                <div style={{ fontSize:8, color:C.muted, marginTop:2 }}>{dt} · {stps}</div>
              </div>
            </div>
            <div style={{ textAlign:"right", flexShrink:0 }}>
              <Val size={15} color={col}>
                {won ? `+$${(h.totalLocked||0).toLocaleString()}` : isVoid ? "VOID" : "Lost"}
              </Val>
              <div style={{ fontSize:8, color:C.muted, marginTop:2 }}>
                {won ? "SECURED" : isVoid ? "SKIPPED" : "FAILED"}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ── TABS ─────────────────────────────────────────────────────────────────────
const ROLLOVER_SVG_ICONS = {
  dashboard: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/>
      <rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/>
    </svg>
  ),
  analytics: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="22 7 13.5 15.5 8.5 10.5 2 17"/>
      <polyline points="16 7 22 7 22 13"/>
    </svg>
  ),
  history: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10"/>
      <polyline points="12 6 12 12 16 14"/>
    </svg>
  ),
};

const TABS = [
  { id:"dashboard", label:"Dashboard", icon: ROLLOVER_SVG_ICONS.dashboard },
  { id:"analytics", label:"Analytics", icon: ROLLOVER_SVG_ICONS.analytics },
  { id:"history",   label:"History",   icon: ROLLOVER_SVG_ICONS.history },
];

const RVL_PAGE_KEY = "rvl_active_page";
// ── MAIN EXPORT ───────────────────────────────────────────────────────────────
export default function RolloverSystem({ C, SERVER, fixtures, historicalRates, date, buildRolloverPick, buildUniversalPool, onFullModel, onChainChange }) {
  const [page,       setPage]       = useState(() => { try { return sessionStorage.getItem(RVL_PAGE_KEY) || "dashboard"; } catch { return "dashboard"; } });
  const setPagePersist = (p) => { try { sessionStorage.setItem(RVL_PAGE_KEY, p); } catch {} setPage(p); };
  const [chain,      setChain]      = useState(null);
  const [history,    setHistory]    = useState([]);
  const [loading,    setLoading]    = useState(true);
  const [offline,    setOffline]    = useState(false);
  const [pick,       setPick]       = useState(null);
  const [showWelcome, setShowWelcome] = useState(false);
  const [engineSyncError, setEngineSyncError] = useState(false);
  const [showHeaderDelete, setShowHeaderDelete] = useState(false); // P25 - delete from header for failed/archived chains
  const pendingOnboardRef = useRef(false);
  const lockedDateRef = useRef(null);

  // Notify App whenever chain or pick changes so Jarvis always has the real chain + today's pick
  useEffect(() => {
    if (!chain) { onChainChange?.(null); return; }
    // Merge pick into chain so Jarvis can access chain.todayPick without a separate prop
    onChainChange?.({ ...chain, todayPick: pick || null });
  }, [chain, pick, onChainChange]);

  // Stable device UUID — generated once, persisted in localStorage
  const userId = useRef(getOrCreateUUID()).current;

  // Helper: fetch with user identity header
  const rvlFetch = useCallback((url, opts = {}) => {
    return fetch(url, {
      ...opts,
      headers: { "Content-Type": "application/json", "X-User-ID": userId, ...(opts.headers || {}) },
    });
  }, [userId]);

  useEffect(() => {
    injectRolloverStyles(C);
    // Seed server date so todayStr() is server-aligned before slip build runs
    fetchRolloverServerDate(SERVER);
  }, [C]);

  // ── Determine whether to show welcome ────────────────────────────────────
  // Done after initial load so we know if a chain exists server-side
  const checkOnboarding = useCallback((chainData) => {
    const hasOnboarded = (() => { try { return !!localStorage.getItem(RVL_ONBOARD_KEY); } catch { return false; } })();
    // status "pending" means chain was archived, show welcome again
    if (chainData?.status === "pending") { setShowWelcome(true); return; }
    // If chain exists with real progress, they've onboarded
    if (chainData?.step != null && chainData?.status === "active") {
      try { localStorage.setItem(RVL_ONBOARD_KEY, "1"); } catch {}
      setShowWelcome(false);
    } else if (!hasOnboarded) {
      setShowWelcome(true);
    } else {
      setShowWelcome(false);
    }
  }, []);

  // pickLoadedRef: once we have a confirmed server-locked slip for today, never rebuild
  const pickLoadedRef  = useRef(false);
  const pickBuildingRef = useRef(false); // C5-FIX: mutex — prevent dual-tab concurrent builds

  // ── Slip build logic ──────────────────────────────────────────────────────
  useEffect(() => {
    if (!fixtures?.length || !historicalRates || !date) return;
    if (date !== todayStr()) return;
    if (pendingOnboardRef.current) return; // blocked — user is in onboarding flow
    // If we already have a confirmed locked pick for today, do nothing
    if (pickLoadedRef.current && lockedDateRef.current === date) return;

    const buildTodayPool = () =>
      buildUniversalPool(
        fixtures.filter(f => {
          const s = (f.state || "").toLowerCase().replace(/[\s_\-]/g, "");
          return s === "" || s === "notstarted" || s === "scheduled" || s === "prematch";
        }),
        historicalRates
      );

    // Always check server lock first — it is the authoritative source
    fetch(`${SERVER}/api/rollover/parley/${date}`, { headers: { "X-User-ID": userId } })
      .then(r => r.json())
      .then(async data => {
        if (data.locked && data.parley?.legs?.length) {
          // Server has a locked slip — use it unconditionally, no rebuild ever
          setPick(data.parley);
          lockedDateRef.current = date;
          pickLoadedRef.current = true;
          return;
        }

        // Not locked — only build if we haven't already shown a pick this session
        if (pickLoadedRef.current) return;
        if (pickBuildingRef.current) return; // C5-FIX: another tab already building
        pickBuildingRef.current = true;

        const pool = buildTodayPool();
        if (!pool.length) return;

        // ── JARVIS PRE-SCORE ──────────────────────────────────────────────
        // Research the top 8 candidates with live web search before selecting legs.
        // Adjustments are applied to pool scores so Jarvis directly affects which
        // games get picked — not just commented on them afterwards.
        const applyPreScores = async (rawPool) => {
          const top = rawPool.slice(0, 8); // top 8 by engine score
          try {
            const r = await fetch(`${SERVER}/api/jarvis-pre-score`, {
              method: "POST",
              headers: { "Content-Type": "application/json", "X-User-ID": userId },
              body: JSON.stringify({
                candidates: top.map(e => ({
                  fixtureId: e.fixtureId, game: e.game, pick: e.pick,
                  market: e.market, league: e.league,
                  conf: e.conf, empiricalRate: e.empiricalRate, odds: e.odds,
                })),
              }),
            });
            if (!r.ok) return rawPool;
            const data = await r.json();
            const scoreMap = {};
            (data.scores || []).forEach(s => {
              scoreMap[s.fixtureId] = { adjustment: s.adjustment, reason: s.reason, flags: s.flags };
            });
            // Apply adjustments — clamp adjusted score between 0.05 and 1.0
            return rawPool.map(e => {
              const adj = scoreMap[e.fixtureId];
              if (!adj) return e;
              return {
                ...e,
                score: Math.max(0.05, Math.min(1.0, e.score + adj.adjustment)),
                jarvisAdjustment: adj.adjustment,
                jarvisReason: adj.reason,
                jarvisFlags: adj.flags,
              };
            }).sort((a, b) => b.score - a.score); // re-sort after adjustments
          } catch {
            return rawPool; // fallback: use unadjusted pool
          }
        };

        const scoredPool = await applyPreScores(pool);
        let p = buildRolloverPick(scoredPool);
        let belowTarget = false;

        if (!p && scoredPool.length >= 2) {
          const fallbackLegs = scoredPool.slice(0, 2);
          const fallbackOdds = parseFloat(fallbackLegs.reduce((acc, l) => acc * l.odds, 1.0).toFixed(2));
          const combRate = fallbackLegs.reduce((acc, l) => acc * (l.empiricalRate / 100), 1.0) * 100;
          p = {
            legs: fallbackLegs.map(l => ({
              fixtureId: l.fixtureId, game: l.game, pick: l.pick, odds: l.odds,
              empiricalRate: l.empiricalRate, conf: l.conf, league: l.league, market: l.market,
              jarvisAdjustment: l.jarvisAdjustment, jarvisReason: l.jarvisReason, jarvisFlags: l.jarvisFlags,
            })),
            totalOdds: fallbackOdds,
            combinedEmpiricalRate: Math.round(combRate),
            poolSize: scoredPool.length,
            belowTarget: true,
          };
          belowTarget = true;
        }

        if (!p) return;

        // Show the pick locally immediately
        setPick(p);

        // A7-FIX: Always lock on server — even belowTarget slips need tracking so
        // autoScoreRolloverPick can fire and register the WIN/LOSS against the chain.
        // belowTarget flag is sent so the server can mark it as a thin-data step.
        // Previously: if (belowTarget) return; — this silently dropped results forever.
        fetch(`${SERVER}/api/rollover/parley/${date}`, {
          method:"POST", headers:{"Content-Type":"application/json", "X-User-ID": userId},
          body: JSON.stringify({ legs:p.legs, totalOdds:p.totalOdds,
                                 combinedEmpiricalRate:p.combinedEmpiricalRate,
                                 poolSize: scoredPool.length,
                                 belowTarget: belowTarget || false }),
        })
        .then(r => { if (!r.ok) throw new Error("lock failed"); return r.json(); })
        .then(lockData => {
          // Use whatever the server locked (may differ if another session locked first)
          if (lockData.parley?.legs?.length) setPick(lockData.parley);
          lockedDateRef.current = date;
          pickLoadedRef.current = true;
          pickBuildingRef.current = false; // C5-FIX: release mutex
          // Register with engine chain
          return fetch(`${SERVER}/api/rollover/engine/pick`, {
            method:"POST", headers:{"Content-Type":"application/json", "X-User-ID": userId},
            body: JSON.stringify({ date, legs:p.legs, odds:p.totalOdds }),
          });
        })
        // E6-FIX: engine/pick registration was silently swallowed with .catch(() => {}).
        // If this fails, autoScoreRolloverPick never fires and the chain step never advances.
        // We surface a non-blocking warning and retry automatically on the next load cycle.
        .catch(err => {
          console.warn("[Rollover] Engine pick registration failed:", err?.message || err);
          setEngineSyncError(true);
          // Retry once after 8s — covers transient network blips without hammering the server
          setTimeout(() => {
            fetch(`${SERVER}/api/rollover/engine/pick`, {
              method:"POST", headers:{"Content-Type":"application/json", "X-User-ID": userId},
              body: JSON.stringify({ date, legs:pick?.legs || p.legs, odds:pick?.totalOdds || p.totalOdds }),
            })
            .then(r => { if (r.ok) setEngineSyncError(false); })
            .catch(() => { /* retry also failed — user will see the warning, manual reload will re-trigger */ });
          }, 8000);
        });
      })
      .catch(() => {
        // Server unreachable — build locally, don't lock
        if (pickLoadedRef.current) return;
        const pool = buildTodayPool();
        let p = buildRolloverPick(pool);
        if (!p && pool.length >= 2) {
          const fl = pool.slice(0, 2);
          const fo = parseFloat(fl.reduce((acc,l) => acc * l.odds, 1.0).toFixed(2));
          const cr = fl.reduce((acc,l) => acc * (l.empiricalRate/100), 1.0) * 100;
          p = { legs:fl.map(l=>({fixtureId:l.fixtureId,game:l.game,pick:l.pick,odds:l.odds,
                                  empiricalRate:l.empiricalRate,conf:l.conf,league:l.league,market:l.market})),
                totalOdds:fo, combinedEmpiricalRate:Math.round(cr), poolSize:pool.length, belowTarget:true };
        }
        if (p) setPick(p);
        pickBuildingRef.current = false; // C5-FIX: release mutex on fallback path
      });
  }, [fixtures, historicalRates, date]);

  // ── Load chain + history ──────────────────────────────────────────────────
  const load = useCallback(async (justOnboarded = false) => {
    setLoading(true); setOffline(false);
    try {
      const [eRes, hRes] = await Promise.all([
        fetch(`${SERVER}/api/rollover/user/${userId}`, { headers: { "X-User-ID": userId } }),
        fetch(`${SERVER}/api/rollover/history?userId=${userId}`, { headers: { "X-User-ID": userId } }),
      ]);
      if (!eRes.ok || !hRes.ok) throw new Error("Server error");
      const [eData, hData] = await Promise.all([eRes.json(), hRes.json()]);
      setChain(eData.chain);
      setHistory(hData.history || []);
      // Skip re-evaluation if we just completed onboarding — the welcome flow
      // already set the onboard key and called setShowWelcome(false).
      // Without this guard, a slow /init write returns a null chain and
      // checkOnboarding incorrectly shows the welcome screen again.
      if (!justOnboarded) checkOnboarding(eData.chain);
    } catch { setOffline(true); setShowWelcome(false); }
    finally  { setLoading(false); }
  }, [SERVER, userId, checkOnboarding]);

  useEffect(() => { load(); }, [load]);

  // ── Render ────────────────────────────────────────────────────────────────
  if (showWelcome) {
    return (
      <div style={{ color:C.text, fontFamily:C.font }}>
        <WelcomeFlow C={C} SERVER={SERVER} userId={userId}
                     onComplete={() => { pendingOnboardRef.current = false; setShowWelcome(false); load(true); }} />
      </div>
    );
  }

  return (
    <div style={{ display:"flex", flexDirection:"column", color:C.text, fontFamily:C.font, paddingBottom:20 }}>

      {/* ── Premium header shell — matches App.jsx grm-header ── */}
      <div className="rvl-header">
        {/* Top row: wordmark + chain status */}
        <div className="rvl-header-top">
          <div style={{ display:"flex",alignItems:"center",gap:10 }}>
            <div className="rvl-wordmark">
              ROLLOVER<span className="rvl-wordmark-accent"> PRO</span>
              <span className="rvl-wordmark-meta">compound engine</span>
            </div>
          </div>
          {/* Live chain status pill */}
          {chain && chain.status === "active" && (
            <div style={{ display:"flex",alignItems:"center",gap:6,
                          background:`${C.green}12`,border:`1px solid ${C.green}30`,
                          borderRadius:"var(--r-lg)",padding:"5px 12px" }}>
              <div style={{ width:6,height:6,borderRadius:"50%",background:C.green }} className="live-dot"/>
              <span style={{ fontSize:10,fontWeight:800,color:C.green,letterSpacing:".04em" }}>
                STEP {chain.step + 1} · {GATE_TABLE[Math.min(chain.step, ROLLOVER_MAX-1)]?.target || "—"}
              </span>
            </div>
          )}
          {chain && chain.status !== "active" && (
            <div style={{ display:"flex", alignItems:"center", gap:8 }}>
              <span style={{ fontSize:9,fontWeight:700,color:C.muted,letterSpacing:".04em",textTransform:"uppercase" }}>
                {chain.status === "pending" ? "Archived" : chain.status === "failed" ? "Archived" : chain.status || "no chain"}
              </span>
              <button onClick={() => setShowHeaderDelete(true)}
                style={{ fontSize:8, fontWeight:800, color:C.red, background:`${C.red}12`,
                         border:`1px solid ${C.red}30`, borderRadius:6, padding:"3px 8px",
                         cursor:"pointer", letterSpacing:".04em", textTransform:"uppercase" }}>
                Start Fresh
              </button>
            </div>
          )}
          {showHeaderDelete && (
            <DeleteModal C={C} SERVER={SERVER} userId={userId}
                         onClose={() => setShowHeaderDelete(false)}
                         onDeleted={() => {
                           setShowHeaderDelete(false);
                           pendingOnboardRef.current = true;
                           pickLoadedRef.current = false;
                           lockedDateRef.current = null;
                           setPick(null); setChain(null); setShowWelcome(true);
                         }} />
          )}
        </div>

        {/* Draft B: NO tab bar in header — tabs live below the hero strip */}
      </div>

      {/* Offline banner */}
      {offline && (
        <div style={{ background:`${C.red}12`,border:`1px solid ${C.red}30`,
                      borderRadius:"var(--r-lg)",margin:"12px 14px 0",padding:"11px 14px",
                      display:"flex",justifyContent:"space-between",alignItems:"center" }}>
          <div>
            <div style={{ fontSize:11,fontWeight:800,color:C.red }}>Connection lost</div>
            <div style={{ fontSize:9,color:C.muted,marginTop:2 }}>Could not reach the rollover engine</div>
          </div>
          <button onClick={load} className="rvl-btn"
            style={{ padding:"8px 14px",fontSize:10,background:"var(--surface)",
                     color:C.text,border:"1px solid var(--glass-border)" }}>
            Retry
          </button>
        </div>
      )}

      {/* ── Tab bar — below hero strip, outside sticky header ── */}
      <div className="rvlb-tabs">
        {TABS.map(t => (
          <button key={t.id} onClick={() => setPagePersist(t.id)}
            className={`rvlb-tab${page===t.id?" rvlb-active":""}`}>
            {t.label}
          </button>
        ))}
      </div>

      <div style={{ paddingTop:14 }}>
        {/* E6-FIX: non-blocking engine sync warning — parley is locked but engine
            registration failed. Auto-retry fires in background; this banner persists
            until retry succeeds or user reloads. Does not block any functionality. */}
        {engineSyncError && page === "dashboard" && (
          <div style={{ marginBottom:10, padding:"8px 12px", borderRadius:8,
                        background:`${C.amber}12`, border:`1px solid ${C.amber}30`,
                        display:"flex", alignItems:"center", justifyContent:"space-between", gap:8 }}>
            <div style={{ fontSize:10, color:C.amber, lineHeight:1.4 }}>
              ⚠ Parley locked — engine sync pending. Will retry automatically.
            </div>
            <button onClick={() => {
              fetch(`${SERVER}/api/rollover/engine/pick`, {
                method:"POST", headers:{"Content-Type":"application/json", "X-User-ID": userId},
                body: JSON.stringify({ date, legs:pick?.legs || [], odds:pick?.totalOdds || 0 }),
              }).then(r => { if (r.ok) setEngineSyncError(false); }).catch(() => {});
            }} style={{ flexShrink:0, fontSize:9, fontWeight:700, color:C.amber,
                        background:"transparent", border:`1px solid ${C.amber}50`,
                        borderRadius:6, padding:"3px 10px", cursor:"pointer", fontFamily:C.font }}>
              Retry
            </button>
          </div>
        )}
        {page === "dashboard" && (
          <DashboardPage
            chain={chain} pick={pick} date={date} C={C} SERVER={SERVER}
            userId={userId}
            onRefresh={load} loading={loading}
            onDelete={() => {
              // BUG3-FIX: Don't call load() from onDeleted — it races with the
              // archive POST and may return the OLD active chain before the server
              // writes the pending blank, causing checkOnboarding to see "active"
              // and immediately close the welcome. Instead:
              // 1. Block slip build immediately
              // 2. Clear old chain/pick from local state
              // 3. Show welcome — it will call load() via onComplete after /init
              pendingOnboardRef.current = true;
              pickLoadedRef.current = false;   // allow fresh slip build after new chain starts
              lockedDateRef.current = null;
              setPick(null);
              setChain(null);
              setShowWelcome(true);
            }}
            fixtures={fixtures}
            onFullModel={onFullModel}
          />
        )}
        {page === "analytics" && (
          <AnalyticsPage chain={chain} C={C} SERVER={SERVER} loading={loading} />
        )}
        {page === "history" && (
          <HistoryPage history={history} C={C} loading={loading} />
        )}
      </div>
    </div>
  );
}
