// api/webhook.js — Stripe webhook handler
// Receives payment events, assigns credits, sends confirmation email via Resend

import Stripe from 'stripe';
import { Redis } from '@upstash/redis';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

// Credit packages — must match Stripe Price IDs
const PACKAGES = {
  [process.env.STRIPE_PRICE_STARTER]: { credits: 50,  label: 'Starter',  price: '1.99' },
  [process.env.STRIPE_PRICE_PRO]:     { credits: 150, label: 'Pro',      price: '3.99' },
  [process.env.STRIPE_PRICE_STUDIO]:  { credits: 400, label: 'Studio',   price: '7.99' },
};

export const config = { api: { bodyParser: false } };

async function getRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const rawBody = await getRawBody(req);
  const sig = req.headers['stripe-signature'];

  let event;
  try {
    event = stripe.webhooks.constructEvent(rawBody, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Webhook signature failed:', err.message);
    return res.status(400).json({ error: `Webhook Error: ${err.message}` });
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const uuid = session.metadata?.uuid;
    const email = session.customer_details?.email;
    const priceId = session.line_items?.data?.[0]?.price?.id;

    // Fetch line items if not expanded
    let resolvedPriceId = priceId;
    if (!resolvedPriceId) {
      const lineItems = await stripe.checkout.sessions.listLineItems(session.id);
      resolvedPriceId = lineItems.data?.[0]?.price?.id;
    }

    const pkg = PACKAGES[resolvedPriceId];
    if (!uuid || !pkg) {
      console.error('Missing uuid or unknown price:', resolvedPriceId, uuid);
      return res.status(200).json({ received: true });
    }

    // Add credits to Redis (persist forever — no expiry)
    const newCredits = await redis.incrby(`credits:${uuid}`, pkg.credits);

    // Send confirmation email via Resend
    if (email) {
      await sendEmail(email, pkg, newCredits, uuid);
    }

    console.log(`✅ ${pkg.credits} credits added for ${uuid} (${email}). Total: ${newCredits}`);
  }

  return res.status(200).json({ received: true });
}

async function sendEmail(email, pkg, totalCredits, uuid) {
  try {
    await fetch('https://api.resend.com/emails', {
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
    <a href="https://supre.online" style="display:inline-block;background:linear-gradient(135deg,#7b5cff,#ff3c5f);color:#fff;text-decoration:none;padding:14px 32px;border-radius:8px;font-size:14px;letter-spacing:2px;text-transform:uppercase;font-weight:bold">START GENERATING →</a>
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
