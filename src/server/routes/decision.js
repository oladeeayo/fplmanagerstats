const express = require('express');
const { buildDecisionCentre, buildSquadAdvice } = require('../../decisionModel');
const { getCachedApiData, BOOTSTRAP_URL, FIXTURES_URL, getGlobalPlayerHistory } = require('../cache');
const { parsePositiveId, POSITION_MAP } = require('../helpers');
const { heavyEndpointLimiter } = require('../middleware');
const logger = require('../logger');

const router = express.Router();

async function optionalApiGet(url, fallback = null) {
  try { return await getCachedApiData(url); }
  catch (error) {
    if ([400, 404].includes(error.response?.status)) return fallback;
    throw error;
  }
}

// ---- Core analysis ----
async function analyzeManager(managerId, playerData, leagueId = null) {
  const [managerEntryData, historyData, leagueData] = await Promise.all([
    getCachedApiData(`https://fantasy.premierleague.com/api/entry/${managerId}/`),
    getCachedApiData(`https://fantasy.premierleague.com/api/entry/${managerId}/history/`),
    leagueId ? optionalApiGet(`https://fantasy.premierleague.com/api/leagues-classic/${leagueId}/standings/`) : Promise.resolve(null)
  ]);
  const currentGameweek = playerData.events.find(event => event.is_current)?.id || playerData.events.find(event => event.is_next)?.id || 1;
  const topManagerPoints = leagueData?.standings?.results?.[0]?.total || 0;

  let totalCaptaincyPoints = 0, totalPointsActive = 0, totalPointsLostOnBench = 0, totalCaptaincyAttempts = 0;
  const playerStats = {}, positionPoints = { GKP: {}, DEF: {}, MID: {}, FWD: {} };
  const weeklyPoints = new Array(currentGameweek).fill(0);
  const weeklyRanks = new Array(currentGameweek).fill(0);
  const weeklyPointsLostBench = new Array(currentGameweek).fill(0);
  const captainChoices = [], chipImpact = [];

  let highestPoints = 0, highestPointsGW = 0, lowestPoints = Infinity, lowestPointsGW = 0;
  let highestRank = Infinity, highestRankGW = 0, lowestRank = 0, lowestRankGW = 0;

  const currentTeam = [];
  const currentPicksData = await optionalApiGet(`https://fantasy.premierleague.com/api/entry/${managerId}/event/${currentGameweek}/picks/`);
  const currentPicks = currentPicksData?.picks || [];

  for (const pick of currentPicks) {
    const player = playerData.elements.find(p => p.id === pick.element);
    if (!player) continue;
    const ph = await getGlobalPlayerHistory(player.id);
    const nextFixtures = (ph.fixtures || []).slice(0, 5).map(f => {
      const isHome = f.is_home;
      const opp = playerData.teams.find(t => t.id === (isHome ? f.team_a : f.team_h));
      return { opponent: opp ? opp.short_name : '?', isHome, difficulty: f.difficulty };
    });
    const last3 = (ph.history || []).slice(-3).reduce((s, g) => s + g.total_points, 0);
    const teamObj = playerData.teams[player.team - 1];
    currentTeam.push({
      name: player.web_name, nextFixtures, last3GWPoints: last3,
      photoId: player.code, team: teamObj.name, teamShort: teamObj.short_name,
      position: POSITION_MAP[player.element_type - 1],
      nowCost: player.now_cost, form: player.form, elementId: player.id,
      selectedBy: player.selected_by_percent, totalPoints: player.total_points,
      pointsPerGame: player.points_per_game, goalsScored: player.goals_scored,
      assists: player.assists, cleanSheets: player.clean_sheets,
      bonus: player.bonus, minutes: player.minutes,
      ictIndex: player.ict_index, expectedGoals: player.expected_goal_involvements
    });
  }

  // Fetch all GW picks in parallel batches, using cache
  const GW_BATCH_SIZE = 5;
  const gwPickResults = new Array(currentGameweek);
  for (let i = 0; i < currentGameweek; i += GW_BATCH_SIZE) {
    const batch = [];
    for (let j = i; j < Math.min(i + GW_BATCH_SIZE, currentGameweek); j++) {
      batch.push(
        getCachedApiData(
          `https://fantasy.premierleague.com/api/entry/${managerId}/event/${j + 1}/picks/`,
          j + 1 < currentGameweek ? 24 * 60 * 60 * 1000 : 60 * 1000
        )
          .then(data => { gwPickResults[j] = data; })
          .catch(() => { gwPickResults[j] = null; })
      );
    }
    await Promise.all(batch);
  }

  // Pre-fetch player histories in controlled batches to avoid FPL API rate limits
  const allPlayerIds = [...new Set(
    gwPickResults.filter(Boolean).flatMap(picksData => picksData.picks.map(p => p.element))
  )];
  const PH_BATCH = 4;
  for (let i = 0; i < allPlayerIds.length; i += PH_BATCH) {
    const batch = allPlayerIds.slice(i, i + PH_BATCH);
    await Promise.all(batch.map(pid => getGlobalPlayerHistory(pid).catch(() => null)));
  }

  for (let gw = 1; gw <= currentGameweek; gw++) {
    const picksData = gwPickResults[gw - 1];
    if (!picksData) continue;
    const picks = picksData.picks;
    const isBenchBoost = picksData.active_chip === "bboost", isTripleCaptain = picksData.active_chip === "3xc";
    let gwPoints = 0, gwBenchPoints = 0, captainPick = null, bestPick = null;

    for (const pick of picks) {
      const playerId = pick.element, player = playerData.elements.find(p => p.id == playerId);
      if (!player) continue;
      const ph = await getGlobalPlayerHistory(playerId);
      const gwHistory = (ph.history || []).find(h => h.round === gw);
      const pts = gwHistory ? gwHistory.total_points : 0;

      if (!playerStats[playerId]) {
        const t = playerData.teams[player.team - 1];
        playerStats[playerId] = {
          name: player.web_name, team: t.name, teamShort: t.short_name,
          position: POSITION_MAP[player.element_type - 1],
          totalPointsActive: 0, gwInSquad: 0, starts: 0, cappedPoints: 0,
          playerPoints: 0, photoId: player.code,
          nowCost: player.now_cost, selectedBy: player.selected_by_percent,
          form: player.form, pointsPerGame: player.points_per_game,
          totalPoints: player.total_points,
          goalsScored: player.goals_scored, assists: player.assists,
          cleanSheets: player.clean_sheets, goalsConceded: player.goals_conceded,
          bonus: player.bonus, bps: player.bps,
          influence: player.influence, creativity: player.creativity,
          threat: player.threat, ictIndex: player.ict_index,
          minutes: player.minutes, yellowCards: player.yellow_cards,
          redCards: player.red_cards, saves: player.saves,
          penaltiesSaved: player.penalties_saved, penaltiesMissed: player.penalties_missed,
          expectedGoals: player.expected_goal_involvements,
          expectedAssists: player.expected_assists,
          expectedGoalsTotal: player.expected_goals,
          elementId: player.id, code: player.code,
          nextFixtures: (await getGlobalPlayerHistory(playerId)).fixtures?.slice(0, 5).map(f => {
            const ih = f.is_home;
            const op = playerData.teams.find(t => t.id === (ih ? f.team_a : f.team_h));
            return { opponent: op ? op.short_name : '?', isHome: ih, difficulty: f.difficulty };
          }) || []
        };
      }

      const inStarting11 = pick.position <= 11, isCaptain = pick.is_captain;
      playerStats[playerId].playerPoints += pts;

      if (inStarting11 || isBenchBoost) {
        let activePoints = pts;
        if (isCaptain) {
          activePoints *= isTripleCaptain ? 3 : 2;
          totalCaptaincyPoints += activePoints;
          totalCaptaincyAttempts++;
          playerStats[playerId].cappedPoints += activePoints;
          captainPick = { playerId, name: player.web_name, points: activePoints, rawPoints: pts, multiplier: isTripleCaptain ? 3 : 2 };
        }
        playerStats[playerId].totalPointsActive += activePoints;
        totalPointsActive += activePoints;
        gwPoints += activePoints;
        const pos = playerStats[playerId].position;
        if (!positionPoints[pos][playerId]) positionPoints[pos][playerId] = { name: player.web_name, points: 0, photoId: player.code };
        positionPoints[pos][playerId].points += activePoints;
        if (inStarting11) playerStats[playerId].starts += 1;
        playerStats[playerId].gwInSquad += 1;
      } else { totalPointsLostOnBench += pts; gwBenchPoints += pts; }

      if (!bestPick || pts > bestPick.rawPoints) bestPick = { playerId, name: player.web_name, rawPoints: pts };
    }

    weeklyPoints[gw - 1] = gwPoints;
    weeklyPointsLostBench[gw - 1] = gwBenchPoints;
    const gwRank = (historyData.current || []).find(h => h.event === gw)?.overall_rank || 0;
    weeklyRanks[gw - 1] = gwRank;
    captainChoices.push({ gw, captain: captainPick || { name: 'None', points: 0, rawPoints: 0, multiplier: 0 }, bestOption: bestPick || { name: 'None', rawPoints: 0 }, missedPoints: (bestPick?.rawPoints||0) - ((captainPick?.rawPoints||0)*(captainPick?.multiplier||1)) });
    if (picksData.active_chip) chipImpact.push({ chip: picksData.active_chip, gw, points: gwPoints });
    if (gwPoints > highestPoints) { highestPoints = gwPoints; highestPointsGW = gw; }
    if (gwPoints < lowestPoints) { lowestPoints = gwPoints; lowestPointsGW = gw; }
    if (gwRank < highestRank) { highestRank = gwRank; highestRankGW = gw; }
    if (gwRank > lowestRank) { lowestRank = gwRank; lowestRankGW = gw; }
  }

  const avgPoints = weeklyPoints.reduce((a, b) => a + b, 0) / weeklyPoints.length;
  chipImpact.forEach(c => { c.avgPoints = Math.round(avgPoints * 10) / 10; c.diff = Math.round((c.points - avgPoints) * 10) / 10; });

  const averageRank = Math.round(weeklyRanks.reduce((a, b) => a + b, 0) / weeklyRanks.length);
  const halfLen = Math.floor(weeklyRanks.length / 2);
  const fh = halfLen > 0 ? Math.round(weeklyRanks.slice(0, halfLen).reduce((a, b) => a + b, 0) / halfLen) : averageRank;
  const sh = halfLen > 0 ? Math.round(weeklyRanks.slice(halfLen).reduce((a, b) => a + b, 0) / weeklyRanks.slice(halfLen).length) : averageRank;
  const rankTrend = fh - sh;

  const players = Object.values(playerStats);
  const defGkp = players.filter(p => p.position === 'DEF' || p.position === 'GKP');
  const gks = players.filter(p => p.position === 'GKP');
  const totalCS = defGkp.reduce((s, p) => s + (p.cleanSheets||0), 0);
  const totalGC = defGkp.reduce((s, p) => s + (p.goalsConceded||0), 0);
  const totalSaves = gks.reduce((s, p) => s + (p.saves||0), 0);
  const templateCount = players.filter(p => parseFloat(p.selectedBy||0) >= 20).length;

  // Underperforming analysis
  const underperforming = players
    .filter(p => {
      const avgFDR = p.nextFixtures?.length ? p.nextFixtures.reduce((s,f) => s+f.difficulty, 0) / p.nextFixtures.length : 0;
      const formOk = parseFloat(p.form||0) >= 2.0;
      const ppgOk = parseFloat(p.pointsPerGame||0) >= 2.0;
      const toughFixtures = avgFDR >= 3.5;
      const lowMins = (p.minutes||0) < 500;
      const yellowRisk = (p.yellowCards||0) >= 4;
      return (toughFixtures && !formOk) || (!ppgOk && lowMins) || yellowRisk;
    })
    .sort((a, b) => parseFloat(a.form||0) - parseFloat(b.form||0))
    .slice(0, 5);

  // Find replacement suggestions from bootstrap
  const replacements = underperforming.map(up => {
    const pos = up.position;
    const cost = up.nowCost || 50;
    const candidates = playerData.elements
      .filter(e => POSITION_MAP[e.element_type-1] === pos && Math.abs(e.now_cost - cost) <= 15 && e.id !== up.elementId && e.total_points > (up.totalPoints||0))
      .sort((a, b) => (b.form||0) - (a.form||0))
      .slice(0, 3)
      .map(e => ({ name: e.web_name, team: (playerData.teams[e.team-1]||{}).name, nowCost: e.now_cost, form: e.form, totalPoints: e.total_points, pointsPerGame: e.points_per_game, photoId: e.code, selectedBy: e.selected_by_percent }));
    return { player: up, reasons: [], replacements: candidates };
  });

  underperforming.forEach(up => {
    const r = replacements.find(r => r.player.elementId === up.elementId);
    const avgFDR = up.nextFixtures?.length ? up.nextFixtures.reduce((s,f) => s+f.difficulty, 0) / up.nextFixtures.length : 0;
    if (avgFDR >= 3.5) r.reasons.push(`Tough fixtures ahead (avg FDR ${avgFDR.toFixed(1)})`);
    if (parseFloat(up.form||0) < 2.0) r.reasons.push(`Poor form (${up.form} pts in last 5)`);
    if ((up.minutes||0) < 500) r.reasons.push(`Limited minutes (${up.minutes} total)`);
    if ((up.yellowCards||0) >= 4) r.reasons.push(`Yellow card risk (${up.yellowCards} cards)`);
    if (parseFloat(up.pointsPerGame||0) < 2.0) r.reasons.push(`Low PPG (${up.pointsPerGame})`);
    if (!r.reasons.length) r.reasons.push('Underperforming relative to cost');
  });

  const seasonHistory = (historyData?.past || []).map((s, i) => ({
    season: s.season_name || `${2020+i}/${2021+i}`, rank: s.rank, points: s.total_points
  }));

  const chips = historyData?.chips || [];

  return {
    managerInfo: {
      name: `${managerEntryData.player_first_name} ${managerEntryData.player_last_name}`,
      teamName: managerEntryData.name,
      overallRanking: managerEntryData.summary_overall_rank?.toLocaleString() || "N/A",
      overallRankRaw: managerEntryData.summary_overall_rank || 0,
      managerPoints: managerEntryData.summary_overall_points,
      chipsUsed: chips.map(c => c.name), chipsCount: chips.length,
      lastSeasonRank: (historyData?.past || []).length > 0 ? historyData.past[historyData.past.length - 1].rank.toLocaleString() : "Didn't Play",
      lastSeasonRankRaw: (historyData?.past || []).length > 0 ? historyData.past[historyData.past.length - 1].rank : null,
      seasonBeforeLastRank: (historyData?.past || []).length > 1 ? historyData.past[historyData.past.length - 2].rank.toLocaleString() : "Didn't Play",
      pointDifference: topManagerPoints - managerEntryData.summary_overall_points,
      totalPointsLostOnBench, totalCaptaincyPoints,
      captaincyEfficiency: totalCaptaincyAttempts > 0 ? Math.round((totalCaptaincyPoints / totalCaptaincyAttempts) * 10) / 10 : 0,
      currentGameweek, highestPoints, highestPointsGW, lowestPoints, lowestPointsGW,
      highestRank: highestRank.toLocaleString(), highestRankGW,
      lowestRank: lowestRank.toLocaleString(), lowestRankGW,
      averageRank: averageRank.toLocaleString(), rankTrend,
      rankTrendLabel: rankTrend > 0 ? 'improving' : rankTrend < 0 ? 'declining' : 'stable',
      totalTransfers: managerEntryData?.transfers?.cost || 0,
      templateScore: templateCount, differentialScore: players.length - templateCount,
      defensiveCleanSheets: totalCS, defensiveGoalsConceded: totalGC, defensiveSaves: totalSaves
    },
    playerStats: players.sort((a, b) => b.totalPointsActive - a.totalPointsActive),
    positionSummary: Object.entries(positionPoints).map(([position, pls]) => ({
      position, totalPoints: Object.values(pls).reduce((s, p) => s + p.points, 0),
      count: Object.keys(pls).length
    })),
    weeklyPoints, weeklyRanks, weeklyPointsLostBench,
    currentTeam, captainChoices, chipImpact, seasonHistory,
    underperforming: replacements
  };
}

