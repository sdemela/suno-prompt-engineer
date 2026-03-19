// api/webhook.js — Stripe webhook handler (no SDK, pure fetch)
import crypto from 'crypto';

const PACKAGES = {
  [process.env.STRIPE_PRICE_STARTER]: { credits: 50,  label: 'Starter',  price: '1.99' },
  [process.env.STRIPE_PRICE_PRO]:     { credits: 150, label: 'Pro',      price: '3.99' },
  [process.env.STRIPE_PRICE_STUDIO]:  { credits: 400, label: 'Studio',   price: '7.99' },
};

export const config = { api: { bodyParser: false } };

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

// Fix #3: body size limit 512KB to prevent DoS
const MAX_BODY_SIZE = 512 * 1024;

async function getRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_BODY_SIZE) {
        req.destroy();
        return reject(new Error('Payload too large'));
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// Stripe webhook signature verification — timing-safe (fix #5)
function verifyStripeSignature(rawBody, sig, secret) {
  const parts = sig.split(',').reduce((acc, p) => {
    const [k, v] = p.split('=');
    acc[k] = v;
    return acc;
  }, {});
  const timestamp = parts['t'];
  const expected  = parts['v1'];
  if (!timestamp || !expected) throw new Error('Invalid signature header');

  const payload = `${timestamp}.${rawBody.toString('utf8')}`;
  const hmac    = crypto.createHmac('sha256', secret).update(payload).digest();

  // Fix #5: constant-time comparison to prevent timing attacks
  const expectedBuf = Buffer.from(expected, 'hex');
  if (hmac.length !== expectedBuf.length || !crypto.timingSafeEqual(hmac, expectedBuf)) {
    throw new Error('Signature mismatch');
  }

  // Reject events older than 5 minutes
  if (Math.abs(Date.now() / 1000 - parseInt(timestamp)) > 300) throw new Error('Timestamp too old');
  return true;
}

// Upstash REST helpers
async function redisIncrby(key, amount) {
  const r = await fetchWithTimeout(`${process.env.UPSTASH_REDIS_REST_URL}/incrby/${key}/${amount}`, {
    headers: { Authorization: `Bearer ${process.env.UPSTASH_REDIS_REST_TOKEN}` }
  });
  const d = await r.json();
  return d.result;
}

// Fix #4: check-only — does NOT mark as processed
async function isEventAlreadyProcessed(eventId) {
  const key = `whook:${eventId}`;
  const r = await fetchWithTimeout(`${process.env.UPSTASH_REDIS_REST_URL}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${process.env.UPSTASH_REDIS_REST_TOKEN}` }
  });
  const d = await r.json();
  return d.result !== null;
}

