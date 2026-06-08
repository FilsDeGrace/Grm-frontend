// ─────────────────────────────────────────────────────────────────────────────
//  CodeAnalyzer.jsx  —  GRM Pro · Code Analyzer  (v3)
//  Props: { theme, C, SERVER, onSendToDraft }
// ─────────────────────────────────────────────────────────────────────────────

import { useState, useEffect, useRef, useCallback } from "react";

// ─────────────────────────────────────────────────────────────────────────────
//  CONSTANTS
// ─────────────────────────────────────────────────────────────────────────────

const STEPS = [
  "Reading your slip",
  "Matching against snapshots",
  "Jarvis researching live context",
];

const BOOKMAKERS = [
  { id: "sb", label: "SportyBet" },
  { id: "ll", label: "Lucky's Ledger" },
];

const HISTORY_KEY    = "grm_ca_history";
const JARVIS_KEY     = (platform, code) => `grm_ca_jarvis_${platform}_${code}_${new Date().toISOString().slice(0,10)}`;
const MAX_HISTORY    = 20;

// Bookmaker share link builders
const BOOKIE_LINKS = {
  sb: {
    shareLink: (code) => `https://www.sportybet.com/ng/?shareCode=${code}`,
    appLink:   (code) => `sportybet://share?shareCode=${code}`,
  },
  ll: {
    shareLink: (code) => `https://luckysledger.com/sports?btBookingCode=${code}`,
    appLink:   (code) => `luckysledger://betslip?btBookingCode=${code}`,
  },
};

// ─────────────────────────────────────────────────────────────────────────────
//  HELPERS
// ─────────────────────────────────────────────────────────────────────────────

// N1-FIX: copyToClipboard — safe clipboard write with execCommand fallback.
// navigator.clipboard.writeText() triggers an unexpected Android permission
// dialog on some versions. execCommand('copy') is synchronous, needs no prompt,
// and works reliably in all Android WebViews. Mirror of App.jsx helper.
function copyToClipboard(text, onSuccess, onError) {
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(text).then(
      () => onSuccess?.(),
      () => _execCommandCopy(text, onSuccess, onError)
    );
    return;
  }
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
    if (ok) onSuccess?.();
    else onError?.();
  } catch {
    onError?.();
  }
}

function impliedPct(odds) {
  const o = parseFloat(odds);
  if (!o || o <= 1) return null;
  return Math.round((1 / o) * 100);
}

function alignColor(prob, C) {
  if (prob == null) return C.silver;
  if (prob >= 65)   return C.green;
  if (prob >= 50)   return C.amber;
  if (prob >= 35)   return C.orange;
  return C.red;
}

function alignLabel(prob) {
  if (prob == null) return "No model data";
  if (prob >= 65)   return "Model backs this pick";
  if (prob >= 50)   return "Mild support from model";
  if (prob >= 35)   return "Model leans against";
  return "Model disagrees";
}

// SVG-only icons — no emoji
const Icons = {
  check: (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="2.8" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="20 6 9 17 4 12"/>
    </svg>
  ),
  warn: (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
      <line x1="12" y1="9" x2="12" y2="13"/>
      <line x1="12" y1="17" x2="12.01" y2="17"/>
    </svg>
  ),
  cross: (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="2.8" strokeLinecap="round" strokeLinejoin="round">
      <line x1="18" y1="6" x2="6" y2="18"/>
      <line x1="6" y1="6" x2="18" y2="18"/>
    </svg>
  ),
  copy: (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="9" y="9" width="13" height="13" rx="2" ry="2"/>
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
    </svg>
  ),
  back: (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="15 18 9 12 15 6"/>
    </svg>
  ),
  info: (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10"/>
      <line x1="12" y1="16" x2="12" y2="12"/>
      <line x1="12" y1="8" x2="12.01" y2="8"/>
    </svg>
  ),
  chevDown: (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="6 9 12 15 18 9"/>
    </svg>
  ),
  chevUp: (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="18 15 12 9 6 15"/>
    </svg>
  ),
  expand: (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="15 3 21 3 21 9"/>
      <polyline points="9 21 3 21 3 15"/>
      <line x1="21" y1="3" x2="14" y2="10"/>
      <line x1="3" y1="21" x2="10" y2="14"/>
    </svg>
  ),
  trash: (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="3 6 5 6 21 6"/>
      <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>
      <path d="M10 11v6"/>
      <path d="M14 11v6"/>
    </svg>
  ),
  bolt: (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
      <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>
    </svg>
  ),
  reanalyze: (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="23 4 23 10 17 10"/>
      <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>
    </svg>
  ),
};

function marketShort(market) {
  const m = (market || "").toLowerCase();
  if (m.includes("double chance")) return "DC";
  if (m.includes("gg") || m.includes("btts") || m.includes("both teams")) return "BTTS";
  if (m === "1x2") return "1X2";
  if (m.includes("over/under") || m.includes("over") || m.includes("under")) {
    const match = market.match(/(over|under)\s*([\d.]+)/i);
    if (match) return `${match[1][0].toUpperCase()}/${match[2]}`;
  }
  if (m.includes("teamtotal") || m.includes("team total")) return "TT";
  return (market || "?").slice(0, 5).toUpperCase();
}

function calcParlayProb(legs) {
  if (!legs?.length) return null;
  const probs = legs.map(l => l.modelProb).filter(p => p != null && p > 0);
  if (!probs.length) return null;
  const raw = probs.reduce((acc, p) => acc * (p / 100), 1) * 100;
  if (raw < 0.1) return "<0.1";
  if (raw < 1)   return raw.toFixed(1);
  return raw.toFixed(0);
}

// Parse a raw input — either a booking code or a bookmaker link
// Returns { code, detectedPlatform } or null if blank
function parseInput(raw) {
  const s = (raw || "").trim();
  if (!s) return null;

  // SB share link
  // e.g. http://www.sportybet.com/ng/?shareCode=XY57QX
  const sbMatch = s.match(/sportybet\.com.*[?&]shareCode=([A-Z0-9]+)/i);
  if (sbMatch) return { code: sbMatch[1].toUpperCase(), detectedPlatform: "sb" };

  // LL booking link — domain is luckysledger.com
  // e.g. https://luckysledger.com/sports?btBookingCode=E9EEE0A
  const llMatch = s.match(/luckysledger\.com.*[?&]btBookingCode=([A-Z0-9]+)/i);
  if (llMatch) return { code: llMatch[1].toUpperCase(), detectedPlatform: "ll" };

  // Plain code — no detection
  return { code: s.toUpperCase(), detectedPlatform: null };
}

// History helpers (localStorage)
function historyLoad() {
  try { return JSON.parse(localStorage.getItem(HISTORY_KEY) || "[]"); }
  catch { return []; }
}

function historySave(entry) {
  // entry: { platform, code, legs, parlayProb, totalOdds, savedAt }
  const prev = historyLoad().filter(h => !(h.platform === entry.platform && h.code === entry.code));
  const next = [entry, ...prev].slice(0, MAX_HISTORY);
  try { localStorage.setItem(HISTORY_KEY, JSON.stringify(next)); } catch {}
}

function historyDelete(platform, code) {
  const next = historyLoad().filter(h => !(h.platform === platform && h.code === code));
  try { localStorage.setItem(HISTORY_KEY, JSON.stringify(next)); } catch {}
}

// ─────────────────────────────────────────────────────────────────────────────
//  SMALL SHARED UI ATOMS
// ─────────────────────────────────────────────────────────────────────────────

function Dots() {
  const [n, setN] = useState(1);
  useEffect(() => {
    const t = setInterval(() => setN(x => x >= 3 ? 1 : x + 1), 380);
    return () => clearInterval(t);
  }, []);
  return <span>{".".repeat(n)}</span>;
}

function Bar({ value, color, height = 4, flex, C }) {
  return (
    <div style={{ flex: flex || 1, height, background: C.surface, borderRadius: height / 2, overflow: "hidden" }}>
      <div style={{ height: "100%", width: `${Math.min(value || 0, 100)}%`, background: color, borderRadius: height / 2 }} />
    </div>
  );
}

