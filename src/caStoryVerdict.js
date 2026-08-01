// ── CA STORY VERDICT (v2 — gate-per-market architecture) ────────────────────
// 2026-07-31, rebuilt per Sterling's explicit spec (not GPT's draft copied
// wholesale — kept the SE-buffer idea because it's the statistically correct
// piece, dropped/changed the rest). See git history for v1 (flat-floor +
// hand-demoted markets + lift-only ranking — all three were patches on a
// design that never fixed the actual problem: ranking by raw hit rate
// structurally favors "easy" markets like Over 0.5 over "specific" ones like
// 1X2, regardless of the fixture).
//
// THE ACTUAL PROBLEM v1 HAD: a flat floor (recalHR >= 60) treats every
// market's 60% the same, but 60% means something totally different for
// TB:Under 4.5 (naturally sits at 84.5% — 60% would be a BAD fixture for it)
// than for TB:1X2-Away (naturally sits at 61.8% — 60% is basically its
// resting state, not a signal). A flat floor can't tell "genuinely elevated"
// apart from "just this market's normal life."
//
// THE FIX: every market gets its OWN gate — its own historical baseline plus
// a statistically-sized buffer (standard error, scaled by that market's own
// sample size). A thin-sample, near-50 market needs a bigger uplift to prove
// it's not noise; a thick-sample, already-strong market needs comparatively
// less, but still has to show real separation from its own norm, not just
// clear some other market's bar. This is the same idea GPT's draft proposed
// (gate = baseline + z*SE) but computed off the LIVE per-combo baseline/
// sample (combo.holdoutBaselineHR / combo.holdoutSample — already flowing
// through matchCAConditions from the mined pattern data) instead of a
// hand-copied snapshot table. The snapshot table below is fallback only, for
// the rare combo that somehow lacks its own baseline/sample.
//
// ARCHITECTURE (per Sterling's spec, 2026-07-31):
//   1. For a thesis, check every MAIN market: does it clear ITS OWN gate?
//   2. If >=1 MAIN market clears, that thesis is confirmed FROM MAIN — done,
//      SUBSIDIARY is never even considered. (This is a real hard gate now,
//      not a merged-pool-ranked-by-lift compromise like v1's "tier as
//      preference" — that compromise is exactly what let Home Over 0.5 keep
//      winning, since it doesn't matter how the winner is chosen if the
//      thing being compared is still the wrong number.)
//   3. Only if NO MAIN market clears does SUBSIDIARY get evaluated, against
//      the SAME per-market gate logic (not a lower bar).
//   4. Among multiple markets that clear for the same thesis, that's
//      corroboration (multiple independent windows into the same story) —
//      tracked and reported, and used as a tie-break.
//   5. The winning market is also checked against its FAMILY's direction-
//      level gate (goals/dominance/result/slow-game, same four buckets as
//      the 801-fixture per-direction table) — reported as directionClear,
//      used as a secondary tie-break. Deliberately NOT a second hard veto:
//      stacking two independent hard gates (market AND direction) risks
//      reproducing this module's original reason for existing — "nothing
//      stakeable" — so direction-level agreement strengthens a pick rather
//      than being required to unlock one.
//   6. Model-agreement (modelProb vs baseline) is NOT wired in yet. It
//      already exists in App.jsx (caModelAgreementFactor) but needs a
//      fixture + SA_MARKETS, which this file deliberately doesn't import
//      (circular-import avoidance — see DUPLICATION NOTE below). Flagging
//      this as scoped-out rather than silently skipping it: the next real
//      step here is wiring that in via a caller-supplied callback, not
//      duplicating SA_MARKETS logic into this file.
//
// SCOPE NOTE: per the CA/SA correlation doc (29 Jul 2026), CA and SA should
// be calibrated independently and combined later via ensemble. This module
// deliberately takes ZERO SA input beyond the model-agreement gap noted
// above.
//
// DUPLICATION NOTE (deliberate, not an oversight): the recalibration
// constants below are copied from App.jsx rather than imported, to avoid a
// circular import (App.jsx imports THIS file). If those numbers change in
// App.jsx, they must change here too — same tradeoff App.jsx's own
// buildCAVerdictLogRows already makes.

