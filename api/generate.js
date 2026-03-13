// CORS allowlist (fix #3)
const ALLOWED_ORIGINS = ['https://supre.online', 'https://www.supre.online'];
function setCors(req, res) {
  const origin = req.headers['origin'] || '';
  if (ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Vary', 'Origin');
}

// api/generate.js — Vercel serverless function
// Free tier: 2/day per IP — rate limit centralizzato su Redis (fix #4)
// Credits tier: paid credits in Upstash Redis per UUID (via REST API, no SDK)

const FREE_LIMIT = 2;

async function redisGet(key) {
  const url = `${process.env.UPSTASH_REDIS_REST_URL}/get/${encodeURIComponent(key)}`;
  const r = await fetch(url, {
    headers: { Authorization: `Bearer ${process.env.UPSTASH_REDIS_REST_TOKEN}` }
  });
  const d = await r.json();
  return d.result;
}

async function redisDecrby(key, n) {
  const url = `${process.env.UPSTASH_REDIS_REST_URL}/decrby/${encodeURIComponent(key)}/${n}`;
  const r = await fetch(url, {
    headers: { Authorization: `Bearer ${process.env.UPSTASH_REDIS_REST_TOKEN}` }
  });
  const d = await r.json();
  return d.result;
}

// Redis-based free tier counter — INCR + EXPIREAT a mezzanotte UTC
// Condiviso tra tutte le istanze serverless, nessun cold start issue
async function redisIncrFreeTier(key) {
  const base = process.env.UPSTASH_REDIS_REST_URL;
  const auth = { Authorization: `Bearer ${process.env.UPSTASH_REDIS_REST_TOKEN}` };

  const incrRes = await fetch(`${base}/incr/${encodeURIComponent(key)}`, { headers: auth });
  const incrData = await incrRes.json();
  const count = incrData.result;

  // Set expiry only on first increment — expires at next midnight UTC
  if (count === 1) {
    const now = new Date();
    const midnight = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
    const expireAt = Math.floor(midnight.getTime() / 1000);
    await fetch(`${base}/expireat/${encodeURIComponent(key)}/${expireAt}`, { headers: auth });
  }

  return count;
}

function getFreeTierKey(ip) {
  const today = new Date().toISOString().slice(0, 10);
  return `free:${ip}:${today}`;
}

export default async function handler(req, res) {
  setCors(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { formData, uuid } = req.body || {};
  if (!formData) return res.status(400).json({ error: 'Missing formData' });

  const totalLen = JSON.stringify(formData).length;
  if (totalLen > 3000) return res.status(400).json({ error: 'Input too long' });

  // --- CREDITS TIER (paid) ---
  if (uuid && uuid.length >= 10) {
    try {
      const raw = await redisGet(`credits:${uuid}`);
      const credits = parseInt(raw) || 0;
      if (credits <= 0) {
        return res.status(402).json({ error: 'no_credits', message: 'No credits remaining.' });
      }
      const newCredits = await redisDecrby(`credits:${uuid}`, 1);
      const result = await callAnthropic(formData);
      return res.status(200).json({ ...result, creditsRemaining: newCredits, tier: 'credits' });
    } catch(e) {
      console.error('Credits tier error:', e.message);
      return res.status(500).json({ error: e.message });
    }
  }

  // --- FREE TIER (IP-based, 2/day — Redis centralizzato) ---
  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress || 'unknown';
  const freeKey = getFreeTierKey(ip);
  const used = await redisIncrFreeTier(freeKey);

  if (used > FREE_LIMIT) {
    return res.status(429).json({
      error: 'free_limit_reached',
      message: `You've used your ${FREE_LIMIT} free generations today.`,
      used: used - 1, limit: FREE_LIMIT,
    });
  }

  try {
    const result = await callAnthropic(formData);
    return res.status(200).json({
      ...result,
      used,
      limit: FREE_LIMIT,
      remaining: Math.max(0, FREE_LIMIT - used),
      tier: 'free',
    });
  } catch(e) {
    return res.status(500).json({ error: e.message });
  }
}

async function callAnthropic(formData) {
  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 600,
      system: buildSystemPrompt(formData.sunoVersion || 'v4'),
      messages: [{ role: 'user', content: buildUserMessage(formData) }],
    }),
  });

  if (!resp.ok) {
    const err = await resp.json();
    throw new Error(err.error?.message || 'Anthropic API error');
  }

  const data = await resp.json();
  const raw = (data.content || []).find(b => b.type === 'text')?.text || '{}';

  let result;
  try {
    result = JSON.parse(raw.replace(/```json|```/g, '').trim());
    if (!result.stylePrompt) result = { stylePrompt: raw, tips: [] };
  } catch(e) {
    result = { stylePrompt: raw, tips: [] };
  }
  return result;
}

