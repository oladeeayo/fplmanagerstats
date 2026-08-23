const logger = require('./logger');
const { sql } = require('./db');
const { getSeasonLabel } = require('./fplInsightsData');

const OWN_REPO_BASE = 'https://raw.githubusercontent.com/oladeeayo/fplmanagerstats/main/data/historical';

const SEASONS_TO_FETCH = ['2022-23', '2023-24', '2024-25', '2025-26'];
const FETCH_TIMEOUT = 15000;

let lastHistoricalRun = null;

function parseNum(v) {
  const n = Number.parseFloat(v);
  return Number.isFinite(n) ? n : 0;
}

function parseCSV(text) {
  const lines = text.split('\n').filter(l => l.trim());
  if (lines.length < 2) return [];
  const headers = lines[0].split(',').map(h => h.trim().replace(/^"|"$/g, ''));
  return lines.slice(1).map(line => {
    const vals = [];
    let current = '';
    for (let i = 0; i < line.length; i++) {
      if (line[i] === '"') { i++; while (i < line.length && line[i] !== '"') { current += line[i]; i++; } continue; }
      if (line[i] === ',') { vals.push(current.trim()); current = ''; continue; }
      current += line[i];
    }
    vals.push(current.trim());
    const row = {};
    headers.forEach((h, idx) => { row[h] = vals[idx] || ''; });
    return row;
  });
}

