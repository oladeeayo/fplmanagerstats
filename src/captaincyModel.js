const { getEliteEntry, getTransferPenalty, computeCaptaincyScore, ELITE_CAPTAINCY_PLAYERS } = require('../data/elite_top20_captaincy');

const POSITION_MAP = ['GKP', 'DEF', 'MID', 'FWD'];

const GOAL_POINTS = { GKP: 10, DEF: 6, MID: 5, FWD: 4 };
const CLEAN_SHEET_POINTS = { GKP: 4, DEF: 4, MID: 1, FWD: 0 };
const ATTACK_MODIFIER = { 1: 1.25, 2: 1.12, 3: 1, 4: 0.88, 5: 0.76 };
const FORM_MODIFIER = { 1: 1.12, 2: 1.06, 3: 1, 4: 0.94, 5: 0.88 };
const CLEAN_SHEET_PROBABILITY = { 1: 0.46, 2: 0.37, 3: 0.28, 4: 0.19, 5: 0.12 };
const PRESEASON_POSITION_PRIOR = { GKP: 3.4, DEF: 3.25, MID: 3.45, FWD: 3.35 };

const POSITION_BENCHMARKS = { FWD: 5.2, MID: 4.8, DEF: 4.5, GKP: 4.2 };
const FDR_MULTIPLIER = { 1: 1.18, 2: 1.08, 3: 1.0, 4: 0.90, 5: 0.80 };
const ROLE_BOOSTS = { penalty: 0.5, setPiece: 0.3, captain: 0.2 };

function getDecayFactor(currentGW) {
  const gw = clamp(number(currentGW, 1), 1, 38);
  return round(1 - Math.exp(-0.08 * (gw - 1)), 3);
}

// Enhanced models (imported lazily to avoid circular deps)
let opponentModel = null;
let bookingRiskModel = null;
let priceModel = null;
let fplInsightsData = null;
function getOpponentModel() { return opponentModel || (opponentModel = require('./server/opponentModel')); }
function getBookingRiskModel() { return bookingRiskModel || (bookingRiskModel = require('./server/bookingRiskModel')); }
function getPriceModel() { return priceModel || (priceModel = require('./server/priceModel')); }
function getFplInsightsData() { return fplInsightsData || (fplInsightsData = require('./server/fplInsightsData')); }

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

// ---- Rotation Risk Detection ----
// Analyzes fixture schedule to detect midweek games, short rest, and congestion.
// Returns a penalty factor (0.72 = 28% penalty, 1.0 = no risk).
function detectRotationRisk(teamId, targetGW, allFixtures, teamsById) {
  const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  // Get all fixtures for this team across the season, sorted by kickoff
  const teamFixtures = allFixtures
    .filter(f => (f.team_h === teamId || f.team_a === teamId) && f.kickoff_time)
    .sort((a, b) => String(a.kickoff_time).localeCompare(String(b.kickoff_time)));

  if (teamFixtures.length === 0) return { penalty: 1.0, reasons: [], restDays: null, isMidweek: false };

  // Find the target GW fixture
  const targetFixtures = teamFixtures.filter(f => f.event === targetGW);
  if (targetFixtures.length === 0) return { penalty: 1.0, reasons: [], restDays: null, isMidweek: false };

  const targetFix = targetFixtures[0];
  const targetDate = new Date(targetFix.kickoff_time);
  const targetDay = targetDate.getUTCDay();
  const isMidweek = targetDay >= 2 && targetDay <= 4; // Tue=2, Wed=3, Thu=4

  // Find the previous fixture for this team
  const prevFixtures = teamFixtures.filter(f => f.event < targetGW && f.kickoff_time);
  let restDays = null;
  if (prevFixtures.length > 0) {
    const prevFix = prevFixtures[prevFixtures.length - 1];
    const prevDate = new Date(prevFix.kickoff_time);
    restDays = (targetDate - prevDate) / (1000 * 60 * 60 * 24);
  }

  // Find the next fixture after this GW
  const nextFixtures = teamFixtures.filter(f => f.event > targetGW && f.kickoff_time);
  let daysUntilNext = null;
  if (nextFixtures.length > 0) {
    const nextFix = nextFixtures[0];
    const nextDate = new Date(nextFix.kickoff_time);
    daysUntilNext = (nextDate - targetDate) / (1000 * 60 * 60 * 24);
  }

  // GW congestion: check if 2 gameweeks fall within a 5-day window
  let gwCongestion = false;
  if (nextFixtures.length > 0 && daysUntilNext !== null) {
    gwCongestion = daysUntilNext < 4.5;
  }

  // Previous GW was midweek (team played Tue/Wed/Thu in the last GW)
  let prevWasMidweek = false;
  if (prevFixtures.length > 0) {
    const prevDay = new Date(prevFixtures[prevFixtures.length - 1].kickoff_time).getUTCDay();
    prevWasMidweek = prevDay >= 2 && prevDay <= 4;
  }

  // European competition indicator: if the team plays in midweek AND the previous
  // or next GW is also midweek, they likely have European fixtures (CL/EL)
  const hasEuropeanSchedule = (isMidweek && prevWasMidweek) ||
    (isMidweek && gwCongestion) ||
    (prevWasMidweek && gwCongestion);

  // Compute rotation risk factors
  let penalty = 1.0;
  const reasons = [];

  // Factor 1: Short rest (< 3.5 days) = high rotation risk
  if (restDays !== null && restDays < 3.5) {
    const severity = restDays < 2.5 ? 0.18 : 0.10;
    penalty -= severity;
    reasons.push(`Short rest: ${restDays.toFixed(1)} days since last match`);
  }

  // Factor 2: Midweek fixture = elevated rotation risk
  if (isMidweek) {
    penalty -= 0.08;
    reasons.push('Midweek fixture — increased rotation likelihood');
  }

  // Factor 3: GW congestion (next GW < 4.5 days away)
  if (gwCongestion) {
    penalty -= 0.06;
    reasons.push(`Congested schedule — next GW in ${daysUntilNext?.toFixed(1)} days`);
  }

  // Factor 4: Previous GW was midweek (fatigue from compressed schedule)
  if (prevWasMidweek && !isMidweek) {
    penalty -= 0.04;
    reasons.push('Played midweek in previous GW — recovery window compressed');
  }

  // Factor 5: European schedule compounding (CL/EL teams)
  if (hasEuropeanSchedule) {
    penalty -= 0.05;
    reasons.push('European competition schedule — squad rotation expected');
  }

  // Factor 6: Very long rest (> 9 days) can indicate postponement/rearrangement
  // which sometimes means a double GW is incoming — slightly boost (less rotation)
  if (restDays !== null && restDays > 9) {
    penalty += 0.03;
    reasons.push('Extended rest period — fresh for this fixture');
  }

  return {
    penalty: clamp(penalty, 0.72, 1.03),
    reasons,
    restDays: restDays !== null ? Math.round(restDays * 10) / 10 : null,
    isMidweek,
    gwCongestion,
    prevWasMidweek,
    hasEuropeanSchedule,
    daysUntilNext: daysUntilNext !== null ? Math.round(daysUntilNext * 10) / 10 : null,
  };
}

