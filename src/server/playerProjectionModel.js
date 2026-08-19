// src/server/playerProjectionModel.js
// Player-level FPL projection model
// Produces per-player projected goals, assists, bonus, clean sheet probability, and points

// --- FPL points system ---
const FPL_POINTS = {
  GOAL: { GKP: 10, DEF: 6, MID: 5, FWD: 4 },
  ASSIST: 3,
  CLEAN_SHEET: { GKP: 4, DEF: 4, MID: 1, FWD: 0 },
  BONUS: 3, // max bonus per match
  SAVE: { GKP: 1 }, // per 3 saves
  YELLOW: -1,
  RED: -3,
  OWN_GOAL: -2,
  PENALTY_SAVE: 5,
  PENALTY_MISS: -2,
};

// --- Compute team-level attacking/defensive strength from bootstrap ---
function computeTeamStrengths(teams) {
  const strengths = {};

  // Compute league means
  const meanAtkHome = teams.reduce((s, t) => s + (t.strength_attack_home || 1100), 0) / teams.length;
  const meanAtkAway = teams.reduce((s, t) => s + (t.strength_attack_away || 1100), 0) / teams.length;
  const meanDefHome = teams.reduce((s, t) => s + (t.strength_defence_home || 1100), 0) / teams.length;
  const meanDefAway = teams.reduce((s, t) => s + (t.strength_defence_away || 1100), 0) / teams.length;

  teams.forEach(t => {
    const atkHome = t.strength_attack_home || 1100;
    const atkAway = t.strength_attack_away || 1100;
    const defHome = t.strength_defence_home || 1100;
    const defAway = t.strength_defence_away || 1100;

    // Relative strength: >1 = above average, <1 = below average
    // Using wider spread with exponential scaling
    const AMPLIFY = 2.5; // Exponential amplification factor

    strengths[t.id] = {
      name: t.short_name,
      fullName: t.name,
      id: t.id,
      // Attack: how many goals this team scores relative to league average
      attackHome: Math.exp((atkHome - meanAtkHome) / 100 * AMPLIFY),
      attackAway: Math.exp((atkAway - meanAtkAway) / 100 * AMPLIFY),
      // Defense: how many goals this team concedes (lower = better)
      // >1 means weaker defense (concedes more)
      defenseHome: Math.exp((defHome - meanDefHome) / 100 * AMPLIFY),
      defenseAway: Math.exp((defAway - meanDefAway) / 100 * AMPLIFY),
      // Overall strength for ranking
      overall: (atkHome + atkAway + defHome + defAway) / 4,
    };
  });

  return strengths;
}

// --- Compute opponent defensive strength modifier ---
// Returns a multiplier for how many goals a team is expected to score vs this opponent
// >1 = easy to score against, <1 = hard to score against
function opponentDefensiveModifier(opponentStrength, isHome) {
  // League average goals per team per match ≈ 1.45
  // Weaker defense (higher defenseHome/Away) = more goals conceded
  const defRating = isHome ? opponentStrength.defenseHome : opponentStrength.defenseAway;
  // Map to modifier: avg = 1.0, weak = 1.3, strong = 0.7
  return 0.7 + (defRating * 0.3);
}

// --- Compute opponent attacking strength modifier ---
// Returns a multiplier for how many goals the opponent scores (affects clean sheet chance)
// >1 = strong attack (harder CS), <1 = weak attack (easier CS)
function opponentAttackingModifier(opponentStrength, isHome) {
  const atkRating = isHome ? opponentStrength.attackHome : opponentStrength.attackAway;
  return 0.7 + (atkRating * 0.3);
}

