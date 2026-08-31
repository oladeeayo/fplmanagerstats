// src/server/decisionLabEngine.js
// Decision Lab Engine — strengthened transfer decision system
// Separates Player Rating from Transfer Rating, adds multi-horizon analysis,
// Bayesian evidence weighting, uncertainty, regression detection, and more.

function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }
function round(v, p = 1) { return Math.round(v * 10 ** p) / 10 ** p; }
function lerp(a, b, t) { return a + (b - a) * t; }

// ============================================================
// EARLY-SEASON CONFIDENCE DAMPENER
// ============================================================
// When only 1–2 gameweeks of data exist, projections are dominated by
// prior/historical estimates. We must cap confidence, probability and
// sell urgency so the model doesn't over-commit from thin evidence.
function earlySeasonDampener(currentGW) {
  const gw = clamp(currentGW || 1, 1, 38);
  // GW 1-2: very thin evidence — cap hard at ~65 % confidence
  if (gw <= 2) return { confidenceCap: 65, probabilityCap: 68, urgencyPenalty: 0.45, sellThresholdBoost: 4, label: 'Early season — thin evidence' };
  // GW 3-5: still noisy — cap at ~78 %
  if (gw <= 5) return { confidenceCap: 78, probabilityCap: 78, urgencyPenalty: 0.30, sellThresholdBoost: 2.5, label: 'Early season — building evidence' };
  // GW 6-8: moderate signal — cap at ~86 %
  if (gw <= 8) return { confidenceCap: 86, probabilityCap: 85, urgencyPenalty: 0.15, sellThresholdBoost: 1, label: 'Moderate sample — improving signal' };
  // GW 9+: mature model
  return { confidenceCap: 95, probabilityCap: 92, urgencyPenalty: 0, sellThresholdBoost: 0, label: 'Mature model' };
}
function median(arr) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// ============================================================
// 1. MULTI-HORIZON FRAMEWORK
// ============================================================

const HORIZONS = {
  nextGW: { label: 'Next Gameweek', gwCount: 1 },
  short:  { label: 'Next 3 GW', gwCount: 3 },
  medium: { label: 'Next 5 GW', gwCount: 5 },
  long:   { label: 'Next 8 GW', gwCount: 8 },
  season: { label: 'Rest of Season', gwCount: 'full' },
};

function computeHorizonPoints(weekly, gwCount) {
  if (!Array.isArray(weekly) || !weekly.length) return 0;
  const n = gwCount === 'full' ? weekly.length : Math.min(gwCount, weekly.length);
  let total = 0;
  for (let i = 0; i < n; i++) {
    total += Number(weekly[i]?.xPts) || 0;
  }
  return round(total);
}

// ============================================================
// 2. BAYESIAN EVIDENCE WEIGHTING (Early-Season Engine)
// ============================================================

function earlySeasonWeights(currentGW) {
  const gw = clamp(currentGW || 1, 1, 38);
  if (gw <= 2)  return { currentSeason: 0.05, previousSeason: 0.55, historical: 0.18, preseason: 0.12, context: 0.10 };
  if (gw <= 5)  return { currentSeason: 0.25, previousSeason: 0.40, historical: 0.12, preseason: 0.08, context: 0.15 };
  if (gw <= 10) return { currentSeason: 0.55, previousSeason: 0.25, historical: 0.08, preseason: 0.02, context: 0.10 };
  if (gw <= 20) return { currentSeason: 0.70, previousSeason: 0.18, historical: 0.05, preseason: 0.00, context: 0.07 };
  return           { currentSeason: 0.78, previousSeason: 0.13, historical: 0.04, preseason: 0.00, context: 0.05 };
}

function bayesianBlend(player, currentGW) {
  const w = earlySeasonWeights(currentGW);
  const currentRate = player.xGI90 || 0;
  const historicalRate = player.prevSeasonXGI90 || player.xGI90 || 0;
  const sampleSize = Math.min((player.minutes || 0) / 90, 38);
  // Bayesian shrinkage: more samples → more weight on current
  const shrinkage = sampleSize / (sampleSize + 8); // K=8 (prior strength)
  const blended = currentRate * shrinkage + historicalRate * (1 - shrinkage);
  return {
    blendedXGI90: round(blended, 3),
    shrinkage: round(shrinkage, 3),
    sampleSize: round(sampleSize, 1),
    priorStrength: 8,
    effectiveWeight: w,
  };
}

// ============================================================
// 3. PLAYER STRENGTH SCORE (0-100)
// ============================================================

function computePlayerStrengthScore(player, options = {}) {
  const currentGW = options.currentGW || 1;
  const horizon = options.horizon || 5;

  // Expected FPL output (25%)
  const xPtsScore = clamp((player.totalXpts || 0) / Math.max(horizon * 7, 1) * 100, 0, 100);

  // Underlying statistics (15%)
  const xgi90 = player.xGI90 || 0;
  const underlyingScore = clamp(xgi90 / 0.8 * 100, 0, 100);

  // Minutes/security (15%)
  const minutesProb = player.startProbability || clamp((player.xMins || 0) / 90, 0, 1);
  const minutesScore = minutesProb * 100;

  // Fixtures (15%)
  const avgFdr = player.weekly?.length > 0
    ? player.weekly.reduce((s, w) => {
        const fdr = w.fixtures?.[0]?.fdr || 3;
        return s + fdr;
      }, 0) / player.weekly.length
    : 3;
  const fixtureScore = clamp((5 - avgFdr) / 4 * 100, 0, 100);

  // Team strength (10%)
  const teamScore = clamp((player.teamAttackRating || 1.3) / 2.5 * 100, 0, 100);

  // Role/position (7%)
  const roleScore = player.starterScore || 50;

  // Value (5%)
  const xPtsPerMillion = player.xPtsPerMillion || 0;
  const valueScore = clamp(xPtsPerMillion / 0.8 * 100, 0, 100);

  // Bonus/defensive contribution (3%)
  const bonusScore = clamp((player.upside || 0) / 4 * 100, 0, 100);

  // Set pieces/penalties (3%)
  const setPieceScore = (player.roles && player.roles.length > 0) ? 80 : 30;

  // Historical evidence (2%)
  const historicalScore = player.hasMultiSeasonData ? 85 : (player.consistencyScore || 0.3) * 100;

  // New-league penalty (reduces strength score for unproven foreign players)
  const translation = computeNewLeagueAdjustment(player, options);
  const newLeaguePenalty = translation.adjusted ? (1 - translation.adjustment) * 15 : 0;

  const raw =
    xPtsScore * 0.25 +
    underlyingScore * 0.15 +
    minutesScore * 0.15 +
    fixtureScore * 0.15 +
    teamScore * 0.10 +
    roleScore * 0.07 +
    valueScore * 0.05 +
    bonusScore * 0.03 +
    setPieceScore * 0.03 +
    historicalScore * 0.02;

  return {
    score: round(clamp(raw, 0, 100)),
    components: {
      expectedOutput: round(xPtsScore),
      underlyingStats: round(underlyingScore),
      minutesSecurity: round(minutesScore),
      fixtures: round(fixtureScore),
      teamStrength: round(teamScore),
      role: round(roleScore),
      value: round(valueScore),
      bonusContrib: round(bonusScore),
      setPieces: round(setPieceScore),
      historical: round(historicalScore),
    },
  };
}

// ============================================================
// 4. UNCERTAINTY MODEL
// ============================================================

function computeUncertainty(player, options = {}) {
  let uncertainty = 0.18; // base uncertainty

  // New signing / new team
  if (player.transferPenalty && player.transferPenalty < 1) {
    uncertainty += (1 - player.transferPenalty) * 0.25;
  }

  // New-league translation uncertainty
  const translation = computeNewLeagueAdjustment(player, options);
  if (translation.adjusted) {
    // Higher confidence decay = more uncertainty
    uncertainty += translation.confidenceDecay * 0.30;
  }

  // Small sample
  const sampleSize = (player.minutes || 0) / 90;
  if (sampleSize < 3) uncertainty += 0.20;
  else if (sampleSize < 8) uncertainty += 0.12;
  else if (sampleSize < 15) uncertainty += 0.06;

  // Minutes risk
  if ((player.xMins || 0) < 60) uncertainty += 0.12;
  else if ((player.xMins || 0) < 75) uncertainty += 0.05;

  // Availability
  const avail = player.availability || 100;
  if (avail < 75) uncertainty += 0.15;
  else if (avail < 90) uncertainty += 0.06;

  // Role uncertainty (low starter score)
  if ((player.starterScore || 50) < 40) uncertainty += 0.15;
  else if ((player.starterScore || 50) < 60) uncertainty += 0.06;

  // Multi-season data reduces uncertainty
  if (player.hasMultiSeasonData) uncertainty -= 0.06;

  uncertainty = clamp(uncertainty, 0.10, 0.75);

  return {
    uncertainty: round(uncertainty, 3),
    tier: uncertainty < 0.22 ? 'Very high confidence'
        : uncertainty < 0.32 ? 'High confidence'
        : uncertainty < 0.42 ? 'Medium confidence'
        : uncertainty < 0.55 ? 'Low confidence'
        : 'Very low confidence',
    intervals: {
      expected: round(player.totalXpts || 0),
      low: round((player.totalXpts || 0) * (1 - uncertainty)),
      high: round((player.totalXpts || 0) * (1 + uncertainty + 0.08)),
    },
    newLeague: translation.adjusted ? translation : null,
  };
}

// ============================================================
// 5. REGRESSION & SUSTAINABILITY ENGINE
// ============================================================

function detectRegression(player) {
  const goals = player.totalGoals || 0;
  const xG = (player.xG90 || 0) * Math.max((player.minutes || 0) / 90, 1);
  const xGI = (player.xGI90 || 0) * Math.max((player.minutes || 0) / 90, 1);
  const points = player.totalXpts || 0;

  const goalsPerXG = xG > 0 ? goals / xG : 1;
  const xGIoverPoints = points > 0 ? xGI / points : 1;

  let status = 'Sustainable';
  let signal = 'neutral';
  let explanation = '';

  if (goalsPerXG > 1.8) {
    status = 'Overperforming — regression candidate';
    signal = 'sell';
    explanation = `Scored ${goals} goals from ${round(xG, 2)} xG (${round(goalsPerXG, 2)}x conversion rate). Expect regression.`;
  } else if (goalsPerXG > 1.4) {
    status = 'Mild overperformance';
    signal = 'caution';
    explanation = `Slightly above expected finishing (${round(goalsPerXG, 2)}x). Monitor underlying numbers.`;
  } else if (goalsPerXG < 0.5 && goals > 0) {
    status = 'Underperforming — improvement candidate';
    signal = 'buy';
    explanation = `Only ${goals} goals from ${round(xG, 2)} xG. Significant finishing underperformance.`;
  } else if (goalsPerXG < 0.75 && goals >= 2) {
    status = 'Mild underperformance';
    signal = 'positive';
    explanation = `Below expected conversion (${round(goalsPerXG, 2)}x). Could improve.`;
  } else if (goals === 0 && xG > 1.5) {
    status = 'Strong buy candidate (zero goals, high xG)';
    signal = 'buy';
    explanation = `${round(xG, 2)} xG with zero goals — highly likely to score soon.`;
  }

  return { status, signal, explanation, goalsPerXG: round(goalsPerXG, 2), xGIoverPoints: round(xGIoverPoints, 2) };
}

function detectHotStreak(player) {
  const xG = player.xGI90 || 0;
  const form = player.form || 0;
  const ppg = player.ppg || 0;

  const formAboveBaseline = form > 0 && ppg > 0 && form > ppg * 1.3;
  const xGIHigh = xG > 0.6;

  // Check if underlying stats support the form
  const underlyingSupport = xGIHigh || (player.improvementRatio && player.improvementRatio > 1.1);

  let classification = 'Normal form';
  if (formAboveBaseline && underlyingSupport) {
    classification = 'Genuine improvement — underlying stats support form';
  } else if (formAboveBaseline && !underlyingSupport) {
    classification = 'Potentially unsustainable finishing spike';
  } else if (xGIHigh && form < ppg) {
    classification = 'Underperforming — buy before points';
  }

  return {
    classification,
    formAboveBaseline,
    underlyingSupport,
    xGIHigh,
    preHaulCandidate: xGIHigh && form < ppg && player.ownership < 15,
  };
}

// ============================================================
// 6. POSITION-SPECIFIC FIXTURE DIFFICULTY
// ============================================================

function positionFixtureDifficulty(fixture, teamId, position) {
  const isHome = fixture.team_h === teamId;
  const fdr = isHome ? (fixture.team_h_difficulty || 3) : (fixture.team_a_difficulty || 3);

  // Attacking difficulty (for MID/FWD): lower FDR = easier to score
  // Defensive difficulty (for DEF/GKP): lower FDR = easier to keep CS
  const attackingFDR = fdr; // same base
  const defensiveFDR = fdr;

  // Position adjustments: some teams are strong defensively but weak offensively
  // We model this as a ±1 modifier based on position
  let adjustedFDR = fdr;
  if (position === 'DEF' || position === 'GKP') {
    // DEF/GKP: clean sheet difficulty matters more
    // Home/away bonus: home teams concede ~15% fewer goals
    adjustedFDR = isHome ? Math.max(1, fdr - 0.5) : Math.min(5, fdr + 0.3);
  } else if (position === 'MID' || position === 'FWD') {
    // MID/FWD: attacking opportunity matters more
    // Home teams score ~20% more goals
    adjustedFDR = isHome ? Math.max(1, fdr - 0.7) : Math.min(5, fdr + 0.2);
  }

  return {
    raw: fdr,
    attacking: round(attackingFDR, 1),
    defensive: round(defensiveFDR, 1),
    positionAdjusted: round(adjustedFDR, 1),
    tone: adjustedFDR <= 1.5 ? 'very favourable'
        : adjustedFDR <= 2.5 ? 'favourable'
        : adjustedFDR <= 3.5 ? 'balanced'
        : adjustedFDR <= 4.5 ? 'difficult'
        : 'very difficult',
  };
}

// ============================================================
// 7. MINUTES PROBABILITY MODEL
// ============================================================

