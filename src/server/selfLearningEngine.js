// src/server/selfLearningEngine.js
// Self-Learning Engine — tracks predictions, compares against outcomes,
// detects systematic biases, and self-tunes model parameters.
//
// The model should try to PROVE a prediction is correct, not just make
// predictions and forget about them. This module creates the feedback loop.

const fs = require('fs');
const path = require('path');
const logger = require('./logger');

const DATA_DIR = path.join(__dirname, 'data');
const PREDICTIONS_DIR = path.join(DATA_DIR, 'predictions');
const LEARNING_DIR = path.join(DATA_DIR, 'learning');

// ============================================================
// 1. PREDICTION SNAPSHOT STORAGE
// ============================================================
// Before each GW deadline, store what the model predicted for every
// player in the squad (and top market players). After the GW,
// compare against actual outcomes.

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

/**
 * Store a prediction snapshot for a gameweek.
 * Called before the GW deadline with the model's current state.
 */
function storePredictionSnapshot(gw, predictions, options = {}) {
  ensureDir(PREDICTIONS_DIR);
  const filePath = path.join(PREDICTIONS_DIR, `gw_${gw}_predictions.json`);

  const snapshot = {
    gameweek: gw,
    storedAt: new Date().toISOString(),
    modelVersion: options.modelVersion || 'Decision Lab Engine 2.0',
    // Per-player predictions
    players: predictions.map(p => ({
      id: p.id,
      name: p.name,
      position: p.position,
      team: p.team,
      // What the model predicted
      predictedXPts: Number(p.weekly?.[0]?.xPts) || 0,
      predictedTotalXPts: Number(p.totalXpts) || 0,
      predictedRange: p.range || { low: 0, high: 0 },
      // Confidence / uncertainty
      uncertainty: p._uncertainty || null,
      strengthScore: p._strengthScore || null,
      // Sell case classification
      sellCase: p._sellCase || null,
      // Captaincy score
      captaincyScore: p.captaincyScore?.finalScore || null,
      // Key inputs
      xGI90: p.xGI90 || 0,
      form: p.form || 0,
      ppg: p.ppg || 0,
      starterScore: p.starterScore || 50,
      availability: p.availability || 100,
      xMins: p.xMins || 0,
      cost: p.cost || 0,
      ownership: p.ownership || 0,
      // Fixture info
      fixtureFDR: p.weekly?.[0]?.fixtures?.[0]?.fdr || 3,
      isHome: p.weekly?.[0]?.fixtures?.[0]?.isHome ?? true,
    })),
    // Model state
    decisions: options.decisions || null,
    transferPlans: (options.transferPlans || []).slice(0, 5).map(p => ({
      out: p.transfers[0]?.out?.name,
      in: p.transfers[0]?.in?.name,
      netGain: p.netGain,
      recommendation: p.recommendation,
    })),
    // Model parameters (for self-tuning comparison)
    parameters: options.parameters || {},
  };

  try {
    fs.writeFileSync(filePath, JSON.stringify(snapshot, null, 2), 'utf8');
    logger.info({ gw, playerCount: snapshot.players.length }, 'Prediction snapshot stored');
    return snapshot;
  } catch (err) {
    logger.error({ err: err.message, gw }, 'Failed to store prediction snapshot');
    return null;
  }
}

/**
 * Load a prediction snapshot for a gameweek.
 */
function loadPredictionSnapshot(gw) {
  const filePath = path.join(PREDICTIONS_DIR, `gw_${gw}_predictions.json`);
  try {
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    }
  } catch (err) {
    logger.warn({ err: err.message, gw }, 'Failed to load prediction snapshot');
  }
  return null;
}

// ============================================================
// 2. OUTCOME COMPARISON
// ============================================================
// After a GW completes, compare predicted vs actual points for every player.

/**
 * Compare predictions against actual outcomes for a completed GW.
 * Returns per-player accuracy metrics and aggregate statistics.
 */
