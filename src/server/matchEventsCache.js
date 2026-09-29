/**
 * Match Events Cache
 *
 * Background-polls the free worldcup26.ir football API during live PL matches
 * (no API key required).
 * - Scoreboard for today's date: fixtures, scores, goals and bookings with
 *   real match minutes
 * - Play-by-play (important events): assist credits for live matches
 * - Live matches: polls every 60s, caches for 60s
 * - No live matches: stops polling entirely
 *
 * Clients read from cache — no direct API calls per request.
 */

const logger = require('./logger');

const API_BASE = 'https://worldcup26.ir/get/soccer';
const LEAGUE = 'eng.1';

let cachedData = { matches: [], fetchedAt: 0 };
let lastFetchTime = 0;
let pollInterval = null;
let isPolling = false;

const LIVE_POLL_MS = 60_000; // Poll every 60s during live matches
const LIVE_CACHE_MS = 60_000; // Serve cache up to 60s old
const FETCH_TIMEOUT_MS = 15_000;
const MAX_PLAY_PAGES = 3;

async function fetchJson(url) {
  const resp = await fetch(url, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status} for ${url}`);
  return resp.json();
}

/** "45'+2'" → { minute: 45, injuryTime: 2 } */
function parseClock(display) {
  const m = /(\d+)'\s*(?:\+\s*(\d+))?/.exec(String(display || ''));
  if (!m) return { minute: null, injuryTime: 0 };
  return { minute: Number(m[1]), injuryTime: m[2] ? Number(m[2]) : 0 };
}

function utcDateKey(date) {
  return date.toISOString().slice(0, 10).replace(/-/g, '');
}

function sideOf(teamId, homeId, awayId) {
  if (teamId == null) return null;
  const id = String(teamId);
  if (homeId != null && id === String(homeId)) return 'home';
  if (awayId != null && id === String(awayId)) return 'away';
  return null;
}

function normalizeEvent(ev) {
  const comp = ev?.competitions?.[0];
  if (!comp) return null;

  const status = comp.status || ev.status || {};
  const state = status.type?.state;
  const map = { in: 'IN_PLAY', post: 'FINISHED', pre: 'TIMED' };
  const matchStatus = map[state] || 'TIMED';

  const competitors = comp.competitors || [];
  const home = competitors.find(c => c.homeAway === 'home');
  const away = competitors.find(c => c.homeAway === 'away');
  if (!home || !away) return null;

  const homeId = home.team?.id;
  const awayId = away.team?.id;
  const teamRef = (teamId, teamObj) => ({
    id: teamId == null ? 0 : Number(teamId),
    name: teamObj?.displayName || teamObj?.name || '',
    tla: teamObj?.abbreviation || '',
  });
  const teamName = (teamId) =>
    String(teamId) === String(homeId)
      ? (home.team?.displayName || home.team?.name || '')
      : (away.team?.displayName || away.team?.name || '');

  const clock = parseClock(status.displayClock);
  const goals = [];
  const bookings = [];
  const substitutions = [];

  for (const d of comp.details || []) {
    const text = String(d.type?.text || '');
    const side = sideOf(d.team?.id, homeId, awayId);
    if (!side) continue;
    const { minute, injuryTime } = parseClock(d.clock?.displayValue);
    if (minute == null) continue;

    const athlete = d.athletesInvolved?.[0];
    const base = { minute, injuryTime, side };

    if (/^Goal/i.test(text)) {
      if (d.ownGoal) continue; // FPL awards no points for own goals
      goals.push({
        ...base,
        type: text,
        penalty: !!d.penaltyKick,
        scorer: athlete ? { id: Number(athlete.id) || 0, name: athlete.displayName || '' } : null,
        assist: null,
        team: { id: Number(d.team?.id) || 0, name: teamName(d.team?.id) },
      });
    } else if (/Yellow/i.test(text)) {
      bookings.push({
        ...base,
        card: 'YELLOW',
        player: athlete ? { id: Number(athlete.id) || 0, name: athlete.displayName || '' } : null,
        team: { id: Number(d.team?.id) || 0, name: teamName(d.team?.id) },
      });
    } else if (/Red/i.test(text)) {
      bookings.push({
        ...base,
        card: 'RED',
        player: athlete ? { id: Number(athlete.id) || 0, name: athlete.displayName || '' } : null,
        team: { id: Number(d.team?.id) || 0, name: teamName(d.team?.id) },
      });
    } else if (/Substitution/i.test(text)) {
      substitutions.push({ ...base, text });
    }
  }

  return {
    id: Number(ev.id) || 0,
    utcDate: ev.date || comp.date || null,
    status: matchStatus,
    minute: clock.minute,
    displayClock: status.displayClock || '',
    homeTeam: teamRef(homeId, home.team),
    awayTeam: teamRef(awayId, away.team),
    score: {
      fullTime: {
        home: home.score == null ? null : Number(home.score),
        away: away.score == null ? null : Number(away.score),
      },
    },
    goals,
    bookings,
    substitutions,
  };
}

function parseAssist(text) {
  const marker = 'Assisted by ';
  const i = text.indexOf(marker);
  if (i < 0) return null;
  const rest = text.slice(i + marker.length);

  let end = rest.length;
  const stopWord = /\s+(?:with|following|from|after|to)\b/.exec(rest);
  if (stopWord && stopWord.index > 0) end = stopWord.index;

  // Cut at the first sentence period, ignoring initials such as "N."
  for (let j = 0; j < end; j++) {
    if (rest[j] !== '.') continue;
    const prev = rest[j - 1] || '';
    const prev2 = rest[j - 2] || '';
    const isInitial = /[A-Za-z]/.test(prev) && (j < 2 || /[\s(']/.test(prev2));
    if (!isInitial) { end = j; break; }
  }

  return rest.slice(0, end).trim().replace(/[,;]+$/, '') || null;
}

function parseScorer(text) {
  const m = /^[^.]*\.\s*([^()]+?)\s*\(/.exec(text) || /^Goal!\s*[^.]*?\.\s*([^()]+?)\s*\(/.exec(text);
  return m ? m[1].trim() : null;
}

async function fetchGoalPlays(eventId) {
  const items = [];
  for (let page = 1; page <= MAX_PLAY_PAGES; page++) {
    const data = await fetchJson(
      `${API_BASE}/${LEAGUE}/events/${eventId}/plays?important=true&limit=100&page=${page}`
    );
    items.push(...(data.items || []));
    if (page >= (data.pageCount || 1)) break;
  }
  return items
    .filter(p => p.scoringPlay && p.text)
    .map(p => ({
      minute: parseClock(p.clock?.displayValue).minute,
      scorer: parseScorer(p.text),
      assist: parseAssist(p.text),
    }));
}

async function attachAssists(match) {
  if (!match.goals.some(g => !g.assist)) return;

  try {
    const plays = await fetchGoalPlays(match.id);
    for (const goal of match.goals) {
      if (goal.assist || !goal.scorer?.name) continue;
      const play =
        plays.find(p => p.scorer && p.minute === goal.minute && p.scorer === goal.scorer.name) ||
        plays.find(p => p.scorer === goal.scorer.name) ||
        null;
      if (play?.assist) goal.assist = { id: 0, name: play.assist };
    }
  } catch (err) {
    logger.debug({ err: err.message, eventId: match.id }, 'assist enrichment skipped');
  }
}

async function fetchTodayMatches() {
  const url = `${API_BASE}/${LEAGUE}/scoreboard?dates=${utcDateKey(new Date())}`;
  const data = await fetchJson(url);
  const matches = (data.events || []).map(normalizeEvent).filter(Boolean);
  logger.info({ matchCount: matches.length }, 'worldcup26.ir scoreboard received');
  return matches;
}

async function poll() {
  if (isPolling) return;
  isPolling = true;

  try {
    const matches = await fetchTodayMatches();
    const live = matches.filter(m => m.status === 'IN_PLAY');
    if (live.length) {
      await Promise.all(live.map(attachAssists));
    }

    cachedData = { matches, fetchedAt: Date.now() };
    lastFetchTime = cachedData.fetchedAt;
    logger.debug({ matchCount: matches.length, live: live.length }, 'Match events cache updated');
  } catch (err) {
    logger.error({ err: err.message }, 'worldcup26.ir fetch error');
  } finally {
    isPolling = false;
  }
}

function hasLiveMatches() {
  return cachedData.matches.some(m => m.status === 'IN_PLAY');
}

function startPolling() {
  if (pollInterval) return;

  logger.info('Starting match events background poller');
  pollInterval = setInterval(() => {
    if (hasLiveMatches()) {
      poll(); // Live match — poll every 60s
    } else {
      // No live matches — stop polling, clear cache
      stopPolling();
      cachedData = { matches: [], fetchedAt: 0 };
      lastFetchTime = 0;
    }
  }, LIVE_POLL_MS);
}

function stopPolling() {
  if (pollInterval) {
    clearInterval(pollInterval);
    pollInterval = null;
    logger.info('Stopped match events background poller');
  }
}

/**
 * Get cached match events.
 * Returns immediately from cache — never blocks on API calls.
 */
function getMatchEvents() {
  const age = Date.now() - lastFetchTime;

  if (age > LIVE_CACHE_MS || lastFetchTime === 0) {
    // Cache is stale — trigger a background fetch (don't await)
    startPolling();
    poll().catch(() => {});
  }

  return cachedData;
}

module.exports = {
  getMatchEvents,
  startPolling,
  stopPolling,
  _internals: { parseClock, parseAssist, parseScorer, normalizeEvent, attachAssists },
};
