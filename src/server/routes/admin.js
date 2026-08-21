const express = require('express');
const crypto = require('crypto');
const { sql } = require('../db');
const logger = require('../logger');
const { requireDatabase } = require('../helpers');
const { adminLoginLimiter } = require('../middleware');

const router = express.Router();

const ADMIN_KEY = process.env.ADMIN_KEY;
const ADMIN_SESSION_SECRET = process.env.ADMIN_SESSION_SECRET || ADMIN_KEY || crypto.randomBytes(32).toString('hex');

const ADMIN_SESSION_TTL = 24 * 60 * 60 * 1000; // 24 hours

// Brute-force protection: track failed login attempts per IP
const loginAttempts = new Map();
const MAX_ATTEMPTS = 5;
const LOCKOUT_MS = 15 * 60 * 1000; // 15 minutes

function cleanupSessions() {
  const now = Date.now();
  for (const [ip, record] of loginAttempts) {
    if (now - record.lastAttempt > LOCKOUT_MS) loginAttempts.delete(ip);
  }
}
setInterval(cleanupSessions, 5 * 60 * 1000).unref();

function generateAdminSessionToken() {
  const payload = `${Date.now()}.${crypto.randomBytes(16).toString('hex')}`;
  const signature = crypto.createHmac('sha256', ADMIN_SESSION_SECRET).update(payload).digest('hex');
  return `${payload}.${signature}`;
}

function createAdminSession(req, res) {
  const token = generateAdminSessionToken();
  const secure = req.secure || req.headers['x-forwarded-proto'] === 'https';
  res.setHeader('Set-Cookie', `fpl_admin_session=${token}; Max-Age=${ADMIN_SESSION_TTL / 1000}; Path=/api/admin; HttpOnly; SameSite=Strict${secure ? '; Secure' : ''}`);
  return token;
}

function destroyAdminSession(req, res) {
  const secure = req.secure || req.headers['x-forwarded-proto'] === 'https';
  res.setHeader('Set-Cookie', `fpl_admin_session=; Max-Age=0; Path=/api/admin; HttpOnly; SameSite=Strict${secure ? '; Secure' : ''}`);
}

function parseAdminCookie(req) {
  const cookies = String(req.headers.cookie || '').split(';').reduce((all, part) => {
    const sep = part.indexOf('=');
    if (sep > 0) all[part.slice(0, sep).trim()] = part.slice(sep + 1).trim();
    return all;
  }, {});
  return cookies.fpl_admin_session || null;
}

function isAdminAuthenticated(req) {
  const token = parseAdminCookie(req);
  if (!token) return false;
  const [createdAtValue, nonce, signature, ...extra] = token.split('.');
  if (extra.length || !/^\d+$/.test(createdAtValue) || !/^[a-f0-9]{32}$/.test(nonce) || !/^[a-f0-9]{64}$/.test(signature)) return false;

  const createdAt = Number(createdAtValue);
  if (!Number.isSafeInteger(createdAt) || createdAt > Date.now() || Date.now() - createdAt > ADMIN_SESSION_TTL) return false;

  const payload = `${createdAtValue}.${nonce}`;
  const expected = crypto.createHmac('sha256', ADMIN_SESSION_SECRET).update(payload).digest();
  const supplied = Buffer.from(signature, 'hex');
  return supplied.length === expected.length && crypto.timingSafeEqual(supplied, expected);
}

// Login endpoint with brute-force protection
router.post('/login', adminLoginLimiter, (req, res) => {
  if (!ADMIN_KEY) {
    return res.status(503).json({ error: 'Admin analytics are not configured' });
  }
  if (!sql) {
    return res.status(503).json({ error: 'Database not available' });
  }

  const ip = req.ip || req.socket?.remoteAddress || 'unknown';
  const now = Date.now();

  // Check brute-force lockout
  const record = loginAttempts.get(ip);
  if (record && record.count >= MAX_ATTEMPTS && now - record.lastAttempt < LOCKOUT_MS) {
    const remaining = Math.ceil((LOCKOUT_MS - (now - record.lastAttempt)) / 60000);
    logger.warn({ ip }, 'Admin login locked out');
    return res.status(429).json({ error: `Too many failed attempts. Try again in ${remaining} minutes.` });
  }

  const key = typeof req.body?.key === 'string' ? req.body.key : '';
  if (!key) {
    return res.status(400).json({ error: 'Admin key is required' });
  }

  // Timing-safe comparison
  const supplied = Buffer.from(key);
  const expected = Buffer.from(ADMIN_KEY);
  const isValid = supplied.length === expected.length && crypto.timingSafeEqual(supplied, expected);

  if (!isValid) {
    // Track failed attempt
    const attempts = loginAttempts.get(ip) || { count: 0, lastAttempt: 0 };
    attempts.count += 1;
    attempts.lastAttempt = now;
    loginAttempts.set(ip, attempts);
    logger.warn({ ip, attemptCount: attempts.count }, 'Failed admin login attempt');
    return res.status(401).json({ error: 'Invalid admin key' });
  }

  // Successful login - reset attempts
  loginAttempts.delete(ip);
  createAdminSession(req, res);
  logger.info({ ip }, 'Admin login successful');
  res.json({ ok: true });
});

