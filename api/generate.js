// api/generate.js
const FREE_LIMIT = 2;
const ipStore = new Map();

function getTodayKey(ip) {
  return `${ip}::${new Date().toISOString().slice(0, 10)}`;
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const ip = req.headers["x-forwarded-for"]?.split(",")[0] || "unknown";
  const rateKey = getTodayKey(ip);
  const used = ipStore.get(rateKey) || 0;

  const { formData, userApiKey } = req.body || {};
  const FINAL_KEY = userApiKey || process.env.ANTHROPIC_API_KEY;

  if (!userApiKey && used >= FREE_LIMIT) {
    return res.status(429).json({ error: "Limite raggiunto." });
  }

  if (!FINAL_KEY) return res.status(500).json({ error: "Configurazione mancante." });

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': FINAL_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: "claude-3-haiku-20240307",
        max_tokens: 400,
        messages: [{
          role: "user", 
          content: `Expert Suno AI Prompt Engineer. Data: ${JSON.stringify(formData)}. Return ONLY JSON: {"stylePrompt": "the prompt", "tips": "one tip"}`
        }]
      })
    });

    const data = await response.json();
    const result = JSON.parse(data.content[0].text);
    if (!userApiKey) ipStore.set(rateKey, used + 1);
    return res.status(200).json(result);
  } catch (error) {
    return res.status(500).json({ error: "Errore AI" });
  }
}