// --- Project player goals for a single match ---
function projectPlayerGoals(player, teamStrength, opponentStrength, isHome) {
  const pos = player.element_type; // 1=GKP, 2=DEF, 3=MID, 4=FWD
  const posName = ['GKP', 'DEF', 'MID', 'FWD'][pos - 1] || 'MID';

  // Base goals per match from expected_goals (season rate)
  const matchesPlayed = Math.max(1, (player.minutes || 0) / 90);
  const goalsPerMatch = matchesPlayed > 0 ? (parseFloat(player.expected_goals) || 0) / matchesPlayed : 0;

  // Fixture modifier: easier opponent = more goals
  const fixMod = isHome ? teamStrength.attackHome : teamStrength.attackAway;
  const oppMod = opponentDefensiveModifier(opponentStrength, !isHome);

  // Position-based adjustment
  const posMod = { GKP: 0.02, DEF: 0.15, MID: 0.65, FWD: 1.0 }[posName] || 0.65;

  // Minutes projection (assume ~80% chance of starting, ~75 min if starts)
  const minutesMod = Math.min(1.0, (player.chance_of_playing_next_round || 100) / 100);

  // Projected goals = base rate * fixture * opponent * position * minutes
  let projectedGoals = goalsPerMatch * fixMod * oppMod * posMod * minutesMod;

  // Floor/ceiling
  projectedGoals = Math.max(0, Math.min(2.5, projectedGoals));

  return Math.round(projectedGoals * 1000) / 1000;
}

// --- Project player assists for a single match ---
function projectPlayerAssists(player, teamStrength, opponentStrength, isHome) {
  const pos = player.element_type;
  const posName = ['GKP', 'DEF', 'MID', 'FWD'][pos - 1] || 'MID';

  const matchesPlayed = Math.max(1, (player.minutes || 0) / 90);
  const assistsPerMatch = matchesPlayed > 0 ? (parseFloat(player.expected_assists) || 0) / matchesPlayed : 0;

  const fixMod = isHome ? teamStrength.attackHome : teamStrength.attackAway;
  const oppMod = opponentDefensiveModifier(opponentStrength, !isHome);

  // Position modifier for assists
  const posMod = { GKP: 0.01, DEF: 0.20, MID: 0.75, FWD: 0.55 }[posName] || 0.75;

  const minutesMod = Math.min(1.0, (player.chance_of_playing_next_round || 100) / 100);

  let projectedAssists = assistsPerMatch * fixMod * oppMod * posMod * minutesMod;
  projectedAssists = Math.max(0, Math.min(2.0, projectedAssists));

  return Math.round(projectedAssists * 1000) / 1000;
}

// --- Project clean sheet probability for a single match ---
function projectCleanSheet(player, teamStrength, opponentStrength, isHome) {
  const pos = player.element_type;
  const posName = ['GKP', 'DEF', 'MID', 'FWD'][pos - 1] || 'MID';

  // Base CS rate from bootstrap (if available)
  const matchesPlayed = Math.max(1, (player.minutes || 0) / 90);
  const baseCSRate = matchesPlayed > 0 ? (parseFloat(player.clean_sheets) || 0) / matchesPlayed : 0.25;

  // Team defensive strength (stronger defense = more CS)
  const teamDef = isHome ? teamStrength.defenseHome : teamStrength.defenseAway;
  const defMod = 1 / teamDef; // Invert: strong defense = high modifier

  // Opponent attacking strength
  const oppAtkMod = opponentAttackingModifier(opponentStrength, isHome);

  // Position modifier (DEF/GKP get more CS points)
  const posMod = { GKP: 1.0, DEF: 1.0, MID: 0.3, FWD: 0.0 }[posName] || 0.3;

  const minutesMod = Math.min(1.0, (player.chance_of_playing_next_round || 100) / 100);

  // CS probability
  let csProb = baseCSRate * defMod * oppAtkMod * posMod * minutesMod;
  csProb = Math.max(0, Math.min(0.85, csProb));

  return Math.round(csProb * 100) / 100;
}

// --- Project bonus points for a single match ---
function projectBonusPoints(player, teamStrength, opponentStrength, isHome) {
  const pos = player.element_type;
  const posName = ['GKP', 'DEF', 'MID', 'FWD'][pos - 1] || 'MID';

  const matchesPlayed = Math.max(1, (player.minutes || 0) / 90);
  const bonusPerMatch = matchesPlayed > 0 ? (parseFloat(player.bonus_points) || 0) / matchesPlayed : 0;

  // Bonus correlates with goal involvements
  const fixMod = isHome ? teamStrength.attackHome : teamStrength.attackAway;
  const minutesMod = Math.min(1.0, (player.chance_of_playing_next_round || 100) / 100);

  // FWD/MID get more bonus for goals, DEF for clean sheets
  const posMod = { GKP: 0.15, DEF: 0.25, MID: 0.45, FWD: 0.40 }[posName] || 0.45;

  let projectedBonus = bonusPerMatch * fixMod * posMod * minutesMod;
  projectedBonus = Math.max(0, Math.min(3.0, projectedBonus));

  return Math.round(projectedBonus * 1000) / 1000;
}

