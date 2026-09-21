const { getCachedApiData, BOOTSTRAP_URL } = require('./cache');
const logger = require('./logger');

// --- Effective XI helpers ---------------------------------------------------
// FPL's picks endpoint serves the post-automatic-substitution state: players
// who didn't play have already been swapped for bench players (positions and
// multipliers updated, armband moved to the vice-captain). Some API variants
// instead return pre-swap picks with the swaps listed in `automatic_subs`, and
// stale caches may omit the field entirely. The helpers below normalise every
// variant so XI-based stats (XI Impact) always reflect the XI that played.

// Best-effort fallback for responses without automatic_subs: bench players
// who clearly didn't play (isPlayed false) are swapped for the best-scoring
// eligible bench player (same position preferred, then bench order).
function inferEffectivePicks(picks, isPlayed) {
  // No player has any minutes/points yet (e.g. between deadline and kickoff,
  // or no live data for the GW) — swapping would be pure guesswork, skip it.
  if (!picks.some(p => isPlayed(p.element))) return picks;
  const starters = picks.filter(p => p.position <= 11);
  const bench = picks.filter(p => p.position > 11).sort((a, b) => a.position - b.position);
  const available = bench.filter(p => isPlayed(p.element));
  const used = new Set();
  for (const starter of starters) {
    if (isPlayed(starter.element)) continue;
    const sameType = available.find(p => !used.has(p.element) && p.element_type === starter.element_type)
      || available.find(p => !used.has(p.element));
    if (!sameType) continue;
    used.add(sameType.element);
    const pos = starter.position, mult = starter.multiplier;
    starter.position = sameType.position;
    starter.multiplier = sameType.multiplier;
    sameType.position = pos;
    sameType.multiplier = mult;
  }
  return picks;
}

function effectivePicks(picks, autosubs, isPlayed) {
  if (!Array.isArray(picks) || picks.length === 0) return [];
  const working = picks.map(p => ({ ...p }));

  // Field absent (legacy variant/stale cache): the payload is pre-swap and
  // lists no subs — infer them from play status.
  if (!Array.isArray(autosubs)) {
    return inferEffectivePicks(working, isPlayed);
  }

  // Field present (even empty): the endpoint serves the POST-swap state —
  // subbed-out players are already benched (position > 11, multiplier 0) and
  // the armband has moved. Applying automatic_subs to that payload would
  // REVERSE the swap. Only apply when the payload is clearly pre-swap
  // (a subbed-out player still sitting in the XI).
  if (autosubs.length > 0) {
    const byId = new Map(working.map(p => [p.element, p]));
    const needsApply = autosubs.some(s => {
      const outPick = byId.get(s.element_out);
      return outPick && outPick.position <= 11;
    });
    if (needsApply) {
      for (const s of autosubs) {
        const outPick = byId.get(s.element_out);
        const inPick = byId.get(s.element_in);
        if (!outPick || !inPick) continue;
        const pos = outPick.position, mult = outPick.multiplier;
        outPick.position = inPick.position;
        outPick.multiplier = inPick.multiplier;
        inPick.position = pos;
        inPick.multiplier = mult;
      }
    }
  }
  return working;
}

// XI Impact: points gained/lost from player swaps — compares the previous GW's
// effective XI with the current effective XI (both AFTER automatic subs).
function computeEffectiveXIImpact(prevPicks, curPicks, prevAutosubs, curAutosubs, getPlayerPoints) {
  if (!Array.isArray(prevPicks) || prevPicks.length === 0) return 0;
  if (!Array.isArray(curPicks) || curPicks.length === 0) return 0;
  const xiOf = (picks, autosubs) => new Set(
    effectivePicks(picks, autosubs, el => getPlayerPoints(el) > 0)
      .filter(p => p.position <= 11)
      .map(p => p.element)
  );
  const lastXI = xiOf(prevPicks, prevAutosubs);
  const curXI = xiOf(curPicks, curAutosubs);
  const removed = [...lastXI].filter(el => !curXI.has(el));
  const added = [...curXI].filter(el => !lastXI.has(el));
  const removedPts = removed.reduce((sum, el) => sum + getPlayerPoints(el), 0);
  const addedPts = added.reduce((sum, el) => sum + getPlayerPoints(el), 0);
  return addedPts - removedPts;
}

// --- Summary builder ---------------------------------------------------------

