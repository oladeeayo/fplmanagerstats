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

app.get('/api/analyze-manager/:managerId', async (req, res) => {
  try {
    const { managerId } = req.params;
    const leagueId = 314;

    const [playerDataResponse, managerEntryResponse, historyResponse, leagueResponse] = await Promise.all([
      axios.get('https://fantasy.premierleague.com/api/bootstrap-static/'),
      axios.get(`https://fantasy.premierleague.com/api/entry/${managerId}/`),
      axios.get(`https://fantasy.premierleague.com/api/entry/${managerId}/history/`),
      axios.get(`https://fantasy.premierleague.com/api/leagues-classic/${leagueId}/standings/`)
    ]);

    const playerData = playerDataResponse.data;
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

    let highestPoints = 0;
    let highestPointsGW = 0;
    let lowestPoints = Infinity;
    let lowestPointsGW = 0;
    let highestRank = Infinity;
    let highestRankGW = 0;
    let lowestRank = 0;
    let lowestRankGW = 0;

    const currentTeam = [];
    const managerPicksResponse = await axios.get(`https://fantasy.premierleague.com/api/entry/${managerId}/event/${currentGameweek}/picks/`);
    const managerPicks = managerPicksResponse.data.picks;

    for (const pick of managerPicks) {
      const player = playerData.elements.find(p => p.id === pick.element);
      if (!player) continue;

      const fixturesResponse = await axios.get(`https://fantasy.premierleague.com/api/element-summary/${player.id}/`);
      const nextFixtures = fixturesResponse.data.fixtures.slice(0, 5).map(fixture => {
        const isHome = fixture.is_home;
        const opponent = playerData.teams.find(t => t.id === (isHome ? fixture.team_a : fixture.team_h)).short_name;
        return { opponent, isHome, difficulty: fixture.difficulty };
      });

      const last3GWPoints = fixturesResponse.data.history.slice(-3).reduce((sum, game) => sum + game.total_points, 0);

      currentTeam.push({
        name: player.web_name,
        nextFixtures,
        last3GWPoints,
        photoId: player.code,
        team: playerData.teams[player.team - 1].name,
        position: ["GKP", "DEF", "MID", "FWD"][player.element_type - 1],
        nowCost: player.now_cost,
        form: player.form,
        selectedBy: player.selected_by_percent,
        totalPoints: player.total_points
      });
    }

    for (let gw = 1; gw <= currentGameweek; gw++) {
      const managerPicksResponse = await axios.get(`https://fantasy.premierleague.com/api/entry/${managerId}/event/${gw}/picks/`);
      const managerPicksData = managerPicksResponse.data;
      const managerPicks = managerPicksData.picks;

      const isBenchBoost = managerPicksData.active_chip === "bboost";
      const isTripleCaptain = managerPicksData.active_chip === "3xc";

      let gwPoints = 0;
      let gwBenchPoints = 0;

      for (const pick of managerPicks) {
        const playerId = pick.element;
        const player = playerData.elements.find(p => p.id == playerId);
        if (!player) continue;

        const playerHistoryResponse = await axios.get(`https://fantasy.premierleague.com/api/element-summary/${playerId}/`);
        const playerHistory = playerHistoryResponse.data.history;
        const gameweekHistory = playerHistory.find(history => history.round === gw);
        const pointsThisWeek = gameweekHistory ? gameweekHistory.total_points : 0;

        if (!playerStats[playerId]) {
          const teamObj = playerData.teams[player.team - 1];
          playerStats[playerId] = {
            name: player.web_name,
            fullName: player.first_name + ' ' + player.second_name,
            team: teamObj.name,
            teamShort: teamObj.short_name,
            position: ["GKP", "DEF", "MID", "FWD"][player.element_type - 1],
            totalPointsActive: 0,
            gwInSquad: 0,
            starts: 0,
            cappedPoints: 0,
            playerPoints: 0,
            photoId: player.code,
            nowCost: player.now_cost,
            selectedBy: player.selected_by_percent,
            form: player.form,
            pointsPerGame: player.points_per_game,
            totalPoints: player.total_points,
            goalsScored: player.goals_scored,
            assists: player.assists,
            cleanSheets: player.clean_sheets,
            goalsConceded: player.goals_conceded,
            bonus: player.bonus,
            bps: player.bps,
            influence: player.influence,
            creativity: player.creativity,
            threat: player.threat,
            ictIndex: player.ict_index,
            minutes: player.minutes,
            yellowCards: player.yellow_cards,
            redCards: player.red_cards,
            saves: player.saves,
            penaltiesSaved: player.penalties_saved,
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
          }

          playerStats[playerId].totalPointsActive += activePoints;
          totalPointsActive += activePoints;
          gwPoints += activePoints;

          const position = playerStats[playerId].position;
          if (!positionPoints[position][playerId]) {
            positionPoints[position][playerId] = {
              name: playerStats[playerId].name,
              points: 0,
              photoId: player.code
            };
          }
          positionPoints[position][playerId].points += activePoints;

          if (inStarting11) playerStats[playerId].starts += 1;
          playerStats[playerId].gwInSquad += 1;
        } else {
          totalPointsLostOnBench += pointsThisWeek;
          gwBenchPoints += pointsThisWeek;
        }
      }

      weeklyPoints[gw - 1] = gwPoints;
      weeklyPointsLostBench[gw - 1] = gwBenchPoints;
      const gwRank = historyData.current.find(h => h.event === gw)?.overall_rank || 0;
      weeklyRanks[gw - 1] = gwRank;

      if (gwPoints > highestPoints) { highestPoints = gwPoints; highestPointsGW = gw; }
      if (gwPoints < lowestPoints) { lowestPoints = gwPoints; lowestPointsGW = gw; }
      if (gwRank < highestRank) { highestRank = gwRank; highestRankGW = gw; }
      if (gwRank > lowestRank) { lowestRank = gwRank; lowestRankGW = gw; }
    }

    const averageRank = Math.round(weeklyRanks.reduce((a, b) => a + b, 0) / weeklyRanks.length);
    const halfLen = Math.floor(weeklyRanks.length / 2);
    const firstHalfRank = halfLen > 0 ? Math.round(weeklyRanks.slice(0, halfLen).reduce((a, b) => a + b, 0) / halfLen) : averageRank;
    const secondHalfRank = halfLen > 0 ? Math.round(weeklyRanks.slice(halfLen).reduce((a, b) => a + b, 0) / weeklyRanks.slice(halfLen).length) : averageRank;
    const rankTrend = firstHalfRank - secondHalfRank;
    const captaincyEfficiency = totalCaptaincyAttempts > 0 ? Math.round((totalCaptaincyPoints / totalCaptaincyAttempts) * 10) / 10 : 0;

    const highestScorers = {};
    for (const [position, players] of Object.entries(positionPoints)) {
      const highestScorer = Object.values(players).reduce((max, player) =>
        player.points > (max?.points || 0) ? player : max, null);
      highestScorers[position] = highestScorer;
    }

    const chips = historyData.chips || [];
    const chipsUsed = chips.map(c => c.name);

    const analysis = {
      managerInfo: {
        name: `${managerEntryData.player_first_name} ${managerEntryData.player_last_name}`,
        teamName: managerEntryData.name,
        overallRanking: managerEntryData.summary_overall_rank?.toLocaleString() || "N/A",
        overallRankRaw: managerEntryData.summary_overall_rank || 0,
        managerPoints: managerEntryData.summary_overall_points,
        allChipsUsed: chipsUsed.join(", ") || "None",
        chipsUsed,
        chipsCount: chipsUsed.length,
        lastSeasonRank: historyData.past.length > 0 ? historyData.past[historyData.past.length - 1].rank.toLocaleString() : "Didn't Play",
        lastSeasonRankRaw: historyData.past.length > 0 ? historyData.past[historyData.past.length - 1].rank : null,
        seasonBeforeLastRank: historyData.past.length > 1 ? historyData.past[historyData.past.length - 2].rank.toLocaleString() : "Didn't Play",
        pointDifference: topManagerPoints - managerEntryData.summary_overall_points,
        totalPointsLostOnBench,
        totalCaptaincyPoints,
        captaincyEfficiency,
        currentGameweek,
        highestPoints, highestPointsGW,
        lowestPoints, lowestPointsGW,
        highestRank: highestRank.toLocaleString(), highestRankGW,
        lowestRank: lowestRank.toLocaleString(), lowestRankGW,
        averageRank: averageRank.toLocaleString(),
        rankTrend,
        rankTrendLabel: rankTrend > 0 ? 'improving' : rankTrend < 0 ? 'declining' : 'stable',
        totalTransfers: managerEntryData?.transfers?.cost || 0
      },
      playerStats: Object.values(playerStats).sort((a, b) => b.totalPointsActive - a.totalPointsActive),
      positionSummary: Object.entries(positionPoints).map(([position, players]) => ({
        position,
        totalPoints: Object.values(players).reduce((sum, player) => sum + player.points, 0),
        players: Object.values(players).sort((a, b) => b.points - a.points),
        highestScorer: highestScorers[position],
        count: Object.keys(players).length
      })),
      weeklyPoints,
      weeklyRanks,
      weeklyPointsLostBench,
      currentTeam
    };

    res.json(analysis);
  } catch (error) {
    console.error('Error analyzing manager:', error);
    res.status(500).json({ error: 'Failed to analyze manager' });
  }
});

app.listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}`);
});
