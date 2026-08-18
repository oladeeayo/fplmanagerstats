// src/server/opponentModel.js
// Opponent-specific defensive strength model
// Replaces static CS probabilities with dynamic, opponent-adjusted values

// Base FDR values (fallback when no Understat data)
const BASE_FDR = { 1: 1.0, 2: 1.2, 3: 1.5, 4: 1.8, 5: 2.2 };

// Base clean sheet probabilities by FDR (legacy fallback)
const BASE_CS_PROB = { 1: 0.46, 2: 0.37, 3: 0.28, 4: 0.19, 5: 0.12 };

// Attack modifiers by FDR
const ATTACK_MODIFIER = { 1: 1.25, 2: 1.12, 3: 1.0, 4: 0.88, 5: 0.76 };

// Team strength profiles (updated when Understat data available)
let teamProfiles = {};

function setTeamProfiles(profiles) {
  teamProfiles = profiles || {};
}

// Get opponent defensive strength (0 = easiest to score against, 1 = hardest)
function opponentDefensiveStrength(opponentName) {
  const profile = teamProfiles[opponentName];
  if (!profile) return 0.5; // neutral

  // Use xGA90 as primary metric (higher = easier to score against)
  const xGA90 = profile.xGA90 || 1.3;
  const csRate = profile.csRate || 0.25;

  // Normalize: xGA90 of 2.0 = very weak defense (0.0), xGA90 of 0.5 = very strong (1.0)
  const strength = 1 - ((xGA90 - 0.5) / 1.5);
  return Math.max(0, Math.min(1, strength));
}

// Get opponent attacking strength (for clean sheet probability)
function opponentAttackingStrength(opponentName) {
  const profile = teamProfiles[opponentName];
  if (!profile) return 0.5;

  const xG90 = profile.xG90 || 1.3;
  // Higher xG = harder to keep clean sheet
  const strength = (xG90 - 0.5) / 1.5;
  return Math.max(0, Math.min(1, strength));
}

// Calculate opponent-adjusted clean sheet probability
function adjustedCleanSheetProbability(opponentName, isHome, teamDefensiveStrength = 0.5) {
  const profile = teamProfiles[opponentName];
  if (!profile) return BASE_CS_PROB[3]; // neutral

  const baseCS = profile.csRate || 0.25;
  const opponentAttack = opponentAttackingStrength(opponentName);

  // Adjust for home/away
  const homeBonus = isHome ? 0.06 : -0.04;

  // Adjust for team's own defensive strength
  const defBonus = (teamDefensiveStrength - 0.5) * 0.15;

  // Adjust for opponent's attacking threat
  const attackPenalty = opponentAttack * 0.2;

  const adjusted = baseCS + homeBonus + defBonus - attackPenalty;
  return Math.max(0.05, Math.min(0.75, adjusted));
}

// Calculate opponent-adjusted attack modifier
function adjustedAttackModifier(opponentName, isHome) {
  const profile = teamProfiles[opponentName];
  if (!profile) return ATTACK_MODIFIER[3];

  const defStrength = opponentDefensiveStrength(opponentName);

  // Map strength to modifier: strong defense = lower modifier
  // defStrength 0.0 (weak) -> modifier 1.3, defStrength 1.0 (strong) -> modifier 0.7
  const modifier = 1.3 - (defStrength * 0.6);

  // Home/away adjustment
  const homeBonus = isHome ? 1.04 : 0.96;

  return modifier * homeBonus;
}

// Calculate opponent-adjusted FDR (1-5 scale)
function adjustedFDR(opponentName, isHome) {
  const profile = teamProfiles[opponentName];
  if (!profile) return 3;

  const defStrength = opponentDefensiveStrength(opponentName);
  const attStrength = opponentAttackingStrength(opponentName);

  // Combine: FDR is about how hard the fixture is
  // Strong opponent defense + strong opponent attack = hard fixture
  const combined = (defStrength + attStrength) / 2;

  // Map to 1-5 scale
  const fdr = 1 + (1 - combined) * 4;
  const rounded = Math.round(fdr);

  // Home advantage
  if (isHome) return Math.max(1, rounded - 1);
  return Math.min(5, rounded + (rounded >= 4 ? 1 : 0));
}

// Get comprehensive opponent analysis
function analyzeOpponent(opponentName, isHome, options = {}) {
  const profile = teamProfiles[opponentName];
  const defStr = opponentDefensiveStrength(opponentName);
  const attStr = opponentAttackingStrength(opponentName);

  return {
    name: opponentName,
    isHome,
    fdr: adjustedFDR(opponentName, isHome),
    csProbability: adjustedCleanSheetProbability(opponentName, isHome, options.teamDefensiveStrength),
    attackModifier: adjustedAttackModifier(opponentName, isHome),
    opponentDefensiveStrength: defStr,
    opponentAttackingStrength: attStr,
    // Raw Understat data if available
    ...(profile ? {
      xGA90: profile.xGA90,
      xG90: profile.xG90,
      csRate: profile.csRate,
    } : {}),
  };
}

module.exports = {
  setTeamProfiles,
  opponentDefensiveStrength,
  opponentAttackingStrength,
  adjustedCleanSheetProbability,
  adjustedAttackModifier,
  adjustedFDR,
  analyzeOpponent,
  BASE_CS_PROB,
  ATTACK_MODIFIER,
};
