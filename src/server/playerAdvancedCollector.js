const logger = require('./logger');
const { sql } = require('./db');
const { getCachedApiData, BOOTSTRAP_URL, BOOTSTRAP_CACHE_TTL, getGlobalPlayerHistory } = require('./cache');

let isCollecting = false;
let lastCollectedGW = null;

async function collectAndStore(gwId) {
  if (isCollecting) {
    logger.info({ gwId }, 'Player advanced stats collection already in progress, skipping');
    return;
  }

  isCollecting = true;
  const startTime = Date.now();
  logger.info({ gwId }, 'Starting player advanced stats collection');

  try {
    const bootstrap = await getCachedApiData(BOOTSTRAP_URL, BOOTSTRAP_CACHE_TTL);
    if (!bootstrap || !bootstrap.elements) {
      logger.error('Failed to fetch bootstrap for advanced stats collection');
      return;
    }

    const teamMap = {};
    (bootstrap.teams || []).forEach(t => {
      teamMap[t.id] = { name: t.name, short: t.short_name, code: t.code };
    });

    const posNames = { 1: 'GKP', 2: 'DEF', 3: 'MID', 4: 'FWD' };

    const activePlayers = bootstrap.elements.filter(p => (p.total_points || 0) > 0 || (p.minutes || 0) > 0);

    const BATCH_SIZE = 50;
    const historyResults = new Map();
    for (let i = 0; i < activePlayers.length; i += BATCH_SIZE) {
      const batch = activePlayers.slice(i, i + BATCH_SIZE);
      await Promise.allSettled(batch.map(async p => {
        try {
          const ph = await getGlobalPlayerHistory(p.id);
          if (ph && Array.isArray(ph.history)) {
            historyResults.set(p.id, ph.history);
          }
        } catch (err) {
          // ignore
        }
      }));
    }

    const playersData = activePlayers.map(p => {
      const history = historyResults.get(p.id) || [];
      const teamInfo = teamMap[p.team] || { name: 'Unknown', short: 'UNK', code: 0 };

      let defconGames = 0;
      let haulGames = 0;
      let bonus3Games = 0;
      let bonus2Games = 0;
      let bonus1Games = 0;
      let totalBonus = 0;

      const defconMatches = [];
      const haulMatches = [];
      const bonusMatches = [];

      history.forEach(h => {
        if (!h.minutes || h.minutes === 0) return;

        const oppTeam = teamMap[h.opponent_team] || { short: 'UNK' };
        const oppShort = oppTeam.short;
        const vsStr = h.was_home ? `vs ${oppShort} (H)` : `@ ${oppShort} (A)`;
        const scoreStr = h.team_h_score != null && h.team_a_score != null
          ? `${h.team_h_score} - ${h.team_a_score}`
          : '-';

        const defVal = h.defensive_contribution || 0;
        const cbi = h.clearances_blocks_interceptions || 0;
        const tackles = h.tackles || 0;
        const totalDefActions = cbi + tackles + (h.recoveries || 0);
        const isDefcon = defVal > 0 || totalDefActions >= 8 || (h.clean_sheets > 0 && [1, 2].includes(p.element_type));

        if (isDefcon) {
          defconGames += 1;
          defconMatches.push({
            gw: h.round, opponent: oppShort, vs: vsStr, wasHome: h.was_home,
            score: scoreStr, minutes: h.minutes, defconVal: defVal || totalDefActions,
            cleanSheets: h.clean_sheets, points: h.total_points
          });
        }

        if (h.total_points >= 10) {
          haulGames += 1;
          haulMatches.push({
            gw: h.round, opponent: oppShort, vs: vsStr, wasHome: h.was_home,
            score: scoreStr, minutes: h.minutes, goals: h.goals_scored,
            assists: h.assists, bonus: h.bonus, bps: h.bps, points: h.total_points
          });
        }

        if (h.bonus > 0) {
          if (h.bonus === 3) bonus3Games += 1;
          else if (h.bonus === 2) bonus2Games += 1;
          else if (h.bonus === 1) bonus1Games += 1;
          totalBonus += h.bonus;

          bonusMatches.push({
            gw: h.round, opponent: oppShort, vs: vsStr, wasHome: h.was_home,
            score: scoreStr, minutes: h.minutes, bonus: h.bonus, bps: h.bps,
            points: h.total_points
          });
        }
      });

      return {
        id: p.id, code: p.code, name: p.web_name,
        fullName: `${p.first_name} ${p.second_name}`,
        team: teamInfo.short, teamName: teamInfo.name, teamCode: teamInfo.code,
        position: posNames[p.element_type] || 'MID', elementType: p.element_type,
        cost: (p.now_cost || 0) / 10, priceStr: `\u00a3${((p.now_cost || 0) / 10).toFixed(1)}m`,
        totalPoints: p.total_points || 0, minutes: p.minutes || 0,
        defconGames, defconMatches, haulGames, haulMatches,
        bonus3Games, bonus2Games, bonus1Games,
        totalBonus: totalBonus || (p.bonus || 0), bonusMatches
      };
    });

    if (sql) {
      await sql`INSERT INTO player_advanced_stats (gameweek, players, total_players) VALUES (${gwId}, ${JSON.stringify(playersData)}, ${playersData.length}) ON CONFLICT (gameweek) DO UPDATE SET players = ${JSON.stringify(playersData)}, total_players = ${playersData.length}`;
    }

    lastCollectedGW = gwId;
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    logger.info({ gwId, playerCount: playersData.length, elapsed }, 'Player advanced stats collection complete');
  } catch (err) {
    logger.error({ err, gwId }, 'Player advanced stats collection failed');
  } finally {
    isCollecting = false;
  }
}

async function checkAndCollect() {
  try {
    const bootstrap = await getCachedApiData(BOOTSTRAP_URL, BOOTSTRAP_CACHE_TTL);
    if (!bootstrap || !bootstrap.events) return;

    const finishedGW = bootstrap.events.filter(e => e.finished).sort((a, b) => b.id - a.id)[0];
    if (!finishedGW) return;

    const gwId = finishedGW.id;
    if (lastCollectedGW === gwId) return;

    if (sql) {
      const existing = await sql`SELECT id FROM player_advanced_stats WHERE gameweek = ${gwId} LIMIT 1`;
      if (existing.length > 0) {
        lastCollectedGW = gwId;
        return;
      }
    }

    logger.info({ gwId }, 'GW finished but no advanced stats in DB, triggering collection');
    await collectAndStore(gwId);
  } catch (err) {
    logger.warn({ err }, 'Error checking for advanced stats collection');
  }
}

module.exports = { collectAndStore, checkAndCollect };