const managerCache = {};

router.post('/v1/decision-centre', heavyEndpointLimiter, async (req, res) => {
  const managerId = parsePositiveId(req.body?.managerId);
  if (!managerId) return res.status(400).json({ error: 'A valid managerId is required' });
  const requestedGW = Math.max(1, Math.min(38, Number.parseInt(req.body?.targetGW, 10) || 1));
  const horizon = Math.max(1, Math.min(8, Number.parseInt(req.body?.horizon, 10) || 5));
  const rivalIds = [...new Set((req.body?.rivalIds || []).map(parsePositiveId).filter(Boolean))].filter(id => id !== managerId).slice(0, 5);

  try {
    const [bootstrap, fixtures, manager, history] = await Promise.all([
      getCachedApiData(BOOTSTRAP_URL),
      getCachedApiData(FIXTURES_URL),
      getCachedApiData(`https://fantasy.premierleague.com/api/entry/${managerId}/`),
      getCachedApiData(`https://fantasy.premierleague.com/api/entry/${managerId}/history/`),
    ]);
    const currentGW = bootstrap.events.find(event => event.is_current)?.id;
    const nextGW = bootstrap.events.find(event => event.is_next)?.id || currentGW || requestedGW;
    const picksGW = Math.max(1, currentGW || nextGW - 1 || 1);
    const picks = await optionalApiGet(`https://fantasy.premierleague.com/api/entry/${managerId}/event/${picksGW}/picks/`);
    if (!picks?.picks?.length) return res.status(409).json({ error: 'This manager does not yet have a published squad. Try again after the first deadline.' });
    const liveData = currentGW ? await optionalApiGet(`https://fantasy.premierleague.com/api/event/${currentGW}/live/`) : null;

    const rivals = (await Promise.all(rivalIds.map(async id => {
      const [entry, rivalPicks] = await Promise.all([
        optionalApiGet(`https://fantasy.premierleague.com/api/entry/${id}/`),
        optionalApiGet(`https://fantasy.premierleague.com/api/entry/${id}/event/${picksGW}/picks/`),
      ]);
      if (!entry || !rivalPicks?.picks) return null;
      return { id, name: `${entry.player_first_name} ${entry.player_last_name}`.trim(), teamName: entry.name, rank: entry.summary_overall_rank, picks: rivalPicks.picks };
    }))).filter(Boolean);

    res.json(buildDecisionCentre({ bootstrap, fixtures, manager: { ...manager, id: managerId }, picks, history, rivals, liveData, options: { ...req.body, targetGW: req.body?.targetGW || nextGW, horizon } }));
  } catch (error) {
    logger.error({ err: error }, 'Decision centre error');
    const status = error.response?.status === 404 ? 404 : 500;
    res.status(status).json({ error: status === 404 ? 'Manager or rival could not be found' : 'Failed to build the decision centre' });
  }
});

