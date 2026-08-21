const express = require('express');
const { buildCaptaincyModel, buildPlayerProjections } = require('../../captaincyModel');
const { buildSquadAdvice } = require('../../decisionModel');
const { DETAILED_POSITIONS, ZONE_MAP, ZONE_LABELS, ATTACKING_ZONES, DEFENSIVE_ZONES, MIDFIELD_ZONES, ALL_ZONES } = require('../../playerPositions');
const { sql } = require('../db');
const { getCachedApiData, BOOTSTRAP_URL, FIXTURES_URL, BOOTSTRAP_CACHE_TTL, redis } = require('../cache');
const { POSITION_MAP, parsePositiveId, stripCodeFences } = require('../helpers');
const { heavyEndpointLimiter } = require('../middleware');
const logger = require('../logger');
const { generateWithGeminiFallback, GEMINI_PREFERENCE_MODELS } = require('./fpl');
const understat = require('../understat');
const { projectMultiGW, computeRollingFDR, computeRollingForm, mergeProfiles, projectMatch, computeMatchXG, aggregateProbs, scoreMatrix } = require('../goalProjectionModel');
const playerProj = require('../playerProjectionModel');
const oddsModel = require('../oddsProjectionModel');
const teamStrengthData = require('../teamStrengthData');

const router = express.Router();

// ---- Health Check ----
router.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: Date.now() });
});

// ---- Manager Lookup (validate ID and return team info) ----
router.get('/manager-lookup/:id', async (req, res) => {
  const id = parsePositiveId(req.params.id);
  if (!id) return res.status(400).json({ error: 'Invalid manager ID' });
  try {
    const data = await getCachedApiData(`https://fantasy.premierleague.com/api/entry/${id}/`);
    res.json({
      id: data.id,
      name: data.name,
      playerFirstName: data.player_first_name,
      playerLastName: data.player_second_name,
      overallPoints: data.summary_overall_points,
      overallRank: data.summary_overall_rank,
    });
  } catch (error) {
    const status = error.response?.status || 500;
    if (status === 404) return res.status(404).json({ error: 'Manager not found' });
    logger.error({ err: error }, 'Manager lookup error');
    res.status(status).json({ error: 'Failed to look up manager' });
  }
});

// ---- Manager Leagues (list leagues a manager has joined) ----
router.get('/manager-leagues/:id', async (req, res) => {
  const id = parsePositiveId(req.params.id);
  if (!id) return res.status(400).json({ error: 'Invalid manager ID' });
  try {
    const data = await getCachedApiData(`https://fantasy.premierleague.com/api/entry/${id}/`);
    const leagues = (data.leagues?.classic || []).map(l => ({
      id: l.id,
      name: l.name,
      rank: l.entry_rank,
      lastRank: l.entry_last_rank,
      percentileRank: l.entry_percentile_rank,
      type: l.league_type === 'x' ? 'private' : 'system',
      scoring: l.scoring,
      totalEntries: l.rank_count,
      admin: l.admin_entry === id,
    }));
    res.json({ leagues });
  } catch (error) {
    const status = error.response?.status || 500;
    if (status === 404) return res.status(404).json({ error: 'Manager not found' });
    logger.error({ err: error }, 'Manager leagues lookup error');
    res.status(status).json({ error: 'Failed to fetch manager leagues' });
  }
});

// ---- Save Manager (cache connected manager info for name search) ----
router.post('/save-manager', async (req, res) => {
  if (!sql) return res.status(503).json({ error: 'Database not available' });
  const managerId = parsePositiveId(req.body?.managerId);
  if (!managerId) return res.status(400).json({ error: 'Invalid manager ID' });
  try {
    const { teamName, playerFirstName, playerLastName, overallPoints, overallRank, leagueId } = req.body || {};
    await sql`
      INSERT INTO connected_managers (manager_id, team_name, player_first_name, player_last_name, overall_points, overall_rank, league_id, last_seen)
      VALUES (${managerId}, ${teamName || null}, ${playerFirstName || null}, ${playerLastName || null}, ${overallPoints || null}, ${overallRank || null}, ${leagueId || null}, NOW())
      ON CONFLICT (manager_id) DO UPDATE SET
        team_name = EXCLUDED.team_name,
        player_first_name = EXCLUDED.player_first_name,
        player_last_name = EXCLUDED.player_last_name,
        overall_points = EXCLUDED.overall_points,
        overall_rank = EXCLUDED.overall_rank,
        league_id = COALESCE(EXCLUDED.league_id, connected_managers.league_id),
        last_seen = NOW()
    `;
    res.json({ ok: true });
  } catch (e) {
    logger.error({ err: e }, 'Save manager error');
    res.status(500).json({ error: 'Failed to save manager' });
  }
});

// ---- Search Managers (by team name or owner name in connected_managers) ----
router.get('/search-managers', async (req, res) => {
  if (!sql) return res.json({ managers: [] });
  const q = String(req.query.q || '').trim();
  if (q.length < 2) return res.json({ managers: [] });
  try {
    const pattern = `%${q}%`;
    const managers = await sql`
      SELECT manager_id, team_name, player_first_name, player_last_name, overall_points, overall_rank
      FROM connected_managers
      WHERE team_name ILIKE ${pattern}
         OR player_first_name ILIKE ${pattern}
         OR player_last_name ILIKE ${pattern}
      ORDER BY last_seen DESC
      LIMIT 10
    `;
    res.json({ managers });
  } catch (e) {
    logger.error({ err: e }, 'Search managers error');
    res.json({ managers: [] });
  }
});

// ---- Bootstrap Static (proxied from FPL API, 5min cache) ----
router.get('/bootstrap-static', async (req, res) => {
  try {
    const data = await getCachedApiData(BOOTSTRAP_URL, BOOTSTRAP_CACHE_TTL);
    res.json(data);
  } catch (e) {
    logger.error({ err: e }, 'Bootstrap static error');
    res.status(500).json({ error: 'Failed to fetch bootstrap data' });
  }
});

// ---- Fixtures (proxied from FPL API, 5min cache) ----
router.get('/fixtures', async (req, res) => {
  try {
    const data = await getCachedApiData(FIXTURES_URL, BOOTSTRAP_CACHE_TTL);
    res.json(data);
  } catch (e) {
    logger.error({ err: e }, 'Fixtures error');
    res.status(500).json({ error: 'Failed to fetch fixtures' });
  }
});

// ---- Team Builder Preferences (Gemini NLP) ----
router.post('/team-builder/preferences', heavyEndpointLimiter, async (req, res) => {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return res.status(503).json({ error: 'Smart preference parsing is not configured' });
  const text = typeof req.body?.text === 'string' ? req.body.text.trim().slice(0, 1000) : '';
  const players = Array.isArray(req.body?.players) ? req.body.players.slice(0, 1000).map(player => ({
    id: Number(player?.id),
    name: String(player?.name || '').slice(0, 80),
    fullName: (String(player?.fullName || '').trim() || `${String(player?.first_name || '').trim()} ${String(player?.second_name || '').trim()}`.trim()).slice(0, 120),
    team: String(player?.team || '').slice(0, 8).toUpperCase(),
    position: String(player?.position || '').slice(0, 3).toUpperCase(),
    price: Number(player?.price),
    status: String(player?.status || '').slice(0, 2),
    gameweeks: Array.isArray(player?.gameweeks) ? player.gameweeks.slice(0, 8).map(Number).filter(Number.isInteger) : [],
    xPts: Number(player?.xPts), xG: Number(player?.xG), xA: Number(player?.xA), xMins: Number(player?.xMins),
    ownership: Number(player?.ownership), form: Number(player?.form),
  })).filter(player => Number.isInteger(player.id) && player.id > 0 && player.name) : [];
  if (!text) return res.status(400).json({ error: 'A preference is required' });
  if (!players.length) return res.status(400).json({ error: 'A player catalog is required' });

  const prompt = `Interpret a user's Fantasy Premier League team-building request into strict constraints. The request may be in any language. Understand idioms, slang, abbreviations, spelling mistakes, negation, and verb inflections.
You are an FPL expert. Understand nailed players, minutes security, rotation, punts, differentials, premiums, enablers, fodder, bench, starting XI, captaincy, ownership, form, xPts, xG, xA, xGI, expected minutes/xMins, price, budget, money in the bank, clubs, positions, formations, and optimization over upcoming gameweeks.
Add/include/want/keep/lock means include. Remove/exclude/avoid/drop/sell/forfeit/forgo/sacrifice means exclude. "Bench X" means include X and put the ID in benchIds. "Start X" means include X and put the ID in starterIds.
Resolve players only against the supplied catalog. Never guess an ID. A named captain must also be in mustInclude.
If a name can refer to multiple catalog players and the user did not disambiguate with a full name, club, or position, put every candidate in ambiguities and do not include or exclude any of them.
Team values are the catalog's three-letter team codes. Positions are only GKP, DEF, MID, FWD. Prices and budget are in millions. Valid formations are 3-4-3, 3-5-2, 4-3-3, 4-4-2, 4-5-1, 5-3-2, 5-4-1.
Set horizon to an explicitly requested count of upcoming gameweeks from 1 to 8, otherwise null.
Metrics are xPts, xG, xA, xGI, xMins, ownership, form, and price. xPts/xG/xA/xGI/xMins are totals across the horizon. Use global metricRules only when every eligible player in the stated positions must satisfy the rule. Use playerRequirements when the user asks for a number/type of players, one bench profile, a differential, enabler, premium, fodder pick, or "a player with" a metric. A playerRequirement has a count, role, positions, teams, price bounds, metric rules, and sortBy.
Price wording matters: "a 4.5 midfielder" or "at 4.5" means priceMin=4.5 and priceMax=4.5; "under 4.5" means only priceMax=4.5. Bench/fodder requirements have role BENCH. "Start" has role STARTER. Other requirements use SQUAD. For "nailed" or minutes-security language, infer a sensible xMins threshold from the catalog and horizon.
Understand these patterns and analogous wording in any language:
- "add Tzolis Bruno Rice" => resolve three adjacent catalog names and put all three IDs in mustInclude. Commas and "and" are never required.
- "Haaland Salah Palmer locked, sell Watkins" => include the first three and exclude Watkins.
- "bench Dibling, start Saka, captain Salah" => include all three, set benchIds, starterIds and captainId.
- "a 4.5m bench midfielder" => one BENCH playerRequirement for MID at exactly 4.5, sorted by xPts.
- "two defenders 5m or less" => one SQUAD requirement, count 2, DEF, priceMax 5.
- "one differential forward below 8m" => count 1, FWD, priceMax 8, ownership max 10, sortBy xPts.
- "a nailed cheap keeper" => count 1, GKP, sensible low priceMax and xMins minimum, sortBy xPts.
- "a player with at least 45 xPts over the next 3 GWs" => horizon 3 and one requirement with xPts min 45. Do not require all 15 players to reach 45.
- "all mids need 200 xMins in 3 GWs" => horizon 3 and a global MID xMins minimum rule.
- "maximize xG over 5 weeks" => horizon 5, optimizationMetric xG. "best xPts" uses xPts; "most assists" uses xA; "best value" uses value.
- "three Arsenal, no Spurs, max one Liverpool" => team minimum, exclusion, and maximum.
- "safe template team" => sensible ownership and xMins requirements; "low owned differential team" => ownership caps; "aggressive punts" => favor xG/xGI with a lower ownership cap.
- "penalty takers" or "set-piece takers" can only be honored when catalog evidence supports it; otherwise put that part in unclear rather than guessing.
- Set prioritizeSetPieces=true when the user asks to prioritize penalty or set-piece takers. Set starterMinScore=55 for likely/nailed starters and 75 only when the user explicitly requires nailed certainty.
- Set preferGoodFixtures=true for good/easy/favourable fixtures or FDR. Set balancedSquad=true when the user asks to spread funds or build a balanced team.
Put unsupported or genuinely unclear requests in unclear. Keep understood labels short and in the user's language. Do not invent constraints from general praise.

USER PREFERENCE:
${text}

PLAYER CATALOG:
${JSON.stringify(players)}`;

  try {
    const { response, model } = await generateWithGeminiFallback(apiKey, GEMINI_PREFERENCE_MODELS, {
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0,
          maxOutputTokens: 4096,
          responseMimeType: 'application/json',
          responseSchema: {
            type: 'OBJECT',
            required: ['constraints', 'understood', 'unclear', 'ambiguities'],
            properties: {
              constraints: {
                type: 'OBJECT',
                required: ['mustInclude', 'mustExclude', 'benchIds', 'starterIds', 'teamIncludeMin', 'teamIncludeMax', 'teamExclude', 'priceMax', 'priceMin', 'playerPriceMax', 'playerPriceMin', 'metricRules', 'playerRequirements', 'optimizationMetric', 'prioritizeSetPieces', 'starterMinScore', 'preferGoodFixtures', 'balancedSquad', 'formation', 'horizon', 'budget', 'captainId', 'viceCaptainId', 'benchStyle', 'structurePreference', 'templateStyle', 'avoidInjured'],
                properties: {
                  mustInclude: { type: 'ARRAY', items: { type: 'INTEGER' } },
                  mustExclude: { type: 'ARRAY', items: { type: 'INTEGER' } },
                  benchIds: { type: 'ARRAY', items: { type: 'INTEGER' } },
                  starterIds: { type: 'ARRAY', items: { type: 'INTEGER' } },
                  teamIncludeMin: { type: 'OBJECT', additionalProperties: { type: 'INTEGER' } },
                  teamIncludeMax: { type: 'OBJECT', additionalProperties: { type: 'INTEGER' } },
                  teamExclude: { type: 'ARRAY', items: { type: 'STRING' } },
                  priceMax: { type: 'OBJECT', additionalProperties: { type: 'NUMBER' } },
                  priceMin: { type: 'OBJECT', additionalProperties: { type: 'NUMBER' } },
                  playerPriceMax: { type: 'OBJECT', additionalProperties: { type: 'NUMBER' } },
                  playerPriceMin: { type: 'OBJECT', additionalProperties: { type: 'NUMBER' } },
                  metricRules: { type: 'ARRAY', items: { type: 'OBJECT', required: ['metric', 'positions', 'min', 'max'], properties: {
                    metric: { type: 'STRING', enum: ['xPts', 'xG', 'xA', 'xGI', 'xMins', 'ownership', 'form', 'price'] },
                    positions: { type: 'ARRAY', items: { type: 'STRING', enum: ['GKP', 'DEF', 'MID', 'FWD'] } },
                    min: { type: 'NUMBER', nullable: true }, max: { type: 'NUMBER', nullable: true },
                  } } },
                  playerRequirements: { type: 'ARRAY', items: { type: 'OBJECT', required: ['count', 'role', 'positions', 'teams', 'priceMin', 'priceMax', 'metricRules', 'sortBy'], properties: {
                    count: { type: 'INTEGER' }, role: { type: 'STRING', enum: ['SQUAD', 'STARTER', 'BENCH'] },
                    positions: { type: 'ARRAY', items: { type: 'STRING', enum: ['GKP', 'DEF', 'MID', 'FWD'] } },
                    teams: { type: 'ARRAY', items: { type: 'STRING' } },
                    priceMin: { type: 'NUMBER', nullable: true }, priceMax: { type: 'NUMBER', nullable: true },
                    metricRules: { type: 'ARRAY', items: { type: 'OBJECT', required: ['metric', 'min', 'max'], properties: {
                      metric: { type: 'STRING', enum: ['xPts', 'xG', 'xA', 'xGI', 'xMins', 'ownership', 'form', 'price'] },
                      min: { type: 'NUMBER', nullable: true }, max: { type: 'NUMBER', nullable: true },
                    } } },
                    sortBy: { type: 'STRING', enum: ['xPts', 'xG', 'xA', 'xGI', 'xMins', 'ownership', 'form', 'price', 'value'] },
                  } } },
                  optimizationMetric: { type: 'STRING', enum: ['xPts', 'xG', 'xA', 'xGI', 'xMins', 'form', 'value'] },
                  prioritizeSetPieces: { type: 'BOOLEAN' },
                  starterMinScore: { type: 'INTEGER', nullable: true },
                  preferGoodFixtures: { type: 'BOOLEAN' },
                  balancedSquad: { type: 'BOOLEAN' },
                  formation: { type: 'ARRAY', nullable: true, items: { type: 'INTEGER' } },
                  horizon: { type: 'INTEGER', nullable: true },
                  budget: { type: 'NUMBER', nullable: true },
                  captainId: { type: 'INTEGER', nullable: true },
                  viceCaptainId: { type: 'INTEGER', nullable: true },
                  benchStyle: { type: 'STRING', nullable: true, enum: ['fodder', 'strong'] },
                  structurePreference: { type: 'STRING', nullable: true, enum: ['big_at_back', 'heavy_mid', 'heavy_fwd'] },
                  templateStyle: { type: 'STRING', nullable: true, enum: ['template', 'differential', 'ultra_differential'] },
                  avoidInjured: { type: 'BOOLEAN' },
                },
              },
              understood: { type: 'ARRAY', items: { type: 'STRING' } },
              unclear: { type: 'ARRAY', items: { type: 'STRING' } },
              ambiguities: {
                type: 'ARRAY',
                items: {
                  type: 'OBJECT',
                  required: ['name', 'playerIds'],
                  properties: {
                    name: { type: 'STRING' },
                    playerIds: { type: 'ARRAY', items: { type: 'INTEGER' } },
                  },
                },
              },
            },
          },
        },
      });
    const raw = (response.data?.candidates?.[0]?.content?.parts || []).map(part => part.text || '').join('').trim();
    if (!raw) return res.status(502).json({ error: 'Smart preference parsing returned no result' });
    const parsed = JSON.parse(stripCodeFences(raw));
    const playerById = new Map(players.map(player => [player.id, player]));
    const validIds = values => [...new Set((Array.isArray(values) ? values : []).map(Number).filter(id => playerById.has(id)))];
    const validTeams = new Set(players.map(player => player.team));
    const validPositions = new Set(['GKP', 'DEF', 'MID', 'FWD']);
    const cleanMap = (value, keys, min, max) => Object.fromEntries(Object.entries(value && typeof value === 'object' && !Array.isArray(value) ? value : {}).filter(([key, amount]) => keys.has(String(key).toUpperCase()) && Number.isFinite(Number(amount)) && Number(amount) >= min && Number(amount) <= max).map(([key, amount]) => [String(key).toUpperCase(), Number(amount)]));
    const source = parsed.constraints || {};
    const mustExclude = validIds(source.mustExclude);
    const mustInclude = validIds(source.mustInclude).filter(id => !mustExclude.includes(id));
    const benchIds = validIds(source.benchIds).filter(id => !mustExclude.includes(id));
    const starterIds = validIds(source.starterIds).filter(id => !mustExclude.includes(id) && !benchIds.includes(id));
    [...benchIds, ...starterIds].forEach(id => { if (!mustInclude.includes(id)) mustInclude.push(id); });
    const captainId = playerById.has(Number(source.captainId)) ? Number(source.captainId) : null;
    if (captainId && !mustExclude.includes(captainId) && !mustInclude.includes(captainId)) mustInclude.push(captainId);
    const viceCaptainId = playerById.has(Number(source.viceCaptainId)) ? Number(source.viceCaptainId) : null;
    if (viceCaptainId && !mustExclude.includes(viceCaptainId) && !mustInclude.includes(viceCaptainId)) mustInclude.push(viceCaptainId);
    const formation = Array.isArray(source.formation) && ['3-4-3', '3-5-2', '4-3-3', '4-4-2', '4-5-1', '5-3-2', '5-4-1'].includes(source.formation.map(Number).join('-')) ? source.formation.map(Number) : null;
    const metricNames = new Set(['xPts', 'xG', 'xA', 'xGI', 'xMins', 'ownership', 'form', 'price']);
    const metricRules = (Array.isArray(source.metricRules) ? source.metricRules : []).map(rule => ({
      metric: String(rule?.metric || ''),
      positions: [...new Set((Array.isArray(rule?.positions) ? rule.positions : []).map(String).map(position => position.toUpperCase()).filter(position => validPositions.has(position)))],
      min: rule?.min == null || !Number.isFinite(Number(rule.min)) ? null : Number(rule.min),
      max: rule?.max == null || !Number.isFinite(Number(rule.max)) ? null : Number(rule.max),
    })).filter(rule => metricNames.has(rule.metric) && (rule.min != null || rule.max != null));
    const playerRequirements = (Array.isArray(source.playerRequirements) ? source.playerRequirements : []).map(requirement => ({
      count: Math.max(1, Math.min(15, Number.parseInt(requirement?.count, 10) || 1)),
      role: ['SQUAD', 'STARTER', 'BENCH'].includes(requirement?.role) ? requirement.role : 'SQUAD',
      positions: [...new Set((Array.isArray(requirement?.positions) ? requirement.positions : []).map(String).map(position => position.toUpperCase()).filter(position => validPositions.has(position)))],
      teams: [...new Set((Array.isArray(requirement?.teams) ? requirement.teams : []).map(String).map(team => team.toUpperCase()).filter(team => validTeams.has(team)))],
      priceMin: requirement?.priceMin == null || !Number.isFinite(Number(requirement.priceMin)) ? null : Math.max(3, Math.min(20, Number(requirement.priceMin))),
      priceMax: requirement?.priceMax == null || !Number.isFinite(Number(requirement.priceMax)) ? null : Math.max(3, Math.min(20, Number(requirement.priceMax))),
      metricRules: (Array.isArray(requirement?.metricRules) ? requirement.metricRules : []).map(rule => ({
        metric: String(rule?.metric || ''),
        min: rule?.min == null || !Number.isFinite(Number(rule.min)) ? null : Number(rule.min),
        max: rule?.max == null || !Number.isFinite(Number(rule.max)) ? null : Number(rule.max),
      })).filter(rule => metricNames.has(rule.metric) && (rule.min != null || rule.max != null)),
      sortBy: ['xPts', 'xG', 'xA', 'xGI', 'xMins', 'ownership', 'form', 'price', 'value'].includes(requirement?.sortBy) ? requirement.sortBy : 'xPts',
    })).slice(0, 15);
    const ambiguities = (Array.isArray(parsed.ambiguities) ? parsed.ambiguities : []).map(item => ({
      name: String(item?.name || '').slice(0, 100),
      players: validIds(item?.playerIds).map(id => ({ id, name: players.find(player => player.id === id).fullName || players.find(player => player.id === id).name, team: players.find(player => player.id === id).team, position: players.find(player => player.id === id).position })),
    })).filter(item => item.name && item.players.length > 1);
    const ambiguousIds = new Set(ambiguities.flatMap(item => item.players.map(player => player.id)));

    res.json({
      constraints: {
        mustInclude: mustInclude.filter(id => !ambiguousIds.has(id)),
        mustExclude: mustExclude.filter(id => !ambiguousIds.has(id)),
        benchIds: benchIds.filter(id => !ambiguousIds.has(id)).slice(0, 4),
        starterIds: starterIds.filter(id => !ambiguousIds.has(id)).slice(0, 11),
        teamIncludeMin: cleanMap(source.teamIncludeMin, validTeams, 1, 3),
        teamIncludeMax: cleanMap(source.teamIncludeMax, validTeams, 0, 3),
        teamExclude: [...new Set((Array.isArray(source.teamExclude) ? source.teamExclude : []).map(String).map(team => team.toUpperCase()).filter(team => validTeams.has(team)))],
        priceMax: cleanMap(source.priceMax, validPositions, 3, 20),
        priceMin: cleanMap(source.priceMin, validPositions, 3, 20),
        playerPriceMax: cleanMap(source.playerPriceMax, new Set(players.map(player => String(player.id))), 3, 20),
        playerPriceMin: cleanMap(source.playerPriceMin, new Set(players.map(player => String(player.id))), 3, 20),
        metricRules,
        playerRequirements,
        optimizationMetric: ['xPts', 'xG', 'xA', 'xGI', 'xMins', 'form', 'value'].includes(source.optimizationMetric) ? source.optimizationMetric : 'xPts',
        prioritizeSetPieces: source.prioritizeSetPieces === true,
        starterMinScore: [55, 75].includes(Number(source.starterMinScore)) ? Number(source.starterMinScore) : null,
        preferGoodFixtures: source.preferGoodFixtures === true,
        balancedSquad: source.balancedSquad === true,
        formation,
        horizon: Number.isInteger(Number(source.horizon)) && Number(source.horizon) >= 1 && Number(source.horizon) <= 8 ? Number(source.horizon) : null,
        budget: Number.isFinite(Number(source.budget)) && Number(source.budget) >= 50 && Number(source.budget) <= 100 ? Number(source.budget) : null,
        captainId: captainId && !ambiguousIds.has(captainId) && !mustExclude.includes(captainId) ? captainId : null,
        viceCaptainId: viceCaptainId && !ambiguousIds.has(viceCaptainId) && !mustExclude.includes(viceCaptainId) ? viceCaptainId : null,
        benchStyle: ['fodder', 'strong'].includes(source.benchStyle) ? source.benchStyle : null,
        structurePreference: ['big_at_back', 'heavy_mid', 'heavy_fwd'].includes(source.structurePreference) ? source.structurePreference : null,
        templateStyle: ['template', 'differential', 'ultra_differential'].includes(source.templateStyle) ? source.templateStyle : null,
        avoidInjured: source.avoidInjured === true,
      },
      understood: (Array.isArray(parsed.understood) ? parsed.understood : []).map(String).map(value => value.slice(0, 160)).slice(0, 30),
      unclear: (Array.isArray(parsed.unclear) ? parsed.unclear : []).map(String).map(value => value.slice(0, 200)).slice(0, 20),
      ambiguities,
      engine: 'gemini',
      model,
    });
  } catch (error) {
    logger.error({ err: error }, 'Gemini preference parsing error');
    const status = error.response?.status === 429 ? 429 : 502;
    res.status(status).json({ error: 'Smart preference parsing failed', detail: error.response?.data?.error?.message || error.message });
  }
});

