const logger = require('./logger');
const { sql } = require('./db');
const { getSeasonData, getGameweekPlayerStatsWithOpponents, parseNum } = require('./fplInsightsData');
const { getCachedApiData, BOOTSTRAP_URL, BOOTSTRAP_CACHE_TTL } = require('./cache');

const activeCollections = new Set();

async function collectAndStore(gwId) {
  const collectingKey = `gw_${gwId}`;
  if (activeCollections.has(collectingKey)) return;
  activeCollections.add(collectingKey);
  const startTime = Date.now();

  try {
    const [seasonData, gwStats] = await Promise.all([
      getSeasonData(),
      getGameweekPlayerStatsWithOpponents(gwId)
    ]);

    const gwPlayers = gwStats;
    if (!gwPlayers || gwPlayers.length === 0) {
      logger.warn({ gwId }, 'No gameweek data available from FPL-Core-Insights');
      return;
    }

    const bootstrap = await getCachedApiData(BOOTSTRAP_URL, BOOTSTRAP_CACHE_TTL);
    const bsPlayerMap = new Map();
    (bootstrap?.elements || []).forEach(p => bsPlayerMap.set(p.id, p));
    const teamMap = {};
    (bootstrap?.teams || []).forEach(t => { teamMap[t.id] = { name: t.name, short: t.short_name, code: t.code }; });
    const posNames = { 1: 'GKP', 2: 'DEF', 3: 'MID', 4: 'FWD' };

    const playersData = [];

    for (const stat of gwPlayers) {
      if (stat.minutes === 0) continue;
      const bs = bsPlayerMap.get(stat.playerId);
      if (!bs) continue;

      const teamInfo = teamMap[bs.team] || { name: 'Unknown', short: 'UNK', code: 0 };
      const posType = bs.element_type;
      const defconThreshold = (posType === 1 || posType === 2) ? 10 : 12;
      const isDefcon = stat.defensiveContribution >= defconThreshold;
      const isHaul = stat.totalPoints >= 10;

      const playerTeamId = bs.team;
      const opp = stat.opponent;
      let oppShort = 'TBD';
      let vsStr = 'TBD';
      let scoreStr = '-';
      let wasHome = null;

      if (opp) {
        wasHome = opp.homeTeamId === playerTeamId;
        oppShort = wasHome ? opp.awayShort : opp.homeShort;
        const homeShort = opp.homeShort;
        const awayShort = opp.awayShort;
        vsStr = wasHome ? `vs ${oppShort}` : `@ ${oppShort}`;
        scoreStr = `${opp.teamGoalsConceded === 0 ? 'CS' : ''}`;
      }

      const defconMatches = [];
      const haulMatches = [];
      const bonusMatches = [];

      if (isDefcon) {
        defconMatches.push({ gw: gwId, opponent: oppShort, vs: vsStr, wasHome, score: scoreStr, minutes: stat.minutes, defconVal: stat.defensiveContribution, cleanSheets: stat.cleanSheets, points: stat.totalPoints });
      }
      if (isHaul) {
        haulMatches.push({ gw: gwId, opponent: oppShort, vs: vsStr, wasHome, score: scoreStr, minutes: stat.minutes, goals: stat.goalsScored, assists: stat.assists, bonus: stat.bonus, bps: stat.bps, points: stat.totalPoints });
      }
      if (stat.bonus > 0) {
        bonusMatches.push({ gw: gwId, opponent: oppShort, vs: vsStr, wasHome, score: scoreStr, minutes: stat.minutes, bonus: stat.bonus, bps: stat.bps, points: stat.totalPoints });
      }

      playersData.push({
        id: bs.id, code: bs.code, name: bs.web_name,
        fullName: `${bs.first_name} ${bs.second_name}`,
        team: teamInfo.short, teamName: teamInfo.name, teamCode: teamInfo.code,
        position: posNames[posType] || 'MID', elementType: posType,
        cost: (bs.now_cost || 0) / 10,
        totalPoints: bs.total_points || 0, minutes: bs.minutes || 0,
        gwPoints: stat.totalPoints,
        defconGames: isDefcon ? 1 : 0, defconMatches,
        haulGames: isHaul ? 1 : 0, haulMatches,
        bonus3Games: stat.bonus === 3 ? 1 : 0,
        bonus2Games: stat.bonus === 2 ? 1 : 0,
        bonus1Games: stat.bonus === 1 ? 1 : 0,
        totalBonus: stat.bonus || 0, bonusMatches,
        expectedGoals: stat.expectedGoals, expectedAssists: stat.expectedAssists,
        defensiveContribution: stat.defensiveContribution,
        xGI: stat.expectedGoalInvolvements
      });
    }

    if (sql && playersData.length > 0) {
      await sql`INSERT INTO player_advanced_stats (gameweek, players, total_players) VALUES (${gwId}, ${JSON.stringify(playersData)}, ${playersData.length}) ON CONFLICT (gameweek) DO UPDATE SET players = ${JSON.stringify(playersData)}, total_players = ${playersData.length}`;
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    logger.info({ gwId, playerCount: playersData.length, elapsed }, 'Player advanced stats collection complete (FPL-Core-Insights)');
  } catch (err) {
    logger.error({ err, gwId }, 'Player advanced stats collection failed');
  } finally {
    activeCollections.delete(collectingKey);
  }
}

async function checkAndCollect() {
  try {
    const bootstrap = await getCachedApiData(BOOTSTRAP_URL, BOOTSTRAP_CACHE_TTL);
    if (!bootstrap || !bootstrap.events) return;

    const currentGW = bootstrap.events.find(e => e.is_current);
    const finishedGWs = bootstrap.events.filter(e => e.finished).sort((a, b) => a.id - b.id);
    const gwsToCollect = [...finishedGWs];
    if (currentGW) gwsToCollect.push(currentGW);

    if (!sql) return;

    const existing = await sql`SELECT gameweek FROM player_advanced_stats`;
    const collectedGWs = new Set(existing.map(r => r.gameweek));

    for (const gw of gwsToCollect) {
      if (collectedGWs.has(gw.id)) continue;
      logger.info({ gwId: gw.id }, 'GW missing from DB, triggering collection (FPL-Core-Insights)');
      await collectAndStore(gw.id);
    }
  } catch (err) {
    logger.warn({ err }, 'Error checking for advanced stats collection');
  }
}

async function computeAdvancedFromInsights(bootstrap, gwId) {
  const gwPlayers = await getGameweekPlayerStatsWithOpponents(gwId);
  if (!gwPlayers || gwPlayers.length === 0) return null;

  const bsPlayerMap = new Map();
  (bootstrap?.elements || []).forEach(p => bsPlayerMap.set(p.id, p));
  const teamMap = {};
  (bootstrap?.teams || []).forEach(t => { teamMap[t.id] = { name: t.name, short: t.short_name, code: t.code }; });
  const posNames = { 1: 'GKP', 2: 'DEF', 3: 'MID', 4: 'FWD' };

  return gwPlayers.filter(s => s.minutes > 0).map(stat => {
    const bs = bsPlayerMap.get(stat.playerId);
    if (!bs) return null;
    const teamInfo = teamMap[bs.team] || { name: 'Unknown', short: 'UNK', code: 0 };
    const posType = bs.element_type;
    const defconThreshold = (posType === 1 || posType === 2) ? 10 : 12;
    const isDefcon = stat.defensiveContribution >= defconThreshold;
    const isHaul = stat.totalPoints >= 10;

    const playerTeamId = bs.team;
    const opp = stat.opponent;
    let oppShort = 'TBD';
    let vsStr = 'TBD';
    let scoreStr = '-';
    let wasHome = null;

    if (opp) {
      wasHome = opp.homeTeamId === playerTeamId;
      oppShort = wasHome ? opp.awayShort : opp.homeShort;
      vsStr = wasHome ? `vs ${oppShort}` : `@ ${oppShort}`;
      scoreStr = `${opp.teamGoalsConceded === 0 ? 'CS' : ''}`;
    }

    return {
      id: bs.id, code: bs.code, name: bs.web_name,
      fullName: `${bs.first_name} ${bs.second_name}`,
      team: teamInfo.short, teamName: teamInfo.name, teamCode: teamInfo.code,
      position: posNames[posType] || 'MID', elementType: posType,
      cost: (bs.now_cost || 0) / 10,
      totalPoints: bs.total_points || 0, minutes: bs.minutes || 0,
      gwPoints: stat.totalPoints,
      defconGames: isDefcon ? 1 : 0,
      defconMatches: isDefcon ? [{ gw: gwId, opponent: oppShort, vs: vsStr, wasHome, score: scoreStr, minutes: stat.minutes, defconVal: stat.defensiveContribution, cleanSheets: stat.cleanSheets, points: stat.totalPoints }] : [],
      haulGames: isHaul ? 1 : 0,
      haulMatches: isHaul ? [{ gw: gwId, opponent: oppShort, vs: vsStr, wasHome, score: scoreStr, minutes: stat.minutes, goals: stat.goalsScored, assists: stat.assists, bonus: stat.bonus, bps: stat.bps, points: stat.totalPoints }] : [],
      bonus3Games: stat.bonus === 3 ? 1 : 0,
      bonus2Games: stat.bonus === 2 ? 1 : 0,
      bonus1Games: stat.bonus === 1 ? 1 : 0,
      totalBonus: stat.bonus || 0,
      bonusMatches: stat.bonus > 0 ? [{ gw: gwId, opponent: oppShort, vs: vsStr, wasHome, score: scoreStr, minutes: stat.minutes, bonus: stat.bonus, bps: stat.bps, points: stat.totalPoints }] : [],
      expectedGoals: stat.expectedGoals, expectedAssists: stat.expectedAssists,
      defensiveContribution: stat.defensiveContribution,
      xGI: stat.expectedGoalInvolvements
    };
  }).filter(Boolean);
}

module.exports = { collectAndStore, checkAndCollect, computeAdvancedFromInsights };
