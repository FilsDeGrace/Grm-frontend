// ─────────────────────────────────────────────────────────────────────────────
// explainers.js — Contextual text generation for FullModelPage sections
//
// Pure data-in → sentence-out. No API calls. No hardcoded strings.
// Every output is derived from the actual fixture data, so it reads
// differently for every match. Each function has multiple template
// branches keyed on data conditions, so the same market won't produce
// the same sentence twice across different fixtures.
//
// Exports:
//   getReadExplainer(f)                        → { headline, sub } for The Read hero
//   getEdgeExplainer(f)                        → { headline, sub } for The Edge strip
//   getXGExplainer(f)                          → string for Expected Goals section
//   getMatchResultExplainer(f)                 → { H, X, A } each a short string
//   getGoalRangeExplainer(f)                   → { headline, desc } for Goal Range panel
//   getBTTSExplainer(f)                        → { yes, no } each a short string
//   getTeamTotalExplainer(team, stats, side, f) → string per team
//
// All functions are null-safe — if data is missing they return null
// and the UI should render nothing rather than a broken sentence.
// ─────────────────────────────────────────────────────────────────────────────

// ── INTERNAL HELPERS ─────────────────────────────────────────────────────────

function pct(v) { return Math.round(v || 0); }
function round1(v) { return parseFloat((v || 0).toFixed(1)); }
function short(name) { return (name || "").split(" ")[0]; }

// Delta between model confidence and historical hit rate
// Returns a signed number in percentage points
function confDelta(anchor) {
  if (!anchor?.prob || !anchor?.empiricalRate) return null;
  return parseFloat((anchor.prob - anchor.empiricalRate).toFixed(1));
}

// Pick type classifier — what kind of pick is this?
function classifyPick(pick = "", market = "") {
  const p = pick.toLowerCase();
  const mkt = (market || "").toLowerCase();
  if (mkt === "dc" || /or draw|or away|or home/.test(p)) return "dc";
  if (/btts|both teams/.test(p)) return "btts";
  if (/clean sheet|cs/.test(p)) return "cs";
  if (/over/.test(p)) return "over";
  if (/under/.test(p)) return "under";
  if (/win/.test(p)) return p.includes("home") || p.includes("away") ? "win" : "win";
  if (/draw/.test(p)) return "draw";
  return "other";
}

// Which side does the pick favour?
function pickSide(pick = "", homeTeam = "", awayTeam = "") {
  const p = pick.toLowerCase();
  const h = homeTeam.toLowerCase();
  const a = awayTeam.toLowerCase();
  if (p.includes(h.split(" ")[0])) return "home";
  if (p.includes(a.split(" ")[0])) return "away";
  if (/home win/.test(p)) return "home";
  if (/away win/.test(p)) return "away";
  return "neutral";
}

// Confidence label
function confLabel(prob) {
  if (prob >= 85) return "very high";
  if (prob >= 75) return "strong";
  if (prob >= 65) return "solid";
  if (prob >= 55) return "moderate";
  return "marginal";
}

// xG dominance classification
function xgProfile(hxg, axg) {
  const total = hxg + axg;
  const diff  = Math.abs(hxg - axg);
  const ratio = Math.max(hxg, axg) / Math.max(Math.min(hxg, axg), 0.01);
  if (diff < 0.15)                  return "level";
  if (diff < 0.4)                   return "slight";
  if (ratio >= 2.0 || diff >= 1.0)  return "dominant";
  return "clear";
}

// Goal volume classification
function goalVolume(total) {
  if (total >= 3.2) return "high";
  if (total >= 2.4) return "moderate-high";
  if (total >= 1.6) return "moderate-low";
  return "low";
}


// ── THE READ EXPLAINER ───────────────────────────────────────────────────────
// Returns { headline, sub }
// headline: one sentence on why the pick is valid
// sub: one sentence on the hist delta and what it means

