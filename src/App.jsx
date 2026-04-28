import React, { useState, useMemo, useCallback, useEffect, useRef } from "react";
import { SERVER, LEAGUE_RANK } from "./config";
import { THEMES, THEME_MAP, loadSavedTheme, saveTheme, clampR } from "./themes";

const CACHE_KEY = "grm_cache_v15";
const todayStr  = () => new Date().toISOString().split("T")[0];

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
  return map[m] || { color:C.muted, bg:C.surface };
};

// ── STYLES INJECTION ──────────────────────────────────────────────────────
function injectStyles(T) {
  if (typeof document === "undefined") return;
  const old = document.getElementById("grm-styles");
  if (old) old.remove();
  const br = Math.min(T.btnRadius || 8, 30);
  // Slider track needs real contrast on both dark and light themes.
  // T.subtleBg is the same as the surface on light themes → invisible.
  // Use a fixed semi-opaque overlay that works on any background.
  const bg = (T.bg || "").toLowerCase();
  const isLight = bg.startsWith("#f") || bg === "#ffffff" || bg === "white" || bg.startsWith("rgba(255");
  T = { ...T, sliderTrack: isLight ? "rgba(0,0,0,0.18)" : "rgba(255,255,255,0.16)" };
  const s = document.createElement("style");
  s.id = "grm-styles";
  s.textContent = `
    @import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@300;400;600;700;800&display=swap');
    *{box-sizing:border-box;margin:0;padding:0}
    body{background:${T.bg};color:${T.text};font-family:${T.font}}
    ::-webkit-scrollbar{width:4px;height:4px}
    ::-webkit-scrollbar-track{background:transparent}
    ::-webkit-scrollbar-thumb{background:${T.scrollThumb||T.subtleBg};border-radius:4px}
    input[type=range]{-webkit-appearance:none;height:4px;border-radius:2px;background:${T.sliderTrack||T.borderHi||"rgba(128,128,128,0.25)"};outline:none;cursor:pointer}
    input[type=range]::-webkit-slider-thumb{-webkit-appearance:none;width:14px;height:14px;border-radius:50%;background:${T.accent};cursor:pointer}
    input[type=number]::-webkit-inner-spin-button{opacity:.4}
    .gc{background:${T.cardBg};backdrop-filter:blur(16px);border:1px solid ${T.border};border-radius:${T.cardRadius||12}px;transition:border-color .18s,background .18s}
    .gc:hover{border-color:${T.borderHi};background:${T.surfaceHi}}
    .gi{font-family:${T.font};background:${T.inputBg};border:1px solid ${T.border};border-radius:7px;color:${T.text};font-size:12px;padding:7px 10px;outline:none;transition:border-color .15s;width:100%}
    .gi:focus{border-color:${T.borderHi}}
    .gb{font-family:${T.font};font-weight:700;font-size:11px;letter-spacing:.08em;text-transform:uppercase;cursor:pointer;border-radius:${br}px;transition:all .15s;border:none}
    .gb:disabled{opacity:.35;cursor:not-allowed}
    .cb{height:3px;border-radius:2px;background:${T.subtleBg};overflow:hidden}
    .cf{height:100%;border-radius:2px;transition:width .4s ease}
    @keyframes fadeUp{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}
    .fa{animation:fadeUp .28s ease forwards}
    @keyframes pulse{0%,100%{opacity:1}50%{opacity:.4}}
    .pu{animation:pulse 1.4s ease infinite}
    @keyframes livePulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.6;transform:scale(1.15)}}
    .live-dot{animation:livePulse 1.2s ease infinite}
    @keyframes shimmer{0%{transform:translateX(-100%)}100%{transform:translateX(200%)}}
    @keyframes spinRing{to{transform:rotate(360deg)}}
    @keyframes marquee{0%{transform:translateX(100vw)}100%{transform:translateX(-100%)}}
    .ticker-track{display:inline-block;white-space:nowrap;animation:marquee 38s linear infinite}
    .ticker-track:hover{animation-play-state:paused}
    .cscroll{display:flex;gap:6px;overflow-x:auto;padding-bottom:4px}
    .cscroll::-webkit-scrollbar{height:2px}
    .filter-wrap{display:flex;flex-wrap:wrap;gap:5px}
    .drop-zone{border:2px dashed ${T.border};border-radius:12px;padding:32px;text-align:center;cursor:pointer;transition:all .18s}
    .drop-zone:hover,.drop-zone.drag-over{border-color:${T.radar};background:${T.radarDim}}
    @media(max-width:640px){
      .grm-grid{grid-template-columns:1fr !important}
      .grm-header-row{flex-wrap:wrap !important}
      .theme-label{display:none}
    }
  `;
  document.head.appendChild(s);
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

// ── FIXTURE STATUS BADGE ──────────────────────────────────────────────────
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
        <span className="live-dot" style={{ width:6,height:6,borderRadius:"50%",background:C.green,display:"inline-block" }}/>
        {label}
      </span>
    );
  }
  // Finished states
  if (["finished","ft","fulltime","ended","complete","aet","afterextratime","afterpenalties","3","5"].includes(s)) {
    return <span style={{ fontSize:8,color:C.text,fontWeight:700,letterSpacing:".1em" }}>FT</span>;
  }
  // Cancelled / postponed / suspended
  if (["cancelled","canceled","postponed","suspended","interrupted","abandoned"].includes(s)) {
    const lbl = s === "postponed" ? "PPD" : (s === "suspended" || s === "interrupted") ? "SUSP" : s === "abandoned" ? "ABD" : "CANC";
    return <span style={{ fontSize:8,color:C.amber,fontWeight:700,letterSpacing:".1em" }}>{lbl}</span>;
  }
  // Default: show kick-off time
  return <span style={{ fontSize:9,color:C.text }}>{time}</span>;
}