function number(value, fallback = 0) {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function round(value, precision = 1) {
  const multiplier = 10 ** precision;
  return Math.round(value * multiplier) / multiplier;
}

function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const midpoint = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[midpoint] : (sorted[midpoint - 1] + sorted[midpoint]) / 2;
}

function availabilityFor(player, useNextRoundChance) {
  if (player.removed || player.can_select === false || ['u', 's', 'n'].includes(player.status)) return 0;

  const chance = useNextRoundChance ? number(player.chance_of_playing_next_round, NaN) : NaN;
  if (Number.isFinite(chance)) return clamp(chance / 100, 0, 1);
  if (player.status === 'i') return 0;
  if (player.status === 'd') return 0.75;
  return 1;
}

function buildTeamExperience(elements) {
  const teamMinutes = new Map();
  const teamCounts = new Map();
  elements.forEach(player => {
    const teamId = player.team;
    if (!teamMinutes.has(teamId)) teamMinutes.set(teamId, 0);
    if (!teamCounts.has(teamId)) teamCounts.set(teamId, 0);
    teamMinutes.set(teamId, teamMinutes.get(teamId) + number(player.minutes));
    teamCounts.set(teamId, teamCounts.get(teamId) + 1);
  });
  const experience = new Map();
  teamMinutes.forEach((total, teamId) => {
    const count = Math.max(teamCounts.get(teamId) || 1, 1);
    const avg = total / count;
    experience.set(teamId, { total, avg, promoted: avg < 900 });
  });
  return experience;
}

function buildTeamPositionCosts(elements) {
  const map = new Map();
  elements.forEach(player => {
    const key = `${player.team}:${player.element_type}`;
    const cost = number(player.now_cost);
    if (!map.has(key) || cost > map.get(key)) map.set(key, cost);
  });
  return map;
}

function estimateExpectedMinutes(player, referenceMatches, availability, context = {}) {
  if (availability <= 0) return 0;

  const minutes = number(player.minutes);
  const starts = number(player.starts);
  const ppg = number(player.points_per_game);
  const points = number(player.total_points);
  if (minutes === 0 && starts === 0 && points === 0) {
    const officialProjection = number(player.ep_next);
    const ownership = number(player.selected_by_percent);
    const teamInfo = context.teamExperience?.get ? context.teamExperience.get(player.team) : null;
    const promotedTeam = Boolean(teamInfo?.promoted);
    const position = context.position;
    let rolePrior = 58 + Math.min(officialProjection * 4, 16) + Math.min(ownership * 0.25, 8);
    if (position === 'GKP') {
      if (promotedTeam) rolePrior -= 24;
      if (number(player.now_cost) < 46) rolePrior -= 6;
    } else if (promotedTeam) {
      rolePrior -= 8;
    }
    const floor = position === 'GKP' ? 22 : 35;
    return round(clamp(rolePrior * availability, floor, 82), 0);
  }
  const inferredAppearances = ppg > 0 ? points / ppg : Math.max(starts, Math.ceil(minutes / 90));
  const appearances = clamp(inferredAppearances, starts, Math.max(referenceMatches, starts, 1));
  const substituteAppearances = Math.max(0, appearances - starts);
  const estimatedSubMinutes = substituteAppearances * 18;
  const averageStartMinutes = starts > 0
    ? clamp((minutes - estimatedSubMinutes) / starts, 55, 90)
    : clamp(minutes / Math.max(appearances, 1), 15, 65);
  const startShare = appearances > 0 ? clamp(starts / appearances, 0, 1) : 0;
  const averageRoleMinutes = (startShare * averageStartMinutes) + ((1 - startShare) * 18);
  const activeMatchRate = clamp(appearances / Math.max(referenceMatches, 1), 0, 1);
  const currentSelectionRate = 0.65 + (activeMatchRate * 0.35);

  return round(clamp(averageRoleMinutes * currentSelectionRate * availability, 0, 90), 0);
}

function buildPositionBaselines(elements) {
  // Fallback baselines for early season when no players have 450+ minutes yet
  const FALLBACK = {
    1: { xG90: 0, xA90: 0 },           // GKP
    2: { xG90: 0.04, xA90: 0.03 },     // DEF
    3: { xG90: 0.18, xA90: 0.15 },     // MID
    4: { xG90: 0.30, xA90: 0.10 },     // FWD
  };
  return [1, 2, 3, 4].reduce((baselines, elementType) => {
    const established = elements.filter(player => player.element_type === elementType && number(player.minutes) >= 450);
    const xgValues = established.map(player => number(player.expected_goals_per_90)).filter(value => value > 0);
    const xaValues = established.map(player => number(player.expected_assists_per_90)).filter(value => value > 0);
    baselines[elementType] = {
      xG90: xgValues.length > 0 ? median(xgValues) : FALLBACK[elementType].xG90,
      xA90: xaValues.length > 0 ? median(xaValues) : FALLBACK[elementType].xA90,
    };
    return baselines;
  }, {});
}

function shrunkRate(player, field, baseline) {
  const minutes = number(player.minutes);
  const sampleWeight = minutes / (minutes + 600);
  return (number(player[field]) * sampleWeight) + (baseline * (1 - sampleWeight));
}

function getFixtureDifficulty(fixture, teamId) {
  return clamp(number(
    fixture.team_h === teamId ? fixture.team_h_difficulty : fixture.team_a_difficulty,
    3,
  ), 1, 5);
}

function fixtureTone(difficulty) {
  if (difficulty === 1) return 'very favourable';
  if (difficulty === 2) return 'favourable';
  if (difficulty === 4) return 'difficult';
  if (difficulty === 5) return 'very difficult';
  return 'balanced';
}

function describeRole(player) {
  const roles = [];
  if (number(player.penalties_order) === 1) roles.push('first-choice penalties');
  if (number(player.direct_freekicks_order) === 1) roles.push('direct free-kicks');
  if (number(player.corners_and_indirect_freekicks_order) === 1) roles.push('corners and indirect free-kicks');
  return roles;
}

