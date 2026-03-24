// api/admin.js — metrics dashboard endpoint
// Protected by ADMIN_TOKEN env variable

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
  const r = await fetchWithTimeout(
    `${process.env.UPSTASH_REDIS_REST_URL}/get/${encodeURIComponent(key)}`,
    { headers: { Authorization: `Bearer ${process.env.UPSTASH_REDIS_REST_TOKEN}` } }
  );
  const d = await r.json();
  return d.result;
}

async function redisScan(pattern) {
  const base = process.env.UPSTASH_REDIS_REST_URL;
  const auth = { Authorization: `Bearer ${process.env.UPSTASH_REDIS_REST_TOKEN}` };
  let cursor = '0';
  const keys = [];
  do {
    const r = await fetchWithTimeout(
      `${base}/scan/${cursor}?match=${encodeURIComponent(pattern)}&count=100`,
      { headers: auth }
    );
    const d = await r.json();
    cursor = d.result[0];
    keys.push(...d.result[1]);
  } while (cursor !== '0');
  return keys;
}

// Rate limit helper for admin brute-force protection
async function checkAdminRateLimit(ip) {
  const key = `rl:admin:${ip}`;
  const r = await fetchWithTimeout(
    `${process.env.UPSTASH_REDIS_REST_URL}/incr/${encodeURIComponent(key)}`,
    { headers: { Authorization: `Bearer ${process.env.UPSTASH_REDIS_REST_TOKEN}` } }
  );
  const d = await r.json();
  const count = d.result;
  if (count === 1) {
    await fetchWithTimeout(
      `${process.env.UPSTASH_REDIS_REST_URL}/expire/${encodeURIComponent(key)}/900`,
      { headers: { Authorization: `Bearer ${process.env.UPSTASH_REDIS_REST_TOKEN}` } }
    );
  }
  return count;
}

function getTrustedIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) {
    const ips = forwarded.split(',').map(s => s.trim()).filter(Boolean);
    return ips[0] || 'unknown';
  }
  return req.socket?.remoteAddress || 'unknown';
}

export default async function handler(req, res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).end();

  // Rate limit: max 10 requests per 15 minutes per IP
  const ip = getTrustedIp(req);
  const rlCount = await checkAdminRateLimit(ip);
  if (rlCount > 10) {
    return res.status(429).json({ error: 'Too many requests' });
  }

  // Auth via header only — never via query string (tokens in URLs end up in logs/history)
  const token = req.headers['x-admin-token'] || (req.headers['authorization'] || '').replace('Bearer ', '');
  if (!token || token !== process.env.ADMIN_TOKEN) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const today = new Date().toISOString().slice(0, 10);
    const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);

    // Global counters (set by webhook + generate)
    const [
      revenueTotal,
      creditsTotal,
      generationsTotal,
      generationsToday,
      generationsYesterday,
      paidUsers,
    ] = await Promise.all([
      redisGet('stats:revenue_eur'),
      redisGet('stats:credits_sold'),
      redisGet('stats:generations_total'),
      redisGet(`stats:generations:${today}`),
      redisGet(`stats:generations:${yesterday}`),
      redisGet('stats:paid_purchases'),
    ]);

    // Scan free tier keys for today's active free users
    const freeKeysToday = await redisScan(`free:*:${today}`);

    // Scan paid credit keys to get active paid UUIDs
    const creditKeys = await redisScan('credits:*');

    // Fix #6: process ALL keys in batches of 20 to avoid partial counts
    let activeCredits = 0;
    for (let i = 0; i < creditKeys.length; i += 20) {
      const batch = creditKeys.slice(i, i + 20);
      const values = await Promise.all(batch.map(k => redisGet(k)));
      activeCredits += values.reduce((sum, v) => sum + (parseInt(v) || 0), 0);
    }

    return res.status(200).json({
      revenue: {
        total_eur: parseFloat(revenueTotal) || 0,
        credits_sold: parseInt(creditsTotal) || 0,
        paid_purchases: parseInt(paidUsers) || 0, // Fix #7: renamed from paid_users — counts purchases not unique users
      },
      generations: {
        total: parseInt(generationsTotal) || 0,
        today: parseInt(generationsToday) || 0,
        yesterday: parseInt(generationsYesterday) || 0,
        free_users_today: freeKeysToday.length,
      },
      credits: {
        active_paid_uuids: creditKeys.length,
        remaining_credits: activeCredits, // Fix #6: now counts all UUIDs, not just first 50
      },
      timestamp: new Date().toISOString(),
    });
  } catch (e) {
    console.error('[admin] error:', e.message);
    return res.status(500).json({ error: 'Internal error' });
  }
}
