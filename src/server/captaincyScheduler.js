/**
 * captaincyScheduler.js
 * 
 * Pre-generates captaincy picks for ALL upcoming gameweeks and stores
 * them in the DB (or disk fallback). The captain-picks API reads from
 * this store instead of calculating live on every page load.
 * 
 * Runs on server startup and every 24 hours to keep picks fresh.
 */

const fs = require('fs');
const path = require('path');
const logger = require('./logger');

const STALENESS_MS = 24 * 60 * 60 * 1000; // 24 hours
const FUTURE_GW_COUNT = 6;
const SNAPSHOT_DIR = path.join(__dirname, '../../data/captaincy_snapshots');

// Ensure disk dir exists
if (!fs.existsSync(SNAPSHOT_DIR)) {
  try { fs.mkdirSync(SNAPSHOT_DIR, { recursive: true }); } catch {}
}

let isRunning = false;
let refreshTimer = null;

function getDeps() {
  const { getCachedApiData } = require('./cache');
  const { buildCaptaincyModel } = require('../captaincyModel');
  let sql;
  try { sql = require('./db').sql; } catch {}
  return { getCachedApiData, buildCaptaincyModel, sql };
}

function getUpcomingGWs(bootstrap) {
  const events = bootstrap?.events;
  if (!events || !Array.isArray(events)) return [];
  const upcoming = [];
  for (const ev of events) {
    if (!ev.finished) upcoming.push(ev.id);
    if (upcoming.length >= FUTURE_GW_COUNT) break;
  }
  return upcoming;
}

function diskPath(gw) {
  return path.join(SNAPSHOT_DIR, `gw_${gw}.json`);
}

/**
 * Get all GWs that have pre-saved picks (DB first, then disk).
 * Returns sorted array of GW numbers, newest first.
 */
async function getAllStoredGWs(sql) {
  const gwSet = new Set();

  // DB
  if (sql) {
    try {
      const rows = await sql`SELECT gameweek FROM captain_snapshots WHERE data->>'bestPick' IS NOT NULL ORDER BY gameweek ASC`;
      rows.forEach(r => gwSet.add(r.gameweek));
    } catch {}
  }

  // Disk
  try {
    if (fs.existsSync(SNAPSHOT_DIR)) {
      const files = fs.readdirSync(SNAPSHOT_DIR).filter(f => f.startsWith('gw_') && f.endsWith('.json'));
      for (const f of files) {
        const gw = parseInt(f.replace('gw_', '').replace('.json', ''), 10);
        if (!isNaN(gw)) {
          // Verify file has valid data
          try {
            const raw = JSON.parse(fs.readFileSync(path.join(SNAPSHOT_DIR, f), 'utf8'));
            if (raw && raw.bestPick) gwSet.add(gw);
          } catch {}
        }
      }
    }
  } catch {}

  return [...gwSet].sort((a, b) => a - b);
}

/**
 * Read stored picks — tries DB first, then disk fallback.
 */
async function getStoredPicks(gw, sql) {
  // Try DB
  if (sql) {
    try {
      const rows = await sql`SELECT data, created_at FROM captain_snapshots WHERE gameweek = ${gw} LIMIT 1`;
      if (rows.length > 0 && rows[0].data) {
        const data = typeof rows[0].data === 'string' ? JSON.parse(rows[0].data) : rows[0].data;
        if (data && data.bestPick && (data.topPicks || []).length > 0) {
          const ageMs = rows[0].created_at ? (Date.now() - new Date(rows[0].created_at).getTime()) : Infinity;
          return { data, generatedAt: data.generatedAt, isStale: data.isDeadlineLocked ? false : ageMs > STALENESS_MS };
        }
      }
    } catch (e) {
      logger.warn({ err: e.message, gw }, 'Failed reading captain picks from DB');
    }
  }

  // Try disk
  const fp = diskPath(gw);
  if (fs.existsSync(fp)) {
    try {
      const raw = JSON.parse(fs.readFileSync(fp, 'utf8'));
      if (raw && raw.bestPick && (raw.topPicks || []).length > 0) {
        const stat = fs.statSync(fp);
        const ageMs = Date.now() - stat.mtimeMs;
        return { data: raw, generatedAt: raw.generatedAt, isStale: raw.isDeadlineLocked ? false : ageMs > STALENESS_MS };
      }
    } catch (e) {
      logger.warn({ err: e.message, gw }, 'Failed reading captain picks from disk');
    }
  }

  return null;
}

/**
 * Store picks to DB and disk.
 */