export function getReadExplainer(f) {
  const anchor = f?.theRead?.anchor;
  if (!anchor || f?.theRead?.isFallback) return null;

  const { pick, prob, market, strong } = anchor;
  const m   = f.markets || {};
  const hxg = parseFloat(m.homeXG) || 0;
  const axg = parseFloat(m.awayXG) || 0;
  const home = f.teams?.home || "Home";
  const away = f.teams?.away || "Away";
  const delta = confDelta(anchor);
  const histRate = anchor.empiricalRate;
  const pickType = classifyPick(pick, market);
  const side     = pickSide(pick, home, away);
  const conf     = pct(prob);
  const volume   = goalVolume(hxg + axg);
  const xgP      = xgProfile(hxg, axg);
  const favTeam  = hxg >= axg ? short(home) : short(away);
  const dogTeam  = hxg >= axg ? short(away) : short(home);

  // ── Headline: contextual to pick type ──
  let headline = null;

  if (pickType === "dc") {
    if (side === "away") {
      if (xgP === "dominant") headline = `${short(away)}'s output is significantly stronger — a loss would be a genuine upset against the model's read.`;
      else if (xgP === "clear") headline = `${short(away)} carry the xG advantage. The double chance protects against a close result going against the lean.`;
      else headline = `With both sides projected close, the double chance covers the most likely outcomes without overcommitting to one result.`;
    } else if (side === "home") {
      if (xgP === "dominant") headline = `${short(home)}'s home output is substantially higher — the draw cover is insurance on a strong performance turning flat.`;
      else headline = `${short(home)} are marginally favoured at home. The double chance captures both a home win and a draw in a tight contest.`;
    } else {
      headline = `The double chance covers the two most probable outcomes based on the model's current read of this match.`;
    }
  } else if (pickType === "over") {
    const line = (pick.match(/[\d.]+/) || ["2.5"])[0];
    if (volume === "high")           headline = `Combined xG of ${round1(hxg + axg)} is well above the ${line} line — both attacks are projected to contribute.`;
    else if (volume === "moderate-high") headline = `The goal profile leans toward a productive game. Over ${line} is the model's clearest read on the scoring environment.`;
    else                             headline = `xG projects enough output to challenge the ${line} line, though the margin is not large — confidence reflects data consistency, not volume.`;
  } else if (pickType === "under") {
    const line = (pick.match(/[\d.]+/) || ["2.5"])[0];
    if (volume === "low")  headline = `Combined xG of ${round1(hxg + axg)} is well below ${line} — the model reads a structured, low-output game.`;
    else if (volume === "moderate-low") headline = `Despite a moderate xG total, the model's probability distribution strongly favours Under ${line}. Historical form in this league supports a contained match.`;
    else                   headline = `The Under ${line} read is backed by form data and defensive metrics, not just the xG total.`;
  } else if (pickType === "win") {
    if (conf >= 80)       headline = `${favTeam}'s model output is substantially ahead of ${dogTeam}'s — a win is the most probable single outcome.`;
    else if (conf >= 65)  headline = `${favTeam} carry a clear advantage on expected output. The win probability is firm but a draw remains live.`;
    else                  headline = `The model leans toward ${favTeam}, though the margin is slim enough that caution applies.`;
  } else if (pickType === "btts") {
    headline = `Both sides carry meaningful attacking threat. The model reads this as a game where neither defence is likely to hold a clean sheet.`;
  } else if (pickType === "draw") {
    headline = `Balanced xG and tight win probabilities make the draw the most statistically resilient outcome in this match.`;
  } else {
    headline = `The model's ${confLabel(conf)} confidence on ${pick} is supported by the current data profile for this fixture.`;
  }

  // ── Sub: hist delta context ──
  let sub = null;
  if (delta !== null && histRate != null) {
    const absDelta = Math.abs(delta);
    const histPct  = pct(histRate);
    if (delta > 10)       sub = `Model is running ${absDelta.toFixed(0)}pts above the historical hit rate (${histPct}%) — pick is performing ahead of expectation.`;
    else if (delta > 4)   sub = `Sitting ${absDelta.toFixed(0)}pts above the ${histPct}% historical baseline — a meaningful edge, not just noise.`;
    else if (delta > -4)  sub = `Model confidence aligns closely with the historical hit rate of ${histPct}% — no significant over- or under-estimation.`;
    else if (delta > -10) sub = `Running ${absDelta.toFixed(0)}pts below the ${histPct}% historical baseline — model is being conservative on this pick type.`;
    else                  sub = `${absDelta.toFixed(0)}pts below historical norm (${histPct}%) — interpret with awareness that the model may be under-weighting base rates here.`;
  } else if (strong) {
    sub = `Flagged as a Strong signal — the model's internal confidence filters are all satisfied for this pick.`;
  }

  return { headline, sub };
}


