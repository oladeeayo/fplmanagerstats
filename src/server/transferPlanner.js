// src/server/transferPlanner.js
// Multi-GW transfer planner with proper FT economics and bank carry-over

const { scorePlayer, findOptimalLineup, VALID_FORMATIONS } = require('./squadOptimizer');
const { calculateSellingPrice } = require('./priceModel');

// Transfer planning constants
const HIT_COST = 4;
const MAX_BANKED_FT = 5;
const FT_VALUE = 1.5; // estimated value of keeping a free transfer

// Plan transfers across multiple gameweeks
function planTransfers(currentSquad, allPlayers, options = {}) {
  const horizon = options.horizon || 5;
  const bank = options.bank || 0;
  const freeTransfers = Math.min(MAX_BANKED_FT, Math.max(1, options.freeTransfers || 1));
  const strategy = options.strategy || 'balanced';

  // Build projection map
  const projectionMap = new Map(allPlayers.map(p => [p.id, p]));
  const squadIds = new Set(currentSquad.map(p => p.id));

  // Evaluate candidates
  const candidates = allPlayers
    .filter(p => !squadIds.has(p.id) && (p.availability || 100) >= 50)
    .map(p => ({ ...p, _score: scorePlayer(p, options) }))
    .sort((a, b) => b._score - a._score);

  // Greedy transfer sequence planning
  const plans = [];
  let currentFT = freeTransfers;
  let currentBank = bank;
  let remainingSquad = [...currentSquad];

  for (let week = 0; week < Math.min(horizon, 3); week++) {
    const weekPlans = findBestTransfersForWeek(
      remainingSquad, candidates, currentFT, currentBank, strategy, week
    );

    if (weekPlans.length > 0) {
      const bestPlan = weekPlans[0];
      plans.push({ week: week + 1, ...bestPlan });

      // Apply transfers
      for (const transfer of bestPlan.transfers) {
        remainingSquad = remainingSquad.filter(p => p.id !== transfer.out.id);
        remainingSquad.push(transfer.in);
      }
      currentFT = bestPlan.transfers.length >= currentFT ? 1 : currentFT - bestPlan.transfers.length + 1;
      currentBank = bestPlan.bankAfter;
    } else {
      // Roll transfer
      currentFT = Math.min(MAX_BANKED_FT, currentFT + 1);
      plans.push({ week: week + 1, transfers: [], netGain: 0, rolled: true, freeTransfers: currentFT });
    }
  }

  return {
    plans,
    finalBank: currentBank,
    finalFreeTransfers: currentFT,
    totalNetGain: plans.reduce((sum, p) => sum + (p.netGain || 0), 0),
  };
}

function findBestTransfersForWeek(squad, candidates, freeTransfers, bank, strategy, weekOffset) {
  const plans = [];
  const hitCost = freeTransfers > 0 ? 0 : HIT_COST;

  // Try single transfers
  for (const outgoing of squad.sort((a, b) => scorePlayer(a) - scorePlayer(b)).slice(0, 12)) {
    const incoming = candidates
      .filter(p => p.position === outgoing.position)
      .filter(p => {
        const sellPrice = calculateSellingPrice(
          outgoing.purchasePrice || outgoing.cost,
          outgoing.cost
        );
        return p.cost <= sellPrice + bank;
      })
      .filter(p => {
        const teamCount = squad.filter(s => s.id !== outgoing.id && (s.team || s.teamId) === (p.team || p.teamId)).length;
        return teamCount < 3;
      })
      .slice(0, 5);

    for (const inCandidate of incoming) {
      const gain = scorePlayer(inCandidate) - scorePlayer(outgoing);
      const netGain = gain - hitCost;
      if (netGain > 0) {
        const sellPrice = calculateSellingPrice(
          outgoing.purchasePrice || outgoing.cost,
          outgoing.cost
        );
        const bankAfter = Math.round((bank + sellPrice - inCandidate.cost) * 10) / 10;
        plans.push({
          transfers: [{ out: outgoing, in: inCandidate }],
          gain,
          netGain,
          hitCost,
          bankAfter,
          risk: inCandidate.confidence === 'High' ? 'Low' : 'Medium',
        });
      }
    }
  }

  return plans.sort((a, b) => b.netGain - a.netGain);
}

// Build multi-GW transfer plan with chip considerations
function buildTransferStrategy(squad, allPlayers, options = {}) {
  const horizon = options.horizon || 5;
  const usedChips = options.usedChips || [];

  const plan = planTransfers(squad, allPlayers, options);

  // Analyze if wildcard is needed
  const weakPlayers = squad.filter(p => {
    const proj = allPlayers.find(a => a.id === p.id);
    return proj && proj.totalXpts < horizon * 2.5;
  }).length;

  const wildcardRecommendation = weakPlayers >= 4 ? {
    recommended: true,
    reason: `${weakPlayers} players project below threshold over ${horizon} GWs`,
    urgency: weakPlayers >= 6 ? 'high' : 'medium',
  } : {
    recommended: false,
    reason: 'Squad is strong enough to handle with regular transfers',
    urgency: 'low',
  };

  return {
    ...plan,
    wildcard: wildcardRecommendation,
    summary: generateTransferSummary(plan, options),
  };
}

function generateTransferSummary(plan, options) {
  const totalHits = plan.plans.reduce((sum, p) => sum + (p.hitCost || 0), 0);
  const totalGain = plan.totalNetGain;
  const avgGainPerWeek = plan.plans.length > 0 ? totalGain / plan.plans.length : 0;

  return {
    totalHits,
    totalHitPoints: totalHits * HIT_COST,
    totalNetGain: Math.round(totalGain * 10) / 10,
    avgGainPerWeek: Math.round(avgGainPerWeek * 10) / 10,
    transfersPlanned: plan.plans.reduce((sum, p) => sum + (p.transfers?.length || 0), 0),
    weeksRolled: plan.plans.filter(p => p.rolled).length,
  };
}

module.exports = {
  planTransfers,
  buildTransferStrategy,
  HIT_COST,
  MAX_BANKED_FT,
  FT_VALUE,
};
