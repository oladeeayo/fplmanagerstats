import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { matchPlayers, normalize } = require('../public/squad-import.js');

const players = [
  { id: 1, name: 'Haaland', fullName: 'Erling Haaland', team: 'MCI', position: 'FWD' },
  { id: 2, name: 'M.Salah', fullName: 'Mohamed Salah', team: 'LIV', position: 'MID' },
  { id: 3, name: 'Alexander-Arnold', fullName: 'Trent Alexander-Arnold', team: 'LIV', position: 'DEF' },
];

assert.equal(normalize('  M. SALAH  '), 'm salah');
const matches = matchPlayers('Pick Team\nHaaland\nM Salah\nAlexander Arnold\nCaptain', players);
assert.deepEqual(matches.map(match => match.playerId).sort(), [1, 2, 3]);
assert.ok(matches.every(match => match.score >= 62));
assert.equal(new Set(matches.map(match => match.playerId)).size, matches.length);

console.log('Squad screenshot matching tests passed');
