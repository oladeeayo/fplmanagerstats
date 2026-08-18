// src/server/squadOptimizer.js
// MILP-inspired squad optimizer using constraint satisfaction with beam search
// Replaces the greedy heuristic with a near-optimal solver

const VALID_FORMATIONS = [
  { DEF: 3, MID: 4, FWD: 3, label: '3-4-3' },
  { DEF: 3, MID: 5, FWD: 2, label: '3-5-2' },
  { DEF: 4, MID: 3, FWD: 3, label: '4-3-3' },
  { DEF: 4, MID: 4, FWD: 2, label: '4-4-2' },
  { DEF: 4, MID: 5, FWD: 1, label: '4-5-1' },
  { DEF: 5, MID: 3, FWD: 2, label: '5-3-2' },
  { DEF: 5, MID: 4, FWD: 1, label: '5-4-1' },
];

const POSITION_QUOTAS = { GKP: 2, DEF: 5, MID: 5, FWD: 3 };
const SQUAD_SIZE = 15;
const XI_SIZE = 11;
const MAX_PER_TEAM = 3;
const BUDGET = 100.0;

// Score a player for squad selection (hybrid of xPts, form, fixtures, and value)
function scorePlayer(player, options = {}) {
  const xPts = Number(player.totalXpts || player.xPts || 0);
  const cost = Number(player.cost || 4.0);
  const form = Number(player.form || player.ppg || 0);
  const ownership = Number(player.ownership || 0);
  const availability = Number(player.availability || 100);
  const xMins = Number(player.xMinsPerFixture || player.xMins || 75);

  // Base score: xPts with minutes adjustment
  let score = xPts * (xMins / 90);

  // Value bonus (xPts per million)
  score += (xPts / Math.max(cost, 3.5)) * 2;

  // Availability penalty
  if (availability < 75) score *= 0.5;
  else if (availability < 90) score *= 0.8;

  // Form bonus (last 5 GWs)
  if (form > 0) score += form * 0.3;

  // Template bonus (for non-differential mode)
  if (options.templateStyle === 'template') {
    score += (ownership / 100) * 3;
  } else if (options.templateStyle === 'differential') {
    if (ownership > 15) score *= 0.3;
  }

  // Set piece taker bonus
  if (player.roles && player.roles.length > 0) {
    score += 0.5;
  }

  return Math.max(0.1, score);
}

// Evaluate a starting XI formation
function evaluateFormation(starters, formation) {
  const gk = starters.filter(p => p.position === 'GKP')[0];
  const defs = starters.filter(p => p.position === 'DEF').slice(0, formation.DEF);
  const mids = starters.filter(p => p.position === 'MID').slice(0, formation.MID);
  const fwds = starters.filter(p => p.position === 'FWD').slice(0, formation.FWD);

  if (!gk || defs.length < formation.DEF || mids.length < formation.MID || fwds.length < formation.FWD) {
    return { score: -Infinity, starters: [], bench: [] };
  }

  const xi = [gk, ...defs, ...mids, ...fwds];
  const score = xi.reduce((sum, p) => sum + scorePlayer(p), 0);

  return {
    score,
    formation: formation.label,
    starters: xi,
    gk, defs, mids, fwds,
  };
}

// Find optimal lineup from a 15-player squad
function findOptimalLineup(squad) {
  if (squad.length !== SQUAD_SIZE) return null;

  const byPos = {
    GKP: squad.filter(p => p.position === 'GKP').sort((a, b) => scorePlayer(b) - scorePlayer(a)),
    DEF: squad.filter(p => p.position === 'DEF').sort((a, b) => scorePlayer(b) - scorePlayer(a)),
    MID: squad.filter(p => p.position === 'MID').sort((a, b) => scorePlayer(b) - scorePlayer(a)),
    FWD: squad.filter(p => p.position === 'FWD').sort((a, b) => scorePlayer(b) - scorePlayer(a)),
  };

  let best = { score: -Infinity };
  for (const formation of VALID_FORMATIONS) {
    const gk = byPos.GKP[0];
    if (!gk) continue;
    const defs = byPos.DEF.slice(0, formation.DEF);
    const mids = byPos.MID.slice(0, formation.MID);
    const fwds = byPos.FWD.slice(0, formation.FWD);
    if (defs.length < formation.DEF || mids.length < formation.MID || fwds.length < formation.FWD) continue;

    const xi = [gk, ...defs, ...mids, ...fwds];
    const score = xi.reduce((sum, p) => sum + scorePlayer(p), 0);
    if (score > best.score) {
      const xiIds = new Set(xi.map(p => p.id));
      best = {
        score,
        formation: formation.label,
        starters: xi,
        bench: squad.filter(p => !xiIds.has(p.id)).sort((a, b) => scorePlayer(b) - scorePlayer(a)),
        captain: xi.filter(p => p.position !== 'GKP').sort((a, b) => scorePlayer(b) - scorePlayer(a))[0] || xi[0],
      };
    }
  }
  return best.score > -Infinity ? best : null;
}

