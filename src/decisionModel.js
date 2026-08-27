const { buildPlayerProjections, buildCaptaincyModel } = require('./captaincyModel');
const {
  clamp,
  computePlayerStrengthScore,
  computeUncertainty,
  computeTransferDecisionScore,
  classifyTransferUrgency,
  classifyRecommendation,
  devilAdvocate,
  rankAllTransferOpportunities,
  evaluateRollTransfer,
  detectPreHaulCandidates,
  detectRegressionRisks,
  findBestMoveAcrossSquad,
  computeMinutesProbability,
  detectRegression,
  earlySeasonWeights,
  bayesianBlend,
  analyzeTransfer,
  buildSquadHeatmap,
  dontSellProtection,
  dontBuyProtection,
  findTransferAlternatives,
  buildDecisionTriggers,
  generateYourDecisionBrief,
  optimizeChips,
  analyzeTransferMode,
  findBestTransferMode,
  optimizeTeamMode,
  monteCarloTransferAnalysis,
  earlySeasonDampener,
  simulateSquadGW,
  detectNewToPL,
  computeNewLeagueAdjustment,
  applyNewLeagueAdjustment,
  computePromotedAdjustment,
  HORIZONS,
} = require('./server/decisionLabEngine');

const POSITION_LIMITS = { GKP: 2, DEF: 5, MID: 5, FWD: 3 };
const START_MINIMUMS = { GKP: 1, DEF: 3, MID: 2, FWD: 1 };

function round(value, precision = 1) {
  const multiplier = 10 ** precision;
  return Math.round(value * multiplier) / multiplier;
}

function normalizeStrategy(value) {
  return ['balanced', 'protect', 'chase'].includes(value) ? value : 'balanced';
}

function adjustedScore(player, strategy) {
  const consistencyBoost = (player.consistencyScore || 0) * 0.4;
  const improvementBoost = (player.improvementRatio || 1) > 1 ? (player.improvementRatio - 1) * 1.2 : 0;
  if (strategy === 'protect') return player.totalXpts + Math.min(player.ownership, 50) * 0.025 + player.availability * 0.006 + consistencyBoost;
  if (strategy === 'chase') return player.totalXpts + (100 - Math.min(player.ownership, 80)) * 0.018 + (player.range.high - player.totalXpts) * 0.22 + improvementBoost;
  return player.totalXpts + player.xPtsPerMillion * 0.04 + consistencyBoost * 0.3;
}

function validSquad(players) {
  if (players.length !== 15) return false;
  const positions = players.reduce((counts, player) => ({ ...counts, [player.position]: (counts[player.position] || 0) + 1 }), {});
  const teams = players.reduce((counts, player) => ({ ...counts, [player.teamId]: (counts[player.teamId] || 0) + 1 }), {});
  return Object.entries(POSITION_LIMITS).every(([position, count]) => positions[position] === count) && Object.values(teams).every(count => count <= 3);
}

function selectLineup(squad, strategy) {
  const ranked = [...squad].sort((a, b) => adjustedScore(b, strategy) - adjustedScore(a, strategy));
  const starters = [];
  Object.entries(START_MINIMUMS).forEach(([position, count]) => starters.push(...ranked.filter(player => player.position === position).slice(0, count)));
  ranked.forEach(player => {
    if (starters.length >= 11 || starters.some(starter => starter.id === player.id)) return;
    if (player.position === 'GKP' && starters.some(starter => starter.position === 'GKP')) return;
    starters.push(player);
  });
  const bench = ranked.filter(player => !starters.some(starter => starter.id === player.id));
  // Captain: use captaincyScore.finalScore when available (from the captaincy model),
  // fall back to weekly xPts. This integrates rotation risk, fixtures, set pieces,
  // elite pool weighting, and H2H data into the captain pick.
  const captainPool = starters.filter(player => player.position !== 'GKP').sort((a, b) => {
    const scoreA = Number(a.captaincyScore?.finalScore) || a.weekly[0].xPts;
    const scoreB = Number(b.captaincyScore?.finalScore) || b.weekly[0].xPts;
    if (scoreB !== scoreA) return scoreB - scoreA;
    return b.weekly[0].xPts - a.weekly[0].xPts || b.range.high - a.range.high;
  });
  const captain = captainPool[0] || starters[0];
  const viceCaptain = captainPool[1] || starters[1];
  const expectedPoints = round(starters.reduce((sum, player) => sum + player.weekly[0].xPts, 0) + (captain?.weekly[0].xPts || 0));
  return { starters, bench, captain, viceCaptain, expectedPoints };
}

