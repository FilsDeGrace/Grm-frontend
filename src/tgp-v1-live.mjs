/**
 * tgp-v1-live.mjs — shared CA/SA condition-matching engine + TGP V1 live-
 * index/assignment logic.
 * ─────────────────────────────────────────────────────────────────────────
 * Extracted verbatim from App.jsx (2026-08-25) so server.js can compute
 * TGP V1's whole-shape/decompose-pool locks itself, the same way
 * tgp-decompose-live.mjs/tgp-whole-shape-live.mjs already let it do for V2
 * — instead of waiting on a client to POST its own client-computed result
 * once a day (see the removed comment above the old
 * ensureTgpWholeTicketsRecord/`/api/tgp-decompose-pool` v1 POST route for
 * the full history of why that was the stopgap in the first place).
 *
 * Every function/constant below is copied byte-for-byte from its App.jsx
 * definition — no behavior changes, only relocation — and App.jsx now
 * imports from this file instead of defining its own copy, so client and
 * server are structurally incapable of drifting apart; there is only ever
 * one implementation. If this file changes, both sides pick it up.
 *
 * Deliberately pure: no React, no DOM, no `fetch`, no `window`. Everything
 * here operates on plain fixture/pattern objects, which is what made this
 * extraction possible without a rewrite.
 */

// ── Fixture lifecycle state ─────────────────────────────────────────────
// Shared by every pool/leg builder in the app (evaluatePick,
// buildSignalPool, PatternEngineControls, and now this module) — single
// source of truth so none of them drift out of sync with three separately-
// typed copies of the same two sets.
export const FIXTURE_ALWAYS_BLOCKED_STATES = new Set([
  "1h","1sthalf","ht","halftime","2h","2ndhalf","et","extratime","penaltyshootout","inprogress","live",
  "postponed","ppd","suspended","interrupted","abandoned","cancelled","canceled","deleted",
]);
export const FIXTURE_FINISHED_STATES = new Set([
  "finished","ft","fulltime","ended","complete","aet","afterextratime","afterpenalties",
]);
export const normalizeFixtureState = f => (f.state || "").toLowerCase().replace(/[\s_\-]/g, "");
// isBookableFixtureState: can a leg be built on this fixture right now?
// isPastDate lets finished games through (backtesting); live/cancelled states
// are excluded no matter what date is being viewed.
export function isBookableFixtureState(f, isPastDate = false) {
  const state = normalizeFixtureState(f);
  if (FIXTURE_ALWAYS_BLOCKED_STATES.has(state)) return false;
  if (!isPastDate && FIXTURE_FINISHED_STATES.has(state)) return false;
  return true;
}

// ── SA market table ──────────────────────────────────────────────────────
export const SA_MARKETS = {
  "TB:Over 1.5":      { probKey:"over15",  oddsKey:"over15odds"  },
  "TB:Over 2.5":      { probKey:"over25",  oddsKey:"over25odds"  },
  "TB:Under 3.5":     { probKey:"under35", oddsKey:"under35odds" },
  "TB:Under 4.5":     { probKey:"under45", oddsKey:"under45odds" },
  "TB:BTTS":          { probKey:"bttsYes", oddsKey:"bttsYesOdds" },
  "TB:DC1X":          { computeProb: m => (+(m.homeWin??0)) + (+(m.draw??0)), oddsKey:"dc1X" },
  "TB:DCX2":          { computeProb: m => (+(m.draw??0)) + (+(m.awayWin??0)), oddsKey:"dcX2" },
  "TB:1X2-Home":      { probKey:"homeWin", oddsKey:"o1" },
  "TB:1X2-Draw":      { probKey:"draw",    oddsKey:"oX" },
  "TB:1X2-Away":      { probKey:"awayWin", oddsKey:"o2" },
  "TB:Home Over 0.5": { probKey:"homeOver05", oddsKey:null },
  "TB:Home Over 1.5": { probKey:"homeOver15", oddsKey:null },
  "TB:Away Over 0.5": { probKey:"awayOver05", oddsKey:null },
  "TB:Away Over 1.5": { probKey:"awayOver15", oddsKey:null },
};

