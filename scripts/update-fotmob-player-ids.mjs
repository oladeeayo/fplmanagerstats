import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const REEP_PEOPLE_URL = 'https://raw.githubusercontent.com/withqwerty/reep/main/data/people.csv';
const REEP_META_URL = 'https://raw.githubusercontent.com/withqwerty/reep/main/data/meta.json';
const FPL_BOOTSTRAP_URL = 'https://fantasy.premierleague.com/api/bootstrap-static/';
const FOTMOB_LEAGUE_URL = 'https://www.fotmob.com/api/data/leagues?id=47';
const FOTMOB_TEAM_URL = teamId => `https://www.fotmob.com/api/data/teams?id=${teamId}`;
const FOTMOB_SEARCH_URL = name => `https://www.fotmob.com/api/data/search/suggest?term=${encodeURIComponent(name)}`;
const FOTMOB_PLAYER_URL = playerId => `https://www.fotmob.com/api/data/playerData?id=${playerId}`;

// Reviewed exceptions where FPL and FotMob disagree on the display name, DOB, or current loan club.
const VERIFIED_FOTMOB_OVERRIDES = {
  436893: 1027447, // Julian Araujo
  550090: 1321562, // Diego Coppola
  549653: 1292100, // Norman Bassette
  488024: 1047676, // Yeremi Pino
  660392: 1580704, // Christantus Uche
  505079: 1587812, // Alfie McNally
  606930: 1428427, // Nobel Mendy
  546600: 1348497, // Kayne van Oevelen
  465694: 1280132, // Nico Gonzalez
  576620: 1607328, // Bendito Mantato
  640419: 1693398, // Jun'ai Byfield
  499716: 1531854, // James Rowswell
};

function parseCsvRow(row) {
  const values = [];
  let value = '';
  let quoted = false;

  for (let index = 0; index < row.length; index += 1) {
    const character = row[index];
    if (character === '"') {
      if (quoted && row[index + 1] === '"') {
        value += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (character === ',' && !quoted) {
      values.push(value);
      value = '';
    } else {
      value += character;
    }
  }

  values.push(value);
  return values;
}

async function fetchText(url) {
  const response = await fetch(url, { headers: { 'User-Agent': 'fplmanagerstats-data-sync' } });
  if (!response.ok) throw new Error(`Failed to fetch ${url}: HTTP ${response.status}`);
  return response.text();
}

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: {
      Accept: 'application/json',
      'User-Agent': 'fplmanagerstats-fotmob-sync',
    },
  });
  if (!response.ok) throw new Error(`Failed to fetch ${url}: HTTP ${response.status}`);
  return response.json();
}

