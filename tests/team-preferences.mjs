import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
    normalize,
    splitClauses,
    parseTeamPreferences,
    parseFormation,
    teamCodeFromName,
    VALID_FORMATIONS,
} = require('../public/team-preferences.js');

const players = [
    { id: 1, name: 'Haaland', web_name: 'Haaland', first_name: 'Erling', second_name: 'Haaland', team: 'MCI', position: 'FWD', costValue: 14.5, status: 'a' },
    { id: 2, name: 'M.Salah', web_name: 'Salah', first_name: 'Mohamed', second_name: 'Salah', team: 'LIV', position: 'MID', costValue: 12.5, status: 'a' },
    { id: 3, name: 'Alexander-Arnold', web_name: 'Alexander-Arnold', first_name: 'Trent', second_name: 'Alexander-Arnold', team: 'LIV', position: 'DEF', costValue: 8.1, status: 'a' },
    { id: 4, name: 'Palmer', web_name: 'Palmer', first_name: 'Cole', second_name: 'Palmer', team: 'CHE', position: 'MID', costValue: 11.0, status: 'a' },
    { id: 5, name: 'Saka', web_name: 'Saka', first_name: 'Bukayo', second_name: 'Saka', team: 'ARS', position: 'MID', costValue: 10.0, status: 'a' },
    { id: 6, name: 'Watkins', web_name: 'Watkins', first_name: 'Ollie', second_name: 'Watkins', team: 'AVL', position: 'FWD', costValue: 8.5, status: 'a' },
    { id: 7, name: 'Gabriel', web_name: 'Gabriel', first_name: 'Gabriel', second_name: 'Magalhaes', team: 'ARS', position: 'DEF', costValue: 5.5, status: 'a' },
    { id: 8, name: 'Raya', web_name: 'Raya', first_name: 'David', second_name: 'Raya', team: 'ARS', position: 'GKP', costValue: 5.5, status: 'a' },
    { id: 9, name: 'Porro', web_name: 'Porro', first_name: 'Pedro', second_name: 'Porro', team: 'TOT', position: 'DEF', costValue: 5.5, status: 'a' },
    { id: 10, name: 'Mbeumo', web_name: 'Mbeumo', first_name: 'Bryan', second_name: 'Mbeumo', team: 'BRE', position: 'MID', costValue: 8.0, status: 'a' },
    { id: 11, name: 'Wood', web_name: 'Wood', first_name: 'Chris', second_name: 'Wood', team: 'NFO', position: 'FWD', costValue: 7.5, status: 'a' },
    { id: 12, name: 'Martinez', web_name: 'Martinez', first_name: 'Emiliano', second_name: 'Martinez', team: 'AVL', position: 'GKP', costValue: 5.0, status: 'a' },
    { id: 13, name: 'Pedersen', web_name: 'Pedersen', first_name: 'Mads', second_name: 'Pedersen', team: 'IPS', position: 'DEF', costValue: 4.0, status: 'a' },
    { id: 14, name: 'Dibling', web_name: 'Dibling', first_name: 'Tyler', second_name: 'Dibling', team: 'SOU', position: 'MID', costValue: 4.5, status: 'a' },
    { id: 15, name: 'Stewart', web_name: 'Stewart', first_name: 'Ross', second_name: 'Stewart', team: 'SOU', position: 'FWD', costValue: 5.5, status: 'd' },
];

// normalize
assert.equal(normalize('  Wätkins!! '), 'watkins');
assert.equal(normalize('4-4-2'), '4 4 2');

// splitClauses
assert.deepEqual(splitClauses('I want Haaland. No Chelsea players; midfielders under 8.0'), ['I want Haaland', 'No Chelsea players', 'midfielders under 8.0']);

// parseFormation
assert.deepEqual(parseFormation('4-4-2'), [4, 4, 2]);
assert.deepEqual(parseFormation('343'), [3, 4, 3]);
assert.equal(parseFormation('9-9-9'), null);
assert.deepEqual(parseFormation('3-5-2'), [3, 5, 2]);

