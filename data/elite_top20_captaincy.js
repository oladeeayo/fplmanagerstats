/**
 * Elite Top 20 Captaincy Candidates for FPL
 *
 * Curated from historical FPL data: expected goal involvement, bonus points, penalty
 * duties, haul rate, and multi-season consistency.
 *
 * Each entry carries:
 *   - webName: FPL web_name (used for matching)
 *   - historicalTeam: team in the most recent completed season (for transfer detection)
 *   - position: FPL position (MID/FWD only — captaincy is about attacking output)
 *   - eliteScore: 0-100 captaincy pedigree (how good a captain they've been historically)
 *   - keyFactors: why they're captaincy-relevant
 *   - seasonsAsElite: how many of the last 3 seasons they were top-20 in xGI
 *
 * Formula integration:
 *   eliteScore feeds into captaincyScore as an 0.08 weight component
 *   transferPenalty is applied when historicalTeam !== currentTeam
 *   H2H bonus uses historical opponent data when available
 */
const ELITE_CAPTAINCY_PLAYERS = [
  {
    webName: 'Haaland',
    historicalTeam: 'Man City',
    position: 'FWD',
    eliteScore: 96,
    keyFactors: ['Penalties', 'Highest xG in PL', 'Goal machine', 'Set-piece threat'],
    seasonsAsElite: 3,
    previousTeams: [],
  },
  {
    webName: 'Palmer',
    historicalTeam: 'Chelsea',
    position: 'MID',
    eliteScore: 93,
    keyFactors: ['Penalties', 'Free-kicks', 'Huge xGI', 'Bonus magnet'],
    seasonsAsElite: 2,
    previousTeams: ['Man City'],
  },
  {
    webName: 'B.Fernandes',
    historicalTeam: 'Man Utd',
    position: 'MID',
    eliteScore: 91,
    keyFactors: ['Penalties', 'Free-kicks', 'Corners', 'Highest bonus for MID', 'Set-piece king'],
    seasonsAsElite: 4,
    previousTeams: [],
  },
  {
    webName: 'Saka',
    historicalTeam: 'Arsenal',
    position: 'MID',
    eliteScore: 89,
    keyFactors: ['Penalties', 'Free-kicks', 'Corners', 'Consistent xGI', 'Bonus collector'],
    seasonsAsElite: 3,
    previousTeams: [],
  },
  {
    webName: 'Watkins',
    historicalTeam: 'Aston Villa',
    position: 'FWD',
    eliteScore: 83,
    keyFactors: ['High xGI', 'Consistent starter', 'Bonus threat', 'Team talisman'],
    seasonsAsElite: 3,
    previousTeams: [],
  },
  {
    webName: 'Isak',
    historicalTeam: 'Liverpool',
    position: 'FWD',
    eliteScore: 82,
    keyFactors: ['High xG', 'Clinical finisher', 'Bonus threat', 'Home dominance'],
    seasonsAsElite: 2,
    previousTeams: ['Newcastle'],
  },
  {
    webName: 'Mbeumo',
    historicalTeam: 'Man Utd',
    position: 'FWD',
    eliteScore: 79,
    keyFactors: ['Penalties', 'High xGI', 'Bonus magnet', 'Team talisman', 'Set-pieces'],
    seasonsAsElite: 3,
    previousTeams: ['Brentford'],
  },
  {
    webName: 'Gibbs-White',
    historicalTeam: 'Nott\'m Forest',
    position: 'MID',
    eliteScore: 74,
    keyFactors: ['Penalties', 'Corners', 'Team talisman', 'Consistent xGI'],
    seasonsAsElite: 2,
    previousTeams: [],
  },
  {
    webName: 'Foden',
    historicalTeam: 'Man City',
    position: 'MID',
    eliteScore: 77,
    keyFactors: ['High xGI', 'Explosive hauls', 'Inside forward role', 'Bonus threat'],
    seasonsAsElite: 3,
    previousTeams: [],
  },
  {
    webName: 'Solanke',
    historicalTeam: 'Tottenham',
    position: 'FWD',
    eliteScore: 73,
    keyFactors: ['Penalties', 'High xGI', 'Team talisman', 'Consistent starter'],
    seasonsAsElite: 2,
    previousTeams: ['Bournemouth'],
  },
  {
    webName: 'Gakpo',
    historicalTeam: 'Liverpool',
    position: 'MID',
    eliteScore: 76,
    keyFactors: ['High xGI', 'Explosive hauls', 'Versatile attacker', 'Home dominance'],
    seasonsAsElite: 2,
    previousTeams: [],
  },
  {
    webName: 'Cherki',
    historicalTeam: 'Man City',
    position: 'MID',
    eliteScore: 75,
    keyFactors: ['Highest xGI/90 in PL', 'Creative genius', 'Set-piece threat', 'Bonus potential'],
    seasonsAsElite: 1,
    previousTeams: [],
  },
  {
    webName: 'Martinelli',
    historicalTeam: 'Arsenal',
    position: 'MID',
    eliteScore: 72,
    keyFactors: ['High xGI', 'Explosive pace', 'Bonus threat', 'Home dominance'],
    seasonsAsElite: 2,
    previousTeams: [],
  },
  {
    webName: 'Wood',
    historicalTeam: 'Nott\'m Forest',
    position: 'FWD',
    eliteScore: 75,
    keyFactors: ['Penalties', 'High xGI', 'Aerial threat', 'Consistent hauls'],
    seasonsAsElite: 2,
    previousTeams: [],
  },
  {
    webName: 'Madueke',
    historicalTeam: 'Arsenal',
    position: 'MID',
    eliteScore: 71,
    keyFactors: ['High xGI', 'Goal threat', 'Bonus potential', 'Explosive winger'],
    seasonsAsElite: 2,
    previousTeams: ['Chelsea'],
  },
  {
    webName: 'Neto',
    historicalTeam: 'Chelsea',
    position: 'MID',
    eliteScore: 70,
    keyFactors: ['High xGI', 'Creative output', 'Set-piece threat', 'Explosive potential'],
    seasonsAsElite: 2,
    previousTeams: ['Wolves', 'Bournemouth'],
  },
  {
    webName: 'Johnson',
    historicalTeam: 'Everton',
    position: 'MID',
    eliteScore: 68,
    keyFactors: ['High xGI', 'Goal threat', 'Bonus potential', 'Versatile attacker'],
    seasonsAsElite: 2,
    previousTeams: ['Tottenham', 'Nott\'m Forest'],
  },
  {
    webName: 'Szoboszlai',
    historicalTeam: 'Liverpool',
    position: 'MID',
    eliteScore: 69,
    keyFactors: ['High xGI', 'Set-piece taker', 'Box-to-box threat', 'Consistent starter'],
    seasonsAsElite: 2,
    previousTeams: [],
  },
  {
    webName: 'Rice',
    historicalTeam: 'Arsenal',
    position: 'MID',
    eliteScore: 65,
    keyFactors: ['Box-to-box role', 'Increasing xGI', 'Set-piece threat', 'Defensive contribution bonus'],
    seasonsAsElite: 1,
    previousTeams: ['West Ham'],
  },
  {
    webName: 'Ødegaard',
    historicalTeam: 'Arsenal',
    position: 'MID',
    eliteScore: 70,
    keyFactors: ['Free-kicks', 'Corners', 'Creative hub', 'Consistent xGI', 'Bonus collector'],
    seasonsAsElite: 2,
    previousTeams: [],
  },
];

