// CORS allowlist
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

// Security headers
function setSecurityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
}

// api/credits.js — check remaining credits for a user UUID
// FIX #1 IDOR: UUID must match the session making the request
// We validate the UUID format and only return credits for valid SPE UUIDs
// Since we have no server-side sessions yet, we add rate limiting to prevent enumeration

async function redisGet(key) {
  const url = `${process.env.UPSTASH_REDIS_REST_URL}/get/${encodeURIComponent(key)}`;
  const r = await fetch(url, {
    headers: { Authorization: `Bearer ${process.env.UPSTASH_REDIS_REST_TOKEN}` }
  });
  const d = await r.json();
  return d.result;
}

// Rate limit credits checks — prevent UUID enumeration
async function redisIncrWithTTL(key, ttl) {
  const base = process.env.UPSTASH_REDIS_REST_URL;
  const auth = { Authorization: `Bearer ${process.env.UPSTASH_REDIS_REST_TOKEN}` };
  const incr = await fetch(`${base}/incr/${encodeURIComponent(key)}`, { headers: auth });
  const d = await incr.json();
  const count = d.result;
  if (count === 1) {
    await fetch(`${base}/expire/${encodeURIComponent(key)}/60`, { headers: auth });
  }
  return count;
}

export default async function handler(req, res) {
  setCors(req, res);
  setSecurityHeaders(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { uuid } = req.body || {};

  // Validate UUID format — must match our SPE format: spe-{timestamp}-{random}
  if (!uuid || typeof uuid !== 'string') {
    return res.status(400).json({ error: 'Invalid UUID' });
  }
  if (!uuid.startsWith('spe-') || uuid.length < 15 || uuid.length > 60) {
    return res.status(400).json({ error: 'Invalid UUID format' });
  }

  // FIX #1 IDOR: Rate limit per IP to prevent UUID enumeration attacks
  // Max 20 credit checks per IP per minute
  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress || 'unknown';
  const rateLimitKey = `rl:credits:ip:${ip}`;
  const count = await redisIncrWithTTL(rateLimitKey, 60);
  if (count > 20) {
    return res.status(429).json({ error: 'Too many requests' });
  }

  try {
    const result = await redisGet(`credits:${uuid}`);
    const credits = parseInt(result) || 0;
    return res.status(200).json({ credits });
  } catch(e) {
    return res.status(500).json({ error: e.message });
  }
}
