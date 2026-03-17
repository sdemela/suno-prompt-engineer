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

// api/checkout.js — creates a Stripe Checkout session (no SDK, pure fetch)
// FIX #4: validazione UUID canonica (coerente con credits/generate/_auth)

const PACKAGES = {
  starter: process.env.STRIPE_PRICE_STARTER,
  pro:     process.env.STRIPE_PRICE_PRO,
  studio:  process.env.STRIPE_PRICE_STUDIO,
};

// FIX #4: validazione UUID canonica — stessa logica di credits/generate/_auth
function isValidSpeUuid(uuid) {
  return typeof uuid === 'string' &&
    uuid.startsWith('spe-') &&
    uuid.length >= 15 &&
    uuid.length <= 60;
}

export default async function handler(req, res) {
  setCors(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { pkg, uuid, lang } = req.body || {};
  if (!pkg || !PACKAGES[pkg]) return res.status(400).json({ error: 'Invalid package' });

  // FIX #4: usa validazione canonica invece di uuid.length < 10
  if (!isValidSpeUuid(uuid)) return res.status(400).json({ error: 'Invalid UUID format' });

  // HMAC auth — obbligatoria per checkout
  const { verifyHMAC } = await import('./_auth.js');
  const sig = req.headers['x-spe-sig'] || '';
  const { valid } = verifyHMAC(uuid, sig);
  if (!valid) return res.status(401).json({ error: 'Invalid signature. Reload the page and try again.' });

  const origin = lang === 'it' ? 'https://supre.online/it' : 'https://supre.online/en';
  const params = new URLSearchParams({
    mode: 'payment',
    'line_items[0][price]': PACKAGES[pkg],
    'line_items[0][quantity]': '1',
    'metadata[uuid]': uuid,
    success_url: `${origin}/?payment=success&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${origin}/?payment=cancelled`,
    locale: lang === 'it' ? 'it' : 'en',
    'payment_method_types[0]': 'card',
    allow_promotion_codes: 'true',
  });

  try {
    const r = await fetch('https://api.stripe.com/v1/checkout/sessions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.STRIPE_SECRET_KEY}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params.toString(),
    });
    if (!r.ok) {
      const d = await r.json().catch(() => ({}));
      throw new Error(d.error?.message || `Stripe error ${r.status}`);
    }
    const d = await r.json();
    if (d.error) throw new Error(d.error.message);
    return res.status(200).json({ url: d.url });
  } catch(e) {
    console.error('[checkout] Stripe error:', e.message);
    return res.status(500).json({ error: 'Payment session failed. Please try again.' });
  }
}
