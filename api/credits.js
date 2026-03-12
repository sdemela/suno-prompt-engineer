// api/credits.js — check remaining credits for a user UUID (Upstash REST, no SDK)
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { uuid } = req.body || {};
  if (!uuid || uuid.length < 10) return res.status(400).json({ error: 'Invalid UUID' });

  const UPSTASH_URL   = process.env.UPSTASH_REDIS_REST_URL;
  const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

  try {
    const r = await fetch(`${UPSTASH_URL}/get/credits:${uuid}`, {
      headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` }
    });
    const d = await r.json();
    const credits = parseInt(d.result) || 0;
    return res.status(200).json({ credits });
  } catch(e) {
    return res.status(500).json({ error: e.message });
  }
}