function computeMinutesProbability(player) {
  const minutes = player.minutes || 0;
  const starts = player.starts || 0;
  const totalGWs = Math.max(1, Math.ceil(minutes / 90));
  const availability = (player.availability || 100) / 100;
  const starterScore = player.starterScore || 50;
  const xMins = player.xMins || 0;

  const startRate = totalGWs > 0 ? starts / totalGWs : 0;
  const avgMinutes = starts > 0 ? minutes / starts : (minutes > 0 ? minutes / Math.max(totalGWs, 1) : 0);

  // Early-season: when there's no current-season data (minutes < 180), lean heavily
  // on xMins and starterScore rather than the raw start rate which is meaningless at 0/0.
  const hasData = minutes >= 180; // at least 2 full matches of data
  let startProb;
  if (hasData) {
    // Normal: blend historical start rate with starter score
    startProb = clamp(
      startRate * 0.5 + (starterScore / 100) * 0.3 + availability * 0.2,
      0, 1
    );
  } else {
    // Early season: use xMins as primary signal (it already encodes historical data)
    const xMinsProb = clamp(xMins / 90, 0, 1);
    startProb = clamp(
      xMinsProb * 0.5 + (starterScore / 100) * 0.3 + availability * 0.2,
      0, 1
    );
    // Floor: never drop below 50% for available players with non-zero xMins
    if (availability >= 0.9 && xMins >= 60) {
      startProb = Math.max(startProb, 0.65);
    } else if (availability >= 0.75 && xMins >= 45) {
      startProb = Math.max(startProb, 0.50);
    }
  }

  // 60+ minute probability: if starts, probability of playing 60+
  const sixtyPlusGivenStart = avgMinutes >= 75 ? 0.88 : avgMinutes >= 60 ? 0.72 : 0.50;
  const sixtyPlusProb = startProb * sixtyPlusGivenStart;

  // Bench probability
  const benchProb = clamp(1 - startProb - (availability < 0.5 ? 0.3 : 0), 0, 0.5);

  // Rotation probability (high starter score + still some risk)
  const rotationProb = startProb > 0.6 && startProb < 0.9
    ? clamp((1 - startProb) * 0.8, 0, 0.4)
    : startProb < 0.6 ? clamp(1 - startProb, 0.2, 0.6) : 0.05;

  // Expected minutes
  const expectedMinutes = round(
    startProb * avgMinutes + (1 - startProb) * (benchProb > 0 ? 15 : 0),
    0
  );

  return {
    startProbability: round(startProb * 100),
    sixtyPlusProbability: round(sixtyPlusProb * 100),
    benchProbability: round(benchProb * 100),
    rotationProbability: round(rotationProb * 100),
    appearanceProbability: round(clamp(startProb + benchProb * 0.8, 0, 1) * 100),
    expectedMinutes: clamp(expectedMinutes, 0, 90),
    roleSecurity: starterScore >= 85 ? 'Nailed'
               : starterScore >= 70 ? 'High security'
               : starterScore >= 50 ? 'Moderate'
               : starterScore >= 30 ? 'Rotation risk'
               : 'Very high rotation risk',
    roleSecurityScore: round(starterScore),
  };
}

// ============================================================
// 8. TRANSFER DECISION SCORE
// ============================================================

function computeTransferDecisionScore(outgoing, incoming, options = {}) {
  const horizon = options.horizon || 5;
  const freeTransfers = options.freeTransfers || 1;
  const currentGW = options.currentGW || 1;

  // Expected points gain over horizon
  const outHorizonPts = computeHorizonPoints(outgoing.weekly, horizon);
  const inHorizonPts = computeHorizonPoints(incoming.weekly, horizon);
  const expectedGain = round(inHorizonPts - outHorizonPts);

  // Next GW gain
  const nextGain = round(
    (Number(incoming.weekly?.[0]?.xPts) || 0) - (Number(outgoing.weekly?.[0]?.xPts) || 0)
  );

  // Transfer cost
  const hitCost = freeTransfers > 0 ? 0 : 4;
  const netGain = round(expectedGain - hitCost);

  // Minutes difference
  const outMins = outgoing.xMins || 75;
  const inMins = incoming.xMins || 75;
  const minutesGain = round(inMins - outMins);

  // Fixture swing
  const outAvgFdr = averageFDR(outgoing.weekly);
  const inAvgFdr = averageFDR(incoming.weekly);
  const fixtureSwing = round(outAvgFdr - inAvgFdr, 2); // positive = easier fixtures

  // Role/security difference
  const outRole = outgoing.starterScore || 50;
  const inRole = incoming.starterScore || 50;
  const roleGain = round(inRole - outRole);

  // Underlying stat difference
  const outXGI = outgoing.xGI90 || 0;
  const inXGI = incoming.xGI90 || 0;
  const xgiGain = round(inXGI - outXGI, 3);

  // Player uncertainty
  const inUncertainty = computeUncertainty(incoming);
  const outUncertainty = computeUncertainty(outgoing);
  const uncertaintyPenalty = inUncertainty.uncertainty * 15; // 0-15 point penalty

  // Value difference
  const outValue = outgoing.xPtsPerMillion || 0;
  const inValue = incoming.xPtsPerMillion || 0;
  const valueGain = round(inValue - outValue, 2);

  // Squad structure bonus/penalty (simplified)
  const squadBonus = 0; // will be computed by squad-level analysis

  // Captaincy upside
  const captaincyBonus = (incoming.captaincyScore?.finalScore || 0) > 60 ? 5 : 0;

  // Raw decision score
  const rawScore =
    clamp(expectedGain * 6, -10, 30) +    // expected gain
    clamp(fixtureSwing * 4, -8, 12) +      // fixture swing
    clamp(roleGain * 0.2, -5, 5) +         // role gain
    clamp(minutesGain * 0.1, -3, 3) +      // minutes gain
    clamp(xgiGain * 20, -8, 10) +          // underlying stat gain
    clamp(valueGain * 3, -5, 5) +          // value gain
    clamp(captaincyBonus, 0, 8) +          // captaincy upside
    clamp(-hitCost, -8, 0) +               // hit cost
    clamp(-uncertaintyPenalty, -15, 0) +    // uncertainty
    50;                                     // base

  const score = round(clamp(rawScore, 0, 100));

  // Transfer probability (how often IN outperforms OUT in simulations - simplified)
  const dampener = earlySeasonDampener(currentGW);
  const rawProbability = 50 + expectedGain * 5 + fixtureSwing * 3 + roleGain * 0.3 - inUncertainty.uncertainty * 20;
  // Early season: pull probability toward 50 % (coin-flip) — less data means less edge
  const seasonAdjustedProbability = lerp(50, rawProbability, 1 - dampener.urgencyPenalty);
  const probabilityTransferWins = clamp(
    Math.round(seasonAdjustedProbability),
    15, dampener.probabilityCap
  );

  // Break-even GW
  const gainPerGW = horizon > 0 ? expectedGain / horizon : 0;
  const breakEvenGW = hitCost > 0 && gainPerGW > 0
    ? Math.ceil(hitCost / gainPerGW) + 1
    : gainPerGW > 0 ? 1 : Infinity;

  return {
    score,
    expectedGain,
    nextGain,
    netGain,
    hitCost,
    minutesGain,
    fixtureSwing: round(fixtureSwing),
    roleGain,
    xgiGain,
    valueGain,
    uncertainty: inUncertainty.uncertainty,
    uncertaintyTier: inUncertainty.tier,
    probabilityTransferWins: round(probabilityTransferWins),
    breakEvenGW: breakEvenGW === Infinity ? null : Math.min(breakEvenGW, horizon),
    captaincyBonus,
  };
}

function averageFDR(weekly) {
  if (!Array.isArray(weekly) || !weekly.length) return 3;
  let total = 0;
  let count = 0;
  for (const w of weekly) {
    for (const f of (w.fixtures || [])) {
      total += f.fdr || 3;
      count++;
    }
  }
  return count > 0 ? round(total / count, 2) : 3;
}

// ============================================================
// 9. TRANSFER URGENCY CLASSIFIER
// ============================================================

function classifyTransferUrgency(decisionScore, options = {}) {
  const { expectedGain, nextGain, hitCost, fixtureSwing, minutesGain, score } = decisionScore;
  const availability = options.incomingAvailability || 100;
  const priceRiseImminent = options.priceRiseImminent || false;

  // ACT NOW: strong improvement + urgent issue
  if (score >= 80 && (nextGain >= 4 || availability < 50 || priceRiseImminent)) {
    return 'ACT NOW';
  }

  // THIS GW: good transfer, not urgent
  if (score >= 68 && (expectedGain >= 3 || hitCost === 0 && expectedGain >= 2)) {
    return 'THIS GW';
  }

  // MONITOR: potentially good but insufficient evidence
  if (score >= 50 || (expectedGain > 0 && hitCost === 0)) {
    return 'MONITOR';
  }

  // WAIT: current player remains competitive
  if (score >= 35 || expectedGain > -2) {
    return 'WAIT';
  }

  // AVOID: incoming player doesn't justify transfer
  return 'AVOID';
}

// ============================================================
// 10. TRANSFER RECOMMENDATION CATEGORIES
// ============================================================

function classifyRecommendation(score, confidence) {
  if (score >= 82 && confidence >= 75) return { category: 'Strong Buy', emoji: '🟢🟢' };
  if (score >= 70 && confidence >= 60) return { category: 'Buy', emoji: '🟢' };
  if (score >= 58) return { category: 'Consider', emoji: '🟡' };
  if (score >= 45) return { category: 'Monitor', emoji: '🟡' };
  if (score >= 35) return { category: 'Wait', emoji: '🟠' };
  if (score >= 20) return { category: 'Hold', emoji: '🔴' };
  return { category: 'Avoid', emoji: '🔴' };
}

// ============================================================
// 11. DEVIL'S ADVOCATE LAYER
// ============================================================

function devilAdvocate(outgoing, incoming, decisionScore) {
  const risks = [];

  // Regression risk for incoming
  const regression = detectRegression(incoming);
  if (regression.signal === 'sell' || regression.signal === 'caution') {
    risks.push({ type: 'Regression risk', detail: regression.explanation });
  }

  // Rotation risk
  const minsProb = computeMinutesProbability(incoming);
  if (minsProb.rotationProbability > 25) {
    risks.push({ type: 'Rotation risk', detail: `${minsProb.rotationProbability}% rotation probability. ${minsProb.roleSecurity} role security.` });
  }

  // Fixture difficulty
  if (decisionScore.fixtureSwing < -0.5) {
    risks.push({ type: 'Fixture concern', detail: `Incoming player faces harder fixtures (FDR swing: ${decisionScore.fixtureSwing.toFixed(1)})` });
  }

  // Small sample
  if ((incoming.minutes || 0) < 270) {
    risks.push({ type: 'Small sample', detail: `Only ${Math.round((incoming.minutes || 0) / 90)} full matches of data` });
  }

  // Availability
  if ((incoming.availability || 100) < 85) {
    risks.push({ type: 'Availability concern', detail: `${incoming.availability}% modeled availability` });
  }

  // Price/value trap
  if (decisionScore.xgiGain < 0.05 && decisionScore.expectedGain < 2) {
    risks.push({ type: 'Value trap', detail: 'Underlying numbers barely improve despite the switch' });
  }

  // Hot streak (unsustainable form)
  const hotStreak = detectHotStreak(incoming);
  if (hotStreak.classification.includes('unsustainable')) {
    risks.push({ type: 'Sustainability concern', detail: hotStreak.classification });
  }

  // Outgoing player might be undervalued
  const outRegression = detectRegression(outgoing);
  if (outRegression.signal === 'buy' || outRegression.signal === 'positive') {
    risks.push({ type: 'Outgoing recovery risk', detail: `Selling ${outgoing.name} while underperforming: ${outRegression.explanation}` });
  }

  // Hit cost concern
  if (decisionScore.hitCost > 0 && decisionScore.expectedGain < decisionScore.hitCost + 2) {
    risks.push({ type: 'Hit cost concern', detail: `-${decisionScore.hitCost} hit may not be recovered over the horizon` });
  }

  // New team / role uncertainty
  if (incoming.transferPenalty && incoming.transferPenalty < 0.85) {
    risks.push({ type: 'New team uncertainty', detail: 'Player recently changed clubs — historical data may not predict new role/output' });
  }

  return risks;
}

// ============================================================
// 12. OPPORTUNITY COST ENGINE
// ============================================================

// Classify whether a player is a genuine transfer candidate.
// Returns a sell-case strength that gates whether replacements are even searched.
function classifySellCase(player, allPlayers, options = {}) {
  const { currentGW = 1, horizon = 5 } = options;
  const dampener = earlySeasonDampener(currentGW);

  // EMERGENCY: truly unavailable — always allow transfer
  if ((player.availability || 100) < 50) {
    return { strength: 'EMERGENCY', allowTransfer: true, reason: `${player.availability}% availability` };
  }

  // Dont-sell protection: if the player is protected, don't replace them
  const protection = dontSellProtection(player, { currentGW, horizon });
  if (protection.protected && currentGW <= 5) {
    return { strength: 'NONE', allowTransfer: false, reason: 'Player protected — underlying thesis intact' };
  }

  const minsProb = computeMinutesProbability(player);
  const horizonPts = computeHorizonPoints(player.weekly, horizon);

  // Find best replacement to gauge upgrade magnitude
  const samePos = (allPlayers || [])
    .filter(p => p.position === player.position && p.id !== player.id && (p.availability || 100) >= 50)
    .sort((a, b) => (b.totalXpts || 0) - (a.totalXpts || 0));
  const bestReplacement = samePos[0] || null;
  const replacementGain = bestReplacement
    ? round(computeHorizonPoints(bestReplacement.weekly, horizon) - horizonPts)
    : 0;

  const strength = computePlayerStrengthScore(player, { currentGW, horizon });

  // STRONG sell case: severe minutes risk + weak player + big upgrade available
  if (minsProb.startProbability < 30 && replacementGain >= 8 && strength.score < 40) {
    return { strength: 'STRONG', allowTransfer: true, reason: `Low start probability (${minsProb.startProbability}%) and weak strength score (${strength.score})` };
  }

  // WEAK sell case: moderate underperformance — only allow in GW4+ or with massive gain
  if ((replacementGain >= 5 && strength.score < 45) || (minsProb.startProbability < 50 && strength.score < 50)) {
    if (currentGW <= 3) {
      return { strength: 'WEAK', allowTransfer: false, reason: 'Early season — insufficient evidence to recommend selling' };
    }
    return { strength: 'WEAK', allowTransfer: true, reason: `Moderate underperformance (strength ${strength.score}, replacement gain ${replacementGain})` };
  }

  // NONE: player is performing adequately
  return { strength: 'NONE', allowTransfer: false, reason: 'Player performing within expected range' };
}

