import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
    normalize,
    normalizeUpper,
    stripSpaces,
    matchPlayers,
    matchPlayersFPL,
    matchPlayersGeneric,
    isFPLScreenshot,
    extractPrice,
    extractPosition,
    isPlayerName,
    extractPlayerCandidates,
    stripCaptainMarkers
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

// Test stripSpaces
assert.equal(stripSpaces('Alexander-Arnold'), 'ALEXANDERARNOLD');
assert.equal(stripSpaces('M. Salah'), 'MSALAH');
assert.equal(stripSpaces('O\'Niel'), 'ONIEL');

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
assert.equal(extractPrice('£2.0'), null);

// Test extractPosition
assert.equal(extractPosition('FWD'), 'FWD');
assert.equal(extractPosition(' midfielder MID'), 'MID');
assert.equal(extractPosition('DEFENDER DEF'), 'DEF');
assert.equal(extractPosition('no position'), null);

// Test isPlayerName
assert.equal(isPlayerName('Haaland'), true);
assert.equal(isPlayerName('M.Salah'), true);
assert.equal(isPlayerName('Alexander-Arnold'), true);
assert.equal(isPlayerName('FWD'), false);
assert.equal(isPlayerName('£8.1'), false);
assert.equal(isPlayerName('CAPTAIN'), false);
assert.equal(isPlayerName('8.1'), false);
assert.equal(isPlayerName(''), false);
assert.equal(isPlayerName('A'), false);
assert.equal(isPlayerName('PICK'), false);
assert.equal(isPlayerName('BENCH'), false);

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

// Test generic matching
const genericMatches = matchPlayersGeneric('Haaland\nM Salah\nAlexander Arnold', players);
assert.deepEqual(genericMatches.map(m => m.playerId).sort((a, b) => a - b), [1, 2, 3]);
assert.ok(genericMatches.every(m => m.score >= 62));

// Test FPL matching
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
assert.ok(fplMatches.every(m => m.score >= 50), 'All matches should have score >= 50');

const matchedIds = new Set(fplMatches.map(m => m.playerId));
assert.ok(matchedIds.has(1), 'Should match Haaland');
assert.ok(matchedIds.has(2), 'Should match Salah');
assert.ok(matchedIds.has(3), 'Should match Alexander-Arnold');

// Test OCR-split names (e.g. "HA ALAND" instead of "HAALAND")
const ocrSplitText = `PICK TEAM
£14.5
HA ALAND

£12.5
M SALAH

£8.1
ALEXANDER ARNOLD

£11.0
PALMER`;
const ocrMatches = matchPlayersFPL(ocrSplitText, players);
assert.ok(ocrMatches.length >= 3, `Should handle OCR-split names, got ${ocrMatches.length}`);
const ocrIds = new Set(ocrMatches.map(m => m.playerId));
assert.ok(ocrIds.has(1), 'Should match HA ALAND to Haaland');
assert.ok(ocrIds.has(2), 'Should match M SALAH to M.Salah');
assert.ok(ocrIds.has(3), 'Should match ALEXANDER ARNOLD to Alexander-Arnold');

// Test main matchPlayers with FPL screenshot
const mainMatches = matchPlayers(fplScreenshotText, players);
assert.ok(mainMatches.length >= 10, `Main matchPlayers with FPL screenshot should find >= 10, got ${mainMatches.length}`);

// Test main matchPlayers with generic text
const genericMainMatches = matchPlayers('Haaland\nSalah\nAlexander-Arnold\nPalmer\nSaka', players);
assert.ok(genericMainMatches.length >= 3, `Main matchPlayers with generic text should find >= 3, got ${genericMainMatches.length}`);

// Test OCR-split names across separate lines ("Trent" then "Alexander-Arnold")
const ocrSplitLinesText = `PICK TEAM
TRENT

ALEXANDER-ARNOLD

SALAH`;
const ocrSplitLinesMatches = matchPlayersFPL(ocrSplitLinesText, players);
assert.ok(ocrSplitLinesMatches.length >= 2, `Should merge split name lines, got ${ocrSplitLinesMatches.length}`);
const ocrSplitLinesIds = new Set(ocrSplitLinesMatches.map(m => m.playerId));
assert.ok(ocrSplitLinesIds.has(3), 'Should merge TRENT + ALEXANDER-ARNOLD into one match');
assert.ok(ocrSplitLinesIds.has(2), 'Should still match SALAH');

// Test captain/vice markers are stripped from names
const captainMarkedText = `PICK TEAM
£14.5
HAALAND (C)

£12.5
M.SALAH (VC)`;
const captainMarkedMatches = matchPlayersFPL(captainMarkedText, players);
const captainMarkedIds = new Set(captainMarkedMatches.map(m => m.playerId));
assert.ok(captainMarkedIds.has(1), 'Should strip (C) marker and match Haaland');
assert.ok(captainMarkedIds.has(2), 'Should strip (VC) marker and match Salah');

// Test name plus inline price on same line
const inlinePriceText = `PICK TEAM
HAALAND £14.5m FWD
M.SALAH £12.5m MID
PALMER £11.0m MID`;
const inlinePriceMatches = matchPlayersFPL(inlinePriceText, players);
const inlinePriceIds = new Set(inlinePriceMatches.map(m => m.playerId));
assert.ok(inlinePriceIds.has(1), 'Should extract HAALAND from inline price line');
assert.ok(inlinePriceIds.has(2), 'Should extract M.SALAH from inline price line');
assert.ok(inlinePriceIds.has(4), 'Should extract PALMER from inline price line');

// Test stripCaptainMarkers export
assert.equal(stripCaptainMarkers('HAALAND (C)'), 'HAALAND');
assert.equal(stripCaptainMarkers('M.SALAH (VC)'), 'M.SALAH');

// Test duplicate prevention
const matchesWithDupes = matchPlayersFPL('HAALAND\nHAALAND\nHAALAND', players);
assert.equal(matchesWithDupes.length, 1, 'Should not duplicate player matches');

// Test empty/invalid input
assert.deepEqual(matchPlayers('', players), []);
assert.deepEqual(matchPlayers(null, players), []);
assert.deepEqual(matchPlayersFPL('', players), []);
assert.deepEqual(matchPlayersGeneric('', players), []);

console.log('All squad screenshot matching tests passed');
