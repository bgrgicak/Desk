import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

const ALGO = "aes-256-gcm";
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;

let cachedKey: Buffer | null = null;

function keyPath(): string {
  return process.env.DESK_SECRET_KEY_PATH ?? "/home/desk/secret.key";
}

/**
 * Loads the AES-256 encryption key. Priority:
 * 1. DESK_SECRET_KEY env var (base64-encoded 32 bytes) — set at deploy time
 *    from a secrets manager so the key never touches disk on the server.
 * 2. Key file at DESK_SECRET_KEY_PATH (default /home/desk/secret.key);
 *    generated automatically on first boot for dev/self-hosted setups.
 */
export function ensureSecretKey(): Buffer {
  if (cachedKey) return cachedKey;

  const envKey = process.env.DESK_SECRET_KEY;
  if (envKey) {
    const buf = Buffer.from(envKey, "base64");
    if (buf.length !== KEY_BYTES) {
      throw new Error(
        `DESK_SECRET_KEY decoded to ${buf.length} bytes; expected ${KEY_BYTES}`,
      );
    }
    cachedKey = buf;
    return buf;
  }

  const p = keyPath();
  try {
    const buf = fs.readFileSync(p);
    if (buf.length !== KEY_BYTES) {
      throw new Error(
        `Secret key at ${p} is ${buf.length} bytes; expected ${KEY_BYTES}`,
      );
    }
    cachedKey = buf;
    return buf;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }

  fs.mkdirSync(path.dirname(p), { recursive: true });
  const generated = crypto.randomBytes(KEY_BYTES);
  fs.writeFileSync(p, generated, { mode: 0o600 });
  cachedKey = generated;
  return generated;
}

/** Test-only: reset the cached key so a new DESK_SECRET_KEY_PATH takes effect. */
export function resetSecretKeyCache(): void {
  cachedKey = null;
}

export function encrypt(plaintext: string): Buffer {
  const key = ensureSecretKey();
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, enc, tag]);
}

export function decrypt(ciphertext: Buffer): string {
  const key = ensureSecretKey();
  if (ciphertext.length < IV_BYTES + TAG_BYTES) {
    throw new Error("Ciphertext too short");
  }
  const iv = ciphertext.subarray(0, IV_BYTES);
  const tag = ciphertext.subarray(ciphertext.length - TAG_BYTES);
  const enc = ciphertext.subarray(IV_BYTES, ciphertext.length - TAG_BYTES);
  const decipher = crypto.createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  const dec = Buffer.concat([decipher.update(enc), decipher.final()]);
  return dec.toString("utf8");
}

export function encryptJson<T>(value: T): Buffer {
  return encrypt(JSON.stringify(value));
}

export function decryptJson<T>(ciphertext: Buffer): T {
  return JSON.parse(decrypt(ciphertext)) as T;
}