// Fix #4: mark as processed — called only AFTER credits confirmed
async function markEventProcessed(eventId) {
  const key = `whook:${eventId}`;
  await fetchWithTimeout(`${process.env.UPSTASH_REDIS_REST_URL}/set/${encodeURIComponent(key)}/1/ex/86400`, {
    headers: { Authorization: `Bearer ${process.env.UPSTASH_REDIS_REST_TOKEN}` }
  });
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const rawBody = await getRawBody(req);
  const sig = req.headers['stripe-signature'];
  if (!sig) return res.status(400).json({ error: 'Missing stripe-signature header' });

  let event;
  try {
    verifyStripeSignature(rawBody, sig, process.env.STRIPE_WEBHOOK_SECRET);
    event = JSON.parse(rawBody.toString('utf8'));
  } catch (err) {
    console.error('Webhook error:', err.message);
    return res.status(400).json({ error: err.message });
  }

  if (event.type === 'checkout.session.completed') {

    const session = event.data.object;
    const uuid    = session.metadata?.uuid;
    const email   = session.customer_details?.email;

    // Fetch line items from Stripe REST to get price ID
    let resolvedPriceId = null;
    try {
      const liResp = await fetchWithTimeout(
        `https://api.stripe.com/v1/checkout/sessions/${session.id}/line_items`,
        { headers: { Authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}` } }
      );
      const liData = await liResp.json();
      resolvedPriceId = liData.data?.[0]?.price?.id;
    } catch(e) {
      console.error('Line items fetch failed:', e.message);
    }

    const pkg = PACKAGES[resolvedPriceId];
    if (!uuid || !pkg) {
      console.error('Missing uuid or unknown price:', resolvedPriceId, uuid);
      return res.status(200).json({ received: true });
    }

    // Fix #4: idempotency check BEFORE side-effects but mark AFTER success
    const alreadyProcessed = await isEventAlreadyProcessed(event.id);
    if (alreadyProcessed) {
      console.log(`⚠️ Duplicate event ignored: ${event.id}`);
      return res.status(200).json({ received: true, duplicate: true });
    }

    // Add credits via Upstash REST
    const newCredits = await redisIncrby(`credits:${uuid}`, pkg.credits);

    // Fix #4: mark as processed only AFTER credits confirmed
    await markEventProcessed(event.id);

    // Global stats counters
    const today = new Date().toISOString().slice(0, 10);
    const priceEur = parseFloat(pkg.price) || 0;
    await Promise.allSettled([
      fetchWithTimeout(`${process.env.UPSTASH_REDIS_REST_URL}/incrbyfloat/stats:revenue_eur/${priceEur}`, { headers: { Authorization: `Bearer ${process.env.UPSTASH_REDIS_REST_TOKEN}` } }),
      fetchWithTimeout(`${process.env.UPSTASH_REDIS_REST_URL}/incrby/stats:credits_sold/${pkg.credits}`, { headers: { Authorization: `Bearer ${process.env.UPSTASH_REDIS_REST_TOKEN}` } }),
      fetchWithTimeout(`${process.env.UPSTASH_REDIS_REST_URL}/incr/stats:paid_users`, { headers: { Authorization: `Bearer ${process.env.UPSTASH_REDIS_REST_TOKEN}` } }),
    ]);

    // Send confirmation email via Resend
    if (email) await sendEmail(email, pkg, newCredits, uuid);

    console.log(`✅ ${pkg.credits} credits added for ${uuid} (${email}). Total: ${newCredits}`);
  }

  return res.status(200).json({ received: true });
}

async function sendEmail(email, pkg, totalCredits, uuid) {
  try {
    await fetchWithTimeout('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: 'Suno Prompt Engineer <noreply@supre.online>',
        to: email,
        subject: `✦ ${pkg.credits} credits activated — Suno Prompt Engineer`,
        html: `
<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"></head>
<body style="background:#0a0a0a;color:#e8e8f0;font-family:'Courier New',monospace;padding:40px 20px;max-width:560px;margin:0 auto">
  <div style="text-align:center;margin-bottom:32px">
    <div style="font-size:11px;letter-spacing:4px;color:#7b5cff;text-transform:uppercase;margin-bottom:8px">✦ Suno Prompt Engineer</div>
    <h1 style="font-size:32px;margin:0;color:#fff;letter-spacing:2px">CREDITS ACTIVATED</h1>
  </div>
  <div style="background:#1c1c28;border:1px solid #2a2a3a;border-radius:12px;padding:24px;margin-bottom:24px">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;padding-bottom:16px;border-bottom:1px solid #2a2a3a">
      <span style="color:#6b6b85;font-size:12px;letter-spacing:2px;text-transform:uppercase">Package</span>
      <span style="color:#fff;font-size:16px;font-weight:bold">${pkg.label}</span>
    </div>
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;padding-bottom:16px;border-bottom:1px solid #2a2a3a">
      <span style="color:#6b6b85;font-size:12px;letter-spacing:2px;text-transform:uppercase">Credits added</span>
      <span style="color:#7b5cff;font-size:24px;font-weight:bold">+${pkg.credits}</span>
    </div>
    <div style="display:flex;justify-content:space-between;align-items:center">
      <span style="color:#6b6b85;font-size:12px;letter-spacing:2px;text-transform:uppercase">Total available</span>
      <span style="color:#00e5b0;font-size:20px;font-weight:bold">${totalCredits}</span>
    </div>
  </div>
  <div style="background:#111118;border:1px solid #2a2a3a;border-radius:8px;padding:16px;margin-bottom:24px">
    <div style="font-size:10px;letter-spacing:2px;color:#6b6b85;text-transform:uppercase;margin-bottom:8px">Your session ID</div>
    <div style="font-size:11px;color:#7b5cff;word-break:break-all">${uuid}</div>
    <div style="font-size:11px;color:#6b6b85;margin-top:8px;line-height:1.6">Credits are linked to this browser session. If you switch browser or device, enter this ID in the tool to restore your credits.</div>
  </div>
  <div style="text-align:center">
    <a href="https://supre.online/en/tool" style="display:inline-block;background:linear-gradient(135deg,#7b5cff,#ff3c5f);color:#fff;text-decoration:none;padding:14px 32px;border-radius:8px;font-size:14px;letter-spacing:2px;text-transform:uppercase;font-weight:bold">START GENERATING →</a>
  </div>
  <div style="text-align:center;margin-top:32px;font-size:10px;color:#2a2a3a;letter-spacing:1px">
    supre.online · Suno Prompt Engineer<br>
    Credits never expire.
  </div>
</body>
</html>`,
      }),
    });
  } catch(e) {
    console.error('Email send failed:', e.message);
  }
}
