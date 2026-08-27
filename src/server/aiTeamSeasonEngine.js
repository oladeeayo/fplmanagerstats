// src/server/aiTeamSeasonEngine.js
// AI Team Season Management Engine
// Strengthened autonomous transfer, chip, and captaincy decision-making
// for the model-owned FPL team. Does NOT touch Decision Lab.

function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }
function round(v, p = 1) { return Math.round(v * 10 ** p) / 10 ** p; }

// ============================================================
// 1. MULTI-HORIZON TRANSFER EVALUATION
// ============================================================
// Evaluate every potential transfer across 1GW, 3GW, 5GW, and 8GW horizons
// to prevent short-term traps and identify season-long upgrades.

function evaluateTransferHorizons(outgoing, incoming, allWeeklyData, gameweeks) {
  const horizons = [1, 3, 5, 8];
  const results = {};

  for (const h of horizons) {
    const gwSlice = gameweeks.slice(0, h);
    let outPts = 0;
    let inPts = 0;
    for (let i = 0; i < gwSlice.length; i++) {
      const gw = gwSlice[i];
      const decay = 0.92 ** i; // nearer GWs matter slightly more
      const outW = outgoing.weekly?.find(w => w.gameweek === gw);
      const inW = incoming.weekly?.find(w => w.gameweek === gw);
      outPts += (outW?.xPts || 0) * decay;
      inPts += (inW?.xPts || 0) * decay;
    }
    results[h + 'gw'] = {
      horizon: h,
      outXPts: round(outPts),
      inXPts: round(inPts),
      gain: round(inPts - outPts),
    };
  }

  // Season-long projection
  let outSeason = 0;
  let inSeason = 0;
  gameweeks.forEach((gw, i) => {
    const decay = 0.95 ** i;
    const outW = outgoing.weekly?.find(w => w.gameweek === gw);
    const inW = incoming.weekly?.find(w => w.gameweek === gw);
    outSeason += (outW?.xPts || 0) * decay;
    inSeason += (inW?.xPts || 0) * decay;
  });
  results.season = { horizon: 'season', outXPts: round(outSeason), inXPts: round(inSeason), gain: round(inSeason - outSeason) };

  return results;
}

// ============================================================
// 2. HIT-AWARE TRANSFER DECISION
// ============================================================
// Determine whether a transfer is worth a -4 hit by computing
// break-even gameweek and cumulative gain.

function hitAwareDecision(horizonGains, freeTransfers, options = {}) {
  const bestHorizon = options.preferredHorizon || 5;
  const key = bestHorizon + 'gw';
  const gain = horizonGains[key]?.gain || 0;
  const hitCost = freeTransfers > 0 ? 0 : 4;

  // Net gain after hit
  const netGain = gain - hitCost;

  // Break-even: after how many GWs does cumulative gain exceed hit cost?
  let cumulative = 0;
  let breakEvenGW = null;
  for (let i = 1; i <= bestHorizon; i++) {
    const gwKey = i + 'gw';
    const gwGain = (horizonGains[gwKey]?.gain || 0) - (i === 1 ? 0 : 0);
    // Interpolate: approx gain per GW from horizon data
    const perGW = gain / bestHorizon;
    cumulative += perGW;
    if (cumulative >= hitCost && breakEvenGW === null) {
      breakEvenGW = i;
    }
  }

  // Should we take the hit?
  // Threshold: net gain must be > 4.5 (comfortable margin above 4-point hit)
  const hitJustified = hitCost > 0 ? netGain >= 4.5 : true;
  // Aggressive threshold for -8 hits (double hit)
  const doubleHitJustified = false; // Never recommend -8 in autonomous mode

  return {
    gain: round(gain),
    hitCost,
    netGain: round(netGain),
    breakEvenGW,
    hitJustified,
    doubleHitJustified,
    freeTransfersAvailable: freeTransfers > 0,
  };
}

// ============================================================
// 3. TRANSFER TRIGGER SYSTEM
// ============================================================
// Each squad player has persistent triggers that can force a sell/hold/monitor decision.

