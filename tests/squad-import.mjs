import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
    normalize,
    normalizeUpper,
    matchPlayers,
    matchPlayersFPL,
    matchPlayersGeneric,
    isFPLScreenshot,
    extractPrice,
    extractPosition,
    isPlayerName,
    extractPlayerCandidates
} = require('../public/squad-import.js');

const players = [
    { id: 1, name: 'Haaland', fullName: 'Erling Haaland', team: 'MCI', position: 'FWD', costValue: 14.5 },
    { id: 2, name: 'M.Salah', fullName: 'Mohamed Salah', team: 'LIV', position: 'MID', costValue: 12.5 },
    { id: 3, name: 'Alexander-Arnold', fullName: 'Trent Alexander-Arnold', team: 'LIV', position: 'DEF', costValue: 8.1 },
    { id: 4, name: 'Palmer', fullName: 'Cole Palmer', team: 'CHE', position: 'MID', costValue: 11.0 },
    { id: 5, name: 'Saka', fullName: 'Bukayo Saka', team: 'ARS', position: 'MID', costValue: 10.0 },
    { id: 6, name: 'Watkins', fullName: 'Ollie Watkins', team: 'AVL', position: 'FWD', costValue: 8.5 },
    { id: 7, name: 'Gabriel', fullName: 'Gabriel Magalhaes', team: 'ARS', position: 'DEF', costValue: 5.5 },
    { id: 8, name: 'Raya', fullName: 'David Raya', team: 'ARS', position: 'GKP', costValue: 5.5 },
    { id: 9, name: 'Porro', fullName: 'Pedro Porro', team: 'TOT', position: 'DEF', costValue: 5.5 },
    { id: 10, name: 'Mbeumo', fullName: 'Bryan Mbeumo', team: 'BRE', position: 'MID', costValue: 8.0 },
    { id: 11, name: 'Wood', fullName: 'Chris Wood', team: 'NFO', position: 'FWD', costValue: 7.5 },
    { id: 12, name: 'Martinez', fullName: 'Emiliano Martinez', team: 'AVL', position: 'GKP', costValue: 5.0 },
    { id: 13, name: 'Pedersen', fullName: 'Mads Pedersen', team: 'IPS', position: 'DEF', costValue: 4.0 },
    { id: 14, name: 'Dibling', fullName: 'Tyler Dibling', team: 'SOU', position: 'MID', costValue: 4.5 },
    { id: 15, name: 'Stewart', fullName: 'Ross Stewart', team: 'SOU', position: 'FWD', costValue: 5.5 },
];

// Test normalize
assert.equal(normalize('  M. SALAH  '), 'm salah');
assert.equal(normalizeUpper('  M. SALAH  '), 'M SALAH');

// Test isFPLScreenshot
assert.equal(isFPLScreenshot('PICK TEAM\nHaaland\nSalah'), true);
assert.equal(isFPLScreenshot('Pick your team\nHaaland'), true);
assert.equal(isFPLScreenshot('My Team\nHaaland'), true);
assert.equal(isFPLScreenshot('Just some random text'), false);

// Test extractPrice
assert.equal(extractPrice('£8.1'), 8.1);
assert.equal(extractPrice('£14.5m'), 14.5);
assert.equal(extractPrice('5.6'), 5.6);
assert.equal(extractPrice('no price here'), null);
assert.equal(extractPrice('£2.0'), null); // too cheap

// Test extractPosition
assert.equal(extractPosition('FWD'), 'FWD');
assert.equal(extractPosition(' midfielder MID'), 'MID');
assert.equal(extractPosition('DEFENDER DEF'), 'DEF');
assert.equal(extractPosition('no position'), null);

// Test isPlayerName
assert.equal(isPlayerName('Haaland'), true);
assert.equal(isPlayerName('M.Salah'), true);
assert.equal(isPlayerName('Alexander-Arnold'), true);
assert.equal(isPlayerName('FWD'), false); // position
assert.equal(isPlayerName('£8.1'), false); // price
assert.equal(isPlayerName('CAPTAIN'), false); // noise
assert.equal(isPlayerName('8.1'), false); // number
assert.equal(isPlayerName(''), false); // empty
assert.equal(isPlayerName('A'), false); // too short

// Test extractPlayerCandidates
const fplText = `PICK TEAM
£10.0
HAALAND

£12.5
M.SALAH

£8.1
ALEXANDER-ARNOLD

FWD
MID
DEF`;
const candidates = extractPlayerCandidates(fplText);
assert.ok(candidates.length >= 3, `Should find at least 3 candidates, found ${candidates.length}`);
const candidateTexts = candidates.map(c => c.normalized);
assert.ok(candidateTexts.some(t => t.includes('HAALAND')), 'Should find HAALAND');
assert.ok(candidateTexts.some(t => t.includes('SALAH')), 'Should find SALAH');

// Test generic matching (fallback)
const genericMatches = matchPlayersGeneric('Haaland\nM Salah\nAlexander Arnold', players);
assert.deepEqual(genericMatches.map(m => m.playerId).sort((a, b) => a - b), [1, 2, 3]);
assert.ok(genericMatches.every(m => m.score >= 62));

// Test FPL-specific matching
const fplScreenshotText = `PICK TEAM
£14.5
HAALAND

£12.5
M.SALAH

£8.1
ALEXANDER-ARNOLD

£11.0
PALMER

£10.0
SAKA

£8.5
WATKINS

£5.5
GABRIEL

£5.5
RAYA

£5.5
PORRO

£8.0
MBEUMO

£7.5
WOOD

£5.0
MARTINEZ

£4.0
PEDERSEN

£4.5
DLIBLING

£5.5
STEWART`;

const fplMatches = matchPlayersFPL(fplScreenshotText, players);
assert.ok(fplMatches.length >= 10, `Should match at least 10 players from FPL screenshot, got ${fplMatches.length}`);
assert.ok(fplMatches.every(m => m.score >= 55), 'All matches should have score >= 55');

// Verify specific matches
const matchedIds = new Set(fplMatches.map(m => m.playerId));
assert.ok(matchedIds.has(1), 'Should match Haaland');
assert.ok(matchedIds.has(2), 'Should match Salah');
assert.ok(matchedIds.has(3), 'Should match Alexander-Arnold');

// Test main matchPlayers function with FPL screenshot
const mainMatches = matchPlayers(fplScreenshotText, players);
assert.ok(mainMatches.length >= 10, `Main matchPlayers with FPL screenshot should find >= 10, got ${mainMatches.length}`);

// Test main matchPlayers function with generic text
const genericText = 'Haaland\nSalah\nAlexander-Arnold\nPalmer\nSaka';
const genericMainMatches = matchPlayers(genericText, players);
assert.ok(genericMainMatches.length >= 3, `Main matchPlayers with generic text should find >= 3, got ${genericMainMatches.length}`);

// Test duplicate prevention
const matchesWithDupes = matchPlayersFPL('HAALAND\nHAALAND\nHAALAND', players);
assert.equal(matchesWithDupes.length, 1, 'Should not duplicate player matches');

// Test empty/invalid input
assert.deepEqual(matchPlayers('', players), []);
assert.deepEqual(matchPlayers(null, players), []);
assert.deepEqual(matchPlayersFPL('', players), []);
assert.deepEqual(matchPlayersGeneric('', players), []);

console.log('All squad screenshot matching tests passed');
