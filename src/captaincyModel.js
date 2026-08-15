const POSITION_MAP = ['GKP', 'DEF', 'MID', 'FWD'];

const GOAL_POINTS = { GKP: 10, DEF: 6, MID: 5, FWD: 4 };
const CLEAN_SHEET_POINTS = { GKP: 4, DEF: 4, MID: 1, FWD: 0 };
const ATTACK_MODIFIER = { 1: 1.25, 2: 1.12, 3: 1, 4: 0.88, 5: 0.76 };
const FORM_MODIFIER = { 1: 1.12, 2: 1.06, 3: 1, 4: 0.94, 5: 0.88 };
const CLEAN_SHEET_PROBABILITY = { 1: 0.46, 2: 0.37, 3: 0.28, 4: 0.19, 5: 0.12 };

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function number(value, fallback = 0) {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function round(value, precision = 1) {
  const multiplier = 10 ** precision;
  return Math.round(value * multiplier) / multiplier;
}

function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const midpoint = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[midpoint] : (sorted[midpoint - 1] + sorted[midpoint]) / 2;
}

function availabilityFor(player, useNextRoundChance) {
  if (player.removed || player.can_select === false || ['u', 's', 'n'].includes(player.status)) return 0;

  const chance = useNextRoundChance ? number(player.chance_of_playing_next_round, NaN) : NaN;
  if (Number.isFinite(chance)) return clamp(chance / 100, 0, 1);
  if (player.status === 'i') return 0.25;
  if (player.status === 'd') return 0.75;
  return 1;
}

function estimateExpectedMinutes(player, referenceMatches, availability) {
  if (availability <= 0) return 0;

  const minutes = number(player.minutes);
  const starts = number(player.starts);
  const ppg = number(player.points_per_game);
  const points = number(player.total_points);
  if (minutes === 0 && starts === 0 && points === 0) {
    const officialProjection = number(player.ep_next);
    const ownership = number(player.selected_by_percent);
    const rolePrior = 58 + Math.min(officialProjection * 4, 16) + Math.min(ownership * 0.25, 8);
    return round(clamp(rolePrior * availability, 35, 82), 0);
  }
  const inferredAppearances = ppg > 0 ? points / ppg : Math.max(starts, Math.ceil(minutes / 90));
  const appearances = clamp(inferredAppearances, starts, Math.max(referenceMatches, starts, 1));
  const substituteAppearances = Math.max(0, appearances - starts);
  const estimatedSubMinutes = substituteAppearances * 18;
  const averageStartMinutes = starts > 0
    ? clamp((minutes - estimatedSubMinutes) / starts, 55, 90)
    : clamp(minutes / Math.max(appearances, 1), 15, 65);
  const startShare = appearances > 0 ? clamp(starts / appearances, 0, 1) : 0;
  const averageRoleMinutes = (startShare * averageStartMinutes) + ((1 - startShare) * 18);
  const activeMatchRate = clamp(appearances / Math.max(referenceMatches, 1), 0, 1);
  const currentSelectionRate = 0.65 + (activeMatchRate * 0.35);

  return round(clamp(averageRoleMinutes * currentSelectionRate * availability, 0, 90), 0);
}

function buildPositionBaselines(elements) {
  return [1, 2, 3, 4].reduce((baselines, elementType) => {
    const established = elements.filter(player => player.element_type === elementType && number(player.minutes) >= 450);
    baselines[elementType] = {
      xG90: median(established.map(player => number(player.expected_goals_per_90)).filter(value => value > 0)),
      xA90: median(established.map(player => number(player.expected_assists_per_90)).filter(value => value > 0)),
    };
    return baselines;
  }, {});
}

function shrunkRate(player, field, baseline) {
  const minutes = number(player.minutes);
  const sampleWeight = minutes / (minutes + 600);
  return (number(player[field]) * sampleWeight) + (baseline * (1 - sampleWeight));
}

function getFixtureDifficulty(fixture, teamId) {
  return clamp(number(
    fixture.team_h === teamId ? fixture.team_h_difficulty : fixture.team_a_difficulty,
    3,
  ), 1, 5);
}

function fixtureTone(difficulty) {
  if (difficulty === 1) return 'very favourable';
  if (difficulty === 2) return 'favourable';
  if (difficulty === 4) return 'difficult';
  if (difficulty === 5) return 'very difficult';
  return 'balanced';
}

function describeRole(player) {
  const roles = [];
  if (number(player.penalties_order) === 1) roles.push('first-choice penalties');
  if (number(player.direct_freekicks_order) === 1) roles.push('direct free-kicks');
  if (number(player.corners_and_indirect_freekicks_order) === 1) roles.push('corners and indirect free-kicks');
  return roles;
}

