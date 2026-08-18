// src/server/autosubModel.js
// Autosub probability model — models the likelihood of bench players coming on

// Probability distribution for different match outcomes for a player
// Based on historical FPL data patterns
const MINUTES_DISTRIBUTION = {
  // P(0 mins), P(1-29), P(30-59), P(60-79), P(80-90)
  starter: [0.02, 0.03, 0.08, 0.35, 0.52],
  rotation: [0.15, 0.12, 0.18, 0.30, 0.25],
  sub: [0.30, 0.25, 0.20, 0.15, 0.10],
  unknown: [0.35, 0.15, 0.15, 0.18, 0.17],
};

// Expected points for each minutes bracket (position-dependent)
const MINUTES_POINTS = {
  GKP: { zero: 0, cameo: 1, partial: 2, full: 4, complete: 6 },
  DEF: { zero: 0, cameo: 0.5, partial: 1.5, full: 3, complete: 4.5 },
  MID: { zero: 0, cameo: 0.5, partial: 2, full: 3.5, complete: 5 },
  FWD: { zero: 0, cameo: 0.5, partial: 2, full: 3.5, complete: 5.5 },
};

// Calculate expected autosub contribution from a bench player
function calculateAutosubEV(benchPlayer, starterMinutesRisk, options = {}) {
  const position = benchPlayer.position || 'MID';
  const xPts = Number(benchPlayer.weekly?.[0]?.xPts || benchPlayer.xPts || 0);
  const xMins = Number(benchPlayer.weekly?.[0]?.xMins || benchPlayer.xMins || 0);
  const availability = Number(benchPlayer.availability || 100) / 100;

  // Determine player category
  let category = 'unknown';
  if (xMins >= 75) category = 'starter';
  else if (xMins >= 55) category = 'rotation';
  else if (xMins >= 20) category = 'sub';
  else category = 'unknown';

  const dist = MINUTES_DISTRIBUTION[category];
  const pts = MINUTES_POINTS[position];

  // Expected points from each minutes bracket
  const ev = (
    dist[0] * pts.zero +
    dist[1] * pts.cameo +
    dist[2] * pts.partial +
    dist[3] * pts.full +
    dist[4] * pts.complete
  ) * availability;

  // Autosub probability: chance this player comes on as sub
  // Higher if starters have minutes risk
  const autoSubProb = Math.min(1, (dist[0] + dist[1]) * 0.3 + starterMinutesRisk * 0.15);

  return {
    ev,
    autoSubProb,
    category,
    expectedMinutes: xMins,
    contribution: ev * autoSubProb,
  };
}

// Calculate bench contribution for a lineup
function calculateBenchContribution(starters, bench, options = {}) {
  if (!bench || bench.length === 0) return { totalContribution: 0, details: [] };

  // Calculate average minutes risk of starters
  const starterMinutesRisk = starters.reduce((sum, s) => {
    const xMins = Number(s.weekly?.[0]?.xMins || s.xMins || 75);
    return sum + (1 - xMins / 90);
  }, 0) / Math.max(starters.length, 1);

  const details = bench.map(player => {
    const autosub = calculateAutosubEV(player, starterMinutesRisk, options);
    return {
      player: player.name,
      position: player.position,
      ...autosub,
    };
  });

  const totalContribution = details.reduce((sum, d) => sum + d.contribution, 0);

  return {
    totalContribution: Math.round(totalContribution * 100) / 100,
    starterMinutesRisk: Math.round(starterMinutesRisk * 100) / 100,
    details,
  };
}

// Find optimal bench order (highest autosub EV first)
function orderBench(bench, starters) {
  const starterMinutesRisk = starters.reduce((sum, s) => {
    const xMins = Number(s.weekly?.[0]?.xMins || s.xMins || 75);
    return sum + (1 - xMins / 90);
  }, 0) / Math.max(starters.length, 1);

  return bench
    .map(p => ({
      ...p,
      _autosubEV: calculateAutosubEV(p, starterMinutesRisk),
    }))
    .sort((a, b) => b._autosubEV.contribution - a._autosubEV.contribution);
}

module.exports = {
  calculateAutosubEV,
  calculateBenchContribution,
  orderBench,
};
