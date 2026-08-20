const axios = require('axios');
const { parse } = require('node-html-parser');

const FFS_URL = 'https://www.fantasyfootballscout.co.uk/fantasy-football-injuries/';

let cache = null;
let cacheTime = 0;
const CACHE_TTL = 10 * 60 * 1000; // 10 minutes

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

module.exports = { scrapeFFSInjuries };