// ---- Price Changes ----
router.get('/price-changes', async (req, res) => {
  try {
    const r = await getCachedApiData(BOOTSTRAP_URL);
    const map = p => ({ name: p.web_name, team: (r.teams.find(t=>t.id===p.team)||{}).name, photoId: p.code, change: p.cost_change_event, newCost: p.now_cost, selectedBy: p.selected_by_percent, form: p.form, totalPoints: p.total_points });
    const risers = r.elements.filter(p => p.cost_change_event > 0).sort((a,b) => b.cost_change_event-a.cost_change_event).slice(0,15).map(map);
    const fallers = r.elements.filter(p => p.cost_change_event < 0).sort((a,b) => a.cost_change_event-b.cost_change_event).slice(0,15).map(map);
    res.json({ risers, fallers });
  } catch (e) { res.status(500).json({ error: 'Failed' }); }
});

// ---- League Standings (old enriched version) ----
router.get('/league-standings/:leagueId', heavyEndpointLimiter, async (req, res) => {
  const requestedLeagueId = parsePositiveId(req.params.leagueId);
  if (!requestedLeagueId) return res.status(400).json({ error: 'Invalid league ID' });
  try {
    const leagueId = requestedLeagueId;
    const [bs, p1] = await Promise.all([
      getCachedApiData(BOOTSTRAP_URL),
      getCachedApiData(`https://fantasy.premierleague.com/api/leagues-classic/${leagueId}/standings/?page_standings=1&phase=1`)
    ]);
    const playerData = bs;
    let standings = p1.standings.results || [];
    // Fetch page 2 for top 50
    try {
      const p2 = await getCachedApiData(`https://fantasy.premierleague.com/api/leagues-classic/${leagueId}/standings/?page_standings=2&phase=1`);
      standings = standings.concat(p2.standings.results || []);
    } catch(e) { /* page 2 may not exist */ }
    standings = standings.slice(0, 50);
    const currentGW = playerData.events.find(e => e.is_current)?.id || 1;

    const enriched = [];
    const entries = standings;

    const batchSize = 3;
    for (let i = 0; i < entries.length; i += batchSize) {
      const batch = entries.slice(i, i + batchSize);
      const results = await Promise.allSettled(batch.map(async e => {
        const [histData, entryData] = await Promise.all([
          getCachedApiData(`https://fantasy.premierleague.com/api/entry/${e.entry}/history/`).catch(() => null),
          getCachedApiData(`https://fantasy.premierleague.com/api/entry/${e.entry}/`).catch(() => null)
        ]);
        return { history: histData, entry: entryData };
      }));
      results.forEach((res, idx) => {
        const entry = batch[idx];
        const hist = res.value?.history;
        const entryData = res.value?.entry;
        const past = hist?.past || [];
        const chips = hist?.chips || [];
        const currentGW = hist?.current?.length || 0;

        // Map season names to find specific past seasons
        const getSeasonRank = (season) => {
          const s = past.find(p => p.season_name === season);
          return s ? s.rank : null;
        };
        const lastSeasonRank = getSeasonRank('2024/25');
        const seasonBeforeLastRank = getSeasonRank('2023/24');

        // Chips filtered from GW20+
        const chipLabels = chips
          .filter(c => c.event >= 20)
          .map(c => {
            const label = ({ wildcard:'WC', freehit:'FH', bench_boost:'BB', '3xc':'TC', triple_captain:'TC', bboost:'BB' }[c.name.toLowerCase()]||c.name);
            return `${label} GW${c.event}`;
          });

        // Overall rank from entry API
        const overallRank = entryData?.summary_overall_rank || entry.overall_rank;

        // GW points from entry current data
        const gwPoints = hist?.current?.length > 0 ? hist.current[hist.current.length - 1].points : entry.event_total;

        enriched.push({
          rank: entry.rank, entry: entry.entry,
          playerName: entry.player_name, teamName: entry.entry_name,
          totalPoints: entry.total, overallRank: overallRank?.toLocaleString() || '—',
          lastRank: entry.last_rank, rankChange: (entry.last_rank || entry.rank) - entry.rank,
          gwPoints: gwPoints?.toLocaleString() || '—',
          lastSeasonRank: lastSeasonRank?.toLocaleString() || '—',
          seasonBeforeLastRank: seasonBeforeLastRank?.toLocaleString() || '—',
          chipsUsed: chipLabels.length ? chipLabels.join(', ') : 'None',
          immediateGain: '—',
          totalImmediateGain: '—'
        });
      });
    }

    res.json({
      leagueName: p1.data.league?.name || 'Classic League',
      currentGW,
      standings: enriched
    });
  } catch (e) {
    logger.error({ err: e }, 'League error');
    res.status(500).json({ error: 'Failed to fetch league standings' });
  }
});

// ---- Zone Analysis (Per-GW Match Breakdowns) ----
const ZONE_ANALYSIS_TTL = 120; // 2 minutes in seconds

