import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { buildCaptaincyModel, estimateExpectedMinutes } = require('../src/captaincyModel');

const teams = [
  { id: 1, name: 'Alpha', short_name: 'ALP' },
  { id: 2, name: 'Bravo', short_name: 'BRV' },
  { id: 3, name: 'Charlie', short_name: 'CHA' },
  { id: 4, name: 'Delta', short_name: 'DEL' },
];

function player(overrides) {
  return {
    id: 1,
    first_name: 'Test',
    second_name: 'Player',
    web_name: 'Player',
    code: 100,
    team: 1,
    element_type: 3,
    status: 'a',
    can_select: true,
    removed: false,
    special: false,
    chance_of_playing_next_round: null,
    minutes: 2700,
    starts: 30,
    total_points: 180,
    points_per_game: '6.0',
    form: '7.0',
    expected_goals_per_90: 0.5,
    expected_assists_per_90: 0.3,
    selected_by_percent: '40.0',
    now_cost: 100,
    bonus: 24,
    saves_per_90: 0,
    clean_sheets: 10,
    yellow_cards: 3,
    red_cards: 0,
    penalties_order: 1,
    direct_freekicks_order: null,
    corners_and_indirect_freekicks_order: null,
    ep_next: '7.0',
    ...overrides,
  };
}

const fixtures = [
  { id: 1, event: 10, team_h: 1, team_a: 2, team_h_difficulty: 1, team_a_difficulty: 5, kickoff_time: '2026-10-01T12:00:00Z', started: false, finished: false },
  { id: 2, event: 10, team_h: 3, team_a: 4, team_h_difficulty: 3, team_a_difficulty: 3, kickoff_time: '2026-10-01T14:00:00Z', started: false, finished: false },
];

const bootstrap = {
  events: [{ id: 9, is_current: true }, { id: 10, is_next: true }],
  teams,
  elements: [
    player({ id: 1, web_name: 'Favourite', selected_by_percent: '50.0' }),
    player({ id: 2, web_name: 'Differential', code: 101, team: 3, selected_by_percent: '5.0', form: '6.0', expected_goals_per_90: 0.45 }),
    player({ id: 3, web_name: 'Unavailable', code: 102, team: 3, status: 'i', chance_of_playing_next_round: 0, selected_by_percent: '1.0', expected_goals_per_90: 1.2 }),
    player({ id: 4, web_name: 'HardAway', code: 103, team: 2, selected_by_percent: '20.0', expected_goals_per_90: 0.5 }),
    player({ id: 5, web_name: 'Keeper', code: 104, team: 3, element_type: 1, selected_by_percent: '2.0', points_per_game: '7.0', form: '8.0', expected_goals_per_90: 0, expected_assists_per_90: 0, saves_per_90: 5.0, bonus: 30 }),
  ],
};

const result = buildCaptaincyModel({ bootstrap, fixtures, selectedGW: 10 });
assert.equal(result.gameweek, 10);
assert.equal(result.topPicks.length, 4);
assert.equal(result.bestPick.name, 'Favourite', 'home FDR 1 should outrank the same profile away at FDR 5');
assert.equal(result.differentialPick.name, 'Differential');
assert.ok(['MID', 'FWD'].includes(result.differentialPick.position), 'the differential should retain attacking captaincy upside');
assert.ok(result.bestPick.explanation.includes('BRV (H)'));
assert.ok(result.differentialPick.explanation.includes('5.0% ownership'));
assert.ok(result.topPicks.every(pick => pick.xMins > 0 && pick.fixtures[0].fdr >= 1));

const doubtfulMinutes = estimateExpectedMinutes(player({ status: 'd' }), 38, 0.75);
const availableMinutes = estimateExpectedMinutes(player(), 38, 1);
assert.ok(doubtfulMinutes < availableMinutes, 'availability must reduce expected minutes');

const blank = buildCaptaincyModel({ bootstrap, fixtures, selectedGW: 11 });
assert.equal(blank.bestPick, null);
assert.deepEqual(blank.topPicks, []);