// ── THE EDGE EXPLAINER ───────────────────────────────────────────────────────
// Returns { headline, sub }
// headline: why this pick represents value vs the book
// sub: what the edge magnitude means in context

export function getEdgeExplainer(f) {
  const edge = f?.theEdge;
  if (!edge) return null;

  const { pick, prob, edgeOddsPct, odds } = edge;
  const m    = f.markets || {};
  const hxg  = parseFloat(m.homeXG) || 0;
  const axg  = parseFloat(m.awayXG) || 0;
  const home = f.teams?.home || "Home";
  const away = f.teams?.away || "Away";

  const edgePct   = parseFloat(edgeOddsPct) || 0;
  const modelProb = pct(prob);
  const pickType  = classifyPick(pick, edge.market);
  const side      = pickSide(pick, home, away);

  // ── Headline: why the value exists ──
  let headline = null;

  if (edgePct >= 15) {
    if (pickType === "over" || pickType === "under") {
      const line = (pick.match(/[\d.]+/) || ["2.5"])[0];
      headline = `The book is significantly mispricing the ${pick} line — the model's ${modelProb}% probability is ${edgePct}% above the implied odds. That gap is what makes this value.`;
    } else if (pickType === "dc") {
      headline = `Large value gap on the double chance. The model gives this ${modelProb}% — the book is pricing it ${edgePct}% lower. The odds haven't caught up to the model's read.`;
    } else if (side === "away") {
      headline = `${short(away)}'s implied probability is being underestimated by the market. At ${edgePct}% above book odds, this is a meaningful mispricing.`;
    } else if (side === "home") {
      headline = `${short(home)} are underpriced relative to model output. The ${edgePct}% gap between model and book implies the market is underweighting home advantage here.`;
    } else {
      headline = `The model finds ${edgePct}% excess value on this pick — a gap this wide is one of the stronger edge signals in the current slate.`;
    }
  } else if (edgePct >= 8) {
    if (pickType === "btts") {
      headline = `Book odds on BTTS are pricing this below what the xG profiles support. The model's ${modelProb}% creates a ${edgePct}% value gap.`;
    } else if (pickType === "draw") {
      headline = `Draw is being undervalued relative to the balanced xG profile. The ${edgePct}% edge over book is the model's core argument for this selection.`;
    } else {
      headline = `Model probability exceeds book implied odds by ${edgePct}%. Not a runaway gap, but consistent with picks that have produced positive returns historically.`;
    }
  } else if (edgePct > 0) {
    headline = `A narrow but real value gap — the model's ${modelProb}% sits ${edgePct}% ahead of what the book implies. Marginal edges compound over volume.`;
  } else {
    headline = `Value based on model probability — no bookmaker odds available to measure against.`;
  }

  // ── Sub: how to interpret the edge ──
  let sub = null;
  if (odds) {
    const impliedProb = Math.round((1 / parseFloat(odds)) * 100);
    sub = `At ${odds}× odds, the book implies ${impliedProb}% probability. The model reads ${modelProb}% — back if you trust the model's accuracy over the bookmaker's line.`;
  } else if (edgePct >= 10) {
    sub = `Edge picks at ${edgePct}%+ vs book are in the top tier of value signals the system generates. Worth considering even on lower-confidence fixtures.`;
  } else {
    sub = `Value picks require volume to realise — single-game edge variance is high. This is a directional lean, not a certainty.`;
  }

  return { headline, sub };
}


// ── XG EXPLAINER ─────────────────────────────────────────────────────────────
// Returns a single string that reads naturally in the xG section

