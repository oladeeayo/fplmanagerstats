const express = require('express');
const path = require('path');
const axios = require('axios');
const { neon } = require('@neondatabase/serverless');
const { buildDecisionCentre } = require('./decisionModel');
const { buildPlayerProjections, buildCaptaincyModel } = require('./captaincyModel');

// Upstash Redis (optional — falls back to in-memory Map if not configured)
let redis = null;
const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
if (UPSTASH_URL && UPSTASH_TOKEN) {
  try {
    const { Redis } = require('@upstash/redis');
    redis = new Redis({ url: UPSTASH_URL, token: UPSTASH_TOKEN });
    console.log('Upstash Redis connected');
  } catch (e) {
    console.warn('Upstash Redis unavailable, falling back to in-memory cache:', e.message);
  }
}

const app = express();
const PORT = process.env.PORT || 3000;
const clientDistPath = path.join(__dirname, '../dist');

// Neon database connection
const NEON_URL = process.env.NEON_DATABASE_URL;
const sql = NEON_URL ? neon(NEON_URL) : null;

// Initialize database tables
async function initDatabase() {
  if (!sql) {
    console.warn('NEON_DATABASE_URL is not set; ownership history and admin analytics are disabled.');
    return;
  }
  try {
    await Promise.all([
      sql`
        CREATE TABLE IF NOT EXISTS ownership_snapshots (
          id SERIAL PRIMARY KEY,
          timestamp BIGINT NOT NULL,
          players JSONB NOT NULL,
          created_at TIMESTAMP DEFAULT NOW()
        )
      `.then(() => sql`CREATE INDEX IF NOT EXISTS idx_ownership_timestamp ON ownership_snapshots(timestamp)`),

      sql`
        CREATE TABLE IF NOT EXISTS admin_page_views (
          id SERIAL PRIMARY KEY,
          session_id VARCHAR(64) NOT NULL,
          path VARCHAR(512) NOT NULL,
          referrer VARCHAR(1024),
          ip_hash VARCHAR(128),
          country VARCHAR(8),
          city VARCHAR(128),
          continent VARCHAR(32),
          device_type VARCHAR(16),
          browser VARCHAR(64),
          os VARCHAR(64),
          os_version VARCHAR(64),
          status_code INT,
          response_time_ms INT,
          created_at TIMESTAMP DEFAULT NOW()
        )
      `.then(() => Promise.all([
        sql`CREATE INDEX IF NOT EXISTS idx_pv_created ON admin_page_views(created_at)`,
        sql`CREATE INDEX IF NOT EXISTS idx_pv_session ON admin_page_views(session_id)`,
        sql`CREATE INDEX IF NOT EXISTS idx_pv_country ON admin_page_views(country)`
      ])),

      sql`
        CREATE TABLE IF NOT EXISTS admin_visitor_sessions (
          id SERIAL PRIMARY KEY,
          session_id VARCHAR(64) UNIQUE NOT NULL,
          ip_hash VARCHAR(128),
          country VARCHAR(8),
          city VARCHAR(128),
          continent VARCHAR(32),
          device_type VARCHAR(16),
          browser VARCHAR(64),
          os VARCHAR(64),
          os_version VARCHAR(64),
          first_page VARCHAR(512),
          last_page VARCHAR(512),
          page_count INT DEFAULT 1,
          is_returning BOOLEAN DEFAULT FALSE,
          created_at TIMESTAMP DEFAULT NOW(),
          last_active_at TIMESTAMP DEFAULT NOW()
        )
      `.then(() => Promise.all([
        sql`CREATE INDEX IF NOT EXISTS idx_vs_created ON admin_visitor_sessions(created_at)`,
        sql`CREATE INDEX IF NOT EXISTS idx_vs_country ON admin_visitor_sessions(country)`,
        sql`ALTER TABLE admin_visitor_sessions ADD COLUMN IF NOT EXISTS last_referrer VARCHAR(1024)`,
        sql`ALTER TABLE admin_visitor_sessions ADD COLUMN IF NOT EXISTS device_fingerprint VARCHAR(64)`,
        sql`ALTER TABLE admin_visitor_sessions ADD COLUMN IF NOT EXISTS visit_count INT DEFAULT 1`,
        sql`ALTER TABLE admin_visitor_sessions ADD COLUMN IF NOT EXISTS unique_visit_days INT DEFAULT 1`
      ])),

      sql`
        CREATE TABLE IF NOT EXISTS admin_daily_stats (
          id SERIAL PRIMARY KEY,
          date DATE UNIQUE NOT NULL,
          unique_visitors INT DEFAULT 0,
          page_views INT DEFAULT 0,
          top_country VARCHAR(8),
          top_page VARCHAR(512),
          avg_response_time_ms INT DEFAULT 0,
          created_at TIMESTAMP DEFAULT NOW()
        )
      `.then(() => sql`CREATE INDEX IF NOT EXISTS idx_ds_date ON admin_daily_stats(date)`),

      sql`
        CREATE TABLE IF NOT EXISTS ai_team (
          id SERIAL PRIMARY KEY,
          session_id VARCHAR(64) NOT NULL,
          squad JSONB NOT NULL,
          lineup JSONB NOT NULL,
          formation VARCHAR(10) NOT NULL,
          team_cost NUMERIC(5,1) NOT NULL,
          team_xpts NUMERIC(7,1) NOT NULL,
          strategy VARCHAR(20) NOT NULL DEFAULT 'balanced',
          budget NUMERIC(5,1) NOT NULL DEFAULT 100,
          horizon INT NOT NULL DEFAULT 5,
          is_locked BOOLEAN DEFAULT FALSE,
          locked_at TIMESTAMP,
          created_at TIMESTAMP DEFAULT NOW(),
          updated_at TIMESTAMP DEFAULT NOW()
        )
      `.then(() => sql`CREATE INDEX IF NOT EXISTS idx_aiteam_session ON ai_team(session_id)`)
    ]);

    console.log('Database initialized successfully');
  } catch (e) {
    console.error('Database init error:', e.message);
  }
}
initDatabase();

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-admin-key, x-session-id');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.use(express.static(clientDistPath, {
  maxAge: '1y',
  immutable: true,
  setHeaders(res, filePath) {
    if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache');
  }
}));
app.use(express.static(path.join(__dirname, '../public'), {
  maxAge: '7d',
  setHeaders(res, filePath) {
    if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache');
  }
}));
app.use(express.json());

function requireDatabase(req, res) {
  if (sql) return true;
  res.status(503).json({ error: 'Database features are not configured' });
  return false;
}

function parsePositiveId(value) {
  return /^\d+$/.test(String(value)) && Number(value) > 0 ? String(value) : null;
}

// ---- Analytics Tracking ----
const crypto = require('crypto');
const geoCache = new Map();
const GEO_CACHE_TTL = 24 * 60 * 60 * 1000;