// --- Project total FPL points for a single match ---
function projectPlayerPoints(player, teamStrength, opponentStrength, isHome) {
  const pos = player.element_type;
  const posName = ['GKP', 'DEF', 'MID', 'FWD'][pos - 1] || 'MID';

  const goals = projectPlayerGoals(player, teamStrength, opponentStrength, isHome);
  const assists = projectPlayerAssists(player, teamStrength, opponentStrength, isHome);
  const cs = projectCleanSheet(player, teamStrength, opponentStrength, isHome);
  const bonus = projectBonusPoints(player, teamStrength, opponentStrength, isHome);

  // Minutes points (assume 60+ min = 2 pts, 30+ = 1 pt)
  const minutesMod = Math.min(1.0, (player.chance_of_playing_next_round || 100) / 100);
  const minutesPoints = minutesMod >= 0.8 ? 2 : minutesMod >= 0.4 ? 1 : 0;

  // Goal points by position
  const goalPts = goals * (FPL_POINTS.GOAL[posName] || 5);
  const assistPts = assists * FPL_POINTS.ASSIST;
  const csPts = cs * (FPL_POINTS.CLEAN_SHEET[posName] || 0);
  const bonusPts = bonus;

  const totalPoints = goalPts + assistPts + csPts + bonusPts + minutesPoints;

  return {
    goals,
    assists,
    csProb: Math.round(cs * 100),
    bonus: Math.round(bonus * 100) / 100,
    minutesPoints,
    goalPts: Math.round(goalPts * 100) / 100,
    assistPts: Math.round(assistPts * 100) / 100,
    csPts: Math.round(csPts * 100) / 100,
    bonusPts: Math.round(bonusPts * 100) / 100,
    totalPoints: Math.round(totalPoints * 100) / 100,
  };
}

// --- Project all players for a single fixture ---
function projectFixturePlayers(homeTeam, awayTeam, players, teamStrengths, options = {}) {
  const homeStrength = teamStrengths[homeTeam.id];
  const awayStrength = teamStrengths[awayTeam.id];

  if (!homeStrength || !awayStrength) return { homePlayers: [], awayPlayers: [] };

  const homePlayers = players
    .filter(p => p.team === homeTeam.id && (p.minutes || 0) > 0)
    .map(p => {
      const proj = projectPlayerPoints(p, homeStrength, awayStrength, true);
      return {
        id: p.id,
        name: p.web_name || p.first_name,
        team: homeTeam.short_name,
        teamId: homeTeam.id,
        position: ['GKP', 'DEF', 'MID', 'FWD'][p.element_type - 1] || 'MID',
        price: (p.now_cost || 50) / 10,
        ...proj,
      };
    });

  const awayPlayers = players
    .filter(p => p.team === awayTeam.id && (p.minutes || 0) > 0)
    .map(p => {
      const proj = projectPlayerPoints(p, awayStrength, homeStrength, false);
      return {
        id: p.id,
        name: p.web_name || p.first_name,
        team: awayTeam.short_name,
        teamId: awayTeam.id,
        position: ['GKP', 'DEF', 'MID', 'FWD'][p.element_type - 1] || 'MID',
        price: (p.now_cost || 50) / 10,
        ...proj,
      };
    });

  return { homePlayers, awayPlayers };
}