router.get('/zone-analysis', async (req, res) => {
  try {
    const [bs, fixtures] = await Promise.all([
      getCachedApiData(BOOTSTRAP_URL),
      getCachedApiData(FIXTURES_URL)
    ]);

    const teams = bs.teams;
    const elements = bs.elements;
    const currentGW = bs.events.find(e => e.is_current)?.id || 1;
    const selectedGW = parseInt(req.query.gw) || currentGW;

    const cacheKey = `zone:${selectedGW}`;

    // Try Redis first
    if (redis) {
      try {
        const cached = await redis.get(cacheKey);
        if (cached) return res.json(cached);
      } catch (e) { /* fall through */ }
    }

    // Helper: get team by id
    const getTeam = id => teams.find(t => t.id === id) || { short_name: '?', name: 'Unknown' };

    // Assign detailed positions to players using web_name lookup
    const playersWithZones = elements.map(p => {
      const detailedPos = DETAILED_POSITIONS[p.web_name] || null;
      const broadPos = POSITION_MAP[p.element_type - 1];
      return {
        id: p.id, name: p.web_name, secondName: p.second_name, team: p.team,
        teamName: getTeam(p.team).short_name, broadPosition: broadPos,
        detailedPosition: detailedPos || broadPos, zone: detailedPos ? (ZONE_MAP[detailedPos] || null) : null,
        goals: p.goals_scored || 0, assists: p.assists || 0,
        expectedGoals: parseFloat(p.expected_goals) || 0,
        expectedAssists: parseFloat(p.expected_assists) || 0,
        expectedGoalInvolvements: parseFloat(p.expected_goal_involvements) || 0,
        expectedGoalsConceded: parseFloat(p.expected_goals_conceded) || 0,
        threat: parseFloat(p.threat) || 0, creativity: parseFloat(p.creativity) || 0,
        influence: parseFloat(p.influence) || 0, ictIndex: parseFloat(p.ict_index) || 0,
        form: parseFloat(p.form) || 0, minutes: p.minutes || 0,
        cleanSheets: p.clean_sheets || 0, goalsConceded: p.goals_conceded || 0,
        saves: p.saves || 0, bonus: p.bonus || 0, bps: p.bps || 0,
        defensiveContribution: p.defensive_contribution || 0,
        clearancesBlocksInterceptions: p.clearances_blocks_interceptions || 0,
        recoveries: p.recoveries || 0, tackles: p.tackles || 0,
        starts: p.starts || 0, chanceOfPlaying: p.chance_of_playing_next_round,
        status: p.status || 'a', valueSeason: parseFloat(p.value_season) || 0,
        yellowCards: p.yellow_cards || 0, redCards: p.red_cards || 0,
        nowCost: p.now_cost || 0, selectedByPercent: parseFloat(p.selected_by_percent) || 0,
        totalPoints: p.total_points || 0, code: p.code,
        pointsPerGame: parseFloat(p.points_per_game) || 0
      };
    });

    // Group players by team
    const teamGroups = {};
    playersWithZones.forEach(p => {
      if (!teamGroups[p.team]) teamGroups[p.team] = { GKP: [], DEF: [], MID: [], FWD: [] };
      if (p.broadPosition === 'GKP') teamGroups[p.team].GKP.push(p);
      else if (p.broadPosition === 'DEF') teamGroups[p.team].DEF.push(p);
      else if (p.broadPosition === 'FWD') teamGroups[p.team].FWD.push(p);
      else teamGroups[p.team].MID.push(p);
    });

    // Assign 4-2-3-1 zones
    // Players with zone from DETAILED_POSITIONS keep it.
    // Players without zone get assigned by position group.
    Object.entries(teamGroups).forEach(([teamId, group]) => {
      // GK
      const gkWithZone = group.GKP.find(p => p.zone);
      if (gkWithZone) { /* already set */ }
      else { const gk = [...group.GKP].sort((a, b) => b.minutes - a.minutes)[0]; if (gk) { gk.zone = 'gk'; gk.detailedPosition = 'GK'; } }

      // DEF: 4-2-3-1 = LB, LCB, RCB, RB
      const defZones = ['lb', 'lcb', 'rcb', 'rb'];
      const defWithZone = group.DEF.filter(p => p.zone);
      const defWithout = group.DEF.filter(p => !p.zone).sort((a, b) => b.minutes - a.minutes);
      // Fill unfilled DEF zones with remaining players
      const filledDefZones = defWithZone.map(p => p.zone);
      const openDefZones = defZones.filter(z => !filledDefZones.includes(z));
      openDefZones.forEach((z, i) => {
        if (i < defWithout.length) { defWithout[i].zone = z; defWithout[i].detailedPosition = z.toUpperCase(); }
      });

      // MID: 4-2-3-1 = LDM, RDM, LW, CAM, RW
      const midZones = ['ldm', 'rdm', 'lw', 'cam', 'rw'];
      const midWithZone = group.MID.filter(p => p.zone);
      const midWithout = group.MID.filter(p => !p.zone).sort((a, b) => b.minutes - a.minutes);
      const filledMidZones = midWithZone.map(p => p.zone);
      const openMidZones = midZones.filter(z => !filledMidZones.includes(z));
      openMidZones.forEach((z, i) => {
        if (i < midWithout.length) {
          midWithout[i].zone = z;
          midWithout[i].detailedPosition = (z === 'ldm' || z === 'rdm') ? 'CDM' : z.toUpperCase();
        }
      });

      // FWD: ST
      const fwdWithZone = group.FWD.find(p => p.zone);
      if (!fwdWithZone) {
        const fwd = [...group.FWD].sort((a, b) => b.minutes - a.minutes)[0];
        if (fwd) { fwd.zone = 'st'; fwd.detailedPosition = 'ST'; }
      }
    });

    // Build team analysis (reusable for all GW matchups)
    const buildTeamAnalysis = (teamId) => {
      const teamPlayers = playersWithZones.filter(p => p.team === teamId);
      const active = teamPlayers.filter(p => p.minutes > 0);
      // Pick best player per zone (by form, then minutes)
      const bestPerZone = {};
      ALL_ZONES.forEach(z => {
        const candidates = (active.length > 0 ? active : teamPlayers).filter(p => p.zone === z);
        if (candidates.length) bestPerZone[z] = candidates.sort((a, b) => b.form - a.form || b.minutes - a.minutes)[0];
      });
      const starters = Object.values(bestPerZone).filter(Boolean);

      const zoneStats = {};
      ALL_ZONES.forEach(z => { zoneStats[z] = { goals: 0, assists: 0, xG: 0, xA: 0, threat: 0, creativity: 0, goalsConceded: 0, xGC: 0, cleanSheets: 0, influence: 0, players: [] }; });

      starters.forEach(p => {
        if (!p.zone || !zoneStats[p.zone]) return;
        const z = zoneStats[p.zone];
        z.goals += p.goals;
        z.assists += p.assists;
        z.xG += p.expectedGoals;
        z.xA += p.expectedAssists;
        z.threat += p.threat;
        z.creativity += p.creativity;
        z.goalsConceded += p.goalsConceded;
        z.xGC += p.expectedGoalsConceded;
        z.influence += p.influence;
        z.cleanSheets += p.cleanSheets;
        z.players.push({
          name: p.name, position: p.detailedPosition, broadPos: p.broadPosition, zone: p.zone,
          goals: p.goals, assists: p.assists, xG: p.expectedGoals, xA: p.expectedAssists,
          xGI: p.expectedGoalInvolvements, threat: p.threat, creativity: p.creativity,
           influence: p.influence, ict: p.ictIndex, form: p.form, cost: p.nowCost,
           totalPoints: p.totalPoints, minutes: p.minutes, bonus: p.bonus,
           selectedBy: p.selectedByPercent, id: p.id, code: p.code,
           pointsPerGame: p.pointsPerGame, goalsConceded: p.goalsConceded,
           cleanSheets: p.cleanSheets, xGC: p.expectedGoalsConceded, saves: p.saves,
           yellowCards: p.yellowCards, defensiveContribution: p.defensiveContribution,
           clearancesBlocksInterceptions: p.clearancesBlocksInterceptions,
           recoveries: p.recoveries, tackles: p.tackles, starts: p.starts,
           status: p.status, chanceOfPlaying: p.chanceOfPlaying,
           valueSeason: p.valueSeason, team: p.teamName
         });
      });

      const gk = starters.find(p => p.broadPosition === 'GKP');
      const defenders = starters.filter(p => p.broadPosition === 'DEF');
      const defensiveReference = gk || [...defenders].sort((a, b) => b.minutes - a.minutes)[0];
      const teamCS = defensiveReference?.cleanSheets || 0;
      const teamGC = defensiveReference?.goalsConceded || 0;
      const referenceStarts = Math.max(defensiveReference?.starts || Math.round((defensiveReference?.minutes || 0) / 90), 1);
      const cleanSheetRate = teamCS / referenceStarts;
      const xgcPer90 = defensiveReference?.minutes > 0
        ? (defensiveReference.expectedGoalsConceded * 90) / defensiveReference.minutes
        : 1.5;
      const defensiveContributors = starters.filter(p => p.broadPosition === 'DEF' || p.broadPosition === 'MID');
      const avgDefconPer90 = defensiveContributors.length
        ? defensiveContributors.reduce((sum, p) => sum + ((p.defensiveContribution * 90) / Math.max(p.minutes, 90)), 0) / defensiveContributors.length
        : 0;
      const defconNorm = Math.max(0, Math.min(100,
        (cleanSheetRate * 55) +
        (Math.max(0, 1 - (xgcPer90 / 2)) * 30) +
        (Math.min(avgDefconPer90 / 12, 1) * 15)
      ));

      let strongestAttack = 'st';
      let maxAtk = 0;
      ATTACKING_ZONES.forEach(z => {
        const score = (zoneStats[z]?.xG || 0) + (zoneStats[z]?.xA || 0);
        if (score > maxAtk) { maxAtk = score; strongestAttack = z; }
      });

      let weakestDefence = 'lcb';
      let maxWeakness = -Infinity;
      DEFENSIVE_ZONES.forEach(z => {
        const zonePlayer = zoneStats[z]?.players?.[0];
        if (!zonePlayer) return;
        const zoneMinutes = Math.max(zonePlayer.minutes, 90);
        const weakness = ((zonePlayer.xGC * 90) / zoneMinutes) -
          (((zonePlayer.defensiveContribution || 0) * 90) / zoneMinutes / 20) -
          (((zonePlayer.tackles || 0) * 90) / zoneMinutes / 10);
        if (weakness > maxWeakness) { maxWeakness = weakness; weakestDefence = z; }
      });

      const topDef = [...defenders].sort((a, b) => b.influence - a.influence)[0];

      const totalGoals = active.reduce((s, p) => s + p.goals, 0);
      const totalAssists = active.reduce((s, p) => s + p.assists, 0);
      const totalXG = active.reduce((s, p) => s + p.expectedGoals, 0);
      const totalXA = active.reduce((s, p) => s + p.expectedAssists, 0);

      return {
        teamId, teamName: getTeam(teamId).short_name, teamFullName: getTeam(teamId).name,
        zoneStats,
        gk: gk ? { name: gk.name, saves: gk.saves, cs: gk.cleanSheets, gc: gk.goalsConceded, form: gk.form, cost: gk.nowCost, code: gk.code, xGC: gk.expectedGoalsConceded, pts: gk.totalPoints } : null,
        totalGoals, totalAssists, totalXG, totalXA, totalGC: teamGC,
        strongestAttack, strongestAttackZone: ZONE_LABELS[strongestAttack],
        weakestDefence, weakestDefenceZone: ZONE_LABELS[weakestDefence],
        defcon: Math.round(defconNorm),
        defconLabel: defconNorm >= 58 ? 'Strong' : defconNorm >= 38 ? 'Average' : 'Weak',
        topDefender: topDef ? { name: topDef.name, position: topDef.detailedPosition, influence: topDef.influence, cs: topDef.cleanSheets, cost: topDef.nowCost, code: topDef.code, form: topDef.form } : null,
        teamCS
      };
    };

    // Build all team analyses
    const teamAnalysisMap = {};
    teams.forEach(t => { teamAnalysisMap[t.id] = buildTeamAnalysis(t.id); });

    const fixtureModifier = difficulty => ({ 1: 1.2, 2: 1.1, 3: 1, 4: 0.9, 5: 0.78 }[difficulty] || 1);
    const attackTargetsWeakness = (attackZone, weakZone) => ({
      lw: ['rb'],
      rw: ['lb'],
      cam: ['lcb', 'rcb'],
      st: ['lcb', 'rcb']
    }[attackZone] || []).includes(weakZone);
    const clampScore = value => Math.round(Math.max(0, Math.min(99, value)));
    const per90 = (value, minutes) => (Number(value || 0) * 90) / Math.max(Number(minutes || 0), 90);

    const buildTargetGroups = (teamId, team, opponent, difficulty, isHome) => {
      const candidates = playersWithZones.filter(p =>
        p.team === teamId &&
        p.minutes > 0 &&
        p.status !== 'u' &&
        p.status !== 'n' &&
        p.chanceOfPlaying !== 0
      );
      if (!candidates.length) return [];

      const maxMinutes = Math.max(...candidates.map(p => p.minutes), 1);
      const maxStarts = Math.max(...candidates.map(p => p.starts), Math.round(maxMinutes / 90), 1);
      const opponentAttackPerMatch = (opponent.totalXG + opponent.totalXA) / maxStarts;
      const difficultyMod = fixtureModifier(difficulty) * (isHome ? 1.04 : 1);
      const directZoneMatch = attackTargetsWeakness(team.strongestAttack, opponent.weakestDefence);

      const scored = candidates.map(player => {
        const minutesShare = Math.min(player.minutes / maxMinutes, 1);
        const startShare = Math.min(player.starts / maxStarts, 1);
        const minutesSecurity = (minutesShare * 0.35) + (startShare * 0.65);
        const availability = player.chanceOfPlaying == null ? 1 : player.chanceOfPlaying / 100;
        const readiness = (0.55 + (minutesSecurity * 0.45)) * availability;

        // Per-90 rates
        const goalRate = per90(player.goals, player.minutes);
        const assistRate = per90(player.assists, player.minutes);
        const xg90 = per90(player.expectedGoals, player.minutes);
        const xa90 = per90(player.expectedAssists, player.minutes);
        const xgi90 = xg90 + xa90;
        const threat90 = per90(player.threat, player.minutes);
        const creativity90 = per90(player.creativity, player.minutes);
        const saves90 = per90(player.saves, player.minutes);
        const defcon90 = per90(player.defensiveContribution, player.minutes);
        const tackles90 = per90(player.tackles, player.minutes);
        const cbi90 = per90(player.clearancesBlocksInterceptions, player.minutes);
        const recoveries90 = per90(player.recoveries, player.minutes);
        const bonusPerStart = player.bonus / Math.max(player.starts, 1);
        const cleanSheetRate = player.cleanSheets / Math.max(player.starts, 1);
        const zoneBoost = directZoneMatch && player.zone === team.strongestAttack ? 1.12 : 1;

        // Opponent weakness: does this player's zone attack the opponent's weak side?
        const playerZoneWeak = attackTargetsWeakness(player.zone, opponent.weakestDefence);
        const weaknessBoost = playerZoneWeak ? 1.10 : 1;

        // === ROUTE 1: Attacking returns (goals + assists) ===
        const attackPoints = (
          (xg90 * 5.5) +        // xG -> expected goals -> ~5.5 pts each
          (xa90 * 4.0) +        // xA -> expected assists -> ~4 pts each
          (goalRate * 4.8) +    // actual goals weighted
          (assistRate * 3.5) +  // actual assists weighted
          (threat90 * 0.3) +    // shot threat as signal
          (creativity90 * 0.2) + // chance creation as signal
          (player.form * 0.8) + // recent form
          (player.pointsPerGame * 0.6) // historical output
        ) * difficultyMod * zoneBoost * weaknessBoost * readiness;

        // === ROUTE 2: Defensive returns (DEFCON + clean sheets) ===
        const defensivePoints = (
          (defcon90 * 2.0) +    // DEFCON points per 90
          (tackles90 * 0.4) +   // tackles as bonus signal
          (cbi90 * 0.15) +      // clearances/blocks/interceptions
          (recoveries90 * 0.1) + // ball recoveries
          (cleanSheetRate * 4.0) + // clean sheet probability * pts
          (team.defcon * 0.08) + // team defensive profile
          (bonusPerStart * 1.5)  // bonus tendency
        ) * difficultyMod * readiness;

        // === ROUTE 3: GK returns (saves + clean sheets) ===
        const gkPoints = (
          (saves90 * 1.0) +     // save points
          (cleanSheetRate * 4.0) + // clean sheet pts
          (bonusPerStart * 1.5) + // bonus
          (Math.min(opponentAttackPerMatch, 2.5) * 1.2) // more shots = more saves
        ) * (0.85 + (difficulty * 0.05)) * availability;

        // === Composite: best route for this player ===
        const bestRoute = Math.max(attackPoints, defensivePoints, gkPoints);

        // === Minutes certainty as a final multiplier ===
        const minutesMultiplier = 0.5 + (minutesSecurity * 0.5); // 0.5 to 1.0

        // === Final expected points ===
        const expectedPoints = clampScore(bestRoute * minutesMultiplier);

        // Keep individual category scores for the target groups
        const goalScore = clampScore(attackPoints * 0.8);
        const assistScore = clampScore(attackPoints * 0.7);
        const cleanSheetScore = clampScore(defensivePoints * 0.9);
        const saveScore = clampScore(gkPoints);
        const defconScore = clampScore(defensivePoints);
        const valueScore = clampScore(((bestRoute / Math.max(player.nowCost / 10, 4)) * 7) + (minutesSecurity * 24));

        return {
          ...player,
          minutesSecurity: clampScore(minutesSecurity * 100),
          rates: {
            xG90: Number(xg90.toFixed(2)), xA90: Number(xa90.toFixed(2)),
            saves90: Number(saves90.toFixed(1)), defcon90: Number(defcon90.toFixed(1))
          },
          scores: { goals: goalScore, assists: assistScore, cleanSheet: cleanSheetScore, saves: saveScore, defcon: defconScore, value: valueScore, composite: expectedPoints }
        };
      });

      const serialize = (player, category, reason) => ({
        id: player.id, name: player.name, code: player.code, team: player.teamName,
        position: player.detailedPosition, broadPosition: player.broadPosition,
        zone: player.zone, cost: player.nowCost, form: player.form,
        pointsPerGame: player.pointsPerGame, totalPoints: player.totalPoints,
        goals: player.goals, assists: player.assists, xG: player.expectedGoals,
        xA: player.expectedAssists, cleanSheets: player.cleanSheets,
        saves: player.saves, defensiveContribution: player.defensiveContribution,
        bonus: player.bonus, minutes: player.minutes, starts: player.starts,
        ownership: player.selectedByPercent, minutesSecurity: player.minutesSecurity,
        rates: player.rates, score: player.scores[category], compositeScore: player.scores.composite, reason
      });
      const ranked = (category, filter, reason) => scored
        .filter(player => player.minutesSecurity >= 65 && filter(player))
        .sort((a, b) => b.scores[category] - a.scores[category] || b.minutesSecurity - a.minutesSecurity)
        .slice(0, 1)
        .map(player => serialize(player, category, reason(player)));

      return [
        {
          key: 'goals', label: 'Goal threat', icon: 'sports_soccer',
          picks: ranked('goals', p => p.broadPosition !== 'GKP', p =>
            `${p.rates.xG90} xG/90 into ${opponent.weakestDefenceZone}${directZoneMatch && p.zone === team.strongestAttack ? ' with a direct zone edge' : ''}.`)
        },
        {
          key: 'assists', label: 'Assist route', icon: 'conversion_path',
          picks: ranked('assists', p => p.broadPosition !== 'GKP', p =>
            `${p.rates.xA90} xA/90 and ${p.assists} assists; creativity is the main return route.`)
        },
        {
          key: 'cleanSheet', label: 'Clean sheet', icon: 'shield',
          picks: ranked('cleanSheet', p => p.broadPosition === 'GKP' || p.broadPosition === 'DEF', () =>
            `${team.defcon}/100 team DEFCON against an attack averaging ${opponentAttackPerMatch.toFixed(2)} xGI per start.`)
        },
        {
          key: 'saves', label: 'Save potential', icon: 'front_hand',
          picks: ranked('saves', p => p.broadPosition === 'GKP', p =>
            `${p.rates.saves90} saves/90 offers a second route to points if the clean sheet goes.`)
        },
        {
          key: 'defcon', label: 'DEFCON + bonus', icon: 'security',
          picks: ranked('defcon', p => p.broadPosition === 'DEF' || p.broadPosition === 'MID', p =>
            `${p.rates.defcon90} defensive contributions/90 with ${p.bonus} bonus points.`)
        },
        {
          key: 'value', label: 'Minutes + value', icon: 'savings',
          picks: ranked('value', () => true, p =>
            `${p.minutesSecurity}% minutes security at £${(p.nowCost / 10).toFixed(1)}m.`)
        }
      ].filter(group => group.picks.length > 0);
    };

    // Get fixtures for selected GW
    const gwFixtures = fixtures.filter(f => f.event === selectedGW);

    // Build per-match breakdowns
    const matchBreakdowns = gwFixtures.map(fixture => {
      const homeTeam = getTeam(fixture.team_h);
      const awayTeam = getTeam(fixture.team_a);
      const home = teamAnalysisMap[fixture.team_h];
      const away = teamAnalysisMap[fixture.team_a];
      if (!home || !away) return null;

       const homeFDR = fixture.team_h_difficulty || 3;
       const awayFDR = fixture.team_a_difficulty || 3;

      // Determine danger zones for each side
      const homeDangerZone = home.strongestAttack;
      const homeDangerPlayers = home.zoneStats[homeDangerZone]?.players || [];
      const awayDangerZone = away.strongestAttack;
      const awayDangerPlayers = away.zoneStats[awayDangerZone]?.players || [];

      // Determine vulnerability zones
      const homeVulnZone = home.weakestDefence;
      const homeVulnPlayers = home.zoneStats[homeVulnZone]?.players || [];
      const awayVulnZone = away.weakestDefence;
      const awayVulnPlayers = away.zoneStats[awayVulnZone]?.players || [];

      // Best attacking picks from home team (vs away weakness)
      const homeAttackPicks = homeDangerPlayers
        .sort((a, b) => (b.xG + b.xA) - (a.xG + a.xA))
        .slice(0, 5)
        .map(p => ({
           ...p, reason: `Strongest zone: ${ZONE_LABELS[homeDangerZone]}`,
           zoneTarget: ZONE_LABELS[awayVulnZone],
           zoneMatch: homeDangerZone === awayVulnZone
         }));

      // Best attacking picks from away team (vs home weakness)
      const awayAttackPicks = awayDangerPlayers
        .sort((a, b) => (b.xG + b.xA) - (a.xG + a.xA))
        .slice(0, 5)
        .map(p => ({
           ...p, reason: `Strongest zone: ${ZONE_LABELS[awayDangerZone]}`,
           zoneTarget: ZONE_LABELS[homeVulnZone],
           zoneMatch: awayDangerZone === homeVulnZone
         }));

      // Best defensive picks from home team (if away attack is weak)
      const awayAttackTotal = away.totalXG + away.totalXA;
      const homeDefPicks = awayAttackTotal < 30 ?
        (home.zoneStats[homeVulnZone]?.players || [])
          .sort((a, b) => b.influence - a.influence)
          .slice(0, 3)
          .map(p => ({
            ...p, reason: awayAttackTotal < 20 ? 'Opponent very weak attack' : 'Opponent below avg attack',
            defensivePick: true
          })) : [];

      // Best defensive picks from away team (if home attack is weak)
      const homeAttackTotal = home.totalXG + home.totalXA;
      const awayDefPicks = homeAttackTotal < 30 ?
        (away.zoneStats[awayVulnZone]?.players || [])
          .sort((a, b) => b.influence - a.influence)
          .slice(0, 3)
          .map(p => ({
            ...p, reason: homeAttackTotal < 20 ? 'Opponent very weak attack' : 'Opponent below avg attack',
            defensivePick: true
          })) : [];

      // DEFCON matchup
      const homeDefconAdvantage = home.defcon - away.defcon;

      // Top 3 players each side by form
      const homeTopByForm = playersWithZones
        .filter(p => p.team === fixture.team_h && p.minutes > 100)
        .sort((a, b) => b.form - a.form)
        .slice(0, 3)
        .map(p => ({ name: p.name, position: p.broadPosition, form: p.form, cost: p.nowCost, code: p.code, xGI: p.expectedGoalInvolvements, pts: p.totalPoints }));

      const awayTopByForm = playersWithZones
        .filter(p => p.team === fixture.team_a && p.minutes > 100)
        .sort((a, b) => b.form - a.form)
        .slice(0, 3)
        .map(p => ({ name: p.name, position: p.broadPosition, form: p.form, cost: p.nowCost, code: p.code, xGI: p.expectedGoalInvolvements, pts: p.totalPoints }));

      const homeTargets = buildTargetGroups(fixture.team_h, home, away, homeFDR, true);
      const awayTargets = buildTargetGroups(fixture.team_a, away, home, awayFDR, false);

      // Combined best 4 picks across both teams, ranked by expected points (holistic model)
      const allPicks = [...homeTargets, ...awayTargets]
        .flatMap(g => g.picks.map(p => ({ ...p, sourceGroup: g.key, sourceLabel: g.label, sourceIcon: g.icon })))
        .filter(p => (p.minutesSecurity || 0) >= 60)
        .map(p => {
          // Determine the dominant route for the reason
          const isAttacking = p.sourceGroup === 'goals' || p.sourceGroup === 'assists';
          const isDefensive = p.sourceGroup === 'cleanSheet' || p.sourceGroup === 'defcon';
          const isGK = p.sourceGroup === 'saves';
          const route = isAttacking ? 'attacking threat' : isDefensive ? 'defensive solidity' : isGK ? 'save potential' : 'overall value';
          return { ...p, score: p.compositeScore || p.score, reason: `${p.reason} Best route: ${route}.` };
        })
        .sort((a, b) => (b.score || 0) - (a.score || 0) || (b.minutesSecurity || 0) - (a.minutesSecurity || 0));
      const seen = new Set();
      const bestPicks = [];
      for (const pick of allPicks) {
        if (bestPicks.length >= 4) break;
        if (seen.has(pick.id)) continue;
        seen.add(pick.id);
        bestPicks.push(pick);
      }

      return {
        fixture: {
          id: fixture.id,
          gw: selectedGW, homeTeam: home.teamName, awayTeam: away.teamName,
          homeTeamFull: home.teamFullName, awayTeamFull: away.teamFullName,
          homeFDR, awayFDR, difficulty: homeFDR,
          kickoff: fixture.kickoff_time || null,
          team_h: fixture.team_h, team_a: fixture.team_a,
          team_h_score: fixture.team_h_score, team_a_score: fixture.team_a_score,
          finished: fixture.finished || false
         },
         home: {
           teamName: home.teamName, teamFullName: home.teamFullName,
           zoneStats: home.zoneStats,
           strongestAttack: home.strongestAttack, strongestAttackZone: home.strongestAttackZone,
           weakestDefence: home.weakestDefence, weakestDefenceZone: home.weakestDefenceZone,
           gk: home.gk, totalXG: home.totalXG, totalXA: home.totalXA,
           totalGoals: home.totalGoals, totalAssists: home.totalAssists, totalGC: home.totalGC,
          defcon: home.defcon, defconLabel: home.defconLabel,
           teamCS: home.teamCS, topDefender: home.topDefender,
           attackPicks: homeAttackPicks, defPicks: homeDefPicks,
           topByForm: homeTopByForm, targetGroups: homeTargets
         },
         away: {
           teamName: away.teamName, teamFullName: away.teamFullName,
           zoneStats: away.zoneStats,
           strongestAttack: away.strongestAttack, strongestAttackZone: away.strongestAttackZone,
           weakestDefence: away.weakestDefence, weakestDefenceZone: away.weakestDefenceZone,
           gk: away.gk, totalXG: away.totalXG, totalXA: away.totalXA,
           totalGoals: away.totalGoals, totalAssists: away.totalAssists, totalGC: away.totalGC,
          defcon: away.defcon, defconLabel: away.defconLabel,
           teamCS: away.teamCS, topDefender: away.topDefender,
           attackPicks: awayAttackPicks, defPicks: awayDefPicks,
           topByForm: awayTopByForm, targetGroups: awayTargets
        },
        homeDefconAdvantage,
        prediction: homeAttackTotal > awayAttackTotal ? home.teamName :
                    awayAttackTotal > homeAttackTotal ? away.teamName : 'Even',
        bestPicks
      };
    }).filter(Boolean);

    // Build overall recommendations for next 5 GWs
    const allRecommendations = [];
    const nextGWs = [];
    for (let gw = currentGW; gw <= Math.min(currentGW + 5, 38); gw++) {
      nextGWs.push(gw);
      const gwFxs = fixtures.filter(f => f.event === gw);
      gwFxs.forEach(fixture => {
        const home = teamAnalysisMap[fixture.team_h];
        const away = teamAnalysisMap[fixture.team_a];
        if (!home || !away) return;

        const isHome = true;

        // Attacking picks
        const homeAtkPlayers = home.zoneStats[home.strongestAttack]?.players || [];
        const awayAtkPlayers = away.zoneStats[away.strongestAttack]?.players || [];

        if (homeAtkPlayers.length > 0) {
           const zoneMatch = home.strongestAttack === away.weakestDefence;
          allRecommendations.push({
            gw, attackingTeam: home.teamName, defendingTeam: away.teamName,
            isHome: true, type: 'attack',
            attackZone: home.strongestAttackZone, weakZone: away.weakestDefenceZone,
            zoneMatch, strength: Math.round((home.zoneStats[home.strongestAttack].xG + home.zoneStats[home.strongestAttack].xA) * 10) / 10,
            players: homeAtkPlayers.sort((a, b) => (b.xG + b.xA) - (a.xG + a.xA)).slice(0, 5)
          });
        }
        if (awayAtkPlayers.length > 0) {
           const zoneMatch = away.strongestAttack === home.weakestDefence;
          allRecommendations.push({
            gw, attackingTeam: away.teamName, defendingTeam: home.teamName,
            isHome: false, type: 'attack',
            attackZone: away.strongestAttackZone, weakZone: home.weakestDefenceZone,
            zoneMatch, strength: Math.round((away.zoneStats[away.strongestAttack].xG + away.zoneStats[away.strongestAttack].xA) * 10) / 10,
            players: awayAtkPlayers.sort((a, b) => (b.xG + b.xA) - (a.xG + a.xA)).slice(0, 5)
          });
        }

        // Defensive picks (when opponent attack is weak)
        if (away.totalXG + away.totalXA < 30 && home.zoneStats[home.weakestDefence]?.players.length > 0) {
          allRecommendations.push({
            gw, attackingTeam: home.teamName, defendingTeam: away.teamName,
            isHome: true, type: 'defence',
            reason: `vs weak attack (${(away.totalXG + away.totalXA).toFixed(1)} xGI)`,
            strength: Math.round(home.defcon),
            players: home.zoneStats[home.weakestDefence].players
              .sort((a, b) => b.influence - a.influence).slice(0, 3)
              .map(p => ({ ...p, defensivePick: true }))
          });
        }
        if (home.totalXG + home.totalXA < 30 && away.zoneStats[away.weakestDefence]?.players.length > 0) {
          allRecommendations.push({
            gw, attackingTeam: away.teamName, defendingTeam: home.teamName,
            isHome: false, type: 'defence',
            reason: `vs weak attack (${(home.totalXG + home.totalXA).toFixed(1)} xGI)`,
            strength: Math.round(away.defcon),
            players: away.zoneStats[away.weakestDefence].players
              .sort((a, b) => b.influence - a.influence).slice(0, 3)
              .map(p => ({ ...p, defensivePick: true }))
          });
        }
      });
    }

    allRecommendations.sort((a, b) => b.strength - a.strength);

    const responseData = {
      currentGW, selectedGW, nextGWs,
      matchBreakdowns,
      recommendations: allRecommendations.slice(0, 50),
      teamAnalysis: Object.values(teamAnalysisMap).sort((a, b) => b.totalXG - a.totalXG),
      zoneLabels: ZONE_LABELS
    };
    // Cache in Redis
    if (redis) {
      try { await redis.setex(cacheKey, ZONE_ANALYSIS_TTL, responseData); } catch (e) { /* ignore */ }
    }
    res.json(responseData);
  } catch (e) {
    logger.error({ err: e }, 'Zone analysis error');
    res.status(500).json({ error: 'Failed to perform zone analysis' });
  }
});

