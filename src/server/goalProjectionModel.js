// src/server/goalProjectionModel.js
// Poisson/Dixon-Coles goal projection model
// Produces per-match expected goals, clean sheet probabilities, and multi-GW aggregates

// --- Poisson PMF ---
function poissonPMF(k, lambda) {
  if (lambda <= 0) return k === 0 ? 1 : 0;
  let logP = -lambda;
  for (let i = 1; i <= k; i++) logP += Math.log(lambda) - Math.log(i);
  return Math.exp(logP);
}

// --- Dixon-Coles tau correction for low scores (0-0, 1-0, 0-1, 1-1) ---
function tau(x, y, lambda, mu, rho) {
  if (x === 0 && y === 0) return 1 - lambda * mu * rho;
  if (x === 0 && y === 1) return 1 + lambda * rho;
  if (x === 1 && y === 0) return 1 + mu * rho;
  if (x === 1 && y === 1) return 1 - rho;
  return 1;
}

// --- Joint score probability P(home=x, away=y) ---
function jointProb(x, y, lambda, mu, rho) {
  return poissonPMF(x, lambda) * poissonPMF(y, mu) * tau(x, y, lambda, mu, rho);
}

// --- Compute full score matrix up to maxGoals ---
function scoreMatrix(lambda, mu, rho, maxGoals = 7) {
  const matrix = [];
  for (let x = 0; x <= maxGoals; x++) {
    const row = [];
    for (let y = 0; y <= maxGoals; y++) {
      row.push(jointProb(x, y, lambda, mu, rho));
    }
    matrix.push(row);
  }
  return matrix;
}

// --- Aggregate probabilities from score matrix ---
function aggregateProbs(matrix) {
  let homeWin = 0, draw = 0, awayWin = 0;
  let homeGoalsExp = 0, awayGoalsExp = 0;
  let bttsYes = 0, over25 = 0;
  const homeCleanSheet = matrix[0].reduce((s, p) => s + p, 0); // P(away=0)
  const awayCleanSheet = matrix.reduce((s, row) => s + row[0], 0); // P(home=0)

  for (let x = 0; x < matrix.length; x++) {
    for (let y = 0; y < matrix[x].length; y++) {
      const p = matrix[x][y];
      if (x > y) homeWin += p;
      else if (x === y) draw += p;
      else awayWin += p;
      homeGoalsExp += x * p;
      awayGoalsExp += y * p;
      if (x > 0 && y > 0) bttsYes += p;
      if (x + y > 2) over25 += p;
    }
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
    over25: Math.round(over25 * 100),
  };
}

// --- Team strength from FPL bootstrap ---
function teamAttackStrength(team, isHome) {
  const raw = isHome ? (team.strength_attack_home || 1100) : (team.strength_attack_away || 1100);
  return raw / 1100; // normalized around 1.0
}

function teamDefenceStrength(team, isHome) {
  const raw = isHome ? (team.strength_defence_home || 1100) : (team.strength_defence_away || 1100);
  return raw / 1100; // higher = stronger defense = fewer goals conceded
}

// --- Build team profiles from bootstrap data when Understat is unavailable ---
function buildBootstrapProfiles(teams) {
  const profiles = {};

  // Compute league-mean strengths to get relative deviations
  const meanAtkHome = teams.reduce((s, t) => s + (t.strength_attack_home || 1100), 0) / teams.length;
  const meanAtkAway = teams.reduce((s, t) => s + (t.strength_attack_away || 1100), 0) / teams.length;
  const meanDefHome = teams.reduce((s, t) => s + (t.strength_defence_home || 1100), 0) / teams.length;
  const meanDefAway = teams.reduce((s, t) => s + (t.strength_defence_away || 1100), 0) / teams.length;

  // PL baseline xG per match (home ~1.55, away ~1.15)
  const PL_XG_HOME = 1.55;
  const PL_XG_AWAY = 1.15;
  const PL_XGA_HOME = 1.15;
  const PL_XGA_AWAY = 1.55;

  // Amplification factor: small FPL strength differences → meaningful xG spread
  // FPL range is ~100 points. We want this to map to roughly ±0.6 xG
  const AMPLIFY = 0.006; // per strength point deviation

  teams.forEach(t => {
    const atkHome = t.strength_attack_home || 1100;
    const atkAway = t.strength_attack_away || 1100;
    const defHome = t.strength_defence_home || 1100;
    const defAway = t.strength_defence_away || 1100;

    // Relative deviation from mean, amplified
    const atkHomeDev = (atkHome - meanAtkHome) * AMPLIFY;
    const atkAwayDev = (atkAway - meanAtkAway) * AMPLIFY;
    const defHomeDev = (meanDefHome - defHome) * AMPLIFY; // inverted: strong defense = low xGA
    const defAwayDev = (meanDefAway - defAway) * AMPLIFY;

    profiles[t.short_name] = {
      name: t.short_name,
      // Attack: higher strength = more goals scored
      xG_home: Math.max(0.7, Math.min(2.4, PL_XG_HOME + atkHomeDev)),
      xG_away: Math.max(0.5, Math.min(2.0, PL_XG_AWAY + atkAwayDev)),
      // Defense: higher strength = fewer goals conceded (inverted)
      xGA_home: Math.max(0.6, Math.min(2.2, PL_XGA_HOME + defHomeDev)),
      xGA_away: Math.max(0.7, Math.min(2.4, PL_XGA_AWAY + defAwayDev)),
      // Defensive strength: 0 = leaky, 1 = solid
      defStrength: defHome / 2000,
    };
  });
  return profiles;
}

