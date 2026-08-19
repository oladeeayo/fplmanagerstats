const crypto = require('crypto');
const { rateLimit } = require('express-rate-limit');
const { sql } = require('./db');
const logger = require('./logger');
const { geoCache, GEO_CACHE_TTL } = require('./cache');

const ALLOWED_ORIGINS = new Set([
  'https://fplmanager.xyz',
  'https://www.fplmanager.xyz',
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  'http://localhost:3000',
  'http://127.0.0.1:3000',
]);

function corsMiddleware(req, res, next) {
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.has(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-admin-key');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
}

function securityHeaders(req, res, next) {
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
  next();
}

// ---- Analytics Tracking ----
const geoLookupMax = 30;
let geoLookupTimes = [];

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
  else if (/cros/i.test(lower)) { os = 'ChromeOS'; }
  return { deviceType, browser, os, osVersion };
}

async function lookupGeo(ip) {
  if (!ip || ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1') {
    return { country: 'Local', city: 'Local', continent: 'Local' };
  }
  if (!/^(?:\d{1,3}\.){3}\d{1,3}$|^[0-9a-fA-F:]+$/.test(ip)) return { country: 'XX', city: '', continent: '' };
  const cached = geoCache.get(ip);
  if (cached && Date.now() - cached.ts < GEO_CACHE_TTL) return cached.data;
  const now = Date.now();
  geoLookupTimes = geoLookupTimes.filter(t => now - t < 60000);
  if (geoLookupTimes.length >= geoLookupMax) return { country: 'XX', city: '', continent: '' };
  geoLookupTimes.push(now);
  try {
    const axios = require('axios');
    const res = await axios.get(`https://ip-api.com/json/${ip}?fields=status,country,countryCode,city,continent`, { timeout: 3000 });
    if (res.data.status === 'success') {
      const geo = { country: res.data.countryCode || 'XX', city: res.data.city || '', continent: res.data.continent || '' };
      geoCache.set(ip, { data: geo, ts: now });
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

function sessionMiddleware(req, res, next) {
  const cookies = String(req.headers.cookie || '').split(';').reduce((all, part) => {
    const separator = part.indexOf('=');
    if (separator > 0) all[part.slice(0, separator).trim()] = part.slice(separator + 1).trim();
    return all;
  }, {});
  const existing = cookies.fpl_analytics_session;
  const sessionId = /^[a-f0-9]{32}$/.test(existing || '') ? existing : generateSessionId();
  if (!existing) {
    const secure = req.secure || req.headers['x-forwarded-proto'] === 'https';
    res.setHeader('Set-Cookie', `fpl_analytics_session=${sessionId}; Max-Age=31536000; Path=/; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`);
  }
  req.fplSessionId = sessionId;
  next();
}

function trackingMiddleware(req, res, next) {
  if (!sql) return next();
  const startTime = Date.now();
  const originalEnd = res.end;

  res.end = function (...args) {
    const responseTime = Date.now() - startTime;
    const reqPath = req.originalUrl || req.url;

    if (reqPath.startsWith('/api/admin') || (reqPath.includes('.') && !reqPath.includes('?'))) {
      return originalEnd.apply(this, args);
    }

    (async () => {
      try {
        const forwarded = req.headers['x-forwarded-for'];
        const rawIp = forwarded ? forwarded.split(',')[0].trim() : (req.socket?.remoteAddress || '');
        const ip = /^(?:\d{1,3}\.){3}\d{1,3}$|^[0-9a-fA-F:]+$/.test(rawIp) ? rawIp : (req.socket?.remoteAddress || '');
        const ua = req.headers['user-agent'] || '';
        const referrer = req.headers['referer'] || req.headers['referrer'] || '';
        const sessionId = req.fplSessionId;

        const { deviceType, browser, os, osVersion } = parseUserAgent(ua);
        const geo = await lookupGeo(ip);
        const ipHash = hashIP(ip);
        const deviceFP = crypto.createHash('sha256').update(`${ua}|${ipHash}`).digest('hex').slice(0, 16);

        await sql`
          INSERT INTO admin_page_views (session_id, path, referrer, ip_hash, country, city, continent, device_type, browser, os, os_version, status_code, response_time_ms)
          VALUES (${sessionId}, ${reqPath.slice(0, 512)}, ${referrer.slice(0, 1024)}, ${ipHash}, ${geo.country}, ${geo.city.slice(0, 128)}, ${geo.continent}, ${deviceType}, ${browser}, ${os}, ${osVersion}, ${res.statusCode}, ${Math.min(responseTime, 99999)})
        `;

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
                last_page = ${reqPath.slice(0, 512)},
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
            VALUES (${sessionId}, ${ipHash}, ${geo.country}, ${geo.city.slice(0, 128)}, ${geo.continent}, ${deviceType}, ${browser}, ${os}, ${osVersion}, ${reqPath.slice(0, 512)}, ${reqPath.slice(0, 512)}, 1, FALSE, ${referrer.slice(0, 1024)}, ${deviceFP}, 1, 1)
          `;
        }
      } catch (e) { logger.debug({ err: e }, 'Tracking error'); }
    })();

    return originalEnd.apply(this, args);
  };

  next();
}

// ---- Rate limiting ----
// Use session ID as primary key (more stable than IP behind CDNs).
// Fall back to IP with IPv6 normalization via the default keyGenerator.
const rateLimitDefaults = {
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  validate: { keyGeneratorIpFallback: false }, // trust proxy handles IP normalization
};

const generalApiLimiter = rateLimit({
  ...rateLimitDefaults,
  windowMs: 15 * 60 * 1000,
  limit: 600,
  message: { error: 'Too many requests — slow down.' },
  keyGenerator: req => req.fplSessionId || req.ip || 'unknown',
});
const heavyEndpointLimiter = rateLimit({
  ...rateLimitDefaults,
  windowMs: 60 * 1000,
  limit: 30,
  message: { error: 'Too many requests — please wait before trying again.' },
  keyGenerator: req => req.fplSessionId || req.ip || 'unknown',
});
const adminLimiter = rateLimit({
  ...rateLimitDefaults,
  windowMs: 15 * 60 * 1000,
  limit: 120,
  message: { error: 'Too many admin requests.' },
  keyGenerator: req => req.fplSessionId || req.ip || 'unknown',
});
const adminLoginLimiter = rateLimit({
  ...rateLimitDefaults,
  windowMs: 15 * 60 * 1000,
  limit: 10,
  message: { error: 'Too many login attempts — try again later.' },
  keyGenerator: req => req.fplSessionId || req.ip || 'unknown',
});

setInterval(() => { geoLookupTimes = geoLookupTimes.filter(t => Date.now() - t < 60000); }, 60000);

module.exports = {
  corsMiddleware,
  securityHeaders,
  sessionMiddleware,
  trackingMiddleware,
  generalApiLimiter,
  heavyEndpointLimiter,
  adminLimiter,
  adminLoginLimiter,
};