// ── Mirrored constants (keep numerically in sync with App.jsx) ─────────────
const CA_MAX_AVOID_HR = 40;
const CA_MIN_ELIGIBLE_LIFT = 5;        // pp, positive direction — sanity floor under the gate math
const CA_MIN_ELIGIBLE_LIFT_AVOID = 15; // pp, avoid direction (unchanged, avoid-note logic untouched)
const CA_RECAL_POS_SLOPE = 1.057, CA_RECAL_POS_INTERCEPT = -17.8;
const CA_RECAL_AVOID_SLOPE = 0.867, CA_RECAL_AVOID_INTERCEPT = 16.1;

function recalibratedHR(rawHR, isAvoid) {
  if (rawHR == null) return null;
  const v = isAvoid
    ? (CA_RECAL_AVOID_SLOPE * rawHR + CA_RECAL_AVOID_INTERCEPT)
    : (CA_RECAL_POS_SLOPE * rawHR + CA_RECAL_POS_INTERCEPT);
  return Math.max(0, Math.min(100, v));
}

const SHORT = m => (m || "").replace(/^TB:/, "");

// ── Story <-> market map (Sterling's final architecture, 2026-07-31) ───────
const STORY_MARKET_MAP = {
  homeDominance: { main: ["TB:1X2-Home", "TB:Home Over 1.5"], subsidiary: ["TB:Home Over 0.5", "TB:DC1X"] },
  awayDominance: { main: ["TB:1X2-Away", "TB:Away Over 1.5"], subsidiary: ["TB:Away Over 0.5", "TB:DCX2"] },
  openGame:      { main: ["TB:Over 2.5", "TB:BTTS"],          subsidiary: ["TB:Over 1.5"] },
  slowGame:      { main: ["TB:Under 3.5"],                    subsidiary: ["TB:Under 4.5"] },
};

// Which of the 4 direction buckets each market belongs to, for the
// direction-level gate (step 5 above). Same grouping as App.jsx's
// CA_FAMILY_GOALS/UNDER/RESULT/DOMINANCE (kept as an independent copy here,
// not imported, same circular-import reason as everything else in this
// file) — a market's FAMILY for direction purposes is not always the same
// as which THESIS it's mapped under above (e.g. TB:1X2-Home sits in the
// homeDominance thesis but its direction family is "result", not
// "dominance" — those are two different, deliberately separate axes).
const FAMILY_OF_MARKET = {
  "TB:Over 1.5": "goals", "TB:Over 2.5": "goals", "TB:BTTS": "goals",
  "TB:Home Over 0.5": "goals", "TB:Away Over 0.5": "goals",
  "TB:Under 3.5": "slow-game", "TB:Under 4.5": "slow-game",
  "TB:1X2-Home": "result", "TB:1X2-Away": "result", "TB:DC1X": "result", "TB:DCX2": "result",
  "TB:Home Over 1.5": "dominance", "TB:Away Over 1.5": "dominance",
};

// ── Baseline/sample tables — AUTHORITATIVE (801-fixture holdout data,
// Sterling's own numbers, dated 2026-07-31). This IS the gate, not a
// fallback — verified to reproduce his pasted gate table exactly (z=1):
// TB:Under 4.5 84.5->86.2, TB:Home Over 0.5 80.2->82.4, TB:Over 1.5 77.2->
// 79.1, TB:Away Over 0.5 75.9->78.7, TB:1X2-Home 73.6->78.2, TB:Over 2.5
// 71.4->74.9, TB:DC1X 71.2->74.3, TB:DCX2 68.7->72.0, TB:Away Over 1.5
// 66.7->72.9, TB:Under 3.5 66.9->69.0, TB:1X2-Away 61.8->68.4, TB:Home
// Over 1.5 60.3->66.2. Direction table: goals 75.7->77.4, dominance 75.7->
// 77.3, slow-game 75.7->77.1, result 69.8->71.7. combo.holdoutBaselineHR/
// holdoutSample (live per-combo data) is used ONLY as a defensive fallback
// for a market that somehow isn't in this table — it does NOT override
// these numbers for any of the 12 markets below.
const MARKET_BASELINE = {
  "TB:Over 1.5":         { hr: 77.2, n: 483 },
  "TB:Under 3.5":        { hr: 66.9, n: 481 },
  "TB:Under 4.5":        { hr: 84.5, n: 478 },
  "TB:Home Over 0.5":    { hr: 80.2, n: 329 },
  "TB:Away Over 0.5":    { hr: 75.9, n: 232 },
  "TB:DC1X":             { hr: 71.2, n: 219 },
  "TB:DCX2":             { hr: 68.7, n: 195 },
  "TB:Over 2.5":         { hr: 71.4, n: 168 },
  "TB:1X2-Home":         { hr: 73.6, n: 91 },
  "TB:Home Over 1.5":    { hr: 60.3, n: 68 },
  "TB:Away Over 1.5":    { hr: 66.7, n: 57 },
  "TB:1X2-Away":         { hr: 61.8, n: 55 },
};
const DIRECTION_BASELINE = {
  "dominance":  { hr: 75.7, n: 686 },
  "goals":      { hr: 75.7, n: 651 },
  "slow-game":  { hr: 75.7, n: 959 },
  "result":     { hr: 69.8, n: 560 },
};

