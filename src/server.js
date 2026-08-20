const express = require('express');
const path = require('path');
const helmet = require('helmet');

// Sentry — must be imported before any other module
if (process.env.SENTRY_DSN) {
  const Sentry = require('@sentry/node');
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment: process.env.VERCEL_ENV || process.env.NODE_ENV || 'development',
    tracesSampleRate: 0.1,
  });
}

const logger = require('./server/logger');
const { sql, initDatabase } = require('./server/db');
const {
  corsMiddleware,
  securityHeaders,
  sessionMiddleware,
  trackingMiddleware,
  generalApiLimiter,
  adminLimiter,
} = require('./server/middleware');

const fplRoutes = require('./server/routes/fpl');
const adminRoutes = require('./server/routes/admin');
const decisionRoutes = require('./server/routes/decision');
const aiTeamRoutes = require('./server/routes/ai-team');
const ownershipRoutes = require('./server/routes/ownership');
const miscRoutes = require('./server/routes/misc');

const app = express();
const PORT = process.env.PORT || 3000;
const clientDistPath = path.join(__dirname, '../dist');

app.set('trust proxy', 1);

app.use(express.static(clientDistPath, {
  maxAge: '1y',
  immutable: true,
  setHeaders(res, filePath) {
    if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache');
  },
}));

app.use(express.static(path.join(__dirname, '../public'), {
  maxAge: '7d',
  setHeaders(res, filePath) {
    if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache');
  },
}));

app.use(express.json({ limit: '1mb' }));

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", "https://cdn.jsdelivr.net"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      fontSrc: ["'self'", "https://fonts.gstatic.com"],
      imgSrc: ["'self'", "data:", "https:", "blob:"],
      connectSrc: ["'self'", "https://fantasy.premierleague.com", "https://ip-api.com", "https://generativelanguage.googleapis.com"],
      objectSrc: ["'none'"],
      mediaSrc: ["'none'"],
      frameSrc: ["'none'"],
    },
  },
  crossOriginResourcePolicy: { policy: 'same-origin' },
}));

app.use(corsMiddleware);
app.use(securityHeaders);
app.use(sessionMiddleware);
app.use(trackingMiddleware);

app.use('/api', generalApiLimiter);
app.use('/api/admin', adminLimiter);

app.use('/api', fplRoutes.router);
app.use('/api/ai-team', aiTeamRoutes);
app.use('/api', decisionRoutes);
app.use('/api/ownership', ownershipRoutes);
app.use('/api', miscRoutes);
app.use('/api/admin', adminRoutes);

// Team News — FPL player availability from bootstrap API + FFS scrape
app.get('/api/team-news', async (req, res) => {
  const axios = require('axios');
  try {
    const resp = await axios.get('https://fantasy.premierleague.com/api/bootstrap-static/', { timeout: 10000 });
    const data = resp.data;
    const teams = data.teams || [];
    const elements = data.elements || [];
    const events = data.events || [];
    const currentGW = events.find(e => e.is_current)?.id || events.find(e => e.is_next)?.id || 1;

    const teamMap = {};
    teams.forEach(t => { teamMap[t.id] = { id: t.id, name: t.name, short: t.short_name }; });

    const teamNews = {};
    elements.forEach(el => {
      const status = (el.status || 'a').toLowerCase();
      const news = (el.news || '').trim();
      if (status === 'a' && !news) return;

      const team = teamMap[el.team];
      if (!team) return;
      if (!teamNews[team.id]) teamNews[team.id] = { team, players: [] };

      let category = 'news';
      if (status === 'j' || status === 's' || news.toLowerCase().includes('suspended')) category = 'suspended';
      else if (status === 'u') category = 'out';
      else if (status === 'i') category = 'injury';
      else if (status === 'd') category = 'doubt';

      teamNews[team.id].players.push({
        name: el.web_name || el.first_name + ' ' + el.last_name,
        pos: { 1: 'GKP', 2: 'DEF', 3: 'MID', 4: 'FWD' }[el.element_type] || '?',
        status,
        news,
        chance: el.chance_of_playing_next_round,
        category,
      });
    });

    // Sort within each team: suspended > out > injury > doubt > news
    const catOrder = { suspended: 0, out: 1, injury: 2, doubt: 3, news: 4 };
    Object.values(teamNews).forEach(t => {
      t.players.sort((a, b) => (catOrder[a.category] ?? 5) - (catOrder[b.category] ?? 5));
    });

    const sorted = Object.values(teamNews).sort((a, b) => a.team.name.localeCompare(b.team.name));
    res.json({ currentGW, teams: sorted });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch team news' });
  }
});

// Sentry request handler (must be after routes, before error handler)
if (process.env.SENTRY_DSN) {
  const Sentry = require('@sentry/node');
  app.use(Sentry.Handlers.requestHandler());
}

app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  res.sendFile(path.join(clientDistPath, 'index.html'), (error) => {
    if (error) next(error);
  });
});

initDatabase();

// Initialize opponent model with Understat data (background, non-blocking)
(async () => {
  try {
    const understat = require('./server/understat');
    const opponentModel = require('./server/opponentModel');
    const teamData = await understat.fetchTeams();
    if (teamData) {
      const profiles = understat.buildOpponentProfiles(teamData);
      opponentModel.setTeamProfiles(profiles);
      logger.info({ teams: Object.keys(profiles).length }, 'Understat opponent profiles loaded');
    }
  } catch (err) {
    logger.warn({ err }, 'Failed to load Understat data on startup');
  }
})();

if (require.main === module) {
  app.listen(PORT, () => logger.info({ port: PORT }, 'Server running'));
}

module.exports = app;
