const logger = require('./logger');
const { sql } = require('./db');
const { getSeasonData, getGameweekPlayerStatsWithOpponents, getAllFinishedGWStats, parseNum, getSeasonLabel, fetchPlayerStats } = require('./fplInsightsData');
const { getCachedApiData, BOOTSTRAP_URL, BOOTSTRAP_CACHE_TTL } = require('./cache');

const activeCollections = new Set();

let lastHistoricalCollectionSeason = null;
const HISTORICAL_COLLECT_INTERVAL = 12 * 60 * 60 * 1000;

function buildSeasonAggregates(rows) {
  const playerMap = new Map();
  for (const ps of rows) {
    const pid = Number(ps.id);
    if (!pid) continue;
    const minutes = parseNum(ps.minutes);
    const goals = parseNum(ps.goals_scored);
    const assists = parseNum(ps.assists);
    const expectedGoals = parseNum(ps.expected_goals);
    const expectedAssists = parseNum(ps.expected_assists);
    const xGI = parseNum(ps.expected_goal_involvements);
    const appearances = parseNum(ps.appearances) || parseNum(ps.games) || (minutes > 0 ? 1 : 0);
    const bonus = parseNum(ps.bonus);
    const bps = parseNum(ps.bps);
    const totalPoints = parseNum(ps.total_points);
    const cleanSheets = parseNum(ps.clean_sheets);
    const defensiveContribution = parseNum(ps.defensive_contribution);
    const form = parseNum(ps.form);

    const existing = playerMap.get(pid) || {
      id: pid, appearances: 0, minutes: 0, goals: 0, assists: 0,
      expectedGoals: 0, expectedAssists: 0, xGI: 0, bonus: 0, bps: 0,
      totalPoints: 0, cleanSheets: 0, defensiveContribution: 0, form: 0
    };
    existing.appearances += appearances;
    existing.minutes += minutes;
    existing.goals += goals;
    existing.assists += assists;
    existing.expectedGoals += expectedGoals;
    existing.expectedAssists += expectedAssists;
    existing.xGI += xGI;
    existing.bonus += bonus;
    existing.bps += bps;
    existing.totalPoints += totalPoints;
    existing.cleanSheets += cleanSheets;
    existing.defensiveContribution += defensiveContribution;
    existing.form = Math.max(existing.form, form);
    playerMap.set(pid, existing);
  }
  for (const [, p] of playerMap) {
    p.goalsPer90 = p.minutes > 0 ? (p.goals * 90 / p.minutes) : 0;
    p.assistsPer90 = p.minutes > 0 ? (p.assists * 90 / p.minutes) : 0;
    p.xGIPer90 = p.minutes > 0 ? (p.xGI * 90 / p.minutes) : 0;
    p.bonusPer90 = p.minutes > 0 ? (p.bonus * 90 / p.minutes) : 0;
    p.pointsPer90 = p.minutes > 0 ? (p.totalPoints * 90 / p.minutes) : 0;
  }
  return playerMap;
}

