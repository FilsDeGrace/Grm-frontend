// ─── GRM Pro v15 Config ───────────────────────────────────────────────────
// Single source of truth for all tunable constants.
// Both server and frontend import from here.

// ── API ──────────────────────────────────────────────────────────────────
export const SERVER = "https://cf4eafcc630c1f.lhr.life"; // Update when tunnel changes
export const SS_BASE = "https://api.sofascore.com/api/v1";
// Full browser-accurate headers. Minimal headers (User-Agent + Accept only) are
// trivially fingerprinted by SofaScore as non-browser and rate-limited aggressively.
// sec-fetch-* + Origin are what a real browser XHR sends to same-origin APIs.
// Rotating User-Agents are in SS_USER_AGENTS below — ssGet picks one per request.
export const SS_HEADERS = {
  "Accept":           "application/json, text/plain, */*",
  "Accept-Language":  "en-GB,en;q=0.9",
  "Accept-Encoding":  "gzip, deflate, br",
  "Referer":          "https://www.sofascore.com/",
  "Origin":           "https://www.sofascore.com",
  "x-requested-with": "XMLHttpRequest",
  "sec-fetch-dest":   "empty",
  "sec-fetch-mode":   "cors",
  "sec-fetch-site":   "same-origin",
  "Cache-Control":    "no-cache",
  "Pragma":           "no-cache",
};

// Rotating User-Agent pool — mobile + desktop mix.
// ssGet picks one per request using a round-robin index.
// SofaScore tracks UA fingerprints — repeating the same UA across 700 requests
// is as bad as a static header.
export const SS_USER_AGENTS = [
  // Chrome on Windows
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  // Chrome on Mac
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  // Safari on iPhone
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1",
  // Chrome on Android
  "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.6367.82 Mobile Safari/537.36",
  // Firefox on Windows
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0",
  // Edge on Windows
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 Edg/124.0.0.0",
  // Safari on iPad
  "Mozilla/5.0 (iPad; CPU OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1",
  // Chrome on Android (another model)
  "Mozilla/5.0 (Linux; Android 13; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.6367.82 Mobile Safari/537.36",
];

// Rotate UA every N requests — proactive not reactive
export const SS_ROTATE_UA_EVERY = 15;

// Scheduled-events response cache TTL (ms) — the bulk fixture list only needs
// one fetch per session. 30 min prevents redundant re-fetches during testing.
export const SS_SCHEDULED_TTL = 30 * 60_000;

// ── Schema ───────────────────────────────────────────────────────────────
export const SCHEMA_VERSION     = 15;
export const MIN_SCHEMA_VERSION = 14;

// ── Poisson Model ────────────────────────────────────────────────────────
export const HOME_ADV       = 1.06;   // was 1.08 — slight reduction, more realistic
export const AWAY_ADV       = 0.96;   // was 0.95
export const XG_SANITY_MAX  = 3.5;    // sanity guard only — should never trigger with normalised inputs
export const LOW_CONF_FLOOR = 10;     // min season games before _lowConfidence flag

// ── Dixon-Coles Blend Ratios ──────────────────────────────────────────────
export const SEASON_BLEND    = 0.65;  // 65% season base rate
export const RECENT_BLEND    = 0.35;  // 35% recent form
export const MIN_RECENT_GAMES = 6;    // minimum same-league games needed for recent modifier

// ── Probability Deflation Curve ───────────────────────────────────────────
// Applied post-calibration before display and pick selection.
// Corrects for systematic overconfidence at high probability bands.
// Backtest: model at 90%+ only hit 78.6% actual.
export const DEFLATE_80 = 0.97;  // 80–85% band
export const DEFLATE_85 = 0.93;  // 85–90% band
export const DEFLATE_90 = 0.89;  // 90–95% band
export const DEFLATE_95 = 0.86;  // 95%+ band

// ── Market-Specific Post-Deflation Multipliers ────────────────────────────
// Applied after the standard deflation curve in applyDeflationCurve().
// Backtest: O3.5 overconfident by ~14.7%, O4.5 by ~13%. Mirror lines underconfident by +17%.
// Root cause: Poisson tail is too fat at high-goal lines — deflate over, inflate under.
export const DEFLATE_OVER35  = 0.88; // additional compression on O3.5
export const DEFLATE_OVER45  = 0.84; // additional compression on O4.5
export const DEFLATE_UNDER35 = 1.00; // removed 1.06 upward push — U3.5 already dominant, no justification to inflate further
export const DEFLATE_UNDER45 = 1.08; // slight upward calibration on U4.5

