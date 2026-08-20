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

// Team News RSS proxy
app.get('/api/team-news', async (req, res) => {
  const axios = require('axios');
  const feeds = [
    { name: 'Fantasy Football Scout', url: 'https://www.fantasyfootballscout.co.uk/feed/' },
    { name: 'BBC Sport Football', url: 'https://feeds.bbci.co.uk/sport/football/rss.xml' },
    { name: 'Premier League', url: 'https://www.premierleague.com/content/premierleague/en-gb/news/newsfeed.rss' },
  ];

  try {
    const results = await Promise.allSettled(
      feeds.map(async (feed) => {
        const resp = await axios.get(feed.url, { timeout: 8000, headers: { 'User-Agent': 'FPLManagerStats/1.0' } });
        const xml = resp.data;
        const items = [];
        const itemRegex = /<item>([\s\S]*?)<\/item>/g;
        let match;
        while ((match = itemRegex.exec(xml)) !== null) {
          const block = match[1];
          const get = (tag) => {
            const m = block.match(new RegExp(`<${tag}[^>]*><\\!\\[CDATA\\[([\\s\\S]*?)\\]\\]><\\/${tag}>|<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`));
            return m ? (m[1] || m[2] || '').trim() : '';
          };
          const title = get('title');
          const link = get('link');
          const pubDate = get('pubDate');
          const description = get('description');
          if (title) {
            items.push({ title, link, pubDate, description: description.replace(/<[^>]+>/g, '').slice(0, 300), source: feed.name });
          }
        }
        return items.slice(0, 15);
      })
    );

    const allItems = results
      .filter(r => r.status === 'fulfilled')
      .flatMap(r => r.value)
      .sort((a, b) => new Date(b.pubDate) - new Date(a.pubDate));

    res.json({ items: allItems.slice(0, 50) });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch news feeds' });
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
