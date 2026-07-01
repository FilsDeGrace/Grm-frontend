// ─────────────────────────────────────────────────────────────────────────────
//  sportConfig.js  ·  GRM Pro sport adapter layer
//
//  Philosophy: Football's components ARE the components.
//  Sport is data. Every sport normalises its engine output into the
//  shared fixture shape so nothing in the render layer branches on sport.
//
//  Exports:
//    SPORT_CONFIGS               — { football, basketball, tennis }
//    getSportConfig(sport)       — safe lookup with football fallback
//    toFixtureShape(game, sport) — normalises any engine output → fixture shape
//    getMarketStyle(market, sport, C) — returns { color, bg } for any market
//    getPickFamilies(sport)      — per-sport pick family list for custom picker
//    normaliseStatus(game, sport)— returns { state, time, minute } for StatusBadge
//    getDataSections(sport)      — ordered list of data panel section IDs
//    getProgressLabel(stage, sport) — human label for progress bar stage key
// ─────────────────────────────────────────────────────────────────────────────

// ─── FOOTBALL CONFIG ─────────────────────────────────────────────────────────
// Football is the canonical reference. Identity transform — engine output needs
// no remapping. All other sports describe their transforms relative to this shape.

const FOOTBALL_CONFIG = {
  id: "football",
  label: "Football",
  accentColor: null, // uses theme C.accent — football owns the primary accent

  marketStyle: (market, C) => {
    const map = {
      "Over 1.5":  { color: C.green,  bg: C.greenDim  },
      "Over 2.5":  { color: C.green,  bg: C.greenDim  },
      "Over 3.5":  { color: C.green,  bg: C.greenDim  },
      "Over 4.5":  { color: C.green,  bg: C.greenDim  },
      "Under 1.5": { color: C.blue,   bg: C.blueDim   },
      "Under 2.5": { color: C.blue,   bg: C.blueDim   },
      "Under 3.5": { color: C.blue,   bg: C.blueDim   },
      "Under 4.5": { color: C.blue,   bg: C.blueDim   },
      "BTTS":      { color: C.purple, bg: C.purpleDim },
      "1X2":       { color: C.gold,   bg: C.goldDim   },
      "TeamTotal": { color: C.radar,  bg: C.radarDim  },
      "DC":        { color: C.dc,     bg: C.dcDim     },
      "CS":        { color: C.blue,   bg: C.blueDim   },
    };
    return map[market] || { color: C.accent, bg: C.accentDim };
  },

  // Mirrors CUSTOM_FAMILIES in App.jsx — returned by getPickFamilies("football").
  // CUSTOM_FAMILIES in App.jsx is still used directly for football's own picker;
  // this copy is here so tennis/basketball can coexist without touching App.jsx.
  pickFamilies: [
    { id:"theRead",   label:"The Read"  },
    { id:"theEdge",   label:"The Edge"  },
    { id:"goalRadar", label:"Goal Radar"},
    { id:"over15",  label:"O1.5" }, { id:"over25",  label:"O2.5" },
    { id:"over35",  label:"O3.5" }, { id:"over45",  label:"O4.5" },
    { id:"under15", label:"U1.5" }, { id:"under25", label:"U2.5" },
    { id:"under35", label:"U3.5" }, { id:"under45", label:"U4.5" },
    { id:"bttsyes", label:"BTTS Yes"  }, { id:"bttsno", label:"BTTS No" },
    { id:"homewin", label:"Home Win"  }, { id:"draw",   label:"Draw"    },
    { id:"awaywin", label:"Away Win"  },
    { id:"dc1x",    label:"DC 1X"     }, { id:"dc2x",   label:"DC X2"   },
    { id:"homeo05", label:"H O0.5"    }, { id:"homeo15",label:"H O1.5"  },
    { id:"awayo05", label:"A O0.5"    }, { id:"awayo15",label:"A O1.5"  },
  ],

  normaliseStatus: (game) => ({
    state:  game.state  ?? null,
    time:   game.time   ?? null,
    minute: game.minute ?? null,
  }),

  getResultValues: (fixture) => ({
    hGoals: fixture.hGoals,
    aGoals: fixture.aGoals,
  }),

  // All football data panel section IDs — same render order as before.
  dataSections: ["xg", "matchResult", "goalRange", "btts", "teamTotals", "external", "combos"],

  progressStages: {
    "":         "Starting…",
    starting:   "Starting…",
    fixtures:   "Fetching Fixtures",
    standings:  "League Standings",
    stats:      "Team Stats",
    processing: "Processing",
    saving:     "Saving",
    loading:    "Starting…", // FIX: snapshot-load path sets this stage while
                             // `loading` is true (App.jsx loadSnapshot); the
                             // original inline ternary's catch-all silently
                             // mapped this to "Starting…" — without this entry,
                             // getProgressLabel() would have shown the literal
                             // word "loading" instead.
    done:       "✓ Done",
  },

  // Identity — football is already the canonical shape.
  toFixtureShape: (game) => game,
};