// ── The Read Thresholds (post-deflation) ─────────────────────────────────
export const READ_1X2_MIN       = 55;  // lowered from 58 — 55-58% games have real directional lean, were being missed
export const READ_BTTS_MIN      = 63;  // BTTS Yes
export const READ_OVER25_MIN    = 63;  // lowered from 65
export const READ_UNDER25_MIN   = 70;  // Under 2.5 / Under 3.5 entry threshold — raised from 65, was generating too many low-confidence U3.5 picks
export const READ_TEAMTOTAL_MIN = 80;  // TeamTotal O0.5 only — raised, worst market in backtest
// READ_FALLBACK_MIN removed — fallback (U4.5/U3.5/O1.5) eliminated entirely.
// If nothing qualifies in the pool, getRead returns null. No pick is better than a bad pick.

// ── The Read — Strong Signal (1X2 only) ──────────────────────────────────
// ratio = (prob - threshold) / threshold
// Backtest: STRONG 1X2 = 65.5%, LEAN 1X2 = 52.6%. 12.9% gap. Real signal.
export const READ_STRONG_RATIO   = 0.12; // 1X2/DC: (prob-threshold)/threshold > this = STRONG
export const READ_STRONG_BTTS    = 72;   // BTTS Yes strong threshold
export const READ_STRONG_OVER25  = 72;   // Over 2.5 strong threshold
export const READ_STRONG_UNDER35 = 80;   // Under 3.5 strong threshold (higher bar — market hits a lot)
export const READ_STRONG_OVER15  = 88;   // Over 1.5 strong threshold (even higher — very common market)
export const READ_STRONG_DC      = 80;   // DC strong threshold

// ── The Edge Thresholds ───────────────────────────────────────────────────
export const EDGE_CONVERGENCE_MIN  = 2;    // min markets pointing same scenario
export const EDGE_PROB_MIN         = 60;   // min prob for any edge market
export const EDGE_ODDS_DISCREPANCY = 0.08; // model prob must exceed implied odds by 8%+

// ── Goal Radar Threshold ─────────────────────────────────────────────────
// Post-deflation thresholds for Goal Radar tab.
// O0.5: lowered to 85 — 92 was too restrictive post-DEFLATE_UNDER35 upward shift.
// O1.5: separate lower threshold for wider coverage.
export const GOAL_RADAR_MIN     = 85;  // HO0.5 / AO0.5 entry threshold (was 92)
export const GOAL_RADAR_O15_MIN = 75;  // HO1.5 / AO1.5 entry threshold (new)

// ── Strategy Thresholds (tightened from v14) ──────────────────────────────
// ── STRATEGY THRESHOLDS (v15.1 — calibrated from Apr 4–24 backtest) ───────
// home_win: absolute xG gap ≥0.9, floor homeXG ≥1.4, CS gate dropped
export const STRAT_HOME_WIN_MIN      = 65;   // homeWin prob gate
export const STRAT_HOME_WIN_XG_GAP   = 0.9;  // abs xG gap in home's favour
export const STRAT_HOME_WIN_XG_FLOOR = 1.4;  // homeXG floor (no stalemate fires)

// away_win: slightly relaxed — away underperformance bias
export const STRAT_AWAY_WIN_MIN      = 55;   // awayWin prob gate
export const STRAT_AWAY_WIN_XG_GAP   = 0.7;  // abs xG gap in away's favour
export const STRAT_AWAY_WIN_XG_FLOOR = 1.2;  // awayXG floor

// btts_value: both sides must show attacking signal independently
export const STRAT_BTTS_MIN          = 65;   // bttsYes primary gate
export const STRAT_BTTS_HO05_MIN     = 75;   // homeOver05 must also clear (was missing)
export const STRAT_BTTS_AWAYO05_MIN  = 70;   // awayOver05

// home_goalfest: home attacking output + dominance (CS gate removed)
export const STRAT_HOME_GOALFEST_XG  = 2.2;  // homeXG floor
export const STRAT_HOME_GOALFEST_O05 = 88;   // homeOver05 floor
export const STRAT_HOME_GOALFEST_WIN = 62;   // homeWin floor

// away_goalfest: mirror, slightly relaxed
export const STRAT_AWAY_GOALFEST_XG  = 2.0;  // awayXG floor
export const STRAT_AWAY_GOALFEST_O05 = 85;   // awayOver05 floor
export const STRAT_AWAY_GOALFEST_WIN = 55;   // awayWin floor

