const logger = require('./logger');

const REPO_BASE = 'https://raw.githubusercontent.com/olbauday/FPL-Core-Insights/main/data';
const FPL_BASE = 'https://fantasy.premierleague.com/api';

let cachedData = null;
let cachedSeason = null;
let lastFetch = 0;
const CACHE_TTL = 4 * 60 * 60 * 1000;

let historicalCache = null;
let historicalSeason = null;
let lastHistoricalFetch = 0;
const HISTORICAL_CACHE_TTL = 12 * 60 * 60 * 1000;

let fplFixturesCache = null;
let fplFixturesCacheTime = 0;
const FPL_FIXTURES_CACHE_TTL = 5 * 60 * 1000;

let fplBootstrapCache = null;
let fplBootstrapCacheTime = 0;
const FPL_BOOTSTRAP_CACHE_TTL = 5 * 60 * 1000;

function parseCSV(text) {
  const lines = text.split('\n').filter(l => l.trim());
  if (lines.length < 2) return [];
  const headers = lines[0].split(',').map(h => h.trim().replace(/^"|"$/g, ''));
  return lines.slice(1).map(line => {
    const vals = [];
    let current = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') { inQuotes = !inQuotes; continue; }
      if (ch === ',' && !inQuotes) { vals.push(current.trim()); current = ''; continue; }
      current += ch;
    }
    vals.push(current.trim());
    const row = {};
    headers.forEach((h, i) => { row[h] = vals[i] || ''; });
    return row;
  });
}

function parseNum(v) {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : 0;
}

function getSeasonLabel() {
  const now = new Date();
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  if (month >= 7) return `${year}-${year + 1}`;
  return `${year - 1}-${year}`;
}

async function fetchCSV(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'FPLManagerStats/1.0', Accept: 'text/csv' }
  });
  if (!res.ok) throw new Error(`Failed to fetch ${url}: ${res.status}`);
  return res.text();
}

async function fetchGameweekStats(season, gw) {
  const url = `${REPO_BASE}/${season}/By%20Gameweek/GW${gw}/player_gameweek_stats.csv`;
  const text = await fetchCSV(url);
  return parseCSV(text);
}

async function fetchSeasonPlayers(season) {
  const url = `${REPO_BASE}/${season}/players.csv`;
  const text = await fetchCSV(url);
  return parseCSV(text);
}

async function fetchSeasonTeams(season) {
  const url = `${REPO_BASE}/${season}/teams.csv`;
  const text = await fetchCSV(url);
  return parseCSV(text);
}

async function fetchPlayerStats(season) {
  const url = `${REPO_BASE}/${season}/playerstats.csv`;
  const text = await fetchCSV(url);
  return parseCSV(text);
}

async function fetchPlayerMatchStats(season, gw) {
  const url = `${REPO_BASE}/${season}/By%20Gameweek/GW${gw}/playermatchstats.csv`;
  const text = await fetchCSV(url);
  return parseCSV(text);
}

function parseMatchId(matchId) {
  if (!matchId) return null;
  const parts = matchId.split('-vs-');
  if (parts.length !== 2) return null;
  const left = parts[0];
  const right = parts[1];
  const dashIdx = left.lastIndexOf('-');
  if (dashIdx < 0) return null;
  const homeName = left.substring(dashIdx + 1).replace(/-/g, ' ');
  const awayName = right.replace(/-/g, ' ');
  return { homeName, awayName };
}

function slugToTeamName(slug) {
  return slug.replace(/-/g, ' ');
}