function rankAllTransferOpportunities(squad, allPlayers, options = {}) {
  const { freeTransfers = 1, bank = 0, horizon = 5, currentGW = 1 } = options;
  const dampener = earlySeasonDampener(currentGW);
  const opportunities = [];

  // GW1-2: only allow emergency transfers (injured/unavailable)
  const emergencyOnly = currentGW <= 1;

  for (const outgoing of squad) {
    // --- SELL-CASE GATE ---
    // Only search for replacements if the player is a genuine sell candidate.
    // This prevents the optimizer from replacing every player just because
    // someone slightly better exists.
    const sellCase = classifySellCase(outgoing, allPlayers, { currentGW, horizon });

    if (!sellCase.allowTransfer) {
      // In GW1-2, skip non-emergency players entirely
      if (emergencyOnly || (currentGW <= 2 && sellCase.strength !== 'EMERGENCY')) {
        continue;
      }
    }

    const candidates = allPlayers
      .filter(p =>
        p.position === outgoing.position &&
        p.id !== outgoing.id &&
        (p.availability || 100) >= 40 &&
        (p.cost || 0) <= (outgoing.sellingPrice || outgoing.cost || 0) + bank
      )
      .filter(p => {
        const teamCount = squad.filter(s => s.id !== outgoing.id && s.teamId === p.teamId).length;
        return teamCount < 3;
      });

    for (const incoming of candidates) {
      const decision = computeTransferDecisionScore(outgoing, incoming, {
        horizon, freeTransfers, currentGW,
      });

      // Apply GW-specific transfer thresholds
      // GW1-2: only accept transfers with very large gains (emergency + massive upgrade)
      // GW3-5: higher bar than normal
      // GW6+: normal thresholds
      let minNetGain;
      if (currentGW <= 2) {
        minNetGain = sellCase.strength === 'EMERGENCY' ? 0 : dampener.sellThresholdBoost + 4;
      } else if (currentGW <= 5) {
        minNetGain = dampener.sellThresholdBoost + 2;
      } else {
        minNetGain = 0;
      }

      if (decision.netGain > minNetGain) {
        // Additional early-season guard: reject hits before GW4 unless massive gain
        if (decision.hitCost > 0 && currentGW <= 3 && decision.netGain < 10) {
          continue;
        }

        opportunities.push({
          out: outgoing,
          in: incoming,
          ...decision,
          sellCase: sellCase.strength,
        });
      }
    }
  }

  opportunities.sort((a, b) => b.netGain - a.netGain || b.score - a.score);
  return opportunities;
}

// ============================================================
// 13. ROLL TRANSFER MODEL
// ============================================================

function evaluateRollTransfer(squad, allPlayers, options = {}) {
  const { freeTransfers = 1, bank = 0, horizon = 5, currentGW = 1 } = options;
  const opportunities = rankAllTransferOpportunities(squad, allPlayers, {
    freeTransfers, bank, horizon, currentGW,
  });

  const bestOpportunity = opportunities[0] || null;
  const bestGain = bestOpportunity?.netGain || 0;

  // GW-specific roll threshold:
  //   GW1: always roll (emergency transfers handled separately)
  //   GW2: roll unless gain >= 8 xPts (massive upgrade)
  //   GW3: roll unless gain >= 6 xPts
  //   GW4-5: roll unless gain >= 4 xPts
  //   GW6+: roll unless gain >= 2 xPts
  let ROLL_THRESHOLD;
  if (currentGW <= 1) ROLL_THRESHOLD = Infinity;
  else if (currentGW <= 2) ROLL_THRESHOLD = 8;
  else if (currentGW <= 3) ROLL_THRESHOLD = 6;
  else if (currentGW <= 5) ROLL_THRESHOLD = 4;
  else ROLL_THRESHOLD = 2;

  const rollRecommended = bestGain < ROLL_THRESHOLD;

  // FT bank value: each banked FT is worth approximately 1.5 xPts
  // Early season: FT value is higher because projections are uncertain
  const earlySeasonBonus = currentGW <= 3 ? 2.0 : 0;
  const ftBankValue = round(Math.min(freeTransfers, 5) * 1.5 + earlySeasonBonus);

  // Flexibility score: how much does preserving the FT help next GW
  const flexibilityScore = rollRecommended ? round(100 - bestGain * 10) : round(Math.max(0, 50 - bestGain * 15));

  return {
    rollRecommended,
    bestGain: round(bestGain),
    bestMove: bestOpportunity ? {
      out: bestOpportunity.out.name,
      in: bestOpportunity.in.name,
      netGain: bestOpportunity.netGain,
    } : null,
    ftBankValue,
    flexibilityScore,
    reason: rollRecommended
      ? `No transfer clears the ${ROLL_THRESHOLD === Infinity ? 'GW1 emergency-only' : ROLL_THRESHOLD + ' xPts'} threshold. Rolling preserves flexibility (bank value: ${ftBankValue} xPts).${currentGW <= 3 ? ' Early season: projections are uncertain — patience is recommended.' : ''}`
      : `Best available move gains ${bestGain.toFixed(1)} xPts — worth taking.`,
  };
}

// ============================================================
// 14. PRE-HAUL CANDIDATE DETECTION ("Buy Before Points")
// ============================================================

function detectPreHaulCandidates(allPlayers) {
  const candidates = [];

  for (const player of allPlayers) {
    if ((player.availability || 100) < 70) continue;
    if ((player.xMins || 0) < 55) continue;

    const xGI90 = player.xGI90 || 0;
    const form = player.form || 0;
    const ppg = player.ppg || 0;
    const ownership = player.ownership || 0;
    const starterScore = player.starterScore || 50;

    // Strong underlying numbers but low form relative to production
    const underlyingStrong = xGI90 > 0.45;
    const formLagging = ppg > 0 && form < ppg * 0.85;
    const lowOwnership = ownership < 12;
    const goodRole = starterScore >= 65;

    if (underlyingStrong && (formLagging || form < 3.5) && goodRole) {
      const strength = (player.totalXpts || 0);
      candidates.push({
        player,
        xGI90: round(xGI90, 2),
        form: round(form),
        ppg: round(ppg),
        ownership: round(ownership),
        signal: lowOwnership ? 'Strong pre-haul candidate (low-owned)' : 'Pre-haul candidate',
        priority: xGI90 * 2 + (lowOwnership ? 0.5 : 0) + (formLagging ? 0.3 : 0),
      });
    }
  }

  candidates.sort((a, b) => b.priority - a.priority);
  return candidates.slice(0, 10);
}

// ============================================================
// 15. REGRESSION RISK DETECTION ("Sell Before Regression")
// ============================================================

function detectRegressionRisks(allPlayers) {
  const risks = [];

  for (const player of allPlayers) {
    if ((player.minutes || 0) < 270) continue;

    const regression = detectRegression(player);
    const ownership = player.ownership || 0;

    if (regression.signal === 'sell' || regression.signal === 'caution') {
      risks.push({
        player,
        ...regression,
        ownership: round(ownership),
        priority: regression.signal === 'sell'
          ? regression.goalsPerXG * 2 + (ownership > 20 ? 1 : 0)
          : regression.goalsPerXG,
      });
    }
  }

  risks.sort((a, b) => b.priority - a.priority);
  return risks.slice(0, 10);
}

// ============================================================
// 16. WHOLE-TRANSFER ANALYSIS
// ============================================================

function analyzeTransfer(outgoing, incoming, options = {}) {
  const currentGW = options.currentGW || 1;
  const horizon = options.horizon || 5;
  const freeTransfers = options.freeTransfers || 1;

  // Player strength scores
  const outStrength = computePlayerStrengthScore(outgoing, { currentGW, horizon });
  const inStrength = computePlayerStrengthScore(incoming, { currentGW, horizon });

  // Uncertainty
  const outUncertainty = computeUncertainty(outgoing);
  const inUncertainty = computeUncertainty(incoming);

  // Decision score
  const decision = computeTransferDecisionScore(outgoing, incoming, {
    horizon, freeTransfers, currentGW,
  });

  // Urgency
  const urgency = classifyTransferUrgency(decision, {
    incomingAvailability: incoming.availability || 100,
  });

  // Recommendation
  const recommendation = classifyRecommendation(decision.score, 100 - inUncertainty.uncertainty * 100);

  // Devil's advocate
  const risks = devilAdvocate(outgoing, incoming, decision);

  // Minutes model
  const outMinutes = computeMinutesProbability(outgoing);
  const inMinutes = computeMinutesProbability(incoming);

  // Regression detection
  const outRegression = detectRegression(outgoing);
  const inRegression = detectRegression(incoming);

  // Hot streak / sustainability
  const inSustainability = detectHotStreak(incoming);

  // Multi-horizon gains
  const horizons = {};
  for (const [key, h] of Object.entries(HORIZONS)) {
    const gwCount = h.gwCount === 'full' ? undefined : h.gwCount;
    horizons[key] = {
      label: h.label,
      gain: round(computeHorizonPoints(incoming.weekly, gwCount) - computeHorizonPoints(outgoing.weekly, gwCount)),
    };
  }

  return {
    transfer: { out: outgoing.name, in: incoming.name },
    recommendation: recommendation.category,
    recommendationEmoji: recommendation.emoji,
    decisionScore: decision.score,
    confidence: round(clamp(100 - inUncertainty.uncertainty * 100, 15, 95)),
    uncertainty: inUncertainty,
    playerStrength: {
      outgoing: outStrength,
      incoming: inStrength,
      difference: round(inStrength.score - outStrength.score),
    },
    horizons,
    expectedGain: decision.expectedGain,
    nextGain: decision.nextGain,
    netGain: decision.netGain,
    hitCost: decision.hitCost,
    breakEvenGW: decision.breakEvenGW,
    probabilityTransferWins: decision.probabilityTransferWins,
    minutes: {
      outgoing: outMinutes,
      incoming: inMinutes,
      gain: decision.minutesGain,
    },
    fixtures: {
      swing: decision.fixtureSwing,
      outgoingFDR: averageFDR(outgoing.weekly),
      incomingFDR: averageFDR(incoming.weekly),
    },
    underlying: {
      xgiGain: decision.xgiGain,
      outgoingXGI90: outgoing.xGI90 || 0,
      incomingXGI90: incoming.xGI90 || 0,
    },
    regression: {
      outgoing: outRegression,
      incoming: inRegression,
    },
    sustainability: inSustainability,
    urgency,
    risks,
    explanation: buildExplanation(outgoing, incoming, decision, outStrength, inStrength, outMinutes, inMinutes, risks),
    // Monte Carlo simulation (auto-included in every transfer analysis)
    simulation: null, // lazy-loaded by monteCarloTransferAnalysis
  };
}

function buildExplanation(outgoing, incoming, decision, outStrength, inStrength, outMinutes, inMinutes, risks) {
  const pros = [];
  const cons = [];

  if (decision.expectedGain > 2) pros.push(`+${decision.expectedGain.toFixed(1)} expected points over the horizon`);
  if (decision.fixtureSwing > 0.3) pros.push(`Easier fixtures (FDR improves by ${decision.fixtureSwing.toFixed(1)})`);
  if (decision.roleGain > 10) pros.push(`Better role security (${inMinutes.roleSecurity} vs ${outMinutes.roleSecurity})`);
  if (decision.minutesGain > 5) pros.push(`+${decision.minutesGain} expected minutes`);
  if (decision.xgiGain > 0.05) pros.push(`Better underlying numbers (${decision.xgiGain.toFixed(3)} xGI/90 improvement)`);
  if (inStrength.score > outStrength.score + 5) pros.push(`Stronger overall player rating (+${(inStrength.score - outStrength.score).toFixed(0)} pts)`);
  if (decision.hitCost === 0) pros.push('No transfer cost (free transfer available)');

  if (decision.hitCost > 0) cons.push(`Costs ${decision.hitCost} points (hit)`);
  if (decision.fixtureSwing < -0.3) cons.push(`Harder fixtures ahead (FDR worsens by ${Math.abs(decision.fixtureSwing).toFixed(1)})`);
  if (decision.uncertainty > 0.35) cons.push('High projection uncertainty');
  if (inMinutes.rotationProbability > 25) cons.push(`${inMinutes.rotationProbability}% rotation risk`);
  if (risks.length > 2) cons.push(`${risks.length} risk factors identified`);

  return { pros, cons };
}

// ============================================================
// 17. SQUAD-LEVEL OPPORTUNITY COST
// ============================================================

function findBestMoveAcrossSquad(squad, allPlayers, options = {}) {
  const opportunities = rankAllTransferOpportunities(squad, allPlayers, options);
  if (!opportunities.length) return null;

  const best = opportunities[0];
  const secondBest = opportunities[1] || null;

  // Check if second-best move is actually the same outgoing player
  const alternativeForSameOut = opportunities.find(
    o => o.out.id === best.out.id && o.in.id !== best.in.id
  );

  return {
    bestMove: {
      out: best.out.name,
      in: best.in.name,
      score: best.score,
      netGain: best.netGain,
    },
    alternativeForSamePlayer: alternativeForSameOut ? {
      in: alternativeForSameOut.in.name,
      score: alternativeForSameOut.score,
      netGain: alternativeForSameOut.netGain,
    } : null,
    topAlternatives: opportunities.slice(1, 6).map(o => ({
      out: o.out.name,
      in: o.in.name,
      score: o.score,
      netGain: o.netGain,
    })),
    totalOpportunities: opportunities.length,
  };
}

// ============================================================
// 18. SQUAD HEATMAP — Player status for the connected manager
// ============================================================