// over25_quality: total xG independent signal + btts confirms two-sided scoring
export const STRAT_OVER25_MIN        = 70;   // over25 primary gate
export const STRAT_OVER25_XG_TOTAL   = 2.6;  // (homeXG+awayXG) floor — independent of prob
export const STRAT_OVER25_BTTS_MIN   = 55;   // bttsYes confirms two-sided

// low_scoring: BOTH sides must show defensive shape (AND not OR)
export const STRAT_LOW_SCORING_CS    = 30;   // homeCS AND awayCS must both clear
export const STRAT_LOW_SCORING_XG    = 2.0;  // total xG ceiling
export const STRAT_LOW_SCORING_U25   = 65;   // under25 gate

// draw: balance + competitiveness (not 0-0 targeting)
export const STRAT_DRAW_MIN          = 30;   // draw prob primary gate
export const STRAT_DRAW_WIN_SPREAD   = 15;   // |homeWin - awayWin| ≤ 15 (roughly equal)
export const STRAT_DRAW_XG_MIN       = 1.4;  // total xG floor (both teams live)
export const STRAT_DRAW_XG_MAX       = 2.6;  // total xG ceiling (not a goalfest)

// ── Draw Strategy (experimental — needs backtest validation post-v15 xG fix) ──
// (draw constants now in STRAT_DRAW_* above)

// ── Home Resilience Modifier ──────────────────────────────────────────────
export const RESILIENCE_COMPRESSION = 0.06; // 6% away win compression toward home+draw
export const RESILIENCE_XG_OVERRIDE = 1.2;  // skip if awayXG > homeXG by this margin
export const RESILIENCE_HOME_FORM   = 3;    // min home wins in last 5 home games

// ── Contextual Modifier Caps ──────────────────────────────────────────────
export const MODIFIER_H2H_MAX       = 0.04; // ±4% max from H2H goal signal
export const MODIFIER_H2H_RESULT_MAX= 0.03; // ±3% max from H2H win rate / BTTS rate signal
export const MODIFIER_RESILIENCE_MAX= 0.06; // ±6% max from home resilience
export const MODIFIER_FORM_MAX      = 0.03; // ±3% max from form momentum
export const MODIFIER_TABLE_MAX     = 0.03; // ±3% max from table gap
export const MODIFIER_TOTAL_CAP     = 0.08; // ±8% total cap across all modifiers

// ── Combo Display Thresholds ──────────────────────────────────────────────
export const COMBO_OVER25_BTTS_MIN   = 62;
export const COMBO_HW_OVER25_HW_MIN  = 68;
export const COMBO_HW_OVER25_O25_MIN = 65;
// DC — single threshold for all three variants (1X, X2, 12).
// Best variant is auto-selected by highest combined probability.
export const COMBO_DC_MIN            = 75;

// ── Calibration ───────────────────────────────────────────────────────────
// weight = min((seasonGames/34)*0.60 + (recentLeagueGames/10)*0.20, 0.75)
// With 30 season + 10 recent: 0.529 + 0.20 = 0.729 → capped 0.75
// vs v14 always-28% — massive improvement
export const CALIB_SEASON_FACTOR = 0.60;
export const CALIB_RECENT_FACTOR = 0.20;
export const CALIB_MAX_WEIGHT    = 0.75;
export const CALIB_SEASON_GAMES  = 34;   // full season games (normaliser)
export const CALIB_RECENT_GAMES  = 10;   // recent games normaliser

// ── Form xG Blend ─────────────────────────────────────────────────────────
// Controls how much cross-competition recent form xG blends into Poisson xG.
// Priority 1 fix: cup games get pure form (1.0), normal leagues get 0.3–0.5.
// formWeight = how much the form xG contributes vs the Poisson xG.
export const FORM_WEIGHT_CUP          = 1.0;  // no standings at all — pure form
export const FORM_WEIGHT_EARLY_SEASON = 0.6;  // sg < 10 — season data too thin
export const FORM_WEIGHT_BASE         = 0.3;  // minimum blend (well-established leagues)
export const FORM_WEIGHT_MAX          = 0.5;  // cap — Poisson foundation stays dominant
export const FORM_WEIGHT_SCALE_GAMES  = 20;   // games to reach FORM_WEIGHT_MAX
export const FORM_HOME_VENUE_WEIGHT   = 1.1;  // home games weighted +10% for all-comp avg
export const FORM_AWAY_VENUE_WEIGHT   = 0.9;  // away games weighted -10%
export const FORM_MIN_ALLCOMP_GAMES   = 6;    // min all-comp games before form xG is used
export const FORM_EARLY_SEASON_GAMES  = 10;   // sg threshold for FORM_WEIGHT_EARLY_SEASON
// Hard block: cup + fewer than this many combined all-comp games = no pick, "Insufficient Data"
export const INSUFFICIENT_DATA_MIN_COMBINED = 12;

