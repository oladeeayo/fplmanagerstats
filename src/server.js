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

app.get('/api/health', (req, res) => {
  res.json({ status: 'healthy' });
});

app.get('/api/bootstrap-static', async (req, res) => {
  try {
    const response = await axios.get('https://fantasy.premierleague.com/api/bootstrap-static/');
    res.json(response.data);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch bootstrap static data' });
  }
});

const POSITION_MAP = ["GKP", "DEF", "MID", "FWD"];

async function analyzeManager(managerId, playerData, leagueId = 314) {
  const [managerEntryResponse, historyResponse, leagueResponse] = await Promise.all([
    axios.get(`https://fantasy.premierleague.com/api/entry/${managerId}/`),
    axios.get(`https://fantasy.premierleague.com/api/entry/${managerId}/history/`),
    axios.get(`https://fantasy.premierleague.com/api/leagues-classic/${leagueId}/standings/`)
  ]);

  const managerEntryData = managerEntryResponse.data;
  const historyData = historyResponse.data;
  const leagueData = leagueResponse.data;
  const currentGameweek = playerData.events.find(event => event.is_current).id;
  const topManagerPoints = leagueData.standings.results[0].total;

  let totalCaptaincyPoints = 0;
  let totalPointsActive = 0;
  let totalPointsLostOnBench = 0;
  let totalCaptaincyAttempts = 0;
  const playerStats = {};
  const positionPoints = { GKP: {}, DEF: {}, MID: {}, FWD: {} };
  const weeklyPoints = new Array(currentGameweek).fill(0);
  const weeklyRanks = new Array(currentGameweek).fill(0);
  const weeklyPointsLostBench = new Array(currentGameweek).fill(0);
  const captainChoices = [];
  const chipImpact = [];

  let highestPoints = 0, highestPointsGW = 0;
  let lowestPoints = Infinity, lowestPointsGW = 0;
  let highestRank = Infinity, highestRankGW = 0;
  let lowestRank = 0, lowestRankGW = 0;

  const currentTeam = [];
  const currentPicksResponse = await axios.get(`https://fantasy.premierleague.com/api/entry/${managerId}/event/${currentGameweek}/picks/`);
  const currentPicks = currentPicksResponse.data.picks;

  for (const pick of currentPicks) {
    const player = playerData.elements.find(p => p.id === pick.element);
    if (!player) continue;
    const fixturesResponse = await axios.get(`https://fantasy.premierleague.com/api/element-summary/${player.id}/`);
    const nextFixtures = fixturesResponse.data.fixtures.slice(0, 5).map(f => {
      const isHome = f.is_home;
      const opp = playerData.teams.find(t => t.id === (isHome ? f.team_a : f.team_h));
      return { opponent: opp ? opp.short_name : '?', isHome, difficulty: f.difficulty };
    });
    const last3 = fixturesResponse.data.history.slice(-3).reduce((s, g) => s + g.total_points, 0);
    currentTeam.push({
      name: player.web_name, nextFixtures, last3GWPoints: last3,
      photoId: player.code, team: playerData.teams[player.team - 1].name,
      position: POSITION_MAP[player.element_type - 1],
      nowCost: player.now_cost, form: player.form,
      selectedBy: player.selected_by_percent, totalPoints: player.total_points,
      elementId: player.id
    });
  }

  // Cache per-player history to avoid duplicate API calls
  const playerHistoryCache = {};

  async function getPlayerHistory(playerId) {
    if (!playerHistoryCache[playerId]) {
      const r = await axios.get(`https://fantasy.premierleague.com/api/element-summary/${playerId}/`);
      playerHistoryCache[playerId] = r.data;
    }
    return playerHistoryCache[playerId];
  }

  for (let gw = 1; gw <= currentGameweek; gw++) {
    const picksResponse = await axios.get(`https://fantasy.premierleague.com/api/entry/${managerId}/event/${gw}/picks/`);
    const picksData = picksResponse.data;
    const picks = picksData.picks;

    const isBenchBoost = picksData.active_chip === "bboost";
    const isTripleCaptain = picksData.active_chip === "3xc";

    let gwPoints = 0, gwBenchPoints = 0;
    let captainPick = null, bestPick = null;

    for (const pick of picks) {
      const playerId = pick.element;
      const player = playerData.elements.find(p => p.id == playerId);
      if (!player) continue;

      const playerDataFull = await getPlayerHistory(playerId);
      const gwHistory = playerDataFull.history.find(h => h.round === gw);
      const pointsThisWeek = gwHistory ? gwHistory.total_points : 0;

      if (!playerStats[playerId]) {
        const t = playerData.teams[player.team - 1];
        playerStats[playerId] = {
          name: player.web_name, team: t.name, teamShort: t.short_name,
          position: POSITION_MAP[player.element_type - 1],
          totalPointsActive: 0, gwInSquad: 0, starts: 0, cappedPoints: 0,
          playerPoints: 0, photoId: player.code,
          nowCost: player.now_cost, selectedBy: player.selected_by_percent,
          form: player.form, pointsPerGame: player.points_per_game,
          totalPoints: player.total_points, goalsScored: player.goals_scored,
          assists: player.assists, cleanSheets: player.clean_sheets,
          goalsConceded: player.goals_conceded, bonus: player.bonus,
          bps: player.bps, influence: player.influence, creativity: player.creativity,
          threat: player.threat, ictIndex: player.ict_index, minutes: player.minutes,
          yellowCards: player.yellow_cards, redCards: player.red_cards,
          saves: player.saves, penaltiesSaved: player.penalties_saved,
          penaltiesMissed: player.penalties_missed,
          expectedGoals: player.expected_goal_involvements,
          expectedAssists: player.expected_assists,
          expectedGoalsTotal: player.expected_goals
        };
      }

      const inStarting11 = pick.position <= 11;
      const isCaptain = pick.is_captain;

      playerStats[playerId].playerPoints += pointsThisWeek;

      if (inStarting11 || isBenchBoost) {
        let activePoints = pointsThisWeek;
        if (isCaptain) {
          activePoints *= isTripleCaptain ? 3 : 2;
          totalCaptaincyPoints += activePoints;
          totalCaptaincyAttempts++;
          playerStats[playerId].cappedPoints += activePoints;
          captainPick = { playerId, name: player.web_name, points: activePoints, rawPoints: pointsThisWeek, multiplier: isTripleCaptain ? 3 : 2 };
        }
        playerStats[playerId].totalPointsActive += activePoints;
        totalPointsActive += activePoints;
        gwPoints += activePoints;

        const pos = playerStats[playerId].position;
        if (!positionPoints[pos][playerId]) {
          positionPoints[pos][playerId] = { name: player.web_name, points: 0, photoId: player.code };
        }
        positionPoints[pos][playerId].points += activePoints;
        if (inStarting11) playerStats[playerId].starts += 1;
        playerStats[playerId].gwInSquad += 1;
      } else {
        totalPointsLostOnBench += pointsThisWeek;
        gwBenchPoints += pointsThisWeek;
      }

      if (!bestPick || pointsThisWeek > bestPick.rawPoints) {
        bestPick = { playerId, name: player.web_name, rawPoints: pointsThisWeek };
      }
    }

    weeklyPoints[gw - 1] = gwPoints;
    weeklyPointsLostBench[gw - 1] = gwBenchPoints;
    const gwRank = historyData.current.find(h => h.event === gw)?.overall_rank || 0;
    weeklyRanks[gw - 1] = gwRank;

    captainChoices.push({
      gw, captain: captainPick || { name: 'None', points: 0, rawPoints: 0, multiplier: 0 },
      bestOption: bestPick || { name: 'None', rawPoints: 0 },
      missedPoints: (bestPick?.rawPoints || 0) - ((captainPick?.rawPoints || 0) * (captainPick?.multiplier || 1))
    });

    if (picksData.active_chip) {
      chipImpact.push({ chip: picksData.active_chip, gw, points: gwPoints });
    }

    if (gwPoints > highestPoints) { highestPoints = gwPoints; highestPointsGW = gw; }
    if (gwPoints < lowestPoints) { lowestPoints = gwPoints; lowestPointsGW = gw; }
    if (gwRank < highestRank) { highestRank = gwRank; highestRankGW = gw; }
    if (gwRank > lowestRank) { lowestRank = gwRank; lowestRankGW = gw; }
  }

  const avgPoints = weeklyPoints.reduce((a, b) => a + b, 0) / weeklyPoints.length;
  chipImpact.forEach(c => { c.avgPoints = Math.round(avgPoints * 10) / 10; c.diff = Math.round((c.points - avgPoints) * 10) / 10; });

  const averageRank = Math.round(weeklyRanks.reduce((a, b) => a + b, 0) / weeklyRanks.length);
  const halfLen = Math.floor(weeklyRanks.length / 2);
  const firstHalfRank = halfLen > 0 ? Math.round(weeklyRanks.slice(0, halfLen).reduce((a, b) => a + b, 0) / halfLen) : averageRank;
  const secondHalfRank = halfLen > 0 ? Math.round(weeklyRanks.slice(halfLen).reduce((a, b) => a + b, 0) / weeklyRanks.slice(halfLen).length) : averageRank;
  const rankTrend = firstHalfRank - secondHalfRank;

  // Defensive record
  const defenders = Object.values(playerStats).filter(p => p.position === 'DEF' || p.position === 'GKP');
  const totalCS = defenders.reduce((s, p) => s + (p.cleanSheets || 0), 0);
  const totalGC = defenders.reduce((s, p) => s + (p.goalsConceded || 0), 0);
  const totalSaves = Object.values(playerStats).filter(p => p.position === 'GKP').reduce((s, p) => s + (p.saves || 0), 0);

  // Template analysis
  const templateThreshold = 20;
  const playerVals = Object.values(playerStats);
  const templateCount = playerVals.filter(p => parseFloat(p.selectedBy || 0) >= templateThreshold).length;
  const diffCount = playerVals.filter(p => parseFloat(p.selectedBy || 0) < templateThreshold).length;

  // Season history
  const seasonHistory = (historyData.past || []).map((s, i) => ({
    season: s.season_name || `${2020 + i}/${2021 + i}`,
    rank: s.rank, points: s.total_points, topPoints: s.top_rank_points || 0
  }));

  // Fixture difficulty summary
  const diffSum = currentTeam.reduce((s, p) => s + p.nextFixtures.reduce((d, f) => d + f.difficulty, 0), 0);
  const diffCount2 = currentTeam.reduce((s, p) => s + p.nextFixtures.length, 0);
  const avgFixtureDiff = diffCount2 > 0 ? Math.round((diffSum / diffCount2) * 10) / 10 : 0;

  const highestScorers = {};
  for (const [position, players] of Object.entries(positionPoints)) {
    const hs = Object.values(players).reduce((max, p) => p.points > (max?.points || 0) ? p : max, null);
    highestScorers[position] = hs;
  }

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
      templateScore: templateCount, differentialScore: diffCount,
      defensiveCleanSheets: totalCS, defensiveGoalsConceded: totalGC, defensiveSaves: totalSaves,
      avgFixtureDifficulty: avgFixtureDiff
    },
    playerStats: Object.values(playerStats).sort((a, b) => b.totalPointsActive - a.totalPointsActive),
    positionSummary: Object.entries(positionPoints).map(([position, players]) => ({
      position,
      totalPoints: Object.values(players).reduce((s, p) => s + p.points, 0),
      players: Object.values(players).sort((a, b) => b.points - a.points),
      highestScorer: highestScorers[position], count: Object.keys(players).length
    })),
    weeklyPoints, weeklyRanks, weeklyPointsLostBench,
    currentTeam, captainChoices, chipImpact, seasonHistory
  };
}