function buildTransferPlans({ squad, allPlayers, bank, freeTransfers, strategy, currentGW, horizon }) {
  const squadIds = new Set(squad.map(player => player.id));
  const candidates = allPlayers.filter(player => !squadIds.has(player.id) && player.availability >= 50);
  const sales = [...squad].sort((a, b) => adjustedScore(a, strategy) - adjustedScore(b, strategy));
  const plans = [];
  const dampener = earlySeasonDampener(currentGW || 1);

  // Minimum thresholds — calibrated for early-season projection noise
  const MIN_NET_GAIN_FREE = 2.0;   // Free transfer must project ≥2.0 xPts net gain over horizon (~0.4/GW)
  const MIN_NET_GAIN_HIT = 5.0;    // Hit must project ≥5.0 xPts net gain (1pt margin above -4 hit cost)
  const MIN_NEXT_GAIN = 0.5;       // Single-GW improvement floor — low bar early season (high variance)
  const MIN_XPTSPM_IMPROVEMENT = 0.03; // Allow modest efficiency upgrades (3% better per £m)

  for (const outgoing of sales.slice(0, 10)) {
    candidates
      .filter(incoming => incoming.position === outgoing.position && incoming.cost <= (outgoing.sellingPrice ?? outgoing.cost) + bank)
      .filter(incoming => squad.filter(player => player.teamId === incoming.teamId).length + 1 <= 3)
      .sort((a, b) => adjustedScore(b, strategy) - adjustedScore(a, strategy))
      .slice(0, 8)
      .forEach(incoming => {
        const horizonGain = round(incoming.totalXpts - outgoing.totalXpts);
        const nextGain = round(incoming.weekly[0].xPts - outgoing.weekly[0].xPts);
        const hitCost = freeTransfers > 0 ? 0 : 4;
        const netGain = round(horizonGain - hitCost);
        const xptsPerMpmImprovement = (incoming.xPtsPerMillion || 0) - (outgoing.xPtsPerMillion || 0);

        // Reject weak transfers: require meaningful improvement
        if (netGain <= 0) return;
        if (hitCost > 0 && netGain < MIN_NET_GAIN_HIT) return;
        if (hitCost === 0 && netGain < MIN_NET_GAIN_FREE) return;
        if (nextGain < MIN_NEXT_GAIN && horizonGain < MIN_NET_GAIN_FREE) return;
        // Reject lateral moves: incoming must be meaningfully better per-£m
        if (xptsPerMpmImprovement < MIN_XPTSPM_IMPROVEMENT && horizonGain < 3.0) return;
        // Decision Lab enhanced scoring
        const labDecision = computeTransferDecisionScore(outgoing, incoming, {
          horizon: horizon || 5, freeTransfers, currentGW: currentGW || 1,
        });
        const labUrgency = classifyTransferUrgency(labDecision, {
          incomingAvailability: incoming.availability || 100,
        });
        const labRecommendation = classifyRecommendation(labDecision.score, 100 - computeUncertainty(incoming).uncertainty * 100);
        const labRisks = devilAdvocate(outgoing, incoming, labDecision);
        plans.push({
          id: `${outgoing.id}-${incoming.id}`,
          transfers: [{ out: outgoing, in: incoming }],
          nextGain,
          horizonGain,
          hitCost,
          netGain,
          bankAfter: round(bank + (outgoing.sellingPrice ?? outgoing.cost) - incoming.cost),
          breakEvenProbability: Math.round(Math.max(8, Math.min(dampener.probabilityCap, 50 + netGain * 5 - (100 - incoming.availability) * 0.22))),
          risk: incoming.confidence === 'High' ? 'Low' : incoming.availability < 75 ? 'High' : 'Medium',
          rationale: `${incoming.name} adds ${netGain.toFixed(1)} hit-adjusted xPts over ${outgoing.name} across the next ${incoming.weekly.length} gameweeks.${incoming.hasMultiSeasonData ? ` Multi-season consistency: ${Math.round((incoming.consistencyScore || 0) * 100)}%.` : ''}${incoming.improvementRatio > 1 ? ` ${Math.round((incoming.improvementRatio - 1) * 100)}% xGI improvement vs last season.` : ''}`,
          // Decision Lab fields
          decisionScore: labDecision.score,
          probabilityTransferWins: labDecision.probabilityTransferWins,
          breakEvenGW: labDecision.breakEvenGW,
          urgency: labUrgency,
          recommendation: labRecommendation.category,
          recommendationEmoji: labRecommendation.emoji,
          risks: labRisks,
          confidence: round(clamp(100 - computeUncertainty(incoming).uncertainty * 100, 15, dampener.confidenceCap)),
        });
      });
  }

  plans.sort((a, b) => b.netGain - a.netGain || b.nextGain - a.nextGain);
  const oneTransferPlans = plans.slice(0, 12);
  const doublePlans = [];
  for (let firstIndex = 0; firstIndex < Math.min(oneTransferPlans.length, 7); firstIndex += 1) {
    for (let secondIndex = firstIndex + 1; secondIndex < Math.min(oneTransferPlans.length, 10); secondIndex += 1) {
      const first = oneTransferPlans[firstIndex];
      const second = oneTransferPlans[secondIndex];
      const ids = [first.transfers[0].out.id, first.transfers[0].in.id, second.transfers[0].out.id, second.transfers[0].in.id];
      if (new Set(ids).size !== 4) continue;
      const resulting = squad.filter(player => ![first.transfers[0].out.id, second.transfers[0].out.id].includes(player.id)).concat(first.transfers[0].in, second.transfers[0].in);
      if (!validSquad(resulting)) continue;
      const firstSale = first.transfers[0].out.sellingPrice ?? first.transfers[0].out.cost;
      const secondSale = second.transfers[0].out.sellingPrice ?? second.transfers[0].out.cost;
      const newBank = round(bank + firstSale + secondSale - first.transfers[0].in.cost - second.transfers[0].in.cost);
      if (newBank < 0) continue;
      // Strictly cap hitCost at 4 (max 1 hit in extreme cases, never -8 or -12)
      const rawHitCost = Math.max(0, 2 - freeTransfers) * 4;
      if (rawHitCost > 4) continue; // Exclude double-hit plans (> -4 hit)
      const hitCost = Math.min(4, rawHitCost);
      const horizonGain = round(first.horizonGain + second.horizonGain);
      const netGain = round(horizonGain - hitCost);
      if (hitCost > 0 && netGain < MIN_NET_GAIN_HIT) continue;
      if (hitCost === 0 && netGain < MIN_NET_GAIN_FREE) continue;
      if (netGain <= 0) continue;
      doublePlans.push({
        id: `${first.id}-${second.id}`,
        transfers: [first.transfers[0], second.transfers[0]],
        nextGain: round(first.nextGain + second.nextGain),
        horizonGain,
        hitCost,
        netGain,
        bankAfter: newBank,
        breakEvenProbability: Math.round(Math.max(8, Math.min(92, 48 + netGain * 4))),
        risk: [first.risk, second.risk].includes('High') ? 'High' : 'Medium',
        rationale: `The paired move adds ${netGain.toFixed(1)} hit-adjusted xPts while preserving a legal squad and £${newBank.toFixed(1)}m bank.`,
      });
    }
  }
  // Guarantee a mix: always surface top singles, then fill with doubles
  const topSingles = oneTransferPlans.slice(0, 8);
  const remainingDoubles = doublePlans.filter(d => !topSingles.some(s => s.id === d.id));
  const topDoubles = remainingDoubles.sort((a, b) => b.netGain - a.netGain).slice(0, 10);
  return [...topSingles, ...topDoubles].sort((a, b) => b.netGain - a.netGain).slice(0, 18);
}

