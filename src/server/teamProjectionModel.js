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

// --- Team strength ratings derived from historical xG data + current season results ---
// α = attack strength (positive = scores more)
// β = defense weakness (positive = concedes more)
// Derived by log-transforming per-game xG and centering around league average

const HOME_ADVANTAGE = 0.22; // log-scale home advantage (~1.25x multiplier)
const RHO = -0.13; // Dixon-Coles low-score dependence parameter

// Historical baseline xG data (used as prior, blended with current season results)
// These represent a multi-year average of team attacking/defensive output
const HISTORICAL_XG_DATA = {
  'LIV': { xG: 2.10, xGA: 1.05 },
  'ARS': { xG: 1.72, xGA: 1.00 },
  'MCI': { xG: 1.95, xGA: 1.15 },
  'CHE': { xG: 1.75, xGA: 1.25 },
  'NEW': { xG: 1.65, xGA: 1.20 },
  'BOU': { xG: 1.55, xGA: 1.30 },
  'BHA': { xG: 1.55, xGA: 1.40 },
  'CRY': { xG: 1.45, xGA: 1.30 },
  'AVL': { xG: 1.55, xGA: 1.30 },
  'BRE': { xG: 1.50, xGA: 1.40 },
  'FUL': { xG: 1.35, xGA: 1.30 },
  'NFO': { xG: 1.25, xGA: 1.30 },
  'TOT': { xG: 1.60, xGA: 1.55 },
  'MUN': { xG: 1.50, xGA: 1.40 },
  'WHU': { xG: 1.30, xGA: 1.45 },
  'EVE': { xG: 1.20, xGA: 1.30 },
  'WOL': { xG: 1.25, xGA: 1.45 },
  'LEE': { xG: 1.10, xGA: 1.50 },
  'SUN': { xG: 1.00, xGA: 1.50 },
  'COV': { xG: 0.95, xGA: 1.55 },
  'IPS': { xG: 0.90, xGA: 1.60 },
  'HUL': { xG: 0.85, xGA: 1.65 },
};

// Compute current season actual stats from completed FPL fixtures
function computeCurrentSeasonStats(teams, fixtures) {
  const current = {};
  const currentGW = fixtures.reduce((max, f) => f.finished ? Math.max(max, f.event) : max, 0);

  teams.forEach(t => {
    current[t.short_name] = {
      goalsFor: 0, goalsAgainst: 0,
      homeGF: 0, homeGA: 0, homeGames: 0,
      awayGF: 0, awayGA: 0, awayGames: 0,
      cleanSheets: 0, totalGames: 0,
      points: 0,
    };
  });

  const finished = fixtures.filter(f => f.finished && f.team_h_score != null);

  finished.forEach(f => {
    const home = teams.find(t => t.id === f.team_h);
    const away = teams.find(t => t.id === f.team_a);
    if (!home || !away) return;
    const hs = current[home.short_name];
    const as = current[away.short_name];
    if (!hs || !as) return;

    hs.goalsFor += f.team_h_score;
    hs.goalsAgainst += f.team_a_score;
    hs.homeGF += f.team_h_score;
    hs.homeGA += f.team_a_score;
    hs.homeGames++;
    hs.totalGames++;
    if (f.team_a_score === 0) hs.cleanSheets++;
    if (f.team_h_score > f.team_a_score) hs.points += 3;
    else if (f.team_h_score === f.team_a_score) hs.points += 1;

    as.goalsFor += f.team_a_score;
    as.goalsAgainst += f.team_h_score;
    as.awayGF += f.team_a_score;
    as.awayGA += f.team_h_score;
    as.awayGames++;
    as.totalGames++;
    if (f.team_h_score === 0) as.cleanSheets++;
    if (f.team_a_score > f.team_h_score) as.points += 3;
    else if (f.team_a_score === f.team_h_score) as.points += 1;
  });

  return { stats: current, currentGW, gamesPlayed: finished.length };
}

// Promoted teams this season (use historical baseline much longer)
const PROMOTED_TEAMS = new Set(['LEE', 'SUN', 'COV', 'IPS', 'HUL']);

// Minimum matches per team before current season data starts blending in
const MIN_MATCHES_FOR_BLEND = 5;

// Compute blend weight for current season data
// Requires MIN_MATCHES_FOR_BLEND per team before any blending kicks in
// Then ramps slowly: 10 matches → ~15%, 19 → ~30%, 38 → ~50%
function getCurrentSeasonWeight(gamesPlayed) {
  if (gamesPlayed < MIN_MATCHES_FOR_BLEND) return 0;
  // Very slow ramp: only 50% influence at end of a full season
  const adjusted = gamesPlayed - MIN_MATCHES_FOR_BLEND;
  const raw = 0.55 * (1 - Math.exp(-0.04 * adjusted));
  return Math.min(0.55, Math.max(0, raw));
}

