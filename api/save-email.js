// api/save-email.js — saves user email linked to UUID, sends session ID via Resend

async function redisSet(key, value) {
  const url = `${process.env.UPSTASH_REDIS_REST_URL}/set/${encodeURIComponent(key)}/${encodeURIComponent(value)}`;
  const r = await fetch(url, {
    headers: { Authorization: `Bearer ${process.env.UPSTASH_REDIS_REST_TOKEN}` }
  });
  return r.ok;
}

async function redisGet(key) {
  const url = `${process.env.UPSTASH_REDIS_REST_URL}/get/${encodeURIComponent(key)}`;
  const r = await fetch(url, {
    headers: { Authorization: `Bearer ${process.env.UPSTASH_REDIS_REST_TOKEN}` }
  });
  const d = await r.json();
  return d.result;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { uuid, email } = req.body || {};
  if (!uuid || uuid.length < 10) return res.status(400).json({ error: 'Invalid UUID' });
  if (!email || !email.includes('@')) return res.status(400).json({ error: 'Invalid email' });

  try {
    // Save email → uuid mapping
    await redisSet(`email:${email}`, uuid);
    await redisSet(`uuid:${uuid}:email`, email);

    // Send email with session ID via Resend
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: 'Suno Prompt Engineer <noreply@supre.online>',
        to: email,
        subject: '🔑 Your Suno Prompt Engineer Session ID',
        html: `
<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"></head>
<body style="background:#0a0a0a;color:#e8e8f0;font-family:'Courier New',monospace;padding:40px 20px;max-width:560px;margin:0 auto">
  <div style="text-align:center;margin-bottom:32px">
    <div style="font-size:11px;letter-spacing:4px;color:#7b5cff;text-transform:uppercase;margin-bottom:8px">✦ Suno Prompt Engineer</div>
    <h1 style="font-size:28px;margin:0;color:#fff;letter-spacing:2px">YOUR SESSION ID</h1>
  </div>
  <div style="background:#1c1c28;border:1px solid #2a2a3a;border-radius:12px;padding:24px;margin-bottom:24px">
    <div style="font-size:10px;letter-spacing:2px;color:#6b6b85;text-transform:uppercase;margin-bottom:12px">Session ID — keep this safe</div>
    <div style="font-family:'Courier New',monospace;font-size:13px;color:#7b5cff;word-break:break-all;background:#0a0a0a;padding:12px;border-radius:8px;border:1px solid #2a2a3a">${uuid}</div>
  </div>
  <div style="background:#111118;border:1px solid #2a2a3a;border-radius:8px;padding:16px;margin-bottom:24px;font-size:12px;color:#6b6b85;line-height:1.7">
    Use this ID to restore your credits on any browser or device:<br>
    1. Go to <a href="https://supre.online" style="color:#7b5cff">supre.online</a><br>
    2. Click <strong style="color:#e8e8f0">+ Buy more</strong> or wait for the limit modal<br>
    3. Click <strong style="color:#e8e8f0">Restore credits with session ID</strong><br>
    4. Paste this ID
  </div>
  <div style="text-align:center">
    <a href="https://supre.online" style="display:inline-block;background:linear-gradient(135deg,#7b5cff,#ff3c5f);color:#fff;text-decoration:none;padding:14px 32px;border-radius:8px;font-size:14px;letter-spacing:2px;text-transform:uppercase;font-weight:bold">GO TO SUPRE.ONLINE →</a>
  </div>
  <div style="text-align:center;margin-top:32px;font-size:10px;color:#2a2a3a;letter-spacing:1px">
    supre.online · Credits never expire.
  </div>
</body>
</html>`,
      }),
    });

    return res.status(200).json({ ok: true });
  } catch(e) {
    return res.status(500).json({ error: e.message });
  }
}