async function getSeasonData(forceRefresh = false) {
  const season = getSeasonLabel();
  const now = Date.now();

  if (!forceRefresh && cachedData && cachedSeason === season && (now - lastFetch) < CACHE_TTL) {
    return cachedData;
  }

  logger.info({ season }, 'Fetching FPL-Core-Insights season data');

  try {
    const [players, teams, playerStats] = await Promise.all([
      fetchSeasonPlayers(season),
      fetchSeasonTeams(season),
      fetchPlayerStats(season)
    ]);

    const playerMap = new Map();
    players.forEach(p => {
      playerMap.set(Number(p.player_id), {
        id: Number(p.player_id),
        code: Number(p.player_code),
        firstName: p.first_name,
        secondName: p.second_name,
        webName: p.web_name,
        teamCode: Number(p.team_code),
        position: p.position
      });
    });

    const teamMap = new Map();
    teams.forEach(t => {
      teamMap.set(Number(t.id), {
        id: Number(t.id),
        code: Number(t.code),
        name: t.name,
        shortName: t.short_name,
        elo: Number(t.elo) || 0
      });
    });

    const seasonStats = new Map();
    playerStats.forEach(ps => {
      const pid = Number(ps.id);
      if (!pid) return;
      seasonStats.set(pid, {
        totalPoints: parseNum(ps.total_points),
        bonus: parseNum(ps.bonus),
        bps: parseNum(ps.bps),
        minutes: parseNum(ps.minutes),
        goalsScored: parseNum(ps.goals_scored),
        assists: parseNum(ps.assists),
        cleanSheets: parseNum(ps.clean_sheets),
        defensiveContribution: parseNum(ps.defensive_contribution),
        expectedGoals: parseNum(ps.expected_goals),
        expectedAssists: parseNum(ps.expected_assists),
        expectedGoalInvolvements: parseNum(ps.expected_goal_involvements),
        epNext: parseNum(ps.ep_next),
        epThis: parseNum(ps.ep_this),
        form: parseNum(ps.form),
        nowCost: parseNum(ps.now_cost),
        selectedByPercent: parseNum(ps.selected_by_percent),
        transfersIn: parseNum(ps.transfers_in),
        transfersOut: parseNum(ps.transfers_out)
      });
    });

    cachedData = { playerMap, teamMap, seasonStats, players, teams, playerStats };
    cachedSeason = season;
    lastFetch = now;

    logger.info({ season, playerCount: playerMap.size, teamCount: teamMap.size }, 'FPL-Core-Insights season data loaded');
    return cachedData;
  } catch (err) {
    logger.error({ err, season }, 'Failed to fetch FPL-Core-Insights season data');
    if (cachedData) return cachedData;
    throw err;
  }
}

async function getGameweekPlayerStats(gwId) {
  const season = getSeasonLabel();
  const rows = await fetchGameweekStats(season, gwId);
  return rows.map(r => ({
    playerId: Number(r.id || r.player_id),
    gameweek: parseNum(r.gw || gwId),
    minutes: parseNum(r.minutes),
    goalsScored: parseNum(r.goals_scored),
    assists: parseNum(r.assists),
    cleanSheets: parseNum(r.clean_sheets),
    goalsConceded: parseNum(r.goals_conceded),
    ownGoals: parseNum(r.own_goals),
    penaltiesSaved: parseNum(r.penalties_saved),
    penaltiesMissed: parseNum(r.penalties_missed),
    yellowCards: parseNum(r.yellow_cards),
    redCards: parseNum(r.red_cards),
    saves: parseNum(r.saves),
    bonus: parseNum(r.bonus),
    bps: parseNum(r.bps),
    influence: parseNum(r.influence),
    creativity: parseNum(r.creativity),
    threat: parseNum(r.threat),
    ictIndex: parseNum(r.ict_index),
    expectedGoals: parseNum(r.expected_goals),
    expectedAssists: parseNum(r.expected_assists),
    expectedGoalInvolvements: parseNum(r.expected_goal_involvements),
    expectedGoalsConceded: parseNum(r.expected_goals_conceded),
    defensiveContribution: parseNum(r.defensive_contribution),
    totalPoints: parseNum(r.total_points),
    starts: parseNum(r.starts),
    nowCost: parseNum(r.now_cost),
    selectedByPercent: parseNum(r.selected_by_percent),
    form: parseNum(r.form),
    epNext: parseNum(r.ep_next),
    epThis: parseNum(r.ep_this),
    transfersInEvent: parseNum(r.transfers_in_event),
    transfersOutEvent: parseNum(r.transfers_out_event)
  }));
}

async function getFPLFixtures() {
  const now = Date.now();
  if (fplFixturesCache && (now - fplFixturesCacheTime) < FPL_FIXTURES_CACHE_TTL) return fplFixturesCache;
  const url = `${FPL_BASE}/fixtures/`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'FPLManagerStats/1.0' }, signal: controller.signal });
    if (!res.ok) throw new Error(`Failed to fetch FPL fixtures: ${res.status}`);
    const data = await res.json();
    fplFixturesCache = data;
    fplFixturesCacheTime = now;
    return data;
  } finally {
    clearTimeout(timeout);
  }
}

async function getFPLBootstrap() {
  const now = Date.now();
  if (fplBootstrapCache && (now - fplBootstrapCacheTime) < FPL_BOOTSTRAP_CACHE_TTL) return fplBootstrapCache;
  const url = `${FPL_BASE}/bootstrap-static/`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'FPLManagerStats/1.0' }, signal: controller.signal });
    if (!res.ok) throw new Error(`Failed to fetch FPL bootstrap: ${res.status}`);
    const data = await res.json();
    fplBootstrapCache = data;
    fplBootstrapCacheTime = now;
    return data;
  } finally {
    clearTimeout(timeout);
  }
}

