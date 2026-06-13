// ─────────────────────────────────────────────────────────────────────────────
// FullModelPage.jsx  ·  v7-final
//
// Base: v2 architecture (prop-based explainers, AddBtn variants, EdgeStrip)
// Merged: backend-final's HeroRead delta display, richer fallback text
// New:    getEdgeExplainer wired to EdgeStrip
//         Visual hierarchy overhaul — theme-safe, legible on white AND dark
//         HeroRead signal arc graphic
//         Section panel headers upgraded to 10px with stronger contrast
//         Color discipline — accent only on signal, not decoration
// ─────────────────────────────────────────────────────────────────────────────

import { useState, useCallback, useRef, useEffect } from "react";
import ReactDOM from "react-dom";
import {
  getReadExplainer,
  getEdgeExplainer,
  getXGExplainer,
  getMatchResultExplainer,
  getGoalRangeExplainer,
  getBTTSExplainer,
  getTeamTotalExplainer,
} from "./explainers.js";

import {
  SERVER,
  STRATEGY_LABELS,
  StatusBadge,
  ComboRow,
  FixtureBookNow,
  AskJarvis,
} from "./App.jsx";
import { loadSavedTheme } from "./themes.js";

// Module-level theme reference — seeded from localStorage so sub-components
// that use C as a free variable don't crash before FullModelPage mounts.
// FullModelPage overwrites this with the live prop on every render.
let C = loadSavedTheme();

// mktStyle not exported from App.jsx — inlined
const mktStyle = (m) => {
  const map = {
    "Over 2.5":  { color: C.green,  bg: C.greenDim  },
    "Over 1.5":  { color: C.green,  bg: C.greenDim  },
    "Over 3.5":  { color: C.green,  bg: C.greenDim  },
    "Over 4.5":  { color: C.green,  bg: C.greenDim  },
    "Under 1.5": { color: C.blue,   bg: C.blueDim   },
    "Under 2.5": { color: C.blue,   bg: C.blueDim   },
    "Under 3.5": { color: C.blue,   bg: C.blueDim   },
    "Under 4.5": { color: C.blue,   bg: C.blueDim   },
    "BTTS":      { color: C.purple, bg: C.purpleDim },
    "1X2":       { color: C.gold,   bg: C.goldDim   },
    "TeamTotal": { color: C.radar,  bg: C.radarDim  },
    "DC":        { color: C.dc,     bg: C.dcDim     },
    "CS":        { color: C.blue,   bg: C.blueDim   },
  };
  return map[m] || { color: C.accent, bg: C.accentDim };
};

