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

    function stripSpaces(value) {
        return String(value || '').toUpperCase().replace(/[^A-Z]/g, '');
    }

    function tokenize(value) {
        return String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, ' ').replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
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
    const FPL_TEAM_CODES = ['ARS', 'AVL', 'BOU', 'BRE', 'BHA', 'CHE', 'CRY', 'EVE', 'FUL', 'IPS', 'LEI', 'LIV', 'MCI', 'MUN', 'NEW', 'NFO', 'SOU', 'TOT', 'WHU', 'WOL', 'LEE', 'SHU', 'BUR', 'WAT', 'NOR', 'CAR', 'BIR', 'LDN'];
    const FPL_HEADER_PATTERNS = ['PICK TEAM', 'PICK YOUR TEAM', 'MY TEAM', 'SQUAD', 'TEAM SELECTION'];
    const FPL_NOISE_PATTERNS = [
        /^(BENCH|SUBSTITUTE|RESERVE)/i,
        /^(CAPTAIN|VICE CAPTAIN|VICE-CAPTAIN)/i,
        /^(POINTS|TOTAL|SCORE|BUDGET|VALUE|COST)/i,
        /^(FORWARD|MIDFIELDER|DEFENDER|GOALKEEPER)/i,
        /^(\d+\s*(pts?|points?))$/i,
        /^(GW\d+|GAMEWEEK\s*\d+)/i,
        /^\d{1,2}\.\d{1,2}$/m,
        /^£\d/,
        /^(SUB|AUTOSUB)/i,
        /^(HOME|AWAY)/i,
        /^(NEXT|PREV)/i,
        /^(INFO|DETAILS|STATS)/i,
        /^[A-Z]{1,2}$/,
        /^\d+$/,
        /^(PICK|SELECT|CHOOSE)/i,
        /^(AND|THE|FOR|WITH)/i,
        /^(EDIT|SAVE|LOAD|BACK|NEXT)/i,
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

    function stripCaptainMarkers(value) {
        return String(value || '')
            .replace(/\s*[\(\[]\s*[CVCV]{1,2}\s*[\)\]]\s*$/i, '')
            .replace(/\s*\([^)]*\)\s*$/i, '')
            .trim();
    }

    function isPlayerName(text) {
        const trimmed = stripCaptainMarkers(text).trim();
        if (trimmed.length < 2 || trimmed.length > 30) return false;
        const upper = trimmed.toUpperCase();
        if (!/[A-Z]/.test(upper)) return false;
        if (FPL_NOISE_PATTERNS.some(pattern => pattern.test(trimmed))) return false;
        if (/^[£$]?\s*\d{1,2}\.\d{1,2}/.test(trimmed)) return false;
        if (FPL_POSITIONS.includes(upper)) return false;
        if (/^\(C\)|^\(VC\)|^CAPTAIN|^VICE/i.test(upper)) return false;
        return true;
    }

    function extractTeamCode(text) {
        const tokens = String(text || '').toUpperCase().replace(/[^A-Z ]/g, ' ').replace(/\s+/g, ' ').trim().split(' ');
        const hit = tokens.find(token => FPL_TEAM_CODES.includes(token));
        return hit || null;
    }

    function scanNearby(lines, index, extractor) {
        for (let offset = 1; offset <= 3; offset++) {
            const below = extractor(lines[index + offset]);
            if (below) return below;
            const above = extractor(lines[index - offset]);
            if (above) return above;
        }
        return null;
    }

    function extractPlayerCandidates(text) {
        const lines = String(text || '').split(/\r?\n/);
        const candidates = [];

        for (let i = 0; i < lines.length; i++) {
            const rawLine = lines[i].trim();
            if (!rawLine) continue;

            // Pull the name portion out of "NAME £X.Xm POS", "NAME (C)", "CAPTAIN NAME", etc.
            const cleaned = stripCaptainMarkers(rawLine)
                .replace(/^(CAPTAIN|VICE\s*CAPTAIN|VICE-CAPTAIN|\(?C\)?|\(?VC\)?)[\s\-:.]*/i, '')
                .replace(/^[£$]\s*\d{1,2}\.\d{1,2}\s*/i, '')
                .replace(/\s*[£$]\s*\d{1,2}\.\d{1,2}m?\s*$/i, '')
                .replace(/\s+(GKP|DEF|MID|FWD)\s*$/i, '')
                .replace(/\s+£\s*\d{1,2}\.\d{1,2}m?\s*$/i, '')
                .replace(/\s*\d{1,2}\.\d{1,2}\s*$/i, '')
                .replace(/\s{2,}/g, ' ')
                .trim();

            // Stay permissive: keep anything that still looks like a name token.
            if (cleaned.length < 2 || !/[A-Za-z]/.test(cleaned)) continue;
            const upper = cleaned.toUpperCase();
            if (FPL_POSITIONS.includes(upper)) continue;
            if (/^[A-Z]{1,2}$/.test(upper)) continue;
            if (/^\d+$/.test(upper)) continue;
            if (/^(BENCH|SUBSTITUTE|RESERVE|CAPTAIN|VICE|POINTS|TOTAL|SCORE|BUDGET|VALUE|COST|FORWARD|MIDFIELDER|DEFENDER|GOALKEEPER|GAMEWEEK|HOME|AWAY|NEXT|PREV|INFO|DETAILS|STATS|PICK|SELECT|CHOOSE|AND|THE|FOR|WITH|EDIT|SAVE|LOAD|BACK|TEAM|SQUAD|MY TEAM|PICK TEAM|PICK YOUR TEAM|TEAM SELECTION|FIRST XI|STARTING XI)$/i.test(upper)) continue;

            const price = extractPrice(rawLine) || scanNearby(lines, i, extractPrice);
            const position = extractPosition(rawLine) || scanNearby(lines, i, extractPosition);
            const team = extractTeamCode(rawLine) || scanNearby(lines, i, extractTeamCode);

            candidates.push({
                text: cleaned,
                normalized: normalizeUpper(cleaned),
                stripped: stripSpaces(cleaned),
                tokens: tokenize(cleaned),
                price,
                position,
                team,
                lineIndex: i,
                confidence: 0
            });
        }

        return candidates;
    }

    function scoreCandidate(candidate, player) {
        const candidateName = candidate.normalized;
        const candidateStripped = candidate.stripped;
        const playerName = normalizeUpper(player.name);
        const playerStripped = stripSpaces(player.name);
        const playerFullName = normalizeUpper(player.fullName || '');
        const playerFullStripped = stripSpaces(player.fullName || '');

        let score = 0;

        // Exact match (with or without spaces)
        if (candidateName === playerName || candidateStripped === playerStripped) {
            score = 1.0;
        } else if (candidateName === playerFullName || candidateStripped === playerFullStripped) {
            score = 1.0;
        } else {
            // Containment
            if (candidateStripped.includes(playerStripped) || playerStripped.includes(candidateStripped)) {
                score = Math.max(score, Math.min(candidateStripped.length, playerStripped.length) / Math.max(candidateStripped.length, playerStripped.length));
            }
            if (candidateName.includes(playerName) || playerName.includes(candidateName)) {
                score = Math.max(score, Math.min(candidateName.length, playerName.length) / Math.max(candidateName.length, playerName.length));
            }
            // Fuzzy match on spaceless string (handles OCR splitting names)
            const distance = editDistance(candidateStripped, playerStripped);
            score = Math.max(score, 1 - distance / Math.max(candidateStripped.length, playerStripped.length, 1));
            if (playerFullStripped) {
                const fullDist = editDistance(candidateStripped, playerFullStripped);
                score = Math.max(score, 1 - fullDist / Math.max(candidateStripped.length, playerFullStripped.length, 1));
            }

            // Token overlap: a garbled or partial line still wins if its words line up
            // with the player's web name or full name ("TRENT" + "ALEXANDER-ARNOLD").
            const candidateTokens = (candidate.tokens || []).filter(t => t.length >= 3);
            const playerTokens = [...new Set([...tokenize(player.name), ...tokenize(player.fullName || '')].filter(t => t.length >= 3))];
            if (candidateTokens.length && playerTokens.length) {
                let covered = 0;
                let totalSim = 0;
                candidateTokens.forEach(ct => {
                    const bestTokenSim = playerTokens.reduce((best, pt) => {
                        const sim = 1 - editDistance(ct, pt) / Math.max(ct.length, pt.length, 1);
                        return Math.max(best, sim);
                    }, 0);
                    totalSim += bestTokenSim;
                    if (bestTokenSim >= 0.6) covered++;
                });
                if (covered > 0) {
                    score = Math.max(score, 0.5 * (covered / candidateTokens.length) + 0.4 * (totalSim / candidateTokens.length));
                }
            }
        }

        // Surname match boost
        const playerSurname = playerName.split(' ').at(-1);
        if (playerSurname && playerSurname.length >= 3) {
            const surnameStripped = stripSpaces(playerSurname);
            if (candidateStripped.includes(surnameStripped) || candidateName.includes(playerSurname)) {
                score = Math.max(score, 0.88);
            }
        }

        // First name match boost
        const playerFirstName = playerName.split(' ')[0];
        if (playerFirstName && playerFirstName.length >= 3) {
            if (candidateStripped.startsWith(stripSpaces(playerFirstName)) || candidateName.startsWith(playerFirstName)) {
                score = Math.max(score, 0.82);
            }
        }

        // Position hint
        if (candidate.position && player.position) {
            if (candidate.position === player.position) score = Math.min(1, score + 0.06);
            else score = Math.max(0, score - 0.05);
        }

        // Team hint
        if (candidate.team && player.team) {
            if (candidate.team === player.team) score = Math.min(1, score + 0.15);
            else score = Math.max(0, score - 0.05);
        }

        // Price hint — prices are small integers on FPL screenshots and very reliable.
        if (candidate.price && player.costValue) {
            const priceDiff = Math.abs(candidate.price - player.costValue);
            if (priceDiff < 0.05) score = Math.min(1, score + 0.18);
            else if (priceDiff < 0.5) score = Math.min(1, score + 0.10);
            else if (priceDiff < 1.0) score = Math.min(1, score + 0.04);
            else score = Math.max(0, score - 0.03);
        }

        return Math.max(0, Math.min(1, score));
    }

    function matchPlayersFPL(text, players, limit = 15) {
        const candidates = extractPlayerCandidates(text);
        const used = new Set();
        const matches = [];

        const rankFor = (line) => players
            .map(player => ({ player, score: scoreCandidate(line, player) }))
            .sort((a, b) => b.score - a.score);

        // Phase 1: resolve OCR-split names by merging a weak line with its neighbour.
        const consumed = new Set();
        const resolved = [];
        for (let i = 0; i < candidates.length; i++) {
            if (consumed.has(i)) continue;
            const candidate = candidates[i];
            let line = candidate;
            const top = rankFor(candidate)[0];
            let bestScore = top ? top.score : 0;

            if (bestScore < 0.60) {
                const next = candidates[i + 1];
                if (next && !consumed.has(i + 1)) {
                    const mergedText = `${candidate.text} ${next.text}`.trim();
                    const mergedLine = {
                        ...candidate,
                        text: mergedText,
                        normalized: normalizeUpper(mergedText),
                        stripped: stripSpaces(mergedText),
                        tokens: tokenize(mergedText)
                    };
                    const mergedTop = rankFor(mergedLine)[0];
                    if (mergedTop && mergedTop.score > bestScore + 0.02) {
                        bestScore = mergedTop.score;
                        line = mergedLine;
                        consumed.add(i + 1);
                    }
                }
            }
            resolved.push({ line, bestScore });
        }

        // Phase 2: greedy fill — strongest lines first, best unused player each time,
        // then fill the rest with low-confidence guesses so a full 15-man squad is
        // produced even from imperfect OCR.
        resolved.sort((a, b) => b.bestScore - a.bestScore);
        for (const entry of resolved) {
            const ranked = rankFor(entry.line);
            const best = ranked.find(item => !used.has(item.player.id));
            if (!best || best.score < 0.45) continue;

            used.add(best.player.id);

            const secondBest = ranked.find(item => !used.has(item.player.id) && item.player.id !== best.player.id);
            const confidence = best.score >= 0.92 && (!secondBest || best.score - secondBest.score >= 0.12)
                ? 'high'
                : best.score >= 0.72
                    ? 'medium'
                    : 'low';

            matches.push({
                line: entry.line.text,
                playerId: best.player.id,
                confidence,
                score: Math.round(best.score * 100),
                position: entry.line.position,
                price: entry.line.price,
                alternatives: ranked.slice(0, 4).map(item => ({
                    id: item.player.id,
                    name: item.player.name,
                    team: item.player.team,
                    position: item.player.position,
                    score: Math.round(item.score * 100)
                }))
            });
        }

        return matches.sort((a, b) => b.score - a.score).slice(0, limit);
    }

    function matchPlayers(text, players, limit = 15) {
        if (isFPLScreenshot(text)) {
            return matchPlayersFPL(text, players, limit);
        }
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
        stripSpaces,
        tokenize,
        stripCaptainMarkers,
        scoreLine,
        matchPlayers,
        matchPlayersFPL,
        matchPlayersGeneric,
        isFPLScreenshot,
        extractPrice,
        extractPosition,
        extractTeamCode,
        isPlayerName,
        extractPlayerCandidates
    };
}));