function buildSquadHeatmap(squad, allPlayers, options = {}) {
  const { currentGW = 1, horizon = 5 } = options;
  const dampener = earlySeasonDampener(currentGW);

  return squad.map(player => {
    const horizonPts = computeHorizonPoints(player.weekly, horizon);
    const nextGWPts = Number(player.weekly?.[0]?.xPts) || 0;
    const minutesProb = computeMinutesProbability(player);
    const uncertainty = computeUncertainty(player);
    const regression = detectRegression(player);
    const strength = computePlayerStrengthScore(player, { currentGW, horizon });

    // Find best replacement for this player position
    const samePosPlayers = (allPlayers || [])
      .filter(p => p.position === player.position && p.id !== player.id && (p.availability || 100) >= 50)
      .sort((a, b) => (b.totalXpts || 0) - (a.totalXpts || 0));
    const bestReplacement = samePosPlayers[0] || null;
    const replacementGain = bestReplacement
      ? round((computeHorizonPoints(bestReplacement.weekly, horizon) - horizonPts))
      : 0;

    // Player status classification
    // A good model requires 2-3 GWs of evidence before flagging players.
    // After 1 GW the projections are dominated by priors — flagging is noise.
    // Only truly unavailable players get PRIORITY SELL before GW2.
    let status = 'HOLD';
    let statusPriority = 3;
    const isUnavailable = (player.availability || 100) < 50;
    const hasNoData = (player.minutes || 0) < 90; // less than 1 full match played
    const thresholdBoost = dampener.sellThresholdBoost;

    if (isUnavailable) {
      // Always flag truly unavailable players regardless of GW
      status = 'PRIORITY SELL';
      statusPriority = 0;
    } else if (currentGW <= 1) {
      // GW1 only: one match is not enough evidence to recommend selling anyone.
      // Default to HOLD unless the player is genuinely the weakest option
      // with strong evidence of a clear upgrade.
      if (minutesProb.startProbability < 15 && replacementGain >= 14 && strength.score < 25) {
        status = 'MONITOR';
        statusPriority = 2;
      } else {
        status = 'HOLD';
        statusPriority = 3;
      }
    } else if (currentGW <= 2) {
      // GW2: still very thin evidence — require much stronger thresholds
      if (minutesProb.startProbability < 20 && replacementGain >= 12 && strength.score < 35) {
        status = 'PRIORITY SELL';
        statusPriority = 0;
      } else if (replacementGain >= 10 && strength.score < 40) {
        status = 'SELL';
        statusPriority = 1;
      } else if (replacementGain >= 7 || strength.score < 32) {
        status = 'MONITOR';
        statusPriority = 2;
      } else {
        status = 'HOLD';
        statusPriority = 3;
      }
    } else if (currentGW <= 3) {
      // GW3: starting to build evidence, but still cautious
      if (minutesProb.startProbability < 25 && replacementGain >= 8 + thresholdBoost && hasNoData) {
        status = 'PRIORITY SELL';
        statusPriority = 0;
      } else if (minutesProb.startProbability < 35 && replacementGain >= 10 + thresholdBoost && strength.score < 40) {
        status = 'PRIORITY SELL';
        statusPriority = 0;
      } else if (replacementGain >= 7 + thresholdBoost && strength.score < 45) {
        status = 'SELL';
        statusPriority = 1;
      } else if (replacementGain >= 5 + thresholdBoost || strength.score < 35) {
        status = 'MONITOR';
        statusPriority = 2;
      } else if (strength.score >= 70 && minutesProb.startProbability >= 75) {
        status = 'KEEP';
        statusPriority = 4;
      }
    } else {
      // GW4+: more normal thresholds, but still with some dampening
      if (minutesProb.startProbability < 30 && replacementGain >= 6 + thresholdBoost && hasNoData) {
        status = 'PRIORITY SELL';
        statusPriority = 0;
      } else if (minutesProb.startProbability < 40 && replacementGain >= 8 + thresholdBoost && strength.score < 45) {
        status = 'PRIORITY SELL';
        statusPriority = 0;
      } else if (replacementGain >= 6 + thresholdBoost && strength.score < 50) {
        status = 'SELL';
        statusPriority = 1;
      } else if (replacementGain >= 3 + thresholdBoost && strength.score < 42) {
        status = 'MONITOR';
        statusPriority = 2;
      } else if (strength.score >= 75 && minutesProb.startProbability >= 80) {
        status = 'KEEP';
        statusPriority = 4;
      }
    }

    // Risk level: dampen early season — rotationProbability is unreliable with thin data
    const rotThreshold = currentGW <= 1 ? 55 : currentGW <= 2 ? 40 : currentGW <= 3 ? 35 : 30;
    const medThreshold = currentGW <= 1 ? 35 : currentGW <= 2 ? 25 : currentGW <= 3 ? 20 : 15;
    const risk = minutesProb.rotationProbability > rotThreshold ? 'High'
      : minutesProb.rotationProbability > medThreshold ? 'Medium'
      : 'Low';

    return {
      id: player.id,
      name: player.name,
      team: player.team,
      position: player.position,
      cost: player.cost,
      status,
      statusPriority,
      horizonXPts: round(horizonPts),
      nextGWXPts: round(nextGWPts),
      startProbability: minutesProb.startProbability,
      roleSecurity: minutesProb.roleSecurity,
      uncertaintyTier: uncertainty.tier,
      regression: regression.signal,
      replacementGain,
      strengthScore: strength.score,
      risk,
    };
  }).sort((a, b) => a.statusPriority - b.statusPriority || a.horizonXPts - b.horizonXPts);
}

// ============================================================
// 19. DON'T SELL / DON'T BUY PROTECTION
// ============================================================

function dontSellProtection(player, options = {}) {
  const { currentGW = 1, horizon = 5 } = options;
  const reasons = [];
  let protected_ = false;

  // Check 1: Underlying numbers are strong despite poor recent points
  const regression = detectRegression(player);
  if (regression.signal === 'buy' || regression.signal === 'positive') {
    reasons.push(`Underperforming but strong underlying xG (${regression.explanation})`);
    protected_ = true;
  }

  // Check 2: Fixture difficulty is about to ease
  const upcoming = player.weekly?.slice(0, 3) || [];
  const laterFixtures = player.weekly?.slice(3, 6) || [];
  const earlyFDR = upcoming.reduce((s, w) => {
    const fdr = w.fixtures?.[0]?.fdr || 3;
    return s + fdr;
  }, 0) / Math.max(upcoming.length, 1);
  const laterFDR = laterFixtures.length > 0
    ? laterFixtures.reduce((s, w) => { const fdr = w.fixtures?.[0]?.fdr || 3; return s + fdr; }, 0) / laterFixtures.length
    : earlyFDR;
  if (laterFDR < earlyFDR - 0.8) {
    reasons.push(`Fixtures improve significantly (FDR ${earlyFDR.toFixed(1)} → ${laterFDR.toFixed(1)})`);
    protected_ = true;
  }

  // Check 3: Minutes security is actually good
  const mins = computeMinutesProbability(player);
  if (mins.startProbability >= 85 && mins.roleSecurity === 'Nailed') {
    reasons.push(`Nailed starter (${mins.startProbability}% start probability)`);
    protected_ = true;
  }

  // Check 4: Multi-season consistency
  if (player.hasMultiSeasonData && (player.consistencyScore || 0) > 0.6) {
    reasons.push(`Strong multi-season consistency (${Math.round((player.consistencyScore || 0) * 100)}%)`);
    protected_ = true;
  }

  // Check 5: Set piece / penalty role
  if (player.roles && player.roles.length > 0) {
    reasons.push(`Set-piece responsibilities: ${player.roles.join(', ')}`);
  }

  return {
    protected: protected_,
    reasons,
    message: protected_
      ? `KEEP — recent points understate expected future output: ${reasons[0]}`
      : null,
  };
}

function dontBuyProtection(player, options = {}) {
  const { currentGW = 1, horizon = 5 } = options;
  const reasons = [];
  let warned = false;

  // Check 1: Unsustainable finishing
  const regression = detectRegression(player);
  if (regression.signal === 'sell') {
    reasons.push(`Unsustainable finishing: ${regression.explanation}`);
    warned = true;
  }

  // Check 2: Low xGI despite high points
  const xgi90 = player.xGI90 || 0;
  const form = player.form || 0;
  const ppg = player.ppg || 0;
  if (form > 5 && xgi90 < 0.25) {
    reasons.push(`High form (${form.toFixed(1)}) but low xGI/90 (${xgi90.toFixed(2)}) — likely unsustainable`);
    warned = true;
  }

  // Check 3: Difficult fixtures ahead
  const upcoming = (player.weekly || []).slice(0, 5);
  const avgFDR = upcoming.length > 0
    ? upcoming.reduce((s, w) => s + (w.fixtures?.[0]?.fdr || 3), 0) / upcoming.length
    : 3;
  if (avgFDR >= 3.8) {
    reasons.push(`Difficult fixture run ahead (avg FDR ${avgFDR.toFixed(1)})`);
    warned = true;
  }

  // Check 4: Minutes uncertainty
  const mins = computeMinutesProbability(player);
  if (mins.startProbability < 65) {
    reasons.push(`Only ${mins.startProbability}% start probability — rotation risk`);
    warned = true;
  }

  // Check 5: New team / role uncertainty
  if (player.transferPenalty && player.transferPenalty < 0.85) {
    reasons.push('Recently changed clubs — historical data may not predict new output');
    warned = true;
  }

  return {
    warned,
    reasons,
    message: warned
      ? `DON'T BUY YET — ${reasons[0]}`
      : null,
  };
}

// ============================================================
// 20. TRANSFER ALTERNATIVES with Model Preference
// ============================================================

function findTransferAlternatives(outgoing, allPlayers, options = {}) {
  const { currentGW = 1, horizon = 5, freeTransfers = 1, limit = 5 } = options;
  const candidates = allPlayers
    .filter(p => p.position === outgoing.position && p.id !== outgoing.id && (p.availability || 100) >= 50)
    .map(incoming => {
      const analysis = analyzeTransfer(outgoing, incoming, { currentGW, horizon, freeTransfers });
      const protection = dontBuyProtection(incoming, { currentGW, horizon });
      return {
        name: incoming.name,
        team: incoming.team,
        cost: incoming.cost,
        score: analysis.decisionScore,
        netGain: analysis.netGain,
        expectedGain: analysis.expectedGain,
        confidence: analysis.confidence,
        urgency: analysis.urgency,
        risks: analysis.risks,
        dontBuyWarning: protection.message,
        recommendation: analysis.recommendation,
      };
    })
    .filter(c => c.netGain > 0)
    .sort((a, b) => b.score - a.score || b.netGain - a.netGain);

  return {
    outgoing: outgoing.name,
    alternatives: candidates.slice(0, limit),
    modelPreference: candidates.length > 0 ? candidates[0].name : null,
    modelPreferenceScore: candidates.length > 0 ? candidates[0].score : 0,
  };
}

// ============================================================
// 21. DECISION TRIGGERS — "What could change this?"
// ============================================================

function buildDecisionTriggers(squad, options = {}) {
  const triggers = [];

  for (const player of squad) {
    const mins = computeMinutesProbability(player);
    const avail = player.availability || 100;
    const status = player.status || 'a';

    // Injury status change trigger
    if (status === 'd') {
      triggers.push({ type: 'injury_update', player: player.name, detail: 'Player is doubtful — monitor press conferences', priority: 'high' });
    }
    if (status === 'i') {
      triggers.push({ type: 'injured', player: player.name, detail: 'Player is injured — consider replacement', priority: 'critical' });
    }

    // Minutes drop trigger
    if (mins.startProbability < 60 && mins.startProbability > 30) {
      triggers.push({ type: 'minutes_risk', player: player.name, detail: `${mins.startProbability}% start probability — rotation possible`, priority: 'medium' });
    }

    // Price drop risk
    if (Number(player.transfers_out || 0) > Number(player.transfers_in || 0) * 1.3) {
      triggers.push({ type: 'price_drop', player: player.name, detail: 'Net transfers out — potential price fall', priority: 'low' });
    }

    // Role change signal
    if ((player.starterScore || 50) < 40) {
      triggers.push({ type: 'role_change', player: player.name, detail: `Starter score dropped to ${player.starterScore || 50} — role may have changed`, priority: 'high' });
    }

    // Fixture swing
    const upcoming = player.weekly?.slice(0, 3) || [];
    const fdrs = upcoming.map(w => w.fixtures?.[0]?.fdr || 3);
    if (fdrs.length >= 2 && fdrs.every(f => f >= 4)) {
      triggers.push({ type: 'fixture_difficulty', player: player.name, detail: `Next ${fdrs.length} fixtures all rated ${fdrs[0]}+ — difficult run`, priority: 'medium' });
    }
  }

  return triggers.sort((a, b) => {
    const order = { critical: 0, high: 1, medium: 2, low: 3 };
    return (order[a.priority] || 4) - (order[b.priority] || 4);
  });
}

// ============================================================
// 22. PERSONALIZED "YOUR DECISION" BRIEF
// ============================================================

