// CORS allowlist (fix #3)
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

// api/save-email.js
// FIX #1: two explicit flows (sign-only / save+email)
// Vercel: client IP is the first element of x-forwarded-for
// FIX #4: validazione UUID canonica

const RATE_IP_MAX  = 3;
const RATE_IP_TTL  = 3600;
const RATE_UUID_TTL = 600;

// FIX #4: validazione UUID canonica — coerente con tutti gli altri endpoint
function isValidSpeUuid(uuid) {
  return typeof uuid === 'string' &&
    uuid.startsWith('spe-') &&
    uuid.length >= 15 &&
    uuid.length <= 60;
}

// Vercel: client IP is the first element of x-forwarded-for
// getTrustedIp — canonical version in _auth.js, kept local to avoid dynamic import overhead
function getTrustedIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) {
    const ips = forwarded.split(',').map(s => s.trim()).filter(Boolean);
    return ips[0] || 'unknown';
  }
  return req.socket?.remoteAddress || 'unknown';
}

// Fix #5: timeout wrapper for all external calls
async function fetchWithTimeout(url, options = {}, ms = 5000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function redisSet(key, value) {
  const url = `${process.env.UPSTASH_REDIS_REST_URL}/set/${encodeURIComponent(key)}/${encodeURIComponent(value)}`;
  const r = await fetchWithTimeout(url, { headers: { Authorization: `Bearer ${process.env.UPSTASH_REDIS_REST_TOKEN}` } });
  if (!r.ok) throw new Error(`Redis SET failed: ${r.status}`);
  return true;
}

async function redisIncrWithTTL(key, ttl) {
  const base = process.env.UPSTASH_REDIS_REST_URL;
  const auth = { Authorization: `Bearer ${process.env.UPSTASH_REDIS_REST_TOKEN}` };
  const incr = await fetchWithTimeout(`${base}/incr/${encodeURIComponent(key)}`, { headers: auth });
  if (!incr.ok) throw new Error(`Redis INCR failed: ${incr.status}`);
  const d = await incr.json();
  const count = d.result;
  if (count === 1) {
    await fetchWithTimeout(`${base}/expire/${encodeURIComponent(key)}/${ttl}`, { headers: auth });
  }
  return count;
}

async function redisSetNxEx(key, ttl) {
  const r = await fetchWithTimeout(`${process.env.UPSTASH_REDIS_REST_URL}/set/${encodeURIComponent(key)}/1/nx/ex/${ttl}`, {
    headers: { Authorization: `Bearer ${process.env.UPSTASH_REDIS_REST_TOKEN}` }
  });
  if (!r.ok) throw new Error(`Redis SETNX failed: ${r.status}`);
  const d = await r.json();
  return d.result === 'OK';
}

export default async function handler(req, res) {
  setCors(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { uuid, email } = req.body || {};

  // FIX #4: validazione UUID canonica
  if (!isValidSpeUuid(uuid)) return res.status(400).json({ error: 'Invalid UUID format' });

  // FIX #1 — FLOW 1: sign-only (no email)
  // Rate limited: 1 signature per UUID per 10 min to prevent HMAC fishing
  if (!email) {
    try {
      const ip = getTrustedIp(req);
      const signKey = `rl:sign:${ip}`;
      const signCount = await redisIncrWithTTL(signKey, 600);
      if (signCount > 5) {
        return res.status(429).json({ error: 'rate_limit', message: 'Too many signature requests.' });
      }
      const { signUUID } = await import('./_auth.js');
      const sig = signUUID(uuid);
      return res.status(200).json({ ok: true, sig });
    } catch(e) {
      console.error('[save-email] sign-only error:', e.message);
      return res.status(500).json({ error: 'Failed to generate signature' });
    }
  }

  // FIX #1 — FLOW 2: save+email (email obbligatoria e valida)
  if (!email.includes('@') || email.length < 5) {
    return res.status(400).json({ error: 'Invalid email' });
  }

  const ip = getTrustedIp(req);

  const uuidKey = `rl:email:uuid:${uuid}`;
  const uuidOk = await redisSetNxEx(uuidKey, RATE_UUID_TTL);
  if (!uuidOk) {
    return res.status(429).json({ error: 'cooldown', message: 'Please wait 10 minutes before requesting another session ID email.' });
  }

  const ipKey = `rl:email:ip:${ip}`;
  const ipCount = await redisIncrWithTTL(ipKey, RATE_IP_TTL);
  if (ipCount > RATE_IP_MAX) {
    return res.status(429).json({ error: 'rate_limit', message: 'Too many requests from this IP. Try again later.' });
  }

  try {
    await redisSet(`email:${email}`, uuid);
    await redisSet(`uuid:${uuid}:email`, email);

    const { signUUID } = await import('./_auth.js');
    const sig = signUUID(uuid);

    const emailRes = await fetchWithTimeout('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: 'Suno Prompt Engineer <noreply@supre.online>',
        to: email,
        subject: '🔑 Your Suno Prompt Engineer Session ID',
        html: `<!DOCTYPE html><html><head><meta charset="UTF-8"></head><body style="background:#0a0a0a;color:#e8e8f0;font-family:'Courier New',monospace;padding:40px 20px;max-width:560px;margin:0 auto"><div style="text-align:center;margin-bottom:32px"><div style="font-size:11px;letter-spacing:4px;color:#7b5cff;text-transform:uppercase;margin-bottom:8px">✦ Suno Prompt Engineer</div><h1 style="font-size:28px;margin:0;color:#fff;letter-spacing:2px">YOUR SESSION ID</h1></div><div style="background:#1c1c28;border:1px solid #2a2a3a;border-radius:12px;padding:24px;margin-bottom:24px"><div style="font-size:10px;letter-spacing:2px;color:#6b6b85;text-transform:uppercase;margin-bottom:12px">Session ID — keep this safe</div><div style="font-family:'Courier New',monospace;font-size:13px;color:#7b5cff;word-break:break-all;background:#0a0a0a;padding:12px;border-radius:8px;border:1px solid #2a2a3a">${uuid}</div></div><div style="background:#111118;border:1px solid #2a2a3a;border-radius:8px;padding:16px;margin-bottom:24px;font-size:12px;color:#6b6b85;line-height:1.7">Use this ID to restore your credits on any browser or device:<br>1. Go to <a href="https://supre.online" style="color:#7b5cff">supre.online</a><br>2. Click <strong style="color:#e8e8f0">+ Buy more</strong><br>3. Click <strong style="color:#e8e8f0">Restore credits with session ID</strong><br>4. Paste this ID</div><div style="text-align:center"><a href="https://supre.online" style="display:inline-block;background:linear-gradient(135deg,#7b5cff,#ff3c5f);color:#fff;text-decoration:none;padding:14px 32px;border-radius:8px;font-size:14px;letter-spacing:2px;text-transform:uppercase;font-weight:bold">GO TO SUPRE.ONLINE →</a></div><div style="text-align:center;margin-top:32px;font-size:10px;color:#2a2a3a;letter-spacing:1px">supre.online · Credits never expire.</div></body></html>`,
      }),
    });

    if (!emailRes.ok) {
      const emailErr = await emailRes.json().catch(() => ({}));
      console.error('[save-email] Resend error:', emailErr);
    }

    return res.status(200).json({ ok: true, sig });
  } catch(e) {
    console.error('[save-email] error:', e.message);
    return res.status(500).json({ error: 'Internal error' });
  }
}