// ── Jarvis ────────────────────────────────────────────────────────────────
// Empirical Jarvis — builds parlays from backtest win rate patterns.
// Gemini used for narrative explanation only, not pick selection.
export const JARVIS_GOAL_RADAR_CAP    = 10;   // max legs in Goal Radar portfolio
export const JARVIS_MIN_EDGE_PCT      = 3;    // historical WR must exceed model pred by 3%+
export const JARVIS_MIN_HISTORICAL_N  = 10;   // min backtest samples before trusting a band
export const JARVIS_GEMINI_MODEL      = "gemini-2.0-flash"; // free tier

// ── Odds Floors ───────────────────────────────────────────────────────────
// Picks below these odds are suppressed — no betting value at lower prices.
export const MIN_ODDS_READ  = 1.15;
export const MIN_ODDS_EDGE  = 1.15;
export const MIN_ODDS_RADAR = 1.15;
export const MIN_ODDS_RADAR_O05 = 1.04;  // O0.5 high-prob picks: 92% → 1.087x, still worth showing

// ── New Correlated Combo Thresholds ──────────────────────────────────────
export const COMBO_BTTS_OVER25_MIN   = 60; // both BTTS and Over 2.5 must clear this
export const COMBO_HW_OVER15_HW_MIN  = 62; // Home Win min for HW + Over 1.5
export const COMBO_HW_OVER15_O15_MIN = 72; // Over 1.5 min for HW + Over 1.5
export const COMBO_AW_OVER15_AW_MIN  = 62; // Away Win min for AW + Over 1.5
export const COMBO_AW_OVER15_O15_MIN = 72; // Over 1.5 min for AW + Over 1.5
export const COMBO_HW_BTTS_HW_MIN    = 62; // Home Win min for HW + BTTS
export const COMBO_HW_BTTS_BTTS_MIN  = 60; // BTTS min for HW + BTTS
export const COMBO_AW_BTTS_AW_MIN    = 62; // Away Win min for AW + BTTS
export const COMBO_AW_BTTS_BTTS_MIN  = 60; // BTTS min for AW + BTTS

// ── League Rank ───────────────────────────────────────────────────────────
// Lower number = higher priority in sort. Unlisted leagues get rank 999.
// Name-based map used as fallback when tournament ID is not in LEAGUE_RANK_BY_ID.
export const LEAGUE_RANK = {
  "UEFA Champions League":1,"Champions League":1,
  "UEFA Europa League":2,"Europa League":2,
  "UEFA Conference League":3,"Conference League":3,
  "Premier League":10,
  "LaLiga":11,"La Liga":11,
  "Bundesliga":12,
  "Serie A":13,
  "Ligue 1":14,
  "Eredivisie":20,"VriendenLoterij Eredivisie":20,
  "Liga Portugal":21,
  "Super Lig":22,"Süper Lig":22,"Trendyol Süper Lig":22,   // SB sends "Super Lig" (no umlaut)
  "Premiership":23,"Scottish Premiership":23,
  "Pro League":24,
  "Ekstraklasa":25,
  "1. Liga":26,"Czech First League":26,"Chance Liga":26,     // SB sends "1. Liga" for Czechia
  "Austrian Bundesliga":27,
  "Super League":28,"Swiss Super League":28,                 // SB sends "Super League" for Switzerland
  "Stoiximan Super League":29,
  "Allsvenskan":30,
  "Eliteserien":31,
  "Superliga":32,"Danish Superliga":32,
  "SuperLiga":33,"Mozzart Bet SuperLiga":33,
  "HNL":34,"SuperSport HNL":34,
  "Parva Liga":35,
  "NB I":36,
  "Nike Liga":37,"Fortuna Liga":37,
  "PrvaLiga":38,"1. SNL":38,
  "Liga MX":50,                                              // season suffix stripped by normaliser
  "Liga DIMAYOR":52,                                         // SB Colombia (was "Primera A")
  "LigaPro Primera A":53,"LigaPro":53,                       // SB Ecuador sends "LigaPro Primera A"
  "División Profesional":54,"Primera División":54,           // SB Paraguay/Chile/Uruguay
  "Division de Honor":54,                                    // SB Paraguay actual name
  "Liga 1":55,
  "Saudi Pro League":60,
  "Stars League":61,
  "J1 League":62,
  "A-League":62,                                             // SB Australia (was "A-League Men")
  "K-League 1":63,"K League 1":63,                          // SB uses hyphen "K-League 1"
  "Chinese Super League":64,
  "Thai League 1":65,
  "Egyptian Premier League":70,"Premier League":70,          // fallback; Egypt/others resolved by country
  "Championship":80,
  "League One":81,
  "League Two":82,
  "LaLiga 2":90,"Segunda División":90,                       // season suffix stripped by normaliser
  "2. Bundesliga":91,
  "Serie B":92,
  "Ligue 2":93,
  "Liga Portugal 2":94,
  "Eerste Divisie":95,
  "Challenge League":96,
  "1. Lig":97,"Trendyol 1. Lig":97,
  "K-League 2":98,"K League 2":98,                          // SB uses hyphen
  "J2 League":99,"J2/J3 League":99,                         // SB bundles J2+J3
  "Superettan":100,
  "Super League 2":101,
};