function parseUserAgent(ua) {
  if (!ua) return { deviceType: 'Unknown', browser: 'Unknown', os: 'Unknown', osVersion: '' };
  const lower = ua.toLowerCase();

  let deviceType = 'Desktop';
  if (/mobile|android|iphone|ipod/i.test(lower)) deviceType = 'Mobile';
  else if (/tablet|ipad/i.test(lower)) deviceType = 'Tablet';

  let browser = 'Other';
  if (/edg\//i.test(lower)) browser = 'Edge';
  else if (/chrome/i.test(lower) && !/opr\//i.test(lower)) browser = 'Chrome';
  else if (/firefox/i.test(lower)) browser = 'Firefox';
  else if (/safari/i.test(lower) && !/chrome/i.test(lower)) browser = 'Safari';
  else if (/opr\//i.test(lower) || /opera/i.test(lower)) browser = 'Opera';

  let os = 'Other', osVersion = '';
  if (/windows/i.test(lower)) { os = 'Windows'; const m = ua.match(/Windows NT (\d+\.\d+)/); if (m) osVersion = m[1]; }
  else if (/mac os x|macintosh/i.test(lower)) { os = 'macOS'; const m = ua.match(/Mac OS X (\d+[._]\d+)/); if (m) osVersion = m[1].replace('_', '.'); }
  else if (/iphone|ipad|ipod/i.test(lower)) { os = ua.match(/OS (\d+_\d+)/)?.[1]?.replace('_', '.') || 'iOS'; osVersion = os; os = 'iOS'; }
  else if (/android/i.test(lower)) { os = 'Android'; const m = ua.match(/Android (\d+\.?\d*)/); if (m) osVersion = m[1]; }
  else if (/linux/i.test(lower)) os = 'Linux';
  else if (/cros/i.test(lower)) { os = 'ChromeOS'; osVersion = ''; }

  return { deviceType, browser, os, osVersion };
}

async function lookupGeo(ip) {
  if (!ip || ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1') {
    return { country: 'Local', city: 'Local', continent: 'Local' };
  }
  const cached = geoCache.get(ip);
  if (cached && Date.now() - cached.ts < GEO_CACHE_TTL) return cached.data;
  try {
    const res = await axios.get(`http://ip-api.com/json/${ip}?fields=status,country,countryCode,city,continent`, { timeout: 3000 });
    if (res.data.status === 'success') {
      const geo = { country: res.data.countryCode || 'XX', city: res.data.city || '', continent: res.data.continent || '' };
      geoCache.set(ip, { data: geo, ts: Date.now() });
      return geo;
    }
  } catch (e) { /* geo lookup failed */ }
  return { country: 'XX', city: '', continent: '' };
}

function hashIP(ip) {
  return crypto.createHash('sha256').update(ip + 'fplstats_salt_2024').digest('hex').slice(0, 16);
}

function generateSessionId() {
  return crypto.randomBytes(16).toString('hex');
}

function getSessionId(req, res) {
  const cookies = String(req.headers.cookie || '').split(';').reduce((all, part) => {
    const separator = part.indexOf('=');
    if (separator > 0) all[part.slice(0, separator).trim()] = part.slice(separator + 1).trim();
    return all;
  }, {});
  const existing = cookies.fpl_analytics_session;
  const sessionId = /^[a-f0-9]{32}$/.test(existing || '') ? existing : generateSessionId();
  if (!existing) {
    res.setHeader('Set-Cookie', `fpl_analytics_session=${sessionId}; Max-Age=31536000; Path=/; SameSite=Lax`);
  }
  return sessionId;
}

// Tracking middleware
app.use(async (req, res, next) => {
  if (!sql) return next();
  const startTime = Date.now();
  const originalEnd = res.end;

  res.end = function(...args) {
    const responseTime = Date.now() - startTime;
    const path = req.originalUrl || req.url;

    // Skip admin routes and static assets from tracking
    if (path.startsWith('/api/admin') || path.includes('.') && !path.includes('?')) {
      return originalEnd.apply(this, args);
    }

    // Fire-and-forget tracking
    (async () => {
      try {
        const forwarded = req.headers['x-forwarded-for'];
        const ip = forwarded ? forwarded.split(',')[0].trim() : (req.socket?.remoteAddress || '');
        const ua = req.headers['user-agent'] || '';
        const referrer = req.headers['referer'] || req.headers['referrer'] || '';
         const sessionId = req.headers['x-session-id'] || getSessionId(req, res);

        const { deviceType, browser, os, osVersion } = parseUserAgent(ua);
        const geo = await lookupGeo(ip);
        const ipHash = hashIP(ip);

        // Device fingerprint: hash of UA + screen width hint (sent via header or just UA-based)
        const deviceFP = crypto.createHash('sha256').update(`${ua}|${ipHash}`).digest('hex').slice(0, 16);

        await sql`
          INSERT INTO admin_page_views (session_id, path, referrer, ip_hash, country, city, continent, device_type, browser, os, os_version, status_code, response_time_ms)
          VALUES (${sessionId}, ${path.slice(0, 512)}, ${referrer.slice(0, 1024)}, ${ipHash}, ${geo.country}, ${geo.city.slice(0, 128)}, ${geo.continent}, ${deviceType}, ${browser}, ${os}, ${osVersion}, ${res.statusCode}, ${Math.min(responseTime, 99999)})
        `;

        // Upsert session with visit tracking
        const existing = await sql`SELECT session_id, page_count, visit_count, unique_visit_days, created_at::date as first_day, last_active_at FROM admin_visitor_sessions WHERE session_id = ${sessionId}`;
        if (existing.length > 0) {
          const today = new Date().toISOString().slice(0, 10);
          const firstDay = existing[0].first_day;
          const daysDiff = Math.floor((new Date(today) - new Date(firstDay)) / 86400000);
          const lastActive = existing[0].last_active_at;
          const isNewDay = !lastActive || new Date(lastActive).toISOString().slice(0, 10) !== today;
          await sql`
            UPDATE admin_visitor_sessions
            SET page_count = page_count + 1,
                last_page = ${path.slice(0, 512)},
                last_active_at = NOW(),
                last_referrer = ${referrer.slice(0, 1024)},
                device_fingerprint = ${deviceFP},
                visit_count = visit_count + ${isNewDay ? 1 : 0},
                unique_visit_days = GREATEST(1, ${daysDiff + 1})
            WHERE session_id = ${sessionId}
          `;
        } else {
          await sql`
            INSERT INTO admin_visitor_sessions (session_id, ip_hash, country, city, continent, device_type, browser, os, os_version, first_page, last_page, page_count, is_returning, last_referrer, device_fingerprint, visit_count, unique_visit_days)
            VALUES (${sessionId}, ${ipHash}, ${geo.country}, ${geo.city.slice(0, 128)}, ${geo.continent}, ${deviceType}, ${browser}, ${os}, ${osVersion}, ${path.slice(0, 512)}, ${path.slice(0, 512)}, 1, FALSE, ${referrer.slice(0, 1024)}, ${deviceFP}, 1, 1)
          `;
        }
      } catch (e) { /* tracking error — don't break the app */ }
    })();

    return originalEnd.apply(this, args);
  };

  next();
});

const POSITION_MAP = ["GKP", "DEF", "MID", "FWD"];
const { DETAILED_POSITIONS, ZONE_MAP, ZONE_LABELS, ZONE_GROUP, POSITION_LABELS, ATTACKING_ZONES, DEFENSIVE_ZONES, MIDFIELD_ZONES, ALL_ZONES } = require('./playerPositions');

async function apiGet(url) {
  let lastError;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return await axios.get(url, { timeout: 15000 });
    } catch (error) {
      lastError = error;
      const status = error.response?.status;
      if (attempt > 0 || (status && status !== 429 && status < 500)) throw error;
      await new Promise(resolve => setTimeout(resolve, 250));
    }
  }
  throw lastError;
}
const upstreamCache = new Map(); // fallback in-memory cache
const globalPlayerHistoryCache = new Map(); // fallback in-memory player history

// Global player history cache
const PLAYER_HISTORY_TTL = 5 * 60; // 5 minutes (Redis uses seconds)

async function getGlobalPlayerHistory(playerId) {
  const cacheKey = `ph:${playerId}`;

  // Try Redis first
  if (redis) {
    try {
      const cached = await redis.get(cacheKey);
      if (cached) return cached;
    } catch (e) { /* fall back to in-memory */ }
  }

  // Fall back to in-memory
  const cached = globalPlayerHistoryCache.get(playerId);
  if (cached && Date.now() - cached.timestamp < PLAYER_HISTORY_TTL * 1000) return cached.data;

  const data = (await apiGet(`https://fantasy.premierleague.com/api/element-summary/${playerId}/`)).data;

  // Write to both caches
  globalPlayerHistoryCache.set(playerId, { data, timestamp: Date.now() });
  if (redis) {
    try { await redis.setex(cacheKey, PLAYER_HISTORY_TTL, data); } catch (e) { /* ignore */ }
  }
  return data;
}

async function getCachedApiData(url, maxAgeMs = 60 * 1000) {
  const cacheKey = `api:${url}`;
  const ttlSeconds = Math.ceil(maxAgeMs / 1000);

  // Try Redis first
  if (redis) {
    try {
      const cached = await redis.get(cacheKey);
      if (cached) return cached;
    } catch (e) { /* fall back to in-memory */ }
  }

  // In-memory fast path
  const cached = upstreamCache.get(url);
  if (cached?.data && Date.now() - cached.timestamp < maxAgeMs) return cached.data;
  if (cached?.request) return cached.request;

  const request = apiGet(url).then(async ({ data }) => {
    upstreamCache.set(url, { data, timestamp: Date.now() });
    // Write to Redis in background (fire-and-forget)
    if (redis) {
      try { await redis.setex(cacheKey, ttlSeconds, data); } catch (e) { /* ignore */ }
    }
    return data;
  }).catch(error => {
    if (cached?.data) return cached.data;
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

const BOOTSTRAP_URL = 'https://fantasy.premierleague.com/api/bootstrap-static/';
const FIXTURES_URL = 'https://fantasy.premierleague.com/api/fixtures/';

async function optionalApiGet(url, fallback = null) {
  try { return await getCachedApiData(url); }
  catch (error) {
    if ([400, 404].includes(error.response?.status)) return fallback;
    throw error;
  }
}

app.get('/api/health', (req, res) => res.json({ status: 'healthy' }));

app.get('/api/bootstrap-static', async (req, res) => {
  try {
    res.setHeader('Cache-Control', 'public, max-age=300, stale-while-revalidate=600');
    res.json(await getCachedApiData(BOOTSTRAP_URL, 5 * 60 * 1000));
  } catch (e) { res.status(500).json({ error: 'Failed to fetch bootstrap static data' }); }
});

app.get('/api/fixtures', async (req, res) => {
  try {
    res.setHeader('Cache-Control', 'public, max-age=300, stale-while-revalidate=600');
    res.json(await getCachedApiData(FIXTURES_URL, 5 * 60 * 1000));
  } catch (e) { res.status(500).json({ error: 'Failed to fetch fixtures' }); }
});

app.post('/api/v1/decision-centre', async (req, res) => {
  const managerId = parsePositiveId(req.body?.managerId);
  if (!managerId) return res.status(400).json({ error: 'A valid managerId is required' });
  const requestedGW = Math.max(1, Math.min(38, Number.parseInt(req.body?.targetGW, 10) || 1));
  const horizon = Math.max(1, Math.min(8, Number.parseInt(req.body?.horizon, 10) || 5));
  const rivalIds = [...new Set((req.body?.rivalIds || []).map(parsePositiveId).filter(Boolean))].filter(id => id !== managerId).slice(0, 5);

  try {
    const [bootstrap, fixtures, manager, history] = await Promise.all([
      getCachedApiData(BOOTSTRAP_URL),
      getCachedApiData(FIXTURES_URL),
      getCachedApiData(`https://fantasy.premierleague.com/api/entry/${managerId}/`),
      getCachedApiData(`https://fantasy.premierleague.com/api/entry/${managerId}/history/`),
    ]);
    const currentGW = bootstrap.events.find(event => event.is_current)?.id;
    const nextGW = bootstrap.events.find(event => event.is_next)?.id || currentGW || requestedGW;
    const picksGW = Math.max(1, currentGW || nextGW - 1 || 1);
    const picks = await optionalApiGet(`https://fantasy.premierleague.com/api/entry/${managerId}/event/${picksGW}/picks/`);
    if (!picks?.picks?.length) return res.status(409).json({ error: 'This manager does not yet have a published squad. Try again after the first deadline.' });
    const liveData = currentGW ? await optionalApiGet(`https://fantasy.premierleague.com/api/event/${currentGW}/live/`) : null;

    const rivals = (await Promise.all(rivalIds.map(async id => {
      const [entry, rivalPicks] = await Promise.all([
        optionalApiGet(`https://fantasy.premierleague.com/api/entry/${id}/`),
        optionalApiGet(`https://fantasy.premierleague.com/api/entry/${id}/event/${picksGW}/picks/`),
      ]);
      if (!entry || !rivalPicks?.picks) return null;
      return { id, name: `${entry.player_first_name} ${entry.player_last_name}`.trim(), teamName: entry.name, rank: entry.summary_overall_rank, picks: rivalPicks.picks };
    }))).filter(Boolean);

    res.json(buildDecisionCentre({ bootstrap, fixtures, manager: { ...manager, id: managerId }, picks, history, rivals, liveData, options: { ...req.body, targetGW: req.body?.targetGW || nextGW, horizon } }));
  } catch (error) {
    console.error('Decision centre error:', error.message);
    const status = error.response?.status === 404 ? 404 : 500;
    res.status(status).json({ error: status === 404 ? 'Manager or rival could not be found' : 'Failed to build the decision centre' });
  }
});

// ---- AI Team: Autonomous Season Manager ----
function getSessionId(req) {
  return req.cookies?.fpl_analytics_session || req.headers['x-session-id'] || 'default';
}

// GET saved AI team + transfer plan + chip schedule
app.get('/api/ai-team', async (req, res) => {
  if (!requireDatabase(req, res)) return;
  const sessionId = getSessionId(req);
  try {
    const rows = await sql`SELECT * FROM ai_team WHERE session_id = ${sessionId} ORDER BY updated_at DESC LIMIT 1`;
    if (!rows.length) return res.json({ saved: false });
    const row = rows[0];
    res.json({
      saved: true,
      isLocked: row.is_locked,
      lockedAt: row.locked_at,
      formation: row.formation,
      teamCost: Number(row.team_cost),
      teamXpts: Number(row.team_xpts),
      strategy: row.strategy,
      budget: Number(row.budget),
      horizon: row.horizon,
      squad: row.squad,
      lineup: row.lineup,
      transfers: row.transfers || [],
      chips: row.chips || { recommendations: [] },
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    });
  } catch (e) {
    console.error('AI Team GET error:', e.message);
    res.status(500).json({ error: 'Failed to load AI team' });
  }
});

// Reset/unlock AI team (only for WC)
app.delete('/api/ai-team', async (req, res) => {
  if (!requireDatabase(req, res)) return;
  const sessionId = getSessionId(req);
  try {
    await sql`DELETE FROM ai_team WHERE session_id = ${sessionId}`;
    res.json({ success: true });
  } catch (e) {
    console.error('AI Team DELETE error:', e.message);
    res.status(500).json({ error: 'Failed to reset team' });
  }
});

// ---- Core AI Team Builder ----
app.post('/api/ai-team', async (req, res) => {
  const budget = Math.max(80, Math.min(120, Number(req.body?.budget) || 100));
  const horizon = Math.max(3, Math.min(38, Number(req.body?.horizon) || 5));
  const strategy = ['balanced', 'protect', 'chase'].includes(req.body?.strategy) ? req.body.strategy : 'balanced';

  try {
    const [bootstrap, fixtures] = await Promise.all([
      getCachedApiData(BOOTSTRAP_URL),
      getCachedApiData(FIXTURES_URL),
    ]);

    const events = bootstrap.events || [];
    const elements = bootstrap.elements || [];
    const teams = bootstrap.teams || [];
    const teamsById = new Map(teams.map(t => [t.id, t]));
    const currentGW = events.find(e => e.is_current)?.id || null;
    const nextGW = events.find(e => e.is_next)?.id || currentGW || 1;

    // Build full player projections across the horizon
    const projectionData = buildPlayerProjections({ bootstrap, fixtures, startGW: nextGW, horizon: Math.max(horizon, 8) });
    const allPlayers = projectionData.projections;

    // Enrich with bootstrap data
    const bootstrapMap = new Map(elements.map(e => [e.id, e]));
    const fixturesByTeam = new Map();
    fixtures.forEach(f => {
      [f.team_h, f.team_a].forEach(teamId => {
        if (!fixturesByTeam.has(teamId)) fixturesByTeam.set(teamId, []);
        fixturesByTeam.get(teamId).push(f);
      });
    });

    const enrichedPlayers = allPlayers.map(p => {
      const raw = bootstrapMap.get(p.id);
      if (!raw) return p;

      let enhancedAvailability = p.availability;
      const status = raw.status || 'a';
      const news = raw.news || '';
      const chanceNext = raw.chance_of_playing_next_round;

      if (['s', 'u', 'n'].includes(status)) enhancedAvailability = 0;
      if (status === 'd') enhancedAvailability = Math.min(enhancedAvailability, 60);
      if (status === 'i') enhancedAvailability = Math.min(enhancedAvailability, 25);
      if (chanceNext !== null && chanceNext !== undefined) {
        enhancedAvailability = Math.min(enhancedAvailability, Number(chanceNext));
      }

      const formBoost = status === 'a' && Number(raw.form) > 5 ? (Number(raw.form) - 5) * 0.3 : 0;
      const minutesPlayed = Number(raw.minutes) || 0;
      const gamesPlayed = Math.max(1, events.filter(e => e.finished).length || 1);
      const minutesPerGame = minutesPlayed / gamesPlayed;
      const minutesReliability = Math.min(1, minutesPerGame / 75);
      const xGI90 = Number(raw.expected_goal_involvements_per_90) || 0;
      const bonusPer90 = Number(raw.bonus) > 0 && Number(raw.minutes) > 0
        ? (Number(raw.bonus) * 90) / Number(raw.minutes) : 0;
      const cleanSheets = Number(raw.clean_sheets) || 0;
      const csPerGame = gamesPlayed > 0 ? cleanSheets / gamesPlayed : 0;
      const isPenaltyTaker = Number(raw.penalties_order) === 1;
      const isFKTaker = Number(raw.direct_freekicks_order) === 1;
      const isCornerTaker = Number(raw.corners_and_indirect_freekicks_order) === 1;
      const setPieceBonus = (isPenaltyTaker ? 0.35 : 0) + (isFKTaker ? 0.15 : 0) + (isCornerTaker ? 0.1 : 0);
      const ictIndex = Number(raw.ict_index) || 0;

      // NEW: Transfer window check - player moved to new team
      // If the player's team changed from previous season, add rotation risk
      const prevTeam = raw.prev_team || null;
      const isNewSigning = prevTeam && prevTeam !== raw.team;
      const rotationRisk = isNewSigning ? 0.85 : 1.0; // 15% penalty for new signings

      // NEW: Get team's upcoming fixtures with FDR
      const playerFixtures = (fixturesByTeam.get(raw.team) || [])
        .filter(f => !f.finished && f.event >= nextGW)
        .sort((a, b) => (a.event || 0) - (b.event || 0))
        .slice(0, 8)
        .map(f => {
          const isHome = f.team_h === raw.team;
          const opponentId = isHome ? f.team_a : f.team_h;
          const opponent = teamsById.get(opponentId);
          const fdr = isHome ? (f.team_h_difficulty || 3) : (f.team_a_difficulty || 3);
          return { gw: f.event, opponent: opponent?.short_name || '?', opponentFull: opponent?.name || '?', home: isHome, fdr, kickoff: f.kickoff_time };
        });

      // NEW: 4+ consecutive fixture run analysis
      let consecutiveGoodFixtures = 0;
      let maxConsecutiveRun = 0;
      let currentRun = 0;
      for (const fx of playerFixtures) {
        if (fx.fdr <= 2) {
          currentRun++;
          maxConsecutiveRun = Math.max(maxConsecutiveRun, currentRun);
        } else {
          currentRun = 0;
        }
      }
      consecutiveGoodFixtures = maxConsecutiveRun;

      return {
        ...p,
        availability: Math.round(enhancedAvailability),
        news, status, formBoost, minutesReliability, xGI90,
        bonusPer90, csPerGame, setPieceBonus, ictIndex,
        isPenaltyTaker, isFKTaker, isCornerTaker,
        isNewSigning, rotationRisk,
        upcomingFixtures: playerFixtures,
        consecutiveGoodFixtures,
        enhancedCost: Number(raw.now_cost) / 10,
        teamFull: teamsById.get(p.teamId)?.name || p.team,
        teamCode: teamsById.get(p.teamId)?.code || 0,
        teamShort: teamsById.get(p.teamId)?.short_name || '',
        prevTeam: prevTeam,
      };
    });

    const availablePlayers = enrichedPlayers.filter(p => p.availability > 10);

    // ---- SMART SQUAD BUILDER ----
    const POSITION_LIMITS = { GKP: 2, DEF: 5, MID: 5, FWD: 3 };
    const MAX_PER_TEAM = 3;

    function adjustedScore(player, strat) {
      const base = player.totalXpts || 0;
      const xPtsPerM = player.xPtsPerMillion || 0;
      const avail = (player.availability || 0) / 100;
      const mins = player.minutesReliability || 0.5;
      const form = player.formBoost || 0;
      const bonusBoost = (player.bonusPer90 || 0) * 1.8;
      const csBoost = (player.csPerGame || 0) * (player.position === 'GKP' || player.position === 'DEF' ? 2.5 : 0.3);
      const setPieceBoost = (player.setPieceBonus || 0) * 1.2;
      const ictBoost = Math.min((player.ictIndex || 0) / 300, 0.5);
      const captainBonus = (bonusBoost + setPieceBoost + ictBoost) * 0.3;

      // NEW: Fixture run bonus - players with 4+ consecutive good fixtures get a boost
      const fixtureRunBonus = (player.consecutiveGoodFixtures || 0) >= 4 ? (player.consecutiveGoodFixtures - 3) * 0.8 : 0;

      // NEW: Rotation penalty for new signings
      const rotPenalty = (player.rotationRisk || 1) < 1 ? -1.5 : 0;

      if (strat === 'protect') return base * 0.85 + Math.min(player.ownership || 0, 50) * 0.04 + avail * 2 + mins * 3 + bonusBoost + csBoost + fixtureRunBonus + rotPenalty;
      if (strat === 'chase') return base * 0.8 + (100 - Math.min(player.ownership || 0, 80)) * 0.02 + (player.range?.high || base) * 0.15 + form + bonusBoost + captainBonus + fixtureRunBonus + rotPenalty;
      return base * 0.65 + xPtsPerM * 0.12 + avail * 1.2 + mins * 1.8 + form + bonusBoost * 0.8 + csBoost * 0.6 + setPieceBoost * 0.5 + captainBonus + fixtureRunBonus + rotPenalty;
    }

    // Multi-pass squad builder
    let bestSquad = [];
    let bestScore = -1;
    let bestCost = 0;

    for (let attempt = 0; attempt < 3; attempt++) {
      const selected = [];
      const teamCounts = {};
      let spent = 0;
      const costBias = attempt * 0.08;

      for (const [position, count] of Object.entries(POSITION_LIMITS)) {
        for (let slot = 0; slot < count; slot++) {
          const minCosts = Object.fromEntries(
            Object.keys(POSITION_LIMITS).map(pos => [pos, Math.min(...availablePlayers.filter(p => p.position === pos).map(p => p.cost))])
          );
          const remainingMinimum = Object.entries(POSITION_LIMITS).reduce((sum, [pos, limit]) => {
            const already = selected.filter(p => p.position === pos).length;
            return sum + Math.max(0, limit - already - (pos === position ? 1 : 0)) * minCosts[pos];
          }, 0);

          const candidates = availablePlayers
            .filter(p => p.position === position && !selected.some(s => s.id === p.id))
            .filter(p => (teamCounts[p.teamId] || 0) < MAX_PER_TEAM)
            .filter(p => spent + (p.cost || p.enhancedCost) + remainingMinimum <= budget + 0.5);

          const scored = candidates.map(p => ({
            ...p,
            _score: adjustedScore(p, strategy) + costBias,
          })).sort((a, b) => b._score - a._score);

          if (scored[0]) {
            selected.push(scored[0]);
            spent += scored[0].cost || scored[0].enhancedCost;
            teamCounts[scored[0].teamId] = (teamCounts[scored[0].teamId] || 0) + 1;
          }
        }
      }

      const squadScore = selected.reduce((s, p) => s + adjustedScore(p, strategy), 0);
      const costDiff = Math.abs(budget - spent);
      const totalScore = squadScore - costDiff * 0.5;

      if (totalScore > bestScore || (Math.abs(totalScore - bestScore) < 0.1 && spent > bestCost)) {
        bestScore = totalScore;
        bestSquad = selected;
        bestCost = spent;
      }
    }

    // Budget upgrade pass
    if (budget - bestCost > 1.5) {
      for (const position of ['FWD', 'MID', 'DEF', 'GKP']) {
        const posPlayers = bestSquad.filter(p => p.position === position).sort((a, b) => a.cost - b.cost);
        for (const cheap of posPlayers) {
          const upgrade = availablePlayers
            .filter(p => p.position === position && p.id !== cheap.id && !bestSquad.some(s => s.id === p.id))
            .filter(p => bestSquad.filter(s => s.teamId === p.teamId).length < MAX_PER_TEAM)
            .filter(p => p.cost <= cheap.cost + (budget - bestCost))
            .filter(p => adjustedScore(p, strategy) > adjustedScore(cheap, strategy))
            .sort((a, b) => adjustedScore(b, strategy) - adjustedScore(a, strategy))[0];
          if (upgrade) {
            const costDiff = upgrade.cost - cheap.cost;
            if (bestCost + costDiff <= budget + 0.3) {
              const idx = bestSquad.findIndex(s => s.id === cheap.id);
              bestSquad[idx] = upgrade;
              bestCost += costDiff;
            }
          }
        }
      }
    }

    const selected = bestSquad;

    // ---- FORMATION + STARTING XI ----
    const VALID_FORMATIONS = [
      { DEF: 3, MID: 4, FWD: 3 }, { DEF: 3, MID: 5, FWD: 2 },
      { DEF: 4, MID: 3, FWD: 3 }, { DEF: 4, MID: 4, FWD: 2 },
      { DEF: 4, MID: 5, FWD: 1 }, { DEF: 5, MID: 3, FWD: 2 },
      { DEF: 5, MID: 4, FWD: 1 },
    ];

    let bestFormation = null;
    let bestFormationScore = -1;
    for (const form of VALID_FORMATIONS) {
      const defPlayers = selected.filter(p => p.position === 'DEF').sort((a, b) => adjustedScore(b, strategy) - adjustedScore(a, strategy));
      const midPlayers = selected.filter(p => p.position === 'MID').sort((a, b) => adjustedScore(b, strategy) - adjustedScore(a, strategy));
      const fwdPlayers = selected.filter(p => p.position === 'FWD').sort((a, b) => adjustedScore(b, strategy) - adjustedScore(a, strategy));
      const score = defPlayers.slice(0, form.DEF).reduce((s, p) => s + adjustedScore(p, strategy), 0)
        + midPlayers.slice(0, form.MID).reduce((s, p) => s + adjustedScore(p, strategy), 0)
        + fwdPlayers.slice(0, form.FWD).reduce((s, p) => s + adjustedScore(p, strategy), 0);
      if (score > bestFormationScore) { bestFormationScore = score; bestFormation = form; }
    }

    const gkp = selected.filter(p => p.position === 'GKP').sort((a, b) => adjustedScore(b, strategy) - adjustedScore(a, strategy));
    const starters = [
      gkp[0],
      ...selected.filter(p => p.position === 'DEF').sort((a, b) => adjustedScore(b, strategy) - adjustedScore(a, strategy)).slice(0, bestFormation.DEF),
      ...selected.filter(p => p.position === 'MID').sort((a, b) => adjustedScore(b, strategy) - adjustedScore(a, strategy)).slice(0, bestFormation.MID),
      ...selected.filter(p => p.position === 'FWD').sort((a, b) => adjustedScore(b, strategy) - adjustedScore(a, strategy)).slice(0, bestFormation.FWD),
    ].filter(Boolean);

    const bench = selected.filter(p => !starters.some(s => s.id === p.id));

    // Captain: highest xPts + bonus/ICT upside
    const captainPool = starters.filter(p => p.position !== 'GKP').sort((a, b) => {
      const aScore = (a.weekly?.[0]?.xPts || 0) + (a.bonusPer90 || 0) * 0.5 + (a.setPieceBonus || 0) * 0.3 + (a.ictIndex || 0) / 500;
      const bScore = (b.weekly?.[0]?.xPts || 0) + (b.bonusPer90 || 0) * 0.5 + (b.setPieceBonus || 0) * 0.3 + (b.ictIndex || 0) / 500;
      return bScore - aScore;
    });
    const captain = captainPool[0] || starters[0];
    const viceCaptain = captainPool[1] || starters[1];

    // Captain x2
    const captainXPts = captain?.weekly?.[0]?.xPts || 0;
    const expectedPoints = starters.reduce((s, p) => s + (p.weekly?.[0]?.xPts || 0), 0) + captainXPts;
    const formation = `${bestFormation.DEF}-${bestFormation.MID}-${bestFormation.FWD}`;
    const teamCost = selected.reduce((s, p) => s + (p.cost || p.enhancedCost), 0);
    const teamXptsRaw = selected.reduce((s, p) => s + (p.totalXpts || 0), 0);
    const captainHorizonBonus = captain ? captain.weekly?.reduce((s, w) => s + (w.xPts || 0), 0) || 0 : 0;
    const teamXpts = teamXptsRaw + captainHorizonBonus;

    // ---- AUTONOMOUS TRANSFER PLAN ----
    // Plan transfers for each GW in the horizon
    const transferPlan = [];
    let currentSquad = [...selected];
    let freeTransfers = 1;

    for (let gw = nextGW; gw < nextGW + horizon && gw <= 38; gw++) {
      const gwPlayers = currentSquad.map(p => {
        const weekly = p.weekly?.find(w => w.gameweek === gw);
        return { ...p, gwXPts: weekly?.xPts || 0, gwFixtures: weekly?.fixtures || [], gwXMins: weekly?.xMins || 0 };
      });

      // Find weak links: players with low xPts or bad fixtures
      const weakLinks = gwPlayers
        .filter(p => p.position !== 'GKP' && p.gwXPts < 3 && bench.some(b => b.position === p.position && b.gwXPts > p.gwXPts + 1))
        .sort((a, b) => a.gwXPts - b.gwXPts);

      // Find upgrade targets from available pool
      const squadIds = new Set(currentSquad.map(p => p.id));
      const teamCounts = {};
      currentSquad.forEach(p => { teamCounts[p.teamId] = (teamCounts[p.teamId] || 0) + 1; });

      let bestTransfer = null;
      let bestGain = 0;

      for (const outgoing of weakLinks.slice(0, 5)) {
        const incoming = availablePlayers
          .filter(p => p.position === outgoing.position && !squadIds.has(p.id))
          .filter(p => (teamCounts[p.teamId] || 0) < MAX_PER_TEAM)
          .filter(p => {
            const weekly = p.weekly?.find(w => w.gameweek === gw);
            return weekly && (weekly.xPts || 0) > outgoing.gwXPts + 1.5;
          })
          .sort((a, b) => {
            const aW = a.weekly?.find(w => w.gameweek === gw)?.xPts || 0;
            const bW = b.weekly?.find(w => w.gameweek === gw)?.xPts || 0;
            return bW - aW;
          })[0];

        if (incoming) {
          const gain = (incoming.weekly?.find(w => w.gameweek === gw)?.xPts || 0) - outgoing.gwXPts;
          if (gain > bestGain) {
            bestGain = gain;
            bestTransfer = { out: outgoing, in: incoming, gain };
          }
        }
      }

      // Only make transfer if gain justifies it (no hit if gain < 4, -4 if gain >= 5)
      if (bestTransfer && freeTransfers > 0) {
        transferPlan.push({ gw, transfer: bestTransfer, hit: 0, freeTransfers: freeTransfers });
        // Update squad
        currentSquad = currentSquad.map(p => p.id === bestTransfer.out.id ? bestTransfer.in : p);
        freeTransfers = 1;
      } else if (bestTransfer && bestTransfer.gain >= 5) {
        // Take a -4 hit
        transferPlan.push({ gw, transfer: bestTransfer, hit: 4, freeTransfers: freeTransfers });
        currentSquad = currentSquad.map(p => p.id === bestTransfer.out.id ? bestTransfer.in : p);
        freeTransfers = 1;
      } else {
        // Roll the transfer
        freeTransfers = Math.min(freeTransfers + 1, 5);
        transferPlan.push({ gw, transfer: null, hit: 0, freeTransfers, rolled: true });
      }
    }

    // ---- AUTONOMOUS CHIP SCHEDULE ----
    const chipSchedule = [];
    const usedChips = [];

    // Analyze each GW for chip opportunities
    for (let gw = nextGW; gw < nextGW + horizon && gw <= 38; gw++) {
      const gwSquad = currentSquad;
      const benchXPts = bench.reduce((s, p) => {
        const w = p.weekly?.find(week => week.gameweek === gw);
        return s + (w?.xPts || 0);
      }, 0);
      const capXPts = captain ? (captain.weekly?.find(w => w.gameweek === gw)?.xPts || 0) : 0;
      const blanks = starters.filter(p => !p.weekly?.some(w => w.gameweek === gw && w.fixtures?.length > 0)).length;
      const injured = gwSquad.filter(p => (p.availability || 0) < 50).length;

      // Bench Boost: when bench output is high
      if (!usedChips.includes('BB') && benchXPts >= 8) {
        chipSchedule.push({ gw, chip: 'BB', reason: `Bench projects ${benchXPts.toFixed(1)} xPts`, confidence: benchXPts >= 12 ? 'High' : 'Medium' });
        usedChips.push('BB');
      }

      // Triple Captain: when captain has a great fixture
      if (!usedChips.includes('TC') && capXPts >= 8) {
        chipSchedule.push({ gw, chip: 'TC', reason: `${captain?.name} projects ${capXPts.toFixed(1)} xPts`, confidence: capXPts >= 10 ? 'High' : 'Medium' });
        usedChips.push('TC');
      }

      // Wildcard: when many players are injured or underperforming
      if (!usedChips.includes('WC') && (injured >= 4 || blanks >= 5)) {
        chipSchedule.push({ gw, chip: 'WC', reason: `${injured} injured, ${ blanks} blanks - squad rebuild needed`, confidence: 'High' });
        usedChips.push('WC');
      }

      // Free Hit: when many blanks in one GW
      if (!usedChips.includes('FH') && blanks >= 6) {
        chipSchedule.push({ gw, chip: 'FH', reason: `${blanks} blanks - team only viable on free hit`, confidence: 'High' });
        usedChips.push('FH');
      }
    }

    // ---- AUTO-LOCK BEFORE GW1 ----
    const isGW1 = nextGW === 1 || (currentGW === null && nextGW === 1);
    const shouldAutoLock = isGW1 || (events.find(e => e.is_current)?.finished === false);

    const result = {
      meta: {
        modelVersion: 'AI Team Engine 3.0',
        generatedAt: new Date().toISOString(),
        strategy, budget, horizon,
        targetGW: nextGW, currentGW,
        gameweeks: projectionData.gameweeks,
        isAutoLocked: shouldAutoLock,
      },
      formation,
      teamCost: Math.round(teamCost * 10) / 10,
      teamXpts: Math.round(teamXpts * 10) / 10,
      squad: selected.map(p => ({ ...p, isCaptain: captain?.id === p.id, isViceCaptain: viceCaptain?.id === p.id })),
      lineup: {
        starters: starters.map(p => ({ ...p, isCaptain: captain?.id === p.id, isViceCaptain: viceCaptain?.id === p.id })),
        bench,
        captain: captain ? { ...captain, isCaptain: true } : null,
        viceCaptain: viceCaptain ? { ...viceCaptain, isViceCaptain: true } : null,
        expectedPoints: Math.round(expectedPoints * 10) / 10,
      },
      transfers: { plan: transferPlan },
      chips: { schedule: chipSchedule },
    };

    // Auto-save to DB (locked if GW1)
    if (sql) {
      const sessionId = getSessionId(req);
      try {
        await sql`DELETE FROM ai_team WHERE session_id = ${sessionId}`;
        await sql`INSERT INTO ai_team (session_id, squad, lineup, formation, team_cost, team_xpts, strategy, budget, horizon, is_locked, locked_at, transfers, chips)
          VALUES (${sessionId}, ${JSON.stringify(result.squad)}, ${JSON.stringify(result.lineup)}, ${result.formation}, ${result.teamCost}, ${result.teamXpts}, ${strategy}, ${budget}, ${horizon}, ${shouldAutoLock}, ${shouldAutoLock ? new Date() : null}, ${JSON.stringify(result.transfers)}, ${JSON.stringify(result.chips)})`;
      } catch (saveErr) {
        console.error('AI Team auto-save error:', saveErr.message);
      }
    }

    res.json(result);
  } catch (error) {
    console.error('AI Team error:', error.message);
    res.status(500).json({ error: 'Failed to build AI Team' });
  }
});

// ---- Core analysis ----
async function analyzeManager(managerId, playerData, leagueId = 314) {
  const [managerEntryData, historyData, leagueData] = await Promise.all([
    getCachedApiData(`https://fantasy.premierleague.com/api/entry/${managerId}/`),
    getCachedApiData(`https://fantasy.premierleague.com/api/entry/${managerId}/history/`),
    getCachedApiData(`https://fantasy.premierleague.com/api/leagues-classic/${leagueId}/standings/`)
  ]);
  const currentGameweek = playerData.events.find(event => event.is_current).id;
  const topManagerPoints = leagueData.standings.results[0].total;

  let totalCaptaincyPoints = 0, totalPointsActive = 0, totalPointsLostOnBench = 0, totalCaptaincyAttempts = 0;
  const playerStats = {}, positionPoints = { GKP: {}, DEF: {}, MID: {}, FWD: {} };
  const weeklyPoints = new Array(currentGameweek).fill(0);
  const weeklyRanks = new Array(currentGameweek).fill(0);
  const weeklyPointsLostBench = new Array(currentGameweek).fill(0);
  const captainChoices = [], chipImpact = [];

  let highestPoints = 0, highestPointsGW = 0, lowestPoints = Infinity, lowestPointsGW = 0;
  let highestRank = Infinity, highestRankGW = 0, lowestRank = 0, lowestRankGW = 0;

  const currentTeam = [];
  const currentPicksData = await getCachedApiData(`https://fantasy.premierleague.com/api/entry/${managerId}/event/${currentGameweek}/picks/`);
  const currentPicks = currentPicksData.picks;

  for (const pick of currentPicks) {
    const player = playerData.elements.find(p => p.id === pick.element);
    if (!player) continue;
    const ph = await getGlobalPlayerHistory(player.id);
    const nextFixtures = (ph.fixtures || []).slice(0, 5).map(f => {
      const isHome = f.is_home;
      const opp = playerData.teams.find(t => t.id === (isHome ? f.team_a : f.team_h));
      return { opponent: opp ? opp.short_name : '?', isHome, difficulty: f.difficulty };
    });
    const last3 = (ph.history || []).slice(-3).reduce((s, g) => s + g.total_points, 0);
    const teamObj = playerData.teams[player.team - 1];
    currentTeam.push({
      name: player.web_name, nextFixtures, last3GWPoints: last3,
      photoId: player.code, team: teamObj.name, teamShort: teamObj.short_name,
      position: POSITION_MAP[player.element_type - 1],
      nowCost: player.now_cost, form: player.form, elementId: player.id,
      selectedBy: player.selected_by_percent, totalPoints: player.total_points,
      pointsPerGame: player.points_per_game, goalsScored: player.goals_scored,
      assists: player.assists, cleanSheets: player.clean_sheets,
      bonus: player.bonus, minutes: player.minutes,
      ictIndex: player.ict_index, expectedGoals: player.expected_goal_involvements
    });
  }

  // Fetch all GW picks in parallel batches, using cache
  const GW_BATCH_SIZE = 5;
  const gwPickResults = new Array(currentGameweek);
  for (let i = 0; i < currentGameweek; i += GW_BATCH_SIZE) {
    const batch = [];
    for (let j = i; j < Math.min(i + GW_BATCH_SIZE, currentGameweek); j++) {
      batch.push(
        getCachedApiData(
          `https://fantasy.premierleague.com/api/entry/${managerId}/event/${j + 1}/picks/`,
          j + 1 < currentGameweek ? 24 * 60 * 60 * 1000 : 60 * 1000
        )
          .then(data => { gwPickResults[j] = data; })
          .catch(() => { gwPickResults[j] = null; })
      );
    }
    await Promise.all(batch);
  }

  // Pre-fetch player histories in controlled batches to avoid FPL API rate limits
  const allPlayerIds = [...new Set(
    gwPickResults.filter(Boolean).flatMap(picksData => picksData.picks.map(p => p.element))
  )];
  const PH_BATCH = 4;
  for (let i = 0; i < allPlayerIds.length; i += PH_BATCH) {
    const batch = allPlayerIds.slice(i, i + PH_BATCH);
    await Promise.all(batch.map(pid => getGlobalPlayerHistory(pid).catch(() => null)));
  }

  for (let gw = 1; gw <= currentGameweek; gw++) {
    const picksData = gwPickResults[gw - 1];
    if (!picksData) continue;
    const picks = picksData.picks;
    const isBenchBoost = picksData.active_chip === "bboost", isTripleCaptain = picksData.active_chip === "3xc";
    let gwPoints = 0, gwBenchPoints = 0, captainPick = null, bestPick = null;

    for (const pick of picks) {
      const playerId = pick.element, player = playerData.elements.find(p => p.id == playerId);
      if (!player) continue;
      const ph = await getGlobalPlayerHistory(playerId);
      const gwHistory = (ph.history || []).find(h => h.round === gw);
      const pts = gwHistory ? gwHistory.total_points : 0;

      if (!playerStats[playerId]) {
        const t = playerData.teams[player.team - 1];
        playerStats[playerId] = {
          name: player.web_name, team: t.name, teamShort: t.short_name,
          position: POSITION_MAP[player.element_type - 1],
          totalPointsActive: 0, gwInSquad: 0, starts: 0, cappedPoints: 0,
          playerPoints: 0, photoId: player.code,
          nowCost: player.now_cost, selectedBy: player.selected_by_percent,
          form: player.form, pointsPerGame: player.points_per_game,
          totalPoints: player.total_points,
          goalsScored: player.goals_scored, assists: player.assists,
          cleanSheets: player.clean_sheets, goalsConceded: player.goals_conceded,
          bonus: player.bonus, bps: player.bps,
          influence: player.influence, creativity: player.creativity,
          threat: player.threat, ictIndex: player.ict_index,
          minutes: player.minutes, yellowCards: player.yellow_cards,
          redCards: player.red_cards, saves: player.saves,
          penaltiesSaved: player.penalties_saved, penaltiesMissed: player.penalties_missed,
          expectedGoals: player.expected_goal_involvements,
          expectedAssists: player.expected_assists,
          expectedGoalsTotal: player.expected_goals,
          elementId: player.id, code: player.code,
          nextFixtures: (await getGlobalPlayerHistory(playerId)).fixtures?.slice(0, 5).map(f => {
            const ih = f.is_home;
            const op = playerData.teams.find(t => t.id === (ih ? f.team_a : f.team_h));
            return { opponent: op ? op.short_name : '?', isHome: ih, difficulty: f.difficulty };
          }) || []
        };
      }

      const inStarting11 = pick.position <= 11, isCaptain = pick.is_captain;
      playerStats[playerId].playerPoints += pts;

      if (inStarting11 || isBenchBoost) {
        let activePoints = pts;
        if (isCaptain) {
          activePoints *= isTripleCaptain ? 3 : 2;
          totalCaptaincyPoints += activePoints;
          totalCaptaincyAttempts++;
          playerStats[playerId].cappedPoints += activePoints;
          captainPick = { playerId, name: player.web_name, points: activePoints, rawPoints: pts, multiplier: isTripleCaptain ? 3 : 2 };
        }
        playerStats[playerId].totalPointsActive += activePoints;
        totalPointsActive += activePoints;
        gwPoints += activePoints;
        const pos = playerStats[playerId].position;
        if (!positionPoints[pos][playerId]) positionPoints[pos][playerId] = { name: player.web_name, points: 0, photoId: player.code };
        positionPoints[pos][playerId].points += activePoints;
        if (inStarting11) playerStats[playerId].starts += 1;
        playerStats[playerId].gwInSquad += 1;
      } else { totalPointsLostOnBench += pts; gwBenchPoints += pts; }

      if (!bestPick || pts > bestPick.rawPoints) bestPick = { playerId, name: player.web_name, rawPoints: pts };
    }

    weeklyPoints[gw - 1] = gwPoints;
    weeklyPointsLostBench[gw - 1] = gwBenchPoints;
    const gwRank = (historyData.current || []).find(h => h.event === gw)?.overall_rank || 0;
    weeklyRanks[gw - 1] = gwRank;
    captainChoices.push({ gw, captain: captainPick || { name: 'None', points: 0, rawPoints: 0, multiplier: 0 }, bestOption: bestPick || { name: 'None', rawPoints: 0 }, missedPoints: (bestPick?.rawPoints||0) - ((captainPick?.rawPoints||0)*(captainPick?.multiplier||1)) });
    if (picksData.active_chip) chipImpact.push({ chip: picksData.active_chip, gw, points: gwPoints });
    if (gwPoints > highestPoints) { highestPoints = gwPoints; highestPointsGW = gw; }
    if (gwPoints < lowestPoints) { lowestPoints = gwPoints; lowestPointsGW = gw; }
    if (gwRank < highestRank) { highestRank = gwRank; highestRankGW = gw; }
    if (gwRank > lowestRank) { lowestRank = gwRank; lowestRankGW = gw; }
  }

  const avgPoints = weeklyPoints.reduce((a, b) => a + b, 0) / weeklyPoints.length;
  chipImpact.forEach(c => { c.avgPoints = Math.round(avgPoints * 10) / 10; c.diff = Math.round((c.points - avgPoints) * 10) / 10; });

  const averageRank = Math.round(weeklyRanks.reduce((a, b) => a + b, 0) / weeklyRanks.length);
  const halfLen = Math.floor(weeklyRanks.length / 2);
  const fh = halfLen > 0 ? Math.round(weeklyRanks.slice(0, halfLen).reduce((a, b) => a + b, 0) / halfLen) : averageRank;
  const sh = halfLen > 0 ? Math.round(weeklyRanks.slice(halfLen).reduce((a, b) => a + b, 0) / weeklyRanks.slice(halfLen).length) : averageRank;
  const rankTrend = fh - sh;

  const players = Object.values(playerStats);
  const defGkp = players.filter(p => p.position === 'DEF' || p.position === 'GKP');
  const gks = players.filter(p => p.position === 'GKP');
  const totalCS = defGkp.reduce((s, p) => s + (p.cleanSheets||0), 0);
  const totalGC = defGkp.reduce((s, p) => s + (p.goalsConceded||0), 0);
  const totalSaves = gks.reduce((s, p) => s + (p.saves||0), 0);
  const templateCount = players.filter(p => parseFloat(p.selectedBy||0) >= 20).length;

  // Underperforming analysis
  const underperforming = players
    .filter(p => {
      const avgFDR = p.nextFixtures?.length ? p.nextFixtures.reduce((s,f) => s+f.difficulty, 0) / p.nextFixtures.length : 0;
      const formOk = parseFloat(p.form||0) >= 2.0;
      const ppgOk = parseFloat(p.pointsPerGame||0) >= 2.0;
      const toughFixtures = avgFDR >= 3.5;
      const lowMins = (p.minutes||0) < 500;
      const yellowRisk = (p.yellowCards||0) >= 4;
      return (toughFixtures && !formOk) || (!ppgOk && lowMins) || yellowRisk;
    })
    .sort((a, b) => parseFloat(a.form||0) - parseFloat(b.form||0))
    .slice(0, 5);

  // Find replacement suggestions from bootstrap
  const replacements = underperforming.map(up => {
    const pos = up.position;
    const cost = up.nowCost || 50;
    const candidates = playerData.elements
      .filter(e => POSITION_MAP[e.element_type-1] === pos && Math.abs(e.now_cost - cost) <= 15 && e.id !== up.elementId && e.total_points > (up.totalPoints||0))
      .sort((a, b) => (b.form||0) - (a.form||0))
      .slice(0, 3)
      .map(e => ({ name: e.web_name, team: (playerData.teams[e.team-1]||{}).name, nowCost: e.now_cost, form: e.form, totalPoints: e.total_points, pointsPerGame: e.points_per_game, photoId: e.code, selectedBy: e.selected_by_percent }));
    return { player: up, reasons: [], replacements: candidates };
  });

  underperforming.forEach(up => {
    const r = replacements.find(r => r.player.elementId === up.elementId);
    const avgFDR = up.nextFixtures?.length ? up.nextFixtures.reduce((s,f) => s+f.difficulty, 0) / up.nextFixtures.length : 0;
    if (avgFDR >= 3.5) r.reasons.push(`Tough fixtures ahead (avg FDR ${avgFDR.toFixed(1)})`);
    if (parseFloat(up.form||0) < 2.0) r.reasons.push(`Poor form (${up.form} pts in last 5)`);
    if ((up.minutes||0) < 500) r.reasons.push(`Limited minutes (${up.minutes} total)`);
    if ((up.yellowCards||0) >= 4) r.reasons.push(`Yellow card risk (${up.yellowCards} cards)`);
    if (parseFloat(up.pointsPerGame||0) < 2.0) r.reasons.push(`Low PPG (${up.pointsPerGame})`);
    if (!r.reasons.length) r.reasons.push('Underperforming relative to cost');
  });

  const seasonHistory = (historyData.past || []).map((s, i) => ({
    season: s.season_name || `${2020+i}/${2021+i}`, rank: s.rank, points: s.total_points
  }));

  const chips = historyData.chips || [];

  return {
    managerInfo: {
      name: `${managerEntryData.player_first_name} ${managerEntryData.player_last_name}`,
      teamName: managerEntryData.name,
      overallRanking: managerEntryData.summary_overall_rank?.toLocaleString() || "N/A",
      overallRankRaw: managerEntryData.summary_overall_rank || 0,
      managerPoints: managerEntryData.summary_overall_points,
      chipsUsed: chips.map(c => c.name), chipsCount: chips.length,
      lastSeasonRank: historyData.past.length > 0 ? historyData.past[historyData.past.length - 1].rank.toLocaleString() : "Didn't Play",
      lastSeasonRankRaw: historyData.past.length > 0 ? historyData.past[historyData.past.length - 1].rank : null,
      seasonBeforeLastRank: historyData.past.length > 1 ? historyData.past[historyData.past.length - 2].rank.toLocaleString() : "Didn't Play",
      pointDifference: topManagerPoints - managerEntryData.summary_overall_points,
      totalPointsLostOnBench, totalCaptaincyPoints,
      captaincyEfficiency: totalCaptaincyAttempts > 0 ? Math.round((totalCaptaincyPoints / totalCaptaincyAttempts) * 10) / 10 : 0,
      currentGameweek, highestPoints, highestPointsGW, lowestPoints, lowestPointsGW,
      highestRank: highestRank.toLocaleString(), highestRankGW,
      lowestRank: lowestRank.toLocaleString(), lowestRankGW,
      averageRank: averageRank.toLocaleString(), rankTrend,
      rankTrendLabel: rankTrend > 0 ? 'improving' : rankTrend < 0 ? 'declining' : 'stable',
      totalTransfers: managerEntryData?.transfers?.cost || 0,
      templateScore: templateCount, differentialScore: players.length - templateCount,
      defensiveCleanSheets: totalCS, defensiveGoalsConceded: totalGC, defensiveSaves: totalSaves
    },
    playerStats: players.sort((a, b) => b.totalPointsActive - a.totalPointsActive),
    positionSummary: Object.entries(positionPoints).map(([position, pls]) => ({
      position, totalPoints: Object.values(pls).reduce((s, p) => s + p.points, 0),
      count: Object.keys(pls).length
    })),
    weeklyPoints, weeklyRanks, weeklyPointsLostBench,
    currentTeam, captainChoices, chipImpact, seasonHistory,
    underperforming: replacements
  };
}

const managerCache = {};

app.get('/api/analyze-manager/:managerId', async (req, res) => {
  const managerId = parsePositiveId(req.params.managerId);
  if (!managerId) return res.status(400).json({ error: 'Invalid manager ID' });
  try {
    const bs = await getCachedApiData(BOOTSTRAP_URL);
    const result = await analyzeManager(managerId, bs, 314);
    managerCache[managerId] = result;
    res.json(result);
  } catch (e) { console.error('Error:', e.message); res.status(500).json({ error: 'Failed to analyze manager' }); }
});

app.get('/api/compare-managers/:id1/:id2', async (req, res) => {
  const id1 = parsePositiveId(req.params.id1);
  const id2 = parsePositiveId(req.params.id2);
  if (!id1 || !id2) return res.status(400).json({ error: 'Invalid manager ID' });
  try {
    const bs = await getCachedApiData(BOOTSTRAP_URL);
    const [m1, m2] = await Promise.all([analyzeManager(id1, bs, 314), analyzeManager(id2, bs, 314)]);
    res.json({ manager1: m1, manager2: m2 });
  } catch (e) { res.status(500).json({ error: 'Failed to compare' }); }
});

app.get('/api/price-changes', async (req, res) => {
  try {
    const r = await getCachedApiData(BOOTSTRAP_URL);
    const map = p => ({ name: p.web_name, team: (r.teams.find(t=>t.id===p.team)||{}).name, photoId: p.code, change: p.cost_change_event, newCost: p.now_cost, selectedBy: p.selected_by_percent, form: p.form, totalPoints: p.total_points });
    const risers = r.elements.filter(p => p.cost_change_event > 0).sort((a,b) => b.cost_change_event-a.cost_change_event).slice(0,15).map(map);
    const fallers = r.elements.filter(p => p.cost_change_event < 0).sort((a,b) => a.cost_change_event-b.cost_change_event).slice(0,15).map(map);
    res.json({ risers, fallers });
  } catch (e) { res.status(500).json({ error: 'Failed' }); }
});

app.get('/api/league-standings/:leagueId', async (req, res) => {
  const requestedLeagueId = parsePositiveId(req.params.leagueId);
  if (!requestedLeagueId) return res.status(400).json({ error: 'Invalid league ID' });
  try {
    const leagueId = requestedLeagueId;
    const [bs, p1] = await Promise.all([
      getCachedApiData(BOOTSTRAP_URL),
      getCachedApiData(`https://fantasy.premierleague.com/api/leagues-classic/${leagueId}/standings/?page_standings=1&phase=1`)
    ]);
    const playerData = bs;
    let standings = p1.standings.results || [];
    // Fetch page 2 for top 50
    try {
      const p2 = await getCachedApiData(`https://fantasy.premierleague.com/api/leagues-classic/${leagueId}/standings/?page_standings=2&phase=1`);
      standings = standings.concat(p2.standings.results || []);
    } catch(e) { /* page 2 may not exist */ }
    standings = standings.slice(0, 50);
    const currentGW = playerData.events.find(e => e.is_current)?.id || 1;

    const enriched = [];
    const entries = standings;

    const batchSize = 3;
    for (let i = 0; i < entries.length; i += batchSize) {
      const batch = entries.slice(i, i + batchSize);
      const results = await Promise.allSettled(batch.map(async e => {
        const [histData, entryData] = await Promise.all([
          getCachedApiData(`https://fantasy.premierleague.com/api/entry/${e.entry}/history/`).catch(() => null),
          getCachedApiData(`https://fantasy.premierleague.com/api/entry/${e.entry}/`).catch(() => null)
        ]);
        return { history: histData, entry: entryData };
      }));
      results.forEach((res, idx) => {
        const entry = batch[idx];
        const hist = res.value?.history;
        const entryData = res.value?.entry;
        const past = hist?.past || [];
        const chips = hist?.chips || [];
        const currentGW = hist?.current?.length || 0;

        // Map season names to find specific past seasons
        const getSeasonRank = (season) => {
          const s = past.find(p => p.season_name === season);
          return s ? s.rank : null;
        };
        const lastSeasonRank = getSeasonRank('2024/25');
        const seasonBeforeLastRank = getSeasonRank('2023/24');

        // Chips filtered from GW20+
        const chipLabels = chips
          .filter(c => c.event >= 20)
          .map(c => {
            const label = ({ wildcard:'WC', freehit:'FH', bench_boost:'BB', '3xc':'TC', triple_captain:'TC', bboost:'BB' }[c.name.toLowerCase()]||c.name);
            return `${label} GW${c.event}`;
          });

        // Overall rank from entry API
        const overallRank = entryData?.summary_overall_rank || entry.overall_rank;

        // GW points from entry current data
        const gwPoints = hist?.current?.length > 0 ? hist.current[hist.current.length - 1].points : entry.event_total;

        enriched.push({
          rank: entry.rank, entry: entry.entry,
          playerName: entry.player_name, teamName: entry.entry_name,
          totalPoints: entry.total, overallRank: overallRank?.toLocaleString() || '—',
          lastRank: entry.last_rank, rankChange: (entry.last_rank || entry.rank) - entry.rank,
          gwPoints: gwPoints?.toLocaleString() || '—',
          lastSeasonRank: lastSeasonRank?.toLocaleString() || '—',
          seasonBeforeLastRank: seasonBeforeLastRank?.toLocaleString() || '—',
          chipsUsed: chipLabels.length ? chipLabels.join(', ') : 'None',
          immediateGain: '—',
          totalImmediateGain: '—'
        });
      });
    }

    res.json({
      leagueName: p1.data.league?.name || 'Classic League',
      currentGW,
      standings: enriched
    });
  } catch (e) {
    console.error('League error:', e.message);
    res.status(500).json({ error: 'Failed to fetch league standings' });
  }
});

// ---- Zone Analysis (Per-GW Match Breakdowns) ----
const ZONE_ANALYSIS_TTL = 120; // 2 minutes in seconds

app.get('/api/zone-analysis', async (req, res) => {
  try {
    const [bs, fixtures] = await Promise.all([
      getCachedApiData(BOOTSTRAP_URL),
      getCachedApiData(FIXTURES_URL)
    ]);

    const teams = bs.teams;
    const elements = bs.elements;
    const currentGW = bs.events.find(e => e.is_current)?.id || 1;
    const selectedGW = parseInt(req.query.gw) || currentGW;

    const cacheKey = `zone:${selectedGW}`;

    // Try Redis first
    if (redis) {
      try {
        const cached = await redis.get(cacheKey);
        if (cached) return res.json(cached);
      } catch (e) { /* fall through */ }
    }

    // Helper: get team by id
    const getTeam = id => teams.find(t => t.id === id) || { short_name: '?', name: 'Unknown' };

    // Assign detailed positions to players using web_name lookup
    const playersWithZones = elements.map(p => {
      const detailedPos = DETAILED_POSITIONS[p.web_name] || null;
      const broadPos = POSITION_MAP[p.element_type - 1];
      return {
        id: p.id, name: p.web_name, secondName: p.second_name, team: p.team,
        teamName: getTeam(p.team).short_name, broadPosition: broadPos,
        detailedPosition: detailedPos || broadPos, zone: detailedPos ? (ZONE_MAP[detailedPos] || null) : null,
        goals: p.goals_scored || 0, assists: p.assists || 0,
        expectedGoals: parseFloat(p.expected_goals) || 0,
        expectedAssists: parseFloat(p.expected_assists) || 0,
        expectedGoalInvolvements: parseFloat(p.expected_goal_involvements) || 0,
        expectedGoalsConceded: parseFloat(p.expected_goals_conceded) || 0,
        threat: parseFloat(p.threat) || 0, creativity: parseFloat(p.creativity) || 0,
        influence: parseFloat(p.influence) || 0, ictIndex: parseFloat(p.ict_index) || 0,
        form: parseFloat(p.form) || 0, minutes: p.minutes || 0,
        cleanSheets: p.clean_sheets || 0, goalsConceded: p.goals_conceded || 0,
        saves: p.saves || 0, bonus: p.bonus || 0, bps: p.bps || 0,
        defensiveContribution: p.defensive_contribution || 0,
        clearancesBlocksInterceptions: p.clearances_blocks_interceptions || 0,
        recoveries: p.recoveries || 0, tackles: p.tackles || 0,
        starts: p.starts || 0, chanceOfPlaying: p.chance_of_playing_next_round,
        status: p.status || 'a', valueSeason: parseFloat(p.value_season) || 0,
        yellowCards: p.yellow_cards || 0, redCards: p.red_cards || 0,
        nowCost: p.now_cost || 0, selectedByPercent: parseFloat(p.selected_by_percent) || 0,
        totalPoints: p.total_points || 0, code: p.code,
        pointsPerGame: parseFloat(p.points_per_game) || 0
      };
    });

    // Group players by team
    const teamGroups = {};
    playersWithZones.forEach(p => {
      if (!teamGroups[p.team]) teamGroups[p.team] = { GKP: [], DEF: [], MID: [], FWD: [] };
      if (p.broadPosition === 'GKP') teamGroups[p.team].GKP.push(p);
      else if (p.broadPosition === 'DEF') teamGroups[p.team].DEF.push(p);
      else if (p.broadPosition === 'FWD') teamGroups[p.team].FWD.push(p);
      else teamGroups[p.team].MID.push(p);
    });

    // Assign 4-2-3-1 zones
    // Players with zone from DETAILED_POSITIONS keep it.
    // Players without zone get assigned by position group.
    Object.entries(teamGroups).forEach(([teamId, group]) => {
      // GK
      const gkWithZone = group.GKP.find(p => p.zone);
      if (gkWithZone) { /* already set */ }
      else { const gk = [...group.GKP].sort((a, b) => b.minutes - a.minutes)[0]; if (gk) { gk.zone = 'gk'; gk.detailedPosition = 'GK'; } }

      // DEF: 4-2-3-1 = LB, LCB, RCB, RB
      const defZones = ['lb', 'lcb', 'rcb', 'rb'];
      const defWithZone = group.DEF.filter(p => p.zone);
      const defWithout = group.DEF.filter(p => !p.zone).sort((a, b) => b.minutes - a.minutes);
      // Fill unfilled DEF zones with remaining players
      const filledDefZones = defWithZone.map(p => p.zone);
      const openDefZones = defZones.filter(z => !filledDefZones.includes(z));
      openDefZones.forEach((z, i) => {
        if (i < defWithout.length) { defWithout[i].zone = z; defWithout[i].detailedPosition = z.toUpperCase(); }
      });

      // MID: 4-2-3-1 = LDM, RDM, LW, CAM, RW
      const midZones = ['ldm', 'rdm', 'lw', 'cam', 'rw'];
      const midWithZone = group.MID.filter(p => p.zone);
      const midWithout = group.MID.filter(p => !p.zone).sort((a, b) => b.minutes - a.minutes);
      const filledMidZones = midWithZone.map(p => p.zone);
      const openMidZones = midZones.filter(z => !filledMidZones.includes(z));
      openMidZones.forEach((z, i) => {
        if (i < midWithout.length) {
          midWithout[i].zone = z;
          midWithout[i].detailedPosition = (z === 'ldm' || z === 'rdm') ? 'CDM' : z.toUpperCase();
        }
      });

      // FWD: ST
      const fwdWithZone = group.FWD.find(p => p.zone);
      if (!fwdWithZone) {
        const fwd = [...group.FWD].sort((a, b) => b.minutes - a.minutes)[0];
        if (fwd) { fwd.zone = 'st'; fwd.detailedPosition = 'ST'; }
      }
    });

    // Build team analysis (reusable for all GW matchups)
    const buildTeamAnalysis = (teamId) => {
      const teamPlayers = playersWithZones.filter(p => p.team === teamId);
      const active = teamPlayers.filter(p => p.minutes > 0);
      // Pick best player per zone (by form, then minutes)
      const bestPerZone = {};
      ALL_ZONES.forEach(z => {
        const candidates = (active.length > 0 ? active : teamPlayers).filter(p => p.zone === z);
        if (candidates.length) bestPerZone[z] = candidates.sort((a, b) => b.form - a.form || b.minutes - a.minutes)[0];
      });
      const starters = Object.values(bestPerZone).filter(Boolean);

      const zoneStats = {};
      ALL_ZONES.forEach(z => { zoneStats[z] = { goals: 0, assists: 0, xG: 0, xA: 0, threat: 0, creativity: 0, goalsConceded: 0, xGC: 0, cleanSheets: 0, influence: 0, players: [] }; });

      starters.forEach(p => {
        if (!p.zone || !zoneStats[p.zone]) return;
        const z = zoneStats[p.zone];
        z.goals += p.goals;
        z.assists += p.assists;
        z.xG += p.expectedGoals;
        z.xA += p.expectedAssists;
        z.threat += p.threat;
        z.creativity += p.creativity;
        z.goalsConceded += p.goalsConceded;
        z.xGC += p.expectedGoalsConceded;
        z.influence += p.influence;
        z.cleanSheets += p.cleanSheets;
        z.players.push({
          name: p.name, position: p.detailedPosition, broadPos: p.broadPosition, zone: p.zone,
          goals: p.goals, assists: p.assists, xG: p.expectedGoals, xA: p.expectedAssists,
          xGI: p.expectedGoalInvolvements, threat: p.threat, creativity: p.creativity,
           influence: p.influence, ict: p.ictIndex, form: p.form, cost: p.nowCost,
           totalPoints: p.totalPoints, minutes: p.minutes, bonus: p.bonus,
           selectedBy: p.selectedByPercent, id: p.id, code: p.code,
           pointsPerGame: p.pointsPerGame, goalsConceded: p.goalsConceded,
           cleanSheets: p.cleanSheets, xGC: p.expectedGoalsConceded, saves: p.saves,
           yellowCards: p.yellowCards, defensiveContribution: p.defensiveContribution,
           clearancesBlocksInterceptions: p.clearancesBlocksInterceptions,
           recoveries: p.recoveries, tackles: p.tackles, starts: p.starts,
           status: p.status, chanceOfPlaying: p.chanceOfPlaying,
           valueSeason: p.valueSeason, team: p.teamName
         });
      });

      const gk = starters.find(p => p.broadPosition === 'GKP');
      const defenders = starters.filter(p => p.broadPosition === 'DEF');
      const defensiveReference = gk || [...defenders].sort((a, b) => b.minutes - a.minutes)[0];
      const teamCS = defensiveReference?.cleanSheets || 0;
      const teamGC = defensiveReference?.goalsConceded || 0;
      const referenceStarts = Math.max(defensiveReference?.starts || Math.round((defensiveReference?.minutes || 0) / 90), 1);
      const cleanSheetRate = teamCS / referenceStarts;
      const xgcPer90 = defensiveReference?.minutes > 0
        ? (defensiveReference.expectedGoalsConceded * 90) / defensiveReference.minutes
        : 1.5;
      const defensiveContributors = starters.filter(p => p.broadPosition === 'DEF' || p.broadPosition === 'MID');
      const avgDefconPer90 = defensiveContributors.length
        ? defensiveContributors.reduce((sum, p) => sum + ((p.defensiveContribution * 90) / Math.max(p.minutes, 90)), 0) / defensiveContributors.length
        : 0;
      const defconNorm = Math.max(0, Math.min(100,
        (cleanSheetRate * 55) +
        (Math.max(0, 1 - (xgcPer90 / 2)) * 30) +
        (Math.min(avgDefconPer90 / 12, 1) * 15)
      ));

      let strongestAttack = 'st';
      let maxAtk = 0;
      ATTACKING_ZONES.forEach(z => {
        const score = (zoneStats[z]?.xG || 0) + (zoneStats[z]?.xA || 0);
        if (score > maxAtk) { maxAtk = score; strongestAttack = z; }
      });

      let weakestDefence = 'lcb';
      let maxWeakness = -Infinity;
      DEFENSIVE_ZONES.forEach(z => {
        const zonePlayer = zoneStats[z]?.players?.[0];
        if (!zonePlayer) return;
        const zoneMinutes = Math.max(zonePlayer.minutes, 90);
        const weakness = ((zonePlayer.xGC * 90) / zoneMinutes) -
          (((zonePlayer.defensiveContribution || 0) * 90) / zoneMinutes / 20) -
          (((zonePlayer.tackles || 0) * 90) / zoneMinutes / 10);
        if (weakness > maxWeakness) { maxWeakness = weakness; weakestDefence = z; }
      });

      const topDef = [...defenders].sort((a, b) => b.influence - a.influence)[0];

      const totalGoals = active.reduce((s, p) => s + p.goals, 0);
      const totalAssists = active.reduce((s, p) => s + p.assists, 0);
      const totalXG = active.reduce((s, p) => s + p.expectedGoals, 0);
      const totalXA = active.reduce((s, p) => s + p.expectedAssists, 0);

      return {
        teamId, teamName: getTeam(teamId).short_name, teamFullName: getTeam(teamId).name,
        zoneStats,
        gk: gk ? { name: gk.name, saves: gk.saves, cs: gk.cleanSheets, gc: gk.goalsConceded, form: gk.form, cost: gk.nowCost, code: gk.code, xGC: gk.expectedGoalsConceded, pts: gk.totalPoints } : null,
        totalGoals, totalAssists, totalXG, totalXA, totalGC: teamGC,
        strongestAttack, strongestAttackZone: ZONE_LABELS[strongestAttack],
        weakestDefence, weakestDefenceZone: ZONE_LABELS[weakestDefence],
        defcon: Math.round(defconNorm),
        defconLabel: defconNorm >= 58 ? 'Strong' : defconNorm >= 38 ? 'Average' : 'Weak',
        topDefender: topDef ? { name: topDef.name, position: topDef.detailedPosition, influence: topDef.influence, cs: topDef.cleanSheets, cost: topDef.nowCost, code: topDef.code, form: topDef.form } : null,
        teamCS
      };
    };

    // Build all team analyses
    const teamAnalysisMap = {};
    teams.forEach(t => { teamAnalysisMap[t.id] = buildTeamAnalysis(t.id); });

    const fixtureModifier = difficulty => ({ 1: 1.2, 2: 1.1, 3: 1, 4: 0.9, 5: 0.78 }[difficulty] || 1);
    const attackTargetsWeakness = (attackZone, weakZone) => ({
      lw: ['rb'],
      rw: ['lb'],
      cam: ['lcb', 'rcb'],
      st: ['lcb', 'rcb']
    }[attackZone] || []).includes(weakZone);
    const clampScore = value => Math.round(Math.max(0, Math.min(99, value)));
    const per90 = (value, minutes) => (Number(value || 0) * 90) / Math.max(Number(minutes || 0), 90);

    const buildTargetGroups = (teamId, team, opponent, difficulty, isHome) => {
      const candidates = playersWithZones.filter(p =>
        p.team === teamId &&
        p.minutes > 0 &&
        p.status !== 'u' &&
        p.status !== 'n' &&
        p.chanceOfPlaying !== 0
      );
      if (!candidates.length) return [];

      const maxMinutes = Math.max(...candidates.map(p => p.minutes), 1);
      const maxStarts = Math.max(...candidates.map(p => p.starts), Math.round(maxMinutes / 90), 1);
      const opponentAttackPerMatch = (opponent.totalXG + opponent.totalXA) / maxStarts;
      const difficultyMod = fixtureModifier(difficulty) * (isHome ? 1.04 : 1);
      const directZoneMatch = attackTargetsWeakness(team.strongestAttack, opponent.weakestDefence);

      const scored = candidates.map(player => {
        const minutesShare = Math.min(player.minutes / maxMinutes, 1);
        const startShare = Math.min(player.starts / maxStarts, 1);
        const minutesSecurity = (minutesShare * 0.35) + (startShare * 0.65);
        const availability = player.chanceOfPlaying == null ? 1 : player.chanceOfPlaying / 100;
        const readiness = (0.55 + (minutesSecurity * 0.45)) * availability;

        // Per-90 rates
        const goalRate = per90(player.goals, player.minutes);
        const assistRate = per90(player.assists, player.minutes);
        const xg90 = per90(player.expectedGoals, player.minutes);
        const xa90 = per90(player.expectedAssists, player.minutes);
        const xgi90 = xg90 + xa90;
        const threat90 = per90(player.threat, player.minutes);
        const creativity90 = per90(player.creativity, player.minutes);
        const saves90 = per90(player.saves, player.minutes);
        const defcon90 = per90(player.defensiveContribution, player.minutes);
        const tackles90 = per90(player.tackles, player.minutes);
        const cbi90 = per90(player.clearancesBlocksInterceptions, player.minutes);
        const recoveries90 = per90(player.recoveries, player.minutes);
        const bonusPerStart = player.bonus / Math.max(player.starts, 1);
        const cleanSheetRate = player.cleanSheets / Math.max(player.starts, 1);
        const zoneBoost = directZoneMatch && player.zone === team.strongestAttack ? 1.12 : 1;

        // Opponent weakness: does this player's zone attack the opponent's weak side?
        const playerZoneWeak = attackTargetsWeakness(player.zone, opponent.weakestDefence);
        const weaknessBoost = playerZoneWeak ? 1.10 : 1;

        // === ROUTE 1: Attacking returns (goals + assists) ===
        const attackPoints = (
          (xg90 * 5.5) +        // xG -> expected goals -> ~5.5 pts each
          (xa90 * 4.0) +        // xA -> expected assists -> ~4 pts each
          (goalRate * 4.8) +    // actual goals weighted
          (assistRate * 3.5) +  // actual assists weighted
          (threat90 * 0.3) +    // shot threat as signal
          (creativity90 * 0.2) + // chance creation as signal
          (player.form * 0.8) + // recent form
          (player.pointsPerGame * 0.6) // historical output
        ) * difficultyMod * zoneBoost * weaknessBoost * readiness;

        // === ROUTE 2: Defensive returns (DEFCON + clean sheets) ===
        const defensivePoints = (
          (defcon90 * 2.0) +    // DEFCON points per 90
          (tackles90 * 0.4) +   // tackles as bonus signal
          (cbi90 * 0.15) +      // clearances/blocks/interceptions
          (recoveries90 * 0.1) + // ball recoveries
          (cleanSheetRate * 4.0) + // clean sheet probability * pts
          (team.defcon * 0.08) + // team defensive profile
          (bonusPerStart * 1.5)  // bonus tendency
        ) * difficultyMod * readiness;

        // === ROUTE 3: GK returns (saves + clean sheets) ===
        const gkPoints = (
          (saves90 * 1.0) +     // save points
          (cleanSheetRate * 4.0) + // clean sheet pts
          (bonusPerStart * 1.5) + // bonus
          (Math.min(opponentAttackPerMatch, 2.5) * 1.2) // more shots = more saves
        ) * (0.85 + (difficulty * 0.05)) * availability;

        // === Composite: best route for this player ===
        const bestRoute = Math.max(attackPoints, defensivePoints, gkPoints);

        // === Minutes certainty as a final multiplier ===
        const minutesMultiplier = 0.5 + (minutesSecurity * 0.5); // 0.5 to 1.0

        // === Final expected points ===
        const expectedPoints = clampScore(bestRoute * minutesMultiplier);

        // Keep individual category scores for the target groups
        const goalScore = clampScore(attackPoints * 0.8);
        const assistScore = clampScore(attackPoints * 0.7);
        const cleanSheetScore = clampScore(defensivePoints * 0.9);
        const saveScore = clampScore(gkPoints);
        const defconScore = clampScore(defensivePoints);
        const valueScore = clampScore(((bestRoute / Math.max(player.nowCost / 10, 4)) * 7) + (minutesSecurity * 24));

        return {
          ...player,
          minutesSecurity: clampScore(minutesSecurity * 100),
          rates: {
            xG90: Number(xg90.toFixed(2)), xA90: Number(xa90.toFixed(2)),
            saves90: Number(saves90.toFixed(1)), defcon90: Number(defcon90.toFixed(1))
          },
          scores: { goals: goalScore, assists: assistScore, cleanSheet: cleanSheetScore, saves: saveScore, defcon: defconScore, value: valueScore, composite: expectedPoints }
        };
      });

      const serialize = (player, category, reason) => ({
        id: player.id, name: player.name, code: player.code, team: player.teamName,
        position: player.detailedPosition, broadPosition: player.broadPosition,
        zone: player.zone, cost: player.nowCost, form: player.form,
        pointsPerGame: player.pointsPerGame, totalPoints: player.totalPoints,
        goals: player.goals, assists: player.assists, xG: player.expectedGoals,
        xA: player.expectedAssists, cleanSheets: player.cleanSheets,
        saves: player.saves, defensiveContribution: player.defensiveContribution,
        bonus: player.bonus, minutes: player.minutes, starts: player.starts,
        ownership: player.selectedByPercent, minutesSecurity: player.minutesSecurity,
        rates: player.rates, score: player.scores[category], compositeScore: player.scores.composite, reason
      });
      const ranked = (category, filter, reason) => scored
        .filter(player => player.minutesSecurity >= 65 && filter(player))
        .sort((a, b) => b.scores[category] - a.scores[category] || b.minutesSecurity - a.minutesSecurity)
        .slice(0, 1)
        .map(player => serialize(player, category, reason(player)));

      return [
        {
          key: 'goals', label: 'Goal threat', icon: 'sports_soccer',
          picks: ranked('goals', p => p.broadPosition !== 'GKP', p =>
            `${p.rates.xG90} xG/90 into ${opponent.weakestDefenceZone}${directZoneMatch && p.zone === team.strongestAttack ? ' with a direct zone edge' : ''}.`)
        },
        {
          key: 'assists', label: 'Assist route', icon: 'conversion_path',
          picks: ranked('assists', p => p.broadPosition !== 'GKP', p =>
            `${p.rates.xA90} xA/90 and ${p.assists} assists; creativity is the main return route.`)
        },
        {
          key: 'cleanSheet', label: 'Clean sheet', icon: 'shield',
          picks: ranked('cleanSheet', p => p.broadPosition === 'GKP' || p.broadPosition === 'DEF', () =>
            `${team.defcon}/100 team DEFCON against an attack averaging ${opponentAttackPerMatch.toFixed(2)} xGI per start.`)
        },
        {
          key: 'saves', label: 'Save potential', icon: 'front_hand',
          picks: ranked('saves', p => p.broadPosition === 'GKP', p =>
            `${p.rates.saves90} saves/90 offers a second route to points if the clean sheet goes.`)
        },
        {
          key: 'defcon', label: 'DEFCON + bonus', icon: 'security',
          picks: ranked('defcon', p => p.broadPosition === 'DEF' || p.broadPosition === 'MID', p =>
            `${p.rates.defcon90} defensive contributions/90 with ${p.bonus} bonus points.`)
        },
        {
          key: 'value', label: 'Minutes + value', icon: 'savings',
          picks: ranked('value', () => true, p =>
            `${p.minutesSecurity}% minutes security at £${(p.nowCost / 10).toFixed(1)}m.`)
        }
      ].filter(group => group.picks.length > 0);
    };

    // Get fixtures for selected GW
    const gwFixtures = fixtures.filter(f => f.event === selectedGW);

    // Build per-match breakdowns
    const matchBreakdowns = gwFixtures.map(fixture => {
      const homeTeam = getTeam(fixture.team_h);
      const awayTeam = getTeam(fixture.team_a);
      const home = teamAnalysisMap[fixture.team_h];
      const away = teamAnalysisMap[fixture.team_a];
      if (!home || !away) return null;

       const homeFDR = fixture.team_h_difficulty || 3;
       const awayFDR = fixture.team_a_difficulty || 3;

      // Determine danger zones for each side
      const homeDangerZone = home.strongestAttack;
      const homeDangerPlayers = home.zoneStats[homeDangerZone]?.players || [];
      const awayDangerZone = away.strongestAttack;
      const awayDangerPlayers = away.zoneStats[awayDangerZone]?.players || [];

      // Determine vulnerability zones
      const homeVulnZone = home.weakestDefence;
      const homeVulnPlayers = home.zoneStats[homeVulnZone]?.players || [];
      const awayVulnZone = away.weakestDefence;
      const awayVulnPlayers = away.zoneStats[awayVulnZone]?.players || [];

      // Best attacking picks from home team (vs away weakness)
      const homeAttackPicks = homeDangerPlayers
        .sort((a, b) => (b.xG + b.xA) - (a.xG + a.xA))
        .slice(0, 5)
        .map(p => ({
           ...p, reason: `Strongest zone: ${ZONE_LABELS[homeDangerZone]}`,
           zoneTarget: ZONE_LABELS[awayVulnZone],
           zoneMatch: homeDangerZone === awayVulnZone
         }));

      // Best attacking picks from away team (vs home weakness)
      const awayAttackPicks = awayDangerPlayers
        .sort((a, b) => (b.xG + b.xA) - (a.xG + a.xA))
        .slice(0, 5)
        .map(p => ({
           ...p, reason: `Strongest zone: ${ZONE_LABELS[awayDangerZone]}`,
           zoneTarget: ZONE_LABELS[homeVulnZone],
           zoneMatch: awayDangerZone === homeVulnZone
         }));

      // Best defensive picks from home team (if away attack is weak)
      const awayAttackTotal = away.totalXG + away.totalXA;
      const homeDefPicks = awayAttackTotal < 30 ?
        (home.zoneStats[homeVulnZone]?.players || [])
          .sort((a, b) => b.influence - a.influence)
          .slice(0, 3)
          .map(p => ({
            ...p, reason: awayAttackTotal < 20 ? 'Opponent very weak attack' : 'Opponent below avg attack',
            defensivePick: true
          })) : [];

      // Best defensive picks from away team (if home attack is weak)
      const homeAttackTotal = home.totalXG + home.totalXA;
      const awayDefPicks = homeAttackTotal < 30 ?
        (away.zoneStats[awayVulnZone]?.players || [])
          .sort((a, b) => b.influence - a.influence)
          .slice(0, 3)
          .map(p => ({
            ...p, reason: homeAttackTotal < 20 ? 'Opponent very weak attack' : 'Opponent below avg attack',
            defensivePick: true
          })) : [];

      // DEFCON matchup
      const homeDefconAdvantage = home.defcon - away.defcon;

      // Top 3 players each side by form
      const homeTopByForm = playersWithZones
        .filter(p => p.team === fixture.team_h && p.minutes > 100)
        .sort((a, b) => b.form - a.form)
        .slice(0, 3)
        .map(p => ({ name: p.name, position: p.broadPosition, form: p.form, cost: p.nowCost, code: p.code, xGI: p.expectedGoalInvolvements, pts: p.totalPoints }));

      const awayTopByForm = playersWithZones
        .filter(p => p.team === fixture.team_a && p.minutes > 100)
        .sort((a, b) => b.form - a.form)
        .slice(0, 3)
        .map(p => ({ name: p.name, position: p.broadPosition, form: p.form, cost: p.nowCost, code: p.code, xGI: p.expectedGoalInvolvements, pts: p.totalPoints }));

      const homeTargets = buildTargetGroups(fixture.team_h, home, away, homeFDR, true);
      const awayTargets = buildTargetGroups(fixture.team_a, away, home, awayFDR, false);

      // Combined best 4 picks across both teams, ranked by expected points (holistic model)
      const allPicks = [...homeTargets, ...awayTargets]
        .flatMap(g => g.picks.map(p => ({ ...p, sourceGroup: g.key, sourceLabel: g.label, sourceIcon: g.icon })))
        .filter(p => (p.minutesSecurity || 0) >= 60)
        .map(p => {
          // Determine the dominant route for the reason
          const isAttacking = p.sourceGroup === 'goals' || p.sourceGroup === 'assists';
          const isDefensive = p.sourceGroup === 'cleanSheet' || p.sourceGroup === 'defcon';
          const isGK = p.sourceGroup === 'saves';
          const route = isAttacking ? 'attacking threat' : isDefensive ? 'defensive solidity' : isGK ? 'save potential' : 'overall value';
          return { ...p, score: p.compositeScore || p.score, reason: `${p.reason} Best route: ${route}.` };
        })
        .sort((a, b) => (b.score || 0) - (a.score || 0) || (b.minutesSecurity || 0) - (a.minutesSecurity || 0));
      const seen = new Set();
      const bestPicks = [];
      for (const pick of allPicks) {
        if (bestPicks.length >= 4) break;
        if (seen.has(pick.id)) continue;
        seen.add(pick.id);
        bestPicks.push(pick);
      }

      return {
        fixture: {
          id: fixture.id,
          gw: selectedGW, homeTeam: home.teamName, awayTeam: away.teamName,
          homeTeamFull: home.teamFullName, awayTeamFull: away.teamFullName,
          homeFDR, awayFDR, difficulty: homeFDR,
          kickoff: fixture.kickoff_time || null,
          team_h: fixture.team_h, team_a: fixture.team_a,
          team_h_score: fixture.team_h_score, team_a_score: fixture.team_a_score,
          finished: fixture.finished || false
         },
         home: {
           teamName: home.teamName, teamFullName: home.teamFullName,
           zoneStats: home.zoneStats,
           strongestAttack: home.strongestAttack, strongestAttackZone: home.strongestAttackZone,
           weakestDefence: home.weakestDefence, weakestDefenceZone: home.weakestDefenceZone,
           gk: home.gk, totalXG: home.totalXG, totalXA: home.totalXA,
           totalGoals: home.totalGoals, totalAssists: home.totalAssists, totalGC: home.totalGC,
          defcon: home.defcon, defconLabel: home.defconLabel,
           teamCS: home.teamCS, topDefender: home.topDefender,
           attackPicks: homeAttackPicks, defPicks: homeDefPicks,
           topByForm: homeTopByForm, targetGroups: homeTargets
         },
         away: {
           teamName: away.teamName, teamFullName: away.teamFullName,
           zoneStats: away.zoneStats,
           strongestAttack: away.strongestAttack, strongestAttackZone: away.strongestAttackZone,
           weakestDefence: away.weakestDefence, weakestDefenceZone: away.weakestDefenceZone,
           gk: away.gk, totalXG: away.totalXG, totalXA: away.totalXA,
           totalGoals: away.totalGoals, totalAssists: away.totalAssists, totalGC: away.totalGC,
          defcon: away.defcon, defconLabel: away.defconLabel,
           teamCS: away.teamCS, topDefender: away.topDefender,
           attackPicks: awayAttackPicks, defPicks: awayDefPicks,
           topByForm: awayTopByForm, targetGroups: awayTargets
        },
        homeDefconAdvantage,
        prediction: homeAttackTotal > awayAttackTotal ? home.teamName :
                    awayAttackTotal > homeAttackTotal ? away.teamName : 'Even',
        bestPicks
      };
    }).filter(Boolean);

    // Build overall recommendations for next 5 GWs
    const allRecommendations = [];
    const nextGWs = [];
    for (let gw = currentGW; gw <= Math.min(currentGW + 5, 38); gw++) {
      nextGWs.push(gw);
      const gwFxs = fixtures.filter(f => f.event === gw);
      gwFxs.forEach(fixture => {
        const home = teamAnalysisMap[fixture.team_h];
        const away = teamAnalysisMap[fixture.team_a];
        if (!home || !away) return;

        const isHome = true;

        // Attacking picks
        const homeAtkPlayers = home.zoneStats[home.strongestAttack]?.players || [];
        const awayAtkPlayers = away.zoneStats[away.strongestAttack]?.players || [];

        if (homeAtkPlayers.length > 0) {
           const zoneMatch = home.strongestAttack === away.weakestDefence;
          allRecommendations.push({
            gw, attackingTeam: home.teamName, defendingTeam: away.teamName,
            isHome: true, type: 'attack',
            attackZone: home.strongestAttackZone, weakZone: away.weakestDefenceZone,
            zoneMatch, strength: Math.round((home.zoneStats[home.strongestAttack].xG + home.zoneStats[home.strongestAttack].xA) * 10) / 10,
            players: homeAtkPlayers.sort((a, b) => (b.xG + b.xA) - (a.xG + a.xA)).slice(0, 5)
          });
        }
        if (awayAtkPlayers.length > 0) {
           const zoneMatch = away.strongestAttack === home.weakestDefence;
          allRecommendations.push({
            gw, attackingTeam: away.teamName, defendingTeam: home.teamName,
            isHome: false, type: 'attack',
            attackZone: away.strongestAttackZone, weakZone: home.weakestDefenceZone,
            zoneMatch, strength: Math.round((away.zoneStats[away.strongestAttack].xG + away.zoneStats[away.strongestAttack].xA) * 10) / 10,
            players: awayAtkPlayers.sort((a, b) => (b.xG + b.xA) - (a.xG + a.xA)).slice(0, 5)
          });
        }

        // Defensive picks (when opponent attack is weak)
        if (away.totalXG + away.totalXA < 30 && home.zoneStats[home.weakestDefence]?.players.length > 0) {
          allRecommendations.push({
            gw, attackingTeam: home.teamName, defendingTeam: away.teamName,
            isHome: true, type: 'defence',
            reason: `vs weak attack (${(away.totalXG + away.totalXA).toFixed(1)} xGI)`,
            strength: Math.round(home.defcon),
            players: home.zoneStats[home.weakestDefence].players
              .sort((a, b) => b.influence - a.influence).slice(0, 3)
              .map(p => ({ ...p, defensivePick: true }))
          });
        }
        if (home.totalXG + home.totalXA < 30 && away.zoneStats[away.weakestDefence]?.players.length > 0) {
          allRecommendations.push({
            gw, attackingTeam: away.teamName, defendingTeam: home.teamName,
            isHome: false, type: 'defence',
            reason: `vs weak attack (${(home.totalXG + home.totalXA).toFixed(1)} xGI)`,
            strength: Math.round(away.defcon),
            players: away.zoneStats[away.weakestDefence].players
              .sort((a, b) => b.influence - a.influence).slice(0, 3)
              .map(p => ({ ...p, defensivePick: true }))
          });
        }
      });
    }

    allRecommendations.sort((a, b) => b.strength - a.strength);

    const responseData = {
      currentGW, selectedGW, nextGWs,
      matchBreakdowns,
      recommendations: allRecommendations.slice(0, 50),
      teamAnalysis: Object.values(teamAnalysisMap).sort((a, b) => b.totalXG - a.totalXG),
      zoneLabels: ZONE_LABELS
    };
    // Cache in Redis
    if (redis) {
      try { await redis.setex(cacheKey, ZONE_ANALYSIS_TTL, responseData); } catch (e) { /* ignore */ }
    }
    res.json(responseData);
  } catch (e) {
    console.error('Zone analysis error:', e.message);
    res.status(500).json({ error: 'Failed to perform zone analysis' });
  }
});

// ---- Fixtures Detail (Next 5 GWs for all teams) ----
app.get('/api/fixtures-detail', async (req, res) => {
  try {
    const [bs, fixtures] = await Promise.all([
      getCachedApiData(BOOTSTRAP_URL),
      getCachedApiData(FIXTURES_URL)
    ]);

    const teams = bs.teams;
    const elements = bs.elements;
    const currentGW = bs.events.find(e => e.is_current)?.id || 1;
    const selectedGW = parseInt(req.query.gw) || currentGW;
    const getTeam = id => teams.find(t => t.id === id) || { short_name: '?', name: 'Unknown' };

    // Build per-GW fixture lists for next 5 GWs
    const gwSchedule = {};
    for (let gw = selectedGW; gw <= Math.min(selectedGW + 4, 38); gw++) {
      const gwFxs = fixtures.filter(f => f.event === gw).map(f => ({
        homeTeam: getTeam(f.team_h).short_name,
        awayTeam: getTeam(f.team_a).short_name,
        homeTeamFull: getTeam(f.team_h).name,
        awayTeamFull: getTeam(f.team_a).name,
        difficulty: f.difficulty || 3,
        team_h: f.team_h, team_a: f.team_a,
        kickoff: f.kickoff_time || null,
        team_h_score: f.team_h_score, team_a_score: f.team_a_score
      }));
      gwSchedule[gw] = gwFxs;
    }

    // Per-team next 5 fixtures with top 5 players by form
    const teamFixtures = teams.map(team => {
      const nextFixtures = [];
      for (let gw = selectedGW; gw <= Math.min(selectedGW + 4, 38); gw++) {
        const fx = fixtures.find(f => f.event === gw && (f.team_h === team.id || f.team_a === team.id));
        if (fx) {
          const isHome = fx.team_h === team.id;
          const opp = getTeam(isHome ? fx.team_a : fx.team_h);
          nextFixtures.push({
            gw, opponent: opp.short_name, opponentFull: opp.name,
            isHome, difficulty: fx.difficulty || 3,
            kickoff: fx.kickoff_time || null
          });
        }
      }

      // Top 5 players by form in last 3 GWs (or overall form if no GW data)
      const teamPlayers = elements
        .filter(e => e.team === team.id && e.minutes > 0)
        .sort((a, b) => parseFloat(b.form) - parseFloat(a.form))
        .slice(0, 5)
        .map(p => ({
          name: p.web_name, position: POSITION_MAP[p.element_type - 1],
          form: parseFloat(p.form) || 0, totalPoints: p.total_points || 0,
          pointsPerGame: parseFloat(p.points_per_game) || 0,
          xGI: parseFloat(p.expected_goal_involvements) || 0,
          cost: p.now_cost || 0, code: p.code, selectedBy: parseFloat(p.selected_by_percent) || 0,
          goals: p.goals_scored || 0, assists: p.assists || 0,
          ictIndex: parseFloat(p.ict_index) || 0
        }));

      // FDR sum for next 5
      const fdrSum = nextFixtures.reduce((s, f) => s + f.difficulty, 0);
      const avgFDR = nextFixtures.length > 0 ? (fdrSum / nextFixtures.length).toFixed(1) : '—';

      return {
        teamId: team.id, teamName: team.short_name, teamFullName: team.name,
        nextFixtures, fdrSum, avgFDR,
        topPlayers: teamPlayers
      };
    });

    res.json({
      currentGW, selectedGW, gwSchedule, teamFixtures
    });
  } catch (e) {
    console.error('Fixtures detail error:', e.message);
    res.status(500).json({ error: 'Failed to fetch fixture details' });
  }
});

// ---- Captain Picks ----
app.get('/api/captain-picks', async (req, res) => {
  try {
    const [bootstrap, fixtures] = await Promise.all([
      getCachedApiData(BOOTSTRAP_URL),
      getCachedApiData(FIXTURES_URL)
    ]);
    res.json(buildCaptaincyModel({ bootstrap, fixtures, selectedGW: req.query.gw }));
  } catch (e) {
    console.error('Captain picks error:', e.message);
    res.status(500).json({ error: 'Failed to calculate captain picks' });
  }
});

// ---- Ownership Tracking ----
app.get('/api/ownership/history', async (req, res) => {
  if (!requireDatabase(req, res)) return;
  try {
    const result = await sql`SELECT timestamp, players FROM ownership_snapshots ORDER BY timestamp ASC`;
    const snapshots = result;
    const now = Date.now();
    const SEVEN_DAYS = 7 * 24 * 60 * 60 * 1000;
    const THREE_DAYS = 3 * 24 * 60 * 60 * 1000;
    const ONE_DAY = 24 * 60 * 60 * 1000;

    // Find snapshots closest to 7d, 3d, 1d ago
    const findClosest = (targetMs) => {
      let best = null, bestDiff = Infinity;
      for (const s of snapshots) {
        const diff = Math.abs(s.timestamp - targetMs);
        if (diff < bestDiff) { bestDiff = diff; best = s; }
      }
      return best;
    };

    const sevenDaysAgo = findClosest(now - SEVEN_DAYS);
    const threeDaysAgo = findClosest(now - THREE_DAYS);
    const oneDayAgo = findClosest(now - ONE_DAY);
    const latest = snapshots.length > 0 ? snapshots[snapshots.length - 1] : null;

    res.json({
      snapshotsCount: snapshots.length,
      latestTimestamp: latest?.timestamp || null,
      snapshots: snapshots.map(s => ({ timestamp: s.timestamp, playerCount: Object.keys(s.players || {}).length })),
      sevenDaysAgo: sevenDaysAgo || null,
      threeDaysAgo: threeDaysAgo || null,
      oneDayAgo: oneDayAgo || null,
      current: latest || null
    });
  } catch (e) {
    console.error('Ownership history error:', e.message);
    res.status(500).json({ error: 'Failed to fetch ownership history' });
  }
});

app.post('/api/ownership/snapshot', async (req, res) => {
  if (!requireDatabase(req, res)) return;
  try {
    // Check throttle - get last snapshot
    const lastResult = await sql`SELECT timestamp FROM ownership_snapshots ORDER BY timestamp DESC LIMIT 1`;
    const now = Date.now();
    const THROTTLE = 60 * 60 * 1000; // 1 hour throttle
    
    if (lastResult.length > 0 && (now - lastResult[0].timestamp) < THROTTLE) {
      // Return existing sparkline data
      const recentForSparkline = await sql`SELECT timestamp, players FROM ownership_snapshots ORDER BY timestamp DESC LIMIT 14`;
      return res.json({ 
        ok: true, 
        message: 'Snapshot already recent, skipping', 
        skipped: true, 
        sparklineData: recentForSparkline.reverse(),
        snapshotCount: (await sql`SELECT COUNT(*) as count FROM ownership_snapshots`)[0].count
      });
    }

    const bs = await getCachedApiData(BOOTSTRAP_URL);
    const players = {};
    bs.elements
      .sort((a, b) => parseFloat(b.selected_by_percent) - parseFloat(a.selected_by_percent))
      .slice(0, 100)
      .forEach(p => {
        const team = bs.teams.find(t => t.id === p.team);
        players[p.id] = {
          name: p.web_name,
          team: team?.short_name || '',
          teamFull: team?.name || '',
          code: p.code,
          position: POSITION_MAP[p.element_type - 1],
          cost: p.now_cost,
          ownership: parseFloat(p.selected_by_percent) || 0,
          transfersIn: p.transfers_in_event || 0,
          transfersOut: p.transfers_out_event || 0
        };
      });

    // Insert snapshot
    await sql`INSERT INTO ownership_snapshots (timestamp, players) VALUES (${now}, ${JSON.stringify(players)})`;

    // Clean up old snapshots (keep 30 days)
    const THIRTY_DAYS = 30 * 24 * 60 * 60 * 1000;
    const cutoff = now - THIRTY_DAYS;
    await sql`DELETE FROM ownership_snapshots WHERE timestamp < ${cutoff}`;

    // Return full data for sparklines (last 14 snapshots)
    const recentForSparkline = await sql`SELECT timestamp, players FROM ownership_snapshots ORDER BY timestamp DESC LIMIT 14`;
    const snapshotCount = (await sql`SELECT COUNT(*) as count FROM ownership_snapshots`)[0].count;

    res.json({ ok: true, snapshotCount: parseInt(snapshotCount), playerCount: Object.keys(players).length, sparklineData: recentForSparkline.reverse() });
  } catch (e) {
    console.error('Ownership snapshot error:', e.message);
    res.status(500).json({ error: 'Failed to create snapshot' });
  }
});

// ---- Ownership Trends Detailed API ----
app.get('/api/ownership/trends', async (req, res) => {
  try {
    const bs = await getCachedApiData(BOOTSTRAP_URL);
    let snapshots = [];
    try {
      snapshots = await sql`SELECT timestamp, players FROM ownership_snapshots ORDER BY timestamp ASC`;
    } catch (dbErr) {
      console.warn('Neon DB query warning (falling back to live calculations):', dbErr.message);
    }

    const totalManagers = bs.total_players || 10000000;
    const now = Date.now();
    const latestSnapshot = snapshots.length > 0 ? snapshots[snapshots.length - 1] : null;

    // Time ago string calculation
    let lastSnapshotTimeStr = 'Just now';
    if (latestSnapshot) {
      const diffMins = Math.floor((now - latestSnapshot.timestamp) / 60000);
      if (diffMins < 1) lastSnapshotTimeStr = 'Just now';
      else if (diffMins < 60) lastSnapshotTimeStr = `${diffMins}m ago`;
      else lastSnapshotTimeStr = `${Math.floor(diffMins / 60)}h ago`;
    }

    const ONE_DAY = 24 * 60 * 60 * 1000;
    const THREE_DAYS = 3 * ONE_DAY;
    const SEVEN_DAYS = 7 * ONE_DAY;

    const findClosestSnapshot = (targetMs) => {
      if (snapshots.length === 0) return null;
      let best = null, bestDiff = Infinity;
      for (const s of snapshots) {
        const diff = Math.abs(s.timestamp - targetMs);
        if (diff < bestDiff) { bestDiff = diff; best = s; }
      }
      return best;
    };

    const s24h = findClosestSnapshot(now - ONE_DAY);
    const s3d = findClosestSnapshot(now - THREE_DAYS);
    const s7d = findClosestSnapshot(now - SEVEN_DAYS);

    const getTeam = id => bs.teams.find(t => t.id === id);

    const playersList = bs.elements
      .map(p => {
        const currentOwn = parseFloat(p.selected_by_percent) || 0;
        const transfersIn = p.transfers_in_event || 0;
        const transfersOut = p.transfers_out_event || 0;
        const netTransfers = transfersIn - transfersOut;

        // Calculate deltas
        let delta24h = 0, delta3d = 0, delta7d = 0;

        if (latestSnapshot && s24h && latestSnapshot !== s24h) {
          const pLatest = latestSnapshot.players?.[p.id];
          const p24h = s24h.players?.[p.id];
          if (pLatest && p24h) delta24h = pLatest.ownership - p24h.ownership;
          else delta24h = (netTransfers / totalManagers) * 100;
        } else {
          delta24h = (netTransfers / totalManagers) * 100;
        }

        if (latestSnapshot && s3d && latestSnapshot !== s3d) {
          const pLatest = latestSnapshot.players?.[p.id];
          const p3d = s3d.players?.[p.id];
          if (pLatest && p3d) delta3d = pLatest.ownership - p3d.ownership;
          else delta3d = delta24h * 2.2;
        } else {
          delta3d = delta24h * 2.2;
        }

        if (latestSnapshot && s7d && latestSnapshot !== s7d) {
          const pLatest = latestSnapshot.players?.[p.id];
          const p7d = s7d.players?.[p.id];
          if (pLatest && p7d) delta7d = pLatest.ownership - p7d.ownership;
          else delta7d = delta24h * 3.5;
        } else {
          delta7d = delta24h * 3.5;
        }

        // Build 14-data point sparkline
        let sparkline = [];
        if (snapshots.length >= 3) {
          const recentSnapshots = snapshots.slice(-14);
          sparkline = recentSnapshots.map(s => {
            const playerInSnap = s.players?.[p.id];
            return playerInSnap ? playerInSnap.ownership : currentOwn;
          });
        } else {
          // Synthetic sparkline for smooth presentation if database snapshots are just starting
          const base = currentOwn - delta7d;
          const step = delta7d / 13;
          for (let i = 0; i < 14; i++) {
            sparkline.push(Math.max(0, Math.round((base + step * i) * 10) / 10));
          }
        }

        const velocityShift = delta24h - (delta7d / 7);

        return {
          id: p.id,
          name: p.web_name,
          secondName: p.second_name,
          team: getTeam(p.team)?.short_name || '',
          teamFull: getTeam(p.team)?.name || '',
          position: POSITION_MAP[p.element_type - 1],
          cost: p.now_cost,
          costStr: '£' + (p.now_cost / 10).toFixed(1) + 'm',
          code: p.code,
          ownership: currentOwn,
          transfersIn,
          transfersOut,
          netTransfers,
          delta24h: Math.round(delta24h * 100) / 100,
          delta3d: Math.round(delta3d * 100) / 100,
          delta7d: Math.round(delta7d * 100) / 100,
          velocityShift: Math.round(velocityShift * 100) / 100,
          sparkline,
          points: p.total_points || 0
        };
      })
      .sort((a, b) => b.ownership - a.ownership);

    // Identify bento highlights
    const sortedByIn = [...playersList].sort((a, b) => b.netTransfers - a.netTransfers);
    const sortedByOut = [...playersList].sort((a, b) => a.netTransfers - b.netTransfers);
    const sortedByVelocity = [...playersList].sort((a, b) => b.velocityShift - a.velocityShift);

    const topTransferredIn = sortedByIn[0] || null;
    const topTransferredOut = sortedByOut[0] || null;
    const highestVelocity = sortedByVelocity[0] || null;

    res.json({
      lastUpdated: now,
      lastSnapshotTime: lastSnapshotTimeStr,
      snapshotCount: snapshots.length,
      topTransferredIn,
      topTransferredOut,
      highestVelocity,
      players: playersList.slice(0, 50)
    });
  } catch (e) {
    console.error('Ownership trends error:', e.message);
    res.status(500).json({ error: 'Failed to fetch ownership trends' });
  }
});

// ---- Price Change Predictor ----
app.get('/api/price-predictions', async (req, res) => {
  try {
    const bs = await getCachedApiData(BOOTSTRAP_URL);
    const elements = bs.elements;
    const teams = bs.teams;
    const getTeam = id => teams.find(t => t.id === id);

    // Price change formula based on transfer velocity and current cost
    const players = elements
      .filter(p => p.status !== 'u' && p.status !== 's')
      .map(p => {
        const netTransfers = (p.transfers_in_event || 0) - (p.transfers_out_event || 0);
        const cost = p.now_cost || 50;
        const ownership = parseFloat(p.selected_by_percent) || 0;
        
        // Simple price change velocity model
        // Positive = likely to rise, Negative = likely to fall
        const velocity = netTransfers / Math.max(ownership, 1) * 100;
        
        // Estimate hours until change (rough approximation)
        const absVelocity = Math.abs(velocity);
        let hoursUntilChange = null;
        if (absVelocity > 50) hoursUntilChange = Math.max(1, Math.round(48 - absVelocity * 0.5));
        else if (absVelocity > 20) hoursUntilChange = Math.round(48 + (50 - absVelocity) * 2);
        else if (absVelocity > 5) hoursUntilChange = Math.round(72 + (20 - absVelocity) * 5);

        return {
          id: p.id, name: p.web_name, code: p.code,
          team: getTeam(p.team)?.short_name || '',
          position: POSITION_MAP[p.element_type - 1],
          cost: cost, costStr: '£' + (cost / 10).toFixed(1) + 'm',
          netTransfers, velocity: Math.round(velocity * 10) / 10,
          hoursUntilChange,
          ownership,
          direction: velocity > 0 ? 'up' : velocity < 0 ? 'down' : 'stable',
          // Price already changed today
          priceChanged: p.cost_change_event !== 0,
          priceChangeAmount: p.cost_change_event
        };
      })
      .sort((a, b) => Math.abs(b.velocity) - Math.abs(a.velocity));

    const risers = players.filter(p => p.velocity > 0 && !p.priceChanged).slice(0, 20);
    const fallers = players.filter(p => p.velocity < 0 && !p.priceChanged).slice(0, 20);
    const recentChanges = elements
      .filter(p => p.cost_change_event !== 0)
      .map(p => ({
        id: p.id, name: p.web_name, code: p.code,
        team: getTeam(p.team)?.short_name || '',
        position: POSITION_MAP[p.element_type - 1],
        cost: p.now_cost, change: p.cost_change_event,
        direction: p.cost_change_event > 0 ? 'up' : 'down'
      }))
      .sort((a, b) => Math.abs(b.change) - Math.abs(a.change));

    res.json({ risers, fallers, recentChanges });
  } catch (e) {
    console.error('Price predictions error:', e.message);
    res.status(500).json({ error: 'Failed to calculate predictions' });
  }
});

// ---- League Standings ----
app.get('/api/leagues-classic/:leagueId/standings', async (req, res) => {
  try {
    const { leagueId } = req.params;
    const page = Math.min(5, Math.max(1, parseInt(req.query.page) || 1));
    
    const data = await getCachedApiData(`https://fantasy.premierleague.com/api/leagues-classic/${leagueId}/standings/?page_standings=${page}`);

    const leagueInfo = data.league || {};
    const standingsData = data.standings || {};
    const results = standingsData.results || [];
    
    let leaderTotal = 0;
    if (page === 1 && results.length > 0) {
      leaderTotal = results[0].total || 0;
    } else {
      try {
        const page1Data = await getCachedApiData(`https://fantasy.premierleague.com/api/leagues-classic/${leagueId}/standings/?page_standings=1`);
        leaderTotal = page1Data?.standings?.results?.[0]?.total || 0;
      } catch (e) {
        leaderTotal = results[0]?.total || 0;
      }
    }

    // If no results from FPL API (season not started or no data yet), return no-data response
    if (results.length === 0) {
      return res.json({
        leagueId: parseInt(leagueId) || 314,
        leagueName: leagueInfo.name || `Overall Top 50k`,
        leagueType: 'Public Global',
        page: 1,
        totalPages: 0,
        totalEntries: 0,
        hasMore: false,
        noData: true,
        managers: []
      });
    }

    const managers = results.map((entry) => ({
      rank: entry.rank,
      managerName: entry.player_name,
      entryName: entry.entry_name,
      eventTotal: entry.event_total || 0,
      total: entry.total || 0,
      rankDiff: (entry.last_rank || entry.rank) - entry.rank,
      diffCount: Math.max(0, leaderTotal - (entry.total || 0))
    }));
    const eventScores = managers.map(manager => manager.eventTotal);

    return res.json({
      leagueId: parseInt(leagueId),
      leagueName: leagueInfo.name || `League ${leagueId}`,
      leagueType: leagueInfo.league_type === 'x' ? 'Classic League' : 'Public Global',
      page,
      totalPages: standingsData.has_next ? Math.min(5, page + 1) : page,
      totalEntries: standingsData.has_next ? Math.max(page * 50 + 1, managers.length) : ((page - 1) * 50) + managers.length,
      hasMore: Boolean(standingsData.has_next),
      noData: false,
      leagueAvgGW: eventScores.length ? Math.round(eventScores.reduce((sum, score) => sum + score, 0) / eventScores.length) : 0,
      topScoreGW: eventScores.length ? Math.max(...eventScores) : 0,
      topScorerManager: managers.find(manager => manager.eventTotal === Math.max(...eventScores))?.managerName || '',
      topScorerTeam: managers.find(manager => manager.eventTotal === Math.max(...eventScores))?.entryName || '',
      managers
    });
  } catch (e) {
    console.error('League standings error:', e.message);
    res.status(500).json({ error: 'Failed to fetch league standings' });
  }
});

// ---- Dashboard Overview ----
app.get('/api/dashboard/overview', async (req, res) => {
  try {
    const bs = await getCachedApiData(BOOTSTRAP_URL);
    const fixtures = await getCachedApiData(FIXTURES_URL);

    const elements = bs.elements || [];
    const teams = bs.teams || [];
    const events = bs.events || [];
    const currentEvent = events.find(e => e.is_current) || events.find(e => e.is_next) || events[0];
    const currentGW = currentEvent?.id || 1;

    const getTeam = id => teams.find(t => t.id === id);
    const getPosStr = type => {
      if (type === 1) return 'GK';
      if (type === 2) return 'DEF';
      if (type === 3) return 'MID';
      if (type === 4) return 'FWD';
      return 'DEF';
    };

    const gwAverage = currentEvent?.average_entry_score || 42;
    const highestScore = currentEvent?.highest_score || 118;
    const totalTransfers = currentEvent?.transfers_made ? (currentEvent.transfers_made / 1000000).toFixed(1) + 'M' : '3.4M';

    const mostSelected = [...elements]
      .sort((a, b) => parseFloat(b.selected_by_percent) - parseFloat(a.selected_by_percent))
      .slice(0, 5)
      .map(p => {
        const team = getTeam(p.team);
        const formVal = parseFloat(p.form || 0);
        const ppg = p.points_per_game || '0.0';
        let fdrClass = 'fdr-3';
        if (formVal >= 6.0) fdrClass = 'fdr-1';
        else if (formVal >= 4.5) fdrClass = 'fdr-2';
        else if (formVal >= 3.0) fdrClass = 'fdr-3';
        else if (formVal >= 2.0) fdrClass = 'fdr-4';
        else fdrClass = 'fdr-5';

        return {
          id: p.id,
          code: p.code,
          name: p.web_name,
          team: team ? team.short_name : 'FPL',
          pos: getPosStr(p.element_type),
          selectedBy: p.selected_by_percent + '%',
          ppg,
          fdrClass
        };
      });

    const topTransfersIn = [...elements]
      .sort((a, b) => (b.transfers_in_event || b.transfers_in || 0) - (a.transfers_in_event || a.transfers_in || 0))
      .slice(0, 5)
      .map(p => {
        const team = getTeam(p.team);
        const count = p.transfers_in_event || p.transfers_in || 0;
        return {
          id: p.id,
          code: p.code,
          name: p.web_name,
          team: team ? team.short_name : 'FPL',
          pos: getPosStr(p.element_type),
          price: (p.now_cost / 10).toFixed(1),
          transfersCount: '+' + count.toLocaleString()
        };
      });

    const topTransfersOut = [...elements]
      .sort((a, b) => (b.transfers_out_event || b.transfers_out || 0) - (a.transfers_out_event || a.transfers_out || 0))
      .slice(0, 5)
      .map(p => {
        const team = getTeam(p.team);
        const count = p.transfers_out_event || p.transfers_out || 0;
        return {
          id: p.id,
          code: p.code,
          name: p.web_name,
          team: team ? team.short_name : 'FPL',
          pos: getPosStr(p.element_type),
          price: (p.now_cost / 10).toFixed(1),
          transfersCount: '-' + count.toLocaleString()
        };
      });

    const priceRisers = [...elements]
      .filter(p => p.cost_change_event > 0 || p.transfers_in_event > 50000)
      .sort((a, b) => b.transfers_in_event - a.transfers_in_event)
      .slice(0, 2);

    const priceFallers = [...elements]
      .filter(p => p.cost_change_event < 0 || p.transfers_out_event > 50000)
      .sort((a, b) => b.transfers_out_event - a.transfers_out_event)
      .slice(0, 2);

    const priceChanges = [
      ...priceRisers.map(p => ({
        name: p.web_name,
        team: getTeam(p.team)?.short_name || 'FPL',
        price: '£' + (p.now_cost / 10).toFixed(1) + 'm',
        direction: 'up'
      })),
      ...priceFallers.map(p => ({
        name: p.web_name,
        team: getTeam(p.team)?.short_name || 'FPL',
        price: '£' + (p.now_cost / 10).toFixed(1) + 'm',
        direction: 'down'
      }))
    ];

    const injuryNews = [...elements]
      .filter(p => p.news && p.news.trim() !== '' && (p.status === 'i' || p.status === 's' || p.status === 'd' || p.status === 'u'))
      .sort((a, b) => {
        const statusOrder = { i: 0, s: 1, d: 2, u: 3 };
        return (statusOrder[a.status] || 4) - (statusOrder[b.status] || 4);
      })
      .slice(0, 6)
      .map(p => {
        const team = getTeam(p.team);
        const statusMap = { i: 'Injured', s: 'Suspended', d: 'Doubtful', u: 'Unavailable' };
        return {
          name: p.web_name,
          team: team ? team.short_name : 'FPL',
          pos: getPosStr(p.element_type),
          status: statusMap[p.status] || p.status,
          statusKey: p.status,
          news: p.news,
          chanceNextGw: p.chance_next_gw
        };
      });

    const topTeamIds = [1, 13, 12, 6, 18, 14, 15];
    const nextGWs = [currentGW, currentGW + 1, currentGW + 2, currentGW + 3, currentGW + 4];

    const fdrGrid = topTeamIds.map(tId => {
      const teamObj = getTeam(tId);
      const teamShort = teamObj ? teamObj.short_name : 'TEAM';

      const teamFixes = nextGWs.map(gw => {
        const gwFixtures = fixtures.filter(f => f.event === gw && (f.team_h === tId || f.team_a === tId));
        if (!gwFixtures || gwFixtures.length === 0) {
          return { label: 'BLANK', fdr: 3 };
        }
        const f = gwFixtures[0];
        const isHome = f.team_h === tId;
        const oppId = isHome ? f.team_a : f.team_h;
        const oppTeam = getTeam(oppId)?.short_name || 'OPP';
        const fdr = isHome ? f.team_h_difficulty : f.team_a_difficulty;
        return {
          label: `${oppTeam} (${isHome ? 'H' : 'A'})`,
          fdr: fdr || 3
        };
      });

      return {
        team: teamShort,
        fixtures: teamFixes
      };
    });

    res.json({
      gw: currentGW,
      gwAverage,
      highestScore,
      totalTransfers,
      mostSelected,
      topTransfersIn,
      topTransfersOut,
      priceChanges,
      injuryNews,
      fdrGrid,
      nextGWs
    });
  } catch (err) {
    console.error('Dashboard overview API error:', err);
    res.status(500).json({ error: 'Failed to fetch dashboard overview data' });
  }
});

// ---- Tactical Zones ----
app.get('/api/tactics/zones', async (req, res) => {
  try {
    const formation = req.query.formation || '4231';
    const bs = await getCachedApiData(BOOTSTRAP_URL);
    const fixtures = await getCachedApiData(FIXTURES_URL);
    
    const elements = bs.elements || [];
    const teams = bs.teams || [];
    const currentGW = bs.events.find(e => e.is_current)?.id || 1;
    const getTeam = id => teams.find(t => t.id === id);

    const playersByPos = {
      1: elements.filter(p => p.element_type === 1 && p.minutes > 0).sort((a, b) => b.total_points - a.total_points),
      2: elements.filter(p => p.element_type === 2 && p.minutes > 0).sort((a, b) => b.total_points - a.total_points),
      3: elements.filter(p => p.element_type === 3 && p.minutes > 0).sort((a, b) => b.total_points - a.total_points),
      4: elements.filter(p => p.element_type === 4 && p.minutes > 0).sort((a, b) => b.total_points - a.total_points)
    };

    const getPlayerNode = (p, role, bottom, left) => {
      const code = p ? p.code : 118748;
      const webName = p ? p.web_name : 'Player';
      const abbr = webName.substring(0, 3).toUpperCase();
      const xGI = p ? parseFloat(p.expected_goal_involvements || 0) : 0;
      const form = p ? parseFloat(p.form || 0) : 0;
      const pts = p ? p.total_points : 0;
      return {
        id: p ? p.id : 0,
        code,
        name: webName,
        abbr,
        team: p ? getTeam(p.team)?.short_name : 'FPL',
        role,
        bottom,
        left,
        xGI,
        form,
        pts,
        highThreat: form >= 6.0 || xGI >= 5.0
      };
    };

    let nodes = [];
    if (formation === '352') {
      nodes = [
        getPlayerNode(playersByPos[1][0], 'GK', '5%', '50%'),
        getPlayerNode(playersByPos[2][0], 'LCB', '20%', '20%'),
        getPlayerNode(playersByPos[2][1], 'CB', '18%', '50%'),
        getPlayerNode(playersByPos[2][2], 'RCB', '20%', '80%'),
        getPlayerNode(playersByPos[3][0], 'LWB', '40%', '5%'),
        getPlayerNode(playersByPos[3][1], 'LCM', '38%', '28%'),
        getPlayerNode(playersByPos[3][2], 'CM', '35%', '50%'),
        getPlayerNode(playersByPos[3][3], 'RCM', '38%', '72%'),
        getPlayerNode(playersByPos[3][4], 'RWB', '40%', '95%'),
        getPlayerNode(playersByPos[4][0], 'LST', '65%', '35%'),
        getPlayerNode(playersByPos[4][1], 'RST', '65%', '65%')
      ];
    } else if (formation === '433') {
      nodes = [
        getPlayerNode(playersByPos[1][0], 'GK', '5%', '50%'),
        getPlayerNode(playersByPos[2][0], 'LB', '20%', '10%'),
        getPlayerNode(playersByPos[2][1], 'LCB', '18%', '33%'),
        getPlayerNode(playersByPos[2][2], 'RCB', '18%', '67%'),
        getPlayerNode(playersByPos[2][3], 'RB', '20%', '90%'),
        getPlayerNode(playersByPos[3][0], 'LCM', '42%', '22%'),
        getPlayerNode(playersByPos[3][1], 'CM', '38%', '50%'),
        getPlayerNode(playersByPos[3][2], 'RCM', '42%', '78%'),
        getPlayerNode(playersByPos[4][0], 'LW', '62%', '15%'),
        getPlayerNode(playersByPos[4][1], 'ST', '70%', '50%'),
        getPlayerNode(playersByPos[4][2], 'RW', '62%', '85%')
      ];
    } else {
      nodes = [
        getPlayerNode(playersByPos[1][0], 'GK', '5%', '50%'),
        getPlayerNode(playersByPos[2][0], 'LB', '20%', '10%'),
        getPlayerNode(playersByPos[2][1], 'LCB', '18%', '33%'),
        getPlayerNode(playersByPos[2][2], 'RCB', '18%', '67%'),
        getPlayerNode(playersByPos[2][3], 'RB', '20%', '90%'),
        getPlayerNode(playersByPos[3][0], 'LDM', '36%', '35%'),
        getPlayerNode(playersByPos[3][1], 'RDM', '36%', '65%'),
        getPlayerNode(playersByPos[3][2], 'LAM', '52%', '18%'),
        getPlayerNode(playersByPos[3][3], 'CAM', '55%', '50%'),
        getPlayerNode(playersByPos[3][4], 'RAM', '52%', '82%'),
        getPlayerNode(playersByPos[4][0], 'ST', '72%', '50%')
      ];
    }

    const topAttackers = elements
      .filter(p => (p.element_type === 3 || p.element_type === 4) && p.minutes > 200)
      .sort((a, b) => (parseFloat(b.form) + parseFloat(b.expected_goal_involvements || 0)) - (parseFloat(a.form) + parseFloat(a.expected_goal_involvements || 0)))
      .slice(0, 2);

    // Get real fixtures for the top attackers
    const getTeamNextFixture = (teamId) => {
      const teamFixtures = fixtures
        .filter(f => f.team_h === teamId || f.team_a === teamId)
        .sort((a, b) => a.event - b.event);
      const next = teamFixtures.find(f => f.event >= currentGW);
      if (!next) return 'TBD';
      const isHome = next.team_h === teamId;
      const oppTeam = getTeam(isHome ? next.team_a : next.team_h);
      return `vs ${oppTeam ? oppTeam.short_name : '?'} (${isHome ? 'H' : 'A'})`;
    };

    const targetZones = [
      {
        zoneName: 'Right Flank (Attacking)',
        vulnBadge: 'HIGH VULNERABILITY',
        vulnClass: 'fdr-5',
        xPts: '8.2',
        player: {
          name: topAttackers[0] ? topAttackers[0].web_name : 'B. Saka',
          code: topAttackers[0] ? topAttackers[0].code : 438098,
          fixture: topAttackers[0] ? getTeamNextFixture(topAttackers[0].team) : 'vs SHU (H)'
        }
      },
      {
        zoneName: 'Central Zone (Box 14)',
        vulnBadge: 'MODERATE EXPLOITATION',
        vulnClass: 'fdr-4',
        xPts: '6.5',
        player: {
          name: topAttackers[1] ? topAttackers[1].web_name : 'K. De Bruyne',
          code: topAttackers[1] ? topAttackers[1].code : 61366,
          fixture: topAttackers[1] ? getTeamNextFixture(topAttackers[1].team) : 'vs LUT (A)'
        }
      }
    ];

    // Build danger zones from real fixture data - find matches with high xG potential
    const teamXG = {};
    elements.forEach(p => {
      const xgc = parseFloat(p.expected_goals_conceded || 0);
      if (xgc > 0) {
        teamXG[p.team] = (teamXG[p.team] || 0) + xgc;
      }
    });

    const dangerFixtures = fixtures
      .filter(f => f.event === currentGW)
      .map(f => {
        const homeTeam = getTeam(f.team_h);
        const awayTeam = getTeam(f.team_a);
        const homeXG = teamXG[f.team_h] || 0;
        const awayXG = teamXG[f.team_a] || 0;
        const totalXG = homeXG + awayXG;
        const threatArea = totalXG > 5 ? 'Central Penalty' : totalXG > 3 ? 'Left Half-Space' : 'Right Wing';
        const tier = totalXG > 5 ? 'fdr-5' : totalXG > 3 ? 'fdr-4' : 'fdr-1';
        return {
          fixture: `${homeTeam ? homeTeam.short_name : '?'} vs ${awayTeam ? awayTeam.short_name : '?'}`,
          threatArea,
          xGConceded: totalXG.toFixed(2),
          colorTier: tier
        };
      })
      .sort((a, b) => parseFloat(b.xGConceded) - parseFloat(a.xGConceded))
      .slice(0, 3);

    const dangerZones = dangerFixtures.length > 0 ? dangerFixtures : [
      { fixture: 'No fixtures', threatArea: 'N/A', xGConceded: '0.00', colorTier: 'fdr-1' }
    ];

    res.json({
      gw: currentGW,
      formation,
      nodes,
      targetZones,
      dangerZones
    });
  } catch (err) {
    console.error('Tactics zones endpoint error:', err);
    res.status(500).json({ error: 'Failed to fetch tactical zones data' });
  }
});

// ---- Differential Finder ----
app.get('/api/differentials', async (req, res) => {
  try {
    const [bs, fixtures] = await Promise.all([getCachedApiData(BOOTSTRAP_URL), getCachedApiData(FIXTURES_URL)]);
    const elements = bs.elements;
    const teams = bs.teams;
    const currentGW = bs.events.find(e => e.is_current)?.id || 1;
    const getTeam = id => teams.find(t => t.id === id);

    // Get next 5 fixtures for FDR calculation
    const getNextFDR = (teamId) => {
      let fdrSum = 0, count = 0;
      for (let gw = currentGW; gw <= Math.min(currentGW + 4, 38); gw++) {
        const fx = fixtures.find(f => f.event === gw && (f.team_h === teamId || f.team_a === teamId));
        if (fx) { fdrSum += fx.difficulty || 3; count++; }
      }
      return count > 0 ? (fdrSum / count).toFixed(1) : '3.0';
    };

    // Calculate xGI per 90 minutes
    const differentials = elements
      .filter(p => p.total_points > 0 || parseFloat(p.form) > 0)
      .map(p => {
        const ownership = parseFloat(p.selected_by_percent) || 0;
        const xGI = parseFloat(p.expected_goal_involvements) || 0;
        const form = parseFloat(p.form) || 0;
        const totalPts = p.total_points || 0;
        const cost = p.now_cost || 50;
        const mins = p.minutes || 0;
        const xGI90 = mins > 0 ? (xGI / mins) * 90 : 0;
        const ptsPerMillion = cost > 0 ? (totalPts / (cost / 10)) : 0;
        const avgFDR = getNextFDR(p.team);

        return {
          id: p.id, name: p.web_name, code: p.code,
          team: getTeam(p.team)?.short_name || '',
          teamFull: getTeam(p.team)?.name || '',
          position: POSITION_MAP[p.element_type - 1],
          cost, costStr: '£' + (cost / 10).toFixed(1) + 'm',
          ownership, xGI, form, totalPts,
          xGI90: xGI90.toFixed(2),
          ptsPerMillion: ptsPerMillion.toFixed(1),
          avgFDR,
          minutes: mins,
          goals: p.goals_scored || 0,
          assists: p.assists || 0,
          // Differential score: low ownership + high output
          diffScore: Math.round((xGI90 * 10 + form * 2 + ptsPerMillion) * (100 - Math.min(ownership, 50)) / 100)
        };
      })
      .filter(p => p.ownership < 15 && p.xGI > 0 && p.minutes > 200)
      .sort((a, b) => b.diffScore - a.diffScore);

    res.json({ 
      differentials: differentials.slice(0, 50),
      template: elements
        .filter(p => parseFloat(p.selected_by_percent) > 30)
        .map(p => p.web_name)
    });
  } catch (e) {
    console.error('Differentials error:', e.message);
    res.status(500).json({ error: 'Failed to calculate differentials' });
  }
});

// ---- Set Piece Takers (Official FPL Scout Data) ----
const SET_PIECE_DATA = {
  'ARS': { penalties: ['Saka','Gy\u00f6keres','\u00d8degaard'], freeKicks: ['Rice','Saka','Eze'], corners: ['Rice','Saka','\u00d8degaard','Tzolis','Madueke'] },
  'AVL': { penalties: ['Buend\u00eda','Watkins'], freeKicks: ['Buend\u00eda'], corners: ['Cash','McGinn'] },
  'BOU': { penalties: ['Kroupi','Kluivert','Tavernier'], freeKicks: ['Tavernier','Kluivert','Brooks','Scott','\u00dcnal'], corners: ['Tavernier','Scott','Kluivert','Brooks','Cook','Christie'] },
  'BRE': { penalties: ['Thiago','Schade','Jensen'], freeKicks: ['Lewis-Potter','Jensen','Damsgaard'], corners: ['Jensen','Damsgaard','Janelt','Dango'] },
  'BHA': { penalties: ['Grobb','O\'Riley'], freeKicks: ['Ayari','Dunk','De Cuyper','Gomez'], corners: ['Grobb','Kad\u0131o\u011flu','Minteh','De Cuyper','Ayari'] },
  'CHE': { penalties: ['Palmer','Enzo','Est\u00eav\u00e3o','Delap'], freeKicks: ['James','Enzo','Palmer','Neto'], corners: ['James','Enzo','Neto','Est\u00eav\u00e3o'] },
  'COV': { penalties: ['Wright','Torp','Grimes','Thomas-Asante'], freeKicks: ['Rudoni','Torp'], corners: ['Grimes','Torp','Rudoni'] },
  'CRY': { penalties: ['Mateta','Sarr','Devenny'], freeKicks: ['Yeremy','Devenny'], corners: ['Wharton','Yeremy','Hughes','Kamada'] },
  'EVE': { penalties: ['Ndiaye','Barry','Garner','Beto'], freeKicks: ['Garner'], corners: ['Garner','Dewsbury-Hall'] },
  'FUL': { penalties: ['Robinson','Iwobi'], freeKicks: ['Iwobi'], corners: ['Iwobi','Bobb','Kevin'] },
  'HUL': { penalties: ['Crooks','McBurnie'], freeKicks: ['Giles','Belloumi'], corners: ['Giles','Slater','Belloumi'] },
  'IPS': { penalties: ['Hirst','Clarke','Philogene'], freeKicks: ['N\u00fa\u00f1ez','Davis','Clarke'], corners: ['N\u00fa\u00f1ez','Davis','Clarke','Philogene'] },
  'LEE': { penalties: ['Calvert-Lewin','Nmecha','Piroe'], freeKicks: ['Stach','Longstaff','Aaronson'], corners: ['Stach','Wilson','Longstaff','Tanaka'] },
  'LIV': { penalties: ['Isak','Szoboszlai','Gakpo','Wirtz','Mac Allister'], freeKicks: ['Szoboszlai','Wirtz'], corners: ['Szoboszlai','Gakpo','Wirtz'] },
  'MCI': { penalties: ['Haaland','Marmoush','Semenyo','Doku','Matheus N.'], freeKicks: ['Cherki','Marmoush','Foden','Reijnders'], corners: ['Cherki','Foden','Anderson','Reijnders'] },
  'MUN': { penalties: ['B.Fernandes','Mbeumo','Tielemans'], freeKicks: ['B.Fernandes','Mbeumo','Mount'], corners: ['B.Fernandes','Mbeumo','Shaw','Amad'] },
  'NEW': { penalties: ['Woltemade','Osula','Wissa'], freeKicks: ['Hall','Sch\u00e4r'], corners: ['Hall','J.Murphy','L.Miley','Elanga'] },
  'NFO': { penalties: ['Wood','Gibbs-White','Igor Jesus'], freeKicks: ['Gibbs-White','Murillo','N.Williams','Hudson-Odoi'], corners: ['N.Williams','Hutchinson','Ndoye','Bakwa'] },
  'TOT': { penalties: ['Solanke','Kudus','Xavi','Richarlison'], freeKicks: ['Pedro Porro','Xavi','Kudus','Tonali'], corners: ['Pedro Porro','Kudus','Tel','Xavi','Tonali'] },
  'SUN': { penalties: ['Diarra','Le F\u00e9e'], freeKicks: ['Xhaka','Le F\u00e9e'], corners: ['Le F\u00e9e','Xhaka','Hume'] },
  'WOL': { penalties: ['Cunha','Hwang','Sarabia'], freeKicks: ['Sarabia','Nunes','A\u00eft-Nouri'], corners: ['Sarabia','Nunes','A\u00eft-Nouri'] }
};

// Fuzzy name matcher: matches FPL list name to bootstrap web_name
function findPlayer(listName, elements, teamId) {
  const ln = listName.toLowerCase().replace(/[^a-z]/g, '');
  // Set-piece ownership is team-specific; never attach a player from another club.
  const teamEls = teamId ? elements.filter(e => e.team === teamId) : elements;

  const tryMatch = (pool) => {
    // Exact web_name
    let m = pool.find(e => e.web_name.toLowerCase() === listName.toLowerCase());
    if (m) return m;
    // Fuzzy: stripped comparison
    m = pool.find(e => e.web_name.toLowerCase().replace(/[^a-z]/g, '') === ln);
    if (m) return m;
    // Partial: listName contained in web_name or vice versa
    m = pool.find(e => {
      const wn = e.web_name.toLowerCase().replace(/[^a-z]/g, '');
      return wn.includes(ln) || ln.includes(wn);
    });
    if (m) return m;
    // Check second_name
    m = pool.find(e => {
      const sn = (e.second_name || '').toLowerCase().replace(/[^a-z]/g, '');
      return sn === ln || sn.includes(ln) || ln.includes(sn);
    });
    if (m) return m;
    // Check first_name
    m = pool.find(e => {
      const fn = (e.first_name || '').toLowerCase().replace(/[^a-z]/g, '');
      return fn === ln || ln.includes(fn);
    });
    return m || null;
  };

  return tryMatch(teamEls);
}

app.get('/api/set-pieces', async (req, res) => {
  try {
    const bs = await getCachedApiData(BOOTSTRAP_URL);
    const elements = bs.elements;
    const teams = bs.teams;
    const getTeam = id => teams.find(t => t.id === id);
    const getTeamByShort = name => teams.find(t => t.short_name === name || t.name === name);

    const result = {};
    Object.entries(SET_PIECE_DATA).forEach(([shortName, sp]) => {
      const team = getTeamByShort(shortName);
      if (!team) return;
      const teamId = team.id;

      const resolve = (names) => names.map(name => {
        const p = findPlayer(name, elements, teamId);
        if (!p) return { name, team: shortName, teamFull: team.name, teamId, cost: 0, costStr: '?', goals: 0, assists: 0, totalPoints: 0, form: 0, code: 0, position: '?', found: false };
        return {
          id: p.id, name: p.web_name, code: p.code,
          position: POSITION_MAP[p.element_type - 1],
          team: shortName, teamFull: team.name, teamId,
          cost: p.now_cost, costStr: '\u00a3' + (p.now_cost / 10).toFixed(1) + 'm',
          goals: p.goals_scored || 0, assists: p.assists || 0,
          totalPoints: p.total_points || 0, form: parseFloat(p.form) || 0,
          minutes: p.minutes || 0, selectedBy: parseFloat(p.selected_by_percent) || 0,
          bonus: p.bonus || 0, ictIndex: parseFloat(p.ict_index) || 0,
          found: true
        };
      });

      result[shortName] = {
        teamName: shortName, teamFull: team.name, teamId,
        penalties: resolve(sp.penalties),
        freeKicks: resolve(sp.freeKicks),
        corners: resolve(sp.corners)
      };
    });

    res.json({ setPieces: result });
  } catch (e) {
    console.error('Set pieces error:', e.message);
    res.status(500).json({ error: 'Failed to calculate set pieces' });
  }
});

// ---- Manager ROI ----
app.get('/api/manager-roi/:managerId', async (req, res) => {
  try {
    const bs = await getCachedApiData(BOOTSTRAP_URL);
    const managerData = await analyzeManager(req.params.managerId, bs, 314);
    
    const players = managerData.playerStats || [];
    const totalValue = players.reduce((s, p) => s + (p.nowCost || 0), 0) / 10;
    const totalPoints = players.reduce((s, p) => s + (p.totalPointsActive || 0), 0);
    
    // ROI = Points per Million spent
    const roi = totalValue > 0 ? (totalPoints / totalValue).toFixed(2) : 0;
    
    // Per-player ROI
    const playerROI = players.map(p => ({
      name: p.name, team: p.team, position: p.position,
      code: p.photoId,
      cost: (p.nowCost / 10).toFixed(1),
      points: p.totalPointsActive,
      roi: p.nowCost > 0 ? (p.totalPointsActive / (p.nowCost / 10)).toFixed(2) : '0.00',
      starts: p.starts,
      ppg: p.starts > 0 ? (p.totalPointsActive / p.starts).toFixed(1) : '0.0'
    })).sort((a, b) => parseFloat(b.roi) - parseFloat(a.roi));

    // Value ratings
    const valueRatings = playerROI.map(p => ({
      ...p,
      rating: parseFloat(p.roi) >= 15 ? 'Elite' : 
              parseFloat(p.roi) >= 10 ? 'Great Value' :
              parseFloat(p.roi) >= 7 ? 'Fair' :
              parseFloat(p.roi) >= 4 ? 'Overpriced' : 'Poor Value'
    }));

    res.json({
      managerName: managerData.managerInfo.name,
      totalValue: totalValue.toFixed(1),
      totalPoints,
      roi,
      playerROI: valueRatings,
      bestValue: valueRatings[0],
      worstValue: valueRatings[valueRatings.length - 1]
    });
  } catch (e) {
    console.error('Manager ROI error:', e.message);
    res.status(500).json({ error: 'Failed to calculate ROI' });
  }
});

// ---- Chip Strategy ----
app.get('/api/chip-strategy', async (req, res) => {
  try {
    const [bs, fixtures] = await Promise.all([getCachedApiData(BOOTSTRAP_URL), getCachedApiData(FIXTURES_URL)]);
    const elements = bs.elements;
    const teams = bs.teams;
    const currentGW = bs.events.find(e => e.is_current)?.id || 1;
    const getTeam = id => teams.find(t => t.id === id);

    // Find DGWs (Double Gameweeks) and BGWs (Blank Gameweeks)
    const gwFixtureCount = {};
    for (let gw = currentGW; gw <= Math.min(currentGW + 10, 38); gw++) {
      const gwFixtures = fixtures.filter(f => f.event === gw);
      gwFixtureCount[gw] = gwFixtures.length;
    }
    
    const avgFixtures = Object.values(gwFixtureCount).reduce((s, v) => s + v, 0) / Object.values(gwFixtureCount).length;
    const dgws = Object.entries(gwFixtureCount).filter(([gw, count]) => count > avgFixtures * 1.3).map(([gw]) => parseInt(gw));
    const bgws = Object.entries(gwFixtureCount).filter(([gw, count]) => count < avgFixtures * 0.7).map(([gw]) => parseInt(gw));

    // Best chips by position
    const bestByPosition = {
      FWD: elements.filter(p => p.element_type === 4 && p.minutes > 0)
        .sort((a, b) => (parseFloat(b.expected_goal_involvements) || 0) - (parseFloat(a.expected_goal_involvements) || 0))
        .slice(0, 5)
        .map(p => ({ name: p.web_name, team: getTeam(p.team)?.short_name, xGI: p.expected_goal_involvements, form: p.form, code: p.code })),
      MID: elements.filter(p => p.element_type === 3 && p.minutes > 0)
        .sort((a, b) => (parseFloat(b.expected_goal_involvements) || 0) - (parseFloat(a.expected_goal_involvements) || 0))
        .slice(0, 5)
        .map(p => ({ name: p.web_name, team: getTeam(p.team)?.short_name, xGI: p.expected_goal_involvements, form: p.form, code: p.code }))
    };

    // Recommendations
    const recommendations = [];
    if (dgws.length > 0) {
      recommendations.push({
        chip: 'Bench Boost',
        reason: `DGW${dgws[0]} has ${gwFixtureCount[dgws[0]]} fixtures - maximize bench points`,
        bestGW: dgws[0],
        priority: 'High'
      });
      recommendations.push({
        chip: 'Triple Captain',
        reason: `DGW${dgws[0]} is ideal for TC on a premium asset`,
        bestGW: dgws[0],
        priority: 'Medium'
      });
    }
    if (bgws.length > 0) {
      recommendations.push({
        chip: 'Free Hit',
        reason: `BGW${bgws[0]} only has ${gwFixtureCount[bgws[0]]} fixtures - build a one-week team`,
        bestGW: bgws[0],
        priority: bgws.length > 2 ? 'High' : 'Medium'
      });
    }

    res.json({
      currentGW,
      gwFixtureCount,
      dgws, bgws,
      recommendations,
      bestByPosition,
      chipTips: [
        'Use Wildcard when 4+ transfers needed',
        'Bench Boost on DGWs with strong bench',
        'Triple Captain on form player with easy DGW fixture',
        'Free Hit to navigate BGWs or build DGW team'
      ]
    });
  } catch (e) {
    console.error('Chip strategy error:', e.message);
    res.status(500).json({ error: 'Failed to calculate chip strategy' });
  }
});

// ---- Expected Points Projections ----
app.get('/api/xpts-projections', async (req, res) => {
  try {
    const [bs, fixtures] = await Promise.all([getCachedApiData(BOOTSTRAP_URL), getCachedApiData(FIXTURES_URL)]);
    const elements = bs.elements;
    const teams = bs.teams;
    const currentGW = bs.events.find(e => e.is_current)?.id || 1;
    const getTeam = id => teams.find(t => t.id === id);

    // Project points for next 5 GWs for each player
    const projections = elements
      .filter(p => parseFloat(p.form) > 0 || p.total_points > 0)
      .map(p => {
        const form = parseFloat(p.form) || 0;
        const ppg = parseFloat(p.points_per_game) || 0;
        const xGI = parseFloat(p.expected_goal_involvements) || 0;
        const team = p.team;
        
        // Get next 5 fixtures
        const nextFixtures = [];
        let totalXpts = 0;
        
        for (let gw = currentGW; gw <= Math.min(currentGW + 4, 38); gw++) {
          const fx = fixtures.find(f => f.event === gw && (f.team_h === team || f.team_a === team));
          if (fx) {
            const isHome = fx.team_h === team;
            const fdr = fx.difficulty || 3;
            const oppId = isHome ? fx.team_a : fx.team_h;
            const opp = getTeam(oppId);
            
            // xPts calculation
            const baseXpts = (xGI * 3 + form * 1.5 + ppg * 1) / 5;
            const fdrMod = fdr === 1 ? 1.4 : fdr === 2 ? 1.2 : fdr === 3 ? 1.0 : fdr === 4 ? 0.8 : 0.6;
            const homeMod = isHome ? 1.1 : 1.0;
            const gwXpts = Math.round(baseXpts * fdrMod * homeMod * 10) / 10;
            
            totalXpts += gwXpts;
            nextFixtures.push({
              gw, opponent: opp?.short_name || '?', isHome, fdr, xpts: gwXpts
            });
          }
        }

        return {
          id: p.id, name: p.web_name, code: p.code,
          team: getTeam(team)?.short_name || '',
          position: POSITION_MAP[p.element_type - 1],
          cost: p.now_cost, costStr: '£' + (p.now_cost / 10).toFixed(1) + 'm',
          form, ppg, xGI,
          totalXpts: Math.round(totalXpts * 10) / 10,
          xptsPerMillion: p.now_cost > 0 ? (totalXpts / (p.now_cost / 10)).toFixed(1) : '0.0',
          nextFixtures,
          totalPoints: p.total_points || 0,
          ownership: parseFloat(p.selected_by_percent) || 0
        };
      })
      .sort((a, b) => b.totalXpts - a.totalXpts);

    // Team projections (sum of all starters)
    const teamProjections = {};
    projections.forEach(p => {
      if (!teamProjections[p.team]) teamProjections[p.team] = { team: p.team, totalXpts: 0, count: 0 };
      teamProjections[p.team].totalXpts += p.totalXpts;
      teamProjections[p.team].count++;
    });

    res.json({
      currentGW,
      playerProjections: projections.slice(0, 100),
      teamProjections: Object.values(teamProjections).sort((a, b) => b.totalXpts - a.totalXpts),
      topByPosition: {
        FWD: projections.filter(p => p.position === 'FWD').slice(0, 10),
        MID: projections.filter(p => p.position === 'MID').slice(0, 10),
        DEF: projections.filter(p => p.position === 'DEF').slice(0, 10),
        GKP: projections.filter(p => p.position === 'GKP').slice(0, 5)
      }
    });
  } catch (e) {
    console.error('xPts projections error:', e.message);
    res.status(500).json({ error: 'Failed to calculate projections' });
  }
});

// ---- Deadline Info ----
app.get('/api/deadline', async (req, res) => {
  try {
    const bs = await getCachedApiData(BOOTSTRAP_URL);
    const events = bs.events;
    const currentGW = events.find(e => e.is_current);
    const nextGW = events.find(e => e.is_next);
    
    // Get deadline times
    const deadlineTime = nextGW?.deadline_time || currentGW?.deadline_time;
    const deadlineDate = deadlineTime ? new Date(deadlineTime) : null;
    
    res.json({
      currentGW: currentGW?.id || 1,
      nextGW: nextGW?.id || currentGW?.id + 1,
      deadlineTime: deadlineDate?.toISOString() || null,
      deadlineTimestamp: deadlineDate?.getTime() || null,
      gameweekDeadline: deadlineTime || 'TBA',
      isFinished: currentGW?.finished || false
    });
  } catch (e) {
    console.error('Deadline error:', e.message);
    res.status(500).json({ error: 'Failed to fetch deadline' });
  }
});

// ---- Injury News ----
app.get('/api/injury-news', async (req, res) => {
  try {
    const bs = await getCachedApiData(BOOTSTRAP_URL);
    const elements = bs.elements;
    const teams = bs.teams;
    const getTeam = id => teams.find(t => t.id === id);

    // Status codes: a=available, d=doubtful, i=injured, s=suspended, u=unavailable, p=phasing in
    const statusLabels = {
      'd': 'Doubtful', 'i': 'Injured', 's': 'Suspended', 
      'u': 'Unavailable', 'p': 'Phasing In', 'n': 'Not Available'
    };

    const injuries = elements
      .filter(p => p.status !== 'a' && p.status !== 'r')
      .map(p => ({
        id: p.id, name: p.web_name, code: p.code,
        team: getTeam(p.team)?.short_name || '',
        teamFull: getTeam(p.team)?.name || '',
        position: POSITION_MAP[p.element_type - 1],
        status: statusLabels[p.status] || p.statusCode,
        statusCode: p.status,
        news: p.news || 'No update',
        cost: p.now_cost,
        costStr: '£' + (p.now_cost / 10).toFixed(1) + 'm',
        ownership: parseFloat(p.selected_by_percent) || 0,
        form: parseFloat(p.form) || 0,
        totalPoints: p.total_points || 0,
        chanceOfPlaying: p.chance_of_playing_next_round,
        // Severity sorting: suspended > injured > doubtful > unavailable
        severity: p.status === 's' ? 4 : p.status === 'i' ? 3 : p.status === 'd' ? 2 : 1
      }))
      .sort((a, b) => b.severity - a.severity || b.ownership - a.ownership);

    res.json({
      injuries,
      summary: {
        total: injuries.length,
        injured: injuries.filter(p => p.statusCode === 'i').length,
        suspended: injuries.filter(p => p.statusCode === 's').length,
        doubtful: injuries.filter(p => p.statusCode === 'd').length,
        unavailable: injuries.filter(p => p.statusCode === 'u').length
      }
    });
  } catch (e) {
    console.error('Injury news error:', e.message);
    res.status(500).json({ error: 'Failed to fetch injury news' });
  }
});

// Match Analysis endpoint for Tactics page
app.get('/api/match-analysis', async (req, res) => {
  try {
    const { team_h, team_a } = req.query;
    if (!team_h || !team_a) return res.status(400).json({ error: 'team_h and team_a required' });

    const bootstrapData = await getCachedApiData('https://fantasy.premierleague.com/api/bootstrap-static/');
    const elements = bootstrapData.elements;
    const teams = bootstrapData.teams;

    const getTeam = id => teams.find(t => t.id === parseInt(id));
    const getPosStr = type => {
      if (type === 1) return 'GK';
      if (type === 2) return 'DEF';
      if (type === 3) return 'MID';
      if (type === 4) return 'FWD';
      return 'DEF';
    };

    const homeTeam = getTeam(team_h);
    const awayTeam = getTeam(team_a);

    const homePlayers = elements.filter(p => p.team === parseInt(team_h) && p.minutes > 0);
    const awayPlayers = elements.filter(p => p.team === parseInt(team_a) && p.minutes > 0);

    const buildTeamData = (players, teamInfo) => {
      const posGroups = { GK: [], DEF: [], MID: [], FWD: [] };
      players.forEach(p => {
        const pos = getPosStr(p.element_type);
        if (posGroups[pos]) {
          posGroups[pos].push({
            name: p.web_name,
            code: p.code,
            position: pos,
            xGI: parseFloat(p.expected_goal_involvements || 0),
            xG: parseFloat(p.expected_goals || 0),
            xA: parseFloat(p.expected_assists || 0),
            goals: p.goals_scored || 0,
            assists: p.assists || 0,
            goalsConceded: p.goals_conceded || 0,
            cleanSheets: p.clean_sheets || 0,
            minutes: p.minutes || 0,
            form: parseFloat(p.form || 0),
            cost: (p.now_cost / 10).toFixed(1),
            totalPoints: p.total_points || 0,
            ictIndex: parseFloat(p.ict_index || 0)
          });
        }
      });

      // Sort each position by xGI/points
      Object.keys(posGroups).forEach(pos => {
        posGroups[pos].sort((a, b) => b.xGI - a.xGI || b.totalPoints - a.totalPoints);
      });

      const totalXGI = players.reduce((s, p) => s + parseFloat(p.expected_goal_involvements || 0), 0);
      const totalGoals = players.reduce((s, p) => s + (p.goals_scored || 0), 0);
      const totalGC = players.reduce((s, p) => s + (p.goals_conceded || 0), 0);
      const totalCS = players.reduce((s, p) => s + (p.clean_sheets || 0), 0);

      // DEFCON: lower is stronger defence
      const avgDefCon = players.length > 0 ?
        (5 - (players.reduce((s, p) => s + parseFloat(p.form || 0), 0) / players.length) * 0.4).toFixed(1) : '3.0';

      // Best picks by xGI
      const bestPicks = [...players]
        .sort((a, b) => parseFloat(b.expected_goal_involvements || 0) - parseFloat(a.expected_goal_involvements || 0))
        .slice(0, 5)
        .map(p => ({
          name: p.web_name,
          code: p.code,
          position: getPosStr(p.element_type),
          xGI: parseFloat(p.expected_goal_involvements || 0),
          form: parseFloat(p.form || 0),
          cost: (p.now_cost / 10).toFixed(1),
          totalPoints: p.total_points || 0,
          team: teamInfo.short_name
        }));

      return {
        teamName: teamInfo.name,
        teamShort: teamInfo.short_name,
        short_name: teamInfo.short_name,
        totalXGI: totalXGI.toFixed(1),
        totalGoals,
        totalGC,
        totalCS,
        defcon: avgDefCon,
        posGroups,
        bestPicks,
        // Strongest position
        strongSide: Object.entries(posGroups).reduce((best, [pos, players]) => {
          const posXGI = players.reduce((s, p) => s + p.xGI, 0);
          return posXGI > best.xgi ? { pos, xgi: posXGI } : best;
        }, { pos: 'MID', xgi: 0 }).pos
      };
    };

    const home = buildTeamData(homePlayers, homeTeam);
    const away = buildTeamData(awayPlayers, awayTeam);

    // Identify danger zones (attacking strength) and vulnerability zones (defensive weakness)
    const dangerZones = [];
    const vulnZones = [];

    // Home attack vs Away defence
    Object.entries(home.posGroups).forEach(([pos, players]) => {
      const posTotalXGI = players.reduce((s, p) => s + p.xGI, 0);
      if (posTotalXGI > 10) {
        dangerZones.push({
          team: home.teamShort,
          zone: pos,
          xGI: posTotalXGI.toFixed(1),
          label: `${home.teamShort} ${pos}: ${posTotalXGI.toFixed(1)} xGI`
        });
      }
    });

    // Away attack vs Home defence
    Object.entries(away.posGroups).forEach(([pos, players]) => {
      const posTotalXGI = players.reduce((s, p) => s + p.xGI, 0);
      if (posTotalXGI > 10) {
        dangerZones.push({
          team: away.teamShort,
          zone: pos,
          xGI: posTotalXGI.toFixed(1),
          label: `${away.teamShort} ${pos}: ${posTotalXGI.toFixed(1)} xGI`
        });
      }
    });

    // Vulnerability zones (high GC)
    const homeGCByPos = { DEF: 0, MID: 0 };
    const awayGCByPos = { DEF: 0, MID: 0 };
    homePlayers.forEach(p => {
      const pos = getPosStr(p.element_type);
      if (pos === 'DEF') homeGCByPos.DEF += p.goals_conceded || 0;
      else if (pos === 'MID') homeGCByPos.MID += p.goals_conceded || 0;
    });
    awayPlayers.forEach(p => {
      const pos = getPosStr(p.element_type);
      if (pos === 'DEF') awayGCByPos.DEF += p.goals_conceded || 0;
      else if (pos === 'MID') awayGCByPos.MID += p.goals_conceded || 0;
    });

    if (homeGCByPos.DEF > 20) vulnZones.push({ team: home.teamShort, zone: 'LCB/RCB', label: `${home.teamShort} CB: ${homeGCByPos.DEF} GC` });
    if (awayGCByPos.DEF > 20) vulnZones.push({ team: away.teamShort, zone: 'LCB/RCB', label: `${away.teamShort} CB: ${awayGCByPos.DEF} GC` });

    // Predicted danger
    const homeStrength = parseFloat(home.totalXGI) - parseFloat(away.totalXGI);
    const predictedDanger = homeStrength > 5 ? `${home.teamShort} favored` :
                           homeStrength < -5 ? `${away.teamShort} favored` : 'Balanced';

    res.json({
      home,
      away,
      dangerZones: dangerZones.slice(0, 4),
      vulnZones: vulnZones.slice(0, 4),
      predictedDanger,
      homeStrength: parseFloat(home.defcon),
      awayStrength: parseFloat(away.defcon)
    });
  } catch (e) {
    console.error('Match analysis error:', e.message);
    res.status(500).json({ error: 'Failed to fetch match analysis' });
  }
});

// ---- Admin Analytics API ----
const ADMIN_KEY = process.env.ADMIN_KEY;

function requireAdmin(req, res) {
  if (!ADMIN_KEY) {
    res.status(503).json({ error: 'Admin analytics are not configured' });
    return false;
  }
  if (!sql) return requireDatabase(req, res);
  const key = req.headers['x-admin-key'];
  const supplied = typeof key === 'string' ? Buffer.from(key) : Buffer.alloc(0);
  const expected = Buffer.from(ADMIN_KEY);
  if (supplied.length !== expected.length || !crypto.timingSafeEqual(supplied, expected)) {
    res.status(401).json({ error: 'Unauthorized' });
    return false;
  }
  return true;
}

app.get('/api/admin/stats', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const now = Date.now();
    const ONE_DAY = 24 * 60 * 60 * 1000;
    const SEVEN_DAYS = 7 * ONE_DAY;
    const THIRTY_DAYS = 30 * ONE_DAY;

    const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
    const weekAgo = new Date(now - SEVEN_DAYS);
    const monthAgo = new Date(now - THIRTY_DAYS);

    const [todayPV, weekPV, monthPV, totalPV] = await Promise.all([
      sql`SELECT COUNT(*) as count FROM admin_page_views WHERE created_at >= ${todayStart.toISOString()}`,
      sql`SELECT COUNT(*) as count FROM admin_page_views WHERE created_at >= ${weekAgo.toISOString()}`,
      sql`SELECT COUNT(*) as count FROM admin_page_views WHERE created_at >= ${monthAgo.toISOString()}`,
      sql`SELECT COUNT(*) as count FROM admin_page_views`
    ]);

    const [todayUV, weekUV, monthUV, totalUV] = await Promise.all([
      sql`SELECT COUNT(DISTINCT session_id) as count FROM admin_page_views WHERE created_at >= ${todayStart.toISOString()}`,
      sql`SELECT COUNT(DISTINCT session_id) as count FROM admin_page_views WHERE created_at >= ${weekAgo.toISOString()}`,
      sql`SELECT COUNT(DISTINCT session_id) as count FROM admin_page_views WHERE created_at >= ${monthAgo.toISOString()}`,
      sql`SELECT COUNT(DISTINCT session_id) as count FROM admin_page_views`
    ]);

    const avgResponse = await sql`SELECT AVG(response_time_ms)::int as avg_ms FROM admin_page_views WHERE created_at >= ${weekAgo.toISOString()} AND response_time_ms > 0`;

    const recentVisitors = await sql`
      SELECT session_id, country, device_type, browser, os, created_at, path
      FROM admin_page_views
      WHERE created_at >= ${new Date(now - 4 * ONE_DAY).toISOString()}
      ORDER BY created_at DESC
      LIMIT 50
    `;

    res.json({
      pageViews: { today: todayPV[0].count, week: weekPV[0].count, month: monthPV[0].count, allTime: totalPV[0].count },
      uniqueVisitors: { today: todayUV[0].count, week: weekUV[0].count, month: monthUV[0].count, allTime: totalUV[0].count },
      avgResponseTimeMs: avgResponse[0].avg_ms || 0,
      recentVisitors
    });
  } catch (e) {
    console.error('Admin stats error:', e.message);
    res.status(500).json({ error: 'Failed to fetch stats' });
  }
});

app.get('/api/admin/countries', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const days = Math.min(parseInt(req.query.days) || 30, 365);
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

    const countries = await sql`
      SELECT country, COUNT(*) as views, COUNT(DISTINCT session_id) as unique_visitors
      FROM admin_page_views
      WHERE created_at >= ${since} AND country IS NOT NULL AND country != 'XX' AND country != 'Local'
      GROUP BY country
      ORDER BY views DESC
      LIMIT 50
    `;

    res.json({ countries, days });
  } catch (e) {
    console.error('Admin countries error:', e.message);
    res.status(500).json({ error: 'Failed to fetch countries' });
  }
});

