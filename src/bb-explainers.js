// ─────────────────────────────────────────────────────────────────────────────
// bb-explainers.js — Contextual text generation for basketball fixtures
//
// Mirrors explainers.js's function signatures so FullModelPage can dispatch
// on f._sport without changing the render call sites' shape. Football's
// explainers.js is left completely untouched — zero regression risk.
//
// WHY A SEPARATE FILE (not a branch inside explainers.js):
//   getReadExplainer/getEdgeExplainer/getMatchResultExplainer in explainers.js
//   read f.markets.homeXG/awayXG unconditionally. Those are always null on a
//   basketball fixture (toFixtureShape sets them to null on purpose), so the
//   football versions silently degrade to null/generic output rather than
//   crashing — but the text they'd produce if BB ever populated fake xG
//   would be wrong (no xG concept exists in basketball). Keeping this as a
//   separate module means football's file never needs a sport branch, and
//   this file can read BB-native fields (_totalSignal, teamStats._winPct,
//   _avgPtsFor/_avgPtsAgainst) without those fields needing to exist on the
//   football shape at all.
//
// Exports (BB-relevant subset only — football-only sections like Goal Range,
// BTTS, xG don't exist for basketball, so there is no BB equivalent of
// getGoalRangeExplainer / getBTTSExplainer / getXGExplainer / getTeamTotalExplainer):
//   getReadExplainer(f)         → { headline, sub }   for HeroRead
//   getEdgeExplainer(f)         → { headline, sub }   for EdgeStrip (Total Signal)
//   getMatchResultExplainer(f)  → { H, A }             for Win Probability rows
//                                  (no X — basketball has no draw)
//
// All functions are null-safe — missing data returns null, and the UI
// renders nothing rather than a broken sentence (same contract as football's
// explainers.js).
// ─────────────────────────────────────────────────────────────────────────────

// ── INTERNAL HELPERS (intentionally duplicated from explainers.js rather
//    than imported — keeps this file a standalone, zero-coupling module) ──

function pct(v) { return Math.round(v || 0); }
function short(name) { return (name || "").split(" ")[0]; }

function confLabel(prob) {
  if (prob >= 85) return "very high";
  if (prob >= 75) return "strong";
  if (prob >= 65) return "solid";
  if (prob >= 55) return "moderate";
  return "marginal";
}

// Pick type classifier for basketball markets — "Moneyline" or "Total"
// are the only two bestPick markets BasketballEngine.selectBestPick() emits.
function classifyPick(market = "") {
  const mkt = (market || "").toLowerCase();
  if (mkt === "moneyline" || mkt === "ml") return "moneyline";
  if (mkt === "total")                     return "total";
  return "other";
}


// ── THE READ EXPLAINER ───────────────────────────────────────────────────────
// Returns { headline, sub }
// Basketball's anchor comes from BasketballEngine.selectBestPick():
//   { pick, market: "Moneyline"|"Total", prob, odds, empiricalRate: null }
// There's no BB backtest data yet, so empiricalRate is always null — the
// "sub" line leans on win-record / scoring-margin context instead of the
// hist-delta language football uses (which depends on empiricalRate).

export function getReadExplainer(f) {
  const anchor = f?.theRead?.anchor;
  if (!anchor || f?.theRead?.isFallback) return null;

  const { pick, prob, market } = anchor;
  const home = f.teams?.home || "Home";
  const away = f.teams?.away || "Away";
  const conf = pct(prob);
  const pickType = classifyPick(market);

  const homeStats = f.teamStats?.home;
  const awayStats = f.teamStats?.away;
  const homeWin   = pct(f.markets?.homeWin);
  const awayWin   = pct(f.markets?.awayWin);

  let headline = null;

  if (pickType === "moneyline") {
    const pickIsHome = pick?.toLowerCase().includes(short(home).toLowerCase());
    const favTeam  = pickIsHome ? short(home) : short(away);
    const favStats = pickIsHome ? homeStats : awayStats;
    const oppStats = pickIsHome ? awayStats : homeStats;
    const favWinPct = favStats?._winPct != null ? pct(favStats._winPct) : null;
    const oppWinPct = oppStats?._winPct != null ? pct(oppStats._winPct) : null;

    if (conf >= 80) {
      headline = favWinPct != null
        ? `${favTeam}'s model probability is decisive at ${conf}%, backed by a ${favWinPct}% win rate this season.`
        : `${favTeam}'s model output is substantially ahead — a win here is the model's clearest single-game read.`;
    } else if (conf >= 65) {
      headline = (favWinPct != null && oppWinPct != null)
        ? `${favTeam} carry a clear edge (${favWinPct}% win rate vs ${oppWinPct}%). The model's ${conf}% confidence is firm but not overwhelming.`
        : `${favTeam} carry a clear edge on the model's read. Confidence sits at ${conf}% — solid, not a blowout lean.`;
    } else {
      headline = `The model leans ${favTeam}, though at ${conf}% confidence the margin is slim enough that either side winning wouldn't surprise.`;
    }
  } else if (pickType === "total") {
    const line = (pick.match(/[\d.]+/) || [null])[0];
    const ts = f._totalSignal;
    if (ts) {
      const dirWord = ts.direction === "OVER" ? "above" : "below";
      headline = `Model projects ${ts.estimated} combined points, ${dirWord} the ${ts.line} market line — a ${ts.margin > 0 ? "+" : ""}${ts.margin}pt edge driving the ${ts.direction} read.`;
    } else {
      headline = `The model's ${confLabel(conf)} confidence on ${pick}${line ? ` (${line})` : ""} reflects the current scoring pace projection for this matchup.`;
    }
  } else {
    headline = `The model's ${confLabel(conf)} confidence on ${pick} is supported by the current data profile for this fixture.`;
  }

  // ── Sub: no empirical hist-rate data for BB yet, so lean on whichever
  // team-record context is available instead of inventing a fake delta. ──
  let sub = null;
  if (pickType === "moneyline" && homeStats?._avgPtsFor != null && awayStats?._avgPtsFor != null) {
    sub = `${short(home)} average ${homeStats._avgPtsFor} pts/g (${homeStats._avgPtsAgainst} allowed) · ${short(away)} average ${awayStats._avgPtsFor} pts/g (${awayStats._avgPtsAgainst} allowed).`;
  } else if (pickType === "moneyline" && (homeWin || awayWin)) {
    sub = `Model win probability: ${short(home)} ${homeWin}% · ${short(away)} ${awayWin}%.`;
  } else if (anchor.strong) {
    sub = `Flagged as a Strong signal — the model's internal confidence filters are all satisfied for this pick.`;
  } else if (pickType === "total" && f._totalSignal) {
    sub = `Confidence of ${f._totalSignal.confidence}% on this total — treat as directional rather than a hard lock if the margin is tight.`;
  }

  return { headline, sub };
}