// 2026-08-27 (Alden — confirmed against server.js's odds ingestion):
// homeOver05/awayOver05 used to map to "over05odds" here, same as App.jsx's
// old teamTotalOddsFor. That field comes from the bookmaker's whole-match
// "Match goals" market (server.js getGoalOdds), not a per-team scoring
// price — this data provider has no team-total-goals market at all. Dropped
// both keys entirely so lookups fall through to null (no fake "real" price),
// same as caOddsFor already correctly does for these two markets via
// SA_MARKETS' oddsKey:null. SC legs on these markets are implied-odds-only
// downstream, same as every other engine now.
export const SC_MARKET_ODDS_FIELD = {
  homeWin: "o1", awayWin: "o2", under35: "under35odds", under45: "under45odds",
  bttsYes: "bttsYesOdds",
};

// ── CA CONDITION MATCHER ──────────────────────────────────────────────────
// CA (conditions-analyst.mjs) conditions are continuous thresholds
// ({field, op, value}), not SA's tertile-bucket equality below — this is a
// direct port of conditions-analyst.mjs's extractDims() + conditionMatches(),
// run against one fixture's live markets object. NOT a reuse of
// matchSAPatterns: the two systems check fundamentally different shapes of
// condition, so porting the real dims-extraction logic (not guessing at
// field names) matters — mismatched field names here would silently match
// nothing and look like "this fixture just has no CA matches" instead of
// erroring, which is worse than a crash.
// Field source is byte-for-byte the same as conditions-analyst.mjs's
// extractDims(): homeCS/awayCS/homeWin/awayWin/draw straight off f.markets,
// btts aliases m.bttsYes (falls back to m.btts), oddsFloor comes off
// f.theRead/f.theEdge (not m at all — it's a fixture-level field, not a
// markets one), totalXG is derived (homeXG + awayXG), not a stored field.
export function caExtractDims(f) {
  const m = f.markets || {};
  const hXG = +(m.homeXG ?? 0), aXG = +(m.awayXG ?? 0);
  const oddsFloorRaw = f.theRead?.anchor?.odds ?? f.theEdge?.odds ?? null;
  return {
    totalXG: hXG + aXG, homeXG: hXG, awayXG: aXG,
    homeCS: +(m.homeCS ?? NaN), awayCS: +(m.awayCS ?? NaN),
    btts: +(m.bttsYes ?? m.btts ?? NaN),
    homeWin: +(m.homeWin ?? NaN), awayWin: +(m.awayWin ?? NaN), draw: +(m.draw ?? NaN),
    oddsFloor: oddsFloorRaw != null ? +oddsFloorRaw : NaN,
  };
}
export function caConditionMatches(dims, cond) {
  const v = dims[cond.field];
  if (v == null || Number.isNaN(v)) return false;
  return cond.op === ">=" ? v >= cond.value : v < cond.value;
}
export function caOddsFor(f, market) {
  const def = SA_MARKETS[market];
  if (!def || !def.oddsKey) return null;
  const o = f.odds?.[def.oddsKey];
  return o > 1 ? o : null;
}
// caPatterns: the { byMarket, byMarketAvoid } payload from GET /api/ca-patterns.
// Returns { positive: [...matched combos, best holdout HR first], avoid: [...] },
// flattened across all 14 markets — FullModelPage groups by combo.market itself.
export function matchCAConditions(f, caPatterns) {
  if (!caPatterns) return { positive: [], avoid: [], emergingPositive: [], emergingAvoid: [], traps: [], contradictoryMarkets: [] };
  const dims = caExtractDims(f);
  const matchGroup = (byMarketObj) => {
    const out = [];
    for (const combos of Object.values(byMarketObj || {})) {
      for (const c of combos) if (c.conditions.every(cond => caConditionMatches(dims, cond))) out.push(c);
    }
    return out;
  };
  const positive = matchGroup(caPatterns.byMarket);
  const avoid = matchGroup(caPatterns.byMarketAvoid);
  // Emerging = low-test-n matches — kept fully separate from positive/avoid,
  // never merged in, so a small-sample fluke can't be mistaken for a
  // validated one just because it happened to also match.
  const emergingPositive = matchGroup(caPatterns.byMarketEmerging);
  const emergingAvoid = matchGroup(caPatterns.byMarketAvoidEmerging);
  // Same-market contradiction: a market can carry one combo that's a VALID
  // positive and a DIFFERENT combo that's a VALID avoid, both matching this
  // fixture at once — never the same rule (traps come from
  // OVERFIT/DEGRADED status; these are two separately-mined VALID combos
  // that just happen to both fire here).
  const positiveMarkets = new Set(positive.map(c => c.market));
  const avoidMarkets = new Set(avoid.map(c => c.market));
  const contradictoryMarkets = [...positiveMarkets].filter(m => avoidMarkets.has(m));
  // Traps — combos that looked convincing on train but didn't hold up on
  // holdout (or the mirror). Only surfaced when the market has NO validated
  // positive or avoid match at all.
  const traps = matchGroup(caPatterns.byMarketTraps)
    .filter(c => !positiveMarkets.has(c.market) && !avoidMarkets.has(c.market));
  positive.sort((a, b) => (b.holdoutHitRate ?? -1) - (a.holdoutHitRate ?? -1));
  avoid.sort((a, b) => (a.holdoutHitRate ?? 101) - (b.holdoutHitRate ?? 101));
  emergingPositive.sort((a, b) => (b.holdoutHitRate ?? -1) - (a.holdoutHitRate ?? -1));
  emergingAvoid.sort((a, b) => (a.holdoutHitRate ?? 101) - (b.holdoutHitRate ?? 101));
  traps.sort((a, b) => Math.abs(b.gap ?? 0) - Math.abs(a.gap ?? 0));
  return { positive, avoid, emergingPositive, emergingAvoid, traps, contradictoryMarkets };
}

