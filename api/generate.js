// CORS allowlist
const ALLOWED_ORIGINS = ['https://supre.online', 'https://www.supre.online'];
function setCors(req, res) {
  const origin = req.headers['origin'] || '';
  if (ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-SPE-UUID, X-SPE-Sig');
  res.setHeader('Vary', 'Origin');
}

// Security headers
function setSecurityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
}

// api/generate.js
// FIX #2: UUID must match spe- format — unknown UUIDs fall through to free tier
// FIX #4: x-forwarded-for uses Vercel: client IP is first element of x-forwarded-for
// HMAC auth: verifica firma prima di consumare crediti paid
const FREE_LIMIT = 2;

// Fix #5: timeout wrapper for all external calls
async function fetchWithTimeout(url, options = {}, ms = 6000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function redisGet(key) {
  const url = `${process.env.UPSTASH_REDIS_REST_URL}/get/${encodeURIComponent(key)}`;
  const r = await fetchWithTimeout(url, {
    headers: { Authorization: `Bearer ${process.env.UPSTASH_REDIS_REST_TOKEN}` }
  });
  const d = await r.json();
  return d.result;
}

// Atomic check-and-decrement via Lua script
// Returns: remaining credits (>=0), -1 if zero, -2 on error, -3 if key doesn't exist
async function redisAtomicDecrIfPositive(key) {
  const base = process.env.UPSTASH_REDIS_REST_URL;
  const auth = { Authorization: `Bearer ${process.env.UPSTASH_REDIS_REST_TOKEN}` };
  const script = 'local v=redis.call("GET",KEYS[1]) if v==false then return -3 end local c=tonumber(v) or 0 if c<=0 then return -1 end return redis.call("DECRBY",KEYS[1],1)';
  const r = await fetchWithTimeout(`${base}/eval`, {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify([script, 1, key]),
  });
  const d = await r.json();
  if (d.result === null || d.result === undefined) return -3;
  return typeof d.result === 'number' ? d.result : -2;
}

// Redis-based free tier counter — INCR + EXPIREAT at midnight UTC
async function redisIncrFreeTier(key) {
  const base = process.env.UPSTASH_REDIS_REST_URL;
  const auth = { Authorization: `Bearer ${process.env.UPSTASH_REDIS_REST_TOKEN}` };
  const incrRes = await fetchWithTimeout(`${base}/incr/${encodeURIComponent(key)}`, { headers: auth });
  const incrData = await incrRes.json();
  const count = incrData.result;
  if (count === 1) {
    const now = new Date();
    const midnight = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
    const expireAt = Math.floor(midnight.getTime() / 1000);
    await fetchWithTimeout(`${base}/expireat/${encodeURIComponent(key)}/${expireAt}`, { headers: auth });
  }
  return count;
}

function getFreeTierKey(ip) {
  const today = new Date().toISOString().slice(0, 10);
  return `free:${ip}:${today}`;
}

// Vercel populates x-forwarded-for with the real client IP as the first element
// getTrustedIp — canonical version in _auth.js, kept local to avoid dynamic import overhead
function getTrustedIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) {
    const ips = forwarded.split(',').map(s => s.trim()).filter(Boolean);
    return ips[0] || 'unknown';
  }
  return req.socket?.remoteAddress || 'unknown';
}