function generateYourDecisionBrief(squad, allPlayers, options = {}) {
  const { currentGW = 1, horizon = 5, freeTransfers = 1, bank = 0 } = options;
  const dampener = earlySeasonDampener(currentGW);

  // Best transfer opportunity (now gated by sell-case + GW-specific thresholds)
  const opportunities = rankAllTransferOpportunities(squad, allPlayers, { freeTransfers, bank, horizon, currentGW });
  const bestTransfer = opportunities[0] || null;
  const bestGain = bestTransfer?.netGain || 0;

  // Roll evaluation
  const rollEval = evaluateRollTransfer(squad, allPlayers, { freeTransfers, bank, horizon, currentGW });

  // --- GW-SPECIFIC DECISION GATES ---
  // The model should actively choose ROLL rather than merely failing to find a transfer.
  let action = 'ROLL';
  let confidence = 72;
  let transferDetail = null;

  // GW-specific transfer thresholds:
  //   GW1: emergency only (injured/unavailable)
  //   GW2: emergency + massive upgrade (>=8 xPts net)
  //   GW3: strong transfer (>=6 xPts net)
  //   GW4-5: moderate transfer (>=4 xPts net)
  //   GW6+: normal (>=2 xPts net)
  let transferThreshold;
  if (currentGW <= 1) {
    transferThreshold = Infinity; // No normal transfers in GW1
  } else if (currentGW <= 2) {
    transferThreshold = bestTransfer?.sellCase === 'EMERGENCY' ? 0 : 8;
  } else if (currentGW <= 3) {
    transferThreshold = 6;
  } else if (currentGW <= 5) {
    transferThreshold = 4;
  } else {
    transferThreshold = 2;
  }

  if (bestTransfer && bestGain >= transferThreshold) {
    action = freeTransfers > 0 ? 'TRANSFER' : 'HIT';
    confidence = Math.min(dampener.confidenceCap, 60 + bestGain * 4);
    const analysis = analyzeTransfer(bestTransfer.out, bestTransfer.in, { currentGW, horizon, freeTransfers });
    transferDetail = {
      out: bestTransfer.out.name,
      in: bestTransfer.in.name,
      expectedGain: round(bestGain),
      hitCost: bestTransfer.hitCost || 0,
      breakEvenGW: analysis.breakEvenGW,
      probabilityWin: Math.min(dampener.probabilityCap, analysis.probabilityTransferWins),
      recommendation: analysis.recommendation,
      urgency: analysis.urgency,
    };
    // Monte Carlo simulation for the best transfer
    transferDetail.simulation = monteCarloTransferAnalysis(bestTransfer.out, bestTransfer.in, { horizon, currentGW, simulations: 5000 });
  } else if (bestTransfer && bestGain >= transferThreshold * 0.5) {
    action = 'MONITOR';
    confidence = 55;
  }

  // --- CAPTAINCY: use captaincyScore as the single source of truth ---
  // The captaincy model (via computeCaptaincyScore) is the authoritative source.
  // We sort by captaincyScore.finalScore, which already integrates rotation risk,
  // fixtures, set pieces, elite pool, and H2H. We do NOT override with the
  // elite list or stored captain — the model's own score is the pick.
  const storedCaptainId = options.storedCaptainId || null;
  const captainPool = squad.filter(p => p.position !== 'GKP' && (p.availability || 0) >= 70);

  // Model's top pick by captaincyScore — the single source of truth
  const modelCaptain = captainPool.sort((a, b) => {
    const scoreA = Number(a.captaincyScore?.finalScore) || (Number(a.weekly?.[0]?.xPts) || 0);
    const scoreB = Number(b.captaincyScore?.finalScore) || (Number(b.weekly?.[0]?.xPts) || 0);
    if (scoreB !== scoreA) return scoreB - scoreA;
    return (Number(b.weekly?.[0]?.xPts) || 0) - (Number(a.weekly?.[0]?.xPts) || 0);
  })[0] || null;

  // Use model captain as the primary pick — no elite/stored override
  const bestCaptain = modelCaptain;
  const captainSource = 'model';

  // Formation (simplified: suggest best based on squad)
  const positions = { GKP: squad.filter(p => p.position === 'GKP').length, DEF: squad.filter(p => p.position === 'DEF').length, MID: squad.filter(p => p.position === 'MID').length, FWD: squad.filter(p => p.position === 'FWD').length };

  // Squad health
  const heatmap = buildSquadHeatmap(squad, allPlayers, { currentGW, horizon });
  const problemPlayers = heatmap.filter(p => ['SELL', 'PRIORITY SELL', 'MONITOR'].includes(p.status));

  // Triggers
  const triggers = buildDecisionTriggers(squad);

  // Reasons
  const reasons = [];
  if (action === 'ROLL') {
    reasons.push('No transfer clears the model threshold for immediate action.');
    reasons.push(`Current squad projects well over the next ${horizon} GWs.`);
    if (freeTransfers > 1) reasons.push(`You have ${freeTransfers} free transfers — rolling preserves flexibility.`);
    if (currentGW <= 5) reasons.push(`Early season: projections are uncertain — patience is recommended.`);
  } else if (action === 'TRANSFER' || action === 'HIT') {
    reasons.push(`${transferDetail.out} → ${transferDetail.in} projects +${transferDetail.expectedGain} xPts over ${horizon} GWs.`);
    if (transferDetail.breakEvenGW) reasons.push(`Break-even in GW${transferDetail.breakEvenGW}.`);
    reasons.push(`${transferDetail.probabilityWin}% probability this transfer wins over the outgoing player.`);
  } else {
    reasons.push('Transfer is marginally positive — consider waiting for more evidence.');
  }

  return {
    gw: currentGW + 1,
    currentGW,
    decision: {
      action,
      confidence: round(confidence),
      earlySeasonWarning: currentGW <= 5 ? dampener.label : null,
    },
    transfer: transferDetail,
    captain: bestCaptain ? {
      name: bestCaptain.name,
      expectedPoints: round(Number(bestCaptain.weekly?.[0]?.xPts) || 0),
      captaincyScore: round(Number(bestCaptain.captaincyScore?.finalScore) || 0),
      captaincyRationale: bestCaptain.captaincyScore?.rationale || null,
      source: captainSource,
      modelPick: modelCaptain ? modelCaptain.name : null,
    } : null,
    formation: `${positions.DEF}-${positions.MID}-${positions.FWD}`,
    freeTransfers,
    bank,
    reasons,
    risks: problemPlayers.map(p => ({ name: p.name, status: p.status, reason: p.roleSecurity + ' role security' })),
    triggers,
    squadHealth: {
      problemCount: problemPlayers.length,
      weakestPlayers: problemPlayers.slice(0, 3).map(p => ({ name: p.name, status: p.status, replacementGain: p.replacementGain })),
    },
  };
}

// ============================================================
// 23. CHIP OPTIMIZER — per-user, not just AI Team
// ============================================================

function optimizeChips(squad, allPlayers, options = {}) {
  const { currentGW = 1, horizon = 8, usedChips = [] } = options;
  const usedSet = new Set(usedChips.map(c => String(c).toLowerCase()));
  const gameweeks = Array.from({ length: Math.min(horizon, 39 - currentGW) }, (_, i) => currentGW + i);
  const results = {};

  for (const gw of gameweeks) {
    const benchXPts = squad.filter(p => !squad.slice(0, 11).some(s => s.id === p.id))
      .reduce((s, p) => s + (Number(p.weekly?.find(w => w.gameweek === gw)?.xPts) || 0), 0);
    const capXPts = squad[0] ? (Number(squad[0].weekly?.find(w => w.gameweek === gw)?.xPts) || 0) : 0;
    const blanks = squad.filter(p => !p.weekly?.some(w => w.gameweek === gw && w.fixtures?.length > 0)).length;
    const injured = squad.filter(p => (p.availability || 0) < 50).length;

    results[gw] = {
      gw,
      wc: gw !== 1 ? injured * 2.5 + blanks * 1.5 : 0,
      fh: gw !== 1 ? blanks * 3.5 : 0,
      bb: benchXPts,
      tc: capXPts * 0.8,
    };
  }

  // Find best window for each chip
  const strategy = {};
  for (const chip of ['wc', 'fh', 'bb', 'tc']) {
    const used = usedSet.has(chip);
    if (used) { strategy[chip.toUpperCase()] = { used: true, bestGW: null, bestValue: 0 }; continue; }
    let bestGW = null;
    let bestValue = 0;
    for (const gw of gameweeks) {
      const val = results[gw]?.[chip] || 0;
      if (val > bestValue) { bestValue = val; bestGW = gw; }
    }
    strategy[chip.toUpperCase()] = { used: false, bestGW, bestValue: round(bestValue) };
  }

  return strategy;
}

// ============================================================
// 24. DECISION LAB MODE ROUTER
// ============================================================
// Three modes: analyzeTransfer, findBestTransfer, optimizeTeam

function analyzeTransferMode(outgoingPlayer, incomingPlayer, squad, allPlayers, options = {}) {
  const { currentGW = 1, horizon = 5, freeTransfers = 1 } = options;
  const analysis = analyzeTransfer(outgoingPlayer, incomingPlayer, { currentGW, horizon, freeTransfers });
  const dontSell = dontSellProtection(outgoingPlayer, { currentGW, horizon });
  const dontBuy = dontBuyProtection(incomingPlayer, { currentGW, horizon });
  const alternatives = findTransferAlternatives(outgoingPlayer, allPlayers, { currentGW, horizon, freeTransfers });
  const triggers = buildDecisionTriggers(squad);

  // Monte Carlo simulation for this transfer
  const simulation = monteCarloTransferAnalysis(outgoingPlayer, incomingPlayer, { horizon, currentGW, simulations: 5000 });

  return {
    mode: 'analyzeTransfer',
    analysis: { ...analysis, simulation },
    dontSellProtection: dontSell,
    dontBuyProtection: dontBuy,
    alternatives,
    triggers,
  };
}

function findBestTransferMode(squad, allPlayers, options = {}) {
  const { currentGW = 1, horizon = 5, freeTransfers = 1, bank = 0 } = options;
  const opportunities = rankAllTransferOpportunities(squad, allPlayers, { freeTransfers, bank, horizon, currentGW });
  const rollEval = evaluateRollTransfer(squad, allPlayers, { freeTransfers, bank, horizon, currentGW });
  const heatmap = buildSquadHeatmap(squad, allPlayers, { currentGW, horizon });
  const triggers = buildDecisionTriggers(squad);

  // Monte Carlo for top 3 opportunities
  const topSimulated = opportunities.slice(0, 3).map(opp => {
    const sim = monteCarloTransferAnalysis(opp.out, opp.in, { horizon, currentGW, simulations: 3000 });
    return { ...opp, simulation: sim };
  });

  return {
    mode: 'findBestTransfer',
    opportunities: topSimulated.concat(opportunities.slice(3, 10)),
    rollEvaluation: rollEval,
    squadHeatmap: heatmap,
    triggers,
    totalLegalMoves: opportunities.length,
  };
}

function optimizeTeamMode(squad, allPlayers, options = {}) {
  const { currentGW = 1, horizon = 5, freeTransfers = 1, bank = 0, usedChips = [] } = options;
  const brief = generateYourDecisionBrief(squad, allPlayers, { currentGW, horizon, freeTransfers, bank });
  const chips = optimizeChips(squad, allPlayers, { currentGW, horizon: 8, usedChips });
  const heatmap = buildSquadHeatmap(squad, allPlayers, { currentGW, horizon });
  const triggers = buildDecisionTriggers(squad);

  return {
    mode: 'optimizeTeam',
    brief,
    chipStrategy: chips,
    squadHeatmap: heatmap,
    triggers,
  };
}

// ============================================================
// 25. NEW-LEAGUE TRANSLATION ENGINE
// ============================================================
// Adjusts expected output for players arriving from non-Premier League
// leagues with league-specific adaptation coefficients and confidence decay.

// --- League translation coefficients ---
// Based on historical FPL transfer success rates by origin league.
// 1.0 = full translation, lower = more penalty for adaptation.
const LEAGUE_TRANSLATION = {
  // PL → PL: minimal adaptation (new club, same league)
  'PL': { xGI: 0.92, minutes: 0.90, confidence: 0.90, label: 'Premier League' },
  // Top-5 European leagues: strong track record of adaptation
  'Bundesliga': { xGI: 0.85, minutes: 0.88, confidence: 0.82, label: 'Bundesliga' },
  'La Liga': { xGI: 0.83, minutes: 0.87, confidence: 0.80, label: 'La Liga' },
  'Serie A': { xGI: 0.82, minutes: 0.86, confidence: 0.79, label: 'Serie A' },
  'Ligue 1': { xGI: 0.80, minutes: 0.85, confidence: 0.77, label: 'Ligue 1' },
  // Second-tier European leagues: moderate adaptation
  'Eredivisie': { xGI: 0.75, minutes: 0.82, confidence: 0.70, label: 'Eredivisie' },
  'Liga Portugal': { xGI: 0.74, minutes: 0.81, confidence: 0.68, label: 'Liga Portugal' },
  'Belgian Pro League': { xGI: 0.72, minutes: 0.80, confidence: 0.65, label: 'Belgian Pro League' },
  'Scottish Premiership': { xGI: 0.70, minutes: 0.78, confidence: 0.63, label: 'Scottish Premiership' },
  'Turkish Super Lig': { xGI: 0.73, minutes: 0.80, confidence: 0.67, label: 'Turkish Super Lig' },
  // South American leagues: significant adaptation
  'Brasileirão': { xGI: 0.68, minutes: 0.76, confidence: 0.58, label: 'Brasileirão' },
  'Argentine Primera': { xGI: 0.67, minutes: 0.75, confidence: 0.56, label: 'Argentine Primera' },
  'Liga MX': { xGI: 0.66, minutes: 0.74, confidence: 0.55, label: 'Liga MX' },
  // Championship: moderate (same country, lower quality)
  'Championship': { xGI: 0.78, minutes: 0.85, confidence: 0.75, label: 'Championship' },
  // Promoted from Championship to PL (same team, step up)
  'Promoted': { xGI: 0.82, minutes: 0.88, confidence: 0.78, label: 'Promoted' },
  // Other / Unknown: highest uncertainty
  'Other': { xGI: 0.62, minutes: 0.72, confidence: 0.50, label: 'Other league' },
};

// --- Position-specific adaptation multipliers ---
// Some positions adapt more easily to the PL.
const POSITION_ADAPTATION = {
  GKP: { speed: 0.95, ceiling: 0.92, label: 'Goalkeepers adapt fastest' },
  DEF: { speed: 0.90, ceiling: 0.88, label: 'Defenders adapt well' },
  MID: { speed: 0.82, ceiling: 0.83, label: 'Midfielders need more time' },
  FWD: { speed: 0.75, ceiling: 0.80, label: 'Forwards face steepest adaptation' },
};

// --- Historical PL adaptation curves ---
// Minutes threshold at which the translation penalty fully decays.
const ADAPTATION_MILESTONES = [
  { minutes: 0,    decay: 1.00, label: 'No PL evidence — full translation penalty' },
  { minutes: 180,  decay: 0.85, label: '2 matches — early evidence' },
  { minutes: 450,  decay: 0.70, label: '5 matches — building picture' },
  { minutes: 900,  decay: 0.50, label: '10 matches — moderate evidence' },
  { minutes: 1800, decay: 0.25, label: '20 matches — strong evidence' },
  { minutes: 2700, decay: 0.10, label: '30 matches — well established' },
  { minutes: 3600, decay: 0.00, label: '40 matches — fully adapted' },
];

// --- Detect if a player is new to the Premier League ---
function detectNewToPL(player, options = {}) {
  const minutes = player.minutes || 0;
  const starts = player.starts || 0;
  const totalPoints = player.totalPoints || player.total_points || 0;
  const status = player.status || 'a';
  const transferPenalty = player.transferPenalty || 1.0;
  const hasMultiSeasonData = player.hasMultiSeasonData || false;

  // Signal 1: Zero minutes at season start (new signing, no PL history)
  const zeroMinutes = minutes === 0 && starts === 0;

  // Signal 2: Transfer penalty < 1 (detected as club changer)
  const isClubChanger = transferPenalty < 1;

  // Signal 3: No multi-season data in the historical collector
  const noHistory = !hasMultiSeasonData && totalPoints === 0;

  // Signal 4: Status is available but no appearances
  const availableButNew = status === 'a' && minutes < 90;

  // Combined detection
  const isNewToPL = zeroMinutes || (isClubChanger && minutes < 200) || noHistory;

  // Is this a promoted team player?
  const isPromoted = options.isPromotedTeam || false;

  // Confidence in detection
  let detectionConfidence = 0;
  if (zeroMinutes) detectionConfidence = 0.95;
  else if (isClubChanger && minutes < 100) detectionConfidence = 0.85;
  else if (noHistory) detectionConfidence = 0.80;
  else if (availableButNew && minutes < 200) detectionConfidence = 0.60;
  else detectionConfidence = 0.30;

  return {
    isNewToPL,
    isClubChanger,
    isPromoted,
    detectionConfidence: round(detectionConfidence, 2),
    signals: {
      zeroMinutes,
      isClubChanger,
      noHistory,
      availableButNew,
    },
  };
}