// 0-100 estimate of how likely a player is a first-choice FPL starter for the next
// several gameweeks, so squad tools prefer proven starters and avoid unknowns.
// context optionally carries the projected minutes (xMins) and average fixture
// difficulty (avgFdr) for the upcoming horizon so those also inform viability.
function estimateStarterScore(player, teamExperience, teamPositionCosts, context = {}) {
  const minutes = number(player.minutes);
  const starts = number(player.starts);
  const ppg = number(player.points_per_game);
  const points = number(player.total_points);
  const epNext = number(player.ep_next);
  const ownership = number(player.selected_by_percent);
  const price = number(player.now_cost) / 10;
  const position = POSITION_MAP[player.element_type - 1];
  const teamInfo = teamExperience.get(player.team) || { promoted: false };
  const xMins = number(context.xMins, NaN);
  const avgFdr = number(context.avgFdr, NaN);

  let score = 0;

  // Proven playing time last season is the strongest starter signal.
  if (minutes >= 2800) score += 40;
  else if (minutes >= 2300) score += 32;
  else if (minutes >= 1800) score += 24;
  else if (minutes >= 1200) score += 17;
  else if (minutes >= 600) score += 9;
  else if (minutes > 0) score += 5;

  // Start frequency among appearances.
  const appearances = ppg > 0 ? points / ppg : Math.max(starts, Math.ceil(minutes / 90));
  const startRatio = appearances > 0 ? starts / appearances : 0;
  if (startRatio >= 0.9) score += 15;
  else if (startRatio >= 0.7) score += 11;
  else if (startRatio >= 0.5) score += 6;

  // Price, official projection and community ownership corroborate role. They are the
  // only signals for unknowns, and a smaller tail for proven players.
  const unknown = minutes === 0 && starts === 0 && points === 0;
  const priceWeight = unknown ? 1 : 0.5;
  if (price >= 8.0) score += 16 * priceWeight;
  else if (price >= 7.0) score += 12 * priceWeight;
  else if (price >= 6.0) score += 7 * priceWeight;
  else if (price >= 5.0) score += 3 * priceWeight;
  score += Math.min(epNext * (unknown ? 1.6 : 0.9), unknown ? 14 : 8);
  score += Math.min(ownership * (unknown ? 0.5 : 0.2), unknown ? 12 : 6);

  // Projected minutes over the horizon corroborate who is expected to actually play.
  if (Number.isFinite(xMins)) {
    if (xMins >= 80) score += 10;
    else if (xMins >= 70) score += 7;
    else if (xMins >= 60) score += 4;
    else if (xMins >= 45) score += 1;
    else if (xMins > 0) score -= 4;
  }

  // Favourable upcoming fixtures modestly improve viability for rotation decisions.
  if (Number.isFinite(avgFdr)) {
    if (avgFdr <= 2.4) score += 3;
    else if (avgFdr >= 3.6) score -= 2;
  }

  // Promoted teams: unknown players are unproven, and GKs there are the least reliable.
  if (teamInfo.promoted && unknown) {
    if (position === 'GKP') score -= 25;
    else if (price < 5.0) score -= 10;
  }

  // "2nd fiddle" risk: a cheaper/newer player with a much more expensive teammate
  // in the same position is often not the first-choice option.
  const rivalMaxPrice = (teamPositionCosts.get(`${player.team}:${player.element_type}`) || 0) / 10;
  if (rivalMaxPrice > price + 1.0 && price < 6.0) score -= 8;

  // Availability drags viability.
  if (player.status === 'i') score -= 20;
  else if (player.status === 'd') score -= 10;
  const chance = number(player.chance_of_playing_next_round, NaN);
  if (Number.isFinite(chance) && chance < 100) score -= Math.max(0, 100 - chance) * 0.3;

  return clamp(Math.round(score), 0, 100);
}

function starterTierFor(score) {
  if (score >= 75) return 'Nailed starter';
  if (score >= 55) return 'Likely starter';
  if (score >= 35) return 'Rotation risk';
  return 'Unknown role';
}

function projectFixture({ player, fixture, fixtureIndex, xMins, xG90, xA90, form, ppg, position, officialProjection, historical, teamsById }) {
  const difficulty = getFixtureDifficulty(fixture, player.team);
  const isHome = fixture.team_h === player.team;
  const opponentId = isHome ? fixture.team_a : fixture.team_h;
  const fixtureXmins = round(xMins * (fixtureIndex === 0 ? 1 : 0.92), 0);
  const minuteShare = fixtureXmins / 90;
  const appearanceProbability = clamp(fixtureXmins / 30, 0, 1);
  const sixtyMinuteProbability = clamp((fixtureXmins - 30) / 30, 0, 1);

  // Enhanced: use opponent model for dynamic modifiers when available
  let attackModifier, formModifier, csProb;
  try {
    const opp = getOpponentModel();
    const oppName = teamsById?.get(opponentId)?.name || '';
    attackModifier = opp.adjustedAttackModifier(oppName, isHome);
    csProb = opp.adjustedCleanSheetProbability(oppName, isHome);
    formModifier = FORM_MODIFIER[difficulty] * (isHome ? 1.02 : 0.98);
  } catch {
    attackModifier = ATTACK_MODIFIER[difficulty] * (isHome ? 1.03 : 0.97);
    csProb = CLEAN_SHEET_PROBABILITY[difficulty];
    formModifier = FORM_MODIFIER[difficulty] * (isHome ? 1.02 : 0.98);
  }

  const appearancePoints = appearanceProbability + sixtyMinuteProbability;
  const goalPoints = xG90 * minuteShare * attackModifier * GOAL_POINTS[position];
  const assistPoints = xA90 * minuteShare * attackModifier * 3;
  const cleanSheetPoints = CLEAN_SHEET_POINTS[position] * csProb * sixtyMinuteProbability;
  const bonusPer90Raw = number(player.bonus) * 90 / Math.max(number(player.minutes), 900);
  let bonusPer90 = bonusPer90Raw;
  if (historical?.crossSeason?.bonusPer90Career > 0) {
    const histBonus = historical.crossSeason.bonusPer90Career;
    const bonusWeight = Math.max(0, 1 - number(player.minutes) / 1000);
    bonusPer90 = bonusPer90Raw * (1 - bonusWeight) + histBonus * bonusWeight;
  }
  const bonusPoints = clamp(bonusPer90, 0, 1.25) * minuteShare * (0.9 + (attackModifier * 0.1));
  const setPiecePoints = (
    (number(player.penalties_order) === 1 ? 0.12 : 0) +
    (number(player.direct_freekicks_order) === 1 ? 0.04 : 0) +
    (number(player.corners_and_indirect_freekicks_order) === 1 ? 0.04 : 0)
  ) * minuteShare * attackModifier;
  const savePoints = position === 'GKP'
    ? (number(player.saves_per_90) * minuteShare / 3)
    : 0;
  const contributionRate = number(player.defensive_contribution_per_90);
  const contributionThreshold = position === 'DEF' ? 10 : 12;
  const contributionPoints = position === 'GKP'
    ? 0
    : 2 * clamp((contributionRate * minuteShare) / contributionThreshold, 0, 1) * sixtyMinuteProbability;

  // Enhanced: use booking risk model for card prediction
  let cardPoints;
  try {
    const brm = getBookingRiskModel();
    const risk = brm.calculateBookingRisk({ ...player, position, xMins: fixtureXmins });
    cardPoints = risk.expectedCardPoints;
  } catch {
    cardPoints = -(
      (number(player.yellow_cards) + (number(player.red_cards) * 3)) * 90 /
      Math.max(number(player.minutes), 1800)
    ) * minuteShare;
  }

  const eventProjection = appearancePoints + goalPoints + assistPoints + cleanSheetPoints + bonusPoints + setPiecePoints + savePoints + contributionPoints + cardPoints;

  const historicAverageMinutes = clamp(number(player.minutes) / Math.max(number(player.total_points) / Math.max(ppg, 0.1), 1), 45, 90);
  const roleMinutesRatio = clamp(fixtureXmins / historicAverageMinutes, 0, 1.2);
  
  // Form & PPG act as a calibrated scaling modifier (0.88x to 1.12x) on the event projection
  const playerBasePPG = ppg > 0 ? ppg : (POSITION_BENCHMARKS[position] || 4.5);
  const formDeltaRatio = form > 0 ? (form / playerBasePPG) : 1.0;
  const formModifierScaled = Math.max(0.88, Math.min(1.12, formDeltaRatio * roleMinutesRatio * formModifier));
  
  let projectedPoints = eventProjection * formModifierScaled;

  if (officialProjection > 0 && fixtureIndex === 0) {
    const preseason = number(player.minutes) === 0 && number(player.total_points) === 0;
    projectedPoints = preseason
      ? (projectedPoints * 0.42) + (officialProjection * 0.43) + (PRESEASON_POSITION_PRIOR[position] * 0.15)
      : (projectedPoints * 0.84) + (officialProjection * 0.16);
  }

  return {
    opponentId,
    isHome,
    venue: isHome ? 'H' : 'A',
    fdr: difficulty,
    kickoff: fixture.kickoff_time || null,
    xMins: fixtureXmins,
    xPts: round(Math.max(0, projectedPoints)),
    attackingXPts: round(goalPoints + assistPoints, 2),
    defensiveContributionXPts: round(contributionPoints, 2),
    tone: fixtureTone(difficulty),
  };
}