// ---- Fixtures Detail (Next 5 GWs for all teams) ----
router.get('/fixtures-detail', async (req, res) => {
  try {
    const [bs, fixtures] = await Promise.all([
      getCachedApiData(BOOTSTRAP_URL),
      getCachedApiData(FIXTURES_URL)
    ]);

    const teams = bs.teams;
    const elements = bs.elements;
    const currentGW = bs.events.find(e => e.is_current)?.id || 1;
    const selectedGW = parseInt(req.query.gw) || currentGW;
    const getTeam = id => teams.find(t => t.id === id) || { short_name: '?', name: 'Unknown' };

    // Build per-GW fixture lists for next 5 GWs
    const gwSchedule = {};
    for (let gw = selectedGW; gw <= Math.min(selectedGW + 4, 38); gw++) {
      const gwFxs = fixtures.filter(f => f.event === gw).map(f => ({
        homeTeam: getTeam(f.team_h).short_name,
        awayTeam: getTeam(f.team_a).short_name,
        homeTeamFull: getTeam(f.team_h).name,
        awayTeamFull: getTeam(f.team_a).name,
        difficulty: f.difficulty || 3,
        team_h: f.team_h, team_a: f.team_a,
        kickoff: f.kickoff_time || null,
        team_h_score: f.team_h_score, team_a_score: f.team_a_score
      }));
      gwSchedule[gw] = gwFxs;
    }

    // Per-team next 5 fixtures with top 5 players by form
    const teamFixtures = teams.map(team => {
      const nextFixtures = [];
      for (let gw = selectedGW; gw <= Math.min(selectedGW + 4, 38); gw++) {
        const fx = fixtures.find(f => f.event === gw && (f.team_h === team.id || f.team_a === team.id));
        if (fx) {
          const isHome = fx.team_h === team.id;
          const opp = getTeam(isHome ? fx.team_a : fx.team_h);
          nextFixtures.push({
            gw, opponent: opp.short_name, opponentFull: opp.name,
            isHome, difficulty: fx.difficulty || 3,
            kickoff: fx.kickoff_time || null
          });
        }
      }

      // Top 5 players by form in last 3 GWs (or overall form if no GW data)
      const teamPlayers = elements
        .filter(e => e.team === team.id && e.minutes > 0)
        .sort((a, b) => parseFloat(b.form) - parseFloat(a.form))
        .slice(0, 5)
        .map(p => ({
          name: p.web_name, position: POSITION_MAP[p.element_type - 1],
          form: parseFloat(p.form) || 0, totalPoints: p.total_points || 0,
          pointsPerGame: parseFloat(p.points_per_game) || 0,
          xGI: parseFloat(p.expected_goal_involvements) || 0,
          cost: p.now_cost || 0, code: p.code, selectedBy: parseFloat(p.selected_by_percent) || 0,
          goals: p.goals_scored || 0, assists: p.assists || 0,
          ictIndex: parseFloat(p.ict_index) || 0
        }));

      // Rolling FDR for 3/5/10 GW windows
      const rollingFDR = {};
      [3, 5, 10].forEach(window => {
        let sum = 0, count = 0;
        for (let gw = selectedGW; gw < Math.min(selectedGW + window, 39); gw++) {
          const fx = fixtures.find(f => f.event === gw && (f.team_h === team.id || f.team_a === team.id));
          if (fx) {
            sum += fx.team_h === team.id ? (fx.team_h_difficulty || 3) : (fx.team_a_difficulty || 3);
            count++;
          }
        }
        rollingFDR[`fdr_${window}gw`] = count > 0 ? Math.round((sum / count) * 100) / 100 : 3;
        rollingFDR[`fdrSum_${window}gw`] = sum;
      });

      const fdrSum = nextFixtures.reduce((s, f) => s + f.difficulty, 0);
      const avgFDR = nextFixtures.length > 0 ? (fdrSum / nextFixtures.length).toFixed(1) : '—';

      return {
        teamId: team.id, teamName: team.short_name, teamFullName: team.name,
        nextFixtures, fdrSum, avgFDR, ...rollingFDR,
        topPlayers: teamPlayers
      };
    });

    res.json({
      currentGW, selectedGW, gwSchedule, teamFixtures
    });
  } catch (e) {
    logger.error({ err: e }, 'Fixtures detail error');
    res.status(500).json({ error: 'Failed to fetch fixture details' });
  }
});