function buildSystemPrompt(version) {
  const isLegacy = version === 'v3' || version === 'v3.5';
  const isV5 = version === 'v5';
  const versionRules = isLegacy
    ? `TARGET: Suno ${version} (legacy). Keep the prompt SHORT and DIRECT.\n- Max 6-8 keywords total\n- Focus only on: genre, core rhythm, 1-2 main instruments\n- NO texture/mix/structure/era descriptors\n- No more than 60 characters total`
    : isV5
    ? `TARGET: Suno v5 (latest). Use a RICH, DESCRIPTIVE prompt.\n- 15-20 keywords, up to 150 characters\n- v5 understands natural language better — use descriptive phrases\n- Include: genre/era → mood/narrative feel → instruments → production texture → mix character → vocal direction\n- Can reference sonic atmospheres, emotional arcs, and production eras more freely`
    : `TARGET: Suno ${version} (modern). Use a FULL, LAYERED prompt.\n- 10-15 keywords, up to 120 characters\n- Include: genre/era → mood/energy → instruments → production texture → mix character → structure hints`;

  return `You are an expert Suno AI prompt engineer. Given music parameters, generate an optimized Style of Music prompt calibrated for the target Suno version.\n\n${versionRules}\n\nOutput ONLY a raw JSON object, no markdown:\n{\n  "stylePrompt": "the complete style prompt string",\n  "tips": ["tip1", "tip2"]\n}\n\nRules:\n- Natural flowing keywords, NOT a sentence\n- NEVER include artist names, song titles, or brand names\n- English only\n- Tips: 1-3 short actionable tips, max 80 chars each`;
}

function buildUserMessage(f) {
  const parts = [];
  if (f.sunoVersion) parts.push(`Suno version: ${f.sunoVersion}`);
  if (f.genre) parts.push(`Genre: ${f.genre}`);
  if (f.era) parts.push(`Era/Reference: ${f.era}`);
  if (f.substyles?.length) parts.push(`Sub-styles: ${f.substyles.join(', ')}`);
  if (f.moods?.length) parts.push(`Mood: ${f.moods.join(', ')}`);
  if (f.energy) parts.push(`Energy: ${f.energy}`);
  if (f.bpm) parts.push(`BPM: ${f.bpm}`);
  if (f.key) parts.push(`Key: ${f.key}`);
  if (f.timeSig) parts.push(`Time signature: ${f.timeSig}`);
  if (f.instruments?.length) parts.push(`Instruments: ${f.instruments.join(', ')}`);
  if (f.mix?.length) parts.push(`Mix: ${f.mix.join(', ')}`);
  if (f.structure?.length) parts.push(`Structure: ${f.structure.join(', ')}`);
  if (f.vocalStyle) parts.push(`Vocals: ${[f.vocalStyle, f.vocalTex, f.vocalLang].filter(Boolean).join(', ')}`);
  if (f.extra) parts.push(`Extra notes: ${f.extra}`);
  if (f.refDesc) parts.push(`Reference description: ${f.refDesc}`);
  return parts.join('\n');
}