function buildOptimalSquad(allPlayers, budget, strategy) {
  const selected = [];
  const teamCounts = {};
  let spent = 0;
  const minimumCosts = Object.fromEntries(Object.keys(POSITION_LIMITS).map(position => [position, Math.min(...allPlayers.filter(player => player.position === position).map(player => player.cost))]));
  for (const [position, count] of Object.entries(POSITION_LIMITS)) {
    for (let slot = 0; slot < count; slot += 1) {
      const remainingMinimum = Object.entries(POSITION_LIMITS).reduce((sum, [candidatePosition, limit]) => {
        const already = selected.filter(player => player.position === candidatePosition).length;
        return sum + Math.max(0, limit - already - (candidatePosition === position ? 1 : 0)) * minimumCosts[candidatePosition];
      }, 0);
      const choice = allPlayers
        .filter(player => player.position === position && !selected.some(item => item.id === player.id))
        .filter(player => (teamCounts[player.teamId] || 0) < 3)
        .filter(player => spent + player.cost + remainingMinimum <= budget + 0.001)
        .sort((a, b) => adjustedScore(b, strategy) / Math.max(b.cost, 3.5) - adjustedScore(a, strategy) / Math.max(a.cost, 3.5))[0];
      if (!choice) continue;
      selected.push(choice);
      spent += choice.cost;
      teamCounts[choice.teamId] = (teamCounts[choice.teamId] || 0) + 1;
    }
  }
  return { players: selected, cost: round(spent), projectedPoints: round(selected.reduce((sum, player) => sum + player.totalXpts, 0)), valid: validSquad(selected) };
}

function buildChipPlan({ squad, gameweeks, usedChips, strategy }) {
  const weeks = gameweeks.map((gameweek, index) => {
    const indexedSquad = squad.map(player => ({ ...player, weekly: [player.weekly[index]] }));
    const lineup = selectLineup(indexedSquad, strategy);
    const benchPoints = round(lineup.bench.reduce((sum, player) => sum + player.weekly[0].xPts, 0));
    const blankCount = indexedSquad.filter(player => !player.weekly[0].fixtures.length).length;
    return { gameweek, benchBoostGain: benchPoints, tripleCaptainGain: round(lineup.captain?.weekly[0].xPts || 0), freeHitNeed: round(blankCount * 1.6 + Math.max(0, 48 - lineup.expectedPoints) * 0.25), wildcardNeed: round(indexedSquad.filter(player => player.availability < 75 || player.totalXpts < 2.5 * gameweeks.length).length * 1.4), topCaptain: lineup.captain?.name || '--' };
  });
  const available = chip => !usedChips.some(used => String(used).toLowerCase().includes(chip));
  // FPL rule: the Wildcard and Free Hit chips cannot be played in Gameweek 1.
  const playableWeeks = (weeks, chip) => chip === 'Wildcard' || chip === 'Free Hit'
    ? weeks.filter(week => week.gameweek !== 1)
    : weeks;
  const recommendations = [
    available('bboost') && { chip: 'Bench Boost', metric: 'benchBoostGain' },
    available('3xc') && { chip: 'Triple Captain', metric: 'tripleCaptainGain' },
    available('freehit') && { chip: 'Free Hit', metric: 'freeHitNeed' },
    available('wildcard') && { chip: 'Wildcard', metric: 'wildcardNeed' },
  ].filter(Boolean).map(({ chip, metric }) => {
    const candidateWeeks = playableWeeks(weeks, chip);
    const best = [...candidateWeeks].sort((a, b) => b[metric] - a[metric])[0] || null;
    const labels = { benchBoostGain: 'Projected bench output', tripleCaptainGain: 'Extra captain projection', freeHitNeed: 'Blank and weak-lineup pressure', wildcardNeed: 'Squad repair pressure' };
    const gated = !best ? ' Wildcard and Free Hit cannot be played in GW1.' : '';
    return { chip, gameweek: best?.gameweek || null, expectedGain: best ? best[metric] : 0, confidence: best ? (best[metric] >= 8 ? 'High' : best[metric] >= 5 ? 'Medium' : 'Wait') : 'Wait', reason: best ? `${labels[metric]} peaks in GW${best.gameweek}.` : `${labels[metric]} has no playable window in this horizon.${gated}` };
  });
  return { weeks, recommendations };
}