// Promoted teams get a reduced blend weight (1 match means nothing)
function getTeamBlendWeight(gamesPlayed, teamShortName) {
  const base = getCurrentSeasonWeight(gamesPlayed);
  if (PROMOTED_TEAMS.has(teamShortName)) {
    // Promoted teams need 8+ matches before blending, cap at 35%
    if (gamesPlayed < 8) return 0;
    return Math.min(0.35, base * 0.6);
  }
  return base;
}

// Build blended team ratings from historical + current season data + H2H adjustments
function computeTeamRatings(teams, fixtures) {
  const ratings = {};
  const { stats, currentGW, gamesPlayed } = computeCurrentSeasonStats(teams || [], fixtures || []);

  // Compute league-average actual stats for centering
  const teamNames = Object.keys(stats);
  const avgGFPG = teamNames.length > 0
    ? teamNames.reduce((s, n) => s + (stats[n].totalGames > 0 ? stats[n].goalsFor / stats[n].totalGames : 1.38), 0) / teamNames.length
    : 1.38;
  const avgGAPG = teamNames.length > 0
    ? teamNames.reduce((s, n) => s + (stats[n].totalGames > 0 ? stats[n].goalsAgainst / stats[n].totalGames : 1.38), 0) / teamNames.length
    : 1.38;
  const leagueAvg = (avgGFPG + avgGAPG) / 2 || 1.38;

  // For each team, blend historical baseline with current season actuals
  for (const shortName of Object.keys(HISTORICAL_XG_DATA)) {
    const hist = HISTORICAL_XG_DATA[shortName];
    const cur = stats[shortName];
    const teamGames = cur ? cur.totalGames : 0;
    const teamWeight = getTeamBlendWeight(teamGames, shortName);
    const historicalWeight = 1 - teamWeight;

    let xG, xGA;

    if (teamGames >= MIN_MATCHES_FOR_BLEND && teamWeight > 0) {
      // Current season actual goals per game (home/away weighted)
      const homeGFPG = cur.homeGames > 0 ? cur.homeGF / cur.homeGames : hist.xG * 0.55;
      const awayGFPG = cur.awayGames > 0 ? cur.awayGF / cur.awayGames : hist.xG * 0.45;
      const homeGAPG = cur.homeGames > 0 ? cur.homeGA / cur.homeGames : hist.xGA * 0.45;
      const awayGAPG = cur.awayGames > 0 ? cur.awayGA / cur.awayGames : hist.xGA * 0.55;

      const curXG = (homeGFPG + awayGFPG) / 2;
      const curXGA = (homeGAPG + awayGAPG) / 2;

      xG = hist.xG * historicalWeight + curXG * teamWeight;
      xGA = hist.xGA * historicalWeight + curXGA * teamWeight;
    } else {
      // Not enough matches yet — use historical only
      xG = hist.xG;
      xGA = hist.xGA;
    }

    // Clamp to reasonable PL bounds
    xG = Math.max(0.6, Math.min(3.0, xG));
    xGA = Math.max(0.6, Math.min(3.0, xGA));

    // Compute Dixon-Coles alpha/beta
    const alpha = Math.log(xG / leagueAvg);
    const beta = Math.log(xGA / leagueAvg);

    ratings[shortName] = {
      alpha, beta,
      xG: Math.round(xG * 100) / 100,
      xGA: Math.round(xGA * 100) / 100,
      currentWeight: Math.round(teamWeight * 100),
      source: teamGames >= MIN_MATCHES_FOR_BLEND && teamWeight > 0 ? 'blended' : 'historical',
      promoted: PROMOTED_TEAMS.has(shortName),
    };
  }

  return { ratings, gamesPlayed, currentGW };
}

