// src/server/teamStrengthData.js
// Hard-coded PL team strength ratings from 2024-25 xG data
// Source: xgstat.com, StatMuse (Opta data)
// Used when FPL bootstrap strengths are all 0 (GW1 of new season)

// Per-game xG and xGA from 2024-25 season
// xG = expected goals scored per game
// xGA = expected goals conceded per game
const TEAM_XG_2024_25 = {
  'LIV': { xG: 2.24, xGA: 1.00, name: 'Liverpool' },
  'ARS': { xG: 1.66, xGA: 0.92, name: 'Arsenal' },
  'MCI': { xG: 1.85, xGA: 1.31, name: 'Man City' },
  'CHE': { xG: 1.81, xGA: 1.30, name: 'Chelsea' },
  'NEW': { xG: 1.75, xGA: 1.24, name: 'Newcastle' },
  'BOU': { xG: 1.77, xGA: 1.31, name: 'Bournemouth' },
  'BHA': { xG: 1.59, xGA: 1.46, name: 'Brighton' },
  'CRY': { xG: 1.63, xGA: 1.34, name: 'Crystal Palace' },
  'AVL': { xG: 1.51, xGA: 1.31, name: 'Aston Villa' },
  'BRE': { xG: 1.62, xGA: 1.49, name: 'Brentford' },
  'FUL': { xG: 1.33, xGA: 1.29, name: 'Fulham' },
  'NFO': { xG: 1.23, xGA: 1.32, name: "Nott'm Forest" },
  'TOT': { xG: 1.57, xGA: 1.75, name: 'Tottenham' },
  'MUN': { xG: 1.43, xGA: 1.47, name: 'Man Utd' },
  'WHU': { xG: 1.24, xGA: 1.59, name: 'West Ham' },
  'EVE': { xG: 1.10, xGA: 1.26, name: 'Everton' },
  'WOL': { xG: 1.18, xGA: 1.55, name: 'Wolves' },
  // Promoted teams (Championship 2024-25, adjusted for PL step-up ~0.85x)
  'LEE': { xG: 1.02, xGA: 1.45, name: 'Leeds' },
  'SUN': { xG: 0.94, xGA: 1.53, name: 'Sunderland' },
  'COV': { xG: 0.85, xGA: 1.60, name: 'Coventry' },
  'IPS': { xG: 0.79, xGA: 1.68, name: 'Ipswich' },
  'HUL': { xG: 0.77, xGA: 1.72, name: 'Hull' },
};

// Home/away split: PL average is ~57% of goals at home
const HOME_ATTACK_SHARE = 0.58;
const HOME_DEFENSE_SHARE = 0.55; // home teams concede slightly less

// Get team xG adjusted for home/away
function getTeamXG(shortName, isHome) {
  const team = TEAM_XG_2024_25[shortName];
  if (!team) {
    // Default for unknown teams (shouldn't happen)
    return { xG: 1.35, xGA: 1.35 };
  }

  if (isHome) {
    return {
      xG: team.xG * HOME_ATTACK_SHARE * 2, // home attack
      xGA: team.xGA * (1 - HOME_DEFENSE_SHARE) * 2, // home defense (concede less)
    };
  } else {
    return {
      xG: team.xG * (1 - HOME_ATTACK_SHARE) * 2, // away attack
      xGA: team.xGA * HOME_DEFENSE_SHARE * 2, // away defense (concede more)
    };
  }
}

// Get fixture expected goals (home team xG vs away team defense)
function getFixtureXG(homeShort, awayShort) {
  const homeXG = getTeamXG(homeShort, true);
  const awayXG = getTeamXG(awayShort, false);

  // Expected goals = team attack * opponent defense factor
  // Use harmonic mean approach: goals = f(home_attack, away_defense)
  const homeExpectedGoals = (homeXG.xG * 0.55) + (awayXG.xGA * 0.45);
  const awayExpectedGoals = (awayXG.xG * 0.55) + (homeXG.xGA * 0.45);

  return {
    homeGoals: Math.round(homeExpectedGoals * 100) / 100,
    awayGoals: Math.round(awayExpectedGoals * 100) / 100,
  };
}

// Check if bootstrap strengths are all zero (GW1)
function areStrengthsZero(teams) {
  if (!teams || teams.length === 0) return true;
  return teams.every(t =>
    (t.strength_attack_home || 0) === 0 &&
    (t.strength_attack_away || 0) === 0
  );
}

module.exports = {
  TEAM_XG_2024_25,
  HOME_ATTACK_SHARE,
  HOME_DEFENSE_SHARE,
  getTeamXG,
  getFixtureXG,
  areStrengthsZero,
};