// --- Estimate the player's origin league ---
// Since FPL doesn't expose origin league, we infer from available signals.
function inferOriginLeague(player, options = {}) {
  const historical = options.historicalData;
  const historicalTeam = historical?.team || historical?.latestSeasonTeam || '';

  // Known PL clubs (for detecting PL→PL transfers)
  const PL_CLUBS = new Set([
    'Arsenal', 'Aston Villa', 'Bournemouth', 'Brentford', 'Brighton', 'Chelsea',
    'Crystal Palace', 'Everton', 'Fulham', 'Liverpool', 'Man City', 'Manchester City',
    'Man Utd', 'Manchester United', 'Newcastle', 'Newcastle United', 'Nottm Forest',
    "Nott'm Forest", 'Nottingham Forest', 'Tottenham', 'West Ham', 'Wolves',
    'Ipswich', 'Leicester', 'Leeds', 'Burnley', 'Luton', 'Sheffield Utd',
  ]);

  // Known league indicators from player name/nationality patterns
  // (simplified heuristic — in production this would use a player database)
  const normalHist = (historicalTeam || '').toLowerCase().replace(/[^a-z]/g, '');

  // Check if historical team was a PL club
  const wasPLClub = [...PL_CLUBS].some(club => {
    const normalClub = club.toLowerCase().replace(/[^a-z]/g, '');
    return normalHist.includes(normalClub) || normalClub.includes(normalHist);
  });

  if (wasPLClub) return 'PL';

  // Promoted team detection
  if (options.isPromotedTeam) return 'Promoted';

  // Championship detection (English-sounding team names)
  const CHAMP_CLUBS = ['Leeds', 'Leicester', 'Burnley', 'Sheffield', 'Sunderland', 'West Brom', 'Middlesbrough', 'Norwich', 'Watford', 'Stoke', 'Swansea', 'Hull', 'Cardiff', 'Reading', 'Birmingham', 'Blackburn', 'Bolton', 'Wigan', 'Portsmouth', 'Charlton', 'Derby', 'Nottm Forest', 'Crystal Palace', 'QPR', 'Brighton', 'Huddersfield', 'Fulham', 'West Bromwich'];
  const wasChampClub = CHAMP_CLUBS.some(club => {
    const normalClub = club.toLowerCase().replace(/[^a-z]/g, '');
    return normalHist.includes(normalClub) || normalClub.includes(normalHist);
  });

  if (wasChampClub) return 'Championship';

  // Without specific data, classify as unknown foreign
  return 'Other';
}

// --- Compute the new-league translation adjustment ---
function computeNewLeagueAdjustment(player, options = {}) {
  const detection = detectNewToPL(player, options);
  if (!detection.isNewToPL) {
    return {
      adjusted: false,
      adjustment: 1.0,
      confidence: 1.0,
      league: null,
      reason: 'Player is not new to the Premier League',
    };
  }

  // Infer origin league
  const originLeague = inferOriginLeague(player, options);
  const leagueCoeff = LEAGUE_TRANSLATION[originLeague] || LEAGUE_TRANSLATION['Other'];
  const posCoeff = POSITION_ADAPTATION[player.position || 'MID'] || POSITION_ADAPTATION.MID;

  // Confidence decay based on PL minutes accumulated
  const plMinutes = player.minutes || 0;
  let confidenceDecay = 1.0;
  for (let i = ADAPTATION_MILESTONES.length - 1; i >= 0; i--) {
    if (plMinutes >= ADAPTATION_MILESTONES[i].minutes) {
      confidenceDecay = ADAPTATION_MILESTONES[i].decay;
      break;
    }
  }

  // Combined xGI adjustment
  // League factor × Position factor × Confidence decay
  const rawAdjustment = leagueCoeff.xGI * posCoeff.speed;
  // Apply confidence decay: as PL evidence accumulates, we trust the PL data more
  const finalAdjustment = 1.0 - (1.0 - rawAdjustment) * confidenceDecay;

  // Minutes adjustment (separate from xGI)
  const minutesAdjustment = 1.0 - (1.0 - leagueCoeff.minutes) * confidenceDecay;

  // Overall confidence in the translation
  const confidence = round(leagueCoeff.confidence * detection.detectionConfidence * (1 - confidenceDecay * 0.3), 3);

  // Adaptation stage
  let stage = 'Unknown';
  for (const milestone of ADAPTATION_MILESTONES) {
    if (plMinutes < milestone.minutes) {
      stage = milestone.label;
      break;
    }
    if (milestone === ADAPTATION_MILESTONES[ADAPTATION_MILESTONES.length - 1]) {
      stage = milestone.label;
    }
  }

  return {
    adjusted: true,
    adjustment: round(finalAdjustment, 3),
    minutesAdjustment: round(minutesAdjustment, 3),
    confidence,
    originLeague,
    leagueLabel: leagueCoeff.label,
    positionFactor: posCoeff.speed,
    positionLabel: posCoeff.label,
    confidenceDecay: round(confidenceDecay, 3),
    plMinutes,
    stage,
    detection,
    explanation: buildTranslationExplanation(originLeague, leagueCoeff, posCoeff, confidenceDecay, plMinutes, stage),
  };
}

function buildTranslationExplanation(league, leagueCoeff, posCoeff, decay, minutes, stage) {
  const parts = [];
  parts.push(`Origin league: ${leagueCoeff.label} (xGI translation: ${Math.round(leagueCoeff.xGI * 100)}%)`);
  parts.push(`Position: ${posCoeff.label}`);
  parts.push(`PL evidence: ${stage}`);
  if (decay > 0.5) {
    parts.push(`High uncertainty — only ${minutes} PL minutes. Translation penalty still active at ${Math.round(decay * 100)}%.`);
  } else if (decay > 0.1) {
    parts.push(`Moderate evidence — ${minutes} PL minutes. Translation penalty fading (${Math.round(decay * 100)}%).`);
  } else {
    parts.push(`Strong evidence — ${minutes} PL minutes. Translation penalty nearly gone.`);
  }
  return parts.join('. ');
}

// --- Apply new-league adjustment to a player's projections ---
function applyNewLeagueAdjustment(player, options = {}) {
  const adj = computeNewLeagueAdjustment(player, options);
  if (!adj.adjusted) return { player, adjustment: adj };

  // Create adjusted player clone with modified xGI/minutes
  const adjusted = { ...player };
  adjusted.xGI90 = round((player.xGI90 || 0) * adj.adjustment, 3);
  adjusted.xG90 = round((player.xG90 || 0) * adj.adjustment, 3);
  adjusted.xA90 = round((player.xA90 || 0) * adj.adjustment, 3);

  // Adjust weekly projections
  if (adjusted.weekly) {
    adjusted.weekly = adjusted.weekly.map(w => ({
      ...w,
      xPts: round((w.xPts || 0) * adj.adjustment, 2),
    }));
  }

  // Adjust total xPts
  adjusted.totalXpts = round((player.totalXpts || 0) * adj.adjustment, 2);
  adjusted.xPtsPerMillion = round(adjusted.totalXpts / Math.max(player.cost || 0.1, 0.1), 2);

  // Increase uncertainty for new signings
  if (adj.confidenceDecay > 0.3) {
    adjusted.uncertainty = Math.min(0.75, (player.uncertainty || 0.18) + adj.confidenceDecay * 0.2);
  }

  return { player: adjusted, adjustment: adj };
}

// ============================================================
// 25B. DEDICATED PROMOTED-TEAM MODEL
// ============================================================
// Comprehensive model for players from Championship-promoted clubs.
// Uses historical promotion data, Championship-to-PL translation,
// reduced blend weights, and player-level profiling.

// --- Historical promoted team performance (last 10 PL seasons) ---
// Tracks how promoted teams typically perform in the PL.
const HISTORICAL_PROMOTED_PERFORMANCE = [
  // { season, teams, avgPoints, surviveRate, avgGoals, avgConceded, bestFinish, worstFinish }
  { season: '2024-25', teams: ['IPS', 'LEI', 'SOU'], avgPoints: 32, surviveRate: 0.33, avgGoals: 38, avgConceded: 65, bestFinish: 16, worstFinish: 20 },
  { season: '2023-24', teams: ['BUR', 'SHU', 'LUT'], avgPoints: 26, surviveRate: 0.00, avgGoals: 32, avgConceded: 72, bestFinish: 18, worstFinish: 20 },
  { season: '2022-23', teams: ['FUL', 'BOU', 'NFO'], avgPoints: 41, surviveRate: 1.00, avgGoals: 44, avgConceded: 58, bestFinish: 10, worstFinish: 18 },
  { season: '2021-22', teams: ['BUR', 'NOR', 'WAT'], avgPoints: 28, surviveRate: 0.00, avgGoals: 30, avgConceded: 68, bestFinish: 17, worstFinish: 20 },
  { season: '2020-21', teams: ['LEE', 'WBA', 'FUL'], avgPoints: 34, surviveRate: 0.33, avgGoals: 38, avgConceded: 62, bestFinish: 9, worstFinish: 20 },
  { season: '2019-20', teams: ['NOR', 'AVL', 'SHU'], avgPoints: 40, surviveRate: 0.67, avgGoals: 42, avgConceded: 58, bestFinish: 9, worstFinish: 20 },
  { season: '2018-19', teams: ['WOL', 'FUL', 'CAR'], avgPoints: 34, surviveRate: 0.33, avgGoals: 38, avgConceded: 64, bestFinish: 7, worstFinish: 18 },
  { season: '2017-18', teams: ['NEW', 'BHA', 'HUD'], avgPoints: 38, surviveRate: 0.67, avgGoals: 40, avgConceded: 60, bestFinish: 10, worstFinish: 18 },
  { season: '2016-17', teams: ['MID', 'BUR', 'HUdd'], avgPoints: 35, surviveRate: 0.33, avgGoals: 36, avgConceded: 62, bestFinish: 12, worstFinish: 19 },
  { season: '2015-16', teams: ['BOU', 'WAT', 'NOR'], avgPoints: 40, surviveRate: 0.67, avgGoals: 42, avgConceded: 56, bestFinish: 12, worstFinish: 19 },
];

// Aggregate survival statistics
const SURVIVAL_RATE = HISTORICAL_PROMOTED_PERFORMANCE.reduce((s, r) => s + r.surviveRate, 0) / HISTORICAL_PROMOTED_PERFORMANCE.length;
const AVG_PROMOTED_POINTS = Math.round(HISTORICAL_PROMOTED_PERFORMANCE.reduce((s, r) => s + r.avgPoints, 0) / HISTORICAL_PROMOTED_PERFORMANCE.length);
const AVG_PROMOTED_GOALS = Math.round(HISTORICAL_PROMOTED_PERFORMANCE.reduce((s, r) => s + r.avgGoals, 0) / HISTORICAL_PROMOTED_PERFORMANCE.length);
const AVG_PROMOTED_CONCEDED = Math.round(HISTORICAL_PROMOTED_PERFORMANCE.reduce((s, r) => s + r.avgConceded, 0) / HISTORICAL_PROMOTED_PERFORMANCE.length);

// --- Championship → PL xG translation coefficients ---
// Championship xG does NOT translate 1:1 to PL xG.
// These coefficients convert Championship-era stats to expected PL output.
const CHAMPIONSHIP_TRANSLATION = {
  // Goals: Championship attacks score more freely but PL defenses are much better
  attacking: {
    xG: 0.74,        // Championship xG → PL xG (26% reduction)
    xA: 0.78,        // Championship xA → PL xA (22% reduction)
    shots: 0.80,      // Fewer shots in PL
    bigChances: 0.72,  // Fewer big chances vs PL defenses
    bonus: 0.75,       // Fewer bonus points in PL
  },
  // Defense: Championship defenses face weaker attacks
  defensive: {
    cleanSheet: 0.68,  // Championship CS rate → PL CS rate (32% reduction)
    saves: 1.15,       // More saves in PL (facing better attacks)
    defensiveContrib: 0.85, // Similar but slightly reduced
  },
  // Minutes: promoted team players get less rotation initially
  minutes: {
    startRate: 0.92,   // Slightly lower start rate (new signings take spots)
    avgMinutes: 0.95,  // Similar minutes if starting
    substituteRate: 1.10, // More substitute appearances
  },
};

// --- Position-specific Championship-to-PL translation ---
const PROMOTED_POSITION_FACTORS = {
  GKP: {
    xGI: 0.88,     // GKs rarely score/assist in any league
    cs: 0.65,       // CS rate drops significantly
    saves: 1.20,    // More saves = more save points
    bonus: 0.70,    // Fewer bonus points
    overall: 0.80,  // Net adjustment
    note: 'GKs face more shots but CS rate drops sharply',
  },
  DEF: {
    xGI: 0.72,     // Defenders score less in PL
    cs: 0.62,       // CS rate drops significantly
    bonus: 0.68,    // Fewer bonus points
    overall: 0.68,  // Net adjustment
    note: 'Defenders face much better attackers — CS and attacking returns both drop',
  },
  MID: {
    xGI: 0.76,     // Midfielders produce less in PL
    cs: 0.80,       // Mid CS worth 1pt anyway
    bonus: 0.72,    // Fewer bonus points
    overall: 0.74,  // Net adjustment
    note: 'Midfielders face better pressing and tighter defenses',
  },
  FWD: {
    xGI: 0.70,     // Forwards most affected by PL defensive quality
    cs: 0,          // No CS points for FWD
    bonus: 0.70,    // Fewer bonus points
    overall: 0.70,  // Net adjustment
    note: 'Forwards face the steepest quality jump in defending',
  },
};

// --- Promoted team strength tiers ---
// Based on Championship performance, transfer activity, and historical patterns
function classifyPromotedTeamStrength(championshipXG, championshipXGA, options = {}) {
  // Championship league average: xG ~1.35, xGA ~1.35
  const CHAMP_AVG = 1.35;
  const attackRatio = championshipXG / CHAMP_AVG;
  const defenseRatio = championshipXGA / CHAMP_AVG; // lower = better defense
  const overallStrength = (attackRatio + (2 - defenseRatio)) / 2;

  let tier, expectedPLFinish, survivalProbability, description;

  if (overallStrength >= 1.20) {
    tier = 'Strong';
    expectedPLFinish = '14-17';
    survivalProbability = 0.70;
    description = 'Strong Championship side — likely to compete for survival comfortably';
  } else if (overallStrength >= 1.05) {
    tier = 'Average';
    expectedPLFinish = '17-19';
    survivalProbability = 0.45;
    description = 'Average Championship side — survival is a coin flip';
  } else if (overallStrength >= 0.90) {
    tier = 'Weak';
    expectedPLFinish = '19-20';
    survivalProbability = 0.20;
    description = 'Weak Championship side — likely relegation candidates';
  } else {
    tier = 'Very weak';
    expectedPLFinish = '20';
    survivalProbability = 0.08;
    description = 'Very weak — heavy favourites for immediate relegation';
  }

  return { tier, expectedPLFinish, survivalProbability, description, overallStrength: round(overallStrength, 3) };
}

