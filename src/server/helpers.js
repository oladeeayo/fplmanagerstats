const { sql } = require('./db');

const POSITION_MAP = ["GKP", "DEF", "MID", "FWD"];

function parsePositiveId(value) {
  return /^\d+$/.test(String(value)) && Number(value) > 0 ? String(value) : null;
}

function requireDatabase(req, res) {
  if (sql) return true;
  res.status(503).json({ error: 'Database features are not configured' });
  return false;
}

function stripCodeFences(text) {
  return String(text || '')
    .replace(/```[a-z]*\n?/gi, '')
    .replace(/```/g, '')
    .trim();
}

module.exports = {
  POSITION_MAP,
  parsePositiveId,
  requireDatabase,
  stripCodeFences,
};