function buildCandidate({ player, playerFixtures, teamsById, referenceMatches, baselines, useNextRoundChance, useOfficialProjection, teamExperience, teamPositionCosts, historicalData, currentGW, allFixtures }) {
  const availability = availabilityFor(player, useNextRoundChance);
  const xMins = estimateExpectedMinutes(player, referenceMatches, availability, { teamExperience, position: POSITION_MAP[player.element_type - 1] });
  if (!playerFixtures.length || xMins < 20) return null;

  // Detect rotation risk from fixture schedule
  const rotationRisk = detectRotationRisk(player.team, currentGW, allFixtures || [], teamsById);

  const position = POSITION_MAP[player.element_type - 1];
  const avgFdr = playerFixtures.length
    ? playerFixtures.reduce((sum, fixture) => sum + getFixtureDifficulty(fixture, player.team), 0) / playerFixtures.length
    : NaN;
  const starterScore = estimateStarterScore(player, teamExperience || new Map(), teamPositionCosts || new Map(), { xMins, avgFdr });
  const form = number(player.form);
  const ppg = number(player.points_per_game);
  let xG90 = shrunkRate(player, 'expected_goals_per_90', baselines[player.element_type].xG90);
  let xA90 = shrunkRate(player, 'expected_assists_per_90', baselines[player.element_type].xA90);

  const histById = historicalData?.get(player.id);
  const historical = (histById && (
    !player.web_name ||
    histById.webNameLower === player.web_name.toLowerCase() ||
    histById.name?.toLowerCase().includes(player.web_name.toLowerCase()) ||
    player.web_name.toLowerCase().includes(histById.webNameLower)
  )) ? histById : (historicalData?.get(player.web_name?.toLowerCase()) || null);
  const currentMins = number(player.minutes);
  const cs = historical?.crossSeason || null;
  const latestSeason = historical?.seasons ? Object.values(historical.seasons)[Object.values(historical.seasons).length - 1] : null;
  const prevSeasonData = historical?.previousSeason || null;

  const decay = getDecayFactor(currentGW);
  const positionName = POSITION_MAP[player.element_type - 1];
  const posBenchmark = POSITION_BENCHMARKS[positionName] || 4.5;

  const hasHistory = cs && cs.totalMinutes > 1000;
  const hasFullHistory = cs && cs.fullSeasons >= 2 && cs.totalMinutes > 3000;

  const histXGI90 = cs?.xGIPer90Career || latestSeason?.xGIPer90 || 0;
  const histPPG90 = cs?.pointsPer90Career || latestSeason?.pointsPer90 || posBenchmark;
  const histBonusPer90 = cs?.bonusPer90Career || 0;
  const histHaulRate = cs?.haulRateCareer || 0;
  const consistency = cs?.consistencyScore || 0;

  const rawForm = form > 0 ? form : ppg;
  let effectiveForm, effectivePPG;
  if (hasHistory) {
    const dampenedForm = Math.min(rawForm, histPPG90 * 2.5);
    effectiveForm = dampenedForm * decay + histPPG90 * (1 - decay);
    effectivePPG = ppg * decay + histPPG90 * (1 - decay);
  } else {
    effectiveForm = rawForm;
    effectivePPG = ppg > 0 ? ppg : posBenchmark;
  }

  const playingTimeFactor = cs ? Math.min(1.0, 0.85 + (cs.minutesReliability || 0.7) * 0.15) : 0.92;

  const eliteBonus = hasFullHistory ? (consistency * 0.4 + histHaulRate * 3 + Math.min(histXGI90, 1.0) * 0.8) : 0;

  if (hasHistory) {
    const careerGoalsPer90 = histXGI90 * 0.65;
    const careerAssistsPer90 = histXGI90 * 0.35;
    xG90 = xG90 * decay + careerGoalsPer90 * (1 - decay);
    xA90 = xA90 * decay + careerAssistsPer90 * (1 - decay);

    if (cs.xGITrend > 0.05) {
      const boost = Math.min(cs.xGITrend * 0.2, 0.12);
      xG90 *= (1 + boost);
      xA90 *= (1 + boost);
    } else if (cs.xGITrend < -0.15) {
      const penalty = Math.min(Math.abs(cs.xGITrend) * 0.1, 0.1);
      xG90 *= (1 - penalty);
      xA90 *= (1 - penalty);
    }
  }
  const fplXGI90 = xG90 + xA90;
  const finalXGI90 = Math.max(fplXGI90, histXGI90 * (1 - decay) + fplXGI90 * decay);
  if (finalXGI90 > fplXGI90) {
    const ratio = finalXGI90 / Math.max(fplXGI90, 0.001);
    xG90 *= ratio;
    xA90 *= ratio;
  }

  const officialProjection = useOfficialProjection ? number(player.ep_next) : 0;
  const roles = describeRole(player);

  const allOpponentHistory = {};
  if (historical?.opponents) {
    for (const [, oppData] of Object.entries(historical.opponents)) {
      for (const opp of oppData) {
        const key = opp.opponentTeamId;
        if (!allOpponentHistory[key]) {
          allOpponentHistory[key] = { appearances: 0, points: 0, xGI: 0, bonus: 0, hauls: 0, homeAppearances: 0, awayAppearances: 0, homePoints: 0, awayPoints: 0 };
        }
        const e = allOpponentHistory[key];
        e.appearances += opp.appearances;
        e.points += opp.points;
        e.xGI += opp.xGI;
        e.bonus += opp.bonus;
        e.hauls += opp.hauls;
        if (opp.wasHome) { e.homeAppearances += opp.appearances; e.homePoints += opp.points; }
        else { e.awayAppearances += opp.appearances; e.awayPoints += opp.points; }
      }
    }
  }

  const fixtures = playerFixtures.map((fixture, fixtureIndex) => {
    const projection = projectFixture({
      player,
      fixture,
      fixtureIndex,
      xMins,
      xG90,
      xA90,
      form: effectiveForm,
      ppg: effectivePPG,
      position,
      officialProjection,
      historical,
      teamsById,
    });

    const opponentId = projection.opponentId;
    const oppHist = allOpponentHistory[opponentId] || historical?.opponentsCombined?.[opponentId] || null;
    let opponentMultiplier = 1.0;
    if (oppHist && oppHist.appearances >= 1) {
      const oppPPG90 = oppHist.minutes > 0 ? (oppHist.points * 90 / oppHist.minutes) : (oppHist.points / oppHist.appearances);
      const sampleConfidence = Math.min(1.0, oppHist.appearances / 3);
      // Calibrated H2H adjustment: -10% to +10% scaling based on historical record vs opponent
      const h2hDelta = (oppPPG90 - 4.5) * 0.025;
      opponentMultiplier = 1.0 + clamp(h2hDelta, -0.10, 0.10) * sampleConfidence;
    }

    return {
      ...projection,
      xPts: round(projection.xPts * opponentMultiplier),
      opponent: teamsById.get(opponentId)?.short_name || '?',
      opponentFull: teamsById.get(opponentId)?.name || 'Opponent',
      label: `${teamsById.get(opponentId)?.short_name || '?'} (${projection.venue})`,
      oppHistAppearances: oppHist?.appearances || 0,
      oppHistPPG: oppHist ? round(oppHist.points / Math.max(oppHist.appearances, 1), 1) : 0,
    };
  });

  // Historical Elite Pool Guard & Top 20 Captaincy Elite Tier
  // Use curated elite list instead of auto-generated rankings
  const eliteEntry = getEliteEntry(player.web_name);
  const isTop20CaptaincyElite = Boolean(eliteEntry);
  const isHistoricalElite = Boolean(historical?.isHistoricalElite || isTop20CaptaincyElite || (cs && (cs.totalPoints >= 380 || cs.fullSeasons >= 2)));
  const gamesPlayedThisSeason = Math.max(number(player.starts), Math.floor(number(player.minutes) / 80));
  const hasSustainedExcellence = gamesPlayedThisSeason >= 9 && (effectiveForm >= 6.5 || ppg >= 6.0);

  // Club-change penalty: players who moved to a new club get reduced weight
  // because their historical data is from a different system/role/tactical setup
  const currentTeamName = teamsById?.get(player.team)?.name || '';
  const historicalTeamName = eliteEntry?.historicalTeam || historical?.team || '';
  let transferPenalty = 1.0;
  if (eliteEntry && historicalTeamName && currentTeamName) {
    const normalize = (t) => (t || '').toLowerCase().replace(/[^a-z]/g, '');
    if (normalize(historicalTeamName) !== normalize(currentTeamName)) {
      transferPenalty = 0.78; // 22% penalty for changing clubs
    }
  } else if ((historical?.latestSeasonTeam || historical?.team) && currentTeamName) {
    const histTeam = historical.latestSeasonTeam || historical.team;
    const normalize = (t) => (t || '').toLowerCase().replace(/[^a-z]/g, '');
    if (normalize(histTeam) !== normalize(currentTeamName)) {
      transferPenalty = 0.78;
    }
  }

  // Captaincy Elite Weighting:
  // Curated Top 20 Captaincy Elite receive 1.12x boost
  // Historical Elite receive 1.04x baseline
  // Non-elite candidates without sustained form receive 0.82x penalty
  let elitePoolFactor = 1.0;
  if (isTop20CaptaincyElite) {
    elitePoolFactor = 1.12;
  } else if (isHistoricalElite || hasSustainedExcellence) {
    elitePoolFactor = 1.04;
  } else {
    elitePoolFactor = 0.82;
  }
  // Apply transfer penalty to elite factor
  elitePoolFactor *= transferPenalty;

  const totalXptsRaw = fixtures.reduce((sum, fixture) => sum + fixture.xPts, 0);
  const totalXpts = round(totalXptsRaw * playingTimeFactor * elitePoolFactor * rotationRisk.penalty);
  const totalXmins = fixtures.reduce((sum, fixture) => sum + fixture.xMins, 0);
  const attackingXpts = fixtures.reduce((sum, fixture) => sum + fixture.attackingXPts, 0);
  const ownership = number(player.selected_by_percent);
  const upsideRoleBoost = (number(player.penalties_order) === 1 ? 0.3 : 0) +
    (number(player.direct_freekicks_order) === 1 ? 0.1 : 0) +
    (number(player.corners_and_indirect_freekicks_order) === 1 ? 0.1 : 0);
  const upside = round(attackingXpts + upsideRoleBoost, 2);
  const fixtureSummary = fixtures.map(fixture => fixture.label).join(' + ');
  const fixtureDetail = fixtures.map(fixture => `${fixture.label}, FDR ${fixture.fdr}`).join('; ');
  const formText = form > 0 ? `${form.toFixed(1)} form` : `${ppg.toFixed(1)} season PPG baseline`;
  const roleText = roles.length ? ` Role: ${roles.join(', ')}.` : '';
  const profileText = position === 'MID' || position === 'FWD'
    ? `${round(xG90 + xA90, 2).toFixed(2)} xGI/90`
    : position === 'GKP'
      ? `${number(player.saves_per_90).toFixed(1)} saves/90`
      : `${number(player.clean_sheets)} clean sheets`;
  const confidence = xMins >= 78 && availability === 1 ? 'High' : xMins >= 60 && availability >= 0.75 ? 'Medium' : 'Managed risk';

  const histData = historical || null;
  const consistencyScore = cs?.consistencyScore ?? 0;
  const improvementRatio = cs?.xGITrend ? (1 + cs.xGITrend) : 1;
  const minutesReliability = cs?.minutesReliability ?? 0;
  const prevSeasonXGI90 = prevSeasonData?.xGIPer90 || cs?.xGIPer90Career || 0;
  const hasMultiSeasonData = !!(cs && cs.fullSeasons >= 2);

  return {
    id: player.id,
    name: player.web_name,
    fullName: [player.first_name, player.second_name].filter(Boolean).join(' '),
    code: player.code,
    team: teamsById.get(player.team)?.short_name || '?',
    teamFull: teamsById.get(player.team)?.name || 'Unknown',
    position,
    cost: number(player.now_cost) / 10,
    form: round(form),
    formUsed: round(effectiveForm),
    formSource: form > 0 ? 'form' : 'season PPG',
    ppg: round(ppg),
    xG90: round(xG90, 2),
    xA90: round(xA90, 2),
    xGI90: round(xG90 + xA90, 2),
    savesPer90: round(number(player.saves_per_90), 1),
    xMins: totalXmins,
    xMinsPerFixture: xMins,
    xPts: totalXpts,
    ownership: round(ownership),
    availability: round(availability * 100, 0),
    confidence,
    starterScore,
    starterTier: starterTierFor(starterScore),
    isStarter: starterScore >= 55,
    roles,
    fixtures,
    fixtureSummary,
    upside,
    consistencyScore: round(consistencyScore, 2),
    improvementRatio: round(improvementRatio, 2),
    minutesReliability: round(minutesReliability, 2),
    prevSeasonXGI90: round(prevSeasonXGI90, 2),
    hasMultiSeasonData,
    isTop20CaptaincyElite,
    captaincyEliteRank: historical?.captaincyEliteRank || null,
    isHistoricalElite,
    transferPenalty,
    eliteEntryScore: eliteEntry?.eliteScore || 0,
    // Captaincy score: weighted combination of all factors
    captaincyScore: (() => {
      const avgFdr = fixtures.length > 0 ? fixtures.reduce((s, f) => s + f.fdr, 0) / fixtures.length : 3;
      const isHome = fixtures.length > 0 ? fixtures[0].isHome : true;
      const firstOppId = fixtures.length > 0 ? fixtures[0].opponentId : null;
      const oppHist = firstOppId ? (allOpponentHistory[firstOppId] || null) : null;
      const baseScore = computeCaptaincyScore({
        xPts: totalXpts,
        form: effectiveForm,
        ppg: effectivePPG,
        xGI90: xG90 + xA90,
        position,
        fdr: avgFdr,
        isHome,
        eliteScore: eliteEntry?.eliteScore || (isHistoricalElite ? 60 : 0),
        h2hAppearances: oppHist?.appearances || 0,
        h2hPointsPerGame: oppHist ? (oppHist.points / Math.max(oppHist.appearances, 1)) : 0,
        h2hHaulRate: oppHist ? (oppHist.hauls / Math.max(oppHist.appearances, 1)) : 0,
        hasPenalties: number(player.penalties_order) === 1,
        hasFreeKicks: number(player.direct_freekicks_order) === 1,
        hasCorners: number(player.corners_and_indirect_freekicks_order) === 1,
        minutesReliability: cs?.minutesReliability || 0,
        consistencyScore: cs?.consistencyScore || 0,
        transferPenalty,
      });
      // Apply rotation risk penalty to captaincy score
      return { ...baseScore, finalScore: Math.round(baseScore.finalScore * rotationRisk.penalty * 10) / 10 };
    })(),
    // Rotation risk from fixture schedule analysis
    rotationRisk: {
      penalty: rotationRisk.penalty,
      reasons: rotationRisk.reasons,
      restDays: rotationRisk.restDays,
      isMidweek: rotationRisk.isMidweek,
      gwCongestion: rotationRisk.gwCongestion,
      daysUntilNext: rotationRisk.daysUntilNext,
    },
    // Is this player a viable captaincy candidate from the curated elite list
    isEliteCaptaincyCandidate: isTop20CaptaincyElite,
    reason: `${fixtureDetail}. ${totalXmins} xMins, ${profileText} and ${formText} produce ${totalXpts.toFixed(1)} xPts.${roleText}${hasMultiSeasonData ? ` Multi-season consistency: ${round(consistencyScore * 100)}%.` : ''}${transferPenalty < 1 ? ' Club change reduces historical weight.' : ''}${rotationRisk.reasons.length > 0 ? ` Rotation risk: ${rotationRisk.reasons[0]}.` : ''}`,
  };
}

