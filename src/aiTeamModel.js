const VALID_FORMATIONS = [
  { DEF: 3, MID: 4, FWD: 3 },
  { DEF: 3, MID: 5, FWD: 2 },
  { DEF: 4, MID: 3, FWD: 3 },
  { DEF: 4, MID: 4, FWD: 2 },
  { DEF: 4, MID: 5, FWD: 1 },
  { DEF: 5, MID: 3, FWD: 2 },
  { DEF: 5, MID: 4, FWD: 1 },
];

function round(value, precision = 1) {
  const multiplier = 10 ** precision;
  return Math.round(value * multiplier) / multiplier;
}

function nextGameweekScore(player) {
  return Number(player?.weekly?.[0]?.xPts) || Number(player?.xPts) || 0;
}

function horizonScore(player) {
  if (Array.isArray(player?.weekly) && player.weekly.length) {
    return player.weekly.reduce((sum, week, index) => sum + (Number(week?.xPts) || 0) * (0.9 ** index), 0);
  }
  return Number(player?.xPts) || 0;
}

function selectCaptainAndVice(squad, scorePlayer) {
  const scoreFn = typeof scorePlayer === 'function' ? scorePlayer : nextGameweekScore;
  const candidates = [...squad].sort((a, b) => {
    const scoreDiff = scoreFn(b) - scoreFn(a);
    if (Math.abs(scoreDiff) > 0.01) return scoreDiff;
    const minsA = Number(a.weekly?.[0]?.xMins || a.xMins || 75);
    const minsB = Number(b.weekly?.[0]?.xMins || b.xMins || 75);
    if (minsA !== minsB) return minsB - minsA;
    // Prefer outfield players over GKP for captaincy unless GKP score is significantly higher
    const isGkpA = a.position === 'GKP';
    const isGkpB = b.position === 'GKP';
    if (isGkpA !== isGkpB) return isGkpA ? 1 : -1;
    return String(a.name || '').localeCompare(String(b.name || ''));
  });

  const captain = candidates[0] || null;
  const viceCaptain = candidates.find(p => p.id !== captain?.id) || candidates[1] || null;
  return { captain, viceCaptain };
}

function selectOptimalLineup(squad, scorePlayer) {
  if (!Array.isArray(squad) || squad.length !== 15) throw new Error('A legal 15-player squad is required');

  const lineupScore = typeof scorePlayer === 'function'
    ? scorePlayer
    : player => Number(player.weekly?.[0]?.xPts) || Number(player.xPts) || 0;

  const byPosition = position => squad.filter(player => player.position === position).sort((a, b) => lineupScore(b) - lineupScore(a));
  const goalkeepers = byPosition('GKP');
  const defenders = byPosition('DEF');
  const midfielders = byPosition('MID');
  const forwards = byPosition('FWD');
  if (goalkeepers.length !== 2 || defenders.length !== 5 || midfielders.length !== 5 || forwards.length !== 3) throw new Error('Squad position quotas are invalid');

  const evaluations = VALID_FORMATIONS.map(formation => {
    const starters = [
      goalkeepers[0],
      ...defenders.slice(0, formation.DEF),
      ...midfielders.slice(0, formation.MID),
      ...forwards.slice(0, formation.FWD),
    ];
    return {
      formation: `${formation.DEF}-${formation.MID}-${formation.FWD}`,
      shape: formation,
      score: round(starters.reduce((sum, player) => sum + lineupScore(player), 0), 3),
      starters,
    };
  }).sort((a, b) => b.score - a.score || a.formation.localeCompare(b.formation));

  const best = evaluations[0];
  const starterIds = new Set(best.starters.map(player => player.id));
  const bench = squad
    .filter(player => !starterIds.has(player.id))
    .sort((a, b) => {
      if ((a.position === 'GKP') !== (b.position === 'GKP')) return a.position === 'GKP' ? 1 : -1;
      return lineupScore(b) - lineupScore(a);
    });

  const { captain, viceCaptain } = selectCaptainAndVice(best.starters, lineupScore);

  return {
    formation: best.formation,
    starters: best.starters,
    bench,
    captain,
    viceCaptain,
    audit: {
      formationOptimal: true,
      formationsEvaluated: evaluations.map(item => ({ formation: item.formation, score: item.score })),
      chosenScore: best.score,
      nextBestScore: evaluations[1]?.score || best.score,
      advantage: round(best.score - (evaluations[1]?.score || best.score), 3),
      captainId: captain?.id || null,
      viceCaptainId: viceCaptain?.id || null,
    },
  };
}

