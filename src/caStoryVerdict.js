// ── CA STORY VERDICT (temp, CA-only, no SA input) ───────────────────────────
// 2026-07-31. Built to fix a specific complaint: computeCAVerdicts (App.jsx)
// picks a single winner across positive+avoid combined by caSafestScore. When
// the winner happens to be an avoid signal and nothing positive clears
// CA_MIN_HOLDOUT_HR, the fixture gets "steer away from X" and nothing
// stakeable — insight, not a verdict.
//
// This module is story-first instead of market-first: it groups evidence
// into match theses (home dominance / away dominance / open game / slow
// game — the same four "directions" already validated in the 801-fixture
// numbers: dominance 75.7%, goals 75.7%, result 69.8%, slow-game 75.7%),
// scores each thesis, then walks theses best-first. Within a thesis, MAIN
// vs SUBSIDIARY is a labeling preference, not a hard gate (2026-07-31,
// see resolveStoryVerdict): every market that clears the bettable floor is
// evaluated, and whichever validates strongest for THAT fixture wins, tied
// broken toward MAIN. The winner's status still reports its true original
// tier, so a SUBSIDIARY market that wins stays labeled SUBSIDIARY downstream.
// Only when every thesis down to the coherence floor fails to produce a
// bettable market does it return NO_VERDICT — and even then it surfaces the
// strongest avoid signal as a clearly-labeled secondary note, never as the
// primary verdict.
//
// SCOPE NOTE: per the CA/SA correlation doc (29 Jul 2026), CA and SA should
// be calibrated independently and combined later via ensemble — not merged
// into one score up front. This module deliberately takes ZERO SA input, so
// it should still be a valid subset once Agent A's merged architecture
// lands, rather than throwaway work.
//
// DUPLICATION NOTE (deliberate, not an oversight): CA_MIN_HOLDOUT_HR,
// CA_MAX_AVOID_HR, CA_MIN_ELIGIBLE_LIFT(_AVOID), and the recalibration
// slope/intercept below are copied from App.jsx rather than imported, to
// avoid a circular import (App.jsx will import THIS file). This is the same
// tradeoff App.jsx's own buildCAVerdictLogRows already makes for
// computeCAVerdicts' internals ("has to be kept in sync by hand" — see that
// function's comment). If these five numbers change in App.jsx, they must
// change here too. Flagging this explicitly rather than hiding it.

// ── Mirrored constants (keep numerically in sync with App.jsx) ─────────────
const CA_MIN_HOLDOUT_HR = 60;
const CA_MAX_AVOID_HR = 40;
const CA_MIN_ELIGIBLE_LIFT = 5;        // pp, positive direction
const CA_MIN_ELIGIBLE_LIFT_AVOID = 15; // pp, avoid direction
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

