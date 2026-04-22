import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  encrypt,
  decrypt,
  encryptJson,
  decryptJson,
  ensureSecretKey,
  resetSecretKeyCache,
} from "../src/encryption.js";

let tmpDir: string;
let keyPath: string;
let prevEnv: string | undefined;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "desk-crypt-"));
  keyPath = path.join(tmpDir, "secret.key");
  prevEnv = process.env.DESK_SECRET_KEY_PATH;
  process.env.DESK_SECRET_KEY_PATH = keyPath;
  resetSecretKeyCache();
});

afterEach(() => {
  if (prevEnv === undefined) delete process.env.DESK_SECRET_KEY_PATH;
  else process.env.DESK_SECRET_KEY_PATH = prevEnv;
  resetSecretKeyCache();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("encryption", () => {
  it("ensureSecretKey creates a 32-byte 0600 key on first call", () => {
    const key = ensureSecretKey();
    expect(key.length).toBe(32);
    const stat = fs.statSync(keyPath);
    expect(stat.size).toBe(32);
    // Mode: low 9 bits should be rw------- = 0o600
    expect(stat.mode & 0o777).toBe(0o600);
  });

  it("ensureSecretKey returns the same key on subsequent calls", () => {
    const a = ensureSecretKey();
    const b = ensureSecretKey();
    expect(a.equals(b)).toBe(true);
  });

  it("ensureSecretKey reads an existing key instead of regenerating", () => {
    const first = ensureSecretKey();
    resetSecretKeyCache();
    const second = ensureSecretKey();
    expect(first.equals(second)).toBe(true);
  });

  it("encrypt / decrypt round-trip", () => {
    const plaintext = "sk-ant-api03-very-secret";
    const ct = encrypt(plaintext);
    expect(ct.length).toBeGreaterThan(plaintext.length);
    expect(decrypt(ct)).toBe(plaintext);
  });

  it("encrypted output changes every call (fresh IV)", () => {
    const ct1 = encrypt("hello");
    const ct2 = encrypt("hello");
    expect(ct1.equals(ct2)).toBe(false);
    expect(decrypt(ct1)).toBe("hello");
    expect(decrypt(ct2)).toBe("hello");
  });

  it("decrypt throws on tampered ciphertext", () => {
    const ct = encrypt("hello");
    const tampered = Buffer.from(ct);
    tampered[20] ^= 0xff; // flip a byte in the encrypted body
    expect(() => decrypt(tampered)).toThrow();
  });

  it("decrypt throws on too-short input", () => {
    expect(() => decrypt(Buffer.from("abc"))).toThrow(/too short/i);
  });

  it("encryptJson / decryptJson round-trip a map", () => {
    const obj = { ANTHROPIC_API_KEY: "sk-abc", OPENAI_API_KEY: "sk-xyz" };
    const ct = encryptJson(obj);
    expect(decryptJson<typeof obj>(ct)).toEqual(obj);
  });
});