async function collectHistoricalStats() {
  if (!sql) return;
  const season = getSeasonLabel();
  const now = Date.now();
  if (lastHistoricalCollectionSeason === season) return;

  try {
    const parts = season.split('-');
    const prevYear = Number(parts[0]) - 1;
    const prevSeason = `${prevYear}-${prevYear + 1}`;

    const [currentRows, prevRows] = await Promise.all([
      fetchPlayerStats(season).catch(() => []),
      fetchPlayerStats(prevSeason).catch(() => [])
    ]);

    const currentAgg = buildSeasonAggregates(currentRows);
    const prevAgg = buildSeasonAggregates(prevRows);

    const allPids = new Set([...currentAgg.keys(), ...prevAgg.keys()]);
    const players = [];

    for (const pid of allPids) {
      const curr = currentAgg.get(pid) || null;
      const prev = prevAgg.get(pid) || null;

      const entry = { id: pid };

      if (curr) {
        entry.currentSeason = {
          appearances: curr.appearances, minutes: curr.minutes,
          goals: curr.goals, assists: curr.assists,
          expectedGoals: curr.expectedGoals, expectedAssists: curr.expectedAssists,
          xGI: curr.xGI, bonus: curr.bonus, bps: curr.bps,
          totalPoints: curr.totalPoints, cleanSheets: curr.cleanSheets,
          defensiveContribution: curr.defensiveContribution,
          goalsPer90: curr.goalsPer90, assistsPer90: curr.assistsPer90,
          xGIPer90: curr.xGIPer90, bonusPer90: curr.bonusPer90,
          pointsPer90: curr.pointsPer90, form: curr.form,
        };
      }

      if (prev) {
        entry.prevSeason = {
          appearances: prev.appearances, minutes: prev.minutes,
          goals: prev.goals, assists: prev.assists,
          expectedGoals: prev.expectedGoals, expectedAssists: prev.expectedAssists,
          xGI: prev.xGI, bonus: prev.bonus, bps: prev.bps,
          totalPoints: prev.totalPoints, cleanSheets: prev.cleanSheets,
          defensiveContribution: prev.defensiveContribution,
          goalsPer90: prev.goalsPer90, assistsPer90: prev.assistsPer90,
          xGIPer90: prev.xGIPer90, bonusPer90: prev.bonusPer90,
          pointsPer90: prev.pointsPer90, form: prev.form,
        };
      }

      const prevMin = prev?.minutes || 0;
      const currMin = curr?.minutes || 0;
      const prevAppear = prev?.appearances || 0;
      const currAppear = curr?.appearances || 0;

      if (prevMin > 0 && currMin > 0) {
        const appearanceRatio = (Math.min(prevAppear, 38) / 38 * 0.3) + (Math.min(currAppear, 38) / 38 * 0.3);
        const minutesRatio = (Math.min(prevMin, 38 * 90) / (38 * 90) * 0.2) + (Math.min(currMin, 38 * 90) / (38 * 90) * 0.2);
        entry.consistencyScore = Math.round((appearanceRatio + minutesRatio) * 100) / 100;

        const prevRate = prev.xGIPer90 || 0;
        const currRate = curr.xGIPer90 || 0;
        entry.improvementRatio = currRate > 0 && prevRate > 0
          ? Math.round(Math.min(currRate / prevRate, 2) * 100) / 100
          : 1;
        entry.minutesReliability = Math.round(((prevMin / (38 * 90)) + (currMin / (38 * 90))) / 2 * 100) / 100;
      } else if (prevMin > 0) {
        entry.consistencyScore = Math.round((prevMin / (38 * 90)) * 100) / 100;
        entry.improvementRatio = 1;
        entry.minutesReliability = Math.round((prevMin / (38 * 90)) * 100) / 100;
      } else if (currMin > 0) {
        entry.consistencyScore = Math.round((Math.min(currAppear, 38) / 38 * 0.5 + Math.min(currMin, 38 * 90) / (38 * 90) * 0.5) * 100) / 100;
        entry.improvementRatio = 1;
        entry.minutesReliability = Math.round((currMin / (38 * 90)) * 100) / 100;
      } else {
        entry.consistencyScore = 0;
        entry.improvementRatio = 1;
        entry.minutesReliability = 0;
      }

      players.push(entry);
    }

    if (players.length > 0) {
      await sql`INSERT INTO player_historical_stats (season, players, total_players) VALUES (${season}, ${JSON.stringify(players)}, ${players.length}) ON CONFLICT (season) DO UPDATE SET players = ${JSON.stringify(players)}, total_players = ${players.length}`;
    }

    lastHistoricalCollectionSeason = season;
    logger.info({ season, playerCount: players.length, prevSeason }, 'Historical player stats collected to DB');
  } catch (err) {
    logger.error({ err, season }, 'Failed to collect historical player stats');
  }
}

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

module.exports = { collectAndStore, checkAndCollect, computeAdvancedFromInsights, collectHistoricalStats };
