const logger = require('./logger');
const { sql } = require('./db');
const { getCachedApiData, BOOTSTRAP_URL, FIXTURES_URL, BOOTSTRAP_CACHE_TTL } = require('./cache');

const activeCollections = new Set();
const FPL_LIVE_URL = 'https://fantasy.premierleague.com/api/event/{gw}/live/';

async function fetchLiveGW(gwId) {
  // A zero TTL must bypass any Redis value left from an earlier partial GW.
  const url = `${FPL_LIVE_URL.replace('{gw}', gwId)}?refresh=${Date.now()}`;
  return getCachedApiData(url, 0);
}

function buildPlayerAdvancedData(bootstrap, fixtures, gwId, liveData) {
  const teamMap = {};
  (bootstrap.teams || []).forEach(t => {
    teamMap[t.id] = { name: t.name, short: t.short_name, code: t.code };
  });

  const gwFixtures = Array.isArray(fixtures) ? fixtures.filter(f => f.event === gwId) : [];
  const playerMap = new Map();
  bootstrap.elements.forEach(p => playerMap.set(p.id, p));
  const posNames = { 1: 'GKP', 2: 'DEF', 3: 'MID', 4: 'FWD' };
  const liveByPlayerId = new Map();
  (liveData.elements || []).forEach(le => liveByPlayerId.set(le.id, le));

  const playersData = [];

  for (const [playerId, liveStats] of liveByPlayerId) {
    const p = playerMap.get(playerId);
    if (!p) continue;

    const stats = liveStats.stats || {};
    const totalPoints = stats.total_points || 0;
    const bonus = stats.bonus || 0;
    const minutes = stats.minutes || 0;
    const defconScore = stats.defensive_contribution || 0;
    const goalsScored = stats.goals_scored || 0;
    const assists = stats.assists || 0;
    const cleanSheets = stats.clean_sheets || 0;
    const bps = stats.bps || 0;

    if (minutes === 0) continue;

    const teamInfo = teamMap[p.team] || { name: 'Unknown', short: 'UNK', code: 0 };
    const posType = p.element_type;
    const defconThreshold = (posType === 1 || posType === 2) ? 10 : 12;
    const isDefcon = defconScore >= defconThreshold;
    const isHaul = totalPoints >= 10;

    let fixture = null;
    const playerFixtures = (liveStats.explain || []).map(e => e.fixture);
    if (playerFixtures.length > 0) {
      fixture = gwFixtures.find(f => playerFixtures.includes(f.id));
    }

    const oppId = fixture ? (fixture.team_h === p.team ? fixture.team_a : fixture.team_h) : null;
    const oppInfo = oppId ? teamMap[oppId] : null;
    const oppShort = oppInfo ? oppInfo.short : 'TBD';
    const isHome = fixture ? fixture.team_h === p.team : null;
    const vsStr = isHome !== null ? (isHome ? `vs ${oppShort} (H)` : `@ ${oppShort} (A)`) : 'TBD';
    const scoreStr = fixture && fixture.team_h_score != null ? `${fixture.team_h_score} - ${fixture.team_a_score}` : '-';

    const defconMatches = [];
    const haulMatches = [];
    const bonusMatches = [];

    if (isDefcon) {
      defconMatches.push({ gw: gwId, opponent: oppShort, vs: vsStr, wasHome: isHome, score: scoreStr, minutes, defconVal: defconScore, cleanSheets, points: totalPoints });
    }
    if (isHaul) {
      haulMatches.push({ gw: gwId, opponent: oppShort, vs: vsStr, wasHome: isHome, score: scoreStr, minutes, goals: goalsScored, assists, bonus, bps, points: totalPoints });
    }
    if (bonus > 0) {
      bonusMatches.push({ gw: gwId, opponent: oppShort, vs: vsStr, wasHome: isHome, score: scoreStr, minutes, bonus, bps, points: totalPoints });
    }

    playersData.push({
      id: p.id, code: p.code, name: p.web_name,
      fullName: `${p.first_name} ${p.second_name}`,
      team: teamInfo.short, teamName: teamInfo.name, teamCode: teamInfo.code,
      position: posNames[posType] || 'MID', elementType: posType,
      cost: (p.now_cost || 0) / 10,
      totalPoints: p.total_points || 0, minutes: p.minutes || 0,
      gwPoints: totalPoints,
      defconGames: isDefcon ? 1 : 0, defconMatches,
      haulGames: isHaul ? 1 : 0, haulMatches,
      bonus3Games: bonus === 3 ? 1 : 0,
      bonus2Games: bonus === 2 ? 1 : 0,
      bonus1Games: bonus === 1 ? 1 : 0,
      totalBonus: bonus || (p.bonus || 0), bonusMatches
    });
  }

  return playersData;
}

async function collectAndStore(gwId) {
  const collectingKey = `gw_${gwId}`;
  if (activeCollections.has(collectingKey)) return;
  activeCollections.add(collectingKey);
  const startTime = Date.now();

  try {
    const [bootstrap, fixtures, liveData] = await Promise.all([
      getCachedApiData(BOOTSTRAP_URL, BOOTSTRAP_CACHE_TTL),
      getCachedApiData(FIXTURES_URL, BOOTSTRAP_CACHE_TTL),
      fetchLiveGW(gwId)
    ]);

    if (!bootstrap || !bootstrap.elements || !liveData || !liveData.elements || liveData.elements.length === 0) {
      logger.warn({ gwId }, 'No live data available for this GW yet');
      return;
    }

    const playersData = buildPlayerAdvancedData(bootstrap, fixtures, gwId, liveData);

    if (sql && playersData.length > 0) {
      await sql`INSERT INTO player_advanced_stats (gameweek, players, total_players) VALUES (${gwId}, ${JSON.stringify(playersData)}, ${playersData.length}) ON CONFLICT (gameweek) DO UPDATE SET players = ${JSON.stringify(playersData)}, total_players = ${playersData.length}`;
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    logger.info({ gwId, playerCount: playersData.length, elapsed }, 'Player advanced stats collection complete');
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
      logger.info({ gwId: gw.id }, 'GW missing from DB, triggering collection');
      await collectAndStore(gw.id);
    }
  } catch (err) {
    logger.warn({ err }, 'Error checking for advanced stats collection');
  }
}

async function computeAdvancedFromLive(bootstrap, fixtures, gwId) {
  const liveData = await fetchLiveGW(gwId);
  if (!liveData || !liveData.elements || liveData.elements.length === 0) return null;
  return buildPlayerAdvancedData(bootstrap, fixtures, gwId, liveData);
}

module.exports = { collectAndStore, checkAndCollect, computeAdvancedFromLive, fetchLiveGW };