// ── SA PATTERN MATCHER ───────────────────────────────────────────────────
function saTheReadToTBMarket(anchor) {
  if (!anchor) return null;
  const mkt = anchor.market, dcV = anchor.dcVariant;
  if (mkt === "DC") return dcV === "1X" ? "TB:DC1X" : dcV === "X2" ? "TB:DCX2" : null;
  const MAP = {
    "Over 1.5":"TB:Over 1.5","Over 2.5":"TB:Over 2.5","Under 3.5":"TB:Under 3.5","Under 4.5":"TB:Under 4.5",
    "BTTS":"TB:BTTS","Home Over 0.5":"TB:Home Over 0.5","Away Over 0.5":"TB:Away Over 0.5",
    "Home Win":"TB:1X2-Home","Away Win":"TB:1X2-Away","Draw":"TB:1X2-Draw",
  };
  return MAP[mkt] ?? null;
}
const saProbBand = p => p>=90?"90+":p>=85?"85-90":p>=80?"80-85":p>=75?"75-80":p>=70?"70-75":p>=65?"65-70":"<65";
const saCalBand = w => w==null?"unknown":w>=80?"80+":w>=60?"60-80":w>=40?"40-60":w>=20?"20-40":"<20";
const saSeasonBand = n => !n?"unknown":n>=30?"30+":n>=20?"20-30":n>=8?"8-20":"<8";
const saGamesUsedBand = n => !n?"unknown":n>=60?"60+":n>=30?"30-60":n>=15?"15-30":"<15";
const saLeagueTier = rank => !rank?"unknown":rank<=10?"elite":rank<=20?"top":rank<=50?"mid":"lower";
const saXgRatioBand = (h,a) => { if(!h||!a||h<=0||a<=0) return "unknown"; const r=Math.max(h/a,a/h); return r>=3?"3+":r>=2?"2-3":r>=1.5?"1.5-2":"<1.5"; };
const saTotalXGBand = t => !t||t<=0?"unknown":t>=4?"4+":t>=3?"3-4":t>=2?"2-3":"<2";
const saOddsDiscrepBand = (modelProb, bkOdds) => {
  if (!bkOdds || bkOdds<=1) return "no-bk";
  const bkP = (1/bkOdds)*100, d = modelProb - bkP;
  return d>15?"strong-edge":d>5?"mild-edge":d>-5?"aligned":d>-15?"mild-against":"strong-against";
};
const saTablePosBand = pos => pos==null?"unknown":pos<=3?"top3":pos<=6?"top6":pos<=10?"mid":"bottom";
const saPosDiffBand  = d => d==null?"unknown":d<=3?"close":d<=7?"mid":"large";
const saBacktestWtBand = w => w==null?"unknown":w>=50?"50+":w>=30?"30-50":w>=15?"15-30":"<15";