async function getGameweekPlayerStatsWithOpponents(gwId) {
  const season = getSeasonLabel();
  const [rows, fplFixtures, fplBootstrap] = await Promise.all([
    fetchGameweekStats(season, gwId),
    getFPLFixtures().catch(() => []),
    getFPLBootstrap().catch(() => ({ elements: [], teams: [] }))
  ]);

  const teamMap = new Map();
  (fplBootstrap.teams || []).forEach(t => {
    teamMap.set(t.id, { id: t.id, name: t.name, short: t.short_name, code: t.code });
  });

  const playerTeamMap = new Map();
  (fplBootstrap.elements || []).forEach(p => {
    playerTeamMap.set(p.id, { teamId: p.team, webName: p.web_name });
  });

  const gwFixtures = (fplFixtures || []).filter(f => f.event === gwId);
  const fixturesByTeam = new Map();
  for (const fix of gwFixtures) {
    if (!fixturesByTeam.has(fix.team_h)) fixturesByTeam.set(fix.team_h, []);
    if (!fixturesByTeam.has(fix.team_a)) fixturesByTeam.set(fix.team_a, []);
    fixturesByTeam.get(fix.team_h).push({
      opponentId: fix.team_a,
      isHome: true,
      teamHDiff: fix.team_h_difficulty,
      teamADiff: fix.team_a_difficulty,
      teamHGwScore: fix.team_h_score,
      teamAGwScore: fix.team_a_score,
      finished: fix.finished
    });
    fixturesByTeam.get(fix.team_a).push({
      opponentId: fix.team_h,
      isHome: false,
      teamHDiff: fix.team_h_difficulty,
      teamADiff: fix.team_a_difficulty,
      teamHGwScore: fix.team_h_score,
      teamAGwScore: fix.team_a_score,
      finished: fix.finished
    });
  }

  const rowsByPlayer = new Map();
  rows.forEach(r => {
    const pid = Number(r.id || r.player_id);
    if (!pid) return;
    if (!rowsByPlayer.has(pid)) rowsByPlayer.set(pid, []);
    rowsByPlayer.get(pid).push(r);
  });

  const results = [];
  for (const [pid, playerRows] of rowsByPlayer) {
    const totalMinutes = playerRows.reduce((s, r) => s + parseNum(r.minutes), 0);
    if (totalMinutes === 0) continue;

    const playerInfo = playerTeamMap.get(pid);
    const playerTeamId = playerInfo?.teamId;
    if (!playerTeamId) continue;

    const teamFixtures = fixturesByTeam.get(playerTeamId) || [];
    const fixture = teamFixtures[0] || null;

    const stat = playerRows[0];
    const oppTeam = fixture ? teamMap.get(fixture.opponentId) : null;
    const oppShort = oppTeam?.short || 'TBD';
    const wasHome = fixture?.isHome ?? null;

    let teamGoalsConceded = 0;
    let cleanSheet = false;
    if (fixture && fixture.finished) {
      if (wasHome) {
        teamGoalsConceded = fixture.teamAGwScore ?? 0;
      } else {
        teamGoalsConceded = fixture.teamHGwScore ?? 0;
      }
      cleanSheet = teamGoalsConceded === 0;
    }

    results.push({
      playerId: pid,
      gameweek: gwId,
      minutes: totalMinutes,
      goalsScored: playerRows.reduce((s, r) => s + parseNum(r.goals_scored), 0),
      assists: playerRows.reduce((s, r) => s + parseNum(r.assists), 0),
      cleanSheets: playerRows.reduce((s, r) => s + parseNum(r.clean_sheets), 0),
      goalsConceded: playerRows.reduce((s, r) => s + parseNum(r.goals_conceded), 0),
      ownGoals: playerRows.reduce((s, r) => s + parseNum(r.own_goals), 0),
      penaltiesSaved: playerRows.reduce((s, r) => s + parseNum(r.penalties_saved), 0),
      penaltiesMissed: playerRows.reduce((s, r) => s + parseNum(r.penalties_missed), 0),
      yellowCards: playerRows.reduce((s, r) => s + parseNum(r.yellow_cards), 0),
      redCards: playerRows.reduce((s, r) => s + parseNum(r.red_cards), 0),
      saves: playerRows.reduce((s, r) => s + parseNum(r.saves), 0),
      bonus: playerRows.reduce((s, r) => s + parseNum(r.bonus), 0),
      bps: playerRows.reduce((s, r) => s + parseNum(r.bps), 0),
      influence: parseNum(stat.influence),
      creativity: parseNum(stat.creativity),
      threat: parseNum(stat.threat),
      ictIndex: parseNum(stat.ict_index),
      expectedGoals: playerRows.reduce((s, r) => s + parseNum(r.expected_goals), 0),
      expectedAssists: playerRows.reduce((s, r) => s + parseNum(r.expected_assists), 0),
      expectedGoalInvolvements: playerRows.reduce((s, r) => s + parseNum(r.expected_goal_involvements), 0),
      expectedGoalsConceded: parseNum(stat.expected_goals_conceded),
      defensiveContribution: playerRows.reduce((s, r) => s + parseNum(r.defensive_contribution), 0),
      totalPoints: playerRows.reduce((s, r) => s + parseNum(r.total_points), 0),
      starts: playerRows.reduce((s, r) => s + parseNum(r.starts), 0),
      nowCost: parseNum(stat.now_cost),
      selectedByPercent: parseNum(stat.selected_by_percent),
      form: parseNum(stat.form),
      epNext: parseNum(stat.ep_next),
      epThis: parseNum(stat.ep_this),
      transfersInEvent: parseNum(stat.transfers_in_event),
      transfersOutEvent: parseNum(stat.transfers_out_event),
      opponent: fixture ? {
        homeTeamId: wasHome ? playerTeamId : fixture.opponentId,
        awayTeamId: wasHome ? fixture.opponentId : playerTeamId,
        homeTeamName: teamMap.get(wasHome ? playerTeamId : fixture.opponentId)?.name || 'Unknown',
        awayTeamName: teamMap.get(wasHome ? fixture.opponentId : playerTeamId)?.name || 'Unknown',
        homeShort: teamMap.get(wasHome ? playerTeamId : fixture.opponentId)?.short || 'TBD',
        awayShort: teamMap.get(wasHome ? fixture.opponentId : playerTeamId)?.short || 'TBD',
        teamGoalsConceded,
        cleanSheet
      } : null
    });
  }

  return results;
}