function projectFixture({ player, fixture, fixtureIndex, xMins, xG90, xA90, form, ppg, position, officialProjection }) {
  const difficulty = getFixtureDifficulty(fixture, player.team);
  const isHome = fixture.team_h === player.team;
  const opponentId = isHome ? fixture.team_a : fixture.team_h;
  const fixtureXmins = round(xMins * (fixtureIndex === 0 ? 1 : 0.92), 0);
  const minuteShare = fixtureXmins / 90;
  const appearanceProbability = clamp(fixtureXmins / 30, 0, 1);
  const sixtyMinuteProbability = clamp((fixtureXmins - 30) / 30, 0, 1);
  const attackModifier = ATTACK_MODIFIER[difficulty] * (isHome ? 1.03 : 0.97);
  const formModifier = FORM_MODIFIER[difficulty] * (isHome ? 1.02 : 0.98);

  const appearancePoints = appearanceProbability + sixtyMinuteProbability;
  const goalPoints = xG90 * minuteShare * attackModifier * GOAL_POINTS[position];
  const assistPoints = xA90 * minuteShare * attackModifier * 3;
  const cleanSheetPoints = CLEAN_SHEET_POINTS[position] * CLEAN_SHEET_PROBABILITY[difficulty] * sixtyMinuteProbability;
  const bonusPer90 = number(player.bonus) * 90 / Math.max(number(player.minutes), 900);
  const bonusPoints = clamp(bonusPer90, 0, 1.25) * minuteShare * (0.9 + (attackModifier * 0.1));
  const setPiecePoints = (
    (number(player.penalties_order) === 1 ? 0.12 : 0) +
    (number(player.direct_freekicks_order) === 1 ? 0.04 : 0) +
    (number(player.corners_and_indirect_freekicks_order) === 1 ? 0.04 : 0)
  ) * minuteShare * attackModifier;
  const savePoints = position === 'GKP'
    ? (number(player.saves_per_90) * minuteShare / 3)
    : 0;
  const cardPoints = -(
    (number(player.yellow_cards) + (number(player.red_cards) * 3)) * 90 /
    Math.max(number(player.minutes), 1800)
  ) * minuteShare;
  const eventProjection = appearancePoints + goalPoints + assistPoints + cleanSheetPoints + bonusPoints + setPiecePoints + savePoints + cardPoints;

  const historicAverageMinutes = clamp(number(player.minutes) / Math.max(number(player.total_points) / Math.max(ppg, 0.1), 1), 45, 90);
  const roleMinutesRatio = clamp(fixtureXmins / historicAverageMinutes, 0, 1.2);
  const formProjection = form * roleMinutesRatio * formModifier;
  const ppgProjection = ppg * roleMinutesRatio * formModifier;
  let projectedPoints = (eventProjection * 0.68) + (formProjection * 0.2) + (ppgProjection * 0.12);

  if (officialProjection > 0 && fixtureIndex === 0) {
    projectedPoints = (projectedPoints * 0.88) + (officialProjection * 0.12);
  }

  return {
    opponentId,
    isHome,
    venue: isHome ? 'H' : 'A',
    fdr: difficulty,
    kickoff: fixture.kickoff_time || null,
    xMins: fixtureXmins,
    xPts: round(Math.max(0, projectedPoints)),
    attackingXPts: round(goalPoints + assistPoints, 2),
    tone: fixtureTone(difficulty),
  };
}