// ─── BASKETBALL STATUS MAPS ───────────────────────────────────────────────────
// SofaScore numeric status codes → football-equivalent state strings.
// These strings are what StatusBadge, evaluatePick's ALWAYS_BLOCKED set, and
// the fixture list live-filter all understand.

const BB_STATUS_MAP = {
  // Live quarter codes
  6:  "1h",        // Q1 — map to "1h" so live filter and ALWAYS_BLOCKED catch it
  7:  "1h",        // Q2
  8:  "2h",        // Q3
  9:  "2h",        // Q4
  10: "et",        // OT
  11: "ht",        // Halftime between Q2/Q3
  // Finished
  100: "finished",
  // Pre-game
  0:   "notstarted",
};

// Quarter label for the "time" display slot in the match header/status pill
const BB_TIME_LABEL = {
  6: "Q1", 7: "Q2", 8: "Q3", 9: "Q4", 10: "OT", 11: "HT",
};

// ─── BASKETBALL: reusable raw-event → recentResult converter ─────────────────
// homeLast / awayLast from BasketballEngine.enrichGame() are raw SofaScore
// event objects: { homeTeam: { id }, awayTeam: { id }, homeScore: { current },
//   awayScore: { current }, startTimestamp }
// We compute outcome from the team's perspective using its teamId.
function bbLastEventsToRecentResults(lastEvents, teamId, teamName, n = 5) {
  const out = [];
  for (const e of (lastEvents || []).slice(0, n * 2)) {
    if (out.length >= n) break;
    const isHome   = (e.homeTeam?.id != null && e.homeTeam.id === teamId) ||
                     (e.homeTeam?.name === teamName);
    const hScore   = e.homeScore?.current ?? (typeof e.homeScore === "number" ? e.homeScore : null);
    const aScore   = e.awayScore?.current ?? (typeof e.awayScore === "number" ? e.awayScore : null);
    if (hScore == null || aScore == null) continue;
    const ptsFor     = isHome ? hScore : aScore;
    const ptsAgainst = isHome ? aScore : hScore;
    out.push({
      outcome:  ptsFor > ptsAgainst ? "W" : "L",
      scored:   ptsFor,       // maps to "scored" in BottomFormStrip (shows pts)
      conceded: ptsAgainst,   // maps to "conceded" in BottomFormStrip (opp pts)
      daysAgo:  e.startTimestamp
        ? Math.floor((Date.now() / 1000 - e.startTimestamp) / 86400)
        : null,
    });
  }
  return out;
}

// ─── BASKETBALL CONFIG ────────────────────────────────────────────────────────