function evaluatePlayerTriggers(player, options = {}) {
  const triggers = [];
  const actions = [];

  // TRIGGER 1: Minutes security
  const projectedMins = player.weekly?.[0]?.xMins || 0;
  const minsReliability = player.minutesReliability || 0.8;
  if (projectedMins < 45) {
    triggers.push({ type: 'minutes', severity: 'high', detail: `Projected ${projectedMins} minutes next GW` });
    actions.push('SELL');
  } else if (projectedMins < 60) {
    triggers.push({ type: 'minutes', severity: 'medium', detail: `Projected ${projectedMins} minutes — rotation risk` });
    actions.push('MONITOR');
  }

  // TRIGGER 2: Availability / injury
  const availability = player.availability || 100;
  const status = player.status || 'a';
  if (status === 'i' || availability === 0) {
    triggers.push({ type: 'injury', severity: 'critical', detail: `Injured/unavailable (${availability}% availability)` });
    actions.push('SELL');
  } else if (status === 'd' || availability < 60) {
    triggers.push({ type: 'injury', severity: 'high', detail: `Doubtful (${availability}% availability)` });
    actions.push('SELL');
  } else if (availability < 75) {
    triggers.push({ type: 'availability', severity: 'medium', detail: `${availability}% availability` });
    actions.push('MONITOR');
  }

  // TRIGGER 3: Role change detection (via starter score drop)
  const starterScore = Number(player.starterScore) || 50;
  if (starterScore < 35) {
    triggers.push({ type: 'role', severity: 'high', detail: `Starter score ${starterScore}/100 — likely rotation` });
    actions.push('SELL');
  } else if (starterScore < 50) {
    triggers.push({ type: 'role', severity: 'medium', detail: `Starter score ${starterScore}/100 — moderate risk` });
    actions.push('MONITOR');
  }

  // TRIGGER 4: Fixture quality collapse
  const upcoming = player.upcomingFixtures || [];
  const next3FDR = upcoming.slice(0, 3).map(f => f.fdr || 3);
  const avgFDR3 = next3FDR.length ? next3FDR.reduce((s, f) => s + f, 0) / next3FDR.length : 3;
  if (avgFDR3 >= 4.0) {
    triggers.push({ type: 'fixtures', severity: 'high', detail: `Average FDR ${avgFDR3.toFixed(1)} over next 3 GWs` });
    actions.push('CONSIDER_SELL');
  } else if (avgFDR3 >= 3.5) {
    triggers.push({ type: 'fixtures', severity: 'low', detail: `Average FDR ${avgFDR3.toFixed(1)} over next 3 GWs` });
  }

  // TRIGGER 5: Underlying numbers collapse (xGI decline)
  const xGI90 = Number(player.xGI90) || 0;
  const form = Number(player.form) || 0;
  const ppg = Number(player.ppg) || 0;
  if (form > 0 && ppg > 0 && form < ppg * 0.5 && xGI90 < 0.15) {
    triggers.push({ type: 'underlying', severity: 'medium', detail: `Form ${form.toFixed(1)} vs PPG ${ppg.toFixed(1)} with low xGI (${xGI90.toFixed(2)})` });
    actions.push('MONITOR');
  }

  // TRIGGER 6: Price drop risk
  if (Number(player.transfers_out) > Number(player.transfers_in) * 1.5) {
    triggers.push({ type: 'price', severity: 'low', detail: 'Net transfers out — potential price fall' });
  }

  // TRIGGER 7: Consecutive good fixtures ending
  if (player.consecutiveGoodFixtures > 0) {
    const nextFDR = upcoming[0]?.fdr || 3;
    if (nextFDR >= 4 && player.consecutiveGoodFixtures >= 3) {
      triggers.push({ type: 'fixture_swing', severity: 'medium', detail: `Good fixture run ending (was ${player.consecutiveGoodFixtures} consecutive, next is FDR ${nextFDR})` });
    }
  }

  // Determine overall action
  const hasCritical = actions.includes('SELL');
  const hasHigh = triggers.some(t => t.severity === 'high');
  const hasMonitor = actions.includes('MONITOR');

  let action = 'HOLD';
  if (hasCritical || (hasHigh && triggers.filter(t => t.severity === 'high').length >= 2)) {
    action = 'SELL';
  } else if (hasMonitor || hasHigh) {
    action = 'MONITOR';
  }

  return { triggers, action, triggerCount: triggers.length };
}

