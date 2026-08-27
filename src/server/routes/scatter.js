const express = require('express');
const { getCachedApiData, BOOTSTRAP_URL } = require('../cache');

const router = express.Router();

/**
 * GET /api/scatter-data
 * Returns aggregated team stats and player stats for scatter plot visualizations.
 * Team stats: xG vs Goals, xGI vs GI, xGC vs Goals Conceded, etc.
 * Player stats: xGI vs GI, xG vs Goals, xA vs Assists, ICT vs Points, etc.
 */
router.get('/scatter-data', async (req, res) => {
  try {
    const bootstrap = await getCachedApiData(BOOTSTRAP_URL, 5 * 60 * 1000);
    if (!bootstrap) {
      return res.status(503).json({ error: 'FPL data unavailable' });
    }

    const teams = bootstrap.teams || [];
    const elements = bootstrap.elements || [];

    // Build team stats by aggregating player data
    const teamStats = {};
    teams.forEach(t => {
      teamStats[t.id] = {
        id: t.id,
        name: t.name,
        short: t.short_name,
        code: t.code,
        // Attacking
        xG: 0, goals: 0,
        xA: 0, assists: 0,
        xGI: 0, goalInvolvements: 0,
        // Defensive
        xGC: 0, goalsConceded: 0,
        cleanSheets: 0,
        // General
        totalPoints: 0,
        minutes: 0,
        // Per 90 (calculated later)
        xG90: 0, goals90: 0, xGI90: 0, giPer90: 0,
      };
    });

    elements.forEach(el => {
      const t = teamStats[el.team];
      if (!t) return;

      const mins = parseInt(el.minutes || 0);
      const gs = parseInt(el.goals_scored || 0);
      const as = parseInt(el.assists || 0);
      const xg = parseFloat(el.expected_goals || 0);
      const xa = parseFloat(el.expected_assists || 0);
      const xgi = parseFloat(el.expected_goal_involvements || 0);
      const xgc = parseFloat(el.expected_goals_conceded || 0);
      const gc = parseInt(el.goals_conceded || 0);
      const cs = parseInt(el.clean_sheets || 0);
      const pts = parseInt(el.total_points || 0);

      t.xG += xg;
      t.goals += gs;
      t.xA += xa;
      t.assists += as;
      t.xGI += xgi;
      t.goalInvolvements += gs + as;
      t.xGC += xgc;
      t.goalsConceded += gc;
      t.cleanSheets += cs;
      t.totalPoints += pts;
      t.minutes += mins;
    });

    // Calculate per-90 stats for teams (total team minutes / 11)
    const teamList = Object.values(teamStats).map(t => {
      const team90s = Math.max(t.minutes / (11 * 90), 0.1);
      t.xG90 = round2(t.xG / team90s);
      t.goals90 = round2(t.goals / team90s);
      t.xGI90 = round2(t.xGI / team90s);
      t.giPer90 = round2(t.goalInvolvements / team90s);
      // Round all values
      t.xG = round2(t.xG);
      t.xA = round2(t.xA);
      t.xGI = round2(t.xGI);
      t.xGC = round2(t.xGC);
      return t;
    });

    // Build player stats (only players with > 0 minutes, min 1 start for quality)
    const posMap = { 1: 'GKP', 2: 'DEF', 3: 'MID', 4: 'FWD' };
    const playerList = elements
      .filter(el => parseInt(el.minutes || 0) >= 45)
      .map(el => {
        const mins = parseInt(el.minutes || 0);
        const gs = parseInt(el.goals_scored || 0);
        const as = parseInt(el.assists || 0);
        const xg = parseFloat(el.expected_goals || 0);
        const xa = parseFloat(el.expected_assists || 0);
        const xgi = parseFloat(el.expected_goal_involvements || 0);
        const ict = parseFloat(el.ict_index || 0);
        const inf = parseFloat(el.influence || 0);
        const crt = parseFloat(el.creativity || 0);
        const thr = parseFloat(el.threat || 0);
        const pts = parseInt(el.total_points || 0);
        const bonus = parseInt(el.bonus || 0);
        const team = teamStats[el.team];

        const nineties = Math.max(mins / 90, 0.1);
        return {
          id: el.id,
          name: el.web_name,
          team: team?.short || '?',
          teamId: el.team,
          teamCode: el.team_code,
          position: posMap[el.element_type] || '?',
          photo: el.photo,
          code: el.code,
          // Raw stats
          xG: round2(xg),
          goals: gs,
          xA: round2(xa),
          assists: as,
          xGI: round2(xgi),
          goalInvolvements: gs + as,
          // Per 90
          xG90: round2(xg / nineties),
          goals90: round2(gs / nineties),
          xGI90: round2(xgi / nineties),
          giPer90: round2((gs + as) / nineties),
          xA90: round2(xa / nineties),
          assistsPer90: round2(as / nineties),
          // Other
          minutes: mins,
          starts: parseInt(el.starts || 0),
          totalPoints: pts,
          ictIndex: round2(inf + crt + thr),
          influence: round2(inf),
          creativity: round2(crt),
          threat: round2(thr),
          bonus,
          form: parseFloat(el.form || 0),
          cost: (el.now_cost || 0) / 10,
          selectedBy: parseFloat(el.selected_by_percent || 0),
          ppg: parseFloat(el.points_per_game || 0),
        };
      });

    // Determine current GW
    const currentEvent = (bootstrap.events || []).find(e => e.is_current);
    const nextEvent = (bootstrap.events || []).find(e => e.is_next);
    const currentGW = currentEvent?.id || nextEvent?.id || 1;

    res.json({
      currentGW,
      teams: teamList,
      players: playerList,
      timestamp: Date.now(),
    });
  } catch (err) {
    console.error('Scatter data error:', err);
    res.status(500).json({ error: 'Failed to compute scatter data' });
  }
});

function round2(n) {
  return Math.round(n * 100) / 100;
}

module.exports = router;
