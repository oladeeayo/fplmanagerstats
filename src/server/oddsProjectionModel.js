// src/server/oddsProjectionModel.js
// Converts betting odds (1X2 + Over/Under) into expected goals and player projections
// Uses The Odds API free tier: https://the-odds-api.com

const https = require('https');

const ODDS_API_KEY = process.env.ODDS_API_KEY || '';
const ODDS_API_BASE = 'https://api.the-odds-api.com/v4';

// --- Fetch upcoming EPL odds from The Odds API ---
async function fetchEplOdds() {
  if (!ODDS_API_KEY) {
    console.log('No ODDS_API_KEY set, skipping odds fetch');
    return [];
  }

  const url = `${ODDS_API_BASE}/sports/soccer_epl/odds?regions=eu&markets=h2h,totals&oddsFormat=decimal&apiKey=${ODDS_API_KEY}`;

  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        try {
          const odds = JSON.parse(data);
          resolve(odds);
        } catch (e) {
          reject(e);
        }
      });
    }).on('error', reject);
  });
}

// --- Convert decimal odds to implied probability (removing overround) ---
function oddsToImpliedProbability(decimalOdds) {
  return 1 / decimalOdds;
}

// --- Remove overround from bookmaker odds to get "true" probabilities ---
function removeOverround(outcomes) {
  const implied = outcomes.map(o => ({
    name: o.name,
    prob: oddsToImpliedProbability(o.price),
  }));
  const totalImplied = implied.reduce((s, o) => s + o.prob, 0);
  // Normalize to sum to 1.0
  return implied.map(o => ({
    name: o.name,
    trueProb: o.prob / totalImplied,
  }));
}

// --- Derive expected goals from Over/Under 2.5 odds ---
// Using Poisson: P(total >= 3) = 1 - P(0) - P(1) - P(2)
// Given P(total >= 2.5) = p, solve for lambda (total expected goals)
function expectedGoalsFromOverUnder(overUnder25) {
  const overOutcome = overUnder25.find(o => o.name === 'Over' && o.point === 2.5);
  const underOutcome = overUnder25.find(o => o.name === 'Under' && o.point === 2.5);

  if (!overOutcome || !underOutcome) return null;

  const overProb = oddsToImpliedProbability(overOutcome.price);
  const underProb = oddsToImpliedProbability(underOutcome.price);
  const totalImplied = overProb + underProb;
  const trueOverProb = overProb / totalImplied;

  // P(total > 2.5) = P(total >= 3) using Poisson
  // P(X=0) = e^-λ, P(X=1) = λ*e^-λ, P(X=2) = λ²*e^-λ/2
  // P(X<=2) = e^-λ(1 + λ + λ²/2)
  // P(X>=3) = 1 - P(X<=2)
  // We need to find λ such that P(X>=3) ≈ trueOverProb

  // Binary search for lambda
  let lo = 0.5, hi = 5.0;
  for (let i = 0; i < 50; i++) {
    const mid = (lo + hi) / 2;
    const expNegLambda = Math.exp(-mid);
    const pLeq2 = expNegLambda * (1 + mid + mid * mid / 2);
    const pGeq3 = 1 - pLeq2;
    if (pGeq3 < trueOverProb) {
      lo = mid;
    } else {
      hi = mid;
    }
  }
  return (lo + hi) / 2;
}

// --- Derive home/away goal split from 1X2 odds ---
// Given P(home win), P(draw), P(away win), estimate home and away expected goals
function goalSplitFrom1X2(homeProb, drawProb, awayProb, totalGoals) {
  // Use the relationship between match outcomes and goal distributions
  // P(home win) = sum over x>y of P(x,y)
  // This is complex, so we use a calibrated approximation:
  //
  // From historical PL data:
  // - Home teams score ~57% of goals at home
  // - Draw probability peaks at λ_home ≈ 1.1, λ_away ≈ 1.1
  //
  // We solve for home/away split given total goals and outcome probs

  // If totalGoals is known, estimate home goals using 1X2 probs
  // A strong home win prob means home team scores more

  // Calibrated approximation from PL data:
  // homeShare ranges from 0.45 (away favorite) to 0.65 (home favorite)
  const homeFavFactor = homeProb - awayProb; // positive = home favorite
  const homeShare = 0.555 + homeFavFactor * 0.15; // range ~0.45 to ~0.65

  const homeGoals = totalGoals * Math.max(0.35, Math.min(0.70, homeShare));
  const awayGoals = totalGoals - homeGoals;

  return {
    homeGoals: Math.round(homeGoals * 100) / 100,
    awayGoals: Math.round(awayGoals * 100) / 100,
  };
}

