import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { buildDecisionCentre, buildSquadAdvice, validSquad } = require('../src/decisionModel');

const teams = Array.from({ length: 8 }, (_, index) => ({ id: index + 1, name: `Team ${index + 1}`, short_name: `T${index + 1}` }));
const positions = [1, 1, 2, 2, 2, 2, 2, 3, 3, 3, 3, 3, 4, 4, 4];
const elements = Array.from({ length: 40 }, (_, index) => {
  const elementType = index < 5 ? 1 : index < 18 ? 2 : index < 32 ? 3 : 4;
  return {
    id: index + 1,
    first_name: 'Test',
    second_name: `Player ${index + 1}`,
    web_name: `Player ${index + 1}`,
    code: 1000 + index,
    team: (index % teams.length) + 1,
    element_type: elementType,
    status: 'a',
    can_select: true,
    special: false,
    minutes: 1800,
    starts: 20,
    total_points: 50 + index * 3,
    points_per_game: String(2.5 + index * 0.08),
    form: String(2.5 + index * 0.12),
    expected_goals_per_90: elementType >= 3 ? 0.12 + index * 0.012 : 0.03,
    expected_assists_per_90: elementType >= 2 ? 0.08 + index * 0.006 : 0,
    expected_goal_involvements_per_90: 0.2 + index * 0.01,
    selected_by_percent: String(2 + index),
    now_cost: 40 + (index % 10) * 4,
    bonus: 4 + index,
    saves_per_90: elementType === 1 ? 3.2 : 0,
    clean_sheets: 5,
    yellow_cards: 2,
    red_cards: 0,
    ep_next: String(3 + index * 0.08),
  };
});

// Make a valid current squad from low-ranked players, leaving upgrades available.
const squadPlayers = [];
for (const [positionIndex, count] of Object.entries({ 1: 2, 2: 5, 3: 5, 4: 3 })) {
  squadPlayers.push(...elements.filter(player => player.element_type === Number(positionIndex)).slice(0, count));
}
const picks = {
  picks: squadPlayers.map((player, index) => ({ element: player.id, position: index + 1, purchase_price: player.now_cost, selling_price: player.now_cost })),
  entry_history: { bank: 50 },
};

const fixtures = [];
for (let gw = 10; gw <= 14; gw += 1) {
  for (let team = 1; team <= 8; team += 2) {
    fixtures.push({ id: fixtures.length + 1, event: gw, team_h: team, team_a: team + 1, team_h_difficulty: 2, team_a_difficulty: 3, kickoff_time: `2026-09-${gw}T12:00:00Z`, started: false, finished: false });
  }
}
fixtures.push({ id: 100, event: 10, team_h: 2, team_a: 3, team_h_difficulty: 2, team_a_difficulty: 4, kickoff_time: '2026-09-11T12:00:00Z', started: false, finished: false });

const bootstrap = { events: [{ id: 9, is_current: true }, { id: 10, is_next: true }], teams, elements };
const manager = { id: '123', player_first_name: 'Test', player_last_name: 'Manager', name: 'Model XI', summary_overall_rank: 10000, summary_overall_points: 500 };
const history = { current: [{ event: 1, points: 52 }, { event: 2, points: 61 }, { event: 3, points: 47 }], chips: [] };
const rivals = [{ id: '456', name: 'Rival', teamName: 'Rival XI', rank: 9000, picks: [...picks.picks.slice(0, 12), ...elements.slice(-3).map((player, index) => ({ element: player.id, position: 13 + index }))] }];
const liveData = { elements: elements.map(player => ({ id: player.id, stats: { total_points: player.id % 7, minutes: 90 } })) };

const result = buildDecisionCentre({ bootstrap, fixtures, manager, picks, history, rivals, liveData, options: { targetGW: 10, horizon: 5, strategy: 'balanced', freeTransfers: 1 } });
assert.equal(result.squad.length, 15);
assert.equal(result.lineup.starters.length, 11);
assert.equal(result.lineup.bench.length, 4);
assert.equal(result.lineup.starters.filter(player => player.position === 'GKP').length, 1);
assert.ok(result.lineup.starters.filter(player => player.position === 'DEF').length >= 3);
assert.ok(result.lineup.captain && result.lineup.viceCaptain);
assert.ok(result.transfers.plans.length > 0, 'optimizer should find upgrades for the deliberately weak squad');
assert.ok(result.transfers.plans.every(plan => plan.netGain > 0 && plan.bankAfter >= 0));
assert.ok(result.transfers.optimalSquad.valid, 'wildcard benchmark must satisfy FPL squad constraints');
assert.ok(validSquad(result.transfers.optimalSquad.players));
assert.equal(result.chips.weeks.length, 5);
assert.equal(result.rivals.length, 1);
assert.ok(result.rivals[0].overlap < 100);
assert.ok(result.comparisonPool.every(player => player.range.low <= player.totalXpts && player.range.high >= player.totalXpts));
const doublePlayer = result.comparisonPool.find(player => player.teamId === 2);
assert.equal(doublePlayer.weekly[0].fixtures.length, 2, 'double gameweeks must include both fixtures');
assert.equal(result.backtest.status, 'baseline');
assert.equal(result.live.status, 'live');
assert.ok(result.live.players.length === 15 && Number.isFinite(result.live.livePoints));

const advice = buildSquadAdvice({ bootstrap, fixtures, playerIds: squadPlayers.map(player => player.id), options: { targetGW: 10, horizon: 5, strategy: 'balanced', freeTransfers: 1, bank: 5 } });
assert.equal(advice.summary.legal, true);
assert.equal(advice.critiques.length, 15);
assert.equal(advice.lineup.starters.length, 11);
assert.ok(advice.critiques.every(item => item.verdict && item.reasons.length >= 2));
assert.ok(advice.chips.recommendations.every(item => ['Hold', 'Consider'].includes(item.recommendation)));
assert.ok(advice.meta.warnings.length >= 2);

// FPL chip rule: Wildcard and Free Hit must never be recommended for GW1.
const gw1Fixtures = [];
for (let gw = 1; gw <= 5; gw += 1) {
  for (let team = 1; team <= 8; team += 2) {
    gw1Fixtures.push({ id: gw1Fixtures.length + 1, event: gw, team_h: team, team_a: team + 1, team_h_difficulty: 2, team_a_difficulty: 3, kickoff_time: `2026-08-${gw}T12:00:00Z`, started: false, finished: false });
  }
}
const gw1Bootstrap = { events: [{ id: 1, is_current: true }, { id: 2, is_next: true }], teams, elements };
const gw1Picks = { picks: squadPlayers.map((player, index) => ({ element: player.id, position: index + 1, purchase_price: player.now_cost, selling_price: player.now_cost })), entry_history: { bank: 50 } };
const gw1Decision = buildDecisionCentre({ bootstrap: gw1Bootstrap, fixtures: gw1Fixtures, manager, picks: gw1Picks, history, rivals: [], liveData: { elements: [] }, options: { targetGW: 1, horizon: 5, strategy: 'balanced', freeTransfers: 1 } });
const wcRec = gw1Decision.chips.recommendations.find(item => item.chip === 'Wildcard');
const fhRec = gw1Decision.chips.recommendations.find(item => item.chip === 'Free Hit');
assert.ok(!wcRec || wcRec.gameweek !== 1, 'Wildcard must not be scheduled in GW1');
assert.ok(!fhRec || fhRec.gameweek !== 1, 'Free Hit must not be scheduled in GW1');

console.log('Decision model tests passed');
