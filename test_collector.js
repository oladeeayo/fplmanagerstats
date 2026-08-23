const logger = require('./src/server/logger');

async function testCollector() {
  // Simulate what collectAllHistoricalStats does
  const { parseCSV, fetchCSV } = (() => {
    // Inline the parse/fetch from historicalCollector to test directly
    const OWN_REPO_BASE = 'https://raw.githubusercontent.com/oladeeayo/fplmanagerstats/main/data/historical';

    function parseCSV(text) {
      const lines = text.split('\n').filter(l => l.trim());
      if (lines.length < 2) return [];
      const headers = lines[0].split(',').map(h => h.trim().replace(/^"|"$/g, ''));
      return lines.slice(1).map(line => {
        const vals = [];
        let current = '';
        for (let i = 0; i < line.length; i++) {
          if (line[i] === '"') { i++; while (i < line.length && line[i] !== '"') { current += line[i]; i++; } continue; }
          if (line[i] === ',') { vals.push(current.trim()); current = ''; continue; }
          current += line[i];
        }
        vals.push(current.trim());
        const row = {};
        headers.forEach((h, idx) => { row[h] = vals[idx] || ''; });
        return row;
      });
    }

    async function fetchCSV(season, filename) {
      const url = `${OWN_REPO_BASE}/${season}/${filename}`;
      const res = await fetch(url, { headers: { 'User-Agent': 'FPLManagerStats/1.0' } });
      if (!res.ok) throw new Error(`${res.status}`);
      const text = await res.text();
      return parseCSV(text);
    }

    return { parseCSV, fetchCSV };
  })();

  console.log('=== Fetching 2024-25 CSV ===');
  const rows = await fetchCSV('2024-25', 'merged_gw.csv');
  console.log('Total rows:', rows.length);

  // Check a known player
  const haalandRows = rows.filter(r => r.name === 'Erling Haaland');
  console.log('Haaland rows:', haalandRows.length);
  if (haalandRows.length > 0) {
    const gw1 = haalandRows[0];
    console.log('GW1:', {
      name: gw1.name,
      element: gw1.element,
      total_points: gw1.total_points,
      minutes: gw1.minutes,
      expected_goals: gw1.expected_goals,
      opponent_team: gw1.opponent_team,
      was_home: gw1.was_home,
    });
  }

  // Check how names appear
  const uniqueNames = [...new Set(rows.map(r => r.name))];
  console.log('Unique players:', uniqueNames.length);

  // Check Bruno
  const brunoRows = rows.filter(r => r.name.includes('Bruno'));
  console.log('Bruno rows:', brunoRows.length, brunoRows[0]?.name);

  // Check Salah
  const salahRows = rows.filter(r => r.name.includes('Salah'));
  console.log('Salah rows:', salahRows.length, salahRows[0]?.name);

  // Check Saka
  const sakaRows = rows.filter(r => r.name.includes('Saka'));
  console.log('Saka rows:', sakaRows.length, sakaRows[0]?.name);

  // Now test bootstrap fetch (the lazy require)
  console.log('\n=== Testing lazy require of cache ===');
  try {
    const { getCachedApiData, BOOTSTRAP_URL, BOOTSTRAP_CACHE_TTL } = require('./src/server/cache');
    console.log('getCachedApiData type:', typeof getCachedApiData);
    console.log('BOOTSTRAP_URL:', BOOTSTRAP_URL);

    const bootstrap = await getCachedApiData(BOOTSTRAP_URL, BOOTSTRAP_CACHE_TTL);
    console.log('Bootstrap elements:', bootstrap?.elements?.length || 0);

    if (bootstrap?.elements) {
      const haaland = bootstrap.elements.find(e => e.web_name === 'Haaland');
      console.log('Haaland in bootstrap:', haaland ? { id: haaland.id, web_name: haaland.web_name, first_name: haaland.first_name } : 'NOT FOUND');
      const bruno = bootstrap.elements.find(e => e.web_name === 'B.Fernandes');
      console.log('Bruno in bootstrap:', bruno ? { id: bruno.id, web_name: bruno.web_name } : 'NOT FOUND');
      const salah = bootstrap.elements.find(e => e.web_name === 'Salah');
      console.log('Salah in bootstrap:', salah ? { id: salah.id, web_name: salah.web_name } : 'NOT FOUND');
    }
  } catch (e) {
    console.log('Lazy require failed:', e.message);
    console.log('Stack:', e.stack?.split('\n').slice(0, 5).join('\n'));
  }
}

testCollector().catch(e => console.error('FATAL:', e));
