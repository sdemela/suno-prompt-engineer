// api/generate.js — Vercel serverless function
// Free tier: 2/day per IP
// Credits tier: paid credits stored in Upstash Redis per UUID
// BYOK: user's own Anthropic key (handled client-side, not here)

import { Redis } from '@upstash/redis';

const FREE_LIMIT = 2;
const ipStore = new Map(); // in-memory free tier (resets on cold start)

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

function getTodayKey(ip) {
  const today = new Date().toISOString().slice(0, 10);
  return `${ip}::${today}`;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { formData, uuid } = req.body || {};
  if (!formData) return res.status(400).json({ error: 'Missing formData' });

  const totalLen = JSON.stringify(formData).length;
  if (totalLen > 3000) return res.status(400).json({ error: 'Input too long' });

  // --- CREDITS TIER (paid) ---
  if (uuid && uuid.length >= 10) {
    try {
      const credits = parseInt(await redis.get(`credits:${uuid}`)) || 0;
      if (credits <= 0) {
        return res.status(402).json({ error: 'no_credits', message: 'No credits remaining. Buy more to continue.' });
      }
      // Deduct 1 credit
      await redis.decrby(`credits:${uuid}`, 1);
      const result = await callAnthropic(formData);
      return res.status(200).json({ ...result, creditsRemaining: credits - 1, tier: 'credits' });
    } catch(e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // --- FREE TIER (IP-based, 2/day) ---
  const ip = req.headers['x-forwarded-for']?.split(',')[0] || req.socket?.remoteAddress || 'unknown';
  const key = getTodayKey(ip);
  const used = ipStore.get(key) || 0;

  if (used >= FREE_LIMIT) {
    return res.status(429).json({
      error: 'free_limit_reached',
      message: `You've used your ${FREE_LIMIT} free generations today.`,
      used,
      limit: FREE_LIMIT,
    });
  }

  try {
    const result = await callAnthropic(formData);
    ipStore.set(key, used + 1);
    return res.status(200).json({
      ...result,
      used: used + 1,
      limit: FREE_LIMIT,
      remaining: Math.max(0, FREE_LIMIT - used - 1),
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
  const versionRules = isLegacy
    ? `TARGET: Suno ${version} (legacy). Keep the prompt SHORT and DIRECT.\n- Max 6-8 keywords total\n- Focus only on: genre, core rhythm, 1-2 main instruments\n- NO texture/mix/structure/era descriptors\n- No more than 60 characters total`
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