/**
 * Transfer penalty weights: players who moved clubs get a penalty
 * because their historical data is from a different system/role.
 *
 * @param {string} historicalTeam - team in historical data
 * @param {string|null} currentTeam - current FPL team (short name)
 * @returns {number} penalty factor (0.78 = 22% penalty, 1.0 = no penalty)
 */
function getTransferPenalty(historicalTeam, currentTeam) {
  if (!currentTeam || !historicalTeam) return 1.0;
  const normalize = (t) => (t || '').toLowerCase().replace(/[^a-z]/g, '');
  if (normalize(historicalTeam) === normalize(currentTeam)) return 1.0;
  return 0.78; // 22% penalty for changing clubs
}

/**
 * Get the elite captaincy entry for a player by web name
 */
function getEliteEntry(webName) {
  if (!webName) return null;
  const lower = webName.toLowerCase();
  return ELITE_CAPTAINCY_PLAYERS.find(
    e => e.webName.toLowerCase() === lower
  ) || ELITE_CAPTAINCY_PLAYERS.find(
    e => lower.includes(e.webName.toLowerCase()) || e.webName.toLowerCase().includes(lower)
  ) || null;
}

/**
 * Compute the captaincy score for a player using the new weighted formula:
 *
 * captaincyScore =
 *   xPtsComponent    (0.30 weight) - expected points for the fixture
 *   formComponent    (0.18 weight) - current form relative to position
 *   fixtureComponent (0.18 weight) - fixture difficulty
 *   xGI90Component   (0.12 weight) - expected goal involvement rate
 *   eliteComponent   (0.08 weight) - historical captaincy pedigree
 *   h2hComponent     (0.08 weight) - historical record vs opponent
 *   roleComponent    (0.06 weight) - set piece / penalty duties
 *
 * All components normalized to 0-100 scale.
 */
