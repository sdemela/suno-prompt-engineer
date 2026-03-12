// api/checkout.js — creates a Stripe Checkout session
import Stripe from 'stripe';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

const PACKAGES = {
  starter: process.env.STRIPE_PRICE_STARTER,
  pro:     process.env.STRIPE_PRICE_PRO,
  studio:  process.env.STRIPE_PRICE_STUDIO,
};

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { pkg, uuid, lang } = req.body || {};

  if (!pkg || !PACKAGES[pkg]) return res.status(400).json({ error: 'Invalid package' });
  if (!uuid || uuid.length < 10) return res.status(400).json({ error: 'Invalid UUID' });

  const origin = lang === 'it' ? 'https://supre.online/it' : 'https://supre.online/en';

  try {
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      line_items: [{ price: PACKAGES[pkg], quantity: 1 }],
      metadata: { uuid },
      customer_email: undefined, // Stripe will ask for email at checkout
      success_url: `${origin}/?payment=success&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${origin}/?payment=cancelled`,
      locale: lang === 'it' ? 'it' : 'en',
      payment_method_types: ['card'],
      allow_promotion_codes: true,
    });

    return res.status(200).json({ url: session.url });
  } catch(e) {
    console.error('Stripe checkout error:', e.message);
    return res.status(500).json({ error: e.message });
  }
}