// --- Merge Understat data with FPL bootstrap data ---
function mergeProfiles(understatProfiles, teams) {
  const merged = {};
  const bootstrapProfiles = buildBootstrapProfiles(teams);

  teams.forEach(t => {
    const shortName = t.short_name;
    const understat = understatProfiles?.[t.name] || understatProfiles?.[shortName] || null;
    const bootstrap = bootstrapProfiles[shortName];

    if (understat && bootstrap) {
      // Blend: 60% Understat (more current), 40% FPL bootstrap (more stable)
      merged[shortName] = {
        name: shortName,
        fullName: t.name,
        xG_home: understat.last10?.xg ? understat.last10.xg * 1.12 : bootstrap.xG_home,
        xG_away: understat.last10?.xg ? understat.last10.xg * 0.88 : bootstrap.xG_away,
        xGA_home: understat.last10?.xga ? understat.last10.xga * 0.95 : bootstrap.xGA_home,
        xGA_away: understat.last10?.xga ? understat.last10.xga * 1.08 : bootstrap.xGA_away,
        defStrength: understat.last10?.csRate != null
          ? understat.last10.csRate * 0.6 + bootstrap.defStrength * 0.4
          : bootstrap.defStrength,
        csRate: understat.last10?.csRate || 0.25,
        goalsScored90: understat.last10?.gf || 1.3,
        goalsConceded90: understat.last10?.ga || 1.3,
        // Rolling form (last 5)
        xG_last5: understat.last5?.xg || understat.last10?.xg || bootstrap.xG_home,
        xGA_last5: understat.last5?.xga || understat.last10?.xga || bootstrap.xGA_home,
        gf_last5: understat.last5?.gf || 1.3,
        ga_last5: understat.last5?.ga || 1.3,
        winRate: understat.last10?.wins ? understat.last10.wins / understat.last10.matches : 0.33,
        source: 'understat+bootstrap',
      };
    } else {
      merged[shortName] = { ...bootstrap, fullName: t.name, source: 'bootstrap' };
    }
  });

  return merged;
}

// --- Core: Compute expected goals for a single fixture ---
function computeMatchXG(homeProfile, awayProfile, options = {}) {
  const { rho = -0.10, homeAdvantage = 1.12 } = options;

  // Blend attack and defense ratings
  const homeAttack = homeProfile.xG_home || 1.45;
  const awayDefence = awayProfile.xGA_away || 1.40;
  const awayAttack = awayProfile.xG_away || 1.15;
  const homeDefence = homeProfile.xGA_home || 1.30;

  // Poisson lambda: expected goals
  // Home xG = f(home_attack, away_defence) * home_advantage
  const lambda = Math.max(0.25, Math.min(4.0,
    ((homeAttack * 0.55) + (awayDefence * 0.45)) * homeAdvantage
  ));

  // Away xG = f(away_attack, home_defence) / home_advantage
  const mu = Math.max(0.15, Math.min(3.5,
    ((awayAttack * 0.55) + (homeDefence * 0.45)) / homeAdvantage
  ));

  return { lambda: Math.round(lambda * 100) / 100, mu: Math.round(mu * 100) / 100 };
}

// --- Full match projection including Dixon-Coles ---
function projectMatch(homeTeam, awayTeam, profiles, options = {}) {
  const homeProfile = profiles[homeTeam.short_name] || profiles[homeTeam.name];
  const awayProfile = profiles[awayTeam.short_name] || profiles[awayTeam.name];

  if (!homeProfile || !awayProfile) {
    return null;
  }

  const { lambda, mu } = computeMatchXG(homeProfile, awayProfile, options);
  const rho = options.rho || -0.10;
  const matrix = scoreMatrix(lambda, mu, rho);
  const probs = aggregateProbs(matrix);

  return {
    homeTeam: homeTeam.short_name,
    awayTeam: awayTeam.short_name,
    homeTeamFull: homeTeam.name,
    awayTeamFull: awayTeam.name,
    homeXG: lambda,
    awayXG: mu,
    ...probs,
    matrix,
  };
}