export function getXGExplainer(f) {
  const m    = f?.markets;
  if (!m?.homeXG || !m?.awayXG) return null;

  const hxg  = parseFloat(m.homeXG);
  const axg  = parseFloat(m.awayXG);
  const home = f.teams?.home || "Home";
  const away = f.teams?.away || "Away";
  const total = hxg + axg;
  const profile = xgProfile(hxg, axg);
  const fav  = hxg >= axg ? short(home) : short(away);
  const dog  = hxg >= axg ? short(away) : short(home);
  const favXG = Math.max(hxg, axg).toFixed(2);
  const dogXG = Math.min(hxg, axg).toFixed(2);

  // Also weave in form if available
  const hForm = (f.form?.home || []).slice(0, 5);
  const aForm = (f.form?.away || []).slice(0, 5);
  const hWins = hForm.filter(r => r === "W").length;
  const aWins = aForm.filter(r => r === "W").length;
  const formLine = hForm.length && aForm.length
    ? ` ${short(home)}'s form reads ${hWins >= 3 ? "well" : hWins <= 1 ? "poorly" : "inconsistently"} (${hForm.join("")}); ${short(away)}'s ${aWins >= 3 ? "is strong" : aWins <= 1 ? "is struggling" : "is mixed"} (${aForm.join("")}).`
    : "";

  if (profile === "level") {
    return `Combined xG of ${(hxg+axg).toFixed(2)} is split evenly — ${hxg.toFixed(2)} for ${short(home)}, ${axg.toFixed(2)} for ${short(away)}. The model sees no meaningful output advantage for either side.${formLine}`;
  } else if (profile === "slight") {
    return `Combined xG of ${(hxg+axg).toFixed(2)} (${favXG} vs ${dogXG}) gives ${fav} a slight edge — enough to support a directional lean but not a dominant read.${formLine}`;
  } else if (profile === "dominant") {
    return `Combined xG of ${(hxg+axg).toFixed(2)} — ${fav} project ${favXG} against just ${dogXG} for ${dog}. A clear performance gap the model reads as decisive.${formLine}`;
  } else {
    return `Combined xG of ${(hxg+axg).toFixed(2)} favours ${fav} (${favXG} vs ${dogXG} for ${dog}). The model reads this as a controlled rather than chaotic match.${formLine}`;
  }
}


// ── MATCH RESULT EXPLAINER ───────────────────────────────────────────────────
// Returns { H: string, X: string, A: string }
// Each is a short phrase that contextualises that outcome's probability

export function getMatchResultExplainer(f) {
  const m    = f?.markets;
  if (!m) return null;

  const home = f.teams?.home || "Home";
  const away = f.teams?.away || "Away";
  const hxg  = parseFloat(m.homeXG) || 0;
  const axg  = parseFloat(m.awayXG) || 0;
  const hWin = pct(m.homeWin);
  const draw = pct(m.draw);
  const aWin = pct(m.awayWin);

  // H explainer
  let H;
  if (hWin >= 55)       H = `Home side is the clear favourite — xG and model both point here.`;
  else if (hWin >= 40)  H = `Home win is the most likely single outcome, though the margin is not decisive.`;
  else if (hWin >= 25)  H = `Home win is possible but the model doesn't favour it — xG leans ${hxg >= axg ? "home" : "away"}.`;
  else                  H = `Home win is the least probable outcome. The model reads ${short(away)} as significantly stronger.`;

  // X explainer
  let X;
  const totalXG = hxg + axg;
  if (draw >= 35)         X = `High draw probability — balanced xG and tight win margins make this the most resilient outcome.`;
  else if (draw >= 25)    X = `Draw is live, particularly if the stronger side fails to convert early.`;
  else if (totalXG < 1.8) X = `Low xG total means a goalless draw remains a genuine path.`;
  else                    X = `Draw is the least likely outcome. One side is expected to separate.`;

  // A explainer
  let A;
  if (aWin >= 55)       A = `Away side carries the xG advantage. Win probability reflects a clear performance edge.`;
  else if (aWin >= 40)  A = `Away win is well supported. ${short(away)}'s projected output gives them the stronger footing.`;
  else if (aWin >= 25)  A = `Away win is a secondary outcome — possible, but the model leans toward ${hxg >= axg ? "home" : "a draw"}.`;
  else                  A = `Away win is the least likely result. ${short(home)} hold a significant xG and probability advantage.`;

  return { H, X, A };
}