function buildCandidate({ player, playerFixtures, teamsById, referenceMatches, baselines, useNextRoundChance, useOfficialProjection }) {
  const availability = availabilityFor(player, useNextRoundChance);
  const xMins = estimateExpectedMinutes(player, referenceMatches, availability);
  if (!playerFixtures.length || xMins < 20) return null;

  const position = POSITION_MAP[player.element_type - 1];
  const form = number(player.form);
  const ppg = number(player.points_per_game);
  const effectiveForm = form > 0 ? form : ppg;
  const xG90 = shrunkRate(player, 'expected_goals_per_90', baselines[player.element_type].xG90);
  const xA90 = shrunkRate(player, 'expected_assists_per_90', baselines[player.element_type].xA90);
  const officialProjection = useOfficialProjection ? number(player.ep_next) : 0;
  const roles = describeRole(player);
  const fixtures = playerFixtures.map((fixture, fixtureIndex) => {
    const projection = projectFixture({
      player,
      fixture,
      fixtureIndex,
      xMins,
      xG90,
      xA90,
      form: effectiveForm,
      ppg,
      position,
      officialProjection,
    });
    const opponent = teamsById.get(projection.opponentId);
    return {
      ...projection,
      opponent: opponent?.short_name || '?',
      opponentFull: opponent?.name || 'Opponent',
      label: `${opponent?.short_name || '?'} (${projection.venue})`,
    };
  });

  const totalXpts = round(fixtures.reduce((sum, fixture) => sum + fixture.xPts, 0));
  const totalXmins = fixtures.reduce((sum, fixture) => sum + fixture.xMins, 0);
  const attackingXpts = fixtures.reduce((sum, fixture) => sum + fixture.attackingXPts, 0);
  const ownership = number(player.selected_by_percent);
  const roleBoost = (number(player.penalties_order) === 1 ? 0.3 : 0) +
    (number(player.direct_freekicks_order) === 1 ? 0.1 : 0) +
    (number(player.corners_and_indirect_freekicks_order) === 1 ? 0.1 : 0);
  const upside = round(attackingXpts + roleBoost, 2);
  const fixtureSummary = fixtures.map(fixture => fixture.label).join(' + ');
  const fixtureDetail = fixtures.map(fixture => `${fixture.label}, FDR ${fixture.fdr}`).join('; ');
  const formText = form > 0 ? `${form.toFixed(1)} form` : `${ppg.toFixed(1)} season PPG baseline`;
  const roleText = roles.length ? ` Role: ${roles.join(', ')}.` : '';
  const profileText = position === 'MID' || position === 'FWD'
    ? `${round(xG90 + xA90, 2).toFixed(2)} xGI/90`
    : position === 'GKP'
      ? `${number(player.saves_per_90).toFixed(1)} saves/90`
      : `${number(player.clean_sheets)} clean sheets`;
  const confidence = xMins >= 78 && availability === 1 ? 'High' : xMins >= 60 && availability >= 0.75 ? 'Medium' : 'Managed risk';

  return {
    id: player.id,
    name: player.web_name,
    fullName: [player.first_name, player.second_name].filter(Boolean).join(' '),
    code: player.code,
    team: teamsById.get(player.team)?.short_name || '?',
    teamFull: teamsById.get(player.team)?.name || 'Unknown',
    position,
    cost: number(player.now_cost) / 10,
    form: round(form),
    formUsed: round(effectiveForm),
    formSource: form > 0 ? 'form' : 'season PPG',
    ppg: round(ppg),
    xG90: round(xG90, 2),
    xA90: round(xA90, 2),
    xGI90: round(xG90 + xA90, 2),
    savesPer90: round(number(player.saves_per_90), 1),
    xMins: totalXmins,
    xMinsPerFixture: xMins,
    xPts: totalXpts,
    ownership: round(ownership),
    availability: round(availability * 100, 0),
    confidence,
    roles,
    fixtures,
    fixtureSummary,
    upside,
    reason: `${fixtureDetail}. ${totalXmins} xMins, ${profileText} and ${formText} produce ${totalXpts.toFixed(1)} xPts.${roleText}`,
  };
}

function buildPickExplanation(pick, bestPick, isDifferential) {
  const profile = pick.position === 'MID' || pick.position === 'FWD'
    ? `${pick.xGI90.toFixed(2)} xGI/90`
    : pick.position === 'GKP'
      ? `${number(pick.savesPer90).toFixed(1)} saves/90`
      : 'clean-sheet and attacking routes';
  const fixtureText = pick.fixtures.map(fixture =>
    `${fixture.opponent} (${fixture.venue}) is a ${fixture.tone} FDR ${fixture.fdr} fixture`
  ).join('; ');
  const roleText = pick.roles.length ? ` ${pick.name} also has ${pick.roles.join(' and ')}.` : '';

  if (isDifferential) {
    const gap = round(Math.max(0, bestPick.xPts - pick.xPts));
    return `At ${pick.ownership.toFixed(1)}% ownership, ${pick.name} offers the strongest low-owned projection at ${pick.xPts.toFixed(1)} xPts, ${gap.toFixed(1)} behind the model leader. ${fixtureText}, while ${pick.xMins} xMins and ${profile} support the upside.${roleText}`;
  }

  return `${pick.name} leads the model at ${pick.xPts.toFixed(1)} xPts. ${fixtureText}. ${pick.xMins} xMins limits appearance risk, while ${profile} and a ${pick.formUsed.toFixed(1)} ${pick.formSource} rating provide the strongest overall points profile.${roleText}`;
}