function comparePredictionsToOutcomes(gw, predictions, liveElements) {
  if (!predictions?.players?.length || !liveElements?.length) {
    return null;
  }

  const actualMap = new Map(liveElements.map(el => [el.id, el.stats || {}]));

  const playerResults = predictions.players.map(pred => {
    const actual = actualMap.get(pred.id) || {};
    const actualXPts = Number(actual.total_points) || 0;
    const actualMinutes = Number(actual.minutes) || 0;
    const predictedXPts = pred.predictedXPts;

    const error = actualXPts - predictedXPts;
    const absError = Math.abs(error);
    const squaredError = error * error;

    // Calibration: was the actual outcome within the predicted range?
    const inRange = pred.predictedRange
      ? actualXPts >= pred.predictedRange.low && actualXPts <= pred.predictedRange.high
      : null;

    // Direction: did the model correctly predict whether the player would
    // score above or below the position average?
    const posAvg = pred.position === 'GKP' ? 3 : pred.position === 'DEF' ? 3.5
      : pred.position === 'MID' ? 4.5 : 5;
    const predictedAbove = predictedXPts > posAvg;
    const actualAbove = actualXPts > posAvg;
    const correctDirection = predictedAbove === actualAbove;

    return {
      id: pred.id,
      name: pred.name,
      position: pred.position,
      predicted: round(predictedXPts),
      actual: actualXPts,
      error: round(error),
      absError: round(absError),
      squaredError: round(squaredError, 2),
      inRange,
      correctDirection,
      predictedMinutes: pred.xMins,
      actualMinutes,
      // Bias detection: was the prediction systematically high or low?
      bias: error > 1 ? 'overpredicted' : error < -1 ? 'underpredicted' : 'accurate',
    };
  });

  // Aggregate metrics
  const n = playerResults.length;
  const mae = n > 0 ? playerResults.reduce((s, r) => s + r.absError, 0) / n : 0;
  const rmse = n > 0 ? Math.sqrt(playerResults.reduce((s, r) => s + r.squaredError, 0) / n) : 0;
  const meanError = n > 0 ? playerResults.reduce((s, r) => s + r.error, 0) / n : 0; // positive = overpredicted
  const directionAccuracy = n > 0 ? playerResults.filter(r => r.correctDirection).length / n : 0;
  const rangeAccuracy = n > 0 ? playerResults.filter(r => r.inRange === true).length / Math.max(1, playerResults.filter(r => r.inRange !== null).length) : 0;

  // Position-level breakdown
  const byPosition = {};
  for (const result of playerResults) {
    if (!byPosition[result.position]) byPosition[result.position] = [];
    byPosition[result.position].push(result);
  }
  const positionMetrics = {};
  for (const [pos, results] of Object.entries(byPosition)) {
    positionMetrics[pos] = {
      mae: round(results.reduce((s, r) => s + r.absError, 0) / results.length),
      meanError: round(results.reduce((s, r) => s + r.error, 0) / results.length),
      count: results.length,
    };
  }

  // Systematic bias detection
  const overpredicted = playerResults.filter(r => r.bias === 'overpredicted');
  const underpredicted = playerResults.filter(r => r.bias === 'underpredicted');

  return {
    gameweek: gw,
    comparedAt: new Date().toISOString(),
    playerCount: n,
    metrics: {
      mae: round(mae),
      rmse: round(rmse),
      meanError: round(meanError, 2), // positive = systematic overprediction
      directionAccuracy: round(directionAccuracy * 100),
      rangeAccuracy: round(rangeAccuracy * 100),
    },
    positionMetrics,
    biases: {
      overpredictedCount: overpredicted.length,
      underpredictedCount: underpredicted.length,
      overpredictedPlayers: overpredicted.slice(0, 5).map(r => ({ name: r.name, error: r.error })),
      underpredictedPlayers: underpredicted.slice(0, 5).map(r => ({ name: r.name, error: r.error })),
    },
    players: playerResults,
  };
}

// ============================================================
// 3. CALIBRATION METRICS
// ============================================================
// Are the model's confidence levels well-calibrated?
// If the model says "70% confident", does the prediction come true ~70% of the time?

/**
 * Compute calibration metrics across multiple gameweeks of outcomes.
 */
