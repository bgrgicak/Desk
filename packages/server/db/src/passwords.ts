import argon2 from "argon2";

const ARGON2_OPTS: argon2.Options = {
  type: argon2.argon2id,
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
};

export async function hashPassword(password: string): Promise<string> {
  return argon2.hash(password, ARGON2_OPTS);
}

export async function verifyPassword(storedHash: string, password: string): Promise<boolean> {
  // Legacy plaintext entries from before argon2 was introduced.
  if (storedHash.startsWith("plain:")) {
    return storedHash === `plain:${password}`;
  }
  try {
    return await argon2.verify(storedHash, password);
  } catch {
    return false;
  }
}

export function isLegacyHash(storedHash: string): boolean {
  return storedHash.startsWith("plain:");
}
