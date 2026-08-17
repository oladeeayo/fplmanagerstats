(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    else root.FPLTeamPreferences = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    // ---- Normalisation helpers ----
    function normalize(value) {
        return String(value || '')
            .toLowerCase()
            .normalize('NFKD')
            .replace(/[\u0300-\u036f]/g, '')
            .replace(/[^a-z0-9 ]/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
    }

    function stripNonAlpha(value) {
        return String(value || '').toUpperCase().replace(/[^A-Z]/g, '');
    }

    function splitClauses(text) {
        return String(text || '')
            .split(/[\n;.?!/]+/)
            .map(clause => clause.replace(/[\u00a0\u2013\u2014]/g, ' ').trim())
            .filter(Boolean);
    }

    // ---- Dictionaries ----
    const POSITION_ALIASES = [
        ['goalkeepers', 'GKP'], ['goalkeeper', 'GKP'], ['keepers', 'GKP'], ['keeper', 'GKP'], ['gk', 'GKP'], ['gkp', 'GKP'],
        ['defenders', 'DEF'], ['defender', 'DEF'], ['defence', 'DEF'], ['defense', 'DEF'], ['defs', 'DEF'], ['def', 'DEF'], ['backs', 'DEF'],
        ['midfielders', 'MID'], ['midfielder', 'MID'], ['midfield', 'MID'], ['mids', 'MID'], ['mid', 'MID'],
        ['forwards', 'FWD'], ['forward', 'FWD'], ['strikers', 'FWD'], ['striker', 'FWD'], ['attackers', 'FWD'], ['attacker', 'FWD'], ['fwds', 'FWD'], ['fwd', 'FWD'],
    ].sort((a, b) => b[0].length - a[0].length);

    const TEAM_ALIASES = [
        ['arsenal', 'ARS'], ['gunners', 'ARS'],
        ['aston villa', 'AVL'], ['villa', 'AVL'],
        ['bournemouth', 'BOU'], ['cherries', 'BOU'],
        ['brentford', 'BRE'], ['bees', 'BRE'],
        ['brighton and hove albion', 'BHA'], ['brighton', 'BHA'], ['seagulls', 'BHA'],
        ['chelsea', 'CHE'], ['blues', 'CHE'],
        ['crystal palace', 'CRY'], ['palace', 'CRY'], ['eagles', 'CRY'],
        ['everton', 'EVE'], ['toffees', 'EVE'],
        ['fulham', 'FUL'], ['cottagers', 'FUL'],
        ['ipswich', 'IPS'], ['tractor boys', 'IPS'],
        ['leicester city', 'LEI'], ['leicester', 'LEI'], ['foxes', 'LEI'],
        ['liverpool', 'LIV'], ['reds', 'LIV'],
        ['manchester city', 'MCI'], ['man city', 'MCI'], ['city', 'MCI'], ['citizens', 'MCI'],
        ['manchester united', 'MUN'], ['man united', 'MUN'], ['man utd', 'MUN'], ['manchester u', 'MUN'], ['united', 'MUN'], ['red devils', 'MUN'],
        ['newcastle united', 'NEW'], ['newcastle', 'NEW'], ['toon', 'NEW'], ['magpies', 'NEW'],
        ["nott'm forest", 'NFO'], ['nottingham forest', 'NFO'], ['forest', 'NFO'],
        ['southampton', 'SOU'], ['saints', 'SOU'],
        ['tottenham hotspur', 'TOT'], ['tottenham', 'TOT'], ['spurs', 'TOT'],
        ['west ham united', 'WHU'], ['west ham', 'WHU'], ['hammers', 'WHU'],
        ['wolverhampton', 'WOL'], ['wolves', 'WOL'], ['wanderers', 'WOL'],
    ].sort((a, b) => b[0].length - a[0].length);

    const NEGATIVES = ['no', 'not', 'avoid', 'without', 'don\'t', 'dont', 'do not', 'exclude', 'minus', 'drop', 'never', 'keep out', 'stay away', 'steer clear'];
    const POSITIVES = ['want', 'must', 'need', 'include', 'have', 'add', 'start', 'pick', 'keep', 'definitely', 'please', 'get', 'with', 'and', 'plus', 'prefer', 'like'];

    const COUNT_WORDS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, 'a couple of': 2, 'a few': 2, both: 2 };

    const NUMBER_TOKEN = /(\d+(?:\.\d+)?)/;

    // ---- Formations ----
    const VALID_FORMATIONS = [
        [3, 4, 3], [3, 5, 2], [4, 3, 3], [4, 4, 2], [4, 5, 1], [5, 3, 2], [5, 4, 1],
    ];

    function parseFormation(text) {
        const dash = String(text).replace(/[^0-9-]/g, '').match(/^(\d)-(\d)-(\d)$/);
        if (dash) {
            const f = [Number(dash[1]), Number(dash[2]), Number(dash[3])];
            return VALID_FORMATIONS.some(s => s[0] === f[0] && s[1] === f[1] && s[2] === f[2]) ? f : null;
        }
        const compact = String(text).replace(/[^0-9]/g, '').match(/^(\d)(\d)(\d)$/);
        if (compact) {
            const f = [Number(compact[1]), Number(compact[2]), Number(compact[3])];
            return VALID_FORMATIONS.some(s => s[0] === f[0] && s[1] === f[1] && s[2] === f[2]) ? f : null;
        }
        return null;
    }

    // ---- Team code lookup ----
    function teamCodeFromName(name, knownTeams) {
        const normalized = normalize(name);
        if (!normalized) return null;
        for (const [alias, code] of TEAM_ALIASES) {
            if (normalized.includes(alias) || alias.includes(normalized)) return code;
        }
        if (/^[a-z]{3}$/.test(normalized)) {
            const upper = normalized.toUpperCase();
            if (knownTeams && knownTeams.some(t => stripNonAlpha(t.code) === upper)) return upper;
            if (/^(ars|avl|bou|bre|bha|che|cry|eve|ful|ips|lei|l iv|liv|mci|mun|new|nfo|sou|tot|whu|wol)$/.test(normalized)) return upper;
        }
        if (knownTeams) {
            const hit = knownTeams.find(t => normalize(t.name) === normalized || normalize(t.code).toLowerCase() === normalized);
            if (hit) return hit.code;
        }
        return null;
    }

    function buildNameMatchers(players) {
        const matchers = [];
        (players || []).forEach(player => {
            const keys = new Set();
            keys.add(normalize(player.name || ''));
            keys.add(normalize(player.web_name || ''));
            if (player.first_name) keys.add(normalize(`${player.first_name} ${player.second_name || ''}`));
            keys.delete('');
            keys.forEach(key => matchers.push({ key, player }));
        });
        matchers.sort((a, b) => b.key.length - a.key.length);
        return matchers;
    }

    function isNegativeContext(clauseLower, index) {
        const before = clauseLower.slice(Math.max(0, index - 40), index);
        const words = before.split(/[^a-z']+/).filter(Boolean).slice(-3).join(' ');
        return NEGATIVES.some(neg => before.includes(neg) && words.includes(neg.split(' ')[0]));
    }

    function isPositiveContext(clauseLower, index) {
        const before = clauseLower.slice(Math.max(0, index - 60), index);
        return POSITIVES.some(pos => before.includes(pos));
    }

    // ---- Main parser ----
    function parseTeamPreferences(text, context = {}) {
        const players = context.players || [];
        const knownTeams = context.teams || [];
        const constraints = {
            mustInclude: [],      // player ids the user explicitly wants
            mustExclude: [],      // player ids the user explicitly rejects
            teamIncludeMin: {},   // { ARS: 2 }
            teamIncludeMax: {},   // { LIV: 1 }
            teamExclude: [],      // [CHE, ...]
            priceMax: {},         // { MID: 8.5 } position-level cap
            priceMin: {},         // { FWD: 10 } position-level floor
            playerPriceMax: {},   // { playerId: 12.5 }
            playerPriceMin: {},   // { playerId: 9.0 }
            formation: null,      // [3,4,3]
            budget: null,         // 100
            captainId: null,
            avoidInjured: false,
        };
        const understood = [];
        const unclear = [];

        const nameMatchers = buildNameMatchers(players);
        const playerById = new Map((players || []).map(p => [p.id, p]));

        const clauses = splitClauses(text);
        clauses.forEach(clause => {
            const original = clause;
            const clauseLower = clause.toLowerCase();
            let matched = false;
            let cursor = clause;

            const markUnderstood = (label) => {
                matched = true;
                understood.push(label);
            };

            // 1) Formation
            const formation = parseFormation(clause);
            if (formation) {
                constraints.formation = formation;
                markUnderstood(`Formation ${formation.join('-')}`);
                cursor = cursor.replace(/[0-9-]{3,7}/g, ' ').replace(/\s+/g, ' ').trim();
            } else if (/(five|5) at the back/i.test(clause) || /(five|5)-at-the-back/i.test(clause)) {
                constraints.formation = [5, 4, 1];
                markUnderstood('Five at the back (5-4-1)');
                cursor = cursor.replace(/(five|5) at the back/gi, ' ').replace(/\s+/g, ' ').trim();
            } else if (/(three|3) at the back/i.test(clause)) {
                constraints.formation = [3, 5, 2];
                markUnderstood('Three at the back (3-5-2)');
                cursor = cursor.replace(/(three|3) at the back/gi, ' ').replace(/\s+/g, ' ').trim();
            } else if (/(four|4) at the back/i.test(clause)) {
                constraints.formation = [4, 4, 2];
                markUnderstood('Four at the back (4-4-2)');
                cursor = cursor.replace(/(four|4) at the back/gi, ' ').replace(/\s+/g, ' ').trim();
            }

            // 2) Player names (must include / exclude / captain)
            const seen = new Set();
            for (const matcher of nameMatchers) {
                if (seen.has(matcher.player.id)) continue;
                if (!matcher.key || matcher.key.length < 3) continue;
                const idx = cursor.toLowerCase().indexOf(matcher.key);
                if (idx < 0) continue;
                const neg = isNegativeContext(cursor.toLowerCase(), idx);
                const isCaptain = /captain/i.test(cursor.slice(Math.max(0, idx - 30), idx + matcher.key.length + 30));
                if (neg) {
                    if (!constraints.mustExclude.includes(matcher.player.id)) constraints.mustExclude.push(matcher.player.id);
                    markUnderstood(`Exclude ${matcher.player.name}`);
                } else {
                    if (!constraints.mustInclude.includes(matcher.player.id)) constraints.mustInclude.push(matcher.player.id);
                    markUnderstood(`Include ${matcher.player.name}`);
                }
                if (isCaptain) {
                    constraints.captainId = matcher.player.id;
                    markUnderstood(`Captain ${matcher.player.name}`);
                }
                seen.add(matcher.player.id);
                cursor = cursor.replace(new RegExp(escapeRegExp(matcher.key), 'gi'), ' ');
            }
            cursor = cursor.replace(/\s+/g, ' ').trim();

            // 3) Team mentions
            for (const [alias, code] of TEAM_ALIASES) {
                const idx = cursor.toLowerCase().indexOf(alias);
                if (idx < 0) continue;
                const neg = isNegativeContext(cursor.toLowerCase(), idx);
                const before = cursor.toLowerCase().slice(Math.max(0, idx - 60), idx);
                const countMatch = before.match(/(\d+|one|two|three|four|five|six|seven|eight|nine|ten|a couple of|a few|both)\s*(players?|people)?\s*(from|of)?\s*$/);
                const atLeast = /(at least|minimum|min|no fewer|at minimum)/i.test(before);
                const atMost = /(at most|maximum|max|no more|up to|only)/i.test(before);
                if (countMatch && !neg) {
                    const raw = countMatch[1];
                    const count = COUNT_WORDS[raw] || Number(raw);
                    if (atLeast || !atMost) {
                        constraints.teamIncludeMin[code] = Math.max(constraints.teamIncludeMin[code] || 0, count);
                        markUnderstood(`At least ${count} player${count > 1 ? 's' : ''} from ${code}`);
                    } else {
                        constraints.teamIncludeMax[code] = Math.min(count, constraints.teamIncludeMax[code] != null ? constraints.teamIncludeMax[code] : count);
                        markUnderstood(`At most ${count} player${count > 1 ? 's' : ''} from ${code}`);
                    }
                } else if (neg) {
                    if (!constraints.teamExclude.includes(code)) constraints.teamExclude.push(code);
                    markUnderstood(`No players from ${code}`);
                } else {
                    markUnderstood(`Players from ${code}`);
                }
                cursor = cursor.replace(new RegExp(escapeRegExp(alias), 'gi'), ' ');
            }
            cursor = cursor.replace(/\s+/g, ' ').trim();

            // 4) Budget
            const budgetMatch = cursor.match(/(?:budget|spend|use|have|keep|only)\s+(?:£|\$)?\s*(\d{2,3}(?:\.\d)?)\s*(?:m|million|mio)?/i)
                || cursor.match(/(?:£|\$)\s*(\d{2,3}(?:\.\d)?)\s*(?:m|million|mio)?\s*(?:budget|to spend|available)/i);
            if (budgetMatch) {
                const value = Number(budgetMatch[1]);
                if (value >= 50 && value <= 120) {
                    constraints.budget = value;
                    markUnderstood(`Budget £${value}m`);
                    cursor = cursor.replace(budgetMatch[0], ' ');
                }
            }
            const bankMatch = cursor.match(/keep\s+(?:£|\$)?\s*(\d{1,2}(?:\.\d)?)\s*(?:m|million)?\s*in\s*(?:the\s*)?bank/i);
            if (bankMatch) {
                constraints.budget = Math.round((100 - Number(bankMatch[1])) * 10) / 10;
                markUnderstood(`Keep £${bankMatch[1]}m in the bank (budget £${constraints.budget}m)`);
                cursor = cursor.replace(bankMatch[0], ' ');
            }
            cursor = cursor.replace(/\s+/g, ' ').trim();

            // 5) Position-scoped prices
            for (const [alias, position] of POSITION_ALIASES) {
                const idx = cursor.toLowerCase().indexOf(alias);
                if (idx < 0) continue;
                const after = cursor.toLowerCase().slice(idx + alias.length, idx + alias.length + 60);
                const numberMatch = after.match(/(under|below|less than|max|maximum|up to|at most|cheaper than)\s*(?:£|\$)?\s*(\d+(?:\.\d)?)/);
                const overMatch = after.match(/(over|above|more than|at least|minimum|min)\s*(?:£|\$)?\s*(\d+(?:\.\d)?)/);
                const rangeMatch = after.match(/between\s*(?:£|\$)?\s*(\d+(?:\.\d)?)\s*(?:and|to|-)\s*(?:£|\$)?\s*(\d+(?:\.\d)?)/);
                if (numberMatch) {
                    constraints.priceMax[position] = Math.min(constraints.priceMax[position] != null ? constraints.priceMax[position] : Number(numberMatch[2]), Number(numberMatch[2]));
                    markUnderstood(`${alias} under £${numberMatch[2]}m`);
                    cursor = cursor.replace(new RegExp(escapeRegExp(alias), 'i'), ' ');
                    cursor = cursor.replace(numberMatch[0], ' ');
                } else if (overMatch) {
                    constraints.priceMin[position] = Math.max(constraints.priceMin[position] != null ? constraints.priceMin[position] : Number(overMatch[2]), Number(overMatch[2]));
                    markUnderstood(`${alias} over £${overMatch[2]}m`);
                    cursor = cursor.replace(new RegExp(escapeRegExp(alias), 'i'), ' ');
                    cursor = cursor.replace(overMatch[0], ' ');
                } else if (rangeMatch) {
                    constraints.priceMin[position] = Math.max(constraints.priceMin[position] != null ? constraints.priceMin[position] : Number(rangeMatch[1]), Number(rangeMatch[1]));
                    constraints.priceMax[position] = Math.min(constraints.priceMax[position] != null ? constraints.priceMax[position] : Number(rangeMatch[2]), Number(rangeMatch[2]));
                    markUnderstood(`${alias} between £${rangeMatch[1]}m and £${rangeMatch[2]}m`);
                    cursor = cursor.replace(new RegExp(escapeRegExp(alias), 'i'), ' ');
                    cursor = cursor.replace(rangeMatch[0], ' ');
                }
            }
            cursor = cursor.replace(/\s+/g, ' ').trim();

            // 6) Player-scoped prices (e.g. "Salah under 12")
            for (const matcher of nameMatchers) {
                if (seen.has(matcher.player.id)) continue;
                if (!matcher.key || matcher.key.length < 3) continue;
                const idx = cursor.toLowerCase().indexOf(matcher.key);
                if (idx < 0) continue;
                const after = cursor.toLowerCase().slice(idx + matcher.key.length, idx + matcher.key.length + 40);
                const numberMatch = after.match(/(under|below|less than|max|maximum|up to|at most)\s*(?:£|\$)?\s*(\d+(?:\.\d)?)/);
                const overMatch = after.match(/(over|above|more than|at least)\s*(?:£|\$)?\s*(\d+(?:\.\d)?)/);
                if (numberMatch) {
                    constraints.playerPriceMax[matcher.player.id] = Number(numberMatch[2]);
                    markUnderstood(`${matcher.player.name} under £${numberMatch[2]}m`);
                    seen.add(matcher.player.id);
                    cursor = cursor.replace(new RegExp(escapeRegExp(matcher.key), 'gi'), ' ');
                    cursor = cursor.replace(numberMatch[0], ' ');
                } else if (overMatch) {
                    constraints.playerPriceMin[matcher.player.id] = Number(overMatch[2]);
                    markUnderstood(`${matcher.player.name} over £${overMatch[2]}m`);
                    seen.add(matcher.player.id);
                    cursor = cursor.replace(new RegExp(escapeRegExp(matcher.key), 'gi'), ' ');
                    cursor = cursor.replace(overMatch[0], ' ');
                }
            }
            cursor = cursor.replace(/\s+/g, ' ').trim();

            // 7) Captain without a name in this clause ("make Haaland captain" already handled above)
            const captainMatch = cursor.match(/captain\s+(.+)/i);
            if (captainMatch && !constraints.captainId) {
                const rest = normalize(captainMatch[1]);
                const hit = nameMatchers.find(m => rest.includes(m.key) || m.key.includes(rest));
                if (hit) {
                    constraints.captainId = hit.player.id;
                    markUnderstood(`Captain ${hit.player.name}`);
                    cursor = cursor.replace(captainMatch[0], ' ');
                }
            }

            // 8) Avoid injured / doubts
            if (/(no|avoid|skip|don't want|dont want|stay away)\s+(injured|injury|doubts?|unavailable|red|suspended)/i.test(cursor)) {
                constraints.avoidInjured = true;
                markUnderstood('Avoid injured / unavailable players');
                cursor = cursor.replace(/(no|avoid|skip|don't want|dont want|stay away)\s+(injured|injury|doubts?|unavailable|red|suspended)/gi, ' ');
            }
            cursor = cursor.replace(/\s+/g, ' ').trim();

            // 9) Whatever meaningful text remains is unclear
            const leftovers = cursor.replace(/\b(and|also|please|team|squad|players?|want|need|must|build|make|let's|lets|i|i'd|id like|would|like|to|for|with|of|my|the|a|an)\b/g, ' ').replace(/\s+/g, ' ').trim();
            if (leftovers && !/^[£$&,.\- ]*$/.test(leftovers)) {
                unclear.push(leftovers.length > 120 ? leftovers.slice(0, 120) + '…' : leftovers);
            }

            if (!matched) {
                // Whole clause was ambiguous
                if (!unclear.includes(original)) unclear.push(original.length > 120 ? original.slice(0, 120) + '…' : original);
            }
        });

        // Cleanup: a player cannot be both include and exclude
        constraints.mustInclude = constraints.mustInclude.filter(id => !constraints.mustExclude.includes(id));
        constraints.teamExclude = [...new Set(constraints.teamExclude)];
        constraints.mustInclude = [...new Set(constraints.mustInclude)];
        constraints.mustExclude = [...new Set(constraints.mustExclude)];

        return {
            constraints,
            understood: [...new Set(understood)],
            unclear: [...new Set(unclear)],
            playerById,
        };
    }

    function escapeRegExp(value) {
        return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }

    return {
        normalize,
        splitClauses,
        parseTeamPreferences,
        parseFormation,
        teamCodeFromName,
        VALID_FORMATIONS,
        POSITION_ALIASES,
        TEAM_ALIASES,
    };
}));