// --- Multi-GW projection for all teams ---
function projectMultiGW(teams, fixtures, profiles, startGW, horizon, options = {}) {
  const results = {};

  teams.forEach(t => {
    results[t.short_name] = {
      teamId: t.id,
      teamName: t.short_name,
      teamFullName: t.name,
      gameweeks: [],
      totalXG: 0,
      totalXGA: 0,
      totalCS: 0,
      avgXG: 0,
      avgXGA: 0,
      avgCS: 0,
    };
  });

  for (let gw = startGW; gw < Math.min(startGW + horizon, 39); gw++) {
    const gwFixtures = fixtures.filter(f => f.event === gw);

    gwFixtures.forEach(fixture => {
      const homeTeam = teams.find(t => t.id === fixture.team_h);
      const awayTeam = teams.find(t => t.id === fixture.team_a);
      if (!homeTeam || !awayTeam) return;

      const projection = projectMatch(homeTeam, awayTeam, profiles, options);
      if (!projection) return;

      // Home team
      if (results[homeTeam.short_name]) {
        results[homeTeam.short_name].gameweeks.push({
          gw,
          opponent: awayTeam.short_name,
          opponentFull: awayTeam.name,
          isHome: true,
          xg: projection.homeXG,
          xga: projection.awayXG,
          csPct: projection.homeCleanSheet,
          fdr: fixture.team_h_difficulty || 3,
          winPct: projection.homeWin,
          bttsPct: projection.bttsYes,
        });
        results[homeTeam.short_name].totalXG += projection.homeXG;
        results[homeTeam.short_name].totalXGA += projection.awayXG;
        results[homeTeam.short_name].totalCS += projection.homeCleanSheet;
      }

      // Away team
      if (results[awayTeam.short_name]) {
        results[awayTeam.short_name].gameweeks.push({
          gw,
          opponent: homeTeam.short_name,
          opponentFull: homeTeam.name,
          isHome: false,
          xg: projection.awayXG,
          xga: projection.homeXG,
          csPct: projection.awayCleanSheet,
          fdr: fixture.team_a_difficulty || 3,
          winPct: projection.awayWin,
          bttsPct: projection.bttsYes,
        });
        results[awayTeam.short_name].totalXG += projection.awayXG;
        results[awayTeam.short_name].totalXGA += projection.homeXG;
        results[awayTeam.short_name].totalCS += projection.awayCleanSheet;
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
    team.totalCS = Math.round(team.totalCS * 10) / 10;
  });

  return results;
}

// --- Rolling FDR (average difficulty over N gameweeks) ---
function computeRollingFDR(teams, fixtures, startGW, window) {
  const results = {};

  teams.forEach(t => {
    const teamFixtures = [];
    for (let gw = startGW; gw < Math.min(startGW + window, 39); gw++) {
      const fx = fixtures.find(f => f.event === gw && (f.team_h === t.id || f.team_a === t.id));
      if (fx) {
        const fdr = fx.team_h === t.id ? (fx.team_h_difficulty || 3) : (fx.team_a_difficulty || 3);
        const isHome = fx.team_h === t.id;
        const oppId = isHome ? fx.team_a : fx.team_h;
        teamFixtures.push({ gw, fdr, isHome, oppId });
      }
    }
    const avgFDR = teamFixtures.length > 0
      ? teamFixtures.reduce((s, f) => s + f.fdr, 0) / teamFixtures.length
      : 3;
    results[t.id] = {
      teamName: t.short_name,
      window,
      fixturesPlayed: teamFixtures.length,
      avgFDR: Math.round(avgFDR * 100) / 100,
      sumFDR: teamFixtures.reduce((s, f) => s + f.fdr, 0),
      fixtures: teamFixtures,
    };
  });

  return results;
}

// --- Rolling form: recent goals scored/conceded trends ---
function computeRollingForm(teams, fixtures, profiles, startGW, window) {
  const results = {};

  teams.forEach(t => {
    const profile = profiles[t.short_name] || {};
    const recentGF = profile.gf_last5 || profile.goalsScored90 || 1.3;
    const recentGA = profile.ga_last5 || profile.goalsConceded90 || 1.3;
    const recentXG = profile.xG_last5 || profile.xG_home || 1.3;
    const recentXGA = profile.xGA_last5 || profile.xGA_home || 1.3;

    results[t.id] = {
      teamName: t.short_name,
      recentGFPerMatch: Math.round(recentGF * 100) / 100,
      recentGAPerMatch: Math.round(recentGA * 100) / 100,
      recentXGPerMatch: Math.round(recentXG * 100) / 100,
      recentXGAPerMatch: Math.round(recentXGA * 100) / 100,
      attackingForm: Math.round((recentXG / 1.3) * 100) / 100, // relative to league avg ~1.3
      defensiveForm: Math.round((1.3 / recentXGA) * 100) / 100, // higher = better defense
    };
  });

  return results;
}

module.exports = {
  poissonPMF,
  tau,
  jointProb,
  scoreMatrix,
  aggregateProbs,
  computeMatchXG,
  projectMatch,
  projectMultiGW,
  computeRollingFDR,
  computeRollingForm,
  buildBootstrapProfiles,
  mergeProfiles,
};
