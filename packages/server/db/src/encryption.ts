import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

const ALGO = "aes-256-gcm";
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;

let cachedKey: Buffer | null = null;

function keyPath(): string {
  return process.env.DESK_SECRET_KEY_PATH ?? "/var/lib/desk/secret.key";
}

/**
 * Loads the encryption key from disk, generating it on first boot if missing.
 * Creates parent dirs, writes 32 random bytes at mode 0600.
 */
export function ensureSecretKey(): Buffer {
  if (cachedKey) return cachedKey;

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
