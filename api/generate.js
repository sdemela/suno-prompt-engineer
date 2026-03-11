// api/generate.js
export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const { formData, userApiKey } = req.body || {};
  
  // Se l'utente non mette la sua chiave, usiamo la tua (impostata su Vercel)
  const FINAL_KEY = userApiKey || process.env.ANTHROPIC_API_KEY;

  if (!FINAL_KEY) {
    return res.status(500).json({ error: "API Key non configurata." });
  }

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
          content: `Sei un esperto di Suno AI. Crea un prompt musicale professionale basato su questi dati: ${JSON.stringify(formData)}. 
          Rispondi SOLO con un oggetto JSON: {"stylePrompt": "testo del prompt", "tips": "un consiglio breve"}`
        }]
      })
    });

    const data = await response.json();
    const content = JSON.parse(data.content[0].text);
    return res.status(200).json(content);
  } catch (error) {
    return res.status(500).json({ error: "Errore generazione AI" });
  }
}
