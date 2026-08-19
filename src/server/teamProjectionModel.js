// src/server/teamProjectionModel.js
// Proper Dixon-Coles team projection model using historical xG data
// Produces per-match expected goals, clean sheet probabilities, win/draw/away probs

// --- Poisson PMF ---
function poissonPMF(k, lambda) {
  if (lambda <= 0) return k === 0 ? 1 : 0;
  let logP = -lambda;
  for (let i = 1; i <= k; i++) logP += Math.log(lambda) - Math.log(i);
  return Math.exp(logP);
}

// --- Dixon-Coles tau correction ---
function tau(x, y, lambda, mu, rho) {
  if (x === 0 && y === 0) return 1 - lambda * mu * rho;
  if (x === 0 && y === 1) return 1 + lambda * rho;
  if (x === 1 && y === 0) return 1 + mu * rho;
  if (x === 1 && y === 1) return 1 - rho;
  return 1;
}

// --- Team strength ratings derived from 2024-25 xG data ---
// α = attack strength (positive = scores more)
// β = defense weakness (positive = concedes more)
// Derived by log-transforming per-game xG and centering around league average

const LEAGUE_AVG_XG = 1.38; // 2024-25 PL average xG per team per game
const HOME_ADVANTAGE = 0.22; // log-scale home advantage (~1.25x multiplier)
const RHO = -0.13; // Dixon-Coles low-score dependence parameter

// 2024-25 PL xG data (per game)
const TEAM_XG_DATA = {
  'LIV': { xG: 2.24, xGA: 1.00 },
  'ARS': { xG: 1.66, xGA: 0.92 },
  'MCI': { xG: 1.85, xGA: 1.31 },
  'CHE': { xG: 1.81, xGA: 1.30 },
  'NEW': { xG: 1.75, xGA: 1.24 },
  'BOU': { xG: 1.77, xGA: 1.31 },
  'BHA': { xG: 1.59, xGA: 1.46 },
  'CRY': { xG: 1.63, xGA: 1.34 },
  'AVL': { xG: 1.51, xGA: 1.31 },
  'BRE': { xG: 1.62, xGA: 1.49 },
  'FUL': { xG: 1.33, xGA: 1.29 },
  'NFO': { xG: 1.23, xGA: 1.32 },
  'TOT': { xG: 1.57, xGA: 1.75 },
  'MUN': { xG: 1.43, xGA: 1.47 },
  'WHU': { xG: 1.24, xGA: 1.59 },
  'EVE': { xG: 1.10, xGA: 1.26 },
  'WOL': { xG: 1.18, xGA: 1.55 },
  'LEE': { xG: 1.02, xGA: 1.45 }, // promoted
  'SUN': { xG: 0.94, xGA: 1.53 }, // promoted
  'COV': { xG: 0.85, xGA: 1.60 }, // promoted
  'IPS': { xG: 0.79, xGA: 1.68 }, // promoted
  'HUL': { xG: 0.77, xGA: 1.72 }, // promoted
};

// Compute attack/defense ratings from xG data
function computeTeamRatings() {
  const ratings = {};

  for (const [shortName, data] of Object.entries(TEAM_XG_DATA)) {
    // α = log(xG / league_avg) — positive means above average attack
    const alpha = Math.log(data.xG / LEAGUE_AVG_XG);
    // β = log(xGA / league_avg) — positive means above average defense weakness
    const beta = Math.log(data.xGA / LEAGUE_AVG_XG);

    ratings[shortName] = { alpha, beta, xG: data.xG, xGA: data.xGA };
  }

  return ratings;
}

// --- Compute match expected goals using Dixon-Coles formula ---
function computeMatchXG(homeTeam, awayTeam, ratings) {
  const home = ratings[homeTeam];
  const away = ratings[awayTeam];

  if (!home || !away) {
    return { homeXG: 1.4, awayXG: 1.2, source: 'default' };
  }

  // λ = exp(α_home + β_away + γ)  — home team expected goals
  // μ = exp(α_away + β_home)       — away team expected goals
  const lambda = Math.exp(home.alpha + away.beta + HOME_ADVANTAGE);
  const mu = Math.exp(away.alpha + home.beta);

  return {
    homeXG: Math.round(lambda * 100) / 100,
    awayXG: Math.round(mu * 100) / 100,
    source: 'dixon-coles',
  };
}

