import type { VirtualLibraryMount } from "./layout.js";
import type { FileRef } from "./files.js";
import type { FolderRef } from "./library.js";

export interface ListLibraryRaw {
  fileItems: FileRef[];
  folderItems: FolderRef[];
}

interface ListLibraryCacheEntry {
  expiresAt: number;
  /**
   * Root directory mtime at capture time. Compared against the live root
   * mtime on every read so an external write that bumps the root (e.g.
   * a test calling `fs.writeFile` or an agent landing a file at the
   * workspace root) bypasses the cache immediately. Nested writes that
   * don't bump root mtime are still bounded by `expiresAt`.
   */
  rootMtimeMs: number;
  raw: ListLibraryRaw;
}

/**
 * Short-TTL cache for `listLibrary` results, keyed per workspace +
 * visibility flag + virtual-mount set. Lives in its own module so the
 * write helpers in files.ts can invalidate without creating a circular
 * import with library.ts.
 */
export const LIST_CACHE_TTL_MS = 1000;
const listCache = new Map<string, ListLibraryCacheEntry>();

export function listCacheKey(
  slug: string,
  showHidden: boolean,
  virtualMounts: readonly VirtualLibraryMount[],
): string {
  const mountSig = virtualMounts
    .map((m) => `${m.homeName}\0${m.sourcePath}`)
    .sort()
    .join("|");
  return `${slug}::${showHidden ? "1" : "0"}::${mountSig}`;
}

export function getListCache(
  key: string,
  liveRootMtimeMs: number,
): ListLibraryRaw | undefined {
  const entry = listCache.get(key);
  if (!entry) return undefined;
  if (entry.expiresAt <= Date.now() || entry.rootMtimeMs !== liveRootMtimeMs) {
    listCache.delete(key);
    return undefined;
  }
  return entry.raw;
}

export function setListCache(
  key: string,
  rootMtimeMs: number,
  raw: ListLibraryRaw,
): void {
  listCache.set(key, {
    expiresAt: Date.now() + LIST_CACHE_TTL_MS,
    rootMtimeMs,
    raw,
  });
}

/**
 * Drops every cached `listLibrary` result for `slug`. Called from every
 * storage write path so the next read reflects the change immediately
 * instead of waiting out the TTL. External (non-API) writes still incur
 * up to LIST_CACHE_TTL_MS of staleness — acceptable for the sidebar
 * polling case the cache was added for.
 */
export function invalidateLibraryListCache(slug: string): void {
  const prefix = `${slug}::`;
  for (const key of listCache.keys()) {
    if (key.startsWith(prefix)) listCache.delete(key);
  }
}