// ---- Team Projections (Goals & Clean Sheet Odds per GW) ----
router.get('/team-projections', async (req, res) => {
  try {
    const [bs, fixtures] = await Promise.all([
      getCachedApiData(BOOTSTRAP_URL),
      getCachedApiData(FIXTURES_URL)
    ]);

    const teams = bs.teams || [];
    const elements = bs.elements || [];
    const currentGW = bs.events?.find(e => e.is_current)?.id || bs.events?.find(e => e.is_next)?.id || 1;
    const selectedGW = parseInt(req.query.gw) || currentGW;
    const getTeam = id => teams.find(t => t.id === id) || { id, short_name: '???', name: 'Unknown' };

    const gwFixtures = fixtures.filter(f => f.event === selectedGW);

    const formatDay = (kickoffTime) => {
      if (!kickoffTime) return 'TBD';
      const d = new Date(kickoffTime);
      if (isNaN(d.getTime())) return 'TBD';
      const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
      const day = days[d.getUTCDay()];
      const dd = String(d.getUTCDate()).padStart(2, '0');
      const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
      return `${day} ${dd}/${mm}`;
    };

    // --- Team-level projections using Dixon-Coles model ---
    const teamProj = require('../teamProjectionModel');

    // Build team ID -> short_name map
    const teamIdMap = {};
    teams.forEach(t => { teamIdMap[t.id] = t.short_name; });

    // Project each fixture with full Dixon-Coles model
    const matchProjections = gwFixtures.map(f => {
      const homeTeam = getTeam(f.team_h);
      const awayTeam = getTeam(f.team_a);
      const proj = teamProj.projectFixture(homeTeam.short_name, awayTeam.short_name, teamProj.computeTeamRatings());

      return {
        id: f.id,
        gw: selectedGW,
        kickoff: f.kickoff_time || null,
        dayStr: formatDay(f.kickoff_time),
        finished: f.finished || false,
        score: f.finished ? `${f.team_h_score} - ${f.team_a_score}` : null,
        homeTeam: {
          id: homeTeam.id, name: homeTeam.name, shortName: homeTeam.short_name,
          projectedGoals: proj.homeXG,
          cleanSheetPct: proj.homeCleanSheet,
          winPct: proj.homeWin,
          drawPct: proj.draw,
          fdr: f.team_h_difficulty || 3,
        },
        awayTeam: {
          id: awayTeam.id, name: awayTeam.name, shortName: awayTeam.short_name,
          projectedGoals: proj.awayXG,
          cleanSheetPct: proj.awayCleanSheet,
          winPct: proj.awayWin,
          drawPct: proj.draw,
          fdr: f.team_a_difficulty || 3,
        },
        probabilities: {
          homeWin: proj.homeWin,
          draw: proj.draw,
          awayWin: proj.awayWin,
          btts: proj.bttsYes,
          over15: proj.over15,
          over25: proj.over25,
          over35: proj.over35,
        },
      };
    });

    // Goals leaderboard — sorted by xG
    const goalsList = matchProjections.flatMap(m => [
      { teamId: m.homeTeam.id, team: m.homeTeam.shortName, teamName: m.homeTeam.name, opponent: m.awayTeam.shortName, goals: m.homeTeam.projectedGoals, csPct: m.homeTeam.cleanSheetPct, fdr: m.homeTeam.fdr, isHome: true },
      { teamId: m.awayTeam.id, team: m.awayTeam.shortName, teamName: m.awayTeam.name, opponent: m.homeTeam.shortName, goals: m.awayTeam.projectedGoals, csPct: m.awayTeam.cleanSheetPct, fdr: m.awayTeam.fdr, isHome: false },
    ]).sort((a, b) => b.goals - a.goals);

    // CS leaderboard — sorted by clean sheet probability
    const csList = matchProjections.flatMap(m => [
      { teamId: m.homeTeam.id, team: m.homeTeam.shortName, teamName: m.homeTeam.name, opponent: m.awayTeam.shortName, csPct: m.homeTeam.cleanSheetPct, xG: m.homeTeam.projectedGoals, fdr: m.homeTeam.fdr, isHome: true },
      { teamId: m.awayTeam.id, team: m.awayTeam.shortName, teamName: m.awayTeam.name, opponent: m.homeTeam.shortName, csPct: m.awayTeam.cleanSheetPct, xG: m.awayTeam.projectedGoals, fdr: m.awayTeam.fdr, isHome: false },
    ]).sort((a, b) => b.csPct - a.csPct);

    goalsList.forEach((item, index) => { item.rank = index + 1; });
    csList.forEach((item, index) => { item.rank = index + 1; });

    // Win probability leaderboard
    const winList = matchProjections.flatMap(m => [
      { teamId: m.homeTeam.id, team: m.homeTeam.shortName, teamName: m.homeTeam.name, opponent: m.awayTeam.shortName, winPct: m.homeTeam.winPct, drawPct: m.homeTeam.drawPct, xG: m.homeTeam.projectedGoals, fdr: m.homeTeam.fdr, isHome: true },
      { teamId: m.awayTeam.id, team: m.awayTeam.shortName, teamName: m.awayTeam.name, opponent: m.homeTeam.shortName, winPct: m.awayTeam.winPct, drawPct: m.awayTeam.drawPct, xG: m.awayTeam.projectedGoals, fdr: m.awayTeam.fdr, isHome: false },
    ]).sort((a, b) => b.winPct - a.winPct);

    res.json({
      gw: selectedGW,
      currentGW,
      availableGWs: Array.from({ length: 38 }, (_, i) => i + 1),
      projectionSource: 'dixon-coles',
      matchProjections,
      teamsToTarget: {
        projectedGoals: goalsList,
        cleanSheets: csList,
        winProbability: winList,
      },
    });
  } catch (e) {
    logger.error({ err: e }, 'Team projections error');
    res.status(500).json({ error: 'Failed to calculate team projections' });
  }
});

// ---- Goals Scored Projections (multi-GW Poisson model) ----
router.get('/goals-projections', async (req, res) => {
  try {
    const [bs, fixtures] = await Promise.all([
      getCachedApiData(BOOTSTRAP_URL),
      getCachedApiData(FIXTURES_URL)
    ]);

    const teams = bs.teams || [];
    const currentGW = bs.events?.find(e => e.is_current)?.id || bs.events?.find(e => e.is_next)?.id || 1;
    const startGW = parseInt(req.query.gw) || currentGW;
    const horizon = Math.min(parseInt(req.query.horizon) || 6, 15);

    const teamProj = require('../teamProjectionModel');
    const teamIdMap = {};
    teams.forEach(t => { teamIdMap[t.id] = t.short_name; });

    const projections = teamProj.projectMultiGWTeams(teams, fixtures, teamIdMap, startGW, horizon);

    // Build ranked list for the full horizon
    const ranked = Object.values(projections)
      .sort((a, b) => b.totalXG - a.totalXG)
      .map((team, idx) => ({
        rank: idx + 1,
        teamId: team.teamId,
        team: team.teamName,
        teamFullName: team.teamFullName,
        totalXG: team.totalXG,
        avgXG: team.avgXG,
        gameweeks: team.gameweeks,
        fdr3gw: Math.round((team.gameweeks.slice(0, 3).reduce((s, g) => s + g.fdr, 0) / Math.max(team.gameweeks.slice(0, 3).length, 1)) * 100) / 100,
        fdr5gw: Math.round((team.gameweeks.slice(0, 5).reduce((s, g) => s + g.fdr, 0) / Math.max(team.gameweeks.slice(0, 5).length, 1)) * 100) / 100,
      }));

    // Per-GW breakdown
    const perGW = {};
    for (let gw = startGW; gw < Math.min(startGW + horizon, 39); gw++) {
      perGW[gw] = [];
      ranked.forEach(team => {
        const gwData = team.gameweeks.find(g => g.gw === gw);
        if (gwData) {
          perGW[gw].push({
            team: team.team,
            opponent: gwData.opponent,
            isHome: gwData.isHome,
            xg: gwData.xg,
            fdr: gwData.fdr,
          });
        }
      });
      perGW[gw].sort((a, b) => b.xg - a.xg);
    }

    res.json({
      startGW,
      horizon,
      currentGW,
      ranked,
      perGW,
      modelVersion: 'Dixon-Coles (2024-25 xG data)',
    });
  } catch (e) {
    logger.error({ err: e }, 'Goals projections error');
    res.status(500).json({ error: 'Failed to calculate goals projections' });
  }
});

// ---- Goals Conceded Projections (multi-GW Poisson model) ----
router.get('/goals-conceded', async (req, res) => {
  try {
    const [bs, fixtures] = await Promise.all([
      getCachedApiData(BOOTSTRAP_URL),
      getCachedApiData(FIXTURES_URL)
    ]);

    const teams = bs.teams || [];
    const currentGW = bs.events?.find(e => e.is_current)?.id || bs.events?.find(e => e.is_next)?.id || 1;
    const startGW = parseInt(req.query.gw) || currentGW;
    const horizon = Math.min(parseInt(req.query.horizon) || 6, 15);

    const teamProj = require('../teamProjectionModel');
    const teamIdMap = {};
    teams.forEach(t => { teamIdMap[t.id] = t.short_name; });

    const projections = teamProj.projectMultiGWTeams(teams, fixtures, teamIdMap, startGW, horizon);

    // Build ranked list sorted by fewest goals conceded (best defenses first)
    const ranked = Object.values(projections)
      .sort((a, b) => a.totalXGA - b.totalXGA)
      .map((team, idx) => ({
        rank: idx + 1,
        teamId: team.teamId,
        team: team.teamName,
        teamFullName: team.teamFullName,
        totalXGA: team.totalXGA,
        avgXGA: team.avgXGA,
        totalCS: team.totalCS,
        avgCS: team.avgCS,
        gameweeks: team.gameweeks,
        fdr3gw: Math.round((team.gameweeks.slice(0, 3).reduce((s, g) => s + g.fdr, 0) / Math.max(team.gameweeks.slice(0, 3).length, 1)) * 100) / 100,
        fdr5gw: Math.round((team.gameweeks.slice(0, 5).reduce((s, g) => s + g.fdr, 0) / Math.max(team.gameweeks.slice(0, 5).length, 1)) * 100) / 100,
      }));

    // Per-GW breakdown
    const perGW = {};
    for (let gw = startGW; gw < Math.min(startGW + horizon, 39); gw++) {
      perGW[gw] = [];
      ranked.forEach(team => {
        const gwData = team.gameweeks.find(g => g.gw === gw);
        if (gwData) {
          perGW[gw].push({
            team: team.team,
            opponent: gwData.opponent,
            isHome: gwData.isHome,
            xga: gwData.xga,
            csPct: gwData.csPct,
            fdr: gwData.fdr,
          });
        }
      });
      perGW[gw].sort((a, b) => a.xga - b.xga);
    }

    res.json({
      startGW,
      horizon,
      currentGW,
      ranked,
      perGW,
      modelVersion: 'Dixon-Coles (2024-25 xG data)',
    });
  } catch (e) {
    logger.error({ err: e }, 'Goals conceded projections error');
    res.status(500).json({ error: 'Failed to calculate goals conceded projections' });
  }
});

// ---- Rolling Fixture Difficulty (3/5/10 GW) ----
router.get('/rolling-fdr', async (req, res) => {
  try {
    const [bs, fixtures] = await Promise.all([
      getCachedApiData(BOOTSTRAP_URL),
      getCachedApiData(FIXTURES_URL)
    ]);

    const teams = bs.teams || [];
    const currentGW = bs.events?.find(e => e.is_current)?.id || bs.events?.find(e => e.is_next)?.id || 1;
    const startGW = parseInt(req.query.gw) || currentGW;

    const windows = [3, 5, 10];
    const result = {};

    windows.forEach(window => {
      result[window] = computeRollingFDR(teams, fixtures, startGW, window);
    });

    // Build combined ranking
    const combined = teams.map(t => ({
      teamId: t.id,
      team: t.short_name,
      teamFullName: t.name,
      fdr3gw: result[3]?.[t.id]?.avgFDR || 3,
      fdr5gw: result[5]?.[t.id]?.avgFDR || 3,
      fdr10gw: result[10]?.[t.id]?.avgFDR || 3,
      fdrSum3gw: result[3]?.[t.id]?.sumFDR || 0,
      fdrSum5gw: result[5]?.[t.id]?.sumFDR || 0,
      fdrSum10gw: result[10]?.[t.id]?.sumFDR || 0,
    }));

    res.json({ startGW, currentGW, windows, combined, detailed: result });
  } catch (e) {
    logger.error({ err: e }, 'Rolling FDR error');
    res.status(500).json({ error: 'Failed to calculate rolling FDR' });
  }
});

// ---- Captain Picks ----
router.get('/captain-picks', async (req, res) => {
  try {
    const [bootstrap, fixtures] = await Promise.all([
      getCachedApiData(BOOTSTRAP_URL),
      getCachedApiData(FIXTURES_URL)
    ]);
    res.json(buildCaptaincyModel({ bootstrap, fixtures, selectedGW: req.query.gw }));
  } catch (e) {
    logger.error({ err: e }, 'Captain picks error');
    res.status(500).json({ error: 'Failed to calculate captain picks' });
  }
});

// ---- Price Change Predictor ----
router.get('/price-predictions', async (req, res) => {
  try {
    const bs = await getCachedApiData(BOOTSTRAP_URL);
    const elements = bs.elements;
    const teams = bs.teams;
    const getTeam = id => teams.find(t => t.id === id);

    // Price change formula based on transfer velocity and current cost
    const players = elements
      .filter(p => p.status !== 'u' && p.status !== 's')
      .map(p => {
        const netTransfers = (p.transfers_in_event || 0) - (p.transfers_out_event || 0);
        const cost = p.now_cost || 50;
        const ownership = parseFloat(p.selected_by_percent) || 0;
        
        // Simple price change velocity model
        // Positive = likely to rise, Negative = likely to fall
        const velocity = netTransfers / Math.max(ownership, 1) * 100;
        
        // Estimate hours until change (rough approximation)
        const absVelocity = Math.abs(velocity);
        let hoursUntilChange = null;
        if (absVelocity > 50) hoursUntilChange = Math.max(1, Math.round(48 - absVelocity * 0.5));
        else if (absVelocity > 20) hoursUntilChange = Math.round(48 + (50 - absVelocity) * 2);
        else if (absVelocity > 5) hoursUntilChange = Math.round(72 + (20 - absVelocity) * 5);

        return {
          id: p.id, name: p.web_name, code: p.code,
          team: getTeam(p.team)?.short_name || '',
          position: POSITION_MAP[p.element_type - 1],
          cost: cost, costStr: '£' + (cost / 10).toFixed(1) + 'm',
          netTransfers, velocity: Math.round(velocity * 10) / 10,
          hoursUntilChange,
          ownership,
          direction: velocity > 0 ? 'up' : velocity < 0 ? 'down' : 'stable',
          // Price already changed today
          priceChanged: p.cost_change_event !== 0,
          priceChangeAmount: p.cost_change_event
        };
      })
      .sort((a, b) => Math.abs(b.velocity) - Math.abs(a.velocity));

    const risers = players.filter(p => p.velocity > 0 && !p.priceChanged).slice(0, 20);
    const fallers = players.filter(p => p.velocity < 0 && !p.priceChanged).slice(0, 20);
    const recentChanges = elements
      .filter(p => p.cost_change_event !== 0)
      .map(p => ({
        id: p.id, name: p.web_name, code: p.code,
        team: getTeam(p.team)?.short_name || '',
        position: POSITION_MAP[p.element_type - 1],
        cost: p.now_cost, change: p.cost_change_event,
        direction: p.cost_change_event > 0 ? 'up' : 'down'
      }))
      .sort((a, b) => Math.abs(b.change) - Math.abs(a.change));

    res.json({ risers, fallers, recentChanges });
  } catch (e) {
    logger.error({ err: e }, 'Price predictions error');
    res.status(500).json({ error: 'Failed to calculate predictions' });
  }
});

