import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { ID_PREFIXES, ValidationError } from "@roomy-ai/shared";
import { workspaceRootPath } from "./layout.js";

/**
 * Per-chat advisory lock for the read-snapshot-write sequence on
 * summary files. Two concurrent summary fires for the same chat each
 * read the same "previous" body, race to write history, and race to
 * materialize the new body — last writer wins, prior history overwrites
 * itself. The map serializes all three operations per `chatId` so the
 * sequence is atomic from the caller's perspective.
 *
 * In-process only (single Node process). Multiple processes touching
 * the same chat directory would still race, but Roomy runs as a single
 * process today.
 */
const chatLocks = new Map<string, Promise<unknown>>();

function withChatLock<T>(chatId: string, fn: () => Promise<T>): Promise<T> {
  const prev = chatLocks.get(chatId) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  chatLocks.set(
    chatId,
    next.catch(() => undefined),
  );
  return next.finally(() => {
    if (chatLocks.get(chatId) === next.catch(() => undefined)) {
      // No-op; the catch wrapper above isn't actually the same promise
      // as `next`. We rely on the next caller chaining off whatever
      // promise is in the map at the time of `withChatLock` entry.
    }
  });
}

/**
 * Writes `data` to `targetPath` atomically — content lands under a
 * sibling temp filename and is renamed into place. Concurrent readers
 * either see the prior file or the new file, never a partial write.
 */
async function atomicWriteFile(targetPath: string, data: string): Promise<void> {
  const dir = path.dirname(targetPath);
  await fs.mkdir(dir, { recursive: true });
  const suffix = crypto.randomBytes(6).toString("hex");
  const tmp = path.join(dir, `.${path.basename(targetPath)}.${suffix}.tmp`);
  await fs.writeFile(tmp, data, "utf-8");
  await fs.rename(tmp, targetPath);
}

function validateChatId(chatId: string): void {
  if (!chatId.startsWith(ID_PREFIXES.chat) || chatId.includes("/") || chatId.includes("..")) {
    throw new ValidationError(`Invalid chat id: ${chatId}`);
  }
}

function validateMessageId(messageId: string): void {
  if (!messageId.startsWith(ID_PREFIXES.message) || messageId.includes("/") || messageId.includes("..")) {
    throw new ValidationError(`Invalid message id: ${messageId}`);
  }
}

/** Absolute path to a chat's summary history directory under `notes/.history/`. */
export function summaryHistoryDir(home: string, slug: string, chatId: string): string {
  return path.join(summaryStorageDir(home, slug, chatId), ".history");
}

/** Absolute path to the chat's summary mirror directory. The path segment is
 * intentionally `notes/`: summaries are stored only there, not in artifacts/. */
export function summaryStorageDir(home: string, slug: string, chatId: string): string {
  validateChatId(chatId);
  return path.join(workspaceRootPath(home, slug), ".chats", chatId, "notes");
}

/**
 * Writes the supplied summary body to `{summaryStorageDir}/{messageId}.md`. Called
 * whenever a `summary`-content message is inserted or its body is patched,
 * so the filesystem copy agents see stays in sync with the DB row.
 * Overwrites any prior file for the same message id.
 */
export async function materializeSummary(
  home: string,
  slug: string,
  chatId: string,
  messageId: string,
  body: string,
): Promise<string> {
  validateMessageId(messageId);
  const dir = summaryStorageDir(home, slug, chatId);
  const file = path.join(dir, `${messageId}.md`);
  await atomicWriteFile(file, body);
  return file;
}

/** Removes a materialized summary file. Best-effort — missing file is OK. */
export async function deleteMaterializedSummary(
  home: string,
  slug: string,
  chatId: string,
  messageId: string,
): Promise<void> {
  validateMessageId(messageId);
  const file = path.join(summaryStorageDir(home, slug, chatId), `${messageId}.md`);
  await fs.rm(file, { force: true });
}

/**
 * Writes the supplied previous summary body as a history snapshot under
 * `notes/.history/`. Filename format: `{iso-utc}-{messageId}.md`, so sort
 * order = reverse chronological when sorted descending.
 */