function computeCalibration(outcomeHistory) {
  if (!outcomeHistory?.length) {
    return { status: 'insufficient_data', bins: [] };
  }

  // Bin predictions by confidence level and check actual accuracy
  const bins = [
    { label: 'Very High (80-100%)', min: 80, max: 100, predicted: 0, correct: 0 },
    { label: 'High (65-80%)', min: 65, max: 80, predicted: 0, correct: 0 },
    { label: 'Medium (50-65%)', min: 50, max: 65, predicted: 0, correct: 0 },
    { label: 'Low (30-50%)', min: 30, max: 50, predicted: 0, correct: 0 },
    { label: 'Very Low (<30%)', min: 0, max: 30, predicted: 0, correct: 0 },
  ];

  for (const outcome of outcomeHistory) {
    for (const player of outcome.players || []) {
      if (player.predicted == null || player.actual == null) continue;

      // Use uncertainty as a proxy for confidence
      const confidence = player.uncertainty
        ? Math.round((1 - player.uncertainty) * 100)
        : 50; // default to medium if no uncertainty data

      for (const bin of bins) {
        if (confidence >= bin.min && confidence < bin.max) {
          bin.predicted++;
          // "Correct" = actual within ±2 of predicted
          if (Math.abs(player.actual - player.predicted) <= 2) {
            bin.correct++;
          }
          break;
        }
      }
    }
  }

  // Compute calibration error (how far actual accuracy is from predicted confidence)
  let calibrationError = 0;
  let totalPredictions = 0;
  const calibratedBins = bins.map(bin => {
    const accuracy = bin.predicted > 0 ? (bin.correct / bin.predicted) * 100 : 0;
    const midpoint = (bin.min + bin.max) / 2;
    const error = Math.abs(accuracy - midpoint);
    calibrationError += error * bin.predicted;
    totalPredictions += bin.predicted;
    return {
      ...bin,
      accuracy: round(accuracy),
      midpoint,
      error: round(error),
    };
  });

  const avgCalibrationError = totalPredictions > 0
    ? round(calibrationError / totalPredictions)
    : 0;

  return {
    status: 'computed',
    sampleSize: outcomeHistory.length,
    totalPredictions,
    avgCalibrationError, // lower = better calibrated
    bins: calibratedBins,
    verdict: avgCalibrationError < 8 ? 'Well calibrated'
      : avgCalibrationError < 15 ? 'Moderately calibrated'
      : 'Poorly calibrated — model confidence levels need adjustment',
  };
}

// ============================================================
// 4. SYSTEMATIC BIAS DETECTION
// ============================================================
// Identify patterns in what the model gets wrong.

/**
 * Detect systematic biases across multiple GW outcomes.
 */