export default async function handler(req, res) {
  setCors(req, res);
  setSecurityHeaders(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { formData, uuid } = req.body || {};
  if (!formData) return res.status(400).json({ error: 'Missing formData' });

  const totalLen = JSON.stringify(formData).length;
  if (totalLen > 3000) return res.status(400).json({ error: 'Input too long' });

  // FIX #2: Only treat as paid user if UUID matches our format AND has credits in Redis
  const isValidSpeUuid = uuid && typeof uuid === 'string' && uuid.startsWith('spe-') && uuid.length >= 15 && uuid.length <= 60;

  if (isValidSpeUuid) {
    // HMAC auth — verifica firma prima di consumare crediti paid
    // Se firma non valida, scala al free tier (non bloccare l'utente)
    const { verifyHMAC } = await import('./_auth.js');
    const sig = req.headers['x-spe-sig'] || '';
    const { valid } = verifyHMAC(uuid, sig);

    if (valid) {
      try {
        const newCredits = await redisAtomicDecrIfPositive(`credits:${uuid}`);
        if (newCredits === -3) {
          // Key doesn't exist — not a paid user, fall through to free tier
        } else if (newCredits === -1) {
          return res.status(402).json({ error: 'no_credits', message: 'No credits remaining.' });
        } else if (newCredits === -2) {
          return res.status(500).json({ error: 'redis_error', message: 'Failed to decrement credits.' });
        } else {
          let result;
          try {
            result = await callAnthropic(formData);
          } catch(anthropicErr) {
            // Rollback: reincrement the credit since generation failed
            try {
              await fetchWithTimeout(`${process.env.UPSTASH_REDIS_REST_URL}/incrby/${encodeURIComponent(`credits:${uuid}`)}/1`, {
                headers: { Authorization: `Bearer ${process.env.UPSTASH_REDIS_REST_TOKEN}` }
              });
            } catch(rollbackErr) {
              console.error('Credit rollback failed:', rollbackErr.message);
            }
            console.error('Anthropic error (credit rolled back):', anthropicErr.message);
            return res.status(503).json({ error: 'Generation failed. Your credit has been restored. Please try again.' });
          }
          // Global stats — only on success
          const today = new Date().toISOString().slice(0, 10);
          await Promise.allSettled([
            fetchWithTimeout(`${process.env.UPSTASH_REDIS_REST_URL}/incr/stats:generations_total`, { headers: { Authorization: `Bearer ${process.env.UPSTASH_REDIS_REST_TOKEN}` } }),
            fetchWithTimeout(`${process.env.UPSTASH_REDIS_REST_URL}/incr/stats:generations:${today}`, { headers: { Authorization: `Bearer ${process.env.UPSTASH_REDIS_REST_TOKEN}` } }),
          ]);
          return res.status(200).json({ ...result, creditsRemaining: newCredits, tier: 'credits' });
        }
      } catch(e) {
        console.error('Credits tier error:', e.message);
        return res.status(500).json({ error: 'Internal error' });
      }
    }
    // Firma non valida → cade nel free tier sotto
  }

  // --- FREE TIER (IP-based, 2/day) ---
  const ip = getTrustedIp(req);
  const freeKey = getFreeTierKey(ip);

  // Check current usage WITHOUT incrementing yet
  const currentUsed = await (async () => {
    const base = process.env.UPSTASH_REDIS_REST_URL;
    const auth = { Authorization: `Bearer ${process.env.UPSTASH_REDIS_REST_TOKEN}` };
    const r = await fetchWithTimeout(`${base}/get/${encodeURIComponent(freeKey)}`, { headers: auth });
    const d = await r.json();
    return parseInt(d.result) || 0;
  })();

  if (currentUsed >= FREE_LIMIT) {
    return res.status(429).json({
      error: 'free_limit_reached',
      message: `You've used your ${FREE_LIMIT} free generations today.`,
      used: currentUsed, limit: FREE_LIMIT,
    });
  }

  try {
    const result = await callAnthropic(formData);
    // Increment only after successful generation
    const used = await redisIncrFreeTier(freeKey);
    // Global stats
    const todayKey = new Date().toISOString().slice(0, 10);
    await Promise.allSettled([
      fetchWithTimeout(`${process.env.UPSTASH_REDIS_REST_URL}/incr/stats:generations_total`, { headers: { Authorization: `Bearer ${process.env.UPSTASH_REDIS_REST_TOKEN}` } }),
      fetchWithTimeout(`${process.env.UPSTASH_REDIS_REST_URL}/incr/stats:generations:${todayKey}`, { headers: { Authorization: `Bearer ${process.env.UPSTASH_REDIS_REST_TOKEN}` } }),
    ]);
    return res.status(200).json({
      ...result,
      used,
      limit: FREE_LIMIT,
      remaining: Math.max(0, FREE_LIMIT - used),
      tier: 'free',
    });
  } catch(e) {
    console.error('Free tier error:', e.message);
    return res.status(500).json({ error: 'Internal error' });
  }
}

async function callAnthropic(formData) {
  const resp = await fetchWithTimeout('https://api.anthropic.com/v1/messages', {
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
  }, 10000);
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