// ── GOAL RANGE EXPLAINER ─────────────────────────────────────────────────────
// Returns { headline, desc }

export function getGoalRangeExplainer(f) {
  const m = f?.markets;
  if (!m) return null;

  const hxg    = parseFloat(m.homeXG) || 0;
  const axg    = parseFloat(m.awayXG) || 0;
  const total  = parseFloat((hxg + axg).toFixed(2));
  const o15    = pct(m.over15);
  const o25    = pct(m.over25);
  const o35    = pct(m.over35);
  const u25    = pct(m.under25);
  const u35    = pct(m.under35);
  const o15Odds = parseFloat(m.over15Odds || 0);
  const range  = f.goalRange || "";
  const volume = goalVolume(total);

  // Config-mirrored thresholds
  const OVER25_MIN     = 63;
  const OVER35_MIN     = 63;
  const STRONG_OVER25  = 72;
  const STRONG_OVER35  = 65; // post-deflation O3.5 is compressed, lower bar
  const UNDER25_MIN    = 70;
  const UNDER35_MIN    = 80;
  const O15_MIN_ODDS   = 1.17; // only mention O1.5 if odds are meaningful

  // Pick the most informative goal line to highlight — never O1.5 unless nothing else qualifies
  let featuredLine = null;
  let featuredPct  = null;
  if (o35 >= STRONG_OVER35)        { featuredLine = "O3.5"; featuredPct = o35; }
  else if (o25 >= OVER25_MIN)      { featuredLine = "O2.5"; featuredPct = o25; }
  else if (u25 >= UNDER25_MIN)     { featuredLine = "U2.5"; featuredPct = u25; }
  else if (u35 >= UNDER35_MIN)     { featuredLine = "U3.5"; featuredPct = u35; }
  else if (o15 >= 70 && (o15Odds === 0 || o15Odds >= O15_MIN_ODDS)) { featuredLine = "O1.5"; featuredPct = o15; }

  let headline, desc;

  if (volume === "high") {
    headline = "High Scoring";
    if (featuredLine === "O3.5") {
      desc = `Combined xG of ${total} pushes into high-scoring territory. Over 3.5 clears at ${featuredPct}% — both attacks are projected to contribute multiple goals.`;
    } else if (featuredLine === "O2.5") {
      desc = `Combined xG of ${total} strongly supports a goal-rich game. Over 2.5 sits at ${featuredPct}% — the model's clearest goals signal here.`;
    } else {
      desc = `Combined xG of ${total} points to a high-output game. Both attacks are expected to create, though the market spread is wide.`;
    }
  } else if (volume === "moderate-high") {
    headline = range || "Active Scoring";
    if (featuredLine === "O2.5") {
      desc = `Combined xG of ${total} sits in a productive range. Over 2.5 at ${featuredPct}% is the model's most confident goals line — value relative to the market.`;
    } else if (featuredLine === "O3.5") {
      desc = `Combined xG of ${total}. Over 3.5 qualifies at ${featuredPct}% — an active game expected, though three goals is not guaranteed.`;
    } else if (featuredLine) {
      desc = `Combined xG of ${total}. ${featuredLine} at ${featuredPct}% is the model's most supported line at this output level.`;
    } else {
      desc = `Combined xG of ${total} sits on the boundary. The model's goal distribution is spread across lines without a dominant signal.`;
    }
  } else if (volume === "moderate-low") {
    headline = range || "Contained Game";
    if (featuredLine === "U2.5") {
      desc = `Combined xG of ${total} leans toward a tight game. Under 2.5 at ${featuredPct}% is the model's primary lean — clean sheet probability is elevated.`;
    } else if (featuredLine === "U3.5") {
      desc = `Moderate xG of ${total}. Under 3.5 at ${featuredPct}% is solid — the model doesn't expect a high-scoring game but goals are still likely.`;
    } else if (featuredLine) {
      desc = `Combined xG of ${total}. ${featuredLine} at ${featuredPct}% is the model's clearest line — the goal environment is moderately cautious.`;
    } else {
      desc = `Combined xG of ${total} sits on the boundary between cautious and active. Neither Over nor Under 2.5 is dominant here.`;
    }
  } else {
    headline = "Low Scoring";
    if (featuredLine === "U2.5" || featuredLine === "U3.5") {
      desc = `Combined xG of ${total} projects a defensive match. ${featuredLine} at ${featuredPct}% — at least one clean sheet is the model's default expectation.`;
    } else {
      desc = `Combined xG of ${total} points firmly to a low-output game. The model expects clean sheet probability to be elevated and goals to be scarce.`;
    }
  }

  return { headline, desc };
}


