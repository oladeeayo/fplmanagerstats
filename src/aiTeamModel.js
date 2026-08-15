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

function selectOptimalLineup(squad, scorePlayer) {
  if (!Array.isArray(squad) || squad.length !== 15) throw new Error('A legal 15-player squad is required');
  const byPosition = position => squad.filter(player => player.position === position).sort((a, b) => scorePlayer(b) - scorePlayer(a));
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
      score: round(starters.reduce((sum, player) => sum + scorePlayer(player), 0), 3),
      starters,
    };
  }).sort((a, b) => b.score - a.score || a.formation.localeCompare(b.formation));

  const best = evaluations[0];
  const starterIds = new Set(best.starters.map(player => player.id));
  const bench = squad
    .filter(player => !starterIds.has(player.id))
    .sort((a, b) => (a.position === 'GKP' ? -1 : b.weekly?.[0]?.xPts - a.weekly?.[0]?.xPts));

  return {
    formation: best.formation,
    starters: best.starters,
    bench,
    audit: {
      formationOptimal: true,
      formationsEvaluated: evaluations.map(item => ({ formation: item.formation, score: item.score })),
      chosenScore: best.score,
      nextBestScore: evaluations[1]?.score || best.score,
      advantage: round(best.score - (evaluations[1]?.score || best.score), 3),
    },
  };
}

module.exports = { VALID_FORMATIONS, selectOptimalLineup };