function buildPickExplanation(pick, bestPick, isDifferential) {
  const profile = pick.position === 'MID' || pick.position === 'FWD'
    ? `${pick.xGI90.toFixed(2)} xGI/90`
    : pick.position === 'GKP'
      ? `${number(pick.savesPer90).toFixed(1)} saves/90`
      : 'clean-sheet and attacking routes';
  const fixtureText = pick.fixtures.map(fixture =>
    `${fixture.opponent} (${fixture.venue}) is a ${fixture.tone} FDR ${fixture.fdr} fixture`
  ).join('; ');
  const roleText = pick.roles.length ? ` ${pick.name} also has ${pick.roles.join(' and ')}.` : '';

  if (isDifferential) {
    const gap = round(Math.max(0, bestPick.xPts - pick.xPts));
    return `At ${pick.ownership.toFixed(1)}% ownership, ${pick.name} offers the strongest low-owned projection at ${pick.xPts.toFixed(1)} xPts, ${gap.toFixed(1)} behind the model leader. ${fixtureText}, while ${pick.xMins} xMins and ${profile} support the upside.${roleText}`;
  }

  return `${pick.name} leads the model at ${pick.xPts.toFixed(1)} xPts. ${fixtureText}. ${pick.xMins} xMins limits appearance risk, while ${profile} and a ${pick.formUsed.toFixed(1)} ${pick.formSource} rating provide the strongest overall points profile.${roleText}`;
}