// --- Compute clean sheet probability from Poisson ---
function cleanSheetProb(opponentGoals) {
  // P(clean sheet) = P(opponent scores 0) = e^-λ
  return Math.round(Math.exp(-opponentGoals) * 100);
}

// --- Parse odds from The Odds API format into our structure ---
function parseOddsForFixture(match) {
  // Find h2h and totals markets
  let h2hMarket = null;
  let totalsMarket = null;

  for (const bookmaker of match.bookmakers || []) {
    for (const market of bookmaker.markets || []) {
      if (market.key === 'h2h' && !h2hMarket) h2hMarket = market;
      if (market.key === 'totals' && !totalsMarket) totalsMarket = market;
    }
  }

  if (!h2hMarket) return null;

  // Parse 1X2
  const h2hOutcomes = h2hMarket.outcomes || [];
  const homeOutcome = h2hOutcomes.find(o => o.name === match.home_team);
  const awayOutcome = h2hOutcomes.find(o => o.name === match.away_team);
  const drawOutcome = h2hOutcomes.find(o => o.name === 'Draw');

  if (!homeOutcome || !awayOutcome || !drawOutcome) return null;

  const homeProb = oddsToImpliedProbability(homeOutcome.price);
  const drawProb = oddsToImpliedProbability(drawOutcome.price);
  const awayProb = oddsToImpliedProbability(awayOutcome.price);
  const totalImplied = homeProb + drawProb + awayProb;

  // Remove overround
  const trueHome = homeProb / totalImplied;
  const trueDraw = drawProb / totalImplied;
  const trueAway = awayProb / totalImplied;

  // Parse Over/Under
  let totalGoals = 2.7; // default PL average
  if (totalsMarket) {
    const derived = expectedGoalsFromOverUnder(totalsMarket.outcomes || []);
    if (derived) totalGoals = derived;
  }

  // Derive home/away goal split
  const split = goalSplitFrom1X2(trueHome, trueDraw, trueAway, totalGoals);

  return {
    homeTeam: match.home_team,
    awayTeam: match.away_team,
    kickoff: match.commence_time,
    odds: {
      home: homeOutcome.price,
      draw: drawOutcome.price,
      away: awayOutcome.price,
    },
    probabilities: {
      homeWin: Math.round(trueHome * 1000) / 10,
      draw: Math.round(trueDraw * 1000) / 10,
      awayWin: Math.round(trueAway * 1000) / 10,
    },
    totalGoals: Math.round(totalGoals * 100) / 100,
    homeGoals: split.homeGoals,
    awayGoals: split.awayGoals,
    homeCS: cleanSheetProb(split.awayGoals),
    awayCS: cleanSheetProb(split.homeGoals),
  };
}

// --- Map team names from odds to FPL short names ---
const TEAM_NAME_MAP = {
  'Arsenal': 'ARS', 'Aston Villa': 'AVL', 'Bournemouth': 'BOU',
  'Brentford': 'BRE', 'Brighton': 'BHA', 'Chelsea': 'CHE',
  'Coventry City': 'COV', 'Crystal Palace': 'CRY', 'Everton': 'EVE',
  'Fulham': 'FUL', 'Hull City': 'HUL', 'Ipswich Town': 'IPS',
  'Leeds United': 'LEE', 'Liverpool': 'LIV', 'Man City': 'MCI',
  'Manchester City': 'MCI', 'Man Utd': 'MUN', 'Manchester United': 'MUN',
  'Newcastle': 'NEW', 'Newcastle United': 'NEW',
  'Nottm Forest': 'NFO', "Nott'ham Forest": 'NFO', 'Nottingham Forest': 'NFO',
  'Spurs': 'TOT', 'Tottenham': 'TOT', 'Tottenham Hotspur': 'TOT',
  'Sunderland': 'SUN',
  // Lower case fallbacks
  'west ham': 'WHU', 'wolves': 'WOL', 'wolverhampton': 'WOL',
};

function mapTeamName(oddsName) {
  if (!oddsName) return '???';
  // Direct match
  if (TEAM_NAME_MAP[oddsName]) return TEAM_NAME_MAP[oddsName];
  // Case-insensitive
  const lower = oddsName.toLowerCase();
  for (const [key, val] of Object.entries(TEAM_NAME_MAP)) {
    if (key.toLowerCase() === lower) return val;
  }
  // Fuzzy: check if any known name is contained
  for (const [key, val] of Object.entries(TEAM_NAME_MAP)) {
    if (lower.includes(key.toLowerCase()) || key.toLowerCase().includes(lower)) return val;
  }
  return oddsName.substring(0, 3).toUpperCase();
}

