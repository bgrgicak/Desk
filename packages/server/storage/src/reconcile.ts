import * as fs from "node:fs/promises";
import * as path from "node:path";
import type pg from "pg";
import { resolveHostPath, workspaceRootPath } from "./layout.js";

/**
 * Walks messages whose content is `artifactRef` and verifies the referenced
 * path exists on the filesystem. When the path is missing:
 *   - Try to repair: if a single file with the same basename exists anywhere
 *     under the workspace root, rewrite `content.path` to that new path.
 *   - Otherwise: mark the content with `missing: true` so the UI and future
 *     callers can flag the reference as broken without losing the message.
 *
 * This closes the gap where out-of-band moves / deletes silently break
 * artifactRef references inserted into message history.
 */
export async function reconcileArtifactRefs(
  pool: pg.Pool,
  home: string,
): Promise<{ checked: number; repaired: number; missing: number }> {
  const stats = { checked: 0, repaired: 0, missing: 0 };
  const root = workspaceRootPath(home);

  const { rows } = await pool.query<{
    id: string;
    content: { type: "artifactRef"; path?: string; name?: string; mime?: string; missing?: boolean };
  }>(
    `SELECT id, content FROM messages
     WHERE content->>'type' = 'artifactRef'`,
  );

  for (const row of rows) {
    stats.checked++;
    const storedPath = row.content.path;
    if (!storedPath) continue;

    let abs: string;
    try {
      abs = resolveHostPath(home, storedPath);
    } catch {
      // Traversal — mark missing and move on.
      if (!row.content.missing) {
        await markMissing(pool, row.id, row.content);
        stats.missing++;
      }
      continue;
    }

    const exists = await fs.access(abs).then(() => true, () => false);
    if (exists) {
      // Clear any prior missing marker (file came back).
      if (row.content.missing) {
        const cleared = { ...row.content };
        delete cleared.missing;
        await pool.query(
          `UPDATE messages SET content = $1, updated_at = now() WHERE id = $2`,
          [JSON.stringify(cleared), row.id],
        );
      }
      continue;
    }

    const candidate = await findSingleCandidate(root, path.basename(storedPath));
    if (candidate) {
      const rel = path.relative(root, candidate).split(path.sep).join("/");
      const updated = { ...row.content, path: rel };
      delete updated.missing;
      await pool.query(
        `UPDATE messages SET content = $1, updated_at = now() WHERE id = $2`,
        [JSON.stringify(updated), row.id],
      );
      stats.repaired++;
    } else if (!row.content.missing) {
      await markMissing(pool, row.id, row.content);
      stats.missing++;
    }
  }

  return stats;
}

async function markMissing(
  pool: pg.Pool,
  messageId: string,
  content: Record<string, unknown>,
): Promise<void> {
  const next = { ...content, missing: true };
  await pool.query(
    `UPDATE messages SET content = $1, updated_at = now() WHERE id = $2`,
    [JSON.stringify(next), messageId],
  );
}

/**
 * Walks the workspace tree for files named `basename`. Skips dotdirs so
 * trash / cache / .chats don't produce false positives. Returns the single
 * match when unambiguous, otherwise null.
 */
async function findSingleCandidate(root: string, basename: string): Promise<string | null> {
  const hits: string[] = [];
  async function walk(dir: string): Promise<void> {
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(abs);
      } else if (entry.isFile() && entry.name === basename) {
        hits.push(abs);
        if (hits.length > 1) return;
      }
    }
  }
  await walk(root);
  return hits.length === 1 ? hits[0] : null;
}