// Computes the same feature dimensions strategy-analyst.mjs mined patterns
// against, off a LIVE fixture instead of a snapshot file. Returned object is
// keyed identically to sa-patterns.json's `conditions`, values stringified
// the same way (DIMS in the miner wraps booleans/bands in String()).
export function computeSAFeatures(f, market) {
  const def = SA_MARKETS[market];
  if (!def) return null;
  const m = f.markets || {};
  const prob   = def.computeProb ? def.computeProb(m) : +(m[def.probKey] ?? 0);
  const bkOdds = def.oddsKey ? +(f.odds?.[def.oddsKey] ?? 0) : 0;

  const hXG = +(m.homeXG ?? 0), aXG = +(m.awayXG ?? 0);
  const tot = hXG + aXG, gap = Math.abs(hXG - aXG);

  const calW   = m._calibrationWeight ?? null;
  const sGames = m._seasonGames ?? null;
  const gUsed  = m._gamesUsed ?? null;
  const btW    = m._backtestWeight ?? null;
  const isLowConf = !!(m._lowConfidence ?? false);

  const lRank = f.leagueRank ?? null;
  const isVol = !!(f.volatileLeague ?? false);

  const hAtk = +(m.homeAttackStrength ?? 0), aAtk = +(m.awayAttackStrength ?? 0);
  const hDef = +(m.homeDefenceStrength ?? 0), aDef = +(m.awayDefenceStrength ?? 0);

  const tp = f.tablePosition || {};
  const hPos = tp.homePosition ?? null, aPos = tp.awayPosition ?? null;
  const posDiff = (hPos!=null && aPos!=null) ? Math.abs(hPos-aPos) : null;

  const hSt = f.teamStats?.home || {}, aSt = f.teamStats?.away || {};

  const readAnchor     = f.theRead?.anchor;
  const readStrong     = !!(readAnchor?.strong ?? false);
  const readTBMkt      = saTheReadToTBMarket(readAnchor);
  const readMatchesMkt = readTBMkt === market;

  const o25 = +(m.over25 ?? 0), btts = +(m.bttsYes ?? m.btts ?? 0), draw = +(m.draw ?? 0);
  const tags = f.strategyTags || [];

  return {
    probBand: saProbBand(prob),
    leagueTier: saLeagueTier(lRank),
    isEliteLeague: String(lRank!=null && lRank<999 && lRank<=10),
    isTopLeague:   String(lRank!=null && lRank<999 && lRank<=20),
    isVolatile: String(isVol),
    country: f.country || "unknown",
    calBand: saCalBand(calW),
    isHighCalib: String(calW!=null && calW>=70),
    gamesUsedBand: saGamesUsedBand(gUsed),
    isLowConf: String(isLowConf),
    backtestWtBand: saBacktestWtBand(btW),
    seasonBand: saSeasonBand(sGames),
    isLateSeason: String(sGames!=null && sGames>30),
    isEarlySeason: String(sGames!=null && sGames<8),
    xgRatioBand: saXgRatioBand(hXG, aXG),
    totalXGBand: saTotalXGBand(tot),
    xgBalanced: String(gap < 0.5),
    xgDomHome: String(hXG>0 && aXG>0 && hXG>=aXG*2 && gap>=1),
    xgDomAway: String(hXG>0 && aXG>0 && aXG>=hXG*2 && gap>=1),
    highTotalXG: String(tot >= 3),
    lowTotalXG: String(tot > 0 && tot < 1.5),
    xgSourceType: f.xgSource || "unknown",
    homeAttackStrong: String(hAtk >= 1.3),
    awayAttackStrong: String(aAtk >= 1.3),
    homeDefenceWeak: String(hDef >= 1.2),
    awayDefenceWeak: String(aDef >= 1.2),
    homeTablePos: saTablePosBand(hPos),
    awayTablePos: saTablePosBand(aPos),
    tablePosDiff: saPosDiffBand(posDiff),
    homeCsHigh: String((hSt.csRate ?? -1) >= 40),
    awayCsHigh: String((aSt.csRate ?? -1) >= 40),
    homeScoreLow: String((hSt.scoredRate ?? 101) <= 40),
    awayScoreLow: String((aSt.scoredRate ?? 101) <= 40),
    homeFtsHigh: String((hSt.ftsRate ?? -1) >= 40),
    awayFtsHigh: String((aSt.ftsRate ?? -1) >= 40),
    goalRange: f.goalRange || "unknown",
    highO25: String(o25 > 40),
    lowBtts: String(btts > 0 && btts < 35),
    highBtts: String(btts > 55),
    highDraw: String(draw > 30),
    hasBkOdds: String(!!(bkOdds && bkOdds>1)),
    oddsDiscrep: saOddsDiscrepBand(prob, bkOdds),
    readStrong: String(readStrong),
    readMatchesMkt: String(readMatchesMkt),
    hasLowScoring: String(tags.includes("low_scoring")),
    hasOver25Quality: String(tags.includes("over25_quality")),
    hasHomeWin: String(tags.includes("home_win")),
    hasAwayWin: String(tags.includes("away_win")),
    hasBttsValue: String(tags.includes("btts_value")),
    hasDrawTag: String(tags.includes("draw")),
    hasHomeGoalfest: String(tags.includes("home_goalfest")),
    hasAwayGoalfest: String(tags.includes("away_goalfest")),
  };
}

