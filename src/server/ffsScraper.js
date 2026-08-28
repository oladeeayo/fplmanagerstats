const axios = require('axios');
const { parse } = require('node-html-parser');

const FFS_URL = 'https://www.fantasyfootballscout.co.uk/fantasy-football-injuries/';
const FFS_TEAM_NEWS_URL = 'https://www.fantasyfootballscout.co.uk/team-news/';

let cache = null;
let cacheTime = 0;
const CACHE_TTL = 10 * 60 * 1000; // 10 minutes

let teamNewsCache = null;
let teamNewsCacheTime = 0;

const FFS_TEAM_CODE_MAP = {
  'ars': 'ARS', 'avl': 'AVL', 'bou': 'BOU', 'bre': 'BRE', 'bha': 'BHA',
  'che': 'CHE', 'cov': 'COV', 'cry': 'CRY', 'eve': 'EVE', 'ful': 'FUL',
  'hul': 'HUL', 'ips': 'IPS', 'lee': 'LEE', 'liv': 'LIV', 'mci': 'MCI',
  'mun': 'MUN', 'new': 'NEW', 'nfo': 'NFO', 'sun': 'SUN', 'tot': 'TOT',
};

async function scrapeFFSInjuries() {
  if (cache && Date.now() - cacheTime < CACHE_TTL) return cache;

  const resp = await axios.get(FFS_URL, {
    timeout: 15000,
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
  });

  const root = parse(resp.data);
  const rows = root.querySelectorAll('tr[data-team-code]');
  const results = [];

  for (const row of rows) {
    const tds = row.querySelectorAll('td');
    if (tds.length < 6) continue;

    const teamCode = (FFS_TEAM_CODE_MAP[row.getAttribute('data-team-code')] || '').toUpperCase();
    if (!teamCode) continue;

    // TD0: Player name (may have first name in parentheses)
    const nameSpan = tds[0].querySelector('.align-middle');
    let playerName = nameSpan ? nameSpan.textContent.replace(/\s+/g, ' ').trim() : tds[0].textContent.replace(/\s+/g, ' ').trim();
    // Clean: "Bruno Guimarães" or "Saliba (William)" -> "Saliba"
    playerName = playerName.replace(/\s*\([^)]*\)\s*/g, '').trim();
    // Extract last name for matching: "Bruno Guimarães" -> "Guimaraes"
    const nameParts = playerName.split(/\s+/);
    const lastName = nameParts.length > 1 ? nameParts[nameParts.length - 1] : playerName;

    // TD2: Status
    const statusSpan = tds[2].querySelector('.status');
    let status = statusSpan ? statusSpan.getAttribute('title') || statusSpan.textContent.trim() : tds[2].textContent.trim();

    // TD3: Return date
    const returnDate = tds[3].textContent.trim();

    // TD4: News with manager quotes
    const newsTD = tds[4];
    const injuryType = newsTD.querySelector('strong');
    const injury = injuryType ? injuryType.textContent.trim() : '';

    // Get full news text
    const fullNews = newsTD.textContent.replace(/\[Source\]/g, '').replace(/\s+/g, ' ').trim();

    // Extract source URL
    const sourceLink = newsTD.querySelector('a[href]');
    const sourceUrl = sourceLink ? sourceLink.getAttribute('href') : null;

    // Extract manager quote patterns
    const quotePatterns = [
      /(?:his|the|their)\s+manager\s+(?:said|revealed|confirmed|stated|explained|updated|claimed|admitted|insisted|believed|hoped|felt|mentioned|noted|added)[^.!?]*[.!?]/gi,
      /(?:he|she)\s+(?:said|revealed|confirmed|stated|explained|updated|claimed|admitted|insisted)[^.!?]*[.!?]/gi,
      /"[^"]{20,}"/g,
    ];

    let managerQuote = null;
    for (const pattern of quotePatterns) {
      const match = fullNews.match(pattern);
      if (match) {
        managerQuote = match[0].trim();
        break;
      }
    }

    // TD5: Last updated
    const lastUpdated = tds[5].textContent.trim();

    results.push({
      player: playerName,
      lastName,
      teamCode,
      status,
      injury,
      returnDate,
      news: fullNews,
      managerQuote,
      sourceUrl,
      lastUpdated,
    });
  }

  cache = results;
  cacheTime = Date.now();
  return results;
}

async function scrapeFFSTeamNews() {
  if (teamNewsCache && Date.now() - teamNewsCacheTime < CACHE_TTL) return teamNewsCache;

  const resp = await axios.get(FFS_TEAM_NEWS_URL, {
    timeout: 15000,
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
  });

  const root = parse(resp.data);
  const results = [];

  // Find all team sections
  const teamSections = root.querySelectorAll('h2');
  for (const h2 of teamSections) {
    const teamName = h2.textContent.trim();
    if (!teamName || teamName.length > 30) continue;

    // Get the parent container for this team
    let container = h2.parentElement;
    if (!container) continue;

    // Find predicted XI (player names in the lineup)
    const playerImages = container.querySelectorAll('img[alt]');
    const predictedXI = [];
    for (const img of playerImages) {
      const alt = img.getAttribute('alt') || '';
      if (alt && !alt.includes('badge') && !alt.includes('avatar') && alt.length > 3) {
        predictedXI.push(alt);
      }
    }

    // Find injury info (Out, Doubts, Banned sections)
    const out = [];
    const doubts = [];
    const banned = [];
    const lists = container.querySelectorAll('ul');
    for (const ul of lists) {
      const items = ul.querySelectorAll('li');
      for (const li of items) {
        const text = li.textContent.trim();
        if (!text) continue;
        // Check parent heading
        const prev = ul.previousElementSibling;
        const heading = prev ? prev.textContent.toLowerCase() : '';
        if (heading.includes('out')) out.push(text);
        else if (heading.includes('doubt')) doubts.push(text);
        else if (heading.includes('banned')) banned.push(text);
      }
    }

    // Find latest news text
    const paragraphs = container.querySelectorAll('p');
    let latestNews = '';
    for (const p of paragraphs) {
      const text = p.textContent.trim();
      if (text.length > 50 && text.includes('.')) {
        latestNews = text;
        break;
      }
    }

    if (predictedXI.length > 0 || out.length > 0 || doubts.length > 0 || latestNews) {
      results.push({
        team: teamName,
        predictedXI,
        out,
        doubts,
        banned,
        latestNews,
      });
    }
  }

  teamNewsCache = results;
  teamNewsCacheTime = Date.now();
  return results;
}

module.exports = { scrapeFFSInjuries, scrapeFFSTeamNews };
