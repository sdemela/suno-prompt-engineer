/**
 * supre.online — UUID + HMAC Auth
 * Incolla questo script in public/en/tool.html e public/it/tool.html
 * subito dopo il tag <body> o in un blocco <script> dedicato.
 *
 * Funzionamento:
 * 1. Al caricamento della pagina, chiama /api/save-email per ottenere uuid + sig
 * 2. Salva entrambi in localStorage
 * 3. Ogni chiamata fetch alle API include gli header X-SPE-UUID e X-SPE-Sig
 */

// ─── Inizializzazione UUID + Signature ──────────────────────────────────────

async function initAuth() {
  const storedUUID = localStorage.getItem("spe_uuid");
  const storedSig  = localStorage.getItem("spe_sig");

  // Se abbiamo già entrambi, non serve fare nulla
  if (storedUUID && storedSig) return;

  try {
    const res = await fetch("/api/save-email", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        uuid: storedUUID || null, // passa UUID esistente per ri-firmare
      }),
    });

    if (!res.ok) throw new Error("save-email failed");

    const data = await res.json();
    localStorage.setItem("spe_uuid", data.uuid);
    localStorage.setItem("spe_sig",  data.sig);
  } catch (err) {
    console.warn("[auth] Impossibile inizializzare UUID:", err);
    // L'utente funzionerà in free tier — non bloccare l'esperienza
  }
}

// ─── Helper: headers auth per ogni fetch ────────────────────────────────────

function authHeaders() {
  return {
    "X-SPE-UUID": localStorage.getItem("spe_uuid") || "",
    "X-SPE-Sig":  localStorage.getItem("spe_sig")  || "",
  };
}

// ─── Helper: salva email utente (opzionale, dopo form iscrizione) ────────────

async function saveUserEmail(email) {
  const uuid = localStorage.getItem("spe_uuid");
  const sig  = localStorage.getItem("spe_sig");

  const res = await fetch("/api/save-email", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, uuid }),
  });

  if (!res.ok) throw new Error("Errore salvataggio email");

  const data = await res.json();
  // Aggiorna sig in caso sia cambiata (non dovrebbe, ma per sicurezza)
  localStorage.setItem("spe_uuid", data.uuid);
  localStorage.setItem("spe_sig",  data.sig);

  return data;
}

// ─── Esempio: chiamata a /api/generate con auth ──────────────────────────────
/*
async function generatePrompt(params) {
  const res = await fetch("/api/generate", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...authHeaders(),           // <-- aggiunge X-SPE-UUID e X-SPE-Sig
    },
    body: JSON.stringify(params),
  });
  return res.json();
}
*/

// ─── Esempio: chiamata a /api/checkout con auth ──────────────────────────────
/*
async function startCheckout(plan) {
  const res = await fetch("/api/checkout", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...authHeaders(),
    },
    body: JSON.stringify({ plan }),
  });
  const data = await res.json();
  if (data.url) window.location.href = data.url;
}
*/

// ─── Esempio: chiamata a /api/credits con auth ───────────────────────────────
/*
async function getCredits() {
  const res = await fetch("/api/credits", {
    headers: authHeaders(),
  });
  return res.json();
}
*/

// ─── Avvio automatico all'apertura della pagina ──────────────────────────────

document.addEventListener("DOMContentLoaded", () => {
  initAuth();
});