// --- Promoted team blend weights ---
// How much to trust current-season data vs Championship baseline
function promotedBlendWeight(gamesPlayed, options = {}) {
  // Promoted teams need MORE evidence before blending in current-season data
  // because early PL results can be misleading (easy opening fixtures, etc.)
  const MIN_MATCHES = 8;       // Need 8+ matches before any blending
  const MAX_BLEND = 0.35;      // Cap at 35% current-season (vs 55% for established PL teams)
  const RAMP_SPEED = 0.035;    // Slower ramp than established teams

  if (gamesPlayed < MIN_MATCHES) return 0;
  const adjusted = gamesPlayed - MIN_MATCHES;
  const raw = MAX_BLEND * (1 - Math.exp(-RAMP_SPEED * adjusted));
  return Math.min(MAX_BLEND, Math.max(0, raw));
}

// --- Player-level promoted team adjustment ---
// Comprehensive adjustment for individual players on promoted teams.
function computePromotedAdjustment(player, options = {}) {
  const isPromoted = options.isPromotedTeam || false;
  if (!isPromoted) {
    return { adjusted: false, adjustment: 1.0, reason: 'Player is not on a promoted team' };
  }

  const minutes = player.minutes || 0;
  const starts = player.starts || 0;
  const position = player.position || 'MID';
  const totalPoints = player.totalPoints || player.total_points || 0;
  const xGI90 = player.xGI90 || 0;
  const form = player.form || 0;
  const ppg = player.ppg || 0;
  const cost = player.cost || 5;
  const ownership = player.ownership || 0;
  const starterScore = player.starterScore || 50;

  // --- Championship-to-PL translation ---
  const posFactors = PROMOTED_POSITION_FACTORS[position] || PROMOTED_POSITION_FACTORS.MID;
  const champTranslation = CHAMPIONSHIP_TRANSLATION;

  // --- Confidence decay: as PL evidence accumulates, reduce the penalty ---
  // More granular than the simple version
  let confidenceDecay = 1.0;
  let evidenceStage = 'No PL evidence';
  if (minutes >= 2700) { confidenceDecay = 0.05; evidenceStage = 'Strong evidence (30+ matches)'; }
  else if (minutes >= 1800) { confidenceDecay = 0.12; evidenceStage = 'Good evidence (20+ matches)'; }
  else if (minutes >= 1200) { confidenceDecay = 0.22; evidenceStage = 'Moderate evidence (13+ matches)'; }
  else if (minutes >= 900) { confidenceDecay = 0.35; evidenceStage = 'Early evidence (10+ matches)'; }
  else if (minutes >= 450) { confidenceDecay = 0.55; evidenceStage = 'Very early evidence (5+ matches)'; }
  else if (minutes >= 180) { confidenceDecay = 0.75; evidenceStage = 'Minimal evidence (2+ matches)'; }
  else if (minutes > 0) { confidenceDecay = 0.90; evidenceStage = 'Barely any evidence'; }

  // --- Position-specific PL adjustment ---
  const rawPositionAdjustment = posFactors.overall;

  // --- Role security adjustment for promoted teams ---
  // Promoted teams often have less squad depth, so nailed players are more valuable
  let roleBonus = 0;
  if (starterScore >= 80) roleBonus = 0.05;      // Nailed starter bonus
  else if (starterScore >= 60) roleBonus = 0.02;  // Likely starter
  else if (starterScore < 40) roleBonus = -0.08;  // Rotation risk penalty (more severe for promoted)

  // --- Survival probability adjustment ---
  // Teams more likely to survive tend to retain more value
  const teamStrength = options.teamStrength || classifyPromotedTeamStrength(1.3, 1.3);
  const survivalBonus = (teamStrength.survivalProbability - 0.33) * 0.10; // ±3% per 10% survival prob

  // --- Fixture difficulty adjustment ---
  // Promoted teams face harder fixtures on average
  const fixturePenalty = options.hardFixtures ? -0.05 : 0;

  // --- Combine all factors ---
  const combinedAdjustment = rawPositionAdjustment + roleBonus + survivalBonus + fixturePenalty;

  // Apply confidence decay
  const finalAdjustment = 1.0 - (1.0 - combinedAdjustment) * confidenceDecay;

  // --- Historical player profile matching ---
  // Find similar historical promoted players for comparison
  const historicalProfile = matchHistoricalPromotedPlayer({ position, cost, xGI90, form, starterScore });

  // --- Regression check for promoted players ---
  // Early-season overperformance from promoted players is common (easy fixtures, unknown quantity)
  let regressionWarning = null;
  if (minutes > 200 && ppg > 0 && form > ppg * 1.4 && xGI90 < 0.30) {
    regressionWarning = 'Early-season form may be unsustainable — underlying numbers are modest';
  }

  return {
    adjusted: true,
    adjustment: round(finalAdjustment, 3),
    rawPositionAdjustment,
    roleBonus: round(roleBonus, 3),
    survivalBonus: round(survivalBonus, 3),
    confidenceDecay: round(confidenceDecay, 3),
    minutes,
    position,
    positionFactors: posFactors,
    evidenceStage,
    teamStrength,
    champTranslation,
    historicalProfile,
    regressionWarning,
    explanation: buildPromotedExplanation(position, posFactors, confidenceDecay, minutes, evidenceStage, teamStrength, roleBonus, historicalProfile, regressionWarning),
  };
}

function buildPromotedExplanation(position, posFactors, decay, minutes, stage, teamStrength, roleBonus, profile, regressionWarn) {
  const parts = [];
  parts.push(`Promoted team ${position}. Championship→PL adjustment: ${Math.round(posFactors.overall * 100)}%.`);
  parts.push(`${stage} (${minutes} PL minutes).`);
  parts.push(`Team tier: ${teamStrength.tier} — ${teamStrength.description}.`);
  if (roleBonus > 0) parts.push(`Nailed starter bonus: +${Math.round(roleBonus * 100)}%.`);
  else if (roleBonus < 0) parts.push(`Rotation risk penalty: ${Math.round(roleBonus * 100)}%.`);
  if (profile) parts.push(`Historical comparison: ${profile.comparison}.`);
  if (regressionWarn) parts.push(`⚠ ${regressionWarn}`);
  parts.push(`Penalty active at ${Math.round(decay * 100)}%.`);
  return parts.join(' ');
}

// --- Match player to historical promoted players ---
function matchHistoricalPromotedPlayer(playerProfile) {
  // Simplified matching based on position and cost tier
  // In production, this would use a database of historical promoted players
  const { position, cost, xGI90, form, starterScore } = playerProfile;

  const costTier = cost >= 7.0 ? 'premium' : cost >= 5.5 ? 'mid' : 'budget';
  const formTier = form >= 5.0 ? 'strong' : form >= 3.0 ? 'average' : 'weak';

  // Historical profiles of successful promoted players
  const PROFILES = {
    'MID_premium_strong': { type: 'Key creator', success: 'High', note: 'Premium mids on promoted teams often deliver if nailed (e.g., Grealish at Villa)' },
    'MID_premium_average': { type: 'Established mid', success: 'Medium', note: 'Premium mids need strong team support to justify price' },
    'MID_mid_strong': { type: 'Value mid', success: 'Medium-High', note: 'Mid-price mids on promoted teams can be FPL gems if nailed' },
    'MID_mid_average': { type: 'Rotation mid', success: 'Low-Medium', note: 'Mid-price mids on promoted teams are risky — rotation likely' },
    'MID_budget_strong': { type: 'Budget gem', success: 'Medium', note: 'Budget mids can outperform if they secure a starting spot' },
    'FWD_premium_strong': { type: 'Main threat', success: 'Medium', note: 'Premium forwards on promoted teams rely heavily on service quality' },
    'FWD_premium_average': { type: 'Isolated striker', success: 'Low', note: 'Premium forwards on weak promoted teams often struggle for service' },
    'FWD_mid_strong': { type: 'Value striker', success: 'Medium', note: 'Mid-price forwards on promoted teams can score if the team creates' },
    'FWD_mid_average': { type: 'Target man', success: 'Low-Medium', note: 'Mid-price forwards on promoted teams are high-variance picks' },
    'FWD_budget_strong': { type: 'Budget forward', success: 'Low-Medium', note: 'Budget forwards on promoted teams are pure upside plays' },
    'DEF_premium_strong': { type: 'Set-piece threat', success: 'Medium-High', note: 'Premium DEFs on promoted teams can earn from set pieces + occasional CS' },
    'DEF_premium_average': { type: 'Defensive anchor', success: 'Low-Medium', note: 'Premium DEFs on promoted teams rarely keep clean sheets' },
    'DEF_mid_strong': { type: 'Value defender', success: 'Low-Medium', note: 'Mid-price DEFs on promoted teams are CS-dependent' },
    'DEF_mid_average': { type: 'Rotation DEF', success: 'Low', note: 'Mid-price DEFs on promoted teams are risky — low CS, low attacking' },
    'DEF_budget_strong': { type: 'Budget DEF', success: 'Low', note: 'Budget DEFs on promoted teams rarely return value' },
    'GKP_premium_strong': { type: 'Shot-stopper', success: 'Medium', note: 'GKs on promoted teams get save points but concede many goals' },
    'GKP_premium_average': { type: 'Exposed GK', success: 'Low-Medium', note: 'GKs on promoted teams face lots of shots — high variance' },
    'GKP_mid_strong': { type: 'Value GK', success: 'Low-Medium', note: 'Budget GKs on promoted teams can earn save points' },
  };

  const key = `${position}_${costTier}_${formTier}`;
  const profile = PROFILES[key];

  if (!profile) {
    return { type: 'Unknown profile', success: 'Unknown', note: 'No historical match — apply standard promoted team penalty', key };
  }

  return { ...profile, key };
}

// --- Promoted team squad-level adjustment ---
// Adjusts ALL players on a promoted team.
function applyPromotedTeamAdjustment(squad, options = {}) {
  const promotedTeamId = options.promotedTeamId;
  if (!promotedTeamId) return squad;

  const teamPlayers = squad.filter(p => p.teamId === promotedTeamId || p.team === promotedTeamId);
  if (!teamPlayers.length) return squad;

  // Classify team strength
  const champXG = options.championshipXG || 1.3;
  const champXGA = options.championshipXGA || 1.3;
  const teamStrength = classifyPromotedTeamStrength(champXG, champXGA);

  // Apply adjustment to each player
  return squad.map(player => {
    if (player.teamId !== promotedTeamId && player.team !== promotedTeamId) return player;

    const adj = computePromotedAdjustment(player, { ...options, isPromotedTeam: true, teamStrength });
    if (!adj.adjusted) return player;

    const adjusted = { ...player };
    adjusted.xGI90 = round((player.xGI90 || 0) * adj.adjustment, 3);
    adjusted.xG90 = round((player.xG90 || 0) * adj.adjustment, 3);
    adjusted.xA90 = round((player.xA90 || 0) * adj.adjustment, 3);

    if (adjusted.weekly) {
      adjusted.weekly = adjusted.weekly.map(w => ({
        ...w,
        xPts: round((w.xPts || 0) * adj.adjustment, 2),
      }));
    }

    adjusted.totalXpts = round((player.totalXpts || 0) * adj.adjustment, 2);
    adjusted.xPtsPerMillion = round(adjusted.totalXpts / Math.max(player.cost || 0.1, 0.1), 2);
    adjusted.promotedAdjustment = adj;

    return adjusted;
  });
}

// ============================================================
// 26. MONTE CARLO SIMULATION ENGINE
// ============================================================
// Poisson-based simulation that runs N iterations per player per GW,
// producing point distributions and outcome classifications.

// --- FPL points by position for goals/assists/clean sheets ---
const MC_FPL = {
  GKP: { goal: 10, assist: 3, cs: 4 },
  DEF: { goal: 6,  assist: 3, cs: 4 },
  MID: { goal: 5,  assist: 3, cs: 1 },
  FWD: { goal: 4,  assist: 3, cs: 0 },
};

// --- Poisson random sample (Knuth algorithm) ---
function poissonSample(lambda) {
  if (lambda <= 0) return 0;
  const L = Math.exp(-lambda);
  let k = 0;
  let p = 1;
  do {
    k++;
    p *= Math.random();
  } while (p > L);
  return k - 1;
}

// --- Normal approximation via Box-Muller (for bonus/variation) ---
function normalSample(mean, std) {
  const u1 = Math.random();
  const u2 = Math.random();
  const z = Math.sqrt(-2 * Math.log(u1 || 1e-10)) * Math.cos(2 * Math.PI * u2);
  return mean + std * z;
}

// --- Simulate a single gameweek for one player ---
// Returns a single point total for that GW.
function simulateSingleGW(player, options = {}) {
  const position = player.position || 'MID';
  const fpl = MC_FPL[position] || MC_FPL.MID;

  // --- Minutes simulation ---
  const minutesProb = computeMinutesProbability(player);
  const startRoll = Math.random() * 100;
  const didStart = startRoll < minutesProb.startProbability;
  const didAppear = startRoll < minutesProb.appearanceProbability;

  if (!didAppear) return { points: 0, goals: 0, assists: 0, cs: 0, bonus: 0, minutes: 0, appeared: false };

  // Minutes if appeared
  const avgMins = didStart ? 78 : 18;
  const minsNoise = normalSample(0, 8);
  const minutes = Math.round(clamp(avgMins + minsNoise, didStart ? 55 : 5, 95));
  const minutePoints = minutes >= 60 ? 2 : minutes >= 30 ? 1 : 0;
  const minuteFraction = minutes / 90;

  // --- Goal simulation (Poisson from xGI split) ---
  const xGI90 = Number(player.xGI90) || 0;
  const xG90 = Number(player.xG90) || xGI90 * 0.6;
  const xA90 = Number(player.xA90) || xGI90 * 0.4;

  // Apply fixture modifier
  const fixtureMod = options.fixtureModifier || 1.0;
  const roleMod = (player.roles && player.roles.length > 0) ? 1.08 : 1.0;

  const lambdaGoals = xG90 * minuteFraction * fixtureMod * roleMod;
  const lambdaAssists = xA90 * minuteFraction * fixtureMod * roleMod;

  const goals = poissonSample(Math.max(0.001, lambdaGoals));
  const assists = poissonSample(Math.max(0.001, lambdaAssists));

  // Goal + assist points
  const goalPts = goals * fpl.goal;
  const assistPts = assists * fpl.assist;

  // --- Clean sheet simulation (DEF/GKP only) ---
  let cs = 0;
  let csPts = 0;
  if ((position === 'DEF' || position === 'GKP') && minutes >= 60) {
    const csProb = options.cleanSheetProb || 0.25;
    cs = Math.random() < csProb ? 1 : 0;
    csPts = cs * fpl.cs;
  }

  // --- Bonus simulation ---
  // Bonus correlates with goal involvements and minutes
  let bonus = 0;
  const involvement = goals + assists;
  const bonusBase = involvement >= 2 ? 2.5 : involvement === 1 ? 0.8 : 0.1;
  const bonusRoll = Math.random();
  if (bonusRoll < bonusBase * minuteFraction) {
    bonus = Math.round(clamp(normalSample(involvement * 1.0, 0.5), 0, 3));
  }

  // --- Card penalty ---
  const cardPts = -(Math.random() < 0.12 ? 1 : 0) // yellow ~12% chance per game for avg player
    -(Math.random() < 0.008 ? 3 : 0); // red ~0.8%

  const totalPoints = Math.max(0, goalPts + assistPts + csPts + bonus + minutePoints + cardPts);

  return {
    points: totalPoints,
    goals,
    assists,
    cs,
    bonus,
    minutes,
    appeared: true,
  };
}