// ── League Rank by SofaScore Tournament ID ────────────────────────────────
// Resolves same-name collisions (e.g. many "Premier League" competitions).
// Keys are SofaScore tournament IDs. Takes precedence over LEAGUE_RANK name lookup.
// Add any new collisions here — ID is available from the SS API tournament.id field.
export const LEAGUE_RANK_BY_ID = {
  17:   10,  // English Premier League
  8:    11,  // LaLiga (Spain)
  35:   12,  // Bundesliga (Germany)
  23:   13,  // Serie A (Italy)
  34:   14,  // Ligue 1 (France)
  37:   20,  // Eredivisie (Netherlands)
  238:  21,  // Liga Portugal (Primeira Liga)
  52:   22,  // Süper Lig (Turkey)
  36:   23,  // Scottish Premiership
  325:  24,  // Belgian Pro League
  107:  25,  // Ekstraklasa (Poland)
  406:  26,  // Czech Chance Liga
  45:   27,  // Austrian Bundesliga
  215:  28,  // Swiss Super League
  390:  29,  // Stoiximan Super League (Greece)
  103:  30,  // Allsvenskan (Sweden)
  70:   31,  // Eliteserien (Norway)
  58:   32,  // Danish Superliga
  242:  33,  // SuperLiga (Serbia)
  89:   34,  // HNL (Croatia)
  286:  35,  // Parva Liga (Bulgaria)
  71:   36,  // NB I (Hungary)
  329:  80,  // Championship (England)
  44:   81,  // League One (England)
  43:   82,  // League Two (England)
  54:   90,  // LaLiga 2 (Spain)
  3:    91,  // 2. Bundesliga (Germany)
  53:   92,  // Serie B (Italy)
  182:  93,  // Ligue 2 (France)
};
export const VOLATILE_LEAGUES = new Set([
  "Eredivisie", "Eerste Divisie",
]);

// ── League Scoring Tiers ──────────────────────────────────────────────────
// Used to select the right backtest prior in calibrateMarkets.
// Tier based on long-run avg goals/game (multi-season):
//   low    < 2.3
//   normal   2.3 – 2.9
//   high   >= 3.0
// Any league not listed defaults to "normal".
export const LEAGUE_TIERS = {
  // LOW
  "J1 League":"low","J2 League":"low","J2/J3 League":"low",
  "Egyptian Premier League":"low",
  "Premiership":"low",
  "Scottish Premiership":"low",
  "División Profesional":"low","Division de Honor":"low",
  // HIGH
  "Saudi Pro League":"high","Stars League":"high",
  "Thai League 1":"high",
  "Indonesia Super League":"high",
};

// ── Request Delays ────────────────────────────────────────────────────────
export const SS_TEAM_EVENTS_DELAY = 800;  // legacy — Stage 4 now uses TEAM_BATCH_DELAY (600ms) with 3-team batches
export const SS_RETRY_DELAY       = 2500; // was 1500 — give SS more breathing room before retry
export const SS_RETRIES           = 2;
export const SS_JITTER_MAX        = 120;  // ms — max random jitter added per request inside batches

