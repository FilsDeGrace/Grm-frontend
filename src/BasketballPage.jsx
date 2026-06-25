/**
 * BasketballPage.jsx — Pure render components for GRM Pro basketball.
 *
 * NO own fetch, NO own date state, NO own header, NO own nav.
 * App.jsx owns all of that. These components just render games data.
 *
 * Exports:
 *   BasketballGameList  — renders enriched basketball games into cards
 *   BasketballRolloverView — renders the rollover pick UI from a pre-built pool
 */

import React, { useState } from "react";
import { fractionalToDecimal } from "./BasketballEngine";

// ─── SPORT ACCENT ─────────────────────────────────────────────────────────────
const BB     = "#E8640A";
const BB_DIM  = `${BB}18`;
const BB_RING = `${BB}35`;

// ─── BASKETBALL SVG ICON — no emoji ───────────────────────────────────────────
export function BballIcon({ size = 14, color = BB }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" style={{ flexShrink: 0 }}>
      <circle cx="8" cy="8" r="7" stroke={color} strokeWidth="1.4" fill="none" />
      <path d="M1 8 Q4 5 8 8 Q12 11 15 8" stroke={color} strokeWidth="1" fill="none" />
      <path d="M8 1 Q5 4 8 8 Q11 12 8 15" stroke={color} strokeWidth="1" fill="none" />
    </svg>
  );
}