// ── Thesis evidence table ───────────────────────────────────────────────────
// Signed evidence per thesis: a market matching POSITIVE or AVOID can
// support a thesis depending on direction — e.g. an avoid on Away Over 0.5
// supports "home dominance" (away being shut out), not just a positive on
// home markets. Weights are relative, not calibrated probabilities — they
// only rank which thesis the fixture's evidence points toward.
const THESIS_EVIDENCE = {
  homeDominance: [
    { market: "TB:1X2-Home",     dir: "positive", weight: 1.0 },
    { market: "TB:Home Over 1.5",dir: "positive", weight: 0.9 },
    { market: "TB:Home Over 0.5",dir: "positive", weight: 0.6 },
    { market: "TB:DC1X",         dir: "positive", weight: 0.5 },
    { market: "TB:1X2-Away",     dir: "avoid",    weight: 0.8 },
    { market: "TB:Away Over 0.5",dir: "avoid",    weight: 0.5 },
    { market: "TB:BTTS",         dir: "avoid",    weight: 0.4 },
  ],
  awayDominance: [
    { market: "TB:1X2-Away",     dir: "positive", weight: 1.0 },
    { market: "TB:Away Over 1.5",dir: "positive", weight: 0.9 },
    { market: "TB:Away Over 0.5",dir: "positive", weight: 0.6 },
    { market: "TB:DCX2",         dir: "positive", weight: 0.5 },
    { market: "TB:1X2-Home",     dir: "avoid",    weight: 0.8 },
    { market: "TB:Home Over 0.5",dir: "avoid",    weight: 0.5 },
    { market: "TB:BTTS",         dir: "avoid",    weight: 0.4 },
  ],
  openGame: [
    { market: "TB:Over 2.5",     dir: "positive", weight: 1.0 },
    { market: "TB:BTTS",         dir: "positive", weight: 0.9 },
    { market: "TB:Over 1.5",     dir: "positive", weight: 0.5 },
    { market: "TB:Under 3.5",    dir: "avoid",    weight: 0.6 },
    { market: "TB:Under 4.5",    dir: "avoid",    weight: 0.4 },
  ],
  slowGame: [
    { market: "TB:Under 3.5",    dir: "positive", weight: 1.0 },
    { market: "TB:Under 4.5",    dir: "positive", weight: 0.6 },
    { market: "TB:Over 2.5",     dir: "avoid",    weight: 0.8 },
    { market: "TB:BTTS",         dir: "avoid",    weight: 0.5 },
  ],
};

// MAIN is preferred (see resolveStoryVerdict's tier-as-preference logic and
// the "CA Safe" tierScope gate downstream), SUBSIDIARY is the fallback pool
// a thesis can still win from if it validates stronger for a given fixture.
//
// DEMOTED 2026-07-31 (801-fixture holdout numbers): TB:Home Over 1.5
// (60.3%, n=68) and TB:1X2-Away (61.8%, n=55) were sitting in MAIN by list
// position, not by strength — both barely clear the 60% floor on thin
// samples, well below their thesis siblings (TB:1X2-Home 73.6%,
// TB:Away Over 1.5 66.7%). Moved to SUBSIDIARY so they can never earn the
// MAIN label — even on a fixture where they're the single strongest
// signal, they're a fallback expression of the story, not a headline pick,
// and they're now permanently excluded from "CA Safe" (tierScope: MAIN)
// rather than winning MAIN by default just because nothing else in their
// thesis fired.
const STORY_MARKET_MAP = {
  homeDominance: { main: ["TB:1X2-Home"], subsidiary: ["TB:Home Over 1.5", "TB:Home Over 0.5", "TB:DC1X"] },
  awayDominance: { main: ["TB:Away Over 1.5"], subsidiary: ["TB:1X2-Away", "TB:Away Over 0.5", "TB:DCX2"] },
  openGame:      { main: ["TB:Over 2.5", "TB:BTTS"],          subsidiary: ["TB:Over 1.5"] },
  slowGame:      { main: ["TB:Under 3.5"],                    subsidiary: ["TB:Under 4.5"] },
};

// Minimum thesis confidence to be tried at all — below this the evidence is
// too thin/mixed to call it a coherent story, not just "weak."
const THESIS_COHERENCE_FLOOR = 25;
// Emerging evidence contributes at reduced weight (weak support, never
// enough alone to source a MAIN/SUBSIDIARY pass on its own).
const EMERGING_WEIGHT_MULT = 0.3;

// ── Step 1-4: build signed evidence -> thesis confidence ───────────────────
// caMatches: the object returned by App.jsx's matchCAConditions (positive,
// avoid, emergingPositive, emergingAvoid, traps, contradictoryMarkets).
function bestComboFor(market, list) {
  return list.find(c => c.market === market) || null; // list is already best-first
}

function evidenceMagnitude(combo, isAvoid) {
  if (!combo) return 0;
  const hr = recalibratedHR(combo.holdoutHitRate, isAvoid);
  if (hr == null) return 0;
  // Distance from the 50/50 baseline, normalized 0-1 — a combo sitting right
  // at chance contributes ~0 regardless of which direction it claims to be.
  const dist = isAvoid ? (50 - hr) : (hr - 50);
  return Math.max(0, dist) / 50;
}