router.get('/analyze-manager/:managerId', heavyEndpointLimiter, async (req, res) => {
  const managerId = parsePositiveId(req.params.managerId);
  if (!managerId) return res.status(400).json({ error: 'Invalid manager ID' });
  try {
    const bs = await getCachedApiData(BOOTSTRAP_URL);
    const result = await analyzeManager(managerId, bs);
    managerCache[managerId] = result;
    res.json(result);
  } catch (e) {
    const status = e.response?.status || 500;
    logger.error({ err: e, managerId, status }, 'Error analyzing manager');
    if (status === 404) return res.status(404).json({ error: 'Manager not found' });
    if (status === 429) return res.status(429).json({ error: 'FPL API rate limited. Try again shortly.' });
    res.status(500).json({ error: 'Failed to analyze manager', detail: e.message });
  }
});

router.get('/compare-managers/:id1/:id2', heavyEndpointLimiter, async (req, res) => {
  const id1 = parsePositiveId(req.params.id1);
  const id2 = parsePositiveId(req.params.id2);
  if (!id1 || !id2) return res.status(400).json({ error: 'Invalid manager ID' });
  try {
    const bs = await getCachedApiData(BOOTSTRAP_URL);
    const [m1, m2] = await Promise.all([analyzeManager(id1, bs), analyzeManager(id2, bs)]);
    res.json({ manager1: m1, manager2: m2 });
  } catch (e) { res.status(500).json({ error: 'Failed to compare' }); }
});

