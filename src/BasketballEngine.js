/**
 * BasketballEngine.js
 * Pure prediction logic for basketball games sourced from SofaScore.
 * No React, no side effects. Input: raw scraper JSON. Output: enriched prediction objects.
 *
 * All SofaScore fetches route through the GRM Pro server (/api/basketball/ss?path=...)
 * so they benefit from UA rotation, proxy pools, retry, and 403 backoff — same
 * infrastructure the football engine uses. The engine never calls SofaScore directly.
 */

// ─── SERVER PROXY FETCH ───────────────────────────────────────────────────────
// Resolved at import time from config.js. Falls back to localhost:3000 for dev.
import { SERVER } from "./config.js";

async function sfGet(ssPath) {
  try {
    const url = `${SERVER}/api/basketball/ss?path=${encodeURIComponent(ssPath)}`;
    const res = await fetch(url);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

// ─── RAW DATA FETCH ───────────────────────────────────────────────────────────

export async function fetchGamesForDate(dateStr) {
  // dateStr: "YYYY-MM-DD"
  // Uses the server's cached scheduled-events endpoint to avoid redundant SS hits.
  try {
    const url = `${SERVER}/api/basketball/scheduled-events/${dateStr}`;
    const res = await fetch(url);
    if (!res.ok) return [];
    const data = await res.json();
    return data?.events ?? [];
  } catch {
    return [];
  }
}

async function fetchEventFull(event) {
  const id = event.id;
  const homeTeamId = event.homeTeam?.id;
  const awayTeamId = event.awayTeam?.id;
  const tournamentId = event.tournament?.id;
  const seasonId = event.season?.id;

  const [pregameForm, h2h, odds, statistics, homeLastRaw0, homeLastRaw1, awayLastRaw0, awayLastRaw1, standings, lineups, homeStatsPR, awayStatsPR, boxScore] = await Promise.all([
    sfGet(`/event/${id}/pregame-form`),
    sfGet(`/event/${id}/h2h`),
    sfGet(`/event/${id}/odds/1/all`),
    sfGet(`/event/${id}/statistics`),
    sfGet(`/team/${homeTeamId}/events/last/0`),
    sfGet(`/team/${homeTeamId}/events/last/1`),
    sfGet(`/team/${awayTeamId}/events/last/0`),
    sfGet(`/team/${awayTeamId}/events/last/1`),
    tournamentId && seasonId ? sfGet(`/tournament/${tournamentId}/season/${seasonId}/standings/total`) : Promise.resolve(null),
    sfGet(`/event/${id}/lineups`),
    sfGet(`/event/${id}/player-statistics/1`),
    sfGet(`/event/${id}/player-statistics/2`),
    sfGet(`/event/${id}/box-score`),
  ]);

  // Merge home last events across two pages (mirrors away — playoffs can push events onto page 1)
  const homeAll = [...(homeLastRaw0?.events || []), ...(homeLastRaw1?.events || [])];
  const homeSeen = new Set();
  const homeLast = homeAll
    .filter(e => { if (homeSeen.has(e.id)) return false; homeSeen.add(e.id); return true; })
    .sort((a, b) => b.startTimestamp - a.startTimestamp)
    .slice(0, 15);

  // Merge away last events across two pages
  const awayAll = [...(awayLastRaw0?.events || []), ...(awayLastRaw1?.events || [])];
  const awaySeen = new Set();
  const awayLast = awayAll
    .filter(e => { if (awaySeen.has(e.id)) return false; awaySeen.add(e.id); return true; })
    .sort((a, b) => b.startTimestamp - a.startTimestamp)
    .slice(0, 15);

  // Parse player data — lineups, then player-statistics, then box-score.
  // See resolvePlayerData() for why each strategy is re-checked after parsing
  // rather than trusting a truthy raw response.
  const homeName = event.homeTeam?.name;
  const awayName = event.awayTeam?.name;
  const players = resolvePlayerData(lineups, homeStatsPR, awayStatsPR, boxScore, homeName, awayName);

  // Parse statistics by period
  const stats = parseStatsByPeriod(statistics);

  // Parse odds markets
  const oddsMarkets = parseOdds(odds);

  // Parse H2H
  const h2hParsed = parseH2H(h2h);

  // Parse standings
  const standingsParsed = parseStandings(standings);

  return { pregameForm, h2h: h2hParsed, odds: oddsMarkets, stats, homeLast, awayLast, players, standings: standingsParsed };
}

// ─── PARSERS ──────────────────────────────────────────────────────────────────

function parsePlayers(players, teamName) {
  if (!Array.isArray(players)) return [];
  return players.map(p => {
    const s = p.statistics || p;
    return {
      name: p.player?.name || p.name || null,
      jerseyNumber: p.player?.jerseyNumber ?? p.jerseyNumber ?? null,
      team: teamName,
      position: p.position || null,
      minutesPlayed: s.minutesPlayed ?? s.minutesPlaued ?? null, // SofaScore API typo seen in wild
      points: s.points ?? null,
      rebounds: s.rebounds ?? s.totalRebounds ?? null,
      offensiveRebounds: s.offensiveRebounds ?? null,
      defensiveRebounds: s.defensiveRebounds ?? null,
      assists: s.assists ?? null,
      steals: s.steals ?? null,
      blocks: s.blocks ?? null,
      turnovers: s.turnovers ?? null,
      fouls: s.personalFouls ?? s.fouls ?? null,
      plusMinus: s.plusMinus ?? null,
      fieldGoalsMade: s.fieldGoalsMade ?? null,
      fieldGoalsAttempted: s.fieldGoalsAttempted ?? null,
      threePointersMade: s.threePointersMade ?? null,
      freeThrowsMade: s.freeThrowsMade ?? null,
    };
  }).filter(p => p.name);
}

/**
 * Resolve player data via a 3-strategy fallback chain: lineups, then
 * player-statistics, then box-score. Mirrors sofascore-basketball.js's
 * getPlayerData() so the engine and the proven CLI scraper agree.
 *
 * A strategy is only accepted if it actually produced players AFTER
 * parsing — not just because the raw response object was truthy. Some
 * SofaScore responses come back as an empty shell ({}  or { players: [] })
 * on leagues that don't carry that data; trusting the raw truthiness check
 * would get the resolver "stuck" on a strategy with 0 players and never
 * fall through to the next one.
 */
function resolvePlayerData(lineups, homeStatsPR, awayStatsPR, boxScore, homeName, awayName) {
  if (lineups?.home?.players || lineups?.away?.players) {
    const home = parsePlayers(lineups.home?.players || [], homeName);
    const away = parsePlayers(lineups.away?.players || [], awayName);
    if (home.length || away.length) return { source: "lineups", home, away };
  }

  if (homeStatsPR || awayStatsPR) {
    const home = parsePlayers(homeStatsPR?.players || homeStatsPR?.statistics || [], homeName);
    const away = parsePlayers(awayStatsPR?.players || awayStatsPR?.statistics || [], awayName);
    if (home.length || away.length) return { source: "player-statistics", home, away };
  }

  if (boxScore) {
    const home = parsePlayers(boxScore.home?.players || boxScore.homeTeam?.players || [], homeName);
    const away = parsePlayers(boxScore.away?.players || boxScore.awayTeam?.players || [], awayName);
    if (home.length || away.length) return { source: "box-score", home, away };
  }

  return null;
}

function parseStatsByPeriod(statistics) {
  if (!statistics?.statistics) return null;
  const result = {};
  for (const period of statistics.statistics) {
    const key = period.period || "ALL";
    result[key] = {};
    for (const group of period.groups || []) {
      for (const item of group.statisticsItems || []) {
        result[key][item.name] = { home: item.home, away: item.away };
      }
    }
  }
  return result;
}

function parseOdds(oddsData) {
  if (!oddsData?.markets) return null;
  const markets = {};
  for (const market of oddsData.markets) {
    const name = market.marketName || market.name;
    if (!name) continue;
    const choices = {};
    for (const choice of market.choices || []) {
      // SofaScore may provide fractional ("5/6"), decimal ("1.83"), or null.
      // Store raw — fractionalToDecimal handles both formats at use-time.
      const raw = choice.fractionalValue ?? choice.initialFractionalValue ?? null;
      if (raw != null && choice.name) choices[choice.name] = raw;
    }
    if (Object.keys(choices).length > 0) markets[name] = choices;
  }
  return markets;
}

function parseH2H(h2hData) {
  if (!h2hData) return null;
  return {
    homeWins: h2hData.homeWins ?? 0,
    awayWins: h2hData.awayWins ?? 0,
    draws: h2hData.draws ?? 0,
    recent: (h2hData.events || []).slice(0, 5).map(e => ({
      date: new Date(e.startTimestamp * 1000).toISOString().split("T")[0],
      home: e.homeTeam?.name,
      away: e.awayTeam?.name,
      homeScore: e.homeScore?.current ?? null,
      awayScore: e.awayScore?.current ?? null,
    })),
  };
}

function parseStandings(standingsData) {
  if (!standingsData?.standings) return null;
  return (standingsData.standings[0]?.rows || []).map(row => ({
    position: row.position,
    team: row.team?.name,
    played: row.matches,
    wins: row.wins,
    losses: row.losses,
  }));
}

// ─── FORM & RECORD HELPERS ────────────────────────────────────────────────────

/**
 * Extract W/L record for a team from their last N games.
 * Returns { wins, losses, winPct, avgPtsFor, avgPtsAgainst, avgMargin, streak }
 */
function teamRecord(lastEvents, teamId, teamName) {
  if (!lastEvents?.length) return { wins: 0, losses: 0, winPct: 0.5, avgPtsFor: 100, avgPtsAgainst: 100, avgMargin: 0, streak: 0 };

  let wins = 0, losses = 0, totalFor = 0, totalAgainst = 0;
  let streak = 0, streakDir = null;

  for (const e of lastEvents) {
    const isHome = e.homeTeam?.id === teamId || e.home === teamName;
    const hScore = e.homeScore?.current ?? e.homeScore ?? null;
    const aScore = e.awayScore?.current ?? e.awayScore ?? null;
    if (hScore == null || aScore == null) continue;

    const ptsFor     = isHome ? hScore : aScore;
    const ptsAgainst = isHome ? aScore : hScore;
    const won = ptsFor > ptsAgainst;

    totalFor     += ptsFor;
    totalAgainst += ptsAgainst;
    won ? wins++ : losses++;

    // streak: positive = win streak, negative = loss streak
    if (streakDir === null) {
      streakDir = won;
      streak = won ? 1 : -1;
    } else if (won === streakDir) {
      streak += won ? 1 : -1;
    }
    // stop streak counting once it breaks
  }

  const played = wins + losses;
  return {
    wins,
    losses,
    winPct:        played ? wins / played : 0.5,
    avgPtsFor:     played ? totalFor / played : 100,
    avgPtsAgainst: played ? totalAgainst / played : 100,
    avgMargin:     played ? (totalFor - totalAgainst) / played : 0,
    streak,
  };
}

/**
 * Home/away split — same logic, filtered by venue.
 */
function venueRecord(lastEvents, teamId, teamName, venue) {
  const filtered = (lastEvents || []).filter(e => {
    const isHome = e.homeTeam?.id === teamId || e.home === teamName;
    return venue === "home" ? isHome : !isHome;
  });
  return teamRecord(filtered, teamId, teamName);
}

/**
 * Derive a form string from last events: "WWLWL" newest-first.
 */
function formString(lastEvents, teamId, teamName, n = 5) {
  const results = [];
  for (const e of lastEvents.slice(0, n * 2)) {
    if (results.length >= n) break;
    const isHome = e.homeTeam?.id === teamId || e.home === teamName;
    const hScore = e.homeScore?.current ?? e.homeScore ?? null;
    const aScore = e.awayScore?.current ?? e.awayScore ?? null;
    if (hScore == null || aScore == null) continue;
    const ptsFor = isHome ? hScore : aScore;
    const ptsAgainst = isHome ? aScore : hScore;
    results.push(ptsFor > ptsAgainst ? "W" : "L");
  }
  return results.join("");
}

// ─── QUARTER ANALYSIS ─────────────────────────────────────────────────────────

/**
 * Predict quarter winners based on per-quarter team stats from recent games.
 * Uses the statistics object (keyed by period: "1ST", "2ND", "3RD", "4TH").
 * Falls back to overall margin-based projection if no per-quarter stats.
 */
function predictQuarters(stats, homeRecord, awayRecord) {
  const quarters = ["1ST", "2ND", "3RD", "4TH"];
  const predictions = [];

  for (const q of quarters) {
    const periodStats = stats?.[q];
    if (periodStats) {
      // Use actual quarter points if the game has stats (post-game)
      const homePts = parseFloat(periodStats["Points"]?.home ?? periodStats["Score"]?.home ?? 0);
      const awayPts = parseFloat(periodStats["Points"]?.away ?? periodStats["Score"]?.away ?? 0);
      if (homePts > 0 || awayPts > 0) {
        predictions.push({ quarter: q, homeScore: homePts, awayScore: awayPts, winner: homePts > awayPts ? "home" : homePts < awayPts ? "away" : "draw", actual: true });
        continue;
      }
    }
    // Pre-game: estimate from overall scoring tendencies
    // Q1 typically slightly higher for favourites; Q4 flips if trailing
    const homeBase = homeRecord.avgPtsFor / 4;
    const awayBase = awayRecord.avgPtsFor / 4;
    const homeEst  = homeBase * (q === "1ST" ? 1.02 : q === "4TH" ? 0.98 : 1.0);
    const awayEst  = awayBase * (q === "1ST" ? 0.98 : q === "4TH" ? 1.02 : 1.0);
    predictions.push({
      quarter: q,
      homeEst: Math.round(homeEst * 10) / 10,
      awayEst: Math.round(awayEst * 10) / 10,
      winner: homeEst > awayEst ? "home" : homeEst < awayEst ? "away" : "draw",
      actual: false,
    });
  }
  return predictions;
}

// ─── TOTAL POINTS MODEL ───────────────────────────────────────────────────────

/**
 * Estimate expected total points for the game.
 * Combines both teams' recent offensive and defensive averages.
 */
function estimateTotal(homeRecord, awayRecord) {
  // Projected score = home offence vs away defence, plus away offence vs home defence
  const homeProjected = (homeRecord.avgPtsFor + awayRecord.avgPtsAgainst) / 2;
  const awayProjected = (awayRecord.avgPtsFor + homeRecord.avgPtsAgainst) / 2;
  return Math.round((homeProjected + awayProjected) * 10) / 10;
}

/**
 * Compare estimated total to the market line and produce an over/under signal.
 */
function totalSignal(estimatedTotal, marketLine) {
  if (!marketLine) return null;
  const line = parseFloat(marketLine);
  if (isNaN(line) || line <= 0) return null;
  const diff = estimatedTotal - line;
  // Confidence curve: 50% at 0pt edge, scales slowly — a 10pt edge ≈ 65%, 20pt ≈ 74%.
  // Original 3.5x multiplier reached 85% at 10pts which is statistically unjustified.
  // Using tanh-based scaling: saturates naturally, never claims >88% conf from this model alone.
  const conf = Math.min(88, 50 + Math.tanh(Math.abs(diff) / 15) * 38);
  return {
    line,
    estimated: estimatedTotal,
    direction: diff > 0 ? "OVER" : "UNDER",
    margin: Math.abs(Math.round(diff * 10) / 10),
    confidence: Math.round(conf),
  };
}

// ─── WIN PROBABILITY MODEL ────────────────────────────────────────────────────

/**
 * Multi-factor win probability for the home team.
 * Factors: form (W%), H2H record, home advantage, margin trend, scoring differential.
 * Returns a 0–1 probability for the home team winning.
 */
function winProbability(homeRecord, awayRecord, h2h, isHomeGame = true) {
  // Base: each team's win rate
  const homeWinPct  = homeRecord.winPct;
  const awayWinPct  = awayRecord.winPct;

  // Normalised head-to-head advantage
  const h2hTotal = (h2h?.homeWins ?? 0) + (h2h?.awayWins ?? 0);
  const h2hBonus = h2hTotal > 0
    ? ((h2h.homeWins - h2h.awayWins) / h2hTotal) * 0.08
    : 0;

  // Home court advantage (~3-4 pts in NBA ≈ +0.04 win probability)
  const homeCourt = isHomeGame ? 0.04 : 0;

  // Scoring margin trend (normalised — large positive margin = better)
  const marginFactor = Math.tanh((homeRecord.avgMargin - awayRecord.avgMargin) / 20) * 0.10;

  // Streak signal: teams on win/loss streaks show persistence beyond their base W%
  // Capped at ±0.06 to prevent a 5-game streak from dominating the model
  const homeStreakBonus = Math.max(-0.06, Math.min(0.06, (homeRecord.streak || 0) * 0.012));
  const awayStreakBonus = Math.max(-0.06, Math.min(0.06, (awayRecord.streak || 0) * 0.012));

  // Blend factors
  const raw = (homeWinPct * 0.43)
    + ((1 - awayWinPct) * 0.33)
    + h2hBonus
    + homeCourt
    + marginFactor
    + homeStreakBonus
    - awayStreakBonus; // away team on hot streak hurts home probability

  // Clamp to [0.10, 0.90] — model won't claim near-certainty
  return Math.min(0.90, Math.max(0.10, raw));
}

// ─── ODDS HELPERS ─────────────────────────────────────────────────────────────

/** Convert fractional odds string "5/6" or decimal string "1.83" to decimal number */
export function fractionalToDecimal(frac) {
  if (frac == null) return null;
  const s = String(frac).trim();
  if (!s) return null;
  // Fractional: "5/6", "11/8"
  const parts = s.split("/");
  if (parts.length === 2) {
    const num = parseFloat(parts[0]);
    const den = parseFloat(parts[1]);
    if (!isFinite(num) || !isFinite(den) || den === 0) return null;
    const d = num / den + 1;
    return isFinite(d) && d > 1 ? Math.round(d * 100) / 100 : null;
  }
  // Already decimal: "1.83", "2.10"
  const d = parseFloat(s);
  return isFinite(d) && d > 1 ? Math.round(d * 100) / 100 : null;
}

/** Implied probability from decimal odds */
function decimalToProb(decimal) {
  if (!decimal || decimal <= 1) return null;
  return Math.round((1 / decimal) * 100);
}

/** Probability to decimal odds (with 5% margin) */
function probToDecimal(prob) {
  if (!prob || prob <= 0 || prob >= 100) return null;
  const d = 1 / ((prob / 100) * 0.95);
  return isFinite(d) && d > 1 ? Math.round(d * 100) / 100 : null;
}

// ─── BEST PICK SELECTOR ───────────────────────────────────────────────────────

/**
 * Picks the single highest-confidence bet for a game.
 * Candidates: moneyline home, moneyline away, total over/under.
 * Returns { pick, market, confidence, odds, basis }.
 */
function selectBestPick(homeTeam, awayTeam, homeProb, totalSig, oddsMarkets) {
  const candidates = [];

  // Moneyline picks
  const awayProb = 100 - homeProb;
  const mlOdds = oddsMarkets?.["Full time"]
    || oddsMarkets?.["Moneyline"]
    || oddsMarkets?.["1X2"]
    || null;

  const homeDecimal = mlOdds
    ? fractionalToDecimal(mlOdds["1"] || mlOdds["Home"] || mlOdds[homeTeam])
    : probToDecimal(homeProb);
  const awayDecimal = mlOdds
    ? fractionalToDecimal(mlOdds["2"] || mlOdds["Away"] || mlOdds[awayTeam])
    : probToDecimal(awayProb);

  if (homeProb >= 55) {
    candidates.push({
      pick: `${homeTeam} ML`,
      market: "Moneyline",
      confidence: homeProb,
      odds: homeDecimal,
      basis: "form + H2H + home court",
    });
  }
  if (awayProb >= 55) {
    candidates.push({
      pick: `${awayTeam} ML`,
      market: "Moneyline",
      confidence: awayProb,
      odds: awayDecimal,
      basis: "form + H2H",
    });
  }

  // Total pick
  if (totalSig && totalSig.confidence >= 58) {
    const totalOddsKey = totalSig.direction === "OVER" ? "Over" : "Under";
    const totalMarketOdds = oddsMarkets?.["Total"]?.[totalOddsKey]
      || oddsMarkets?.["Over/Under"]?.[totalOddsKey]
      || null;
    candidates.push({
      pick: `${totalSig.direction} ${totalSig.line}`,
      market: "Total",
      confidence: totalSig.confidence,
      odds: totalMarketOdds ? fractionalToDecimal(totalMarketOdds) : probToDecimal(totalSig.confidence),
      basis: `estimated ${totalSig.estimated} pts vs line ${totalSig.line}`,
    });
  }

  if (!candidates.length) return null;
  return candidates.sort((a, b) => b.confidence - a.confidence)[0];
}

// ─── PLAYER FLAGS ─────────────────────────────────────────────────────────────

/**
 * Returns notable player flags: top scorers, foul risk, +/- leaders.
 */
function playerFlags(players) {
  if (!players) return null;
  const all = [...(players.home || []), ...(players.away || [])];

  const topScorers = all
    .filter(p => p.points != null)
    .sort((a, b) => b.points - a.points)
    .slice(0, 5);

  const foulRisk = all
    .filter(p => p.fouls != null && p.fouls >= 4)
    .sort((a, b) => b.fouls - a.fouls);

  const pmLeaders = all
    .filter(p => p.plusMinus != null)
    .sort((a, b) => b.plusMinus - a.plusMinus)
    .slice(0, 3);

  return { topScorers, foulRisk, pmLeaders };
}

// ─── ROLLOVER POOL ────────────────────────────────────────────────────────────

/**
 * Build a rollover-eligible pool from enriched games.
 * Each entry: { game, pick, odds, confidence, basis }
 * Only includes picks with confidence ≥ 60% and odds ≥ 1.50.
 */
export function buildBasketballRolloverPool(enrichedGames) {
  const pool = [];
  for (const g of enrichedGames) {
    if (!g.bestPick) continue;
    const { confidence, odds } = g.bestPick;
    if (confidence < 60) continue;
    if (!odds || odds < 1.50) continue;
    pool.push({
      gameId: g.eventId,
      game: `${g.homeTeam} vs ${g.awayTeam}`,
      homeTeam: g.homeTeam,
      awayTeam: g.awayTeam,
      tournament: g.tournament,
      startTime: g.startTime,
      status: g.status,
      ...g.bestPick,
    });
  }
  return pool.sort((a, b) => b.confidence - a.confidence);
}

/**
 * Build a two-leg rollover pick targeting ≥ 2.00 combined odds.
 * Mirrors football's buildRolloverPick logic, basketball flavour.
 */
export function buildBasketballRolloverPick(pool) {
  if (pool.length < 1) return null;

  // Try single high-confidence pick first if odds ≥ 2.00
  const single = pool.find(p => p.odds >= 2.00 && p.confidence >= 62);
  if (single) {
    return {
      legs: [single],
      combinedOdds: single.odds,
      combinedConfidence: single.confidence,
      label: "BB Rollover · Single",
    };
  }

  // Two-leg combo: find best pair whose combined odds ≥ 2.00
  for (let i = 0; i < pool.length; i++) {
    for (let j = i + 1; j < pool.length; j++) {
      const a = pool[i], b = pool[j];
      // Must be different games
      if (a.gameId === b.gameId) continue;
      const combined = (a.odds || 1) * (b.odds || 1);
      if (combined < 2.00) continue;
      const combinedConf = Math.round((a.confidence + b.confidence) / 2);
      return {
        legs: [a, b],
        combinedOdds: Math.round(combined * 100) / 100,
        combinedConfidence: combinedConf,
        label: "BB Rollover · Parlay",
      };
    }
  }
  return null;
}

// ─── MAIN ENRICH PIPELINE ─────────────────────────────────────────────────────

/**
 * Full enrichment pipeline for a single raw SofaScore event.
 * Returns a prediction-ready object.
 */
export async function enrichGame(event) {
  const full = await fetchEventFull(event);

  const homeId   = event.homeTeam?.id;
  const awayId   = event.awayTeam?.id;
  const homeName = event.homeTeam?.name ?? "Home";
  const awayName = event.awayTeam?.name ?? "Away";

  const homeRecord = teamRecord(full.homeLast, homeId, homeName);
  const awayRecord = teamRecord(full.awayLast, awayId, awayName);
  const homeVenue  = venueRecord(full.homeLast, homeId, homeName, "home");
  const awayVenue  = venueRecord(full.awayLast, awayId, awayName, "away");

  const homeWinProb = Math.round(winProbability(homeRecord, awayRecord, full.h2h) * 100);
  const awayWinProb = 100 - homeWinProb;

  // Total from market — look for "Total" or "Over/Under" market line.
  // Market keys can be numeric strings like "230.5", named like "Over", or labelled "Total 230.5".
  // We extract the first key that looks like a number (the handicap line).
  const totalMarket = full.odds?.["Total"] || full.odds?.["Over/Under"] || full.odds?.["Total Points"] || null;
  const marketLine  = (() => {
    if (!totalMarket) return null;
    // Priority 1: a key that is itself a pure decimal number
    const pureNum = Object.keys(totalMarket).find(k => /^\d+(\.\d+)?$/.test(k));
    if (pureNum) return pureNum;
    // Priority 2: a key containing a number (e.g. "Total 230.5", "Over 225")
    const withNum = Object.keys(totalMarket).find(k => /\d{2,}(\.\d+)?/.test(k));
    if (withNum) { const m = withNum.match(/(\d{2,}(\.\d+)?)/); return m ? m[1] : null; }
    return null;
  })();
  const estTotal   = estimateTotal(homeRecord, awayRecord);
  const totalSig   = totalSignal(estTotal, marketLine);

  const quarterPreds = predictQuarters(full.stats, homeRecord, awayRecord);
  const bestPick     = selectBestPick(homeName, awayName, homeWinProb, totalSig, full.odds);
  const flags        = playerFlags(full.players);

  const homeForm = formString(full.homeLast, homeId, homeName, 5);
  const awayForm = formString(full.awayLast, awayId, awayName, 5);

  return {
    // Identity
    eventId:    event.id,
    homeTeam:   homeName,
    awayTeam:   awayName,
    homeTeamId: homeId,
    awayTeamId: awayId,
    tournament: event.tournament?.name ?? null,
    league:     event.tournament?.uniqueTournament?.name ?? event.tournament?.name ?? null,
    startTime:  event.startTimestamp ? new Date(event.startTimestamp * 1000).toISOString() : null,
    status:     event.status?.description ?? null,
    statusCode: event.status?.code ?? null,

    // Scores
    homeScore: event.homeScore?.current ?? null,
    awayScore: event.awayScore?.current ?? null,
    scoreByQuarter: {
      home: {
        q1: event.homeScore?.period1 ?? null,
        q2: event.homeScore?.period2 ?? null,
        q3: event.homeScore?.period3 ?? null,
        q4: event.homeScore?.period4 ?? null,
        ot: event.homeScore?.overtime ?? null,
      },
      away: {
        q1: event.awayScore?.period1 ?? null,
        q2: event.awayScore?.period2 ?? null,
        q3: event.awayScore?.period3 ?? null,
        q4: event.awayScore?.period4 ?? null,
        ot: event.awayScore?.overtime ?? null,
      },
    },

    // Prediction
    homeWinProb,
    awayWinProb,
    homeRecord,
    awayRecord,
    homeVenueRecord: homeVenue,
    awayVenueRecord: awayVenue,
    homeForm,
    awayForm,
    quarterPredictions: quarterPreds,
    estimatedTotal: estTotal,
    totalSignal: totalSig,
    bestPick,

    // Detail data
    h2h:       full.h2h,
    odds:      full.odds,
    stats:     full.stats,
    players:   full.players,
    flags,
    standings: full.standings,
    homeLast:  full.homeLast.slice(0, 8),
    awayLast:  full.awayLast.slice(0, 8),
  };
}

/**
 * Enrich a full day's slate.
 * Returns array of enriched games in parallel batches of 4
 * to avoid hammering SofaScore with 20 concurrent requests.
 */
export async function enrichGamesForDate(dateStr, onProgress) {
  const events = await fetchGamesForDate(dateStr);
  if (!events.length) return [];

  const results = [];
  const BATCH = 4;
  for (let i = 0; i < events.length; i += BATCH) {
    const batch = events.slice(i, i + BATCH);
    const enriched = await Promise.all(batch.map(e => enrichGame(e).catch(err => ({
      eventId: e.id,
      homeTeam: e.homeTeam?.name ?? "?",
      awayTeam: e.awayTeam?.name ?? "?",
      error: err.message,
    }))));
    results.push(...enriched);
    onProgress?.(Math.min(99, Math.round(((i + BATCH) / events.length) * 100)));
  }
  return results;
}