async function buildCaptaincyModel({ bootstrap, fixtures, selectedGW }) {
  const events = bootstrap.events || [];
  const elements = bootstrap.elements || [];
  const teams = bootstrap.teams || [];
  const teamsById = new Map(teams.map(team => [team.id, team]));
  const currentGW = events.find(event => event.is_current)?.id || null;
  const nextGW = events.find(event => event.is_next)?.id || currentGW || 1;
  const requestedGW = Number.parseInt(selectedGW, 10);
  const gameweek = Number.isInteger(requestedGW) && requestedGW >= 1 && requestedGW <= 38 ? requestedGW : nextGW;
  const availableGameweeks = [...new Set(fixtures.map(fixture => fixture.event).filter(Boolean))].sort((a, b) => a - b);
  const gwFixtures = fixtures.filter(fixture => fixture.event === gameweek && !fixture.finished);
  const fixturesByTeam = new Map();
  gwFixtures.forEach(fixture => {
    [fixture.team_h, fixture.team_a].forEach(teamId => {
      if (!fixturesByTeam.has(teamId)) fixturesByTeam.set(teamId, []);
      fixturesByTeam.get(teamId).push(fixture);
    });
  });
  fixturesByTeam.forEach(teamFixtures => teamFixtures.sort((a, b) =>
    String(a.kickoff_time || '').localeCompare(String(b.kickoff_time || ''))
  ));

  const seasonHasStarted = fixtures.some(fixture => fixture.started || fixture.finished);
  const completedMatchesByTeam = new Map(teams.map(team => [
    team.id,
    fixtures.filter(fixture => fixture.finished && (fixture.team_h === team.id || fixture.team_a === team.id)).length,
  ]));
  const baselines = buildPositionBaselines(elements);
  const useNextRoundChance = gameweek === nextGW;
  const useOfficialProjection = gameweek === nextGW;
  const teamExperience = buildTeamExperience(elements);
  const teamPositionCosts = buildTeamPositionCosts(elements);

  let historicalData = null;
  try {
    const insights = getFplInsightsData();
    if (insights.getHistoricalPlayerStats) {
      historicalData = await insights.getHistoricalPlayerStats();
    }
  } catch { /* ignore */ }

  const candidates = elements
    .filter(player => fixturesByTeam.has(player.team) && player.special !== true)
    .map(player => buildCandidate({
      player,
      playerFixtures: fixturesByTeam.get(player.team),
      teamsById,
      referenceMatches: seasonHasStarted
        ? Math.max(completedMatchesByTeam.get(player.team) || 0, number(player.starts), 1)
        : 38,
      baselines,
      useNextRoundChance,
      useOfficialProjection,
      teamExperience,
      teamPositionCosts,
      historicalData,
      currentGW: gameweek,
      allFixtures: fixtures,
    }))
    .filter(Boolean)
    .filter(candidate => {
      // Must be active and available to play
      if (candidate.availability <= 0 || candidate.xMinsPerFixture < 45) return false;
      // Include: curated elite, historical elite, sustained performers, or any player with meaningful xPts
      // Lowered threshold from 4.5 to 3.0 so captaincy always has results for upcoming GWs
      return candidate.isTop20CaptaincyElite || candidate.isHistoricalElite || candidate.hasSustainedExcellence || candidate.xPts >= 3.0;
    })
    .sort((a, b) => {
      // Primary sort: captaincyScore (the new weighted formula)
      const aScore = a.captaincyScore?.finalScore || a.xPts;
      const bScore = b.captaincyScore?.finalScore || b.xPts;
      if (bScore !== aScore) return bScore - aScore;
      // Secondary: xPts for tiebreak
      if (b.xPts !== a.xPts) return b.xPts - a.xPts;
      // Tertiary: upside
      return b.upside - a.upside;
    });

  const bestPick = candidates[0] || null;
  const topPicks = candidates.slice(0, 5).map((candidate, index) => ({ ...candidate, rank: index + 1 }));
  let differentialThreshold = 10;
  let differentialPick = candidates.find(candidate =>
    candidate.id !== bestPick?.id &&
    candidate.position !== 'GKP' &&
    candidate.ownership < differentialThreshold &&
    candidate.xMinsPerFixture >= 60 &&
    candidate.xPts >= Math.max(4, (bestPick?.xPts || 0) * 0.7)
  );
  if (!differentialPick) {
    differentialThreshold = 15;
    differentialPick = candidates.find(candidate =>
      candidate.id !== bestPick?.id &&
      candidate.position !== 'GKP' &&
      candidate.ownership < differentialThreshold &&
      candidate.xMinsPerFixture >= 55
    ) || candidates.find(candidate => candidate.id !== bestPick?.id && candidate.position !== 'GKP' && candidate.ownership < differentialThreshold) || null;
  }

  const rankedDifferential = differentialPick
    ? { ...differentialPick, overallRank: candidates.findIndex(candidate => candidate.id === differentialPick.id) + 1 }
    : null;

  // Build side-by-side comparison between best pick and differential pick
  function buildComparison(best, diff) {
    if (!best || !diff) return null;

    // H2H fixture comparison
    const fixtureCompare = best.fixtures.map((bf, i) => {
      const df = diff.fixtures[i];
      return {
        best: { label: bf.label, fdr: bf.fdr, venue: bf.venue, xPts: bf.xPts, opponentFull: bf.opponentFull, tone: bf.tone },
        diff: df ? { label: df.label, fdr: df.fdr, venue: df.venue, xPts: df.xPts, opponentFull: df.opponentFull, tone: df.tone } : null,
      };
    });

    // Form comparison
    const formDelta = round(diff.formUsed - best.formUsed, 2);
    const formWinner = formDelta > 0 ? 'diff' : formDelta < 0 ? 'best' : 'tie';

    // xGI comparison
    const xgiDelta = round(diff.xGI90 - best.xGI90, 2);
    const xgiWinner = xgiDelta > 0 ? 'diff' : xgiDelta < 0 ? 'best' : 'tie';

    // xPts comparison
    const xptsDelta = round(diff.xPts - best.xPts, 2);
    const xptsWinner = xptsDelta > 0 ? 'diff' : xptsDelta < 0 ? 'best' : 'tie';

    // Ownership differential
    const ownershipGap = round(best.ownership - diff.ownership, 1);

    // Fixture difficulty comparison
    const bestAvgFdr = best.fixtures.length > 0 ? round(best.fixtures.reduce((s, f) => s + f.fdr, 0) / best.fixtures.length, 1) : 3;
    const diffAvgFdr = diff.fixtures.length > 0 ? round(diff.fixtures.reduce((s, f) => s + f.fdr, 0) / diff.fixtures.length, 1) : 3;

    // Rotation risk comparison
    const bestRotation = best.rotationRisk || {};
    const diffRotation = diff.rotationRisk || {};

    // Set-piece / role comparison
    const bestRoles = best.roles || [];
    const diffRoles = diff.roles || [];

    // Historical H2H vs upcoming opponent
    const bestOppHist = best.fixtures[0] ? { appearances: best.fixtures[0].oppHistAppearances || 0, ppg: best.fixtures[0].oppHistPPG || 0 } : { appearances: 0, ppg: 0 };
    const diffOppHist = diff.fixtures[0] ? { appearances: diff.fixtures[0].oppHistAppearances || 0, ppg: diff.fixtures[0].oppHistPPG || 0 } : { appearances: 0, ppg: 0 };

    // Head-to-head summary
    const advantages = [];
    if (xptsDelta > 0.3) advantages.push({ player: 'diff', reason: `${diff.xPts.toFixed(1)} vs ${best.xPts.toFixed(1)} xPts` });
    else if (xptsDelta < -0.3) advantages.push({ player: 'best', reason: `${best.xPts.toFixed(1)} vs ${diff.xPts.toFixed(1)} xPts` });
    if (formDelta > 0.3) advantages.push({ player: 'diff', reason: `Better form (${diff.formUsed.toFixed(1)} vs ${best.formUsed.toFixed(1)})` });
    else if (formDelta < -0.3) advantages.push({ player: 'best', reason: `Better form (${best.formUsed.toFixed(1)} vs ${diff.formUsed.toFixed(1)})` });
    if (xgiDelta > 0.05) advantages.push({ player: 'diff', reason: `Higher xGI (${diff.xGI90.toFixed(2)} vs ${best.xGI90.toFixed(2)} /90)` });
    else if (xgiDelta < -0.05) advantages.push({ player: 'best', reason: `Higher xGI (${best.xGI90.toFixed(2)} vs ${diff.xGI90.toFixed(2)} /90)` });
    if (diffAvgFdr < bestAvgFdr - 0.3) advantages.push({ player: 'diff', reason: `Easier fixture (FDR ${diffAvgFdr} vs ${bestAvgFdr})` });
    else if (bestAvgFdr < diffAvgFdr - 0.3) advantages.push({ player: 'best', reason: `Easier fixture (FDR ${bestAvgFdr} vs ${diffAvgFdr})` });
    if (diffRoles.length > bestRoles.length) advantages.push({ player: 'diff', reason: `More set-piece duties (${diffRoles.join(', ')})` });
    if (diffOppHist.appearances >= 2 && diffOppHist.ppg > bestOppHist.ppg + 1) advantages.push({ player: 'diff', reason: `Better H2H record vs opponent (${diffOppHist.ppg.toFixed(1)} vs ${bestOppHist.ppg.toFixed(1)} PPG)` });

    return {
      bestPick: {
        name: best.name,
        team: best.team,
        position: best.position,
        cost: best.cost,
        xPts: best.xPts,
        formUsed: best.formUsed,
        xGI90: best.xGI90,
        ownership: best.ownership,
        xMins: best.xMins,
        confidence: best.confidence,
        fixtures: fixtureCompare.map(f => f.best),
        rotationPenalty: bestRotation.penalty,
        rotationReasons: bestRotation.reasons || [],
        roles: bestRoles,
        captaincyScore: best.captaincyScore?.finalScore || 0,
        oppHistAppearances: bestOppHist.appearances,
        oppHistPPG: bestOppHist.ppg,
      },
      diffPick: {
        name: diff.name,
        team: diff.team,
        position: diff.position,
        cost: diff.cost,
        xPts: diff.xPts,
        formUsed: diff.formUsed,
        xGI90: diff.xGI90,
        ownership: diff.ownership,
        xMins: diff.xMins,
        confidence: diff.confidence,
        fixtures: fixtureCompare.map(f => f.diff),
        rotationPenalty: diffRotation.penalty,
        rotationReasons: diffRotation.reasons || [],
        roles: diffRoles,
        captaincyScore: diff.captaincyScore?.finalScore || 0,
        oppHistAppearances: diffOppHist.appearances,
        oppHistPPG: diffOppHist.ppg,
      },
      deltas: {
        xPts: xptsDelta,
        form: formDelta,
        xGI90: xgiDelta,
        ownership: ownershipGap,
        avgFdr: round(bestAvgFdr - diffAvgFdr, 1),
      },
      advantages,
    };
  }

  return {
    gameweek,
    selectedGW: gameweek,
    currentGW,
    nextGW,
    availableGameweeks,
    generatedAt: new Date().toISOString(),
    modelVersion: 'Captaincy Score v3.0 - Elite Pool + H2H + Transfer Detection',
    modelInputs: ['fixtures', 'form', 'xMins', 'xG', 'xA', 'PPG', 'availability', 'set pieces', 'bonus'],
    bestPick: bestPick ? { ...bestPick, explanation: buildPickExplanation(bestPick, bestPick, false) } : null,
    differentialPick: rankedDifferential ? {
      ...rankedDifferential,
      threshold: differentialThreshold,
      explanation: buildPickExplanation(rankedDifferential, bestPick, true),
      comparison: buildComparison(bestPick, rankedDifferential),
    } : null,
    topPicks,
  };
}