// ---- Enhanced Model Endpoints ----

const { buildOptimalSquad, findOptimalLineup, findOptimalTransfers } = require('../squadOptimizer');
const { buildTransferStrategy } = require('../transferPlanner');
const { buildPlayerProjections } = require('../../captaincyModel');
const understat = require('../understat');

// Optimal squad builder (MILP-inspired)
router.post('/optimal-squad', heavyEndpointLimiter, async (req, res) => {
  try {
    const [bootstrap, fixtures] = await Promise.all([
      getCachedApiData(BOOTSTRAP_URL),
      getCachedApiData(FIXTURES_URL),
    ]);
    const options = {
      budget: req.body.budget || 100,
      strategy: req.body.strategy || 'balanced',
      templateStyle: req.body.templateStyle || 'balanced',
      horizon: req.body.horizon || 5,
    };
    const projections = buildPlayerProjections({ bootstrap, fixtures, startGW: options.startGW, horizon: options.horizon });
    const result = buildOptimalSquad(projections.projections, options);
    res.json({
      meta: { modelVersion: 'Squad Optimizer 2.0', generatedAt: new Date().toISOString() },
      ...result,
    });
  } catch (error) {
    logger.error({ err: error }, 'Optimal squad error');
    res.status(500).json({ error: 'Failed to build optimal squad' });
  }
});