// teamCodeFromName
assert.equal(teamCodeFromName('Arsenal'), 'ARS');
assert.equal(teamCodeFromName('spurs'), 'TOT');
assert.equal(teamCodeFromName('CHE'), 'CHE');
assert.equal(teamCodeFromName('Manchester City'), 'MCI');
assert.equal(teamCodeFromName('UnknownClub'), null);

// VALID_FORMATIONS
assert.equal(VALID_FORMATIONS.length, 7);

// Include + captain + budget + formation
{
    const parsed = parseTeamPreferences('I want Haaland and Salah. Captain Haaland. Play 3-4-3.', { players });
    assert.deepEqual(parsed.constraints.mustInclude.sort(), [1, 2]);
    assert.equal(parsed.constraints.captainId, 1);
    assert.deepEqual(parsed.constraints.formation, [3, 4, 3]);
    assert.ok(parsed.understood.some(u => u.includes('Include Haaland')));
}

// Exclude a player, a team, and set a position price cap
{
    const parsed = parseTeamPreferences('No Chelsea players. Exclude Watkins. Midfielders under 8.0.', { players });
    assert.deepEqual(parsed.constraints.teamExclude, ['CHE']);
    assert.deepEqual(parsed.constraints.mustExclude, [6]);
    assert.equal(parsed.constraints.priceMax.MID, 8);
    assert.ok(parsed.understood.some(u => u.includes('No players from CHE')));
    assert.ok(parsed.understood.some(u => u.includes('Exclude Watkins')));
}

// Team counts: at least / at most
{
    const parsed = parseTeamPreferences('At least 2 players from Arsenal. Max 1 from Chelsea.', { players });
    assert.equal(parsed.constraints.teamIncludeMin.ARS, 2);
    assert.equal(parsed.constraints.teamIncludeMax.CHE, 1);
}

// Price floors and ranges
{
    const parsed = parseTeamPreferences('Forwards over 10. Defenders between 4.5 and 5.5.', { players });
    assert.equal(parsed.constraints.priceMin.FWD, 10);
    assert.equal(parsed.constraints.priceMin.DEF, 4.5);
    assert.equal(parsed.constraints.priceMax.DEF, 5.5);
}

// Player-scoped price ("Salah under 12")
{
    const parsed = parseTeamPreferences('Salah under 12.0', { players });
    assert.equal(parsed.constraints.playerPriceMax[2], 12);
    assert.ok(parsed.understood.some(u => u.includes('under')));
}

// Budget: keep money in the bank
{
    const parsed = parseTeamPreferences('Keep 1.5 in the bank', { players });
    assert.equal(parsed.constraints.budget, 98.5);
}

// Avoid injured
{
    const parsed = parseTeamPreferences('Avoid injured players', { players });
    assert.equal(parsed.constraints.avoidInjured, true);
}

// Captain-only clause ("make Palmer captain")
{
    const parsed = parseTeamPreferences('Make Palmer captain', { players });
    assert.equal(parsed.constraints.captainId, 4);
}

// Unclear input is reported for clarification
{
    const parsed = parseTeamPreferences('I want the purple llama strategy', { players });
    assert.ok(parsed.unclear.length > 0);
    assert.ok(parsed.unclear.some(u => u.includes('purple')));
}

// The full sample sentence parses into everything
{
    const parsed = parseTeamPreferences('I want Haaland and Salah. No Chelsea players. Midfielders under 8.0. 2 from Arsenal. Play 4-4-2. Keep 1.0 in the bank. Captain Palmer.', { players });
    const c = parsed.constraints;
    assert.deepEqual(c.mustInclude.sort(), [1, 2, 4]);
    assert.deepEqual(c.teamExclude, ['CHE']);
    assert.equal(c.priceMax.MID, 8);
    assert.equal(c.teamIncludeMin.ARS, 2);
    assert.deepEqual(c.formation, [4, 4, 2]);
    assert.equal(c.budget, 99);
    assert.equal(c.captainId, 4);
    assert.equal(c.avoidInjured, false);
}

console.log('team-preferences.mjs: all tests passed');