app.get('/api/admin/devices', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const days = Math.min(parseInt(req.query.days) || 30, 365);
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

    const [devices, browsers, osList] = await Promise.all([
      sql`SELECT device_type, COUNT(*) as count FROM admin_page_views WHERE created_at >= ${since} GROUP BY device_type ORDER BY count DESC`,
      sql`SELECT browser, COUNT(*) as count FROM admin_page_views WHERE created_at >= ${since} AND browser IS NOT NULL GROUP BY browser ORDER BY count DESC`,
      sql`SELECT os, COUNT(*) as count FROM admin_page_views WHERE created_at >= ${since} AND os IS NOT NULL GROUP BY os ORDER BY count DESC`
    ]);

    res.json({ devices, browsers, osList, days });
  } catch (e) {
    console.error('Admin devices error:', e.message);
    res.status(500).json({ error: 'Failed to fetch devices' });
  }
});

app.get('/api/admin/pages', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const days = Math.min(parseInt(req.query.days) || 30, 365);
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

    const pages = await sql`
      SELECT
        CASE
          WHEN path LIKE '/api/analyze-manager%' THEN '/api/analyze-manager'
          WHEN path LIKE '/api/league-standings%' THEN '/api/league-standings'
          WHEN path LIKE '/api/zone-analysis%' THEN '/api/zone-analysis'
          WHEN path LIKE '/api/captain-picks%' THEN '/api/captain-picks'
          WHEN path LIKE '/api/ownership%' THEN '/api/ownership'
          WHEN path LIKE '/api/fixtures-detail%' THEN '/api/fixtures-detail'
          WHEN path LIKE '/api/dashboard%' THEN '/api/dashboard'
          WHEN path LIKE '/api/price%' THEN '/api/price-*'
          WHEN path LIKE '/api/bootstrap%' THEN '/api/bootstrap-static'
          WHEN path LIKE '/api%' THEN path
          ELSE path
        END as page_group,
        path,
        COUNT(*) as views,
        COUNT(DISTINCT session_id) as unique_visitors,
        AVG(response_time_ms)::int as avg_response_ms
      FROM admin_page_views
      WHERE created_at >= ${since}
      GROUP BY page_group, path
      ORDER BY views DESC
      LIMIT 50
    `;

    res.json({ pages, days });
  } catch (e) {
    console.error('Admin pages error:', e.message);
    res.status(500).json({ error: 'Failed to fetch pages' });
  }
});