function detectSystematicBiases(outcomeHistory) {
  if (!outcomeHistory?.length || outcomeHistory.length < 2) {
    return { status: 'insufficient_data', biases: [] };
  }

  const biases = [];

  // Aggregate per-player error across all GWs
  const playerErrors = new Map();
  for (const outcome of outcomeHistory) {
    for (const player of outcome.players || []) {
      if (!playerErrors.has(player.id)) {
        playerErrors.set(player.id, { name: player.name, position: player.position, errors: [], predictions: [] });
      }
      const record = playerErrors.get(player.id);
      record.errors.push(player.error || 0);
      record.predictions.push(player.predicted || 0);
    }
  }

  // Find players with consistent bias (always over or under predicted)
  for (const [id, record] of playerErrors) {
    if (record.errors.length < 2) continue;
    const avgError = record.errors.reduce((s, e) => s + e, 0) / record.errors.length;
    if (avgError > 1.5) {
      biases.push({
        type: 'consistent_overprediction',
        playerId: id,
        playerName: record.name,
        position: record.position,
        avgError: round(avgError),
        sampleSize: record.errors.length,
        severity: avgError > 3 ? 'high' : 'medium',
        recommendation: `Model consistently overpredicts ${record.name} by ~${round(avgError)} pts. Consider reducing projection weight for this player type.`,
      });
    } else if (avgError < -1.5) {
      biases.push({
        type: 'consistent_underprediction',
        playerId: id,
        playerName: record.name,
        position: record.position,
        avgError: round(avgError),
        sampleSize: record.errors.length,
        severity: avgError < -3 ? 'high' : 'medium',
        recommendation: `Model consistently underpredicts ${record.name} by ~${Math.abs(round(avgError))} pts. Consider increasing projection weight.`,
      });
    }
  }

  // Position-level bias
  const posErrors = {};
  for (const record of playerErrors.values()) {
    if (!posErrors[record.position]) posErrors[record.position] = [];
    const avg = record.errors.reduce((s, e) => s + e, 0) / record.errors.length;
    posErrors[record.position].push(avg);
  }
  for (const [pos, errors] of Object.entries(posErrors)) {
    const posAvg = errors.reduce((s, e) => s + e, 0) / errors.length;
    if (Math.abs(posAvg) > 1.0) {
      biases.push({
        type: 'position_bias',
        position: pos,
        avgError: round(posAvg),
        playerCount: errors.length,
        severity: Math.abs(posAvg) > 2 ? 'high' : 'medium',
        recommendation: `Model ${posAvg > 0 ? 'overpredicts' : 'underpredicts'} ${pos} players by ~${Math.abs(round(posAvg))} pts on average. Adjust position-specific weights.`,
      });
    }
  }

  // Fixture-based bias: does the model overpredict for hard fixtures?
  const fixtureErrors = [];
  for (const outcome of outcomeHistory) {
    for (const player of outcome.players || []) {
      if (player.fixtureFDR && player.predicted != null && player.actual != null) {
        fixtureErrors.push({
          fdr: player.fixtureFDR,
          error: player.error || 0,
        });
      }
    }
  }
  if (fixtureErrors.length > 5) {
    const hardFixtures = fixtureErrors.filter(f => f.fdr >= 4);
    const easyFixtures = fixtureErrors.filter(f => f.fdr <= 2);
    if (hardFixtures.length > 2 && easyFixtures.length > 2) {
      const hardAvg = hardFixtures.reduce((s, f) => s + f.error, 0) / hardFixtures.length;
      const easyAvg = easyFixtures.reduce((s, f) => s + f.error, 0) / easyFixtures.length;
      if (Math.abs(hardAvg) > 1.5 || Math.abs(easyAvg) > 1.5) {
        biases.push({
          type: 'fixture_bias',
          hardFixtureError: round(hardAvg),
          easyFixtureError: round(easyAvg),
          severity: 'medium',
          recommendation: `Model ${hardAvg > 0 ? 'overpredicts' : 'underpredicts'} in hard fixtures and ${easyAvg > 0 ? 'overpredicts' : 'underpredicts'} in easy fixtures. Adjust fixture difficulty scaling.`,
        });
      }
    }
  }

  return {
    status: 'computed',
    sampleSize: outcomeHistory.length,
    biasCount: biases.length,
    biases: biases.sort((a, b) => {
      const sev = { high: 0, medium: 1, low: 2 };
      return (sev[a.severity] || 3) - (sev[b.severity] || 3);
    }),
  };
}

// ============================================================
// 5. SELF-TUNING PARAMETER ADJUSTMENT
// ============================================================
// Based on detected biases, suggest (or apply) parameter adjustments.

/**
 * Current model parameters that can be self-tuned.
 */
const DEFAULT_PARAMETERS = {
  // Transfer thresholds (from decisionModel.js)
  transferThresholdGW2: 8,
  transferThresholdGW3: 6,
  transferThresholdGW4_5: 4,
  transferThresholdGW6Plus: 2,
  hitThresholdGW2: 14,
  hitThresholdGW3: 8,

  // Captaincy weights
  captaincyXptsWeight: 1.0,
  captaincyFormWeight: 0.3,
  captaincyFixtureWeight: 0.2,

  // xPts model
  xGItoPtsMultiplier: 4.2,
  appearanceBonus: 2.0,

  // Uncertainty scaling
  uncertaintyPenalty: 15,

  // Early season
  earlySeasonConfidenceCap: 65,
  earlySeasonProbabilityCap: 68,

  // Strength score weights
  strengthXptsWeight: 0.25,
  strengthUnderlyingWeight: 0.15,
  strengthMinutesWeight: 0.15,
  strengthFixtureWeight: 0.15,
};

/**
 * Load learned parameters from disk, falling back to defaults.
 */