// ─── UTILS ────────────────────────────────────────────────────────────────────
function fmtTime(isoStr) {
  if (!isoStr) return null;
  return new Date(isoStr).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export function isLive(statusCode)     { return [6,7,8,9,10,11].includes(statusCode); }
export function isFinished(statusCode) { return statusCode === 100; }

function confColor(conf, C) {
  if (conf >= 70) return C.green;
  if (conf >= 58) return BB;
  return C.amber;
}

function oddsLabel(odds) {
  if (!odds || odds <= 1) return "—";
  return `${parseFloat(odds).toFixed(2)}x`;
}

// ─── MICRO COMPONENTS ─────────────────────────────────────────────────────────

function LiveDot({ C }) {
  return (
    <svg width="8" height="8" viewBox="0 0 8 8" style={{ flexShrink: 0 }}>
      <circle cx="4" cy="4" r="4" fill={C.green} opacity=".2" />
      <circle cx="4" cy="4" r="2.5" fill={C.green} />
    </svg>
  );
}

function StatusPill({ status, statusCode, startTime, C }) {
  if (isLive(statusCode)) return (
    <span style={{ display:"inline-flex",alignItems:"center",gap:4,fontSize:8,fontWeight:800,color:C.green,letterSpacing:".1em",textTransform:"uppercase" }}>
      <LiveDot C={C} /> {status || "LIVE"}
    </span>
  );
  if (isFinished(statusCode)) return (
    <span style={{ fontSize:8,color:C.muted,fontWeight:700,letterSpacing:".08em",textTransform:"uppercase" }}>Final</span>
  );
  if (startTime) return (
    <span style={{ fontSize:8,color:C.text,letterSpacing:".04em" }}>{fmtTime(startTime)}</span>
  );
  return <span style={{ fontSize:8,color:C.muted }}>{status || "—"}</span>;
}

function CourtArc({ C }) {
  return (
    <div style={{ position:"relative",height:20,margin:"0 -2px",flexShrink:0 }}>
      <svg width="100%" height="20" viewBox="0 0 120 20" preserveAspectRatio="none">
        <path d="M0,10 Q60,2 120,10" stroke={`${BB}30`} strokeWidth="1" fill="none" strokeDasharray="3 2" />
      </svg>
    </div>
  );
}

function QuarterScoreRow({ quarters, C }) {
  const labels = ["Q1","Q2","Q3","Q4","OT"];
  const keys   = ["q1","q2","q3","q4","ot"];
  const hasOT  = quarters.home.ot != null || quarters.away.ot != null;
  return (
    <div style={{ display:"grid",gridTemplateColumns:`repeat(${hasOT?5:4},1fr)`,gap:2 }}>
      {keys.slice(0,hasOT?5:4).map((k,i) => {
        const h = quarters.home[k], a = quarters.away[k];
        if (h == null && a == null) return null;
        const hw = h != null && a != null && h > a;
        const aw = h != null && a != null && a > h;
        return (
          <div key={k} style={{ textAlign:"center" }}>
            <div style={{ fontSize:7,color:C.muted,fontWeight:700,letterSpacing:".06em",marginBottom:3 }}>{labels[i]}</div>
            <div style={{ fontSize:11,fontWeight:800,color:hw?C.text:C.muted,fontFamily:'"JetBrains Mono",monospace' }}>{h??'—'}</div>
            <div style={{ fontSize:11,fontWeight:800,color:aw?C.text:C.muted,fontFamily:'"JetBrains Mono",monospace' }}>{a??'—'}</div>
          </div>
        );
      })}
    </div>
  );
}

function DraftButton({ game, pick, draftLegs, onAddToDraft, C }) {
  const alreadyAdded = draftLegs?.some(l => l.gameId === game.eventId && l.pick === pick.pick);
  const [flashed, setFlashed] = useState(false);
  const handleAdd = () => {
    if (alreadyAdded || !onAddToDraft) return;
    onAddToDraft({
      gameId: game.eventId,
      game:   `${game.homeTeam} vs ${game.awayTeam}`,
      home:   game.homeTeam, away: game.awayTeam,
      pick:   pick.pick, odds: pick.odds, conf: pick.confidence,
      market: pick.market, sport: "basketball", tournament: game.tournament,
    });
    setFlashed(true);
    setTimeout(() => setFlashed(false), 1400);
  };
  return (
    <button onClick={handleAdd} disabled={alreadyAdded} style={{
      padding:"5px 12px",fontSize:9,fontWeight:800,borderRadius:7,
      cursor:alreadyAdded?"default":"pointer",
      border:`1px solid ${alreadyAdded?C.green:BB}55`,
      background:alreadyAdded?`${C.green}15`:flashed?`${C.green}20`:BB_DIM,
      color:alreadyAdded?C.green:flashed?C.green:BB,
      transition:"all .2s",letterSpacing:".06em",fontFamily:"var(--font,inherit)",
    }}>
      {alreadyAdded ? "✓ Added" : "+ Draft"}
    </button>
  );
}

function PlayerTable({ players, C }) {
  if (!players?.length) return (
    <div style={{ fontSize:9,color:C.muted,padding:"10px 0",textAlign:"center" }}>No player data</div>
  );
  return (
    <div style={{ overflowX:"auto" }}>
      <table style={{ width:"100%",borderCollapse:"collapse",fontSize:9,fontFamily:'"JetBrains Mono",monospace' }}>
        <thead>
          <tr>{["#","Player","MIN","PTS","REB","AST","STL","BLK","TO","F","+/-"].map(h => (
            <th key={h} style={{ padding:"4px 6px",textAlign:h==="Player"?"left":"center",color:C.muted,fontWeight:700,fontSize:7,letterSpacing:".08em",borderBottom:`1px solid ${C.border}` }}>{h}</th>
          ))}</tr>
        </thead>
        <tbody>
          {players.map((p,i) => (
            <tr key={i} style={{ borderBottom:`1px solid ${C.border}22` }}>
              <td style={{ padding:"5px 6px",color:C.muted,textAlign:"center" }}>{p.jerseyNumber??"—"}</td>
              <td style={{ padding:"5px 6px",color:C.text,fontWeight:700,whiteSpace:"nowrap",maxWidth:100,overflow:"hidden",textOverflow:"ellipsis" }}>
                {p.name}
                {p.fouls>=4 && <span style={{ marginLeft:5,fontSize:7,color:C.amber,background:`${C.amber}18`,borderRadius:3,padding:"1px 4px" }}>FOUL RISK</span>}
              </td>
              {[p.minutesPlayed,p.points,p.rebounds,p.assists,p.steals,p.blocks,p.turnovers,p.fouls].map((v,j) => (
                <td key={j} style={{ padding:"5px 6px",textAlign:"center",color:v!=null?(j===1&&v>=20?BB:C.text):C.muted,fontWeight:j===1?800:400 }}>{v??"—"}</td>
              ))}
              <td style={{ padding:"5px 6px",textAlign:"center",color:p.plusMinus>0?C.green:p.plusMinus<0?C.red:C.muted,fontWeight:700 }}>
                {p.plusMinus!=null?(p.plusMinus>0?`+${p.plusMinus}`:p.plusMinus):"—"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ─── SECTION LABEL ────────────────────────────────────────────────────────────
function SectionLabel({ children }) {
  return (
    <div style={{ fontSize:8,fontWeight:800,color:BB,letterSpacing:".12em",textTransform:"uppercase",marginBottom:6 }}>
      {children}
    </div>
  );
}

// ─── GAME DETAIL OVERLAY ──────────────────────────────────────────────────────
function GameDetailOverlay({ game, draftLegs, onAddToDraft, onClose, C }) {
  const [tab, setTab] = useState("stats");
  const TABS = [
    { id:"stats",   label:"Stats"   },
    { id:"players", label:"Players" },
    { id:"form",    label:"Form"    },
    { id:"odds",    label:"Odds"    },
  ];
  return (
    <div style={{ position:"fixed",inset:0,zIndex:300,background:"rgba(0,0,0,0.72)",display:"flex",alignItems:"flex-end" }}
      onClick={onClose}>
      <div onClick={e=>e.stopPropagation()} style={{
        width:"100%",maxHeight:"82vh",borderRadius:"18px 18px 0 0",
        background:C.modalBg,border:`1px solid ${C.border}`,
        display:"flex",flexDirection:"column",overflow:"hidden",
      }}>
        {/* Handle */}
        <div style={{ display:"flex",justifyContent:"center",paddingTop:10,paddingBottom:4 }}>
          <div style={{ width:36,height:4,borderRadius:2,background:C.border }} />
        </div>
        {/* Header */}
        <div style={{ padding:"10px 16px 12px",borderBottom:`1px solid ${C.border}` }}>
          <div style={{ fontSize:8,color:BB,fontWeight:800,letterSpacing:".12em",textTransform:"uppercase",marginBottom:4,display:"flex",alignItems:"center",gap:4 }}>
            <BballIcon size={10} color={BB} />
            {game.tournament}
          </div>
          <div style={{ display:"flex",justifyContent:"space-between",alignItems:"center" }}>
            <div style={{ flex:1 }}>
              <div style={{ fontSize:13,fontWeight:900,color:C.text,letterSpacing:".04em" }}>{game.homeTeam}</div>
              <div style={{ fontSize:8,color:C.muted,marginTop:1 }}>HOME</div>
            </div>
            <div style={{ padding:"0 14px",textAlign:"center" }}>
              {game.homeScore!=null
                ? <div style={{ fontSize:22,fontWeight:900,color:C.text,fontFamily:'"JetBrains Mono",monospace' }}>{game.homeScore}–{game.awayScore}</div>
                : <div style={{ fontSize:11,color:BB,fontWeight:800 }}>VS</div>
              }
              <StatusPill status={game.status} statusCode={game.statusCode} startTime={game.startTime} C={C} />
            </div>
            <div style={{ flex:1,textAlign:"right" }}>
              <div style={{ fontSize:13,fontWeight:900,color:C.text,letterSpacing:".04em" }}>{game.awayTeam}</div>
              <div style={{ fontSize:8,color:C.muted,marginTop:1 }}>AWAY</div>
            </div>
          </div>
        </div>
        {/* Tab strip */}
        <div style={{ display:"flex",padding:"8px 12px 0",gap:4,borderBottom:`1px solid ${C.border}` }}>
          {TABS.map(t => (
            <button key={t.id} onClick={() => setTab(t.id)} style={{
              padding:"5px 14px",fontSize:9,fontWeight:800,borderRadius:"7px 7px 0 0",cursor:"pointer",
              border:`1px solid ${tab===t.id?BB:C.border}`,borderBottom:"none",
              background:tab===t.id?BB_DIM:C.surface,
              color:tab===t.id?BB:C.muted,fontFamily:"inherit",
            }}>{t.label}</button>
          ))}
        </div>
        {/* Tab body */}
        <div style={{ flex:1,overflowY:"auto",padding:"14px 16px" }}>
          {/* STATS */}
          {tab==="stats" && (
            <div>
              {/* Best pick */}
              {game.bestPick && (
                <div style={{ background:BB_DIM,border:`1px solid ${BB_RING}`,borderRadius:10,padding:"12px 14px",marginBottom:14 }}>
                  <SectionLabel>Best Pick</SectionLabel>
                  <div style={{ display:"flex",justifyContent:"space-between",alignItems:"center" }}>
                    <div>
                      <div style={{ fontSize:12,fontWeight:900,color:BB }}>{game.bestPick.pick}</div>
                      <div style={{ fontSize:8,color:C.muted,marginTop:2 }}>{game.bestPick.market} · {game.bestPick.basis}</div>
                    </div>
                    <div style={{ textAlign:"right" }}>
                      <div style={{ fontSize:18,fontWeight:900,color:confColor(game.bestPick.confidence,C),fontFamily:'"JetBrains Mono",monospace' }}>{game.bestPick.confidence}%</div>
                      <div style={{ fontSize:10,color:C.text,fontFamily:'"JetBrains Mono",monospace' }}>{oddsLabel(game.bestPick.odds)}</div>
                    </div>
                  </div>
                  <div style={{ marginTop:10 }}>
                    <DraftButton game={game} pick={game.bestPick} draftLegs={draftLegs} onAddToDraft={onAddToDraft} C={C} />
                  </div>
                </div>
              )}
              {/* Win probs */}
              <SectionLabel>Win Probability</SectionLabel>
              <div style={{ display:"grid",gridTemplateColumns:"1fr 1fr",gap:8,marginBottom:14 }}>
                {[{label:game.homeTeam,prob:game.homeWinProb},{label:game.awayTeam,prob:game.awayWinProb}].map(({label,prob}) => (
                  <div key={label} style={{ background:C.surface,border:`1px solid ${C.border}`,borderRadius:9,padding:"10px 12px",textAlign:"center" }}>
                    <div style={{ fontSize:20,fontWeight:900,color:C.text,fontFamily:'"JetBrains Mono",monospace' }}>{prob}%</div>
                    <div style={{ fontSize:8,color:C.muted,marginTop:2,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap" }}>{label}</div>
                  </div>
                ))}
              </div>
              {/* Total signal */}
              {game.totalSignal && (
                <div style={{ marginBottom:14 }}>
                  <SectionLabel>Total Points Model</SectionLabel>
                  <div style={{ background:C.surface,border:`1px solid ${C.border}`,borderRadius:9,padding:"10px 12px" }}>
                    <div style={{ display:"flex",justifyContent:"space-between",alignItems:"center" }}>
                      <div>
                        <div style={{ fontSize:8,color:C.muted,marginBottom:3 }}>Market Line</div>
                        <div style={{ fontSize:18,fontWeight:900,color:C.text,fontFamily:'"JetBrains Mono",monospace' }}>{game.totalSignal.line}</div>
                      </div>
                      <div style={{ textAlign:"center" }}>
                        <div style={{ fontSize:8,color:C.muted,marginBottom:3 }}>Model Estimate</div>
                        <div style={{ fontSize:16,fontWeight:900,color:BB,fontFamily:'"JetBrains Mono",monospace' }}>{game.totalSignal.estimated}</div>
                      </div>
                      <div style={{ textAlign:"right" }}>
                        <div style={{ fontSize:8,color:C.muted,marginBottom:3 }}>Signal</div>
                        <div style={{ fontSize:13,fontWeight:900,color:game.totalSignal.direction==="OVER"?C.green:C.amber }}>
                          {game.totalSignal.direction} <span style={{ fontSize:9,color:C.muted }}>({game.totalSignal.confidence}%)</span>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              )}
              {/* Quarter predictions */}
              {game.quarterPredictions?.length > 0 && (
                <div style={{ marginBottom:14 }}>
                  <SectionLabel>Quarter Predictions</SectionLabel>
                  <div style={{ display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:6 }}>
                    {game.quarterPredictions.map((q,i) => (
                      <div key={i} style={{ background:C.surface,border:`1px solid ${C.border}`,borderRadius:8,padding:"8px 6px",textAlign:"center" }}>
                        <div style={{ fontSize:7,color:C.muted,fontWeight:800,marginBottom:4 }}>{q.quarter}</div>
                        {q.actual
                          ? <>
                              <div style={{ fontSize:10,fontWeight:800,color:q.winner==="home"?C.text:C.muted,fontFamily:'"JetBrains Mono",monospace' }}>{q.homeScore}</div>
                              <div style={{ fontSize:9,color:C.muted,margin:"2px 0" }}>—</div>
                              <div style={{ fontSize:10,fontWeight:800,color:q.winner==="away"?C.text:C.muted,fontFamily:'"JetBrains Mono",monospace' }}>{q.awayScore}</div>
                            </>
                          : <>
                              <div style={{ fontSize:9,fontWeight:700,color:q.winner==="home"?BB:C.muted }}>{q.homeEst}</div>
                              <div style={{ fontSize:8,color:C.muted,margin:"2px 0" }}>—</div>
                              <div style={{ fontSize:9,fontWeight:700,color:q.winner==="away"?BB:C.muted }}>{q.awayEst}</div>
                            </>
                        }
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
          {/* PLAYERS */}
          {tab==="players" && (
            <div style={{ display:"flex",flexDirection:"column",gap:18 }}>
              {[{label:game.homeTeam,players:game.homePlayers},{label:game.awayTeam,players:game.awayPlayers}].map(({label,players}) => (
                <div key={label}>
                  <SectionLabel>{label}</SectionLabel>
                  <PlayerTable players={players} C={C} />
                </div>
              ))}
            </div>
          )}
          {/* FORM */}
          {tab==="form" && (
            <div style={{ display:"flex",flexDirection:"column",gap:14 }}>
              {[{label:game.homeTeam,form:game.homeForm,record:game.homeRecord},{label:game.awayTeam,form:game.awayForm,record:game.awayRecord}].map(({label,form,record}) => (
                <div key={label} style={{ background:C.surface,border:`1px solid ${C.border}`,borderRadius:10,padding:"12px 14px" }}>
                  <div style={{ fontSize:10,fontWeight:800,color:C.text,marginBottom:8 }}>{label}</div>
                  {record && (
                    <div style={{ display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:6,marginBottom:10 }}>
                      {[{label:"W",value:record.wins,color:C.green},{label:"L",value:record.losses,color:C.red},{label:"PPG",value:record.avgPtsFor?.toFixed(1)},{label:"OPP",value:record.avgPtsAgainst?.toFixed(1)}].map(s => (
                        <div key={s.label} style={{ textAlign:"center" }}>
                          <div style={{ fontSize:14,fontWeight:900,color:s.color||C.text,fontFamily:'"JetBrains Mono",monospace' }}>{s.value??"—"}</div>
                          <div style={{ fontSize:7,color:C.muted,letterSpacing:".08em" }}>{s.label}</div>
                        </div>
                      ))}
                    </div>
                  )}
                  {form && (
                    <div style={{ display:"flex",gap:3 }}>
                      {form.split("").map((r,i) => (
                        <div key={i} style={{ width:18,height:18,borderRadius:"50%",background:r==="W"?`${C.green}22`:`${C.red}22`,border:`1px solid ${r==="W"?C.green:C.red}55`,display:"flex",alignItems:"center",justifyContent:"center",fontSize:8,fontWeight:800,color:r==="W"?C.green:C.red }}>
                          {r}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
          {/* ODDS */}
          {tab==="odds" && (
            <div>
              {game.odds ? (
                Object.entries(game.odds).map(([market,choices]) => (
                  <div key={market} style={{ marginBottom:14 }}>
                    <SectionLabel>{market}</SectionLabel>
                    <div style={{ display:"flex",flexWrap:"wrap",gap:6 }}>
                      {Object.entries(choices).map(([name,frac]) => {
                        // Shared with BasketballEngine.js — one parser, not two.
                        const decNum = fractionalToDecimal(frac);
                        const dec = decNum != null ? decNum.toFixed(2) : null;
                        return (
                          <div key={name} style={{ background:C.surface,border:`1px solid ${C.border}`,borderRadius:8,padding:"6px 10px",fontSize:9 }}>
                            <div style={{ color:C.muted,fontWeight:700,marginBottom:2 }}>{name}</div>
                            <div style={{ color:C.text,fontWeight:900,fontFamily:'"JetBrains Mono",monospace' }}>{dec?`${dec}x`:frac??"—"}</div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                ))
              ) : (
                <div style={{ textAlign:"center",padding:"40px 0",color:C.muted,fontSize:10 }}>No odds data available</div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── GAME CARD ────────────────────────────────────────────────────────────────
function GameCard({ game, draftLegs, onAddToDraft, onDetail, C }) {
  const hasScore  = game.homeScore != null && game.awayScore != null;
  const homeAhead = hasScore && game.homeScore > game.awayScore;
  const awayAhead = hasScore && game.awayScore > game.homeScore;

  return (
    <div style={{ background:C.surface,border:`1px solid ${C.border}`,borderRadius:14,padding:"14px 16px",transition:"border-color .15s" }}>
      {/* Top row */}
      <div style={{ display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:10 }}>
        <span style={{ fontSize:8,color:BB,fontWeight:800,letterSpacing:".08em",textTransform:"uppercase",display:"inline-flex",alignItems:"center",gap:4 }}>
          <BballIcon size={10} color={BB} />
          {game.tournament ?? game.league ?? "Basketball"}
        </span>
        <StatusPill status={game.status} statusCode={game.statusCode} startTime={game.startTime} C={C} />
      </div>
      {/* Score row */}
      <div style={{ display:"flex",alignItems:"center",gap:0,marginBottom:12 }}>
        <div style={{ flex:1,minWidth:0 }}>
          <div style={{ fontSize:10,fontWeight:900,color:C.text,letterSpacing:".05em",textTransform:"uppercase",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",marginBottom:3 }}>{game.homeTeam}</div>
          {hasScore
            ? <div style={{ fontSize:26,fontWeight:900,color:homeAhead?C.text:C.muted,fontFamily:'"JetBrains Mono","Courier New",monospace',lineHeight:1 }}>{game.homeScore}</div>
            : <div style={{ fontSize:11,fontWeight:800,color:BB }}>{game.homeWinProb}%</div>
          }
        </div>
        <div style={{ width:48,flexShrink:0,padding:"0 4px" }}>
          <CourtArc C={C} />
          {!hasScore && <div style={{ textAlign:"center",fontSize:7,color:C.muted,marginTop:2,letterSpacing:".06em" }}>VS</div>}
        </div>
        <div style={{ flex:1,minWidth:0,textAlign:"right" }}>
          <div style={{ fontSize:10,fontWeight:900,color:C.text,letterSpacing:".05em",textTransform:"uppercase",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",marginBottom:3 }}>{game.awayTeam}</div>
          {hasScore
            ? <div style={{ fontSize:26,fontWeight:900,color:awayAhead?C.text:C.muted,fontFamily:'"JetBrains Mono","Courier New",monospace',lineHeight:1 }}>{game.awayScore}</div>
            : <div style={{ fontSize:11,fontWeight:800,color:C.text }}>{game.awayWinProb}%</div>
          }
        </div>
      </div>
      {/* Quarter scores */}
      {hasScore && game.scoreByQuarter && (
        <div style={{ marginBottom:12 }}>
          <QuarterScoreRow quarters={game.scoreByQuarter} C={C} />
        </div>
      )}
      {/* Best pick */}
      {game.bestPick && (
        <div style={{ display:"flex",alignItems:"center",justifyContent:"space-between",background:BB_DIM,border:`1px solid ${BB_RING}`,borderRadius:9,padding:"8px 10px",marginBottom:10 }}>
          <div style={{ minWidth:0,flex:1,marginRight:10 }}>
            <div style={{ fontSize:10,fontWeight:800,color:BB,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap" }}>{game.bestPick.pick}</div>
            <div style={{ fontSize:7,color:C.muted,marginTop:1 }}>{game.bestPick.market}</div>
          </div>
          <div style={{ display:"flex",alignItems:"center",gap:10,flexShrink:0 }}>
            <span style={{ fontSize:13,fontWeight:900,color:confColor(game.bestPick.confidence,C) }}>{game.bestPick.confidence}%</span>
            <span style={{ fontSize:10,fontWeight:700,color:C.text,fontFamily:'"JetBrains Mono",monospace' }}>{oddsLabel(game.bestPick.odds)}</span>
          </div>
        </div>
      )}
      {/* Total signal */}
      {game.totalSignal && (
        <div style={{ display:"flex",alignItems:"center",gap:6,marginBottom:10 }}>
          <span style={{ fontSize:8,color:C.muted,fontWeight:700,letterSpacing:".06em" }}>O/U {game.totalSignal.line}</span>
          <span style={{ fontSize:8,fontWeight:800,color:game.totalSignal.direction==="OVER"?C.green:C.amber }}>→ {game.totalSignal.direction}</span>
          <span style={{ fontSize:8,color:C.muted }}>{game.totalSignal.confidence}%</span>
        </div>
      )}
      {/* Actions */}
      <div style={{ display:"flex",gap:8,alignItems:"center" }}>
        {game.bestPick && <DraftButton game={game} pick={game.bestPick} draftLegs={draftLegs} onAddToDraft={onAddToDraft} C={C} />}
        <button onClick={() => onDetail(game)} style={{ padding:"5px 12px",fontSize:9,fontWeight:800,borderRadius:7,cursor:"pointer",border:`1px solid ${C.border}`,background:"none",color:C.text,letterSpacing:".06em",fontFamily:"var(--font,inherit)" }}>
          Details →
        </button>
      </div>
    </div>
  );
}

// ─── BASKETBALL GAME LIST — pure renderer, no own fetch ───────────────────────
// Takes `games` array (enriched by BasketballEngine) and renders them.
// All fetch, date, loading state lives in App.jsx.
export function BasketballGameList({ games = [], C, draftLegs = [], onAddToDraft }) {
  const [detailGame, setDetailGame] = useState(null);

  return (
    <div>
      {games.map(game => (
        <div key={game.eventId} style={{ marginBottom:10 }}>
          <GameCard
            game={game}
            draftLegs={draftLegs}
            onAddToDraft={onAddToDraft}
            onDetail={setDetailGame}
            C={C}
          />
        </div>
      ))}
      {detailGame && (
        <GameDetailOverlay
          game={detailGame}
          draftLegs={draftLegs}
          onAddToDraft={onAddToDraft}
          onClose={() => setDetailGame(null)}
          C={C}
        />
      )}
    </div>
  );
}

// ─── BASKETBALL ROLLOVER VIEW — pure renderer ─────────────────────────────────
// Takes `rolloverPick` and `pool` from App.jsx state.
export function BasketballRolloverView({ rolloverPick, pool, C }) {
  const [step,  setStep]  = useState(1);
  const [stake, setStake] = useState(10);
  const [chain, setChain] = useState([]);

  const currentStake = chain.reduce((s, e) => {
    if (e.result === "WIN")  return parseFloat((s * e.odds).toFixed(2));
    if (e.result === "LOSS") return stake;
    return s;
  }, stake);

  const markResult = (result) => {
    if (!rolloverPick) return;
    setChain(prev => [...prev, { step, pick: rolloverPick.label, odds: rolloverPick.combinedOdds, result }]);
    if (result === "WIN") setStep(s => s + 1);
    else setStep(1);
  };

  return (
    <div>
      {/* Step + stake counters */}
      <div style={{ display:"flex",gap:10,alignItems:"center",marginBottom:18 }}>
        {[
          { label:"CURRENT STEP",   value:`${step}/10`, color:BB, mono:true },
          { label:"CURRENT STAKE",  value:`$${currentStake.toFixed(2)}`, color:C.text, mono:true },
        ].map(s => (
          <div key={s.label} style={{ background:C.surface,border:`1px solid ${s.color===BB?BB_RING:C.border}`,borderRadius:10,padding:"10px 14px",flex:1,textAlign:"center" }}>
            <div style={{ fontSize:22,fontWeight:900,color:s.color,fontFamily:'"JetBrains Mono",monospace' }}>{s.value}</div>
            <div style={{ fontSize:8,color:C.muted,marginTop:2,letterSpacing:".08em" }}>{s.label}</div>
          </div>
        ))}
        <div style={{ background:C.surface,border:`1px solid ${C.border}`,borderRadius:10,padding:"10px 14px",flex:1 }}>
          <div style={{ fontSize:8,color:C.muted,marginBottom:4,letterSpacing:".08em" }}>BASE STAKE $</div>
          <input type="number" value={stake} min={1} onChange={e=>setStake(parseFloat(e.target.value)||10)}
            style={{ width:"100%",fontSize:13,fontWeight:800,background:"none",border:"none",color:C.text,fontFamily:'"JetBrains Mono",monospace',outline:"none",padding:0 }} />
        </div>
      </div>

      {/* Step track */}
      <div style={{ display:"flex",gap:4,marginBottom:20 }}>
        {Array.from({length:10},(_,i) => {
          const sn = i+1, done = chain.find(c=>c.step===sn);
          return (
            <div key={i} style={{ flex:1,height:6,borderRadius:3,background:done?.result==="WIN"?C.green:done?.result==="LOSS"?C.red:sn===step?BB:C.border,transition:"background .2s" }} />
          );
        })}
      </div>

      {/* Rollover pick */}
      {rolloverPick ? (
        <div style={{ background:C.surface,border:`1px solid ${BB_RING}`,borderRadius:14,padding:16,marginBottom:16 }}>
          <div style={{ display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:12 }}>
            <div>
              <div style={{ fontSize:9,color:BB,fontWeight:800,letterSpacing:".1em",textTransform:"uppercase",marginBottom:4 }}>{rolloverPick.label}</div>
              <div style={{ fontSize:13,fontWeight:900,color:C.text }}>{rolloverPick.legs.map(l=>l.pick).join(" + ")}</div>
            </div>
            <div style={{ textAlign:"right" }}>
              <div style={{ fontSize:20,fontWeight:900,color:BB,fontFamily:'"JetBrains Mono",monospace' }}>{rolloverPick.combinedOdds}x</div>
              <div style={{ fontSize:8,color:C.muted }}>{rolloverPick.combinedConfidence}% conf</div>
            </div>
          </div>
          {rolloverPick.legs.map((leg,i) => (
            <div key={i} style={{ display:"flex",justifyContent:"space-between",alignItems:"center",padding:"7px 0",borderTop:`1px solid ${C.border}22`,fontSize:9 }}>
              <div style={{ minWidth:0,flex:1,marginRight:10 }}>
                <div style={{ fontWeight:700,color:C.text,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap" }}>{leg.game}</div>
                <div style={{ color:C.muted,marginTop:1 }}>{leg.basis}</div>
              </div>
              <div style={{ display:"flex",gap:8,flexShrink:0,alignItems:"center" }}>
                <span style={{ fontWeight:800,color:confColor(leg.confidence,C) }}>{leg.confidence}%</span>
                <span style={{ fontWeight:700,color:C.text,fontFamily:'"JetBrains Mono",monospace' }}>{oddsLabel(leg.odds)}</span>
              </div>
            </div>
          ))}
          <div style={{ display:"flex",justifyContent:"space-between",marginTop:12,padding:"8px 0",borderTop:`1px solid ${C.border}` }}>
            <span style={{ fontSize:9,color:C.muted,fontWeight:700 }}>If WIN — return</span>
            <span style={{ fontSize:11,fontWeight:900,color:C.green,fontFamily:'"JetBrains Mono",monospace' }}>
              ${(currentStake*rolloverPick.combinedOdds).toFixed(2)}
            </span>
          </div>
          <div style={{ display:"flex",gap:8,marginTop:14 }}>
            <button onClick={()=>markResult("WIN")} style={{ flex:1,padding:"10px 0",fontSize:10,fontWeight:900,borderRadius:9,cursor:"pointer",background:`${C.green}18`,border:`1px solid ${C.green}40`,color:C.green,fontFamily:"inherit",letterSpacing:".06em" }}>✓ WIN</button>
            <button onClick={()=>markResult("LOSS")} style={{ flex:1,padding:"10px 0",fontSize:10,fontWeight:900,borderRadius:9,cursor:"pointer",background:`${C.red}12`,border:`1px solid ${C.red}35`,color:C.red,fontFamily:"inherit",letterSpacing:".06em" }}>✕ LOSS</button>
          </div>
        </div>
      ) : (
        <div style={{ textAlign:"center",padding:"40px 0",color:C.muted }}>
          <div style={{ display:"flex",justifyContent:"center",marginBottom:10 }}><BballIcon size={32} color={C.muted} /></div>
          <div style={{ fontSize:11,fontWeight:700,letterSpacing:".1em",textTransform:"uppercase" }}>No rollover pick found</div>
          <div style={{ fontSize:9,marginTop:6 }}>No eligible picks with ≥60% confidence and ≥1.50 odds today</div>
        </div>
      )}

      {/* Pool */}
      {pool?.length > 0 && (
        <div>
          <SectionLabel>Full Pool · {pool.length} eligible picks</SectionLabel>
          <div style={{ display:"flex",flexDirection:"column",gap:6 }}>
            {pool.map((p,i) => (
              <div key={i} style={{ display:"flex",alignItems:"center",gap:10,padding:"8px 12px",background:C.surface,borderRadius:9,border:`1px solid ${C.border}` }}>
                <div style={{ fontSize:8,fontWeight:800,color:BB,width:16,flexShrink:0,textAlign:"center" }}>{i+1}</div>
                <div style={{ flex:1,minWidth:0 }}>
                  <div style={{ fontSize:9,fontWeight:700,color:C.text,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap" }}>{p.pick}</div>
                  <div style={{ fontSize:8,color:C.muted }}>{p.game}</div>
                </div>
                <div style={{ display:"flex",gap:10,flexShrink:0,alignItems:"center" }}>
                  <span style={{ fontSize:10,fontWeight:900,color:confColor(p.confidence,C) }}>{p.confidence}%</span>
                  <span style={{ fontSize:9,fontWeight:700,color:C.text,fontFamily:'"JetBrains Mono",monospace' }}>{oddsLabel(p.odds)}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Chain history */}
      {chain.length > 0 && (
        <div style={{ marginTop:20 }}>
          <div style={{ display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:8 }}>
            <SectionLabel>Chain History</SectionLabel>
            <button onClick={()=>{setChain([]);setStep(1);}} style={{ fontSize:8,color:C.muted,background:"none",border:`1px solid ${C.border}`,borderRadius:6,padding:"3px 8px",cursor:"pointer",fontFamily:"inherit" }}>Reset</button>
          </div>
          <div style={{ display:"flex",flexDirection:"column",gap:4 }}>
            {chain.map((e,i) => (
              <div key={i} style={{ display:"flex",alignItems:"center",gap:10,padding:"6px 10px",background:C.surface,borderRadius:8,border:`1px solid ${e.result==="WIN"?C.green:C.red}25`,fontSize:9 }}>
                <span style={{ fontSize:7,color:C.muted,fontWeight:700,width:20,flexShrink:0 }}>S{e.step}</span>
                <span style={{ flex:1,color:C.text,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap" }}>{e.pick}</span>
                <span style={{ fontWeight:900,color:e.result==="WIN"?C.green:C.red }}>{e.result}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
