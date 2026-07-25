const express = require('express');
const path = require('path');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  next();
});

app.use(express.static(path.join(__dirname, '../public')));
app.use(express.json());

const POSITION_MAP = ["GKP", "DEF", "MID", "FWD"];
const { DETAILED_POSITIONS, ZONE_MAP, ZONE_LABELS, ZONE_GROUP, POSITION_LABELS, ATTACKING_ZONES, DEFENSIVE_ZONES, MIDFIELD_ZONES, ALL_ZONES } = require('./playerPositions');

const apiGet = url => axios.get(url, { timeout: 15000 });

app.get('/api/health', (req, res) => res.json({ status: 'healthy' }));

app.get('/api/bootstrap-static', async (req, res) => {
  try { res.json((await apiGet('https://fantasy.premierleague.com/api/bootstrap-static/')).data); }
  catch (e) { res.status(500).json({ error: 'Failed to fetch bootstrap static data' }); }
});

app.get('/api/fixtures', async (req, res) => {
  try { res.json((await apiGet('https://fantasy.premierleague.com/api/fixtures/')).data); }
  catch (e) { res.status(500).json({ error: 'Failed to fetch fixtures' }); }
});

// ---- Core analysis ----
async function analyzeManager(managerId, playerData, leagueId = 314) {
  const [managerEntryResponse, historyResponse, leagueResponse] = await Promise.all([
    apiGet(`https://fantasy.premierleague.com/api/entry/${managerId}/`),
    apiGet(`https://fantasy.premierleague.com/api/entry/${managerId}/history/`),
    apiGet(`https://fantasy.premierleague.com/api/leagues-classic/${leagueId}/standings/`)
  ]);

  const managerEntryData = managerEntryResponse.data;
  const historyData = historyResponse.data;
  const leagueData = leagueResponse.data;
  const currentGameweek = playerData.events.find(event => event.is_current).id;
  const topManagerPoints = leagueData.standings.results[0].total;

  let totalCaptaincyPoints = 0, totalPointsActive = 0, totalPointsLostOnBench = 0, totalCaptaincyAttempts = 0;
  const playerStats = {}, positionPoints = { GKP: {}, DEF: {}, MID: {}, FWD: {} };
  const weeklyPoints = new Array(currentGameweek).fill(0);
  const weeklyRanks = new Array(currentGameweek).fill(0);
  const weeklyPointsLostBench = new Array(currentGameweek).fill(0);
  const captainChoices = [], chipImpact = [];

  let highestPoints = 0, highestPointsGW = 0, lowestPoints = Infinity, lowestPointsGW = 0;
  let highestRank = Infinity, highestRankGW = 0, lowestRank = 0, lowestRankGW = 0;

  const currentTeam = [];
  const currentPicksResponse = await apiGet(`https://fantasy.premierleague.com/api/entry/${managerId}/event/${currentGameweek}/picks/`);
  const currentPicks = currentPicksResponse.data.picks;

  const playerHistoryCache = {};
  const getPlayerHistory = async pid => {
    if (!playerHistoryCache[pid]) playerHistoryCache[pid] = (await apiGet(`https://fantasy.premierleague.com/api/element-summary/${pid}/`)).data;
    return playerHistoryCache[pid];
  };

  for (const pick of currentPicks) {
    const player = playerData.elements.find(p => p.id === pick.element);
    if (!player) continue;
    const ph = await getPlayerHistory(player.id);
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

  for (let gw = 1; gw <= currentGameweek; gw++) {
    const pr = await apiGet(`https://fantasy.premierleague.com/api/entry/${managerId}/event/${gw}/picks/`);
    const picksData = pr.data, picks = picksData.picks;
    const isBenchBoost = picksData.active_chip === "bboost", isTripleCaptain = picksData.active_chip === "3xc";
    let gwPoints = 0, gwBenchPoints = 0, captainPick = null, bestPick = null;

    for (const pick of picks) {
      const playerId = pick.element, player = playerData.elements.find(p => p.id == playerId);
      if (!player) continue;
      const ph = await getPlayerHistory(playerId);
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
          nextFixtures: (await getPlayerHistory(playerId)).fixtures?.slice(0, 5).map(f => {
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

  const seasonHistory = (historyData.past || []).map((s, i) => ({
    season: s.season_name || `${2020+i}/${2021+i}`, rank: s.rank, points: s.total_points
  }));

  const chips = historyData.chips || [];

  return {
    managerInfo: {
      name: `${managerEntryData.player_first_name} ${managerEntryData.player_last_name}`,
      teamName: managerEntryData.name,
      overallRanking: managerEntryData.summary_overall_rank?.toLocaleString() || "N/A",
      overallRankRaw: managerEntryData.summary_overall_rank || 0,
      managerPoints: managerEntryData.summary_overall_points,
      chipsUsed: chips.map(c => c.name), chipsCount: chips.length,
      lastSeasonRank: historyData.past.length > 0 ? historyData.past[historyData.past.length - 1].rank.toLocaleString() : "Didn't Play",
      lastSeasonRankRaw: historyData.past.length > 0 ? historyData.past[historyData.past.length - 1].rank : null,
      seasonBeforeLastRank: historyData.past.length > 1 ? historyData.past[historyData.past.length - 2].rank.toLocaleString() : "Didn't Play",
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

app.get('/api/analyze-manager/:managerId', async (req, res) => {
  try {
    const bs = (await apiGet('https://fantasy.premierleague.com/api/bootstrap-static/')).data;
    const result = await analyzeManager(req.params.managerId, bs, 314);
    managerCache[req.params.managerId] = result;
    res.json(result);
  } catch (e) { console.error('Error:', e.message); res.status(500).json({ error: 'Failed to analyze manager' }); }
});

app.get('/api/compare-managers/:id1/:id2', async (req, res) => {
  try {
    const bs = (await apiGet('https://fantasy.premierleague.com/api/bootstrap-static/')).data;
    const [m1, m2] = await Promise.all([analyzeManager(req.params.id1, bs, 314), analyzeManager(req.params.id2, bs, 314)]);
    res.json({ manager1: m1, manager2: m2 });
  } catch (e) { res.status(500).json({ error: 'Failed to compare' }); }
});

app.get('/api/price-changes', async (req, res) => {
  try {
    const r = (await apiGet('https://fantasy.premierleague.com/api/bootstrap-static/')).data;
    const map = p => ({ name: p.web_name, team: (r.teams.find(t=>t.id===p.team)||{}).name, photoId: p.code, change: p.cost_change_event, newCost: p.now_cost, selectedBy: p.selected_by_percent, form: p.form, totalPoints: p.total_points });
    const risers = r.elements.filter(p => p.cost_change_event > 0).sort((a,b) => b.cost_change_event-a.cost_change_event).slice(0,15).map(map);
    const fallers = r.elements.filter(p => p.cost_change_event < 0).sort((a,b) => a.cost_change_event-b.cost_change_event).slice(0,15).map(map);
    res.json({ risers, fallers });
  } catch (e) { res.status(500).json({ error: 'Failed' }); }
});

app.get('/api/league-standings/:leagueId', async (req, res) => {
  try {
    const leagueId = req.params.leagueId || 314;
    const [bs, p1] = await Promise.all([
      apiGet('https://fantasy.premierleague.com/api/bootstrap-static/'),
      apiGet(`https://fantasy.premierleague.com/api/leagues-classic/${leagueId}/standings/?page_standings=1&phase=1`)
    ]);
    const playerData = bs.data;
    let standings = p1.data.standings.results || [];
    // Fetch page 2 for top 50
    try {
      const p2 = await apiGet(`https://fantasy.premierleague.com/api/leagues-classic/${leagueId}/standings/?page_standings=2&phase=1`);
      standings = standings.concat(p2.data.standings.results || []);
    } catch(e) { /* page 2 may not exist */ }
    standings = standings.slice(0, 50);
    const currentGW = playerData.events.find(e => e.is_current)?.id || 1;

    const enriched = [];
    const entries = standings;

    const batchSize = 3;
    for (let i = 0; i < entries.length; i += batchSize) {
      const batch = entries.slice(i, i + batchSize);
      const results = await Promise.allSettled(batch.map(async e => {
        const [histRes, entryRes] = await Promise.all([
          apiGet(`https://fantasy.premierleague.com/api/entry/${e.entry}/history/`).catch(() => null),
          apiGet(`https://fantasy.premierleague.com/api/entry/${e.entry}/`).catch(() => null)
        ]);
        return { history: histRes?.data, entry: entryRes?.data };
      }));
      results.forEach((res, idx) => {
        const entry = batch[idx];
        const hist = res.value?.history;
        const entryData = res.value?.entry;
        const past = hist?.past || [];
        const chips = hist?.chips || [];
        const currentGW = hist?.current?.length || 0;

        // Map season names to find specific past seasons
        const getSeasonRank = (season) => {
          const s = past.find(p => p.season_name === season);
          return s ? s.rank : null;
        };
        const lastSeasonRank = getSeasonRank('2024/25');
        const seasonBeforeLastRank = getSeasonRank('2023/24');

        // Chips filtered from GW20+
        const chipLabels = chips
          .filter(c => c.event >= 20)
          .map(c => {
            const label = ({ wildcard:'WC', freehit:'FH', bench_boost:'BB', '3xc':'TC', triple_captain:'TC', bboost:'BB' }[c.name.toLowerCase()]||c.name);
            return `${label} GW${c.event}`;
          });

        // Overall rank from entry API
        const overallRank = entryData?.summary_overall_rank || entry.overall_rank;

        // GW points from entry current data
        const gwPoints = hist?.current?.length > 0 ? hist.current[hist.current.length - 1].points : entry.event_total;

        enriched.push({
          rank: entry.rank, entry: entry.entry,
          playerName: entry.player_name, teamName: entry.entry_name,
          totalPoints: entry.total, overallRank: overallRank?.toLocaleString() || '—',
          lastRank: entry.last_rank, rankChange: (entry.last_rank || entry.rank) - entry.rank,
          gwPoints: gwPoints?.toLocaleString() || '—',
          lastSeasonRank: lastSeasonRank?.toLocaleString() || '—',
          seasonBeforeLastRank: seasonBeforeLastRank?.toLocaleString() || '—',
          chipsUsed: chipLabels.length ? chipLabels.join(', ') : 'None',
          immediateGain: '—',
          totalImmediateGain: '—'
        });
      });
    }

    res.json({
      leagueName: p1.data.league?.name || 'Classic League',
      currentGW,
      standings: enriched
    });
  } catch (e) {
    console.error('League error:', e.message);
    res.status(500).json({ error: 'Failed to fetch league standings' });
  }
});

// ---- Zone Analysis (Per-GW Match Breakdowns) ----
app.get('/api/zone-analysis', async (req, res) => {
  try {
    const bs = (await apiGet('https://fantasy.premierleague.com/api/bootstrap-static/')).data;
    const fixtures = (await apiGet('https://fantasy.premierleague.com/api/fixtures/')).data;

    const teams = bs.teams;
    const elements = bs.elements;
    const currentGW = bs.events.find(e => e.is_current)?.id || 1;
    const selectedGW = parseInt(req.query.gw) || currentGW;

    // Helper: get team by id
    const getTeam = id => teams.find(t => t.id === id) || { short_name: '?', name: 'Unknown' };

    // Assign detailed positions to players + infer zones
    const playersWithZones = elements.map(p => {
      const detailedPos = DETAILED_POSITIONS[p.web_name] || DETAILED_POSITIONS[p.second_name] || null;
      const broadPos = POSITION_MAP[p.element_type - 1];
      const zone = detailedPos ? (ZONE_MAP[detailedPos] || null) : null;
      return {
        id: p.id, name: p.web_name, secondName: p.second_name, team: p.team,
        teamName: getTeam(p.team).short_name, broadPosition: broadPos,
        detailedPosition: detailedPos, zone,
        goals: p.goals_scored || 0, assists: p.assists || 0,
        expectedGoals: parseFloat(p.expected_goals) || 0,
        expectedAssists: parseFloat(p.expected_assists) || 0,
        expectedGoalInvolvements: parseFloat(p.expected_goal_involvements) || 0,
        expectedGoalsConceded: parseFloat(p.expected_goals_conceded) || 0,
        threat: parseFloat(p.threat) || 0, creativity: parseFloat(p.creativity) || 0,
        influence: parseFloat(p.influence) || 0, ictIndex: parseFloat(p.ict_index) || 0,
        form: parseFloat(p.form) || 0, minutes: p.minutes || 0,
        cleanSheets: p.clean_sheets || 0, goalsConceded: p.goals_conceded || 0,
        saves: p.saves || 0, bonus: p.bonus || 0, bps: p.bps || 0,
        yellowCards: p.yellow_cards || 0, redCards: p.red_cards || 0,
        nowCost: p.now_cost || 0, selectedByPercent: parseFloat(p.selected_by_percent) || 0,
        totalPoints: p.total_points || 0, code: p.code,
        pointsPerGame: parseFloat(p.points_per_game) || 0
      };
    });

    // Assign zones for ALL players using position-based mapping
    const teamGroups = {};
    playersWithZones.forEach(p => {
      if (!teamGroups[p.team]) teamGroups[p.team] = { DEF: [], MID: [], FWD: [], GKP: [] };
      if (!p.zone) {
        if (p.broadPosition === 'DEF') teamGroups[p.team].DEF.push(p);
        else if (p.broadPosition === 'FWD') teamGroups[p.team].FWD.push(p);
        else if (p.broadPosition === 'GKP') teamGroups[p.team].GKP.push(p);
        else teamGroups[p.team].MID.push(p);
      }
    });

    Object.entries(teamGroups).forEach(([teamId, group]) => {
      const defCount = group.DEF.length;
      const midCount = group.MID.length;
      const fwdCount = group.FWD.length;

      group.GKP.forEach(p => { if (!p.zone) { p.zone = 'gk'; p.detailedPosition = 'GK'; } });

      // Filter out players that already have zones assigned
      const defWithoutZone = group.DEF.filter(p => !p.zone);
      const midWithoutZone = group.MID.filter(p => !p.zone);
      const fwdWithoutZone = group.FWD.filter(p => !p.zone);

      // 4-2-3-1: DEF = LB, LCB, RCB, RB (assign only players without zones)
      defWithoutZone.forEach((p, i) => {
        if (i === 0) { p.zone = 'lb'; p.detailedPosition = 'LB'; }
        else if (i === 1) { p.zone = 'lcb'; p.detailedPosition = 'LCB'; }
        else if (i === 2) { p.zone = 'rcb'; p.detailedPosition = 'RCB'; }
        else { p.zone = 'rb'; p.detailedPosition = 'RB'; }
      });

      // 4-2-3-1: MID = 2 CDM (ldm, rdm) + 3 AM (lw, cam, rw)
      // Assign only players without zones
      const midSlots = ['ldm', 'rdm', 'lw', 'cam', 'rw'];
      midWithoutZone.forEach((p, i) => {
        if (i < midSlots.length) {
          p.zone = midSlots[i];
          p.detailedPosition = midSlots[i] === 'ldm' || midSlots[i] === 'rdm' ? 'CDM' : midSlots[i].toUpperCase();
        } else {
          // Overflow: assign to cam
          p.zone = 'cam'; p.detailedPosition = 'CAM';
        }
      });

      // 4-2-3-1: FWD = ST (assign only players without zones)
      fwdWithoutZone.forEach((p, i) => {
        p.zone = 'st'; p.detailedPosition = 'ST';
      });
    });

    // Build team analysis (reusable for all GW matchups)
    const buildTeamAnalysis = (teamId) => {
      const teamPlayers = playersWithZones.filter(p => p.team === teamId);
      const active = teamPlayers.filter(p => p.minutes > 0);
      const starters = [...active].sort((a, b) => b.minutes - a.minutes).slice(0, 15);

      const zoneStats = {};
      ALL_ZONES.forEach(z => { zoneStats[z] = { goals: 0, assists: 0, xG: 0, xA: 0, threat: 0, creativity: 0, goalsConceded: 0, xGC: 0, cleanSheets: 0, influence: 0, players: [] }; });

      starters.forEach(p => {
        if (!p.zone || !zoneStats[p.zone]) return;
        const z = zoneStats[p.zone];
        z.goals += p.goals;
        z.assists += p.assists;
        z.xG += p.expectedGoals;
        z.xA += p.expectedAssists;
        z.threat += p.threat;
        z.creativity += p.creativity;
        z.goalsConceded += p.goalsConceded;
        z.xGC += p.expectedGoalsConceded;
        z.influence += p.influence;
        z.cleanSheets += p.cleanSheets;
        z.players.push({
          name: p.name, position: p.detailedPosition, broadPos: p.broadPosition, zone: p.zone,
          goals: p.goals, assists: p.assists, xG: p.expectedGoals, xA: p.expectedAssists,
          xGI: p.expectedGoalInvolvements, threat: p.threat, creativity: p.creativity,
          influence: p.influence, ict: p.ictIndex, form: p.form, cost: p.nowCost,
          totalPoints: p.totalPoints, minutes: p.minutes, bonus: p.bonus,
          selectedBy: p.selectedByPercent, id: p.id, code: p.code,
          pointsPerGame: p.pointsPerGame, goalsConceded: p.goalsConceded,
          cleanSheets: p.cleanSheets, xGC: p.expectedGoalsConceded, saves: p.saves,
          yellowCards: p.yellowCards
        });
      });

      const defPlayers = active.filter(p => p.broadPosition === 'DEF' || p.broadPosition === 'GKP');
      const teamCS = defPlayers.reduce((s, p) => s + p.cleanSheets, 0);
      const teamGC = active.reduce((s, p) => s + p.goalsConceded, 0);
      const defCount = defPlayers.length || 1;
      const defcon = ((teamCS * 20) - teamGC) / defCount;
      const defconNorm = Math.max(0, Math.min(100, ((defcon + 20) / 60) * 100));

      const gk = starters.find(p => p.broadPosition === 'GKP');
      const defenders = starters.filter(p => p.broadPosition === 'DEF');

      let strongestAttack = 'st';
      let maxAtk = 0;
      ATTACKING_ZONES.forEach(z => {
        const score = (zoneStats[z]?.xG || 0) + (zoneStats[z]?.xA || 0);
        if (score > maxAtk) { maxAtk = score; strongestAttack = z; }
      });

      let weakestDefence = 'cb';
      let maxGC = 0;
      DEFENSIVE_ZONES.forEach(z => {
        if ((zoneStats[z]?.goalsConceded || 0) > maxGC) { maxGC = zoneStats[z].goalsConceded; weakestDefence = z; }
      });

      const topDef = [...defenders].sort((a, b) => b.influence - a.influence)[0];

      const totalGoals = active.reduce((s, p) => s + p.goals, 0);
      const totalAssists = active.reduce((s, p) => s + p.assists, 0);
      const totalXG = active.reduce((s, p) => s + p.expectedGoals, 0);
      const totalXA = active.reduce((s, p) => s + p.expectedAssists, 0);

      return {
        teamId, teamName: getTeam(teamId).short_name, teamFullName: getTeam(teamId).name,
        zoneStats,
        gk: gk ? { name: gk.name, saves: gk.saves, cs: gk.cleanSheets, gc: gk.goalsConceded, form: gk.form, cost: gk.nowCost, code: gk.code, xGC: gk.expectedGoalsConceded, pts: gk.totalPoints } : null,
        totalGoals, totalAssists, totalXG, totalXA, totalGC: teamGC,
        strongestAttack, strongestAttackZone: ZONE_LABELS[strongestAttack],
        weakestDefence, weakestDefenceZone: ZONE_LABELS[weakestDefence],
        defcon: Math.round(defconNorm),
        defconLabel: defconNorm > 66 ? 'Strong' : defconNorm > 33 ? 'Average' : 'Weak',
        topDefender: topDef ? { name: topDef.name, position: topDef.detailedPosition, influence: topDef.influence, cs: topDef.cleanSheets, cost: topDef.nowCost, code: topDef.code, form: topDef.form } : null,
        teamCS
      };
    };

    // Build all team analyses
    const teamAnalysisMap = {};
    teams.forEach(t => { teamAnalysisMap[t.id] = buildTeamAnalysis(t.id); });

    // Get fixtures for selected GW
    const gwFixtures = fixtures.filter(f => f.event === selectedGW);

    // Build per-match breakdowns
    const matchBreakdowns = gwFixtures.map(fixture => {
      const homeTeam = getTeam(fixture.team_h);
      const awayTeam = getTeam(fixture.team_a);
      const home = teamAnalysisMap[fixture.team_h];
      const away = teamAnalysisMap[fixture.team_a];
      if (!home || !away) return null;

      const homeFDR = fixture.difficulty || 3;

      // Determine danger zones for each side
      const homeDangerZone = home.strongestAttack;
      const homeDangerPlayers = home.zoneStats[homeDangerZone]?.players || [];
      const awayDangerZone = away.strongestAttack;
      const awayDangerPlayers = away.zoneStats[awayDangerZone]?.players || [];

      // Determine vulnerability zones
      const homeVulnZone = home.weakestDefence;
      const homeVulnPlayers = home.zoneStats[homeVulnZone]?.players || [];
      const awayVulnZone = away.weakestDefence;
      const awayVulnPlayers = away.zoneStats[awayVulnZone]?.players || [];

      // Best attacking picks from home team (vs away weakness)
      const homeAttackPicks = homeDangerPlayers
        .sort((a, b) => (b.xG + b.xA) - (a.xG + a.xA))
        .slice(0, 5)
        .map(p => ({
          ...p, reason: `Strongest zone: ${ZONE_LABELS[homeDangerZone]}`,
          zoneTarget: ZONE_LABELS[awayVulnZone],
          zoneMatch: homeDangerZone.replace('attack', 'defence') === awayVulnZone
        }));

      // Best attacking picks from away team (vs home weakness)
      const awayAttackPicks = awayDangerPlayers
        .sort((a, b) => (b.xG + b.xA) - (a.xG + a.xA))
        .slice(0, 5)
        .map(p => ({
          ...p, reason: `Strongest zone: ${ZONE_LABELS[awayDangerZone]}`,
          zoneTarget: ZONE_LABELS[homeVulnZone],
          zoneMatch: awayDangerZone.replace('attack', 'defence') === homeVulnZone
        }));

      // Best defensive picks from home team (if away attack is weak)
      const awayAttackTotal = away.totalXG + away.totalXA;
      const homeDefPicks = awayAttackTotal < 30 ?
        (home.zoneStats[homeVulnZone]?.players || [])
          .sort((a, b) => b.influence - a.influence)
          .slice(0, 3)
          .map(p => ({
            ...p, reason: awayAttackTotal < 20 ? 'Opponent very weak attack' : 'Opponent below avg attack',
            defensivePick: true
          })) : [];

      // Best defensive picks from away team (if home attack is weak)
      const homeAttackTotal = home.totalXG + home.totalXA;
      const awayDefPicks = homeAttackTotal < 30 ?
        (away.zoneStats[awayVulnZone]?.players || [])
          .sort((a, b) => b.influence - a.influence)
          .slice(0, 3)
          .map(p => ({
            ...p, reason: homeAttackTotal < 20 ? 'Opponent very weak attack' : 'Opponent below avg attack',
            defensivePick: true
          })) : [];

      // DEFCON matchup
      const homeDefconAdvantage = home.defcon - away.defcon;

      // Top 3 players each side by form
      const homeTopByForm = playersWithZones
        .filter(p => p.team === fixture.team_h && p.minutes > 100)
        .sort((a, b) => b.form - a.form)
        .slice(0, 3)
        .map(p => ({ name: p.name, position: p.broadPosition, form: p.form, cost: p.nowCost, code: p.code, xGI: p.expectedGoalInvolvements, pts: p.totalPoints }));

      const awayTopByForm = playersWithZones
        .filter(p => p.team === fixture.team_a && p.minutes > 100)
        .sort((a, b) => b.form - a.form)
        .slice(0, 3)
        .map(p => ({ name: p.name, position: p.broadPosition, form: p.form, cost: p.nowCost, code: p.code, xGI: p.expectedGoalInvolvements, pts: p.totalPoints }));

      return {
        fixture: {
          gw: selectedGW, homeTeam: home.teamName, awayTeam: away.teamName,
          homeTeamFull: home.teamFullName, awayTeamFull: away.teamFullName,
          homeFDR, difficulty: homeFDR,
          kickoff: fixture.kickoff_time || null,
          team_h: fixture.team_h, team_a: fixture.team_a,
          team_h_score: fixture.team_h_score, team_a_score: fixture.team_a_score
        },
        home: {
          zoneStats: home.zoneStats,
          strongestAttack: home.strongestAttack, strongestAttackZone: home.strongestAttackZone,
          weakestDefence: home.weakestDefence, weakestDefenceZone: home.weakestDefenceZone,
          gk: home.gk, totalXG: home.totalXG, totalXA: home.totalXA,
          totalGoals: home.totalGoals, totalGC: home.totalGC,
          defcon: home.defcon, defconLabel: home.defconLabel,
          teamCS: home.teamCS, topDefender: home.topDefender,
          attackPicks: homeAttackPicks, defPicks: homeDefPicks,
          topByForm: homeTopByForm
        },
        away: {
          zoneStats: away.zoneStats,
          strongestAttack: away.strongestAttack, strongestAttackZone: away.strongestAttackZone,
          weakestDefence: away.weakestDefence, weakestDefenceZone: away.weakestDefenceZone,
          gk: away.gk, totalXG: away.totalXG, totalXA: away.totalXA,
          totalGoals: away.totalGoals, totalGC: away.totalGC,
          defcon: away.defcon, defconLabel: away.defconLabel,
          teamCS: away.teamCS, topDefender: away.topDefender,
          attackPicks: awayAttackPicks, defPicks: awayDefPicks,
          topByForm: awayTopByForm
        },
        homeDefconAdvantage,
        prediction: homeAttackTotal > awayAttackTotal ? home.teamName :
                    awayAttackTotal > homeAttackTotal ? away.teamName : 'Even'
      };
    }).filter(Boolean);

    // Build overall recommendations for next 5 GWs
    const allRecommendations = [];
    const nextGWs = [];
    for (let gw = currentGW; gw <= Math.min(currentGW + 5, 38); gw++) {
      nextGWs.push(gw);
      const gwFxs = fixtures.filter(f => f.event === gw);
      gwFxs.forEach(fixture => {
        const home = teamAnalysisMap[fixture.team_h];
        const away = teamAnalysisMap[fixture.team_a];
        if (!home || !away) return;

        const isHome = true;

        // Attacking picks
        const homeAtkPlayers = home.zoneStats[home.strongestAttack]?.players || [];
        const awayAtkPlayers = away.zoneStats[away.strongestAttack]?.players || [];

        if (homeAtkPlayers.length > 0) {
          const zoneMatch = home.strongestAttack.replace('attack', 'defence') === away.weakestDefence;
          allRecommendations.push({
            gw, attackingTeam: home.teamName, defendingTeam: away.teamName,
            isHome: true, type: 'attack',
            attackZone: home.strongestAttackZone, weakZone: away.weakestDefenceZone,
            zoneMatch, strength: Math.round((home.zoneStats[home.strongestAttack].xG + home.zoneStats[home.strongestAttack].xA) * 10) / 10,
            players: homeAtkPlayers.sort((a, b) => (b.xG + b.xA) - (a.xG + a.xA)).slice(0, 5)
          });
        }
        if (awayAtkPlayers.length > 0) {
          const zoneMatch = away.strongestAttack.replace('attack', 'defence') === home.weakestDefence;
          allRecommendations.push({
            gw, attackingTeam: away.teamName, defendingTeam: home.teamName,
            isHome: false, type: 'attack',
            attackZone: away.strongestAttackZone, weakZone: home.weakestDefenceZone,
            zoneMatch, strength: Math.round((away.zoneStats[away.strongestAttack].xG + away.zoneStats[away.strongestAttack].xA) * 10) / 10,
            players: awayAtkPlayers.sort((a, b) => (b.xG + b.xA) - (a.xG + a.xA)).slice(0, 5)
          });
        }

        // Defensive picks (when opponent attack is weak)
        if (away.totalXG + away.totalXA < 30 && home.zoneStats[home.weakestDefence]?.players.length > 0) {
          allRecommendations.push({
            gw, attackingTeam: home.teamName, defendingTeam: away.teamName,
            isHome: true, type: 'defence',
            reason: `vs weak attack (${(away.totalXG + away.totalXA).toFixed(1)} xGI)`,
            strength: Math.round(home.defcon),
            players: home.zoneStats[home.weakestDefence].players
              .sort((a, b) => b.influence - a.influence).slice(0, 3)
              .map(p => ({ ...p, defensivePick: true }))
          });
        }
        if (home.totalXG + home.totalXA < 30 && away.zoneStats[away.weakestDefence]?.players.length > 0) {
          allRecommendations.push({
            gw, attackingTeam: away.teamName, defendingTeam: home.teamName,
            isHome: false, type: 'defence',
            reason: `vs weak attack (${(home.totalXG + home.totalXA).toFixed(1)} xGI)`,
            strength: Math.round(away.defcon),
            players: away.zoneStats[away.weakestDefence].players
              .sort((a, b) => b.influence - a.influence).slice(0, 3)
              .map(p => ({ ...p, defensivePick: true }))
          });
        }
      });
    }

    allRecommendations.sort((a, b) => b.strength - a.strength);

    res.json({
      currentGW, selectedGW, nextGWs,
      matchBreakdowns,
      recommendations: allRecommendations.slice(0, 50),
      teamAnalysis: Object.values(teamAnalysisMap).sort((a, b) => b.totalXG - a.totalXG),
      zoneLabels: ZONE_LABELS
    });
  } catch (e) {
    console.error('Zone analysis error:', e.message);
    res.status(500).json({ error: 'Failed to perform zone analysis' });
  }
});

// ---- Fixtures Detail (Next 5 GWs for all teams) ----
app.get('/api/fixtures-detail', async (req, res) => {
  try {
    const bs = (await apiGet('https://fantasy.premierleague.com/api/bootstrap-static/')).data;
    const fixtures = (await apiGet('https://fantasy.premierleague.com/api/fixtures/')).data;

    const teams = bs.teams;
    const elements = bs.elements;
    const currentGW = bs.events.find(e => e.is_current)?.id || 1;
    const selectedGW = parseInt(req.query.gw) || currentGW;
    const getTeam = id => teams.find(t => t.id === id) || { short_name: '?', name: 'Unknown' };

    // Build per-GW fixture lists for next 5 GWs
    const gwSchedule = {};
    for (let gw = selectedGW; gw <= Math.min(selectedGW + 4, 38); gw++) {
      const gwFxs = fixtures.filter(f => f.event === gw).map(f => ({
        homeTeam: getTeam(f.team_h).short_name,
        awayTeam: getTeam(f.team_a).short_name,
        homeTeamFull: getTeam(f.team_h).name,
        awayTeamFull: getTeam(f.team_a).name,
        difficulty: f.difficulty || 3,
        team_h: f.team_h, team_a: f.team_a,
        kickoff: f.kickoff_time || null,
        team_h_score: f.team_h_score, team_a_score: f.team_a_score
      }));
      gwSchedule[gw] = gwFxs;
    }

    // Per-team next 5 fixtures with top 5 players by form
    const teamFixtures = teams.map(team => {
      const nextFixtures = [];
      for (let gw = selectedGW; gw <= Math.min(selectedGW + 4, 38); gw++) {
        const fx = fixtures.find(f => f.event === gw && (f.team_h === team.id || f.team_a === team.id));
        if (fx) {
          const isHome = fx.team_h === team.id;
          const opp = getTeam(isHome ? fx.team_a : fx.team_h);
          nextFixtures.push({
            gw, opponent: opp.short_name, opponentFull: opp.name,
            isHome, difficulty: fx.difficulty || 3,
            kickoff: fx.kickoff_time || null
          });
        }
      }

      // Top 5 players by form in last 3 GWs (or overall form if no GW data)
      const teamPlayers = elements
        .filter(e => e.team === team.id && e.minutes > 0)
        .sort((a, b) => parseFloat(b.form) - parseFloat(a.form))
        .slice(0, 5)
        .map(p => ({
          name: p.web_name, position: POSITION_MAP[p.element_type - 1],
          form: parseFloat(p.form) || 0, totalPoints: p.total_points || 0,
          pointsPerGame: parseFloat(p.points_per_game) || 0,
          xGI: parseFloat(p.expected_goal_involvements) || 0,
          cost: p.now_cost || 0, code: p.code, selectedBy: parseFloat(p.selected_by_percent) || 0,
          goals: p.goals_scored || 0, assists: p.assists || 0,
          ictIndex: parseFloat(p.ict_index) || 0
        }));

      // FDR sum for next 5
      const fdrSum = nextFixtures.reduce((s, f) => s + f.difficulty, 0);
      const avgFDR = nextFixtures.length > 0 ? (fdrSum / nextFixtures.length).toFixed(1) : '—';

      return {
        teamId: team.id, teamName: team.short_name, teamFullName: team.name,
        nextFixtures, fdrSum, avgFDR,
        topPlayers: teamPlayers
      };
    });

    res.json({
      currentGW, selectedGW, gwSchedule, teamFixtures
    });
  } catch (e) {
    console.error('Fixtures detail error:', e.message);
    res.status(500).json({ error: 'Failed to fetch fixture details' });
  }
});

// ---- Captain Picks (xPts model) ----
app.get('/api/captain-picks', async (req, res) => {
  try {
    const bs = (await apiGet('https://fantasy.premierleague.com/api/bootstrap-static/')).data;
    const fixtures = (await apiGet('https://fantasy.premierleague.com/api/fixtures/')).data;
    const teams = bs.teams;
    const elements = bs.elements;
    const currentGW = bs.events.find(e => e.is_current)?.id || 1;
    const selectedGW = parseInt(req.query.gw) || currentGW;
    const getTeam = id => teams.find(t => t.id === id) || { short_name: '?', name: 'Unknown' };

    // Get next fixture for each team in the selected GW
    const getOpponent = (teamId) => {
      const fx = fixtures.find(f => f.event === selectedGW && (f.team_h === teamId || f.team_a === teamId));
      if (!fx) return null;
      const isHome = fx.team_h === teamId;
      const oppId = isHome ? fx.team_a : fx.team_h;
      return { opponent: getTeam(oppId).short_name, isHome, difficulty: fx.difficulty || 3 };
    };

    // Calculate xPts for each player
    const captainCandidates = elements
      .filter(p => p.minutes > 0 && (p.element_type === 4 || p.element_type === 3)) // FWD or MID only
      .map(p => {
        const xGI = parseFloat(p.expected_goal_involvements) || 0;
        const form = parseFloat(p.form) || 0;
        const ppg = parseFloat(p.points_per_game) || 0;
        const ict = parseFloat(p.ict_index) || 0;
        const goals = p.goals_scored || 0;
        const assists = p.assists || 0;
        const totalPts = p.total_points || 0;
        const cost = p.now_cost || 0;
        const team = getTeam(p.team);
        const fixture = getOpponent(p.team);

        // xPts formula: weighted combination of xGI, form, PPG, fixture
        const xGI_component = xGI * 6; // xGI weighted heavily
        const form_component = form * 2.5;
        const ppg_component = ppg * 1.5;
        const ict_component = (ict / 100) * 2;

        // Fixture modifier: lower difficulty = higher bonus
        let fixtureMod = 1.0;
        if (fixture) {
          if (fixture.difficulty === 1) fixtureMod = 1.4;
          else if (fixture.difficulty === 2) fixtureMod = 1.2;
          else if (fixture.difficulty === 3) fixtureMod = 1.0;
          else if (fixture.difficulty === 4) fixtureMod = 0.8;
          else if (fixture.difficulty === 5) fixtureMod = 0.6;

          // Home advantage
          if (fixture.isHome) fixtureMod *= 1.1;
        }

        // Raw xPts before fixture adjustment
        const rawXpts = xGI_component + form_component + ppg_component + ict_component;
        const xpts = Math.round(rawXpts * fixtureMod * 10) / 10;

        return {
          id: p.id, name: p.web_name, secondName: p.second_name,
          team: team.name, teamShort: team.short_name,
          position: POSITION_MAP[p.element_type - 1],
          form, ppg, xGI, goals, assists, totalPts, cost, ict,
          fixture: fixture ? fixture.opponent : '—',
          isHome: fixture ? fixture.isHome : false,
          fdr: fixture ? fixture.difficulty : 3,
          selectedBy: parseFloat(p.selected_by_percent) || 0,
          code: p.code, xpts, rawXpts,
          bonus: p.bonus || 0,
          minutes: p.minutes || 0
        };
      })
      .sort((a, b) => b.xpts - a.xpts)
      .slice(0, 15);

    res.json({ currentGW, selectedGW, captainPicks: captainCandidates });
  } catch (e) {
    console.error('Captain picks error:', e.message);
    res.status(500).json({ error: 'Failed to calculate captain picks' });
  }
});

app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