function loadLearnedParameters() {
  const filePath = path.join(LEARNING_DIR, 'learned_parameters.json');
  try {
    if (fs.existsSync(filePath)) {
      const saved = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      return { ...DEFAULT_PARAMETERS, ...saved };
    }
  } catch (err) {
    logger.warn({ err: err.message }, 'Failed to load learned parameters');
  }
  return { ...DEFAULT_PARAMETERS };
}

/**
 * Save learned parameters to disk.
 */
function saveLearnedParameters(params) {
  ensureDir(LEARNING_DIR);
  const filePath = path.join(LEARNING_DIR, 'learned_parameters.json');
  try {
    fs.writeFileSync(filePath, JSON.stringify(params, null, 2), 'utf8');
    logger.info('Learned parameters saved');
  } catch (err) {
    logger.error({ err: err.message }, 'Failed to save learned parameters');
  }
}

/**
 * Suggest parameter adjustments based on detected biases.
 * Returns suggested changes without applying them (conservative approach).
 */
function suggestParameterAdjustments(biases, calibration, currentParams) {
  const suggestions = [];
  const params = { ...currentParams };

  for (const bias of (biases.biases || [])) {
    if (bias.type === 'position_bias' && bias.severity === 'high') {
      // If MID is systematically overpredicted, reduce xGI multiplier for MIDs
      if (bias.position === 'MID' && bias.avgError > 2) {
        suggestions.push({
          parameter: 'xGItoPtsMultiplier',
          currentValue: params.xGItoPtsMultiplier,
          suggestedValue: round(params.xGItoPtsMultiplier * 0.92, 2),
          reason: `MID players overpredicted by ~${bias.avgError} pts. Reducing xGI multiplier.`,
          confidence: bias.sampleSize >= 5 ? 'medium' : 'low',
        });
      }
      // If FWD is systematically underpredicted, increase xGI multiplier
      if (bias.position === 'FWD' && bias.avgError < -2) {
        suggestions.push({
          parameter: 'xGItoPtsMultiplier',
          currentValue: params.xGItoPtsMultiplier,
          suggestedValue: round(params.xGItoPtsMultiplier * 1.08, 2),
          reason: `FWD players underpredicted by ~${Math.abs(bias.avgError)} pts. Increasing xGI multiplier.`,
          confidence: bias.sampleSize >= 5 ? 'medium' : 'low',
        });
      }
    }

    if (bias.type === 'fixture_bias') {
      // If model overpredicts in hard fixtures, increase the penalty
      if (bias.hardFixtureError > 2) {
        suggestions.push({
          parameter: 'strengthFixtureWeight',
          currentValue: params.strengthFixtureWeight,
          suggestedValue: round(Math.min(0.25, params.strengthFixtureWeight + 0.03), 2),
          reason: `Model overpredicts in hard fixtures by ~${bias.hardFixtureError} pts. Increasing fixture weight in strength score.`,
          confidence: 'low',
        });
      }
    }

    if (bias.type === 'consistent_overprediction' && bias.severity === 'high') {
      // Wider uncertainty penalty for overconfident predictions
      suggestions.push({
        parameter: 'uncertaintyPenalty',
        currentValue: params.uncertaintyPenalty,
        suggestedValue: Math.min(25, params.uncertaintyPenalty + 2),
        reason: `Systematic overprediction detected. Increasing uncertainty penalty.`,
        confidence: 'low',
      });
    }
  }

  // Calibration-based adjustments
  if (calibration.status === 'computed') {
    if (calibration.avgCalibrationError > 15) {
      // Model is overconfident — reduce confidence caps
      suggestions.push({
        parameter: 'earlySeasonConfidenceCap',
        currentValue: params.earlySeasonConfidenceCap,
        suggestedValue: Math.max(50, params.earlySeasonConfidenceCap - 5),
        reason: `Calibration error ${calibration.avgCalibrationError}% — model is overconfident. Reducing confidence cap.`,
        confidence: 'medium',
      });
    }
  }

  return {
    suggestionCount: suggestions.length,
    suggestions,
    note: 'Suggestions require minimum 3 GWs of data before applying. All changes are conservative (max ±8% per adjustment).',
  };
}

