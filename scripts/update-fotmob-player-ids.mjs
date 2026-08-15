import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const REEP_PEOPLE_URL = 'https://raw.githubusercontent.com/withqwerty/reep/main/data/people.csv';
const REEP_META_URL = 'https://raw.githubusercontent.com/withqwerty/reep/main/data/meta.json';
const FPL_BOOTSTRAP_URL = 'https://fantasy.premierleague.com/api/bootstrap-static/';

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

const [peopleCsv, reepMeta, bootstrap] = await Promise.all([
  fetchText(REEP_PEOPLE_URL),
  fetch(REEP_META_URL).then(response => {
    if (!response.ok) throw new Error(`Failed to fetch Reep metadata: HTTP ${response.status}`);
    return response.json();
  }),
  fetch(FPL_BOOTSTRAP_URL).then(response => {
    if (!response.ok) throw new Error(`Failed to fetch FPL bootstrap: HTTP ${response.status}`);
    return response.json();
  }),
]);

const rows = peopleCsv.split(/\r?\n/);
const headers = parseCsvRow(rows.shift());
const optaIndex = headers.indexOf('key_opta_numeric');
const fotmobIndex = headers.indexOf('key_fotmob');
if (optaIndex < 0 || fotmobIndex < 0) throw new Error('Reep CSV is missing required ID columns');

const fotmobByOpta = new Map();
for (const row of rows) {
  if (!row) continue;
  const values = parseCsvRow(row);
  const optaId = values[optaIndex];
  const fotmobId = values[fotmobIndex];
  if (/^\d+$/.test(optaId) && /^\d+$/.test(fotmobId)) fotmobByOpta.set(optaId, Number(fotmobId));
}

const currentPlayers = Object.fromEntries(
  bootstrap.elements
    .map(player => [String(player.code), fotmobByOpta.get(String(player.code))])
    .filter(([, fotmobId]) => Number.isInteger(fotmobId))
    .sort(([left], [right]) => Number(left) - Number(right))
);

const output = {
  source: 'Reep football identity register (reep.football)',
  sourceUrl: REEP_PEOPLE_URL,
  license: 'CC0-1.0',
  reepDataVersion: reepMeta.data_version,
  reepGeneratedAt: reepMeta.generated_at,
  generatedAt: new Date().toISOString(),
  matchedPlayers: Object.keys(currentPlayers).length,
  totalPlayers: bootstrap.elements.length,
  byOptaId: currentPlayers,
};

const outputPath = path.resolve('public/fotmob-player-ids.json');
await mkdir(path.dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(output, null, 2)}\n`);
console.log(`Mapped ${output.matchedPlayers}/${output.totalPlayers} current FPL players to FotMob IDs`);
