// app/lib/crypto.server.js
//
// AES-256-GCM helpers for encrypting sensitive settings fields at rest (e.g.
// the Claude API key in AiSettings). Keyed by AI_SETTINGS_ENCRYPTION_KEY, a
// server-only env var — never commit it, never send it to the client.

import crypto from "crypto";

const ALGORITHM  = "aes-256-gcm";
const IV_BYTES    = 12; // recommended IV length for GCM
const KEY_BYTES   = 32; // AES-256

// Fails loudly and specifically if misconfigured, rather than silently
// encrypting with a wrong-length key and producing ciphertext that can
// never be decrypted back.
function getKey() {
  const raw = process.env.AI_SETTINGS_ENCRYPTION_KEY;
  if (!raw) {
    throw new Error(
      "Server misconfigured: AI_SETTINGS_ENCRYPTION_KEY not set. " +
      "Generate one with: node -e \"console.log(require('crypto').randomBytes(32).toString('base64'))\"",
    );
  }

  const key = Buffer.from(raw, "base64");
  if (key.length !== KEY_BYTES) {
    throw new Error(
      `Server misconfigured: AI_SETTINGS_ENCRYPTION_KEY must decode to ${KEY_BYTES} bytes (got ${key.length})`,
    );
  }

  return key;
}

// --- Encrypt a plaintext string, returning "iv:authTag:ciphertext" (hex) ---
export function encrypt(plaintext) {
  const key = getKey();
  const iv = crypto.randomBytes(IV_BYTES);

  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(String(plaintext), "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return `${iv.toString("hex")}:${authTag.toString("hex")}:${ciphertext.toString("hex")}`;
}

// --- Decrypt a payload produced by encrypt() back into the plaintext string ---
export function decrypt(payload) {
  const key = getKey();

  const parts = String(payload).split(":");
  if (parts.length !== 3) {
    throw new Error("Malformed encrypted payload");
  }
  const [ivHex, authTagHex, ciphertextHex] = parts;

  const decipher = crypto.createDecipheriv(ALGORITHM, key, Buffer.from(ivHex, "hex"));
  decipher.setAuthTag(Buffer.from(authTagHex, "hex"));

  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(ciphertextHex, "hex")),
    decipher.final(),
  ]);

  return plaintext.toString("utf8");
}