// --- H2H historical matchup adjustments (avg goal diff over last 3 seasons) ---
// Positive = home team scores more on average against this opponent
// Negative = home team scores less on average against this opponent
const H2H_ADJUSTMENTS = {
  'LIV-ARS': 0.15, 'ARS-LIV': -0.10, 'LIV-MCI': 0.20, 'MCI-LIV': -0.15,
  'LIV-CHE': 0.25, 'CHE-LIV': -0.15, 'LIV-EVE': 0.35, 'EVE-LIV': -0.30,
  'LIV-TOT': 0.20, 'TOT-LIV': -0.15, 'LIV-MUN': 0.30, 'MUN-LIV': -0.20,
  'ARS-MCI': 0.10, 'MCI-ARS': -0.05, 'ARS-CHE': 0.15, 'CHE-ARS': -0.10,
  'ARS-TOT': 0.20, 'TOT-ARS': -0.15, 'ARS-MUN': 0.20, 'MUN-ARS': -0.15,
  'MCI-CHE': 0.15, 'CHE-MCI': -0.10, 'MCI-TOT': 0.25, 'TOT-MCI': -0.20,
  'MCI-NEW': 0.20, 'NEW-MCI': -0.15, 'MCI-AVL': 0.15, 'AVL-MCI': -0.10,
  'CHE-TOT': 0.10, 'TOT-CHE': -0.05, 'CHE-BHA': 0.15, 'BHA-CHE': -0.10,
  'NEW-TOT': 0.15, 'TOT-NEW': -0.10, 'NEW-BHA': 0.10, 'BHA-NEW': -0.05,
  'AVL-CHE': 0.05, 'CHE-AVL': 0.00, 'AVL-TOT': 0.10, 'TOT-AVL': -0.05,
  'BRE-ARS': -0.15, 'ARS-BRE': 0.20, 'BRE-MCI': -0.20, 'MCI-BRE': 0.25,
  'BOU-LIV': -0.10, 'LIV-BOU': 0.15, 'BOU-ARS': -0.10, 'ARS-BOU': 0.15,
  'CRY-LIV': -0.15, 'LIV-CRY': 0.20, 'CRY-ARS': -0.15, 'ARS-CRY': 0.20,
  'FUL-LIV': -0.15, 'LIV-FUL': 0.20, 'FUL-ARS': -0.10, 'ARS-FUL': 0.15,
  'NFO-LIV': -0.10, 'LIV-NFO': 0.15, 'NFO-ARS': -0.10, 'ARS-NFO': 0.15,
  'WHU-LIV': -0.10, 'LIV-WHU': 0.15, 'WHU-ARS': -0.10, 'ARS-WHU': 0.15,
  'WOL-LIV': -0.10, 'LIV-WOL': 0.15, 'WOL-ARS': -0.10, 'ARS-WOL': 0.15,
  'EVE-LIV': -0.30, 'LIV-EVE': 0.35, 'EVE-ARS': -0.10, 'ARS-EVE': 0.15,
  'LEE-LIV': -0.10, 'LIV-LEE': 0.15, 'LEE-ARS': -0.10, 'ARS-LEE': 0.15,
  'SUN-LIV': -0.10, 'LIV-SUN': 0.15, 'SUN-ARS': -0.10, 'ARS-SUN': 0.15,
  'FUL-CRY': 0.05, 'CRY-FUL': -0.05, 'BOU-BRE': 0.05, 'BRE-BOU': -0.05,
  'WHU-EVE': 0.10, 'EVE-WHU': -0.05, 'NFO-WOL': 0.10, 'WOL-NFO': -0.05,
  'EVE-WOL': 0.10, 'WOL-EVE': -0.05, 'BRE-NFO': 0.05, 'NFO-BRE': -0.05,
  'TOT-WOL': 0.15, 'WOL-TOT': -0.10, 'TOT-BRE': 0.15, 'BRE-TOT': -0.10,
  'MUN-WOL': 0.15, 'WOL-MUN': -0.10, 'MUN-TOT': 0.10, 'TOT-MUN': 0.00,
};

function getH2HAdjustment(homeTeam, awayTeam) {
  const key = `${homeTeam}-${awayTeam}`;
  return H2H_ADJUSTMENTS[key] || 0;
}

// --- Compute match expected goals using Dixon-Coles formula + H2H ---
function computeMatchXG(homeTeam, awayTeam, ratings) {
  const home = ratings[homeTeam];
  const away = ratings[awayTeam];

  if (!home || !away) {
    return { homeXG: 1.4, awayXG: 1.2, source: 'default' };
  }

  // λ = exp(α_home + β_away + γ)  — home team expected goals
  // μ = exp(α_away + β_home)       — away team expected goals
  const h2h = getH2HAdjustment(homeTeam, awayTeam);
  const h2hAway = getH2HAdjustment(awayTeam, homeTeam);

  const lambda = Math.exp(home.alpha + away.beta + HOME_ADVANTAGE + h2h * 0.3);
  const mu = Math.exp(away.alpha + home.beta + h2hAway * 0.3);

  return {
    homeXG: Math.round(lambda * 100) / 100,
    awayXG: Math.round(mu * 100) / 100,
    source: 'dixon-coles+h2h',
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
  const { ratings } = computeTeamRatings(teams, fixtures);

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
  const { ratings } = computeTeamRatings(teams, fixtures);
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
  computeCurrentSeasonStats,
  getCurrentSeasonWeight,
  getTeamBlendWeight,
  computeMatchXG,
  computeMatchProbs,
  projectFixture,
  projectGameweek,
  projectMultiGWTeams,
  HISTORICAL_XG_DATA,
  H2H_ADJUSTMENTS,
  PROMOTED_TEAMS,
  MIN_MATCHES_FOR_BLEND,
  HOME_ADVANTAGE,
  RHO,
};
