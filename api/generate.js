// api/generate.js — Vercel serverless function
// Handles free-tier AI calls (max 2/day per IP)
// From 3rd use onward, user must provide their own API key (BYOK)

const FREE_LIMIT = 2;
const ipStore = new Map();

function getTodayKey(ip) {
  const today = new Date().toISOString().slice(0, 10);
  return `${ip}::${today}`;
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const ip = req.headers["x-forwarded-for"]?.split(",")[0] || req.socket.remoteAddress || "unknown";
  const key = getTodayKey(ip);
  const used = ipStore.get(key) || 0;

  const { formData } = req.body || {};

  if (!formData) return res.status(400).json({ error: "Missing formData" });

  // Validate input length
  const totalLen = JSON.stringify(formData).length;
  if (totalLen > 3000) return res.status(400).json({ error: "Input too long" });

  // Check rate limit
  if (used >= FREE_LIMIT) {
    return res.status(429).json({
      error: "free_limit_reached",
      message: `You've used your ${FREE_LIMIT} free generations today. Add your Anthropic API key to continue.`,
      used,
      limit: FREE_LIMIT
    });
  }

  const userMessage = buildUserMessage(formData);

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
        max_tokens: 600,
        system: buildSystemPrompt(formData.sunoVersion || "v4"),
        messages: [{ role: "user", content: userMessage }]
      })
    });

    if (!resp.ok) {
      const err = await resp.json();
      return res.status(500).json({ error: err.error?.message || "Anthropic API error" });
    }

    const data = await resp.json();
    const raw = (data.content || []).find(b => b.type === "text")?.text || "{}";

    let result;
    try {
      result = JSON.parse(raw.replace(/```json|```/g, "").trim());
      if (!result.stylePrompt) result = { stylePrompt: raw, tips: [] };
    } catch(e) {
      result = { stylePrompt: raw, tips: [] };
    }

    ipStore.set(key, used + 1);

    return res.status(200).json({
      ...result,
      used: used + 1,
      limit: FREE_LIMIT,
      remaining: Math.max(0, FREE_LIMIT - used - 1)
    });

  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}

function buildSystemPrompt(version) {
  const isLegacy = version === 'v3' || version === 'v3.5';
  const versionRules = isLegacy
    ? `TARGET: Suno ${version} (legacy). Keep the prompt SHORT and DIRECT.
- Max 6-8 keywords total
- Focus only on: genre, core rhythm, 1-2 main instruments
- NO texture/mix/structure/era descriptors — they confuse v3
- No more than 60 characters total
- Simpler = better for this version`
    : `TARGET: Suno ${version} (modern). Use a FULL, LAYERED prompt.
- 10-15 keywords, up to 120 characters
- Include: genre/era → mood/energy → instruments → production texture → mix character → structure hints
- v4/v4.5 handles stylistic nuance and stacking well — use it
- Reference descriptions blend well into the prompt at this version`;

  return `You are an expert Suno AI prompt engineer. Given music parameters, generate an optimized Style of Music prompt calibrated for the target Suno version.

${versionRules}

Output ONLY a raw JSON object with this exact structure, no markdown, no explanation:
{
  "stylePrompt": "the complete style prompt string",
  "tips": ["tip1", "tip2"]
}

General rules:
- Natural flowing keywords, NOT a sentence
- NEVER include artist names, song titles, or brand names
- English only
- If reference description provided, extract sonic keywords and blend them in

Rules for tips: 1-3 short actionable tips specific to the genre/version, max 80 chars each. Include one tip about how this prompt behaves specifically on ${version}.`;
}

function buildUserMessage(f) {
  const parts = [];
  if (f.sunoVersion) parts.push(`Suno version: ${f.sunoVersion}`);
  if (f.genre) parts.push(`Genre: ${f.genre}`);
  if (f.era) parts.push(`Era/Reference: ${f.era}`);
  if (f.substyles?.length) parts.push(`Sub-styles: ${f.substyles.join(', ')}`);
  if (f.moods?.length) parts.push(`Mood: ${f.moods.join(', ')}`);
  if (f.energy) parts.push(`Energy: ${f.energy}`);
  if (f.bpm) parts.push(`BPM: ${f.bpm}`);
  if (f.key) parts.push(`Key: ${f.key}`);
  if (f.timeSig) parts.push(`Time signature: ${f.timeSig}`);
  if (f.instruments?.length) parts.push(`Instruments: ${f.instruments.join(', ')}`);
  if (f.mix?.length) parts.push(`Mix: ${f.mix.join(', ')}`);
  if (f.structure?.length) parts.push(`Structure: ${f.structure.join(', ')}`);
  if (f.vocalStyle) parts.push(`Vocals: ${[f.vocalStyle, f.vocalTex, f.vocalLang].filter(Boolean).join(', ')}`);
  if (f.extra) parts.push(`Extra notes: ${f.extra}`);
  if (f.refDesc) parts.push(`Reference description: ${f.refDesc}`);
  return parts.join('\n');
}
