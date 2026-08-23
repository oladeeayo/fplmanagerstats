const fs = require('fs');
const path = require('path');
const logger = require('./logger');
const { checkAndCollect } = require('./playerAdvancedCollector');
// historicalCollector is lazily required in initSnapshotManager to prevent circular dependency with cache.js

const SNAPSHOT_DIR = path.join(__dirname, 'data');
const SNAPSHOT_FILE = path.join(SNAPSHOT_DIR, 'snapshot.json');

// Timing constants
const PRE_DEADLINE_MS = 2 * 60 * 1000;  // 2 minutes before deadline
const PRE_MATCH_MS = 20 * 60 * 1000;   // 20 minutes before first match

let snapshotData = null; // { gwId, timestamp, snapshotStartTime, snapshotEndTime, bootstrap, fixtures }
let isSnapshotActiveFlag = false;
let forceMode = null; // null | 'snapshot' | 'live'
let currentSchedule = null;
let intervalId = null;

/**
 * Load saved snapshot from disk if present.
 */
function loadSnapshotFromDisk() {
  try {
    if (fs.existsSync(SNAPSHOT_FILE)) {
      const raw = fs.readFileSync(SNAPSHOT_FILE, 'utf8');
      snapshotData = JSON.parse(raw);
      logger.info({ gwId: snapshotData?.gwId, timestamp: snapshotData?.timestamp }, 'Loaded site snapshot from disk');
      return snapshotData;
    }
  } catch (err) {
    logger.warn({ err: err.message }, 'Failed to load snapshot from disk');
  }
  return null;
}

/**
 * Save snapshot payload to disk.
 */
function saveSnapshotToDisk(data) {
  try {
    if (!fs.existsSync(SNAPSHOT_DIR)) {
      fs.mkdirSync(SNAPSHOT_DIR, { recursive: true });
    }
    fs.writeFileSync(SNAPSHOT_FILE, JSON.stringify(data, null, 2), 'utf8');
  } catch (err) {
    logger.error({ err: err.message }, 'Failed to write snapshot to disk');
  }
}

/**
 * Update rolling backup on disk when fresh bootstrap or fixtures arrive during live operation.
 */
function saveRollingBackup(bootstrap, fixtures) {
  if (isSnapshotActive()) return; // Don't overwrite during snapshot mode

  if (!snapshotData) {
    snapshotData = { timestamp: Date.now() };
  }
  if (bootstrap) snapshotData.bootstrap = bootstrap;
  if (fixtures) snapshotData.fixtures = fixtures;
  snapshotData.timestamp = Date.now();

  saveSnapshotToDisk(snapshotData);
}

/**
 * Compute the deadline and first-match schedule for current or upcoming GW.
 */
function calculateSchedule(bootstrap, fixtures) {
  if (!bootstrap || !Array.isArray(bootstrap.events)) return null;

  const now = Date.now();
  const events = bootstrap.events;

  // Find active or upcoming gameweek
  // Preference: next event -> current event -> event with future deadline -> latest event
  let event = events.find(e => e.is_next)
    || events.find(e => e.is_current)
    || events.find(e => new Date(e.deadline_time).getTime() > now - 24 * 60 * 60 * 1000)
    || events[events.length - 1];

  if (!event || !event.deadline_time) return null;

  const deadlineMs = new Date(event.deadline_time).getTime();

  // Find earliest kickoff for this GW in fixtures
  let firstMatchMs = deadlineMs + (90 * 60 * 1000); // default 90m after deadline if fixtures unassigned
  if (Array.isArray(fixtures)) {
    const gwFixtures = fixtures.filter(f => f.event === event.id && f.kickoff_time);
    if (gwFixtures.length > 0) {
      const kickoffTimes = gwFixtures.map(f => new Date(f.kickoff_time).getTime()).sort((a, b) => a - b);
      if (kickoffTimes[0]) {
        firstMatchMs = kickoffTimes[0];
      }
    }
  }

  const snapshotStartMs = deadlineMs - PRE_DEADLINE_MS;
  const snapshotEndMs = firstMatchMs - PRE_MATCH_MS;

  return {
    gwId: event.id,
    gwName: event.name,
    deadlineTime: new Date(deadlineMs).toISOString(),
    snapshotStartTime: new Date(snapshotStartMs).toISOString(),
    firstMatchTime: new Date(firstMatchMs).toISOString(),
    snapshotEndTime: new Date(snapshotEndMs).toISOString(),
    deadlineMs,
    firstMatchMs,
    snapshotStartMs,
    snapshotEndMs,
  };
}

