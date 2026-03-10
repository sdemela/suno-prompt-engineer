// api/generate.js — Vercel serverless function
// Handles free-tier AI calls (max 2/day per IP)
// Rate limit stored in-memory per invocation (use Vercel KV or Upstash Redis for production persistence)

const FREE_LIMIT = 2;

// Simple in-memory store — resets on cold start
// For persistent rate limiting, replace with Upstash Redis (free tier available)
const ipStore = new Map();

function getTodayKey(ip) {
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  return `${ip}::${today}`;
}

export default async function handler(req, res) {
  // CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const ip = req.headers["x-forwarded-for"]?.split(",")[0] || req.socket.remoteAddress || "unknown";
  const key = getTodayKey(ip);
  const used = ipStore.get(key) || 0;

  const { refDesc, mode } = req.body || {};

  // If just checking quota
  if (mode === "check") {
    return res.status(200).json({ used, limit: FREE_LIMIT, remaining: Math.max(0, FREE_LIMIT - used) });
  }

  if (!refDesc) return res.status(400).json({ error: "Missing refDesc" });

  // Check rate limit
  if (used >= FREE_LIMIT) {
    return res.status(429).json({
      error: "free_limit_reached",
      message: `Hai usato i tuoi ${FREE_LIMIT} prompt gratuiti di oggi. Inserisci la tua API key per continuare.`,
      used,
      limit: FREE_LIMIT
    });
  }

  // Call Anthropic
  const sysPrompt =
    "You are a music prompt engineer for Suno AI. " +
    "The user describes a reference track in Italian or English. " +
    "Extract 4-8 concise English style keywords for Suno Style of Music field. " +
    "NEVER include artist names or song titles. " +
    "Output ONLY a raw JSON array of strings, no markdown, no explanation. " +
    "Max 4 words per item. Focus on rhythm, texture, energy, mix, structure. " +
    'Example: ["hypnotic groove","dry punchy kick","long reverb tails","warm analog mix"]';

  try {
    const resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 300,
        system: sysPrompt,
        messages: [{ role: "user", content: "Reference: " + refDesc }]
      })
    });

    if (!resp.ok) {
      const err = await resp.json();
      return res.status(500).json({ error: err.error?.message || "Anthropic API error" });
    }

    const data = await resp.json();
    const raw = (data.content || []).find(b => b.type === "text")?.text || "[]";
    const keywords = JSON.parse(raw.replace(/```json|```/g, "").trim());

    // Increment counter
    ipStore.set(key, used + 1);

    return res.status(200).json({ keywords, used: used + 1, limit: FREE_LIMIT, remaining: Math.max(0, FREE_LIMIT - used - 1) });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