function normalizeName(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

function sameDate(left, right) {
  return Boolean(left && right && String(left).slice(0, 10) === String(right).slice(0, 10));
}

const [peopleCsv, reepMeta, bootstrap, fotmobLeague] = await Promise.all([
  fetchText(REEP_PEOPLE_URL),
  fetch(REEP_META_URL).then(response => {
    if (!response.ok) throw new Error(`Failed to fetch Reep metadata: HTTP ${response.status}`);
    return response.json();
  }),
  fetch(FPL_BOOTSTRAP_URL).then(response => {
    if (!response.ok) throw new Error(`Failed to fetch FPL bootstrap: HTTP ${response.status}`);
    return response.json();
  }),
  fetchJson(FOTMOB_LEAGUE_URL),
]);

const rows = peopleCsv.split(/\r?\n/);
const headers = parseCsvRow(rows.shift());
const optaIndex = headers.indexOf('key_opta_numeric');
const fotmobIndex = headers.indexOf('key_fotmob');
if (optaIndex < 0 || fotmobIndex < 0) throw new Error('Reep CSV is missing required ID columns');

const fotmobByOpta = new Map();
const reepPeople = [];
for (const row of rows) {
  if (!row) continue;
  const values = parseCsvRow(row);
  const optaId = values[optaIndex];
  const fotmobId = values[fotmobIndex];
  const person = {
    name: values[headers.indexOf('name')],
    fullName: values[headers.indexOf('full_name')],
    dateOfBirth: values[headers.indexOf('date_of_birth')],
    optaId,
    fotmobId,
  };
  if (person.name && person.dateOfBirth && /^\d+$/.test(fotmobId)) reepPeople.push(person);
  if (/^\d+$/.test(optaId) && /^\d+$/.test(fotmobId)) fotmobByOpta.set(optaId, Number(fotmobId));
}

const fotmobTeams = fotmobLeague.table?.[0]?.data?.table?.all || [];
const teamResponses = await Promise.all(fotmobTeams.map(team => fetchJson(FOTMOB_TEAM_URL(team.id))));
const fotmobPlayers = teamResponses.flatMap(teamData => {
  const team = teamData.details || {};
  return (teamData.squad?.squad || [])
    .filter(group => group.title !== 'coach')
    .flatMap(group => (group.members || []).map(player => ({
      id: Number(player.id),
      name: player.name,
      dateOfBirth: player.dateOfBirth,
      teamId: Number(team.id),
      teamName: team.name,
    })));
});

const playersByNameAndDob = new Map();
for (const player of fotmobPlayers) {
  const key = `${normalizeName(player.name)}|${player.dateOfBirth || ''}`;
  const entries = playersByNameAndDob.get(key) || [];
  entries.push(player);
  playersByNameAndDob.set(key, entries);
}

const currentPlayers = {};
const methods = {};
const unresolved = [];
for (const player of bootstrap.elements) {
  const optaId = String(player.code);
  const names = [...new Set([
    player.known_name,
    `${player.first_name} ${player.second_name}`,
    player.web_name,
    player.second_name,
  ].filter(Boolean))];
  const verifiedFotmobId = VERIFIED_FOTMOB_OVERRIDES[optaId];
  if (verifiedFotmobId) {
    currentPlayers[optaId] = verifiedFotmobId;
    methods[optaId] = 'verified-override';
    continue;
  }
  const reepFotmobId = fotmobByOpta.get(optaId);
  if (reepFotmobId) {
    currentPlayers[optaId] = reepFotmobId;
    methods[optaId] = 'reep-opta';
    continue;
  }

  const candidates = names.flatMap(name => playersByNameAndDob.get(`${normalizeName(name)}|${player.birth_date || ''}`) || []);
  const uniqueCandidates = [...new Map(candidates.map(candidate => [candidate.id, candidate])).values()];
  if (uniqueCandidates.length === 1) {
    currentPlayers[optaId] = uniqueCandidates[0].id;
    methods[optaId] = 'fotmob-squad-name-dob';
    continue;
  }

  const reepCandidates = reepPeople.filter(person =>
    sameDate(person.dateOfBirth, player.birth_date)
    && [person.name, person.fullName].some(name => names.some(playerName => normalizeName(name) === normalizeName(playerName)))
  );
  if (reepCandidates.length === 1) {
    currentPlayers[optaId] = Number(reepCandidates[0].fotmobId);
    methods[optaId] = 'reep-name-dob';
    continue;
  }

  unresolved.push({
    code: player.code,
    name: `${player.first_name} ${player.second_name}`,
    names,
    birthDate: player.birth_date,
    teamName: bootstrap.teams.find(team => team.id === player.team)?.name,
  });
}

// Search only players not found in the current senior squads; validate each candidate with FotMob DOB.
for (const player of unresolved) {
  const suggestions = [];
  for (const name of player.names) {
    const search = await fetchJson(FOTMOB_SEARCH_URL(name)).catch(() => []);
    suggestions.push(...(search || []).flatMap(group => group.suggestions || [])
      .filter(candidate => candidate.type === 'player' && !candidate.isCoach));
  }
  const uniqueSuggestions = [...new Map(suggestions.map(candidate => [candidate.id, candidate])).values()];
  const validated = [];
  for (const candidate of uniqueSuggestions.slice(0, 12)) {
    const details = await fetchJson(FOTMOB_PLAYER_URL(candidate.id)).catch(() => null);
    const birthDate = details?.birthDate?.utcTime;
    const exactName = player.names.some(name => normalizeName(name) === normalizeName(candidate.name));
    const sameTeam = normalizeName(candidate.teamName).includes(normalizeName(player.teamName))
      || normalizeName(player.teamName).includes(normalizeName(candidate.teamName));
    if (sameDate(birthDate, player.birthDate) || (!player.birthDate && exactName && sameTeam)) {
      validated.push(Number(candidate.id));
    }
  }
  const uniqueValidated = [...new Set(validated)];
  if (uniqueValidated.length === 1) {
    currentPlayers[String(player.code)] = uniqueValidated[0];
    methods[String(player.code)] = player.birthDate ? 'fotmob-search-name-dob' : 'fotmob-search-name-team';
  }
}

const orderedPlayers = Object.fromEntries(Object.entries(currentPlayers).sort(([left], [right]) => Number(left) - Number(right)));
const methodCounts = Object.values(methods).reduce((counts, method) => ({ ...counts, [method]: (counts[method] || 0) + 1 }), {});
const playerEntries = Object.entries(orderedPlayers);
const unavailablePhotoOptaIds = [];
let nextPhoto = 0;
async function checkPhotos() {
  while (nextPhoto < playerEntries.length) {
    const [optaId, fotmobId] = playerEntries[nextPhoto++];
    const response = await fetch(`https://images.fotmob.com/image_resources/playerimages/${fotmobId}.png`);
    if (!response.ok || !String(response.headers.get('content-type')).startsWith('image/')) {
      unavailablePhotoOptaIds.push(optaId);
    }
    await response.body?.cancel();
  }
}
await Promise.all(Array.from({ length: 12 }, checkPhotos));
unavailablePhotoOptaIds.sort((left, right) => Number(left) - Number(right));

const output = {
  source: 'Reep football identity register (reep.football)',
  sourceUrl: REEP_PEOPLE_URL,
  license: 'CC0-1.0',
  reepDataVersion: reepMeta.data_version,
  reepGeneratedAt: reepMeta.generated_at,
  generatedAt: new Date().toISOString(),
  matchedPlayers: Object.keys(orderedPlayers).length,
  totalPlayers: bootstrap.elements.length,
  availablePhotos: outputPhotoCount(orderedPlayers, unavailablePhotoOptaIds),
  methodCounts,
  unresolved: unresolved.filter(player => !orderedPlayers[String(player.code)]),
  unavailablePhotoOptaIds,
  byOptaId: orderedPlayers,
};

function outputPhotoCount(players, unavailable) {
  return Object.keys(players).length - unavailable.length;
}

const outputPath = path.resolve('public/fotmob-player-ids.json');
await mkdir(path.dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(output, null, 2)}\n`);
console.log(`Mapped ${output.matchedPlayers}/${output.totalPlayers} current FPL players to FotMob IDs`);