export async function snapshotSummary(
  home: string,
  slug: string,
  chatId: string,
  messageId: string,
  previousBody: string,
): Promise<string> {
  validateMessageId(messageId);
  const dir = summaryHistoryDir(home, slug, chatId);
  const iso = new Date().toISOString().replace(/:/g, "-");
  const nonce = crypto.randomBytes(3).toString("hex");
  const file = path.join(dir, `${iso}-${nonce}-${messageId}.md`);
  await atomicWriteFile(file, previousBody);
  return file;
}

/**
 * Atomically snapshots the existing materialized summary body to
 * history (if any) and replaces it with `nextBody` — under a per-chat
 * advisory lock so two concurrent refreshes for the same message can't
 * clobber each other's writes.
 *
 * The previous body is **read inside the lock**. This is what makes the
 * sequence atomic: two callers reading the materialized file outside
 * the lock would each see the same prior body, so neither would
 * snapshot the body the other left behind. Reading inside the lock
 * forces the second caller to observe the first caller's freshly
 * materialized body and snapshot it.
 *
 * The caller still passes `messageId` because the storage layout uses
 * it for both the materialized filename and the history-entry suffix.
 */
export async function snapshotAndReplaceSummary(
  home: string,
  slug: string,
  chatId: string,
  messageId: string,
  nextBody: string,
): Promise<{ snapshotPath: string | null; materializedPath: string }> {
  return withChatLock(chatId, async () => {
    const dir = summaryStorageDir(home, slug, chatId);
    const file = path.join(dir, `${messageId}.md`);
    const previousBody = await fs.readFile(file, "utf-8").catch(() => null);

    let snapshotPath: string | null = null;
    if (previousBody !== null && previousBody.length > 0 && previousBody !== nextBody) {
      snapshotPath = await snapshotSummary(home, slug, chatId, messageId, previousBody);
    }
    const materializedPath = await materializeSummary(home, slug, chatId, messageId, nextBody);
    return { snapshotPath, materializedPath };
  });
}

export interface SummaryVersion {
  timestamp: string;
  body: string;
}

/**
 * Returns every snapshot of the supplied summary message, newest first. When
 * the directory doesn't exist (nothing snapshotted yet) returns an empty
 * array.
 */
export async function listSummaryHistory(
  home: string,
  slug: string,
  chatId: string,
  messageId: string,
): Promise<SummaryVersion[]> {
  validateMessageId(messageId);
  const dirs = [
    summaryHistoryDir(home, slug, chatId),
    ...legacySummaryHistoryDirs(home, slug, chatId),
  ];
  const versions: SummaryVersion[] = [];
  for (const dir of dirs) {
    let entries: string[];
    try {
      entries = await fs.readdir(dir);
    } catch {
      continue;
    }
    const matching = entries.filter((name) => name.endsWith(`-${messageId}.md`));
    for (const name of matching) {
      const body = await fs.readFile(path.join(dir, name), "utf-8");
      const isoPart = name.slice(0, -`-${messageId}.md`.length);
      // Restore the colons we stripped for filesystem safety.
      const restored = restoreIsoColons(extractSnapshotTimestamp(isoPart));
      versions.push({ timestamp: restored, body });
    }
  }
  versions.sort((a, b) => (a.timestamp > b.timestamp ? -1 : 1));
  return versions;
}

function legacySummaryHistoryDirs(home: string, slug: string, chatId: string): string[] {
  validateChatId(chatId);
  const chatDir = path.join(workspaceRootPath(home, slug), ".chats", chatId);
  return [
    path.join(chatDir, "note-history"),
    path.join(chatDir, "summary-history"),
  ];
}

function extractSnapshotTimestamp(isoPart: string): string {
  // Current files add a random suffix after the millisecond ISO timestamp to
  // avoid same-millisecond history overwrites. Older files are just the ISO.
  const strippedIsoLength = "2000-01-01T00-00-00.000Z".length;
  return isoPart.length > strippedIsoLength ? isoPart.slice(0, strippedIsoLength) : isoPart;
}

function restoreIsoColons(stripped: string): string {
  // `2026-04-23T09-15-30.123Z` → `2026-04-23T09:15:30.123Z`
  const tIdx = stripped.indexOf("T");
  if (tIdx === -1) return stripped;
  const date = stripped.slice(0, tIdx);
  const time = stripped.slice(tIdx + 1).replace(/-/g, ":");
  return `${date}T${time}`;
}
