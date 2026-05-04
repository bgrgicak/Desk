import * as fs from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";

export async function rmTempTree(path: string): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      await fs.rm(path, { recursive: true, force: true });
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "EACCES" && code !== "EPERM" && code !== "EBUSY" && code !== "ENOTEMPTY") {
        throw err;
      }
      lastError = err;
      await delay(100 * (attempt + 1));
    }
  }
  throw lastError;
}
