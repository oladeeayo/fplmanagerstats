const express = require('express');
const axios = require('axios');
const { POSITION_MAP, stripCodeFences } = require('../helpers');
const { getCachedApiData, BOOTSTRAP_URL, FIXTURES_URL, BOOTSTRAP_CACHE_TTL } = require('../cache');
const { heavyEndpointLimiter } = require('../middleware');
const logger = require('../logger');

const router = express.Router();

// ---- Gemini OCR & Preference Models ----
const GEMINI_OCR_MODELS = ['gemini-3.7-flash', 'gemini-3.6-flash', 'gemini-3.5-flash', 'gemini-3-flash', 'gemini-2.5-flash'];
const GEMINI_PREFERENCE_MODELS = ['gemini-3.5-flash-lite', 'gemini-3.1-flash-lite', 'gemini-2.5-flash-lite', 'gemini-2.5-flash'];
const GEMINI_OCR_PROMPT = `You are analyzing a screenshot from Fantasy Premier League. It may show Pick Team, My Team, Transfers, a squad list, a pitch, or a third-party FPL squad graphic.
Identify every visible squad player by combining all available evidence:
- player name text, including clipped, abbreviated, blurred, stylized, or OCR-difficult text;
- the football shirt/jersey design, club colors, crest, sponsor, and badge;
- the player's pitch row or stated position;
- displayed FPL price;
- starting XI versus bench layout;
- captain and vice-captain markers.

Resolve only against the supplied current FPL catalog. Never invent a player or ID. Shirt evidence is especially important when text is unclear or two players share a surname. Price and position must agree where visible. If evidence remains ambiguous, return the best candidates in alternativePlayerIds and lower confidence instead of pretending certainty.
Return players in screenshot order: starting XI from top/forward row down to goalkeeper, then bench left to right. Ignore UI labels, fixtures, points, managers, club names used as headings, and any player not actually selected in the squad.`;

async function generateWithGeminiFallback(apiKey, models, payload) {
  let lastError;
  for (const model of models) {
    try {
      const response = await axios.post(
        `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`,
        payload,
        { timeout: 30000 }
      );
      return { response, model };
    } catch (error) {
      lastError = error;
      const status = error.response?.status;
      if (status === 401 || status === 403) throw error;
      const retryable = status == null || status === 400 || status === 404 || status === 408 || status === 429 || status >= 500;
      if (!retryable) throw error;
      logger.warn({ model, status: status || error.code }, 'Gemini model unavailable; trying fallback');
    }
  }
  throw lastError || new Error('No Gemini model was available');
}

// ---- Cloud OCR (Gemini) for squad screenshots ----
router.post('/ocr', express.raw({ type: ['image/png', 'image/jpeg', 'image/webp', 'image/*'], limit: '8mb' }), heavyEndpointLimiter, async (req, res) => {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return res.status(503).json({ error: 'Cloud OCR is not configured (set GEMINI_API_KEY)' });
  const image = req.body;
  if (!Buffer.isBuffer(image) || image.length === 0) return res.status(400).json({ error: 'An image upload is required' });
  const mimeType = (req.get('content-type') || 'image/png').split(';')[0];
  try {
    const { response, model } = await generateWithGeminiFallback(apiKey, GEMINI_OCR_MODELS, {
      contents: [{
        parts: [
          { text: GEMINI_OCR_PROMPT },
          { inline_data: { mime_type: mimeType, data: image.toString('base64') } },
        ],
      }],
      generationConfig: { temperature: 0.2, maxOutputTokens: 2048 },
    });
    const text = (response.data?.candidates?.[0]?.content?.parts || []).map(part => part.text || '').join('\n').trim();
    if (!text) return res.status(502).json({ error: 'Cloud OCR returned no text' });
    res.json({ text: stripCodeFences(text), engine: 'gemini', model });
  } catch (error) {
    logger.error({ err: error }, 'Cloud OCR error');
    const status = error.response?.status === 429 ? 429 : 502;
    res.status(status).json({ error: 'Cloud OCR failed', detail: error.response?.data?.error?.message || error.message });
  }
});