// Matches a fixture's computed features against every pattern for `market`.
// Returns { positive: [...matched, lift desc], avoid: [...matched, worst-first] }.
// Both single-condition and pair-condition patterns are handled the same way
// — every key in `p.conditions` must match the fixture's computed feature.
export function matchSAPatterns(f, market, patterns) {
  const feats = computeSAFeatures(f, market);
  if (!feats || !patterns?.length) return { positive: [], avoid: [] };
  const positive = [], avoid = [];
  for (const p of patterns) {
    if (p.market !== market) continue;
    const matches = Object.entries(p.conditions).every(([k, v]) => feats[k] === v);
    if (!matches) continue;
    (p.direction === "positive" ? positive : avoid).push(p);
  }
  positive.sort((a,b) => b.lift - a.lift);
  avoid.sort((a,b) => a.lift - b.lift); // most negative lift first — worst offenders surfaced first within the flagged group
  return { positive, avoid };
}

// ── TGP V1 combinators ───────────────────────────────────────────────────
export function tgpComboKey(combo) {
  return combo.conditions.map(c => `${c.field}${c.op}${c.value}`).sort().join('&');
}
export function tgpSaKey(pattern) {
  return Object.entries(pattern.conditions).map(([k, v]) => `${k}=${v}`).sort().join('&');
}

// The "max 3 distinct patterns per fixture, each on a different market"
// rule exists purely to stop the ranked Whole Shape list itself from being
// dominated by one popular live fixture:
//   - stateless — recomputed from scratch every time the candidate list is
//     built, with zero memory of session clicks or prior adds.
//   - applied once, top-down, over the list already sorted by holdout hit
//     rate — the strongest shape touching a fixture wins a slot first.
//   - a fixture may anchor at most 3 surfaced shapes, and only if each
//     uses a different market at that fixture (skips duplicates, not just
//     counts them).
export function tgpShapeSignature(shape) {
  return shape.legs.map(l => `${l.market}/${l.source}:${l.patternKey}`).sort().join('||');
}
export function tgpApplyFixtureDiversity(rankedCandidates, maxPerFixture = 3) {
  const marketsUsedByFixture = new Map(); // fixtureId -> Set(market) already surfaced
  const result = [];
  for (const cand of rankedCandidates) {
    const touches = cand.assignment.map((a, i) => ({ fixtureId: a.fixtureId, market: cand.shape.legs[i].market }));
    const fits = touches.every(({ fixtureId, market }) => {
      const used = marketsUsedByFixture.get(fixtureId);
      if (!used) return true; // fixture has open capacity
      if (used.has(market)) return false; // this exact market already surfaced for this fixture by a stronger shape
      return used.size < maxPerFixture;
    });
    if (!fits) continue;
    for (const { fixtureId, market } of touches) {
      if (!marketsUsedByFixture.has(fixtureId)) marketsUsedByFixture.set(fixtureId, new Set());
      marketsUsedByFixture.get(fixtureId).add(market);
    }
    result.push(cand);
  }
  return result;
}