export function scoreTheses(caMatches) {
  const { positive = [], avoid = [], emergingPositive = [], emergingAvoid = [], traps = [] } = caMatches || {};
  const trappedMarkets = new Set(traps.map(t => t.market));

  const scores = {};
  for (const [thesis, evidenceRows] of Object.entries(THESIS_EVIDENCE)) {
    let raw = 0;
    let contributingGroups = 0;
    for (const row of evidenceRows) {
      const list = row.dir === "positive" ? positive : avoid;
      const emergingList = row.dir === "positive" ? emergingPositive : emergingAvoid;
      const combo = bestComboFor(row.market, list);
      const emergingCombo = !combo ? bestComboFor(row.market, emergingList) : null;
      if (combo) {
        const mag = evidenceMagnitude(combo, row.dir === "avoid");
        if (mag > 0) { raw += row.weight * mag; contributingGroups++; }
      } else if (emergingCombo) {
        const mag = evidenceMagnitude(emergingCombo, row.dir === "avoid");
        if (mag > 0) raw += row.weight * mag * EMERGING_WEIGHT_MULT;
      } else if (trappedMarkets.has(row.market)) {
        raw -= row.weight * 0.3; // trap caution — small drag, not disqualifying
      }
      // absent (no positive/avoid/emerging/trap at all) contributes 0 — neutral
    }
    // Normalize against the thesis's OWN top single-row weight, not the sum
    // of every row's weight. Most fixtures only ever fire 1-3 of a thesis's
    // ~5-7 evidence rows (the rest are legitimately absent, which is
    // neutral) — dividing by the full weight sum would crush a single
    // strong confirming signal's confidence toward zero just because five
    // OTHER markets stayed silent. Dividing by the top weight instead means
    // one dominant, full-magnitude signal can approach 100 on its own,
    // while still rewarding genuine corroboration (raw grows faster than
    // the fixed denominator when multiple rows fire).
    // BUG FOUND IN SMOKETEST (2026-07-31): the original sum-of-all-weights
    // denominator made every single-signal fixture score under
    // THESIS_COHERENCE_FLOOR regardless of how strong that one signal was —
    // i.e. it silently reproduced the exact "steer away only, nothing
    // actionable" failure this module exists to fix. Caught before ship.
    const topWeight = Math.max(...evidenceRows.map(r => r.weight));
    const confidence = topWeight > 0 ? Math.round(Math.min(1, raw / topWeight) * 100) : 0;
    scores[thesis] = { thesis, confidence, contributingGroups };
  }
  return Object.values(scores).sort((a, b) => b.confidence - a.confidence);
}