async function buildGWSummary({ leagueId, gw } = {}) {
  if (!leagueId) throw new Error('leagueId is required');

  // Fetch bootstrap for player data
  const bs = await getCachedApiData(BOOTSTRAP_URL);
  const players = {};
  (bs.elements || []).forEach(p => {
    players[p.id] = {
      webName: p.web_name,
      team: p.team,
      elementType: p.element_type,
      eventPoints: p.event_points || 0,
    };
  });

  const activeEvent = (bs.events || []).find(e => e.is_current);
  // Default to the CURRENT gameweek so numbers match the standings page
  // (event_total), including live automatic substitutions for players who
  // didn't play. Fall back to the last finished GW.
  const targetGW = parseInt(gw) || (activeEvent ? activeEvent.id : 1);

  // Fetch the LIVE endpoint for the target GW to get correct per-player scores
  // (bootstrap event_points only reflects the current GW, not the requested one)
  let livePlayerPoints = {};
  let liveMinutes = {};
  try {
    const liveData = await getCachedApiData(
      `https://fantasy.premierleague.com/api/event/${targetGW}/live/`,
      60 * 1000
    );
    (liveData?.elements || []).forEach(el => {
      livePlayerPoints[el.id] = el.stats?.total_points || 0;
      liveMinutes[el.id] = el.stats?.minutes || 0;
    });
  } catch (e) {
    // Fallback: use bootstrap event_points if live endpoint fails
    logger.warn({ err: e, targetGW }, 'Failed to fetch live data, falling back to bootstrap event_points');
    (bs.elements || []).forEach(p => {
      livePlayerPoints[p.id] = p.event_points || 0;
    });
  }

  // Helper: get correct points for a player in the target GW
  function getPlayerPoints(playerId) {
    return livePlayerPoints[playerId] ?? players[playerId]?.eventPoints ?? 0;
  }
  // "Played" = recorded minutes or scored points (used only by the inference
  // fallback when the picks response omits automatic_subs)
  function hasPlayed(playerId) {
    return (liveMinutes[playerId] ?? -1) > 0 || getPlayerPoints(playerId) > 0;
  }

  // Fetch league standings (all pages)
  let allEntries = [];
  let leagueName = 'League';
  for (let page = 1; page <= 5; page++) {
    try {
      const data = await getCachedApiData(
        `https://fantasy.premierleague.com/api/leagues-classic/${leagueId}/standings/?page_standings=${page}`
      );
      const results = data?.standings?.results || [];
      if (page === 1) {
        leagueName = data?.league?.name || 'League';
      }
      if (results.length === 0) break;
      allEntries = allEntries.concat(results);
      if (results.length < 50) break;
    } catch { break; }
  }

  if (allEntries.length === 0) {
    const err = new Error('No managers found in this league');
    err.status = 404;
    throw err;
  }

  // Fetch history + picks for each manager (in batches to avoid hammering the API)
  const BATCH = 10;
  const managerData = [];

  for (let i = 0; i < allEntries.length; i += BATCH) {
    const batch = allEntries.slice(i, i + BATCH);
    const batchResults = await Promise.all(batch.map(async (entry) => {
      try {
        const prevGWPicks = targetGW > 1
          ? getCachedApiData(`https://fantasy.premierleague.com/api/entry/${entry.entry}/event/${targetGW - 1}/picks/`)
          : Promise.resolve(null);
        const [historyRes, picksRes, transfersRes, prevGWRes] = await Promise.all([
          getCachedApiData(`https://fantasy.premierleague.com/api/entry/${entry.entry}/history/`),
          getCachedApiData(`https://fantasy.premierleague.com/api/entry/${entry.entry}/event/${targetGW}/picks/`),
          getCachedApiData(`https://fantasy.premierleague.com/api/entry/${entry.entry}/transfers/`),
          prevGWPicks,
        ]);

        // Find GW data
        const gwData = (historyRes.current || []).find(c => c.event === targetGW);
        const gwPoints = gwData ? gwData.points : 0;

        // Chips used this GW
        const chipsUsed = (historyRes.chips || []).filter(c => c.event === targetGW).map(c => c.name);

        // Picks analysis
        const picks = picksRes?.picks || [];
        let benchPoints = 0;
        let captainPoints = 0;
        let captainName = '';
        let vcName = '';
        let chipPlayed = chipsUsed.length > 0 ? chipsUsed[0] : null;

        picks.forEach(p => {
          const playerInfo = players[p.element];
          if (!playerInfo) return;
          const pts = getPlayerPoints(p.element);
          if (p.position > 11) {
            benchPoints += pts;
          }
          if (p.is_captain) {
            captainName = playerInfo.webName;
            captainPoints = pts * p.multiplier;
          }
          if (p.is_vice_captain) {
            vcName = playerInfo.webName;
          }
        });

        // --- XI Impact: based on the effective XI AFTER automatic subs ---
        const gwTransfers = (transfersRes || []).filter(t => t.event === targetGW);
        const xiImpact = computeEffectiveXIImpact(
          prevGWRes?.picks || [],
          picks,
          prevGWRes?.automatic_subs,
          picksRes?.automatic_subs,
          getPlayerPoints
        );

        return {
          rank: entry.rank,
          lastRank: entry.last_rank || entry.rank,
          teamName: entry.entry_name,
          managerName: entry.player_name,
          entryId: entry.entry,
          totalPoints: entry.total,
          gwPoints,
          captainName,
          captainPoints,
          vcName,
          benchPoints,
          chipPlayed,
          overallRank: (historyRes?.current || []).find(c => c.event === targetGW)?.overall_rank || historyRes?.current?.[historyRes.current.length - 1]?.overall_rank || null,
          xiImpact,
          transferCount: gwTransfers.length,
        };
      } catch (e) {
        return {
          rank: entry.rank,
          lastRank: entry.last_rank || entry.rank,
          teamName: entry.entry_name,
          managerName: entry.player_name,
          entryId: entry.entry,
          totalPoints: entry.total,
          gwPoints: 0,
          captainName: '',
          captainPoints: 0,
          vcName: '',
          benchPoints: 0,
          chipPlayed: null,
          overallRank: null,
          xiImpact: 0,
          transferCount: 0,
          error: true,
        };
      }
    }));
    managerData.push(...batchResults);
  }

  // Sort by GW points
  const sorted = [...managerData].sort((a, b) => b.gwPoints - a.gwPoints);
  const leagueAvg = sorted.reduce((s, m) => s + m.gwPoints, 0) / sorted.length;

  // Tie-aware top/bottom 4: if tied managers share a position, include all of them
  function getTopNWithTies(arr, n) {
    const result = [];
    let positionsUsed = 0;
    for (let i = 0; i < arr.length && positionsUsed < n; i++) {
      result.push(arr[i]);
      // Count how many managers have the same points as this one
      const nextIdx = i + 1;
      if (nextIdx < arr.length && arr[nextIdx].gwPoints === arr[i].gwPoints) {
        // Same points as next — don't count as new position yet
      } else {
        positionsUsed++;
      }
    }
    return result;
  }
  function getBottomNWithTies(arr, n) {
    const reversed = [...arr].reverse();
    const result = getTopNWithTies(reversed, n);
    return result.reverse();
  }
  const top4 = getTopNWithTies(sorted, 4);
  const bottom4 = getBottomNWithTies(sorted, 4);

  // Highest bench points (EXCLUDE bench boost users)
  const nonBBManagers = sorted.filter(m => m.chipPlayed !== 'bboost');
  const highestBench = [...nonBBManagers].sort((a, b) => b.benchPoints - a.benchPoints)[0];

  // Captain points — list all tied at highest/lowest
  const sortedByCaptain = [...sorted].sort((a, b) => b.captainPoints - a.captainPoints);
  const topCaptainPoints = sortedByCaptain[0].captainPoints;
  const topCaptains = sorted.filter(m => m.captainPoints === topCaptainPoints);
  const bottomCaptainPoints = sortedByCaptain[sortedByCaptain.length - 1].captainPoints;
  const lowestCaptain = sorted.filter(m => m.captainPoints === bottomCaptainPoints);

  // Highest bench — all tied, excluding BB users
  const highestBenchPoints = nonBBManagers.length > 0 ? Math.max(...nonBBManagers.map(m => m.benchPoints)) : 0;
  const highestBenchManagers = nonBBManagers.filter(m => m.benchPoints === highestBenchPoints);

  // Chip users
  const tripleCaptainUsers = sorted.filter(m => m.chipPlayed === '3xc');
  const benchBoostUsers = sorted.filter(m => m.chipPlayed === 'bboost');
  const freeHitUsers = sorted.filter(m => m.chipPlayed === 'freehit');
  const wildcardUsers = sorted.filter(m => m.chipPlayed === 'wildcard');

  // Biggest movers
  const biggestClimbers = [...sorted]
    .filter(m => m.lastRank !== m.rank)
    .sort((a, b) => (b.lastRank - b.rank) - (a.lastRank - a.rank))
    .slice(0, 3);
  const biggestFallers = [...sorted]
    .filter(m => m.lastRank !== m.rank)
    .sort((a, b) => (a.lastRank - a.rank) - (b.lastRank - b.rank))
    .slice(0, 3);

  // Build WhatsApp markdown
  const medals = ['\u{1F3C6}', '\u{1F948}', '\u{1F3C9}', '\u{1F44F}'];
  const sadEmojis = ['\u{1F62D}', '\u{1F622}', '\u{1F615}', '\u{1F615}', '\u{1F615}'];

  let md = '';
  md += `*Top 4 Managers of The Week – GW ${targetGW}*\n\n`;

  const rankEmojis = ['1\uFE0F\u20E3','2\uFE0F\u20E3','3\uFE0F\u20E3','4\uFE0F\u20E3'];

  // Compute display ranks: tied managers get the same rank number
  function getDisplayRanks(list) {
    const ranks = [];
    let lastPts = null;
    let currentRank = 0;
    list.forEach((m) => {
      if (m.gwPoints !== lastPts) {
        currentRank++;
        lastPts = m.gwPoints;
      }
      ranks.push(Math.min(currentRank, 4));
    });
    return ranks;
  }

  const top4Ranks = getDisplayRanks(top4);
  top4.forEach((m, i) => {
    const rankIdx = top4Ranks[i] - 1;
    md += `${rankEmojis[rankIdx]} *${m.teamName}* – ${m.gwPoints} points ${medals[rankIdx]}\n`;
  });
  md += `---\n\n`;

  md += `*Bottom 4 Managers of The Week – GW ${targetGW}*\n\n`;
  // Reverse bottom4 so lowest scorer is #1 (worst)
  const bottom4Sorted = [...bottom4].sort((a, b) => a.gwPoints - b.gwPoints);
  const bottom4Ranks = getDisplayRanks(bottom4Sorted);
  bottom4Sorted.forEach((m, i) => {
    const rankIdx = bottom4Ranks[i] - 1;
    md += `${rankEmojis[rankIdx]} *${m.teamName}* – ${m.gwPoints} points ${sadEmojis[rankIdx]}\n`;
  });
  md += `---\n\n`;

  md += `*Other Notable Stats*\n\n`;

  // Helper: list all tied names — show actual count when >5
  function listManagers(managers) {
    if (managers.length <= 5) {
      return managers.map(m => `*${m.teamName}*`).join(', ');
    }
    return `${managers.length} managers (${managers.slice(0, 5).map(m => `*${m.teamName}*`).join(', ')}...)`;
  }

  md += `\u{1F9E0} *Highest Points on Bench (no BB):* ${listManagers(highestBenchManagers)} – ${highestBenchPoints} points\n`;
  md += `\u{1F52D} *Highest Captain Points:* ${listManagers(topCaptains)} – ${topCaptainPoints} points\n`;
  md += `\u{1F53B} *Lowest Captain Points:* ${listManagers(lowestCaptain)} – ${bottomCaptainPoints} points\n`;
  md += `\u{1F4CA} *League Average:* ${Math.round(leagueAvg)} points\n`;
  md += `---\n\n`;

  // Chip section
  const chipSections = [
    { name: 'Triple Captain', emoji: '\u{1F3AF}', users: tripleCaptainUsers },
    { name: 'Bench Boost', emoji: '\u{1F3AF}', users: benchBoostUsers },
    { name: 'Free Hit', emoji: '\u{1F3AF}', users: freeHitUsers },
    { name: 'Wildcard', emoji: '\u{1F3AF}', users: wildcardUsers },
  ].filter(s => s.users.length > 0);

  if (chipSections.length > 0) {
    md += `*Managers Who Used Chips*\n\n`;
    chipSections.forEach(section => {
      md += `${section.emoji} *${section.name}*\n`;
      section.users.forEach(m => { md += `– *${m.teamName}*\n`; });
      md += `\n`;
    });
  }

  // Biggest movers
  if (biggestClimbers.length > 0 || biggestFallers.length > 0) {
    md += `*Rank Movers*\n`;
    biggestClimbers.forEach(m => {
      const diff = m.lastRank - m.rank;
      md += `\u{2B06}\u{FE0F} *${m.teamName}* – moved up ${diff} spot${diff > 1 ? 's' : ''} (now #${m.rank})\n`;
    });
    biggestFallers.forEach(m => {
      const diff = m.rank - m.lastRank;
      md += `\u{2B07}\u{FE0F} *${m.teamName}* – dropped ${diff} spot${diff > 1 ? 's' : ''} (now #${m.rank})\n`;
    });
    md += `---\n\n`;
  }

  md += `\u{1F389}Congratulations to *${top4[0].teamName}* for topping *GW ${targetGW}* with a massive *${top4[0].gwPoints} points*! \u{1F525}\u{1F3C6}`;

  return {
    leagueId,
    leagueName,
    gw: targetGW,
    totalManagers: sorted.length,
    leagueAvg: Math.round(leagueAvg * 10) / 10,
    top4,
    bottom4,
    highestBenchManagers,
    highestBenchPoints,
    topCaptains,
    topCaptainPoints,
    lowestCaptain,
    bottomCaptainPoints,
    chipSections: chipSections.map(s => ({ name: s.name, users: s.users.map(u => u.teamName) })),
    biggestClimbers,
    biggestFallers,
    markdown: md,
    allManagers: sorted,
  };
}

module.exports = {
  buildGWSummary,
  effectivePicks,
  computeEffectiveXIImpact,
};
