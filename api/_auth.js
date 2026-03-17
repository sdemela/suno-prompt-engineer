// api/_auth.js — modulo HMAC condiviso
// Verifica che uuid + signature siano validi prima di processare ogni request

import crypto from 'crypto';

const SECRET = process.env.SPE_HMAC_SECRET;

/**
 * Genera la firma HMAC-SHA256 per un UUID.
 * Usato solo in api/save-email.js al momento della creazione UUID.
 */
export function signUUID(uuid) {
  if (!SECRET) throw new Error("SPE_HMAC_SECRET non configurato");
  return crypto.createHmac("sha256", SECRET).update(uuid).digest("hex");
}

/**
 * Verifica uuid + signature ricevuti nella request.
 * Restituisce { valid: true } oppure { valid: false, error: "..." }
 */
export function verifyHMAC(uuid, signature) {
  if (!SECRET) {
    console.error("[auth] SPE_HMAC_SECRET mancante");
    return { valid: false, error: "Server misconfigured" };
  }

  // Formato UUID: deve iniziare con "spe-"
  if (!uuid || typeof uuid !== "string" || !uuid.startsWith("spe-")) {
    return { valid: false, error: "UUID non valido" };
  }

  if (!signature || typeof signature !== "string") {
    return { valid: false, error: "Signature mancante" };
  }

  const expected = crypto
    .createHmac("sha256", SECRET)
    .update(uuid)
    .digest("hex");

  // Timing-safe compare per prevenire timing attacks
  try {
    const sigBuf = Buffer.from(signature, "hex");
    const expBuf = Buffer.from(expected, "hex");

    if (sigBuf.length !== expBuf.length) {
      return { valid: false, error: "Signature non valida" };
    }

    const match = crypto.timingSafeEqual(sigBuf, expBuf);
    return match
      ? { valid: true }
      : { valid: false, error: "Signature non valida" };
  } catch {
    return { valid: false, error: "Signature malformata" };
  }
}

/**
 * Helper: estrae uuid e signature dagli header della request.
 * Convenzione header:
 *   X-SPE-UUID: spe-...
 *   X-SPE-Sig:  <hex hmac>
 */
export function extractAndVerify(req) {
  const uuid = req.headers["x-spe-uuid"] || "";
  const sig = req.headers["x-spe-sig"] || "";
  return { uuid, sig, ...verifyHMAC(uuid, sig) };
}