/**
 * Capture a complete snapshot of site data (bootstrap & fixtures).
 */
async function takeSnapshot(gwId, schedule, fetcher) {
  try {
    const getCachedApiData = fetcher || require('./cache').getCachedApiData;
    const BOOTSTRAP_URL = 'https://fantasy.premierleague.com/api/bootstrap-static/';
    const FIXTURES_URL = 'https://fantasy.premierleague.com/api/fixtures/';

    const [bootstrap, fixtures] = await Promise.all([
      getCachedApiData(BOOTSTRAP_URL, 0).catch(() => snapshotData?.bootstrap || null),
      getCachedApiData(FIXTURES_URL, 0).catch(() => snapshotData?.fixtures || null),
    ]);

    if (!bootstrap || !fixtures) {
      logger.warn({ gwId }, 'Incomplete data for site snapshot; using existing backup');
    }

    snapshotData = {
      gwId: gwId || schedule?.gwId || snapshotData?.gwId || 1,
      timestamp: Date.now(),
      snapshotStartTime: schedule?.snapshotStartTime || null,
      snapshotEndTime: schedule?.snapshotEndTime || null,
      bootstrap: bootstrap || snapshotData?.bootstrap || null,
      fixtures: fixtures || snapshotData?.fixtures || null,
    };

    saveSnapshotToDisk(snapshotData);
    logger.info({ gwId: snapshotData.gwId, deadline: schedule?.deadlineTime }, 'FPL site snapshot captured 2 minutes before deadline');

    // Trigger pre-deadline captaincy model lock
    try {
      if (bootstrap && fixtures) {
        const { buildCaptaincyModel } = require('../captaincyModel');
        const miscRoutes = require('./routes/misc');
        const getOrSaveCaptainSnapshot = miscRoutes.getOrSaveCaptainSnapshot;
        if (typeof getOrSaveCaptainSnapshot === 'function') {
          const rawModel = await buildCaptaincyModel({ bootstrap, fixtures, selectedGW: snapshotData.gwId });
          await getOrSaveCaptainSnapshot(snapshotData.gwId, rawModel, bootstrap.events);
          logger.info({ gwId: snapshotData.gwId }, 'Pre-deadline captaincy model snapshot permanently locked');
        }
      }
    } catch (capErr) {
      logger.warn({ err: capErr.message }, 'Failed locking pre-deadline captain snapshot in snapshotManager');
    }

    return snapshotData;
  } catch (err) {
    logger.error({ err: err.message }, 'Error taking snapshot');
    return snapshotData;
  }
}

/**
 * Evaluate whether snapshot mode should be ACTIVE or INACTIVE based on current time and schedule.
 */
async function evaluateSnapshotState(fetcher) {
  if (forceMode === 'snapshot') {
    isSnapshotActiveFlag = true;
    return;
  }
  if (forceMode === 'live') {
    isSnapshotActiveFlag = false;
    return;
  }

  const now = Date.now();

  try {
    const getCachedApiData = fetcher || require('./cache').getCachedApiData;
    const BOOTSTRAP_URL = 'https://fantasy.premierleague.com/api/bootstrap-static/';
    const FIXTURES_URL = 'https://fantasy.premierleague.com/api/fixtures/';

    let bootstrap = snapshotData?.bootstrap;
    let fixtures = snapshotData?.fixtures;

    if (!bootstrap) {
      bootstrap = await getCachedApiData(BOOTSTRAP_URL).catch(() => null);
    }
    if (!fixtures) {
      fixtures = await getCachedApiData(FIXTURES_URL).catch(() => null);
    }

    if (!bootstrap) return;

    currentSchedule = calculateSchedule(bootstrap, fixtures);
    if (!currentSchedule) return;

    const { snapshotStartMs, snapshotEndMs, gwId, deadlineTime, firstMatchTime, snapshotEndTime } = currentSchedule;

    // Snapshot window: from (deadline - 2 minutes) until (firstMatch - 20 minutes)
    const inWindow = now >= snapshotStartMs && now < snapshotEndMs;

    if (inWindow) {
      if (!isSnapshotActiveFlag) {
        isSnapshotActiveFlag = true;
        logger.info(
          { gwId, deadlineTime, restoreTime: snapshotEndTime },
          'Snapshot mode ACTIVATED: 2 mins before GW deadline. Serving cached site snapshot.'
        );
      }
      // If snapshot is missing or from an old GW, capture it
      if (!snapshotData || snapshotData.gwId !== gwId || !snapshotData.bootstrap) {
        await takeSnapshot(gwId, currentSchedule, fetcher);
      }
    } else {
      if (isSnapshotActiveFlag) {
        isSnapshotActiveFlag = false;
        logger.info(
          { gwId, firstMatchTime },
          'Snapshot mode DEACTIVATED: 20 mins before first GW match. Restoring live FPL API access.'
        );
      }
    }
  } catch (err) {
    logger.warn({ err: err.message }, 'Failed during snapshot evaluation');
  }
}

