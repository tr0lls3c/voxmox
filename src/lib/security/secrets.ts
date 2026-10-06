/**
 * Encrypt secrets at rest in servers.json (tokenSecret, authPassword).
 *
 * Format: enc:v1:<iv_b64>:<tag_b64>:<ciphertext_b64> (AES-256-GCM).
 * Key: VOXMOX_SECRETS_KEY (64-char hex or passphrase) → else derive from
 * VOXMOX_DASHBOARD_SECRET → else plaintext (dev).
 */

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  scryptSync,
} from "node:crypto";

const ENC_PREFIX = "enc:v1:";
const SCRYPT_SALT = "voxmox-secrets-v1";

let warnedPlaintextWrite = false;

function envTrim(name: string): string | null {
  const value = process.env[name]?.trim();
  return value ? value : null;
}

/** 32-byte AES key, or null when encryption is unavailable. */
export function resolveSecretsKey(): Buffer | null {
  const secretsKey = envTrim("VOXMOX_SECRETS_KEY");
  if (secretsKey) {
    if (/^[0-9a-fA-F]{64}$/.test(secretsKey)) {
      return Buffer.from(secretsKey, "hex");
    }
    // Passphrase: scrypt for better KDF than raw sha256.
    return scryptSync(secretsKey, SCRYPT_SALT, 32);
  }

  const dashboardSecret = envTrim("VOXMOX_DASHBOARD_SECRET");
  if (dashboardSecret) {
    return createHash("sha256")
      .update(`voxmox-secrets:${dashboardSecret}`)
      .digest();
  }

  return null;
}

export function isEncryptedSecret(value: string): boolean {
  return value.startsWith(ENC_PREFIX);
}

function warnPlaintextOnce(): void {
  if (warnedPlaintextWrite) return;
  if (process.env.NODE_ENV !== "production") return;
  warnedPlaintextWrite = true;
  console.warn(
    "[voxmox] Writing secrets in plaintext because neither VOXMOX_SECRETS_KEY nor VOXMOX_DASHBOARD_SECRET is set. Set VOXMOX_SECRETS_KEY (32-byte hex or passphrase) for encryption at rest.",
  );
}

/** Encrypt a secret for disk. Returns plaintext when no key is configured. */
export function encryptSecret(plaintext: string): string {
  if (!plaintext) return plaintext;
  // Already encrypted — avoid double-encryption.
  if (isEncryptedSecret(plaintext)) return plaintext;

  const key = resolveSecretsKey();
  if (!key) {
    warnPlaintextOnce();
    return plaintext;
  }

  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();

  return [
    "enc:v1",
    iv.toString("base64"),
    tag.toString("base64"),
    ciphertext.toString("base64"),
  ].join(":");
}

/** Decrypt an enc:v1 value, or return plaintext unchanged. */
export function decryptSecret(value: string): string {
  if (!value || !isEncryptedSecret(value)) return value;

  const key = resolveSecretsKey();
  if (!key) {
    throw new Error(
      "Encrypted secret found in servers.json but neither VOXMOX_SECRETS_KEY nor VOXMOX_DASHBOARD_SECRET is set.",
    );
  }

  const parts = value.split(":");
  // enc:v1:<iv>:<tag>:<ciphertext>  →  ["enc", "v1", iv, tag, ciphertext...]
  if (parts.length < 5 || parts[0] !== "enc" || parts[1] !== "v1") {
    throw new Error("Malformed encrypted secret (expected enc:v1:...).");
  }

  const iv = Buffer.from(parts[2], "base64");
  const tag = Buffer.from(parts[3], "base64");
  const ciphertext = Buffer.from(parts.slice(4).join(":"), "base64");

  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]);
  return plaintext.toString("utf8");
}

/** Seal a secret for disk (optional-friendly alias used by the servers store). */
export function sealSecret(value: string | undefined): string | undefined {
  if (value == null || value === "") return undefined;
  return encryptSecret(value);
}

/** Open a sealed secret from disk (optional-friendly alias used by the servers store). */
export function openSecret(value: string | undefined): string | undefined {
  if (value == null || value === "") return undefined;
  return decryptSecret(value);
}