app.get('/api/admin/hourly', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const days = Math.min(parseInt(req.query.days) || 7, 30);
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

    const hourly = await sql`
      SELECT EXTRACT(HOUR FROM created_at)::int as hour, COUNT(*) as views, COUNT(DISTINCT session_id) as unique_visitors
      FROM admin_page_views
      WHERE created_at >= ${since}
      GROUP BY hour
      ORDER BY hour
    `;

    const daily = await sql`
      SELECT DATE(created_at) as date, COUNT(*) as views, COUNT(DISTINCT session_id) as unique_visitors
      FROM admin_page_views
      WHERE created_at >= ${since}
      GROUP BY date
      ORDER BY date
    `;

    res.json({ hourly, daily, days });
  } catch (e) {
    console.error('Admin hourly error:', e.message);
    res.status(500).json({ error: 'Failed to fetch hourly data' });
  }
});

app.get('/api/admin/referrers', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const days = Math.min(parseInt(req.query.days) || 30, 365);
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

    const referrers = await sql`
      SELECT
        CASE
          WHEN referrer = '' OR referrer IS NULL THEN 'Direct'
          WHEN referrer LIKE '%google%' THEN 'Google'
          WHEN referrer LIKE '%facebook%' OR referrer LIKE '%fb.%' THEN 'Facebook'
          WHEN referrer LIKE '%twitter%' OR referrer LIKE '%t.co%' THEN 'Twitter'
          WHEN referrer LIKE '%reddit%' THEN 'Reddit'
          WHEN referrer LIKE '%instagram%' THEN 'Instagram'
          WHEN referrer LIKE '%youtube%' THEN 'YouTube'
          WHEN referrer LIKE '%myfplstats%' THEN 'Internal'
          ELSE SUBSTRING(referrer FROM 'https?://([^/]+)')
        END as source,
        COUNT(*) as views,
        COUNT(DISTINCT session_id) as unique_visitors
      FROM admin_page_views
      WHERE created_at >= ${since}
      GROUP BY source
      ORDER BY views DESC
      LIMIT 20
    `;

    res.json({ referrers, days });
  } catch (e) {
    console.error('Admin referrers error:', e.message);
    res.status(500).json({ error: 'Failed to fetch referrers' });
  }
});