function Chip({ children, color, bg, border, style = {} }) {
  return (
    <span style={{
      display: "inline-flex", alignItems: "center", gap: 3,
      fontSize: 8, fontWeight: 800, letterSpacing: ".07em",
      textTransform: "uppercase", padding: "2px 7px",
      borderRadius: 999, border: `1px solid ${border || color + "35"}`,
      background: bg || color + "14", color,
      ...style,
    }}>
      {children}
    </span>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
//  JARVIS TEXT RENDERER
// ─────────────────────────────────────────────────────────────────────────────

function JarvisText({ text, C }) {
  if (!text) return null;

  const raw = text.trim();
  const hasStructure = /\*\*[A-Z]/.test(raw);

  const headingColor = (label) => {
    const l = label.toUpperCase();
    if (l.includes("VERDICT") || l.includes("OVERALL")) return C.green;
    if (l.includes("SQUAD") || l.includes("NEWS") || l.includes("INJURY")) return C.amber;
    if (l.includes("MODEL") || l.includes("CHECK")) return C.edge || "#3333aa";
    if (l.includes("CONTEXT") || l.startsWith("LEG")) return C.muted;
    return C.accent;
  };

  if (hasStructure) {
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
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {sections.map((sec, si) => (
          <div key={si} style={{
            padding: "8px 10px",
            borderLeft: `3px solid ${sec.color}`,
            borderRadius: "0 6px 6px 0",
            background: `${sec.color}0a`,
          }}>
            {sec.label && (
              <div style={{
                fontSize: 8, fontWeight: 800, color: sec.color,
                letterSpacing: ".08em", textTransform: "uppercase",
                marginBottom: 4, fontFamily: C.font,
              }}>
                {sec.label}
              </div>
            )}
            <div style={{ fontSize: 11, color: C.text, lineHeight: 1.65, fontFamily: C.font }}>
              {sec.body}
            </div>
          </div>
        ))}
      </div>
    );
  }

  // Fallback: line-by-line with inline bold support
  return (
    <div>
      {raw.split("\n").map((line, i) => {
        if (!line.trim()) return <div key={i} style={{ height: 6 }} />;
        const parts = line.split(/\*\*(.+?)\*\*/g);
        return (
          <div key={i} style={{ fontSize: 11, color: C.text, lineHeight: 1.65,
                                 marginBottom: 2, fontFamily: C.font }}>
            {parts.map((p, j) => j % 2 === 1
              ? <span key={j} style={{ fontWeight: 700 }}>{p}</span>
              : p
            )}
          </div>
        );
      })}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
//  PROB BAR COMPONENT
// ─────────────────────────────────────────────────────────────────────────────

function ProbBar({ modelProb, impliedP, C }) {
  const color = alignColor(modelProb, C);
  return (
    <div style={{ marginTop: 8 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 7, marginBottom: 5 }}>
        <div style={{ fontSize: 8, color: C.muted, fontFamily: C.font, letterSpacing: ".04em", minWidth: 46, textAlign: "right" }}>
          Model
        </div>
        <div style={{ flex: 1, height: 7, background: C.surface, borderRadius: 4, overflow: "hidden", position: "relative" }}>
          {impliedP != null && (
            <div style={{ position: "absolute", inset: 0, width: `${Math.min(impliedP, 100)}%`, background: `${C.muted}25`, borderRadius: 4 }} />
          )}
          {modelProb != null && (
            <div style={{ position: "absolute", inset: 0, width: `${Math.min(modelProb, 100)}%`, background: color, borderRadius: 4 }} />
          )}
        </div>
        <div style={{ fontSize: 12, fontWeight: 900, color: modelProb != null ? color : C.muted, fontFamily: C.font, minWidth: 38 }}>
          {modelProb != null ? `${modelProb}%` : "—"}
        </div>
      </div>
      {impliedP != null && (
        <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
          <div style={{ fontSize: 8, color: C.muted, fontFamily: C.font, letterSpacing: ".04em", minWidth: 46, textAlign: "right", opacity: .7 }}>
            Bookie's odds
          </div>
          <div style={{ flex: 1, height: 4, background: C.surface, borderRadius: 2, overflow: "hidden" }}>
            <div style={{ width: `${Math.min(impliedP, 100)}%`, height: "100%", background: C.muted, opacity: .4, borderRadius: 2 }} />
          </div>
          <div style={{ fontSize: 10, color: C.muted, fontFamily: C.font, minWidth: 38, opacity: .7 }}>
            {impliedP}%
          </div>
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
//  FULL MODEL OVERLAY  — redesigned to match App.jsx FullModelPage
// ─────────────────────────────────────────────────────────────────────────────

function FullModelOverlay({ f, onClose, C }) {
  const m = f?.markets;
  if (!f || !m) return null;

  // Tier 1 — instant match brief from data
  const buildVoice = () => {
    const lines = [];
    const hxg = parseFloat(m.homeXG) || 0;
    const axg = parseFloat(m.awayXG) || 0;
    const total = hxg + axg;
    if (hxg && axg) {
      const diff = Math.abs(hxg - axg);
      const fav  = hxg > axg ? f.teams?.home : f.teams?.away;
      const dog  = hxg > axg ? f.teams?.away : f.teams?.home;
      if (diff < 0.2)      lines.push(`Expected goals are level at ${hxg} vs ${axg} — an evenly contested match with no clear edge on output.`);
      else if (diff < 0.5) lines.push(`${fav} hold a slim xG edge (${Math.max(hxg,axg).toFixed(2)} vs ${Math.min(hxg,axg).toFixed(2)}). A marginal advantage in the model's eyes.`);
      else                 lines.push(`${fav} are the stronger side on expected output (${Math.max(hxg,axg).toFixed(2)} vs ${Math.min(hxg,axg).toFixed(2)} for ${dog?.split(" ")[0]}). A clear performance gap.`);
    }
    const o25 = m.over25 || 0;
    if (total > 2.8 && o25 > 65) lines.push(`Combined xG of ${total.toFixed(2)} and Over 2.5 at ${Math.round(o25)}% — goals are well expected in this fixture.`);
    else if (total < 1.8)         lines.push(`Combined xG of ${total.toFixed(2)} points to a low-scoring match. Under 2.5 looks the stronger position.`);
    else                          lines.push(`Combined xG of ${total.toFixed(2)} suggests a moderate goal environment. Over 2.5 sits at ${Math.round(o25)}%.`);
    return lines.join(" ");
  };

  // Tier 2 — auto Jarvis with cache
  const cacheKey = JARVIS_KEY("fm", f.id || f.teams?.home);
  const JarvisBrief = () => {
    const [brief, setBrief]     = useState(() => { try { return localStorage.getItem(cacheKey) || null; } catch { return null; } });
    const [loading, setLoading] = useState(false);
    const calledRef = useRef(!!brief);
    useEffect(() => {
      if (calledRef.current) return;
      const t = setTimeout(async () => {
        if (calledRef.current) return;
        calledRef.current = true;
        setLoading(true);
        try {
          const prompt = [
            "You are a football analyst briefing a betting team. 4-5 sentences. No emoji. No 'as an AI'. Plain English. Direct.",
            `Match: ${f.teams?.home} vs ${f.teams?.away}`,
            `xG: Home ${m.homeXG}, Away ${m.awayXG}`,
            `Win probs: Home ${Math.round(m.homeWin||0)}%, Draw ${Math.round(m.draw||0)}%, Away ${Math.round(m.awayWin||0)}%`,
            `BTTS: ${Math.round(m.bttsYes||0)}%. O2.5: ${Math.round(m.over25||0)}%.`,
            "HIERARCHY: lead with recent form (last 5 games) and model probabilities. Note injury/squad news if you find any. H2H is a weak secondary signal only — do not let past meetings override current form trajectory. Give a concise match assessment and the pick you'd back, with brief reasoning.",
          ].join("\n");
          const res  = await fetch("https://api.anthropic.com/v1/messages", {
            method:"POST", headers:{"Content-Type":"application/json"},
            body: JSON.stringify({ model:"claude-sonnet-4-20250514", max_tokens:800,
              tools:[{type:"web_search_20250305",name:"web_search"}],
              messages:[{role:"user",content:prompt}] }),
          });
          const data = await res.json();
          const text = (data.content||[]).filter(b=>b.type==="text").map(b=>b.text).join(" ").trim();
          if (text) { setBrief(text); try { localStorage.setItem(cacheKey, text); } catch {} }
        } catch {}
        setLoading(false);
      }, 1500);
      return () => clearTimeout(t);
    }, []);
    if (!loading && !brief) return null;
    return (
      <div style={{ marginTop:10, paddingTop:10, borderTop:`1px solid ${C.border}` }}>
        <div style={{ fontSize:8, fontWeight:800, color:C.edge, letterSpacing:".1em", textTransform:"uppercase", marginBottom:6 }}>
          Analyst View {brief && <span style={{ color:C.muted, fontWeight:400, letterSpacing:0, textTransform:"none" }}>· cached</span>}
        </div>
        {loading && <div style={{ fontSize:10, color:C.muted, fontStyle:"italic" }}>Researching…</div>}
        {brief && <div style={{ fontSize:11, color:C.text, lineHeight:1.65 }}>{brief}</div>}
      </div>
    );
  };

  const formDot = r => ({ W: C.green, D: C.gold || C.amber, L: C.red }[r] || C.faint);

  const ProbRow = ({ label, prob, odds, color }) => (
    <div style={{ display:"flex", alignItems:"center", gap:8, marginBottom:5 }}>
      <span style={{ fontSize:10, color:C.muted, minWidth:28, fontWeight:700 }}>{label}</span>
      <div style={{ flex:1, height:4, background:C.surface, borderRadius:2, overflow:"hidden" }}>
        <div style={{ height:"100%", width:`${Math.min(prob||0,100)}%`, background:color, borderRadius:2 }}/>
      </div>
      <span style={{ fontSize:11, fontWeight:800, color, minWidth:34, textAlign:"right" }}>
        {prob != null ? `${Math.round(prob)}%` : "—"}
      </span>
      {odds && <span style={{ fontSize:9, color:C.muted, minWidth:30, textAlign:"right" }}>{odds}x</span>}
    </div>
  );

  const Panel = ({ label, color, bg, children }) => (
    <div style={{ background:bg||C.surface, border:`1px solid ${color}22`, borderRadius:16, padding:"12px 14px" }}>
      <div style={{ fontSize:9, fontWeight:800, color, letterSpacing:".1em", textTransform:"uppercase", marginBottom:10 }}>{label}</div>
      {children}
    </div>
  );

  const voice = buildVoice();

  return (
    <div style={{ position:"fixed", inset:0, zIndex:400, background:C.bg, overflowY:"auto", fontFamily:C.font }}>

      {/* Header */}
      <div style={{ position:"sticky", top:0, zIndex:10,
                    background:C.headerBg, borderBottom:`1px solid ${C.border}`,
                    backdropFilter:"blur(28px)", padding:"14px 16px",
                    display:"flex", alignItems:"center", gap:12 }}>
        <button onClick={onClose} style={{
          display:"flex", alignItems:"center", gap:6,
          background:"transparent", border:`1px solid ${C.border}`,
          borderRadius:C.btnRadius||10, padding:"7px 14px",
          fontSize:11, fontWeight:700, color:C.muted, cursor:"pointer", fontFamily:C.font,
        }}>
          {Icons.back} Back
        </button>
        <div style={{ flex:1, minWidth:0 }}>
          <div style={{ fontSize:13, fontWeight:800, color:C.text, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>
            {f.teams?.home} <span style={{ color:C.muted, fontWeight:400 }}>vs</span> {f.teams?.away}
          </div>
          {f.league && <div style={{ fontSize:9, color:C.muted, marginTop:2 }}>{f.league}</div>}
        </div>
      </div>

      <div style={{ padding:"14px 16px", display:"flex", flexDirection:"column", gap:12, maxWidth:700, margin:"0 auto" }}>

        {/* Match identity */}
        <div style={{ background:C.surface, border:`1px solid ${C.border}`, borderRadius:C.cardRadius||16, padding:"14px 16px" }}>
          <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:10 }}>
            <span style={{ fontSize:14, fontWeight:800, color:C.text, flex:1 }}>{f.teams?.home}</span>
            <span style={{ fontSize:10, color:C.muted, padding:"0 12px", flexShrink:0 }}>vs</span>
            <span style={{ fontSize:14, fontWeight:800, color:C.text, flex:1, textAlign:"right" }}>{f.teams?.away}</span>
          </div>
          {/* Form dots */}
          {(f.form?.home?.length || f.form?.away?.length) ? (
            <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center" }}>
              <div style={{ display:"flex", gap:4 }}>
                {(f.form?.home||[]).slice(0,5).map((r,i) => (
                  <div key={i} style={{ width:10, height:10, borderRadius:"50%", background:formDot(r) }}/>
                ))}
              </div>
              <div style={{ fontSize:8, color:C.muted }}>Form</div>
              <div style={{ display:"flex", gap:4 }}>
                {(f.form?.away||[]).slice(0,5).map((r,i) => (
                  <div key={i} style={{ width:10, height:10, borderRadius:"50%", background:formDot(r) }}/>
                ))}
              </div>
            </div>
          ) : null}
        </div>

        {/* Match Brief — Tier 1 + 2 */}
        <div style={{ background:C.surface, border:`1px solid ${C.goldBorder||C.border}`, borderRadius:C.cardRadius||16, padding:"14px 16px" }}>
          <div style={{ fontSize:9, fontWeight:800, color:C.gold, letterSpacing:".12em", textTransform:"uppercase", marginBottom:10 }}>Match Brief</div>
          <div style={{ fontSize:11, color:C.text, lineHeight:1.7 }}>{voice}</div>
          <JarvisBrief />
        </div>

        {/* xG */}
        {(m.homeXG || m.awayXG) && (
          <div style={{ background:C.surface, border:`1px solid ${C.border}`, borderRadius:C.cardRadius||16, padding:"14px 16px" }}>
            <div style={{ fontSize:9, fontWeight:800, color:C.muted, letterSpacing:".1em", textTransform:"uppercase", marginBottom:12 }}>Expected Goals</div>
            <div style={{ display:"flex", alignItems:"center", gap:14 }}>
              <div style={{ textAlign:"center", minWidth:48 }}>
                <div style={{ fontSize:24, fontWeight:800, color:C.gold, lineHeight:1 }}>{m.homeXG}</div>
                <div style={{ fontSize:8, color:C.muted, marginTop:3 }}>{(f.teams?.home||"").split(" ")[0]}</div>
              </div>
              <div style={{ flex:1, height:5, background:C.faint, borderRadius:3, overflow:"hidden", position:"relative" }}>
                <div style={{ position:"absolute", left:0, top:0, height:"100%",
                              width:`${(m.homeXG/(m.homeXG+m.awayXG))*100}%`,
                              background:C.gold, borderRadius:3 }}/>
              </div>
              <div style={{ textAlign:"center", minWidth:48 }}>
                <div style={{ fontSize:24, fontWeight:800, color:C.muted, lineHeight:1 }}>{m.awayXG}</div>
                <div style={{ fontSize:8, color:C.muted, marginTop:3 }}>{(f.teams?.away||"").split(" ")[0]}</div>
              </div>
            </div>
          </div>
        )}

        {/* The Read */}
        {f.theRead?.anchor && (() => {
          const { anchor, reinforcer, isFallback, scenario } = f.theRead;
          const color = isFallback ? C.muted : C.accent;
          const bg    = isFallback ? C.surface : `${C.accent}0e`;
          return (
            <div style={{ background:bg, border:`1px solid ${color}28`, borderRadius:C.cardRadius||16, padding:"12px 14px" }}>
              <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:8 }}>
                <div style={{ display:"flex", alignItems:"center", gap:6 }}>
                  <span style={{ fontSize:9, fontWeight:800, color, letterSpacing:".1em", textTransform:"uppercase" }}>
                    {isFallback ? "The Read · Low Signal" : "The Read"}
                  </span>
                  <span style={{ fontSize:8, fontWeight:600, color, opacity:.55 }}>highest confidence</span>
                  {anchor.strong && !isFallback && (
                    <Chip color={C.gold||C.amber} bg={`${C.gold||C.amber}14`}>Strong</Chip>
                  )}
                </div>
                {anchor.odds && <span style={{ fontSize:10, color:C.muted }}>{anchor.odds}x</span>}
              </div>
              <div style={{ fontSize:15, fontWeight:800, color, marginBottom:6 }}>{anchor.pick}</div>
              {scenario && !isFallback && <div style={{ fontSize:9, color:C.muted, fontStyle:"italic", marginBottom:6 }}>{scenario}</div>}
              <div style={{ display:"flex", alignItems:"center", gap:10 }}>
                <span style={{ fontSize:14, fontWeight:900, color }}>{Math.round(anchor.prob)}%</span>
                <Bar value={anchor.prob} color={color} flex={1} C={C} />
              </div>
              {anchor.empiricalRate != null && (anchor.sampleSize == null || anchor.sampleSize >= 5) && (
                <div style={{ fontSize:8, color:C.muted, marginTop:6 }}>
                  {anchor.market} hit rate: <strong style={{ color:C.text, opacity:.75 }}>{anchor.empiricalRate}%</strong>
                  {anchor.sampleSize != null && <span style={{ opacity:.6 }}> ({anchor.sampleSize} games)</span>}
                </div>
              )}
              {reinforcer && (
                <div style={{ marginTop:9, paddingTop:9, borderTop:`1px solid ${color}18` }}>
                  <span style={{ fontSize:8, color:C.muted, textTransform:"uppercase", letterSpacing:".1em" }}>Reinforced by </span>
                  <span style={{ fontSize:11, fontWeight:700, color:C.accent }}>{reinforcer.pick} · {Math.round(reinforcer.prob)}%</span>
                </div>
              )}
            </div>
          );
        })()}

        {/* The Edge */}
        {f.theEdge && (() => {
          const e = f.theEdge;
          const ec = C.edge || C.accent;
          return (
            <div style={{ background:`${ec}0e`, border:`1px solid ${ec}28`, borderRadius:C.cardRadius||16, padding:"12px 14px" }}>
              <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:8 }}>
                <div style={{ display:"flex", alignItems:"center", gap:6 }}>
                  <span style={{ fontSize:9, fontWeight:800, color:ec, letterSpacing:".1em", textTransform:"uppercase" }}>The Edge</span>
                  <span style={{ fontSize:8, fontWeight:600, color:ec, opacity:.55 }}>best odds value</span>
                  {e.edgeOddsPct && <Chip color={C.green}>+{e.edgeOddsPct}% vs book</Chip>}
                  <Chip color={ec}>{e.convergenceCount} sig</Chip>
                </div>
                {e.odds && <span style={{ fontSize:10, color:C.muted }}>{e.odds}x</span>}
              </div>
              <div style={{ fontSize:15, fontWeight:800, color:ec, marginBottom:5 }}>{e.pick}</div>
              {e.narrative && <div style={{ fontSize:9, color:C.muted, fontStyle:"italic", marginBottom:6, lineHeight:1.5 }}>{e.narrative}</div>}
              <div style={{ display:"flex", alignItems:"center", gap:10 }}>
                <span style={{ fontSize:14, fontWeight:900, color:ec }}>{Math.round(e.prob)}%</span>
                <Bar value={e.prob} color={ec} C={C} />
              </div>
            </div>
          );
        })()}

        {/* Goal Radar */}
        {f.goalRadar && (f.goalRadar.home || f.goalRadar.away) && (
          <div style={{ background:`${C.radar||C.blue}0e`, border:`1px solid ${C.radar||C.blue}28`, borderRadius:C.cardRadius||16, padding:"12px 14px" }}>
            <div style={{ fontSize:9, fontWeight:800, color:C.radar||C.blue, letterSpacing:".1em", textTransform:"uppercase", marginBottom:10 }}>Goal Radar</div>
            <div style={{ display:"flex", gap:10, flexWrap:"wrap" }}>
              {[f.goalRadar.home, f.goalRadar.away].filter(Boolean).map((entry, i) => (
                <div key={i} style={{ flex:1, minWidth:120, background:`${C.radar||C.blue}10`, borderRadius:12, padding:"9px 11px", border:`1px solid ${C.radar||C.blue}22` }}>
                  <div style={{ fontSize:10, fontWeight:700, color:C.text, marginBottom:4 }}>{entry.pick}</div>
                  <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center" }}>
                    <span style={{ fontSize:15, fontWeight:800, color:C.radar||C.blue }}>{Math.round(entry.prob)}%</span>
                    {entry.odds && <span style={{ fontSize:9, color:C.muted }}>{entry.odds}x</span>}
                  </div>
                  <Bar value={entry.prob} color={C.radar||C.blue} height={3} C={C} />
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Stats grid */}
        <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:10 }}>
          <Panel label="Match Result" color={C.blue||C.accent} bg={`${C.blue||C.accent}0a`}>
            {[
              { l:"H", prob:m.homeWin, odds:f.odds?.o1 },
              { l:"X", prob:m.draw,    odds:f.odds?.oX },
              { l:"A", prob:m.awayWin, odds:f.odds?.o2 },
            ].map(r => <ProbRow key={r.l} label={r.l} prob={r.prob} odds={r.odds} color={C.blue||C.accent} />)}
          </Panel>
          <Panel label="Goal Range" color={C.amber} bg={`${C.amber}0a`}>
            {f.goalRange && <div style={{ fontSize:12, fontWeight:800, color:C.amber, marginBottom:6 }}>{f.goalRange}</div>}
            {[
              { l:"O1.5", prob:m.over15,  odds:f.odds?.over15odds  },
              { l:"O2.5", prob:m.over25,  odds:f.odds?.over25odds  },
              { l:"O3.5", prob:m.over35,  odds:f.odds?.over35odds  },
              { l:"U2.5", prob:m.under25, odds:f.odds?.under25odds },
            ].map(r => <ProbRow key={r.l} label={r.l} prob={r.prob} odds={r.odds} color={C.amber} />)}
            {m.likelyScore && (
              <div style={{ fontSize:9, color:C.muted, marginTop:5 }}>
                Likely: <span style={{ color:C.text, fontWeight:700 }}>{m.likelyScore}</span>
                {m.likelyScoreProb && <span style={{ opacity:.7 }}> ({m.likelyScoreProb}%)</span>}
              </div>
            )}
          </Panel>
          <Panel label="BTTS" color={C.purple||C.accent} bg={`${C.purple||C.accent}0a`}>
            <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:8 }}>
              <div>
                <div style={{ fontSize:9, color:C.muted, marginBottom:2 }}>Yes</div>
                <div style={{ fontSize:22, fontWeight:800, color:(m.bttsYes||0)>=60?(C.purple||C.accent):C.muted }}>
                  {Math.round(m.bttsYes||0)}%
                </div>
              </div>
              <div style={{ textAlign:"right" }}>
                <div style={{ fontSize:9, color:C.muted, marginBottom:2 }}>No</div>
                <div style={{ fontSize:14, fontWeight:700, color:C.text }}>{Math.round(m.bttsNo||0)}%</div>
                {f.odds?.bttsYesOdds && <div style={{ fontSize:9, color:C.muted, marginTop:2 }}>{f.odds.bttsYesOdds}x</div>}
              </div>
            </div>
            <Bar value={m.bttsYes} color={C.purple||C.accent} height={4} C={C} />
          </Panel>
          <Panel label="Team Total" color={C.radar||C.blue||C.accent} bg={`${C.radar||C.blue}0a`}>
            {[
              { name:f.teams?.home, o05:m.homeOver05, o15:m.homeOver15, cs:m.homeCS },
              { name:f.teams?.away, o05:m.awayOver05, o15:m.awayOver15, cs:m.awayCS },
            ].map(t => (
              <div key={t.name} style={{ marginBottom:9 }}>
                <div style={{ fontSize:10, fontWeight:700, color:C.radar||C.accent, marginBottom:4 }}>
                  {(t.name||"").split(" ").slice(0,2).join(" ")}
                </div>
                <div style={{ display:"flex", gap:8, flexWrap:"wrap" }}>
                  <span style={{ fontSize:10, color:C.text }}>O0.5 <span style={{ fontWeight:700, color:(t.o05||0)>=90?(C.radar||C.green):C.muted }}>{Math.round(t.o05||0)}%</span></span>
                  <span style={{ fontSize:10, color:C.text }}>O1.5 <span style={{ fontWeight:700, color:(t.o15||0)>=65?(C.radar||C.green):C.muted }}>{Math.round(t.o15||0)}%</span></span>
                  <span style={{ fontSize:10, fontWeight:700, color:(t.cs||0)>=30?C.green:C.muted }}>CS {Math.round(t.cs||0)}%</span>
                </div>
              </div>
            ))}
          </Panel>
        </div>

        {/* Bottom back */}
        <button onClick={onClose} style={{
          background:"transparent", border:`1px solid ${C.border}`,
          borderRadius:C.btnRadius||10, padding:"12px 0", width:"100%",
          fontSize:11, fontWeight:700, color:C.muted,
          cursor:"pointer", fontFamily:C.font,
          display:"flex", alignItems:"center", justifyContent:"center", gap:6,
        }}>
          {Icons.back} Back to Analysis
        </button>
        <div style={{ height:20 }}/>
      </div>
    </div>
  );
}
function LegCard({ leg, idx, C, onOpenFullModel }) {
  const f        = leg.fixture;
  const color    = alignColor(leg.modelProb, C);
  const league   = leg.league || f?.league || null;
  const impliedP = impliedPct(leg.odds);

  const readPick       = f?.theRead?.anchor?.pick;
  const readProb       = f?.theRead?.anchor?.prob;
  const readStrong     = f?.theRead?.anchor?.strong;
  const userMatchesRead = readPick &&
    readPick.toLowerCase().trim() === (leg.pick || "").toLowerCase().trim();

  const hasFullModel = !!f;

  return (
    <div style={{
      background: C.cardBg,
      border: `1px solid ${leg.modelProb != null ? color + "28" : C.border}`,
      borderRadius: 18,
      marginBottom: 10,
      overflow: "hidden",
      boxShadow: "0 4px 16px rgba(0,0,0,0.13)",
      backdropFilter: "blur(10px)",
    }}>
      {/* Header */}
      <div style={{ padding: "11px 14px 10px", borderBottom: `1px solid ${C.border}` }}>
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 8 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 9, color: C.muted, fontFamily: C.font, letterSpacing: ".07em", marginBottom: 3 }}>
              LEG {idx + 1}
              {league ? ` · ${league}` : ""}
              {leg.country && leg.country !== league ? ` · ${leg.country}` : ""}
            </div>
            <div style={{ fontSize: 13, fontWeight: 800, color: C.text, fontFamily: C.font, lineHeight: 1.25 }}>
              {leg.home} <span style={{ color: C.muted, fontWeight: 400, fontSize: 10 }}>vs</span> {leg.away}
            </div>
            {leg.date && (
              <div style={{ fontSize: 9, color: C.muted, fontFamily: C.font, marginTop: 3 }}>
                {leg.date}{leg.time ? ` · ${leg.time}` : ""}
              </div>
            )}
          </div>

          {/* Alignment badge — now shows label too */}
          <div style={{
            flexShrink: 0,
            background: `${color}14`,
            border: `1px solid ${color}30`,
            borderRadius: 999,
            padding: "4px 10px",
            display: "flex", alignItems: "center", gap: 5,
          }}>
            <span style={{ fontSize: 10, color, fontWeight: 900 }}>
              {leg.modelProb == null ? "—" : leg.modelProb >= 65 ? "✓" : leg.modelProb >= 50 ? "~" : leg.modelProb >= 35 ? "!" : "✕"}
            </span>
            <span style={{ fontSize: 9, color, fontWeight: 800, fontFamily: C.font, letterSpacing: ".04em" }}>
              {leg.modelProb != null ? `${leg.modelProb}%` : "—"}
            </span>
          </div>
        </div>
      </div>

      {/* Body */}
      <div style={{ padding: "10px 14px 12px" }}>

        {/* Align label row */}
        {leg.modelProb != null && (
          <div style={{ marginBottom: 6 }}>
            <span style={{ fontSize: 8, fontWeight: 800, color, letterSpacing: ".08em", textTransform: "uppercase" }}>
              {alignLabel(leg.modelProb)}
            </span>
          </div>
        )}

        {/* User pick row */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, marginBottom: 2 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0, flex: 1 }}>
            <span style={{
              fontSize: 9, fontWeight: 800,
              background: C.accentDim, border: `1px solid ${C.accentBorder}`,
              color: C.accent, borderRadius: 999, padding: "2px 8px",
              fontFamily: C.font, letterSpacing: ".04em", flexShrink: 0,
            }}>
              {marketShort(leg.market)}
            </span>
            <span style={{ fontSize: 12, fontWeight: 700, color: C.text, fontFamily: C.font, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {leg.pick}
            </span>
          </div>
          <span style={{ fontSize: 13, fontWeight: 900, color: C.text, fontFamily: C.font, flexShrink: 0 }}>
            ×{leg.odds}
          </span>
        </div>

        {/* Prob bar */}
        <ProbBar modelProb={leg.modelProb} impliedP={impliedP} C={C} />

        {/* Model read or no-snapshot state */}
        {f ? (
          <div style={{ marginTop: 10 }}>
            {userMatchesRead ? (
              <div style={{
                display: "flex", alignItems: "center", gap: 6,
                fontSize: 9, color: C.green, fontWeight: 800,
                letterSpacing: ".04em", fontFamily: C.font,
              }}>
                <span style={{ color: C.green }}>{Icons.check}</span>
                Your pick matches the model's top read
              </div>
            ) : readPick ? (
              <div style={{
                display: "grid", gridTemplateColumns: "1fr auto 1fr",
                gap: 8, alignItems: "center",
                background: C.surface, borderRadius: 10,
                padding: "8px 10px", border: `1px solid ${C.border}`,
              }}>
                <div>
                  <div style={{ fontSize: 7, color: C.muted, letterSpacing: ".08em", textTransform: "uppercase", marginBottom: 3 }}>Your Pick</div>
                  <div style={{ fontSize: 10, fontWeight: 700, color: C.text }}>{leg.pick}</div>
                  {impliedP != null && <div style={{ fontSize: 8, color: C.muted, marginTop: 1 }}>{impliedP}% implied</div>}
                </div>
                <div style={{ color: C.muted, fontSize: 12 }}>→</div>
                <div>
                  <div style={{ fontSize: 7, color: C.muted, letterSpacing: ".08em", textTransform: "uppercase", marginBottom: 3 }}>Model's Read</div>
                  <div style={{ fontSize: 10, fontWeight: 700, color: readStrong ? C.green : C.text }}>
                    {readPick}
                  </div>
                  {readProb != null && (
                    <div style={{ fontSize: 8, color: readStrong ? C.green : C.muted, marginTop: 1, fontWeight: 700 }}>
                      {readProb}%{readStrong ? " · Strong" : ""}
                    </div>
                  )}
                </div>
              </div>
            ) : (
              <div style={{ fontSize: 9, color: C.muted, fontStyle: "italic", fontFamily: C.font }}>
                No model read for this fixture
              </div>
            )}
          </div>
        ) : (
          /* No snapshot */
          <div style={{
            marginTop: 10, padding: "10px 12px",
            background: C.surface, border: `1px solid ${C.border}`,
            borderRadius: 12, fontFamily: C.font,
          }}>
            <div style={{ fontSize: 10, fontWeight: 700, color: C.text, marginBottom: 3 }}>
              No model data for this game
            </div>
            <div style={{ fontSize: 9, color: C.muted, lineHeight: 1.5 }}>
              Fetch{" "}
              <span style={{ color: C.accent, fontWeight: 700 }}>{leg.date}</span>
              {" "}in Live Model to enable analysis for this leg
            </div>
          </div>
        )}

        {/* Full Model + Draft buttons */}
        <div style={{ display: "flex", gap: 6, marginTop: 10, flexWrap: "wrap" }}>
          {hasFullModel && onOpenFullModel && (
            <button
              onClick={() => onOpenFullModel(f)}
              style={{
                display: "flex", alignItems: "center", gap: 5,
                padding: "6px 12px",
                background: C.accentDim, border: `1px solid ${C.accentBorder}`,
                borderRadius: 999, fontSize: 9, fontWeight: 800,
                color: C.accent, cursor: "pointer", fontFamily: C.font,
                letterSpacing: ".06em", textTransform: "uppercase",
              }}
            >
              {Icons.expand} Full Model
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
//  REBUILD BOOKING
// ─────────────────────────────────────────────────────────────────────────────

function RebuildBooking({ legs, C, SERVER, onSendToDraft }) {
  const [bookmaker, setBookmaker] = useState("sb");
  const [booking, setBooking]     = useState(false);
  const [result, setResult]       = useState(null);
  const [error, setError]         = useState(null);
  const [copied, setCopied]       = useState(false);
  const [copiedLink, setCopiedLink] = useState(false);

  const book = async () => {
    if (!legs?.length) return;
    setBooking(true); setResult(null); setError(null);
    try {
      const endpoint = bookmaker === "sb" ? "/api/book-sportybet" : "/api/book-luckyledger";
      const res  = await fetch(`${SERVER}${endpoint}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ legs }),
      });
      const data = await res.json();
      if (!res.ok || data.error) throw new Error(data.error || "Booking failed");
      setResult(data);
    } catch (e) {
      const msg = e.message || "";
      if (msg.includes("Failed to fetch") || msg.includes("NetworkError") || msg.includes("net::ERR")) {
        setError("Cannot reach bookmaker — check your connection and try again.");
      } else if (msg.includes("429") || msg.includes("already in progress")) {
        setError("A booking is already running. Please wait a moment.");
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
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      });
    }
  };

  const copyLink = () => {
    if (!result?.code) return;
    const link = BOOKIE_LINKS[bookmaker]?.shareLink(result.code) || result.code;
    copyToClipboard(link, () => {
      setCopiedLink(true);
      setTimeout(() => setCopiedLink(false), 2000);
    });
  };

  // N2-FIX: use appLink (deep-link scheme) not shareLink (web URL).
  // Fire via hidden <a> click — avoids Android "which app?" chooser dialog.
  const openInApp = () => {
    if (!result?.code) return;
    const deepLink = BOOKIE_LINKS[bookmaker]?.appLink?.(result.code);
    if (!deepLink) return;
    try {
      const a = document.createElement("a");
      a.href = deepLink;
      a.style.display = "none";
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
    } catch {
      // Scheme not supported — fail silently
    }
  };

  const cr = C.cardRadius || 16;
  const br = C.btnRadius  || 12;

  return (
    <div>
      {/* Bookmaker selector */}
      <div style={{ display:"flex", gap:6, marginBottom:12,
                    background:C.surface, borderRadius:br+4, padding:4,
                    border:`1px solid ${C.border}` }}>
        {BOOKMAKERS.map(bm => (
          <button key={bm.id} onClick={() => { setBookmaker(bm.id); setResult(null); setError(null); }} style={{
            flex:1, padding:"8px 0", borderRadius:br, border:"none",
            background: bookmaker===bm.id ? C.accent : "transparent",
            color: bookmaker===bm.id ? C.accentText : C.muted,
            fontSize:10, fontWeight:800, cursor:"pointer", fontFamily:C.font,
            letterSpacing:".06em", transition:"all .15s",
          }}>
            {bm.label}
          </button>
        ))}
      </div>

      {/* Send to Draft */}
      {onSendToDraft && legs.length > 0 && (
        <button onClick={() => onSendToDraft(legs)} style={{
          width:"100%", padding:"10px 0", marginBottom:10,
          background:"transparent", border:`1px solid ${C.border}`,
          borderRadius:br, fontSize:10, fontWeight:700, color:C.muted,
          cursor:"pointer", fontFamily:C.font, letterSpacing:".04em",
          textTransform:"uppercase", display:"flex", alignItems:"center",
          justifyContent:"center", gap:7,
        }}>
          {Icons.transfer} Edit in Parlay System
        </button>
      )}

      {error && (
        <div style={{ padding:"10px 12px", marginBottom:10,
                      background:`${C.red}12`, border:`1px solid ${C.red}35`,
                      borderRadius:cr, color:C.red, fontSize:10,
                      fontFamily:C.font, lineHeight:1.5 }}>
          {error}
        </div>
      )}

      {!result && (
        <button onClick={book} disabled={booking} style={{
          width:"100%", padding:"13px 0",
          background: booking ? C.surface : C.accent,
          border:`1px solid ${booking ? C.border : C.accentBorder}`,
          borderRadius:br, fontSize:11, fontWeight:900,
          color: booking ? C.muted : C.accentText,
          cursor: booking ? "not-allowed" : "pointer",
          fontFamily:C.font, letterSpacing:".08em", textTransform:"uppercase",
        }}>
          {booking ? "Generating…" : "Generate Booking Code"}
        </button>
      )}

      {result && (
        <div style={{ marginTop:4 }}>
          <div style={{ fontSize:9, color:C.green, fontWeight:800, letterSpacing:".1em", textTransform:"uppercase", marginBottom:10 }}>
            {result.resolved}/{result.total} leg{result.total!==1?"s":""} booked
          </div>

          {/* Code display */}
          <div style={{ background:C.surface, border:`1px solid ${C.green}35`,
                        borderRadius:cr, padding:"12px 14px", marginBottom:8,
                        fontFamily:C.font, fontSize:22, fontWeight:800,
                        color:C.green, letterSpacing:".2em", textAlign:"center" }}>
            {result.code}
          </div>

          {/* Action row — copy code, copy link, open */}
          <div style={{ display:"flex", gap:6, marginBottom:10 }}>
            <button onClick={copyCode} style={{
              flex:1, padding:"9px 0",
              background: copied ? C.green : "transparent",
              color: copied ? C.accentText : C.green,
              border:`1px solid ${C.green}45`,
              borderRadius:br, fontSize:9, fontWeight:700,
              cursor:"pointer", fontFamily:C.font,
              display:"flex", alignItems:"center", justifyContent:"center", gap:5,
            }}>
              {Icons.copy} {copied ? "Copied!" : "Copy Code"}
            </button>
            <button onClick={copyLink} style={{
              flex:1, padding:"9px 0",
              background: copiedLink ? `${C.blue}18` : "transparent",
              color: copiedLink ? C.blue : C.muted,
              border:`1px solid ${C.border}`,
              borderRadius:br, fontSize:9, fontWeight:700,
              cursor:"pointer", fontFamily:C.font,
              display:"flex", alignItems:"center", justifyContent:"center", gap:5,
            }}>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/>
                <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>
              </svg>
              {copiedLink ? "Copied!" : "Copy Link"}
            </button>
            <button onClick={openInApp} style={{
              padding:"9px 14px",
              background:"transparent",
              color:C.accent,
              border:`1px solid ${C.accentBorder}`,
              borderRadius:br, fontSize:9, fontWeight:700,
              cursor:"pointer", fontFamily:C.font,
              display:"flex", alignItems:"center", gap:5,
            }}>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>
                <polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/>
              </svg>
              Open
            </button>
          </div>

          {result.failed?.length > 0 && (
            <div style={{ background:`${C.amber}0e`, border:`1px solid ${C.amber}30`,
                          borderRadius:cr, padding:"10px 12px" }}>
              <div style={{ fontSize:9, color:C.amber, fontWeight:800, marginBottom:8 }}>
                {result.failed.length} leg{result.failed.length!==1?"s":""} could not be booked
              </div>
              {result.failed.map((fail, i) => {
                const isObj  = fail && typeof fail === "object";
                const label  = isObj ? fail.label : fail;
                const reason = isObj
                  ? fail.failReason === "tt_unavailable"
                    ? "Team Total not available — try Over 2.5 or BTTS."
                    : "Match not found on bookmaker."
                  : "Could not be resolved.";
                return (
                  <div key={i} style={{ marginBottom:i<result.failed.length-1?6:0 }}>
                    <div style={{ fontSize:9, color:C.text, fontWeight:700 }}>{label}</div>
                    <div style={{ fontSize:8, color:C.muted, marginTop:1 }}>{reason}</div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
// ─────────────────────────────────────────────────────────────────────────────
//  REBUILD TAB CONTENT
// ─────────────────────────────────────────────────────────────────────────────

function RebuildTab({ result, C, SERVER, onSendToDraft }) {
  const legs = result?.legs || [];

  const initSelections = () => {
    const s = {};
    legs.forEach((leg, i) => {
      const readPick = leg.fixture?.theRead?.anchor?.pick;
      const matches  = readPick && readPick.toLowerCase().trim() === (leg.pick || "").toLowerCase().trim();
      s[i] = (!leg.fixture || matches) ? "user" : "model";
    });
    return s;
  };

  const [selections, setSelections] = useState(initSelections);

  useEffect(() => { setSelections(initSelections()); }, [result]);

  const toggle = (i, val) => setSelections(prev => ({ ...prev, [i]: val }));

  const builtLegs = legs.map((leg, i) => {
    const sel      = selections[i];
    const anchor   = leg.fixture?.theRead?.anchor;
    const useModel = sel === "model" && anchor && leg.fixture;
    // A1-FIX: implied odds helper for when real odds not present
    const io = p => (p > 0 && p < 100) ? parseFloat((1 / (p / 100)).toFixed(2)) : null;

    return {
      home:          leg.home,
      away:          leg.away,
      // game field required — App.jsx draft mapper uses l.game not `${l.home} vs ${l.away}`
      game:          `${leg.home} vs ${leg.away}`,
      market:        useModel ? (anchor.market || leg.market) : leg.market,
      pick:          useModel ? anchor.pick : leg.pick,
      league:        leg.league,
      // fixtureId required — without it draft shows "? vs ?" and leg can't be matched
      fixtureId:     leg.fixture?.id || null,
      // odds required — without it draft shows ×1.00 on every leg
      odds:          useModel
        ? (anchor.odds || io(anchor.prob))
        : (parseFloat(leg.odds) > 1 ? parseFloat(leg.odds) : io(leg.modelProb) || null),
      // conf required — without it draft shows (0%) model confidence
      conf:          useModel ? anchor.prob : (leg.modelProb || null),
      empiricalRate: useModel ? anchor.empiricalRate : null,
    };
  });

  const estOdds = legs.reduce((acc, leg, i) => {
    const sel    = selections[i];
    const anchor = leg.fixture?.theRead?.anchor;
    const useModel = sel === "model" && anchor;
    const io = p => (p > 0 && p < 100) ? parseFloat((1 / (p / 100)).toFixed(2)) : 1;
    const o  = useModel ? (anchor.odds || io(anchor.prob)) : parseFloat(leg.odds || 1);
    return acc * (o || 1);
  }, 1).toFixed(2);

  const hasAnyModel = legs.some((leg, i) => selections[i] === "model" && leg.fixture?.theRead?.anchor);

  return (
    <div style={{ padding: "12px 16px 80px" }}>

      {/* Header */}
      <div style={{ marginBottom: 16 }}>
        <div style={{ fontSize: 12, fontWeight: 900, color: C.text, fontFamily: C.font, marginBottom: 3 }}>
          Model Rebuild
        </div>
        <div style={{ fontSize: 10, color: C.muted, fontFamily: C.font, lineHeight: 1.5 }}>
          Select which pick to use for each leg. Model picks are pre-selected where the model disagrees.
        </div>
      </div>

      {/* Per-leg rows */}
      {legs.map((leg, i) => {
        const anchor       = leg.fixture?.theRead?.anchor;
        const readPick     = anchor?.pick;
        const readProb     = anchor?.prob;
        const hasModel     = !!anchor && !!leg.fixture;
        const matchesPick  = hasModel && readPick?.toLowerCase().trim() === (leg.pick || "").toLowerCase().trim();
        const sel          = selections[i];

        return (
          <div key={i} style={{
            background: C.cardBg, border: `1px solid ${C.border}`,
            borderRadius: 16, marginBottom: 10, padding: "12px 14px",
            boxShadow: "0 3px 12px rgba(0,0,0,0.10)",
          }}>
            <div style={{ fontSize: 9, color: C.muted, fontFamily: C.font, letterSpacing: ".07em", marginBottom: 4 }}>
              LEG {i + 1} · {leg.home} vs {leg.away}
            </div>

            {matchesPick ? (
              <div style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 9, color: C.green, fontWeight: 700, fontFamily: C.font }}>
                {Icons.check} Matches model's top pick · keeping as-is
              </div>
            ) : !hasModel ? (
              <div>
                <div style={{ fontSize: 10, fontWeight: 700, color: C.text, fontFamily: C.font }}>{leg.pick}</div>
                <div style={{ fontSize: 8, color: C.muted, marginTop: 3, fontFamily: C.font }}>
                  Using your original pick · no model data for this game
                </div>
              </div>
            ) : (
              <div>
                {/* Segmented toggle */}
                <div style={{
                  display: "flex", background: C.surface,
                  borderRadius: 999, padding: 3,
                  border: `1px solid ${C.border}`, marginBottom: 10,
                }}>
                  {[
                    { val: "user",  label: "Your Pick",  detail: leg.pick },
                    { val: "model", label: "Model Pick", detail: readPick },
                  ].map(opt => (
                    <button key={opt.val} onClick={() => toggle(i, opt.val)} style={{
                      flex: 1, padding: "7px 8px", borderRadius: 999, border: "none",
                      background: sel === opt.val ? C.accent : "transparent",
                      color: sel === opt.val ? C.accentText : C.muted,
                      fontSize: 9, fontWeight: 800, cursor: "pointer",
                      fontFamily: C.font, letterSpacing: ".04em", transition: "all .15s",
                      textAlign: "center",
                    }}>
                      <div>{opt.label}</div>
                      <div style={{
                        fontSize: 8, fontWeight: 600,
                        color: sel === opt.val ? C.accentText : C.muted,
                        opacity: .8, marginTop: 1,
                        overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                      }}>
                        {opt.detail}
                      </div>
                    </button>
                  ))}
                </div>

                {/* Odds/prob display */}
                <div style={{ display: "flex", justifyContent: "space-between" }}>
                  <span style={{ fontSize: 9, color: C.muted, fontFamily: C.font }}>
                    {sel === "user"
                      ? `Odds ×${leg.odds}`
                      : readProb
                        ? `Model: ${readProb}% · est. ×${anchor.odds || (readProb > 0 ? (1 / (readProb / 100)).toFixed(2) : "—")}`
                        : "Model pick"}
                  </span>
                  {sel === "model" && anchor.odds && (
                    <span style={{ fontSize: 8, color: C.muted, fontStyle: "italic", fontFamily: C.font }}>
                      estimated
                    </span>
                  )}
                </div>
              </div>
            )}
          </div>
        );
      })}

      {/* Ticket summary */}
      <div style={{
        background: C.surface, border: `1px solid ${C.border}`,
        borderRadius: 14, padding: "12px 14px", marginBottom: 14,
      }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div>
            <div style={{ fontSize: 10, fontWeight: 700, color: C.text, fontFamily: C.font }}>{legs.length} legs</div>
            {hasAnyModel && (
              <div style={{ fontSize: 8, color: C.muted, marginTop: 2, fontFamily: C.font }}>
                Odds estimated where model picks are applied
              </div>
            )}
          </div>
          <div style={{ textAlign: "right" }}>
            <div style={{ fontSize: 8, color: C.muted, fontFamily: C.font, letterSpacing: ".08em", textTransform: "uppercase" }}>
              Est. Total Odds
            </div>
            <div style={{ fontSize: 20, fontWeight: 900, color: C.text, fontFamily: C.font }}>×{estOdds}</div>
          </div>
        </div>
      </div>

      {/* Booking */}
      <RebuildBooking legs={builtLegs} C={C} SERVER={SERVER} onSendToDraft={onSendToDraft} />
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
//  HISTORY TAB
// ─────────────────────────────────────────────────────────────────────────────

function HistoryTab({ C, onReanalyze }) {
  const [entries, setEntries] = useState(historyLoad);
  const [deletingKey, setDeletingKey] = useState(null);

  const handleDelete = (platform, code) => {
    historyDelete(platform, code);
    setEntries(historyLoad());
    setDeletingKey(null);
  };

  if (!entries.length) {
    return (
      <div style={{ padding: "60px 24px", textAlign: "center", fontFamily: C.font }}>
        <div style={{ fontSize: 12, fontWeight: 700, color: C.muted, marginBottom: 8 }}>No saved analyses</div>
        <div style={{ fontSize: 10, color: C.muted, lineHeight: 1.6 }}>
          Analyses are saved here automatically. Paste a code and run the analyzer to get started.
        </div>
      </div>
    );
  }

  return (
    <div style={{ padding: "12px 16px 80px", fontFamily: C.font }}>
      <div style={{ fontSize: 10, color: C.muted, marginBottom: 14, lineHeight: 1.5 }}>
        {entries.length} saved · tap a code to re-analyze
      </div>

      {entries.map((h, i) => (
        <div key={`${h.platform}-${h.code}`} style={{
          background: C.cardBg, border: `1px solid ${C.border}`,
          borderRadius: 16, marginBottom: 8, padding: "12px 14px",
          boxShadow: "0 3px 12px rgba(0,0,0,0.10)",
        }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4 }}>
                <span style={{
                  fontSize: 8, fontWeight: 800,
                  background: C.accentDim, border: `1px solid ${C.accentBorder}`,
                  color: C.accent, borderRadius: 999, padding: "2px 7px",
                  letterSpacing: ".06em", textTransform: "uppercase",
                }}>
                  {(h.platform || "").toUpperCase()}
                </span>
                <span style={{ fontSize: 13, fontWeight: 900, color: C.text, letterSpacing: ".1em" }}>
                  {h.code}
                </span>
              </div>
              <div style={{ fontSize: 9, color: C.muted }}>
                {h.legs?.length || "?"} legs · ×{h.totalOdds}
                {h.parlayProb != null && (
                  <span style={{ marginLeft: 6 }}>· parlay {h.parlayProb}%</span>
                )}
              </div>
              {h.savedAt && (
                <div style={{ fontSize: 8, color: C.muted, opacity: .6, marginTop: 2 }}>
                  {new Date(h.savedAt).toLocaleDateString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
                </div>
              )}
            </div>

            {/* Actions */}
            <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
              <button onClick={() => onReanalyze(h.platform, h.code)} style={{
                display: "flex", alignItems: "center", gap: 4,
                padding: "6px 10px", borderRadius: 999,
                background: C.accentDim, border: `1px solid ${C.accentBorder}`,
                color: C.accent, fontSize: 9, fontWeight: 700,
                cursor: "pointer", fontFamily: C.font,
              }}>
                {Icons.reanalyze} Analyze
              </button>
              <button
                onClick={() => deletingKey === h.code ? handleDelete(h.platform, h.code) : setDeletingKey(h.code)}
                style={{
                  display: "flex", alignItems: "center", gap: 4,
                  padding: "6px 10px", borderRadius: 999,
                  background: deletingKey === h.code ? C.red : "transparent",
                  border: `1px solid ${deletingKey === h.code ? C.red : C.border}`,
                  color: deletingKey === h.code ? "#fff" : C.muted,
                  fontSize: 9, fontWeight: 700, cursor: "pointer", fontFamily: C.font,
                }}
              >
                {deletingKey === h.code ? "Confirm" : Icons.trash}
              </button>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
//  MAIN COMPONENT
// ─────────────────────────────────────────────────────────────────────────────

export default function CodeAnalyzer({ theme: C, SERVER, onSendToDraft, onOpenFullModel, initialCode = null, initialPlatform = null, autoAnalyze = false, onPayloadConsumed }) {
  const [subTab, setSubTab]         = useState("analyzer");
  const [platform, setPlatform]     = useState(initialPlatform ? initialPlatform.toLowerCase() : "sb");
  const [rawInput, setRawInput]     = useState(initialCode || "");
  const [stepsDone, setStepsDone]   = useState(0);
  const [activeStep, setActiveStep] = useState(0);
  const CA_RESULT_KEY  = "grm_ca_last_result_v1";
  const CA_JARVIS_KEY  = "grm_ca_last_jarvis_v1";

  const [result, setResult] = useState(() => {
    try {
      const saved = localStorage.getItem(CA_RESULT_KEY);
      return saved ? JSON.parse(saved) : null;
    } catch { return null; }
  });
  const persistResult = (r) => {
    setResult(r);
    try {
      if (r) localStorage.setItem(CA_RESULT_KEY, JSON.stringify(r));
      else localStorage.removeItem(CA_RESULT_KEY);
    } catch {}
  };

  const [jarvis, setJarvisState] = useState(() => {
    try { return localStorage.getItem(CA_JARVIS_KEY) || null; } catch { return null; }
  });
  const setJarvis = (text) => {
    setJarvisState(text);
    try {
      if (text) localStorage.setItem(CA_JARVIS_KEY, text);
      else localStorage.removeItem(CA_JARVIS_KEY);
    } catch {}
  };

  // Sync phase on mount — if we have a persisted result, go straight to "done"
  const [phase, setPhase] = useState(() => {
    try {
      const saved = localStorage.getItem(CA_RESULT_KEY);
      return saved ? "done" : "idle";
    } catch { return "idle"; }
  });
  const [error, setError]           = useState("");
  const [infoOpen, setInfoOpen]     = useState(false);
  const [jarvisCopied, setJarvisCopied] = useState(false);
  const [showCancel, setShowCancel] = useState(false);
  const abortRef = useRef(null);

  // Show cancel button 4s after loading starts
  useEffect(() => {
    if (phase === "loading") {
      setShowCancel(false);
      const t = setTimeout(() => setShowCancel(true), 4000);
      return () => clearTimeout(t);
    }
  }, [phase]);

  // Clear error when platform changes
  useEffect(() => { if (phase === "error") setPhase("idle"); }, [platform]);

  // CL1: Auto-trigger analysis when Jarvis navigates here with a code payload
  const autoAnalyzeRef = useRef(false);
  useEffect(() => {
    if (autoAnalyze && initialCode && !autoAnalyzeRef.current) {
      autoAnalyzeRef.current = true;
      onPayloadConsumed?.();
      // Small delay so component fully mounts before firing
      const t = setTimeout(() => analyze(initialPlatform?.toLowerCase() || null, initialCode), 300);
      return () => clearTimeout(t);
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const analyze = useCallback(async (overridePlatform, overrideCode) => {
    const parsed = parseInput(overrideCode || rawInput);
    if (!parsed?.code) return;

    const finalCode     = parsed.code;
    const finalPlatform = overridePlatform || parsed.detectedPlatform || platform;

    // If link detected a platform, auto-switch
    if (parsed.detectedPlatform && parsed.detectedPlatform !== platform) {
      setPlatform(parsed.detectedPlatform);
    }

    // Update rawInput to show the clean code
    setRawInput(finalCode);

    const controller = new AbortController();
    abortRef.current = controller;

    setPhase("loading");
    setError("");
    persistResult(null);
    setJarvis(null);
    setStepsDone(0);
    setActiveStep(0);
    setSubTab("analyzer");

    // Helper: compose user-cancel signal with a hard timeout signal.
    // AbortSignal.any() isn't universally supported — manual race pattern mirrors Step 3 (Jarvis).
    const withStepTimeout = (ms) => {
      const tc = new AbortController();
      const tid = setTimeout(() => tc.abort(), ms);
      const onUserAbort = () => tc.abort();
      controller.signal.addEventListener("abort", onUserAbort);
      return {
        signal: tc.signal,
        cleanup: () => { clearTimeout(tid); controller.signal.removeEventListener("abort", onUserAbort); },
      };
    };

    try {
      // Step 1 — Fetch slip (25s hard timeout; server has 14-16s internally)
      const s1 = withStepTimeout(25000);
      let r1, d1;
      try {
        r1 = await fetch(
          `${SERVER}/api/code-analyzer/fetch?platform=${finalPlatform}&code=${encodeURIComponent(finalCode)}`,
          { signal: s1.signal }
        );
        d1 = await r1.json();
      } finally { s1.cleanup(); }
      if (!r1.ok) throw new Error(d1.error || "Could not fetch slip");
      setStepsDone(1); setActiveStep(1);

      // Step 2 — Match (20s hard timeout; this is a synchronous server op, should be fast)
      const s2 = withStepTimeout(20000);
      let r2, d2;
      try {
        r2 = await fetch(`${SERVER}/api/code-analyzer/analyze`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ legs: d1.legs }),
          signal: s2.signal,
        });
        d2 = await r2.json();
      } finally { s2.cleanup(); }
      if (!r2.ok) throw new Error(d2.error || "Analysis failed");
      if (!Array.isArray(d2.analyzed) || !d2.analyzed.length)
        throw new Error("No matching fixtures found for this slip");
      setStepsDone(2); setActiveStep(2);

      const parlayProb = calcParlayProb(d2.analyzed);
      const totalOdds  = d1.totalOdds
        || d2.analyzed.reduce((a, l) => a * parseFloat(l.odds || 1), 1).toFixed(2);

      // Step 3 — Jarvis (check cache first).
      // Non-fatal: if Jarvis times out or errors, we still show results.
      // 30s hard timeout guards against callGeminiWithSearch hanging on the server.
      const jarvisCacheKey = JARVIS_KEY(finalPlatform, finalCode);
      let jarvisText = null;
      try { jarvisText = localStorage.getItem(jarvisCacheKey); } catch {}

      if (jarvisText) {
        setStepsDone(3);
        setJarvis(jarvisText);
      } else {
        try {
          // Combine user cancel signal with a 30s hard timeout.
          // AbortSignal.any is not yet universally supported — use a manual race instead.
          const timeoutController = new AbortController();
          const timeoutId = setTimeout(() => timeoutController.abort(), 30_000);
          // If the user manually cancels (controller.signal), also abort the timeout fetch.
          const onUserAbort = () => timeoutController.abort();
          controller.signal.addEventListener("abort", onUserAbort);

          try {
            const r3 = await fetch(`${SERVER}/api/jarvis-code-analyze`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ legs: d2.analyzed, parlayProb, totalOdds, platform: finalPlatform, code: finalCode }),
              signal: timeoutController.signal,
            });
            if (r3.ok) {
              const d3 = await r3.json();
              jarvisText = (d3.analysis || "").trim() || null;
              if (jarvisText) {
                setJarvis(jarvisText);
                try { localStorage.setItem(jarvisCacheKey, jarvisText); } catch {}
              }
            }
          } finally {
            clearTimeout(timeoutId);
            controller.signal.removeEventListener("abort", onUserAbort);
          }
        } catch (jarvisErr) {
          // Re-throw only if user explicitly cancelled — timeout/network failures are non-fatal
          if (jarvisErr.name === "AbortError" && controller.signal.aborted) throw jarvisErr;
          // Otherwise: Jarvis unavailable, continue to show decode results
        }
        setStepsDone(3);
      }

      const res = { legs: d2.analyzed, parlayProb, totalOdds, platform: finalPlatform, code: finalCode };
      persistResult(res);
      setPhase("done");
      historySave({
        platform: finalPlatform,
        code: finalCode,
        legs: d2.analyzed.map(l => ({ home: l.home, away: l.away, pick: l.pick })),
        parlayProb,
        totalOdds,
        savedAt: new Date().toISOString(),
      });

    } catch (err) {
      // User explicitly cancelled — go back to idle silently
      if (err.name === "AbortError" && controller.signal.aborted) {
        setPhase("idle");
        return;
      }
      // Step timeout AbortError or any other error → show error state
      const msg = err.name === "AbortError"
        ? "Request timed out — check your connection and try again"
        : (err.message || "Something went wrong");
      setError(msg);
      setPhase("error");
    }
  }, [rawInput, platform]);

  const cancel = () => {
    abortRef.current?.abort();
    setPhase("idle");
  };

  const reset = () => {
    setPhase("idle");
    setRawInput("");
    persistResult(null);
    setJarvis(null);
    setError("");
    setSubTab("analyzer");
  };

  const copyJarvis = () => {
    if (!jarvis) return;
    copyToClipboard(jarvis, () => {
      setJarvisCopied(true);
      setTimeout(() => setJarvisCopied(false), 1800);
    });
  };

  // ── TOP PILL NAV ──────────────────────────────────────────────────────────
  const navTabs = [
    { id: "analyzer", label: "Analyzer" },
    { id: "rebuild",  label: "Rebuild",  locked: phase !== "done" },
    { id: "history",  label: "History" },
  ];

  const TopNav = () => (
    <div style={{
      position: "sticky", top: 0, zIndex: 20,
      background: C.headerBg, borderBottom: `1px solid ${C.headerBorder}`,
      backdropFilter: "blur(20px)",
      display: "flex",
    }}>
      {navTabs.map(tab => {
        const active = subTab === tab.id;
        const icons = {
          analyzer: <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>,
          rebuild:  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 2v6h-6"/><path d="M3 12a9 9 0 0 1 15-6.7L21 8"/><path d="M3 22v-6h6"/><path d="M21 12a9 9 0 0 1-15 6.7L3 16"/></svg>,
          history:  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>,
        };
        return (
          // P12-FIX: inactive tabs had border:none — looked like static text, not navigable.
          // Active = accent underbar. Inactive = outlined surface pill so all 3 tabs read as tappable.
          <button
            key={tab.id}
            onClick={() => !tab.locked && setSubTab(tab.id)}
            style={{
              flex: 1,
              padding: active ? "12px 8px" : "9px 6px",
              border: active ? "none" : `1px solid ${tab.locked ? "transparent" : C.border}`,
              borderBottom: active ? `2.5px solid ${C.accent}` : `1px solid ${tab.locked ? "transparent" : C.border}`,
              borderRadius: active ? 0 : 6,
              margin: active ? 0 : "5px 4px",
              background: active ? "transparent" : tab.locked ? "transparent" : C.surface,
              color: active ? C.accent : tab.locked ? C.muted : C.text,
              fontSize: 10, fontWeight: 800,
              cursor: tab.locked ? "not-allowed" : "pointer",
              fontFamily: C.font, letterSpacing: ".04em",
              opacity: tab.locked ? .4 : 1,
              transition: "all .18s",
              display: "flex", flexDirection: "column", alignItems: "center", gap: 4,
            }}
          >
            <span style={{ color: active ? C.accent : tab.locked ? C.muted : C.muted }}>{icons[tab.id]}</span>
            {tab.label}
            {tab.locked && <span style={{ fontSize:7, color:C.muted, fontWeight:500 }}>Run analyzer first</span>}
          </button>
        );
      })}
    </div>
  );

  // ── FULL MODEL OVERLAY ────────────────────────────────────────────────────
  // CA delegates to App's FullModelPage via onOpenFullModel prop.
  // The old FullModelOverlay (CA-internal) is kept in file for reference only —
  // it is never rendered from here; App mounts FullModelPage over the whole screen.

  // ── HISTORY TAB ───────────────────────────────────────────────────────────
  if (subTab === "history") {
    return (
      <div style={{ fontFamily: C.font }}>
        <TopNav />
      <HistoryTab C={C} onReanalyze={(plt, cd) => {
          setPlatform(plt);
          setRawInput(cd);
          setSubTab("analyzer");
          analyze(plt, cd);
        }} />
      </div>
    );
  }

  // ── REBUILD TAB ───────────────────────────────────────────────────────────
  if (subTab === "rebuild") {
    return (
      <div style={{ fontFamily: C.font }}>
        <TopNav />
        {result
          ? <RebuildTab result={result} C={C} SERVER={SERVER} onSendToDraft={onSendToDraft} />
          : (
            <div style={{ padding: "60px 24px", textAlign: "center", fontFamily: C.font }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: C.muted }}>Run an analysis first</div>
            </div>
          )
        }
      </div>
    );
  }

  // ── ANALYZER — LOADING ────────────────────────────────────────────────────
  if (phase === "loading") {

    return (
      <div style={{ fontFamily: C.font }}>
        <TopNav />
        <div style={{ padding: "60px 24px", maxWidth: 360, margin: "0 auto", textAlign: "center" }}>
          <div style={{ fontSize: 13, fontWeight: 800, color: C.text, letterSpacing: ".1em", textTransform: "uppercase", marginBottom: 36 }}>
            Analyzing<Dots />
          </div>
          <div style={{ display: "inline-flex", flexDirection: "column", gap: 18, alignItems: "flex-start" }}>
            {STEPS.map((label, i) => {
              const done   = i < stepsDone;
              const active = i === activeStep && !done;
              return (
                <div key={i} style={{ display: "flex", alignItems: "center", gap: 14 }}>
                  <div style={{
                    width: 26, height: 26, borderRadius: "50%",
                    border: `2px solid ${done ? C.green : active ? C.accent : C.border}`,
                    background: done ? C.green : "transparent",
                    display: "flex", alignItems: "center", justifyContent: "center",
                    flexShrink: 0, transition: "all .3s",
                    boxShadow: active ? `0 0 12px ${C.accent}50` : "none",
                  }}>
                    {done   && <span style={{ color: C.bg, fontWeight: 900 }}>{Icons.check}</span>}
                    {active && <span style={{ width: 8, height: 8, borderRadius: "50%", background: C.accent, display: "block" }} />}
                  </div>
                  <span style={{
                    fontSize: 12, fontWeight: done ? 700 : active ? 800 : 500,
                    color: done ? C.green : active ? C.text : C.muted,
                    transition: "all .3s",
                  }}>
                    {label}
                  </span>
                </div>
              );
            })}
          </div>

          {showCancel && (
            <button onClick={cancel} style={{
              marginTop: 36, padding: "8px 22px",
              background: "transparent", border: `1px solid ${C.border}`,
              borderRadius: 999, fontSize: 10, fontWeight: 700,
              color: C.muted, cursor: "pointer", fontFamily: C.font,
            }}>
              Cancel
            </button>
          )}
        </div>
      </div>
    );
  }

  // ── ANALYZER — DONE ───────────────────────────────────────────────────────
  if (phase === "done" && result) {
    const { legs, parlayProb, totalOdds, platform: plt, code: slipCode } = result;
    const covered   = legs.filter(l => l.fixture).length;
    const probNum   = parseFloat(parlayProb);
    const probColor = isNaN(probNum) ? C.silver : probNum > 5 ? C.green : probNum > 1 ? C.amber : C.red;

    return (
      <div style={{ fontFamily: C.font }}>
        <TopNav />

        {/* Sticky results summary */}
        <div style={{
          padding: "11px 16px",
          background: C.headerBg, borderBottom: `1px solid ${C.headerBorder}`,
          backdropFilter: "blur(20px)",
          position: "sticky", top: 52, zIndex: 10,
        }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, flexWrap: "wrap" }}>
            <div>
              <div style={{ fontSize: 8, fontWeight: 800, color: C.muted, letterSpacing: ".12em", textTransform: "uppercase" }}>
                {plt.toUpperCase()} · {slipCode}
              </div>
              <div style={{ fontSize: 14, fontWeight: 900, color: C.text, marginTop: 1 }}>
                {legs.length} legs · ×{totalOdds}
              </div>
              {covered < legs.length && (
                <div style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 8, color: C.amber, marginTop: 2 }}>
                  {Icons.warn}
                  {covered}/{legs.length} legs matched to snapshots
                </div>
              )}
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
              <div style={{ textAlign: "right" }}>
                <div style={{ fontSize: 8, color: C.muted, letterSpacing: ".08em", textTransform: "uppercase" }}>Parlay prob</div>
                <div style={{ fontSize: 22, fontWeight: 900, color: probColor, lineHeight: 1, marginTop: 1 }}>
                  {parlayProb != null ? `${parlayProb}%` : "—"}
                </div>
              </div>
              {/* B1-FIX: Send all legs directly to Parley System draft */}
              {onSendToDraft && legs.length > 0 && (
                <button onClick={() => {
                  const io = p => (p > 0 && p < 100) ? parseFloat((1/(p/100)).toFixed(2)) : null;
                  onSendToDraft(legs.map(l => ({
                    game:      `${l.home} vs ${l.away}`,
                    pick:      l.pick,
                    odds:      parseFloat(l.odds) > 1 ? parseFloat(l.odds) : io(l.modelProb) || null,
                    conf:      l.modelProb || null,
                    market:    l.market || "1X2",
                    fixtureId: l.fixture?.id || null,
                    empiricalRate: null,
                  })));
                }} style={{
                  display: "flex", alignItems: "center", gap: 4,
                  padding: "7px 13px", borderRadius: 999,
                  background: C.accentDim, border: `1px solid ${C.accentBorder}`,
                  fontSize: 9, fontWeight: 800, color: C.accent,
                  cursor: "pointer", fontFamily: C.font, flexShrink: 0,
                  letterSpacing: ".04em",
                }}>
                  → Draft
                </button>
              )}
              <button onClick={reset} style={{
                display: "flex", alignItems: "center", gap: 5,
                padding: "7px 13px", borderRadius: 999,
                background: "transparent", border: `1px solid ${C.border}`,
                fontSize: 9, fontWeight: 700, color: C.muted,
                cursor: "pointer", fontFamily: C.font, flexShrink: 0,
              }}>
                {Icons.back} New
              </button>
            </div>
          </div>
        </div>

        {/* Leg cards */}
        <div style={{ padding: "12px 16px 0" }}>
          {legs.map((leg, i) => (
            <LegCard key={i} leg={leg} idx={i} C={C} onOpenFullModel={onOpenFullModel || null} />
          ))}
        </div>

        {/* Jarvis card */}
        {jarvis && (
          <div style={{
            margin: "4px 16px 0", padding: "14px 14px 16px",
            background: C.cardBg, border: `1px solid ${C.accentBorder}`,
            borderRadius: 18,
            boxShadow: `0 4px 20px ${C.accent}18`,
          }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                {Icons.bolt}
                <span style={{ fontSize: 9, fontWeight: 900, color: C.accent, letterSpacing: ".18em", textTransform: "uppercase" }}>
                  Jarvis Verdict
                </span>
              </div>
              <button onClick={copyJarvis} style={{
                display: "flex", alignItems: "center", gap: 4,
                padding: "5px 10px", borderRadius: 999,
                background: jarvisCopied ? C.green : "transparent",
                border: `1px solid ${jarvisCopied ? C.green : C.border}`,
                color: jarvisCopied ? C.accentText : C.muted,
                fontSize: 9, fontWeight: 700, cursor: "pointer",
                fontFamily: C.font, transition: "all .2s",
              }}>
                {Icons.copy} {jarvisCopied ? "Copied" : "Copy"}
              </button>
            </div>
            <JarvisText text={jarvis} C={C} />
          </div>
        )}

        {/* New analysis button */}
        <div style={{ padding: "14px 16px 0" }}>
          <button onClick={reset} style={{
            width: "100%", padding: "13px 0",
            background: "transparent", border: `1px solid ${C.border}`,
            borderRadius: 999, fontSize: 11, fontWeight: 700,
            color: C.muted, cursor: "pointer", fontFamily: C.font,
            letterSpacing: ".1em", textTransform: "uppercase",
            display: "flex", alignItems: "center", justifyContent: "center", gap: 6,
          }}>
            {Icons.back} New Analysis
          </button>
        </div>

        <div style={{ height: 80 }} />
      </div>
    );
  }

  // ── ANALYZER — IDLE / ERROR ───────────────────────────────────────────────
  return (
    <div style={{ fontFamily: C.font }}>
      <TopNav />

      <div style={{ padding: "24px 16px 80px", maxWidth: 520, margin: "0 auto" }}>

        {/* Title */}
        <div style={{ marginBottom: 24 }}>
          <div style={{ fontSize: 9, fontWeight: 900, color: C.accent, letterSpacing: ".22em", textTransform: "uppercase", marginBottom: 4 }}>
            GRM Pro
          </div>
          <div style={{ fontSize: 22, fontWeight: 900, color: C.text, letterSpacing: ".01em", lineHeight: 1 }}>
            Code Analyzer
          </div>
        </div>

        {/* Platform toggle */}
        <div style={{
          display: "flex", gap: 0, marginBottom: 12,
          background: C.surface, borderRadius: 999,
          padding: 4, border: `1px solid ${C.border}`,
        }}>
          {BOOKMAKERS.map(bm => (
            <button key={bm.id} onClick={() => setPlatform(bm.id)} style={{
              flex: 1, padding: "10px 0",
              borderRadius: 999, border: "none",
              background: platform === bm.id ? C.accent : "transparent",
              color: platform === bm.id ? C.accentText : C.muted,
              fontSize: 11, fontWeight: 800, cursor: "pointer",
              fontFamily: C.font, letterSpacing: ".05em",
              transition: "all .18s",
              boxShadow: platform === bm.id ? `0 0 16px ${C.accent}30` : "none",
            }}>
              {bm.label}
            </button>
          ))}
        </div>

        {/* Input */}
        <div style={{ position: "relative", marginBottom: 12 }}>
          <input
            type="text"
            value={rawInput}
            onChange={e => setRawInput(e.target.value)}
            onKeyDown={e => e.key === "Enter" && rawInput.trim() && analyze()}
            placeholder={
              platform === "sb"
                ? "Code or sportybet link"
                : "Code or lucky's booking link"
            }
            style={{
              display: "block", width: "100%", boxSizing: "border-box",
              padding: "15px 44px 15px 16px", marginBottom: 0,
              background: C.inputBg || C.surface, border: `1px solid ${C.border}`,
              borderRadius: 14, fontFamily: C.font,
              fontSize: 15, fontWeight: 800, letterSpacing: ".08em",
              color: C.text, outline: "none", caretColor: C.accent,
            }}
            autoComplete="off"
            spellCheck={false}
          />
          {rawInput && (
            <button onClick={() => setRawInput("")} style={{
              position: "absolute", right: 12, top: "50%", transform: "translateY(-50%)",
              background: "transparent", border: "none", cursor: "pointer",
              color: C.muted, display: "flex", alignItems: "center", padding: 4,
            }}>
              {Icons.cross}
            </button>
          )}
        </div>

        {/* Error banner */}
        {phase === "error" && error && (
          <div style={{
            padding: "10px 14px", marginBottom: 12,
            background: C.redDim || `${C.red}14`,
            border: `1px solid ${C.red}40`,
            borderRadius: 12, color: C.red, fontSize: 11,
            fontFamily: C.font, lineHeight: 1.5,
          }}>
            {error}
          </div>
        )}

        {/* Analyze button */}
        <button
          onClick={() => analyze()}
          disabled={!rawInput.trim()}
          style={{
            display: "block", width: "100%", padding: "14px 0",
            background: rawInput.trim() ? C.accent : C.surface,
            border: `1px solid ${rawInput.trim() ? C.accentBorder : C.border}`,
            borderRadius: 999, fontFamily: C.font, fontSize: 12,
            fontWeight: 900, letterSpacing: ".14em", textTransform: "uppercase",
            color: rawInput.trim() ? C.accentText : C.muted,
            cursor: rawInput.trim() ? "pointer" : "not-allowed",
            boxShadow: rawInput.trim() ? `0 4px 20px ${C.accent}28` : "none",
            transition: "all .18s",
          }}
        >
          {phase === "error" ? "Try Again" : "Analyze Slip"}
        </button>

        {/* Info chip */}
        <div style={{ marginTop: 14 }}>
          <button onClick={() => setInfoOpen(o => !o)} style={{
            display: "inline-flex", alignItems: "center", gap: 5,
            background: "transparent", border: `1px solid ${C.border}`,
            borderRadius: 999, padding: "5px 12px", fontSize: 9,
            color: C.muted, cursor: "pointer", fontFamily: C.font, fontWeight: 600,
          }}>
            {Icons.info} How this works
            {infoOpen ? Icons.chevUp : Icons.chevDown}
          </button>
          {infoOpen && (
            <div style={{
              marginTop: 8, padding: "10px 12px",
              background: C.surface, border: `1px solid ${C.border}`,
              borderRadius: 12, fontSize: 9, color: C.muted,
              fontFamily: C.font, lineHeight: 1.7,
            }}>
              Paste a booking code or a share link from your bookmaker. The model matches each leg against its snapshots, computes win probabilities, then Jarvis delivers a verdict using live web context. Fetch the date in Live Model first if you get missing legs.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