// ─────────────────────────────────────────────────────────────────────────────
// TIP — tooltip portal
// ─────────────────────────────────────────────────────────────────────────────
function Tip({ text, children }) {
  const [open, setOpen] = useState(false);
  const [pos,  setPos]  = useState({ top: 0, left: 0 });
  const ref             = useRef(null);

  useEffect(() => {
    if (!open) return;
    if (ref.current) {
      const r = ref.current.getBoundingClientRect();
      const TW = 220, TH = 90;
      const above = r.top > TH + 16;
      setPos({
        top:  above ? r.top - TH - 8 : r.bottom + 8,
        left: Math.max(8, Math.min(r.left + r.width / 2 - TW / 2, window.innerWidth - TW - 8)),
      });
    }
    const close = (e) => { if (!ref.current?.contains(e.target)) setOpen(false); };
    document.addEventListener("mousedown", close);
    document.addEventListener("touchstart", close);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("touchstart", close);
    };
  }, [open]);

  return (
    <span ref={ref} style={{ display: "inline-flex", alignItems: "center", gap: 3 }}>
      {children}
      <button
        onClick={e => { e.stopPropagation(); setOpen(o => !o); }}
        style={{
          width: 15, height: 15, borderRadius: "50%",
          border: `1px solid ${C.border}`, background: C.surface,
          cursor: "pointer", display: "inline-flex", alignItems: "center",
          justifyContent: "center", color: C.muted, fontSize: 8,
          fontWeight: 800, flexShrink: 0, lineHeight: 1,
        }}>
        ?
      </button>
      {open && ReactDOM.createPortal(
        <div style={{
          position: "fixed", zIndex: 9999, top: pos.top, left: pos.left,
          background: "var(--modal-bg, #1a1a1a)", border: `1px solid ${C.border}`,
          borderRadius: 8, padding: "10px 13px", width: 220, maxWidth: "90vw",
          boxShadow: "0 8px 28px rgba(0,0,0,0.55)",
        }}>
          <div style={{ fontSize: 11, color: C.text, lineHeight: 1.65 }}>{text}</div>
        </div>,
        document.body
      )}
    </span>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// WLD CHIP
// ─────────────────────────────────────────────────────────────────────────────
function WLDChip({ result, score }) {
  const cfg = {
    W: { bg: `${C.green}18`, color: C.green,  border: `1px solid ${C.green}30` },
    L: { bg: `${C.red}18`,   color: C.red,    border: `1px solid ${C.red}30`   },
    D: { bg: C.faint,        color: C.muted,  border: `1px solid ${C.border}`  },
  }[result] || { bg: C.faint, color: C.muted, border: `1px solid ${C.border}` };
  return (
    <div style={{
      width: 28, height: score ? 30 : 28, borderRadius: 5,
      display: "flex", alignItems: "center", justifyContent: "center",
      flexDirection: "column", gap: 1, flexShrink: 0,
      background: cfg.bg, border: cfg.border,
    }}>
      <span style={{ fontSize: 9, fontWeight: 800, lineHeight: 1, color: cfg.color }}>{result}</span>
      {score && <span style={{ fontSize: 7, lineHeight: 1, color: cfg.color, opacity: 0.8 }}>{score}</span>}
    </div>
  );
}

// TOP form strip — Sofascore raw strings ["W","L","D",...], no scores
function TopFormStrip({ form, align = "left" }) {
  if (!form?.length) return null;
  return (
    <div style={{ display: "flex", gap: 3, flexWrap: "nowrap", overflow: "hidden", justifyContent: align === "right" ? "flex-end" : "flex-start" }}>
      {form.slice(0, 5).map((r, i) => <WLDChip key={i} result={r} />)}
    </div>
  );
}

// BOTTOM form strip — engine recentResults with scores
function BottomFormStrip({ recentResults }) {
  if (!recentResults?.length) return null;
  return (
    <div style={{ display: "flex", gap: 3, flexWrap: "wrap" }}>
      {recentResults.slice(0, 5).map((r, i) => (
        <WLDChip key={i} result={r.outcome} score={`${r.scored}-${r.conceded}`} />
      ))}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// EXPLAINER — italic context line
// ─────────────────────────────────────────────────────────────────────────────
function Explainer({ text, style: extra }) {
  if (!text) return null;
  return (
    <div style={{
      fontSize: 10, color: C.muted, lineHeight: 1.6,
      fontStyle: "italic", ...extra,
    }}>
      {text}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION PANEL — theme-safe bordered card
// Header uses stronger opacity text for light-theme legibility
// ─────────────────────────────────────────────────────────────────────────────
function SectionPanel({ label, labelRight, accent, children }) {
  return (
    <div style={{
      background: C.surface,
      border: `1px solid ${C.border}`,
      borderRadius: 10,
      overflow: "hidden",
      boxShadow: "0 1px 4px rgba(0,0,0,0.10)",
      borderLeft: accent ? `3px solid ${accent}` : `1px solid ${C.border}`,
    }}>
      {label != null && (
        <div style={{
          fontSize: 9, fontWeight: 800, letterSpacing: ".12em",
          textTransform: "uppercase", color: C.muted,
          padding: "11px 16px",
          borderBottom: `1px solid ${C.border}`,
          background: C.faint,
          display: "flex", alignItems: "center", justifyContent: "space-between",
        }}>
          <span>{label}</span>
          {labelRight && (
            <span style={{
              fontSize: 9, fontWeight: 600, color: C.muted,
              letterSpacing: ".03em", textTransform: "none",
            }}>
              {labelRight}
            </span>
          )}
        </div>
      )}
      <div style={{ padding: "18px 16px" }}>{children}</div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// ADD TO TICKET BUTTON — v2 architecture with compact/variant/label
// ─────────────────────────────────────────────────────────────────────────────
function AddBtn({
  onClick,
  color,
  alreadyAdded,
  otherInDraft,
  isFinished,
  fullWidth = false,
  compact = false,
  variant = "solid",
  label,
}) {
  const [flash, setFlash] = useState(false);

  const handle = (e) => {
    e.stopPropagation();
    if (!onClick) return;
    onClick();
    setFlash(true);
    setTimeout(() => setFlash(false), 1400);
  };

  const w        = fullWidth ? "100%" : undefined;
  const done     = flash || alreadyAdded;
  const btnColor = done ? C.green : color;
  const btnBg    = done ? `${C.green}16` : `${color}12`;
  const defLabel = done ? "✓ Added" : otherInDraft ? "↺ Replace" : "Add to Ticket";
  const btnLabel = label || defLabel;
  const padY     = compact ? "7px" : "11px";
  const padX     = compact ? "10px" : "14px";
  const fs       = compact ? 9 : 10;
  const bg       = variant === "ghost" ? "transparent" : btnBg;
  const border   = variant === "ghost" ? `1px solid ${btnColor}28` : `1px solid ${btnColor}44`;
  const shadow   = done && variant !== "ghost" ? `0 6px 18px ${btnColor}14` : "none";

  if (isFinished) {
    return (
      <div style={{
        width: w, padding: `${padY} ${padX}`,
        background: C.faint, border: `1px solid ${C.border}`,
        borderRadius: 8, fontSize: fs, color: C.muted,
        fontWeight: 700, letterSpacing: ".08em", textTransform: "uppercase",
        display: "flex", alignItems: "center", justifyContent: "center", gap: 6,
      }}>
        ✓ Match Finished
      </div>
    );
  }

  return (
    <button
      onClick={handle}
      onMouseDown={e => (e.currentTarget.style.transform = "translateY(1px)")}
      onMouseUp={e => (e.currentTarget.style.transform = "translateY(0)")}
      onMouseLeave={e => (e.currentTarget.style.transform = "translateY(0)")}
      style={{
        width: w, padding: `${padY} ${padX}`,
        background: bg, border, borderRadius: 8,
        color: done ? C.green : btnColor,
        fontFamily: "inherit", fontSize: fs,
        fontWeight: 800, letterSpacing: ".08em", textTransform: "uppercase",
        cursor: "pointer", display: "flex", alignItems: "center",
        justifyContent: fullWidth ? "center" : "flex-start",
        gap: 6, transition: "transform .1s ease, opacity .12s ease",
        boxShadow: shadow, opacity: 1,
      }}>
      {!done && (
        <svg width={compact ? "9" : "10"} height={compact ? "9" : "10"} viewBox="0 0 10 10" fill="none">
          <path d="M5 1v8M1 5h8" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
        </svg>
      )}
      {btnLabel}
    </button>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// SIGNAL ARC — SVG confidence arc for HeroRead
// Renders a partial circular gauge. Theme-safe: uses currentColor logic.
// ─────────────────────────────────────────────────────────────────────────────
function SignalArc({ prob, color, size = 72 }) {
  const r = (size / 2) - 7;
  const cx = size / 2;
  const cy = size / 2;
  // Arc spans 240° (from 150° to 30°, going clockwise)
  const startAngle = 150;
  const endAngle   = 30; // clockwise, wraps = 240° total
  const totalDeg   = 240;

  const toRad = d => (d * Math.PI) / 180;
  const polarToXY = (deg) => ({
    x: cx + r * Math.cos(toRad(deg)),
    y: cy + r * Math.sin(toRad(deg)),
  });

  const start  = polarToXY(startAngle);
  const bgEnd  = polarToXY(startAngle + totalDeg);

  // Track (background arc)
  const bgPath = `M ${start.x} ${start.y} A ${r} ${r} 0 1 1 ${bgEnd.x} ${bgEnd.y}`;

  // Filled arc for prob
  const fillDeg   = (prob / 100) * totalDeg;
  const fillEnd   = polarToXY(startAngle + fillDeg);
  const largeArc  = fillDeg > 180 ? 1 : 0;
  const fillPath  = fillDeg > 1
    ? `M ${start.x} ${start.y} A ${r} ${r} 0 ${largeArc} 1 ${fillEnd.x} ${fillEnd.y}`
    : null;

  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} fill="none" style={{ flexShrink: 0 }}>
      {/* Track */}
      <path
        d={bgPath}
        stroke={C.faint || "rgba(128,128,128,0.15)"}
        strokeWidth="5"
        strokeLinecap="round"
        fill="none"
        opacity="1"
      />
      {/* Glow behind fill */}
      {fillPath && (
        <path
          d={fillPath}
          stroke={color}
          strokeWidth="8"
          strokeLinecap="round"
          fill="none"
          opacity="0.12"
        />
      )}
      {/* Fill */}
      {fillPath && (
        <path
          d={fillPath}
          stroke={color}
          strokeWidth="5"
          strokeLinecap="round"
          fill="none"
          opacity="0.85"
        />
      )}
      {/* Center prob text */}
      <text
        x={cx}
        y={cy - 3}
        textAnchor="middle"
        dominantBaseline="middle"
        fill={color}
        fontSize="17"
        fontWeight="900"
        fontFamily="var(--display,'Azeret Mono',monospace)"
        letterSpacing="-1"
      >
        {prob}%
      </text>
      <text
        x={cx}
        y={cy + 11}
        textAnchor="middle"
        fill={C.muted || "#888"}
        fontSize="7"
        fontWeight="700"
        letterSpacing="1"
        fontFamily="inherit"
        style={{ textTransform: "uppercase" }}
      >
        CONF
      </text>
    </svg>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// JARVIS — consent gate + analysis display
// ─────────────────────────────────────────────────────────────────────────────
function FullModelJarvis({ f, backtestSummary }) {
  const cacheKey = `grm_fm_${f.id}_${new Date().toISOString().slice(0, 10)}`;
  const cached   = (() => { try { return localStorage.getItem(cacheKey) || null; } catch { return null; } })();

  const [brief,     setBrief]     = useState(cached);
  const [loading,   setLoading]   = useState(false);
  const [error,     setError]     = useState(null);
  const [srvCached, setSrvCached] = useState(false);
  const [ageH,      setAgeH]      = useState(null);
  const [consented, setConsented] = useState(!!cached);

  const doFetch = async (force = false) => {
    setLoading(true); setError(null);
    if (force) { setBrief(null); setSrvCached(false); setAgeH(null); }
    try {
      const q = [
        `Give a 4-5 sentence analyst briefing. Plain English, no emoji, no "as an AI".`,
        `Include injury concerns, lineup issues, or squad news.`,
        `Note what each team is fighting for if relevant.`,
        `Flag red flags the model data might be missing.`,
        f.form?.home?.length ? `Home form: ${f.form.home.join("")}` : "",
        f.form?.away?.length ? `Away form: ${f.form.away.join("")}` : "",
        force ? "refresh" : "",
      ].filter(Boolean).join(" ");
      const res  = await fetch(`${SERVER}/api/jarvis-match`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fixture: f, question: q, backtestSummary }),
      });
      if (!res.ok) throw new Error(`${res.status}`);
      const data = await res.json();
      const text = (data.analysis || "").trim();
      if (text) {
        setBrief(text); setSrvCached(!!data.cached); setAgeH(data.ageH ?? null);
        try { localStorage.setItem(cacheKey, text); } catch {}
      } else setError("Analysis unavailable — check back shortly.");
    } catch { setError("Could not reach analysis service."); }
    finally  { setLoading(false); }
  };

  const sectionColors = {
    "CONTEXT": C.muted, "SQUAD NEWS": C.amber,
    "MODEL CHECK": C.edge, "VERDICT": C.green,
  };

  if (!consented) {
    return (
      <div style={{ padding: "14px 16px 16px", borderBottom: `1px solid ${C.border}`, background: `${C.accent}05` }}>
        <div style={{
          fontSize: 9, fontWeight: 800, letterSpacing: ".12em",
          textTransform: "uppercase", color: C.accent, marginBottom: 8,
          display: "flex", alignItems: "center", gap: 6,
        }}>
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
            <circle cx="5" cy="5" r="4.5" stroke="currentColor" strokeWidth="1"/>
            <path d="M5 3v2.5L6.5 7" stroke="currentColor" strokeWidth="1" strokeLinecap="round"/>
          </svg>
          Jarvis Analysis
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <span className="grm-jarvis-pulse" style={{ fontSize: 11, color: C.muted, flex: 1, lineHeight: 1.5 }}>
            Want real-time context — injuries, motivation, squad news?
          </span>
          <button
            onClick={() => { setConsented(true); doFetch(false); }}
            style={{
              flexShrink: 0, padding: "8px 20px", fontSize: 10, fontWeight: 800,
              background: C.accent, color: C.accentText || "#000", border: "none",
              borderRadius: 8, cursor: "pointer", letterSpacing: ".05em",
              textTransform: "uppercase",
            }}>
            Yes
          </button>
        </div>
      </div>
    );
  }

  return (
    <div style={{ padding: "14px 16px 16px", borderBottom: `1px solid ${C.border}` }}>
      <div style={{
        display: "flex", alignItems: "center", justifyContent: "space-between",
        marginBottom: (brief || loading || error) ? 10 : 0,
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ fontSize: 9, fontWeight: 700, letterSpacing: ".10em", textTransform: "uppercase", color: C.accent }}>
            Jarvis Analysis
          </span>
          {srvCached && ageH != null && (
            <span style={{
              fontSize: 7, color: C.muted, background: C.surface,
              border: `1px solid ${C.faint}`, borderRadius: 4, padding: "1px 6px",
            }}>
              Cached · {ageH < 1 ? `${Math.round(ageH * 60)}m ago` : `${ageH.toFixed(1)}h ago`}
            </span>
          )}
        </div>
        {!loading && (
          <button
            onClick={() => doFetch(true)}
            style={{
              fontSize: 8, color: C.muted, background: "transparent",
              border: `1px solid ${C.border}`, borderRadius: 3,
              padding: "3px 9px", cursor: "pointer",
              display: "flex", alignItems: "center", gap: 3,
            }}>
            <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M23 4v6h-6"/><path d="M1 20v-6h6"/>
              <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>
            </svg>
            Retry
          </button>
        )}
      </div>

      {loading && (
        <div style={{ fontSize: 10, color: C.muted, fontStyle: "italic" }}>
          <span className="pu">Researching match context…</span>
        </div>
      )}
      {error && !loading && (
        <div style={{ fontSize: 10, color: C.amber, lineHeight: 1.5 }}>{error}</div>
      )}

      {brief && !loading && (() => {
        const raw = brief.trim();
        const hasStructure = /\*\*[A-Z ]+\*\*/.test(raw);
        if (hasStructure) {
          const parts    = raw.split(/(\*\*[A-Z][A-Z ]*\*\*)/).filter(Boolean);
          const sections = [];
          for (let i = 0; i < parts.length; i++) {
            const hm = parts[i].match(/^\*\*([A-Z][A-Z ]*)\*\*$/);
            if (hm) {
              sections.push({
                label: hm[1].trim(),
                body: (parts[i+1] || "").replace(/^[\s—–-]+/, "").trim(),
                color: sectionColors[hm[1].trim()] || C.text,
              });
              i++;
            } else if (parts[i].trim()) {
              sections.push({ label: null, body: parts[i].trim(), color: C.text });
            }
          }
          return (
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {sections.map((s, i) => (
                <div key={i} style={{
                  padding: "8px 10px",
                  borderLeft: `3px solid ${s.color !== C.text ? s.color : C.border}`,
                  borderRadius: "0 6px 6px 0",
                  background: s.color !== C.text ? `${s.color}08` : "transparent",
                }}>
                  {s.label && (
                    <div style={{
                      fontSize: 9, fontWeight: 800, color: s.color,
                      letterSpacing: ".08em", textTransform: "uppercase", marginBottom: 4,
                    }}>
                      {s.label}
                    </div>
                  )}
                  <div style={{ fontSize: 11, color: C.text, lineHeight: 1.65 }}>{s.body}</div>
                </div>
              ))}
            </div>
          );
        }
        const conflict = /injur|ruled out|doubt|absent|missing|suspend|without|unavailab|concern|caution|contradict|against|red flag|volatile|thin data|limited data|flag|warning|however|despite|but\b|worr/i;
        const support  = /back the model|support|confirms|align|strong case|confident|clear pick|solid|endorse|in agreement|on balance|verdict.*back|back.*pick/i;
        return (
          <div style={{ fontSize: 11, color: C.text, lineHeight: 1.75 }}>
            {raw.split(/\n{2,}/).filter(Boolean).map((para, i, arr) => {
              const col = conflict.test(para) ? C.amber : (support.test(para) || i === arr.length - 1) ? C.green : null;
              return (
                <div key={i} style={{
                  marginBottom: i < arr.length - 1 ? 12 : 0,
                  padding: col ? "8px 10px" : 0,
                  borderLeft: col ? `3px solid ${col}` : "none",
                  borderRadius: col ? "0 6px 6px 0" : 0,
                  background: col ? `${col}08` : "transparent",
                  color: col || C.text,
                }}>
                  {para}
                </div>
              );
            })}
          </div>
        );
      })()}

      {brief && !loading && (
        <div style={{ marginTop: 10 }}>
          <AskJarvis fixture={f} backtestSummary={backtestSummary} brief={brief} />
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// HERO READ — model's anchor pick with signal arc graphic
// Merges v2 prop-based explainer + backend-final's inline delta display
// ─────────────────────────────────────────────────────────────────────────────
function HeroRead({ theRead, fixture, onAddToParlay, alreadyAdded, otherInDraft, explainer }) {
  const ftStates   = ["finished", "ft", "fulltime", "ended", "complete", "aet", "afterextratime", "afterpenalties"];
  const isFinished = ftStates.includes((fixture?.state || "").toLowerCase().replace(/[_\-\s]/g, ""));

  const noSignalBlock = (
    <section style={{ padding: "16px 20px", borderBottom: `1px solid ${C.border}`, opacity: 0.55 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 7, marginBottom: 5 }}>
        <Tip text="The model's single highest-confidence pick for this match — driven by statistical signal convergence, not just probability.">
          <span style={{ fontSize: 9, fontWeight: 700, letterSpacing: ".12em", textTransform: "uppercase", color: C.muted }}>
            The Read
          </span>
        </Tip>
      </div>
      <div style={{ fontSize: 11, color: C.muted, fontStyle: "italic", lineHeight: 1.55 }}>
        No strong signal — check individual market probabilities below.
      </div>
    </section>
  );

  if (!theRead) return noSignalBlock;
  const { anchor, reinforcer, isFallback, scenario } = theRead;
  if (!anchor) return noSignalBlock;

  const mst         = mktStyle(anchor.market);
  const accentColor = isFallback ? C.muted : (mst.color || C.accent);
  const prob        = Math.round(anchor.prob || 0);
  // Delta — from backend-final's HeroRead
  const delta       = (anchor.prob && anchor.empiricalRate != null)
    ? parseFloat((anchor.prob - anchor.empiricalRate).toFixed(1)) : null;

  return (
    <section style={{
      padding: "20px 20px 18px",
      background: `${accentColor}06`,
      borderBottom: `1px solid ${C.border}`,
    }}>
      {/* Header row */}
      <div style={{ display: "flex", alignItems: "center", gap: 7, marginBottom: 12 }}>
        <Tip text="The model's single highest-confidence pick for this match — driven by statistical signal convergence, not just probability.">
          <span style={{
            fontSize: 9, fontWeight: 700, letterSpacing: ".12em",
            textTransform: "uppercase", color: accentColor,
          }}>
            {isFallback ? "THE READ · LOW SIGNAL" : "THE READ"}
          </span>
        </Tip>
        {anchor.market && (
          <span style={{
            fontSize: 8, fontWeight: 700, padding: "2px 7px",
            borderRadius: 3, border: `1px solid ${accentColor}30`,
            color: accentColor, background: `${accentColor}10`,
            letterSpacing: ".05em", textTransform: "uppercase",
          }}>
            {anchor.market}
          </span>
        )}
        {anchor.odds && (
          <span style={{
            marginLeft: "auto",
            fontFamily: "var(--display, 'Azeret Mono', monospace)",
            fontSize: 12, fontWeight: 700, color: C.muted, letterSpacing: "-.02em",
          }}>
            {anchor.odds}×
          </span>
        )}
      </div>

      {/* Main content: arc + pick info side by side */}
      <div style={{ display: "flex", alignItems: "flex-start", gap: 16, marginBottom: 10 }}>
        {/* Signal arc — visual anchor */}
        <SignalArc prob={prob} color={accentColor} size={76} />

        {/* Text content */}
        <div style={{ flex: 1, minWidth: 0 }}>
          {/* Pick name */}
          <div style={{
            fontSize: 22, fontWeight: 900, color: C.text,
            lineHeight: 1.1, letterSpacing: "-.03em", marginBottom: 6,
          }}>
            {anchor.pick}
          </div>

          {/* Scenario */}
          {scenario && (
            <div style={{
              fontSize: 10, color: C.muted, fontStyle: "italic",
              lineHeight: 1.4, marginBottom: 4,
            }}>
              {scenario}
            </div>
          )}

          {/* Delta badge — from backend-final */}
          {delta !== null && (
            <div style={{ display: "flex", alignItems: "center", gap: 5, marginBottom: 4 }}>
              <span style={{
                fontSize: 10, fontWeight: 700, letterSpacing: ".02em",
                color: delta > 0 ? C.green : delta < -3 ? C.red : C.muted,
              }}>
                {delta > 0 ? "↑" : "↓"} {anchor.empiricalRate}% hist · model {delta > 0 ? "+" : ""}{delta}%
              </span>
            </div>
          )}

          {/* Reinforcer */}
          {reinforcer && (
            <div style={{ display: "flex", alignItems: "flex-start", gap: 6, flexWrap: "wrap" }}>
              <span style={{
                fontSize: 9, fontWeight: 700, letterSpacing: ".06em",
                textTransform: "uppercase", color: C.muted, flexShrink: 0, paddingTop: 1,
              }}>
                Reinforced by
              </span>
              <span style={{ fontSize: 11, fontWeight: 700, color: C.radar, lineHeight: 1.4 }}>
                {reinforcer.pick} {Math.round(reinforcer.prob)}%
                {reinforcer.combined && reinforcer.probO15
                  ? ` · O1.5 ${Math.round(reinforcer.probO15)}%`
                  : reinforcer.odds ? ` · ${reinforcer.odds}×` : ""}
              </span>
            </div>
          )}
        </div>
      </div>

      {/* Progress bar */}
      <div style={{ height: 4, background: C.faint, borderRadius: 999, overflow: "hidden", marginBottom: 10 }}>
        <div style={{
          height: "100%", width: `${prob}%`, background: accentColor,
          borderRadius: 999, transition: "width .9s cubic-bezier(.16,1,.3,1)",
        }} />
      </div>

      {/* Explainer — from prop (getReadExplainer) */}
      {explainer?.headline && (
        <div style={{ marginBottom: explainer?.sub ? 3 : 10 }}>
          <div style={{ fontSize: 11, color: C.text, lineHeight: 1.55, fontStyle: "italic" }}>
            {explainer.headline}
          </div>
        </div>
      )}
      {explainer?.sub && (
        <div style={{ marginBottom: 10 }}>
          <div style={{ fontSize: 10, color: C.muted, lineHeight: 1.5 }}>{explainer.sub}</div>
        </div>
      )}
      {/* Fallback: only show low-signal warning, not a tooltip echo */}
      {!explainer && isFallback && (
        <Explainer
          text="Lower-confidence read — treat as directional rather than a hard lean."
          style={{ marginBottom: 10 }}
        />
      )}

      {/* CTA */}
      {onAddToParlay && !isFallback && (
        <div style={{ maxWidth: 200, marginTop: 4 }}>
          <AddBtn
            onClick={() => onAddToParlay(anchor)}
            color={accentColor}
            alreadyAdded={alreadyAdded}
            otherInDraft={otherInDraft}
            isFinished={isFinished}
            compact
            variant="ghost"
            label="Add Read"
          />
        </div>
      )}
    </section>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// EDGE STRIP — value pick vs book
// Now wired to getEdgeExplainer via prop
// ─────────────────────────────────────────────────────────────────────────────
function EdgeStrip({ theEdge, fixture, onAddToParlay, alreadyAdded, otherInDraft, explainer }) {
  const ftStates   = ["finished", "ft", "fulltime", "ended", "complete", "aet", "afterextratime", "afterpenalties"];
  const isFinished = ftStates.includes((fixture?.state || "").toLowerCase().replace(/[_\-\s]/g, ""));

  if (!theEdge) {
    return (
      <section style={{
        padding: "12px 20px",
        borderTop: `1px solid ${C.border}`,
        opacity: 0.45,
        display: "flex", alignItems: "center", gap: 8,
      }}>
        <span style={{ fontSize: 9, fontWeight: 700, letterSpacing: ".12em", textTransform: "uppercase", color: C.muted }}>
          The Edge
        </span>
        <span style={{ fontSize: 9, color: C.muted, fontStyle: "italic" }}>No value signal found</span>
      </section>
    );
  }

  const prob = Math.round(theEdge.prob || 0);

  return (
    <section style={{ padding: "14px 20px", borderTop: `1px solid ${C.border}` }}>
      <div style={{ marginBottom: 8 }}>
        <Tip text="The pick where the model's probability most exceeds what the bookmaker's odds imply — the best-priced outcome, not necessarily the most likely.">
          <span style={{ fontSize: 9, fontWeight: 700, letterSpacing: ".12em", textTransform: "uppercase", color: C.amber }}>
            The Edge
          </span>
        </Tip>
      </div>

      <div style={{ fontSize: 15, fontWeight: 800, color: C.text, lineHeight: 1.2, marginBottom: 5 }}>
        {theEdge.pick}
      </div>

      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 6, gap: 8 }}>
        <span style={{
          fontFamily: "var(--display, 'Azeret Mono', monospace)",
          fontSize: 22, fontWeight: 900, color: C.amber,
          letterSpacing: "-.03em", lineHeight: 1,
        }}>
          {prob}%
        </span>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          {theEdge.edgeOddsPct && (
            <span style={{
              fontSize: 9, fontWeight: 700, color: C.green,
              background: `${C.green}12`, padding: "2px 7px", borderRadius: 3,
            }}>
              +{theEdge.edgeOddsPct}% vs book
            </span>
          )}
          {theEdge.odds && (
            <span style={{ fontSize: 10, color: C.muted, fontFamily: "var(--display,'Azeret Mono',monospace)" }}>
              {theEdge.odds}×
            </span>
          )}
        </div>
      </div>

      <div style={{ height: 3, background: C.faint, borderRadius: 1, overflow: "hidden", marginBottom: 8 }}>
        <div style={{
          height: "100%", width: `${prob}%`, background: C.amber,
          opacity: 0.5, borderRadius: 1, transition: "width .6s cubic-bezier(.16,1,.3,1)",
        }} />
      </div>

      {/* Dynamic explainer only — no static fallback (tooltip covers the concept) */}
      {explainer?.headline && (
        <div style={{ marginBottom: explainer?.sub ? 3 : 10 }}>
          <div style={{ fontSize: 11, color: C.text, lineHeight: 1.55, fontStyle: "italic" }}>
            {explainer.headline}
          </div>
        </div>
      )}
      {explainer?.sub && (
        <div style={{ marginBottom: 10 }}>
          <Explainer text={explainer.sub} />
        </div>
      )}

      {onAddToParlay && (
        <div style={{ maxWidth: 200, marginTop: 4 }}>
          <AddBtn
            onClick={() => onAddToParlay(theEdge)}
            color={C.amber}
            alreadyAdded={alreadyAdded}
            otherInDraft={otherInDraft}
            isFinished={isFinished}
            compact
            variant="ghost"
            label="Add Edge"
          />
        </div>
      )}
    </section>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// RADAR STRIP — team scoring totals
// ─────────────────────────────────────────────────────────────────────────────
function RadarStrip({ goalRadar, onAddToParlay, alreadyAdded, otherInDraft }) {
  const [flashed, setFlashed] = useState({});

  if (!goalRadar || (!goalRadar.home && !goalRadar.away)) {
    return (
      <section style={{
        padding: "12px 20px 14px",
        borderTop: `1px solid ${C.border}`,
        opacity: 0.4,
        display: "flex", alignItems: "center", gap: 8,
      }}>
        <span style={{ fontSize: 9, fontWeight: 700, letterSpacing: ".12em", textTransform: "uppercase", color: C.muted }}>
          Goal Radar
        </span>
        <span style={{ fontSize: 9, color: C.muted, fontStyle: "italic" }}>Insufficient data</span>
      </section>
    );
  }
  const { home, away, homeExtra, awayExtra } = goalRadar;

  const handleAdd = (entry) => {
    if (!onAddToParlay) return;
    onAddToParlay(entry);
    setFlashed(p => ({ ...p, [entry.pick]: true }));
    setTimeout(() => setFlashed(p => ({ ...p, [entry.pick]: false })), 1300);
  };

  const renderEntry = (entry, isExtra = false) => {
    const done = !!flashed[entry.pick];
    const prob = Math.round(entry.prob || 0);
    return (
      <div style={{ opacity: isExtra ? 0.72 : 1 }}>
        <div style={{ fontSize: 12, fontWeight: 800, color: C.text, lineHeight: 1.2, marginBottom: 4 }}>
          {entry.pick}
        </div>
        <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 5, gap: 8 }}>
          <span style={{
            fontFamily: "var(--display, 'Azeret Mono', monospace)",
            fontSize: 20, fontWeight: 900, color: C.radar,
            letterSpacing: "-.03em", lineHeight: 1,
          }}>
            {prob}%
          </span>
          {entry.odds && (
            <span style={{ fontSize: 9, color: C.muted }}>{entry.odds}×</span>
          )}
        </div>
        <div style={{ height: 3, background: C.faint, borderRadius: 1, overflow: "hidden", marginBottom: isExtra ? 4 : 7 }}>
          <div style={{
            height: "100%", width: `${prob}%`, background: C.radar,
            opacity: 0.45, borderRadius: 1, transition: "width .6s cubic-bezier(.16,1,.3,1)",
          }} />
        </div>
        {isExtra ? (
          <div style={{ fontSize: 8, color: C.muted, fontStyle: "italic", lineHeight: 1.35 }}>
            O1.5 also strong — add via Custom Pick
          </div>
        ) : (
          onAddToParlay && (
            <AddBtn
              onClick={() => handleAdd(entry)}
              color={done || alreadyAdded ? C.green : C.radar}
              alreadyAdded={done || alreadyAdded}
              otherInDraft={!done && !alreadyAdded && otherInDraft}
              isFinished={false}
              compact
              variant="ghost"
              label={done || alreadyAdded ? "Added" : "Add"}
            />
          )
        )}
      </div>
    );
  };

  return (
    <section style={{ padding: "14px 20px 18px", borderTop: `1px solid ${C.border}` }}>
      <div style={{ marginBottom: 10 }}>
        <Tip text="Probability that each team scores at least one goal in this match, based on attack strength, defence quality, and recent form.">
          <span style={{ fontSize: 9, fontWeight: 700, letterSpacing: ".12em", textTransform: "uppercase", color: C.radar }}>
            Goal Radar
          </span>
        </Tip>
      </div>
      <div style={{ display: "flex", gap: 0 }}>
        {home && (
          <div style={{
            flex: 1, paddingRight: away ? 14 : 0,
            borderRight: away ? `1px solid ${C.border}` : "none",
          }}>
            {renderEntry(home)}
            {homeExtra && <div style={{ marginTop: 10 }}>{renderEntry(homeExtra, true)}</div>}
          </div>
        )}
        {away && (
          <div style={{ flex: 1, paddingLeft: home ? 14 : 0 }}>
            {renderEntry(away)}
            {awayExtra && <div style={{ marginTop: 10 }}>{renderEntry(awayExtra, true)}</div>}
          </div>
        )}
      </div>
    </section>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN EXPORT
// ─────────────────────────────────────────────────────────────────────────────
// ── Inline tooltip component for signal zone (no portal, solid bg, mobile-safe)
function TipIcon({ text }) {
  const [open, setOpen] = useState(false);
  const [pos,  setPos]  = useState({ top: 0, left: 0 });
  const btnRef = useRef(null);
  const [shaking, setShaking] = useState(false);

  // Initial shake on mount + periodic every 35s
  useEffect(() => {
    const trigger = () => { setShaking(true); setTimeout(() => setShaking(false), 500); };
    const t = setTimeout(trigger, 2000); // initial shake after 2s
    const iv = setInterval(trigger, 35000);
    return () => { clearTimeout(t); clearInterval(iv); };
  }, []);

  const toggle = (e) => {
    e.stopPropagation();
    if (!open && btnRef.current) {
      const r   = btnRef.current.getBoundingClientRect();
      const tw  = 210;
      const left = Math.max(8, Math.min(r.left + r.width / 2 - tw / 2, window.innerWidth - tw - 8));
      const top  = r.top > 120 ? r.top - 8 - 90 : r.bottom + 8;
      setPos({ top, left });
    }
    setOpen(o => !o);
  };

  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    document.addEventListener("touchstart", close, { once: true });
    document.addEventListener("mousedown",  close, { once: true });
    return () => {};
  }, [open]);

  return (
    <>
      <button ref={btnRef} className={shaking ? "grm-tip-icon grm-tip-shaking" : "grm-tip-icon"} onClick={toggle} style={{
        width:15, height:15, borderRadius:"50%",
        border:"1px solid rgba(255,255,255,0.18)",
        background:"rgba(255,255,255,0.07)",
        cursor:"pointer", fontSize:8, fontWeight:900,
        color:"rgba(255,255,255,0.55)", flexShrink:0,
        display:"inline-flex", alignItems:"center", justifyContent:"center",
        lineHeight:1, padding:0,
      }}>
        ?
      </button>
      {open && (
        <div className="grm-tip-box" style={{ top: pos.top, left: pos.left }}>
          {text}
        </div>
      )}
    </>
  );
}


export default function FullModelPage({ f, onBack, onAddToParlay, draftLegs, backtestSummary, C: CProp }) {
  // Keep module-level C in sync so all sub-components get the live theme
  if (CProp) C = CProp;
  const m         = f.markets;
  const scrollRef = useRef(null);

  const draftLeg     = Array.isArray(draftLegs) ? draftLegs.find(l => l.fixtureId === f.id) : null;
  const inDraft      = !!draftLeg;
  const readAnchor   = f.theRead?.anchor;
  const readInDraft  = inDraft && !!readAnchor && draftLeg.pick === readAnchor.pick;
  const edgeInDraft  = inDraft && !!f.theEdge   && draftLeg.pick === f.theEdge.pick;
  const radarInDraft = inDraft && (draftLeg?.market === "TeamTotal" || draftLeg?.market?.includes("TeamTotal"));

  // All explainers computed once
  const readEx   = getReadExplainer(f);
  const edgeEx   = getEdgeExplainer(f);
  const xgEx     = getXGExplainer(f);
  const resultEx = getMatchResultExplainer(f);
  const goalEx   = getGoalRangeExplainer(f);
  const bttsEx   = getBTTSExplainer(f);
  const homeEx   = getTeamTotalExplainer(f.teams?.home, f.teamStats?.home, "home", f);
  const awayEx   = getTeamTotalExplainer(f.teams?.away, f.teamStats?.away, "away", f);

  const handleAdd = useCallback((pick) => {
    if (!onAddToParlay) return;
    const io = p => (p > 0 && p < 100) ? parseFloat((1 / (p / 100)).toFixed(2)) : null;
    onAddToParlay(f, { pick: pick.pick, prob: pick.prob, odds: pick.odds || io(pick.prob) || null, market: pick.market });
  }, [f, onAddToParlay]);

  const hxg       = parseFloat(m?.homeXG) || 0;
  const axg       = parseFloat(m?.awayXG) || 0;
  const xgTotal   = hxg + axg;
  const xgHomePct = xgTotal > 0 ? (hxg / xgTotal) * 100 : 50;


  return (
    <div
      className="grm-full-model-page"
      ref={scrollRef}
      style={{
        position: "fixed", inset: 0, zIndex: 300,
        background: C.bg, overflowY: "auto",
        overscrollBehavior: "contain", display: "flex", flexDirection: "column",
        alignItems: "center", // P20-FIX: center content column on desktop
      }}>
      {/* P20-FIX: inner column constrains width on desktop */}
      <div style={{ width: "100%", maxWidth: 480, display: "flex", flexDirection: "column", flex: 1 }}>

      {/* ── Sticky header ── */}
      <div className="grm-page-header">
        <button
          onClick={onBack}
          className="gb-ghost"
          style={{ padding: "7px 14px", fontSize: 11, display: "flex", alignItems: "center", gap: 6, flexShrink: 0 }}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="15 18 9 12 15 6"/>
          </svg>
          Back
        </button>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{
            fontSize: 13, fontWeight: 800, color: C.text,
            overflow: "hidden", textOverflow: "ellipsis",
            whiteSpace: "nowrap", lineHeight: 1.2,
          }}>
            {f.teams.home} <span style={{ color: C.muted, fontWeight: 400 }}>vs</span> {f.teams.away}
          </div>
          <div style={{ fontSize: 9, color: C.muted, marginTop: 2 }}>{f.league}</div>
        </div>
        <StatusBadge state={f.state} time={f.time} />
      </div>

      {/* ══ MATCH IDENTITY ══════════════════════════════════════════════════ */}
      <div style={{
        display: "grid", gridTemplateColumns: "1fr auto 1fr",
        gap: 8, alignItems: "start",
        padding: "20px 16px 18px",
        borderBottom: `1px solid ${C.border}`,
      }}>
        {/* Home */}
        <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
          <span style={{ fontSize: 14, fontWeight: 800, color: C.text, letterSpacing: "-.02em", lineHeight: 1.2 }}>
            {f.teams.home}
          </span>
          <TopFormStrip form={f.form?.home} align="left" />
          {f.tablePosition?.homePosition && (
            <span style={{ fontSize: 9, color: C.muted }}>
              <span style={{ color: C.text, fontWeight: 700 }}>#{f.tablePosition.homePosition}</span>
              {f.tablePosition.homePoints != null && ` · ${f.tablePosition.homePoints}pts`}
            </span>
          )}
        </div>

        {/* Centre */}
        <div style={{ textAlign: "center", flexShrink: 0, paddingTop: 2 }}>
          <div style={{
            fontFamily: "var(--display, 'Azeret Mono', monospace)",
            fontSize: 32, fontWeight: 900, color: C.text,
            letterSpacing: "-.05em", lineHeight: 1,
          }}>
            {f.hGoals != null ? `${f.hGoals}–${f.aGoals}` : "–"}
          </div>
          <div style={{
            fontSize: 9, color: C.muted, letterSpacing: ".06em",
            textTransform: "uppercase", marginTop: 3,
          }}>
            {f.time || f.state || "—"}
          </div>
          {f.strategyTags?.length > 0 && (
            <div style={{ display: "flex", gap: 3, justifyContent: "center", marginTop: 6, flexWrap: "wrap" }}>
              {f.strategyTags.map(t => (
                <span key={t} style={{
                  fontSize: 8, fontWeight: 700, padding: "2px 6px", borderRadius: 2,
                  border: `1px solid ${C.border}`, color: C.muted, background: C.faint,
                  letterSpacing: ".04em", textTransform: "uppercase",
                }}>
                  {STRATEGY_LABELS[t] || t}
                </span>
              ))}
            </div>
          )}
        </div>

        {/* Away */}
        <div style={{ display: "flex", flexDirection: "column", gap: 5, alignItems: "flex-end" }}>
          <span style={{ fontSize: 14, fontWeight: 800, color: C.text, letterSpacing: "-.02em", textAlign: "right", lineHeight: 1.2 }}>
            {f.teams.away}
          </span>
          <TopFormStrip form={f.form?.away} align="right" />
          {f.tablePosition?.awayPosition && (
            <span style={{ fontSize: 9, color: C.muted, textAlign: "right" }}>
              {f.tablePosition.awayPoints != null && `${f.tablePosition.awayPoints}pts · `}
              <span style={{ color: C.text, fontWeight: 700 }}>#{f.tablePosition.awayPosition}</span>
            </span>
          )}
        </div>
      </div>

      {/* ══ JARVIS ══════════════════════════════════════════════════════════ */}
      <FullModelJarvis f={f} backtestSummary={backtestSummary} />



      {/* ══ SIGNAL ZONE ════════════════════════════════════════════════════ */}

      {/* Tooltip styles + shake animation */}
      <style>{`
        @keyframes grmShake{0%,100%{transform:rotate(0)}15%{transform:rotate(-10deg)}30%{transform:rotate(10deg)}45%{transform:rotate(-7deg)}60%{transform:rotate(7deg)}75%{transform:rotate(-3deg)}}
        @keyframes grmPulse{0%,100%{opacity:1}50%{opacity:0.35}}
        .grm-tip-icon{}
        .grm-tip-icon:hover{animation:grmShake .4s ease}.grm-tip-shaking{animation:grmShake .5s ease!important}
        .grm-tip-box{
          position:fixed;z-index:99999;
          background:#1a1a2e;
          border:1px solid rgba(255,255,255,0.15);
          border-radius:8px;padding:10px 13px;
          width:210px;max-width:88vw;
          box-shadow:0 8px 32px rgba(0,0,0,0.7);
          font-size:11px;line-height:1.6;color:#e8e8f0;
          pointer-events:none;
        }
        .grm-jarvis-pulse{animation:grmPulse 3s ease-in-out infinite}
      `}</style>

      <div style={{ padding: "0 12px", marginTop: 14, display: "flex", flexDirection: "column", gap: 10 }}>

        {/* ── THE READ ─────────────────────────────────────────────── */}
        {(() => {
          const anchor    = f.theRead?.anchor;
          const isFallback = f.theRead?.isFallback;
          const ftStates  = ["finished","ft","fulltime","ended","complete","aet","afterextratime","afterpenalties"];
          const ppdStates = ["postponed","ppd","cancelled","canceled","abandoned","suspended","interrupted","deleted"];
          const norm      = (f.state||"").toLowerCase().replace(/[_\-\s]/g,"");
          const isFinished = ftStates.includes(norm);
          const isPPD      = ppdStates.includes(norm);
          const blocked    = isFinished || isPPD;
          const dl         = Array.isArray(draftLegs) ? draftLegs.find(l => l.fixtureId === f.id) : null;

          if (!anchor) return (
            <div style={{ padding:"14px 16px", background:C.surface, borderRadius:10, border:`1px solid ${C.border}`, opacity:0.45 }}>
              <div style={{ fontSize:9, fontWeight:800, letterSpacing:".1em", textTransform:"uppercase", color:C.muted }}>The Read</div>
              <div style={{ fontSize:11, color:C.muted, fontStyle:"italic", marginTop:4 }}>No strong signal for this match</div>
            </div>
          );

          const col        = mktStyle(anchor.market).color || C.accent;
          const prob       = Math.round(anchor.prob||0);
          const readInDraft = !!dl && dl.pick === anchor.pick;
          const otherInDraft = !!dl && !readInDraft;

          return (
            <div style={{ background:C.surface, borderRadius:10, border:`1px solid ${C.border}`, borderLeft:`3px solid ${col}`, overflow:"hidden" }}>
              {/* header */}
              <div style={{ padding:"11px 14px 0", display:"flex", alignItems:"center", justifyContent:"space-between" }}>
                <div style={{ display:"flex", alignItems:"center", gap:6 }}>
                  <span style={{ fontSize:9, fontWeight:800, letterSpacing:".1em", textTransform:"uppercase", color:col }}>
                    {isFallback ? "The Read · Low Signal" : "The Read"}
                  </span>
                  <span style={{ fontSize:8, fontWeight:700, color:col, background:`${col}14`, border:`1px solid ${col}30`, borderRadius:3, padding:"1px 6px", letterSpacing:".04em", textTransform:"uppercase" }}>
                    {anchor.market}
                  </span>
                  {/* Tooltip trigger */}
                  <TipIcon text="The model's single highest-confidence pick — driven by statistical signal convergence, not just probability." />
                </div>
                <span style={{ fontFamily:"var(--display,'Azeret Mono',monospace)", fontSize:22, fontWeight:900, color:col, letterSpacing:"-.03em" }}>
                  {prob}%
                </span>
              </div>
              {/* body */}
              <div style={{ padding:"6px 14px 4px" }}>
                <div style={{ fontSize:19, fontWeight:900, color:C.text, lineHeight:1.1, letterSpacing:"-.02em" }}>{anchor.pick}</div>
                {f.theRead?.scenario && <div style={{ fontSize:10, color:C.muted, fontStyle:"italic", marginTop:3 }}>{f.theRead.scenario}</div>}
                {f.theRead?.reinforcer && (
                  <div style={{ fontSize:10, color:C.muted, marginTop:4 }}>
                    Reinforced by <span style={{ color:C.text, fontWeight:700 }}>{f.theRead.reinforcer.pick} {Math.round(f.theRead.reinforcer.prob)}%</span>
                  </div>
                )}
              </div>
              {/* bar */}
              <div style={{ margin:"6px 14px 10px", height:3, background:C.faint, borderRadius:2, overflow:"hidden" }}>
                <div style={{ height:"100%", width:`${prob}%`, background:col, borderRadius:2 }} />
              </div>
              {readEx?.headline && <div style={{ padding:"0 14px 8px", fontSize:10, color:C.muted, fontStyle:"italic", lineHeight:1.5 }}>{readEx.headline}</div>}
              {/* CTA */}
              {onAddToParlay && !isFallback && (
                <div style={{ padding:"0 14px 12px" }}>
                  <button onClick={() => !blocked && handleAdd(anchor)} style={{
                    fontSize:10, fontWeight:700, letterSpacing:".06em", textTransform:"uppercase",
                    padding:"5px 13px", borderRadius:6, cursor: blocked ? "default" : "pointer",
                    border:`1px solid ${readInDraft ? `${C.green}50` : blocked ? `${C.muted}30` : `${col}40`}`,
                    background: readInDraft ? `${C.green}12` : blocked ? "transparent" : `${col}10`,
                    color: blocked ? C.muted : readInDraft ? C.green : col,
                  }}>
                    {isFinished ? "✓ Match Finished" : isPPD ? "✗ Match Unavailable" : readInDraft ? "✓ Added" : otherInDraft ? "↺ Replace" : "+ Add Read"}
                  </button>
                </div>
              )}
            </div>
          );
        })()}

        {/* ── THE EDGE ─────────────────────────────────────────────── */}
        {(() => {
          const ftStates  = ["finished","ft","fulltime","ended","complete","aet","afterextratime","afterpenalties"];
          const ppdStates = ["postponed","ppd","cancelled","canceled","abandoned","suspended","interrupted","deleted"];
          const norm      = (f.state||"").toLowerCase().replace(/[_\-\s]/g,"");
          const isFinished = ftStates.includes(norm);
          const isPPD      = ppdStates.includes(norm);
          const blocked    = isFinished || isPPD;
          const dl         = Array.isArray(draftLegs) ? draftLegs.find(l => l.fixtureId === f.id) : null;

          if (!f.theEdge) return (
            <div style={{ padding:"10px 14px", background:C.surface, borderRadius:10, border:`1px solid ${C.border}`, display:"flex", alignItems:"center", gap:8, opacity:0.45 }}>
              <span style={{ fontSize:9, fontWeight:800, letterSpacing:".1em", textTransform:"uppercase", color:C.muted }}>The Edge</span>
              <span style={{ fontSize:10, color:C.muted, fontStyle:"italic" }}>No value signal</span>
            </div>
          );

          const e          = f.theEdge;
          const prob       = Math.round(e.prob||0);
          const edgeInDraft = !!dl && dl.pick === e.pick;
          const otherInDraft = !!dl && !edgeInDraft;

          return (
            <div style={{ background:C.surface, borderRadius:10, border:`1px solid ${C.border}`, borderLeft:`3px solid ${C.amber}`, overflow:"hidden" }}>
              <div style={{ padding:"11px 14px 0", display:"flex", alignItems:"center", justifyContent:"space-between" }}>
                <div style={{ display:"flex", alignItems:"center", gap:6 }}>
                  <span style={{ fontSize:9, fontWeight:800, letterSpacing:".1em", textTransform:"uppercase", color:C.amber }}>The Edge</span>
                  <TipIcon text="Where the model's probability exceeds what the bookmaker's odds imply — a potential value pick." />
                  {e.edgeOddsPct && (
                    <span style={{ fontSize:8, fontWeight:700, color:C.green, background:`${C.green}12`, border:`1px solid ${C.green}30`, borderRadius:3, padding:"1px 6px" }}>
                      +{e.edgeOddsPct}% vs book
                    </span>
                  )}
                </div>
                <span style={{ fontFamily:"var(--display,'Azeret Mono',monospace)", fontSize:22, fontWeight:900, color:C.amber, letterSpacing:"-.03em" }}>
                  {prob}%
                </span>
              </div>
              <div style={{ padding:"6px 14px 4px" }}>
                <div style={{ fontSize:17, fontWeight:800, color:C.text, lineHeight:1.1 }}>{e.pick}</div>
                {e.narrative && <div style={{ fontSize:10, color:C.muted, fontStyle:"italic", marginTop:3 }}>{e.narrative}</div>}
              </div>
              <div style={{ margin:"6px 14px 10px", height:3, background:C.faint, borderRadius:2, overflow:"hidden" }}>
                <div style={{ height:"100%", width:`${prob}%`, background:C.amber, opacity:0.7, borderRadius:2 }} />
              </div>
              {edgeEx?.headline && <div style={{ padding:"0 14px 8px", fontSize:10, color:C.muted, fontStyle:"italic", lineHeight:1.5 }}>{edgeEx.headline}</div>}
              {onAddToParlay && (
                <div style={{ padding:"0 14px 12px" }}>
                  <button onClick={() => !blocked && handleAdd({...e, market:e.market})} style={{
                    fontSize:10, fontWeight:700, letterSpacing:".06em", textTransform:"uppercase",
                    padding:"5px 13px", borderRadius:6, cursor: blocked ? "default" : "pointer",
                    border:`1px solid ${edgeInDraft ? `${C.green}50` : blocked ? `${C.muted}30` : `${C.amber}40`}`,
                    background: edgeInDraft ? `${C.green}12` : blocked ? "transparent" : `${C.amber}10`,
                    color: blocked ? C.muted : edgeInDraft ? C.green : C.amber,
                  }}>
                    {isFinished ? "✓ Match Finished" : isPPD ? "✗ Match Unavailable" : edgeInDraft ? "✓ Added" : otherInDraft ? "↺ Replace" : "+ Add Edge"}
                  </button>
                </div>
              )}
            </div>
          );
        })()}

        {/* ── GOAL RADAR (supports home + away + extras) ───────────── */}
        {(() => {
          const gr = f.goalRadar;
          if (!gr || (!gr.home && !gr.away)) return (
            <div style={{ padding:"10px 14px", background:C.surface, borderRadius:10, border:`1px solid ${C.border}`, display:"flex", alignItems:"center", gap:8, opacity:0.45 }}>
              <span style={{ fontSize:9, fontWeight:800, letterSpacing:".1em", textTransform:"uppercase", color:C.muted }}>Goal Radar</span>
              <span style={{ fontSize:10, color:C.muted, fontStyle:"italic" }}>Insufficient data</span>
            </div>
          );

          const ftStates  = ["finished","ft","fulltime","ended","complete","aet","afterextratime","afterpenalties"];
          const ppdStates = ["postponed","ppd","cancelled","canceled","abandoned","suspended","interrupted","deleted"];
          const norm      = (f.state||"").toLowerCase().replace(/[_\-\s]/g,"");
          const isFinished = ftStates.includes(norm);
          const isPPD      = ppdStates.includes(norm);
          const blocked    = isFinished || isPPD;
          const dl         = Array.isArray(draftLegs) ? draftLegs.find(l => l.fixtureId === f.id) : null;
          const radarInDraft = !!dl && (dl.market === "TeamTotal" || dl.market?.includes("TeamTotal"));
          const otherInDraft = !!dl && !radarInDraft;

          const entries = [
            gr.home      && { ...gr.home,      isExtra:false },
            gr.homeExtra && { ...gr.homeExtra,  isExtra:true  },
            gr.away      && { ...gr.away,       isExtra:false },
            gr.awayExtra && { ...gr.awayExtra,  isExtra:true  },
          ].filter(Boolean);

          return (
            <div style={{ background:C.surface, borderRadius:10, border:`1px solid ${C.border}`, borderLeft:`3px solid ${C.radar}`, overflow:"hidden" }}>
              {/* header */}
              <div style={{ padding:"11px 14px 8px", display:"flex", alignItems:"center", justifyContent:"space-between" }}>
                <div style={{ display:"flex", alignItems:"center", gap:6 }}>
                  <span style={{ fontSize:9, fontWeight:800, letterSpacing:".1em", textTransform:"uppercase", color:C.radar, background:`${C.radar}14`, borderRadius:3, padding:"2px 7px" }}>
                    Goal Radar
                  </span>
                  <TipIcon text="Probability that each team scores at least one goal, based on attack strength, defence, and recent form." />
                </div>
              </div>
              {/* entries grid */}
              <div style={{ padding:"0 14px 12px", display:"flex", gap:8, flexWrap:"wrap" }}>
                {entries.map((entry, i) => {
                  const prob      = Math.round(entry.prob||0);
                  const thisAdded = !!dl && dl.pick === entry.pick && radarInDraft;
                  return (
                    <div key={i} style={{
                      flex:"1 1 calc(50% - 4px)", minWidth:120,
                      background:`${C.radar}08`, border:`1px solid ${C.radar}${entry.isExtra?"18":"28"}`,
                      borderRadius:8, padding:"10px 12px", opacity:entry.isExtra?0.75:1,
                    }}>
                      <div style={{ fontSize:12, fontWeight:800, color:C.text, marginBottom:3 }}>{entry.pick}</div>
                      <div style={{ fontSize:19, fontWeight:900, color:C.text, letterSpacing:"-.03em", lineHeight:1 }}>{prob}%</div>
                      <div style={{ margin:"6px 0 8px", height:3, background:C.faint, borderRadius:2, overflow:"hidden" }}>
                        <div style={{ height:"100%", width:`${prob}%`, background:C.radar, borderRadius:2 }} />
                      </div>
                      {entry.isExtra
                        ? <div style={{ fontSize:8, color:C.radar, fontStyle:"italic" }}>O1.5 also strong — add via Custom Pick</div>
                        : onAddToParlay && (
                          <button onClick={() => !blocked && handleAdd({...entry, market:"TeamTotal"})} style={{
                            fontSize:9, fontWeight:700, letterSpacing:".06em", textTransform:"uppercase",
                            padding:"4px 10px", borderRadius:5, cursor: blocked ? "default" : "pointer",
                            border:`1px solid ${thisAdded ? `${C.green}50` : blocked ? `${C.muted}30` : `${C.radar}40`}`,
                            background: thisAdded ? `${C.green}12` : blocked ? "transparent" : `${C.radar}10`,
                            color: blocked ? C.muted : thisAdded ? C.green : C.radar,
                          }}>
                            {isFinished ? "✓ Finished" : isPPD ? "✗ Unavailable" : thisAdded ? "✓ Added" : otherInDraft ? "↺ Replace" : "+ Add"}
                          </button>
                        )
                      }
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })()}

      </div>

                  {/* ══ DATA PANELS ═════════════════════════════════════════════════════ */}
      <div style={{
        padding: "16px 12px", display: "flex", flexDirection: "column",
        gap: 14, maxWidth: 700, width: "100%", margin: "0 auto",
      }}>

        <FixtureBookNow fixture={f} onAddToParlay={onAddToParlay ? handleAdd : null} />

        {/* Expected Goals */}
        <SectionPanel
          label="Expected Goals"
          labelRight={xgTotal > 0 ? `Combined ${xgTotal.toFixed(2)} xG` : null}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 14, marginBottom: 12 }}>
            {/* Home xG */}
            <div style={{ textAlign: "left", minWidth: 56 }}>
              <div style={{
                fontSize: 38, fontWeight: 900, color: C.accent, lineHeight: 1,
                fontFamily: "var(--display,'Azeret Mono',monospace)", letterSpacing: "-.04em",
              }}>
                {m.homeXG}
              </div>
              <div style={{ fontSize: 9, color: C.muted, marginTop: 2, fontWeight: 600 }}>
                {f.teams.home.split(" ")[0]}
              </div>
            </div>

            {/* Split bar */}
            <div style={{ flex: 1, position: "relative", height: 22 }}>
              <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center" }}>
                <div style={{
                  height: 4, background: C.accent, opacity: .55,
                  borderRadius: "3px 0 0 3px",
                  width: `${xgHomePct}%`, transition: "width .8s cubic-bezier(.16,1,.3,1)",
                }} />
                <div style={{ height: 4, background: C.blue, opacity: .55, borderRadius: "0 3px 3px 0", flex: 1 }} />
              </div>
              {/* Center marker */}
              <div style={{
                position: "absolute", left: `${xgHomePct}%`,
                transform: "translateX(-50%)", width: 3, height: 22,
                background: C.text, borderRadius: 1, zIndex: 2, opacity: 0.6,
              }} />
              <div style={{
                position: "absolute", left: "50%", transform: "translateX(-50%)",
                bottom: -13, fontSize: 8, color: C.muted, letterSpacing: ".06em",
                textTransform: "uppercase", whiteSpace: "nowrap",
              }}>
                even
              </div>
            </div>

            {/* Away xG */}
            <div style={{ textAlign: "right", minWidth: 56 }}>
              <div style={{
                fontSize: 38, fontWeight: 900, color: C.blue, lineHeight: 1,
                fontFamily: "var(--display,'Azeret Mono',monospace)", letterSpacing: "-.04em",
              }}>
                {m.awayXG}
              </div>
              <div style={{ fontSize: 9, color: C.muted, marginTop: 2, textAlign: "right", fontWeight: 600 }}>
                {f.teams.away.split(" ")[0]}
              </div>
            </div>
          </div>
          <Explainer text={xgEx} style={{ marginTop: 4 }} />
        </SectionPanel>

        {/* Match Result */}
        <SectionPanel
          label="Match Result"
          labelRight={null}
        >
          {[
            { l: "H", prob: m.homeWin, odds: f.odds?.o1,  color: C.accent, ex: resultEx?.H, histKey: "homeWinHist" },
            { l: "X", prob: m.draw,    odds: f.odds?.oX,  color: C.muted,  ex: resultEx?.X, histKey: "drawHist"    },
            { l: "A", prob: m.awayWin, odds: f.odds?.o2,  color: C.blue,   ex: resultEx?.A, histKey: "awayWinHist" },
          ].map((r, ri, arr) => {
            const prob   = Math.round(r.prob || 0);
            const hist   = Math.round(f.markets?.[r.histKey] || 0);
            const d      = hist ? prob - hist : null;
            const isLast = ri === arr.length - 1;
            return (
              <div key={r.l} style={{
                paddingBottom: isLast ? 0 : 10,
                marginBottom: isLast ? 0 : 10,
                borderBottom: isLast ? "none" : `1px solid ${C.faint}`,
              }}>
                <div style={{
                  display: "grid", gridTemplateColumns: "16px 1fr 44px 34px",
                  gap: 10, alignItems: "center", marginBottom: d !== null ? 5 : 2,
                }}>
                  <span style={{ fontSize: 11, fontWeight: 700, color: C.muted }}>{r.l}</span>
                  <div style={{ height: 4, background: C.faint, borderRadius: 2, overflow: "hidden" }}>
                    <div style={{
                      height: "100%", width: `${prob}%`, background: r.color,
                      borderRadius: 2, transition: "width .6s cubic-bezier(.16,1,.3,1)",
                    }} />
                  </div>
                  <span style={{
                    fontSize: 18, color: r.color, fontWeight: 900, textAlign: "right",
                    fontFamily: "var(--display,'Azeret Mono',monospace)", letterSpacing: "-.02em",
                  }}>
                    {prob}%
                  </span>
                  {r.odds
                    ? <span style={{ fontSize: 9, color: C.muted, textAlign: "right" }}>{r.odds}×</span>
                    : <span />
                  }
                </div>
                {d !== null && (
                  <div style={{ display: "flex", gap: 5, paddingLeft: 24, alignItems: "center" }}>
                    <span style={{
                      fontSize: 10, fontWeight: 700,
                      color: d > 3 ? C.green : d < -3 ? C.red : C.muted,
                    }}>
                      {d > 0 ? `+${d}%` : `${d}%`} {d > 3 ? "above historical rate" : d < -3 ? "below historical rate" : "on historical rate"}
                    </span>
                    <span style={{ fontSize: 9, color: C.muted, opacity: .6 }}>(hist avg {hist}%)</span>
                  </div>
                )}
                {r.ex && <Explainer text={r.ex} style={{ paddingLeft: 24, marginTop: 4 }} />}
              </div>
            );
          })}
        </SectionPanel>

        {/* Goal Range */}
        <SectionPanel
          label="Goal Range"
          labelRight={null}
        >
          {goalEx && (
            <div style={{ marginBottom: 14 }}>
              <div style={{
                fontSize: 13, fontWeight: 800, color: C.orange,
                letterSpacing: "-.01em", fontFamily: "var(--display,'Azeret Mono',monospace)",
                marginBottom: 3,
              }}>
                {goalEx.headline}
              </div>
              <div style={{ fontSize: 10, color: C.muted, fontStyle: "italic", lineHeight: 1.55 }}>
                {goalEx.desc}
              </div>
            </div>
          )}
          {[
            { mkt: "O1.5", prob: m.over15,  odds: f.odds?.over15,  color: C.green  },
            { mkt: "O2.5", prob: m.over25,  odds: f.odds?.over25,  color: C.green  },
            { mkt: "O3.5", prob: m.over35,  odds: f.odds?.over35,  color: C.amber  },
            { mkt: "U2.5", prob: m.under25, odds: f.odds?.under25, color: C.blue   },
            { mkt: "U3.5", prob: m.under35, odds: f.odds?.under35, color: C.blue   },
          ].map((r, ri, arr) => {
            const prob   = Math.round(r.prob || 0);
            const isLast = ri === arr.length - 1;
            return (
              <div key={r.mkt} style={{
                display: "grid", gridTemplateColumns: "36px 1fr 36px 30px",
                gap: 8, alignItems: "center", padding: "7px 0",
                borderBottom: isLast ? "none" : `1px solid ${C.faint}`,
              }}>
                <span style={{ fontSize: 10, fontWeight: 700, color: C.muted }}>{r.mkt}</span>
                <div style={{ height: 4, background: C.faint, borderRadius: 1, overflow: "hidden" }}>
                  <div style={{
                    height: "100%", width: `${prob}%`, background: r.color,
                    borderRadius: 1, transition: "width .6s cubic-bezier(.16,1,.3,1)",
                  }} />
                </div>
                <span style={{
                  fontFamily: "var(--display,'Azeret Mono',monospace)",
                  fontSize: 13, fontWeight: 800, color: r.color,
                  textAlign: "right", letterSpacing: "-.02em",
                }}>
                  {prob}%
                </span>
                {r.odds
                  ? <span style={{ fontSize: 9, color: C.muted, textAlign: "right" }}>{r.odds}×</span>
                  : <span />
                }
              </div>
            );
          })}
          {m.likelyScore && (
            <div style={{ marginTop: 14, paddingTop: 12, borderTop: `1px solid ${C.border}` }}>
              <div style={{
                fontSize: 9, fontWeight: 700, letterSpacing: ".12em",
                textTransform: "uppercase", color: C.muted, marginBottom: 4,
              }}>
                Likely Scoreline
              </div>
              <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
                <span style={{
                  fontFamily: "var(--display,'Azeret Mono',monospace)",
                  fontSize: 30, fontWeight: 900, color: C.text,
                  letterSpacing: "-.04em", lineHeight: 1,
                }}>
                  {m.likelyScore}
                </span>
                {m.likelyScoreProb && (
                  <span style={{ fontSize: 11, color: C.muted }}>
                    {Math.round(m.likelyScoreProb)}% probability
                  </span>
                )}
              </div>
            </div>
          )}
        </SectionPanel>

        {/* BTTS */}
        <SectionPanel label="Both Teams to Score">
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1px 1fr", gap: 0 }}>
            {/* Yes side */}
            <div style={{ paddingRight: 14 }}>
              <div style={{
                fontSize: 9, fontWeight: 700, letterSpacing: ".10em",
                textTransform: "uppercase", color: C.muted, marginBottom: 6,
              }}>
                Yes
              </div>
              <div style={{ display: "flex", alignItems: "baseline", gap: 6, marginBottom: 6 }}>
                <span style={{
                  fontSize: 30, fontWeight: 900, letterSpacing: "-.05em", lineHeight: 1,
                  color: m.bttsYes >= 60 ? C.orange : C.muted,
                  fontFamily: "var(--display,'Azeret Mono',monospace)",
                }}>
                  {Math.round(m.bttsYes)}%
                </span>
                {m.bttsYes >= 60 && (
                  <span style={{
                    fontSize: 8, fontWeight: 700, color: C.orange,
                    background: `${C.orange}14`, border: `1px solid ${C.orange}30`,
                    padding: "2px 5px", borderRadius: 3, letterSpacing: ".04em",
                    textTransform: "uppercase", flexShrink: 0,
                  }}>
                    Qualifies
                  </span>
                )}
              </div>
              <div style={{ height: 4, background: C.faint, borderRadius: 2, overflow: "hidden", marginBottom: 8 }}>
                <div style={{
                  height: "100%", width: `${Math.round(m.bttsYes)}%`,
                  background: C.orange, borderRadius: 2,
                  transition: "width .7s cubic-bezier(.16,1,.3,1)",
                }} />
              </div>
              <Explainer text={bttsEx?.yes} />
            </div>

            {/* Divider */}
            <div style={{ background: C.border, margin: "0 0" }} />

            {/* No side */}
            <div style={{ paddingLeft: 14 }}>
              <div style={{
                fontSize: 9, fontWeight: 700, letterSpacing: ".10em",
                textTransform: "uppercase", color: C.muted, marginBottom: 6, textAlign: "right",
              }}>
                No
              </div>
              <div style={{
                fontSize: 30, fontWeight: 900, letterSpacing: "-.05em", lineHeight: 1,
                color: C.muted, fontFamily: "var(--display,'Azeret Mono',monospace)",
                marginBottom: 6, textAlign: "right",
              }}>
                {Math.round(m.bttsNo)}%
              </div>
              {/* Bar fills right-to-left for symmetry */}
              <div style={{ height: 4, background: C.faint, borderRadius: 2, overflow: "hidden", marginBottom: 8, direction: "rtl" }}>
                <div style={{
                  height: "100%", width: `${Math.round(m.bttsNo)}%`,
                  background: C.muted, opacity: 0.5, borderRadius: 2,
                  transition: "width .7s cubic-bezier(.16,1,.3,1)",
                }} />
              </div>
              <Explainer text={bttsEx?.no} style={{ textAlign: "right" }} />
            </div>
          </div>
        </SectionPanel>

        {/* Team Totals */}
        <SectionPanel label="Team Totals">
          {[
            { name: f.teams.home, o05: m.homeOver05, o15: m.homeOver15, cs: m.homeCS, stats: f.teamStats?.home, ex: homeEx, accent: C.accent },
            { name: f.teams.away, o05: m.awayOver05, o15: m.awayOver15, cs: m.awayCS, stats: f.teamStats?.away, ex: awayEx, accent: C.blue  },
          ].map((t, ti, arr) => (
            <div key={t.name} style={{
              paddingLeft: 12,
              borderLeft: `2px solid ${t.accent}`,
              marginBottom: ti < arr.length - 1 ? 18 : 0,
            }}>
              <div style={{
                fontSize: 12, fontWeight: 800, color: C.text,
                marginBottom: 8, letterSpacing: "-.01em",
              }}>
                {t.name}
              </div>
              <div style={{ display: "flex", flexDirection: "column", marginBottom: 8 }}>
                {[
                  { lbl: "To Score (O0.5)", val: t.o05 },
                  { lbl: "Score 2+ (O1.5)", val: t.o15 },
                  { lbl: "Clean Sheet",     val: t.cs  },
                ].map((stat, si) => {
                  const pct = Math.round(stat.val || 0);
                  const col = pct >= 65 ? C.green : pct >= 45 ? C.text : C.muted;
                  return (
                    <div key={stat.lbl} style={{
                      display: "grid", gridTemplateColumns: "90px 1fr 34px",
                      gap: 6, alignItems: "center", padding: "4px 0",
                      borderBottom: si < 2 ? `1px solid ${C.faint}` : "none",
                    }}>
                      <span style={{ fontSize: 9, color: C.muted, fontWeight: 600 }}>{stat.lbl}</span>
                      <div style={{ height: 3, background: C.faint, borderRadius: 1, overflow: "hidden" }}>
                        <div style={{
                          height: "100%", width: `${pct}%`,
                          background: col, opacity: 0.75, borderRadius: 1,
                        }} />
                      </div>
                      <span style={{
                        fontSize: 11, fontWeight: 700, color: col, textAlign: "right",
                        fontFamily: "var(--display,'Azeret Mono',monospace)", letterSpacing: "-.02em",
                      }}>
                        {pct}%
                      </span>
                    </div>
                  );
                })}
              </div>
              <Explainer text={t.ex} style={{ marginBottom: t.stats?.recentResults?.length ? 8 : 0 }} />
              <BottomFormStrip recentResults={t.stats?.recentResults} />
            </div>
          ))}
        </SectionPanel>

        {/* Combos */}
        {f.combos?.length > 0 && (
          <SectionPanel label="Combo Suggestions">
            {f.combos.map((combo, i) => (
              <ComboRow key={i} combo={combo} onAddToParlay={onAddToParlay ? handleAdd : null} />
            ))}
          </SectionPanel>
        )}

        {/* Bottom spacer — no redundant back button here (header handles it) */}
        <div style={{ height: 48 }} />
      </div>
      </div>{/* end P20 desktop column */}
    </div>
  );
}
