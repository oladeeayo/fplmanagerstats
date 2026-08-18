// src/server/understat.js
// Understat data fetcher — scrapes xG, xA, xGC from Understat's embedded JSON
const https = require('https');
const logger = require('./logger');

const UNDERSTAT_BASE = 'https://understat.com';

function fetchPage(path) {
  return new Promise((resolve, reject) => {
    const url = `${UNDERSTAT_BASE}${path}`;
    https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
      res.on('error', reject);
    }).on('error', reject);
  });
}

function extractJSON(html, varName) {
  const regex = new RegExp(`var\\s+${varName}\\s*=\\s*JSON\\.parse\\('(.+?)'\\)`);
  const match = html.match(regex);
  if (!match) return null;
  try {
    const decoded = match[1].replace(/\\x([0-9A-Fa-f]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
    return JSON.parse(decoded);
  } catch { return null; }
}

// Fetch all teams' season-level stats from Understat
async function fetchTeams() {
  try {
    const html = await fetchPage('/league/EPL');
    const teams = extractJSON(html, 'teamsData');
    if (!teams) return null;

    const result = {};
    for (const [id, team] of Object.entries(teams)) {
      const history = team.history || [];
      // Aggregate last 10 matches for team defensive/offensive profile
      const last10 = history.slice(-10);
      const last5 = history.slice(-5);
      const all = history;

      const aggregate = (matches, label) => {
        if (!matches.length) return null;
        const gf = matches.reduce((s, m) => s + (m.scored || 0), 0) / matches.length;
        const ga = matches.reduce((s, m) => s + (m.missed || 0), 0) / matches.length;
        const xg = matches.reduce((s, m) => s + (m.xG || 0), 0) / matches.length;
        const xga = matches.reduce((s, m) => s + (m.xGA || 0), 0) / matches.length;
        const ppda = matches.reduce((s, m) => s + (m.ppda?.att || 0), 0) / Math.max(matches.reduce((s, m) => s + (m.ppda?.def || 1), 0), 1);
        const deep = matches.reduce((s, m) => s + (m.deep || 0), 0) / matches.length;
        const wins = matches.filter(m => {
          const [h, a] = (m.result || '').split('');
          return (m.isHome && h === 'w') || (!m.isHome && a === 'w');
        }).length;
        const cleanSheets = matches.filter(m => {
          const conceded = m.isHome ? (m.missed || 0) : (m.scored || 0);
          // Actually: home team missed = away team scored, need to check both
          const teamConceded = m.isHome ? (m.missed || 0) : (m.scored || 0);
          return teamConceded === 0;
        }).length;
        return { matches: matches.length, gf, ga, xg, xga, ppda, deep, wins, cleanSheets, csRate: cleanSheets / matches.length };
      };

      result[team.title] = {
        id: team.id,
        name: team.title,
        last5: aggregate(last5, 'last5'),
        last10: aggregate(last10, 'last10'),
        season: aggregate(all, 'season'),
      };
    }
    return result;
  } catch (err) {
    logger.warn({ err }, 'Understat teams fetch failed');
    return null;
  }
}

// Fetch player-level stats from Understat
async function fetchPlayers() {
  try {
    const html = await fetchPage('/league/EPL');
    const players = extractJSON(html, 'playersData');
    if (!players) return null;

    const result = {};
    for (const player of players) {
      const name = player.player_name || player.player;
      result[name] = {
        id: player.id,
        name,
        team: player.team_title,
        position: player.position,
        // Season totals
        xG: player.xG || 0,
        xA: player.xA || 0,
        xGI: (player.xG || 0) + (player.xA || 0),
        goals: player.goals || 0,
        assists: player.assists || 0,
        keyPasses: player.key_passes || 0,
        shots: player.shots || 0,
        npg: player.npg || 0, // non-penalty goals
        npxG: player.npxG || 0, // non-penalty xG
        // Per 90 if minutes available
        minutes: player.time || 0,
        xG90: player.time ? (player.xG || 0) / (player.time / 90) : 0,
        xA90: player.time ? (player.xA || 0) / (player.time / 90) : 0,
        xGI90: player.time ? ((player.xG || 0) + (player.xA || 0)) / (player.time / 90) : 0,
      };
    }
    return result;
  } catch (err) {
    logger.warn({ err }, 'Understat players fetch failed');
    return null;
  }
}

// Fetch match-level data for a specific team
async function fetchTeamMatches(teamName) {
  try {
    const html = await fetchPage(`/team/${teamName.replace(/\s+/g, '_')}/`);
    const matches = extractJSON(html, 'datesData');
    if (!matches) return null;
    return matches.map(m => ({
      id: m.id,
      isHome: m.isHome,
      result: m.result,
      scored: m.scored,
      missed: m.missed,
      xG: m.xG,
      xGA: m.xGA,
      deep: m.deep,
      ppda: m.ppda,
      date: m.date,
      opponent: m.h_a === 'h' ? m.aTitle : m.hTitle,
    }));
  } catch (err) {
    logger.warn({ err: err.message }, `Understat match fetch failed for ${teamName}`);
    return null;
  }
}

// Build opponent defensive profile from team stats
function buildOpponentProfiles(teamStats) {
  if (!teamStats) return {};
  const profiles = {};
  for (const [teamName, stats] of Object.entries(teamStats)) {
    const s10 = stats.last10 || stats.season || {};
    profiles[teamName] = {
      // Defensive metrics (lower = easier to score against)
      xGA90: s10.xga || 1.3, // expected goals against per 90
      goalsConceded90: s10.ga || 1.3,
      csRate: s10.csRate || 0.25,
      // Offensive threat (higher = harder to keep clean sheet)
      xG90: s10.xg || 1.3,
      goalsScored90: s10.gf || 1.3,
      ppda: s10.ppda || 10, // pressing intensity
      deep90: s10.deep || 8,
      // Overall strength (for FDR override)
      winRate: s10.matches ? (s10.wins || 0) / s10.matches : 0.33,
    };
  }
  return profiles;
}

module.exports = {
  fetchTeams,
  fetchPlayers,
  fetchTeamMatches,
  buildOpponentProfiles,
};
