const express = require('express');
const { buildPlayerProjections } = require('../../captaincyModel');
const { selectOptimalLineup, hasEconomicalReserveGoalkeeper, nextGameweekScore, horizonScore } = require('../../aiTeamModel');
const { getCachedApiData, BOOTSTRAP_URL, FIXTURES_URL, optionalApiGet } = require('../cache');
const { heavyEndpointLimiter } = require('../middleware');
const logger = require('../logger');
const { sql } = require('../db');

const router = express.Router();

const AI_TEAM_MODEL_VERSION = 'AI Team Engine 9.0';
const SMART_TEAM_MANAGER_ID = 7698060;
const SMART_TEAM_STORAGE_KEY = `autonomous-smart-team-${SMART_TEAM_MANAGER_ID}`;
const AI_TEAM_POSITION_LIMITS = { GKP: 2, DEF: 5, MID: 5, FWD: 3 };

function isValidAITeamPayload(payload) {
  const squad = payload?.squad;
  const starters = payload?.lineup?.starters;
  const bench = payload?.lineup?.bench;
  if (!Array.isArray(squad) || squad.length !== 15 || !Array.isArray(starters) || starters.length !== 11 || !Array.isArray(bench) || bench.length !== 4) return false;
  const ids = squad.map(player => Number(player?.id));
  if (ids.some(id => !Number.isFinite(id)) || new Set(ids).size !== 15) return false;
  const starterIds = starters.map(player => Number(player?.id));
  const benchIds = bench.map(player => Number(player?.id));
  if (new Set(starterIds).size !== 11 || new Set(benchIds).size !== 4 || starterIds.some(id => benchIds.includes(id))) return false;
  const positions = squad.reduce((counts, player) => ({ ...counts, [player.position]: (counts[player.position] || 0) + 1 }), {});
  const clubs = squad.reduce((counts, player) => ({ ...counts, [player.teamId]: (counts[player.teamId] || 0) + 1 }), {});
  const costTenths = squad.reduce((sum, player) => sum + Math.round(Number(player.cost || 0) * 10), 0);
  return Object.entries(AI_TEAM_POSITION_LIMITS).every(([position, count]) => positions[position] === count)
    && Object.values(clubs).every(count => count <= 3)
    && costTenths <= 1000
    && payload?.lineup?.quality?.reserveGoalkeeperEconomical === true
    && payload?.lineup?.quality?.optimizerVersion === 8
    && ['balanced', 'protect', 'chase'].every(strategy => Array.isArray(payload?.transfers?.plansByStrategy?.[strategy]))
    && starters.every(player => ids.includes(Number(player.id)))
    && bench.every(player => ids.includes(Number(player.id)));
}

async function getGW1LockState() {
  const bootstrap = await getCachedApiData(BOOTSTRAP_URL);
  const gw1 = (bootstrap.events || []).find(event => event.id === 1);
  const deadline = gw1?.deadline_time ? new Date(gw1.deadline_time) : null;
  return { deadline, shouldLock: Boolean(deadline && new Date() >= deadline) };
}

