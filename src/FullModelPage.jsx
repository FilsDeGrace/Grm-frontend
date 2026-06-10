// ─────────────────────────────────────────────────────────────────────────────
// FullModelPage.jsx
// Extracted from App.jsx. All original logic preserved.
// Design updated to v3 style (panel sections, display typography, explainers).
// Explainers from explainers.js are wired into each section.
// ─────────────────────────────────────────────────────────────────────────────

import { useState, useCallback, useRef } from "react";
import {
  getReadExplainer,
  getXGExplainer,
  getMatchResultExplainer,
  getGoalRangeExplainer,
  getBTTSExplainer,
  getTeamTotalExplainer,
} from "./explainers.js";

// ── These are shared from App.jsx — import them from wherever they live ──────
// Adjust paths to match your project structure
import {
  C,
  SERVER,
  STRATEGY_LABELS,
  StatusBadge,
  FormRow,
  TheReadSection,
  TheEdgeSection,
  GoalRadarSection,
  ComboRow,
  GoalsPanel,
  FixtureBookNow,
  AskJarvis,
  buildMatchVoice,
  Bar,
  Panel,
  Lbl,
} from "./App.jsx";

// ─────────────────────────────────────────────────────────────────────────────
// INTERNAL: Jarvis Analysis (unchanged from App.jsx)
// ─────────────────────────────────────────────────────────────────────────────
function FullModelJarvis({ f, backtestSummary }) {
  const cacheKey    = `grm_fm_${f.id}_${new Date().toISOString().slice(0,10)}`;
  const cached      = (() => { try { return localStorage.getItem(cacheKey) || null; } catch { return null; } })();
  const [brief, setBrief]             = useState(cached);
  const [loading, setLoading]         = useState(false);
  const [error, setError]             = useState(null);
  const [serverCached, setServerCached] = useState(false);
  const [cachedAgeH, setCachedAgeH]   = useState(null);
  const [consented, setConsented]     = useState(!!cached);

  const doFetch = async (force = false) => {
    setLoading(true); setError(null);
    if (force) { setBrief(null); setServerCached(false); setCachedAgeH(null); }
    try {
      const question = [
        `Give a 4-5 sentence analyst briefing. Plain English, no emoji, no "as an AI".`,
        `Find and include any injury concerns, lineup issues, or squad news.`,
        `Note what each team is fighting for (title, relegation, European place) if relevant.`,
        `Flag any red flags the model data might be missing.`,
        f.form?.home?.length ? `Home form (last 5): ${f.form.home.join("")}` : "",
        f.form?.away?.length ? `Away form (last 5): ${f.form.away.join("")}` : "",
        force ? "refresh" : "",
      ].filter(Boolean).join(" ");
      const res  = await fetch(`${SERVER}/api/jarvis-match`, {
        method:"POST", headers:{ "Content-Type":"application/json" },
        body: JSON.stringify({ fixture: f, question, backtestSummary }),
      });
      if (!res.ok) throw new Error(`Server ${res.status}`);
      const data = await res.json();
      const text = (data.analysis || "").trim();
      if (text) {
        setBrief(text); setServerCached(!!data.cached); setCachedAgeH(data.ageH ?? null);
        try { localStorage.setItem(cacheKey, text); } catch {}
      } else { setError("Analysis unavailable — check back shortly."); }
    } catch { setError("Could not reach analysis service."); }
    finally  { setLoading(false); }
  };

  // Consent gate
  if (!consented) {
    return (
      <div style={s.jarvisWrap}>
        <div style={s.jarvisLabel}>Jarvis Analysis</div>
        <div style={{ marginTop:10, display:"flex", alignItems:"center", gap:10 }}>
          <div style={{ fontSize:11, color:C.muted, lineHeight:1.5, flex:1 }}>Want Jarvis analysis?</div>
          <button onClick={() => { setConsented(true); doFetch(false); }} style={s.jarvisYesBtn}>Yes</button>
        </div>
      </div>
    );
  }

  const sectionColors = {
    "CONTEXT":     C.muted,
    "SQUAD NEWS":  C.amber,
    "MODEL CHECK": C.edge,
    "VERDICT":     C.green,
  };

  return (
    <div style={s.jarvisWrap}>
      <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:8 }}>
        <div style={{ display:"flex", alignItems:"center", gap:8 }}>
          <div style={s.jarvisLabel}>Jarvis Analysis</div>
          {serverCached && cachedAgeH != null && (
            <span style={s.jarvisCacheBadge}>
              Cached · {cachedAgeH < 1 ? `${Math.round(cachedAgeH*60)}m ago` : `${cachedAgeH.toFixed(1)}h ago`}
            </span>
          )}
        </div>
        {!loading && (
          <button onClick={() => doFetch(true)} style={s.jarvisRetryBtn}>
            <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M23 4v6h-6"/><path d="M1 20v-6h6"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>
            </svg>
            Retry
          </button>
        )}
      </div>
      {loading && <div style={{ fontSize:10, color:C.muted, fontStyle:"italic" }}><span className="pu">Researching match context…</span></div>}
      {error && !loading && <div style={{ fontSize:10, color:C.amber, lineHeight:1.5 }}>{error}</div>}
      {brief && !loading && (() => {
        const raw = brief.trim();
        const hasStructure = /\*\*[A-Z ]+\*\*/.test(raw);
        if (hasStructure) {
          const parts = raw.split(/(\*\*[A-Z][A-Z ]*\*\*)/).filter(Boolean);
          const sections = [];
          for (let i = 0; i < parts.length; i++) {
            const hm = parts[i].match(/^\*\*([A-Z][A-Z ]*)\*\*$/);
            if (hm) { sections.push({ label:hm[1].trim(), body:(parts[i+1]||"").replace(/^[\s—–-]+/,"").trim(), color:sectionColors[hm[1].trim()]||C.text }); i++; }
            else if (parts[i].trim()) sections.push({ label:null, body:parts[i].trim(), color:C.text });
          }
          return (
            <div style={{ display:"flex", flexDirection:"column", gap:8 }}>
              {sections.map((sec, i) => (
                <div key={i} style={{ padding:"8px 10px", borderLeft:`3px solid ${sec.color !== C.text ? sec.color : C.border}`, borderRadius:"0 6px 6px 0", background: sec.color !== C.text ? `${sec.color}08` : "transparent" }}>
                  {sec.label && <div style={{ fontSize:9, fontWeight:800, color:sec.color, letterSpacing:".08em", textTransform:"uppercase", marginBottom:4 }}>{sec.label}</div>}
                  <div style={{ fontSize:11, color:C.text, lineHeight:1.65 }}>{sec.body}</div>
                </div>
              ))}
            </div>
          );
        }
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
                <div key={i} style={{ marginBottom:i < paragraphs.length-1 ? 12 : 0, padding:accentCol?"8px 10px":0, borderLeft:accentCol?`3px solid ${accentCol}`:"none", borderRadius:accentCol?"0 6px 6px 0":0, background:accentCol?`${accentCol}08`:"transparent", color:accentCol||C.text }}>
                  {para}
                </div>
              );
            })}
          </div>
        );
      })()}
      {brief && !loading && (
        <div style={{ marginTop:10 }}>
          <AskJarvis fixture={f} backtestSummary={backtestSummary} brief={brief} />
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// INTERNAL: Section panel wrapper
// ─────────────────────────────────────────────────────────────────────────────
function SectionPanel({ label, children }) {
  return (
    <div style={s.panel}>
      <div style={s.panelHeader}>{label}</div>
      <div style={s.panelBody}>{children}</div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// INTERNAL: Explainer text block — renders below a section's data
// Null-safe: renders nothing if text is null
// ─────────────────────────────────────────────────────────────────────────────
function Explainer({ text, style: extraStyle }) {
  if (!text) return null;
  return (
    <div style={{ ...s.explainer, ...extraStyle }}>
      {text}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN EXPORT
// ─────────────────────────────────────────────────────────────────────────────
export default function FullModelPage({ f, onBack, onAddToParlay, draftLegs, backtestSummary }) {
  const m          = f.markets;
  const scrollRef  = useRef(null);

  // Draft state — unchanged from App.jsx
  const draftLegForFixture = Array.isArray(draftLegs)
    ? draftLegs.find(l => l.fixtureId === f.id) : null;
  const isAlreadyInDraft = !!draftLegForFixture;
  const readAnchor   = f.theRead?.anchor;
  const fmEdge       = f.theEdge;
  const readInDraft  = isAlreadyInDraft && !!readAnchor && draftLegForFixture.pick === readAnchor.pick;
  const edgeInDraft  = isAlreadyInDraft && !!fmEdge && draftLegForFixture.pick === fmEdge.pick;
  const radarInDraft = isAlreadyInDraft && (draftLegForFixture?.market === "TeamTotal" || draftLegForFixture?.market?.includes("TeamTotal"));

  // Explainers — all derived from live fixture data
  const readEx    = getReadExplainer(f);
  const xgEx      = getXGExplainer(f);
  const resultEx  = getMatchResultExplainer(f);
  const goalEx    = getGoalRangeExplainer(f);
  const bttsEx    = getBTTSExplainer(f);
  const homeEx    = getTeamTotalExplainer(f.teams?.home, f.teamStats?.home, "home", f);
  const awayEx    = getTeamTotalExplainer(f.teams?.away, f.teamStats?.away, "away", f);

  const handleAdd = useCallback((pick) => {
    if (!onAddToParlay) return;
    const io = p => (p > 0 && p < 100) ? parseFloat((1 / (p / 100)).toFixed(2)) : null;
    onAddToParlay(f, { pick:pick.pick, prob:pick.prob, odds:pick.odds || io(pick.prob) || null, market:pick.market });
  }, [f, onAddToParlay]);

  const BackBtn = ({ bottom }) => (
    <button onClick={onBack} className="gb-ghost"
      style={{ padding:bottom?"12px 0":"7px 14px", fontSize:11,
               display:"flex", alignItems:"center", gap:6,
               width:bottom?"100%":"auto", justifyContent:bottom?"center":"flex-start", flexShrink:0 }}>
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
        <polyline points="15 18 9 12 15 6"/>
      </svg>
      {bottom ? "Back to fixtures" : "Back"}
    </button>
  );

  // xG values
  const hxg = parseFloat(m?.homeXG) || 0;
  const axg = parseFloat(m?.awayXG) || 0;
  const xgTotal = hxg + axg;
  const xgHomePct = xgTotal > 0 ? (hxg / xgTotal) * 100 : 50;

  // Historical rate delta for The Read
  const anchor = f.theRead?.anchor;
  const delta  = anchor?.prob && anchor?.empiricalRate
    ? parseFloat((anchor.prob - anchor.empiricalRate).toFixed(1)) : null;

  return (
    <div className="grm-full-model-page"
      ref={scrollRef}
      style={{ position:"fixed", inset:0, zIndex:300, background:C.bg,
               overflowY:"auto", overscrollBehavior:"contain",
               display:"flex", flexDirection:"column" }}>

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

      <div style={{ padding:"12px 12px", display:"flex", flexDirection:"column", gap:8, maxWidth:700, width:"100%", margin:"0 auto" }}>

        {/* ── MATCH IDENTITY ── */}
        <SectionPanel label={null}>
          <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:10 }}>
            <span style={{ fontSize:14, fontWeight:800, color:C.text, flex:1, lineHeight:1.25 }}>{f.teams.home}</span>
            <div style={{ textAlign:"center", padding:"0 12px", flexShrink:0 }}>
              {f.hGoals != null
                ? <div style={{ fontSize:20, fontWeight:800, color:C.text, fontFamily:"var(--font-display,'JetBrains Mono',monospace)" }}>{f.hGoals}–{f.aGoals}</div>
                : <div style={{ fontSize:10, color:C.muted }}>vs</div>}
              {f.time && <div style={{ fontSize:8, color:C.muted, marginTop:1 }}>{f.time}</div>}
            </div>
            <span style={{ fontSize:14, fontWeight:800, color:C.text, flex:1, textAlign:"right", lineHeight:1.25 }}>{f.teams.away}</span>
          </div>
          {f.form && (f.form.home?.length > 0 || f.form.away?.length > 0) && (
            <FormRow home={f.form.home} away={f.form.away} allCompHome={f.form.allCompHome} allCompAway={f.form.allCompAway} />
          )}
          {f.tablePosition && (f.tablePosition.homePosition || f.tablePosition.awayPosition) && (
            <div style={{ display:"flex", justifyContent:"space-between", marginTop:8, paddingTop:8, borderTop:`1px solid ${C.border}` }}>
              <span style={{ fontSize:10, color:C.muted }}>
                <span style={{ color:C.text, fontWeight:700 }}>#{f.tablePosition.homePosition || "—"}</span>
                {f.tablePosition.homePoints != null && <span> · {f.tablePosition.homePoints}pts</span>}
              </span>
              <span style={{ fontSize:10, color:C.muted, textAlign:"right" }}>
                {f.tablePosition.awayPoints != null && <span>{f.tablePosition.awayPoints}pts · </span>}
                <span style={{ color:C.text, fontWeight:700 }}>#{f.tablePosition.awayPosition || "—"}</span>
              </span>
            </div>
          )}
          {f.strategyTags?.length > 0 && (
            <div style={{ display:"flex", gap:5, flexWrap:"wrap", marginTop:8 }}>
              {f.strategyTags.map(t => (
                <span key={t} className="grm-chip" style={{ color:C.gold, borderColor:`${C.gold}40`, background:C.goldDim }}>
                  {STRATEGY_LABELS[t] || t}
                </span>
              ))}
            </div>
          )}
        </SectionPanel>

        {/* ── JARVIS ANALYSIS ── */}
        <SectionPanel label={null}>
          <FullModelJarvis f={f} backtestSummary={backtestSummary} />
        </SectionPanel>

        {/* ── THE READ + EDGE — side by side, unchanged components ── */}
        <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:8 }}>
          <TheReadSection theRead={f.theRead} fixture={f}
            onAddToParlay={onAddToParlay ? handleAdd : null}
            alreadyAdded={readInDraft}
            otherInDraft={isAlreadyInDraft && !readInDraft} />
          <TheEdgeSection theEdge={f.theEdge}
            alreadyAdded={edgeInDraft}
            otherInDraft={isAlreadyInDraft && !edgeInDraft}
            onAddToParlay={onAddToParlay ? (pick) => handleAdd({ ...pick, market:pick.market }) : null}
            fixture={f} />
        </div>

        {/* Read explainer — sits below signal panels as a single contextual summary */}
        {(readEx?.headline || readEx?.sub) && (
          <div style={s.readExplainerBlock}>
            {readEx.headline && <div style={s.readExplainerHeadline}>{readEx.headline}</div>}
            {readEx.sub      && <div style={s.readExplainerSub}>{readEx.sub}</div>}
          </div>
        )}

        {/* ── GOAL RADAR ── */}
        {f.goalRadar && (
          <GoalRadarSection goalRadar={f.goalRadar}
            alreadyAdded={radarInDraft}
            otherInDraft={isAlreadyInDraft && !radarInDraft}
            onAddToParlay={onAddToParlay ? (entry) => handleAdd({ ...entry, market:"TeamTotal" }) : null} />
        )}

        {/* ── CUSTOM PICK ── */}
        <FixtureBookNow fixture={f} onAddToParlay={onAddToParlay ? handleAdd : null} />

        {/* ── EXPECTED GOALS ── */}
        <SectionPanel label="Expected Goals">
          <div style={{ display:"flex", alignItems:"center", gap:14, marginBottom:10 }}>
            <div style={{ textAlign:"center", minWidth:56 }}>
              <div style={{ fontSize:30, fontWeight:900, color:C.accent, lineHeight:1, fontFamily:"var(--font-display,'Azeret Mono',monospace)" }}>{m.homeXG}</div>
              <div style={{ fontSize:9, color:C.muted, marginTop:3 }}>{f.teams.home.split(" ")[0]}</div>
            </div>
            {/* xG tension bar with marker */}
            <div style={{ flex:1, position:"relative", height:20, display:"flex", alignItems:"center" }}>
              <div style={{ position:"absolute", inset:0, display:"flex", alignItems:"center", height:"100%" }}>
                <div style={{ height:4, background:C.accent, opacity:.55, borderRadius:"2px 0 0 2px", width:`${xgHomePct}%`, transition:"width .8s cubic-bezier(.16,1,.3,1)" }} />
                <div style={{ height:4, background:C.blue, opacity:.55, borderRadius:"0 2px 2px 0", flex:1 }} />
              </div>
              {/* Marker */}
              <div style={{ position:"absolute", left:`${xgHomePct}%`, transform:"translateX(-50%)", width:3, height:20, background:C.text, borderRadius:1, zIndex:2 }} />
              {/* Even label */}
              <div style={{ position:"absolute", left:"50%", transform:"translateX(-50%)", bottom:-13, fontSize:8, color:C.border, letterSpacing:".06em", textTransform:"uppercase", whiteSpace:"nowrap" }}>even</div>
            </div>
            <div style={{ textAlign:"center", minWidth:56 }}>
              <div style={{ fontSize:30, fontWeight:900, color:C.blue, lineHeight:1, fontFamily:"var(--font-display,'Azeret Mono',monospace)" }}>{m.awayXG}</div>
              <div style={{ fontSize:9, color:C.muted, marginTop:3 }}>{f.teams.away.split(" ")[0]}</div>
            </div>
          </div>
          <Explainer text={xgEx} style={{ marginTop:6 }} />
        </SectionPanel>

        {/* ── MATCH RESULT ── */}
        <SectionPanel label="Match Result">
          {[
            { l:"H", label:`${f.teams.home} Win`, prob:m.homeWin, odds:f.odds?.o1,  color:C.accent, ex:resultEx?.H },
            { l:"X", label:"Draw",                prob:m.draw,    odds:f.odds?.oX,  color:C.muted,  ex:resultEx?.X },
            { l:"A", label:`${f.teams.away} Win`, prob:m.awayWin, odds:f.odds?.o2,  color:C.blue,   ex:resultEx?.A },
          ].map(r => {
            const prob      = Math.round(r.prob || 0);
            const histKey   = r.l === "H" ? "homeWinHist" : r.l === "X" ? "drawHist" : "awayWinHist";
            const hist      = Math.round(f.markets?.[histKey] || 0);
            const d         = hist ? prob - hist : null;
            return (
              <div key={r.l} style={{ paddingBottom:10, marginBottom:10, borderBottom:`1px solid ${C.border}` }}
                   className="fm-result-row">
                {/* Bar row */}
                <div style={{ display:"flex", alignItems:"center", gap:8, marginBottom:4 }}>
                  <span style={{ fontSize:11, color:C.muted, width:14, fontWeight:700, flexShrink:0 }}>{r.l}</span>
                  <div style={{ flex:1, height:3, background:C.faint, borderRadius:2, overflow:"hidden" }}>
                    <div style={{ height:"100%", width:`${prob}%`, background:r.color, borderRadius:2, transition:"width .6s cubic-bezier(.16,1,.3,1)" }}/>
                  </div>
                  <span style={{ fontSize:15, color:r.color, fontWeight:800, width:36, textAlign:"right", fontFamily:"var(--font-display,'Azeret Mono',monospace)", letterSpacing:"-.02em", flexShrink:0 }}>{prob}%</span>
                  {r.odds && <span style={{ fontSize:9, color:C.muted, width:28, textAlign:"right", flexShrink:0 }}>{r.odds}×</span>}
                </div>
                {/* Hist delta */}
                {d !== null && (
                  <div style={{ display:"flex", alignItems:"center", gap:5, paddingLeft:22 }}>
                    <span style={{ fontSize:10, fontWeight:700, color: d > 3 ? C.green : d < -3 ? C.red : C.muted }}>
                      {d > 0 ? `+${d}%` : `${d}%`} {d > 3 ? "above hist" : d < -3 ? "below hist" : "on hist"}
                    </span>
                    <span style={{ fontSize:9, color:C.muted, opacity:.6 }}>(hist {hist}%)</span>
                  </div>
                )}
                {/* Explainer */}
                {r.ex && <Explainer text={r.ex} style={{ paddingLeft:22, marginTop:4 }} />}
              </div>
            );
          })}
        </SectionPanel>

        {/* ── GOAL RANGE ── */}
        <SectionPanel label="Goal Range">
          {goalEx && (
            <div style={{ marginBottom:12 }}>
              <div style={{ fontSize:13, fontWeight:800, color:C.orange, letterSpacing:"-.01em", fontFamily:"var(--font-display,'Azeret Mono',monospace)", marginBottom:2 }}>{goalEx.headline}</div>
              <div style={{ fontSize:10, color:C.muted, fontStyle:"italic", lineHeight:1.5 }}>{goalEx.desc}</div>
            </div>
          )}
          {/* Goal rows — reusing GoalsPanel data */}
          {[
            { mkt:"O1.5", prob:m.over15,  color:C.green },
            { mkt:"O2.5", prob:m.over25,  color:C.green },
            { mkt:"O3.5", prob:m.over35,  color:C.amber },
            { mkt:"U2.5", prob:m.under25, color:C.blue  },
            { mkt:"U3.5", prob:m.under35, color:C.blue  },
          ].map(r => {
            const prob = Math.round(r.prob || 0);
            return (
              <div key={r.mkt} style={{ display:"grid", gridTemplateColumns:"30px 1fr 30px", gap:8, alignItems:"center", padding:"4px 0", borderBottom:`1px solid ${C.faint}` }}>
                <span style={{ fontSize:10, fontWeight:600, color:C.muted }}>{r.mkt}</span>
                <div style={{ height:3, background:C.faint, borderRadius:1, overflow:"hidden" }}>
                  <div style={{ height:"100%", width:`${prob}%`, background:r.color, borderRadius:1, transition:"width .6s cubic-bezier(.16,1,.3,1)" }}/>
                </div>
                <span style={{ fontSize:11, fontWeight:700, color:r.color, textAlign:"right", fontFamily:"var(--font-display,'Azeret Mono',monospace)", letterSpacing:"-.02em" }}>{prob}%</span>
              </div>
            );
          })}
          {/* Likely score */}
          {m.likelyScore && (
            <div style={{ marginTop:14, paddingTop:12, borderTop:`1px solid ${C.border}` }}>
              <div style={{ fontSize:9, fontWeight:700, letterSpacing:".12em", textTransform:"uppercase", color:C.muted, marginBottom:4 }}>Likely Scoreline</div>
              <div style={{ display:"flex", alignItems:"baseline", gap:8 }}>
                <span style={{ fontSize:28, fontWeight:900, color:C.text, letterSpacing:"-.04em", lineHeight:1, fontFamily:"var(--font-display,'Azeret Mono',monospace)" }}>{m.likelyScore}</span>
                {m.likelyScoreProb && <span style={{ fontSize:11, color:C.muted }}>{Math.round(m.likelyScoreProb)}% probability</span>}
              </div>
            </div>
          )}
        </SectionPanel>

        {/* ── BTTS ── */}
        <SectionPanel label="BTTS">
          <div style={{ display:"grid", gridTemplateColumns:"1fr 1px 1fr", gap:0 }}>
            <div style={{ paddingRight:14 }}>
              <div style={{ fontSize:9, fontWeight:700, letterSpacing:".10em", textTransform:"uppercase", color:C.muted, marginBottom:4 }}>Yes</div>
              <div style={{ fontSize:32, fontWeight:900, letterSpacing:"-.05em", lineHeight:1, color:m.bttsYes >= 60 ? C.orange : C.muted, fontFamily:"var(--font-display,'Azeret Mono',monospace)", marginBottom:2 }}>{Math.round(m.bttsYes)}%</div>
              <div style={{ fontSize:9, color:m.bttsYes >= 60 ? C.orange : C.muted, fontWeight:700, marginBottom:8 }}>{m.bttsYes >= 60 ? "Qualified" : "Below threshold"}</div>
              <Explainer text={bttsEx?.yes} />
              <div style={{ height:2, background:C.faint, borderRadius:1, overflow:"hidden", marginTop:8 }}>
                <div style={{ height:"100%", width:`${Math.round(m.bttsYes)}%`, background:C.orange, borderRadius:1 }}/>
              </div>
            </div>
            <div style={{ background:C.border }} />
            <div style={{ paddingLeft:14 }}>
              <div style={{ fontSize:9, fontWeight:700, letterSpacing:".10em", textTransform:"uppercase", color:C.muted, marginBottom:4, textAlign:"right" }}>No</div>
              <div style={{ fontSize:32, fontWeight:900, letterSpacing:"-.05em", lineHeight:1, color:C.muted, fontFamily:"var(--font-display,'Azeret Mono',monospace)", marginBottom:2, textAlign:"right" }}>{Math.round(m.bttsNo)}%</div>
              <div style={{ fontSize:9, color:C.muted, fontWeight:700, marginBottom:8, textAlign:"right" }}>Below threshold</div>
              <Explainer text={bttsEx?.no} style={{ textAlign:"right" }} />
              <div style={{ height:2, background:C.faint, borderRadius:1, overflow:"hidden", marginTop:8 }}>
                <div style={{ height:"100%", width:`${Math.round(m.bttsNo)}%`, background:C.muted, borderRadius:1, float:"right" }}/>
              </div>
            </div>
          </div>
        </SectionPanel>

        {/* ── TEAM TOTALS ── */}
        <SectionPanel label="Team Totals">
          {[
            { name:f.teams.home, o05:m.homeOver05, o15:m.homeOver15, cs:m.homeCS, stats:f.teamStats?.home, side:"home", ex:homeEx },
            { name:f.teams.away, o05:m.awayOver05, o15:m.awayOver15, cs:m.awayCS, stats:f.teamStats?.away, side:"away", ex:awayEx },
          ].map((t, ti) => (
            <div key={t.name} style={{ paddingLeft:12, borderLeft:`2px solid ${ti === 0 ? C.border : C.accent}`, marginBottom:ti === 0 ? 14 : 0 }}>
              <div style={{ fontSize:12, fontWeight:700, color:C.text, marginBottom:4, letterSpacing:"-.01em" }}>{t.name}</div>
              <div style={{ fontSize:10, color:C.muted, marginBottom:6 }}>
                O0.5 <span style={{ color:C.text, fontWeight:600 }}>{Math.round(t.o05||0)}%</span>
                &nbsp;&nbsp;O1.5 <span style={{ color:C.text, fontWeight:600 }}>{Math.round(t.o15||0)}%</span>
                &nbsp;&nbsp;CS <span style={{ color:C.text, fontWeight:600 }}>{Math.round(t.cs||0)}%</span>
              </div>
              <Explainer text={t.ex} style={{ marginBottom:8 }} />
              {t.stats?.recentResults?.length > 0 && (
                <div style={{ display:"flex", gap:3, flexWrap:"wrap" }}>
                  {t.stats.recentResults.map((r, i) => (
                    <div key={i} title={`${r.role} vs ${r.opponent} · ${r.scored}-${r.conceded}`}
                      style={{ display:"flex", alignItems:"center", gap:2, background:C.faint, borderRadius:4, padding:"2px 6px", fontSize:8,
                               border:`1px solid ${r.outcome==="W"?C.green+"40":r.outcome==="L"?C.red+"40":C.border}` }}>
                      <span style={{ color:r.outcome==="W"?C.green:r.outcome==="L"?C.red:C.muted, fontWeight:800 }}>{r.outcome}</span>
                      <span style={{ color:C.muted }}>{r.scored}-{r.conceded}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))}
        </SectionPanel>

        {/* ── COMBOS ── */}
        {f.combos?.length > 0 && (
          <SectionPanel label="Combo Suggestions">
            {f.combos.map((combo, i) => (
              <ComboRow key={i} combo={combo} onAddToParlay={onAddToParlay ? handleAdd : null} />
            ))}
          </SectionPanel>
        )}

        <BackBtn bottom />
        <div style={{ height:20 }} />
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// STYLES — all in-file, token-referenced
// ─────────────────────────────────────────────────────────────────────────────
const s = {
  panel: {
    background: C.surface,
    border: `1px solid ${C.border}`,
    borderRadius: 8,
    overflow: "hidden",
  },
  panelHeader: {
    fontSize: 9, fontWeight: 700,
    letterSpacing: ".14em", textTransform: "uppercase",
    color: C.muted,
    padding: "8px 14px",
    borderBottom: `1px solid ${C.border}`,
    background: C.faint,
  },
  panelBody: {
    padding: "14px",
  },
  explainer: {
    fontSize: 10,
    color: C.muted,
    lineHeight: 1.55,
    fontStyle: "italic",
  },
  readExplainerBlock: {
    padding: "12px 14px",
    borderLeft: `3px solid ${C.accent}`,
    background: C.accentDim,
    borderRadius: "0 6px 6px 0",
    margin: "0 0 0 0",
  },
  readExplainerHeadline: {
    fontSize: 11, color: C.text,
    lineHeight: 1.55, marginBottom: 4,
    fontStyle: "italic",
  },
  readExplainerSub: {
    fontSize: 10, color: C.muted,
    lineHeight: 1.45,
  },
  jarvisWrap: {
    paddingTop: 0,
  },
  jarvisLabel: {
    fontSize: 9, fontWeight: 800,
    color: C.edge, letterSpacing: ".1em",
    textTransform: "uppercase",
  },
  jarvisCacheBadge: {
    fontSize: 7, color: C.muted,
    background: C.surface,
    border: `1px solid ${C.faint}`,
    borderRadius: 4, padding: "1px 6px",
  },
  jarvisRetryBtn: {
    fontSize: 8, color: C.muted,
    background: "transparent",
    border: `1px solid ${C.faint}`,
    borderRadius: 5, padding: "2px 8px",
    cursor: "pointer", fontFamily: C.font,
    display: "flex", alignItems: "center", gap: 3,
  },
  jarvisYesBtn: {
    flexShrink: 0, padding: "6px 16px",
    fontSize: 10, fontWeight: 700,
    background: C.accentDim, color: C.accent,
    border: `1px solid ${C.accentBorder}`,
    borderRadius: 8, cursor: "pointer",
    fontFamily: C.font, letterSpacing: ".04em",
  },
};
