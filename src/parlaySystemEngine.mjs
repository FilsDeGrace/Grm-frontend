// ── PARLAY SYSTEM ENGINE (temp, CA-verdict-based) ───────────────────────────
// 2026-07-31. Consumes an array of "legs" — one per (fixture, market) that
// caStoryVerdict.js's resolveStoryVerdict() called MAIN or SUBSIDIARY (i.e.
// already cleared the bettable floor). This module does NOT compute
// verdicts itself and does NOT know about CA/SA internals — it only enforces
// your two occupancy rules and runs named "systems" against the pool.
//
// Wiring note: assembling the actual leg pool (iterate today's fixtures ->
// matchCAConditions -> resolveStoryVerdict -> attach odds) needs your real
// fixture/odds data shapes, which I haven't seen beyond caOddsFor existing
// as a private App.jsx helper. legFromVerdict() below shows the expected
// leg shape; wire the pool-building loop against your actual fixture list
// once you confirm where this runs (server.js request handler vs a
// standalone script).
//
// YOUR TWO RULES (exactly as specified, not the correlation-doc's separate
// "no two legs from the same match on one ticket" rule — that's enforced
// too, see WITHIN-TICKET rule below, but it's a different constraint):
//   1. A (fixture, market) pair can be claimed by ONE ticket, ever, across
//      every system. Once claimed, it's permanently closed.
//   2. A fixture (any markets) can be claimed by AT MOST 3 tickets total,
//      across different markets, across all systems.
//
// SEQUENCING (per your decision): tiered (Mode B) systems run first, in
// explicit priority order among themselves — they have bounded appetite.
// Long-shot (Mode A) systems run last, sweeping whatever the ledger has
// left — they're unbounded by design (stack until exhausted), so running
// them first would starve every tiered system behind them.

// FIXED 2026-07-31: was reading fixture.homeTeam / fixture.home, which
// don't exist on your fixture objects — every leg rendered "? vs ?" as a
// result. Real shape (confirmed against 40+ usages elsewhere in App.jsx) is
// fixture.teams.home / fixture.teams.away. Old guesses kept as fallback in
// case a caller ever passes a differently-shaped fixture object.
export function legFromVerdict(fixture, verdict, odds) {
  if (!verdict || (verdict.status !== "MAIN" && verdict.status !== "SUBSIDIARY")) return null;
  return {
    fixtureId: fixture.id,
    market: verdict.market,
    tier: verdict.status,
    thesis: verdict.thesis,
    confidence: verdict.confidence,
    recalHR: verdict.recalHR,
    odds: odds ?? null,
    league: fixture.league ?? null,
    kickoff: fixture.kickoff ?? fixture.date ?? null,
    homeTeam: fixture.teams?.home ?? fixture.homeTeam ?? fixture.home ?? null,
    awayTeam: fixture.teams?.away ?? fixture.awayTeam ?? fixture.away ?? null,
  };
}

// ── Ledger ───────────────────────────────────────────────────────────────
const legKey = (leg) => `${leg.fixtureId}|${leg.market}`;

export function createLedger() {
  return {
    claimedLegs: new Set(),                 // legKey -> claimed forever
    fixtureOccupancy: new Map(),            // fixtureId -> count of distinct markets claimed
    claims: [],                             // audit trail, one row per claim
  };
}

export function canClaim(ledger, leg, maxPerFixture = 3) {
  if (ledger.claimedLegs.has(legKey(leg))) return false; // rule 1
  const occ = ledger.fixtureOccupancy.get(leg.fixtureId) ?? 0;
  return occ < maxPerFixture; // rule 2
}

export function claim(ledger, leg, systemName, ticketId, maxPerFixture = 3) {
  if (!canClaim(ledger, leg, maxPerFixture)) return false;
  ledger.claimedLegs.add(legKey(leg));
  ledger.fixtureOccupancy.set(leg.fixtureId, (ledger.fixtureOccupancy.get(leg.fixtureId) ?? 0) + 1);
  ledger.claims.push({ fixtureId: leg.fixtureId, market: leg.market, systemName, ticketId, claimedAt: new Date().toISOString() });
  return true;
}

// ── System definition shape ─────────────────────────────────────────────
// {
//   name: "Longshot-A", mode: "stack" | "tier", priority: number (tier only,
//   lower = runs first among tier systems),
//   thesisScope: ["homeDominance", ...] | null (null = all theses),
//   marketScope: ["TB:1X2-Home", ...] | null (null = all markets — allowlist),
//   marketExclude: ["TB:1X2-Away", ...] | null (null = exclude nothing —
//     denylist, checked in addition to marketScope; a market must pass BOTH),
//   tierScope: ["MAIN"] | ["MAIN","SUBSIDIARY"] (default both),
//   // stack mode:
//   targetOddsMin, targetOddsMax, maxLegs,
//   // tier mode:
//   tiers: [{ name, minConfidence, legsPerTicket, maxTickets }]
// }