// ── PARLEY BUILDER ────────────────────────────────────────────────────────────
export const MAX_SAME_MARKET_PER_TICKET = 2; // max legs of same market in one ticket; user-tunable in UI

// ── Read Pool Rank Weights ────────────────────────────────────────────────
// Each market family's probability is multiplied by its weight before ranking.
// 1.0 = face value. Lower = deprioritised. All equal = pure probability wins.
// Tune these to shift what The Read favours without changing thresholds.
export const READ_RANK_WEIGHT_1X2        = 1.00; // directional signal, full weight
export const READ_RANK_WEIGHT_DC         = 1.00; // safety pick, full weight
export const READ_RANK_WEIGHT_BTTS       = 1.00; // balanced game signal, full weight
export const READ_RANK_WEIGHT_OVER25     = 1.00; // goals signal, full weight
export const READ_RANK_WEIGHT_UNDER35    = 1.00; // defensive signal, full weight
export const READ_RANK_WEIGHT_TEAMTOTAL  = 0.82; // near-certain O0.5 has low betting value
// Over 1.5 — pool member but heavily deprioritised so it never beats a real signal.
// Ranked at 0.75 so even an 85% O1.5 (rank 63.8) loses to a 65% 1X2 (rank 65).
// Only surfaces when nothing else qualifies AND odds gate clears.
export const READ_RANK_WEIGHT_OVER15     = 0.75;
export const READ_OVER15_MIN             = 70;   // lowered from 82 — O1.5 now surfaces as genuine fallback when U3.5/BTTS blocked
export const READ_OVER15_MIN_ODDS        = 1.17; // lowered from 1.20 — 1.17 is meaningful value floor for O1.5
// Note: DC only enters the pool when no 1X2 clears READ_1X2_MIN.
// To make DC compete even when 1X2 qualifies, set READ_DC_COMPETES_WITH_1X2 = true.
export const READ_DC_COMPETES_WITH_1X2   = false;
// DC minimum threshold (separate from COMBO_DC_MIN which is for combo display)
export const READ_DC_MIN                 = 72;  // lowered from 75 — several real games were missing by <3%
// TeamTotal threshold for The Read (separate from display threshold)
export const READ_TEAMTOTAL_READ_MIN     = 75;
// TeamTotal minimum odds gate — if the book pays less than this, it's not a real pick.
// A "to score" at 1.01 adds no parlay value. Gate keeps TT out of The Read when worthless.
// If TT is the only qualifier and its odds are below this, The Read falls through to fallback.
export const READ_TT_MIN_ODDS            = 1.10;
// Total xG cap — preserves home/away ratio, kills unrealistic totals
export const XG_TOTAL_CAP               = 4.5;

// ── Engine Pool — Scoring & Qualification ─────────────────────────────────
// Minimum empirical hit rate for a pick to qualify for the pool.
// Picks below this are excluded regardless of odds — kills draws and
// low-hit-rate speculative picks from ever entering parlay candidates.
// Markets with structural low hit rates (Draw ~33%, longshot 1X2) will
// rarely clear this without an unusually strong conf band.
export const POOL_MIN_EMPIRICAL_RATE    = 0.48; // 48% — below this = not a pool pick

// Scoring formula: score = empiricalRate^POOL_SCORE_P_EXP * ln(o)/o
// p exponent controls probability dominance. 2.0 = p² (recommended).
// Higher = more conservative (pure hit rate). Lower = more odds-driven.
export const POOL_SCORE_P_EXP          = 2.0;

// ── Form Streak Multiplier ────────────────────────────────────────────────
// Applied to the form xG channel only (not base Poisson).
// Amplifies or dampens the form contribution when a team is on a run.
// Applies to Win/Over markets only — NOT draw, NOT Under, NOT DC.
// Rationale: a team on 4 straight losses is genuinely struggling;
// a team on 4 straight wins is on form. Unders/DC/Draw aren't
// directional enough to benefit from streak signal.
export const FORM_STREAK_LOSS_4        = 0.82; // 4–5 straight losses — heavy form penalty
export const FORM_STREAK_LOSS_3        = 0.90; // 3 losses in last 5
export const FORM_STREAK_WIN_4         = 1.12; // 4–5 straight wins — form boost
export const FORM_STREAK_WIN_3         = 1.06; // 3 wins in last 5
// Markets where streak multiplier is applied (directional markets only)
export const FORM_STREAK_MARKETS       = new Set(["1X2", "Over 1.5", "Over 2.5", "Over 3.5", "TeamTotal"]);
