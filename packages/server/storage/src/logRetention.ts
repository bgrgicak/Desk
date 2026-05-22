import * as fs from "node:fs/promises";
import * as path from "node:path";
import { trashDir } from "./layout.js";

/**
 * Walks every workspace's `.chats/{chatId}/logs/` directory and enforces
 * a per-chat retention cap. Oldest files beyond `maxFiles` are moved to
 * `~/Roomy/.trash/logs/` (matching the trash-on-delete convention used
 * elsewhere). Returns the total number of files evicted.
 *
 * Retention is per-chat, not global, so a chat with a lot of activity
 * doesn't starve a quiet one of history. Workspaces are discovered by
 * scanning the data root for non-dot subdirectories (matching the
 * validateSlug rules) so a single retention pass covers every workspace
 * without having to enumerate the DB.
 */
export async function enforceLogRetention(
  home: string,
  maxFiles: number,
): Promise<{ scanned: number; evicted: number }> {
  if (maxFiles <= 0) return { scanned: 0, evicted: 0 };

  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(home, { withFileTypes: true });
  } catch {
    return { scanned: 0, evicted: 0 };
  }
  // Workspaces sit directly under $ROOMY_HOME with non-dot slugs. Skip the
  // legacy `workspaces/` parent in case migration left it behind.
  const workspaceSlugs = entries
    .filter((e) => e.isDirectory() && !e.name.startsWith(".") && e.name !== "workspaces")
    .map((e) => e.name);

  let scanned = 0;
  let evicted = 0;
  const trash = path.join(trashDir(home), "logs");

  for (const slug of workspaceSlugs) {
    const chatsRoot = path.join(home, slug, ".chats");
    let chatDirs: string[];
    try {
      chatDirs = await fs.readdir(chatsRoot);
    } catch {
      continue;
    }

    for (const chatId of chatDirs) {
      const logsDir = path.join(chatsRoot, chatId, "logs");
      let logEntries: string[];
      try {
        logEntries = await fs.readdir(logsDir);
      } catch {
        continue;
      }
      const files = logEntries.filter((n) => n.endsWith(".log"));
      scanned += files.length;
      if (files.length <= maxFiles) continue;

      // Sort by mtime ascending (oldest first) so we evict the first N-maxFiles.
      const stats = await Promise.all(
        files.map(async (name) => {
          const abs = path.join(logsDir, name);
          const s = await fs.stat(abs).catch(() => null);
          return { name, abs, mtime: s?.mtime.getTime() ?? 0 };
        }),
      );
      stats.sort((a, b) => a.mtime - b.mtime);

      const toEvict = stats.slice(0, files.length - maxFiles);
      if (toEvict.length === 0) continue;

      await fs.mkdir(trash, { recursive: true });
      for (const entry of toEvict) {
        const dest = path.join(trash, `${Date.now()}-${slug}-${chatId}-${entry.name}`);
        try {
          await fs.rename(entry.abs, dest);
          evicted++;
        } catch {
          // Best-effort — missing files are fine.
        }
      }
    }
  }

  return { scanned, evicted };
}