// Transfer optimization for existing squad
router.post('/optimize-transfers', heavyEndpointLimiter, async (req, res) => {
  try {
    const { playerIds, budget, freeTransfers, strategy, horizon } = req.body;
    if (!playerIds || !Array.isArray(playerIds) || playerIds.length !== 15) {
      return res.status(400).json({ error: 'Provide 15 playerIds for your current squad' });
    }
    const [bootstrap, fixtures] = await Promise.all([
      getCachedApiData(BOOTSTRAP_URL),
      getCachedApiData(FIXTURES_URL),
    ]);
    const projections = buildPlayerProjections({ bootstrap, fixtures, horizon: horizon || 5 });
    const projectionMap = new Map(projections.projections.map(p => [p.id, p]));
    const squad = playerIds.map(id => projectionMap.get(id)).filter(Boolean);
    if (squad.length < 15) return res.status(400).json({ error: 'Some player IDs could not be found' });

    const plans = findOptimalTransfers(squad, projections.projections, {
      budget: budget || 0,
      freeTransfers: freeTransfers || 1,
      horizon: horizon || 5,
      strategy,
    });
    const transferPlan = buildTransferStrategy(squad, projections.projections, {
      budget: budget || 0,
      freeTransfers: freeTransfers || 1,
      horizon: horizon || 5,
      strategy,
    });

    res.json({
      meta: { modelVersion: 'Transfer Planner 2.0', generatedAt: new Date().toISOString() },
      plans,
      strategy: transferPlan,
    });
  } catch (error) {
    logger.error({ err: error }, 'Transfer optimization error');
    res.status(500).json({ error: 'Failed to optimize transfers' });
  }
});