// ============================================================
// 4. ANTI-REACTION LAYER
// ============================================================
// Prevents the model from making transfers driven primarily by
// one GW's results (recency bias).

function antiReactionCheck(proposedTransfer, squad, currentGW, options = {}) {
  const { incoming, outgoing } = proposedTransfer;
  const reasons = [];
  let reactionRisk = 'low';

  // Check 1: Was the outgoing player's last GW unusually bad?
  const outLastGW = outgoing.weekly?.find(w => w.gameweek === currentGW);
  const outAvgXPts = outgoing.totalXpts / Math.max(outgoing.weekly?.length || 1, 1);
  const outLastPts = outLastGW?.xPts || 0;
  if (outLastPts < outAvgXPts * 0.3 && outLastPts < 2) {
    reasons.push(`Outgoing player (${outgoing.name}) had an unusually poor GW (${outLastPts.toFixed(1)} xPts vs ${outAvgXPts.toFixed(1)} avg)`);
    reactionRisk = 'medium';
  }

  // Check 2: Was the incoming player's last GW unusually good?
  const inLastGW = incoming.weekly?.find(w => w.gameweek === currentGW);
  const inAvgXPts = incoming.totalXpts / Math.max(incoming.weekly?.length || 1, 1);
  const inLastPts = inLastGW?.xPts || 0;
  if (inLastPts > inAvgXPts * 1.8 && inLastPts > 8) {
    reasons.push(`Incoming player (${incoming.name}) had an unusually strong GW (${inLastPts.toFixed(1)} xPts vs ${inAvgXPts.toFixed(1)} avg)`);
    reactionRisk = 'medium';
  }

  // Check 3: Has the underlying data actually changed, or just the points?
  const inXGI90 = Number(incoming.xGI90) || 0;
  const inForm = Number(incoming.form) || 0;
  const inPPG = Number(incoming.ppg) || 0;
  if (inForm > inPPG * 1.5 && inXGI90 < 0.35) {
    reasons.push(`Incoming player's form spike (${inForm.toFixed(1)}) may not be supported by underlying xGI (${inXGI90.toFixed(2)})`);
    if (reactionRisk === 'low') reactionRisk = 'high';
  }

  // Check 4: Is the transfer primarily driven by one fixture?
  const inNextFDR = incoming.upcomingFixtures?.[0]?.fdr || 3;
  const inAvgFDR = (incoming.upcomingFixtures || []).slice(0, 5).length > 0
    ? (incoming.upcomingFixtures || []).slice(0, 5).reduce((s, f) => s + (f.fdr || 3), 0) / Math.min(incoming.upcomingFixtures.length, 5)
    : 3;
  if (inNextFDR <= 1 && inAvgFDR >= 3.5) {
    reasons.push(`Transfer appears driven by single easy fixture (${inNextFDR}) while average is ${inAvgFDR.toFixed(1)}`);
    if (reactionRisk !== 'high') reactionRisk = 'medium';
  }

  // Check 5: Nothing meaningful changed — is this a lateral move?
  const horizonGain5 = proposedTransfer.horizonGains?.['5gw']?.gain || 0;
  if (horizonGain5 < 2.0 && horizonGain5 > -1) {
    reasons.push(`Transfer shows minimal medium-term improvement (${horizonGain5.toFixed(1)} xPts over 5 GWs)`);
    if (reactionRisk === 'low') reactionRisk = 'medium';
  }

  const shouldProceed = reactionRisk === 'low' || (reactionRisk === 'medium' && horizonGain5 >= 4.0);

  return {
    reactionRisk,
    reasons,
    shouldProceed,
    recommendation: shouldProceed ? 'Proceed with transfer' : 'Consider holding — transfer may be reaction-driven',
  };
}