app.get('/api/admin/feature-usage', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const days = Math.min(parseInt(req.query.days) || 30, 365);
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

    const features = await sql`
      SELECT
        CASE
          WHEN path LIKE '/api/analyze-manager%' THEN 'Team Analysis'
          WHEN path LIKE '/api/league-standings%' THEN 'League Standings'
          WHEN path LIKE '/api/leagues-classic%' THEN 'League Standings'
          WHEN path LIKE '/api/zone-analysis%' THEN 'Zone Analysis'
          WHEN path LIKE '/api/tactics%' THEN 'Tactics'
          WHEN path LIKE '/api/captain-picks%' THEN 'Captain Picks'
          WHEN path LIKE '/api/captaincy%' THEN 'Captaincy Matrix'
          WHEN path LIKE '/api/ownership%' THEN 'Ownership'
          WHEN path LIKE '/api/fixtures-detail%' THEN 'Fixtures'
          WHEN path LIKE '/api/fixtures%' THEN 'Fixtures'
          WHEN path LIKE '/api/dashboard%' THEN 'Dashboard'
          WHEN path LIKE '/api/price-changes%' THEN 'Price Changes'
          WHEN path LIKE '/api/price-predictions%' THEN 'Price Predictions'
          WHEN path LIKE '/api/bootstrap-static%' THEN 'Bootstrap Data'
          WHEN path LIKE '/api/xpts%' THEN 'xPts Projections'
          WHEN path LIKE '/api/chip-strategy%' THEN 'Chip Strategy'
          WHEN path LIKE '/api/differentials%' THEN 'Differentials'
          WHEN path LIKE '/api/set-pieces%' THEN 'Set Pieces'
          WHEN path LIKE '/api/injury-news%' THEN 'Injury News'
          WHEN path LIKE '/api/deadline%' THEN 'Deadline'
          WHEN path LIKE '/api/compare-managers%' THEN 'Compare Managers'
          WHEN path LIKE '/api/manager-roi%' THEN 'Manager ROI'
          WHEN path LIKE '/api/match-analysis%' THEN 'Match Analysis'
          WHEN path LIKE '/api%' THEN 'Other API'
          WHEN path = '/' OR path = '/index.html' THEN 'Homepage'
          WHEN path LIKE '%.html%' THEN 'Page: ' || path
          ELSE 'Static/Other'
        END as feature,
        COUNT(*) as hits,
        COUNT(DISTINCT session_id) as unique_users
      FROM admin_page_views
      WHERE created_at >= ${since}
      GROUP BY feature
      ORDER BY hits DESC
    `;

    res.json({ features, days });
  } catch (e) {
    console.error('Admin feature usage error:', e.message);
    res.status(500).json({ error: 'Failed to fetch feature usage' });
  }
});