// ── THE EDGE EXPLAINER (Total Signal) ────────────────────────────────────────
// Returns { headline, sub }
// Basketball doesn't run a book-odds-vs-model edge comparison the way
// football does (edgeOddsPct is always null on BB fixtures — see
// sportConfig.js theEdge construction) — theEdge here IS the totalSignal,
// surfaced only when it differs from the bestPick market. So "edge" means
// model-vs-market-total-line, not model-vs-bookmaker-implied-probability.

export function getEdgeExplainer(f) {
  const edge = f?.theEdge;
  if (!edge) return null;

  const { pick, prob } = edge;
  const ts = f._totalSignal;
  const modelProb = pct(prob);

  let headline = null;
  if (ts) {
    const dirWord = ts.direction === "OVER" ? "outpacing" : "falling short of";
    if (Math.abs(ts.margin) >= 8) {
      headline = `Model projects ${ts.estimated} points, ${dirWord} the ${ts.line} line by ${Math.abs(ts.margin)} — one of the wider total-points gaps on the slate.`;
    } else if (Math.abs(ts.margin) >= 4) {
      headline = `A real but moderate gap: model estimate of ${ts.estimated} sits ${Math.abs(ts.margin)} points ${ts.direction === "OVER" ? "above" : "below"} the ${ts.line} market line.`;
    } else {
      headline = `A narrow total-points lean — model estimate of ${ts.estimated} is close to the ${ts.line} line, so treat this as directional rather than a strong signal.`;
    }
  } else {
    headline = `Model probability of ${modelProb}% on ${pick} — no market-line comparison available for this total.`;
  }

  let sub = null;
  if (ts) {
    sub = `${ts.confidence}% model confidence on the ${ts.direction} read. Total-points signals carry single-game variance — pace and foul trouble can swing a final score well past the projection.`;
  } else {
    sub = `Value picks require volume to realise — single-game variance is high. This is a directional lean, not a certainty.`;
  }

  return { headline, sub };
}


// ── MATCH RESULT EXPLAINER (Win Probability) ─────────────────────────────────
// Returns { H, A } — no X, basketball has no draw.
// Uses win-pct and avg points for/against where available; falls back to
// pure model-probability framing when team record data isn't populated.

export function getMatchResultExplainer(f) {
  const m = f?.markets;
  if (!m) return null;

  const home = f.teams?.home || "Home";
  const away = f.teams?.away || "Away";
  const hWin = pct(m.homeWin);
  const aWin = pct(m.awayWin);

  const homeStats = f.teamStats?.home;
  const awayStats = f.teamStats?.away;
  const hWinPct = homeStats?._winPct != null ? pct(homeStats._winPct) : null;
  const aWinPct = awayStats?._winPct != null ? pct(awayStats._winPct) : null;

  let H;
  if (hWin >= 65) {
    H = hWinPct != null
      ? `${short(home)} are the clear favourite — model and season win rate (${hWinPct}%) both point here.`
      : `${short(home)} are the clear favourite on the model's read.`;
  } else if (hWin >= 50) {
    H = `${short(home)} are favoured, though the margin leaves room for an upset.`;
  } else if (hWin >= 35) {
    H = `${short(home)} can win this, but the model leans toward ${short(away)} overall.`;
  } else {
    H = `${short(home)} are the model's least likely winner here — ${short(away)} hold a clear edge.`;
  }

  let A;
  if (aWin >= 65) {
    A = aWinPct != null
      ? `${short(away)} are the clear favourite — model and season win rate (${aWinPct}%) both point here.`
      : `${short(away)} are the clear favourite on the model's read.`;
  } else if (aWin >= 50) {
    A = `${short(away)} are favoured, though the margin leaves room for an upset.`;
  } else if (aWin >= 35) {
    A = `${short(away)} can win this, but the model leans toward ${short(home)} overall.`;
  } else {
    A = `${short(away)} are the model's least likely winner here — ${short(home)} hold a clear edge.`;
  }

  return { H, A };
}
