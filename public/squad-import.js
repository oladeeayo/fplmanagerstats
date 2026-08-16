(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    else root.FPLSquadImport = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    function normalize(value) {
        return String(value || '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
    }

    function normalizeUpper(value) {
        return String(value || '').toUpperCase().replace(/[^A-Z ]/g, ' ').replace(/\s+/g, ' ').trim();
    }

    function editDistance(first, second) {
        const a = normalize(first);
        const b = normalize(second);
        const row = Array.from({ length: b.length + 1 }, (_, index) => index);
        for (let i = 1; i <= a.length; i += 1) {
            let previous = row[0];
            row[0] = i;
            for (let j = 1; j <= b.length; j += 1) {
                const current = row[j];
                row[j] = Math.min(row[j] + 1, row[j - 1] + 1, previous + (a[i - 1] === b[j - 1] ? 0 : 1));
                previous = current;
            }
        }
        return row[b.length];
    }

    function scoreLine(line, player) {
        const source = normalize(line);
        const names = [player.name, player.fullName].map(normalize).filter(Boolean);
        let best = 0;
        names.forEach(name => {
            if (source === name) best = Math.max(best, 1);
            if (source.includes(name) || name.includes(source)) best = Math.max(best, Math.min(source.length, name.length) / Math.max(source.length, name.length));
            const distance = editDistance(source, name);
            best = Math.max(best, 1 - distance / Math.max(source.length, name.length, 1));
            const surname = name.split(' ').at(-1);
            if (surname?.length >= 4 && source.includes(surname)) best = Math.max(best, .86);
        });
        return best;
    }

    // FPL-specific patterns
    const FPL_POSITIONS = ['GKP', 'DEF', 'MID', 'FWD'];
    const FPL_HEADER_PATTERNS = ['PICK TEAM', 'PICK YOUR TEAM', 'MY TEAM', 'SQUAD', 'TEAM SELECTION'];
    const FPL_NOISE_PATTERNS = [
        /^(BENCH|SUBSTITUTE|RESERVE)/i,
        /^(CAPTAIN|VICE CAPTAIN|VICE-CAPTAIN)/i,
        /^(POINTS|TOTAL|SCORE|BUDGET|VALUE|COST)/i,
        /^(FORWARD|MIDFIELDER|DEFENDER|GOALKEEPER)/i,
        /^(\d+\s*(pts?|points?))$/i,
        /^(GW\d+|GAMEWEEK\s*\d+)/i,
        /^\d{1,2}\.\d{1,2}$/m, // price patterns like "8.1"
        /^£\d/,
        /^(SUB|AUTOSUB)/i,
        /^(HOME|AWAY)/i,
        /^(NEXT|PREV)/i,
        /^(INFO|DETAILS|STATS)/i,
        /^[A-Z]{1,2}$/, // very short uppercase (likely noise)
        /^\d+$/, // pure numbers
    ];

    function isFPLScreenshot(text) {
        const upper = String(text).toUpperCase();
        return FPL_HEADER_PATTERNS.some(pattern => upper.includes(pattern));
    }

    function extractPrice(text) {
        const match = String(text).match(/[£$]?\s*(\d{1,2}\.\d{1,2})\s*m?/i);
        if (match) {
            const price = parseFloat(match[1]);
            if (price >= 3.0 && price <= 15.0) return price;
        }
        return null;
    }

    function extractPosition(text) {
        const upper = String(text).toUpperCase();
        for (const pos of FPL_POSITIONS) {
            if (upper.includes(pos)) return pos;
        }
        return null;
    }

    function isPlayerName(text) {
        const trimmed = String(text).trim();
        if (trimmed.length < 2 || trimmed.length > 25) return false;
        const upper = trimmed.toUpperCase();
        // Must contain at least one letter
        if (!/[A-Z]/.test(upper)) return false;
        // Skip noise patterns
        if (FPL_NOISE_PATTERNS.some(pattern => pattern.test(trimmed))) return false;
        // Skip if it's just a price
        if (/^[£$]?\s*\d{1,2}\.\d{1,2}/.test(trimmed)) return false;
        // Skip position labels
        if (FPL_POSITIONS.includes(upper)) return false;
        // Skip captain indicators
        if (/^\(C\)|^\(VC\)|^CAPTAIN|^VICE/i.test(upper)) return false;
        return true;
    }

    function extractPlayerCandidates(text) {
        const lines = String(text || '').split(/\r?\n/);
        const candidates = [];

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i].trim();
            if (!line) continue;

            const upper = line.toUpperCase();

            // Check if this line contains a player name
            if (isPlayerName(line)) {
                const price = extractPrice(line);
                const position = extractPosition(line);
                candidates.push({
                    text: line,
                    normalized: normalizeUpper(line),
                    price,
                    position,
                    lineIndex: i,
                    confidence: 0
                });
            }
        }

        return candidates;
    }

    function matchPlayersFPL(text, players, limit = 15) {
        const candidates = extractPlayerCandidates(text);
        const used = new Set();
        const matches = [];

        // Score each candidate against all players
        for (const candidate of candidates) {
            let bestMatch = null;
            let bestScore = 0;

            for (const player of players) {
                if (used.has(player.id)) continue;

                const score = scoreCandidate(candidate, player);
                if (score > bestScore) {
                    bestScore = score;
                    bestMatch = player;
                }
            }

            if (bestMatch && bestScore >= 0.55) {
                used.add(bestMatch.id);

                // Calculate confidence
                const secondBest = players
                    .filter(p => !used.has(p.id) && p.id !== bestMatch.id)
                    .map(p => ({ player: p, score: scoreCandidate(candidate, p) }))
                    .sort((a, b) => b.score - a.score)[0];

                const confidence = bestScore >= 0.9 && (!secondBest || bestScore - secondBest.score >= 0.1)
                    ? 'high'
                    : bestScore >= 0.75
                        ? 'medium'
                        : 'low';

                matches.push({
                    line: candidate.text,
                    playerId: bestMatch.id,
                    confidence,
                    score: Math.round(bestScore * 100),
                    position: candidate.position,
                    price: candidate.price,
                    alternatives: players
                        .map(p => ({ player: p, score: scoreCandidate(candidate, p) }))
                        .sort((a, b) => b.score - a.score)
                        .slice(0, 4)
                        .map(item => ({
                            id: item.player.id,
                            name: item.player.name,
                            team: item.player.team,
                            position: item.player.position,
                            score: Math.round(item.score * 100)
                        }))
                });
            }
        }

        return matches.sort((a, b) => b.score - a.score).slice(0, limit);
    }

    function scoreCandidate(candidate, player) {
        const candidateName = candidate.normalized;
        const playerName = normalizeUpper(player.name);
        const playerFullName = normalizeUpper(player.fullName || '');

        let score = 0;

        // Exact match
        if (candidateName === playerName || candidateName === playerFullName) {
            score = 1.0;
        }
        // Containment
        else if (candidateName.includes(playerName) || playerName.includes(candidateName)) {
            score = Math.min(candidateName.length, playerName.length) / Math.max(candidateName.length, playerName.length);
        }
        // Fuzzy match
        else {
            const distance = editDistance(candidateName, playerName);
            score = 1 - distance / Math.max(candidateName.length, playerName.length, 1);
        }

        // Boost if surname matches (common in FPL)
        const playerSurname = playerName.split(' ').at(-1);
        if (playerSurname && playerSurname.length >= 3 && candidateName.includes(playerSurname)) {
            score = Math.max(score, 0.85);
        }

        // Also check full name
        if (playerFullName) {
            const fullDistance = editDistance(candidateName, playerFullName);
            const fullScore = 1 - fullDistance / Math.max(candidateName.length, playerFullName.length, 1);
            score = Math.max(score, fullScore);
        }

        // Position hint bonus
        if (candidate.position && player.position) {
            if (candidate.position === player.position) {
                score = Math.min(1, score + 0.05);
            }
        }

        // Price hint bonus (price should be close)
        if (candidate.price && player.costValue) {
            const priceDiff = Math.abs(candidate.price - player.costValue);
            if (priceDiff < 0.5) {
                score = Math.min(1, score + 0.03);
            } else if (priceDiff < 1.0) {
                score = Math.min(1, score + 0.01);
            }
        }

        return score;
    }

    function matchPlayers(text, players, limit = 15) {
        // Detect if this is an FPL screenshot
        if (isFPLScreenshot(text)) {
            return matchPlayersFPL(text, players, limit);
        }

        // Fallback to generic matching for non-FPL screenshots
        return matchPlayersGeneric(text, players, limit);
    }

    function matchPlayersGeneric(text, players, limit = 15) {
        const lines = String(text || '').split(/\r?\n/).map(normalize).filter(line => line.length >= 3 && !/^(captain|vice captain|goalkeeper|defender|midfielder|forward|bench|points|team)$/.test(line));
        const used = new Set();
        const matches = [];
        lines.forEach(line => {
            const ranked = players.map(player => ({ player, score: scoreLine(line, player) })).sort((a, b) => b.score - a.score);
            const best = ranked.find(item => !used.has(item.player.id));
            if (!best || best.score < .62) return;
            const second = ranked.find(item => item.player.id !== best.player.id && !used.has(item.player.id));
            const confidence = best.score >= .9 && (!second || best.score - second.score >= .08) ? 'high' : best.score >= .76 ? 'medium' : 'low';
            used.add(best.player.id);
            matches.push({ line: line, playerId: best.player.id, confidence, score: Math.round(best.score * 100), alternatives: ranked.slice(0, 4).map(item => ({ id: item.player.id, name: item.player.name, team: item.player.team, position: item.player.position, score: Math.round(item.score * 100) })) });
        });
        return matches.sort((a, b) => b.score - a.score).slice(0, limit);
    }

    return {
        normalize,
        normalizeUpper,
        scoreLine,
        matchPlayers,
        matchPlayersFPL,
        matchPlayersGeneric,
        isFPLScreenshot,
        extractPrice,
        extractPosition,
        isPlayerName,
        extractPlayerCandidates
    };
}));
