const express = require('express');
const { buildGWSummary } = require('../gwSummary');
const logger = require('../logger');

const router = express.Router();

// Public GW Summary Generator (WhatsApp-formatted markdown + league table)
// Same engine as the admin endpoint, but reachable from the main site.
router.get('/gw-summary', async (req, res) => {
  try {
    const leagueId = parseInt(req.query.leagueId);
    const gw = parseInt(req.query.gw);
    if (!leagueId) return res.status(400).json({ error: 'leagueId is required' });
    const data = await buildGWSummary({ leagueId, gw });
    res.json(data);
  } catch (e) {
    if (e.status === 404) return res.status(404).json({ error: e.message });
    logger.error({ err: e }, 'GW summary error');
    res.status(500).json({ error: 'Failed to generate GW summary: ' + e.message });
  }
});

module.exports = router;
