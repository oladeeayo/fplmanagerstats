// src/server/boxTouches.js
// Fetches "Touches in the Opposition Box" per player from the Premier League
// SDP (Opta) leaderboard — the same source behind premierleague.com stats pages —
// and joins it onto FPL bootstrap players by normalized full name + team.
const axios = require('axios');
const logger = require('./logger');

const SDP_BASE = 'https://sdp-prem-prod.premier-league-prod.pulselive.com/api';
const TOUCHES_STAT = 'totalTouchesInOppositionBox';
const SEASON_ID = '2026'; // SDP season ids are start-year based (2026 = 2026/27)
const PAGE_SIZE = 100;
const MAX_PAGES = 25; // ~1000 players covers every player with a box touch

// Team short-name aliases between SDP (Opta) and FPL bootstrap
const TEAM_ALIASES = {
  'Man Utd': 'Man Utd',
  'Man City': 'Man City',
  'Nott\'m Forest': 'Nott\'m Forest',
  'Nottm Forest': 'Nott\'m Forest',
  'Newcastle': 'Newcastle',
  'Spurs': 'Spurs',
  'Tottenham': 'Spurs',
  'West Ham': 'West Ham',
  'Crystal Palace': 'Palace',
  'Sheffield United': 'Sheffield Utd',
};

function stripDiacritics(str) {
  return String(str || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

function normalizeName(str) {
  return stripDiacritics(str).toLowerCase().replace(/[^a-z0-9]/g, '');
}

function normalizeTeam(str) {
  const s = stripDiacritics(String(str || '').trim());
  return TEAM_ALIASES[s] || s;
}

async function fetchAllPlayersWithTouches() {
  const base = `${SDP_BASE}/v3/competitions/8/seasons/${SEASON_ID}/players/stats/leaderboard`;
  let url = `${base}?comps=1&altIds=true&_limit=${PAGE_SIZE}`;
  const players = [];
  for (let page = 0; page < MAX_PAGES && url; page++) {
    const { data } = await axios.get(url, {
      timeout: 20000,
      headers: { Origin: 'https://www.premierleague.com', 'User-Agent': 'Mozilla/5.0' },
    });
    const rows = Array.isArray(data?.data) ? data.data : [];
    players.push(...rows);
    const next = data?.pagination?._next;
    url = next ? `${base}?comps=1&altIds=true&_limit=${PAGE_SIZE}&_next=${encodeURIComponent(next)}` : null;
    if (!rows.length) break;
  }
  return players
    .filter(p => p?.playerMetadata && Number.isFinite(p?.stats?.[TOUCHES_STAT]))
    .map(p => ({
      sdpId: p.playerMetadata.id,
      name: p.playerMetadata.name || `${p.playerMetadata.firstName || ''} ${p.playerMetadata.lastName || ''}`.trim(),
      firstName: p.playerMetadata.firstName || '',
      lastName: p.playerMetadata.lastName || '',
      teamShort: normalizeTeam(p.playerMetadata.currentTeam?.shortName),
      touches: p.stats[TOUCHES_STAT],
      appearances: p.stats.appearances,
      minutes: p.stats.timePlayed,
      goals: p.stats.goals,
      assists: p.stats.goalAssists,
      shots: p.stats.totalShots,
    }));
}

// Match an SDP row to an FPL element by normalized full name, then web name,
// then last name (with team tie-breaker where names are ambiguous).
function buildMatcher(elements, fplTeamsById) {
  const byFullName = new Map();
  const byWebName = new Map();
  for (const el of elements) {
    const team = fplTeamsById.get(el.team);
    const entry = { element: el, teamShort: team?.short_name || '' };
    for (const key of [
      normalizeName(`${el.first_name} ${el.second_name}`),
      normalizeName(el.second_name),
    ]) {
      if (key) {
        if (!byFullName.has(key)) byFullName.set(key, []);
        byFullName.get(key).push(entry);
      }
    }
    const webKey = normalizeName(el.web_name);
    if (webKey) {
      if (!byWebName.has(webKey)) byWebName.set(webKey, []);
      byWebName.get(webKey).push(entry);
    }
  }
  return sdpRow => {
    const fullKey = normalizeName(sdpRow.name);
    const lastKey = normalizeName(sdpRow.lastName);
    for (const [map, key] of [[byFullName, fullKey], [byWebName, fullKey], [byFullName, lastKey], [byWebName, lastKey]]) {
      if (!key) continue;
      const candidates = map.get(key);
      if (!candidates?.length) continue;
      const sameTeam = candidates.find(c => c.teamShort === sdpRow.teamShort);
      return (sameTeam || candidates[0]).element;
    }
    return null;
  };
}

async function buildBoxTouchesData(getCachedApiData, bootstrap) {
  const sdpPlayers = await fetchAllPlayersWithTouches();
  const fplTeamsById = new Map((bootstrap.teams || []).map(t => [t.id, t]));
  const matchElement = buildMatcher(bootstrap.elements || [], fplTeamsById);

  const players = [];
  let matchedCount = 0;
  for (const row of sdpPlayers) {
    const el = matchElement(row);
    if (!el) {
      logger.warn({ player: row.name }, 'Box touches: no FPL match for player');
      continue;
    }
    matchedCount++;
    const team = fplTeamsById.get(el.team);
    const posMap = { 1: 'GKP', 2: 'DEF', 3: 'MID', 4: 'FWD' };
    players.push({
      id: el.id,
      code: el.code,
      name: el.web_name,
      fullName: `${el.first_name} ${el.second_name}`,
      team: team?.short_name || '?',
      teamId: el.team,
      position: posMap[el.element_type] || '?',
      touches: row.touches,
      appearances: row.appearances,
      minutes: row.minutes,
      xGI: parseFloat(el.expected_goal_involvements || 0),
      xG: parseFloat(el.expected_goals || 0),
      xA: parseFloat(el.expected_assists || 0),
      gi: (el.goals_scored || 0) + (el.assists || 0),
      goals: el.goals_scored || 0,
      assists: el.assists || 0,
      totalPoints: el.total_points || 0,
      minutesFpl: el.minutes || 0,
      cost: (el.now_cost || 0) / 10,
      form: parseFloat(el.form || 0),
      touchesPer90: el.minutes > 0 ? Math.round((row.touches / (el.minutes / 90)) * 100) / 100 : 0,
    });
  }

  players.sort((a, b) => b.touches - a.touches);
  const currentEvent = (bootstrap.events || []).find(e => e.is_current);
  const nextEvent = (bootstrap.events || []).find(e => e.is_next);

  return {
    stat: TOUCHES_STAT,
    source: 'premierleague.com (Opta SDP leaderboard)',
    matchedCount,
    players,
    currentGW: currentEvent?.id || nextEvent?.id || 1,
    timestamp: Date.now(),
  };
}

module.exports = {
  buildBoxTouchesData,
  normalizeName,
  normalizeTeam,
};
