const logger = require('./src/server/logger');

async function traceDataFlow() {
  console.log('=== Step 1: Check if collector can fetch CSVs ===');
  const { fetchCSV } = require('./src/server/historicalCollector');
  try {
    const rows = await fetchCSV('2024-25', 'merged_gw.csv');
    console.log('CSV rows:', rows.length);
    const haaland = rows.find(r => r.name === 'Erling Haaland');
    if (haaland) {
      console.log('Haaland found in CSV:', {
        name: haaland.name,
        position: haaland.position,
        team: haaland.team,
        total_points: haaland.total_points,
        minutes: haaland.minutes,
        expected_goals: haaland.expected_goals,
        expected_assists: haaland.expected_assists,
        was_home: haaland.was_home,
        opponent_team: haaland.opponent_team,
      });
    } else {
      console.log('Haaland NOT found. Sample names:', rows.slice(0, 5).map(r => r.name));
    }
  } catch (e) {
    console.log('CSV fetch failed:', e.message);
  }

  console.log('\n=== Step 2: Check if DB has data ===');
  const { sql } = require('./src/server/db');
  if (!sql) {
    console.log('No DB connection - cannot check');
    return;
  }
  try {
    const rows = await sql`SELECT season, total_players FROM player_historical_stats ORDER BY id DESC LIMIT 3`;
    console.log('DB rows:', rows.length);
    for (const row of rows) {
      console.log(`  Season ${row.season}: ${row.total_players} players`);
      const players = row.players;
      if (Array.isArray(players)) {
        const sample = players[0];
        console.log('  Sample keys:', Object.keys(sample).join(', '));
        console.log('  Has id?', !!sample.id, 'webName?', sample.webName);
        const bruno = players.find(p => p.webName === 'Bruno Fernandes' || p.name?.includes('Bruno'));
        if (bruno) {
          console.log('  Bruno found:', { id: bruno.id, webName: bruno.webName, name: bruno.name });
          console.log('  Bruno crossSeason:', JSON.stringify(bruno.crossSeason || {}).slice(0, 200));
        } else {
          console.log('  Bruno NOT found');
        }
      }
    }
  } catch (e) {
    console.log('DB check failed:', e.message);
  }

  console.log('\n=== Step 3: Check getHistoricalPlayerStats ===');
  const { getHistoricalPlayerStats } = require('./src/server/fplInsightsData');
  try {
    const data = await getHistoricalPlayerStats();
    console.log('Historical data size:', data?.size || 0);
    if (data && data.size > 0) {
      const firstKey = [...data.keys()][0];
      const firstVal = data.get(firstKey);
      console.log('First entry key type:', typeof firstKey, 'key:', firstKey);
      console.log('First entry has crossSeason?', !!firstVal?.crossSeason);
    }
  } catch (e) {
    console.log('getHistoricalPlayerStats failed:', e.message);
  }
}

traceDataFlow().catch(e => console.error('FATAL:', e));
