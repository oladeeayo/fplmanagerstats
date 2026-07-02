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
    const [bs, lr] = await Promise.all([
      apiGet('https://fantasy.premierleague.com/api/bootstrap-static/'),
      apiGet(`https://fantasy.premierleague.com/api/leagues-classic/${leagueId}/standings/`)
    ]);
    const playerData = bs.data;
    const standings = lr.data.standings.results || [];
    const currentGW = playerData.events.find(e => e.is_current)?.id || 1;

    // Enrich with chips, past seasons, transfers (top 20 only to limit API calls)
    const enriched = [];
    const entries = standings.slice(0, 30);

    const batchSize = 5;
    for (let i = 0; i < entries.length; i += batchSize) {
      const batch = entries.slice(i, i + batchSize);
      const results = await Promise.allSettled(batch.map(e =>
        apiGet(`https://fantasy.premierleague.com/api/entry/${e.entry}/history/`).catch(() => null)
      ));
      results.forEach((res, idx) => {
        const entry = batch[idx];
        const data = res.value?.data;
        const chips = (data?.chips || []).map(c => c.name);
        const past = data?.past || [];
        const lastSeasonRank = past.length > 0 ? past[past.length - 1].rank : null;
        const seasonBeforeLastRank = past.length > 1 ? past[past.length - 2].rank : null;
        const chipLabels = chips.map(c => ({ wildcard:'WC', freehit:'FH', bench_boost:'BB', '3xc':'TC', triple_captain:'TC', bboost:'BB' }[c]||c));

        // Estimate GW points from total difference
        const gwPoints = entry.total - (entry.last_rank > 0 ? entry.total - (entry.rank - entry.last_rank) * 10 : 0);

        enriched.push({
          rank: entry.rank, entry: entry.entry,
          playerName: entry.player_name, teamName: entry.entry_name,
          totalPoints: entry.total, overallRank: entry.overall_rank?.toLocaleString() || '—',
          lastRank: entry.last_rank, rankChange: (entry.last_rank || entry.rank) - entry.rank,
          gwPoints: '—',
          lastSeasonRank: lastSeasonRank?.toLocaleString() || '—',
          seasonBeforeLastRank: seasonBeforeLastRank?.toLocaleString() || '—',
          chipsUsed: chipLabels.length ? chipLabels.join(', ') : 'None',
          immediateGain: '—',
          totalImmediateGain: '—'
        });
      });
    }

    res.json({
      leagueName: lr.data.league?.name || 'Classic League',
      currentGW,
      standings: enriched
    });
  } catch (e) {
    console.error('League error:', e.message);
    res.status(500).json({ error: 'Failed to fetch league standings' });
  }
});

app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
