import * as fs from "node:fs/promises";
import * as path from "node:path";
import { ID_PREFIXES, ValidationError } from "@agent-desk/shared";
import { workspaceRootPath } from "./layout.js";

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
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, `${messageId}.md`);
  await fs.writeFile(file, body, "utf-8");
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
  await fs.mkdir(dir, { recursive: true });
  const iso = new Date().toISOString().replace(/:/g, "-");
  const file = path.join(dir, `${iso}-${messageId}.md`);
  await fs.writeFile(file, previousBody, "utf-8");
  return file;
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
      const restored = restoreIsoColons(isoPart);
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

function restoreIsoColons(stripped: string): string {
  // `2026-04-23T09-15-30.123Z` → `2026-04-23T09:15:30.123Z`
  const tIdx = stripped.indexOf("T");
  if (tIdx === -1) return stripped;
  const date = stripped.slice(0, tIdx);
  const time = stripped.slice(tIdx + 1).replace(/-/g, ":");
  return `${date}T${time}`;
}