// --- Compute full score matrix and aggregate probabilities ---
function computeMatchProbs(lambda, mu, rho = RHO, maxGoals = 8) {
  const matrix = [];
  let homeWin = 0, draw = 0, awayWin = 0;
  let bttsYes = 0, over25 = 0, over15 = 0, over35 = 0;
  let homeCleanSheet = 0, awayCleanSheet = 0;
  let homeGoalsExp = 0, awayGoalsExp = 0;

  for (let x = 0; x <= maxGoals; x++) {
    const row = [];
    for (let y = 0; y <= maxGoals; y++) {
      const p = poissonPMF(x, lambda) * poissonPMF(y, mu) * tau(x, y, lambda, mu, rho);
      row.push(p);

      if (x > y) homeWin += p;
      else if (x === y) draw += p;
      else awayWin += p;

      if (x > 0 && y > 0) bttsYes += p;
      if (x + y > 2) over25 += p;
      if (x + y > 1) over15 += p;
      if (x + y > 3) over35 += p;
      if (y === 0) homeCleanSheet += p;
      if (x === 0) awayCleanSheet += p;

      homeGoalsExp += x * p;
      awayGoalsExp += y * p;
    }
    matrix.push(row);
  }

  return {
    homeWin: Math.round(homeWin * 1000) / 10,
    draw: Math.round(draw * 1000) / 10,
    awayWin: Math.round(awayWin * 1000) / 10,
    homeCleanSheet: Math.round(homeCleanSheet * 100),
    awayCleanSheet: Math.round(awayCleanSheet * 100),
    homeGoals: Math.round(homeGoalsExp * 100) / 100,
    awayGoals: Math.round(awayGoalsExp * 100) / 100,
    bttsYes: Math.round(bttsYes * 100),
    over15: Math.round(over15 * 100),
    over25: Math.round(over25 * 100),
    over35: Math.round(over35 * 100),
    matrix,
  };
}

// --- Project a single fixture ---
function projectFixture(homeTeam, awayTeam, ratings) {
  const { homeXG, awayXG, source } = computeMatchXG(homeTeam, awayTeam, ratings);
  const probs = computeMatchProbs(homeXG, awayXG);

  return {
    homeTeam,
    awayTeam,
    homeXG,
    awayXG,
    source,
    ...probs,
  };
}

// --- Project all fixtures for a gameweek ---
function projectGameweek(fixtures, teams, teamIdMap) {
  const ratings = computeTeamRatings();

  return fixtures.map(f => {
    const homeTeam = teamIdMap[f.team_h] || '???';
    const awayTeam = teamIdMap[f.team_a] || '???';

    const proj = projectFixture(homeTeam, awayTeam, ratings);

    return {
      fixtureId: f.id,
      gw: f.event,
      kickoff: f.kickoff_time,
      fdrHome: f.team_h_difficulty || 3,
      fdrAway: f.team_a_difficulty || 3,
      ...proj,
    };
  });
}

// --- Multi-GW team projections ---
function projectMultiGWTeams(teams, fixtures, teamIdMap, startGW, horizon) {
  const ratings = computeTeamRatings();
  const results = {};

  // Initialize
  teams.forEach(t => {
    results[t.short_name] = {
      teamId: t.id,
      teamName: t.short_name,
      teamFullName: t.name,
      gameweeks: [],
      totalXG: 0,
      totalXGA: 0,
      totalCS: 0,
      totalWinPct: 0,
      avgXG: 0,
      avgXGA: 0,
      avgCS: 0,
    };
  });

  for (let gw = startGW; gw < Math.min(startGW + horizon, 39); gw++) {
    const gwFixtures = fixtures.filter(f => f.event === gw);

    gwFixtures.forEach(f => {
      const homeTeam = teamIdMap[f.team_h];
      const awayTeam = teamIdMap[f.team_a];
      if (!homeTeam || !awayTeam) return;

      const proj = projectFixture(homeTeam, awayTeam, ratings);

      if (results[homeTeam]) {
        results[homeTeam].gameweeks.push({
          gw,
          opponent: awayTeam,
          isHome: true,
          xg: proj.homeXG,
          xga: proj.awayXG,
          csPct: proj.homeCleanSheet,
          winPct: proj.homeWin,
          fdr: f.team_h_difficulty || 3,
        });
        results[homeTeam].totalXG += proj.homeXG;
        results[homeTeam].totalXGA += proj.awayXG;
        results[homeTeam].totalCS += proj.homeCleanSheet;
        results[homeTeam].totalWinPct += proj.homeWin;
      }

      if (results[awayTeam]) {
        results[awayTeam].gameweeks.push({
          gw,
          opponent: homeTeam,
          isHome: false,
          xg: proj.awayXG,
          xga: proj.homeXG,
          csPct: proj.awayCleanSheet,
          winPct: proj.awayWin,
          fdr: f.team_a_difficulty || 3,
        });
        results[awayTeam].totalXG += proj.awayXG;
        results[awayTeam].totalXGA += proj.homeXG;
        results[awayTeam].totalCS += proj.awayCleanSheet;
        results[awayTeam].totalWinPct += proj.awayWin;
      }
    });
  }

  // Compute averages
  Object.values(results).forEach(team => {
    const count = team.gameweeks.length || 1;
    team.avgXG = Math.round((team.totalXG / count) * 100) / 100;
    team.avgXGA = Math.round((team.totalXGA / count) * 100) / 100;
    team.avgCS = Math.round((team.totalCS / count) * 10) / 10;
    team.totalXG = Math.round(team.totalXG * 100) / 100;
    team.totalXGA = Math.round(team.totalXGA * 100) / 100;
    team.totalCS = Math.round(team.totalCS) / 10;
  });

  return results;
}

module.exports = {
  poissonPMF,
  tau,
  computeTeamRatings,
  computeMatchXG,
  computeMatchProbs,
  projectFixture,
  projectGameweek,
  projectMultiGWTeams,
  TEAM_XG_DATA,
  LEAGUE_AVG_XG,
  HOME_ADVANTAGE,
  RHO,
};
