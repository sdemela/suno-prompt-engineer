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

function setSecurityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
}

// api/credits.js
// Vercel: client IP is the first element of x-forwarded-for
// FIX #3: usa il parametro ttl invece di hardcoded 60

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
  const r = await fetchWithTimeout(url, { headers: { Authorization: `Bearer ${process.env.UPSTASH_REDIS_REST_TOKEN}` } });
  const d = await r.json();
  return d.result;
}

async function redisIncrWithTTL(key, ttl) {
  const base = process.env.UPSTASH_REDIS_REST_URL;
  const auth = { Authorization: `Bearer ${process.env.UPSTASH_REDIS_REST_TOKEN}` };
  const incr = await fetchWithTimeout(`${base}/incr/${encodeURIComponent(key)}`, { headers: auth });
  const d = await incr.json();
  const count = d.result;
  if (count === 1) {
    await fetchWithTimeout(`${base}/expire/${encodeURIComponent(key)}/${ttl}`, { headers: auth });
  }
  return count;
}

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

  const { uuid } = req.body || {};

  if (!uuid || typeof uuid !== 'string') {
    return res.status(400).json({ error: 'Invalid UUID' });
  }
  if (!uuid.startsWith('spe-') || uuid.length < 15 || uuid.length > 60) {
    return res.status(400).json({ error: 'Invalid UUID format' });
  }

  // Vercel: client IP is the first element of x-forwarded-for
  const ip = getTrustedIp(req);
  const rateLimitKey = `rl:credits:ip:${ip}`;
  const count = await redisIncrWithTTL(rateLimitKey, 60); // 20 req/min
  if (count > 20) {
    return res.status(429).json({ error: 'Too many requests' });
  }

  // HMAC auth
  const { verifyHMAC } = await import('./_auth.js');
  const sig = req.headers['x-spe-sig'] || '';
  const { valid } = verifyHMAC(uuid, sig);
  if (!valid) {
    return res.status(200).json({ credits: 0, authenticated: false });
  }

  try {
    const result = await redisGet(`credits:${uuid}`);
    const credits = parseInt(result) || 0;
    return res.status(200).json({ credits, authenticated: true });
  } catch(e) {
    console.error('[credits] Redis error:', e.message);
    return res.status(500).json({ error: 'Internal error' });
  }
}