// --- Project all fixtures for a gameweek ---
function projectGameweekPlayers(fixtures, teams, elements, teamStrengths, options = {}) {
  const allProjections = [];

  fixtures.forEach(f => {
    const homeTeam = teams.find(t => t.id === f.team_h);
    const awayTeam = teams.find(t => t.id === f.team_a);
    if (!homeTeam || !awayTeam) return;

    const { homePlayers, awayPlayers } = projectFixturePlayers(
      homeTeam, awayTeam, elements, teamStrengths, options
    );

    allProjections.push({
      fixtureId: f.id,
      gw: f.event,
      kickoff: f.kickoff_time,
      homeTeam: { id: homeTeam.id, name: homeTeam.name, shortName: homeTeam.short_name },
      awayTeam: { id: awayTeam.id, name: awayTeam.name, shortName: awayTeam.short_name },
      fdrHome: f.team_h_difficulty || 3,
      fdrAway: f.team_a_difficulty || 3,
      homePlayers,
      awayPlayers,
    });
  });

  return allProjections;
}

// --- Aggregate player projections into team-level stats ---
function aggregateTeamProjections(fixtureProjections) {
  const teamStats = {};

  fixtureProjections.forEach(fp => {
    // Home team
    if (!teamStats[fp.homeTeam.id]) {
      teamStats[fp.homeTeam.id] = {
        id: fp.homeTeam.id,
        name: fp.homeTeam.shortName,
        fullName: fp.homeTeam.name,
        totalGoals: 0,
        totalAssists: 0,
        totalCS: 0,
        totalBonus: 0,
        totalPoints: 0,
        playerCount: 0,
        topScorers: [],
      };
    }

    fp.homePlayers.forEach(p => {
      teamStats[fp.homeTeam.id].totalGoals += p.goals;
      teamStats[fp.homeTeam.id].totalAssists += p.assists;
      teamStats[fp.homeTeam.id].totalCS += p.csProb;
      teamStats[fp.homeTeam.id].totalBonus += p.bonus;
      teamStats[fp.homeTeam.id].totalPoints += p.totalPoints;
      teamStats[fp.homeTeam.id].playerCount++;
    });

    // Away team
    if (!teamStats[fp.awayTeam.id]) {
      teamStats[fp.awayTeam.id] = {
        id: fp.awayTeam.id,
        name: fp.awayTeam.shortName,
        fullName: fp.awayTeam.name,
        totalGoals: 0,
        totalAssists: 0,
        totalCS: 0,
        totalBonus: 0,
        totalPoints: 0,
        playerCount: 0,
        topScorers: [],
      };
    }

    fp.awayPlayers.forEach(p => {
      teamStats[fp.awayTeam.id].totalGoals += p.goals;
      teamStats[fp.awayTeam.id].totalAssists += p.assists;
      teamStats[fp.awayTeam.id].totalCS += p.csProb;
      teamStats[fp.awayTeam.id].totalBonus += p.bonus;
      teamStats[fp.awayTeam.id].totalPoints += p.totalPoints;
      teamStats[fp.awayTeam.id].playerCount++;
    });
  });

  // Round team totals
  Object.values(teamStats).forEach(t => {
    t.totalGoals = Math.round(t.totalGoals * 100) / 100;
    t.totalAssists = Math.round(t.totalAssists * 100) / 100;
    t.totalCS = Math.round(t.totalCS * 10) / 10;
    t.totalBonus = Math.round(t.totalBonus * 100) / 100;
    t.totalPoints = Math.round(t.totalPoints * 100) / 100;
  });

  return teamStats;
}

// --- Get top projected players across all fixtures ---
function getTopProjectedPlayers(fixtureProjections, options = {}) {
  const { limit = 30, position = null, sortBy = 'totalPoints' } = options;

  let allPlayers = [];
  fixtureProjections.forEach(fp => {
    allPlayers = allPlayers.concat(fp.homePlayers, fp.awayPlayers);
  });

  if (position) {
    const posMap = { GKP: 1, DEF: 2, MID: 3, FWD: 4 };
    const posId = posMap[position];
    if (posId) allPlayers = allPlayers.filter(p => p.element_type === posId || p.position === position);
  }

  // Sort by projected points
  allPlayers.sort((a, b) => (b[sortBy] || 0) - (a[sortBy] || 0));

  return allPlayers.slice(0, limit);
}