// Builds a global index: leg key ("market/source:patternKey") -> every
// fixture live-matching it right now, with that fixture's odds for the
// market. One pass over fixtures (not one pass per shape), since shapes can
// number in the thousands but fixtures are a handful of hundred at most.
export function computeTgpLiveIndex(fixtures, { appCaPatterns, appSaPatterns, saPatternsByMarket, scResults, isPastDate }) {
  const index = new Map(); // key -> [{fixtureId, home, away, league, odds, modelProb}]
  const add = (key, f, odds, modelProb) => {
    if (!(odds > 1)) return; // unpriced legs can't be staked or combined into odds
    if (!index.has(key)) index.set(key, []);
    index.get(key).push({ fixtureId: f.id, home: f.teams?.home, away: f.teams?.away, league: f.league, odds, modelProb: Number.isFinite(Number(modelProb)) ? Number(modelProb) : null });
  };
  for (const f of fixtures || []) {
    if (!isBookableFixtureState(f, isPastDate)) continue; // same live/cancelled gate Pattern Engine uses
    // Never let a fixture flagged cup/friendly/international
    // (f.competitionRisk) become a live candidate for a mined leg — mined
    // shapes' holdout stats may be contaminated by that noisier population
    // (tgp-ticket-miner.mjs mines from settlement-pool-v2.jsonl without
    // excluding these). This narrows what TGP can match against; it does
    // not retroactively clean the mined shapes' own stats.
    if (f.competitionRisk) continue;
    if (appCaPatterns) {
      const { positive } = matchCAConditions(f, appCaPatterns);
      for (const c of positive) {
        const odds = SA_MARKETS[c.market]?.oddsKey ? f.odds?.[SA_MARKETS[c.market].oddsKey] : caOddsFor(f, c.market);
        const def = SA_MARKETS[c.market];
        const modelProb = def?.computeProb ? def.computeProb(f.markets || {}) : (def?.probKey ? f.markets?.[def.probKey] : null);
        add(`${c.market}/ca:${tgpComboKey(c)}`, f, odds, modelProb);
      }
    }
    if (appSaPatterns?.length) {
      for (const mkt of Object.keys(SA_MARKETS)) {
        const { positive } = matchSAPatterns(f, mkt, saPatternsByMarket.get(mkt) || []);
        const def = SA_MARKETS[mkt];
        const odds = def.oddsKey ? f.odds?.[def.oddsKey] : null;
        const modelProb = def?.computeProb ? def.computeProb(f.markets || {}) : (def?.probKey ? f.markets?.[def.probKey] : null);
        for (const p of positive) add(`${mkt}/sa:${tgpSaKey(p)}`, f, odds, modelProb);
      }
    }
    // SC's matched combos come back from POST /api/sc-match's own
    // matchResult.positive — real {conditions} objects, same shape CA's
    // are (tgp-pattern-matcher.mjs confirms CA/SC condition objects are
    // byte-identical), so tgpComboKey applies unchanged. c.market here is
    // SC's raw pool-key field (over25, homeWin, ...) — no TB: prefix,
    // matching exactly what the miner's library.sc grouping key was.
    const scPositive = scResults?.[f.id]?.positive;
    if (scPositive?.length) {
      for (const c of scPositive) {
        const odds = SC_MARKET_ODDS_FIELD[c.market] ? f.odds?.[SC_MARKET_ODDS_FIELD[c.market]] : null;
        const modelProb = f.markets?.[c.market] ?? null;
        add(`${c.market}/sc:${tgpComboKey(c)}`, f, odds, modelProb);
      }
    }
  }
  return index;
}

// Whole-shape mode only: finds ONE assignment of a distinct fixture to
// each of a shape's legs (cut is 2 or 3 in the current miner, so plain
// backtracking is more than fast enough; this is never run against an
// unbounded leg count). Candidates per leg are pre-sorted by odds
// descending so, among multiple valid assignments, the search naturally
// favors the higher-value one without needing a separate optimization pass.
export function tgpAssignDistinctFixtures(legLabels, liveIndex) {
  const candidatesPerLeg = legLabels.map(l => {
    const key = `${l.market}/${l.source}:${l.patternKey}`;
    return (liveIndex.get(key) || []).slice().sort((a, b) => b.odds - a.odds);
  });
  if (candidatesPerLeg.some(c => c.length === 0)) return null; // at least one leg isn't live anywhere today
  const used = new Set();
  const assignment = new Array(legLabels.length);
  function backtrack(i) {
    if (i === legLabels.length) return true;
    for (const cand of candidatesPerLeg[i]) {
      if (used.has(cand.fixtureId)) continue;
      used.add(cand.fixtureId);
      assignment[i] = cand;
      if (backtrack(i + 1)) return true;
      used.delete(cand.fixtureId);
    }
    return false;
  }
  return backtrack(0) ? assignment : null;
}