// Understat data endpoint
router.get('/understat/teams', heavyEndpointLimiter, async (req, res) => {
  try {
    const data = await understat.fetchTeams();
    if (!data) return res.status(503).json({ error: 'Understat data unavailable' });
    res.json(data);
  } catch (error) {
    logger.error({ err: error }, 'Understat fetch error');
    res.status(500).json({ error: 'Failed to fetch Understat data' });
  }
});

router.get('/understat/players', heavyEndpointLimiter, async (req, res) => {
  try {
    const data = await understat.fetchPlayers();
    if (!data) return res.status(503).json({ error: 'Understat data unavailable' });
    res.json(data);
  } catch (error) {
    logger.error({ err: error }, 'Understat fetch error');
    res.status(500).json({ error: 'Failed to fetch Understat data' });
  }
});

// Head-to-Head Matchup Intelligence Endpoint
router.get('/v1/h2h-matchup/:managerId', heavyEndpointLimiter, async (req, res) => {
  const managerId = parsePositiveId(req.params.managerId);
  if (!managerId) return res.status(400).json({ error: 'Invalid manager ID' });
  const requestedLeagueId = parsePositiveId(req.query.leagueId);

  try {
    const [bootstrap, managerData] = await Promise.all([
      getCachedApiData(BOOTSTRAP_URL),
      getCachedApiData(`https://fantasy.premierleague.com/api/entry/${managerId}/`)
    ]);

    const h2hLeagues = (managerData.leagues?.h2h || []).map(l => ({
      id: l.id,
      name: l.name,
      rank: l.entry_rank,
      lastRank: l.entry_last_rank,
      totalEntries: l.rank_count
    }));

    if (h2hLeagues.length === 0) {
      return res.json({
        hasH2H: false,
        message: 'This manager is not currently participating in any Head-to-Head leagues.'
      });
    }

    const selectedLeague = requestedLeagueId
      ? h2hLeagues.find(l => l.id === requestedLeagueId) || h2hLeagues[0]
      : h2hLeagues[0];

    const currentGW = bootstrap.events?.find(e => e.is_current)?.id || bootstrap.events?.find(e => e.is_next)?.id || 1;
    const targetGW = Math.max(1, Math.min(38, parseInt(req.query.gw) || currentGW));

    // Fetch H2H match fixture for manager in this league and gameweek
    const h2hData = await optionalApiGet(
      `https://fantasy.premierleague.com/api/leagues-h2h-matches/league/${selectedLeague.id}/?entry=${managerId}&event=${targetGW}`
    );

    const matches = h2hData?.results || [];
    const numManagerId = Number(managerId);
    const userMatch = matches.find(m => Number(m.entry_1_entry) === numManagerId || Number(m.entry_2_entry) === numManagerId) || matches[0];

    if (!userMatch) {
      return res.json({
        hasH2H: true,
        h2hLeagues,
        selectedLeague,
        targetGW,
        hasOpponent: false,
        message: `No H2H fixture scheduled for GW${targetGW} in ${selectedLeague.name}.`
      });
    }

    const isEntry1 = Number(userMatch.entry_1_entry) === numManagerId;
    const isEntry2 = Number(userMatch.entry_2_entry) === numManagerId;

    let opponentId = null;
    let opponentName = 'Opponent';
    let opponentTeam = 'Opponent Squad';
    let userName = 'Your Team';
    let userTeam = 'Your Squad';

    if (isEntry1) {
      opponentId = userMatch.entry_2_entry;
      opponentName = userMatch.entry_2_player_name || 'Opponent';
      opponentTeam = userMatch.entry_2_name || 'Opponent Squad';
      userName = userMatch.entry_1_player_name || 'You';
      userTeam = userMatch.entry_1_name || 'Your Squad';
    } else if (isEntry2) {
      opponentId = userMatch.entry_1_entry;
      opponentName = userMatch.entry_1_player_name || 'Opponent';
      opponentTeam = userMatch.entry_1_name || 'Opponent Squad';
      userName = userMatch.entry_2_player_name || 'You';
      userTeam = userMatch.entry_2_name || 'Your Squad';
    }

    async function getLatestPicks(mId, requestedGW, activeGW) {
      if (!mId) return null;
      let picks = await optionalApiGet(`https://fantasy.premierleague.com/api/entry/${mId}/event/${requestedGW}/picks/`);
      if (picks && Array.isArray(picks.picks) && picks.picks.length > 0) return picks;

      if (activeGW && activeGW !== requestedGW) {
        picks = await optionalApiGet(`https://fantasy.premierleague.com/api/entry/${mId}/event/${activeGW}/picks/`);
        if (picks && Array.isArray(picks.picks) && picks.picks.length > 0) return picks;
      }

      for (let g = Math.min(38, activeGW || 38); g >= 1; g--) {
        if (g === requestedGW || g === activeGW) continue;
        picks = await optionalApiGet(`https://fantasy.premierleague.com/api/entry/${mId}/event/${g}/picks/`);
        if (picks && Array.isArray(picks.picks) && picks.picks.length > 0) return picks;
      }
      return null;
    }

    // Fetch picks for manager and opponent with automatic fallback to active published GW if pre-deadline
    const [userPicksData, oppPicksData, oppEntryData] = await Promise.all([
      getLatestPicks(managerId, targetGW, currentGW),
      opponentId ? getLatestPicks(opponentId, targetGW, currentGW) : Promise.resolve(null),
      opponentId ? optionalApiGet(`https://fantasy.premierleague.com/api/entry/${opponentId}/`) : Promise.resolve(null)
    ]);

    const elements = bootstrap.elements || [];
    const teams = bootstrap.teams || [];
    const getTeam = id => teams.find(t => t.id === id);

    const elementMap = {};
    elements.forEach(p => {
      const xP = parseFloat(p.ep_next) || (parseFloat(p.form || 0) * 0.8 + parseFloat(p.points_per_game || 0) * 0.2);
      elementMap[p.id] = {
        id: p.id,
        code: p.code,
        webName: p.web_name,
        name: `${p.first_name} ${p.second_name}`,
        team: getTeam(p.team)?.short_name || 'FPL',
        pos: POSITION_MAP[p.element_type - 1] || 'MID',
        nowCost: p.now_cost,
        form: p.form,
        xP: Math.max(0, xP)
      };
    });

    const processSquad = (picksData) => {
      if (!picksData?.picks) return { starting11: [], bench: [], totalXPts: 0, captain: null, activeChip: null };
      let totalXPts = 0;
      let captain = null;
      const starting11 = [];
      const bench = [];
      const activeChip = picksData.active_chip;

      picksData.picks.forEach(pick => {
        const el = elementMap[pick.element];
        if (!el) return;
        const isCap = pick.is_captain;
        const isStarting = pick.position <= 11 || activeChip === 'bboost';
        const mult = isCap ? (activeChip === '3xc' ? 3 : 2) : (isStarting ? 1 : 0);
        const playerXPts = Math.round((el.xP * mult) * 10) / 10;

        const pObj = {
          ...el,
          positionNum: pick.position,
          isCaptain: pick.is_captain,
          isViceCaptain: pick.is_vice_captain,
          multiplier: mult,
          xPts: playerXPts
        };

        if (isCap) captain = pObj;
        if (isStarting) {
          totalXPts += playerXPts;
          starting11.push(pObj);
        } else {
          bench.push(pObj);
        }
      });

      return { starting11, bench, totalXPts: Math.round(totalXPts * 10) / 10, captain, activeChip };
    };

    const userSquad = processSquad(userPicksData);
    const oppSquad = processSquad(oppPicksData);

    const userStartIds = new Set(userSquad.starting11.map(p => p.id));
    const oppStartIds = new Set(oppSquad.starting11.map(p => p.id));

    const overlap = userSquad.starting11.filter(p => oppStartIds.has(p.id));
    const userEdges = userSquad.starting11.filter(p => !oppStartIds.has(p.id));
    const oppThreats = oppSquad.starting11.filter(p => !userStartIds.has(p.id));

    const xPtsDiff = Math.round((userSquad.totalXPts - oppSquad.totalXPts) * 10) / 10;

    res.json({
      hasH2H: true,
      hasOpponent: true,
      h2hLeagues,
      selectedLeague,
      targetGW,
      user: {
        id: managerId,
        name: userName || `${managerData.player_first_name} ${managerData.player_last_name}`,
        teamName: userTeam || managerData.name,
        rank: managerData.summary_overall_rank,
        squad: userSquad
      },
      opponent: {
        id: opponentId,
        name: opponentName || (oppEntryData ? `${oppEntryData.player_first_name} ${oppEntryData.player_last_name}` : 'Opponent'),
        teamName: opponentTeam || oppEntryData?.name || 'Opponent Squad',
        rank: oppEntryData?.summary_overall_rank || 0,
        squad: oppSquad
      },
      xPtsDiff,
      overlap,
      userEdges,
      oppThreats
    });
  } catch (error) {
    logger.error({ err: error }, 'H2H matchup error');
    res.status(500).json({ error: 'Failed to build H2H matchup' });
  }
});

router.analyzeManager = analyzeManager;
module.exports = router;
