const axios = require('axios');
const logger = require('./logger');
const snapshotManager = require('./snapshotManager');

// Upstash Redis (optional — falls back to in-memory Map if not configured)
let redis = null;
const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
if (UPSTASH_URL && UPSTASH_TOKEN) {
  try {
    const { Redis } = require('@upstash/redis');
    redis = new Redis({ url: UPSTASH_URL, token: UPSTASH_TOKEN });
    logger.info('Upstash Redis connected');
  } catch (e) {
    logger.warn({ err: e }, 'Upstash Redis unavailable, falling back to in-memory cache');
  }
}

const upstreamCache = new Map();
const globalPlayerHistoryCache = new Map();
const geoCache = new Map();
const CACHE_MAX_ENTRIES = 500;
const GEO_CACHE_TTL = 24 * 60 * 60 * 1000;
const PLAYER_HISTORY_TTL = 5 * 60;
const BOOTSTRAP_URL = 'https://fantasy.premierleague.com/api/bootstrap-static/';
const FIXTURES_URL = 'https://fantasy.premierleague.com/api/fixtures/';

// Bootstrap data changes ~once per gameweek. 30 minutes is safe and cuts API load drastically.
const BOOTSTRAP_CACHE_TTL = 30 * 60 * 1000;

// ---- Circuit Breaker ----
// Prevents hammering a failing upstream. Opens after CONSECUTIVE failures,
// half-open after COOLDOWN ms to probe if the service recovered.
const circuitBreaker = {
  failures: 0,
  state: 'closed', // closed = normal, open = blocked, half-open = probing
  lastFailure: 0,
  CONSECUTIVE_FAILURES_THRESHOLD: 5,
  COOLDOWN_MS: 60 * 1000, // 1 minute

  recordFailure() {
    this.failures += 1;
    this.lastFailure = Date.now();
    if (this.failures >= this.CONSECUTIVE_FAILURES_THRESHOLD) {
      this.state = 'open';
      logger.warn({ failures: this.failures }, 'Circuit breaker OPEN — FPL API requests paused');
    }
  },

  recordSuccess() {
    this.failures = 0;
    this.state = 'closed';
  },

  canRequest() {
    if (this.state === 'closed') return true;
    if (this.state === 'open' && Date.now() - this.lastFailure > this.COOLDOWN_MS) {
      this.state = 'half-open';
      return true;
    }
    return this.state === 'half-open';
  },
};

function pruneCache(cache, isStale, maxEntries = CACHE_MAX_ENTRIES) {
  if (cache.size <= maxEntries) {
    for (const [key, value] of cache) {
      if (isStale(value)) cache.delete(key);
    }
    return;
  }
  let removed = 0;
  for (const [key, value] of cache) {
    if (isStale(value)) { cache.delete(key); removed += 1; }
    else if (cache.size - removed > maxEntries) { cache.delete(key); removed += 1; }
  }
}

setInterval(() => {
  const now = Date.now();
  pruneCache(globalPlayerHistoryCache, v => now - v.timestamp > PLAYER_HISTORY_TTL * 1000);
  pruneCache(upstreamCache, v => now - v.timestamp > 24 * 60 * 60 * 1000);
  pruneCache(geoCache, v => now - v.ts > GEO_CACHE_TTL);
}, 5 * 60 * 1000);

// ---- Resilient HTTP GET with exponential backoff ----
async function apiGet(url, { maxRetries = 3, baseDelay = 500 } = {}) {
  if (!circuitBreaker.canRequest()) {
    // Circuit is open — try stale cache before failing
    const stale = upstreamCache.get(url);
    if (stale?.data) {
      logger.warn({ url }, 'Circuit breaker open, serving stale cache');
      return { data: stale.data };
    }
    throw new Error(`Circuit breaker open and no stale cache for ${url}`);
  }

  let lastError;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const response = await axios.get(url, { timeout: 15000 });
      circuitBreaker.recordSuccess();
      return response;
    } catch (error) {
      lastError = error;
      const status = error.response?.status;
      // Don't retry client errors (except 429 rate limit)
      if (status && status !== 429 && status < 500) {
        circuitBreaker.recordFailure();
        throw error;
      }
      if (attempt < maxRetries) {
        const delay = baseDelay * Math.pow(2, attempt) + Math.random() * 200;
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }
  circuitBreaker.recordFailure();
  throw lastError;
}