function buildAlerts(squad, plans) {
  const alerts = [];
  squad.forEach(player => {
    if (player.availability < 75) alerts.push({ severity: player.availability === 0 ? 'critical' : 'warning', type: 'availability', playerId: player.id, message: `${player.name} has ${player.availability}% modeled availability${player.news ? `: ${player.news}` : '.'}` });
    if (!player.weekly[0].fixtures.length) alerts.push({ severity: 'warning', type: 'blank', playerId: player.id, message: `${player.name} has no fixture in the target gameweek.` });
    if (player.status === 'a' && player.weekly[0].xMins < 55) alerts.push({ severity: 'info', type: 'minutes', playerId: player.id, message: `${player.name} carries elevated minutes risk at ${player.weekly[0].xMins} xMins.` });
  });
  if (plans[0]?.netGain >= 6) alerts.push({ severity: 'opportunity', type: 'transfer', message: `${plans[0].transfers.map(move => `${move.out.name} to ${move.in.name}`).join(' and ')} projects a ${plans[0].netGain.toFixed(1)} net xPts gain.` });
  return alerts.slice(0, 12);
}

function buildBacktest(managerHistory) {
  const current = managerHistory.current || [];
  if (!current.length) return { status: 'collecting', sample: 0, message: 'Backtesting starts after completed gameweeks. Pre-deadline projection snapshots are required for leakage-free accuracy metrics.' };
  const scores = current.map(week => week.points || 0);
  const rolling = scores.map((score, index) => {
    const prior = scores.slice(Math.max(0, index - 5), index);
    return { actual: score, predicted: prior.length ? prior.reduce((sum, value) => sum + value, 0) / prior.length : score };
  }).slice(1);
  const mae = rolling.length ? rolling.reduce((sum, row) => sum + Math.abs(row.actual - row.predicted), 0) / rolling.length : 0;
  return { status: 'baseline', sample: rolling.length, mae: round(mae), message: 'Rolling-score baseline only. Versioned model snapshots will replace this baseline as new deadlines pass.' };
}

function buildRivalAnalysis(managerSquad, rivals, projectionMap) {
  const managerIds = new Set(managerSquad.map(player => player.id));
  const managerProjection = selectLineup(managerSquad, 'balanced').expectedPoints;
  return rivals.map(rival => {
    const squad = rival.picks.map(pick => projectionMap.get(pick.element)).filter(Boolean);
    const rivalIds = new Set(squad.map(player => player.id));
    const threats = squad.filter(player => !managerIds.has(player.id)).sort((a, b) => b.weekly[0].xPts - a.weekly[0].xPts).slice(0, 5);
    const differentials = managerSquad.filter(player => !rivalIds.has(player.id)).sort((a, b) => b.weekly[0].xPts - a.weekly[0].xPts).slice(0, 5);
    const projected = selectLineup(squad, 'balanced').expectedPoints;
    return { id: rival.id, name: rival.name, teamName: rival.teamName, rank: rival.rank, overlap: Math.round([...managerIds].filter(id => rivalIds.has(id)).length / 15 * 100), projectedPoints: projected, projectedSwing: round(managerProjection - projected), threats, differentials };
  });
}