// ── JARVIS MIND BOX ───────────────────────────────────────────────────────
// Displayed at the top of the Live tab after fixtures load.
// Calls /api/jarvis-mindbox once after fetch to get the morning brief.
function JarvisMindBox({ fixtures, date, backtestSummary }) {
  const [mindbox, setMindbox]   = useState(null);
  const [loading, setLoading]   = useState(false);
  const [error, setError]       = useState(null);
  const [collapsed, setCollapsed] = useState(false);
  const calledRef = useRef(false);

  useEffect(() => {
    if (!fixtures?.length || calledRef.current) return;
    calledRef.current = true;
    setLoading(true);
    setError(null);
    fetch(`${SERVER}/api/jarvis-mindbox`, {
      method: "POST",
      headers: { "Content-Type":"application/json" },
      body: JSON.stringify({ fixtures, backtestSummary, date }),
    })
      .then(r => r.json())
      .then(d => { if (d.mindbox) setMindbox(d.mindbox); else setError("No mindbox data"); })
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));
  }, [fixtures, date]);

  // Reset when fixtures change (new fetch)
  useEffect(() => { calledRef.current = false; setMindbox(null); setError(null); }, [fixtures]);

  const riskColor = mindbox?.riskLevel === "LOW" ? C.green
                  : mindbox?.riskLevel === "HIGH" ? C.red
                  : C.amber;

  return (
    <div style={{ background:`linear-gradient(135deg,${C.surface} 0%,rgba(251,191,36,0.05) 100%)`,border:`1px solid ${C.goldBorder}`,borderRadius:12,padding:"14px 18px",marginBottom:18,position:"relative" }}>
      <div style={{ display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom: collapsed ? 0 : 10 }}>
        <div style={{ display:"flex",alignItems:"center",gap:8 }}>
          <span style={{ fontSize:10,fontWeight:800,color:C.gold,letterSpacing:".15em",textTransform:"uppercase" }}>⚡ Jarvis · Mind Box</span>
          {mindbox?.riskLevel && !collapsed && (
            <span style={{ fontSize:8,fontWeight:800,color:riskColor,background:`${riskColor}18`,border:`1px solid ${riskColor}40`,borderRadius:4,padding:"1px 7px",letterSpacing:".08em" }}>
              {mindbox.riskLevel} RISK
            </span>
          )}
        </div>
        <button onClick={() => setCollapsed(c => !c)} className="gb"
          style={{ background:"transparent",border:"none",color:C.muted,fontSize:10,padding:"0 4px" }}>
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
            <div style={{ fontSize:9,color:C.amber,display:"flex",alignItems:"center",gap:8,background:`${C.amber}08`,border:`1px solid ${C.amber}22`,borderRadius:6,padding:"8px 10px" }}>
              <span>
                {error.toLowerCase().includes("429") || error.toLowerCase().includes("rate") || error.toLowerCase().includes("quota")
                  ? "🤓 Jarvis is taking a breather — rate limit hit. Try again in a minute."
                  : error.toLowerCase().includes("network") || error.toLowerCase().includes("fetch") || error.toLowerCase().includes("failed")
                  ? "🤓 Jarvis couldn't connect — check your server connection."
                  : "🤓 Jarvis is busy right now. Tap Retry when ready."}
              </span>
              <button onClick={() => { calledRef.current = false; setMindbox(null); setError(null); }} className="gb"
                style={{ fontSize:8,padding:"2px 10px",background:"transparent",border:`1px solid ${C.amber}`,color:C.amber,flexShrink:0 }}>
                Retry
              </button>
            </div>
          )}
          {mindbox && !loading && (
            <div style={{ display:"flex",flexDirection:"column",gap:8 }}>
              {/* Brief */}
              <div style={{ fontSize:12,fontWeight:600,color:C.text,lineHeight:1.5,fontStyle:"italic" }}>
                "{mindbox.brief}"
              </div>

              {/* Risk reason + Navigation */}
              <div style={{ display:"grid",gridTemplateColumns:"1fr 1fr",gap:8 }}>
                {mindbox.riskReason && (
                  <div style={{ background:C.surface,borderRadius:8,padding:"8px 10px",border:`1px solid ${riskColor}25` }}>
                    <div style={{ fontSize:7,color:riskColor,fontWeight:800,letterSpacing:".1em",textTransform:"uppercase",marginBottom:3 }}>RISK</div>
                    <div style={{ fontSize:9,color:C.text,lineHeight:1.5 }}>{mindbox.riskReason}</div>
                  </div>
                )}
                {mindbox.marketOfDay && (
                  <div style={{ background:C.surface,borderRadius:8,padding:"8px 10px",border:`1px solid ${C.goldBorder}` }}>
                    <div style={{ fontSize:7,color:C.gold,fontWeight:800,letterSpacing:".1em",textTransform:"uppercase",marginBottom:3 }}>MARKET OF THE DAY</div>
                    <div style={{ fontSize:9,color:C.text,lineHeight:1.5 }}><strong>{mindbox.marketOfDay}</strong> — {mindbox.marketOfDayReason}</div>
                  </div>
                )}
              </div>

              {/* Warnings + Gems */}
              {((mindbox.warnings?.length > 0) || (mindbox.gems?.length > 0)) && (
                <div style={{ display:"grid",gridTemplateColumns:"1fr 1fr",gap:8 }}>
                  {mindbox.warnings?.length > 0 && (
                    <div style={{ background:`rgba(239,68,68,0.06)`,borderRadius:8,padding:"7px 10px",border:"1px solid C.redDim" }}>
                      <div style={{ fontSize:7,color:C.red,fontWeight:800,letterSpacing:".1em",textTransform:"uppercase",marginBottom:4 }}>⚠ AVOID</div>
                      {mindbox.warnings.map((w,i) => <div key={i} style={{ fontSize:8,color:C.red,lineHeight:1.5 }}>· {w}</div>)}
                    </div>
                  )}
                  {mindbox.gems?.length > 0 && (
                    <div style={{ background:`rgba(52,211,153,0.06)`,borderRadius:8,padding:"7px 10px",border:`1px solid ${C.green}30` }}>
                      <div style={{ fontSize:7,color:C.green,fontWeight:800,letterSpacing:".1em",textTransform:"uppercase",marginBottom:4 }}>💎 GEMS</div>
                      {mindbox.gems.map((g,i) => <div key={i} style={{ fontSize:8,color:C.green,lineHeight:1.5 }}>· {g}</div>)}
                    </div>
                  )}
                </div>
              )}

              {/* Navigation */}
              {mindbox.navigation && (
                <div style={{ fontSize:9,color:C.muted,lineHeight:1.5,borderTop:`1px solid ${C.border}`,paddingTop:7 }}>
                  🧭 <span style={{ color:C.text }}>{mindbox.navigation}</span>
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
function AskJarvis({ fixture, backtestSummary }) {
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
      const res = await fetch(`${SERVER}/api/jarvis-match`, {
        method: "POST",
        headers: { "Content-Type":"application/json" },
        body: JSON.stringify({ fixture, question: trimmed || undefined, backtestSummary }),
      });
      const data = await res.json();
      setResponse(data.analysis || data.error || "No response");
    } catch(e) {
      const msg = e.message || "";
      const isGemini = msg.toLowerCase().includes("gemini") || msg.toLowerCase().includes("429") || msg.toLowerCase().includes("503") || msg.toLowerCase().includes("rate");
      setResponse(isGemini
        ? "⚡ Jarvis hit a rate limit — the AI oracle is catching its breath. Try again in a few seconds."
        : "Error contacting Jarvis: " + msg
      );
    } finally {
      setLoading(false);
    }
  };

  const quickPrompts = [
    `Why ${fixture.theRead?.anchor?.pick || "this pick"}?`,
    "Any red flags for this match?",
    "Is BTTS worth it here?",
    "What's the xG telling us?",
  ];

  if (!open) {
    return (
      <button onClick={() => { setOpen(true); setTimeout(() => inputRef.current?.focus(), 50); }}
        className="gb"
        style={{ width:"100%",background:`${C.edge}10`,border:`1px solid ${C.edge}35`,color:C.edge,padding:"5px 0",fontSize:9,fontWeight:700,letterSpacing:".05em",marginTop:4 }}>
        ⚡ Ask Jarvis
      </button>
    );
  }

  return (
    <div style={{ marginTop:6,background:`${C.edge}08`,border:`1px solid ${C.edge}30`,borderRadius:8,padding:"10px 12px" }}>
      <div style={{ display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:6 }}>
        <span style={{ fontSize:8,fontWeight:800,color:C.edge,letterSpacing:".1em",textTransform:"uppercase" }}>⚡ Ask Jarvis</span>
        <button onClick={() => { setOpen(false); setResponse(null); setQuestion(""); }} className="gb"
          style={{ background:"transparent",border:"none",color:C.muted,fontSize:11,padding:0 }}>✕</button>
      </div>

      {/* Quick prompt chips */}
      <div style={{ display:"flex",gap:4,flexWrap:"wrap",marginBottom:6 }}>
        {quickPrompts.map((p,i) => (
          <button key={i} onClick={() => { setQuestion(p); ask(p); }} className="gb"
            style={{ fontSize:8,padding:"2px 8px",background:"transparent",border:`1px solid ${C.edge}30`,color:C.muted,borderRadius:4 }}>
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
        <button onClick={() => ask()} disabled={loading || !question.trim()} className="gb"
          style={{ background:loading||!question.trim()?C.faint:C.edge,color:loading||!question.trim()?C.muted:C.accentText,padding:"4px 12px",fontSize:9,fontWeight:700 }}>
          {loading ? <span className="pu">…</span> : "→"}
        </button>
      </div>

      {/* Response */}
      {loading && (
        <div style={{ fontSize:9,color:C.muted,fontStyle:"italic",marginTop:8 }}>
          <span className="pu">Jarvis is thinking…</span>
        </div>
      )}
      {response && !loading && (
        <div style={{ fontSize:9,color:C.text,lineHeight:1.6,marginTop:8,borderTop:`1px solid ${C.border}`,paddingTop:8 }}>
          {response}
          {response.includes("rate limit") && (
            <button onClick={() => ask(question)} className="gb"
              style={{ marginTop:8,display:"block",padding:"4px 14px",background:`${C.edge}18`,border:`1px solid ${C.edge}50`,color:C.edge,fontSize:9,fontWeight:700 }}>
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
    <div style={{ display:"inline-flex",alignItems:"center",gap:6,background:C.surface,border:`1px solid ${C.border}`,borderRadius:6,padding:"4px 10px" }}>
      <span style={{ fontSize:13,fontWeight:800,color:C.text,letterSpacing:"-.01em" }}>{score}</span>
      {ft && <span style={{ fontSize:8,color:C.muted,fontWeight:700 }}>FT</span>}
    </div>
  );
}

// ── CLIENT RESULT EVALUATOR ───────────────────────────────────────────────
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

// ── FORM ROW ──────────────────────────────────────────────────────────────
function FormRow({ home, away }) {
  const dot = r => ({ W:C.green, D:C.gold, L:C.red }[r] || C.faint);
  const dots = form => (form || []).slice(0, 5).map((r, i) =>
    <span key={i} style={{ width:8,height:8,borderRadius:"50%",background:dot(r),display:"inline-block",margin:"0 1px" }}/>
  );
  return (
    <div style={{ display:"flex",justifyContent:"space-between",alignItems:"center",marginTop:4 }}>
      <div>{dots(home)}</div>
      <div>{dots(away)}</div>
    </div>
  );
}

// ── THE READ SECTION ──────────────────────────────────────────────────────
// ── ADD TO TICKET WITH FEEDBACK ──────────────────────────────────────────
// Shows "✓ Added!" flash for 1.5s so the user knows the leg was registered.
// Also prevents duplicate add (button stays green if already in draft).
function AddToTicketBtn({ onClick, color, alreadyAdded, label }) {
  const [flash, setFlash] = useState(false);

  const handleClick = (e) => {
    e.stopPropagation();
    onClick(); // always allow — replaces existing leg
    setFlash(true);
    setTimeout(() => setFlash(false), 1500);
  };

  const done = flash;
  const btnColor = alreadyAdded ? C.green : (done ? C.green : color);
  return (
    <button onClick={handleClick} className="gb"
      style={{ marginTop:8,width:"100%",padding:"5px 0",background:done?`${C.green}18`:alreadyAdded?`${C.green}10`:`${color}18`,
               color:btnColor,border:`1px solid ${btnColor}40`,fontSize:9,fontWeight:700,
               transition:"all 0.2s",letterSpacing:".04em" }}>
      {done ? "✓ Added to Ticket" : alreadyAdded ? "↺ Replace in Ticket" : (label || "+ Add to Ticket")}
    </button>
  );
}

function TheReadSection({ theRead, onAddToParlay, fixture, alreadyAdded }) {
  if (!theRead) return null;
  const { anchor, reinforcer, isFallback, scenario } = theRead;
  if (!anchor) return null;

  const mst = mktStyle(anchor.market);
  const accentColor = isFallback ? C.muted : mst.color;
  const accentBg    = isFallback ? C.surface : mst.bg;

  return (
    <div style={{ background:accentBg, border:`1px solid ${accentColor}30`, borderRadius:9, padding:"10px 12px" }}>
      {/* Header row */}
      <div style={{ display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:6 }}>
        <div style={{ display:"flex",alignItems:"center",gap:6 }}>
          <span style={{ fontSize:8,color:accentColor,fontWeight:800,letterSpacing:".12em",textTransform:"uppercase" }}>
            {isFallback ? "THE READ · LOW SIGNAL" : "THE READ"}
          </span>
          {!isFallback && anchor.strong && (
            <span style={{ fontSize:7,color:C.gold,background:C.goldDim,border:`1px solid ${C.goldBorder}`,borderRadius:3,padding:"1px 5px",fontWeight:800,letterSpacing:".08em" }}>STRONG</span>
          )}
          {fixture.markets?._lowConfidence && (
            <span style={{ fontSize:7,color:C.amber,background:C.amberDim,border:`1px solid ${C.amber}30`,borderRadius:3,padding:"1px 4px" }}>⚠ LOW CONF</span>
          )}
        </div>
        {anchor.odds && (
          <span style={{ fontSize:10,color:C.text,fontWeight:700 }}>{anchor.odds}x</span>
        )}
      </div>

      {/* Anchor pick */}
      <div style={{ fontSize:14,fontWeight:800,color:accentColor,lineHeight:1.2,marginBottom:5 }}>
        {anchor.pick}
      </div>
      <div style={{ display:"flex",justifyContent:"space-between",alignItems:"center" }}>
        <span style={{ fontSize:12,fontWeight:800,color:accentColor }}>{Math.round(anchor.prob)}%</span>
        {!isFallback && <span style={{ fontSize:8,color:C.muted,fontStyle:"italic" }}>{scenario}</span>}
      </div>
      <Bar value={anchor.prob} color={accentColor} />

      {/* Reinforcer */}
      {reinforcer && (
        <div style={{ marginTop:8,paddingTop:8,borderTop:`1px solid ${accentColor}20` }}>
          <span style={{ fontSize:7,color:C.muted,textTransform:"uppercase",letterSpacing:".1em" }}>Reinforced by</span>
          <div style={{ marginTop:3,display:"flex",alignItems:"center",gap:8,flexWrap:"wrap" }}>
            <span style={{ fontSize:10,fontWeight:700,color:mktStyle(reinforcer.market).color }}>
              {reinforcer.pick}
            </span>
            {/* Combined O0.5 + O1.5 display */}
            {reinforcer.combined ? (
              <div style={{ display:"flex",gap:6,alignItems:"center" }}>
                <span style={{ fontSize:10,color:mktStyle(reinforcer.market).color,fontWeight:800 }}>
                  {Math.round(reinforcer.prob)}%
                </span>
                <span style={{ fontSize:8,color:C.faint }}>·</span>
                <span style={{ fontSize:8,color:C.muted }}>O1.5</span>
                <span style={{ fontSize:10,color:mktStyle(reinforcer.market).color,fontWeight:700 }}>
                  {Math.round(reinforcer.probO15)}%
                </span>
              </div>
            ) : (
              <div style={{ display:"flex",alignItems:"center",gap:6 }}>
                <span style={{ fontSize:10,fontWeight:800,color:mktStyle(reinforcer.market).color }}>
                  {Math.round(reinforcer.prob)}%
                </span>
                {reinforcer.odds && <span style={{ fontSize:9,color:C.muted }}>{reinforcer.odds}x</span>}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Add to ticket */}
      {onAddToParlay && !isFallback && (
        <AddToTicketBtn onClick={() => onAddToParlay(anchor)} color={accentColor} alreadyAdded={alreadyAdded} />
      )}
    </div>
  );
}

// ── THE EDGE SECTION ──────────────────────────────────────────────────────
function TheEdgeSection({ theEdge, onAddToParlay, alreadyAdded }) {
  if (!theEdge) return (
    <div style={{ background:C.surface,border:`1px solid ${C.border}`,borderRadius:9,padding:"10px 12px" }}>
      <span style={{ fontSize:8,color:C.muted,fontWeight:700,letterSpacing:".1em",textTransform:"uppercase" }}>THE EDGE — no signal</span>
    </div>
  );

  const isOdds = theEdge.type === "odds";
  return (
    <div style={{ background:C.edgeDim,border:`1px solid ${C.edgeBorder}`,borderRadius:9,padding:"10px 12px" }}>
      <div style={{ display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:6 }}>
        <div style={{ display:"flex",alignItems:"center",gap:6 }}>
          <span style={{ fontSize:8,color:C.edge,fontWeight:800,letterSpacing:".12em",textTransform:"uppercase" }}>THE EDGE</span>
          {isOdds && (
            <span style={{ fontSize:7,color:C.green,background:C.greenDim,border:`1px solid ${C.green}30`,borderRadius:3,padding:"1px 5px",fontWeight:800 }}>
              +{theEdge.edgeOddsPct}% vs BOOK
            </span>
          )}
          {theEdge.lowValue && (
            <span style={{ fontSize:7,color:C.amber,background:C.amberDim,border:`1px solid ${C.amber}30`,borderRadius:3,padding:"1px 5px",fontWeight:700 }}>
              value unclear
            </span>
          )}
          <span style={{ fontSize:7,color:C.edge,background:`${C.edge}15`,borderRadius:3,padding:"1px 5px" }}>
            {theEdge.convergenceCount} signals
          </span>
        </div>
        {theEdge.odds && <span style={{ fontSize:10,color:C.text }}>{theEdge.odds}x</span>}
      </div>
      <div style={{ fontSize:13,fontWeight:800,color:C.edge,lineHeight:1.2,marginBottom:4 }}>{theEdge.pick}</div>
      <div style={{ fontSize:8,color:C.muted,fontStyle:"italic",marginBottom:5,lineHeight:1.4 }}>{theEdge.narrative}</div>
      <div style={{ display:"flex",justifyContent:"space-between",alignItems:"center" }}>
        <span style={{ fontSize:12,fontWeight:800,color:C.edge }}>{Math.round(theEdge.prob)}%</span>
        <span style={{ fontSize:8,color:C.muted }}>Strength {theEdge.edgeStrength}</span>
      </div>
      <Bar value={theEdge.prob} color={C.edge} />
      {onAddToParlay && (
        <AddToTicketBtn onClick={() => onAddToParlay(theEdge)} color={C.edge} alreadyAdded={alreadyAdded} />
      )}
    </div>
  );
}

// ── GOAL RADAR SECTION ────────────────────────────────────────────────────
function GoalRadarSection({ goalRadar, onAddToParlay, alreadyAdded }) {
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
    return (
      <div key={entry.pick} style={{ flex:1,minWidth:120,background:`${C.radar}10`,borderRadius:6,padding:"6px 8px",border:`1px solid ${isExtra ? C.radar+"18" : C.radar+"25"}`,opacity:isExtra?0.85:1 }}>
        <div style={{ fontSize:9,color:C.text,fontWeight:700,marginBottom:2 }}>{entry.pick}</div>
        <div style={{ display:"flex",justifyContent:"space-between",alignItems:"center" }}>
          <span style={{ fontSize:13,fontWeight:800,color:C.radar }}>{Math.round(entry.prob)}%</span>
          {entry.odds && <span style={{ fontSize:9,color:C.muted }}>{entry.odds}x</span>}
        </div>
        <Bar value={entry.prob} color={C.radar} />
        {isExtra
          ? <div style={{ marginTop:5,fontSize:8,color:C.radar,fontStyle:"italic" }}>💡 O1.5 also strong — add via Custom Pick</div>
          : onAddToParlay && (
            <button onClick={() => handleAdd(entry)} className="gb"
              style={{ marginTop:5,width:"100%",padding:"3px 0",background:done?`${C.green}20`:alreadyAdded?`${C.green}10`:`${C.radar}18`,color:done||alreadyAdded?C.green:C.radar,border:`1px solid ${done||alreadyAdded?C.green:C.radar}40`,fontSize:8,transition:"all .2s" }}>
              {done ? "✓ Added!" : alreadyAdded ? "↺ Replace" : "+ Ticket"}
            </button>
          )
        }
      </div>
    );
  };

  return (
    <div style={{ background:C.radarDim,border:`1px solid ${C.radarBorder}`,borderRadius:9,padding:"10px 12px" }}>
      <span style={{ fontSize:8,color:C.radar,fontWeight:800,letterSpacing:".12em",textTransform:"uppercase" }}>🎯 GOAL RADAR</span>
      <div style={{ display:"flex",gap:10,marginTop:6,flexWrap:"wrap" }}>
        {home && renderEntry(home)}
        {homeExtra && renderEntry(homeExtra, true)}
        {away && renderEntry(away)}
        {awayExtra && renderEntry(awayExtra, true)}
      </div>
    </div>
  );
}

// ── COMBO ROW ─────────────────────────────────────────────────────────────
function ComboRow({ combo }) {
  const color = combo.type === "DC" ? C.dc : C.radar;
  return (
    <div style={{ background:C.surface,border:`1px solid ${color}25`,borderRadius:7,padding:"7px 10px",marginTop:5 }}>
      <div style={{ display:"flex",justifyContent:"space-between",alignItems:"center" }}>
        <span style={{ fontSize:9,color,fontWeight:700 }}>{combo.label}</span>
        <span style={{ fontSize:10,color,fontWeight:800 }}>{combo.prob}%</span>
      </div>
      <div style={{ display:"flex",gap:5,marginTop:4,flexWrap:"wrap" }}>
        {combo.picks.map((p, i) => (
          <span key={i} style={{ fontSize:8,color:C.muted,background:C.surface,border:`1px solid ${C.border}`,borderRadius:3,padding:"2px 6px" }}>
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
          <span style={{ fontSize:8,color:C.muted }}>
            xG <span style={{ color:C.text,fontWeight:700 }}>{m.homeXG}</span>
            {" – "}
            <span style={{ color:C.text,fontWeight:700 }}>{m.awayXG}</span>
          </span>
        </div>
        {f.goalInsight && <div style={{ fontSize:8,color:C.muted,fontStyle:"italic",lineHeight:1.4 }}>{f.goalInsight}</div>}
      </div>
      {[
        { l:"O1.5", prob:m.over15,  odds:f.odds?.over15odds  },
        { l:"O2.5", prob:m.over25,  odds:f.odds?.over25odds  },
        { l:"O3.5", prob:m.over35,  odds:f.odds?.over35odds  },
        { l:"U2.5", prob:m.under25, odds:f.odds?.under25odds },
        { l:"U3.5", prob:m.under35, odds:f.odds?.under35odds },
      ].map(r => (
        <div key={r.l} style={{ display:"flex",alignItems:"center",marginBottom:2 }}>
          <span style={{ fontSize:8,color:C.muted,width:28 }}>{r.l}</span>
          <div style={{ flex:1,height:2,background:C.faint,borderRadius:2,margin:"0 6px",overflow:"hidden" }}>
            <div style={{ height:"100%",width:`${r.prob || 0}%`,background:C.orange,borderRadius:2 }}/>
          </div>
          <span style={{ fontSize:8,color:C.orange,fontWeight:700,width:28,textAlign:"right" }}>
            {r.prob ? `${Math.round(r.prob)}%` : "—"}
          </span>
          <span style={{ fontSize:7,color:C.muted,width:30,textAlign:"right" }}>
            {r.odds ? `${r.odds}x` : ""}
          </span>
        </div>
      ))}
      <div style={{ marginTop:7,display:"inline-flex",alignItems:"center",gap:5,
        background:scoreBright ? C.goldDim : "transparent",
        border:scoreBright ? `1px solid ${C.goldBorder}` : "1px solid transparent",
        borderRadius:5,padding:scoreBright ? "3px 8px" : "0" }}>
        <span style={{ fontSize:8,color:C.muted }}>Likely</span>
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
      setError(e.message);
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
          🎟️ Book Now
        </button>
      ) : (
        <div style={{ background:C.accentDim,border:`1px solid ${C.accentBorder}`,borderRadius:8,padding:"10px 12px" }}>
          <div style={{ display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:8 }}>
            <span style={{ fontSize:8,fontWeight:800,color:C.gold,letterSpacing:".1em",textTransform:"uppercase" }}>🎟️ Book Now</span>
            <button onClick={() => { setOpen(false); setResult(null); setError(null); }} className="gb"
              style={{ background:"transparent",border:"none",color:C.muted,fontSize:11,padding:0 }}>✕</button>
          </div>

          {/* Bookmaker selector (SportyBet only for now) */}
          <div style={{ fontSize:8,color:C.muted,marginBottom:8 }}>
            Bookmaker: <span style={{ color:C.gold,fontWeight:700 }}>SportyBet NG</span>
            <span style={{ fontSize:7,color:C.faint,marginLeft:6 }}>(more coming)</span>
          </div>

          {/* Pick preview */}
          <div style={{ background:C.surface,borderRadius:6,padding:"6px 10px",marginBottom:8,border:`1px solid ${C.border}` }}>
            <div style={{ fontSize:7,color:C.muted,marginBottom:2 }}>PICK</div>
            <div style={{ fontSize:10,color:C.text,fontWeight:700 }}>{fixture.theRead?.anchor?.pick}</div>
            <div style={{ fontSize:8,color:C.muted }}>{fixture.teams.home} vs {fixture.teams.away} · {fixture.theRead?.anchor?.market}</div>
          </div>

          {/* Book button */}
          {!result && !error && (
            <button onClick={book} disabled={booking} className="gb"
              style={{ width:"100%",background:booking?C.faint:C.accent,color:booking?C.muted:C.accentText,padding:"7px 0",fontWeight:800,fontSize:10 }}>
              {booking ? <span className="pu">Booking…</span> : "Generate Booking Code"}
            </button>
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
              <div style={{ fontSize:7,color:C.green,fontWeight:800,letterSpacing:".1em",textTransform:"uppercase",marginBottom:4 }}>✓ BOOKING CODE</div>
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
                <div style={{ fontSize:7,color:C.muted,marginTop:5,wordBreak:"break-all" }}>
                  {result.shareURL}
                </div>
              )}
              {result.failed?.length > 0 && (
                <div style={{ fontSize:7,color:C.amber,marginTop:5 }}>
                  ⚠ {result.failed.length} leg(s) not found: {result.failed.join(", ")}
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
function FixtureCard({ f, onAddToParlay, onBack, draftLegs, isEngineQualified }) {
  const [expanded, setExpanded]     = useState(false);
  const [fetchingResult, setFetchingResult] = useState(false);
  const [localResult, setLocalResult]       = useState(null);
  const [finishedFlash, setFinishedFlash] = useState("");
  const m = f.markets;

  const isAlreadyInDraft = Array.isArray(draftLegs) && draftLegs.some(l => l.fixtureId === f.id);

  const handleAddAnchor = useCallback((pick) => {
    if (!onAddToParlay) return;
    // Finished game — show brief visual warning instead of silently ignoring
    const state = (f.state || "").toLowerCase().replace(/[_\-\s]/g, "");
    if (["finished","ft","fulltime","ended","complete","aet","afterextratime","afterpenalties"].includes(state)) {
      setFinishedFlash("⏱ Match is finished — result is already in");
      setTimeout(() => setFinishedFlash(""), 2500);
      return;
    }
    const io = p => (p > 0 && p < 100) ? parseFloat((1 / (p / 100)).toFixed(2)) : null;
    const resolvedOdds = pick.odds || io(pick.prob);
    // Don't block — sportybet.js books by pick text, not odds.
    // Null odds just shows "—" in the ticket; parlay math falls back to ×1.
    if (!resolvedOdds && !pick.prob) {
      setFinishedFlash("⚠ No model data — adding anyway, odds will show as —");
      setTimeout(() => setFinishedFlash(""), 2500);
    }
    onAddToParlay(f, {
      pick:   pick.pick,
      prob:   pick.prob,
      odds:   resolvedOdds || null,
      market: pick.market,
    });
  }, [f, onAddToParlay]);

  // Per-card result fetch (Issue 2)
  const fetchCardResult = async () => {
    setFetchingResult(true);
    try {
      const date = (f.startingAt || "").split("T")[0] || todayStr();
      await fetch(`${SERVER}/api/fetch-results?date=${date}`, { headers:{"x-admin-token":"sterling77"} });
      // Re-load snapshot to get updated scores
      const res  = await fetch(`${SERVER}/api/load-snapshot?date=${date}`);
      const data = await res.json();
      const updated = (data.data || []).find(x => x.id === f.id);
      if (updated?.hGoals != null) setLocalResult({ hGoals: updated.hGoals, aGoals: updated.aGoals, state: updated.state });
    } catch {}
    setFetchingResult(false);
  };

  const displayF = localResult ? { ...f, ...localResult } : f;

  return (
    <div className="gc fa" style={{ padding:"14px 16px",display:"flex",flexDirection:"column",gap:10 }}>
      {/* Score badge — shows live result; per-card Fetch button if no score yet */}
      {displayF.hGoals != null ? (
        <div style={{ display:"flex",justifyContent:"center",alignItems:"center",gap:8 }}>
          <ResultBadge f={displayF} />
          <button onClick={fetchCardResult} disabled={fetchingResult} className="gb"
            style={{ background:"transparent",border:`1px solid ${C.faint}`,color:C.faint,padding:"2px 8px",fontSize:8 }}>
            {fetchingResult ? <span className="pu">…</span> : "↺"}
          </button>
        </div>
      ) : (
        <div style={{ display:"flex",justifyContent:"flex-end" }}>
          <button onClick={fetchCardResult} disabled={fetchingResult} className="gb"
            style={{ background:"transparent",border:`1px solid ${C.faint}`,color:C.text,padding:"2px 8px",fontSize:8 }}>
            {fetchingResult ? <span className="pu">…</span> : "↺ Result"}
          </button>
        </div>
      )}

      {/* Header */}
      <div style={{ display:"flex",justifyContent:"space-between",alignItems:"flex-start",gap:8 }}>
        <div style={{ display:"flex",gap:5,alignItems:"center",flexWrap:"wrap",flex:1 }}>
          <span style={{ fontSize:9,color:C.text }}>{f.league}</span>
          {isEngineQualified && (
            <span style={{ fontSize:7,fontWeight:800,color:C.accentText,background:C.accent,borderRadius:4,padding:"1px 6px",letterSpacing:".05em" }}>⚡ ENGINE</span>
          )}
          {f.volatileLeague && (
            <span style={{ fontSize:7,color:C.amber,background:C.amberDim,border:`1px solid ${C.amber}30`,borderRadius:3,padding:"1px 5px",fontWeight:700 }}>⚠ VOLATILE</span>
          )}
          {f.markets?._lowConfidence && (
            <span style={{ fontSize:7,color:C.muted,background:C.surface,border:`1px solid ${C.border}`,borderRadius:3,padding:"1px 5px",fontWeight:700,opacity:.7 }}>LIMITED DATA</span>
          )}
          {f.strategyTags?.length > 0 && f.strategyTags.map(t => (
            <span key={t} style={{ fontSize:7,color:C.gold,fontWeight:800,background:C.goldDim,border:`1px solid ${C.goldBorder}`,borderRadius:4,padding:"1px 5px",letterSpacing:".06em" }}>
              {STRATEGY_LABELS[t] || t}
            </span>
          ))}
        </div>
        <div style={{ display:"flex",flexDirection:"column",alignItems:"flex-end",gap:2 }}>
          <StatusBadge state={displayF.state} time={f.time} />
          {f.oddsAt && (
            <span style={{ fontSize:6,color:C.text }}>
              odds {new Date(f.oddsAt).toLocaleTimeString([],{hour:"2-digit",minute:"2-digit"})}
            </span>
          )}
        </div>
      </div>

      {/* Teams + form + table */}
      <div>
        <div style={{ display:"flex",justifyContent:"space-between",alignItems:"center" }}>
          <span style={{ fontSize:13,fontWeight:800,color:C.text,flex:1,lineHeight:1.3 }}>{f.teams.home}</span>
          <span style={{ fontSize:9,color:C.text,padding:"0 10px",flexShrink:0 }}>vs</span>
          <span style={{ fontSize:13,fontWeight:800,color:C.text,flex:1,textAlign:"right",lineHeight:1.3 }}>{f.teams.away}</span>
        </div>
        {f.form && (f.form.home?.length > 0 || f.form.away?.length > 0) && (
          <FormRow home={f.form.home} away={f.form.away} />
        )}
        {f.tablePosition && (f.tablePosition.homePosition || f.tablePosition.awayPosition) && (
          <div style={{ display:"flex",justifyContent:"space-between",marginTop:4 }}>
            <span style={{ fontSize:8,color:C.text }}>
              #{f.tablePosition.homePosition || "—"}{f.tablePosition.homePoints != null && ` · ${f.tablePosition.homePoints}pts`}
            </span>
            <span style={{ fontSize:8,color:C.text }}>
              #{f.tablePosition.awayPosition || "—"}{f.tablePosition.awayPoints != null && ` · ${f.tablePosition.awayPoints}pts`}
            </span>
          </div>
        )}
      </div>

      {/* Finished-game add warning */}
      {finishedFlash && (
        <div style={{ background:"rgba(248,113,113,0.1)",border:"1px solid rgba(248,113,113,0.3)",borderRadius:7,padding:"5px 10px",fontSize:9,color:C.red,fontWeight:700,textAlign:"center" }}>
          {finishedFlash}
        </div>
      )}

      {/* THE READ */}
      <TheReadSection
        theRead={f.theRead}
        fixture={f}
        onAddToParlay={onAddToParlay ? handleAddAnchor : null}
        alreadyAdded={isAlreadyInDraft}
      />

      {/* THE EDGE */}
      <TheEdgeSection
        theEdge={f.theEdge}
        alreadyAdded={isAlreadyInDraft}
        onAddToParlay={onAddToParlay ? (pick) => handleAddAnchor({ ...pick, market: pick.market }) : null}
      />

      {/* GOAL RADAR (only if qualifying) */}
      {f.goalRadar && (
        <GoalRadarSection
          goalRadar={f.goalRadar}
          alreadyAdded={isAlreadyInDraft}
          onAddToParlay={onAddToParlay ? (entry) => handleAddAnchor({ ...entry, market: "TeamTotal" }) : null}
        />
      )}

      {/* CUSTOM PICK — inline, below all signals */}
      <FixtureBookNow fixture={f} onAddToParlay={onAddToParlay ? handleAddAnchor : null} />

      {/* Expand toggle */}
      <button onClick={() => setExpanded(e => !e)} className="gb"
        style={{ background:"transparent",border:`1px solid ${C.border}`,color:C.muted,padding:"5px 0",fontSize:9,width:"100%" }}>
        {expanded ? "▲ Collapse" : "▼ Full Model"}
      </button>

      {/* ASK JARVIS — per card */}
      <AskJarvis fixture={f} backtestSummary={null} />

      {/* EXPANDED STATE */}
      {expanded && (
        <div style={{ display:"flex",flexDirection:"column",gap:10 }}>
          {/* xG bar */}
          <div style={{ background:C.surface,borderRadius:8,padding:"8px 12px",border:`1px solid ${C.border}` }}>
            <div style={{ fontSize:8,color:C.muted,textTransform:"uppercase",letterSpacing:".1em",marginBottom:6 }}>Expected Goals ({f.xgSource})</div>
            <div style={{ display:"flex",alignItems:"center",gap:8 }}>
              <span style={{ fontSize:10,fontWeight:700,color:C.text,width:36,textAlign:"right" }}>{m.homeXG}</span>
              <div style={{ flex:1,height:4,background:C.faint,borderRadius:2,overflow:"hidden",position:"relative" }}>
                <div style={{ position:"absolute",left:0,top:0,height:"100%",width:`${(m.homeXG/(m.homeXG+m.awayXG))*100}%`,background:C.gold,borderRadius:2 }}/>
              </div>
              <span style={{ fontSize:10,fontWeight:700,color:C.text,width:36 }}>{m.awayXG}</span>
            </div>
            <div style={{ display:"flex",justifyContent:"space-between",marginTop:3 }}>
              <span style={{ fontSize:7,color:C.muted }}>atk {m.homeAttackStrength?.toFixed(2)} def {m.homeDefenceStrength?.toFixed(2)}</span>
              <span style={{ fontSize:7,color:C.muted }}>atk {m.awayAttackStrength?.toFixed(2)} def {m.awayDefenceStrength?.toFixed(2)}</span>
            </div>
            {m._calibrationWeight > 0 && (
              <div style={{ fontSize:8,color:C.muted,marginTop:3,textAlign:"center" }}>
                {m._calibrationWeight}% calibrated · {m._seasonGames} season games · {m._recentLeagueGames} recent
              </div>
            )}
          </div>

          {/* Stats grid */}
          <div style={{ display:"grid",gridTemplateColumns:"1fr 1fr",gap:8 }}>
            <Panel label="Match Result" color={C.blue} bg={C.blueDim}>
              {[
                { l:"H", prob:m.homeWin, odds:f.odds?.o1 },
                { l:"X", prob:m.draw,    odds:f.odds?.oX },
                { l:"A", prob:m.awayWin, odds:f.odds?.o2 },
              ].map(r => (
                <div key={r.l} style={{ display:"flex",alignItems:"center",marginBottom:3,gap:4 }}>
                  <span style={{ fontSize:9,color:C.muted,width:10 }}>{r.l}</span>
                  <div style={{ flex:1,height:3,background:C.faint,borderRadius:2,overflow:"hidden" }}>
                    <div style={{ height:"100%",width:`${r.prob || 0}%`,background:C.blue,borderRadius:2 }}/>
                  </div>
                  <span style={{ fontSize:9,color:C.blue,fontWeight:700,width:28,textAlign:"right" }}>{r.prob ? `${Math.round(r.prob)}%` : "—"}</span>
                  {r.odds && <span style={{ fontSize:8,color:C.muted,width:32,textAlign:"right" }}>{r.odds}x</span>}
                </div>
              ))}
            </Panel>
            <GoalsPanel f={f} />

            <Panel label="BTTS" color={C.purple} bg={C.purpleDim}>
              <div style={{ display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:8 }}>
                <div>
                  <div style={{ fontSize:9,color:C.muted,marginBottom:2 }}>Yes</div>
                  <div style={{ fontSize:18,fontWeight:800,color:m.bttsYes >= 60 ? C.purple : C.muted }}>{Math.round(m.bttsYes)}%</div>
                  <div style={{ fontSize:8,color:m.bttsYes >= 60 ? C.purple : C.text,fontWeight:700 }}>
                    {m.bttsYes >= 60 ? "QUALIFIED ✓" : "Below threshold"}
                  </div>
                </div>
                <div style={{ textAlign:"right" }}>
                  <div style={{ fontSize:9,color:C.text,marginBottom:2 }}>No</div>
                  <div style={{ fontSize:11,fontWeight:700,color:C.text }}>{Math.round(m.bttsNo)}%</div>
                  {f.odds?.bttsYesOdds && <div style={{ fontSize:9,color:C.text,marginTop:4 }}>Odds {f.odds.bttsYesOdds}x</div>}
                </div>
              </div>
              <Bar value={m.bttsYes} color={C.purple} />
            </Panel>

            <Panel label="Team Totals" color={C.radar} bg={C.radarDim}>
              {[
                { name:f.teams.home, o05:m.homeOver05, o15:m.homeOver15, cs:m.homeCS, stats:f.teamStats?.home },
                { name:f.teams.away, o05:m.awayOver05, o15:m.awayOver15, cs:m.awayCS, stats:f.teamStats?.away },
              ].map(t => (
                <div key={t.name} style={{ marginBottom:8 }}>
                  <div style={{ fontSize:10,color:C.radar,fontWeight:700,marginBottom:3,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap" }}>{t.name}</div>
                  <div style={{ display:"flex",gap:10,alignItems:"center",flexWrap:"wrap" }}>
                    <span style={{ fontSize:11,color:C.text }}>
                      O0.5 <span style={{ color:t.o05 >= 90 ? C.radar : C.silver,fontWeight:700 }}>{Math.round(t.o05)}%</span>
                    </span>
                    <span style={{ fontSize:11,color:C.text }}>
                      O1.5 <span style={{ color:t.o15 >= 65 ? C.radar : C.silver,fontWeight:700 }}>{Math.round(t.o15)}%</span>
                    </span>
                    <span style={{
                      fontSize:11,
                      color:t.cs >= 30 ? C.green : C.silver,
                      fontWeight:t.cs >= 30 ? 800 : 600,
                      background:t.cs >= 30 ? C.greenDim : "transparent",
                      border:t.cs >= 30 ? `1px solid ${C.green}30` : "1px solid transparent",
                      borderRadius:4, padding:t.cs >= 30 ? "1px 5px" : "0",
                    }}>
                      CS {Math.round(t.cs)}%
                    </span>
                  </div>
                  {t.stats && (
                    <div style={{ display:"flex",gap:8,marginTop:4,flexWrap:"wrap" }}>
                      {t.stats.scoredRate != null && (
                        <span style={{ fontSize:7,color:C.muted }}>
                          Scored <span style={{ color:t.stats.scoredRate >= 70 ? C.green : C.silver,fontWeight:700 }}>{t.stats.scoredRate}%</span>
                          {t.stats.played ? <span style={{ color:C.faint }}> ({t.stats.played}g)</span> : ""}
                        </span>
                      )}
                      {t.stats.ftsRate != null && (
                        <span style={{ fontSize:7,color:C.muted }}>
                          FTS <span style={{ color:t.stats.ftsRate >= 30 ? C.red : C.silver,fontWeight:700 }}>{t.stats.ftsRate}%</span>
                        </span>
                      )}
                    </div>
                  )}
                </div>
              ))}
            </Panel>
          </div>

          {/* Combos */}
          {f.combos?.length > 0 && (
            <div>
              <div style={{ fontSize:7,color:C.dc,fontWeight:800,textTransform:"uppercase",letterSpacing:".1em",marginBottom:4 }}>Combo Suggestions</div>
              {f.combos.map((combo, i) => <ComboRow key={i} combo={combo} />)}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── GOAL RADAR LIST VIEW ──────────────────────────────────────────────────
function GoalRadarTab({ fixtures, onAddToParlay, search }) {
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
    <div style={{ textAlign:"center",padding:"60px 0",color:C.faint,fontSize:11,textTransform:"uppercase",letterSpacing:".15em" }}>
      No Goal Radar picks today
    </div>
  );

  return (
    <div>
      <div style={{ display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:14 }}>
        <div>
          <div style={{ fontSize:10,fontWeight:800,color:C.radar,letterSpacing:".1em",textTransform:"uppercase" }}>🎯 Goal Radar · {entries.length} picks</div>
          <div style={{ fontSize:8,color:C.muted,marginTop:2 }}>O0.5 at {entries[0] ? Math.round(entries[0].prob) : 85}%+ · O1.5 where qualifying · implied odds</div>
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
                  {e.isExtra && <span style={{ fontSize:7,color:C.amber,background:`${C.amber}15`,borderRadius:3,padding:"1px 5px",marginLeft:4,fontWeight:800 }}>💡 advisory</span>}
                </div>
                <div style={{ fontSize:8,color:C.muted }}>{f.teams.home} vs {f.teams.away} · {f.league}</div>
              </div>
              <div style={{ fontSize:8,color:C.muted,textAlign:"center" }}>
                <StatusBadge state={f.state} time={f.time} />
              </div>
              <span style={{ fontSize:13,fontWeight:800,color:C.radar }}>{Math.round(e.prob)}%</span>
              <span style={{ fontSize:10,fontWeight:700,color:C.muted,textAlign:"right" }}>
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

// ── CUSTOM LIST VIEW ──────────────────────────────────────────────────────
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
  { id:"theRead",   label:"📖 The Read"   },
  { id:"theEdge",   label:"🔮 The Edge"   },
  { id:"goalRadar", label:"🎯 Goal Radar" },
  { id:"over15",label:"O1.5" }, { id:"over25",label:"O2.5" }, { id:"over35",label:"O3.5" }, { id:"over45",label:"O4.5" },
  { id:"under15",label:"U1.5" }, { id:"under25",label:"U2.5" }, { id:"under35",label:"U3.5" }, { id:"under45",label:"U4.5" },
  { id:"bttsyes",label:"BTTS Yes" }, { id:"bttsno",label:"BTTS No" },
  { id:"homewin",label:"Home Win" }, { id:"draw",label:"Draw" }, { id:"awaywin",label:"Away Win" },
  { id:"homeo05",label:"H O0.5" }, { id:"homeo15",label:"H O1.5" }, { id:"awayo05",label:"A O0.5" }, { id:"awayo15",label:"A O1.5" },
];

const STRATEGY_LABELS = {
  home_win:"🏠 Home Win", away_win:"✈ Away Win", btts_value:"⚽ BTTS Value",
  home_goalfest:"⚡ H Goalfest", away_goalfest:"⚡ A Goalfest",
  over25_quality:"📈 O2.5 Quality", low_scoring:"🔒 Low Scoring",
  draw:"〰 Draw",
};

function xgHomeDominant(f){ return f.markets.homeXG >= f.markets.awayXG*2 && (f.markets.homeXG - f.markets.awayXG) >= 1; }
function xgAwayDominant(f){ return f.markets.awayXG >= f.markets.homeXG*2 && (f.markets.awayXG - f.markets.homeXG) >= 1; }

const makeStatFilters = (xgT) => [
  { id:"has_read",      label:"Has Read",       desc:"Has a non-fallback Read pick",    fn:f=>!!(f.theRead && !f.theRead.isFallback) },
  { id:"has_edge",      label:"Has Edge",        desc:"Edge signal found",               fn:f=>!!f.theEdge },
  { id:"has_radar",     label:"Goal Radar",      desc:"At least one team in Goal Radar", fn:f=>!!f.goalRadar },
  { id:"btts_q",        label:"BTTS ≥63%",       desc:"BTTS Yes ≥63%",                   fn:f=>f.markets.bttsYes>=63 },
  { id:"xg_both",       label:`Both xG ≥${xgT}`, desc:`Both xG ≥${xgT}`,                fn:f=>f.markets.homeXG>=xgT&&f.markets.awayXG>=xgT },
  { id:"xg_home",       label:"Home xG Dom",     desc:"Home xG 2× away",                fn:f=>xgHomeDominant(f) },
  { id:"xg_away",       label:"Away xG Dom",     desc:"Away xG 2× home",                fn:f=>xgAwayDominant(f) },
  { id:"cs_home",       label:"Home CS ≥30%",    desc:"Home clean sheet ≥30%",           fn:f=>f.markets.homeCS>=30 },
  { id:"cs_away",       label:"Away CS ≥30%",    desc:"Away clean sheet ≥30%",           fn:f=>f.markets.awayCS>=30 },
  { id:"def_weak_home", label:"H Def Weak",      desc:"Home CS < 20%",                   fn:f=>f.markets.homeCS<20 },
  { id:"def_weak_away", label:"A Def Weak",       desc:"Away CS < 20%",                   fn:f=>f.markets.awayCS<20 },
  { id:"homewin_str",   label:"H Win ≥65%",      desc:"Home win ≥65%",                   fn:f=>f.markets.homeWin>=65 },
  { id:"awaywin_str",   label:"A Win ≥55%",      desc:"Away win ≥55%",                   fn:f=>f.markets.awayWin>=55 },
  { id:"low_xg",        label:"Low xG",          desc:"Total xG < 2.0",                  fn:f=>(f.markets.homeXG+f.markets.awayXG)<2.0 },
  { id:"volatile",      label:"Volatile",        desc:"Volatile league",                 fn:f=>!!f.volatileLeague },
  { id:"live",          label:"🔴 LIVE",         desc:"Currently in progress",           fn:f=>{ const s=(f.state||"").toLowerCase(); return ["inprogress","live","1h","1sthalf","ht","halftime","2h","2ndhalf","et","extratime","penaltyshootout"].includes(s); } },
  { id:"scheduled",     label:"⏰ Upcoming",     desc:"Not yet started",                 fn:f=>{ const s=(f.state||"").toLowerCase(); return s===""||s==="notstarted"||s==="scheduled"||s==="prematch"; } },
  // Draw-specific filters — mirrors server STRATEGY_DEFS.draw
  { id:"draw_prob",     label:"Draw ≥30%",       desc:"Draw probability ≥30%",           fn:f=>f.markets.draw>=30 },
  { id:"draw_balanced", label:"Balanced",        desc:"|homeWin−awayWin| ≤15",           fn:f=>Math.abs((f.markets.homeWin||0)-(f.markets.awayWin||0))<=15 },
  { id:"draw_xg_range", label:"xG 1.4–2.6",     desc:"Total xG between 1.4 and 2.6",    fn:f=>{ const t=(f.markets.homeXG||0)+(f.markets.awayXG||0); return t>=1.4&&t<=2.6; } },
];

const STRATEGIES_UI = [
  { id:"home_win",      label:"🏠 Home Win",    filters:["homewin_str"],           family:"homewin",  desc:"Home xG gap ≥0.9 · homeXG ≥1.4 · homeWin ≥65%" },
  { id:"away_win",      label:"✈ Away Win",     filters:["awaywin_str"],           family:"awaywin",  desc:"Away xG gap ≥0.7 · awayXG ≥1.2 · awayWin ≥55%" },
  { id:"btts_value",    label:"⚽ BTTS Value",  filters:["btts_q"],                family:"bttsyes",  desc:"BTTS ≥65% · homeO05 ≥75% · awayO05 ≥70%" },
  { id:"home_goalfest", label:"⚡ H Goalfest",  filters:["homewin_str"],           family:"homeo05",  desc:"homeXG ≥2.2 · homeO05 ≥88% · homeWin ≥62%" },
  { id:"away_goalfest", label:"⚡ A Goalfest",  filters:["awaywin_str"],           family:"awayo05",  desc:"awayXG ≥2.0 · awayO05 ≥85% · awayWin ≥55%" },
  { id:"over25_quality",label:"📈 O2.5 Quality",filters:["xg_both","btts_q"],     family:"over25",   desc:"O2.5 ≥70% · total xG ≥2.6 · BTTS ≥55%" },
  { id:"low_scoring",   label:"🔒 Low Scoring", filters:["cs_home","cs_away"],     family:"under25",  desc:"homeCS AND awayCS ≥30% · total xG <2.0 · U2.5 ≥65%" },
  { id:"draw",          label:"〰 Draw",         filters:["draw_prob","draw_balanced","draw_xg_range"], family:"draw", desc:"draw ≥30% · |homeWin−awayWin| ≤15 · total xG 1.4–2.6" },
];

function CustomListView({ fixtures, search, onAddToTicket, onAddToParlay, draftLegs }) {
  const isMobile = useIsMobile();
  const [family, setFamily] = useState("theRead");
  const [statFilters, setStatFilters] = useState([]);
  const [selected, setSelected] = useState(null);
  const [xgThreshold, setXgThreshold] = useState(1.5);
  const [activeStrategy, setActiveStrategy] = useState(null);
  const [selectedIds, setSelectedIds] = useState(new Set());

  const toggleSelect = id => setSelectedIds(prev => { const n=new Set(prev); n.has(id)?n.delete(id):n.add(id); return n; });
  const clearSelection = () => setSelectedIds(new Set());
  const STAT_FILTERS = useMemo(() => makeStatFilters(xgThreshold), [xgThreshold]);
  const toggleStat = id => setStatFilters(prev => prev.includes(id) ? prev.filter(x=>x!==id) : [...prev, id]);

  const applyStrategy = strat => {
    if (activeStrategy === strat.id) { setActiveStrategy(null); setStatFilters([]); }
    else { setActiveStrategy(strat.id); setStatFilters(strat.filters); setFamily(strat.family); }
  };

  const rows = useMemo(() => {
    const s = search.toLowerCase();
    return fixtures
      .filter(f => !s || f.teams.home.toLowerCase().includes(s) || f.teams.away.toLowerCase().includes(s) || f.league.toLowerCase().includes(s))
      .filter(f => statFilters.every(id => { const sf = STAT_FILTERS.find(x => x.id === id); return sf ? sf.fn(f) : true; }))
      .map(f => ({ f, pick: getCustomPick(f, family) }))
      .filter(r => r.pick && r.pick.prob > 0)
      .sort((a, b) => b.pick.prob - a.pick.prob);
  }, [fixtures, family, search, statFilters, STAT_FILTERS]);

  const saveListToJSON = () => {
    const payload = {
      date: todayStr(), savedAt: new Date().toISOString(), family,
      count: rows.length,
      rows: rows.map(({ f, pick }) => ({
        id:f.id, league:f.league, home:f.teams.home, away:f.teams.away, time:f.time,
        pick:pick.label, prob:Math.round(pick.prob), odds:pick.odds,
        homeXG:f.markets.homeXG, awayXG:f.markets.awayXG,
        strategyTags:f.strategyTags||[],
      })),
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type:"application/json" });
    const url  = URL.createObjectURL(blob); const a = document.createElement("a");
    a.href = url; a.download = `grm_list_${family}_${payload.date}.json`; a.click(); URL.revokeObjectURL(url);
  };

  if (selected) return (
    <div>
      <button onClick={() => setSelected(null)} className="gb"
        style={{ marginBottom:12,background:"transparent",border:`1px solid ${C.faint}`,color:C.muted,padding:"5px 14px",fontSize:9,display:"flex",alignItems:"center",gap:6 }}>
        ← Back to List
      </button>
      <FixtureCard f={selected} onAddToParlay={onAddToParlay} draftLegs={draftLegs} />
    </div>
  );
  const hasResults = fixtures.some(f => f.hGoals != null);

  return (
    <div>
      {/* Desktop notice */}
      <div style={{ display:"flex",alignItems:"center",gap:6,background:C.radarDim,border:`1px solid ${C.radarBorder}`,borderRadius:7,padding:"6px 12px",marginBottom:14,fontSize:8,color:C.radar,fontWeight:700,letterSpacing:".06em" }}>
        🖥️ Best experienced in desktop site mode — more columns, filters and strategy rows visible at once.
      </div>
      {/* Strategy presets */}
      <div style={{ marginBottom:12 }}>
        <div style={{ fontSize:7,color:C.muted,textTransform:"uppercase",letterSpacing:".12em",fontWeight:700,marginBottom:6 }}>Strategy</div>
        <div className="filter-wrap">
          {STRATEGIES_UI.map(strat => {
            const active = activeStrategy === strat.id;
            return (
              <button key={strat.id} onClick={() => applyStrategy(strat)} className="gb" title={strat.desc}
                style={{ padding:"4px 12px",background:active?C.amber:"transparent",color:active?C.accentText:C.text,opacity:active?1:.5,border:`1px solid ${active?C.amber:C.text}`,fontSize:9,textTransform:"none",letterSpacing:".03em" }}>
                {strat.label}
              </button>
            );
          })}
          {activeStrategy && (
            <button onClick={() => { setActiveStrategy(null); setStatFilters([]); }} className="gb"
              style={{ padding:"4px 10px",background:"transparent",color:C.red,border:`1px solid ${C.red}50`,fontSize:9 }}>Clear ✕</button>
          )}
        </div>
      </div>

      {/* Market family */}
      <div style={{ marginBottom:10 }}>
        <div style={{ fontSize:7,color:C.muted,textTransform:"uppercase",letterSpacing:".12em",fontWeight:700,marginBottom:6 }}>Market</div>
        <div className="cscroll">
          {CUSTOM_FAMILIES.map(fam => (
            <button key={fam.id} onClick={() => { setFamily(fam.id); setActiveStrategy(null); }} className="gb"
              style={{ flexShrink:0,padding:"5px 12px",background:family===fam.id?C.gold:"transparent",color:family===fam.id?C.accentText:C.muted,border:`1px solid ${family===fam.id?C.gold:C.faint}`,fontSize:10,textTransform:"none" }}>
              {fam.label}
            </button>
          ))}
        </div>
      </div>

      {/* Stat filters */}
      <div style={{ marginBottom:14 }}>
        <div style={{ fontSize:7,color:C.muted,textTransform:"uppercase",letterSpacing:".12em",fontWeight:700,marginBottom:6 }}>Filters</div>
        <div style={{ display:"flex",alignItems:"center",gap:10,marginBottom:8,background:C.surface,borderRadius:7,padding:"7px 10px",border:`1px solid ${C.border}` }}>
          <span style={{ fontSize:8,color:C.muted,flexShrink:0 }}>xG threshold</span>
          <input type="range" min={1.0} max={2.5} step={0.25} value={xgThreshold} onChange={e=>setXgThreshold(parseFloat(e.target.value))} style={{ flex:1 }}/>
          <span style={{ fontSize:10,color:C.radar,fontWeight:800,width:28,textAlign:"right" }}>{xgThreshold}</span>
        </div>
        <div className="filter-wrap">
          {STAT_FILTERS.map(sf => {
            const active = statFilters.includes(sf.id);
            return (
              <button key={sf.id} onClick={() => { toggleStat(sf.id); setActiveStrategy(null); }} className="gb" title={sf.desc}
                style={{ padding:"4px 10px",background:active?C.radar:"transparent",color:active?C.accentText:C.muted,border:`1px solid ${active?C.radar:C.faint}`,fontSize:9,textTransform:"none" }}>
                {sf.label}
              </button>
            );
          })}
          {statFilters.length > 0 && !activeStrategy && (
            <button onClick={() => setStatFilters([])} className="gb"
              style={{ padding:"4px 10px",background:"transparent",color:C.red,border:`1px solid ${C.red}50`,fontSize:9 }}>Clear ✕</button>
          )}
        </div>
      </div>

      {/* List header */}
      <div style={{ display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:10 }}>
        <span style={{ fontSize:9,color:C.muted }}>{rows.length} matches</span>
        {rows.length > 0 && (
          <button onClick={saveListToJSON} className="gb"
            style={{ padding:"3px 10px",background:"transparent",border:`1px solid ${C.radar}50`,color:C.radar,fontSize:9 }}>💾 Save JSON</button>
        )}
      </div>

      {/* Column headers */}
      {!isMobile && (
        <div style={{ display:"grid",gridTemplateColumns:hasResults?"24px 50px 1fr 140px 60px 60px 72px":"24px 50px 1fr 140px 60px 60px",gap:8,padding:"6px 14px",borderBottom:`1px solid ${C.border}`,fontSize:7,color:C.faint,textTransform:"uppercase",letterSpacing:".1em",fontWeight:700,marginBottom:4 }}>
          <span>{selectedIds.size > 0 ? <button onClick={clearSelection} style={{ background:"none",border:"none",color:C.red,cursor:"pointer",fontSize:9,padding:0 }}>✕</button> : "☐"}</span>
          <span>Time</span><span>Match</span><span>Pick</span><span>Prob</span><span>Odds</span>
          {hasResults && <span>Score</span>}
        </div>
      )}
      {isMobile && (
        <div style={{ display:"grid",gridTemplateColumns:hasResults?"20px 1fr 44px 44px":"20px 1fr 44px",gap:6,padding:"5px 10px",borderBottom:`1px solid ${C.border}`,fontSize:7,color:C.faint,textTransform:"uppercase",letterSpacing:".1em",fontWeight:700,marginBottom:4 }}>
          <span>{selectedIds.size > 0 ? <button onClick={clearSelection} style={{ background:"none",border:"none",color:C.red,cursor:"pointer",fontSize:9,padding:0 }}>✕</button> : "☐"}</span>
          <span>Match / Pick</span><span style={{ textAlign:"right" }}>%</span>
          {hasResults && <span style={{ textAlign:"right" }}>Score</span>}
        </div>
      )}

      {/* Rows */}
      <div style={{ display:"flex",flexDirection:"column",gap:2,paddingBottom:selectedIds.size > 0 ? 60 : 0 }}>
        {rows.map(({ f, pick }) => {
          const probColor = pick.prob >= 75 ? C.green : pick.prob >= 60 ? C.gold : C.muted;
          const isSelected = selectedIds.has(f.id);
          const cols = hasResults ? "24px 50px 1fr 140px 60px 60px 72px" : "24px 50px 1fr 140px 60px 60px";
          const mCols = hasResults ? "20px 1fr 44px 44px" : "20px 1fr 44px";
          if (isMobile) return (
            <div key={f.id} style={{ display:"grid",gridTemplateColumns:mCols,gap:6,padding:"8px 10px",background:isSelected?"rgba(99,102,241,0.1)":C.surface,borderRadius:8,border:`1px solid ${isSelected?C.edge:C.border}`,cursor:"pointer",transition:"all .15s",alignItems:"center" }}
              onClick={() => setSelected(f)}>
              <div onClick={e=>{e.stopPropagation();toggleSelect(f.id);}}>
                <div style={{ width:16,height:16,borderRadius:4,border:`1.5px solid ${isSelected?C.edge:C.text}`,opacity:isSelected?1:.3,background:isSelected?C.edge:"transparent",display:"flex",alignItems:"center",justifyContent:"center" }}>
                  {isSelected && <span style={{ fontSize:9,color:"#fff",fontWeight:900 }}>✓</span>}
                </div>
              </div>
              <div style={{ minWidth:0 }}>
                <div style={{ fontSize:10,fontWeight:700,color:C.text,lineHeight:1.3,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap" }}>{f.teams.home} <span style={{ color:C.text,opacity:.3 }}>vs</span> {f.teams.away}</div>
                <div style={{ fontSize:8,color:C.muted,marginTop:1,display:"flex",gap:5,alignItems:"center" }}>
                  <StatusBadge state={f.state} time={f.time} />
                  {f.league && <span style={{ overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap" }}>{f.league}</span>}
                </div>
                <div style={{ fontSize:9,fontWeight:700,color:pick.color||C.text,marginTop:3,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap" }}>{pick.label}</div>
                <div className="cb" style={{ marginTop:3 }}><div className="cf" style={{ width:`${Math.min(pick.prob,100)}%`,background:probColor }}/></div>
              </div>
              <div style={{ textAlign:"right",fontSize:12,fontWeight:800,color:probColor }}>{Math.round(pick.prob)}%</div>
              {hasResults && (
                <div style={{ textAlign:"right" }}>
                  {f.hGoals != null ? <ResultBadge f={f} /> : <span style={{ fontSize:9,color:C.faint }}>—</span>}
                </div>
              )}
            </div>
          );
          return (
            <div key={f.id} style={{ display:"grid",gridTemplateColumns:cols,gap:8,padding:"8px 14px",background:isSelected?"rgba(99,102,241,0.1)":C.surface,borderRadius:8,border:`1px solid ${isSelected?C.edge:C.border}`,cursor:"pointer",transition:"all .15s" }}
              onClick={() => setSelected(f)}
              onMouseEnter={e=>{ if(!isSelected){ e.currentTarget.style.borderColor=C.borderHi; e.currentTarget.style.background=C.surfaceHi; }}}
              onMouseLeave={e=>{ if(!isSelected){ e.currentTarget.style.borderColor=C.border; e.currentTarget.style.background=C.surface; }}}>
              <div style={{ alignSelf:"center" }} onClick={e=>{e.stopPropagation();toggleSelect(f.id);}}>
                <div style={{ width:16,height:16,borderRadius:4,border:`1.5px solid ${isSelected?C.edge:C.text}`,opacity:isSelected?1:.3,background:isSelected?C.edge:"transparent",display:"flex",alignItems:"center",justifyContent:"center" }}>
                  {isSelected && <span style={{ fontSize:9,color:"#fff",fontWeight:900 }}>✓</span>}
                </div>
              </div>
              <div style={{ alignSelf:"center",fontSize:9,color:C.muted }}>
                <StatusBadge state={f.state} time={f.time} />
              </div>
              <div style={{ alignSelf:"center" }}>
                <div style={{ fontSize:10,fontWeight:700,color:C.text,lineHeight:1.3 }}>{f.teams.home} <span style={{ color:C.text,opacity:.3 }}>vs</span> {f.teams.away}</div>
                <div style={{ fontSize:8,color:C.muted,marginTop:1 }}>{f.league}{f.volatileLeague?" ⚠":""}</div>
              </div>
              <div style={{ alignSelf:"center" }}>
                <div style={{ fontSize:10,fontWeight:700,color:pick.color||C.text,lineHeight:1.2 }}>{pick.label}</div>
                <div className="cb" style={{ marginTop:4 }}><div className="cf" style={{ width:`${Math.min(pick.prob,100)}%`,background:probColor }}/></div>
              </div>
              <span style={{ fontSize:12,fontWeight:800,color:probColor,alignSelf:"center" }}>{Math.round(pick.prob)}%</span>
              <span style={{ fontSize:10,color:C.muted,alignSelf:"center" }}>{pick.odds || "—"}</span>
              {hasResults && (
                <div style={{ alignSelf:"center" }}>
                  {f.hGoals != null ? <ResultBadge f={f} /> : <span style={{ fontSize:9,color:C.faint }}>—</span>}
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
          <span style={{ fontSize:10,fontWeight:800,color:"#fff" }}>{selectedIds.size} selected</span>
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
          <button onClick={clearSelection} style={{ background:"none",border:"none",color:C.muted,cursor:"pointer",fontSize:13,padding:0 }}>✕</button>
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
        {[["code","🎟️ Ticket Code"],["json","📄 JSON Upload"]].map(([id,label]) => (
          <button key={id} onClick={() => { setMode(id); setResult(null); setError(null); }} className="gb"
            style={{ padding:"5px 14px",fontSize:9,background:mode===id?C.radar:"transparent",color:mode===id?C.accentText:C.muted,border:`1px solid ${mode===id?C.radar:C.faint}` }}>
            {label}
          </button>
        ))}
      </div>

      {/* Mode A: Paste ticket code */}
      {mode === "code" && (
        <div>
          <div style={{ fontSize:9,color:C.muted,marginBottom:10,lineHeight:1.6 }}>
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
            <div style={{ fontSize:8,color:C.faint,marginBottom:8 }}>
              Saved codes: {savedTickets.slice(-6).map(t => (
                <button key={t.code} onClick={() => setTicketCode(t.code)} className="gb"
                  style={{ fontSize:8,padding:"1px 7px",background:"transparent",border:`1px solid ${C.faint}`,color:C.muted,marginLeft:4,marginBottom:3 }}>
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
          <div style={{ fontSize:9,color:C.muted,marginBottom:10,lineHeight:1.6 }}>
            Upload a <span style={{ color:C.radar }}>custom list JSON</span> (from Custom List › Save JSON) to evaluate against results.
          </div>
          <div className={`drop-zone${dragging?" drag-over":""}`} onClick={() => fileRef.current?.click()}
            onDragOver={e=>{e.preventDefault();setDragging(true);}} onDragLeave={()=>setDragging(false)} onDrop={onDrop}
            style={{ marginBottom:16 }}>
            <input ref={fileRef} type="file" accept=".json" style={{ display:"none" }} onChange={e=>{const f=e.target.files?.[0];if(f)processFile(f);}}/>
            {uploading ? <span className="pu" style={{ fontSize:11,color:C.radar }}>Evaluating…</span>
              : <span style={{ fontSize:11,color:C.muted }}>Drop JSON here or <span style={{ color:C.radar }}>click to upload</span></span>}
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
                  <div style={{ fontSize:8,color:C.muted,textTransform:"uppercase",letterSpacing:".12em",marginBottom:4 }}>{result.date}</div>
                  <div style={{ fontSize:22,fontWeight:800,color:resColor(result.parlayResult) }}>{result.parlayResult}</div>
                  <div style={{ fontSize:9,color:C.muted,marginTop:4 }}>
                    {result.summary.wins}W / {result.summary.losses}L / {result.summary.voids} void
                    {result.summary.legWinRate != null && <span style={{ color:C.radar,marginLeft:8 }}>{result.summary.legWinRate}% leg hit rate</span>}
                  </div>
                </div>
                {result.totalOdds && <div style={{ fontSize:18,fontWeight:800,color:C.gold }}>×{result.totalOdds}</div>}
              </div>
              <div className="gc" style={{ overflow:"hidden" }}>
                <div style={{ padding:"10px 14px",borderBottom:`1px solid ${C.border}`,fontSize:8,color:C.muted,textTransform:"uppercase",letterSpacing:".1em",fontWeight:700 }}>Leg Results</div>
                {result.legs.map((leg, i) => {
                  const legCols = isMobile ? "1fr 72px 44px" : "1fr 120px 70px 70px 60px";
                  return (
                    <div key={i} style={{ display:"grid",gridTemplateColumns:legCols,gap:8,padding:"9px 14px",borderBottom:`1px solid ${C.faint}`,alignItems:"center",fontSize:10 }}>
                      <div>
                        <div style={{ fontWeight:600,color:C.text }}>{leg.game}</div>
                        {leg.league&&<div style={{ fontSize:7,color:C.muted }}>{leg.league}</div>}
                        {isMobile && <div style={{ fontSize:8,color:C.muted,marginTop:1 }}>{leg.score||""}{leg.odds ? ` · ×${leg.odds}` : ""}</div>}
                      </div>
                      <div style={{ color:mktStyle(leg.market).color||C.muted,fontSize:9,fontWeight:700 }}>{leg.pick}</div>
                      {!isMobile && <div style={{ color:C.muted,fontSize:9 }}>{leg.score||"—"}</div>}
                      {!isMobile && <div style={{ fontSize:9,color:C.muted }}>{leg.odds?`×${leg.odds}`:"—"}</div>}
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
                  <div style={{ fontSize:8,color:C.muted,textTransform:"uppercase",letterSpacing:".1em",marginBottom:6 }}>Overall</div>
                  <div style={{ fontSize:22,fontWeight:800,color:result.stats.overall.rate>=55?C.green:result.stats.overall.rate>=45?C.gold:C.red }}>{result.stats.overall.rate}%</div>
                  <div style={{ fontSize:9,color:C.muted,marginTop:3 }}>{result.stats.overall.wins}W / {result.stats.overall.total} played</div>
                </div>
              )}
              <div className="gc" style={{ overflow:"hidden" }}>
                <div style={{ display:"grid",gridTemplateColumns:isMobile?"1fr 70px 44px":"1fr 160px 70px 60px",gap:8,padding:"10px 14px",borderBottom:`1px solid ${C.border}`,fontSize:8,color:C.muted,textTransform:"uppercase",letterSpacing:".1em",fontWeight:700 }}>
                  <span>Match</span><span>Pick</span>{!isMobile&&<span>Score</span>}<span>Result</span>
                </div>
                <div style={{ maxHeight:480,overflowY:"auto" }}>
                  {result.rows.map((row, i) => (
                    <div key={i} style={{ display:"grid",gridTemplateColumns:isMobile?"1fr 70px 44px":"1fr 160px 70px 60px",gap:8,padding:"8px 14px",borderBottom:`1px solid ${C.faint}`,fontSize:10,alignItems:"center" }}>
                      <div>
                        <div style={{ fontWeight:600,color:C.text }}>{row.home} vs {row.away}</div>
                        <div style={{ fontSize:8,color:C.muted }}>{row.league||""}</div>
                        {isMobile && row.score && <div style={{ fontSize:8,color:C.muted }}>{row.score}</div>}
                        {row.strategyTags?.length>0 && <div style={{ fontSize:7,color:C.amber,marginTop:1 }}>{row.strategyTags.map(t=>STRATEGY_LABELS[t]||t).join(" · ")}</div>}
                      </div>
                      <div style={{ fontSize:9,color:C.gold,fontWeight:700 }}>{row.pick}</div>
                      {!isMobile && <div style={{ color:C.muted }}>{row.score||"—"}</div>}
                      <div style={{ fontWeight:800,color:resColor(row.result),textAlign:isMobile?"right":"left" }}>{row.result}</div>
                    </div>
                  ))}
                </div>
              </div>
            </>
          )}
          <button onClick={() => { setResult(null); setError(null); setTicketCode(""); if(fileRef.current) fileRef.current.value=""; }} className="gb"
            style={{ alignSelf:"flex-start",padding:"6px 16px",background:"transparent",border:`1px solid ${C.faint}`,color:C.muted,fontSize:10 }}>
            ↺ Evaluate Another
          </button>
        </div>
      )}
    </div>
  );
}

// ── BACKTEST TAB ──────────────────────────────────────────────────────────
function BacktestTab({ loadSnapshot, adminMode, onReloadFixtures }) {
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
      await fetch(`${SERVER}/api/fetch-results?date=${date}`, { headers:{"x-admin-token":"sterling77"} });
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
    try { await fetch(`${SERVER}/api/backtests/${filename}`, { method:"DELETE", headers:{"x-admin-token":"sterling77"} }); loadReportsList(); } catch {}
  };

  const resColor = r => r==="WIN"?C.green:r==="LOSS"?C.red:C.muted;

  return (
    <div style={{ maxWidth:1480,margin:"0 auto",padding:isMobile?"16px 12px":"28px 24px" }}>
      {/* Desktop notice */}
      <div style={{ display:"flex",alignItems:"center",gap:6,background:C.radarDim,border:`1px solid ${C.radarBorder}`,borderRadius:7,padding:"6px 12px",marginBottom:20,fontSize:8,color:C.radar,fontWeight:700,letterSpacing:".06em" }}>
        🖥️ Best experienced in desktop site mode — charts, match tables and date ranges are easier to navigate on a wider screen.
      </div>
      {/* Snapshots */}
      <div className="gc" style={{ padding:"18px",marginBottom:20 }}>
        <div style={{ fontSize:9,color:C.gold,fontWeight:800,textTransform:"uppercase",letterSpacing:".15em",marginBottom:14 }}>◆ Saved Snapshots</div>
        {!snapshots.length && <div style={{ fontSize:11,color:C.text,opacity:.3 }}>No snapshots yet</div>}
        <div style={{ display:"flex",flexWrap:"wrap",gap:8 }}>
          {snapshots.map(s => (
            <div key={s.date} style={{ display:"flex",alignItems:"center",gap:6,background:C.surface,border:`1px solid ${C.border}`,borderRadius:7,padding:"5px 10px" }}>
              <button onClick={() => loadSnapshot(s.date)} style={{ background:"none",border:"none",cursor:"pointer",fontSize:10,color:C.radar,fontFamily:C.font,padding:0,fontWeight:700 }}>{s.date}</button>
              {s.hasResults ? <span style={{ fontSize:8,color:C.green,fontWeight:700 }}>✓ Results</span>
                : adminMode ? <button onClick={() => fetchResults(s.date)} disabled={fetching===s.date} className="gb" style={{ background:C.gold,color:C.accentText,padding:"2px 8px",fontSize:9 }}>{fetching===s.date?"…":"Fetch"}</button>
                : <span style={{ fontSize:8,color:C.faint }}>No results</span>}
            </div>
          ))}
        </div>
      </div>

      {/* Run backtest */}
      <div className="gc" style={{ padding:"18px",marginBottom:20 }}>
        <div style={{ fontSize:9,color:C.gold,fontWeight:800,textTransform:"uppercase",letterSpacing:".15em",marginBottom:14 }}>◆ Run Backtest</div>
        <div style={{ display:"flex",gap:12,alignItems:"flex-end",flexWrap:"wrap" }}>
          <div><div style={{ fontSize:9,color:C.muted,marginBottom:5 }}>From</div><input type="date" value={from} onChange={e=>setFrom(e.target.value)} className="gi" style={{ width:150 }}/></div>
          <div><div style={{ fontSize:9,color:C.muted,marginBottom:5 }}>To</div><input type="date" value={to} onChange={e=>setTo(e.target.value)} className="gi" style={{ width:150 }}/></div>
          <button onClick={runBacktest} disabled={loading} className="gb" style={{ background:loading?C.faint:C.gold,color:loading?C.muted:C.accentText,padding:"8px 20px" }}>{loading?<span className="pu">RUNNING…</span>:"RUN"}</button>
        </div>
        {error && <div style={{ marginTop:12,color:C.red,fontSize:11,background:C.redDim,border:`1px solid ${C.red}30`,borderRadius:7,padding:"8px 12px",whiteSpace:"pre-wrap" }}>✕ {error}</div>}
      </div>

      {/* Save report */}
      {btData?.stats && (
        <div className="gc" style={{ padding:"16px",marginBottom:20,border:`1px solid ${C.radar}30` }}>
          <div style={{ fontSize:9,color:C.radar,fontWeight:800,textTransform:"uppercase",letterSpacing:".15em",marginBottom:12 }}>💾 Save Report</div>
          <div style={{ display:"flex",gap:10,alignItems:"flex-end",flexWrap:"wrap" }}>
            <div style={{ flex:1 }}>
              <div style={{ fontSize:9,color:C.muted,marginBottom:5 }}>Label (optional)</div>
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
          <div style={{ fontSize:9,color:C.muted,fontWeight:800,textTransform:"uppercase",letterSpacing:".15em",marginBottom:12 }}>📂 Saved Reports</div>
          <div style={{ display:"flex",flexDirection:"column",gap:6 }}>
            {savedReports.map(r => (
              <div key={r.filename} style={{ display:"flex",justifyContent:"space-between",alignItems:"center",background:C.surface,border:`1px solid ${C.border}`,borderRadius:8,padding:"8px 12px" }}>
                <div>
                  <div style={{ fontSize:10,color:C.text,fontWeight:700 }}>{r.label||`${r.from} → ${r.to}`}</div>
                  <div style={{ fontSize:8,color:C.muted,marginTop:2 }}>
                    {r.from} → {r.to}
                    {r.overall && <span style={{ marginLeft:8,color:r.overall.rate>=55?C.green:r.overall.rate>=45?C.gold:C.red,fontWeight:700 }}>{r.overall.rate}% ({r.overall.wins}W/{r.overall.total})</span>}
                  </div>
                  <div style={{ fontSize:7,color:C.faint,marginTop:1 }}>{new Date(r.savedAt).toLocaleString()}</div>
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
                    <div style={{ fontSize:8,color:C.muted,textTransform:"uppercase",letterSpacing:".1em",marginBottom:8 }}>{label}</div>
                    <div style={{ fontSize:24,fontWeight:800,color:stat.rate>=55?C.green:stat.rate>=45?C.gold:C.red }}>{stat.rate}%</div>
                    <div style={{ fontSize:9,color:C.muted,marginTop:4 }}>{stat.wins}W / {stat.total} played</div>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div style={{ display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(160px,1fr))",gap:12,marginBottom:20 }}>
            {[["Overall", btData.stats.overall]].filter(([,s])=>s).map(([label, stat]) => (
              <div key={label} className="gc" style={{ padding:"14px 16px" }}>
                <div style={{ fontSize:8,color:C.muted,textTransform:"uppercase",letterSpacing:".1em",marginBottom:8 }}>{label}</div>
                <div style={{ fontSize:24,fontWeight:800,color:stat.rate>=55?C.green:stat.rate>=45?C.gold:C.red }}>{stat.rate}%</div>
                <div style={{ fontSize:9,color:C.muted,marginTop:4 }}>{stat.wins}W / {stat.total} played</div>
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
                    <div style={{ fontSize:8,color:C.muted }}>{stat.wins}/{stat.total}</div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {btData.stats.byLeague && Object.keys(btData.stats.byLeague).length > 0 && (
            <div className="gc" style={{ padding:"16px",marginBottom:20 }}>
              <div style={{ fontSize:9,color:C.radar,fontWeight:800,textTransform:"uppercase",letterSpacing:".12em",marginBottom:12 }}>🌍 By League</div>
              <div style={{ display:"flex",flexWrap:"wrap",gap:8,maxHeight:240,overflowY:"auto" }}>
                {Object.entries(btData.stats.byLeague).sort((a,b)=>(b[1]?.rate||0)-(a[1]?.rate||0)).map(([lg, stat]) => stat && (
                  <div key={lg} style={{ background:C.surface,border:`1px solid ${C.radar}20`,borderRadius:8,padding:"8px 12px",minWidth:130 }}>
                    <div style={{ fontSize:7,color:C.muted,marginBottom:4,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap" }}>{lg}</div>
                    <div style={{ fontSize:14,fontWeight:800,color:stat.rate>=55?C.green:stat.rate>=45?C.gold:C.red }}>{stat.rate}%</div>
                    <div style={{ fontSize:7,color:C.muted }}>{stat.wins}/{stat.total}</div>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="gc" style={{ padding:"16px",marginBottom:20 }}>
            <div style={{ fontSize:9,color:C.muted,textTransform:"uppercase",letterSpacing:".12em",fontWeight:700,marginBottom:12 }}>By Market</div>
            <div style={{ display:"flex",flexWrap:"wrap",gap:8 }}>
              {Object.entries(btData.stats.byMarket||{}).map(([mkt, stat]) => stat && (
                <div key={mkt} style={{ background:C.surface,border:`1px solid ${C.border}`,borderRadius:8,padding:"8px 12px",minWidth:120 }}>
                  <div style={{ fontSize:8,color:C.muted,marginBottom:4 }}>{mkt}</div>
                  <div style={{ fontSize:16,fontWeight:800,color:stat.rate>=55?C.green:stat.rate>=45?C.gold:C.red }}>{stat.rate}%</div>
                  <div style={{ fontSize:8,color:C.muted }}>{stat.wins}/{stat.total}</div>
                </div>
              ))}
            </div>
          </div>

          {btData.matches && (
            <div className="gc" style={{ overflow:"hidden" }}>
              <div style={{ display:"grid",gridTemplateColumns:isMobile?"1fr 72px 40px 40px":"1fr 110px 80px 55px 55px",gap:8,padding:"10px 16px",borderBottom:`1px solid ${C.border}`,fontSize:8,color:C.muted,textTransform:"uppercase",letterSpacing:".1em",fontWeight:700 }}>
                <span>Match</span><span>{isMobile?"Pick":"The Read"}</span>{!isMobile&&<span>Score</span>}<span>Read</span><span>Edge</span>
              </div>
              <div style={{ maxHeight:500,overflowY:"auto" }}>
                {btData.matches.map((r, i) => (
                  <div key={i} style={{ display:"grid",gridTemplateColumns:isMobile?"1fr 72px 40px 40px":"1fr 110px 80px 55px 55px",gap:8,padding:"8px 16px",borderBottom:`1px solid ${C.faint}`,fontSize:10,alignItems:"center" }}>
                    <div>
                      <div style={{ color:C.text,fontWeight:600 }}>{r.teams.home} vs {r.teams.away}</div>
                      <div style={{ fontSize:8,color:C.muted }}>{r.league}</div>
                      {isMobile && r.hGoals != null && <div style={{ fontSize:8,color:C.muted }}>{r.hGoals} – {r.aGoals}</div>}
                      {r.strategyTags?.length>0 && <div style={{ fontSize:7,color:C.amber,marginTop:1 }}>{r.strategyTags.map(t=>STRATEGY_LABELS[t]||t).join(" · ")}</div>}
                    </div>
                    <div style={{ color:mktStyle(r.theRead?.anchor?.market||r.safeBet?.market).color||C.muted,fontSize:9,fontWeight:700,lineHeight:1.4 }}>
                      {r.theRead?.anchor?.pick||r.safeBet?.pick||"—"}
                    </div>
                    {!isMobile && <div style={{ color:C.muted }}>
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
        <div style={{ textAlign:"center",padding:"40px",color:C.faint,fontSize:11 }}>
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
  { id:"sportybet",    label:"SportyBet NG",     api:"/api/book-sportybet",    link: code => `http://www.sportybet.com/ng/?shareCode=${code}` },
  { id:"luckyledger",  label:"Lucky's Ledger",   api:"/api/book-luckyledger",  link: code => `https://luckysledger.com/sports?btBookingCode=${code}` },
];

function TicketBookNowButton({ legs }) {
  const [open, setOpen]         = useState(false);
  const [bookie, setBookie]     = useState("");
  const [booking, setBooking]   = useState(false);
  const [result, setResult]     = useState(null);
  const [error, setError]       = useState(null);
  const [copied, setCopied]     = useState(false);

  const buildLegs = () => (legs || []).map(leg => {
    const home = leg.home || (leg.game || "").split(" vs ")[0]?.trim() || "";
    const away = leg.away || (leg.game || "").split(" vs ")[1]?.trim() || "";
    let mkt = leg.market || "";
    if (!mkt || mkt === "Unknown") mkt = inferMarket(leg.pick || "");
    if (mkt.startsWith("TeamTotal")) mkt = "TeamTotal";
    return { home, away, market: mkt, pick: leg.pick || "" };
  }).filter(l => l.home && l.away && l.pick && l.market !== "Unknown");

  const selectedBookie = BOOKMAKERS.find(b => b.id === bookie) || null;

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
    } catch(e) { setError(e.message); }
    finally { setBooking(false); }
  };

  const copy = () => {
    if (!result?.code) return;
    navigator.clipboard.writeText(result.code)
      .then(() => { setCopied(true); setTimeout(() => setCopied(false), 2000); });
  };

  const reset = () => { setResult(null); setError(null); };

  const legCount = buildLegs().length;

  if (!open) return (
    <button onClick={() => setOpen(true)} className="gb"
      style={{ width:"100%",marginTop:6,background:`${C.gold}10`,border:`1px solid ${C.goldBorder}`,color:C.gold,padding:"7px 0",fontSize:10,fontWeight:700,letterSpacing:".05em" }}>
      🎟️ Book Now
    </button>
  );

  return (
    <div style={{ marginTop:6,background:`${C.gold}06`,border:`1px solid ${C.goldBorder}`,borderRadius:8,padding:"12px" }}>
      {/* Header */}
      <div style={{ display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:10 }}>
        <span style={{ fontSize:8,fontWeight:800,color:C.gold,letterSpacing:".1em",textTransform:"uppercase" }}>🎟️ Book Now</span>
        <button onClick={() => { setOpen(false); reset(); }} className="gb"
          style={{ background:"transparent",border:"none",color:C.muted,fontSize:13,padding:0 }}>✕</button>
      </div>

      {!result ? (
        <>
          {/* Bookmaker selector — visible dropdown with chevron */}
          <div style={{ marginBottom:10 }}>
            <div style={{ fontSize:7,color:C.muted,textTransform:"uppercase",letterSpacing:".1em",marginBottom:5 }}>Select Bookmaker</div>
            <div style={{ position:"relative" }}>
              <select value={bookie} onChange={e => { setBookie(e.target.value); reset(); }}
                style={{ width:"100%",background:C.surface,color:bookie?C.text:C.muted,border:`1px solid ${C.goldBorder}`,borderRadius:6,padding:"8px 32px 8px 10px",fontSize:10,fontWeight:600,cursor:"pointer",WebkitAppearance:"none",MozAppearance:"none",appearance:"none" }}>
                <option value="" disabled>Choose bookmaker…</option>
                {BOOKMAKERS.map(b => (
                  <option key={b.id} value={b.id}>{b.label}</option>
                ))}
              </select>
              {/* Visible chevron arrow */}
              <div style={{ position:"absolute",right:10,top:"50%",transform:"translateY(-50%)",pointerEvents:"none",color:C.gold,fontSize:10,fontWeight:900 }}>▾</div>
            </div>
          </div>

          <div style={{ fontSize:8,color:C.muted,marginBottom:10 }}>
            {legCount} leg{legCount !== 1 ? "s" : ""}{bookie ? ` · ${selectedBookie?.label}` : ""}
          </div>

          <button onClick={book} disabled={booking || !legCount || !bookie} className="gb"
            style={{ width:"100%",background:(booking||!legCount||!bookie)?C.faint:C.gold,color:(booking||!legCount||!bookie)?C.muted:C.accentText,padding:"8px 0",fontWeight:800,fontSize:10 }}>
            {booking ? <span className="pu">Booking…</span> : !bookie ? "Select a bookmaker" : "Generate Code"}
          </button>

          {error && (
            <div style={{ fontSize:8,color:C.red,marginTop:6,display:"flex",alignItems:"center",gap:8 }}>
              <span>✕ {error}</span>
              <button onClick={book} className="gb"
                style={{ fontSize:8,padding:"1px 8px",background:"transparent",border:`1px solid ${C.red}`,color:C.red,flexShrink:0 }}>Retry</button>
            </div>
          )}
        </>
      ) : (
        <div>
          <div style={{ fontSize:7,color:C.green,fontWeight:800,letterSpacing:".1em",textTransform:"uppercase",marginBottom:8 }}>
            ✓ BOOKED · {BOOKMAKERS.find(b=>b.id===result.bookieId)?.label}
          </div>

          {/* Primary — deep link */}
          <button onClick={() => window.open(selectedBookie.link(result.code), "_blank")} className="gb"
            style={{ width:"100%",background:C.gold,color:C.accentText,padding:"9px 0",fontWeight:800,fontSize:11,marginBottom:8 }}>
            🎟️ Open in {selectedBookie.label}
          </button>

          {/* Secondary — code + copy */}
          <div style={{ display:"flex",alignItems:"center",gap:8,marginBottom:6 }}>
            <div style={{ flex:1,background:C.bg,border:`1px solid ${C.green}30`,borderRadius:6,padding:"5px 10px",fontSize:14,fontWeight:800,color:C.green,letterSpacing:".2em",textAlign:"center",fontFamily:C.font }}>
              {result.code}
            </div>
            <button onClick={copy} className="gb"
              style={{ padding:"5px 12px",background:copied?C.green:"transparent",color:copied?C.accentText:C.green,border:`1px solid ${C.green}50`,fontWeight:700,fontSize:9,flexShrink:0 }}>
              {copied ? "✓" : "Copy"}
            </button>
          </div>

          {result.failed?.length > 0 && (
            <div style={{ fontSize:7,color:C.amber,marginBottom:6 }}>⚠ Skipped: {result.failed.join(", ")}</div>
          )}

          {/* Try another bookmaker */}
          <button onClick={reset} className="gb"
            style={{ width:"100%",background:"transparent",border:`1px solid ${C.faint}`,color:C.muted,padding:"4px 0",fontSize:8 }}>
            ↺ Try another bookmaker
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
      style={{ width:"100%", background:"transparent", border:`1px solid ${C.goldBorder}`, color:C.gold, padding:"5px 0", fontSize:9, fontWeight:700, letterSpacing:".05em" }}>
      🎟️ Custom Pick
    </button>
  );

  return (
    <div style={{ background:C.surface, border:`1px solid ${C.goldBorder}`, borderRadius:9, padding:"10px 12px" }}>
      {/* Header */}
      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:6 }}>
        <span style={{ fontSize:8, fontWeight:800, color:C.gold, letterSpacing:".12em", textTransform:"uppercase" }}>🎟️ Custom Pick</span>
        <button onClick={() => setOpen(false)} className="gb"
          style={{ background:"transparent", border:"none", color:C.muted, fontSize:11, padding:0 }}>✕</button>
      </div>
      <div style={{ fontSize:8, color:C.muted, marginBottom:8 }}>
        <span style={{ color:C.text, fontWeight:700 }}>{home}</span>
        <span style={{ color:C.faint }}> vs </span>
        <span style={{ color:C.text, fontWeight:700 }}>{away}</span>
      </div>

      {/* Market family */}
      <div style={{ fontSize:7, color:C.muted, textTransform:"uppercase", letterSpacing:".1em", marginBottom:4 }}>Market</div>
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
          <div style={{ fontSize:7, color:C.muted, textTransform:"uppercase", letterSpacing:".1em", marginBottom:4 }}>Pick</div>
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
            <span style={{ color:C.muted }}>Model prob</span>
            <span style={{ color:C.gold,fontWeight:700 }}>{previewProb ? `${Math.round(previewProb)}%` : "—"}</span>
            <span style={{ color:C.muted }}>Odds</span>
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
            <div style={{ padding:"12px 14px",fontSize:9,color:C.faint,textAlign:"center" }}>No fixtures found</div>
          )}
          {filtered.map(f => (
            <button key={f.id} onClick={() => { onSelect(f); setOpen(false); setQuery(""); }} className="gb"
              style={{ width:"100%",textAlign:"left",padding:"8px 12px",background:"transparent",border:"none",borderBottom:`1px solid ${C.faint}`,color:C.text,fontSize:10,fontWeight:600,borderRadius:0,letterSpacing:0,textTransform:"none",cursor:"pointer" }}>
              <div style={{ lineHeight:1.3 }}>{f.teams.home} <span style={{ color:C.text,opacity:.3 }}>vs</span> {f.teams.away}</div>
              <div style={{ fontSize:7,color:C.muted,marginTop:1 }}>{f.league} · {f.time}</div>
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
      <div style={{ fontSize:10,fontWeight:800,color:C.gold,letterSpacing:".12em",textTransform:"uppercase",marginBottom:4 }}>🎟️ Custom Picks</div>
      <div style={{ fontSize:8,color:C.muted,marginBottom:12 }}>
        {hasFixtures ? "Select fixtures and picks · adds to your ticket" : "Enter your own picks · adds to your ticket"}
      </div>

      {legs.map((leg,i) => {
        const pickOptions = getCustomPickOptions(leg.market, leg.home, leg.away);
        return (
          <div key={i} style={{ background:C.bg,borderRadius:8,padding:"10px 12px",marginBottom:8,border:`1px solid ${C.border}` }}>
            <div style={{ display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:8 }}>
              <span style={{ fontSize:8,color:C.muted,fontWeight:700 }}>LEG {i+1}</span>
              {legs.length>1 && <button onClick={()=>removeLeg(i)} style={{ background:"none",border:"none",color:C.muted,cursor:"pointer",fontSize:11,padding:0 }}>✕</button>}
            </div>

            {/* Fixture selector — searchable dropdown if fixtures loaded, else free text */}
            {hasFixtures ? (
              <div style={{ marginBottom:8 }}>
                <div style={{ fontSize:7,color:C.muted,textTransform:"uppercase",letterSpacing:".1em",marginBottom:4 }}>Fixture</div>
                <FixtureSearchDropdown
                  fixtures={fixtures}
                  selectedFixture={selectedFixtures[i]}
                  onSelect={f => selectFixture(i, f)}
                  placeholder="Search team or league…"
                />
                {selectedFixtures[i] && (
                  <div style={{ fontSize:7,color:C.muted,marginTop:3 }}>
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
                <div style={{ fontSize:7,color:C.muted,textTransform:"uppercase",letterSpacing:".1em",marginBottom:4 }}>Market</div>
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
                    <div style={{ fontSize:7,color:C.muted,textTransform:"uppercase",letterSpacing:".1em",marginBottom:4 }}>Pick</div>
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
        style={{ background:"transparent",border:`1px solid ${C.faint}`,color:C.muted,padding:"4px 12px",fontSize:9,marginBottom:10 }}>
        + Add Leg
      </button>

      <button onClick={handleAddToTicket} disabled={!validCount || flash} className="gb"
        style={{ width:"100%",background:flash?C.green:validCount?C.gold:C.faint,color:flash||validCount?C.accentText:C.muted,padding:"8px 0",fontWeight:800,fontSize:10,transition:"all .2s" }}>
        {flash ? `✓ Added ${validCount} leg${validCount!==1?"s":""}!` : `+ Add to Ticket (${validCount} leg${validCount!==1?"s":""})`}
      </button>
    </div>
  );
}

const SAVED_TICKETS_KEY = "grm_saved_tickets_v15";
function loadSavedTickets() { try { return JSON.parse(localStorage.getItem(SAVED_TICKETS_KEY)||"[]"); } catch { return []; } }
function persistTickets(tickets) { try { localStorage.setItem(SAVED_TICKETS_KEY, JSON.stringify(tickets)); } catch {} }
function generateTicketCode() {
  // Use 8 chars of random base-36 — virtually no collision risk
  return "T" + Math.random().toString(36).slice(2, 6).toUpperCase()
             + Math.random().toString(36).slice(2, 6).toUpperCase();
}
function CopyCodeButton({ code }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    navigator.clipboard.writeText(code).then(() => { setCopied(true); setTimeout(()=>setCopied(false),2000); });
  };
  return (
    <button onClick={copy} className="gb"
      style={{ background:copied?`${C.green}15`:"transparent",border:`1px solid ${copied?C.green:C.radar}40`,color:copied?C.green:C.radar,padding:"2px 10px",fontSize:9,fontWeight:700 }}>
      {copied ? "✓ Copied" : `📋 ${code}`}
    </button>
  );
}

function TicketCard({ ticket, date, onRemove, onRemoveLeg, isJarvis, onOpenFixture, onSaveInternal, onInject, savedCode, injecting }) {
  const [stakeInput, setStakeInput] = useState(ticket.stake > 0 ? String(ticket.stake) : "");
  const stake      = parseFloat(stakeInput) || 0;
  const potential  = parseFloat((stake * parseFloat(ticket.totalOdds)).toFixed(2));
  const exhausted  = ticket.exhausted;
  const accentColor = isJarvis ? C.edge : C.gold;
  const accentBg    = isJarvis ? C.edgeDim : C.goldDim;
  const accentBdr   = isJarvis ? C.edgeBorder : C.goldBorder;
  const isManual    = ticket.source === "card_add" || ticket.source === "custom_selection";



  return (
    <div className="gc" style={{ padding:"14px 16px",background:accentBg,border:`1px solid ${accentBdr}` }}>
      {/* Header */}
      <div style={{ display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:10,paddingBottom:8,borderBottom:`1px solid ${accentBdr}` }}>
        <div style={{ display:"flex",gap:6,alignItems:"center",flexWrap:"wrap" }}>
          {isJarvis && <span style={{ fontSize:8,color:C.edge,fontWeight:900,letterSpacing:".12em" }}>🤓 JARVIS</span>}
          {ticket.slotLabel && <span style={{ fontSize:9,fontWeight:800,color:accentColor }}>{ticket.slotLabel}</span>}
          {!ticket.slotLabel && <span style={{ fontSize:10,fontWeight:800,color:accentColor }}>TICKET #{ticket.id}</span>}
          {ticket.edgeScore > 0 && <span style={{ fontSize:8,fontWeight:800,color:C.green,background:C.greenDim,border:`1px solid ${C.green}30`,borderRadius:4,padding:"1px 6px" }}>EDGE {ticket.edgeScore.toFixed(1)}</span>}
          {exhausted && <span style={{ fontSize:8,fontWeight:800,color:C.orange,background:C.orangeDim,border:`1px solid ${C.orange}30`,borderRadius:4,padding:"1px 6px" }}>⚠ EXHAUSTED</span>}
        </div>
        <div style={{ display:"flex",gap:6,alignItems:"center",flexWrap:"wrap" }}>
          <span style={{ fontSize:10,color:C.text,fontWeight:700 }}>×{ticket.totalOdds}</span>
          {savedCode
            ? <span style={{ fontSize:9,fontWeight:800,color:C.green,background:C.greenDim,border:`1px solid ${C.green}30`,borderRadius:4,padding:"2px 7px" }}>✓ {savedCode}</span>
            : onSaveInternal && !exhausted && (
              <button onClick={() => onSaveInternal(stake)} className="gb"
                style={{ background:`${accentColor}20`,border:`1px solid ${accentColor}50`,color:accentColor,padding:"2px 8px",fontSize:9 }}>
                💾 Save
              </button>
            )
          }
          {/* ⚡ Inject button */}
          {onInject && !exhausted && (
            <button onClick={onInject} disabled={injecting} className="gb"
              style={{ background:injecting?"transparent":`${C.radar}18`,border:`1px solid ${C.radar}50`,color:injecting?C.muted:C.radar,padding:"2px 8px",fontSize:9 }}>
              {injecting ? <span className="pu">…</span> : "⚡ Check Progress"}
            </button>
          )}

          <button onClick={onRemove} style={{ background:"none",border:"none",color:C.muted,cursor:"pointer",fontSize:13,padding:0 }}>✕</button>
        </div>
      </div>

      {/* Exhausted state */}
      {isJarvis && exhausted && (
        <div style={{ padding:"10px 0",textAlign:"center" }}>
          <div style={{ fontSize:9,color:C.orange,fontWeight:700,marginBottom:4 }}>Slot unavailable today</div>
          <div style={{ fontSize:8,color:C.muted }}>{ticket.jarvisReason}</div>
        </div>
      )}

      {/* Jarvis analysis bar */}
      {isJarvis && !exhausted && ticket.jarvisConf != null && (
        <div style={{ marginBottom:8,background:`${C.edge}08`,borderRadius:6,padding:"6px 9px",border:`1px solid ${C.edge}22` }}>
          <div style={{ fontSize:7,color:C.edge,fontWeight:800,textTransform:"uppercase",letterSpacing:".12em",marginBottom:2 }}>Jarvis Confidence</div>
          <div style={{ display:"flex",alignItems:"center",gap:6 }}>
            <div style={{ flex:1,height:3,background:C.faint,borderRadius:2,overflow:"hidden" }}>
              <div style={{ height:"100%",width:`${ticket.jarvisConf}%`,background:C.edge,borderRadius:2 }}/>
            </div>
            <span style={{ fontSize:9,color:C.edge,fontWeight:800 }}>{ticket.jarvisConf}%</span>
          </div>
          {ticket.jarvisReason && <div style={{ fontSize:7,color:C.muted,marginTop:3,lineHeight:1.4 }}>{ticket.jarvisReason}</div>}
        </div>
      )}

      {/* Legs */}
      {!exhausted && (
        <div style={{ display:"flex",flexDirection:"column",gap:6,marginBottom:10 }}>
          {(ticket.legs||[]).map((leg, i) => (
            <div key={i} style={{ background:`${accentColor}08`,borderRadius:6,padding:"7px 9px",border:`1px solid ${accentColor}18`,position:"relative" }}>
              {leg.strategyLabel && <div style={{ fontSize:6,color:C.amber,fontWeight:800,textTransform:"uppercase",letterSpacing:".1em",marginBottom:2 }}>{leg.strategyLabel}</div>}
              <div style={{ display:"flex",justifyContent:"space-between",alignItems:"flex-start" }}>
                <div style={{ flex:1 }}>
                  {onOpenFixture && leg.fixtureId ? (
                    <button onClick={() => onOpenFixture(leg.fixtureId)} style={{ background:"none",border:"none",color:C.radar,cursor:"pointer",fontSize:9,fontWeight:700,textAlign:"left",fontFamily:C.font,padding:0,marginBottom:2 }}>
                      {leg.game} →
                    </button>
                  ) : (
                    <div style={{ fontSize:9,color:C.text,fontWeight:600,marginBottom:2,lineHeight:1.35 }}>{leg.game}</div>
                  )}
                </div>
                {onRemoveLeg && (
                  <button onClick={() => onRemoveLeg(i)} style={{ background:"none",border:"none",color:C.muted,cursor:"pointer",fontSize:11,padding:"0 0 0 6px",lineHeight:1,flexShrink:0 }}>✕</button>
                )}
              </div>
              {/* Inject result badge */}
              {leg._result && (
                <span style={{ fontSize:8,fontWeight:800,color:leg._result==="WIN"?C.green:leg._result==="LOSS"?C.red:C.muted,marginBottom:4,display:"block" }}>
                  {leg._result==="WIN"?"✓":leg._result==="LOSS"?"✕":"–"} {leg._result}
                  {leg._score && <span style={{ fontWeight:400,color:C.muted,marginLeft:4 }}>{leg._score}</span>}
                </span>
              )}
              <div style={{ display:"flex",justifyContent:"space-between" }}>
                <div style={{ display:"flex",gap:5,alignItems:"center" }}>
                  {leg.market && leg.market !== "Unknown" && (
                    <Pill color={mktStyle(leg.market||"").color} bg={mktStyle(leg.market||"").bg}>{leg.market}</Pill>
                  )}
                  {leg.isVolatile && (
                    <Pill color={C.amber} bg={`${C.amber}18`}>⚡ vol</Pill>
                  )}
                  <span style={{ fontSize:9,color:mktStyle(leg.market && leg.market !== "Unknown" ? leg.market : "1X2").color,fontWeight:700 }}>{leg.pick}</span>
                </div>
                <div style={{ textAlign:"right" }}>
                  <span style={{ fontSize:10,fontWeight:700,color:accentColor }}>{leg.odds ? `${parseFloat(leg.odds).toFixed(2)}x` : "—"}</span>
                  <span style={{ fontSize:8,color:C.muted,marginLeft:4 }}>({Math.round(leg.conf||0)}%)</span>
                  {leg.empiricalRate != null && (
                    <div style={{ fontSize:7,color:C.radar,marginTop:1 }}>{leg.empiricalRate}% hist</div>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Book Now — ticket level */}
      {!exhausted && ticket.legs?.length > 0 && (
        <TicketBookNowButton legs={ticket.legs} />
      )}

      {/* Stake + return */}
      {!exhausted && (
        <div style={{ paddingTop:10,borderTop:`1px solid ${accentBdr}`,marginTop:4 }}>
          <div style={{ fontSize:8,color:C.muted,fontWeight:800,letterSpacing:".1em",textTransform:"uppercase",marginBottom:10 }}>
            Check Your Estimated Winning
          </div>
          <div style={{ display:"flex",justifyContent:"space-between",alignItems:"center" }}>
            <div>
              <div style={{ fontSize:8,color:C.muted,textTransform:"uppercase",letterSpacing:".1em",marginBottom:4 }}>Stake</div>
              {isManual ? (
                <div style={{ display:"flex",alignItems:"center",gap:6 }}>
                  <span style={{ fontSize:11,color:C.muted }}>$</span>
                  <input type="number" value={stakeInput} onChange={e=>setStakeInput(e.target.value)}
                    placeholder="0.00" className="gi" style={{ width:80,padding:"4px 7px",fontSize:12,fontWeight:800,color:C.text }}
                    onFocus={e=>e.target.select()}/>
                </div>
              ) : (
                <div style={{ fontSize:16,fontWeight:800,color:C.text }}>${stake.toFixed(2)}</div>
              )}
            </div>
            <div style={{ textAlign:"right" }}>
              <div style={{ fontSize:8,color:C.green,textTransform:"uppercase",letterSpacing:".1em",marginBottom:2 }}>
                {stake > 0 ? "Potential Return" : "×" + ticket.totalOdds + " odds"}
              </div>
              <div style={{ fontSize:16,fontWeight:800,color:stake > 0 ? C.green : C.muted }}>
                {stake > 0 ? `$${potential}` : "Enter stake"}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── JARVIS TICKET CARD ────────────────────────────────────────────────────
function JarvisTicketCard({ ticket, onOpenFixture, onRemove, date, onSaveInternal, onInject, savedCode, injecting }) {
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
      setAnalysis(`🤓 Jarvis is busy right now — ${e.message?.toLowerCase().includes("429") || e.message?.toLowerCase().includes("rate") ? "rate limit hit, try again in a minute." : "tap Analyse to retry."}`);
    }
    setAnalysing(false);
  };

  return (
    <div style={{ marginBottom:14 }}>
      <TicketCard
        ticket={ticket} date={date} isJarvis={true}
        onRemove={onRemove} onOpenFixture={onOpenFixture}
        onSaveInternal={onSaveInternal} onInject={onInject}
        savedCode={savedCode} injecting={injecting}
      />
      {!ticket.exhausted && (
        <>
          <button onClick={handleAnalyse} disabled={analysing} className="gb"
            style={{ marginTop:8,padding:"6px 16px",background:C.edgeDim,color:C.edge,border:`1px solid ${C.edgeBorder}`,fontSize:10 }}>
            {analysing ? <span className="pu">🤓 Analysing…</span> : "🤓 Analyse with Jarvis"}
          </button>
          {analysis && (
            <div style={{ marginTop:8,background:C.surface,border:`1px solid ${C.edgeBorder}`,borderRadius:8,padding:"10px 12px",fontSize:11,color:C.text,lineHeight:1.6,whiteSpace:"pre-wrap" }}>
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
    <div style={{ position:"fixed",bottom:96,left:0,right:0,zIndex:200,display:"flex",justifyContent:"center",pointerEvents:"none" }}>
      <div style={{ pointerEvents:"all",background:C.accent,borderRadius:12,padding:"10px 18px",display:"flex",alignItems:"center",gap:14,boxShadow:`0 4px 28px ${C.accentBorder}`,maxWidth:420,width:"calc(100% - 32px)" }}>
        <div style={{ flex:1 }}>
          <div style={{ fontSize:9,fontWeight:800,color:C.accentText,letterSpacing:".1em" }}>DRAFT · {draftLegs.length} LEG{draftLegs.length>1?"S":""}</div>
          <div style={{ fontSize:11,fontWeight:700,color:C.accentText,marginTop:2 }}>×{prod.toFixed(2)} combined odds</div>
        </div>
        <button onClick={onOpen} style={{ background:C.bg,color:C.accent,border:"none",borderRadius:8,padding:"6px 14px",fontSize:11,fontWeight:900,cursor:"pointer",fontFamily:C.font }}>VIEW →</button>
        {/* X only dismisses the banner — does NOT delete the ticket */}
        <button onClick={() => setVisible(false)} style={{ background:"rgba(0,0,0,0.15)",color:C.accentText,border:"none",borderRadius:8,padding:"6px 10px",fontSize:13,cursor:"pointer" }} title="Dismiss (ticket stays)">✕</button>
      </div>
    </div>
  );
}

// ── GRM NEWS TICKER ──────────────────────────────────────────────────────
// Fixed bottom bar. Scrolls continuously right → left like a news channel.
// Loads yesterday's snapshot on mount, scores Safe + Value tiers and the
// full pool hit rate, then builds the ticker string. No dismiss — ambient.
function GrmNewsTicker({ historicalRates }) {
  const [text, setText] = useState(null);

  useEffect(() => {
    if (!historicalRates) return;
    const yest = new Date(Date.now() - 86_400_000).toISOString().split("T")[0];
    (async () => {
      try {
        const r = await fetch(`${SERVER}/api/load-snapshot?date=${yest}`);
        if (!r.ok) return;
        const { data: fixtures } = await r.json();
        if (!fixtures?.length) return;

        // Only work with resolved fixtures
        const resolved = fixtures.filter(f => f.hGoals != null);
        if (!resolved.length) return;

        // ── Pool hit rate ─────────────────────────────────────────────────
        const poolWins  = resolved.filter(f => f.readResult === "WIN").length;
        const poolTotal = resolved.length;
        const poolPct   = poolTotal ? ((poolWins / poolTotal) * 100).toFixed(1) : null;

        // ── Build Safe + Value tiers for yesterday ────────────────────────
        const bets   = buildDailyBestBets(fixtures, historicalRates);
        const resMap = new Map(resolved.map(f => [f.id, f]));

        const scoreTier = tier => {
          if (!tier?.legs?.length) return null;
          const legs = tier.legs.filter(l => resMap.has(l.fixtureId));
          if (!legs.length) return null;
          const wins = legs.filter(l => (resMap.get(l.fixtureId)?.readResult || resMap.get(l.fixtureId)?.safeBetResult) === "WIN").length;
          const odds = parseFloat(tier.totalOdds).toFixed(1);
          const tag  = wins === legs.length ? "✅ WIN" : wins > 0 ? "⚠️ PARTIAL" : "❌ LOSS";
          return { wins, total: legs.length, odds, tag };
        };

        const safe  = scoreTier(bets?.safe);
        const value = scoreTier(bets?.value);

        // ── Build ticker string ───────────────────────────────────────────
        const parts = [`📅 Yesterday ${yest}`];
        if (safe)  parts.push(`🛡️ Safe Bet: ${safe.tag} ${safe.wins}/${safe.total} · ×${safe.odds}`);
        if (value) parts.push(`⚡ Value Bet: ${value.tag} ${value.wins}/${value.total} · ×${value.odds}`);
        if (poolPct) parts.push(`🎯 Engine Pool: ${poolWins}/${poolTotal} hits · ${poolPct}%`);

        // Separator + duplicate for seamless loop feel
        const segment = parts.join("   ·   ");
        setText(`${segment}   ·   ${segment}`);
      } catch { /* silent */ }
    })();
  }, [historicalRates]);

  if (!text) return null;

  return (
    <div style={{
      position:"fixed", bottom:0, left:0, right:0, zIndex:300,
      background:C.surface, borderTop:`1px solid ${C.border}`,
      height:26, overflow:"hidden", display:"flex", alignItems:"center",
    }}>
      <span className="ticker-track" style={{
        fontSize:9, fontWeight:700, color:C.text,
        fontFamily:C.font, letterSpacing:".04em", lineHeight:1,
      }}>
        {text}
      </span>
    </div>
  );
}

// ── DAILY BEST BETS — Safe (2–10×) and Value (10–100×) ───────────────────
// Pre-generates the engine's two opinionated tickets for the day.
// Safe: stops when odds ≥ 2, max 10. Value: stops when odds ≥ 10, max 100.
// Recommended stake uses a simplified Kelly edge estimate.
function buildDailyBestBets(fixtures, historicalRates) {
  const pool = buildUniversalPool(fixtures, historicalRates);
  if (pool.length < 2) return { safe: null, value: null };

  // Safe tier — target 2×, cap 10× so it never drifts into value territory
  const safeUsed = new Set();
  const safeFull = buildOneParlayFromPool(pool, safeUsed, 2.0, 0);
  const safe = safeFull && parseFloat(safeFull.totalOdds) <= 10
    ? safeFull : (() => {
        // pool exhausted under 10× — still valid, just smaller
        const u2 = new Set();
        return buildOneParlayFromPool(pool, u2, 2.0, 0);
      })();

  // Value tier — start fresh from pool, target 10×, cap at 100×
  const valueUsed = new Set();
  const value = buildOneParlayFromPool(pool, valueUsed, 10.0, 0);

  // Recommended stake: simplified Kelly — assume edge = empirical rate - implied prob
  const kellyStake = (ticket, bankroll = 100) => {
    if (!ticket?.legs?.length) return 0;
    const avgEdge = ticket.legs.reduce((s, l) => {
      const implied = 1 / (parseFloat(l.odds) || 2);
      const edge = Math.max(0, (l.empiricalRate || 55) / 100 - implied);
      return s + edge;
    }, 0) / ticket.legs.length;
    const oddsN = parseFloat(ticket.totalOdds) || 1;
    const kelly = avgEdge / Math.max(oddsN - 1, 0.1);
    return parseFloat((Math.min(kelly, 0.05) * bankroll).toFixed(2)); // cap at 5% bankroll
  };

  return {
    safe:  safe  ? { ...safe,  tier:"safe",  label:"🛡️ Safe",  oddsRange:"2–10×",  recommendedStake: kellyStake(safe)  } : null,
    value: value ? { ...value, tier:"value", label:"⚡ Value", oddsRange:"10–100×", recommendedStake: kellyStake(value) } : null,
  };
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

// ── UNIVERSAL PARLEY ENGINE v1.0 ─────────────────────────────────────────
// Single pool + single builder used by both Builder and Jarvis.
// Calibrated from Apr 4–24 backtest (723 resolved games).

const CALIBRATION = {
  oddsFloor: {
    "Over 1.5":1.18, "Under 3.5":1.15, "Under 4.5":1.15,
    "Over 2.5":1.15, "Under 2.5":1.15, "Over 3.5":1.15,
    "BTTS":1.15, "1X2":1.15, "DC":1.15, "TeamTotal":1.15, _default:1.15,
  },
  blockedMarkets: new Set(["TeamTotal"]),
  bttsMinConf: 80,
  under35Guards: { maxOver25:37, minSeasonGames:16 },
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
  unknownMarketFallback: 0.55,
  modifiers: { lowConfPenalty:0.80, volatilePenalty:0.85, strongBoost:1.15, stratBoost:1.10 },
};

function getOddsFloor(market) {
  return CALIBRATION.oddsFloor[market] ?? CALIBRATION.oddsFloor._default;
}
function getEmpiricalRate(market, conf, historicalRates) {
  const band    = `${Math.floor(conf/5)*5}-${Math.floor(conf/5)*5+5}`;
  const bandData = historicalRates?.byProbBand?.[`${market}:${band}`];
  if (bandData?.total >= 5) return bandData.rate / 100;
  const mktData  = historicalRates?.byMarket?.[market];
  if (mktData?.total >= 5) return mktData.rate / 100;
  return CALIBRATION.unknownMarketFallback;
}
function isLeagueVolatile(league) { return league in CALIBRATION.volatileLeagues; }
function getVolatileBoost(league) { return CALIBRATION.volatileLeagues[league]?.boostRequired ?? 0; }

function evaluatePick(f, historicalRates) {
  const anchor = f.theRead?.anchor;
  if (!anchor || f.theRead?.isFallback) return null;
  const { market, prob:conf, odds:rawOdds, pick } = anchor;
  if (CALIBRATION.blockedMarkets.has(market)) return null;
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
  const logOdds = Math.log(odds) / Math.log(CALIBRATION.oddsLogBase);
  let score = empiricalRate * logOdds;
  if (f.markets?._lowConfidence)  score *= CALIBRATION.modifiers.lowConfPenalty;
  if (f.volatileLeague)           score *= CALIBRATION.modifiers.volatilePenalty;
  if (anchor.strong)              score *= CALIBRATION.modifiers.strongBoost;
  if (f.strategyTags?.length > 0) score *= CALIBRATION.modifiers.stratBoost;

  return {
    fixtureId:     f.id,
    game:          `${f.teams.home} vs ${f.teams.away}`,
    pick, odds: parseFloat(odds.toFixed(2)), conf, market, league, score,
    empiricalRate: parseFloat((empiricalRate * 100).toFixed(1)),
    strategyLabel: anchor.strong ? "STRONG" : "Read",
    strategyTags:  f.strategyTags || [],
    isVolatile:    isLeagueVolatile(league),
    fixture:       f,
  };
}

function buildUniversalPool(fixtures, historicalRates) {
  const pool = [];
  for (const f of fixtures) {
    const entry = evaluatePick(f, historicalRates);
    if (entry) pool.push(entry);
  }
  return pool.sort((a, b) => b.score - a.score);
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
function buildUniversalParley(fixtures, { targetOdds, historicalRates, budget = 0, budgetPct = 100 }) {
  const pool   = buildUniversalPool(fixtures, historicalRates);
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
  const usedIds = new Set();
  return { ...buildOneParlayFromPool(pool, usedIds, target, stake), poolSize: pool.length };
}

// Manual mode — N non-overlapping tickets from the same pool.
function buildManualParlays(fixtures, { numParlays, targetOdds, historicalRates, budget = 0, budgetPct = 100 }) {
  const pool   = buildUniversalPool(fixtures, historicalRates);
  const target = parseFloat(targetOdds) || 5.0;
  const n      = Math.max(1, Math.min(numParlays || 1, 10));
  const totalStake = parseFloat((budget * (budgetPct / 100)).toFixed(2));
  const stakeEach  = parseFloat((totalStake / n).toFixed(2));

  if (pool.length < 2) return [];

  const globalUsed = new Set();
  const tickets = [];
  for (let i = 0; i < n; i++) {
    const remaining = pool.filter(e => !globalUsed.has(e.fixtureId));
    if (remaining.length < 2) break;
    const localUsed = new Set(globalUsed);
    const ticket = buildOneParlayFromPool(remaining, localUsed, target, stakeEach);
    if (!ticket || !ticket.legs.length) break;
    ticket.legs.forEach(l => globalUsed.add(l.fixtureId));
    tickets.push({ ...ticket, id: i + 1, poolSize: pool.length });
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

// ── MARKET OPTIONS (kept for CustomListView buildPool compatibility) ──────
const MKOPTS = [
  { id:"theRead",  label:"📖 The Read"  },
  { id:"theEdge",  label:"🔮 The Edge"  },
  { id:"goalRadar",label:"🎯 Goal Radar"},
  { id:"over15",   label:"📈 Over 1.5"  }, { id:"over25",   label:"📈 Over 2.5"  }, { id:"over35", label:"📈 Over 3.5" },
  { id:"under25",  label:"📉 Under 2.5" }, { id:"under35",  label:"📉 Under 3.5" }, { id:"under45",label:"📉 Under 4.5"},
  { id:"bttsyes",  label:"⚽ BTTS Yes"  },
  { id:"homewin",  label:"🏠 Home Win"  }, { id:"awaywin",  label:"✈ Away Win"   },
  { id:"homeo05",  label:"H O0.5"       }, { id:"awayo05",  label:"A O0.5"       },
];

// ── INJECT HELPER ─────────────────────────────────────────────────────────
// Fetches results for a ticket's date and evaluates each leg inline.
async function injectTicketResults(ticket, ticketDate) {
  const date = ticketDate || todayStr();
  try {
    // Ensure results file exists for this date
    await fetch(`${SERVER}/api/fetch-results?date=${date}`, { headers:{"x-admin-token":"sterling77"} });

    // Normalise legs — backtest-upload needs fixtureId + market on every leg
    const legs = (ticket.legs || []).map(leg => ({
      fixtureId: leg.fixtureId || leg.id,
      game:      leg.game || `${leg.home || ""} vs ${leg.away || ""}`,
      pick:      leg.pick,
      market:    leg.market || inferMarket(leg.pick),
      conf:      leg.conf || leg.prob || null,
      strategyId: leg.strategyId || null,
    }));

    if (!legs.some(l => l.fixtureId)) {
      console.warn("injectTicketResults: no fixtureIds on legs — cannot match results");
      return null;
    }

    const res  = await fetch(`${SERVER}/api/backtest-upload`, {
      method: "POST",
      headers: { "Content-Type":"application/json" },
      body: JSON.stringify({ date, legs }),
    });
    if (!res.ok) { console.warn("backtest-upload error:", res.status); return null; }
    return await res.json(); // { parlayResult, legs: [{...leg, result, score}], summary }
  } catch(e) {
    console.error("injectTicketResults error:", e.message);
    return null;
  }
}

// ── LEAGUE FILTER ─────────────────────────────────────────────────────────
function LeagueFilter({ availableLeagues, leagueFilter, setLeagueFilter }) {
  const [open, setOpen] = useState(false);

  // Find if any league name appears more than once (same name, different leagueId)
  const nameCounts = useMemo(() => {
    const counts = {};
    availableLeagues.forEach(lg => { counts[lg.league] = (counts[lg.league] || 0) + 1; });
    return counts;
  }, [availableLeagues]);

  const activeLabel = useMemo(() => {
    if (!leagueFilter) return "All Leagues";
    const lg = availableLeagues.find(l => l.leagueId === leagueFilter);
    if (!lg) return "All Leagues";
    return nameCounts[lg.league] > 1 && lg.country ? `${lg.league} · ${lg.country}` : lg.league;
  }, [leagueFilter, availableLeagues, nameCounts]);

  return (
    <div style={{ marginBottom:6 }}>
      <button onClick={() => setOpen(o => !o)} className="gb"
        style={{ padding:"3px 12px",fontSize:9,background:leagueFilter?C.radarDim:"transparent",color:leagueFilter?C.radar:C.muted,border:`1px solid ${leagueFilter?C.radar:C.faint}`,display:"flex",alignItems:"center",gap:5 }}>
        <span>🌍</span>
        <span style={{ maxWidth:160,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap" }}>{activeLabel}</span>
        <span style={{ fontSize:8 }}>{open ? "▲" : "▼"}</span>
      </button>
      {open && (
        <div style={{ display:"flex",gap:4,flexWrap:"wrap",marginTop:5,padding:"8px 10px",background:C.surface,border:`1px solid ${C.border}`,borderRadius:8 }}>
          <button onClick={() => { setLeagueFilter(null); setOpen(false); }} className="gb"
            style={{ padding:"3px 10px",fontSize:9,background:!leagueFilter?C.radar:"transparent",color:!leagueFilter?C.accentText:C.muted,border:`1px solid ${!leagueFilter?C.radar:C.faint}` }}>
            All
          </button>
          {availableLeagues.map(lg => {
            const label = nameCounts[lg.league] > 1 && lg.country
              ? `${lg.league} · ${lg.country}` : lg.league;
            const active = leagueFilter === lg.leagueId;
            return (
              <button key={lg.leagueId} onClick={() => { setLeagueFilter(active ? null : lg.leagueId); setOpen(false); }} className="gb"
                style={{ padding:"3px 10px",fontSize:9,background:active?C.radarDim:"transparent",color:active?C.radar:C.muted,border:`1px solid ${active?C.radar:C.faint}`,maxWidth:190,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap" }} title={label}>
                {label}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ── DAILY BREAKDOWN TABLE ────────────────────────────────────────────────
// Replaces the small bar chart — shows each day as an expandable row with
// date · picks · wins · hit-rate, and (if the server returns d.picks) a
// drill-down list of every individual pick + result for that day.
function DailyBreakdownTable({ dailyTrend }) {
  const [expanded, setExpanded] = useState(null);
  const rows = [...dailyTrend].reverse(); // most recent first

  return (
    <div className="gc" style={{ padding:14, marginBottom:12 }}>
      <div style={{ fontSize:8,color:C.text,opacity:.55,textTransform:"uppercase",letterSpacing:".1em",marginBottom:10,fontWeight:700 }}>
        Daily Pick Report
      </div>

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

// ── POOL PERFORMANCE TAB ─────────────────────────────────────────────────
function PoolPerformanceTab({ serverUrl }) {
  const [data, setData]     = useState(null);
  const [loading, setLoading] = useState(true);
  const [days, setDays]     = useState(30);

  useEffect(() => {
    setLoading(true);
    fetch(`${serverUrl}/api/pool/performance?days=${days}`)
      .then(r => r.json())
      .then(d => { setData(d.empty ? null : d); setLoading(false); })
      .catch(() => { setData(null); setLoading(false); });
  }, [days]);

  const [bestBetHistory, setBestBetHistory] = useState(() => {
    try { return JSON.parse(localStorage.getItem("grm_bestbet_history_v1") || "[]"); } catch { return []; }
  });

  if (loading) return <div style={{ padding:40,textAlign:"center",color:C.muted,fontSize:10 }}>Loading performance data…</div>;

  return (
    <div style={{ paddingBottom:40 }}>

      {/* Engine Best Bets Track Record */}
      {bestBetHistory.length > 0 && (
        <div className="gc" style={{ padding:14,marginBottom:12 }}>
          <div style={{ fontSize:8,color:C.accent,textTransform:"uppercase",letterSpacing:".1em",fontWeight:800,marginBottom:10 }}>
            ⚡ Engine Best Bet History
          </div>
          <div style={{ display:"flex",flexDirection:"column",gap:8 }}>
            {bestBetHistory.slice(-10).reverse().map((entry, i) => {
              const resultColor = entry.result === "WIN" ? C.green : entry.result === "LOSS" ? C.red : C.muted;
              return (
                <div key={i} style={{ display:"flex",justifyContent:"space-between",alignItems:"center",padding:"7px 10px",background:C.surface,border:`1px solid ${C.border}`,borderRadius:7 }}>
                  <div>
                    <div style={{ fontSize:9,fontWeight:800,color:C.text }}>{entry.date}</div>
                    <div style={{ fontSize:8,color:C.muted,marginTop:1 }}>
                      {entry.tier === "safe" ? "🛡️ Safe" : "⚡ Value"} · {entry.legs} legs · ×{entry.odds}
                    </div>
                  </div>
                  <div style={{ textAlign:"right" }}>
                    <div style={{ fontSize:11,fontWeight:800,color:resultColor }}>{entry.result || "PENDING"}</div>
                    {entry.result === "WIN" && entry.stake > 0 && (
                      <div style={{ fontSize:8,color:C.green }}>+${(entry.stake * entry.odds - entry.stake).toFixed(2)}</div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

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
          <div style={{ fontSize:8,color:C.muted,textTransform:"uppercase",letterSpacing:".1em",marginBottom:8 }}>Overall · {data.period}</div>
          <div style={{ display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:8 }}>
            {[["Picks",data.overall.total],["Wins",data.overall.wins],["Hit Rate",`${data.overall.rate}%`],["Avg Odds",data.overall.avgOdds?.toFixed(2)+"×"]].map(([l,v])=>(
              <div key={l} style={{ textAlign:"center" }}>
                <div style={{ fontSize:16,fontWeight:800,color:parseFloat(v)>60?C.green:parseFloat(v)<45?C.red:C.gold }}>{v}</div>
                <div style={{ fontSize:7,color:C.muted,marginTop:2 }}>{l}</div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* By Market */}
      {data.byMarket && Object.keys(data.byMarket).length > 0 && (
        <div className="gc" style={{ padding:14,marginBottom:12 }}>
          <div style={{ fontSize:8,color:C.muted,textTransform:"uppercase",letterSpacing:".1em",marginBottom:10 }}>By Market</div>
          {Object.entries(data.byMarket).sort((a,b)=>b[1].total-a[1].total).map(([mkt,d]) => (
            <div key={mkt} style={{ display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:7 }}>
              <div style={{ fontSize:9,color:C.text,minWidth:100 }}>{mkt}</div>
              <div style={{ flex:1,height:4,background:C.faint,borderRadius:4,margin:"0 10px",overflow:"hidden" }}>
                <div style={{ height:"100%",width:`${d.rate}%`,background:d.rate>=65?C.green:d.rate>=50?C.gold:C.red,borderRadius:4,transition:"width .4s" }}/>
              </div>
              <div style={{ fontSize:9,fontWeight:700,color:d.rate>=65?C.green:d.rate>=50?C.gold:C.red,minWidth:36,textAlign:"right" }}>{d.rate}%</div>
              <div style={{ fontSize:8,color:C.muted,minWidth:30,textAlign:"right",marginLeft:6 }}>{d.total}</div>
            </div>
          ))}
        </div>
      )}

      {/* By Tag */}
      {data.byTag && Object.keys(data.byTag).length > 0 && (
        <div className="gc" style={{ padding:14,marginBottom:12 }}>
          <div style={{ fontSize:8,color:C.muted,textTransform:"uppercase",letterSpacing:".1em",marginBottom:10 }}>By Strategy Tag</div>
          {Object.entries(data.byTag).sort((a,b)=>b[1].total-a[1].total).map(([tag,d]) => (
            <div key={tag} style={{ display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:6 }}>
              <div style={{ fontSize:9,color:C.text,minWidth:120 }}>{tag.replace(/_/g," ")}</div>
              <div style={{ fontSize:9,fontWeight:700,color:d.rate>=65?C.green:d.rate>=50?C.gold:C.red }}>{d.rate}%</div>
              <div style={{ fontSize:8,color:C.muted,marginLeft:8 }}>{d.wins}/{d.total}</div>
            </div>
          ))}
        </div>
      )}

      {/* Daily Breakdown */}
      {data.dailyTrend?.length > 0 && (
        <DailyBreakdownTable dailyTrend={data.dailyTrend} />
      )}
      </>)}
    </div>
  );
}

// ── DAILY BEST BETS BANNER ────────────────────────────────────────────────
function DailyBestBetsBanner({ fixtures, historicalRates, onUseTier, date }) {
  const [open, setOpen] = useState(false);
  const [bets, setBets] = useState(null);

  useEffect(() => {
    if (!fixtures?.length || !historicalRates) return;
    const result = buildDailyBestBets(fixtures, historicalRates);
    setBets(result);
  }, [fixtures, historicalRates]);

  if (!bets || (!bets.safe && !bets.value)) return null;

  const safeOdds  = bets.safe  ? `×${parseFloat(bets.safe.totalOdds).toFixed(1)}`  : "—";
  const valueOdds = bets.value ? `×${parseFloat(bets.value.totalOdds).toFixed(1)}` : "—";

  return (
    <div style={{ marginBottom:14,border:`1px solid ${C.accentBorder}`,borderRadius:10,overflow:"hidden" }}>
      {/* Collapsed strip — always visible */}
      <button onClick={() => setOpen(o => !o)} style={{
        width:"100%", background:C.accentDim, border:"none", cursor:"pointer",
        padding:"9px 14px", display:"flex", alignItems:"center", gap:10,
        fontFamily:C.font,
      }}>
        <span style={{ fontSize:10,fontWeight:800,color:C.accent,letterSpacing:".08em",flex:1,textAlign:"left" }}>
          ⚡ Today's Engine Picks
        </span>
        <span style={{ fontSize:9,color:C.text,fontWeight:700 }}>
          🛡️ {safeOdds}
        </span>
        <span style={{ fontSize:9,color:C.text,fontWeight:700 }}>
          ⚡ {valueOdds}
        </span>
        <span style={{ fontSize:9,color:C.muted }}>{open ? "▲" : "▼"}</span>
      </button>

      {/* Expanded — two tier cards */}
      {open && (
        <div style={{ padding:"12px 14px", background:C.surface, display:"flex", flexDirection:"column", gap:12 }}>
          <div style={{ fontSize:8,color:C.muted,letterSpacing:".1em",textTransform:"uppercase" }}>
            Engine's best bets for {date} · tap "Use" to load as your ticket
          </div>
          {[bets.safe, bets.value].filter(Boolean).map(tier => {
            const odds  = parseFloat(tier.totalOdds);
            const stake = tier.recommendedStake;
            const estReturn = stake > 0 ? `$${(stake * odds).toFixed(2)}` : null;
            const color = tier.tier === "safe" ? C.green : C.accent;
            const dimBg = tier.tier === "safe" ? C.greenDim : C.accentDim;
            const bdrClr = tier.tier === "safe" ? `${C.green}40` : C.accentBorder;

            return (
              <div key={tier.tier} style={{ background:dimBg, border:`1px solid ${bdrClr}`, borderRadius:8, padding:"10px 12px" }}>
                {/* Tier header */}
                <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:8 }}>
                  <div>
                    <span style={{ fontSize:11,fontWeight:800,color, fontFamily:C.font }}>{tier.label}</span>
                    <span style={{ fontSize:8,color:C.muted,marginLeft:8,letterSpacing:".06em" }}>{tier.oddsRange}</span>
                  </div>
                  <div style={{ textAlign:"right" }}>
                    <div style={{ fontSize:14,fontWeight:800,color, fontFamily:C.font }}>×{odds.toFixed(2)}</div>
                    <div style={{ fontSize:8,color:C.muted }}>{tier.legs?.length} leg{tier.legs?.length !== 1 ? "s" : ""}</div>
                  </div>
                </div>

                {/* Legs preview */}
                <div style={{ display:"flex",flexDirection:"column",gap:4,marginBottom:10 }}>
                  {(tier.legs || []).map((leg, i) => (
                    <div key={i} style={{ display:"flex",justifyContent:"space-between",alignItems:"center" }}>
                      <div style={{ flex:1,minWidth:0 }}>
                        <div style={{ fontSize:8,color:C.muted,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap" }}>{leg.game}</div>
                        <div style={{ fontSize:9,fontWeight:700,color:mktStyle(leg.market).color }}>{leg.pick}</div>
                      </div>
                      <div style={{ fontSize:9,fontWeight:800,color:C.text,marginLeft:8,flexShrink:0 }}>×{leg.odds}</div>
                    </div>
                  ))}
                </div>

                {/* Stake + est return row */}
                <div style={{ display:"flex",justifyContent:"space-between",alignItems:"center",borderTop:`1px solid ${bdrClr}`,paddingTop:8 }}>
                  <div style={{ fontSize:8,color:C.muted }}>
                    Rec. stake <span style={{ color:C.text,fontWeight:700 }}>${stake.toFixed(2)}</span>
                    {estReturn && <span style={{ color:color,fontWeight:700,marginLeft:6 }}>→ est. {estReturn}</span>}
                  </div>
                  <button onClick={() => { onUseTier(tier); setOpen(false); }} className="gb"
                    style={{ background:color,color:C.accentText,border:"none",padding:"5px 14px",fontSize:9,fontWeight:800 }}>
                    Use →
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ── PARLAY & JARVIS PANEL ─────────────────────────────────────────────────
function ParlayJarvisTab({ fixtures, tickets, setTickets, draftLegs, setDraftLegs, budget, setBudget, budgetPct, setBudgetPct, numParlays, setNumParlays, targetOdds, setTargetOdds, marketFilter, toggleMarket, historicalRates, ensureHistoricalRates, date, onClose, engineFixtureIds, onAddLegToDraft }) {
  const [view, setView] = useState("parlay");
  const [builderMode, setBuilderMode] = useState("auto"); // "auto" | "manual"
  const [focusFixture, setFocus] = useState(null);
  const [returnTo, setReturnTo] = useState("parlay");
  const [building, setBuilding] = useState(false);
  const [autoMessage, setAutoMessage] = useState(null);
  const [analysing, setAnalysing] = useState(false); // Gemini analysis state for auto ticket
  const [autoAnalysis, setAutoAnalysis] = useState(null);
  const [savedTickets, setSavedTickets] = useState(() => loadSavedTickets());
  const [savedCodes, setSavedCodes] = useState(() => {
    try { return JSON.parse(localStorage.getItem("grm_saved_codes_v15") || "{}"); } catch { return {}; }
  });
  const [injectingId, setInjectingId] = useState(null);

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
  const handleInject = async (ticket, ticketSetter, ticketId) => {
    setInjectingId(ticketId);
    const result = await injectTicketResults(ticket, date);
    if (result?.legs) {
      const updatedLegs = ticket.legs.map((leg, i) => ({
        ...leg,
        _result: result.legs[i]?.result,
        _score:  result.legs[i]?.score,
      }));
      const updatedTicket = { ...ticket, legs:updatedLegs, _parlayResult:result.parlayResult };
      if (ticketSetter) ticketSetter(prev => prev.map(t => t.id === ticketId ? updatedTicket : t));
    }
    setInjectingId(null);
  };

  const draftTicket = draftLegs.length > 0 ? {
    id: "draft", source: "card_add",
    legs: draftLegs,
    totalOdds: draftLegs.reduce((s,l) => parseFloat((s*(parseFloat(l.odds)||1)).toFixed(4)), 1.0).toFixed(2),
    stake: 0, exhausted: false,
  } : null;

  const openFixture = (fixtureId, from) => {
    const f = fixtures.find(x => x.id === fixtureId);
    if (!f) return;
    setFocus(f); setReturnTo(from); setView("fixture");
  };

  const handleBuildParlay = async () => {
    setBuilding(true); setAutoMessage(null); setAutoAnalysis(null);
    const rates = await ensureHistoricalRates();
    if (builderMode === "auto") {
      const pool   = buildUniversalPool(fixtures, rates);
      const result = buildUniversalParley(fixtures, { targetOdds, historicalRates:rates, budget, budgetPct });
      setTickets([{ ...result, id:1, slotLabel:"🎯 Best Picks", slotId:"universal", isAuto:true }]);
      setAutoMessage(result.reason + (pool.length ? ` · pool: ${pool.length} qualifying` : ""));
      savePoolToServer(pool, date); // fire-and-forget
    } else {
      const results = buildManualParlays(fixtures, { numParlays, targetOdds, historicalRates:rates, budget, budgetPct });
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
        body: JSON.stringify({ ticket, fixtures }),
      });
      const data = await res.json();
      if (!res.ok || data.error) throw new Error(data.error || "Analysis failed");
      setAutoAnalysis(data.analysis || data.message || "No analysis returned.");
    } catch(e) {
      const msg = e.message?.toLowerCase();
      setAutoAnalysis(msg?.includes("429") || msg?.includes("rate")
        ? "🤓 Jarvis is taking a breather — rate limit hit. Try again in a minute."
        : "🤓 Jarvis is busy right now. Tap Analyse to retry.");
    }
    setAnalysing(false);
  };

  if (view === "fixture") return (
    <div style={{ position:"fixed",inset:0,background:C.bg,zIndex:200,overflowY:"auto",padding:16 }}>
      <button onClick={() => { setFocus(null); setView(returnTo); }} className="gb"
        style={{ marginBottom:16,padding:"6px 14px",background:"transparent",border:`1px solid ${C.radar}50`,color:C.radar,fontSize:10 }}>
        ← Back
      </button>
      <FixtureCard
        f={focusFixture}
        draftLegs={draftLegs}
        onAddToParlay={onAddLegToDraft}
        isEngineQualified={engineFixtureIds.has(focusFixture?.id)}
      />
    </div>
  );

  return (
    <div style={{ position:"fixed",inset:0,background:C.bg,zIndex:200,overflowY:"auto",padding:0 }}>
      {/* Tab bar */}
      <div style={{ display:"flex",borderBottom:`1px solid ${C.border}`,background:C.headerBg,position:"sticky",top:0,zIndex:10 }}>
        {[
          ["parlay",  `⚡ Builder${draftLegs.length+tickets.length>0?` (${draftLegs.length+tickets.length})`:""}`, C.gold],
          ["saved",   `📂 Saved${savedTickets.length>0?` (${savedTickets.length})`:""}`, C.radar],
          ["perf",    `📊 Performance`, C.edge],
        ].map(([id, label, color]) => (
          <button key={id} onClick={() => setView(id)} className="gb"
            style={{ flex:1,padding:"13px 0",background:"transparent",color:view===id?color:C.muted,border:"none",borderBottom:view===id?`2px solid ${color}`:"2px solid transparent",borderRadius:0,fontSize:10 }}>
            {label}
          </button>
        ))}
        <button onClick={onClose} className="gb" style={{ padding:"13px 16px",background:"transparent",color:C.muted,border:"none",borderRadius:0,fontSize:16 }}>✕</button>
      </div>

      <div style={{ padding:16,paddingBottom:80 }}>

        {/* PARLAY BUILDER */}
        {view === "parlay" && (
          <>
            {/* Daily Best Bets — collapsible engine picks */}
            {fixtures?.length > 0 && historicalRates && (
              <DailyBestBetsBanner
                fixtures={fixtures}
                historicalRates={historicalRates}
                date={date}
                onUseTier={tier => {
                  // Load the tier as draft legs — sheet is already open
                  setDraftLegs(tier.legs.map(l => ({ ...l })));
                }}
              />
            )}

            {draftTicket && (
              <div style={{ marginBottom:16 }}>
                <div style={{ fontSize:9,color:C.gold,fontWeight:800,textTransform:"uppercase",letterSpacing:".12em",marginBottom:8 }}>📝 Draft Ticket</div>
                <TicketCard
                  ticket={draftTicket} date={date} isJarvis={false}
                  onRemove={() => setDraftLegs([])}
                  onRemoveLeg={i => setDraftLegs(prev => prev.filter((_, idx) => idx !== i))}
                  onOpenFixture={id => openFixture(id, "parlay")}
                  onSaveInternal={stake => { saveTicketInternal(draftTicket, stake); setDraftLegs([]); }}
                  onInject={() => handleInject(draftTicket, (updater) => {
                    const updated = updater([draftTicket]);
                    if (updated?.[0]) setDraftLegs(updated[0].legs);
                  }, "draft")}
                  injecting={injectingId === "draft"}
                  savedCode={savedCodes[ticketContentKey(draftTicket)]}
                />
              </div>
            )}

            <div className="gc" style={{ padding:16,marginBottom:16 }}>

              {/* Mode toggle */}
              <div style={{ display:"flex",marginBottom:14,background:C.bg,borderRadius:8,padding:3,border:`1px solid ${C.border}` }}>
                {[["auto","⚡ Auto"],["manual","🎛 Manual"]].map(([id,label]) => (
                  <button key={id} onClick={() => setBuilderMode(id)} className="gb"
                    style={{ flex:1,padding:"7px 0",fontSize:10,fontWeight:700,background:builderMode===id?C.accent:"transparent",color:builderMode===id?C.accentText:C.muted,border:"none",borderRadius:6,transition:"all .15s" }}>
                    {label}
                  </button>
                ))}
              </div>

              <div style={{ fontSize:8,color:C.muted,marginBottom:12,lineHeight:1.6 }}>
                {builderMode === "auto"
                  ? <>Engine picks best single ticket from <span style={{ color:C.gold }}>The Read</span> pool · runs until target hit or pool exhausted.</>
                  : <>Builds <span style={{ color:C.gold }}>N non-overlapping tickets</span> — each picks from fixtures unused by previous tickets.</>
                }
              </div>

              <div style={{ display:"grid",gridTemplateColumns:"1fr 1fr",gap:10,marginBottom:12 }}>
                <div><div style={{ fontSize:8,color:C.muted,marginBottom:4,textTransform:"uppercase",letterSpacing:".1em" }}>Budget ($)</div><input type="number" value={budget} onChange={e=>setBudget(+e.target.value)} onFocus={e=>e.target.select()} className="gi"/></div>
                <div><div style={{ fontSize:8,color:C.muted,marginBottom:4,textTransform:"uppercase",letterSpacing:".1em" }}>Target Odds</div><input type="number" step="0.5" value={targetOdds} onChange={e=>setTargetOdds(+e.target.value)} onFocus={e=>e.target.select()} className="gi"/></div>
                {builderMode === "manual" && (
                  <div><div style={{ fontSize:8,color:C.muted,marginBottom:4,textTransform:"uppercase",letterSpacing:".1em" }}>Tickets (max 10)</div><input type="number" min={1} max={10} value={numParlays} onChange={e=>setNumParlays(Math.max(1,Math.min(10,+e.target.value)))} onFocus={e=>e.target.select()} className="gi"/></div>
                )}
                <div style={{ gridColumn: builderMode==="manual" ? "auto" : "span 1" }}>
                  <div style={{ fontSize:8,color:C.muted,marginBottom:4,textTransform:"uppercase",letterSpacing:".1em" }}>Budget % {budgetPct}%</div>
                  <input type="range" min={1} max={100} value={budgetPct} onChange={e=>setBudgetPct(+e.target.value)} style={{ width:"100%",marginTop:6 }}/>
                </div>
              </div>

              <button onClick={handleBuildParlay} disabled={building || !fixtures.length} className="gb"
                style={{ width:"100%",background:building?C.faint:C.accent,color:building?C.muted:C.accentText,padding:"12px 0",fontSize:13,fontWeight:800 }}>
                {building ? "BUILDING…" : builderMode === "auto" ? "⚡ BUILD BEST TICKET" : `⚡ BUILD ${numParlays} TICKET${numParlays>1?"S":""}`}
              </button>
            </div>

            {/* Auto mode — engine message + Gemini analysis */}
            {builderMode === "auto" && autoMessage && (
              <div style={{ background:`${C.edge}08`,border:`1px solid ${C.edge}30`,borderRadius:8,padding:"10px 14px",fontSize:9,color:C.edge,marginBottom:12 }}>
                {autoMessage}
              </div>
            )}
            {builderMode === "auto" && tickets.some(t=>t.isAuto) && (
              <div style={{ marginBottom:12 }}>
                {!autoAnalysis ? (
                  <button onClick={handleAutoAnalyse} disabled={analysing} className="gb"
                    style={{ width:"100%",background:analysing?C.faint:`${C.edge}18`,color:analysing?C.muted:C.edge,border:`1px solid ${C.edge}40`,padding:"8px 0",fontSize:10,fontWeight:700 }}>
                    {analysing ? <span className="pu">🤓 Jarvis analysing…</span> : "🤓 Ask Jarvis to Explain Picks"}
                  </button>
                ) : (
                  <div style={{ background:`${C.edge}08`,border:`1px solid ${C.edge}30`,borderRadius:8,padding:"12px 14px" }}>
                    <div style={{ fontSize:8,fontWeight:800,color:C.edge,letterSpacing:".1em",textTransform:"uppercase",marginBottom:6 }}>🤓 Jarvis Analysis</div>
                    <div style={{ fontSize:9,color:C.text,lineHeight:1.6,whiteSpace:"pre-wrap" }}>{autoAnalysis}</div>
                    <button onClick={()=>setAutoAnalysis(null)} className="gb"
                      style={{ marginTop:8,background:"transparent",border:`1px solid ${C.faint}`,color:C.muted,padding:"3px 10px",fontSize:8 }}>
                      ↺ Re-analyse
                    </button>
                  </div>
                )}
              </div>
            )}

            {tickets.length > 0 && (
              <>
                <div style={{ display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:10 }}>
                  <span style={{ fontSize:9,color:C.muted }}>{tickets.length} built ticket{tickets.length>1?"s":""}</span>
                  <button onClick={() => setTickets([])} className="gb" style={{ fontSize:9,color:C.red,border:`1px solid ${C.red}40`,padding:"3px 8px" }}>Clear all</button>
                </div>
                <div style={{ display:"flex",flexDirection:"column",gap:8 }}>
                  {tickets.map(t => (
                    <TicketCard key={t.id} ticket={t} date={date} isJarvis={false}
                      onRemove={() => setTickets(prev => prev.filter(x => x.id !== t.id))}
                      onOpenFixture={id => openFixture(id, "parlay")}
                      onSaveInternal={stake => saveTicketInternal(t, stake)}
                      onInject={() => handleInject(t, setTickets, t.id)}
                      injecting={injectingId === t.id}
                      savedCode={savedCodes[ticketContentKey(t)]}
                    />
                  ))}
                </div>
              </>
            )}
          </>
        )}

        {/* PERFORMANCE TAB */}
        {view === "perf" && <PoolPerformanceTab serverUrl={SERVER} />}

        {/* SAVED */}
        {view === "saved" && (
          <>
            {!savedTickets.length && (
              <div style={{ textAlign:"center",padding:"60px 0",color:C.text,opacity:.3,fontSize:11,textTransform:"uppercase",letterSpacing:".15em" }}>
                No saved tickets yet<br/>
                <span style={{ fontSize:9,marginTop:8,display:"block" }}>Save a ticket from Builder or Jarvis</span>
              </div>
            )}
            <div style={{ display:"flex",flexDirection:"column",gap:10 }}>
              {savedTickets.map(t => (
                <div key={t.code} style={{ background:C.surface,border:`1px solid ${C.border}`,borderRadius:12,padding:"12px 14px" }}>
                  <div style={{ display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:8 }}>
                    <div>
                      <span style={{ fontSize:11,fontWeight:800,color:C.radar,letterSpacing:".08em" }}>{t.code}</span>
                      <span style={{ fontSize:8,color:C.muted,marginLeft:8 }}>{t.date} · {t.legs?.length||0} legs · ×{t.totalOdds}</span>
                    </div>
                    <div style={{ display:"flex",gap:6,alignItems:"center",flexWrap:"wrap" }}>
                      <CopyCodeButton code={t.code} />
                      <button onClick={() => {
                        // Reload saved ticket back into the builder as a new ticket
                        const reloaded = { ...t, id: Date.now(), source:"card_add", exhausted:false };
                        setTickets(prev => [...prev, reloaded]);
                        setView("parlay");
                      }} className="gb" style={{ background:`${C.gold}15`,border:`1px solid ${C.goldBorder}`,color:C.gold,padding:"2px 8px",fontSize:9,fontWeight:700 }}>
                        ↩ Load
                      </button>
                      <button onClick={() => deleteSavedTicket(t.code)} style={{ background:"none",border:"none",color:C.muted,cursor:"pointer",fontSize:13,padding:0 }}>✕</button>
                    </div>
                  </div>
                  {t.stake > 0 && (
                    <div style={{ fontSize:9,color:C.muted,marginBottom:6 }}>
                      Stake ${t.stake} · Return ${parseFloat((t.stake*parseFloat(t.totalOdds)).toFixed(2))}
                    </div>
                  )}
                  <div style={{ display:"flex",flexDirection:"column",gap:3 }}>
                    {(t.legs||[]).map((leg, i) => (
                      <div key={i} style={{ display:"flex",justifyContent:"space-between",fontSize:9,color:C.muted }}>
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
export default function GRMPro() {

  // ── THEME ─────────────────────────────────────────────────────────────────
  const [theme, setTheme] = useState(loadSavedTheme);
  const [themePickerOpen, setThemePickerOpen] = useState(false);

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
  const [loading, setLoading]     = useState(false);
  const [error, setError]         = useState(null);
  const [cached, setCached]       = useState(false);
  const [legacySnapshot, setLegacySnapshot] = useState(false);

  const [tab, setTab]             = useState("all");
  const [search, setSearch]       = useState("");
  const [leagueFilter, setLeagueFilter] = useState(null);

  const [budget, setBudget]       = useState(100);
  const [budgetPct, setBudgetPct] = useState(10);
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

  const [parlayJarvisOpen, setParlayJarvisOpen] = useState(false);
  const [draftLegs, setDraftLegs] = useState([]);
  const [adminMode, setAdminMode] = useState(() => {
    try { return sessionStorage.getItem("grm_admin") === "1"; } catch { return false; }
  });

  const [adminPromptOpen, setAdminPromptOpen] = useState(false);
  const [adminTokenInput, setAdminTokenInput] = useState("");
  const [helpOpen, setHelpOpen] = useState(false);

  const toggleAdmin = () => {
    if (adminMode) {
      setAdminMode(false);
      try { sessionStorage.removeItem("grm_admin"); } catch {}
      return;
    }
    setAdminPromptOpen(true);
    setAdminTokenInput("");
  };

  const submitAdminToken = () => {
    if (adminTokenInput === "sterling77") {
      setAdminMode(true);
      try { sessionStorage.setItem("grm_admin", "1"); } catch {}
    }
    setAdminPromptOpen(false);
    setAdminTokenInput("");
  };

  // Add a pick from fixture card to draft legs
  const addLegToDraft = useCallback((fixture, pick) => {
    const state = (fixture.state || "").toLowerCase().replace(/[_\-\s]/g, "");
    if (state === "finished" || state === "ft" || state === "fulltime" || state === "ended" || state === "complete") return;
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
    try {
      const raw = localStorage.getItem(CACHE_KEY);
      if (!raw) return;
      const { date:d, data } = JSON.parse(raw);
      if (d === date && Array.isArray(data) && data.length) { setFixtures(data); setCached(true); }
    } catch {}
  }, []);

  const startPolling = session => {
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = setInterval(async () => {
      try {
        const r = await fetch(`${SERVER}/api/progress?session=${session}`), d = await r.json();
        setProgress(d.pct||0); setProgressStage(d.stage||""); setProgressMsg(d.message||"");
        if (d.stage === "done" || d.stage === "error" || d.pct >= 100) { clearInterval(pollRef.current); pollRef.current = null; }
      } catch {}
    }, 800);
  };
  const stopPolling = () => { if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; } };
  useEffect(() => () => stopPolling(), []);

  const fetchData = useCallback(async (force = false) => {
    setLoading(true); setError(null); setCached(false); setLegacySnapshot(false); setTickets([]);
    setProgress(0); setProgressStage("starting"); setProgressMsg("Initialising…");
    const session = `${Date.now()}_${Math.random().toString(36).slice(2,8)}`;
    sessionIdRef.current = session; startPolling(session);
    try {
      const res = await fetch(`${SERVER}/api/grm-pro-data?date=${date}&session=${session}${force?"&force=1":""}`);
      if (!res.ok) { const e = await res.json().catch(()=>({})); throw new Error(e.error||res.statusText); }
      const json = await res.json(), data = Array.isArray(json.data) ? json.data : [];
      setFixtures(data); safeCacheWrite(CACHE_KEY, { date, data });
      if (json.legacySchema) setLegacySnapshot(true);
      setProgress(100); setProgressStage("done"); setProgressMsg(`${data.length} fixtures ready`);

      // Auto-save pool silently after fetch — every fetched date contributes to training data.
      // Uses empty rates initially; rates warm up via ensureHistoricalRates shortly after.
      if (data.length) {
        const rates = historicalRates || {};
        const pool  = buildUniversalPool(data, rates);
        if (pool.length) savePoolToServer(pool, date); // fire-and-forget
      }
    } catch(e) { setError(e.message); setProgressStage("error"); setProgressMsg(e.message); }
    finally { stopPolling(); setLoading(false); }
  }, [date]);

  const loadSnapshot = useCallback(async snapDate => {
    setLoading(true); setError(null); setCached(false); setLegacySnapshot(false); setTickets([]);
    try {
      const res = await fetch(`${SERVER}/api/load-snapshot?date=${snapDate}`);
      if (!res.ok) { const e = await res.json().catch(()=>({})); throw new Error(e.error||res.statusText); }
      const json = await res.json(), data = Array.isArray(json.data) ? json.data : [];
      setFixtures(data); setDate(snapDate); setCached(true);
      if (json.legacySchema) setLegacySnapshot(true);
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

  // ── AUTO RESULTS REFRESH ─────────────────────────────────────────────────
  // Polls /api/load-snapshot every 60s when fixtures are loaded for today.
  // Merges updated scores and states back into fixtures without re-running model.
  const resultsRefreshRef = useRef(null);
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
        // Only update score/state/result fields — preserve model data from original
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

  const startResultsRefresh = useCallback((forDate) => {
    if (resultsRefreshRef.current) clearInterval(resultsRefreshRef.current);
    resultsRefreshRef.current = setInterval(async () => {
      if (forDate !== todayStr()) { clearInterval(resultsRefreshRef.current); return; }
      try {
        // Poll the results file — it has live state updates from the server loop.
        // The snapshot is frozen at fetch time and won't reflect live/PPD changes.
        const res = await fetch(`${SERVER}/api/load-results?date=${forDate}`);
        if (!res.ok) return;
        const json = await res.json();
        const data = json.results || json.data || [];
        if (Array.isArray(data) && data.length) mergeResultsIntoFixtures(data);
      } catch {}
    }, 45_000); // every 45s — fast enough to catch state changes without hammering
  }, [mergeResultsIntoFixtures]);

  const stopResultsRefresh = useCallback(() => {
    if (resultsRefreshRef.current) { clearInterval(resultsRefreshRef.current); resultsRefreshRef.current = null; }
  }, []);

  // Start refresh loop whenever fixtures are loaded for today
  useEffect(() => {
    if (fixtures.length && activeTab === "live") {
      if (date === todayStr()) startResultsRefresh(date);
      else stopResultsRefresh();
      ensureHistoricalRates();
    } else {
      stopResultsRefresh();
    }
    return () => stopResultsRefresh();
  }, [fixtures.length > 0, date, activeTab]);

  // ── Live states ticker — polls /api/live-states every 45s ────────────────
  const liveTickerRef = useRef(null);
  const pollLiveStates = useCallback(async (d) => {
    if (!d) return;
    try {
      const res  = await fetch(`${SERVER}/api/live-states?date=${d}`);
      const data = await res.json();
      if (!data.states?.length) return;
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
    } catch {}
  }, []);

  useEffect(() => {
    if (!fixtures.length || activeTab !== "live") return;
    pollLiveStates(date);
    liveTickerRef.current = setInterval(() => pollLiveStates(date), 45_000);
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

  const enginePool = useMemo(() => {
    return buildUniversalPool(fixtures, historicalRates || {});
  }, [fixtures, historicalRates]);

  const engineFixtureIds = useMemo(() => new Set(enginePool.map(e => e.fixtureId)), [enginePool]);

  const TABS = [
    { id:"all",    label:`All (${counts.total})` },
    { id:"engine", label:`The Engine (${enginePool.length})`, color:C.gold },
    { id:"custom", label:"Custom",                           color:C.muted },
  ];

  const filtered = useMemo(() => {
    if (tab === "custom") return fixtures;
    if (tab === "engine") {
      let list = fixtures.filter(f => engineFixtureIds.has(f.id));
      if (search) { const s = search.toLowerCase(); list = list.filter(f => f.teams.home.toLowerCase().includes(s) || f.teams.away.toLowerCase().includes(s) || (f.league||"").toLowerCase().includes(s)); }
      if (leagueFilter) list = list.filter(f => f.leagueId === leagueFilter);
      return list.sort((a,b) => {
        const sa = enginePool.find(e=>e.fixtureId===a.id)?.score||0;
        const sb = enginePool.find(e=>e.fixtureId===b.id)?.score||0;
        return sb - sa;
      });
    }
    let list = [...fixtures];
    if (search) { const s = search.toLowerCase(); list = list.filter(f => f.teams.home.toLowerCase().includes(s) || f.teams.away.toLowerCase().includes(s) || (f.league||"").toLowerCase().includes(s)); }
    if (leagueFilter) list = list.filter(f => f.leagueId === leagueFilter);
    list = [...list].sort((a, b) => {
      const ra = a.leagueRank ?? (LEAGUE_RANK[a.league] ?? 999);
      const rb = b.leagueRank ?? (LEAGUE_RANK[b.league] ?? 999);
      if (ra !== rb) return ra - rb;
      return (a.startingAt || "").localeCompare(b.startingAt || "");
    });
    return list;
  }, [fixtures, tab, search, leagueFilter, enginePool, engineFixtureIds]);

  return (
    <div style={{ minHeight:"100vh",background:C.bg,fontFamily:C.font,paddingBottom:66 }}>

      {/* ── SINGLE STICKY BLOCK — header + tab/search row ────────────────── */}
      <div style={{ position:"sticky",top:0,zIndex:50,background:C.headerBg,backdropFilter:"blur(24px)",borderBottom:`1px solid ${C.headerBorder}` }}>

        {/* Top row: GRM PRO + counts + date/fetch */}
        <div style={{ padding:"12px 16px",display:"flex",justifyContent:"space-between",alignItems:"center",gap:12,flexWrap:"wrap" }}>
          <div>
            <div style={{ fontSize:16,fontWeight:800,letterSpacing:"-.04em",color:C.text }}>
              GRM <span style={{ color:C.gold }}>PRO</span>
              <span style={{ fontSize:9,color:C.faint,fontWeight:400,marginLeft:8 }}>v15.0</span>
              {cached && <span style={{ fontSize:8,color:C.muted,marginLeft:6 }}>● cached</span>}
              {lastResultsRefresh && <span style={{ fontSize:7,color:C.green,marginLeft:6 }}>↺ {lastResultsRefresh}</span>}
              {legacySnapshot && <span style={{ fontSize:7,color:C.amber,marginLeft:6,background:C.amberDim,border:`1px solid ${C.amber}30`,borderRadius:3,padding:"1px 4px" }}>Legacy</span>}
            </div>
            <div style={{ fontSize:8,color:C.text,letterSpacing:".12em",textTransform:"uppercase",marginTop:1 }}>
              Dixon-Coles · Deflation · The Read · The Edge · Goal Radar
            </div>
            <div style={{ display:"flex",gap:6,marginTop:8,flexWrap:"wrap" }}>
              {[["live","Live Model"],["backtest","Backtest"]].map(([id,label]) => (
                <button key={id} onClick={() => setActiveTab(id)} className="gb"
                  style={{ padding:"4px 12px",fontSize:9,background:activeTab===id?C.accent:"transparent",color:activeTab===id?C.accentText:C.muted,border:`1px solid ${activeTab===id?C.accent:C.faint}` }}>
                  {label}
                </button>
              ))}
            </div>
          </div>

          {/* Counts — only when fixtures loaded */}
          {activeTab === "live" && fixtures.length > 0 && (
            <div style={{ display:"flex",gap:12 }}>
              {[["TOTAL",counts.total,C.text],["READ",counts.read,C.gold],["EDGE",counts.edge,C.edge],["RADAR",counts.radar,C.radar]].map(([l,v,c]) => (
                <div key={l} style={{ textAlign:"center" }}>
                  <div style={{ fontSize:7,color:C.muted,letterSpacing:".1em",textTransform:"uppercase",marginBottom:1 }}>{l}</div>
                  <div style={{ fontSize:16,fontWeight:800,color:c }}>{v}</div>
                </div>
              ))}
            </div>
          )}

          {/* Date / Fetch / Admin controls */}
          {activeTab === "live" && (
            <div style={{ display:"flex",gap:5,alignItems:"center",flexWrap:"wrap" }}>
              <input type="date" value={date} onChange={e=>setDate(e.target.value)} className="gi" style={{ color:C.gold,width:140,fontSize:10 }}/>
              <button onClick={() => fetchData(false)} disabled={loading} className="gb"
                style={{ background:loading?C.faint:C.accent,color:loading?C.muted:C.accentText,padding:"7px 16px",fontSize:10 }}>
                {loading ? <span className="pu">LOADING…</span> : "FETCH"}
              </button>
              {adminMode && (
                <button onClick={() => fetchData(true)} disabled={loading} className="gb"
                  style={{ background:"transparent",border:`1px solid ${C.radar}50`,color:C.radar,padding:"7px 10px",fontSize:9 }}>
                  ↺
                </button>
              )}
              {adminMode && fixtures.length > 0 && (
                <button onClick={async () => {
                  try {
                    const res = await fetch(`${SERVER}/api/refresh-odds?date=${date}`, { method:"POST", headers:{"x-admin-token":"sterling77"} });
                    const d = await res.json();
                    if (d.updated) { const r = await fetch(`${SERVER}/api/load-snapshot?date=${date}`); const j = await r.json(); if (j.data) { setFixtures(j.data); setLastResultsRefresh(new Date().toLocaleTimeString([],{hour:"2-digit",minute:"2-digit"})); } }
                  } catch {}
                }} className="gb"
                  style={{ background:"transparent",border:`1px solid ${C.gold}50`,color:C.gold,padding:"7px 10px",fontSize:9 }}>
                  $
                </button>
              )}
              <button onClick={toggleAdmin} className="gb"
                style={{ background:adminMode?"C.redDim":"transparent",border:`1px solid ${adminMode?C.red:C.faint}`,color:adminMode?C.red:C.faint,padding:"7px 8px",fontSize:9 }}>
                {adminMode ? "🔓" : "🔒"}
              </button>
              <button onClick={() => setHelpOpen(true)} className="gb"
                style={{ background:"transparent",border:`1px solid ${C.faint}`,color:C.muted,padding:"7px 10px",fontSize:9 }}>
                How it works
              </button>
            </div>
          )}
        </div>

        {/* Tab + search row — only when fixtures loaded */}
        {activeTab === "live" && fixtures.length > 0 && (
          <div style={{ padding:"8px 16px 8px",borderTop:`1px solid ${C.border}` }}>
            <div style={{ display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:6,flexWrap:"wrap",gap:6 }}>
              <div style={{ display:"flex",gap:5,flexWrap:"wrap" }}>
                {TABS.map(t => (
                  <button key={t.id} onClick={() => {
                    setTab(t.id);
                    if (t.id === "custom") setLeagueFilter(null);
                  }} className="gb"
                    style={{ padding:"5px 12px",background:tab===t.id?(t.color||C.text):"transparent",color:tab===t.id?C.accentText:(t.color||C.muted),border:`1px solid ${tab===t.id?(t.color||C.text):C.faint}`,opacity:tab===t.id?1:0.75,fontSize:10 }}>
                    {t.label}
                  </button>
                ))}
              </div>
              <div style={{ display:"flex",gap:6,alignItems:"center" }}>
                <input type="text" placeholder="Search…" value={search} onChange={e=>setSearch(e.target.value)} className="gi" style={{ width:120,fontSize:10 }}/>
                {/* Theme button — visible here, not buried in admin controls */}
                <button onClick={() => setThemePickerOpen(true)} className="gb"
                  style={{ background:C.accentDim,border:`1px solid ${C.accentBorder}`,color:C.accent,padding:"6px 10px",fontSize:9,flexShrink:0,whiteSpace:"nowrap" }}>
                  🎨 Change Theme<span className="theme-label"> Theme</span>
                </button>
              </div>
            </div>
            {availableLeagues.length > 1 && tab !== "custom" && tab !== "engine" && (
              <LeagueFilter availableLeagues={availableLeagues} leagueFilter={leagueFilter} setLeagueFilter={setLeagueFilter} />
            )}
          </div>
        )}

      </div>
      {/* ── END STICKY BLOCK ─────────────────────────────────────────────── */}

      {activeTab === "backtest" && <BacktestTab loadSnapshot={loadSnapshot} adminMode={adminMode} onReloadFixtures={async (d) => { if (d === date) { const r = await fetch(`${SERVER}/api/load-snapshot?date=${d}`); const j = await r.json(); if (j.data) { setFixtures(j.data); setLastResultsRefresh(new Date().toLocaleTimeString([],{hour:"2-digit",minute:"2-digit"})); } } }} />}

      {activeTab === "live" && (
        <div style={{ maxWidth:1480,margin:"0 auto",padding:activeTab==="live"?"28px 16px 0":"28px 24px 0" }}>
          {error && <div style={{ background:C.redDim,border:"1px solid rgba(248,113,113,0.2)",borderRadius:10,padding:"12px 18px",marginBottom:24,fontSize:12,color:C.red }}>✕ {error}</div>}
          {!loading && !error && !fixtures.length && (
            <div style={{ textAlign:"center",padding:"80px 0",color:C.faint,fontSize:11,letterSpacing:".18em",textTransform:"uppercase" }}>Select a date and press FETCH</div>
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
                  {progressStage==="fixtures"?"📋 Fetching Fixtures"
                    :progressStage==="standings"?"🏆 League Standings"
                    :progressStage==="stats"?"📊 Team Stats"
                    :progressStage==="processing"?"⚙️ Processing"
                    :progressStage==="saving"?"💾 Saving"
                    :progressStage==="done"?"✓ Done"
                    :"⏳ Starting…"}
                </span>
                <span style={{ fontSize:14,fontWeight:800,color:progress<30?C.blue:progress<70?C.accent:progress<95?C.orange:C.green }}>{progress}%</span>
              </div>
              <div style={{ height:6,background:C.subtleBg,borderRadius:6,overflow:"hidden",marginBottom:10,position:"relative" }}>
                <div style={{ height:"100%",width:`${progress}%`,background:progress<30?C.blue:progress<70?C.accent:progress<95?C.orange:C.green,borderRadius:6,transition:"width 0.6s ease,background 0.4s ease",position:"relative" }}>
                  <div style={{ position:"absolute",inset:0,borderRadius:6,background:"linear-gradient(90deg,transparent,rgba(255,255,255,0.2),transparent)",animation:"shimmer 1.8s infinite" }}/>
                </div>
              </div>
              <div style={{ fontSize:9,color:C.muted,textAlign:"center",minHeight:16,lineHeight:1.5,marginBottom:24 }}>{progressMsg}</div>
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
                <CustomListView
                  fixtures={fixtures} search={search}
                  draftLegs={draftLegs} onAddToParlay={addLegToDraft}
                  onAddToTicket={ticket => {
                    setDraftLegs(prev => {
                      const existing = new Set(prev.map(l => l.fixtureId));
                      const newLegs  = (ticket.legs||[]).filter(l => !existing.has(l.fixtureId));
                      return [...prev, ...newLegs];
                    });
                    setParlayJarvisOpen(true);
                  }}
                />
              ) : (
                <>
                  <div className="grm-grid" style={{ display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(380px,1fr))",gap:14,paddingBottom:80 }}>
                    {filtered.map(f => (
                      <FixtureCard key={f.id} f={f} onAddToParlay={addLegToDraft} draftLegs={draftLegs} isEngineQualified={engineFixtureIds.has(f.id)} />
                    ))}
                  </div>
                  {!filtered.length && (
                    <div style={{ textAlign:"center",padding:"60px 0",color:C.faint,fontSize:11,textTransform:"uppercase",letterSpacing:".15em" }}>No matches found</div>
                  )}
                </>
              )}
            </>
          )}
        </div>
      )}

      {/* Floating parlay button */}
      {activeTab === "live" && fixtures.length > 0 && (
        <button onClick={() => setParlayJarvisOpen(true)}
          style={{ position:"fixed",bottom:50,right:16,zIndex:150,background:C.edge,border:"none",cursor:"pointer",boxShadow:`0 4px 20px ${C.edgeBorder}`,borderRadius:24,padding:"10px 16px",display:"flex",alignItems:"center",gap:8 }}>
          <span style={{ fontSize:16,lineHeight:1 }}>📜</span>
          <span style={{ fontSize:9,fontWeight:800,color:C.accentText,letterSpacing:".04em",textTransform:"uppercase" }}>Parley System</span>
          {(draftLegs.length + tickets.length) > 0 && (
            <span style={{ background:C.accent,color:C.accentText,borderRadius:"50%",width:18,height:18,fontSize:9,fontWeight:900,display:"flex",alignItems:"center",justifyContent:"center",fontFamily:C.font }}>
              {draftLegs.length + tickets.length}
            </span>
          )}
        </button>
      )}

      {/* ── THEME PICKER ──────────────────────────────────────────────────── */}
      {themePickerOpen && (
        <div style={{ position:"fixed",inset:0,zIndex:700,background:"rgba(0,0,0,0.65)",display:"flex",alignItems:"flex-end",justifyContent:"center" }}
          onClick={() => setThemePickerOpen(false)}>
          <div style={{ background:C.modalBg,borderRadius:"20px 20px 0 0",border:`1px solid ${C.border}`,padding:"16px 16px 36px",width:"100%",maxWidth:480,fontFamily:C.font }}
            onClick={e => e.stopPropagation()}>
            <div style={{ width:36,height:4,borderRadius:2,background:C.text,opacity:.2,margin:"0 auto 16px" }}/>
            <div style={{ fontSize:11,fontWeight:800,color:C.text,letterSpacing:".1em",textTransform:"uppercase",marginBottom:14 }}>🎨 Change Theme</div>
            <div style={{ display:"flex",flexDirection:"column",gap:8 }}>
              {THEMES.map(t => {
                const active = theme.id === t.id;
                return (
                  <button key={t.id} onClick={() => pickTheme(t)} style={{
                    display:"flex",alignItems:"center",gap:12,
                    background: active ? t.accentDim : t.surface,
                    border:`1px solid ${active ? t.accent : t.border}`,
                    borderRadius:Math.min(t.cardRadius||12,14),
                    padding:"12px 14px",cursor:"pointer",textAlign:"left",
                    width:"100%",transition:"all .15s",
                    boxShadow: active ? `0 0 0 2px ${t.accent}30` : "none",
                  }}>
                    <div style={{ display:"flex",gap:4,flexShrink:0 }}>
                      {[t.bg,t.accent,t.green,t.blue,t.radar].map((clr,i) => (
                        <div key={i} style={{ width:13,height:13,borderRadius:"50%",background:clr,border:`1px solid ${t.border}`,flexShrink:0 }}/>
                      ))}
                    </div>
                    <div style={{ flex:1,minWidth:0 }}>
                      <div style={{ fontFamily:'"JetBrains Mono",monospace',fontSize:11,fontWeight:800,color:t.text }}>{t.emoji} {t.name}</div>
                      <div style={{ fontFamily:'"JetBrains Mono",monospace',fontSize:8,color:t.muted,marginTop:2,letterSpacing:".04em" }}>{t.desc}</div>
                    </div>
                    {active && <div style={{ fontSize:12,color:t.accent,fontWeight:800,flexShrink:0 }}>✓</div>}
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {/* GRM Explainer Modal */}
      {helpOpen && (
        <div style={{ position:"fixed",inset:0,zIndex:600,background:"rgba(0,0,0,0.85)",display:"flex",alignItems:"flex-end",justifyContent:"center" }}
          onClick={() => setHelpOpen(false)}>
          <div style={{ background:C.modalBg,borderRadius:"16px 16px 0 0",border:`1px solid ${C.border}`,padding:"24px 20px",width:"100%",maxWidth:480,maxHeight:"85vh",overflowY:"auto" }}
            onClick={e => e.stopPropagation()}>
            <div style={{ display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:16 }}>
              <div style={{ fontSize:14,fontWeight:800,color:C.accent }}>⚡ How GRM Works</div>
              <button onClick={() => setHelpOpen(false)} className="gb"
                style={{ background:"transparent",border:"none",color:C.muted,fontSize:18,padding:0 }}>✕</button>
            </div>
            {[
              ["📖 The Read",  C.gold,  "The model's main pick for each fixture. Built from xG, team form, standings and Dixon-Coles ratings. Shows confidence % and implied odds. Tap + Add to Ticket to include it in your parley."],
              ["🔮 The Edge",  C.edge,  "A secondary pick where the model sees value vs the bookmaker's odds. Only fires when the model's probability is significantly higher than what the odds imply. Higher risk, higher reward."],
              ["🎯 Goal Radar", C.radar, "Team-specific scoring probability. Shows each team's chance of scoring at least once or twice. Use it to build Team Total legs or confirm BTTS picks."],
              ["⚡ The Engine", C.gold,  "The automated parley builder. Scores every qualifying pick using empirical win rates × log(odds), filters out PPD/live games, and builds the best ticket(s) for your target odds. Gets smarter as more results come in."],
              ["🎟️ Parley System", C.edge, "Open via the '📜 Parley System' button. Build a draft by adding picks from cards, then hit Build in Auto or Manual mode. Book directly to SportyBet or Lucky's Ledger — opens the app on mobile."],
              ["🔒 Custom List",C.radar, "The Custom tab lets you browse fixtures by strategy (Home Win, BTTS Value etc.) and select multiple games for a single parley. Sort is by confidence descending within each strategy."],
              ["📊 Performance",C.muted,"Tracks the engine's historical hit rate by market, strategy tag, and probability band. Updates automatically as results come in each day."],
            ].map(([title, color, desc]) => (
              <div key={title} style={{ marginBottom:16,borderLeft:`3px solid ${color}`,paddingLeft:12 }}>
                <div style={{ fontSize:11,fontWeight:800,color,marginBottom:4 }}>{title}</div>
                <div style={{ fontSize:9,color:C.muted,lineHeight:1.6 }}>{desc}</div>
              </div>
            ))}
            <div style={{ fontSize:8,color:C.text,opacity:.3,textAlign:"center",marginTop:8 }}>Tap anywhere outside to close</div>
          </div>
        </div>
      )}
      {adminPromptOpen && (
        <div style={{ position:"fixed",inset:0,zIndex:500,background:"rgba(0,0,0,0.7)",display:"flex",alignItems:"center",justifyContent:"center" }}
          onClick={() => setAdminPromptOpen(false)}>
          <div style={{ background:C.modalBg,border:`1px solid ${C.gold}40`,borderRadius:12,padding:"24px",width:280 }}
            onClick={e => e.stopPropagation()}>
            <div style={{ fontSize:10,color:C.gold,fontWeight:800,letterSpacing:".12em",textTransform:"uppercase",marginBottom:12 }}>🔒 Admin Token</div>
            <input type="password" value={adminTokenInput} onChange={e => setAdminTokenInput(e.target.value)}
              onKeyDown={e => e.key === "Enter" && submitAdminToken()}
              className="gi" placeholder="Enter token…" autoFocus
              style={{ marginBottom:10 }} />
            <div style={{ display:"flex",gap:8 }}>
              <button onClick={submitAdminToken} className="gb"
                style={{ flex:1,background:C.accent,color:C.accentText,padding:"8px 0",fontWeight:800,fontSize:10 }}>
                Confirm
              </button>
              <button onClick={() => setAdminPromptOpen(false)} className="gb"
                style={{ padding:"8px 14px",background:"transparent",border:`1px solid ${C.text}`,opacity:.3,color:C.text,fontSize:10 }}>
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      <DraftTicketBanner draftLegs={draftLegs} onOpen={() => setParlayJarvisOpen(true)} onClear={() => setDraftLegs([])} />
      <GrmNewsTicker historicalRates={historicalRates} />

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
        />
      )}
    </div>
  );
}