function computeCaptaincyScore({
  xPts,
  form,
  ppg,
  xGI90,
  position,
  fdr,
  isHome,
  eliteScore = 0,
  h2hAppearances = 0,
  h2hPointsPerGame = 0,
  h2hHaulRate = 0,
  hasPenalties = false,
  hasFreeKicks = false,
  hasCorners = false,
  minutesReliability = 0,
  consistencyScore = 0,
  transferPenalty = 1.0,
}) {
  const POS_BENCHMARK = { FWD: 5.2, MID: 4.8, DEF: 4.5, GKP: 4.2 };

  // 1. xPts component (0-100): 0 xPts = 0, 10+ xPts = 100
  const xPtsComponent = Math.min(100, (xPts / 10) * 100);

  // 2. Form component (0-100): relative to position benchmark
  const benchmark = POS_BENCHMARK[position] || 4.5;
  const formRatio = form > 0 ? form / benchmark : (ppg > 0 ? ppg / benchmark : 1.0);
  const formComponent = Math.min(100, Math.max(0, (formRatio - 0.3) / 1.4 * 100));

  // 3. xGI90 component (0-100): 0 = 0, 1.0+ = 100
  const xGI90Component = Math.min(100, xGI90 * 100);

  // 4. Fixture component (0-100): FDR 1 = 100, FDR 5 = 0
  const fixtureComponent = Math.max(0, (1 - (fdr - 1) / 4) * 100) * (isHome ? 1.05 : 0.95);

  // 5. Elite component (0-100): directly from elite score
  const eliteComponent = eliteScore;

  // 6. H2H component (0-100): based on historical record vs this opponent
  let h2hComponent = 50; // neutral if no data
  if (h2hAppearances >= 2) {
    h2hComponent = Math.min(100, Math.max(0, (h2hPointsPerGame / 12) * 100));
    if (h2hHaulRate > 0.3) h2hComponent = Math.min(100, h2hComponent + 15);
  } else if (h2hAppearances === 1) {
    h2hComponent = Math.min(100, Math.max(25, (h2hPointsPerGame / 12) * 100));
  }

  // 7. Role component (0-100): set piece and penalty duties
  let roleComponent = 20; // baseline
  if (hasPenalties) roleComponent += 50;
  if (hasFreeKicks) roleComponent += 15;
  if (hasCorners) roleComponent += 10;
  roleComponent = Math.min(100, roleComponent);

  // Weighted sum — fixture quality and xPts dominate, elite is a tiebreaker
  const rawScore =
    xPtsComponent * 0.30 +
    formComponent * 0.18 +
    xGI90Component * 0.12 +
    fixtureComponent * 0.18 +
    eliteComponent * 0.08 +
    h2hComponent * 0.08 +
    roleComponent * 0.06;

  // Apply transfer penalty
  const finalScore = rawScore * transferPenalty;

  return {
    finalScore: Math.round(finalScore * 10) / 10,
    components: {
      xPts: Math.round(xPtsComponent),
      form: Math.round(formComponent),
      xGI90: Math.round(xGI90Component),
      fixture: Math.round(fixtureComponent),
      elite: Math.round(eliteComponent),
      h2h: Math.round(h2hComponent),
      role: Math.round(roleComponent),
    },
    transferPenalty,
  };
}

module.exports = {
  ELITE_CAPTAINCY_PLAYERS,
  getTransferPenalty,
  getEliteEntry,
  computeCaptaincyScore,
};