// ── The gate itself ──────────────────────────────────────────────────────
// gate = baseline + z * SE, SE = sqrt(p(1-p)/n) * 100.
// z=1 (one standard error): matches what the reference draft used, and on
// the actual 801-fixture numbers produces buffers from ~1.7pp (Under 4.5,
// n=478 — huge sample, doesn't need much) up to ~6.6pp (1X2-Away, n=55 —
// thin sample, needs real separation to trust). That range is deliberately
// modest — Sterling's own instruction was "not a fucking 30pp gap." p(1-p)
// is largest at p=0.5 and shrinks toward the extremes, which is exactly the
// "closer to 50, bigger the lift required" behavior asked for — it falls
// out of the statistics, not a separate rule bolted on.
// TUNABLE: raise GATE_Z (e.g. 1.28, 1.645) for a stricter bar if too many
// weak fixtures are clearing; this is the one knob to turn, not the formula.
const GATE_Z = 1;

function computeGate(baselineHR, n) {
  if (baselineHR == null || n == null || n <= 0) return null;
  const p = Math.max(0, Math.min(1, baselineHR / 100));
  const se = Math.sqrt((p * (1 - p)) / n) * 100;
  return baselineHR + GATE_Z * se;
}

function marketGate(market, combo) {
  const t = MARKET_BASELINE[market];
  const baseline = t?.hr ?? combo?.holdoutBaselineHR ?? null;
  const n = t?.n ?? combo?.holdoutSample ?? null;
  return computeGate(baseline, n);
}

function familyGate(family) {
  const b = DIRECTION_BASELINE[family];
  return b ? computeGate(b.hr, b.n) : null;
}

// ── Step: does a single market clear, for THIS fixture? ────────────────────
function bestComboFor(market, list) {
  return list.find(c => c.market === market) || null; // list is already best-first
}

function marketPasses(market, caMatches) {
  const { positive = [], contradictoryMarkets = [] } = caMatches || {};
  if (contradictoryMarkets.includes(market)) return null;
  const combo = bestComboFor(market, positive);
  if (!combo) return null;

  // SCALE NOTE: this compares combo.holdoutHitRate (raw) against the RAW
  // market baseline, not the recalibrated rate. recalibratedHR() corrects a
  // specific known bias — per-combo claimed rates overclaiming relative to a
  // FRESHER holdout window (see the recalibration comment in App.jsx) — but
  // the baseline table here is already reported as true 801-fixture holdout
  // performance, the same kind of number recalHR tries to approximate, not
  // the inflated claim it corrects away from. Recalibrating one side and not
  // the other silently breaks the gate: recalHR's -17.8pp intercept means a
  // combo sitting EXACTLY at its market's baseline scores ~14pp below that
  // baseline after "correction," so almost nothing could ever clear. Raw vs
  // raw keeps both sides on the same measurement process, which is what
  // actually cancels out whatever shared bias exists between them.
  const hr = combo.holdoutHitRate;
  if (hr == null) return null;

  const gate = marketGate(market, combo);
  if (gate == null || hr < gate) return null; // the actual fix — market-specific bar, not a flat one

  if (Math.abs(combo.holdoutLift ?? 0) < CA_MIN_ELIGIBLE_LIFT) return null; // sanity floor under the gate math

  const family = FAMILY_OF_MARKET[market] || null;
  const dGate = family ? familyGate(family) : null;
  const directionClear = dGate != null ? hr >= dGate : null;

  return { market, combo, hr, gate, margin: hr - gate, family, directionGate: dGate, directionClear };
}