// ============================================================
// 5. CHIP OPPORTUNITY EVALUATOR
// ============================================================
// Evaluates each chip's current GW value vs future windows.

function evaluateChipOpportunities(squad, starters, bench, captain, gameweeks, options = {}) {
  const results = [];

  for (const gw of gameweeks) {
    const benchXPts = bench.reduce((s, p) => {
      const w = p.weekly?.find(week => week.gameweek === gw);
      return s + (w?.xPts || 0);
    }, 0);

    const capXPts = captain ? (captain.weekly?.find(w => w.gameweek === gw)?.xPts || 0) : 0;
    const blanks = starters.filter(p => !p.weekly?.some(w => w.gameweek === gw && w.fixtures?.length > 0)).length;
    const injured = squad.filter(p => (p.availability || 0) < 50).length;
    const totalSquadXPts = squad.reduce((s, p) => {
      const w = p.weekly?.find(week => week.gameweek === gw);
      return s + (w?.xPts || 0);
    }, 0);

    // Bench Boost value: bench points that would otherwise be wasted
    // Only valuable when bench is strong AND likely to play
    const benchMinsQuality = bench.filter(p => (p.weekly?.find(w => w.gameweek === gw)?.xMins || 0) >= 55);
    const bbValue = benchMinsQuality.length >= 3 ? benchXPts : benchXPts * 0.6;

    // TC value: captain projected points × extra value
    // Most valuable when captain has exceptional fixture + high ceiling
    const capMins = captain?.weekly?.find(w => w.gameweek === gw)?.xMins || 0;
    const tcValue = capMins >= 75 ? capXPts * 0.85 : capXPts * 0.5;

    // WC value: number of problematic players + squad weakness
    const weakPlayers = squad.filter(p => (p.availability || 0) < 70 || (p.weekly?.find(w => w.gameweek === gw)?.xPts || 0) < 2).length;
    const wcValue = weakPlayers * 2.5 + (injured * 3);

    // FH value: blank fixtures that can't be covered
    const fhValue = blanks * 3.5;

    if (gw !== 1) { // WC and FH cannot be played in GW1
      results.push({ gw, chip: 'WC', value: round(wcValue), reason: `${weakPlayers} weak/injured players, ${injured} unavailable` });
      results.push({ gw, chip: 'FH', value: round(fhValue), reason: `${blanks} projected blanks` });
    }
    results.push({ gw, chip: 'BB', value: round(bbValue), reason: `Bench projects ${benchXPts.toFixed(1)} xPts (${benchMinsQuality.length} likely to play)` });
    results.push({ gw, chip: 'TC', value: round(tcValue), reason: `${captain?.name || 'Captain'} projects ${capXPts.toFixed(1)} xPts` });
  }

  return results;
}

// ============================================================
// 6. CHIP STRATEGY RANKING
// ============================================================
// Rank the best GW for each chip, and identify the best overall chip window.

function rankChipStrategy(chipOpportunities, usedChips = []) {
  const usedSet = new Set(usedChips.map(c => String(c).toLowerCase()));
  const chips = ['WC', 'FH', 'BB', 'TC'];
  const strategy = {};

  for (const chip of chips) {
    if (usedSet.has(chip.toLowerCase())) {
      strategy[chip] = { used: true, bestGW: null, bestValue: 0, windows: [] };
      continue;
    }

    const candidates = chipOpportunities.filter(c => c.chip === chip).sort((a, b) => b.value - a.value);
    const best = candidates[0] || null;

    // Build top windows (GWs where value is within 20% of best)
    const threshold = best ? best.value * 0.8 : 0;
    const windows = candidates.filter(c => c.value >= threshold).slice(0, 3);

    strategy[chip] = {
      used: false,
      bestGW: best?.gw || null,
      bestValue: best?.value || 0,
      bestReason: best?.reason || '',
      windows: windows.map(w => ({ gw: w.gw, value: w.value, reason: w.reason })),
    };
  }

  // Find the single best chip opportunity across all chips
  const allAvailable = chipOpportunities.filter(c => !usedSet.has(c.chip.toLowerCase()));
  const bestOverall = allAvailable.sort((a, b) => b.value - a.value)[0] || null;

  return {
    strategy,
    bestOverallChip: bestOverall ? {
      chip: bestOverall.chip,
      gw: bestOverall.gw,
      value: bestOverall.value,
      reason: bestOverall.reason,
    } : null,
    shouldUseChipNow: bestOverall ? bestOverall.value >= 8 : false,
  };
}