function buildCaptaincyModel({ bootstrap, fixtures, selectedGW }) {
  const events = bootstrap.events || [];
  const elements = bootstrap.elements || [];
  const teams = bootstrap.teams || [];
  const teamsById = new Map(teams.map(team => [team.id, team]));
  const currentGW = events.find(event => event.is_current)?.id || null;
  const nextGW = events.find(event => event.is_next)?.id || currentGW || 1;
  const requestedGW = Number.parseInt(selectedGW, 10);
  const gameweek = Number.isInteger(requestedGW) && requestedGW >= 1 && requestedGW <= 38 ? requestedGW : nextGW;
  const availableGameweeks = [...new Set(fixtures.map(fixture => fixture.event).filter(Boolean))].sort((a, b) => a - b);
  const gwFixtures = fixtures.filter(fixture => fixture.event === gameweek && !fixture.finished);
  const fixturesByTeam = new Map();
  gwFixtures.forEach(fixture => {
    [fixture.team_h, fixture.team_a].forEach(teamId => {
      if (!fixturesByTeam.has(teamId)) fixturesByTeam.set(teamId, []);
      fixturesByTeam.get(teamId).push(fixture);
    });
  });
  fixturesByTeam.forEach(teamFixtures => teamFixtures.sort((a, b) =>
    String(a.kickoff_time || '').localeCompare(String(b.kickoff_time || ''))
  ));

  const seasonHasStarted = fixtures.some(fixture => fixture.started || fixture.finished);
  const completedMatchesByTeam = new Map(teams.map(team => [
    team.id,
    fixtures.filter(fixture => fixture.finished && (fixture.team_h === team.id || fixture.team_a === team.id)).length,
  ]));
  const baselines = buildPositionBaselines(elements);
  const useNextRoundChance = gameweek === nextGW;
  const useOfficialProjection = gameweek === nextGW;

  const candidates = elements
    .filter(player => fixturesByTeam.has(player.team) && player.special !== true)
    .map(player => buildCandidate({
      player,
      playerFixtures: fixturesByTeam.get(player.team),
      teamsById,
      referenceMatches: seasonHasStarted
        ? Math.max(completedMatchesByTeam.get(player.team) || 0, number(player.starts), 1)
        : 38,
      baselines,
      useNextRoundChance,
      useOfficialProjection,
    }))
    .filter(Boolean)
    .sort((a, b) => b.xPts - a.xPts || b.upside - a.upside || b.xMins - a.xMins);

  const bestPick = candidates[0] || null;
  const topPicks = candidates.slice(0, 5).map((candidate, index) => ({ ...candidate, rank: index + 1 }));
  let differentialThreshold = 10;
  let differentialPick = candidates.find(candidate =>
    candidate.id !== bestPick?.id &&
    ['MID', 'FWD'].includes(candidate.position) &&
    candidate.ownership < differentialThreshold &&
    candidate.xMinsPerFixture >= 60 &&
    candidate.xPts >= Math.max(4, (bestPick?.xPts || 0) * 0.7)
  );
  if (!differentialPick) {
    differentialThreshold = 15;
    differentialPick = candidates.find(candidate =>
      candidate.id !== bestPick?.id &&
      ['MID', 'FWD'].includes(candidate.position) &&
      candidate.ownership < differentialThreshold &&
      candidate.xMinsPerFixture >= 55
    ) || candidates.find(candidate => candidate.id !== bestPick?.id && ['MID', 'FWD'].includes(candidate.position)) || null;
  }

  const rankedDifferential = differentialPick
    ? { ...differentialPick, overallRank: candidates.findIndex(candidate => candidate.id === differentialPick.id) + 1 }
    : null;

  return {
    gameweek,
    selectedGW: gameweek,
    currentGW,
    nextGW,
    availableGameweeks,
    generatedAt: new Date().toISOString(),
    modelVersion: 'Captaincy xPts 2.0',
    modelInputs: ['fixtures', 'form', 'xMins', 'xG', 'xA', 'PPG', 'availability', 'set pieces', 'bonus'],
    bestPick: bestPick ? { ...bestPick, explanation: buildPickExplanation(bestPick, bestPick, false) } : null,
    differentialPick: rankedDifferential ? {
      ...rankedDifferential,
      threshold: differentialThreshold,
      explanation: buildPickExplanation(rankedDifferential, bestPick, true),
    } : null,
    topPicks,
  };
}