async function fetchCSV(season, filename) {
  const fs = require('fs');
  const path = require('path');
  const localPath = path.join(__dirname, '..', '..', 'data', 'historical', season, filename);
  try {
    if (fs.existsSync(localPath)) {
      const text = fs.readFileSync(localPath, 'utf8');
      return parseCSV(text);
    }
  } catch { /* fall through to remote */ }

  const url = `${OWN_REPO_BASE}/${season}/${filename}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT);
  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'FPLManagerStats/1.0' }, signal: controller.signal });
    if (!res.ok) throw new Error(`${res.status}`);
    const text = await res.text();
    return parseCSV(text);
  } finally {
    clearTimeout(timeout);
  }
}

function buildPlayerSeasonProfile(gwRows) {
  let appearances = 0;
  let minutes = 0;
  let goals = 0;
  let assists = 0;
  let xG = 0;
  let xA = 0;
  let xGI = 0;
  let bonus = 0;
  let bps = 0;
  let totalPoints = 0;
  let cleanSheets = 0;
  let yellowCards = 0;
  let redCards = 0;
  let saves = 0;
  let ownGoals = 0;
  let penaltiesMissed = 0;
  let penaltiesSaved = 0;

  let homeMinutes = 0;
  let awayMinutes = 0;
  let homePoints = 0;
  let awayPoints = 0;
  let homeXGI = 0;
  let awayXGI = 0;
  let homeBonus = 0;
  let awayBonus = 0;
  let homeAppearances = 0;
  let awayAppearances = 0;

  let hauls = 0;
  let doubleHauls = 0;
  let bonusGames = 0;
  let bonus3Games = 0;
  let bonus2Games = 0;
  let cleanSheetGames = 0;
  let returnGames = 0;
  let blankGames = 0;

  const gwPoints = [];

  for (const gw of gwRows) {
    const mins = parseNum(gw.minutes);
    const pts = parseNum(gw.total_points);
    const g = parseNum(gw.goals_scored);
    const a = parseNum(gw.assists);
    const eg = parseNum(gw.expected_goals);
    const ea = parseNum(gw.expected_assists);
    const egI = parseNum(gw.expected_goal_involvements);
    const bon = parseNum(gw.bonus);
    const b = parseNum(gw.bps);
    const cs = parseNum(gw.clean_sheets);
    const yc = parseNum(gw.yellow_cards);
    const rc = parseNum(gw.red_cards);
    const sv = parseNum(gw.saves);
    const og = parseNum(gw.own_goals);
    const pm = parseNum(gw.penalties_missed);
    const ps = parseNum(gw.penalties_saved);
    const isHome = gw.was_home === 'True' || gw.was_home === true;

    if (mins > 0) appearances++;

    minutes += mins;
    goals += g;
    assists += a;
    xG += eg;
    xA += ea;
    xGI += egI;
    bonus += bon;
    bps += b;
    totalPoints += pts;
    cleanSheets += cs;
    yellowCards += yc;
    redCards += rc;
    saves += sv;
    ownGoals += og;
    penaltiesMissed += pm;
    penaltiesSaved += ps;
    gwPoints.push(pts);

    if (isHome) {
      homeMinutes += mins;
      homePoints += pts;
      homeXGI += egI;
      homeBonus += bon;
      if (mins > 0) homeAppearances++;
    } else {
      awayMinutes += mins;
      awayPoints += pts;
      awayXGI += egI;
      awayBonus += bon;
      if (mins > 0) awayAppearances++;
    }

    if (pts >= 10) hauls++;
    if (pts >= 20) doubleHauls++;
    if (bon > 0) bonusGames++;
    if (bon === 3) bonus3Games++;
    if (bon === 2) bonus2Games++;
    if (cs > 0) cleanSheetGames++;
    if (pts > 0) returnGames++;
    if (mins > 0 && pts === 0) blankGames++;
  }

  const per90 = (val) => minutes > 0 ? (val * 90 / minutes) : 0;

  return {
    appearances,
    minutes,
    goals,
    assists,
    expectedGoals: xG,
    expectedAssists: xA,
    expectedGoalInvolvements: xGI,
    bonus,
    bps,
    totalPoints,
    cleanSheets,
    yellowCards,
    redCards,
    saves,
    ownGoals,
    penaltiesMissed,
    penaltiesSaved,

    goalsPer90: round(per90(goals)),
    assistsPer90: round(per90(assists)),
    xGPer90: round(per90(xG)),
    xAPer90: round(per90(xA)),
    xGIPer90: round(per90(xGI)),
    bonusPer90: round(per90(bonus)),
    bpsPer90: round(per90(bps)),
    pointsPer90: round(per90(totalPoints)),
    savesPer90: round(per90(saves)),
    cleanSheetsPer90: round(per90(cleanSheets)),

    home: {
      minutes: homeMinutes,
      points: homePoints,
      xGI: homeXGI,
      bonus: homeBonus,
      appearances: homeAppearances,
      pointsPer90: homeMinutes > 0 ? round(homePoints * 90 / homeMinutes) : 0,
      xGIPer90: homeMinutes > 0 ? round(homeXGI * 90 / homeMinutes) : 0,
    },
    away: {
      minutes: awayMinutes,
      points: awayPoints,
      xGI: awayXGI,
      bonus: awayBonus,
      appearances: awayAppearances,
      pointsPer90: awayMinutes > 0 ? round(awayPoints * 90 / awayMinutes) : 0,
      xGIPer90: awayMinutes > 0 ? round(awayXGI * 90 / awayMinutes) : 0,
    },

    hauls,
    doubleHauls,
    bonusGames,
    bonus3Games,
    bonus2Games,
    cleanSheetGames,
    returnGames,
    blankGames,
    haulRate: appearances > 0 ? round(hauls / appearances, 3) : 0,
    returnRate: appearances > 0 ? round(returnGames / appearances, 3) : 0,
    blankRate: appearances > 0 ? round(blankGames / appearances, 3) : 0,
    consistencyRate: appearances > 0 ? round((appearances / 38) * (minutes / (appearances * 90)), 3) : 0,

    gwPoints,
    maxGwPoints: gwPoints.length > 0 ? Math.max(...gwPoints) : 0,
    medianGwPoints: gwPoints.length > 0 ? median(gwPoints) : 0,
    stdDevGwPoints: gwPoints.length > 1 ? stdDev(gwPoints) : 0,
  };
}

function buildOpponentProfile(gwRows) {
  const oppMap = new Map();
  for (const gw of gwRows) {
    const opp = gw.opponent_team;
    if (!opp) continue;
    const key = `${opp}_${gw.was_home === 'True' || gw.was_home === true ? 'H' : 'A'}`;
    if (!oppMap.has(key)) {
      oppMap.set(key, {
        opponentTeamId: Number(opp),
        wasHome: gw.was_home === 'True' || gw.was_home === true,
        appearances: 0,
        minutes: 0,
        points: 0,
        goals: 0,
        assists: 0,
        xGI: 0,
        bonus: 0,
        hauls: 0,
      });
    }
    const entry = oppMap.get(key);
    const mins = parseNum(gw.minutes);
    entry.appearances++;
    entry.minutes += mins;
    entry.points += parseNum(gw.total_points);
    entry.goals += parseNum(gw.goals_scored);
    entry.assists += parseNum(gw.assists);
    entry.xGI += parseNum(gw.expected_goal_involvements);
    entry.bonus += parseNum(gw.bonus);
    if (parseNum(gw.total_points) >= 10) entry.hauls++;
  }

  return [...oppMap.values()].map(e => ({
    ...e,
    pointsPer90: e.minutes > 0 ? round(e.points * 90 / e.minutes) : 0,
    xGIPer90: e.minutes > 0 ? round(e.xGI * 90 / e.minutes) : 0,
    haulRate: e.appearances > 0 ? round(e.hauls / e.appearances, 3) : 0,
  }));
}

function buildFixtureProfile(gwRows) {
  const fixtures = [];
  for (const gw of gwRows) {
    const mins = parseNum(gw.minutes);
    if (mins === 0) continue;
    fixtures.push({
      gw: parseNum(gw.round) || parseNum(gw.GW),
      opponent: parseNum(gw.opponent_team),
      wasHome: gw.was_home === 'True' || gw.was_home === true,
      minutes: mins,
      points: parseNum(gw.total_points),
      goals: parseNum(gw.goals_scored),
      assists: parseNum(gw.assists),
      xG: parseNum(gw.expected_goals),
      xA: parseNum(gw.expected_assists),
      xGI: parseNum(gw.expected_goal_involvements),
      bonus: parseNum(gw.bonus),
      bps: parseNum(gw.bps),
    });
  }
  return fixtures;
}

function round(val, decimals = 2) {
  const factor = Math.pow(10, decimals);
  return Math.round(val * factor) / factor;
}

function median(arr) {
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function stdDev(arr) {
  const mean = arr.reduce((a, b) => a + b, 0) / arr.length;
  const sqDiffs = arr.map(v => Math.pow(v - mean, 2));
  const avgSqDiff = sqDiffs.reduce((a, b) => a + b, 0) / arr.length;
  return round(Math.sqrt(avgSqDiff));
}

function computeCrossSeasonMetrics(seasonProfiles) {
  const seasons = Object.keys(seasonProfiles).sort();
  const latest = seasonProfiles[seasons[seasons.length - 1]];
  const prev = seasons.length >= 2 ? seasonProfiles[seasons[seasons.length - 2]] : null;

  let totalMinutes = 0;
  let totalPoints = 0;
  let totalAppearances = 0;
  let totalXGI = 0;
  let totalBonus = 0;
  let totalHauls = 0;
  let totalGames = 0;
  const allGwPoints = [];

  for (const s of seasons) {
    const p = seasonProfiles[s];
    totalMinutes += p.minutes;
    totalPoints += p.totalPoints;
    totalAppearances += p.appearances;
    totalXGI += p.expectedGoalInvolvements;
    totalBonus += p.bonus;
    totalHauls += p.hauls;
    totalGames += p.appearances;
    allGwPoints.push(...p.gwPoints);
  }

  const fullSeasons = seasons.filter(s => seasonProfiles[s].minutes > 1500).length;

  const consistencyScore = fullSeasons >= 2
    ? Math.min(1, (totalAppearances / (seasons.length * 38)) * 0.4 + (Math.min(totalMinutes, seasons.length * 3000) / (seasons.length * 3000)) * 0.4 + (fullSeasons / seasons.length) * 0.2)
    : fullSeasons >= 1
      ? Math.min(1, (totalAppearances / 38) * 0.5 + (Math.min(totalMinutes, 3000) / 3000) * 0.5)
      : 0;

  const minutesReliability = totalAppearances > 0 ? Math.min(1, totalMinutes / (totalAppearances * 90)) : 0;
  const seasonAppearances = seasons.map(s => seasonProfiles[s].appearances);
  const appearanceConsistency = seasonAppearances.length > 1
    ? 1 - (Math.max(...seasonAppearances) - Math.min(...seasonAppearances)) / Math.max(...seasonAppearances, 1)
    : 1;

  let xGITrend = 0;
  const xGIValues = seasons.map(s => seasonProfiles[s].xGIPer90).filter(v => v > 0);
  if (xGIValues.length >= 2) {
    const recent = xGIValues[xGIValues.length - 1];
    const earlier = xGIValues.slice(0, -1).reduce((a, b) => a + b, 0) / (xGIValues.length - 1);
    xGITrend = earlier > 0 ? (recent - earlier) / earlier : 0;
  }

  const prevHomeAdvantage = prev
    ? (prev.home.pointsPer90 - prev.away.pointsPer90)
    : (latest.home.pointsPer90 - latest.away.pointsPer90);

  return {
    totalMinutes,
    totalPoints,
    totalAppearances,
    totalXGI,
    totalBonus,
    totalHauls,
    totalGames,
    fullSeasons,
    seasonsTracked: seasons.length,

    avgAppearancesPerSeason: round(totalAppearances / seasons.length),
    avgMinutesPerSeason: round(totalMinutes / seasons.length),
    avgPointsPerSeason: round(totalPoints / seasons.length),
    avgXGIPerSeason: round(totalXGI / seasons.length),
    avgBonusPerSeason: round(totalBonus / seasons.length),
    avgHaulsPerSeason: round(totalHauls / seasons.length),

    pointsPer90Career: totalMinutes > 0 ? round(totalPoints * 90 / totalMinutes) : 0,
    xGIPer90Career: totalMinutes > 0 ? round(totalXGI * 90 / totalMinutes) : 0,
    bonusPer90Career: totalMinutes > 0 ? round(totalBonus * 90 / totalMinutes) : 0,
    haulRateCareer: totalAppearances > 0 ? round(totalHauls / totalAppearances, 3) : 0,

    consistencyScore: round(consistencyScore, 3),
    minutesReliability: round(minutesReliability, 3),
    appearanceConsistency: round(appearanceConsistency, 3),
    xGITrend: round(xGITrend, 3),

    peakSeason: seasons.reduce((best, s) => {
      const pts = seasonProfiles[s].totalPoints;
      return pts > (best.points || 0) ? { season: s, points: pts } : best;
    }, {}),
    peakXGISeason: seasons.reduce((best, s) => {
      const xgi = seasonProfiles[s].expectedGoalInvolvements;
      return xgi > (best.xGI || 0) ? { season: s, xGI: xgi } : best;
    }, {}),

    homeAdvantage: round(prevHomeAdvantage, 2),
    recentForm: latest,
    previousSeason: prev,

    allGwPoints: allGwPoints.slice(-100),
    overallMedianGwPoints: median(allGwPoints),
    overallMaxGwPoints: allGwPoints.length > 0 ? Math.max(...allGwPoints) : 0,
  };
}

let cachedHistoricalMap = null;

async function collectAllHistoricalStats() {
  const season = getSeasonLabel();
  const now = Date.now();

  if (cachedHistoricalMap && lastHistoricalRun && (now - lastHistoricalRun) < 6 * 60 * 60 * 1000) {
    return cachedHistoricalMap;
  }

  if (sql) {
    try {
      const existing = await sql`SELECT total_players FROM player_historical_stats WHERE season = ${season} LIMIT 1`;
      if (existing.length > 0 && existing[0].total_players > 100) {
        lastHistoricalRun = now;
        logger.info({ season, playerCount: existing[0].total_players }, 'Historical data already in DB, skipping collection');
      }
    } catch { /* continue with collection */ }
  }

  try {
    const seasonProfiles = {};
    const allPlayerGwData = new Map();
    const playerMeta = new Map();

    let bootstrap = null;
    try {
      const cache = require('./cache');
      if (typeof cache?.getCachedApiData === 'function') {
        bootstrap = await cache.getCachedApiData(
          cache.BOOTSTRAP_URL || 'https://fantasy.premierleague.com/api/bootstrap-static/',
          cache.BOOTSTRAP_CACHE_TTL || 30 * 60 * 1000,
        );
      }
    } catch { /* continue without IDs */ }

    const bsByName = new Map();
    const bsById = new Map();
    if (bootstrap?.elements) {
      for (const el of bootstrap.elements) {
        const fullName = `${el.first_name || ''} ${el.second_name || ''}`.trim().toLowerCase();
        const webName = (el.web_name || '').toLowerCase();
        bsByName.set(fullName, el);
        bsByName.set(webName, el);
        bsById.set(el.id, el);
      }
    }

    for (const s of SEASONS_TO_FETCH) {
      logger.info({ season: s }, 'Fetching historical FPL data from own repo');

      let gwRows = [];
      try {
        gwRows = await fetchCSV(s, 'merged_gw.csv');
      } catch (e) {
        logger.warn({ season: s, err: e.message }, 'Failed to fetch merged_gw.csv');
        continue;
      }

      if (gwRows.length === 0) {
        logger.warn({ season: s }, 'No GW data for season');
        continue;
      }

      const playerMap = new Map();
      for (const row of gwRows) {
        const name = row.name;
        if (!name) continue;
        if (!playerMap.has(name)) playerMap.set(name, []);
        playerMap.get(name).push(row);

        if (!playerMeta.has(name)) {
          playerMeta.set(name, {
            name,
            position: row.position,
            team: row.team,
            element: parseNum(row.element),
          });
        }
      }

      for (const [name, rows] of playerMap) {
        const profile = buildPlayerSeasonProfile(rows);
        const opponents = buildOpponentProfile(rows);
        const fixtures = buildFixtureProfile(rows);

        if (!allPlayerGwData.has(name)) allPlayerGwData.set(name, {});
        allPlayerGwData.get(name)[s] = {
          profile,
          opponents,
          fixtures,
        };
      }
    }

    const results = [];
    for (const [name, seasonsData] of allPlayerGwData) {
      const meta = playerMeta.get(name) || {};
      const crossSeason = computeCrossSeasonMetrics(
        Object.fromEntries(Object.entries(seasonsData).map(([s, d]) => [s, d.profile]))
      );

      const bsEntry = bsByName.get(name.toLowerCase()) || null;
      const fplId = bsEntry?.id || meta.element || null;
      const webName = bsEntry?.web_name || name.split(' ').pop() || name;

      results.push({
        id: fplId,
        element: meta.element || fplId,
        name,
        webName,
        webNameLower: webName.toLowerCase(),
        position: meta.position || 'MID',
        team: meta.team || 'Unknown',
        seasons: Object.fromEntries(Object.entries(seasonsData).map(([s, d]) => [s, d.profile])),
        opponents: Object.fromEntries(Object.entries(seasonsData).map(([s, d]) => [s, d.opponents])),
        topFixtures: Object.fromEntries(Object.entries(seasonsData).map(([s, d]) => [s, d.fixtures.slice(0, 5)])),
        crossSeason,
      });
    }

    results.sort((a, b) => (b.crossSeason.totalPoints || 0) - (a.crossSeason.totalPoints || 0));

    if (results.length > 0 && sql) {
      const batch_size = 500;
      for (let i = 0; i < results.length; i += batch_size) {
        const batch = results.slice(i, i + batch_size);
        await sql`INSERT INTO player_historical_stats (season, players, total_players) VALUES (${season}, ${JSON.stringify(batch)}, ${batch.length}) ON CONFLICT (season) DO UPDATE SET players = ${JSON.stringify(batch)}, total_players = ${batch.length}`;
      }
    }

    const resultMap = new Map();
    for (const entry of results) {
      if (entry.id) resultMap.set(Number(entry.id), entry);
      if (entry.element) resultMap.set(Number(entry.element), entry);
      if (entry.webNameLower) resultMap.set(entry.webNameLower, entry);
      if (entry.name) resultMap.set(entry.name.toLowerCase(), entry);
    }

    cachedHistoricalMap = resultMap;
    lastHistoricalRun = Date.now();
    logger.info({ season, playerCount: results.length, seasons: SEASONS_TO_FETCH }, 'Historical player profiles collected');
    return resultMap;
  } catch (err) {
    logger.error({ err }, 'Failed to collect historical player profiles');
    return cachedHistoricalMap || new Map();
  }
}

module.exports = { collectAllHistoricalStats };