function inScope(leg, system) {
  if (system.thesisScope && !system.thesisScope.includes(leg.thesis)) return false;
  if (system.marketScope && !system.marketScope.includes(leg.market)) return false;
  if (system.marketExclude && system.marketExclude.includes(leg.market)) return false;
  const tierScope = system.tierScope || ["MAIN", "SUBSIDIARY"];
  if (!tierScope.includes(leg.tier)) return false;
  if (leg.odds == null) return false; // no combined-odds math without real odds
  return true;
}

function sameFixtureInTicket(ticket, leg) {
  return ticket.some(l => l.fixtureId === leg.fixtureId);
}

function combinedOdds(ticket) {
  return ticket.reduce((acc, l) => acc * l.odds, 1);
}

// ── Mode A: long-shot stacker ───────────────────────────────────────────
// Greedily stacks legs (best confidence first, no same-fixture twice on one
// ticket) until the ticket's combined odds hits targetOddsMin, or maxLegs is
// reached, or the pool runs out. Repeats, starting new tickets from
// remaining unclaimed legs, until nothing left in scope can start a new
// ticket. Never pads a ticket below targetOddsMin just to close it out —
// an unfinished ticket at pool exhaustion is dropped, not shipped weak.
export function buildLongshotTickets(system, legPool, ledger) {
  const tickets = [];
  const candidates = () => legPool
    .filter(leg => inScope(leg, system) && canClaim(ledger, leg))
    .sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0));

  let pool = candidates();
  while (pool.length) {
    const ticket = [];
    for (const leg of pool) {
      if (!canClaim(ledger, leg)) continue;
      if (sameFixtureInTicket(ticket, leg)) continue;
      const trial = [...ticket, leg];
      if (system.maxLegs && trial.length > system.maxLegs) continue;
      if (system.targetOddsMax && combinedOdds(trial) > system.targetOddsMax) continue;
      ticket.push(leg);
      if (system.targetOddsMin && combinedOdds(ticket) >= system.targetOddsMin) break;
      if (system.maxLegs && ticket.length >= system.maxLegs) break;
    }
    const meetsFloor = !system.targetOddsMin || combinedOdds(ticket) >= system.targetOddsMin;
    if (!ticket.length || !meetsFloor) break; // pool exhausted for this system
    const ticketId = `${system.name}-${tickets.length + 1}`;
    for (const leg of ticket) claim(ledger, leg, system.name, ticketId);
    tickets.push({ ticketId, systemName: system.name, mode: "stack", legs: ticket, combinedOdds: combinedOdds(ticket) });
    pool = candidates(); // re-filter — some legs just got claimed
  }
  return tickets;
}

// ── Mode B: tiered divider ──────────────────────────────────────────────
// Buckets qualifying legs into named confidence tiers, builds normal-sized
// tickets (legsPerTicket) per tier, up to maxTickets per tier. Stops a tier
// as soon as it can't fill a full ticket — never ships an undersized one.
export function buildTieredTickets(system, legPool, ledger) {
  const tickets = [];
  for (const tier of system.tiers) {
    let built = 0;
    while (!tier.maxTickets || built < tier.maxTickets) {
      const candidates = legPool
        .filter(leg => inScope(leg, system) && canClaim(ledger, leg) && (leg.confidence ?? 0) >= tier.minConfidence)
        .sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0));

      const ticket = [];
      for (const leg of candidates) {
        if (!canClaim(ledger, leg)) continue;
        if (sameFixtureInTicket(ticket, leg)) continue;
        ticket.push(leg);
        if (ticket.length >= tier.legsPerTicket) break;
      }
      if (ticket.length < tier.legsPerTicket) break; // can't fill this tier anymore
      const ticketId = `${system.name}-${tier.name}-${built + 1}`;
      for (const leg of ticket) claim(ledger, leg, system.name, ticketId);
      tickets.push({ ticketId, systemName: system.name, mode: "tier", tier: tier.name, legs: ticket, combinedOdds: combinedOdds(ticket) });
      built++;
    }
  }
  return tickets;
}

// ── Sequencer ────────────────────────────────────────────────────────────
// Tier systems first (explicit priority, ascending), then stack systems
// last, in the order given. Returns { results: [{systemName, tickets}],
// ledger } so callers can inspect the full audit trail via ledger.claims.
export function runSystems(systems, legPool) {
  const ledger = createLedger();
  const tierSystems = systems.filter(s => s.mode === "tier").sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0));
  const stackSystems = systems.filter(s => s.mode === "stack");

  const results = [];
  for (const system of tierSystems) {
    results.push({ systemName: system.name, tickets: buildTieredTickets(system, legPool, ledger) });
  }
  for (const system of stackSystems) {
    results.push({ systemName: system.name, tickets: buildLongshotTickets(system, legPool, ledger) });
  }
  return { results, ledger };
}