function buildPlayerProjections({ bootstrap, fixtures, startGW, horizon = 5 }) {
  const events = bootstrap.events || [];
  const elements = bootstrap.elements || [];
  const teams = bootstrap.teams || [];
  const teamsById = new Map(teams.map(team => [team.id, team]));
  const currentGW = events.find(event => event.is_current)?.id || null;
  const nextGW = events.find(event => event.is_next)?.id || currentGW || 1;
  const requestedGW = Number.parseInt(startGW, 10);
  const firstGW = Number.isInteger(requestedGW) && requestedGW >= 1 && requestedGW <= 38 ? requestedGW : nextGW;
  const safeHorizon = clamp(Number.parseInt(horizon, 10) || 5, 1, 8);
  const gameweeks = Array.from({ length: Math.min(safeHorizon, 39 - firstGW) }, (_, index) => firstGW + index);
  const seasonHasStarted = fixtures.some(fixture => fixture.started || fixture.finished);
  const completedMatchesByTeam = new Map(teams.map(team => [
    team.id,
    fixtures.filter(fixture => fixture.finished && (fixture.team_h === team.id || fixture.team_a === team.id)).length,
  ]));
  const baselines = buildPositionBaselines(elements);

  const projections = elements.map(player => {
    const buildForGameweek = gameweek => {
      const playerFixtures = fixtures
        .filter(fixture => fixture.event === gameweek && !fixture.finished && (fixture.team_h === player.team || fixture.team_a === player.team))
        .sort((a, b) => String(a.kickoff_time || '').localeCompare(String(b.kickoff_time || '')));
      if (!playerFixtures.length) return null;
      return buildCandidate({
        player,
        playerFixtures,
        teamsById,
        referenceMatches: seasonHasStarted
          ? Math.max(completedMatchesByTeam.get(player.team) || 0, number(player.starts), 1)
          : 38,
        baselines,
        useNextRoundChance: gameweek === nextGW,
        useOfficialProjection: gameweek === nextGW,
      });
    };
    const candidates = gameweeks.map(buildForGameweek);
    const weekly = candidates.map((candidate, index) => candidate
      ? { gameweek: gameweeks[index], xPts: candidate.xPts, xMins: candidate.xMins, fixtures: candidate.fixtures, confidence: candidate.confidence }
      : { gameweek: gameweeks[index], xPts: 0, xMins: 0, fixtures: [], confidence: 'Blank' });
    const firstCandidate = candidates[0];
    const totalXpts = round(weekly.reduce((sum, week) => sum + week.xPts, 0));
    const availability = availabilityFor(player, firstGW === nextGW);
    const xMins = weekly[0]?.xMins || 0;
    const uncertainty = clamp(0.18 + ((90 - Math.min(xMins, 90)) / 90 * 0.42) + ((1 - availability) * 0.35), 0.16, 0.72);

    return {
      id: player.id,
      name: player.web_name,
      fullName: [player.first_name, player.second_name].filter(Boolean).join(' '),
      code: player.code,
      teamId: player.team,
      team: teamsById.get(player.team)?.short_name || '?',
      position: POSITION_MAP[player.element_type - 1],
      elementType: player.element_type,
      cost: number(player.now_cost) / 10,
      ownership: round(number(player.selected_by_percent)),
      form: round(number(player.form)),
      xGI90: firstCandidate?.xGI90 || round(number(player.expected_goal_involvements_per_90), 2),
      roles: firstCandidate?.roles || describeRole(player),
      availability: round(availability * 100, 0),
      status: player.status || 'a',
      news: player.news || '',
      totalXpts,
      xPtsPerMillion: round(totalXpts / Math.max(number(player.now_cost) / 10, 0.1), 2),
      weekly,
      range: {
        low: round(totalXpts * (1 - uncertainty)),
        expected: totalXpts,
        high: round(totalXpts * (1 + uncertainty + Math.min(number(player.expected_goal_involvements_per_90), 1) * 0.12)),
      },
      returnProbability: round(clamp(1 - Math.exp(-Math.max(totalXpts - gameweeks.length, 0) / 4), 0.04, 0.88) * 100, 0),
      haulProbability: round(clamp((totalXpts / Math.max(gameweeks.length, 1) - 3) * 8 + number(player.expected_goal_involvements_per_90) * 18, 2, 58), 0),
      confidence: firstCandidate?.confidence || (availability === 0 ? 'Unavailable' : 'Low sample'),
    };
  }).sort((a, b) => b.totalXpts - a.totalXpts || b.xPtsPerMillion - a.xPtsPerMillion);

  return { startGW: firstGW, nextGW, gameweeks, horizon: gameweeks.length, projections };
}

module.exports = {
  buildCaptaincyModel,
  buildPlayerProjections,
  estimateExpectedMinutes,
};