function buildLiveAnalysis(picks, liveData, projectionMap, manager) {
  if (!liveData?.elements?.length) return { status: 'scheduled', message: 'Live rank analytics activate after the gameweek begins.' };
  const liveById = new Map(liveData.elements.map(element => [element.id, element.stats || {}]));
  const players = picks.picks.map(pick => {
    const projection = projectionMap.get(pick.element);
    const stats = liveById.get(pick.element) || {};
    const multiplier = Number(pick.multiplier || (pick.position <= 11 ? 1 : 0));
    const points = Number(stats.total_points || 0) * multiplier;
    const effectiveOwnership = round((projection?.ownership || 0) * (pick.is_captain ? 2 : 1));
    const rankImpact = round(points * (100 - effectiveOwnership) / 100, 2);
    return { id: pick.element, name: projection?.name || `Player ${pick.element}`, points, rawPoints: Number(stats.total_points || 0), multiplier, effectiveOwnership, rankImpact, minutes: Number(stats.minutes || 0), isCaptain: Boolean(pick.is_captain) };
  });
  const livePoints = players.reduce((sum, player) => sum + player.points, 0) - Number(picks.entry_history?.event_transfers_cost || 0);
  const eventPoints = Number(picks.entry_history?.points || 0);
  const overallPointsBefore = Math.max(0, Number(manager.summary_overall_points || 0) - eventPoints);
  const estimatedOverallPoints = overallPointsBefore + livePoints;
  const gainers = [...players].sort((a, b) => b.rankImpact - a.rankImpact).filter(player => player.rankImpact > 0).slice(0, 5);
  const threats = [...players].sort((a, b) => a.rankImpact - b.rankImpact).filter(player => player.rankImpact < 0).slice(0, 5);
  const captain = players.find(player => player.isCaptain);
  return {
    status: 'live',
    livePoints,
    estimatedOverallPoints,
    publishedRank: manager.summary_overall_rank || null,
    estimatedRankDirection: livePoints >= eventPoints ? 'up' : 'down',
    safetyDelta: round(livePoints - eventPoints),
    captainDamage: captain ? round(captain.rawPoints * Math.max(0, captain.effectiveOwnership - 100) / 100, 2) : 0,
    gainers,
    threats,
    players,
  };
}