// Logout endpoint
router.post('/logout', (req, res) => {
  destroyAdminSession(req, res);
  res.json({ ok: true });
});

// Session check endpoint
router.get('/session', (req, res) => {
  if (!ADMIN_KEY) return res.json({ authenticated: false });
  res.json({ authenticated: isAdminAuthenticated(req) });
});

// Middleware: require admin session OR legacy key header for backward compatibility
function requireAdmin(req, res) {
  if (!ADMIN_KEY) {
    res.status(503).json({ error: 'Admin analytics are not configured' });
    return false;
  }
  if (!sql) return requireDatabase(req, res);

  // Check session cookie first
  if (isAdminAuthenticated(req)) return true;

  // Fallback: legacy x-admin-key header (backward compat)
  const key = req.headers['x-admin-key'];
  const supplied = typeof key === 'string' ? Buffer.from(key) : Buffer.alloc(0);
  const expected = Buffer.from(ADMIN_KEY);
  if (supplied.length === expected.length && crypto.timingSafeEqual(supplied, expected)) {
    return true;
  }

  res.status(401).json({ error: 'Unauthorized' });
  return false;
}

router.get('/stats', async (req, res) => {
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
    logger.error({ err: e }, 'Admin stats error');
    res.status(500).json({ error: 'Failed to fetch stats' });
  }
});

router.get('/countries', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const days = Math.min(parseInt(req.query.days) || 30, 365);
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    const countries = await sql`
      SELECT country, COUNT(*) as views, COUNT(DISTINCT session_id) as unique_visitors
      FROM admin_page_views
      WHERE created_at >= ${since} AND country IS NOT NULL AND country != 'XX' AND country != 'Local'
      GROUP BY country ORDER BY views DESC LIMIT 50
    `;
    res.json({ countries, days });
  } catch (e) {
    logger.error({ err: e }, 'Admin countries error');
    res.status(500).json({ error: 'Failed to fetch countries' });
  }
});

router.get('/devices', async (req, res) => {
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
    logger.error({ err: e }, 'Admin devices error');
    res.status(500).json({ error: 'Failed to fetch devices' });
  }
});

router.get('/pages', async (req, res) => {
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
        path, COUNT(*) as views, COUNT(DISTINCT session_id) as unique_visitors, AVG(response_time_ms)::int as avg_response_ms
      FROM admin_page_views WHERE created_at >= ${since}
      GROUP BY page_group, path ORDER BY views DESC LIMIT 50
    `;
    res.json({ pages, days });
  } catch (e) {
    logger.error({ err: e }, 'Admin pages error');
    res.status(500).json({ error: 'Failed to fetch pages' });
  }
});

router.get('/hourly', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const days = Math.min(parseInt(req.query.days) || 7, 30);
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    const hourly = await sql`
      SELECT EXTRACT(HOUR FROM created_at)::int as hour, COUNT(*) as views, COUNT(DISTINCT session_id) as unique_visitors
      FROM admin_page_views WHERE created_at >= ${since} GROUP BY hour ORDER BY hour
    `;
    const daily = await sql`
      SELECT DATE(created_at) as date, COUNT(*) as views, COUNT(DISTINCT session_id) as unique_visitors
      FROM admin_page_views WHERE created_at >= ${since} GROUP BY date ORDER BY date
    `;
    res.json({ hourly, daily, days });
  } catch (e) {
    logger.error({ err: e }, 'Admin hourly error');
    res.status(500).json({ error: 'Failed to fetch hourly data' });
  }
});

router.get('/referrers', async (req, res) => {
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
          WHEN referrer LIKE '%fplmanager%' THEN 'Internal'
          ELSE SUBSTRING(referrer FROM 'https?://([^/]+)')
        END as source,
        COUNT(*) as views, COUNT(DISTINCT session_id) as unique_visitors
      FROM admin_page_views WHERE created_at >= ${since}
      GROUP BY source ORDER BY views DESC LIMIT 20
    `;
    res.json({ referrers, days });
  } catch (e) {
    logger.error({ err: e }, 'Admin referrers error');
    res.status(500).json({ error: 'Failed to fetch referrers' });
  }
});