// ---- League Standings (classic proxy) ----
router.get('/leagues-classic/:leagueId/standings', heavyEndpointLimiter, async (req, res) => {
  const leagueId = parsePositiveId(req.params.leagueId);
  if (!leagueId) return res.status(400).json({ error: 'A valid leagueId is required' });
  try {
    const page = Math.min(5, Math.max(1, parseInt(req.query.page) || 1));
    
    const data = await getCachedApiData(`https://fantasy.premierleague.com/api/leagues-classic/${leagueId}/standings/?page_standings=${page}`);

    const leagueInfo = data.league || {};
    const standingsData = data.standings || {};
    const results = standingsData.results || [];
    
    let leaderTotal = 0;
    if (page === 1 && results.length > 0) {
      leaderTotal = results[0].total || 0;
    } else {
      try {
        const page1Data = await getCachedApiData(`https://fantasy.premierleague.com/api/leagues-classic/${leagueId}/standings/?page_standings=1`);
        leaderTotal = page1Data?.standings?.results?.[0]?.total || 0;
      } catch (e) {
        leaderTotal = results[0]?.total || 0;
      }
    }

    // If no results from FPL API (season not started or no data yet), return no-data response
    if (results.length === 0) {
      return res.json({
        leagueId: parseInt(leagueId) || 314,
        leagueName: leagueInfo.name || `Overall Top 50k`,
        leagueType: 'Public Global',
        page: 1,
        totalPages: 0,
        totalEntries: 0,
        hasMore: false,
        noData: true,
        managers: []
      });
    }

    const managers = results.map((entry) => ({
      rank: entry.rank,
      managerName: entry.player_name,
      entryName: entry.entry_name,
      eventTotal: entry.event_total || 0,
      total: entry.total || 0,
      rankDiff: (entry.last_rank || entry.rank) - entry.rank,
      diffCount: Math.max(0, leaderTotal - (entry.total || 0))
    }));
    const eventScores = managers.map(manager => manager.eventTotal);

    return res.json({
      leagueId: parseInt(leagueId),
      leagueName: leagueInfo.name || `League ${leagueId}`,
      leagueType: leagueInfo.league_type === 'x' ? 'Classic League' : 'Public Global',
      page,
      totalPages: standingsData.has_next ? Math.min(5, page + 1) : page,
      totalEntries: standingsData.has_next ? Math.max(page * 50 + 1, managers.length) : ((page - 1) * 50) + managers.length,
      hasMore: Boolean(standingsData.has_next),
      noData: false,
      leagueAvgGW: eventScores.length ? Math.round(eventScores.reduce((sum, score) => sum + score, 0) / eventScores.length) : 0,
      topScoreGW: eventScores.length ? Math.max(...eventScores) : 0,
      topScorerManager: managers.find(manager => manager.eventTotal === Math.max(...eventScores))?.managerName || '',
      topScorerTeam: managers.find(manager => manager.eventTotal === Math.max(...eventScores))?.entryName || '',
      managers
    });
  } catch (e) {
    logger.error({ err: e }, 'League standings error');
    res.status(500).json({ error: 'Failed to fetch league standings' });
  }
});

// ---- Dashboard Overview ----
router.get('/dashboard/overview', async (req, res) => {
  try {
    const bs = await getCachedApiData(BOOTSTRAP_URL);
    const fixtures = await getCachedApiData(FIXTURES_URL);

    const elements = bs.elements || [];
    const teams = bs.teams || [];
    const events = bs.events || [];
    const currentEvent = events.find(e => e.is_current) || events.find(e => e.is_next) || events[0];
    const nextEvent = events.find(e => e.is_next) || currentEvent;
    const currentGW = currentEvent?.id || 1;
    const projectionGW = nextEvent?.id || currentGW;

    const getTeam = id => teams.find(t => t.id === id);
    const getPosStr = type => {
      if (type === 1) return 'GK';
      if (type === 2) return 'DEF';
      if (type === 3) return 'MID';
      if (type === 4) return 'FWD';
      return 'DEF';
    };

    const gwAverage = currentEvent?.average_entry_score || 42;
    const highestScore = currentEvent?.highest_score || 118;
    const totalTransfers = currentEvent?.transfers_made ? (currentEvent.transfers_made / 1000000).toFixed(1) + 'M' : '3.4M';

    const mostSelected = [...elements]
      .sort((a, b) => parseFloat(b.selected_by_percent) - parseFloat(a.selected_by_percent))
      .slice(0, 5)
      .map(p => {
        const team = getTeam(p.team);
        const formVal = parseFloat(p.form || 0);
        const xPPG = Number.parseFloat(p.ep_next || p.points_per_game || 0).toFixed(1);
        let fdrClass = 'fdr-3';
        if (formVal >= 6.0) fdrClass = 'fdr-1';
        else if (formVal >= 4.5) fdrClass = 'fdr-2';
        else if (formVal >= 3.0) fdrClass = 'fdr-3';
        else if (formVal >= 2.0) fdrClass = 'fdr-4';
        else fdrClass = 'fdr-5';

        return {
          id: p.id,
          code: p.code,
          name: p.web_name,
          team: team ? team.short_name : 'FPL',
          pos: getPosStr(p.element_type),
          selectedBy: p.selected_by_percent + '%',
          xPPG,
          fdrClass
        };
      });

    const topTransfersIn = [...elements]
      .sort((a, b) => (b.transfers_in_event || b.transfers_in || 0) - (a.transfers_in_event || a.transfers_in || 0))
      .slice(0, 5)
      .map(p => {
        const team = getTeam(p.team);
        const count = p.transfers_in_event || p.transfers_in || 0;
        return {
          id: p.id,
          code: p.code,
          name: p.web_name,
          team: team ? team.short_name : 'FPL',
          pos: getPosStr(p.element_type),
          price: (p.now_cost / 10).toFixed(1),
          transfersCount: '+' + count.toLocaleString()
        };
      });

    const topTransfersOut = [...elements]
      .sort((a, b) => (b.transfers_out_event || b.transfers_out || 0) - (a.transfers_out_event || a.transfers_out || 0))
      .slice(0, 5)
      .map(p => {
        const team = getTeam(p.team);
        const count = p.transfers_out_event || p.transfers_out || 0;
        return {
          id: p.id,
          code: p.code,
          name: p.web_name,
          team: team ? team.short_name : 'FPL',
          pos: getPosStr(p.element_type),
          price: (p.now_cost / 10).toFixed(1),
          transfersCount: '-' + count.toLocaleString()
        };
      });

    const priceRisers = [...elements]
      .filter(p => p.cost_change_event > 0 || p.transfers_in_event > 50000)
      .sort((a, b) => b.transfers_in_event - a.transfers_in_event)
      .slice(0, 2);

    const priceFallers = [...elements]
      .filter(p => p.cost_change_event < 0 || p.transfers_out_event > 50000)
      .sort((a, b) => b.transfers_out_event - a.transfers_out_event)
      .slice(0, 2);

    const priceChanges = [
      ...priceRisers.map(p => ({
        name: p.web_name,
        team: getTeam(p.team)?.short_name || 'FPL',
        price: '£' + (p.now_cost / 10).toFixed(1) + 'm',
        direction: 'up'
      })),
      ...priceFallers.map(p => ({
        name: p.web_name,
        team: getTeam(p.team)?.short_name || 'FPL',
        price: '£' + (p.now_cost / 10).toFixed(1) + 'm',
        direction: 'down'
      }))
    ];

    const injuryNews = [...elements]
      .filter(p => p.news && p.news.trim() !== '' && (p.status === 'i' || p.status === 's' || p.status === 'd' || p.status === 'u'))
      .sort((a, b) => {
        const statusOrder = { i: 0, s: 1, d: 2, u: 3 };
        return (statusOrder[a.status] || 4) - (statusOrder[b.status] || 4);
      })
      .slice(0, 6)
      .map(p => {
        const team = getTeam(p.team);
        const statusMap = { i: 'Injured', s: 'Suspended', d: 'Doubtful', u: 'Unavailable' };
        return {
          name: p.web_name,
          team: team ? team.short_name : 'FPL',
          pos: getPosStr(p.element_type),
          status: statusMap[p.status] || p.status,
          statusKey: p.status,
          news: p.news,
          chanceNextGw: p.chance_next_gw
        };
      });

    const nextGWs = Array.from({ length: Math.min(5, 39 - projectionGW) }, (_, index) => projectionGW + index);

    const fdrGrid = teams.map(team => {
      const tId = team.id;
      const teamObj = getTeam(tId);
      const teamShort = teamObj ? teamObj.short_name : 'TEAM';

      const teamFixes = nextGWs.map(gw => {
        const gwFixtures = fixtures.filter(f => f.event === gw && (f.team_h === tId || f.team_a === tId));
        if (!gwFixtures || gwFixtures.length === 0) {
          return { label: 'BLANK', fdr: 3 };
        }
        const labels = gwFixtures.map(f => {
          const isHome = f.team_h === tId;
          const oppId = isHome ? f.team_a : f.team_h;
          return {
            label: `${getTeam(oppId)?.short_name || 'OPP'} (${isHome ? 'H' : 'A'})`,
            fdr: (isHome ? f.team_h_difficulty : f.team_a_difficulty) || 3
          };
        });
        return labels.length === 1 ? labels[0] : labels;
      });

      return {
        team: teamShort,
        fixtures: teamFixes
      };
    });

    res.json({
      gw: currentGW,
      gwAverage,
      highestScore,
      totalTransfers,
      mostSelected,
      topTransfersIn,
      topTransfersOut,
      priceChanges,
      injuryNews,
      fdrGrid,
      nextGWs
    });
  } catch (err) {
    logger.error({ err }, 'Dashboard overview API error');
    res.status(500).json({ error: 'Failed to fetch dashboard overview data' });
  }
});

// ---- Tactical Zones ----
router.get('/tactics/zones', async (req, res) => {
  try {
    const formation = req.query.formation || '4231';
    const bs = await getCachedApiData(BOOTSTRAP_URL);
    const fixtures = await getCachedApiData(FIXTURES_URL);
    
    const elements = bs.elements || [];
    const teams = bs.teams || [];
    const currentGW = bs.events.find(e => e.is_current)?.id || 1;
    const getTeam = id => teams.find(t => t.id === id);

    const playersByPos = {
      1: elements.filter(p => p.element_type === 1 && p.minutes > 0).sort((a, b) => b.total_points - a.total_points),
      2: elements.filter(p => p.element_type === 2 && p.minutes > 0).sort((a, b) => b.total_points - a.total_points),
      3: elements.filter(p => p.element_type === 3 && p.minutes > 0).sort((a, b) => b.total_points - a.total_points),
      4: elements.filter(p => p.element_type === 4 && p.minutes > 0).sort((a, b) => b.total_points - a.total_points)
    };

    const getPlayerNode = (p, role, bottom, left) => {
      const code = p ? p.code : 118748;
      const webName = p ? p.web_name : 'Player';
      const abbr = webName.substring(0, 3).toUpperCase();
      const xGI = p ? parseFloat(p.expected_goal_involvements || 0) : 0;
      const form = p ? parseFloat(p.form || 0) : 0;
      const pts = p ? p.total_points : 0;
      return {
        id: p ? p.id : 0,
        code,
        name: webName,
        abbr,
        team: p ? getTeam(p.team)?.short_name : 'FPL',
        role,
        bottom,
        left,
        xGI,
        form,
        pts,
        highThreat: form >= 6.0 || xGI >= 5.0
      };
    };

    let nodes = [];
    if (formation === '352') {
      nodes = [
        getPlayerNode(playersByPos[1][0], 'GK', '5%', '50%'),
        getPlayerNode(playersByPos[2][0], 'LCB', '20%', '20%'),
        getPlayerNode(playersByPos[2][1], 'CB', '18%', '50%'),
        getPlayerNode(playersByPos[2][2], 'RCB', '20%', '80%'),
        getPlayerNode(playersByPos[3][0], 'LWB', '40%', '5%'),
        getPlayerNode(playersByPos[3][1], 'LCM', '38%', '28%'),
        getPlayerNode(playersByPos[3][2], 'CM', '35%', '50%'),
        getPlayerNode(playersByPos[3][3], 'RCM', '38%', '72%'),
        getPlayerNode(playersByPos[3][4], 'RWB', '40%', '95%'),
        getPlayerNode(playersByPos[4][0], 'LST', '65%', '35%'),
        getPlayerNode(playersByPos[4][1], 'RST', '65%', '65%')
      ];
    } else if (formation === '433') {
      nodes = [
        getPlayerNode(playersByPos[1][0], 'GK', '5%', '50%'),
        getPlayerNode(playersByPos[2][0], 'LB', '20%', '10%'),
        getPlayerNode(playersByPos[2][1], 'LCB', '18%', '33%'),
        getPlayerNode(playersByPos[2][2], 'RCB', '18%', '67%'),
        getPlayerNode(playersByPos[2][3], 'RB', '20%', '90%'),
        getPlayerNode(playersByPos[3][0], 'LCM', '42%', '22%'),
        getPlayerNode(playersByPos[3][1], 'CM', '38%', '50%'),
        getPlayerNode(playersByPos[3][2], 'RCM', '42%', '78%'),
        getPlayerNode(playersByPos[4][0], 'LW', '62%', '15%'),
        getPlayerNode(playersByPos[4][1], 'ST', '70%', '50%'),
        getPlayerNode(playersByPos[4][2], 'RW', '62%', '85%')
      ];
    } else {
      nodes = [
        getPlayerNode(playersByPos[1][0], 'GK', '5%', '50%'),
        getPlayerNode(playersByPos[2][0], 'LB', '20%', '10%'),
        getPlayerNode(playersByPos[2][1], 'LCB', '18%', '33%'),
        getPlayerNode(playersByPos[2][2], 'RCB', '18%', '67%'),
        getPlayerNode(playersByPos[2][3], 'RB', '20%', '90%'),
        getPlayerNode(playersByPos[3][0], 'LDM', '36%', '35%'),
        getPlayerNode(playersByPos[3][1], 'RDM', '36%', '65%'),
        getPlayerNode(playersByPos[3][2], 'LAM', '52%', '18%'),
        getPlayerNode(playersByPos[3][3], 'CAM', '55%', '50%'),
        getPlayerNode(playersByPos[3][4], 'RAM', '52%', '82%'),
        getPlayerNode(playersByPos[4][0], 'ST', '72%', '50%')
      ];
    }

    const topAttackers = elements
      .filter(p => (p.element_type === 3 || p.element_type === 4) && p.minutes > 200)
      .sort((a, b) => (parseFloat(b.form) + parseFloat(b.expected_goal_involvements || 0)) - (parseFloat(a.form) + parseFloat(a.expected_goal_involvements || 0)))
      .slice(0, 2);

    // Get real fixtures for the top attackers
    const getTeamNextFixture = (teamId) => {
      const teamFixtures = fixtures
        .filter(f => f.team_h === teamId || f.team_a === teamId)
        .sort((a, b) => a.event - b.event);
      const next = teamFixtures.find(f => f.event >= currentGW);
      if (!next) return 'TBD';
      const isHome = next.team_h === teamId;
      const oppTeam = getTeam(isHome ? next.team_a : next.team_h);
      return `vs ${oppTeam ? oppTeam.short_name : '?'} (${isHome ? 'H' : 'A'})`;
    };

    const targetZones = [
      {
        zoneName: 'Right Flank (Attacking)',
        vulnBadge: 'HIGH VULNERABILITY',
        vulnClass: 'fdr-5',
        xPts: '8.2',
        player: {
          name: topAttackers[0] ? topAttackers[0].web_name : 'B. Saka',
          code: topAttackers[0] ? topAttackers[0].code : 438098,
          fixture: topAttackers[0] ? getTeamNextFixture(topAttackers[0].team) : 'vs SHU (H)'
        }
      },
      {
        zoneName: 'Central Zone (Box 14)',
        vulnBadge: 'MODERATE EXPLOITATION',
        vulnClass: 'fdr-4',
        xPts: '6.5',
        player: {
          name: topAttackers[1] ? topAttackers[1].web_name : 'K. De Bruyne',
          code: topAttackers[1] ? topAttackers[1].code : 61366,
          fixture: topAttackers[1] ? getTeamNextFixture(topAttackers[1].team) : 'vs LUT (A)'
        }
      }
    ];

    // Build danger zones from real fixture data - find matches with high xG potential
    const teamXG = {};
    elements.forEach(p => {
      const xgc = parseFloat(p.expected_goals_conceded || 0);
      if (xgc > 0) {
        teamXG[p.team] = (teamXG[p.team] || 0) + xgc;
      }
    });

    const dangerFixtures = fixtures
      .filter(f => f.event === currentGW)
      .map(f => {
        const homeTeam = getTeam(f.team_h);
        const awayTeam = getTeam(f.team_a);
        const homeXG = teamXG[f.team_h] || 0;
        const awayXG = teamXG[f.team_a] || 0;
        const totalXG = homeXG + awayXG;
        const threatArea = totalXG > 5 ? 'Central Penalty' : totalXG > 3 ? 'Left Half-Space' : 'Right Wing';
        const tier = totalXG > 5 ? 'fdr-5' : totalXG > 3 ? 'fdr-4' : 'fdr-1';
        return {
          fixture: `${homeTeam ? homeTeam.short_name : '?'} vs ${awayTeam ? awayTeam.short_name : '?'}`,
          threatArea,
          xGConceded: totalXG.toFixed(2),
          colorTier: tier
        };
      })
      .sort((a, b) => parseFloat(b.xGConceded) - parseFloat(a.xGConceded))
      .slice(0, 3);

    const dangerZones = dangerFixtures.length > 0 ? dangerFixtures : [
      { fixture: 'No fixtures', threatArea: 'N/A', xGConceded: '0.00', colorTier: 'fdr-1' }
    ];

    res.json({
      gw: currentGW,
      formation,
      nodes,
      targetZones,
      dangerZones
    });
  } catch (err) {
    logger.error({ err }, 'Tactics zones endpoint error');
    res.status(500).json({ error: 'Failed to fetch tactical zones data' });
  }
});

