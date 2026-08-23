const logger = require('./logger');

const REPO_BASE = 'https://raw.githubusercontent.com/olbauday/FPL-Core-Insights/main/data';

let cachedData = null;
let cachedSeason = null;
let lastFetch = 0;
const CACHE_TTL = 4 * 60 * 60 * 1000;

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

module.exports = {
  getSeasonData,
  getGameweekPlayerStats,
  getAllFinishedGWStats,
  parseNum,
  getSeasonLabel
};