// Stacking's assignment differs from tgpAssignDistinctFixtures above on
// purpose: normal Whole Shape cards use strict distinct-fixture assignment
// (one shape, no duplicate fixtures allowed at all — a shape that can't
// find distinct fixtures for every leg simply isn't offered). Stacking
// combines legs from MULTIPLE already-validated shapes a user hand-picked,
// where the same fixture legitimately recurring across shapes is normal,
// not an error — without bet-builder pricing, the strongest occurrence
// should win the fixture rather than the whole stack failing. Priority is
// (holdoutHR, lift, holdoutN, odds) of the containing shape, strongest
// first; a weaker occurrence that loses a fixture to a stronger one tries
// to relocate to an alternate live fixture before being dropped entirely.
export function tgpAssignStackFixtures(legLabels, liveIndex) {
  const candidatesPerLeg = legLabels.map(l => {
    const key = `${l.market}/${l.source}:${l.patternKey}`;
    return (liveIndex.get(key) || []).slice().sort((a, b) => b.odds - a.odds);
  });
  if (candidatesPerLeg.some(c => c.length === 0)) return null;

  const priority = (leg, bestOdds = 0) => [
    Number(leg?._shape?.holdoutHR) || 0,
    Number(leg?._shape?.lift) || 0,
    Number(leg?._shape?.holdoutN) || 0,
    Number(bestOdds) || 0,
  ];

  const order = legLabels.map((leg, legIndex) => ({ leg, legIndex }))
    .sort((a, b) => {
      const pa = priority(a.leg, candidatesPerLeg[a.legIndex][0]?.odds);
      const pb = priority(b.leg, candidatesPerLeg[b.legIndex][0]?.odds);
      for (let i = 0; i < pa.length; i++) {
        if (pb[i] !== pa[i]) return pb[i] - pa[i];
      }
      return a.legIndex - b.legIndex;
    });

  const fixtureOwner = new Map(); // fixtureId -> legIndex
  const assigned = new Array(legLabels.length).fill(null);

  const canTakeFixture = (legIndex, seenFixtures, seenLegs) => {
    if (seenLegs.has(legIndex)) return false;
    seenLegs.add(legIndex);

    const leg = legLabels[legIndex];
    for (const cand of candidatesPerLeg[legIndex]) {
      const fixtureId = cand.fixtureId;
      if (seenFixtures.has(fixtureId)) continue;
      seenFixtures.add(fixtureId);

      const ownerIndex = fixtureOwner.get(fixtureId);
      if (ownerIndex == null) {
        fixtureOwner.set(fixtureId, legIndex);
        assigned[legIndex] = cand;
        return true;
      }

      const ownerPriority = priority(legLabels[ownerIndex], assigned[ownerIndex]?.odds);
      const contenderPriority = priority(leg, cand.odds);
      let contenderStronger = false;

      for (let i = 0; i < contenderPriority.length; i++) {
        if (contenderPriority[i] !== ownerPriority[i]) {
          contenderStronger = contenderPriority[i] > ownerPriority[i];
          break;
        }
      }

      // The existing occurrence wins ties so renders remain deterministic.
      if (!contenderStronger) continue;

      // Stronger occurrence takes the fixture; try to relocate the weaker one.
      fixtureOwner.delete(fixtureId);
      const previous = assigned[ownerIndex];
      assigned[ownerIndex] = null;

      if (canTakeFixture(ownerIndex, seenFixtures, seenLegs)) {
        fixtureOwner.set(fixtureId, legIndex);
        assigned[legIndex] = cand;
        return true;
      }

      // No alternate fixture for the weaker occurrence — restore it.
      fixtureOwner.set(fixtureId, ownerIndex);
      assigned[ownerIndex] = previous;
    }
    return false;
  };

  for (const { legIndex } of order) {
    if (!assigned[legIndex]) canTakeFixture(legIndex, new Set(), new Set());
  }

  return assigned
    .map((candidate, legIndex) => candidate ? { legIndex, candidate } : null)
    .filter(Boolean);
}
