/**
 * Match Events Cache
 *
 * Background-polls football-data.org during live PL matches.
 * - Live matches: polls every 60s, caches for 60s
 * - Finished matches: caches for 24h (events are final)
 * - No live matches: stops polling entirely
 *
 * Clients read from cache — no direct API calls per request.
 */

const logger = require('./logger');

const FD_API_BASE = 'https://api.football-data.org/v4';
const PL_COMPETITION_ID = 2021; // Premier League

let cachedData = { matches: [] };
let lastFetchTime = 0;
let pollInterval = null;
let isPolling = false;

const LIVE_POLL_MS = 60_000;    // Poll every 60s during live matches
const LIVE_CACHE_MS = 60_000;   // Cache for 60s during live
const FINISHED_CACHE_MS = 24 * 60 * 60 * 1000; // 24h after match finishes

function getApiKey() {
  return process.env.FOOTBALL_API_KEY;
}

async function fetchMatchEvents() {
  const apiKey = getApiKey();
  if (!apiKey) return null;

  try {
    // Fetch live + recently finished PL matches (comma-separated statuses for v4 API)
    const now = new Date();
    const season = now.getMonth() >= 7 ? now.getFullYear() : now.getFullYear() - 1;
    const resp = await fetch(
      `${FD_API_BASE}/competitions/${PL_COMPETITION_ID}/matches?status=LIVE,IN_PLAY,PAUSED,FINISHED&season=${season}`,
      { headers: { 'X-Auth-Token': apiKey } }
    );

    if (!resp.ok) {
      logger.warn({ status: resp.status }, 'football-data.org request failed');
      return null;
    }

    const data = await resp.json();
    const now = Date.now();
    logger.info({ matchCount: data.matches?.length ?? 0, season }, 'football-data.org response received');

    const matches = (data.matches || [])
      .filter(m => {
        // Keep live matches and matches finished within the last 2 hours
        if (['IN_PLAY', 'PAUSED', 'TIMED'].includes(m.status)) return true;
        if (m.status === 'FINISHED') {
          const matchEnd = new Date(m.utcDate).getTime() + 2 * 60 * 60 * 1000;
          return now < matchEnd;
        }
        return false;
      })
      .map(m => ({
        id: m.id,
        utcDate: m.utcDate,
        status: m.status,
        minute: m.minute,
        homeTeam: {
          id: m.homeTeam.id,
          name: m.homeTeam.shortName || m.homeTeam.name,
          tla: m.homeTeam.tla,
        },
        awayTeam: {
          id: m.awayTeam.id,
          name: m.awayTeam.shortName || m.awayTeam.name,
          tla: m.awayTeam.tla,
        },
        score: m.score,
        goals: (m.goals || []).map(g => ({
          minute: g.minute,
          injuryTime: g.injuryTime,
          type: g.type,
          scorer: g.scorer ? { id: g.scorer.id, name: g.scorer.name } : null,
          assist: g.assist ? { id: g.assist.id, name: g.assist.name } : null,
          team: g.team ? { id: g.team.id, name: g.team.name } : null,
          score: g.score,
        })),
        bookings: (m.bookings || []).map(b => ({
          minute: b.minute,
          injuryTime: b.injuryTime,
          player: b.player ? { id: b.player.id, name: b.player.name } : null,
          team: b.team ? { id: b.team.id, name: b.team.name } : null,
          card: b.card,
        })),
        substitutions: (m.substitutions || []).map(s => ({
          minute: s.minute,
          playerOut: s.playerOut ? { id: s.playerOut.id, name: s.playerOut.name } : null,
          playerIn: s.playerIn ? { id: s.playerIn.id, name: s.playerIn.name } : null,
          team: s.team ? { id: s.team.id, name: s.team.name } : null,
        })),
      }));

    return { matches, fetchedAt: now };
  } catch (err) {
    logger.error({ err: err.message }, 'football-data.org fetch error');
    return null;
  }
}

async function poll() {
  if (!getApiKey() || isPolling) return;
  isPolling = true;

  try {
    const result = await fetchMatchEvents();
    if (result) {
      cachedData = { matches: result.matches };
      lastFetchTime = result.fetchedAt;
      logger.debug({ matchCount: result.matches.length }, 'Match events cache updated');
    }
  } finally {
    isPolling = false;
  }
}

function hasLiveMatches() {
  return cachedData.matches.some(m => ['IN_PLAY', 'PAUSED', 'TIMED'].includes(m.status));
}

function startPolling() {
  if (pollInterval) return;

  logger.info('Starting match events background poller');
  poll(); // Initial fetch

  pollInterval = setInterval(() => {
    if (hasLiveMatches()) {
      poll(); // Live match — poll every 60s
    } else {
      // No live matches — stop polling, clear cache
      stopPolling();
      cachedData = { matches: [] };
      lastFetchTime = 0;
    }
  }, LIVE_POLL_MS);
}

function stopPolling() {
  if (pollInterval) {
    clearInterval(pollInterval);
    pollInterval = null;
    logger.info('Stopped match events background poller');
  }
}

/**
 * Get cached match events.
 * Returns immediately from cache — never blocks on API calls.
 */
function getMatchEvents() {
  if (!getApiKey()) return { matches: [] };

  const now = Date.now();
  const age = now - lastFetchTime;

  // Start polling if we have live matches and polling isn't running
  if (age > LIVE_POLL_MS) {
    // Cache is stale — trigger a background fetch (don't await)
    poll().catch(() => {});
  }

  // Auto-start polling if we detect it should be running
  if (!pollInterval && lastFetchTime === 0) {
    poll().catch(() => {});
  }

  return cachedData;
}

// Start polling on module load if API key is present
if (getApiKey()) {
  startPolling();
}

module.exports = { getMatchEvents, startPolling, stopPolling };