async function buildDecisionCentre({ bootstrap, fixtures, manager, picks, history, rivals = [], liveData = null, options = {} }) {
  const strategy = normalizeStrategy(options.strategy);
  const currentGW = bootstrap.events?.find(e => e.is_current)?.id || bootstrap.events?.find(e => e.is_next)?.id || 1;
  const horizon = Number(options.horizon) || 5;
  const projectionData = await buildPlayerProjections({ bootstrap, fixtures, startGW: options.targetGW, horizon: options.horizon });
  const projectionMap = new Map(projectionData.projections.map(player => [player.id, player]));
  const squad = picks.picks.map(pick => ({ ...projectionMap.get(pick.element), pickPosition: pick.position, purchasePrice: pick.purchase_price ? pick.purchase_price / 10 : null, sellingPrice: pick.selling_price ? pick.selling_price / 10 : null })).filter(player => player.id);
  const bank = Number.isFinite(Number(options.bank)) ? Number(options.bank) : Number(picks.entry_history?.bank || 0) / 10;
  const freeTransfers = Math.max(1, Math.min(5, Number(options.freeTransfers) || 1));

  // Merge captaincy model scores into squad so captain selection uses the full
  // captaincy model (rotation risk, fixtures, set pieces, elite pool, H2H).
  try {
    const targetCaptaincyGW = options.targetGW || projectionData.startGW;
    const captaincyModel = await buildCaptaincyModel({ bootstrap, fixtures, selectedGW: targetCaptaincyGW });
    if (captaincyModel?.topPicks) {
      const captaincyMap = new Map(captaincyModel.topPicks.map(pick => [pick.id, pick.captaincyScore]));
      squad.forEach(player => {
        const capScore = captaincyMap.get(player.id);
        if (capScore) player.captaincyScore = capScore;
      });
    }
  } catch (e) { /* captaincy model failure is non-fatal — fall back to xPts */ }

  const lineup = selectLineup(squad, strategy);
  // Preserve FPL's actual bench arrangement (positions 12-15) rather than re-sorting by score
  const fplBench = squad.filter(p => p.pickPosition > 11).sort((a, b) => a.pickPosition - b.pickPosition);
  if (fplBench.length === lineup.bench.length) lineup.bench = fplBench;
  const transferPlans = buildTransferPlans({ squad, allPlayers: projectionData.projections, bank, freeTransfers, strategy, currentGW, horizon });
  const optimalSquad = buildOptimalSquad(projectionData.projections.filter(player => player.availability >= 50), Number(options.budget) || 100, strategy);
  const chips = buildChipPlan({ squad, gameweeks: projectionData.gameweeks, usedChips: (history.chips || []).map(chip => chip.name), strategy });
  const alerts = buildAlerts(squad, transferPlans);
  const rollValue = round(Math.max(0, (transferPlans[0]?.netGain || 0) < 2.5 ? 1.5 : 0));

  // Decision Lab enhanced analysis
  const labRollEvaluation = evaluateRollTransfer(squad, projectionData.projections, {
    freeTransfers, bank, horizon, currentGW,
  });

  // Player strength scores for all projected players
  const playerStrengths = new Map();
  for (const player of projectionData.projections) {
    const strength = computePlayerStrengthScore(player, { currentGW, horizon });
    const uncertainty = computeUncertainty(player);
    const minutes = computeMinutesProbability(player);
    const bayesian = bayesianBlend(player, currentGW);
    playerStrengths.set(player.id, { ...strength, uncertainty, minutes, bayesian });
  }

  // Pre-haul candidates and regression risks across the market
  const preHaulCandidates = detectPreHaulCandidates(projectionData.projections);
  const regressionRisks = detectRegressionRisks(projectionData.projections);

  // Squad-level opportunity cost
  const squadOpportunityCost = findBestMoveAcrossSquad(squad, projectionData.projections, {
    freeTransfers, bank, horizon, currentGW,
  });

  // Evidence weights for current gameweek
  const evidenceWeights = earlySeasonWeights(currentGW);

  // Enhanced transfer plans with full Decision Lab analysis
  const enhancedTransferPlans = transferPlans.slice(0, 6).map(plan => {
    const outPlayer = plan.transfers[0]?.out;
    const inPlayer = plan.transfers[0]?.in;
    if (!outPlayer || !inPlayer) return plan;
    const labAnalysis = analyzeTransfer(outPlayer, inPlayer, { currentGW, horizon, freeTransfers });
    return { ...plan, labAnalysis };
  });

  return {
    meta: { schemaVersion: '2.0', modelVersion: 'Decision Lab Engine 2.0', generatedAt: new Date().toISOString(), strategy, targetGW: projectionData.startGW, gameweeks: projectionData.gameweeks, currentGW, horizon, evidenceWeights, warnings: ['Public FPL data reflects the latest published deadline. Pending transfers and exact free-transfer state require manual overrides.', 'Projection ranges are scenario bands, not betting-market probabilities.', 'Decision scores are model estimates, not guarantees. Football is inherently stochastic.'] },
    manager: { id: manager.id, name: `${manager.player_first_name} ${manager.player_last_name}`.trim(), teamName: manager.name, rank: manager.summary_overall_rank || null, points: manager.summary_overall_points || 0, bank, squadValue: round(squad.reduce((sum, player) => sum + player.cost, 0)), freeTransfers, chipsUsed: (history.chips || []).map(chip => chip.name) },
    squad,
    lineup,
    decisions: [
      { type: 'transfer', priority: transferPlans[0]?.netGain >= 4 ? 'high' : 'medium', title: transferPlans[0] ? transferPlans[0].transfers.map(move => `${move.out.name} to ${move.in.name}`).join(', ') : 'Roll the transfer', expectedGain: transferPlans[0]?.netGain || rollValue, reason: transferPlans[0]?.rationale || 'No available move clears the model threshold.' },
      { type: 'captain', priority: 'high', title: `Captain ${lineup.captain?.name || '--'}`, expectedGain: lineup.captain?.weekly[0].xPts || 0, reason: `${lineup.captain?.weekly[0].xPts.toFixed(1) || '0.0'} xPts with a ${lineup.captain?.range.low.toFixed(1) || '0.0'}-${lineup.captain?.range.high.toFixed(1) || '0.0'} horizon range.` },
      { type: 'lineup', priority: 'medium', title: `${lineup.expectedPoints.toFixed(1)} projected GW points`, expectedGain: 0, reason: `Best legal XI with ${lineup.bench.map(player => player.name).join(', ') || 'no bench'} benched.` },
    ],
    transfers: { rollValue, plans: transferPlans, optimalSquad, rollEvaluation: labRollEvaluation, topTransferAnalyses: enhancedTransferPlans },
    decisionLab: {
      squadOpportunityCost,
      preHaulCandidates: preHaulCandidates.map(c => ({ name: c.player.name, team: c.player.team, position: c.player.position, xGI90: c.xGI90, form: c.form, ownership: c.ownership, signal: c.signal })),
      regressionRisks: regressionRisks.map(r => ({ name: r.player.name, team: r.player.team, position: r.player.position, status: r.status, signal: r.signal, explanation: r.explanation, ownership: r.ownership })),
      playerStrengths: Array.from(playerStrengths.entries()).map(([id, data]) => ({ id, ...data })).slice(0, 60),
      evidenceWeights,
      // New Decision Lab product features
      squadHeatmap: buildSquadHeatmap(squad, projectionData.projections, { currentGW, horizon }),
      decisionTriggers: buildDecisionTriggers(squad),
      yourDecision: generateYourDecisionBrief(squad, projectionData.projections, { currentGW, horizon, freeTransfers, bank }),
      chipStrategy: optimizeChips(squad, projectionData.projections, { currentGW, horizon: 8, usedChips: (history.chips || []).map(c => c.name) }),
      // Mode support: analyzeTransfer / findBestTransfer / optimizeTeam
      mode: options.mode || 'optimizeTeam',
      transferAnalysis: options.mode === 'analyzeTransfer' && options.transferIn && options.transferOut
        ? analyzeTransferMode(options.transferOut, options.transferIn, squad, projectionData.projections, { currentGW, horizon, freeTransfers })
        : null,
      bestTransferSearch: options.mode === 'findBestTransfer'
        ? findBestTransferMode(squad, projectionData.projections, { currentGW, horizon, freeTransfers, bank })
        : null,
    },
    chips,
    rivals: buildRivalAnalysis(squad, rivals, projectionMap),
    live: buildLiveAnalysis(picks, liveData, projectionMap, manager),
    alerts,
    comparisonPool: projectionData.projections.slice(0, 80),
    backtest: buildBacktest(history),
  };
}