const BASKETBALL_CONFIG = {
  id: "basketball",
  label: "Basketball",
  accentColor: "#E8640A",

  marketStyle: (market, C) => {
    // Named markets. Team Total uses C.radar / C.radarDim deliberately --
    // it IS the radar-equivalent market the screenshots show (per-team O/U
    // lines, e.g. "Saudi Arabia Over/Under 69.5-73.5"), same semantic slot
    // football's Goal Radar / Team Totals section occupies.
    const map = {
      "Moneyline":           { color: C.gold,   bg: C.goldDim   },
      "ML":                  { color: C.gold,   bg: C.goldDim   },
      "Total":               { color: C.green,  bg: C.greenDim  },
      "Handicap":            { color: C.blue,   bg: C.blueDim   },
      "1st Half Handicap":   { color: C.blue,   bg: C.blueDim   },
      "Quarter Winner":      { color: C.gold,   bg: C.goldDim   },
      "Quarter Handicap":    { color: C.blue,   bg: C.blueDim   },
      "Quarter O/U":         { color: C.purple, bg: C.purpleDim },
      "Quarter Margin":      { color: C.dc,     bg: C.dcDim     },
      "Team Total":          { color: C.radar,  bg: C.radarDim  },
    };
    if (map[market]) return map[market];
    // Catches the literal market names from the screenshots, e.g.
    // "Saudi Arabia Over/Under (incl. overtime)" -> still the team total market
    if (/team total|over\/under \(incl/i.test(market)) return { color: C.radar, bg: C.radarDim };
    // Partial match — "Over 185.5" / "Under 225.5" / "OVER" / "UNDER"
    if (/^over\b/i.test(market))  return { color: C.green, bg: C.greenDim };
    if (/^under\b/i.test(market)) return { color: C.blue,  bg: C.blueDim  };
    return { color: "#E8640A", bg: "rgba(232,100,10,0.12)" };
  },

  // Pick families for the custom picker when sport === "basketball".
  // theRead / theEdge: engine picks with confidence % (computed by BasketballEngine).
  // teamtotal_home / teamtotal_away: the radar-equivalent families — surfaced
  // from RAW MARKET ODDS (f.odds._raw), not engine predictions, because
  // BasketballEngine's estimateTotal() currently only returns the COMBINED
  // total, not a home/away split — see the engine note below this config.
  // q1-q4 / margin / fh_handicap: market-odds-only families from the screenshots,
  // same caveat — no engine confidence behind these yet, just market lines.
  pickFamilies: [
    { id: "theRead",        label: "Best Pick"         },
    { id: "theEdge",        label: "Total Signal"      },
    { id: "homewin",        label: "Home ML"           },
    { id: "awaywin",        label: "Away ML"           },
    { id: "over_total",     label: "Over Total"        },
    { id: "under_total",    label: "Under Total"       },
    { id: "homehandicap",   label: "Home Handicap"     },
    { id: "awayhandicap",   label: "Away Handicap"     },
    { id: "teamtotal_home", label: "Home Team Total"   },
    { id: "teamtotal_away", label: "Away Team Total"   },
    { id: "q1_winner",      label: "Q1 Winner"         },
    { id: "q2_winner",      label: "Q2 Winner"         },
    { id: "q3_winner",      label: "Q3 Winner"         },
    { id: "q4_winner",      label: "Q4 Winner"         },
    { id: "q1_margin",      label: "Q1 Margin"         },
    { id: "fh_handicap",    label: "1st Half Handicap" },
  ],

  normaliseStatus: (game) => {
    const code  = typeof game.statusCode === "number" ? game.statusCode : null;
    const state = (code !== null ? BB_STATUS_MAP[code] : null) ?? (game.status ?? "notstarted");
    const time  = code !== null ? (BB_TIME_LABEL[code] ?? null) : null;
    return { state, time, minute: null };
  },

  getResultValues: (fixture) => ({
    hGoals: fixture.hGoals,  // = homeScore in points
    aGoals: fixture.aGoals,  // = awayScore in points
  }),

  // teamTotal: the radar equivalent — per-team O/U lines from raw market odds
  // (f.odds._raw["<TeamName> Over/Under"]). Renders the SAME WAY the odds_bb
  // table does (data-driven, no engine confidence) because the engine doesn't
  // produce a home/away total split yet — see ENGINE GAP note below.
  dataSections: [
    "matchResult",        // Win probability H/A (no Draw row for BB)
    "totalSignal",        // Over/Under model vs market line (combined total only)
    "teamTotal",          // Radar equivalent — per-team O/U market lines
    "quarterPredictions", // Q1–Q4 engine estimates (or actuals if live/finished)
    "teamRecords",        // W/L/PPG/OPP + BottomFormStrip
    "odds_bb",            // Catch-all data-driven market odds table
  ],

  // ── ENGINE GAP (flagged, not fixed here — sportConfig.js cannot fabricate
  //    data BasketballEngine.js doesn't compute) ──────────────────────────
  //
  // estimateTotal(homeRecord, awayRecord) in BasketballEngine.js computes
  // homeProjected and awayProjected internally (line ~366-367) but only
  // RETURNS their sum. The per-team split needed for a true "radar" section
  // (i.e. confidence-scored home/away point projections, the way football's
  // Goal Radar shows P(each team scores 1+) is thrown away before reaching
  // enrichGame()'s return object.
  //
  // ONE-LINE ENGINE FIX (apply in BasketballEngine.js when ready — NOT
  // applied here per your instruction not to touch files this round):
  //
  //   function estimateTotal(homeRecord, awayRecord) {
  //     const homeProjected = (homeRecord.avgPtsFor + awayRecord.avgPtsAgainst) / 2;
  //     const awayProjected = (awayRecord.avgPtsFor + homeRecord.avgPtsAgainst) / 2;
  //     return {
  //       combined: Math.round((homeProjected + awayProjected) * 10) / 10,
  //       home:     Math.round(homeProjected * 10) / 10,
  //       away:     Math.round(awayProjected * 10) / 10,
  //     };
  //   }
  //
  // Then in enrichGame(): const estTotal = estimateTotal(...).combined (or
  // restructure callers to use the object). Once home/away are exposed,
  // toFixtureShape() below can populate f._teamTotalProjection = { home, away }
  // and the "teamTotal" data section can show model confidence exactly like
  // football's radar, instead of only raw market odds.
  //
  // UNTIL THEN: the "teamTotal" section below renders market lines only
  // (from f.odds._raw), which is honest and functional, just not
  // confidence-scored the way football's radar is.

  progressStages: {
    starting:  "Starting",
    fetching:  "Fetching Games",
    enriching: "Enriching",
    done:      "✓ Done",
  },

  // ── THE CORE TRANSFORM ────────────────────────────────────────────────────
  // BasketballEngine.enrichGame() output → canonical football fixture shape.
  // After this, every football component renders basketball data correctly.
  toFixtureShape: (game) => {
    if (!game) return null;

    // ── Status ───────────────────────────────────────────────────────────
    const { state, time, minute } = BASKETBALL_CONFIG.normaliseStatus(game);

    // ── The Read ──────────────────────────────────────────────────────────
    // bestPick from BasketballEngine.selectBestPick():
    //   { pick, market, confidence, odds, basis }
    // market is "Moneyline" or "Total" — both handled by BB marketStyle.
    const theRead = game.bestPick ? {
      anchor: {
        pick:          game.bestPick.pick,
        market:        game.bestPick.market,
        prob:          game.bestPick.confidence,
        odds:          game.bestPick.odds   ?? null,
        empiricalRate: null, // no BB backtest data yet — pool uses _default base rate
      },
      isFallback: false,
      scenario:   game.bestPick.basis ?? null,
      reinforcer: null,
    } : null;

    // ── The Edge (Total Signal) ───────────────────────────────────────────
    // totalSignal from BasketballEngine.totalSignal():
    //   { line, estimated, direction: "OVER"|"UNDER", margin, confidence }
    // Only surface as theEdge when it's different from the bestPick to avoid duplicate.
    const ts      = game.totalSignal;
    const theEdge = (ts && game.bestPick?.market !== "Total") ? {
      pick:        `${ts.direction} ${ts.line}`,
      market:      "Total",
      prob:        ts.confidence,
      odds:        null,
      narrative:   `Model estimates ${ts.estimated} pts · market line ${ts.line} · edge ${ts.margin > 0 ? "+" : ""}${ts.margin}`,
      edgeOddsPct: null,
    } : null;

    // ── Markets (probability map) ─────────────────────────────────────────
    // Basketball has no draw. Draw = 0 so the Draw row in Match Result renders
    // at 0% — if you want it hidden entirely, filter rows on isBB in FullModelPage.
    const markets = {
      homeWin:  game.homeWinProb  ?? 50,
      awayWin:  game.awayWinProb  ?? 50,
      draw:     0,
      // Football-expected fields: null-safe so no football utility crashes on BB.
      homeXG: null, awayXG: null,
      bttsYes: null, bttsNo: null,
      homeCS: null,  awayCS: null,
      over15: null, over25: null, over35: null, over45: null,
      under25: null, under35: null, under45: null,
      homeOver05: null, homeOver15: null,
      awayOver05: null, awayOver15: null,
      // BB-specific — only read by BB data section renderers
      _totalSignal:        ts          ?? null,
      _quarterPredictions: game.quarterPredictions ?? [],
      _estimatedTotal:     game.estimatedTotal     ?? null,
    };

    // ── Odds ──────────────────────────────────────────────────────────────
    // Raw BB odds: nested object keyed by market name, values keyed by choice.
    // e.g. { "Full time": { "1": "1/2", "2": "6/4" }, "Total": { "225.5": { Over: "9/10", Under: "9/10" } } }
    // We map to football odds shape (o1/o2/oX) where possible for FixtureBookNow;
    // the full raw object is stored in _raw for the BB odds section renderer.
    const rawOdds = game.odds ?? {};
    const mlMarket = rawOdds["Full time"] || rawOdds["Moneyline"] || rawOdds["1X2"] || {};

    // Fractional → decimal inline (avoids needing BasketballEngine import)
    const fracToDecimal = (frac) => {
      if (typeof frac === "number") return frac;
      if (typeof frac === "string" && frac.includes("/")) {
        const [n, d] = frac.split("/").map(Number);
        if (!isNaN(n) && !isNaN(d) && d > 0) return parseFloat((n / d + 1).toFixed(2));
      }
      return null;
    };

    // Attempt to resolve home/away ML odds → o1/o2 for shared pick components.
    // BB market keys are typically "1" / "2" or the team name.
    let o1 = null, o2 = null;
    if (mlMarket && typeof mlMarket === "object") {
      const k1 = "1" in mlMarket ? "1" : Object.keys(mlMarket)[0];
      const k2 = "2" in mlMarket ? "2" : Object.keys(mlMarket)[1];
      if (k1) o1 = fracToDecimal(mlMarket[k1]);
      if (k2) o2 = fracToDecimal(mlMarket[k2]);
    }

    const bbOdds = {
      o1,    // home ML decimal odds (or null — FixtureBookNow falls back to implied)
      o2,    // away ML decimal odds
      oX:  null, // no draw in basketball
      _raw: rawOdds,  // full raw odds for the BB odds section renderer
    };

    // ── Team stats (for BottomFormStrip and teamRecords section) ─────────
    // homeLast / awayLast: raw SofaScore event objects (8 most recent games).
    // bbLastEventsToRecentResults computes outcome, ptsFor, ptsAgainst per game.
    const mapTeamStats = (record, lastEvents, teamId, teamName) => {
      if (!record && !lastEvents) return null;
      return {
        recentResults: bbLastEventsToRecentResults(lastEvents, teamId, teamName, 5),
        // BB-specific stat fields — read only by the teamRecords section
        _wins:          record?.wins          ?? null,
        _losses:        record?.losses        ?? null,
        _winPct:        record?.winPct        ?? null,
        _avgPtsFor:     record?.avgPtsFor     ?? null,
        _avgPtsAgainst: record?.avgPtsAgainst ?? null,
        _streak:        record?.streak        ?? null,
      };
    };

    // ── Form arrays ───────────────────────────────────────────────────────
    // formString() returns "WWLWL" (a string). Football form is an array.
    const toFormArray = (val) => {
      if (!val) return [];
      if (Array.isArray(val)) return val;
      return String(val).split("").filter(c => c === "W" || c === "L" || c === "D");
    };

    // ── Compose fixture shape ─────────────────────────────────────────────
    return {
      // ── Core identity ───────────────────────────────────────────────────
      id:      game.eventId,
      sport:   "basketball",
      _sport:  "basketball",         // used by FullModelPage to pick dataSections
      teams: {
        home: game.homeTeam ?? "Home",
        away: game.awayTeam ?? "Away",
      },
      // Prefer the tournament's full name for display; fall back to uniqueTournament name.
      league:  game.tournament ?? game.league ?? "Basketball",
      // FIX (caught during deliverable review — App_changes.js Change 4b assumed
      // this was "already there"; it wasn't. Without it, the existing league-filter
      // pills (`list.filter(f => lf.has(f.leagueId))`) silently drop every basketball
      // fixture once a league filter is active, since f.leagueId was undefined.
      leagueId: game.tournament ?? game.league ?? "basketball-other",
      date:    game.startTime ? game.startTime.split("T")[0] : null,
      kickoff: game.startTime ?? null,

      // ── Status ──────────────────────────────────────────────────────────
      state,   // normalised to football string — StatusBadge, evaluatePick, live filter
      time,    // "Q1"/"Q2"/"HT" etc — shown in status pill / match header
      minute,  // null for basketball (no running clock data from this API)

      // ── Scores ──────────────────────────────────────────────────────────
      // Points mapped to hGoals/aGoals so the score display renders correctly
      // and evalPickResult's total calculation (h + a) works for Over/Under picks.
      hGoals: game.homeScore ?? null,
      aGoals: game.awayScore ?? null,

      // ── Signal ──────────────────────────────────────────────────────────
      theRead,   // bestPick → anchor; flows into HeroRead, evaluatePick, pool builder
      theEdge,   // totalSignal → edge strip (only when != bestPick market)
      goalRadar: null, // no Goal Radar for basketball — RadarStrip shows "Insufficient data"
      combos:    [],   // no combo suggestions for basketball

      // ── Markets ─────────────────────────────────────────────────────────
      markets,

      // ── Odds ─────────────────────────────────────────────────────────────
      odds: bbOdds,

      // ── Form ─────────────────────────────────────────────────────────────
      form: {
        home: toFormArray(game.homeForm),
        away: toFormArray(game.awayForm),
      },

      // ── Team stats ───────────────────────────────────────────────────────
      teamStats: {
        home: mapTeamStats(game.homeRecord, game.homeLast, game.homeTeamId, game.homeTeam),
        away: mapTeamStats(game.awayRecord, game.awayLast, game.awayTeamId, game.awayTeam),
      },

      // ── Football-expected fields set to neutral values ────────────────────
      // Any football utility that reads these won't crash; BB sections simply
      // don't render the panels that would display them.
      tablePosition: null,
      strategyTags:  [],
      volatileLeague: false,
      theRead_external: null,

      // ── BB-specific passthrough (namespaced, never touched by football code) ─
      _scoreByQuarter:     game.scoreByQuarter     ?? null, // for quarter score strip in header
      _quarterPredictions: game.quarterPredictions ?? [],
      _homeRecord:         game.homeRecord         ?? null,
      _awayRecord:         game.awayRecord         ?? null,
      _homeVenueRecord:    game.homeVenueRecord    ?? null,
      _awayVenueRecord:    game.awayVenueRecord    ?? null,
      _estimatedTotal:     game.estimatedTotal     ?? null,
      _totalSignal:        ts                      ?? null,
      // _teamTotalProjection: null until BasketballEngine's estimateTotal()
      // is updated to return { combined, home, away } instead of just a number
      // (see ENGINE GAP note above BASKETBALL_CONFIG.dataSections). Once it
      // does, change this to: { home: game.estimatedTotal?.home ?? null,
      // away: game.estimatedTotal?.away ?? null } and the "teamTotal" data
      // section will automatically start showing model confidence instead
      // of falling back to market-odds-only display.
      _teamTotalProjection: (game.estimatedTotal && typeof game.estimatedTotal === "object")
        ? { home: game.estimatedTotal.home ?? null, away: game.estimatedTotal.away ?? null }
        : null,
      _h2h:                game.h2h               ?? null,
      _standings:          game.standings         ?? null,
      _players:            game.players           ?? null,
      _flags:              game.flags             ?? null,
    };
  },
};

// ─── TENNIS CONFIG (stub — ready to fill when tennis engine ships) ────────────
const TENNIS_CONFIG = {
  id: "tennis",
  label: "Tennis",
  accentColor: "#22C55E",

  marketStyle: (market, C) => {
    const map = {
      "Match Winner":      { color: C.gold,   bg: C.goldDim   },
      "Set Winner":        { color: C.gold,   bg: C.goldDim   },
      "Set Handicap":      { color: C.blue,   bg: C.blueDim   },
      "Game Handicap":     { color: C.purple, bg: C.purpleDim },
      "Total Games":       { color: C.green,  bg: C.greenDim  },
      "Player Total Games":{ color: C.radar,  bg: C.radarDim  }, // radar equivalent — per-player games O/U
    };
    if (map[market]) return map[market];
    // Catches screenshot's literal naming: "<Player Name> total games"
    if (/total games/i.test(market)) return { color: C.radar, bg: C.radarDim };
    return { color: C.accent, bg: C.accentDim };
  },

  // teamtotal_home/away: per-player total games O/U — tennis's radar equivalent,
  // from the screenshot's "Santillan, Akira total games" / "Yevseyev, Denis total
  // games" markets. Same engine-gap caveat as basketball: market-odds-only until
  // a tennis engine computes per-player games projections.
  pickFamilies: [
    { id: "theRead",        label: "Best Pick"          },
    { id: "homewin",        label: "Player 1 Win"       },
    { id: "awaywin",        label: "Player 2 Win"       },
    { id: "over_total",     label: "Over Games"         },
    { id: "under_total",    label: "Under Games"        },
    { id: "sethandicap_h",  label: "P1 Set Handicap"    },
    { id: "sethandicap_a",  label: "P2 Set Handicap"    },
    { id: "teamtotal_home", label: "P1 Total Games"     },
    { id: "teamtotal_away", label: "P2 Total Games"     },
  ],

  normaliseStatus: (game) => ({
    state:  game.state   ?? "notstarted",
    time:   game.set     ? `Set ${game.set}` : null,
    minute: null,
  }),

  getResultValues: (fixture) => ({
    hGoals: fixture.hGoals, // = sets won by player 1
    aGoals: fixture.aGoals,
  }),

  dataSections: ["matchResult", "totalSignal", "teamTotal", "setBreakdown"],

  progressStages: {
    starting: "Starting",
    fetching: "Fetching Matches",
    done:     "✓ Done",
  },

  toFixtureShape: (game) => {
    if (!game) return null;
    return {
      id:      game.id ?? game.eventId,
      sport:   "tennis",
      _sport:  "tennis",
      teams:   { home: game.player1 ?? game.homeTeam ?? "P1", away: game.player2 ?? game.awayTeam ?? "P2" },
      league:  game.tournament ?? "Tennis",
      state:   game.state   ?? "notstarted",
      time:    game.set     ? `Set ${game.set}` : null,
      minute:  null,
      hGoals:  game.homeScore  ?? null,
      aGoals:  game.awayScore  ?? null,
      theRead: null, theEdge: null, goalRadar: null, combos: [],
      markets: { homeWin: game.homeWinProb ?? 50, awayWin: game.awayWinProb ?? 50, draw: 0 },
      odds:    { o1: null, o2: null, oX: null, _raw: {} },
      form:    { home: [], away: [] },
      teamStats: { home: null, away: null },
      tablePosition: null, strategyTags: [], volatileLeague: false,
    };
  },
};

// ─── REGISTRY ─────────────────────────────────────────────────────────────────

export const SPORT_CONFIGS = {
  football:   FOOTBALL_CONFIG,
  basketball: BASKETBALL_CONFIG,
  tennis:     TENNIS_CONFIG,
};

// ─── PUBLIC API ───────────────────────────────────────────────────────────────

/** Safe sport config lookup — always falls back to football. */
export function getSportConfig(sport) {
  return SPORT_CONFIGS[sport] || SPORT_CONFIGS.football;
}

/**
 * Normalise any engine output → canonical football fixture shape.
 * Football: identity (returns game unchanged).
 * Basketball/Tennis: full field remapping via config.toFixtureShape().
 * After this call, every football component can render the result.
 */
export function toFixtureShape(game, sport) {
  return getSportConfig(sport).toFixtureShape(game);
}

/**
 * Returns { color, bg } for a market string in the current sport.
 * Replaces the hardcoded mktStyle() in FullModelPage and App.jsx.
 *
 * Usage: getMarketStyle("Moneyline", "basketball", C)
 *        getMarketStyle("Over 2.5",  "football",   C)
 */
export function getMarketStyle(market, sport, C) {
  return getSportConfig(sport).marketStyle(market, C);
}

/**
 * Per-sport pick family list for the custom pick selector UI.
 * Football: returns the same list as CUSTOM_FAMILIES in App.jsx.
 * Basketball/Tennis: returns sport-appropriate families.
 *
 * Usage in the picker render:
 *   (sport === "football" ? CUSTOM_FAMILIES : getPickFamilies(sport)).map(...)
 */
export function getPickFamilies(sport) {
  return getSportConfig(sport).pickFamilies;
}

/**
 * Normalise game status → { state, time, minute } for StatusBadge.
 * Football: pass-through of existing string state codes.
 * Basketball: maps numeric SofaScore statusCode → football string codes.
 */
export function normaliseStatus(game, sport) {
  return getSportConfig(sport).normaliseStatus(game);
}

/**
 * Ordered list of data panel section IDs for FullModelPage.
 * Football: all sections (xg, matchResult, goalRange, btts, teamTotals, external, combos).
 * Basketball: sport-relevant subset + BB-specific sections.
 *
 * Usage in FullModelPage:
 *   const sections = new Set(getDataSections(f._sport || "football"));
 *   {sections.has("xg") && <SectionPanel ...> ... </SectionPanel>}
 */
export function getDataSections(sport) {
  return getSportConfig(sport).dataSections;
}

/**
 * Human-readable label for a fetch progress stage key.
 * Falls back to the raw key if the sport doesn't define a label for it.
 *
 * Usage in App.jsx progress bar:
 *   {getProgressLabel(progressStage, sport)}
 */
export function getProgressLabel(stage, sport) {
  const stages = getSportConfig(sport).progressStages;
  return stages[stage] ?? stage;
}
