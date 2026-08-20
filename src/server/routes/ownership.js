const express = require('express');
const router = express.Router();
const { getCachedApiData, BOOTSTRAP_URL } = require('../cache');
const { requireDatabase, POSITION_MAP } = require('../helpers');
const { heavyEndpointLimiter } = require('../middleware');
const logger = require('../logger');
const { sql } = require('../db');

router.get('/history', async (req, res) => {
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
    logger.error({ err: e }, 'Ownership history error');
    res.status(500).json({ error: 'Failed to fetch ownership history' });
  }
});

router.post('/snapshot', heavyEndpointLimiter, async (req, res) => {
  if (!requireDatabase(req, res)) return;
  try {
    const now = Date.now();
    const THROTTLE = 60 * 60 * 1000; // 1 hour throttle

    // Atomic compare-and-swap: claim the throttle slot. The row lock serialises
    // concurrent requests, so exactly one wins the right to write a snapshot.
    const claimed = await sql`
      INSERT INTO ownership_snapshot_lock (id, last_timestamp) VALUES (TRUE, ${now})
      ON CONFLICT (id) DO UPDATE SET last_timestamp = EXCLUDED.last_timestamp
      WHERE ownership_snapshot_lock.last_timestamp < ${now - THROTTLE}
      RETURNING last_timestamp
    `;

    if (claimed.length === 0) {
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
    logger.error({ err: e }, 'Ownership snapshot error');
    res.status(500).json({ error: 'Failed to create snapshot' });
  }
});

router.get('/trends', async (req, res) => {
  try {
    const bs = await getCachedApiData(BOOTSTRAP_URL);
    let snapshots = [];
    try {
      snapshots = await sql`SELECT timestamp, players FROM ownership_snapshots ORDER BY timestamp ASC`;
    } catch (dbErr) {
      logger.warn('Neon DB query warning (falling back to live calculations):' + dbErr.message);
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

    // Identify bento highlights — use ownership delta from snapshots
    const topTransferredIn = [...playersList].sort((a, b) => b.delta24h - a.delta24h)[0] || null;
    const topTransferredOut = [...playersList].sort((a, b) => a.delta24h - b.delta24h)[0] || null;
    const highestVelocity = [...playersList].sort((a, b) => Math.abs(b.velocityShift) - Math.abs(a.velocityShift))[0] || null;

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
    logger.error({ err: e }, 'Ownership trends error');
    res.status(500).json({ error: 'Failed to fetch ownership trends' });
  }
});

module.exports = router;