async function buildSquadAdvice({ bootstrap, fixtures, playerIds, options = {} }) {
  const strategy = normalizeStrategy(options.strategy);
  const projectionData = await buildPlayerProjections({ bootstrap, fixtures, startGW: options.targetGW, horizon: options.horizon });
  const projectionMap = new Map(projectionData.projections.map(player => [player.id, player]));
  const squad = [...new Set((playerIds || []).map(Number))].map(id => projectionMap.get(id)).filter(Boolean);
  if (!squad.length) throw new Error('Add players before running the squad review');

  // Merge captaincy model scores into squad so captain selection uses the full
  // captaincy model (rotation risk, fixtures, set pieces, elite pool, H2H).
  if (squad.length === 15) {
    try {
      const targetCaptaincyGW = options.targetGW || projectionData.startGW;
      const captaincyModel = await buildCaptaincyModel({ bootstrap, fixtures, selectedGW: targetCaptaincyGW });
      if (captaincyModel?.topPicks) {
        const captaincyMap = new Map(captaincyModel.topPicks.map(pick => [pick.id, pick.captaincyScore]));
        squad.forEach(player => {
          const capScore = captaincyMap.get(player.id);
          if (capScore) player.captaincyScore = capScore;
        });
      }
    } catch (e) { /* captaincy model failure is non-fatal — fall back to xPts */ }
  }

  const legal = validSquad(squad);
  const squadCost = round(squad.reduce((sum, player) => sum + player.cost, 0));
  const bank = round(Math.max(0, Number.isFinite(Number(options.bank)) ? Number(options.bank) : 100 - squadCost));
  const freeTransfers = Math.max(1, Math.min(5, Number(options.freeTransfers) || 1));
  const lineup = squad.length === 15 ? selectLineup(squad, strategy) : null;
  const transferPlans = squad.length === 15
    ? buildTransferPlans({ squad, allPlayers: projectionData.projections, bank, freeTransfers, strategy })
    : [];
  const chips = squad.length === 15
    ? buildChipPlan({ squad, gameweeks: projectionData.gameweeks, usedChips: options.usedChips || [], strategy })
    : { weeks: [], recommendations: [] };
  const bestReplacementByPlayer = new Map();
  transferPlans.forEach(plan => {
    if (plan.transfers.length !== 1) return;
    const move = plan.transfers[0];
    if (!bestReplacementByPlayer.has(move.out.id)) bestReplacementByPlayer.set(move.out.id, { ...move.in, netGain: plan.netGain, horizonGain: plan.horizonGain, nextGain: plan.nextGain, hitCost: plan.hitCost, risk: plan.risk });
  });

  const rankedWithinPosition = Object.fromEntries(['GKP', 'DEF', 'MID', 'FWD'].map(position => [position,
    projectionData.projections.filter(player => player.position === position).sort((a, b) => adjustedScore(b, strategy) - adjustedScore(a, strategy))
  ]));
  const currentGW = bootstrap.events?.find(e => e.is_current)?.id || bootstrap.events?.find(e => e.is_next)?.id || 1;
  const horizon = Number(options.horizon) || projectionData.horizon;
  const critiques = squad.map(player => {
    const replacement = bestReplacementByPlayer.get(player.id) || null;
    const positionPool = rankedWithinPosition[player.position];
    const percentile = Math.round((1 - Math.max(0, positionPool.findIndex(item => item.id === player.id)) / Math.max(positionPool.length - 1, 1)) * 100);
    const riskReasons = [];
    if (player.availability < 75) riskReasons.push(`${player.availability}% availability${player.news ? `: ${player.news}` : ''}`);
    if ((player.weekly[0]?.xMins || 0) < 60) riskReasons.push(`${player.weekly[0]?.xMins || 0} expected minutes next GW`);
    if (!player.weekly[0]?.fixtures?.length) riskReasons.push('blank next gameweek');
    const weakProjection = player.totalXpts < projectionData.horizon * 2.6;
    const transferCase = replacement && replacement.netGain >= (replacement.hitCost ? 4.5 : 2.5);
    const verdict = riskReasons.length && transferCase ? 'Sell' : transferCase ? 'Consider replacing' : weakProjection ? 'Monitor' : 'Keep';
    const reasons = [];
    reasons.push(`${player.totalXpts.toFixed(1)} xPts over ${projectionData.horizon} GWs (${player.range.low.toFixed(1)}-${player.range.high.toFixed(1)} range)`);
    reasons.push(`${player.xPtsPerMillion.toFixed(2)} xPts/£m and ${percentile}th position percentile`);
    reasons.push(...riskReasons);
    if (replacement) reasons.push(`${replacement.name} projects ${replacement.horizonGain.toFixed(1)} more horizon xPts${replacement.hitCost ? ` before a -${replacement.hitCost} hit` : ''}`);
    // Decision Lab enhanced critique
    const labStrength = computePlayerStrengthScore(player, { currentGW, horizon });
    const labUncertainty = computeUncertainty(player);
    const labMinutes = computeMinutesProbability(player);
    const labRegression = detectRegression(player);
    return {
      player,
      verdict,
      priority: verdict === 'Sell' ? 'high' : verdict === 'Consider replacing' ? 'medium' : verdict === 'Monitor' ? 'watch' : 'keep',
      percentile,
      reasons,
      replacement,
      // Decision Lab fields
      strengthScore: labStrength.score,
      strengthComponents: labStrength.components,
      uncertaintyTier: labUncertainty.tier,
      uncertainty: labUncertainty.uncertainty,
      roleSecurity: labMinutes.roleSecurity,
      roleSecurityScore: labMinutes.roleSecurityScore,
      startProbability: labMinutes.startProbability,
      regression: labRegression,
    };
  }).sort((a, b) => ({ high: 0, medium: 1, watch: 2, keep: 3 }[a.priority] - { high: 0, medium: 1, watch: 2, keep: 3 }[b.priority]) || a.player.totalXpts - b.player.totalXpts);

  const topPlan = transferPlans[0] || null;
  const urgentPlayers = critiques.filter(item => ['Sell', 'Consider replacing'].includes(item.verdict)).length;
  const wildcard = chips.recommendations.find(item => item.chip === 'Wildcard');
  const chipRecommendations = chips.recommendations.map(item => {
    let confidence = item.confidence;
    let recommendation = confidence === 'Wait' ? 'Hold' : 'Consider';
    if (item.chip === 'Wildcard') {
      const shouldUse = urgentPlayers >= 4 && item.expectedGain >= 7;
      confidence = shouldUse ? confidence : 'Wait';
      recommendation = shouldUse ? 'Consider' : 'Hold';
    }
    if (item.chip === 'Bench Boost' && item.expectedGain < 14) { confidence = 'Wait'; recommendation = 'Hold'; }
    if (item.chip === 'Triple Captain' && item.expectedGain < 7.5) { confidence = 'Wait'; recommendation = 'Hold'; }
    if (item.chip === 'Free Hit' && item.expectedGain < 8) { confidence = 'Wait'; recommendation = 'Hold'; }
    return { ...item, confidence, recommendation };
  });

  const headline = !legal
    ? `Complete a legal 15-player squad before acting on transfer or chip advice.`
    : topPlan?.netGain >= 4
      ? `${topPlan.transfers.map(move => `${move.out.name} to ${move.in.name}`).join(' and ')} is the strongest modeled move at +${topPlan.netGain.toFixed(1)} net xPts.`
      : `The model prefers patience: no transfer clears a strong hit-adjusted threshold.`;

  // Decision Lab squad-level insights
  const evidenceWeights = earlySeasonWeights(currentGW);
  const labRollEvaluation = squad.length === 15 ? evaluateRollTransfer(squad, projectionData.projections, {
    freeTransfers, bank, horizon, currentGW,
  }) : null;
  const preHaulCandidates = detectPreHaulCandidates(projectionData.projections).slice(0, 5);
  const regressionRisks = detectRegressionRisks(projectionData.projections).slice(0, 5);

  return {
    meta: { modelVersion: 'Squad Advisor 2.0', generatedAt: new Date().toISOString(), strategy, gameweeks: projectionData.gameweeks, currentGW, horizon, evidenceWeights, warnings: ['Projections are uncertain, especially before stable minutes and role data exist.', 'Confirm prices, free transfers, bank and chip availability before acting.', 'Decision scores are model estimates, not guarantees.'] },
    summary: { legal, squadCost, bank, headline, urgentPlayers, horizonXpts: round(squad.reduce((sum, player) => sum + player.totalXpts, 0)) },
    squad,
    lineup,
    critiques,
    transfers: { rollRecommended: !topPlan || topPlan.netGain < 2.5, plans: transferPlans.slice(0, 8), rollEvaluation: labRollEvaluation },
    chips: { ...chips, recommendations: chipRecommendations, wildcardPressure: wildcard?.expectedGain || 0 },
    alerts: squad.length === 15 ? buildAlerts(squad, transferPlans) : [],
    decisionLab: {
      preHaulCandidates: preHaulCandidates.map(c => ({ name: c.player.name, team: c.player.team, position: c.player.position, xGI90: c.xGI90, form: c.form, ownership: c.ownership, signal: c.signal })),
      regressionRisks: regressionRisks.map(r => ({ name: r.player.name, team: r.player.team, position: r.player.position, status: r.status, signal: r.signal, explanation: r.explanation, ownership: r.ownership })),
      evidenceWeights,
      // Squad heatmap and triggers
      squadHeatmap: squad.length === 15 ? buildSquadHeatmap(squad, projectionData.projections, { currentGW, horizon }) : [],
      decisionTriggers: squad.length === 15 ? buildDecisionTriggers(squad) : [],
      yourDecision: squad.length === 15 ? generateYourDecisionBrief(squad, projectionData.projections, { currentGW, horizon, freeTransfers, bank }) : null,
      chipStrategy: optimizeChips(squad, projectionData.projections, { currentGW, horizon: 8, usedChips: options.usedChips || [] }),
    },
  };
}

module.exports = { buildDecisionCentre, buildSquadAdvice, selectLineup, validSquad };