async function buildPlayerProjections({ bootstrap, fixtures, startGW, horizon = 5 }) {
  const events = bootstrap.events || [];
  const elements = bootstrap.elements || [];
  const teams = bootstrap.teams || [];
  const teamsById = new Map(teams.map(team => [team.id, team]));
  const currentGW = events.find(event => event.is_current)?.id || null;
  const nextGW = events.find(event => event.is_next)?.id || currentGW || 1;
  const requestedGW = Number.parseInt(startGW, 10);
  const firstGW = Number.isInteger(requestedGW) && requestedGW >= 1 && requestedGW <= 38 ? requestedGW : nextGW;
  const safeHorizon = clamp(Number.parseInt(horizon, 10) || 5, 1, 8);
  const gameweeks = Array.from({ length: Math.min(safeHorizon, 39 - firstGW) }, (_, index) => firstGW + index);
  const seasonHasStarted = fixtures.some(fixture => fixture.started || fixture.finished);
  const completedMatchesByTeam = new Map(teams.map(team => [
    team.id,
    fixtures.filter(fixture => fixture.finished && (fixture.team_h === team.id || fixture.team_a === team.id)).length,
  ]));
  const baselines = buildPositionBaselines(elements);
  const teamExperience = buildTeamExperience(elements);
  const teamPositionCosts = buildTeamPositionCosts(elements);

  let historicalData = null;
  try {
    const insights = getFplInsightsData();
    if (insights.getHistoricalPlayerStats) {
      historicalData = await insights.getHistoricalPlayerStats();
    }
  } catch { /* ignore */ }

  const projections = elements.map(player => {
    const buildForGameweek = gameweek => {
      const playerFixtures = fixtures
        .filter(fixture => fixture.event === gameweek && !fixture.finished && (fixture.team_h === player.team || fixture.team_a === player.team))
        .sort((a, b) => String(a.kickoff_time || '').localeCompare(String(b.kickoff_time || '')));
      if (!playerFixtures.length) return null;
      return buildCandidate({
        player,
        playerFixtures,
        teamsById,
        referenceMatches: seasonHasStarted
          ? Math.max(completedMatchesByTeam.get(player.team) || 0, number(player.starts), 1)
          : 38,
        baselines,
        useNextRoundChance: gameweek === nextGW,
        useOfficialProjection: gameweek === nextGW,
        teamExperience,
        teamPositionCosts,
        historicalData,
        currentGW: gameweek,
        allFixtures: fixtures,
      });
    };
    const candidates = gameweeks.map(buildForGameweek);
    const weekly = candidates.map((candidate, index) => candidate
      ? { gameweek: gameweeks[index], xPts: candidate.xPts, xMins: candidate.xMins, fixtures: candidate.fixtures, confidence: candidate.confidence }
      : { gameweek: gameweeks[index], xPts: 0, xMins: 0, fixtures: [], confidence: 'Blank' });
    const firstCandidate = candidates[0];
    const totalXpts = round(weekly.reduce((sum, week) => sum + week.xPts, 0));
    const availability = availabilityFor(player, firstGW === nextGW);
    const xMins = weekly[0]?.xMins || 0;
    const uncertainty = clamp(0.18 + ((90 - Math.min(xMins, 90)) / 90 * 0.42) + ((1 - availability) * 0.35), 0.16, 0.72);

    return {
      id: player.id,
      name: player.web_name,
      fullName: [player.first_name, player.second_name].filter(Boolean).join(' '),
      code: player.code,
      teamId: player.team,
      team: teamsById.get(player.team)?.short_name || '?',
      position: POSITION_MAP[player.element_type - 1],
      elementType: player.element_type,
      cost: number(player.now_cost) / 10,
      ownership: round(number(player.selected_by_percent)),
      form: round(number(player.form)),
      xG90: firstCandidate?.xG90 || round(number(player.expected_goals_per_90), 2),
      xA90: firstCandidate?.xA90 || round(number(player.expected_assists_per_90), 2),
      xGI90: firstCandidate?.xGI90 || round(number(player.expected_goal_involvements_per_90), 2),
      defensiveContributionPer90: round(number(player.defensive_contribution_per_90), 2),
      roles: firstCandidate?.roles || describeRole(player),
      availability: round(availability * 100, 0),
      status: player.status || 'a',
      news: player.news || '',
      totalXpts,
      xPtsPerMillion: round(totalXpts / Math.max(number(player.now_cost) / 10, 0.1), 2),
      weekly,
      range: {
        low: round(totalXpts * (1 - uncertainty)),
        expected: totalXpts,
        high: round(totalXpts * (1 + uncertainty + Math.min(number(player.expected_goal_involvements_per_90), 1) * 0.12)),
      },
      returnProbability: round(clamp(1 - Math.exp(-Math.max(totalXpts - gameweeks.length, 0) / 4), 0.04, 0.88) * 100, 0),
      haulProbability: round(clamp((totalXpts / Math.max(gameweeks.length, 1) - 3) * 8 + number(player.expected_goal_involvements_per_90) * 18, 2, 58), 0),
      confidence: firstCandidate?.confidence || (availability === 0 ? 'Unavailable' : 'Low sample'),
      starterScore: firstCandidate?.starterScore ?? estimateStarterScore(player, teamExperience, teamPositionCosts, { xMins: weekly[0]?.xMins || 0 }),
      starterTier: firstCandidate?.starterTier || starterTierFor(firstCandidate?.starterScore ?? estimateStarterScore(player, teamExperience, teamPositionCosts)),
      isStarter: firstCandidate?.isStarter ?? estimateStarterScore(player, teamExperience, teamPositionCosts) >= 55,
    };
  }).sort((a, b) => b.totalXpts - a.totalXpts || b.xPtsPerMillion - a.xPtsPerMillion);

  return { startGW: firstGW, nextGW, gameweeks, horizon: gameweeks.length, projections };
}

module.exports = {
  buildCaptaincyModel,
  buildPlayerProjections,
  estimateExpectedMinutes,
  estimateStarterScore,
  starterTierFor,
  detectRotationRisk,
};