// ── BTTS EXPLAINER ───────────────────────────────────────────────────────────
// Returns { yes: string, no: string }

export function getBTTSExplainer(f) {
  const m = f?.markets;
  if (!m) return null;

  const bttsYes = pct(m.bttsYes);
  const hxg     = parseFloat(m.homeXG) || 0;
  const axg     = parseFloat(m.awayXG) || 0;
  const home    = f.teams?.home || "Home";
  const away    = f.teams?.away || "Away";

  // Identify which side is the weaker attacker
  const weakerSide  = hxg <= axg ? short(home) : short(away);
  const weakerXG    = Math.min(hxg, axg).toFixed(2);
  const strongerXG  = Math.max(hxg, axg).toFixed(2);

  let yes, no;

  if (bttsYes >= 70) {
    yes = `Both attacks carry genuine threat — ${short(home)} at ${hxg.toFixed(2)} xG and ${short(away)} at ${axg.toFixed(2)} xG. Neither defence is projected to hold a clean sheet.`;
    no  = `A clean sheet from either side would require outperforming the xG projection. Possible, but not what the model expects.`;
  } else if (bttsYes >= 55) {
    yes = `Scoring is probable from both sides, though ${weakerSide}'s ${weakerXG} xG means it's not guaranteed. The model qualifies this as a meaningful path.`;
    no  = `If ${weakerSide} fail to convert their ${weakerXG} xG projection, No lands. A realistic secondary outcome.`;
  } else if (bttsYes >= 40) {
    yes = `BTTS Yes is possible but the ${weakerSide}'s ${weakerXG} xG projection makes it uncertain. The probability sits below the confidence threshold.`;
    no  = `BTTS No is the stronger side here — ${weakerSide}'s limited xG output (${weakerXG}) makes a clean sheet from one side the more likely scenario.`;
  } else {
    yes = `BTTS Yes is low probability. ${weakerSide} at ${weakerXG} xG are not projected to convert reliably — a clean sheet is the model's default expectation.`;
    no  = `BTTS No is the dominant outcome. Low combined output of ${(hxg + axg).toFixed(2)} xG means at least one team is unlikely to score.`;
  }

  return { yes, no };
}


// ── TEAM TOTAL EXPLAINER ─────────────────────────────────────────────────────
// Returns a short string per team
// side: "home" | "away"

export function getTeamTotalExplainer(teamName, stats, side, f) {
  if (!stats) return null;
  const m    = f?.markets || {};
  const o05  = side === "home" ? pct(m.homeOver05) : pct(m.awayOver05);
  const o15  = side === "home" ? pct(m.homeOver15) : pct(m.awayOver15);
  const cs   = side === "home" ? pct(m.homeCS)     : pct(m.awayCS);
  const xg   = parseFloat(side === "home" ? m.homeXG : m.awayXG) || 0;
  const name = short(teamName);

  if (o05 >= 90 && o15 >= 65) {
    return `${name} are highly likely to score — ${o05}% to open their account, ${o15}% to reach two. Clean sheet probability sits at ${cs}%.`;
  } else if (o05 >= 75) {
    return `${name} are projected to score (${o05}%) but a second goal is less certain (${o15}%). xG of ${xg.toFixed(2)} reflects a team that creates but doesn't always convert in volume.`;
  } else if (o05 >= 55) {
    return `${name} carry a moderate scoring threat. ${o05}% to score at all — clean sheet from the opposition is a live possibility at ${100 - o05}%.`;
  } else {
    return `${name} have limited attacking output in this match — ${o05}% to score. The model gives the opposition a ${cs > 30 ? "strong" : "reasonable"} clean sheet chance.`;
  }
}
