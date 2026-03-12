// api/credits.js — check remaining credits for a user UUID
import { Redis } from '@upstash/redis';

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { uuid } = req.body || {};
  if (!uuid || uuid.length < 10) return res.status(400).json({ error: 'Invalid UUID' });

  try {
    const credits = await redis.get(`credits:${uuid}`) || 0;
    return res.status(200).json({ credits: parseInt(credits) });
  } catch(e) {
    return res.status(500).json({ error: e.message });
  }
}