// Build optimal squad using beam search (near-MILP quality)
function buildOptimalSquad(allPlayers, options = {}) {
  const budget = options.budget || BUDGET;
  const teamLimit = options.maxPerTeam || MAX_PER_TEAM;

  // Pre-filter: remove unavailable and sort by score
  const available = allPlayers
    .filter(p => (p.availability || 100) >= 25)
    .map(p => ({ ...p, _score: scorePlayer(p, options) }))
    .sort((a, b) => b._score - a._score);

  // Group by position
  const byPos = { GKP: [], DEF: [], MID: [], FWD: [] };
  available.forEach(p => { byPos[p.position]?.push(p); });

  // Beam search: try multiple squad configurations
  const BEAM_WIDTH = 50;
  let beams = [[]]; // Each beam is an array of selected player IDs

  for (const [pos, count] of Object.entries(POSITION_QUOTAS)) {
    const candidates = byPos[pos] || [];
    const newBeams = [];

    for (const beam of beams) {
      const selected = beam.map(id => available.find(p => p.id === id)).filter(Boolean);
      const teamCounts = {};
      selected.forEach(p => {
        const team = String(p.team || p.teamId || '').toUpperCase();
        teamCounts[team] = (teamCounts[team] || 0) + 1;
      });
      const spent = selected.reduce((s, p) => s + (p.cost || 4), 0);

      // Filter candidates for this position
      const validCandidates = candidates.filter(p => {
        if (beam.includes(p.id)) return false;
        const team = String(p.team || p.teamId || '').toUpperCase();
        if ((teamCounts[team] || 0) >= teamLimit) return false;
        const remainingMinCost = estimateRemainingCost(pos, count - 1, selected, byPos);
        if (spent + p.cost + remainingMinCost > budget + 0.01) return false;
        return true;
      });

      // Take top candidates
      const topCandidates = validCandidates.slice(0, Math.ceil(BEAM_WIDTH / beams.length) + 2);

      if (topCandidates.length === 0 && count > 0) {
        // Try with a cheaper player
        const cheapest = candidates
          .filter(p => !beam.includes(p.id))
          .sort((a, b) => (a.cost || 4) - (b.cost || 4))[0];
        if (cheapest) topCandidates.push(cheapest);
      }

      for (const p of topCandidates) {
        newBeams.push([...beam, p.id]);
      }
    }

    // Keep top beams by score
    beams = newBeams
      .map(beam => ({
        ids: beam,
        score: beam.reduce((s, id) => s + (available.find(p => p.id === id)?._score || 0), 0),
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, BEAM_WIDTH)
      .map(b => b.ids);
  }

  // Find best valid squad
  let bestSquad = null;
  let bestScore = -Infinity;

  for (const beam of beams) {
    const squad = beam.map(id => available.find(p => p.id === id)).filter(Boolean);
    if (squad.length !== SQUAD_SIZE) continue;

    // Validate
    const posCounts = {};
    const teamCounts = {};
    let valid = true;
    for (const p of squad) {
      posCounts[p.position] = (posCounts[p.position] || 0) + 1;
      const team = String(p.team || p.teamId || '').toUpperCase();
      teamCounts[team] = (teamCounts[team] || 0) + 1;
    }
    for (const [pos, count] of Object.entries(POSITION_QUOTAS)) {
      if ((posCounts[pos] || 0) !== count) { valid = false; break; }
    }
    if (valid) {
      for (const count of Object.values(teamCounts)) {
        if (count > teamLimit) { valid = false; break; }
      }
    }
    const totalCost = squad.reduce((s, p) => s + (p.cost || 4), 0);
    if (totalCost > budget + 0.01) valid = false;
    if (!valid) continue;

    const score = squad.reduce((s, p) => s + scorePlayer(p, options), 0);
    if (score > bestScore) {
      bestScore = score;
      bestSquad = squad;
    }
  }

  if (!bestSquad) return { squad: [], lineup: null, totalCost: 0, totalScore: 0 };

  const lineup = findOptimalLineup(bestSquad);
  return {
    squad: bestSquad,
    lineup,
    totalCost: Math.round(bestSquad.reduce((s, p) => s + (p.cost || 4), 0) * 10) / 10,
    totalScore: Math.round(bestScore * 10) / 10,
  };
}

function estimateRemainingCost(currentPos, slotsNeeded, selected, byPos) {
  if (slotsNeeded <= 0) return 0;
  const positions = Object.keys(POSITION_QUOTAS);
  let remaining = 0;
  for (const pos of positions) {
    if (pos === currentPos) {
      remaining += slotsNeeded * 4.0; // rough minimum
    } else {
      const needed = (POSITION_QUOTAS[pos] || 0) - selected.filter(p => p.position === pos).length;
      if (needed > 0) {
        const cheapest = (byPos[pos] || []).sort((a, b) => (a.cost || 4) - (b.cost || 4))[0];
        remaining += needed * Math.min(cheapest?.cost || 4, 4.5);
      }
    }
  }
  return remaining;
}

// Transfer optimization: find best transfers for existing squad
function findOptimalTransfers(currentSquad, allPlayers, options = {}) {
  const budget = options.budget || 0;
  const freeTransfers = options.freeTransfers || 1;
  const horizon = options.horizon || 5;
  const squadIds = new Set(currentSquad.map(p => p.id));

  const candidates = allPlayers
    .filter(p => !squadIds.has(p.id) && (p.availability || 100) >= 50)
    .map(p => ({ ...p, _score: scorePlayer(p, options) }))
    .sort((a, b) => b._score - a._score);

  const plans = [];

  // Evaluate single transfers
  for (const outgoing of currentSquad.sort((a, b) => scorePlayer(a) - scorePlayer(b))) {
    const incoming = candidates
      .filter(p => p.position === outgoing.position)
      .filter(p => {
        const sellPrice = outgoing.sellingPrice || outgoing.cost || 4;
        return p.cost <= sellPrice + budget;
      })
      .filter(p => {
        const teamCount = currentSquad.filter(s => s.id !== outgoing.id && (s.team || s.teamId) === (p.team || p.teamId)).length;
        return teamCount < MAX_PER_TEAM;
      })[0];

    if (!incoming) continue;

    const outgoingScore = scorePlayer(outgoing);
    const incomingScore = scorePlayer(incoming);
    const gain = incomingScore - outgoingScore;
    const hitCost = freeTransfers > 0 ? 0 : 4;
    const netGain = gain - hitCost;

    if (netGain > 0) {
      plans.push({
        transfers: [{ out: outgoing, in: incoming }],
        netGain,
        gain,
        hitCost,
        risk: incoming.confidence === 'High' ? 'Low' : incoming.availability < 75 ? 'High' : 'Medium',
        rationale: `${incoming.name} adds ${netGain.toFixed(1)} net xPts over ${outgoing.name} across ${horizon} GWs.`,
      });
    }
  }

  // Evaluate double transfers (top pairs)
  const topSingles = plans.slice(0, 8);
  for (let i = 0; i < topSingles.length; i++) {
    for (let j = i + 1; j < topSingles.length; j++) {
      const t1 = topSingles[i].transfers[0];
      const t2 = topSingles[j].transfers[0];
      if (t1.out.id === t2.out.id || t1.in.id === t2.in.id) continue;

      const newSquad = currentSquad
        .filter(p => p.id !== t1.out.id && p.id !== t2.out.id)
        .concat([t1.in, t2.in]);

      if (newSquad.length !== SQUAD_SIZE) continue;

      // Validate
      const posCounts = {};
      const teamCounts = {};
      let valid = true;
      for (const p of newSquad) {
        posCounts[p.position] = (posCounts[p.position] || 0) + 1;
        const team = String(p.team || p.teamId || '').toUpperCase();
        teamCounts[team] = (teamCounts[team] || 0) + 1;
      }
      for (const [pos, count] of Object.entries(POSITION_QUOTAS)) {
        if ((posCounts[pos] || 0) !== count) { valid = false; break; }
      }
      if (valid) {
        for (const count of Object.values(teamCounts)) {
          if (count > MAX_PER_TEAM) { valid = false; break; }
        }
      }
      if (!valid) continue;

      const hitCost = Math.max(0, 2 - freeTransfers) * 4;
      const netGain = topSingles[i].gain + topSingles[j].gain - hitCost;
      if (netGain > 0) {
        plans.push({
          transfers: [t1, t2],
          netGain,
          gain: topSingles[i].gain + topSingles[j].gain,
          hitCost,
          risk: [topSingles[i].risk, topSingles[j].risk].includes('High') ? 'High' : 'Medium',
          rationale: `Paired move adds ${netGain.toFixed(1)} hit-adjusted xPts.`,
        });
      }
    }
  }

  return plans.sort((a, b) => b.netGain - a.netGain).slice(0, 15);
}

module.exports = {
  VALID_FORMATIONS,
  POSITION_QUOTAS,
  scorePlayer,
  findOptimalLineup,
  buildOptimalSquad,
  findOptimalTransfers,
};