// --- Main: fetch odds and convert to match projections ---
async function getOddsBasedProjections(fixtures, teams) {
  let oddsData = [];
  try {
    oddsData = await fetchEplOdds();
  } catch (e) {
    console.error('Failed to fetch odds:', e.message);
    return null;
  }

  if (!oddsData || oddsData.length === 0) {
    console.log('No odds data available');
    return null;
  }

  // Parse odds for each fixture
  const oddsProjections = {};
  for (const match of oddsData) {
    const parsed = parseOddsForFixture(match);
    if (!parsed) continue;

    const homeShort = mapTeamName(parsed.homeTeam);
    const awayShort = mapTeamName(parsed.awayTeam);

    // Find matching fixture by team names
    const fixture = fixtures.find(f => {
      const ht = teams.find(t => t.id === f.team_h);
      const at = teams.find(t => t.id === f.team_a);
      if (!ht || !at) return false;
      return (ht.short_name === homeShort && at.short_name === awayShort) ||
             (ht.name.toLowerCase() === parsed.homeTeam.toLowerCase());
    });

    if (fixture) {
      oddsProjections[fixture.id] = parsed;
    }
  }

  return oddsProjections;
}

// --- Build player projections using odds-derived team xG ---
function distributeGoalsToPlayers(players, teamGoals, teamStrength) {
  if (!players || players.length === 0 || teamGoals <= 0) return [];

  // Sort players by expected goal involvement (xG + xA)
  const sorted = players
    .filter(p => (p.minutes || 0) > 0)
    .map(p => {
      const matches = Math.max(1, (p.minutes || 0) / 90);
      const xGperMatch = (parseFloat(p.expected_goals) || 0) / matches;
      const xAperMatch = (parseFloat(p.expected_assists) || 0) / matches;
      const bonusPerMatch = (parseFloat(p.bonus_points) || 0) / matches;
      const pos = ['GKP', 'DEF', 'MID', 'FWD'][p.element_type - 1] || 'MID';
      // Position weight: FWD most likely to score, then MID, then DEF
      const posWeight = { GKP: 0.01, DEF: 0.08, MID: 0.35, FWD: 0.56 }[pos];
      return { ...p, xGperMatch, xAperMatch, bonusPerMatch, pos, posWeight };
    })
    .sort((a, b) => (b.xGperMatch + b.xAperMatch) - (a.xGperMatch + a.xAperMatch));

  // Distribute team goals based on player xG rates
  const totalXG = sorted.reduce((s, p) => s + p.xGperMatch * p.posWeight, 0);

  return sorted.map(p => {
    const share = totalXG > 0 ? (p.xGperMatch * p.posWeight) / totalXG : 0;
    const playerGoals = teamGoals * share;
    const playerAssists = teamGoals * share * 0.6; // assists ~60% of goals in PL
    const minutesMod = Math.min(1, (p.chance_of_playing_next_round || 100) / 100);

    const FPL_PTS = { GKP: 10, DEF: 6, MID: 5, FWD: 4 };
    const goalPts = playerGoals * (FPL_PTS[p.pos] || 5);
    const assistPts = playerAssists * 3;
    const minsPts = minutesMod >= 0.8 ? 2 : minutesMod >= 0.4 ? 1 : 0;
    const bonusPts = p.bonusPerMatch * minutesMod;
    const totalPts = goalPts + assistPts + minsPts + bonusPts;

    return {
      id: p.id,
      name: p.web_name,
      team: p.team_short || '???',
      teamId: p.team,
      position: p.pos,
      price: (p.now_cost || 50) / 10,
      projectedGoals: Math.round(playerGoals * 1000) / 1000,
      projectedAssists: Math.round(playerAssists * 1000) / 1000,
      goals: Math.round(playerGoals * 1000) / 1000,
      assists: Math.round(playerAssists * 1000) / 1000,
      csProb: 0,
      bonus: Math.round(bonusPts * 100) / 100,
      totalPoints: Math.round(totalPts * 100) / 100,
    };
  });
}

module.exports = {
  fetchEplOdds,
  oddsToImpliedProbability,
  removeOverround,
  expectedGoalsFromOverUnder,
  goalSplitFrom1X2,
  cleanSheetProb,
  parseOddsForFixture,
  mapTeamName,
  getOddsBasedProjections,
  distributeGoalsToPlayers,
  TEAM_NAME_MAP,
};