function savedPayloadFromRow(row, saved = true) {
  return {
    saved,
    isLocked: row.is_locked,
    lockedAt: row.locked_at,
    formation: row.formation,
    teamCost: Number(row.team_cost),
    teamXpts: Number(row.team_xpts),
    strategy: row.strategy,
    budget: Number(row.budget),
    horizon: row.horizon,
    squad: row.squad,
    lineup: row.lineup,
    transfers: row.transfers || { plan: [] },
    chips: row.chips || { schedule: [] },
    meta: { schemaVersion: '2.0', modelVersion: AI_TEAM_MODEL_VERSION, generatedAt: row.updated_at, strategy: row.strategy, budget: Number(row.budget), horizon: row.horizon, gameweeks: row.lineup?.starters?.[0]?.weekly?.map(week => week.gameweek) || [], isAutoLocked: row.is_locked, quality: row.lineup?.quality || null, managerId: SMART_TEAM_MANAGER_ID },
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// GET saved AI team + transfer plan + chip schedule
router.get('/', async (req, res) => {
  if (!sql) return res.json({ saved: false, persistenceAvailable: false });
  const storageKey = SMART_TEAM_STORAGE_KEY;
  try {
    const rows = await sql`SELECT * FROM ai_team WHERE session_id = ${storageKey} ORDER BY updated_at DESC LIMIT 1`;
    if (!rows.length) return res.json({ saved: false });
    const row = rows[0];
    const lockState = await getGW1LockState();
    if (!row.is_locked && lockState.shouldLock) {
      await sql`UPDATE ai_team SET is_locked = TRUE, locked_at = COALESCE(locked_at, NOW()), updated_at = NOW() WHERE id = ${row.id}`;
      row.is_locked = true;
      row.locked_at = row.locked_at || new Date();
    }
    const payload = {
      saved: true,
      isLocked: row.is_locked,
      lockedAt: row.locked_at,
      formation: row.formation,
      teamCost: Number(row.team_cost),
      teamXpts: Number(row.team_xpts),
      strategy: row.strategy,
      budget: Number(row.budget),
      horizon: row.horizon,
      squad: row.squad,
      lineup: row.lineup,
      transfers: row.transfers || { plan: [] },
      chips: row.chips || { schedule: [] },
      meta: {
        schemaVersion: '2.0',
        modelVersion: AI_TEAM_MODEL_VERSION,
        generatedAt: row.updated_at,
        strategy: row.strategy,
        budget: Number(row.budget),
        horizon: row.horizon,
        gameweeks: row.lineup?.starters?.[0]?.weekly?.map(week => week.gameweek) || [],
        isAutoLocked: row.is_locked,
        quality: row.lineup?.quality || null,
        managerId: SMART_TEAM_MANAGER_ID,
      },
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
    if (!isValidAITeamPayload(payload)) {
      await sql`DELETE FROM ai_team WHERE session_id = ${storageKey}`;
      return res.json({ saved: false, stale: true });
    }
    res.json(payload);
  } catch (e) {
    logger.error({ err: e }, 'AI Team GET error');
    res.status(500).json({ error: 'Failed to load AI team' });
  }
});

// Save a user-selected Smart Team before the GW1 deadline.
router.put('/', async (req, res) => {
  if (!sql) return res.status(503).json({ error: 'Smart Team persistence is unavailable' });
  const payload = req.body || {};
  if (!isValidAITeamPayload(payload)) return res.status(400).json({ error: 'Smart Team payload is invalid' });
  try {
    const lockState = await getGW1LockState();
    const rows = await sql`SELECT * FROM ai_team WHERE session_id = ${SMART_TEAM_STORAGE_KEY} LIMIT 1`;
    if ((rows.length && rows[0].is_locked) || lockState.shouldLock) {
      if (rows.length && !rows[0].is_locked && lockState.shouldLock) {
        await sql`UPDATE ai_team SET is_locked = TRUE, locked_at = COALESCE(locked_at, NOW()), updated_at = NOW() WHERE id = ${rows[0].id}`;
      }
      return res.status(409).json({ error: 'The GW1 deadline has passed. The locked Smart Team is now being used.', locked: true });
    }
    const savedRows = await sql`INSERT INTO ai_team (session_id, squad, lineup, formation, team_cost, team_xpts, strategy, budget, horizon, is_locked, locked_at, transfers, chips)
      VALUES (${SMART_TEAM_STORAGE_KEY}, ${JSON.stringify(payload.squad)}, ${JSON.stringify(payload.lineup)}, ${payload.formation || '4-4-2'}, ${Number(payload.teamCost) || 0}, ${Number(payload.teamXpts) || 0}, ${payload.strategy || 'balanced'}, ${Number(payload.budget) || 100}, ${Number(payload.horizon) || 8}, FALSE, NULL, ${JSON.stringify(payload.transfers || { plan: [] })}, ${JSON.stringify(payload.chips || { schedule: [] })})
      ON CONFLICT (session_id) DO UPDATE SET squad = EXCLUDED.squad, lineup = EXCLUDED.lineup, formation = EXCLUDED.formation, team_cost = EXCLUDED.team_cost, team_xpts = EXCLUDED.team_xpts, strategy = EXCLUDED.strategy, budget = EXCLUDED.budget, horizon = EXCLUDED.horizon, transfers = EXCLUDED.transfers, chips = EXCLUDED.chips, updated_at = NOW()
      RETURNING *`;
    res.json(savedPayloadFromRow(savedRows[0]));
  } catch (error) {
    logger.error({ err: error }, 'AI Team save error');
    res.status(500).json({ error: 'Failed to save AI Team' });
  }
});

// ---- Core Smart Team optimizer ----
router.post('/', heavyEndpointLimiter, async (req, res) => {
  const budget = 100;
  const horizon = 8;
  const strategy = 'balanced';
  const storageKey = SMART_TEAM_STORAGE_KEY;

  try {
    if (sql) {
      const rows = await sql`SELECT * FROM ai_team WHERE session_id = ${storageKey} AND is_locked = TRUE ORDER BY updated_at DESC LIMIT 1`;
      if (rows.length && rows[0].lineup?.quality?.optimizerVersion === 8 && rows[0].transfers?.plansByStrategy) {
        const row = rows[0];
        return res.json({
          saved: true, isLocked: true, lockedAt: row.locked_at, formation: row.formation,
          teamCost: Number(row.team_cost), teamXpts: Number(row.team_xpts), strategy: row.strategy,
          budget: Number(row.budget), horizon: row.horizon, squad: row.squad, lineup: row.lineup,
          transfers: row.transfers || { plan: [] }, chips: row.chips || { schedule: [] },
          meta: { schemaVersion: '2.0', modelVersion: AI_TEAM_MODEL_VERSION, generatedAt: row.updated_at, strategy: row.strategy, budget: Number(row.budget), horizon: row.horizon, isAutoLocked: true, quality: row.lineup?.quality || null, managerId: SMART_TEAM_MANAGER_ID },
        });
      }
    }
    const [bootstrap, fixtures] = await Promise.all([
      getCachedApiData(BOOTSTRAP_URL),
      getCachedApiData(FIXTURES_URL),
    ]);

    const events = bootstrap.events || [];
    const elements = bootstrap.elements || [];
    const teams = bootstrap.teams || [];
    const teamsById = new Map(teams.map(t => [t.id, t]));
    const currentGW = events.find(e => e.is_current)?.id || null;
    const nextGW = events.find(e => e.is_next)?.id || currentGW || 1;
    const gw1Event = events.find(event => event.id === 1);
    const gw1DeadlineAt = gw1Event?.deadline_time ? new Date(gw1Event.deadline_time) : null;
    if (sql && gw1DeadlineAt && new Date() >= gw1DeadlineAt) {
      const savedRows = await sql`UPDATE ai_team SET is_locked = TRUE, locked_at = COALESCE(locked_at, NOW()), updated_at = NOW() WHERE session_id = ${storageKey} RETURNING *`;
      if (savedRows.length) return res.json(savedPayloadFromRow(savedRows[0]));
    }

    // Build full player projections across the horizon
    const projectionData = await buildPlayerProjections({ bootstrap, fixtures, startGW: nextGW, horizon });
    const allPlayers = projectionData.projections;

    // Enrich with bootstrap data
    const bootstrapMap = new Map(elements.map(e => [e.id, e]));
    const fixturesByTeam = new Map();
    fixtures.forEach(f => {
      [f.team_h, f.team_a].forEach(teamId => {
        if (!fixturesByTeam.has(teamId)) fixturesByTeam.set(teamId, []);
        fixturesByTeam.get(teamId).push(f);
      });
    });

    const enrichedPlayers = allPlayers.map(p => {
      const raw = bootstrapMap.get(p.id);
      if (!raw) return p;

      let enhancedAvailability = p.availability;
      const status = raw.status || 'a';
      const news = raw.news || '';
      const chanceNext = raw.chance_of_playing_next_round;

      if (['s', 'u', 'n'].includes(status)) enhancedAvailability = 0;
      if (status === 'd') enhancedAvailability = Math.min(enhancedAvailability, 60);
      if (status === 'i') enhancedAvailability = Math.min(enhancedAvailability, 25);
      if (chanceNext !== null && chanceNext !== undefined) {
        enhancedAvailability = Math.min(enhancedAvailability, Number(chanceNext));
      }

      const formBoost = status === 'a' && Number(raw.form) > 5 ? (Number(raw.form) - 5) * 0.3 : 0;
      const minutesPlayed = Number(raw.minutes) || 0;
      const gamesPlayed = Math.max(1, events.filter(e => e.finished).length || 1);
      const minutesPerGame = minutesPlayed / gamesPlayed;
      const projectedMinutes = Number(p.weekly?.[0]?.xMins) || 0;
      const minutesReliability = Math.min(1, (minutesPlayed > 0 ? minutesPerGame : projectedMinutes) / 75);
      const xGI90 = Number(raw.expected_goal_involvements_per_90) || 0;
      const bonusPer90 = Number(raw.bonus) > 0 && Number(raw.minutes) > 0
        ? (Number(raw.bonus) * 90) / Number(raw.minutes) : 0;
      const cleanSheets = Number(raw.clean_sheets) || 0;
      const csPerGame = gamesPlayed > 0 ? cleanSheets / gamesPlayed : 0;
      const isPenaltyTaker = Number(raw.penalties_order) === 1;
      const isFKTaker = Number(raw.direct_freekicks_order) === 1;
      const isCornerTaker = Number(raw.corners_and_indirect_freekicks_order) === 1;
      const setPieceBonus = (isPenaltyTaker ? 0.35 : 0) + (isFKTaker ? 0.15 : 0) + (isCornerTaker ? 0.1 : 0);
      const ictIndex = Number(raw.ict_index) || 0;

      const fixturesByGameweek = new Map();
      (fixturesByTeam.get(raw.team) || [])
        .filter(f => !f.finished && f.event >= nextGW && f.event < nextGW + projectionData.horizon)
        .sort((a, b) => (a.event || 0) - (b.event || 0))
        .forEach(f => {
          const isHome = f.team_h === raw.team;
          const opponentId = isHome ? f.team_a : f.team_h;
          const opponent = teamsById.get(opponentId);
          const fdr = isHome ? (f.team_h_difficulty || 3) : (f.team_a_difficulty || 3);
          const item = { gw: f.event, opponent: opponent?.short_name || '?', opponentFull: opponent?.name || '?', home: isHome, fdr, kickoff: f.kickoff_time };
          if (!fixturesByGameweek.has(f.event)) fixturesByGameweek.set(f.event, []);
          fixturesByGameweek.get(f.event).push(item);
        });
      const playerFixtures = [...fixturesByGameweek.values()].flat();

      // NEW: 4+ consecutive fixture run analysis
      let consecutiveGoodFixtures = 0;
      let maxConsecutiveRun = 0;
      let currentRun = 0;
      for (const gw of projectionData.gameweeks) {
        const gwFixtures = fixturesByGameweek.get(gw) || [];
        if (gwFixtures.length && Math.min(...gwFixtures.map(fixture => fixture.fdr)) <= 2) {
          currentRun++;
          maxConsecutiveRun = Math.max(maxConsecutiveRun, currentRun);
        } else {
          currentRun = 0;
        }
      }
      consecutiveGoodFixtures = maxConsecutiveRun;

      return {
        ...p,
        availability: Math.round(enhancedAvailability),
        news, status, formBoost, minutesReliability, xGI90,
        bonusPer90, csPerGame, setPieceBonus, ictIndex,
        isPenaltyTaker, isFKTaker, isCornerTaker,
        rotationRisk: minutesReliability >= 0.85 ? 1 : minutesReliability >= 0.65 ? 0.94 : 0.86,
        upcomingFixtures: playerFixtures,
        consecutiveGoodFixtures,
        enhancedCost: Number(raw.now_cost) / 10,
        teamFull: teamsById.get(p.teamId)?.name || p.team,
        teamCode: teamsById.get(p.teamId)?.code || 0,
        teamShort: teamsById.get(p.teamId)?.short_name || '',
      };
    });

    const minimumAvailability = strategy === 'chase' ? 25 : 50;
    const availablePlayers = enrichedPlayers.filter(player => player.availability >= minimumAvailability && (player.weekly?.[0]?.xMins || 0) >= 20);

    // ---- SMART SQUAD BUILDER ----
    const POSITION_LIMITS = AI_TEAM_POSITION_LIMITS;
    const MAX_PER_TEAM = 3;

    function adjustedScore(player, strat) {
      const horizon = horizonScore(player);
      const next = nextGameweekScore(player);
      const value = horizon / Math.max(Number(player.cost || player.enhancedCost) || 0.1, 0.1);
      const ownership = Math.min(Number(player.ownership) || 0, 80);
      // Favour proven first-choice starters; discount unknowns and rotation risks.
      const starter = (Number(player.starterScore) || 0) - 50;
      if (strat === 'protect') return horizon + next * 0.2 + ownership * 0.008 + starter * 0.03;
      if (strat === 'chase') return horizon + next * 0.2 + (80 - ownership) * 0.008 + starter * 0.02;
      return horizon + next * 0.2 + value * 0.04 + starter * 0.03;
    }

    const costTenths = player => Math.round(Number(player.cost || player.enhancedCost || 0) * 10);
    const goalkeeperCosts = availablePlayers.filter(player => player.position === 'GKP').map(costTenths).sort((a, b) => a - b);
    const reserveGoalkeeperCeilingTenths = (goalkeeperCosts[0] || 40) + 5;

    function isLegalSquad(players) {
      if (!Array.isArray(players) || players.length !== 15) return false;
      const positions = players.reduce((counts, player) => ({ ...counts, [player.position]: (counts[player.position] || 0) + 1 }), {});
      const clubs = players.reduce((counts, player) => ({ ...counts, [player.teamId]: (counts[player.teamId] || 0) + 1 }), {});
      return Object.entries(POSITION_LIMITS).every(([position, count]) => positions[position] === count)
        && Object.values(clubs).every(count => count <= MAX_PER_TEAM)
        && players.reduce((sum, player) => sum + costTenths(player), 0) <= 1000;
    }
    const lineupScore = nextGameweekScore;
    const easyDefensiveTriple = (players, teamId) => {
      const defensivePlayers = players.filter(player => player.teamId === teamId && ['GKP', 'DEF'].includes(player.position));
      if (defensivePlayers.length <= 2) return true;
      const next3 = defensivePlayers[0]?.upcomingFixtures?.slice(0, 3) || [];
      const avgFdr = next3.length ? next3.reduce((sum, fixture) => sum + (fixture.fdr || 3), 0) / next3.length : 5;
      const projected = defensivePlayers.reduce((sum, player) => sum + lineupScore(player), 0);
      return avgFdr <= 2 && projected >= 10.5;
    };
    const respectsDefensiveStack = players => [...new Set(players.map(player => player.teamId))].every(teamId => easyDefensiveTriple(players, teamId));
    const squadObjective = players => {
      const weeklyXI = projectionData.gameweeks.reduce((total, gameweek, index) => {
        const scoreWeek = player => Number(player.weekly?.[index]?.xPts) || 0;
        const selection = selectOptimalLineup(players, scoreWeek);
        return total + selection.starters.reduce((sum, player) => sum + scoreWeek(player), 0) * (0.9 ** index);
      }, 0);
      // A bench pick only matters when it can realistically cover a starter. Score
      // the best legal replacement in each future GW instead of rewarding four
      // expensive names that never enter the XI.
      const benchDepth = projectionData.gameweeks.reduce((total, gameweek, index) => {
        const scoreWeek = player => Number(player.weekly?.[index]?.xPts) || 0;
        const xi = selectOptimalLineup(players, scoreWeek);
        const outfieldCover = xi.bench.filter(player => player.position !== 'GKP');
        const playableCover = outfieldCover.filter(player => (player.weekly?.[index]?.xMins || 0) >= 55);
        const reserveKeeper = xi.bench.find(player => player.position === 'GKP');
        const coverScore = playableCover.reduce((sum, player) => sum + scoreWeek(player), 0)
          + (reserveKeeper && (reserveKeeper.weekly?.[index]?.xMins || 0) >= 55 ? scoreWeek(reserveKeeper) * 0.25 : 0);
        const missingCoverPenalty = Math.max(0, 3 - playableCover.length) * 2.5;
        return total + (coverScore - missingCoverPenalty) * (0.9 ** index);
      }, 0) * 0.18;
      const riskPenalty = players.reduce((sum, player) => sum + Math.max(0, 75 - (player.availability || 0)) * 0.02, 0);
      // Prefer squads built from first-choice starters; penalize unknown/rotation-heavy picks.
      const starterPenalty = players.reduce((sum, player) => sum + Math.max(0, 55 - (Number(player.starterScore) || 0)) * 0.04, 0);
      return weeklyXI + benchDepth - riskPenalty - starterPenalty;
    };

    // Bounded beam search keeps alternative budget structures alive, then scores complete squads by their best XI.
    const slots = ['FWD', 'MID', 'DEF', 'GKP', 'MID', 'DEF', 'FWD', 'MID', 'DEF', 'GKP', 'MID', 'DEF', 'FWD', 'MID', 'DEF'];
    const pools = Object.keys(POSITION_LIMITS).reduce((result, position) => {
      const ranked = availablePlayers.filter(player => player.position === position).sort((a, b) => adjustedScore(b, 'balanced') - adjustedScore(a, 'balanced'));
      const economical = [...ranked].sort((a, b) => costTenths(a) - costTenths(b)).slice(0, 8);
      result[position] = [...ranked.slice(0, 34), ...economical].filter((player, index, list) => list.findIndex(item => item.id === player.id) === index);
      return result;
    }, {});
    let beam = [{ players: [], spent: 0, score: 0, teamCounts: {} }];
    for (const position of slots) {
      const next = [];
      for (const state of beam) {
        const samePositionCount = state.players.filter(player => player.position === position).length;
        for (const player of pools[position]) {
          if (state.players.some(item => item.id === player.id) || (state.teamCounts[player.teamId] || 0) >= MAX_PER_TEAM) continue;
          if (position === 'GKP' && samePositionCount === 1 && costTenths(player) > reserveGoalkeeperCeilingTenths) continue;
          const spent = state.spent + costTenths(player);
          if (spent > 1000) continue;
          const players = [...state.players, player];
          if (!respectsDefensiveStack(players)) continue;
          const remainingSlots = slots.slice(players.length);
          const minimumRemaining = remainingSlots.reduce((sum, remainingPosition) => sum + Math.min(...pools[remainingPosition].filter(candidate => !players.some(item => item.id === candidate.id)).map(costTenths)), 0);
          if (spent + minimumRemaining > 1000) continue;
          next.push({
            players,
            spent,
            score: state.score + adjustedScore(player, 'balanced'),
            teamCounts: { ...state.teamCounts, [player.teamId]: (state.teamCounts[player.teamId] || 0) + 1 },
          });
        }
      }
      const signatures = new Set();
      beam = next.sort((a, b) => b.score - a.score || b.spent - a.spent).filter(state => {
        const signature = state.players.map(player => player.id).sort((a, b) => a - b).join(',');
        if (signatures.has(signature)) return false;
        signatures.add(signature);
        return true;
      }).slice(0, 1000);
    }
    const finalists = beam.filter(state => isLegalSquad(state.players) && respectsDefensiveStack(state.players)).map(state => ({ ...state, objective: squadObjective(state.players) })).sort((a, b) => b.objective - a.objective || b.spent - a.spent);
    if (!finalists.length) throw new Error('The optimizer could not produce a legal 15-player squad within £100m');
    const bestSquad = finalists[0].players;
    const bestCost = finalists[0].spent / 10;

    const selected = bestSquad;

    // The weekly XI is the highest-scoring legal formation from all seven FPL shapes.
    const lineupSelection = selectOptimalLineup(selected, lineupScore);
    const { starters, bench } = lineupSelection;

    // Captain: highest ceiling + reliable minutes + fixture quality
    const captainPool = starters.filter(p => p.position !== 'GKP').sort((a, b) => nextGameweekScore(b) - nextGameweekScore(a)
      || (b.weekly?.[0]?.xMins || 0) - (a.weekly?.[0]?.xMins || 0)
      || String(a.name).localeCompare(String(b.name)));
    const captain = captainPool[0] || starters[0];
    const viceCaptain = captainPool[1] || starters[1];

    // Captain x2
    const captainXPts = captain?.weekly?.[0]?.xPts || 0;
    const expectedPoints = starters.reduce((s, p) => s + (p.weekly?.[0]?.xPts || 0), 0) + captainXPts;
    const formation = lineupSelection.formation;
    const teamCost = selected.reduce((s, p) => s + (p.cost || p.enhancedCost), 0);
    const teamXpts = projectionData.gameweeks.reduce((total, gameweek, index) => {
      const scoreWeek = player => Number(player.weekly?.[index]?.xPts) || 0;
      const weeklySelection = selectOptimalLineup(selected, scoreWeek);
      const weeklyCaptain = weeklySelection.starters.filter(player => player.position !== 'GKP').sort((a, b) => scoreWeek(b) - scoreWeek(a))[0];
      return total + weeklySelection.starters.reduce((sum, player) => sum + scoreWeek(player), 0) + scoreWeek(weeklyCaptain);
    }, 0);

    // ---- AUTONOMOUS TRANSFER PLAN ----
    // Plan transfers for each GW in the horizon
    function buildTransferPlan(planStrategy) {
      const transferPlan = [];
      let currentSquad = [...selected];
      let freeTransfers = 1;
      let bankTenths = 1000 - selected.reduce((sum, player) => sum + costTenths(player), 0);
      for (const gw of projectionData.gameweeks) {
      const transfersMade = [];
      const maxTransfers = freeTransfers + 1;
      while (transfersMade.length < maxTransfers) {
        const scoreSquadFromGW = players => projectionData.gameweeks
          .filter(projectedGW => projectedGW >= gw)
          .reduce((total, projectedGW, offset) => {
            const scoreWeek = player => Number(player.weekly?.find(w => w.gameweek === projectedGW)?.xPts) || 0;
            const xi = selectOptimalLineup(players, scoreWeek);
            return total + xi.starters.reduce((sum, player) => sum + scoreWeek(player), 0) * (0.9 ** offset);
          }, 0);
        const currentScore = scoreSquadFromGW(currentSquad);
        const remainingScore = player => projectionData.gameweeks
          .filter(projectedGW => projectedGW >= gw)
          .reduce((sum, projectedGW, offset) => sum + (Number(player.weekly?.find(w => w.gameweek === projectedGW)?.xPts) || 0) * (0.9 ** offset), 0);
        const weakLinks = [...currentSquad].sort((a, b) => {
          const riskA = a.availability < 60 || (a.weekly?.find(w => w.gameweek === gw)?.xMins || 0) < 45 ? 1 : 0;
          const riskB = b.availability < 60 || (b.weekly?.find(w => w.gameweek === gw)?.xMins || 0) < 45 ? 1 : 0;
          return riskB - riskA || remainingScore(a) - remainingScore(b);
        });
        const squadIds = new Set(currentSquad.map(p => p.id));
        const teamCounts = {};
        currentSquad.forEach(p => { teamCounts[p.teamId] = (teamCounts[p.teamId] || 0) + 1; });
        let bestTransfer = null;

        for (const outgoing of weakLinks.slice(0, 5)) {
          const incoming = availablePlayers
            .filter(p => p.position === outgoing.position && !squadIds.has(p.id))
            .filter(p => p.teamId === outgoing.teamId || (teamCounts[p.teamId] || 0) < MAX_PER_TEAM)
            .filter(p => costTenths(p) <= costTenths(outgoing) + bankTenths)
            .map(p => {
              const proposedSquad = currentSquad.map(player => player.id === outgoing.id ? p : player);
              if (!isLegalSquad(proposedSquad)) return null;
              const nextGain = (p.weekly?.find(w => w.gameweek === gw)?.xPts || 0) - (outgoing.weekly?.find(w => w.gameweek === gw)?.xPts || 0);
              const horizonGain = scoreSquadFromGW(proposedSquad) - currentScore;
              const reliability = ((p.availability || 0) - (outgoing.availability || 0)) * 0.015;
              const differential = (Math.min(Number(outgoing.ownership) || 0, 80) - Math.min(Number(p.ownership) || 0, 80)) * 0.012;
              const preference = planStrategy === 'protect' ? reliability : planStrategy === 'chase' ? differential : 0;
              return { out: outgoing, in: p, gain: Math.round(horizonGain * 10) / 10, nextGain: Math.round(nextGain * 10) / 10, rankingGain: horizonGain + preference };
            })
            .filter(Boolean)
            .filter(move => move.gain > 0)
            .sort((a, b) => b.rankingGain - a.rankingGain || b.gain - a.gain || b.nextGain - a.nextGain)[0];
          if (incoming && (!bestTransfer || incoming.rankingGain > bestTransfer.rankingGain)) bestTransfer = incoming;
        }

        const hit = transfersMade.length >= freeTransfers ? 4 : 0;
        const threshold = hit ? 4.5 : 1.5;
        if (!bestTransfer || bestTransfer.gain < threshold) break;
        transfersMade.push({ ...bestTransfer, hit });
        currentSquad = currentSquad.map(p => p.id === bestTransfer.out.id ? bestTransfer.in : p);
        bankTenths += costTenths(bestTransfer.out) - costTenths(bestTransfer.in);
      }

      const hit = transfersMade.reduce((sum, move) => sum + move.hit, 0);
      if (transfersMade.length) {
        transferPlan.push({ gw, transfers: transfersMade, transfer: transfersMade[0], hit, freeTransfersBefore: freeTransfers, rolled: false });
        freeTransfers = Math.min(5, Math.max(0, freeTransfers - transfersMade.length) + 1);
      } else {
        freeTransfers = Math.min(freeTransfers + 1, 5);
        transferPlan.push({ gw, transfers: [], transfer: null, hit: 0, freeTransfers, rolled: true });
      }
      }
      return transferPlan;
    }
    const plansByStrategy = {
      balanced: buildTransferPlan('balanced'),
      protect: buildTransferPlan('protect'),
      chase: buildTransferPlan('chase'),
    };
    const transferPlan = plansByStrategy.balanced;

    // ---- AUTONOMOUS CHIP SCHEDULE ----
    const chipSchedule = [];
    // Analyze each GW for chip opportunities
    const chipCandidates = [];
    for (const gw of projectionData.gameweeks) {
      const gwSquad = selected;
      const benchXPts = bench.reduce((s, p) => {
        const w = p.weekly?.find(week => week.gameweek === gw);
        return s + (w?.xPts || 0);
      }, 0);
      const capXPts = captain ? (captain.weekly?.find(w => w.gameweek === gw)?.xPts || 0) : 0;
      const blanks = starters.filter(p => !p.weekly?.some(w => w.gameweek === gw && w.fixtures?.length > 0)).length;
      const injured = gwSquad.filter(p => (p.availability || 0) < 50).length;

      chipCandidates.push(
        { gw, chip: 'BB', score: benchXPts, expectedGain: benchXPts, reason: `Bench projects ${benchXPts.toFixed(1)} xPts.` },
        { gw, chip: 'TC', score: capXPts, expectedGain: capXPts, reason: `${captain?.name || 'Captain'} projects ${capXPts.toFixed(1)} xPts.` },
      );
      // FPL rule: Wildcard and Free Hit cannot be played in Gameweek 1.
      if (gw !== 1) {
        chipCandidates.push(
          { gw, chip: 'WC', score: injured * 2 + blanks * 1.5, expectedGain: injured * 2 + blanks * 1.5, reason: `${injured} availability concerns and ${blanks} blanks.` },
          { gw, chip: 'FH', score: blanks * 2, expectedGain: blanks * 2, reason: `${blanks} projected blanks in the squad.` },
        );
      }
    }
    const occupiedGameweeks = new Set();
    ['WC', 'FH', 'BB', 'TC'].forEach(chip => {
      const candidate = chipCandidates.filter(item => item.chip === chip && !occupiedGameweeks.has(item.gw)).sort((a, b) => b.score - a.score)[0];
      if (!candidate) return;
      occupiedGameweeks.add(candidate.gw);
      chipSchedule.push({ ...candidate, confidence: candidate.score >= 8 ? 'High' : candidate.score >= 5 ? 'Medium' : 'Watch', projected: true });
    });
    chipSchedule.sort((a, b) => a.gw - b.gw);

    // ---- AUTO-LOCK BEFORE GW1 ----
    const gw1 = events.find(event => event.id === 1);
    const gw1Deadline = gw1?.deadline_time ? new Date(gw1.deadline_time) : null;
    const shouldAutoLock = nextGW === 1 && gw1Deadline && new Date() >= gw1Deadline;
    const qualityAudit = {
      legalSquad: isLegalSquad(selected),
      budgetCompliant: selected.reduce((sum, player) => sum + costTenths(player), 0) <= 1000,
      lineupComplete: starters.length === 11 && bench.length === 4,
      reserveGoalkeeperEconomical: hasEconomicalReserveGoalkeeper(selected, reserveGoalkeeperCeilingTenths),
      reserveGoalkeeperCeiling: reserveGoalkeeperCeilingTenths / 10,
        optimizerVersion: 8,
        optimizer: 'fixed balanced squad with weekly best-XI and competitive bench-cover objective',
      ...lineupSelection.audit,
    };

    const result = {
      meta: {
        schemaVersion: '2.0',
        modelVersion: AI_TEAM_MODEL_VERSION,
        generatedAt: new Date().toISOString(),
        strategy, budget, horizon,
        targetGW: nextGW, currentGW,
        gameweeks: projectionData.gameweeks,
        isAutoLocked: Boolean(shouldAutoLock),
        lockScheduledFor: nextGW === 1 ? gw1?.deadline_time || null : null,
        quality: qualityAudit,
        managerId: SMART_TEAM_MANAGER_ID,
      },
      formation,
      teamCost: Math.round(teamCost * 10) / 10,
      teamXpts: Math.round(teamXpts * 10) / 10,
      squad: selected.map(p => ({ ...p, isCaptain: captain?.id === p.id, isViceCaptain: viceCaptain?.id === p.id })),
      lineup: {
        starters: starters.map(p => ({ ...p, isCaptain: captain?.id === p.id, isViceCaptain: viceCaptain?.id === p.id })),
        bench,
        captain: captain ? { ...captain, isCaptain: true } : null,
        viceCaptain: viceCaptain ? { ...viceCaptain, isViceCaptain: true } : null,
        expectedPoints: Math.round(expectedPoints * 10) / 10,
        quality: qualityAudit,
      },
       transfers: { plan: transferPlan, plansByStrategy },
      chips: { schedule: chipSchedule },
    };

    // Auto-save to DB (locked if GW1)
    if (sql) {
      try {
        await sql`INSERT INTO ai_team (session_id, squad, lineup, formation, team_cost, team_xpts, strategy, budget, horizon, is_locked, locked_at, transfers, chips)
          VALUES (${storageKey}, ${JSON.stringify(result.squad)}, ${JSON.stringify(result.lineup)}, ${result.formation}, ${result.teamCost}, ${result.teamXpts}, ${strategy}, ${budget}, ${projectionData.horizon}, ${Boolean(shouldAutoLock)}, ${shouldAutoLock ? new Date() : null}, ${JSON.stringify(result.transfers)}, ${JSON.stringify(result.chips)})
ON CONFLICT (session_id) DO UPDATE SET
            squad = EXCLUDED.squad, lineup = EXCLUDED.lineup, formation = EXCLUDED.formation,
            team_cost = EXCLUDED.team_cost, team_xpts = EXCLUDED.team_xpts, strategy = EXCLUDED.strategy,
            budget = EXCLUDED.budget, horizon = EXCLUDED.horizon,
            is_locked = ai_team.is_locked OR EXCLUDED.is_locked,
            locked_at = CASE WHEN ai_team.is_locked THEN ai_team.locked_at ELSE EXCLUDED.locked_at END,
            transfers = EXCLUDED.transfers, chips = EXCLUDED.chips, updated_at = NOW()`;
      } catch (saveErr) {
        logger.error({ err: saveErr }, 'AI Team auto-save error');
      }
    }

    res.json(result);
  } catch (error) {
    logger.error({ err: error }, 'AI Team error');
    res.status(500).json({ error: 'Failed to build AI Team' });
  }
});

// ---- Smart Team Standing (FPL live data for the AI manager) ----
router.get('/standing', async (req, res) => {
  try {
    const [entryData, historyData] = await Promise.all([
      getCachedApiData(`https://fantasy.premierleague.com/api/entry/${SMART_TEAM_MANAGER_ID}/`),
      getCachedApiData(`https://fantasy.premierleague.com/api/entry/${SMART_TEAM_MANAGER_ID}/history/`).catch(() => null),
    ]);
    const events = (await getCachedApiData(BOOTSTRAP_URL).catch(() => ({})))?.events || [];
    const currentGW = events.find(e => e.is_current)?.id || events.filter(e => e.finished).length || 1;
    const nextGW = events.find(e => e.is_next)?.id || currentGW + 1;

    const gwHistory = (historyData?.current || []).map(h => ({
      gw: h.event,
      points: h.points,
      rank: h.rank || null,
      overallRank: h.overall_rank || null,
      transfers: h.transfers || 0,
      transferCost: h.event_transfers_cost || 0,
      benchedPts: h.points_on_bench || 0,
    }));

    const gwPoints = gwHistory.find(h => h.gw === currentGW) || null;
    const freeTransfers = (() => {
      // Estimate free transfers: start with 1, +1 per GW without a transfer, cap at 5
      let ft = 1;
      for (const h of gwHistory) {
        if (h.transfers === 0) ft = Math.min(5, ft + 1);
        else ft = 1;
      }
      return ft;
    })();

    res.json({
      managerId: SMART_TEAM_MANAGER_ID,
      teamName: entryData.name || '',
      playerName: [entryData.player_first_name, entryData.player_second_name].filter(Boolean).join(' '),
      overallPoints: entryData.summary_overall_points || 0,
      overallRank: entryData.summary_overall_rank || null,
      currentGW,
      nextGW,
      gwPoints: gwPoints?.points || null,
      gwRank: gwPoints?.rank || null,
      gwOverallRank: gwPoints?.overallRank || null,
      gwTransfers: gwPoints?.transfers || 0,
      gwTransferCost: gwPoints?.transferCost || 0,
      freeTransfers,
      gwHistory,
      lastUpdated: new Date().toISOString(),
    });
  } catch (error) {
    logger.error({ err: error }, 'Smart Team standing error');
    res.status(500).json({ error: 'Failed to fetch smart team standing' });
  }
});

// ---- GW Advisor: captain, transfers, players to watch ----
router.get('/advisor', async (req, res) => {
  try {
    const [bootstrap, fixtures] = await Promise.all([
      getCachedApiData(BOOTSTRAP_URL),
      getCachedApiData(FIXTURES_URL),
    ]);
    const events = bootstrap.events || [];
    const elements = bootstrap.elements || [];
    const teams = bootstrap.teams || [];
    const teamsById = new Map(teams.map(t => [t.id, t]));
    const currentGW = events.find(e => e.is_current)?.id || events.filter(e => e.finished).length || 1;
    const nextGW = events.find(e => e.is_next)?.id || currentGW + 1;

    // Get saved squad
    const savedRows = sql ? await sql`SELECT * FROM ai_team WHERE session_id = ${SMART_TEAM_STORAGE_KEY} ORDER BY updated_at DESC LIMIT 1` : [];
    if (!savedRows.length) return res.json({ advisor: null, message: 'No saved smart team found.' });
    const row = savedRows[0];
    const squad = row.squad || [];
    const lineup = row.lineup || {};
    const starters = lineup.starters || [];
    const bench = lineup.bench || [];
    const transferPlan = row.transfers?.plan || [];
    const plansByStrategy = row.transfers?.plansByStrategy || {};

    // Free transfers estimation
    let freeTransfers = 1;
    const historyData = await optionalApiGet(`https://fantasy.premierleague.com/api/entry/${SMART_TEAM_MANAGER_ID}/history/`);
    const gwHistory = historyData?.current || [];
    for (const h of gwHistory) {
      if (h.event >= nextGW) break;
      if ((h.transfers || 0) === 0) freeTransfers = Math.min(5, freeTransfers + 1);
      else freeTransfers = 1;
    }

    // Build player map for lookups
    const bootstrapMap = new Map(elements.map(e => [e.id, e]));
    const fixturesByTeam = new Map();
    fixtures.forEach(f => {
      [f.team_h, f.team_a].forEach(teamId => {
        if (!fixturesByTeam.has(teamId)) fixturesByTeam.set(teamId, []);
        fixturesByTeam.get(teamId).push(f);
      });
    });

    // Current GW transfer suggestion from plan
    const gwTransferPlan = transferPlan.find(p => p.gw === nextGW) || transferPlan.find(p => p.gw === currentGW);
    const suggestedTransfers = (gwTransferPlan?.transfers || []).slice(0, 2);
    const transferHit = gwTransferPlan?.hit || 0;
    const shouldHold = !suggestedTransfers.length;

    // Captain recommendation for next GW: highest xPts from starters (non-GKP)
    const captainCandidates = starters
      .filter(p => p.position !== 'GKP')
      .map(p => {
        const nextW = (p.weekly || []).find(w => w.gameweek === nextGW);
        const curW = (p.weekly || []).find(w => w.gameweek === currentGW);
        const xPts = nextW?.xPts || 0;
        const form = Number(bootstrapMap.get(p.id)?.form) || 0;
        const fixtures = (fixturesByTeam.get(p.teamId) || []).filter(f => !f.finished && f.event === nextGW);
        const fdr = fixtures.length ? Math.min(...fixtures.map(f => (p.teamId === f.team_h ? f.team_h_difficulty : f.team_a_difficulty) || 3)) : 3;
        return { ...p, nextXPts: xPts, form, fdr, gwPoints: curW?.xPts || 0 };
      })
      .sort((a, b) => b.nextXPts - a.nextXPts || b.form - a.form);
    const captainPick = captainCandidates[0] || null;
    const vicePick = captainCandidates.find(c => c.id !== captainPick?.id) || captainCandidates[1] || null;

    // Players to watch: top form + good fixtures (not in squad)
    const squadIds = new Set(squad.map(p => p.id));
    const watchlist = elements
      .filter(e => {
        const form = Number(e.form) || 0;
        if (form < 4.5) return false;
        const teamFixtures = (fixturesByTeam.get(e.team) || []).filter(f => !f.finished && f.event >= nextGW && f.event < nextGW + 4);
        if (!teamFixtures.length) return false;
        const avgFDR = teamFixtures.reduce((s, f) => s + ((e.team === f.team_h ? f.team_h_difficulty : f.team_a_difficulty) || 3), 0) / teamFixtures.length;
        return avgFDR <= 2.5;
      })
      .map(e => {
        const team = teamsById.get(e.team);
        const posMap = { 1: 'GKP', 2: 'DEF', 3: 'MID', 4: 'FWD' };
        const teamFixtures = (fixturesByTeam.get(e.team) || []).filter(f => !f.finished && f.event >= nextGW && f.event < nextGW + 4);
        const avgFDR = teamFixtures.reduce((s, f) => s + ((e.team === f.team_h ? f.team_h_difficulty : f.team_a_difficulty) || 3), 0) / teamFixtures.length;
        return {
          id: e.id,
          name: e.web_name,
          team: team?.short_name || '?',
          teamFull: team?.name || '',
          position: posMap[e.element_type] || 'MID',
          cost: (e.now_cost || 0) / 10,
          form: Number(e.form) || 0,
          xGI90: Number(e.expected_goal_involvements_per_90) || 0,
          avgFDR: Math.round(avgFDR * 10) / 10,
          inSquad: squadIds.has(e.id),
          upcomingFixtures: teamFixtures.slice(0, 4).map(f => {
            const isHome = f.team_h === e.team;
            const oppId = isHome ? f.team_a : f.team_h;
            const opp = teamsById.get(oppId);
            return { gw: f.event, opponent: opp?.short_name || '?', home: isHome, fdr: isHome ? (f.team_h_difficulty || 3) : (f.team_a_difficulty || 3) };
          }),
        };
      })
      .filter(p => !squadIds.has(p.id))
      .sort((a, b) => b.form - a.form || a.avgFDR - b.avgFDR)
      .slice(0, 8);

    res.json({
      nextGW,
      currentGW,
      freeTransfers,
      captain: captainPick ? { id: captainPick.id, name: captainPick.name, team: captainPick.teamFull || captainPick.team, position: captainPick.position, nextXPts: captainPick.nextXPts, form: captainPick.form, fdr: captainPick.fdr } : null,
      viceCaptain: vicePick ? { id: vicePick.id, name: vicePick.name } : null,
      transferAdvice: {
        hold: shouldHold,
        transfers: suggestedTransfers.map(t => ({
          out: { id: t.out?.id, name: t.out?.name, position: t.out?.position, team: t.out?.teamFull || t.out?.team },
          in: { id: t.in?.id, name: t.in?.name, position: t.in?.position, team: t.in?.teamFull || t.in?.team },
          gain: t.gain || 0,
          nextGain: t.nextGain || 0,
        })),
        hit: transferHit,
        reason: shouldHold ? 'Your squad looks solid. No urgent transfers needed — roll the free transfer.' : `Suggested ${suggestedTransfers.length} move${suggestedTransfers.length > 1 ? 's' : ''} for a projected +${suggestedTransfers.reduce((s, t) => s + (t.gain || 0), 0).toFixed(1)} xPts gain.`,
      },
      playersToWatch: watchlist,
      lastUpdated: new Date().toISOString(),
    });
  } catch (error) {
    logger.error({ err: error }, 'Smart Team advisor error');
    res.status(500).json({ error: 'Failed to build GW advisor' });
  }
});

module.exports = router;