// ── Step 5-6: main-market test, subsidiary fallback ─────────────────────────
// A candidate market "passes" if it has a clean positive combo clearing the
// same floors computeCAVerdicts already uses (recalibrated HR + lift), and
// isn't flagged as a same-market contradiction. This intentionally reuses
// the SAME bettable definition as the current engine — the fix here is the
// fallback ladder around it, not a new bettable threshold.
function marketPasses(market, caMatches) {
  const { positive = [], contradictoryMarkets = [] } = caMatches || {};
  if (contradictoryMarkets.includes(market)) return null;
  const combo = bestComboFor(market, positive);
  if (!combo) return null;
  const recalHR = recalibratedHR(combo.holdoutHitRate, false);
  if (recalHR == null || recalHR < CA_MIN_HOLDOUT_HR) return null;
  if (Math.abs(combo.holdoutLift ?? 0) < CA_MIN_ELIGIBLE_LIFT) return null;
  return { market, combo, recalHR };
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

// ── Main entry point ─────────────────────────────────────────────────────
// Returns exactly one of:
//   { status: "MAIN",       market, thesis, confidence, combo, note }
//   { status: "SUBSIDIARY", market, thesis, confidence, combo, note }
//   { status: "NO_VERDICT", reason, avoidNote }
export function resolveStoryVerdict(caMatches) {
  if (!caMatches || (!caMatches.positive?.length && !caMatches.avoid?.length)) {
    return { status: "NO_VERDICT", reason: "NO_EVIDENCE", avoidNote: null };
  }

  const theses = scoreTheses(caMatches).filter(t => t.confidence >= THESIS_COHERENCE_FLOOR);
  const avoidNote = strongestAvoidNote(caMatches);

  if (!theses.length) {
    return { status: "NO_VERDICT", reason: "NO_COHERENT_STORY", avoidNote };
  }

  // Walk theses best-first. This is the actual fix for "steer away only" —
  // the old engine stopped at one competition across all markets; this one
  // keeps trying the NEXT best story if the current one has no bettable
  // main or subsidiary market, instead of giving up after the first miss.
  for (const t of theses) {
    const map = STORY_MARKET_MAP[t.thesis];
    if (!map) continue;

    // TIER-AS-PREFERENCE (2026-07-31): tier used to be a hard gate — every
    // MAIN market was tried, SUBSIDIARY only even evaluated if all MAIN
    // markets failed. That's exactly the "60.3%/61.8%, n=68/55" gap the
    // holdout numbers exposed: TB:Home Over 1.5 and TB:1X2-Away sit in MAIN
    // by list position, not by strength, so a genuinely fixture-strong
    // SUBSIDIARY reading (e.g. TB:Home Over 0.5 at 80.2%, n=329) could never
    // win against them even when it clearly should. Fix: evaluate every
    // market in BOTH main and subsidiary that passes the bettable floor,
    // then pick whichever validates strongest for THIS fixture (highest
    // recalibrated hit rate), tie-breaking toward MAIN only when otherwise
    // equal. The winner's status still reflects its ORIGINAL tier — a
    // subsidiary market that wins is still labeled SUBSIDIARY, so
    // downstream tier-scoped consumers (CA_PARLAY_SYSTEMS' "CA Safe",
    // tierScope: ["MAIN"]) keep treating it exactly as cautiously as
    // before. This only stops list position from outranking evidence.
    const candidates = [];
    for (const market of map.main) {
      const pass = marketPasses(market, caMatches);
      if (pass) candidates.push({ tier: "MAIN", market, pass });
    }
    for (const market of map.subsidiary) {
      const pass = marketPasses(market, caMatches);
      if (pass) candidates.push({ tier: "SUBSIDIARY", market, pass });
    }

    if (!candidates.length) continue; // no bettable market for this thesis — try the next thesis

    // Strongest recalHR wins; MAIN wins ties over SUBSIDIARY; any remaining
    // tie keeps map-declared order (Array.sort is stable).
    candidates.sort((a, b) => {
      const hrDiff = b.pass.recalHR - a.pass.recalHR;
      if (Math.abs(hrDiff) > 1e-9) return hrDiff;
      if (a.tier !== b.tier) return a.tier === "MAIN" ? -1 : 1;
      return 0;
    });

    const winner = candidates[0];
    return {
      status: winner.tier, market: winner.market, thesis: t.thesis, confidence: t.confidence,
      combo: winner.pass.combo, recalHR: winner.pass.recalHR,
      note: winner.tier === "MAIN"
        ? `${SHORT(winner.market)} — ${t.thesis} story (confidence ${t.confidence}), holdout ${winner.pass.combo.holdoutHitRate}% (+${winner.pass.combo.holdoutLift}pp).`
        : `${SHORT(winner.market)} — fallback expression of the ${t.thesis} story (main market not trusted enough), holdout ${winner.pass.combo.holdoutHitRate}% (+${winner.pass.combo.holdoutLift}pp).`,
      avoidNote,
    };
  }

  // Every coherent thesis failed to produce a bettable market. Genuine
  // no-verdict — surfaced honestly, with the avoid note as a labeled
  // secondary, never dressed up as the primary pick.
  return { status: "NO_VERDICT", reason: "STORY_PRESENT_BUT_NO_PLAYABLE_MARKET", avoidNote };
}