// ============================================================
// 7. TRANSFER DECISION BRIEF GENERATOR
// ============================================================
// Produces the structured GW decision brief for the AI Team.

function generateDecisionBrief(squad, starters, bench, captain, viceCaptain, transferPlan, chipStrategy, currentGW, nextGW, freeTransfers) {
  const gwTransfer = transferPlan.find(p => p.gw === nextGW) || transferPlan.find(p => p.gw === currentGW);
  const transfers = gwTransfer?.transfers || [];
  const hit = gwTransfer?.hit || 0;
  const rolled = gwTransfer?.rolled || transfers.length === 0;

  // Projected points for next GW
  const nextGWXPts = starters.reduce((s, p) => {
    const w = p.weekly?.find(week => week.gameweek === nextGW);
    return s + (w?.xPts || 0);
  }, 0) + (captain?.weekly?.find(w => w.gameweek === nextGW)?.xPts || 0);

  // Decision action
  let action = 'ROLL';
  if (chipStrategy.shouldUseChipNow && chipStrategy.bestOverallChip) {
    action = 'CHIP: ' + chipStrategy.bestOverallChip.chip;
  } else if (transfers.length > 0 && hit === 0) {
    action = 'TRANSFER';
  } else if (transfers.length > 0 && hit > 0) {
    action = 'HIT';
  }

  // Reasons
  const reasons = [];
  if (rolled) {
    reasons.push('No transfer provides sufficient medium-term gain to justify the move.');
    reasons.push(`Current squad projects ${nextGWXPts.toFixed(1)} xPts for GW${nextGW}.`);
  }
  if (transfers.length > 0) {
    const totalGain = transfers.reduce((s, t) => s + (t.gain || 0), 0);
    reasons.push(`Transfer(s) project +${totalGain.toFixed(1)} xPts gain over the horizon.`);
    if (hit > 0) reasons.push(`-${hit} hit cost — break-even expected within the horizon.`);
  }
  if (chipStrategy.shouldUseChipNow) {
    reasons.push(`${chipStrategy.bestOverallChip.chip} opportunity: GW${chipStrategy.bestOverallChip.gw} (value: ${chipStrategy.bestOverallChip.value.toFixed(1)}).`);
    reasons.push(chipStrategy.bestOverallChip.reason);
  }

  // Risks
  const risks = [];
  const injuredCount = squad.filter(p => (p.availability || 0) < 60).length;
  if (injuredCount > 0) risks.push(`${injuredCount} player(s) with availability concerns.`);
  if (hit > 0) risks.push(`Taking a -${hit} hit reduces cushion.`);
  const avgFDR3 = starters.slice(0, 11).reduce((s, p) => {
    const fixtures = (p.upcomingFixtures || []).slice(0, 3);
    return s + (fixtures.length ? fixtures.reduce((fs, f) => fs + (f.fdr || 3), 0) / fixtures.length : 3);
  }, 0) / 11;
  if (avgFDR3 >= 3.8) risks.push(`Difficult fixture run (avg FDR ${avgFDR3.toFixed(1)} for starters).`);

  // Watch list
  const watch = squad.filter(p => {
    const trigger = evaluatePlayerTriggers(p);
    return trigger.action === 'MONITOR';
  }).map(p => ({ name: p.name, position: p.position, reason: evaluatePlayerTriggers(p).triggers[0]?.detail || 'Monitor' }));

  return {
    gw: nextGW,
    currentGW,
    decision: {
      action,
      confidence: rolled ? 75 : (transfers.length > 0 ? 70 : 60),
    },
    squad: {
      projectedPoints: round(nextGWXPts),
      formation: null, // will be filled by caller
    },
    transfer: transfers.length > 0 ? {
      out: transfers[0].out?.name,
      in: transfers[0].in?.name,
      expectedGain: round(transfers[0].gain || 0),
      hit,
    } : null,
    captain: captain ? { name: captain.name, expectedPoints: round(captain.weekly?.find(w => w.gameweek === nextGW)?.xPts || 0) } : null,
    chip: chipStrategy,
    freeTransfers,
    reasons,
    risks,
    watch,
    modelVersion: 'AI Team Engine 10.0',
    dataSnapshot: new Date().toISOString(),
  };
}