/**
 * Apply parameter adjustments (only if confidence is sufficient).
 * Called after manual review or when sample size is large enough.
 */
function applyParameterAdjustments(params, suggestions, options = {}) {
  const minSampleSize = options.minSampleSize || 3;
  const applied = [];

  for (const suggestion of suggestions) {
    if (suggestion.confidence === 'low' && options.gw < minSampleSize) continue;

    const current = params[suggestion.parameter];
    if (current == null) continue;

    // Conservative: max ±8% per adjustment
    const maxChange = current * 0.08;
    const suggested = suggestion.suggestedValue;
    const change = Math.abs(suggested - current);
    if (change > maxChange) {
      // Dampen the change
      suggestion.suggestedValue = current + (suggested > current ? maxChange : -maxChange);
    }

    params[suggestion.parameter] = round(suggestion.suggestedValue, 3);
    applied.push(suggestion);
  }

  if (applied.length > 0) {
    saveLearnedParameters(params);
    logger.info({ appliedCount: applied.length }, 'Parameter adjustments applied');
  }

  return { applied, params };
}

// ============================================================
// 6. TRANSFER OUTCOME TRACKING
// ============================================================
// Did recommended transfers actually improve the manager's score?

/**
 * Track whether a recommended transfer was beneficial.
 * Compares the outgoing player's actual points vs incoming player's actual points.
 */
function trackTransferOutcome(transfer, liveElements) {
  if (!transfer?.transfers?.length || !liveElements?.length) return null;

  const actualMap = new Map(liveElements.map(el => [el.id, el.stats || {}]));

  const outcomes = transfer.transfers.map(move => {
    const outActual = actualMap.get(move.out?.id);
    const inActual = actualMap.get(move.in?.id);
    if (!outActual || !inActual) return null;

    const outPts = Number(outActual.total_points) || 0;
    const inPts = Number(inActual.total_points) || 0;
    const actualGain = inPts - outPts;
    const predictedGain = move.out?.weekly?.[0]?.xPts != null && move.in?.weekly?.[0]?.xPts != null
      ? (move.in.weekly[0].xPts - move.out.weekly[0].xPts)
      : null;

    return {
      outName: move.out?.name,
      inName: move.in?.name,
      predictedGain: predictedGain != null ? round(predictedGain) : null,
      actualGain,
      wasCorrect: actualGain > 0,
      predictionError: predictedGain != null ? round(actualGain - predictedGain) : null,
    };
  }).filter(Boolean);

  if (!outcomes.length) return null;

  return {
    transfers: outcomes,
    overallGain: outcomes.reduce((s, o) => s + o.actualGain, 0),
    wasWorthIt: outcomes.every(o => o.wasCorrect),
  };
}

// ============================================================
// 7. COMPREHENSIVE LEARNING REPORT
// ============================================================
// Combine all self-learning insights into a single report.

/**
 * Generate a comprehensive learning report for a completed GW.
 */
function generateLearningReport(gw, predictions, liveElements, options = {}) {
  // Compare predictions to outcomes
  const comparison = comparePredictionsToOutcomes(gw, predictions, liveElements);
  if (!comparison) return { status: 'insufficient_data' };

  // Load historical outcomes for bias detection
  const outcomeHistory = [];
  for (let g = Math.max(1, gw - 10); g < gw; g++) {
    const prev = loadOutcomeSnapshot(g);
    if (prev) outcomeHistory.push(prev);
  }
  outcomeHistory.push(comparison);

  // Detect biases
  const biases = detectSystematicBiases(outcomeHistory);

  // Calibration
  const calibration = computeCalibration(outcomeHistory);

  // Parameter suggestions
  const currentParams = loadLearnedParameters();
  const adjustments = suggestParameterAdjustments(biases, calibration, currentParams);

  // Track transfer outcomes
  const transferOutcomes = (options.recentTransfers || []).map(t => trackTransferOutcome(t, liveElements)).filter(Boolean);

  // Save outcome snapshot for future learning
  saveOutcomeSnapshot(gw, comparison);

  return {
    gameweek: gw,
    generatedAt: new Date().toISOString(),
    comparison: {
      mae: comparison.metrics.mae,
      rmse: comparison.metrics.rmse,
      meanError: comparison.metrics.meanError,
      directionAccuracy: comparison.metrics.directionAccuracy,
      rangeAccuracy: comparison.metrics.rangeAccuracy,
      playerCount: comparison.playerCount,
    },
    positionMetrics: comparison.positionMetrics,
    biases,
    calibration,
    parameterAdjustments: adjustments,
    transferOutcomes,
    learningInsight: generateInsightSummary(comparison, biases, calibration),
  };
}

