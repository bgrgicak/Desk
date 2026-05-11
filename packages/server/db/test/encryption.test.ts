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
let prevKeyPath: string | undefined;
let prevSecretKey: string | undefined;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "desk-crypt-"));
  keyPath = path.join(tmpDir, "secret.key");
  prevKeyPath = process.env.DESK_SECRET_KEY_PATH;
  prevSecretKey = process.env.DESK_SECRET_KEY;
  process.env.DESK_SECRET_KEY_PATH = keyPath;
  delete process.env.DESK_SECRET_KEY;
  resetSecretKeyCache();
});

afterEach(() => {
  if (prevKeyPath === undefined) delete process.env.DESK_SECRET_KEY_PATH;
  else process.env.DESK_SECRET_KEY_PATH = prevKeyPath;
  if (prevSecretKey === undefined) delete process.env.DESK_SECRET_KEY;
  else process.env.DESK_SECRET_KEY = prevSecretKey;
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
    const obj = { GEMINI_API_KEY: "gem-abc", OPENAI_API_KEY: "sk-xyz" };
    const ct = encryptJson(obj);
    expect(decryptJson<typeof obj>(ct)).toEqual(obj);
  });

  it("ensureSecretKey uses DESK_SECRET_KEY env var when set", () => {
    const raw = Buffer.alloc(32, 0xab);
    process.env.DESK_SECRET_KEY = raw.toString("base64");
    resetSecretKeyCache();
    const key = ensureSecretKey();
    expect(key.equals(raw)).toBe(true);
    // key file must not be written
    expect(fs.existsSync(keyPath)).toBe(false);
  });

  it("DESK_SECRET_KEY takes precedence over key file", () => {
    // Pre-write a different key to the file path.
    const fileKey = Buffer.alloc(32, 0x01);
    fs.mkdirSync(path.dirname(keyPath), { recursive: true });
    fs.writeFileSync(keyPath, fileKey, { mode: 0o600 });
    const envKey = Buffer.alloc(32, 0x02);
    process.env.DESK_SECRET_KEY = envKey.toString("base64");
    resetSecretKeyCache();
    expect(ensureSecretKey().equals(envKey)).toBe(true);
  });

  it("ensureSecretKey throws when DESK_SECRET_KEY has wrong length", () => {
    process.env.DESK_SECRET_KEY = Buffer.alloc(16).toString("base64");
    resetSecretKeyCache();
    expect(() => ensureSecretKey()).toThrow(/16 bytes/);
  });
});