async function getGlobalPlayerHistory(playerId) {
  const cacheKey = `ph:${playerId}`;
  if (redis) {
    try {
      const cached = await redis.get(cacheKey);
      if (cached) return cached;
    } catch (e) { /* fall back to in-memory */ }
  }
  const cached = globalPlayerHistoryCache.get(playerId);
  if (cached && Date.now() - cached.timestamp < PLAYER_HISTORY_TTL * 1000) return cached.data;
  const data = (await apiGet(`https://fantasy.premierleague.com/api/element-summary/${playerId}/`)).data;
  globalPlayerHistoryCache.set(playerId, { data, timestamp: Date.now() });
  if (redis) {
    try { await redis.setex(cacheKey, PLAYER_HISTORY_TTL, data); } catch (e) { /* ignore */ }
  }
  return data;
}

async function getCachedApiData(url, maxAgeMs = 60 * 1000) {
  const isBootstrapUrl = url === BOOTSTRAP_URL || url.includes('/api/bootstrap-static');
  const isFixturesUrl = url === FIXTURES_URL || url.includes('/api/fixtures');

  // If site snapshot mode is ACTIVE (from 2 mins before deadline to 20 mins before 1st match), serve snapshot
  if (snapshotManager.isSnapshotActive()) {
    const snap = snapshotManager.getSnapshotData();
    if (isBootstrapUrl && snap?.bootstrap) {
      return snap.bootstrap;
    }
    if (isFixturesUrl && snap?.fixtures) {
      return snap.fixtures;
    }
  }

  const cacheKey = `api:${url}`;
  const ttlSeconds = Math.ceil(maxAgeMs / 1000);
  if (redis) {
    try {
      const cached = await redis.get(cacheKey);
      if (cached) return cached;
    } catch (e) { /* fall back to in-memory */ }
  }
  const cached = upstreamCache.get(url);
  if (cached?.data && Date.now() - cached.timestamp < maxAgeMs) return cached.data;
  if (cached?.request) return cached.request;

  const request = apiGet(url).then(async ({ data }) => {
    upstreamCache.set(url, { data, timestamp: Date.now() });
    if (redis) {
      try { await redis.setex(cacheKey, ttlSeconds, data); } catch (e) { /* ignore */ }
    }
    if (isBootstrapUrl) {
      snapshotManager.saveRollingBackup(data, null);
    } else if (isFixturesUrl) {
      snapshotManager.saveRollingBackup(null, data);
    }
    return data;
  }).catch(error => {
    if (cached?.data) return cached.data;
    const snap = snapshotManager.getSnapshotData();
    if (isBootstrapUrl && snap?.bootstrap) return snap.bootstrap;
    if (isFixturesUrl && snap?.fixtures) return snap.fixtures;
    throw error;
  });
  upstreamCache.set(url, { ...cached, request });
  try {
    return await request;
  } finally {
    const latest = upstreamCache.get(url);
    if (latest?.request === request) {
      const { request: pendingRequest, ...rest } = latest;
      if (rest.data) upstreamCache.set(url, rest);
      else upstreamCache.delete(url);
    }
  }
}

async function optionalApiGet(url, fallback = null) {
  try { return await getCachedApiData(url); }
  catch (error) {
    if ([400, 404].includes(error.response?.status)) return fallback;
    throw error;
  }
}

module.exports = {
  redis,
  upstreamCache,
  globalPlayerHistoryCache,
  geoCache,
  GEO_CACHE_TTL,
  PLAYER_HISTORY_TTL,
  BOOTSTRAP_URL,
  FIXTURES_URL,
  BOOTSTRAP_CACHE_TTL,
  apiGet,
  getGlobalPlayerHistory,
  getCachedApiData,
  optionalApiGet,
  snapshotManager,
};