function strongestAvoidNote(caMatches) {
  const { avoid = [] } = caMatches || {};
  for (const c of avoid) {
    const recalHR = recalibratedHR(c.holdoutHitRate, true);
    if (recalHR != null && recalHR <= CA_MAX_AVOID_HR && Math.abs(c.holdoutLift ?? 0) >= CA_MIN_ELIGIBLE_LIFT_AVOID) {
      return { market: c.market, holdoutHitRate: c.holdoutHitRate, holdoutLift: c.holdoutLift };
    }
  }
  return null;
}

// Bonus weights reused from App.jsx's caSafestScore where a direct
// equivalent already exists and is tuned/documented there (not re-guessed):
// CA_FAMILY_CORROB_BONUS=0.15, CA_MODEL_AGREEMENT_BONUS=0.20. CA_DIRECTION_BONUS
// is new — story mode's direction-level check has no existing equivalent to
// reuse — set smaller (0.10) since it's the softest of the three signals.
const CA_FAMILY_CORROB_BONUS = 0.15;
const CA_MODEL_AGREEMENT_BONUS = 0.20;
const CA_DIRECTION_BONUS = 0.10;

// Model agreement (2026-07-31): mirrors App.jsx's caModelAgreementFactor —
// reward when the model's own probability read agrees with this market
// clearing (sits above its baseline), penalize when it disagrees, both
// normalized by the room actually available above baseline (a market
// already sitting at 85% baseline only has 15pp of room to climb). Injected
// via getModelProb rather than imported, since it needs the fixture's raw
// `f.markets` + SA_MARKETS (App.jsx-only) to compute — this file stays
// import-free from App.jsx (circular-import avoidance) while still using
// the real signal, not a duplicated copy of SA_MARKETS logic.
function modelAgreementFor(pass, getModelProb) {
  if (!getModelProb) return 0; // no model prob supplied — neutral, no bonus or penalty
  const mp = getModelProb(pass.market);
  if (mp == null) return 0;
  const baseline = MARKET_BASELINE[pass.market]?.hr ?? pass.combo.holdoutBaselineHR ?? 50;
  const agreement = mp - baseline;
  const room = Math.max(100 - baseline, 10);
  return Math.max(-1, Math.min(1, agreement / room));
}

