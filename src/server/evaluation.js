// src/server/evaluation.js
// Walk-forward evaluation framework with proper metrics
const logger = require('./logger');

// Root Mean Squared Error
function rmse(predictions, actuals) {
  if (!predictions.length) return 0;
  const sumSq = predictions.reduce((sum, pred, i) => sum + Math.pow(pred - (actuals[i] || 0), 2), 0);
  return Math.sqrt(sumSq / predictions.length);
}

// Mean Absolute Error
function mae(predictions, actuals) {
  if (!predictions.length) return 0;
  return predictions.reduce((sum, pred, i) => sum + Math.abs(pred - (actuals[i] || 0)), 0) / predictions.length;
}

// Spearman rank correlation
function spearman(predictions, actuals) {
  if (predictions.length < 3) return 0;
  const rank = (arr) => {
    const sorted = arr.map((v, i) => ({ v, i })).sort((a, b) => a.v - b.v);
    const ranks = new Array(arr.length);
    sorted.forEach((item, rank) => { ranks[item.i] = rank + 1; });
    return ranks;
  };
  const rPred = rank(predictions);
  const rActual = rank(actuals);
  const n = predictions.length;
  const dSqSum = rPred.reduce((sum, r, i) => sum + Math.pow(r - rActual[i], 2), 0);
  return 1 - (6 * dSqSum) / (n * (n * n - 1));
}

// NDCG@k (Normalized Discounted Cumulative Gain)
function ndcgAtK(predictions, actuals, k = 10) {
  if (predictions.length < k) return 0;
  const dcg = (scores) => {
    return scores.slice(0, k).reduce((sum, score, i) => sum + (Math.pow(2, score) - 1) / Math.log2(i + 2), 0);
  };
  const predOrder = predictions.map((p, i) => ({ p, a: actuals[i] || 0 })).sort((a, b) => b.p - a.p);
  const idealOrder = [...actuals].sort((a, b) => b - a);
  const predDCG = dcg(predOrder.map(x => x.a));
  const idealDCG = dcg(idealOrder);
  return idealDCG > 0 ? predDCG / idealDCG : 0;
}

// Classification metrics for "haul" prediction (>= 5 points)
function haulMetrics(predictions, actuals) {
  const threshold = 5;
  const predHauls = predictions.filter(p => p >= threshold).length;
  const actualHauls = actuals.filter(a => a >= threshold).length;
  const truePositives = predictions.filter((p, i) => p >= threshold && (actuals[i] || 0) >= threshold).length;
  const precision = predHauls > 0 ? truePositives / predHauls : 0;
  const recall = actualHauls > 0 ? truePositives / actualHauls : 0;
  const f1 = precision + recall > 0 ? 2 * (precision * recall) / (precision + recall) : 0;
  return { precision, recall, f1, predHauls, actualHauls };
}

// Evaluate xPts predictions against actual outcomes
function evaluatePredictions(predictions, actuals, options = {}) {
  if (!predictions.length || !actuals.length) {
    return { error: 'No data to evaluate' };
  }

  const min = Math.min(predictions.length, actuals.length);
  const pred = predictions.slice(0, min);
  const act = actuals.slice(0, min);

  return {
    samples: min,
    rmse: rmse(pred, act),
    mae: mae(pred, act),
    spearman: spearman(pred, act),
    ndcg10: ndcgAtK(pred, act, 10),
    haul: haulMetrics(pred, act),
    // Position-specific breakdown if provided
    ...(options.byPosition ? { byPosition: evaluateByPosition(pred, act, options.positions) } : {}),
  };
}

function evaluateByPosition(predictions, actuals, positions) {
  if (!positions || !positions.length) return {};
  const byPos = {};
  positions.forEach(pos => { byPos[pos] = { predictions: [], actuals: [] }; });
  predictions.forEach((pred, i) => {
    const pos = positions[i];
    if (byPos[pos]) {
      byPos[pos].predictions.push(pred);
      byPos[pos].actuals.push(actuals[i]);
    }
  });
  const result = {};
  for (const [pos, data] of Object.entries(byPos)) {
    if (data.predictions.length > 0) {
      result[pos] = {
        samples: data.predictions.length,
        rmse: rmse(data.predictions, data.actuals),
        mae: mae(data.predictions, data.actuals),
        spearman: spearman(data.predictions, data.actuals),
      };
    }
  }
  return result;
}

module.exports = {
  rmse, mae, spearman, ndcgAtK, haulMetrics, evaluatePredictions, evaluateByPosition,
};