/**
 * Generate a human-readable insight summary.
 */
function generateInsightSummary(comparison, biases, calibration) {
  const insights = [];

  // Overall accuracy
  if (comparison.metrics.mae < 2) {
    insights.push('Strong prediction accuracy — model is performing well.');
  } else if (comparison.metrics.mae < 3.5) {
    insights.push('Moderate prediction accuracy — room for improvement.');
  } else {
    insights.push('Low prediction accuracy — model may need recalibration.');
  }

  // Systematic bias
  if (comparison.metrics.meanError > 1.5) {
    insights.push(`Model systematically overpredicts by ~${comparison.metrics.meanError} pts. Projections may be too optimistic.`);
  } else if (comparison.metrics.meanError < -1.5) {
    insights.push(`Model systematically underpredicts by ~${Math.abs(comparison.metrics.meanError)} pts. Projections may be too conservative.`);
  }

  // Direction accuracy
  if (comparison.metrics.directionAccuracy < 55) {
    insights.push('Direction accuracy is low — the model struggles to identify which players will outperform their position average.');
  }

  // Position-specific
  for (const [pos, metrics] of Object.entries(comparison.positionMetrics)) {
    if (Math.abs(metrics.meanError) > 2) {
      insights.push(`${pos} predictions have a ${metrics.meanError > 0 ? 'positive' : 'negative'} bias of ~${Math.abs(metrics.meanError)} pts.`);
    }
  }

  // Calibration
  if (calibration.status === 'computed' && calibration.avgCalibrationError > 15) {
    insights.push('Model confidence levels are poorly calibrated — high-confidence predictions are not significantly more accurate than low-confidence ones.');
  }

  // Active biases
  const highSeverityBiases = (biases.biases || []).filter(b => b.severity === 'high');
  if (highSeverityBiases.length > 0) {
    insights.push(`${highSeverityBiases.length} high-severity bias(es) detected: ${highSeverityBiases.map(b => b.type.replace(/_/g, ' ')).join(', ')}.`);
  }

  return insights;
}

// ============================================================
// 8. OUTCOME SNAPSHOT MANAGEMENT
// ============================================================

function saveOutcomeSnapshot(gw, comparison) {
  ensureDir(LEARNING_DIR);
  const filePath = path.join(LEARNING_DIR, `outcome_gw_${gw}.json`);
  try {
    fs.writeFileSync(filePath, JSON.stringify(comparison, null, 2), 'utf8');
  } catch (err) {
    logger.warn({ err: err.message, gw }, 'Failed to save outcome snapshot');
  }
}

function loadOutcomeSnapshot(gw) {
  const filePath = path.join(LEARNING_DIR, `outcome_gw_${gw}.json`);
  try {
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    }
  } catch (err) { /* ignore */ }
  return null;
}

// ============================================================
// UTILITIES
// ============================================================

function round(v, p = 1) { return Math.round(v * 10 ** p) / 10 ** p; }

// ============================================================
// EXPORTS
// ============================================================

module.exports = {
  // Prediction storage
  storePredictionSnapshot,
  loadPredictionSnapshot,
  // Outcome comparison
  comparePredictionsToOutcomes,
  // Calibration
  computeCalibration,
  // Bias detection
  detectSystematicBiases,
  // Self-tuning
  loadLearnedParameters,
  saveLearnedParameters,
  suggestParameterAdjustments,
  applyParameterAdjustments,
  DEFAULT_PARAMETERS,
  // Transfer tracking
  trackTransferOutcome,
  // Learning report
  generateLearningReport,
  generateInsightSummary,
  // Outcome snapshots
  saveOutcomeSnapshot,
  loadOutcomeSnapshot,
};