// ── Step: pick the winner for one thesis ────────────────────────────────
// MAIN is a real gate here, not a preference: if ANY main market clears,
// subsidiary is never even evaluated. Within whichever pool is active,
// EVERYTHING speaks at once — margin, corroboration, direction agreement,
// and model agreement all multiply into one score, the same pattern
// App.jsx's caSafestScore already uses (shrink x stability x hrFactor x
// corrob x modelAgreement) — not a lexicographic tie-break chain, which
// would leave corroboration/direction/model-prob deciding almost nothing in
// practice since margin is a continuous number that rarely ties exactly.
function resolveThesisWinner(thesisName, caMatches, getModelProb) {
  const map = STORY_MARKET_MAP[thesisName];
  if (!map) return null;

  const mainPasses = map.main.map(m => marketPasses(m, caMatches)).filter(Boolean);
  const subPasses  = map.subsidiary.map(m => marketPasses(m, caMatches)).filter(Boolean);

  let pool, tier;
  if (mainPasses.length) { pool = mainPasses; tier = "MAIN"; }
  else if (subPasses.length) { pool = subPasses; tier = "SUBSIDIARY"; }
  else return null;

  const allPasses = [...mainPasses, ...subPasses];
  const corrobFor = (pass) => Math.min(3, allPasses.filter(p => p.market !== pass.market).length);

  const candidates = pool.map(pass => {
    const corroboration = corrobFor(pass);
    const modelAgreement = modelAgreementFor(pass, getModelProb);
    const finalScore = pass.margin
      * (1 + CA_FAMILY_CORROB_BONUS * corroboration)
      * (1 + CA_DIRECTION_BONUS * (pass.directionClear ? 1 : 0))
      * (1 + CA_MODEL_AGREEMENT_BONUS * modelAgreement);
    return { tier, pass, corroboration, modelAgreement, finalScore };
  });
  candidates.sort((a, b) => b.finalScore - a.finalScore);

  const winner = candidates[0];
  const { pass } = winner;
  const gateR = Math.round(pass.gate * 10) / 10, marginR = Math.round(pass.margin * 10) / 10;
  // confidence: 50 = just barely cleared its own gate (margin=0), climbing
  // toward 100 as the margin grows. CA_PARLAY_SYSTEMS' minConfidence
  // thresholds (60 for CA Safe, 40 for CA Balanced) read off this scale.
  const confidence = Math.round(Math.max(0, Math.min(100, 50 + marginR * 5)));
  return {
    status: winner.tier,
    market: pass.market,
    thesis: thesisName,
    confidence,
    combo: pass.combo,
    recalHR: pass.hr, // field name kept for leg-shape stability; holds raw holdout HR, see marketPasses' SCALE NOTE
    gate: gateR,
    margin: marginR,
    corroboration: winner.corroboration,
    directionClear: pass.directionClear,
    modelAgreement: Math.round(winner.modelAgreement * 100) / 100,
    finalScore: Math.round(winner.finalScore * 100) / 100,
    note: `${SHORT(pass.market)} — ${thesisName} story, holdout ${pass.combo.holdoutHitRate}% vs its own ${gateR}% gate (+${marginR}pp clear)`
      + (winner.corroboration ? `, corroborated by ${winner.corroboration} other market${winner.corroboration !== 1 ? "s" : ""}` : "")
      + (pass.directionClear ? ", also clears its direction-level bar" : "")
      + (getModelProb ? `, model agreement ${winner.modelAgreement >= 0 ? "+" : ""}${Math.round(winner.modelAgreement * 100) / 100}` : "")
      + ".",
  };
}

function allThesisWinners(caMatches, getModelProb) {
  return Object.keys(STORY_MARKET_MAP)
    .map(t => resolveThesisWinner(t, caMatches, getModelProb))
    .filter(Boolean)
    .sort((a, b) => b.finalScore - a.finalScore); // strongest story overall — everything already spoke into finalScore
}

// ── Main entry point ─────────────────────────────────────────────────────
// getModelProb: optional (market) => number|null, bound by the caller to a
// specific fixture (App.jsx: market => caModelProbFor(f, market)). Omit it
// and model agreement is simply neutral (0) for every candidate — everything
// else in the gate/corroboration/direction chain still runs.
// Returns exactly one of:
//   { status: "MAIN"|"SUBSIDIARY", market, thesis, confidence, combo,
//     recalHR, gate, margin, corroboration, directionClear, modelAgreement,
//     finalScore, note, avoidNote }
//   { status: "NO_VERDICT", reason, avoidNote }
export function resolveStoryVerdict(caMatches, getModelProb) {
  if (!caMatches || (!caMatches.positive?.length && !caMatches.avoid?.length)) {
    return { status: "NO_VERDICT", reason: "NO_EVIDENCE", avoidNote: null };
  }
  const avoidNote = strongestAvoidNote(caMatches);
  const winners = allThesisWinners(caMatches, getModelProb);
  if (!winners.length) {
    return { status: "NO_VERDICT", reason: "NO_MARKET_CLEARED_ITS_GATE", avoidNote };
  }
  return { ...winners[0], avoidNote };
}

// ── Multi-leg variant: every thesis's winner, not just the strongest one ──
// Feeds the parlay leg pool (parlaySystemEngine.mjs) — a fixture with two
// independently-cleared stories (e.g. homeDominance AND slowGame) can offer
// two distinct-market legs instead of being capped at one.
//
// CORRELATION CAVEAT: this returns at most one market per THESIS (not one
// per market that clears) specifically so two highly-correlated same-story
// markets (e.g. Over 2.5 AND BTTS both firing off openGame) never get
// stacked into one parlay as if they were independent evidence —
// combinedOdds() in parlaySystemEngine.mjs multiplies odds assuming
// independence, which same-story markets are not.
export function resolveAllStoryVerdicts(caMatches, getModelProb) {
  if (!caMatches || (!caMatches.positive?.length && !caMatches.avoid?.length)) return [];
  return allThesisWinners(caMatches, getModelProb);
}
