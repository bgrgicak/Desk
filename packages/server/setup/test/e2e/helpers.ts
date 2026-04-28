import { resolve } from "node:path";

/**
 * Mirrors the port derivation logic from setup/scripts/vm.sh:
 * host port = 3000 + (CRC32(instance) % 100)
 */
export function getPortForInstance(instance: string): number {
  return 3000 + (crc32(instance) % 100);
}

/**
 * URL to hit the desk-server inside the VM for a given instance.
 * Lima forwards guest :8080 → host :<port>, so tests can use localhost.
 */
export function getInstanceUrl(instance: string): string {
  return `http://127.0.0.1:${getPortForInstance(instance)}/`;
}

/**
 * Absolute path to the vm.sh wrapper (used to invoke limactl with the
 * right per-instance naming and port injection).
 */
export const VM_SH = resolve(
  import.meta.dirname,
  "../../scripts/vm.sh",
);

/**
 * Host-side path that vm.sh mounts into the VM at /home/desk/Desk.
 * Mirrors the derivation in setup/scripts/vm.sh: the default `dev` instance
 * uses `~/Desk` (stable, user-friendly path for the primary daily-driver
 * VM); other instances use `~/Desk-${instance}` so test/throwaway VMs
 * don't collide with the user's real data.
 */
export function getDeskHomeForInstance(instance: string): string {
  const home = process.env.HOME ?? "";
  return instance === "dev" ? `${home}/Desk` : `${home}/Desk-${instance}`;
}

function crc32(str: string): number {
  const table = makeCRC32Table();
  let crc = 0xffffffff;
  for (let i = 0; i < str.length; i++) {
    crc = (crc >>> 8) ^ table[(crc ^ str.charCodeAt(i)) & 0xff];
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function makeCRC32Table(): number[] {
  const table: number[] = [];
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table.push(c >>> 0);
  }
  return table;
}

/**
 * Polls a URL until the response body matches the expected string.
 * Returns the body on success, throws on timeout.
 */
export async function pollEndpoint(
  url: string,
  expected: string,
  timeoutMs: number,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      const body = await res.text();
      if (body === expected) return body;
    } catch {
      // Server not ready yet
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(
    `Timed out after ${timeoutMs}ms waiting for ${url} to return "${expected}"`,
  );
}