app.get('/api/admin/visitors', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, Math.max(10, parseInt(req.query.limit) || 50));
    const offset = (page - 1) * limit;
    const days = Math.min(parseInt(req.query.days) || 7, 90);
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

    const [visitors, countResult] = await Promise.all([
      sql`
        SELECT session_id, country, city, device_type, browser, os, first_page, last_page, page_count, is_returning, created_at, last_active_at,
               last_referrer, device_fingerprint, visit_count, unique_visit_days
        FROM admin_visitor_sessions
        WHERE created_at >= ${since}
        ORDER BY created_at DESC
        LIMIT ${limit} OFFSET ${offset}
      `,
      sql`SELECT COUNT(*) as total FROM admin_visitor_sessions WHERE created_at >= ${since}`
    ]);

    res.json({
      visitors,
      total: countResult[0].total,
      page,
      limit,
      totalPages: Math.ceil(countResult[0].total / limit)
    });
  } catch (e) {
    console.error('Admin visitors error:', e.message);
    res.status(500).json({ error: 'Failed to fetch visitors' });
  }
});

// Device visit summary endpoint
app.get('/api/admin/device-visits', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const days = Math.min(parseInt(req.query.days) || 30, 365);
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

    const [topVisitors, deviceStats, returnRate] = await Promise.all([
      sql`
        SELECT device_fingerprint, country, device_type, browser, os,
               SUM(visit_count) as total_visits,
               MAX(unique_visit_days) as active_days,
               MAX(page_count) as total_pages,
               MAX(last_active_at) as last_seen,
               MIN(created_at) as first_seen
        FROM admin_visitor_sessions
        WHERE created_at >= ${since} AND device_fingerprint IS NOT NULL
        GROUP BY device_fingerprint, country, device_type, browser, os
        ORDER BY total_visits DESC
        LIMIT 50
      `,
      sql`
        SELECT device_type,
               COUNT(DISTINCT device_fingerprint) as unique_devices,
               SUM(visit_count) as total_visits,
               AVG(unique_visit_days)::int as avg_days
        FROM admin_visitor_sessions
        WHERE created_at >= ${since} AND device_fingerprint IS NOT NULL
        GROUP BY device_type
        ORDER BY total_visits DESC
      `,
      sql`
        SELECT
          COUNT(*) FILTER (WHERE visit_count > 1) as returning,
          COUNT(*) as total
        FROM admin_visitor_sessions
        WHERE created_at >= ${since}
      `
    ]);

    res.json({
      topVisitors,
      deviceStats,
      returnRate: returnRate[0],
      days
    });
  } catch (e) {
    console.error('Admin device-visits error:', e.message);
    res.status(500).json({ error: 'Failed to fetch device visits' });
  }
});

// Admin page route
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/admin.html'));
});
app.get('/admin.html', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/admin.html'));
});

// Client-side routes are rendered by React Router.
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  res.sendFile(path.join(clientDistPath, 'index.html'), (error) => {
    if (error) next(error);
  });
});

if (require.main === module) {
  app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
}

module.exports = app;
