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
const scatterRoutes = require('./server/routes/scatter');
const { getCachedApiData, BOOTSTRAP_URL, snapshotManager } = require('./server/cache');

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
app.use('/api', scatterRoutes);
app.use('/api/admin', adminRoutes);

// Team News — FPL bootstrap API + FFS injury scrape with manager quotes
let lastTeamNewsResponse = null;

app.get('/api/team-news', async (req, res) => {
  const { scrapeFFSInjuries } = require('./server/ffsScraper');

  try {
    // Fetch both sources in parallel
    const [data, ffsData] = await Promise.all([
      getCachedApiData(BOOTSTRAP_URL, 5 * 60 * 1000),
      scrapeFFSInjuries().catch(() => []),
    ]);

    const teams = data.teams || [];
    const elements = data.elements || [];
    const events = data.events || [];
    const currentGW = events.find(e => e.is_current)?.id || events.find(e => e.is_next)?.id || 1;

    const teamMap = {};
    teams.forEach(t => { teamMap[t.id] = { id: t.id, name: t.name, short: t.short_name }; });

    // Build FFS lookup by teamCode + player name variants
    const ffsByTeamName = {};
    const ffsByTeamLastName = {};
    const ffsByTeamFirstName = {};
    (ffsData || []).forEach(entry => {
      if (entry.player && entry.teamCode) {
        const nameKey = `${entry.teamCode}|${entry.player.toLowerCase()}`;
        ffsByTeamName[nameKey] = entry;
        if (entry.lastName) {
          const lastNameKey = `${entry.teamCode}|${entry.lastName.toLowerCase()}`;
          if (!ffsByTeamLastName[lastNameKey]) ffsByTeamLastName[lastNameKey] = entry;
        }
        // Also index by first name (first word of full name)
        const firstName = entry.player.split(/\s+/)[0].toLowerCase();
        if (firstName) {
          const firstNameKey = `${entry.teamCode}|${firstName}`;
          if (!ffsByTeamFirstName[firstNameKey]) ffsByTeamFirstName[firstNameKey] = entry;
        }
      }
    });

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

      // Try to find FFS data for this player by team code + name variants
      const teamCode = team.short;
      const webName = (el.web_name || '').toLowerCase();
      const firstName = (el.first_name || '').toLowerCase();
      const lastName = (el.last_name || '').toLowerCase();
      const fullName = `${firstName} ${lastName}`;

      // Handle abbreviated web names: "Bruno G." -> "bruno", "J.Timber" -> "timber"
      const webNameDots = webName.replace(/\./g, '').trim();
      const webNameParts = webName.split(/[.\s]+/).filter(Boolean);
      const webNameLastPart = webNameParts.length > 1 ? webNameParts[webNameParts.length - 1] : webName;

      const ffsEntry = ffsByTeamName[`${teamCode}|${webName}`]
        || ffsByTeamLastName[`${teamCode}|${webName}`]
        || ffsByTeamLastName[`${teamCode}|${webNameDots}`]
        || ffsByTeamLastName[`${teamCode}|${webNameLastPart}`]
        || ffsByTeamName[`${teamCode}|${lastName}`]
        || ffsByTeamLastName[`${teamCode}|${lastName}`]
        || ffsByTeamName[`${teamCode}|${fullName}`]
        || ffsByTeamName[`${teamCode}|${firstName}`]
        || ffsByTeamFirstName[`${teamCode}|${firstName}`];

      // Use FFS news if richer, otherwise prefer FPL
      let combinedNews = news;
      let managerQuote = null;
      let sourceUrl = null;
      let returnDate = null;
      let injury = null;

      if (ffsEntry) {
        if (ffsEntry.news && ffsEntry.news.length > combinedNews.length) {
          combinedNews = ffsEntry.news;
        }
        managerQuote = ffsEntry.managerQuote || null;
        sourceUrl = ffsEntry.sourceUrl || null;
        returnDate = ffsEntry.returnDate || null;
        injury = ffsEntry.injury || null;
      }

      teamNews[team.id].players.push({
        name: el.web_name || el.first_name + ' ' + el.last_name,
        pos: { 1: 'GKP', 2: 'DEF', 3: 'MID', 4: 'FWD' }[el.element_type] || '?',
        status,
        news: combinedNews,
        chance: el.chance_of_playing_next_round,
        category,
        managerQuote,
        sourceUrl,
        returnDate,
        injury,
      });
    });

    // Sort within each team: suspended > out > injury > doubt > news
    const catOrder = { suspended: 0, out: 1, injury: 2, doubt: 3, news: 4 };
    Object.values(teamNews).forEach(t => {
      t.players.sort((a, b) => (catOrder[a.category] ?? 5) - (catOrder[b.category] ?? 5));
    });

    const sorted = Object.values(teamNews).sort((a, b) => a.team.name.localeCompare(b.team.name));
    lastTeamNewsResponse = { currentGW, teams: sorted, ffsCount: (ffsData || []).length };
    res.json(lastTeamNewsResponse);
  } catch (err) {
    if (lastTeamNewsResponse) {
      return res.json({ ...lastTeamNewsResponse, stale: true });
    }
    res.status(502).json({ error: 'Team news is temporarily unavailable. Please try again.' });
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
snapshotManager.initSnapshotManager();

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