router.get('/feature-usage', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const days = Math.min(parseInt(req.query.days) || 30, 365);
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    const features = await sql`
      SELECT
        CASE
          WHEN path LIKE '/api/analyze-manager%' THEN 'Manager Analysis'
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
        COUNT(*) as hits, COUNT(DISTINCT session_id) as unique_users
      FROM admin_page_views WHERE created_at >= ${since}
      GROUP BY feature ORDER BY hits DESC
    `;
    res.json({ features, days });
  } catch (e) {
    logger.error({ err: e }, 'Admin feature usage error');
    res.status(500).json({ error: 'Failed to fetch feature usage' });
  }
});

router.get('/visitors', async (req, res) => {
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
        FROM admin_visitor_sessions WHERE created_at >= ${since}
        ORDER BY created_at DESC LIMIT ${limit} OFFSET ${offset}
      `,
      sql`SELECT COUNT(*) as total FROM admin_visitor_sessions WHERE created_at >= ${since}`
    ]);
    res.json({ visitors, total: countResult[0].total, page, limit, totalPages: Math.ceil(countResult[0].total / limit) });
  } catch (e) {
    logger.error({ err: e }, 'Admin visitors error');
    res.status(500).json({ error: 'Failed to fetch visitors' });
  }
});

router.get('/device-visits', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const days = Math.min(parseInt(req.query.days) || 30, 365);
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    const [topVisitors, deviceStats, returnRate] = await Promise.all([
      sql`
        SELECT device_fingerprint, country, device_type, browser, os,
               SUM(visit_count) as total_visits, MAX(unique_visit_days) as active_days,
               MAX(page_count) as total_pages, MAX(last_active_at) as last_seen, MIN(created_at) as first_seen
        FROM admin_visitor_sessions WHERE created_at >= ${since} AND device_fingerprint IS NOT NULL
        GROUP BY device_fingerprint, country, device_type, browser, os
        ORDER BY total_visits DESC LIMIT 50
      `,
      sql`
        SELECT device_type, COUNT(DISTINCT device_fingerprint) as unique_devices,
               SUM(visit_count) as total_visits, AVG(unique_visit_days)::int as avg_days
        FROM admin_visitor_sessions WHERE created_at >= ${since} AND device_fingerprint IS NOT NULL
        GROUP BY device_type ORDER BY total_visits DESC
      `,
      sql`
        SELECT COUNT(*) FILTER (WHERE visit_count > 1) as returning, COUNT(*) as total
        FROM admin_visitor_sessions WHERE created_at >= ${since}
      `
    ]);
    res.json({ topVisitors, deviceStats, returnRate: returnRate[0], days });
  } catch (e) {
    logger.error({ err: e }, 'Admin device-visits error');
    res.status(500).json({ error: 'Failed to fetch device visits' });
  }
});

router.get('/connected-managers', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, Math.max(10, parseInt(req.query.limit) || 50));
    const offset = (page - 1) * limit;
    const [managers, countResult] = await Promise.all([
      sql`
        SELECT manager_id, team_name, player_first_name, player_last_name,
               overall_points, overall_rank, league_id, first_connected, last_seen
        FROM connected_managers
        ORDER BY last_seen DESC
        LIMIT ${limit} OFFSET ${offset}
      `,
      sql`SELECT COUNT(*) as total FROM connected_managers`
    ]);
    res.json({ managers, total: countResult[0].total, page, limit, totalPages: Math.ceil(countResult[0].total / limit) });
  } catch (e) {
    logger.error({ err: e }, 'Admin connected managers error');
    res.status(500).json({ error: 'Failed to fetch connected managers' });
  }
});

module.exports = router;