// ---- Differential Finder ----
router.get('/differentials', async (req, res) => {
  try {
    const [bs, fixtures] = await Promise.all([getCachedApiData(BOOTSTRAP_URL), getCachedApiData(FIXTURES_URL)]);
    const elements = bs.elements;
    const teams = bs.teams;
    const currentGW = bs.events.find(e => e.is_current)?.id || 1;
    const getTeam = id => teams.find(t => t.id === id);

    // Use the Poisson model's rolling FDR for consistency
    const teamFDR = computeRollingFDR(fixtures, teams, currentGW, 5);

    // Calculate xGI per 90 minutes
    const differentials = elements
      .filter(p => p.total_points > 0 || parseFloat(p.form) > 0)
      .map(p => {
        const ownership = parseFloat(p.selected_by_percent) || 0;
        const xGI = parseFloat(p.expected_goal_involvements) || 0;
        const form = parseFloat(p.form) || 0;
        const totalPts = p.total_points || 0;
        const cost = p.now_cost || 50;
        const mins = p.minutes || 0;
        const xGI90 = mins > 0 ? (xGI / mins) * 90 : 0;
        const ptsPerMillion = cost > 0 ? (totalPts / (cost / 10)) : 0;
        const fdrData = teamFDR[p.team] || {};
        const avgFDR = fdrData.avgFDR != null ? fdrData.avgFDR.toFixed(1) : '3.0';

        return {
          id: p.id, name: p.web_name, code: p.code,
          team: getTeam(p.team)?.short_name || '',
          teamFull: getTeam(p.team)?.name || '',
          position: POSITION_MAP[p.element_type - 1],
          cost, costStr: '£' + (cost / 10).toFixed(1) + 'm',
          ownership, xGI, form, totalPts,
          xGI90: xGI90.toFixed(2),
          ptsPerMillion: ptsPerMillion.toFixed(1),
          avgFDR,
          minutes: mins,
          goals: p.goals_scored || 0,
          assists: p.assists || 0,
          diffScore: Math.round((xGI90 * 10 + form * 2 + ptsPerMillion) * (100 - Math.min(ownership, 50)) / 100)
        };
      })
      .filter(p => p.ownership < 15 && p.xGI > 0 && p.minutes > 200)
      .sort((a, b) => b.diffScore - a.diffScore);

    res.json({ 
      differentials: differentials.slice(0, 50),
      template: elements
        .filter(p => parseFloat(p.selected_by_percent) > 30)
        .map(p => p.web_name)
    });
  } catch (e) {
    logger.error({ err: e }, 'Differentials error');
    res.status(500).json({ error: 'Failed to calculate differentials' });
  }
});

// ---- Set Piece Takers (Official FPL Scout Data) ----
const SET_PIECE_DATA = {
  'ARS': { penalties: ['Saka','Gyökeres','Ødegaard'], freeKicks: ['Rice','Saka','Eze'], corners: ['Rice','Saka','Ødegaard','Tzolis','Madueke'] },
  'AVL': { penalties: ['Buendía','Watkins'], freeKicks: ['Buendía'], corners: ['Cash','McGinn'] },
  'BOU': { penalties: ['Kroupi','Kluivert','Tavernier'], freeKicks: ['Tavernier','Kluivert','Brooks','Scott','Ünal'], corners: ['Tavernier','Scott','Kluivert','Brooks','Cook','Christie'] },
  'BRE': { penalties: ['Thiago','Schade','Jensen'], freeKicks: ['Lewis-Potter','Jensen','Damsgaard'], corners: ['Jensen','Damsgaard','Janelt','Dango'] },
  'BHA': { penalties: ['Grobb','O\'Riley'], freeKicks: ['Ayari','Dunk','De Cuyper','Gomez'], corners: ['Grobb','Kadıoğlu','Minteh','De Cuyper','Ayari'] },
  'CHE': { penalties: ['Palmer','Enzo','Estêvão','Delap'], freeKicks: ['James','Enzo','Palmer','Neto'], corners: ['James','Enzo','Neto','Estêvão'] },
  'COV': { penalties: ['Wright','Torp','Grimes','Thomas-Asante'], freeKicks: ['Rudoni','Torp'], corners: ['Grimes','Torp','Rudoni'] },
  'CRY': { penalties: ['Mateta','Sarr','Devenny'], freeKicks: ['Yeremy','Devenny'], corners: ['Wharton','Yeremy','Hughes','Kamada'] },
  'EVE': { penalties: ['Ndiaye','Barry','Garner','Beto'], freeKicks: ['Garner'], corners: ['Garner','Dewsbury-Hall'] },
  'FUL': { penalties: ['Robinson','Iwobi'], freeKicks: ['Iwobi'], corners: ['Iwobi','Bobb','Kevin'] },
  'HUL': { penalties: ['Crooks','McBurnie'], freeKicks: ['Giles','Belloumi'], corners: ['Giles','Slater','Belloumi'] },
  'IPS': { penalties: ['Hirst','Clarke','Philogene'], freeKicks: ['Núñez','Davis','Clarke'], corners: ['Núñez','Davis','Clarke','Philogene'] },
  'LEE': { penalties: ['Calvert-Lewin','Nmecha','Piroe'], freeKicks: ['Stach','Longstaff','Aaronson'], corners: ['Stach','Wilson','Longstaff','Tanaka'] },
  'LIV': { penalties: ['Isak','Szoboszlai','Gakpo','Wirtz','Mac Allister'], freeKicks: ['Szoboszlai','Wirtz'], corners: ['Szoboszlai','Gakpo','Wirtz'] },
  'MCI': { penalties: ['Haaland','Marmoush','Semenyo','Doku','Matheus N.'], freeKicks: ['Cherki','Marmoush','Foden','Reijnders'], corners: ['Cherki','Foden','Anderson','Reijnders'] },
  'MUN': { penalties: ['B.Fernandes','Mbeumo','Tielemans'], freeKicks: ['B.Fernandes','Mbeumo','Mount'], corners: ['B.Fernandes','Mbeumo','Shaw','Amad'] },
  'NEW': { penalties: ['Woltemade','Osula','Wissa'], freeKicks: ['Hall','Schär'], corners: ['Hall','J.Murphy','L.Miley','Elanga'] },
  'NFO': { penalties: ['Wood','Gibbs-White','Igor Jesus'], freeKicks: ['Gibbs-White','Murillo','N.Williams','Hudson-Odoi'], corners: ['N.Williams','Hutchinson','Ndoye','Bakwa'] },
  'TOT': { penalties: ['Solanke','Kudus','Xavi','Richarlison'], freeKicks: ['Pedro Porro','Xavi','Kudus','Tonali'], corners: ['Pedro Porro','Kudus','Tel','Xavi','Tonali'] },
  'SUN': { penalties: ['Diarra','Le Fée'], freeKicks: ['Xhaka','Le Fée'], corners: ['Le Fée','Xhaka','Hume'] },
  'WOL': { penalties: ['Cunha','Hwang','Sarabia'], freeKicks: ['Sarabia','Nunes','Aït-Nouri'], corners: ['Sarabia','Nunes','Aït-Nouri'] }
};

// Fuzzy name matcher: matches FPL list name to bootstrap web_name
function findPlayer(listName, elements, teamId) {
  const ln = listName.toLowerCase().replace(/[^a-z]/g, '');
  // Set-piece ownership is team-specific; never attach a player from another club.
  const teamEls = teamId ? elements.filter(e => e.team === teamId) : elements;

  const tryMatch = (pool) => {
    // Exact web_name
    let m = pool.find(e => e.web_name.toLowerCase() === listName.toLowerCase());
    if (m) return m;
    // Fuzzy: stripped comparison
    m = pool.find(e => e.web_name.toLowerCase().replace(/[^a-z]/g, '') === ln);
    if (m) return m;
    // Partial: listName contained in web_name or vice versa
    m = pool.find(e => {
      const wn = e.web_name.toLowerCase().replace(/[^a-z]/g, '');
      return wn.includes(ln) || ln.includes(wn);
    });
    if (m) return m;
    // Check second_name
    m = pool.find(e => {
      const sn = (e.second_name || '').toLowerCase().replace(/[^a-z]/g, '');
      return sn === ln || sn.includes(ln) || ln.includes(sn);
    });
    if (m) return m;
    // Check first_name
    m = pool.find(e => {
      const fn = (e.first_name || '').toLowerCase().replace(/[^a-z]/g, '');
      return fn === ln || ln.includes(fn);
    });
    return m || null;
  };

  return tryMatch(teamEls);
}

router.get('/set-pieces', async (req, res) => {
  try {
    const bs = await getCachedApiData(BOOTSTRAP_URL);
    const elements = bs.elements;
    const teams = bs.teams;
    const getTeam = id => teams.find(t => t.id === id);
    const getTeamByShort = name => teams.find(t => t.short_name === name || t.name === name);

    const result = {};
    Object.entries(SET_PIECE_DATA).forEach(([shortName, sp]) => {
      const team = getTeamByShort(shortName);
      if (!team) return;
      const teamId = team.id;

      const resolve = (names) => names.map(name => {
        const p = findPlayer(name, elements, teamId);
        if (!p) return { name, team: shortName, teamFull: team.name, teamId, cost: 0, costStr: '?', goals: 0, assists: 0, totalPoints: 0, form: 0, code: 0, position: '?', found: false };
        return {
          id: p.id, name: p.web_name, code: p.code,
          position: POSITION_MAP[p.element_type - 1],
          team: shortName, teamFull: team.name, teamId,
          cost: p.now_cost, costStr: '£' + (p.now_cost / 10).toFixed(1) + 'm',
          goals: p.goals_scored || 0, assists: p.assists || 0,
          totalPoints: p.total_points || 0, form: parseFloat(p.form) || 0,
          minutes: p.minutes || 0, selectedBy: parseFloat(p.selected_by_percent) || 0,
          bonus: p.bonus || 0, ictIndex: parseFloat(p.ict_index) || 0,
          found: true
        };
      });

      result[shortName] = {
        teamName: shortName, teamFull: team.name, teamId,
        penalties: resolve(sp.penalties),
        freeKicks: resolve(sp.freeKicks),
        corners: resolve(sp.corners)
      };
    });

    res.json({ setPieces: result });
  } catch (e) {
    logger.error({ err: e }, 'Set pieces error');
    res.status(500).json({ error: 'Failed to calculate set pieces' });
  }
});

// ---- Manager ROI ----
router.get('/manager-roi/:managerId', heavyEndpointLimiter, async (req, res) => {
  const managerId = parsePositiveId(req.params.managerId);
  if (!managerId) return res.status(400).json({ error: 'A valid managerId is required' });
  try {
    const bs = await getCachedApiData(BOOTSTRAP_URL);
    const { analyzeManager } = require('../routes/decision');
    const managerData = await analyzeManager(managerId, bs);
    
    const players = managerData.playerStats || [];
    const totalValue = players.reduce((s, p) => s + (p.nowCost || 0), 0) / 10;
    const totalPoints = players.reduce((s, p) => s + (p.totalPointsActive || 0), 0);
    
    // ROI = Points per Million spent
    const roi = totalValue > 0 ? (totalPoints / totalValue).toFixed(2) : 0;
    
    // Per-player ROI
    const playerROI = players.map(p => ({
      name: p.name, team: p.team, position: p.position,
      code: p.photoId,
      cost: (p.nowCost / 10).toFixed(1),
      points: p.totalPointsActive,
      roi: p.nowCost > 0 ? (p.totalPointsActive / (p.nowCost / 10)).toFixed(2) : '0.00',
      starts: p.starts,
      ppg: p.starts > 0 ? (p.totalPointsActive / p.starts).toFixed(1) : '0.0'
    })).sort((a, b) => parseFloat(b.roi) - parseFloat(a.roi));

    // Value ratings
    const valueRatings = playerROI.map(p => ({
      ...p,
      rating: parseFloat(p.roi) >= 15 ? 'Elite' : 
              parseFloat(p.roi) >= 10 ? 'Great Value' :
              parseFloat(p.roi) >= 7 ? 'Fair' :
              parseFloat(p.roi) >= 4 ? 'Overpriced' : 'Poor Value'
    }));

    res.json({
      managerName: managerData.managerInfo.name,
      totalValue: totalValue.toFixed(1),
      totalPoints,
      roi,
      playerROI: valueRatings,
      bestValue: valueRatings[0],
      worstValue: valueRatings[valueRatings.length - 1]
    });
  } catch (e) {
    logger.error({ err: e }, 'Manager ROI error');
    res.status(500).json({ error: 'Failed to calculate ROI' });
  }
});

// ---- Chip Strategy ----
router.get('/chip-strategy', async (req, res) => {
  try {
    const [bs, fixtures] = await Promise.all([getCachedApiData(BOOTSTRAP_URL), getCachedApiData(FIXTURES_URL)]);
    const elements = bs.elements;
    const teams = bs.teams;
    const currentGW = bs.events.find(e => e.is_current)?.id || 1;
    const getTeam = id => teams.find(t => t.id === id);

    // Find DGWs (Double Gameweeks) and BGWs (Blank Gameweeks)
    const gwFixtureCount = {};
    for (let gw = currentGW; gw <= Math.min(currentGW + 10, 38); gw++) {
      const gwFixtures = fixtures.filter(f => f.event === gw);
      gwFixtureCount[gw] = gwFixtures.length;
    }
    
    const avgFixtures = Object.values(gwFixtureCount).reduce((s, v) => s + v, 0) / Object.values(gwFixtureCount).length;
    const dgws = Object.entries(gwFixtureCount).filter(([gw, count]) => count > avgFixtures * 1.3).map(([gw]) => parseInt(gw));
    const bgws = Object.entries(gwFixtureCount).filter(([gw, count]) => count < avgFixtures * 0.7).map(([gw]) => parseInt(gw));

    // Best chips by position
    const bestByPosition = {
      FWD: elements.filter(p => p.element_type === 4 && p.minutes > 0)
        .sort((a, b) => (parseFloat(b.expected_goal_involvements) || 0) - (parseFloat(a.expected_goal_involvements) || 0))
        .slice(0, 5)
        .map(p => ({ name: p.web_name, team: getTeam(p.team)?.short_name, xGI: p.expected_goal_involvements, form: p.form, code: p.code })),
      MID: elements.filter(p => p.element_type === 3 && p.minutes > 0)
        .sort((a, b) => (parseFloat(b.expected_goal_involvements) || 0) - (parseFloat(a.expected_goal_involvements) || 0))
        .slice(0, 5)
        .map(p => ({ name: p.web_name, team: getTeam(p.team)?.short_name, xGI: p.expected_goal_involvements, form: p.form, code: p.code }))
    };

    // Recommendations
    const recommendations = [];
    if (dgws.length > 0) {
      recommendations.push({
        chip: 'Bench Boost',
        reason: `DGW${dgws[0]} has ${gwFixtureCount[dgws[0]]} fixtures - maximize bench points`,
        bestGW: dgws[0],
        priority: 'High'
      });
      recommendations.push({
        chip: 'Triple Captain',
        reason: `DGW${dgws[0]} is ideal for TC on a premium asset`,
        bestGW: dgws[0],
        priority: 'Medium'
      });
    }
    if (bgws.length > 0) {
      recommendations.push({
        chip: 'Free Hit',
        reason: `BGW${bgws[0]} only has ${gwFixtureCount[bgws[0]]} fixtures - build a one-week team`,
        bestGW: bgws[0],
        priority: bgws.length > 2 ? 'High' : 'Medium'
      });
    }

    res.json({
      currentGW,
      gwFixtureCount,
      dgws, bgws,
      recommendations,
      bestByPosition,
      chipTips: [
        'Use Wildcard when 4+ transfers needed',
        'Bench Boost on DGWs with strong bench',
        'Triple Captain on form player with easy DGW fixture',
        'Free Hit to navigate BGWs or build DGW team'
      ]
    });
  } catch (e) {
    logger.error({ err: e }, 'Chip strategy error');
    res.status(500).json({ error: 'Failed to calculate chip strategy' });
  }
});

