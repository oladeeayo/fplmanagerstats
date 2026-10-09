// Shared filters for FPL availability news (bootstrap `elements[].news`).

// Club-departure announcements the FPL API stores under status 'u' (Unavailable).
// They are permanent/loan transfers, not gameweek availability updates.
const TRANSFER_NEWS_RE = /\b(joined|departed|transferred|signed|released|free agent|on loan|contract)\b|\breturned to [A-Z]/i;

function isTransferNews(news) {
  return TRANSFER_NEWS_RE.test((news || '').trim());
}

module.exports = { isTransferNews, TRANSFER_NEWS_RE };