// --- Get top goal scorers ---
function getTopGoalScorers(fixtureProjections, limit = 20) {
  return getTopProjectedPlayers(fixtureProjections, { limit, sortBy: 'goals' });
}

// --- Get top assist providers ---
function getTopAssistProviders(fixtureProjections, limit = 20) {
  return getTopProjectedPlayers(fixtureProjections, { limit, sortBy: 'assists' });
}

// --- Get top clean sheet candidates ---
function getTopCleanSheetPlayers(fixtureProjections, limit = 20) {
  let allPlayers = [];
  fixtureProjections.forEach(fp => {
    allPlayers = allPlayers.concat(fp.homePlayers, fp.awayPlayers);
  });

  // Only DEF and GKP
  allPlayers = allPlayers.filter(p => p.position === 'DEF' || p.position === 'GKP');
  allPlayers.sort((a, b) => (b.csProb || 0) - (a.csProb || 0));

  return allPlayers.slice(0, limit);
}

// --- Multi-GW player projections ---
function projectMultiGWPlayers(teams, fixtures, elements, startGW, horizon, options = {}) {
  const teamStrengths = computeTeamStrengths(teams);
  const results = {};

  // Initialize player results
  elements.forEach(el => {
    if ((el.minutes || 0) === 0) return;
    results[el.id] = {
      id: el.id,
      name: el.web_name || el.first_name,
      team: teams.find(t => t.id === el.team)?.short_name || '???',
      teamId: el.team,
      position: ['GKP', 'DEF', 'MID', 'FWD'][el.element_type - 1] || 'MID',
      price: (el.now_cost || 50) / 10,
      totalGoals: 0,
      totalAssists: 0,
      totalCS: 0,
      totalBonus: 0,
      totalPoints: 0,
      gameweeks: [],
    };
  });

  for (let gw = startGW; gw < Math.min(startGW + horizon, 39); gw++) {
    const gwFixtures = fixtures.filter(f => f.event === gw);

    gwFixtures.forEach(f => {
      const homeTeam = teams.find(t => t.id === f.team_h);
      const awayTeam = teams.find(t => t.id === f.team_a);
      if (!homeTeam || !awayTeam) return;

      const { homePlayers, awayPlayers } = projectFixturePlayers(
        homeTeam, awayTeam, elements, teamStrengths, options
      );

      // Aggregate into player results
      [...homePlayers, ...awayPlayers].forEach(p => {
        if (!results[p.id]) return;
        results[p.id].totalGoals += p.goals;
        results[p.id].totalAssists += p.assists;
        results[p.id].totalCS += p.csProb;
        results[p.id].totalBonus += p.bonus;
        results[p.id].totalPoints += p.totalPoints;
        results[p.id].gameweeks.push({
          gw,
          opponent: p.team === homeTeam.short_name ? awayTeam.short_name : homeTeam.short_name,
          isHome: p.team === homeTeam.short_name,
          goals: p.goals,
          assists: p.assists,
          csProb: p.csProb,
          bonus: p.bonus,
          points: p.totalPoints,
        });
      });
    });
  }

  // Round totals and convert to array
  const playerArray = Object.values(results).map(p => ({
    ...p,
    totalGoals: Math.round(p.totalGoals * 100) / 100,
    totalAssists: Math.round(p.totalAssists * 100) / 100,
    totalCS: Math.round(p.totalCS * 10) / 10,
    totalBonus: Math.round(p.totalBonus * 100) / 100,
    totalPoints: Math.round(p.totalPoints * 100) / 100,
  }));

  // Sort by total points
  playerArray.sort((a, b) => b.totalPoints - a.totalPoints);

  return playerArray;
}

module.exports = {
  FPL_POINTS,
  computeTeamStrengths,
  opponentDefensiveModifier,
  opponentAttackingModifier,
  projectPlayerGoals,
  projectPlayerAssists,
  projectCleanSheet,
  projectBonusPoints,
  projectPlayerPoints,
  projectFixturePlayers,
  projectGameweekPlayers,
  aggregateTeamProjections,
  getTopProjectedPlayers,
  getTopGoalScorers,
  getTopAssistProviders,
  getTopCleanSheetPlayers,
  projectMultiGWPlayers,
};