app.get('/api/analyze-manager/:managerId', async (req, res) => {
  try {
    const playerDataResponse = await axios.get('https://fantasy.premierleague.com/api/bootstrap-static/');
    const result = await analyzeManager(req.params.managerId, playerDataResponse.data, 314);
    res.json(result);
  } catch (error) {
    console.error('Error analyzing manager:', error);
    res.status(500).json({ error: 'Failed to analyze manager' });
  }
});

app.get('/api/compare-managers/:id1/:id2', async (req, res) => {
  try {
    const playerDataResponse = await axios.get('https://fantasy.premierleague.com/api/bootstrap-static/');
    const [m1, m2] = await Promise.all([
      analyzeManager(req.params.id1, playerDataResponse.data, 314),
      analyzeManager(req.params.id2, playerDataResponse.data, 314)
    ]);
    res.json({ manager1: m1, manager2: m2 });
  } catch (error) {
    console.error('Error comparing managers:', error);
    res.status(500).json({ error: 'Failed to compare managers' });
  }
});

app.get('/api/price-changes', async (req, res) => {
  try {
    const r = await axios.get('https://fantasy.premierleague.com/api/bootstrap-static/');
    const elements = r.data.elements || [];
    const teams = r.data.teams || [];
    const risers = elements.filter(p => (p.cost_change_event || 0) > 0)
      .sort((a, b) => b.cost_change_event - a.cost_change_event)
      .slice(0, 15).map(p => ({
        name: p.web_name, team: (teams.find(t => t.id === p.team) || {}).name || '',
        photoId: p.code, change: p.cost_change_event,
        newCost: p.now_cost, selectedBy: p.selected_by_percent, form: p.form
      }));
    const fallers = elements.filter(p => (p.cost_change_event || 0) < 0)
      .sort((a, b) => a.cost_change_event - b.cost_change_event)
      .slice(0, 15).map(p => ({
        name: p.web_name, team: (teams.find(t => t.id === p.team) || {}).name || '',
        photoId: p.code, change: p.cost_change_event,
        newCost: p.now_cost, selectedBy: p.selected_by_percent, form: p.form
      }));
    res.json({ risers, fallers });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch price changes' });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
