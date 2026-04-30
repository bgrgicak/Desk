import { argon2id, argon2Verify } from "hash-wasm";
import { randomBytes } from "node:crypto";

const ARGON2_OPTS = {
  iterations: 2,
  memorySize: 19456,
  parallelism: 1,
  hashLength: 32,
} as const;

export async function hashPassword(password: string): Promise<string> {
  return argon2id({
    password,
    salt: randomBytes(16),
    ...ARGON2_OPTS,
    outputType: "encoded",
  });
}

export async function verifyPassword(storedHash: string, password: string): Promise<boolean> {
  // Legacy plaintext entries from before argon2 was introduced.
  if (storedHash.startsWith("plain:")) {
    return storedHash === `plain:${password}`;
  }
  try {
    return await argon2Verify({ hash: storedHash, password });
  } catch {
    return false;
  }
}

export function isLegacyHash(storedHash: string): boolean {
  return storedHash.startsWith("plain:");
}