/**
 * Returns true if the site is currently serving from snapshot (offline/freeze window).
 */
function isSnapshotActive() {
  if (forceMode === 'snapshot') return true;
  if (forceMode === 'live') return false;
  return isSnapshotActiveFlag;
}

/**
 * Returns stored snapshot payload.
 */
function getSnapshotData() {
  return snapshotData;
}

/**
 * Returns current snapshot status and schedule metadata.
 */
function getSnapshotStatus() {
  try {
    let lastSnapshotTimestamp = null;
    if (snapshotData?.timestamp && !isNaN(new Date(snapshotData.timestamp).getTime())) {
      lastSnapshotTimestamp = new Date(snapshotData.timestamp).toISOString();
    }

    return {
      isSnapshotActive: isSnapshotActive(),
      mode: isSnapshotActive() ? 'snapshot' : 'live',
      forceMode,
      currentGW: currentSchedule?.gwId || snapshotData?.gwId || null,
      deadlineTime: currentSchedule?.deadlineTime || null,
      snapshotStartTime: currentSchedule?.snapshotStartTime || null,
      firstMatchTime: currentSchedule?.firstMatchTime || null,
      snapshotEndTime: currentSchedule?.snapshotEndTime || null,
      lastSnapshotTimestamp,
      hasSnapshotData: Boolean(snapshotData && snapshotData.bootstrap && snapshotData.fixtures),
    };
  } catch (err) {
    logger.error({ err: err.message }, 'Error building snapshot status');
    return {
      isSnapshotActive: false,
      mode: 'live',
      forceMode,
      currentGW: null,
      deadlineTime: null,
      snapshotStartTime: null,
      firstMatchTime: null,
      snapshotEndTime: null,
      lastSnapshotTimestamp: null,
      hasSnapshotData: false,
    };
  }
}

/**
 * Set manual override for testing ('snapshot', 'live', or null).
 */
function setForceMode(mode) {
  if (['snapshot', 'live', null].includes(mode)) {
    forceMode = mode;
    logger.info({ forceMode }, 'Snapshot force mode updated');
  }
}

/**
 * Initialize snapshot manager on server startup.
 */
function initSnapshotManager(fetcher) {
  loadSnapshotFromDisk();
  evaluateSnapshotState(fetcher).catch(() => {});
  try {
    const { collectAllHistoricalStats } = require('./historicalCollector');
    collectAllHistoricalStats().catch(() => {});
  } catch { /* ignore if not available */ }

  if (!intervalId) {
    intervalId = setInterval(() => {
      evaluateSnapshotState(fetcher).catch(() => {});
      checkAndCollect().catch(() => {});
    }, 30 * 1000); // Evaluate every 30 seconds
    if (intervalId.unref) intervalId.unref();
  }
}

module.exports = {
  initSnapshotManager,
  evaluateSnapshotState,
  takeSnapshot,
  isSnapshotActive,
  getSnapshotData,
  getSnapshotStatus,
  setForceMode,
  saveRollingBackup,
  calculateSchedule,
  loadSnapshotFromDisk,
};