function hasEconomicalReserveGoalkeeper(squad, reserveCeilingTenths) {
  const goalkeeperCosts = (squad || [])
    .filter(player => player.position === 'GKP')
    .map(player => Math.round(Number(player.cost || player.costValue || 0) * 10))
    .sort((a, b) => a - b);
  return goalkeeperCosts.length === 2 && goalkeeperCosts[0] <= reserveCeilingTenths;
}

function scorePlayerForSquad(player, constraints = {}) {
  let score = horizonScore(player);
  if (constraints.optimizationMetric === 'form') {
    const formVal = Number(player.form) || Number(player.weekly?.[0]?.form) || 0;
    if (formVal > 0) score = score * 0.5 + formVal * 1.2;
  }

  if (constraints.prioritizeSetPieces && (player.isSetPieceTaker || player.isPenTaker || player.cornersTaker || player.penaltiesTaker)) {
    score *= 1.15;
  }

  if (constraints.preferGoodFixtures) {
    const fdr = Number(player.fdr || player.fixtureDifficulty || player.weekly?.[0]?.fdr || 3);
    if (fdr <= 2) score *= 1.15;
    else if (fdr >= 4) score *= 0.85;
  }

  if (constraints.structurePreference === 'big_at_back' && player.position === 'DEF') score *= 1.2;
  if (constraints.structurePreference === 'heavy_mid' && player.position === 'MID') score *= 1.2;
  if (constraints.structurePreference === 'heavy_fwd' && player.position === 'FWD') score *= 1.2;

  const ownership = Number(player.ownership || player.selected_by_percent || 0);
  if (constraints.templateStyle === 'template') {
    score += (ownership / 100) * 2;
  } else if (constraints.templateStyle === 'differential' && ownership > 15) {
    score *= 0.2;
  } else if (constraints.templateStyle === 'ultra_differential' && ownership > 7) {
    score *= 0.1;
  }

  return Math.max(0.1, round(score, 2));
}

