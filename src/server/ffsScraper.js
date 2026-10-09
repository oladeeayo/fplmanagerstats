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

  // Team select maps FFS codes ("ars") to club names — used to derive short codes
  const codeByLabel = {};
  const select = root.querySelector('#ffs-team-news-team-select');
  if (select) {
    for (const opt of select.querySelectorAll('option')) {
      const value = (opt.getAttribute('value') || '').trim();
      if (value && value !== 'all') codeByLabel[opt.textContent.trim()] = value;
    }
  }

  // Each club block: DIV.story-wrap (badge + h2) followed by sibling
  // next-match / scout-picks / out-doubts-banned-latest-news blocks
  for (const h2 of root.querySelectorAll('h2')) {
    const teamName = h2.textContent.replace(/\s+/g, ' ').trim();
    if (!teamName || teamName.length > 30) continue;

    const header = h2.parentNode;
    const card = header && header.parentNode;
    if (!card || !String(card.getAttribute('class') || '').includes('story-wrap')) continue;

    const parentKids = card.parentNode.childNodes || [];
    const cardIndex = parentKids.indexOf(card);
    const blocks = [];
    for (let i = cardIndex + 1; i < parentKids.length && blocks.length < 6; i++) {
      const node = parentKids[i];
      if (!node || !node.tagName) continue;
      if (String(node.getAttribute('class') || '').includes('story-wrap')) break;
      blocks.push(node);
    }

    let nextMatch = '';
    let latestNews = '';
    const out = [];
    const doubts = [];
    const banned = [];
    const predictedXI = [];

    for (const block of blocks) {
      const cls = String(block.getAttribute('class') || '');

      if (cls.includes('next-match')) {
        nextMatch = block.textContent.replace(/\s+/g, ' ').trim();
        continue;
      }

      if (cls.includes('scout-picks')) {
        for (const li of block.querySelectorAll('li')) {
          const title = li.getAttribute('title');
          if (title) predictedXI.push(title.replace(/\s*\([^)]*\)\s*/g, '').trim());
        }
        continue;
      }

      // Out / Doubts / Banned / Latest News lists
      for (const strong of block.querySelectorAll('strong')) {
        const label = strong.textContent.replace(/[:\s]+$/g, '').trim().toLowerCase();
        if (label === 'latest news') {
          const p = strong.parentNode;
          const text = (p ? p.textContent : '').replace(/^latest news:\s*/i, '');
          if (text.length > latestNews.length) latestNews = text.replace(/\s+/g, ' ').trim();
          continue;
        }
        if (label !== 'out' && label !== 'doubts' && label !== 'banned') continue;

        const listKids = strong.parentNode.childNodes || [];
        const strongIndex = listKids.indexOf(strong);
        let ul = null;
        for (let i = strongIndex + 1; i < listKids.length; i++) {
          if (listKids[i] && listKids[i].tagName === 'UL') { ul = listKids[i]; break; }
        }
        if (!ul) continue;

        for (const li of ul.childNodes) {
          if (!li || li.tagName !== 'LI') continue;
          if (String(li.getAttribute('class') || '').includes('headers')) continue;
          // Structural list items (e.g. nested "Latest News") hold no player names
          if (li.querySelector('strong') || li.querySelector('ul')) continue;
          const pct = li.querySelector('.doubt-percent');
          const pctText = pct ? pct.textContent.trim() : '';
          const name = li.textContent.replace(pctText, '').replace(/\s+/g, ' ').trim();
          if (!name) continue;
          if (label === 'out') out.push(name);
          else if (label === 'doubts') doubts.push(pctText ? `${name} (${pctText})` : name);
          else banned.push(name);
        }
      }
    }

    if (!nextMatch && !latestNews && !out.length && !doubts.length && !banned.length && !predictedXI.length) continue;

    const ffsCode = codeByLabel[teamName];
    const teamCode = ffsCode && FFS_TEAM_CODE_MAP[ffsCode] ? FFS_TEAM_CODE_MAP[ffsCode] : null;

    results.push({
      team: teamName,
      teamCode,
      predictedXI,
      out,
      doubts,
      banned,
      nextMatch,
      latestNews,
    });
  }

  teamNewsCache = results;
  teamNewsCacheTime = Date.now();
  return results;
}

// PL Predicted Lineups scraper
const PL_NEWS_URL = 'https://www.premierleague.com/en/news';
let plLineupsCache = null;
let plLineupsCacheTime = 0;
const PL_CACHE_TTL = 30 * 60 * 1000; // 30 minutes

async function scrapePLPredictedLineups() {
  if (plLineupsCache && Date.now() - plLineupsCacheTime < PL_CACHE_TTL) return plLineupsCache;

  try {
    // Step 1: Find the latest predicted lineups article
    const newsResp = await axios.get(PL_NEWS_URL, {
      timeout: 15000,
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
    });
    const newsRoot = parse(newsResp.data);

    // Find link to predicted lineups article
    const links = newsRoot.querySelectorAll('a[href]');
    let articleUrl = null;
    for (const link of links) {
      const href = link.getAttribute('href') || '';
      const text = link.textContent.toLowerCase();
      if ((text.includes('predicted') && text.includes('line')) || href.includes('predicted-line')) {
        articleUrl = href.startsWith('http') ? href : `https://www.premierleague.com${href}`;
        break;
      }
    }

    if (!articleUrl) {
      plLineupsCache = [];
      plLineupsCacheTime = Date.now();
      return [];
    }

    // Step 2: Fetch the article
    const articleResp = await axios.get(articleUrl, {
      timeout: 15000,
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
    });
    const articleRoot = parse(articleResp.data);

    // Step 3: Extract team news from article sections
    const results = [];
    const headings = articleRoot.querySelectorAll('h3, h4');

    for (const h of headings) {
      const text = h.textContent.trim();
      // Match patterns like "Arsenal v Coventry predicted line-ups" or "Crystal Palace predicted line-ups"
      const match = text.match(/^(.+?)(?:\s+v\s+|\s+predicted)/i);
      if (!match) continue;

      const teamName = match[1].trim();
      if (teamName.length > 30 || teamName.length < 3) continue;

      // Get the content after this heading
      let content = '';
      let nextEl = h.nextElementSibling;
      while (nextEl && !['H3', 'H4'].includes(nextEl.tagName)) {
        content += nextEl.textContent + '\n';
        nextEl = nextEl.nextElementSibling;
      }

      // Extract key info
      const news = content.replace(/\s+/g, ' ').trim();
      if (news.length < 20) continue;

      // Extract manager quotes
      const quoteMatch = news.match(/"[^"]{20,}"/g);
      const managerQuote = quoteMatch ? quoteMatch[0] : null;

      // Extract injury info
      const outMatch = news.match(/(?:out|ruled out|unavailable|missing)[^.!?]*[.!?]/gi);
      const injuryNews = outMatch ? outMatch[0] : null;

      results.push({
        team: teamName,
        news: news.substring(0, 500),
        managerQuote,
        injuryNews,
        source: articleUrl,
      });
    }

    plLineupsCache = results;
    plLineupsCacheTime = Date.now();
    return results;
  } catch (err) {
    console.error('PL lineups scrape error:', err.message);
    return plLineupsCache || [];
  }
}

module.exports = { scrapeFFSInjuries, scrapeFFSTeamNews, scrapePLPredictedLineups };