async function getAllFinishedGWStats(finishedGWIds) {
  const results = new Map();
  const BATCH = 5;
  for (let i = 0; i < finishedGWIds.length; i += BATCH) {
    const batch = finishedGWIds.slice(i, i + BATCH);
    const batchResults = await Promise.allSettled(batch.map(gw => getGameweekPlayerStats(gw)));
    batchResults.forEach((result, idx) => {
      if (result.status === 'fulfilled') {
        results.set(batch[idx], result.value);
      } else {
        logger.warn({ gw: batch[idx], err: result.reason?.message }, 'Failed to fetch GW stats from FPL-Core-Insights');
      }
    });
  }
  return results;
}

async function getHistoricalPlayerStats(forceRefresh = false) {
  const currentSeason = getSeasonLabel();
  const now = Date.now();

  if (!forceRefresh && historicalCache && historicalSeason === currentSeason && (now - lastHistoricalFetch) < HISTORICAL_CACHE_TTL) {
    return historicalCache;
  }

  const parts = currentSeason.split('-');
  const prevYear = Number(parts[0]) - 1;
  const prevSeason = `${prevYear}-${prevYear + 1}`;

  logger.info({ currentSeason, prevSeason }, 'Fetching historical player stats from FPL-Core-Insights');

  try {
    const [currentStats, prevStats] = await Promise.all([
      fetchPlayerStats(currentSeason).catch(() => []),
      fetchPlayerStats(prevSeason).catch(() => [])
    ]);

    const historicalMap = new Map();

    for (const ps of prevStats) {
      const pid = Number(ps.id);
      if (!pid) continue;
      historicalMap.set(pid, {
        prevSeason: {
          appearances: parseNum(ps.appearances) || parseNum(ps.games) || 0,
          minutes: parseNum(ps.minutes),
          goals: parseNum(ps.goals_scored),
          assists: parseNum(ps.assists),
          cleanSheets: parseNum(ps.clean_sheets),
          bonus: parseNum(ps.bonus),
          bps: parseNum(ps.bps),
          totalPoints: parseNum(ps.total_points),
          expectedGoals: parseNum(ps.expected_goals),
          expectedAssists: parseNum(ps.expected_assists),
          xGI: parseNum(ps.expected_goal_involvements),
          form: parseNum(ps.form),
          defensiveContribution: parseNum(ps.defensive_contribution),
          goalsPer90: parseNum(ps.minutes) > 0 ? (parseNum(ps.goals_scored) * 90 / parseNum(ps.minutes)) : 0,
          assistsPer90: parseNum(ps.minutes) > 0 ? (parseNum(ps.assists) * 90 / parseNum(ps.minutes)) : 0,
          xGIPer90: parseNum(ps.minutes) > 0 ? (parseNum(ps.expected_goal_involvements) * 90 / parseNum(ps.minutes)) : 0,
          bonusPer90: parseNum(ps.minutes) > 0 ? (parseNum(ps.bonus) * 90 / parseNum(ps.minutes)) : 0,
        }
      });
    }

    for (const ps of currentStats) {
      const pid = Number(ps.id);
      if (!pid) continue;
      const existing = historicalMap.get(pid) || {};
      existing.currentSeason = {
        appearances: parseNum(ps.appearances) || parseNum(ps.games) || 0,
        minutes: parseNum(ps.minutes),
        goals: parseNum(ps.goals_scored),
        assists: parseNum(ps.assists),
        cleanSheets: parseNum(ps.clean_sheets),
        bonus: parseNum(ps.bonus),
        bps: parseNum(ps.bps),
        totalPoints: parseNum(ps.total_points),
        expectedGoals: parseNum(ps.expected_goals),
        expectedAssists: parseNum(ps.expected_assists),
        xGI: parseNum(ps.expected_goal_involvements),
        form: parseNum(ps.form),
        defensiveContribution: parseNum(ps.defensive_contribution),
        goalsPer90: parseNum(ps.minutes) > 0 ? (parseNum(ps.goals_scored) * 90 / parseNum(ps.minutes)) : 0,
        assistsPer90: parseNum(ps.minutes) > 0 ? (parseNum(ps.assists) * 90 / parseNum(ps.minutes)) : 0,
        xGIPer90: parseNum(ps.minutes) > 0 ? (parseNum(ps.expected_goal_involvements) * 90 / parseNum(ps.minutes)) : 0,
        bonusPer90: parseNum(ps.minutes) > 0 ? (parseNum(ps.bonus) * 90 / parseNum(ps.minutes)) : 0,
      };
      historicalMap.set(pid, existing);
    }

    for (const [pid, data] of historicalMap) {
      const prev = data.prevSeason;
      const curr = data.currentSeason;
      if (prev && curr && prev.minutes > 0 && curr.minutes > 0) {
        const consistencyScore = (
          (Math.min(prev.appearances, 38) / 38) * 0.3 +
          (Math.min(curr.appearances, 38) / 38) * 0.3 +
          (prev.minutes > 1500 ? 0.2 : prev.minutes / 1500 * 0.2) +
          (curr.minutes > 1500 ? 0.2 : curr.minutes / 1500 * 0.2)
        );
        const improvementRatio = curr.xGIPer90 > 0 && prev.xGIPer90 > 0
          ? Math.min(curr.xGIPer90 / prev.xGIPer90, 2)
          : 1;
        data.consistencyScore = Math.round(consistencyScore * 100) / 100;
        data.improvementRatio = Math.round(improvementRatio * 100) / 100;
        data.minutesReliability = Math.round(((prev.minutes / (38 * 90)) + (curr.minutes / (38 * 90))) / 2 * 100) / 100;
      } else if (prev && prev.minutes > 0) {
        data.consistencyScore = Math.round((prev.minutes / (38 * 90)) * 100) / 100;
        data.improvementRatio = 1;
        data.minutesReliability = Math.round((prev.minutes / (38 * 90)) * 100) / 100;
      } else {
        data.consistencyScore = 0;
        data.improvementRatio = 1;
        data.minutesReliability = 0;
      }
    }

    historicalCache = historicalMap;
    historicalSeason = currentSeason;
    lastHistoricalFetch = now;

    logger.info({ prevSeason, playerCount: historicalMap.size }, 'Historical player stats loaded');
    return historicalMap;
  } catch (err) {
    logger.error({ err, prevSeason }, 'Failed to fetch historical player stats');
    if (historicalCache) return historicalCache;
    return new Map();
  }
}

module.exports = {
  getSeasonData,
  getGameweekPlayerStats,
  getGameweekPlayerStatsWithOpponents,
  getAllFinishedGWStats,
  getHistoricalPlayerStats,
  parseNum,
  getSeasonLabel
};