// ---- Expected Points Projections ----
router.get('/xpts-projections', async (req, res) => {
  try {
    const [bs, fixtures] = await Promise.all([getCachedApiData(BOOTSTRAP_URL), getCachedApiData(FIXTURES_URL)]);
    const elements = bs.elements;
    const teams = bs.teams;
    const currentGW = bs.events.find(e => e.is_next)?.id || bs.events.find(e => e.is_current)?.id || 1;
    const getTeam = id => teams.find(t => t.id === id);
    const teamStrengthRanks = new Map([...teams]
      .sort((a, b) => (Number(b.strength_overall_home || 0) + Number(b.strength_overall_away || 0)) - (Number(a.strength_overall_home || 0) + Number(a.strength_overall_away || 0)))
      .map((team, index) => [team.id, index + 1]));

    // Route through the shared captaincy projection engine so the team builder uses
    // the same starter-aware xPts model as the decision centre and AI team.
    const projectionData = buildPlayerProjections({ bootstrap: bs, fixtures, startGW: currentGW, horizon: 8 });
    const projections = projectionData.projections.map(p => {
      const raw = elements.find(element => element.id === p.id) || {};
      const nextFixtures = p.weekly.map(week => {
        const labels = week.fixtures || [];
        return {
          gw: week.gameweek,
          opponent: labels.map(item => item.opponent).join(' + ') || 'BLANK',
          isHome: labels.length === 1 ? labels[0].isHome : null,
          fdr: labels.length ? Math.round(labels.reduce((sum, item) => sum + (item.fdr || 3), 0) / labels.length) : null,
          xpts: week.xPts,
          xmins: week.xMins,
          xg: p.xG90 * week.xMins / 90,
          xa: p.xA90 * week.xMins / 90,
          fixtures: labels,
        };
      });
      return {
        id: p.id, name: p.name, fullName: p.fullName, code: p.code,
        team: p.team,
        position: p.position,
        cost: p.cost * 10, costStr: '£' + p.cost.toFixed(1) + 'm',
        form: p.form, ppg: raw.points_per_game ? parseFloat(raw.points_per_game) : 0,
        xG90: p.xG90, xA90: p.xA90, xGI90: p.xGI90,
        totalXpts: p.totalXpts,
        xptsPerMillion: p.xPtsPerMillion.toFixed(1),
        nextFixtures,
        totalPoints: raw.total_points || 0,
        ownership: p.ownership,
        status: p.status,
        news: p.news || '',
        teamId: p.teamId,
        photoId: p.code,
        availability: p.availability,
        confidence: p.confidence,
        starterScore: p.starterScore,
        starterTier: p.starterTier,
        isStarter: p.isStarter,
        roles: p.roles || [],
        teamStrengthRank: teamStrengthRanks.get(p.teamId) || 20,
      };
    }).sort((a, b) => b.totalXpts - a.totalXpts);

    // Team projections (sum of all starters)
    const teamProjections = {};
    projections.forEach(p => {
      if (!teamProjections[p.team]) teamProjections[p.team] = { team: p.team, totalXpts: 0, count: 0 };
      teamProjections[p.team].totalXpts += p.totalXpts;
      teamProjections[p.team].count++;
    });

    res.json({
      currentGW,
      playerProjections: projections,
      teamProjections: Object.values(teamProjections).sort((a, b) => b.totalXpts - a.totalXpts),
      topByPosition: {
        FWD: projections.filter(p => p.position === 'FWD').slice(0, 10),
        MID: projections.filter(p => p.position === 'MID').slice(0, 10),
        DEF: projections.filter(p => p.position === 'DEF').slice(0, 10),
        GKP: projections.filter(p => p.position === 'GKP').slice(0, 5)
      }
    });
  } catch (e) {
    logger.error({ err: e }, 'xPts projections error');
    res.status(500).json({ error: 'Failed to calculate projections' });
  }
});

// ---- Team Builder Squad Advisor ----
router.post('/team-builder/advice', heavyEndpointLimiter, async (req, res) => {
  try {
    const playerIds = Array.isArray(req.body?.playerIds) ? req.body.playerIds.map(Number).filter(Number.isFinite) : [];
    if (!playerIds.length || playerIds.length > 15) return res.status(400).json({ error: 'Choose between 1 and 15 players for review' });
    const horizon = Math.max(1, Math.min(8, Number(req.body?.horizon) || 5));
    const [bootstrap, fixtures] = await Promise.all([getCachedApiData(BOOTSTRAP_URL), getCachedApiData(FIXTURES_URL)]);
    const nextGW = bootstrap.events.find(event => event.is_next)?.id || bootstrap.events.find(event => event.is_current)?.id || 1;
    res.json(buildSquadAdvice({
      bootstrap,
      fixtures,
      playerIds,
      options: {
        horizon,
        targetGW: nextGW,
        strategy: req.body?.strategy,
        bank: req.body?.bank,
        freeTransfers: req.body?.freeTransfers,
        usedChips: Array.isArray(req.body?.usedChips) ? req.body.usedChips : [],
      },
    }));
} catch (error) {
    logger.error({ err: error }, 'Team builder advice error');
    res.status(500).json({ error: 'Failed to review this squad' });
  }
});

// ---- Deadline Info ----
router.get('/deadline', async (req, res) => {
  try {
    const bs = await getCachedApiData(BOOTSTRAP_URL);
    const events = bs.events;
    const currentGW = events.find(e => e.is_current);
    const nextGW = events.find(e => e.is_next);
    const futureGW = events.find(e => e.deadline_time && new Date(e.deadline_time).getTime() > Date.now());
    
    // Get deadline times
    const deadlineTime = futureGW?.deadline_time || nextGW?.deadline_time || currentGW?.deadline_time;
    const deadlineDate = deadlineTime ? new Date(deadlineTime) : null;
    
    res.json({
      currentGW: currentGW?.id || 1,
      nextGW: futureGW?.id || nextGW?.id || (currentGW?.id ? currentGW.id + 1 : 1),
      deadlineTime: deadlineDate?.toISOString() || null,
      deadlineTimestamp: deadlineDate?.getTime() || null,
      gameweekDeadline: deadlineTime || 'TBA',
      isFinished: currentGW?.finished || false
    });
  } catch (e) {
    logger.error({ err: e }, 'Deadline error');
    res.status(500).json({ error: 'Failed to fetch deadline' });
  }
});

// ---- Injury News ----
router.get('/injury-news', async (req, res) => {
  try {
    const bs = await getCachedApiData(BOOTSTRAP_URL);
    const elements = bs.elements;
    const teams = bs.teams;
    const getTeam = id => teams.find(t => t.id === id);

    // Status codes: a=available, d=doubtful, i=injured, s=suspended, u=unavailable, p=phasing in
    const statusLabels = {
      'd': 'Doubtful', 'i': 'Injured', 's': 'Suspended', 
      'u': 'Unavailable', 'p': 'Phasing In', 'n': 'Not Available'
    };

    const injuries = elements
      .filter(p => p.status !== 'a' && p.status !== 'r')
      .map(p => ({
        id: p.id, name: p.web_name, code: p.code,
        team: getTeam(p.team)?.short_name || '',
        teamFull: getTeam(p.team)?.name || '',
        position: POSITION_MAP[p.element_type - 1],
        status: statusLabels[p.status] || p.statusCode,
        statusCode: p.status,
        news: p.news || 'No update',
        cost: p.now_cost,
        costStr: '£' + (p.now_cost / 10).toFixed(1) + 'm',
        ownership: parseFloat(p.selected_by_percent) || 0,
        form: parseFloat(p.form) || 0,
        totalPoints: p.total_points || 0,
        chanceOfPlaying: p.chance_of_playing_next_round,
        // Severity sorting: suspended > injured > doubtful > unavailable
        severity: p.status === 's' ? 4 : p.status === 'i' ? 3 : p.status === 'd' ? 2 : 1
      }))
      .sort((a, b) => b.severity - a.severity || b.ownership - a.ownership);

    res.json({
      injuries,
      summary: {
        total: injuries.length,
        injured: injuries.filter(p => p.statusCode === 'i').length,
        suspended: injuries.filter(p => p.statusCode === 's').length,
        doubtful: injuries.filter(p => p.statusCode === 'd').length,
        unavailable: injuries.filter(p => p.statusCode === 'u').length
      }
    });
  } catch (e) {
    logger.error({ err: e }, 'Injury news error');
    res.status(500).json({ error: 'Failed to fetch injury news' });
  }
});

// Match Analysis endpoint for Tactics page
router.get('/match-analysis', async (req, res) => {
  try {
    const { team_h, team_a } = req.query;
    if (!team_h || !team_a) return res.status(400).json({ error: 'team_h and team_a required' });

    const bootstrapData = await getCachedApiData('https://fantasy.premierleague.com/api/bootstrap-static/');
    const elements = bootstrapData.elements;
    const teams = bootstrapData.teams;

    const getTeam = id => teams.find(t => t.id === parseInt(id));
    const getPosStr = type => {
      if (type === 1) return 'GK';
      if (type === 2) return 'DEF';
      if (type === 3) return 'MID';
      if (type === 4) return 'FWD';
      return 'DEF';
    };

    const homeTeam = getTeam(team_h);
    const awayTeam = getTeam(team_a);

    const homePlayers = elements.filter(p => p.team === parseInt(team_h) && p.minutes > 0);
    const awayPlayers = elements.filter(p => p.team === parseInt(team_a) && p.minutes > 0);

    const buildTeamData = (players, teamInfo) => {
      const posGroups = { GK: [], DEF: [], MID: [], FWD: [] };
      players.forEach(p => {
        const pos = getPosStr(p.element_type);
        if (posGroups[pos]) {
          posGroups[pos].push({
            name: p.web_name,
            code: p.code,
            position: pos,
            xGI: parseFloat(p.expected_goal_involvements || 0),
            xG: parseFloat(p.expected_goals || 0),
            xA: parseFloat(p.expected_assists || 0),
            goals: p.goals_scored || 0,
            assists: p.assists || 0,
            goalsConceded: p.goals_conceded || 0,
            cleanSheets: p.clean_sheets || 0,
            minutes: p.minutes || 0,
            form: parseFloat(p.form || 0),
            cost: (p.now_cost / 10).toFixed(1),
            totalPoints: p.total_points || 0,
            ictIndex: parseFloat(p.ict_index || 0)
          });
        }
      });

      // Sort each position by xGI/points
      Object.keys(posGroups).forEach(pos => {
        posGroups[pos].sort((a, b) => b.xGI - a.xGI || b.totalPoints - a.totalPoints);
      });

      const totalXGI = players.reduce((s, p) => s + parseFloat(p.expected_goal_involvements || 0), 0);
      const totalGoals = players.reduce((s, p) => s + (p.goals_scored || 0), 0);
      const totalGC = players.reduce((s, p) => s + (p.goals_conceded || 0), 0);
      const totalCS = players.reduce((s, p) => s + (p.clean_sheets || 0), 0);

      // DEFCON: lower is stronger defence
      const avgDefCon = players.length > 0 ?
        (5 - (players.reduce((s, p) => s + parseFloat(p.form || 0), 0) / players.length) * 0.4).toFixed(1) : '3.0';

      // Best picks by xGI
      const bestPicks = [...players]
        .sort((a, b) => parseFloat(b.expected_goal_involvements || 0) - parseFloat(a.expected_goal_involvements || 0))
        .slice(0, 5)
        .map(p => ({
          name: p.web_name,
          code: p.code,
          position: getPosStr(p.element_type),
          xGI: parseFloat(p.expected_goal_involvements || 0),
          form: parseFloat(p.form || 0),
          cost: (p.now_cost / 10).toFixed(1),
          totalPoints: p.total_points || 0,
          team: teamInfo.short_name
        }));

      return {
        teamName: teamInfo.name,
        teamShort: teamInfo.short_name,
        short_name: teamInfo.short_name,
        totalXGI: totalXGI.toFixed(1),
        totalGoals,
        totalGC,
        totalCS,
        defcon: avgDefCon,
        posGroups,
        bestPicks,
        // Strongest position
        strongSide: Object.entries(posGroups).reduce((best, [pos, players]) => {
          const posXGI = players.reduce((s, p) => s + p.xGI, 0);
          return posXGI > best.xgi ? { pos, xgi: posXGI } : best;
        }, { pos: 'MID', xgi: 0 }).pos
      };
    };

    const home = buildTeamData(homePlayers, homeTeam);
    const away = buildTeamData(awayPlayers, awayTeam);

    // Identify danger zones (attacking strength) and vulnerability zones (defensive weakness)
    const dangerZones = [];
    const vulnZones = [];

    // Home attack vs Away defence
    Object.entries(home.posGroups).forEach(([pos, players]) => {
      const posTotalXGI = players.reduce((s, p) => s + p.xGI, 0);
      if (posTotalXGI > 10) {
        dangerZones.push({
          team: home.teamShort,
          zone: pos,
          xGI: posTotalXGI.toFixed(1),
          label: `${home.teamShort} ${pos}: ${posTotalXGI.toFixed(1)} xGI`
        });
      }
    });

    // Away attack vs Home defence
    Object.entries(away.posGroups).forEach(([pos, players]) => {
      const posTotalXGI = players.reduce((s, p) => s + p.xGI, 0);
      if (posTotalXGI > 10) {
        dangerZones.push({
          team: away.teamShort,
          zone: pos,
          xGI: posTotalXGI.toFixed(1),
          label: `${away.teamShort} ${pos}: ${posTotalXGI.toFixed(1)} xGI`
        });
      }
    });

    // Vulnerability zones (high GC)
    const homeGCByPos = { DEF: 0, MID: 0 };
    const awayGCByPos = { DEF: 0, MID: 0 };
    homePlayers.forEach(p => {
      const pos = getPosStr(p.element_type);
      if (pos === 'DEF') homeGCByPos.DEF += p.goals_conceded || 0;
      else if (pos === 'MID') homeGCByPos.MID += p.goals_conceded || 0;
    });
    awayPlayers.forEach(p => {
      const pos = getPosStr(p.element_type);
      if (pos === 'DEF') awayGCByPos.DEF += p.goals_conceded || 0;
      else if (pos === 'MID') awayGCByPos.MID += p.goals_conceded || 0;
    });

    if (homeGCByPos.DEF > 20) vulnZones.push({ team: home.teamShort, zone: 'LCB/RCB', label: `${home.teamShort} CB: ${homeGCByPos.DEF} GC` });
    if (awayGCByPos.DEF > 20) vulnZones.push({ team: away.teamShort, zone: 'LCB/RCB', label: `${away.teamShort} CB: ${awayGCByPos.DEF} GC` });

    // Predicted danger
    const homeStrength = parseFloat(home.totalXGI) - parseFloat(away.totalXGI);
    const predictedDanger = homeStrength > 5 ? `${home.teamShort} favored` :
                           homeStrength < -5 ? `${away.teamShort} favored` : 'Balanced';

    res.json({
      home,
      away,
      dangerZones: dangerZones.slice(0, 4),
      vulnZones: vulnZones.slice(0, 4),
      predictedDanger,
      homeStrength: parseFloat(home.defcon),
      awayStrength: parseFloat(away.defcon)
    });
  } catch (e) {
    logger.error({ err: e }, 'Match analysis error');
    res.status(500).json({ error: 'Failed to fetch match analysis' });
  }
});

module.exports = router;