// ============================================================
// 8. PLAYER HOLD/SELL SCORING
// ============================================================
// Score each squad player on a 0-100 scale to prioritize who to sell first.

function scorePlayerHoldValue(player, gameweeks, options = {}) {
  let score = 50; // baseline

  // Expected points contribution over horizon
  const horizonXPts = gameweeks.reduce((s, gw, i) => {
    const w = player.weekly?.find(week => week.gameweek === gw);
    return s + (w?.xPts || 0) * (0.92 ** i);
  }, 0);
  score += clamp(horizonXPts * 1.5, -20, 30);

  // Availability
  const avail = player.availability || 100;
  score -= clamp((100 - avail) * 0.3, -15, 0);

  // Minutes security
  const starterScore = Number(player.starterScore) || 50;
  score += clamp((starterScore - 50) * 0.3, -10, 10);

  // Fixture quality
  const upcoming = player.upcomingFixtures || [];
  const avgFDR = upcoming.length > 0
    ? upcoming.slice(0, 5).reduce((s, f) => s + (f.fdr || 3), 0) / Math.min(upcoming.length, 5)
    : 3;
  score += clamp((3 - avgFDR) * 5, -10, 10);

  // Set piece / penalty bonus
  if (player.isPenaltyTaker) score += 3;
  if (player.isFKTaker) score += 1.5;
  if (player.isCornerTaker) score += 1;

  // Price (selling value)
  score += clamp((Number(player.enhancedCost) || 5) * 0.5, 2, 5);

  return {
    score: round(clamp(score, 0, 100)),
    horizonXPts: round(horizonXPts),
    verdict: score >= 65 ? 'HOLD' : score >= 45 ? 'WATCH' : score >= 30 ? 'CONSIDER_SELL' : 'SELL',
  };
}

// ============================================================
// 9. WHOLE-SQUAD HEALTH CHECK
// ============================================================
// Aggregates individual player scores into a squad health assessment.

function squadHealthCheck(squad, gameweeks) {
  const playerScores = squad.map(p => ({
    player: p,
    ...scorePlayerHoldValue(p, gameweeks),
    triggers: evaluatePlayerTriggers(p),
  }));

  const sells = playerScores.filter(p => p.verdict === 'SELL');
  const watches = playerScores.filter(p => p.verdict === 'WATCH');
  const considerSells = playerScores.filter(p => p.verdict === 'CONSIDER_SELL');

  const avgScore = playerScores.reduce((s, p) => s + p.score, 0) / Math.max(playerScores.length, 1);
  const weakestPlayers = [...playerScores].sort((a, b) => a.score - b.score).slice(0, 3);

  const urgency = sells.length >= 3 ? 'HIGH'
    : sells.length >= 1 || considerSells.length >= 2 ? 'MEDIUM'
    : watches.length >= 3 ? 'LOW'
    : 'STABLE';

  return {
    avgScore: round(avgScore),
    urgency,
    sells,
    considerSells,
    watches,
    weakestPlayers,
    playerScores,
  };
}

// ============================================================
// EXPORTS
// ============================================================

module.exports = {
  evaluateTransferHorizons,
  hitAwareDecision,
  evaluatePlayerTriggers,
  antiReactionCheck,
  evaluateChipOpportunities,
  rankChipStrategy,
  generateDecisionBrief,
  scorePlayerHoldValue,
  squadHealthCheck,
};