// --- Simulate a single player across multiple gameweeks ---
function simulatePlayerHorizon(player, gameweeks, numSims) {
  const simCount = numSims || 5000;
  const results = new Array(simCount).fill(0);
  const perGWSims = []; // per-GW distribution breakdown

  for (let gwIdx = 0; gwIdx < gameweeks.length; gwIdx++) {
    const gw = gameweeks[gwIdx];
    // Get fixture modifier from player's weekly data
    const weeklyData = player.weekly?.find(w => w.gameweek === gw);
    const fdr = weeklyData?.fixtures?.[0]?.fdr || 3;
    const fixtureModifier = fdr <= 2 ? 1.15 : fdr <= 3 ? 1.0 : fdr <= 4 ? 0.88 : 0.76;

    const gwResults = [];
    for (let sim = 0; sim < simCount; sim++) {
      const gwResult = simulateSingleGW(player, { fixtureModifier });
      results[sim] += gwResult.points;
      gwResults.push(gwResult.points);
    }
    perGWSims.push({ gw, results: gwResults });
  }

  // Sort for percentiles
  results.sort((a, b) => a - b);

  const p10 = results[Math.floor(simCount * 0.10)] || 0;
  const p25 = results[Math.floor(simCount * 0.25)] || 0;
  const p50 = results[Math.floor(simCount * 0.50)] || 0;
  const p75 = results[Math.floor(simCount * 0.75)] || 0;
  const p90 = results[Math.floor(simCount * 0.90)] || 0;
  const expected = results.reduce((s, v) => s + v, 0) / simCount;
  const variance = results.reduce((s, v) => s + (v - expected) ** 2, 0) / simCount;
  const stdDev = Math.sqrt(variance);

  // Outcome classification across all simulations
  let blanks = 0, returns = 0, hauls = 0, doubleDigitHauls = 0;
  for (const pts of results) {
    if (pts <= 2) blanks++;
    else if (pts <= 6) returns++;
    else if (pts < 10) hauls++;
    else doubleDigitHauls++;
  }

  return {
    simulations: simCount,
    expected: round(expected, 2),
    median: p50,
    stdDev: round(stdDev, 2),
    percentiles: { p10, p25, p50, p75, p90 },
    distribution: {
      blank: round(blanks / simCount * 100, 1),
      return: round(returns / simCount * 100, 1),
      haul: round(hauls / simCount * 100, 1),
      doubleDigitHaul: round(doubleDigitHauls / simCount * 100, 1),
    },
    range: { low: p10, high: p90 },
  };
}

// --- Simulate a transfer comparison: IN vs OUT across a horizon ---
function simulateTransferComparison(outgoing, incoming, gameweeks, numSims) {
  const simCount = numSims || 5000;

  // Simulate both players independently
  const outSims = simulatePlayerHorizon(outgoing, gameweeks, simCount);
  const inSims = simulatePlayerHorizon(incoming, gameweeks, simCount);

  // Head-to-head: run paired simulations
  // For each simulation, IN and OUT face the same random "reality" (same fixture luck)
  // but with independent randomness for goals/assists/minutes
  const differences = new Array(simCount);
  let inWins = 0;
  let outWins = 0;
  let ties = 0;

  for (let sim = 0; sim < simCount; sim++) {
    let outTotal = 0;
    let inTotal = 0;

    for (let gwIdx = 0; gwIdx < gameweeks.length; gwIdx++) {
      const gw = gameweeks[gwIdx];
      const outWeekly = outgoing.weekly?.find(w => w.gameweek === gw);
      const inWeekly = incoming.weekly?.find(w => w.gameweek === gw);

      const outFDR = outWeekly?.fixtures?.[0]?.fdr || 3;
      const inFDR = inWeekly?.fixtures?.[0]?.fdr || 3;
      const outFixMod = outFDR <= 2 ? 1.15 : outFDR <= 3 ? 1.0 : outFDR <= 4 ? 0.88 : 0.76;
      const inFixMod = inFDR <= 2 ? 1.15 : inFDR <= 3 ? 1.0 : inFDR <= 4 ? 0.88 : 0.76;

      outTotal += simulateSingleGW(outgoing, { fixtureModifier: outFixMod }).points;
      inTotal += simulateSingleGW(incoming, { fixtureModifier: inFixMod }).points;
    }

    differences[sim] = inTotal - outTotal;
    if (inTotal > outTotal) inWins++;
    else if (outTotal > inTotal) outWins++;
    else ties++;
  }

  differences.sort((a, b) => a - b);

  const avgDiff = differences.reduce((s, v) => s + v, 0) / simCount;
  const diffVariance = differences.reduce((s, v) => s + (v - avgDiff) ** 2, 0) / simCount;
  const diffStdDev = Math.sqrt(diffVariance);

  // Distribution of differences
  const positiveGainCount = differences.filter(d => d > 0).length;
  const significantGainCount = differences.filter(d => d >= 4).length; // beats a hit
  const significantLossCount = differences.filter(d => d <= -4).length;

  return {
    simulations: simCount,
    incoming: {
      expected: inSims.expected,
      median: inSims.median,
      stdDev: inSims.stdDev,
      percentiles: inSims.percentiles,
      distribution: inSims.distribution,
      range: inSims.range,
    },
    outgoing: {
      expected: outSims.expected,
      median: outSims.median,
      stdDev: outSims.stdDev,
      percentiles: outSims.percentiles,
      distribution: outSims.distribution,
      range: outSims.range,
    },
    comparison: {
      expectedDifference: round(avgDiff, 2),
      medianDifference: differences[Math.floor(simCount * 0.5)] || 0,
      stdDev: round(diffStdDev, 2),
      percentiles: {
        p10: differences[Math.floor(simCount * 0.10)] || 0,
        p25: differences[Math.floor(simCount * 0.25)] || 0,
        p50: differences[Math.floor(simCount * 0.50)] || 0,
        p75: differences[Math.floor(simCount * 0.75)] || 0,
        p90: differences[Math.floor(simCount * 0.90)] || 0,
      },
    },
    winProbability: {
      incomingWins: round(inWins / simCount * 100, 1),
      outgoingWins: round(outWins / simCount * 100, 1),
      ties: round(ties / simCount * 100, 1),
    },
    riskMetrics: {
      probabilityOfGain: round(positiveGainCount / simCount * 100, 1),
      probabilityOfSignificantGain: round(significantGainCount / simCount * 100, 1),
      probabilityOfSignificantLoss: round(significantLossCount / simCount * 100, 1),
      expectedValueOfTransfer: round(avgDiff, 2),
    },
    scenarioAnalysis: {
      bestCase: differences[simCount - 1] || 0,
      worstCase: differences[0] || 0,
      mostLikely: differences[Math.floor(simCount * 0.5)] || 0,
      upsideRange: round(differences[Math.floor(simCount * 0.90)] - avgDiff, 2),
      downsideRange: round(avgDiff - differences[Math.floor(simCount * 0.10)], 2),
    },
  };
}

// ============================================================
// 26. MONTE CARLO INTEGRATION INTO TRANSFER ANALYSIS
// ============================================================

function monteCarloTransferAnalysis(outgoing, incoming, options = {}) {
  const horizon = options.horizon || 5;
  const currentGW = options.currentGW || 1;
  const numSims = options.simulations || 5000;

  // Build gameweek list from player weekly data
  const gameweeks = (incoming.weekly || outgoing.weekly || [])
    .map(w => w.gameweek)
    .filter(Boolean)
    .slice(0, horizon);

  if (!gameweeks.length) {
    return { error: 'No gameweek data available for simulation', simulations: 0 };
  }

  const simulation = simulateTransferComparison(outgoing, incoming, gameweeks, numSims);

  // Generate narrative from simulation
  const narrative = buildMCNarrative(simulation, outgoing, incoming);

  return {
    ...simulation,
    narrative,
  };
}

function buildMCNarrative(sim, outgoing, incoming) {
  const lines = [];
  const { winProbability, riskMetrics, comparison, incoming: inSim, outgoing: outSim } = sim;

  // Win probability
  if (winProbability.incomingWins >= 70) {
    lines.push(`${incoming.name} outscores ${outgoing.name} in ${winProbability.incomingWins}% of simulations — strong transfer signal.`);
  } else if (winProbability.incomingWins >= 55) {
    lines.push(`${incoming.name} outscores ${outgoing.name} in ${winProbability.incomingWins}% of simulations — moderate edge.`);
  } else if (winProbability.incomingWins >= 45) {
    lines.push(`Roughly a coin flip: ${incoming.name} wins ${winProbability.incomingWins}% of simulations. No clear advantage.`);
  } else {
    lines.push(`${outgoing.name} actually outscores ${incoming.name} in ${winProbability.outgoingWins}% of simulations — reconsider this transfer.`);
  }

  // Expected gain
  if (comparison.expectedDifference > 3) {
    lines.push(`Expected gain: +${comparison.expectedDifference.toFixed(1)} points over the horizon.`);
  } else if (comparison.expectedDifference > 0) {
    lines.push(`Marginal expected gain: +${comparison.expectedDifference.toFixed(1)} points — within noise.`);
  } else {
    lines.push(`Negative expected value: ${comparison.expectedDifference.toFixed(1)} points — model opposes this transfer.`);
  }

  // Risk
  if (riskMetrics.probabilityOfSignificantLoss > 25) {
    lines.push(`⚠ ${riskMetrics.probabilityOfSignificantLoss}% chance of losing 4+ points — this transfer carries real downside.`);
  }

  // Outcome profiles
  lines.push(`${incoming.name} hauls (7+) in ${inSim.distribution.haul + inSim.distribution.doubleDigitHaul}% of GWs vs ${outgoing.name} at ${outSim.distribution.haul + outSim.distribution.doubleDigitHaul}%.`);

  return lines;
}

// ============================================================
// 27. MONTE CARLO SQUAD SIMULATION
// ============================================================
// Simulate the entire squad's GW output to produce team-level distributions.

function simulateSquadGW(squad, gameweek, numSims) {
  const simCount = numSims || 3000;
  const results = new Array(simCount).fill(0);
  const playerBreakdown = {};

  for (const player of squad) {
    const weeklyData = player.weekly?.find(w => w.gameweek === gameweek);
    const fdr = weeklyData?.fixtures?.[0]?.fdr || 3;
    const fixtureMod = fdr <= 2 ? 1.15 : fdr <= 3 ? 1.0 : fdr <= 4 ? 0.88 : 0.76;

    const playerResults = [];
    for (let sim = 0; sim < simCount; sim++) {
      const gwResult = simulateSingleGW(player, { fixtureModifier: fixtureMod });
      results[sim] += gwResult.points;
      playerResults.push(gwResult.points);
    }

    const expected = playerResults.reduce((s, v) => s + v, 0) / simCount;
    playerBreakdown[player.name || player.id] = {
      expected: round(expected, 2),
      blankProb: round(playerResults.filter(p => p <= 2).length / simCount * 100, 1),
      haulProb: round(playerResults.filter(p => p >= 7).length / simCount * 100, 1),
    };
  }

  results.sort((a, b) => a - b);

  return {
    gameweek,
    simulations: simCount,
    expected: round(results.reduce((s, v) => s + v, 0) / simCount, 1),
    median: results[Math.floor(simCount * 0.5)] || 0,
    percentiles: {
      p10: results[Math.floor(simCount * 0.10)] || 0,
      p25: results[Math.floor(simCount * 0.25)] || 0,
      p50: results[Math.floor(simCount * 0.50)] || 0,
      p75: results[Math.floor(simCount * 0.75)] || 0,
      p90: results[Math.floor(simCount * 0.90)] || 0,
    },
    playerBreakdown,
  };
}

// ============================================================
// EXPORTS
// ============================================================

module.exports = {
  // Core models
  HORIZONS,
  computeHorizonPoints,
  earlySeasonWeights,
  earlySeasonDampener,
  bayesianBlend,
  computePlayerStrengthScore,
  computeUncertainty,
  detectRegression,
  detectHotStreak,
  positionFixtureDifficulty,
  computeMinutesProbability,
  computeTransferDecisionScore,
  classifyTransferUrgency,
  classifyRecommendation,
  devilAdvocate,
  rankAllTransferOpportunities,
  evaluateRollTransfer,
  detectPreHaulCandidates,
  detectRegressionRisks,
  analyzeTransfer,
  findBestMoveAcrossSquad,
  averageFDR,
  // Product features
  buildSquadHeatmap,
  dontSellProtection,
  dontBuyProtection,
  findTransferAlternatives,
  buildDecisionTriggers,
  generateYourDecisionBrief,
  optimizeChips,
  // Decision Lab modes
  analyzeTransferMode,
  findBestTransferMode,
  optimizeTeamMode,
  // Monte Carlo simulation
  simulateSingleGW,
  simulatePlayerHorizon,
  simulateTransferComparison,
  monteCarloTransferAnalysis,
  simulateSquadGW,
  // New-league translation
  LEAGUE_TRANSLATION,
  POSITION_ADAPTATION,
  ADAPTATION_MILESTONES,
  detectNewToPL,
  inferOriginLeague,
  computeNewLeagueAdjustment,
  applyNewLeagueAdjustment,
  // Promoted-team model
  HISTORICAL_PROMOTED_PERFORMANCE,
  CHAMPIONSHIP_TRANSLATION,
  PROMOTED_POSITION_FACTORS,
  classifyPromotedTeamStrength,
  promotedBlendWeight,
  computePromotedAdjustment,
  matchHistoricalPromotedPlayer,
  applyPromotedTeamAdjustment,
  SURVIVAL_RATE,
  AVG_PROMOTED_POINTS,
  // Utilities
  clamp,
  round,
};
