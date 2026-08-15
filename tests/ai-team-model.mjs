import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { VALID_FORMATIONS, selectOptimalLineup, hasEconomicalReserveGoalkeeper } = require('../src/aiTeamModel.js');

const makePlayers = (position, scores) => scores.map((score, index) => ({
  id: `${position}-${index}`,
  position,
  score,
  weekly: [{ xPts: score }],
}));

const squad = [
  ...makePlayers('GKP', [4, 2]),
  ...makePlayers('DEF', [8, 7, 6, 5, 1]),
  ...makePlayers('MID', [9, 8, 7, 2, 1]),
  ...makePlayers('FWD', [10, 9, 8]),
];

const result = selectOptimalLineup(squad, player => player.score);
assert.equal(VALID_FORMATIONS.length, 7, 'All legal FPL formations must be evaluated');
assert.equal(result.starters.length, 11);
assert.equal(result.bench.length, 4);
assert.equal(new Set([...result.starters, ...result.bench].map(player => player.id)).size, 15);
assert.equal(result.audit.formationsEvaluated.length, 7);
assert.ok(result.audit.chosenScore >= result.audit.nextBestScore);

const expectedBest = VALID_FORMATIONS.map(shape => ({
  formation: `${shape.DEF}-${shape.MID}-${shape.FWD}`,
  score: [4]
    .concat([8, 7, 6, 5, 1].slice(0, shape.DEF))
    .concat([9, 8, 7, 2, 1].slice(0, shape.MID))
    .concat([10, 9, 8].slice(0, shape.FWD))
    .reduce((sum, value) => sum + value, 0),
})).sort((a, b) => b.score - a.score || a.formation.localeCompare(b.formation))[0];
assert.equal(result.formation, expectedBest.formation);
assert.equal(hasEconomicalReserveGoalkeeper([
  { position: 'GKP', cost: 5.5 },
  { position: 'GKP', cost: 4.5 },
], 45), true);
assert.equal(hasEconomicalReserveGoalkeeper([
  { position: 'GKP', cost: 5.5 },
  { position: 'GKP', cost: 5.0 },
], 45), false);

console.log('AI Team formation tests passed');