router.post('/ocr/fpl', express.raw({ type: ['image/png', 'image/jpeg', 'image/webp', 'image/*'], limit: '8mb' }), heavyEndpointLimiter, async (req, res) => {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return res.status(503).json({ error: 'Cloud FPL OCR is not configured' });
  const image = req.body;
  if (!Buffer.isBuffer(image) || !image.length) return res.status(400).json({ error: 'An FPL screenshot is required' });
  const mimeType = (req.get('content-type') || 'image/png').split(';')[0];
  try {
    const bootstrap = await getCachedApiData(BOOTSTRAP_URL, BOOTSTRAP_CACHE_TTL);
    const teams = new Map((bootstrap.teams || []).map(team => [team.id, { code: team.short_name, name: team.name }]));
    const players = (bootstrap.elements || []).map(player => ({
      id: player.id, name: player.web_name, fullName: [player.first_name, player.second_name].filter(Boolean).join(' '),
      team: teams.get(player.team)?.code || '', teamName: teams.get(player.team)?.name || '', position: POSITION_MAP[player.element_type - 1], price: Number(player.now_cost || 0) / 10,
    }));
    const prompt = `${GEMINI_OCR_PROMPT}\n\nPLAYER CATALOG (use IDs exactly):\n${JSON.stringify(players)}`;
    const { response, model } = await generateWithGeminiFallback(apiKey, GEMINI_OCR_MODELS, {
      contents: [{ parts: [{ text: prompt }, { inline_data: { mime_type: mimeType, data: image.toString('base64') } }] }],
      generationConfig: {
        temperature: 0.1,
        maxOutputTokens: 4096,
        responseMimeType: 'application/json',
        responseSchema: {
          type: 'OBJECT', required: ['players'], properties: {
            players: { type: 'ARRAY', items: { type: 'OBJECT', required: ['playerId', 'visibleName', 'teamCode', 'position', 'price', 'role', 'captain', 'viceCaptain', 'confidence', 'alternativePlayerIds'], properties: {
              playerId: { type: 'INTEGER' }, visibleName: { type: 'STRING' }, teamCode: { type: 'STRING', nullable: true },
              position: { type: 'STRING', nullable: true }, price: { type: 'NUMBER', nullable: true }, role: { type: 'STRING', enum: ['STARTER', 'BENCH', 'UNKNOWN'] },
              captain: { type: 'BOOLEAN' }, viceCaptain: { type: 'BOOLEAN' }, confidence: { type: 'STRING', enum: ['high', 'medium', 'low'] },
              alternativePlayerIds: { type: 'ARRAY', items: { type: 'INTEGER' } },
            } } },
          },
        },
      },
    });
    const parsed = JSON.parse(stripCodeFences((response.data?.candidates?.[0]?.content?.parts || []).map(part => part.text || '').join('').trim()));
    const catalog = new Map(players.map(player => [player.id, player]));
    const valid = [...new Set((Array.isArray(parsed.players) ? parsed.players : []).map(item => Number(item?.playerId)).filter(id => catalog.has(id)))].map(id => {
      const item = parsed.players.find(candidate => Number(candidate?.playerId) === id);
      const player = catalog.get(id);
      const alternatives = [...new Set((Array.isArray(item?.alternativePlayerIds) ? item.alternativePlayerIds : []).map(Number).filter(candidateId => catalog.has(candidateId) && candidateId !== id))].slice(0, 4);
      return {
        line: item.visibleName || player.name, playerId: id, confidence: item.confidence || 'low', score: item.confidence === 'high' ? 96 : item.confidence === 'medium' ? 78 : 58,
        position: item.position || player.position, price: Number.isFinite(Number(item.price)) ? Number(item.price) : null, team: item.teamCode || player.team,
        role: item.role || 'UNKNOWN', captain: item.captain === true, viceCaptain: item.viceCaptain === true,
        alternatives: [id, ...alternatives].map(candidateId => { const candidate = catalog.get(candidateId); return { id: candidate.id, name: candidate.name, team: candidate.team, position: candidate.position, score: candidateId === id ? (item.confidence === 'high' ? 96 : item.confidence === 'medium' ? 78 : 58) : 45 }; }),
      };
    });
    res.json({ players: valid.slice(0, 15), engine: 'gemini-fpl-vision', model });
  } catch (error) {
    logger.error({ err: error }, 'Structured FPL OCR error');
    const status = error.response?.status === 429 ? 429 : 502;
    res.status(status).json({ error: 'Structured FPL OCR failed', detail: error.response?.data?.error?.message || error.message });
  }
});

module.exports = { router, generateWithGeminiFallback, GEMINI_PREFERENCE_MODELS };
