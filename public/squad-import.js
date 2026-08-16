(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    else root.FPLSquadImport = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    function normalize(value) {
        return String(value || '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
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

    function matchPlayers(text, players, limit = 15) {
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
            matches.push({ line, playerId: best.player.id, confidence, score: Math.round(best.score * 100), alternatives: ranked.slice(0, 4).map(item => ({ id: item.player.id, name: item.player.name, team: item.player.team, position: item.player.position, score: Math.round(item.score * 100) })) });
        });
        return matches.sort((a, b) => b.score - a.score).slice(0, limit);
    }

    return { normalize, scoreLine, matchPlayers };
}));