async function storePicks(gw, model, sql) {
  if (!model.bestPick && (!model.topPicks || model.topPicks.length === 0)) {
    logger.warn({ gw }, 'Skipping empty captaincy model');
    return;
  }

  const snapshot = {
    gameweek: gw,
    generatedAt: model.generatedAt || new Date().toISOString(),
    modelVersion: model.modelVersion,
    modelInputs: model.modelInputs,
    isDeadlineLocked: false,
    lockedAt: null,
    bestPick: model.bestPick ? JSON.parse(JSON.stringify(model.bestPick)) : null,
    differentialPick: model.differentialPick ? JSON.parse(JSON.stringify(model.differentialPick)) : null,
    topPicks: (model.topPicks || []).map(p => JSON.parse(JSON.stringify(p)))
  };

  // Save to DB
  if (sql) {
    try {
      await sql`INSERT INTO captain_snapshots (gameweek, data) VALUES (${gw}, ${JSON.stringify(snapshot)}) ON CONFLICT (gameweek) DO UPDATE SET data = ${JSON.stringify(snapshot)}, created_at = NOW()`;
    } catch (e) {
      logger.warn({ err: e.message, gw }, 'Failed storing picks to DB');
    }
  }

  // Save to disk (always — works locally and on Vercel)
  try {
    fs.writeFileSync(diskPath(gw), JSON.stringify(snapshot, null, 2), 'utf8');
  } catch (e) {
    logger.warn({ err: e.message, gw }, 'Failed writing picks to disk');
  }

  logger.info({ gw, picksCount: snapshot.topPicks?.length || 0 }, 'Stored pre-generated captain picks');
}

/**
 * Generate picks for a single GW.
 */
async function generateForGW(gw, bootstrap, fixtures, buildCaptaincyModel, sql) {
  try {
    // Attach availableGameweeks to the model so it's stored
    const events = bootstrap?.events || [];
    const rawModel = await buildCaptaincyModel({ bootstrap, fixtures, selectedGW: gw });
    rawModel.availableGameweeks = events.filter(e => !e.finished).map(e => e.id);
    await storePicks(gw, rawModel, sql);
    return rawModel;
  } catch (e) {
    logger.warn({ err: e.message, gw }, 'Failed generating captain picks');
    return null;
  }
}

/**
 * Main: pre-generate picks for all upcoming GWs.
 */
async function preGenerateAll() {
  if (isRunning) {
    logger.info('Captaincy pre-generation already running, skipping');
    return;
  }
  isRunning = true;
  const startTime = Date.now();

  try {
    const { getCachedApiData, buildCaptaincyModel, sql } = getDeps();
    const BOOTSTRAP_URL = 'https://fantasy.premierleague.com/api/bootstrap-static/';
    const FIXTURES_URL = 'https://fantasy.premierleague.com/api/fixtures/';

    const [bootstrap, fixtures] = await Promise.all([
      getCachedApiData(BOOTSTRAP_URL),
      getCachedApiData(FIXTURES_URL)
    ]);

    if (!bootstrap || !fixtures) {
      logger.warn('Captaincy pre-generation: missing bootstrap or fixtures');
      return;
    }

    bootstrap.fixtures = fixtures;

    const upcomingGWs = getUpcomingGWs(bootstrap);
    if (upcomingGWs.length === 0) {
      logger.info('No upcoming gameweeks for captaincy pre-generation');
      return;
    }

    logger.info({ upcomingGWs }, 'Starting captaincy pre-generation');

    for (const gw of upcomingGWs) {
      const stored = await getStoredPicks(gw, sql);
      if (stored && !stored.isStale) {
        logger.info({ gw }, 'Skipping GW — picks already fresh');
        continue;
      }
      await generateForGW(gw, bootstrap, fixtures, buildCaptaincyModel, sql);
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    logger.info({ gwsGenerated: upcomingGWs.length, elapsed: `${elapsed}s` }, 'Captaincy pre-generation complete');
  } catch (e) {
    logger.error({ err: e.message }, 'Captaincy pre-generation failed');
  } finally {
    isRunning = false;
  }
}

function startRefreshTimer() {
  if (refreshTimer) return;
  refreshTimer = setInterval(() => {
    preGenerateAll().catch(() => {});
  }, STALENESS_MS);
  if (refreshTimer.unref) refreshTimer.unref();
  logger.info('Captaincy refresh timer started (every 24 hours)');
}

function initCaptaincyScheduler() {
  preGenerateAll().catch(() => {});
  startRefreshTimer();
}

module.exports = {
  initCaptaincyScheduler,
  preGenerateAll,
  getStoredPicks,
  getAllStoredGWs,
  storePicks,
  STALENESS_MS,
};