function buildOptimalSquadFromConstraints(allPlayers, constraints = {}) {
  const budget = Number(constraints.budget) || 100.0;
  const mustIncludeIds = new Set(constraints.mustInclude || []);
  const mustExcludeIds = new Set(constraints.mustExclude || []);
  const teamExclude = new Set((constraints.teamExclude || []).map(t => String(t).toUpperCase()));
  const teamIncludeMin = constraints.teamIncludeMin || {};
  const teamIncludeMax = constraints.teamIncludeMax || {};

  let pool = (allPlayers || []).filter(player => {
    if (mustExcludeIds.has(player.id)) return false;
    const teamCode = (player.team || player.teamCode || '').toUpperCase();
    if (teamExclude.has(teamCode)) return false;
    if (constraints.avoidInjured && (player.status === 'i' || player.status === 'u' || (player.availability != null && player.availability < 75))) return false;
    const pos = player.position;
    if (constraints.priceMax?.[pos] && player.cost > constraints.priceMax[pos]) return false;
    if (constraints.priceMin?.[pos] && player.cost < constraints.priceMin[pos]) return false;
    if (constraints.playerPriceMax?.[player.id] && player.cost > constraints.playerPriceMax[player.id]) return false;
    if (constraints.playerPriceMin?.[player.id] && player.cost < constraints.playerPriceMin[player.id]) return false;
    return true;
  });

  const positionQuotas = { GKP: 2, DEF: 5, MID: 5, FWD: 3 };
  const selected = [];
  const selectedIds = new Set();
  const teamCounts = {};

  const addPlayer = player => {
    selected.push(player);
    selectedIds.add(player.id);
    const teamCode = (player.team || player.teamCode || '').toUpperCase();
    teamCounts[teamCode] = (teamCounts[teamCode] || 0) + 1;
  };

  for (const player of allPlayers || []) {
    if (mustIncludeIds.has(player.id) && !selectedIds.has(player.id)) {
      addPlayer(player);
    }
  }

  pool = pool.filter(p => !selectedIds.has(p.id));
  pool.sort((a, b) => {
    const scoreA = scorePlayerForSquad(a, constraints) / Math.max(a.cost || 4, 3.8);
    const scoreB = scorePlayerForSquad(b, constraints) / Math.max(b.cost || 4, 3.8);
    return scoreB - scoreA;
  });

  for (const [pos, quota] of Object.entries(positionQuotas)) {
    const currentPosCount = selected.filter(p => p.position === pos).length;
    const needed = quota - currentPosCount;

    if (needed > 0) {
      const candidates = pool.filter(player => {
        if (player.position !== pos) return false;
        const teamCode = (player.team || player.teamCode || '').toUpperCase();
        if ((teamCounts[teamCode] || 0) >= (teamIncludeMax[teamCode] ?? 3)) return false;
        return true;
      });

      for (let i = 0; i < needed && i < candidates.length; i++) {
        addPlayer(candidates[i]);
      }
    }
  }

  for (const [teamCode, minCount] of Object.entries(teamIncludeMin)) {
    const codeUpper = teamCode.toUpperCase();
    const currentCount = teamCounts[codeUpper] || 0;
    if (currentCount < minCount) {
      const needed = minCount - currentCount;
      let addedForTeam = 0;
      for (const player of pool) {
        if (selectedIds.has(player.id)) continue;
        if ((player.team || player.teamCode || '').toUpperCase() !== codeUpper) continue;
        const pos = player.position;
        const currentPosCount = selected.filter(p => p.position === pos).length;
        if (currentPosCount >= positionQuotas[pos]) {
          const replaceableIndex = selected.findIndex(p => p.position === pos && !mustIncludeIds.has(p.id) && (p.team || '').toUpperCase() !== codeUpper);
          if (replaceableIndex >= 0) {
            const oldPlayer = selected[replaceableIndex];
            selected.splice(replaceableIndex, 1);
            selectedIds.delete(oldPlayer.id);
            const oldTeam = (oldPlayer.team || '').toUpperCase();
            teamCounts[oldTeam] = Math.max(0, (teamCounts[oldTeam] || 1) - 1);
            addPlayer(player);
            addedForTeam++;
            if (addedForTeam >= needed) break;
          }
        }
      }
    }
  }

  if (selected.length === 15) {
    const lineup = selectOptimalLineup(selected, p => scorePlayerForSquad(p, constraints));
    if (constraints.captainId) {
      const explicitCaptain = selected.find(p => p.id === constraints.captainId);
      if (explicitCaptain) lineup.captain = explicitCaptain;
    }
    if (constraints.viceCaptainId) {
      const explicitVice = selected.find(p => p.id === constraints.viceCaptainId);
      if (explicitVice) lineup.viceCaptain = explicitVice;
    }
    return {
      squad: selected,
      lineup,
      totalCost: Math.round(selected.reduce((sum, p) => sum + Number(p.cost || 0), 0) * 10) / 10,
      totalScore: Math.round(selected.reduce((sum, p) => sum + scorePlayerForSquad(p, constraints), 0) * 10) / 10,
    };
  }

  return { squad: selected, lineup: null, totalCost: 0, totalScore: 0 };
}

module.exports = {
  VALID_FORMATIONS,
  selectOptimalLineup,
  selectCaptainAndVice,
  hasEconomicalReserveGoalkeeper,
  nextGameweekScore,
  horizonScore,
  scorePlayerForSquad,
  buildOptimalSquadFromConstraints,
};


