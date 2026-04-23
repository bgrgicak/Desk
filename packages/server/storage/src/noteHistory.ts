import * as fs from "node:fs/promises";
import * as path from "node:path";
import { ID_PREFIXES, ValidationError } from "@desk/shared";

const WORKSPACE_SLUG = "desk";

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

/** Absolute path to a chat's note-history directory. */
export function noteHistoryDir(home: string, chatId: string): string {
  validateChatId(chatId);
  return path.join(home, "Desk", "workspaces", WORKSPACE_SLUG, ".chats", chatId, "note-history");
}

/**
 * Writes the supplied previous note body as a history snapshot. Filename
 * format: `{iso-utc}-{messageId}.md`, so sort order = reverse chronological
 * when sorted descending.
 */
export async function snapshotNote(
  home: string,
  chatId: string,
  messageId: string,
  previousBody: string,
): Promise<string> {
  validateMessageId(messageId);
  const dir = noteHistoryDir(home, chatId);
  await fs.mkdir(dir, { recursive: true });
  const iso = new Date().toISOString().replace(/:/g, "-");
  const file = path.join(dir, `${iso}-${messageId}.md`);
  await fs.writeFile(file, previousBody, "utf-8");
  return file;
}

export interface NoteVersion {
  timestamp: string;
  body: string;
}

/**
 * Returns every snapshot of the supplied note message, newest first. When
 * the directory doesn't exist (nothing snapshotted yet) returns an empty
 * array.
 */
export async function listNoteHistory(
  home: string,
  chatId: string,
  messageId: string,
): Promise<NoteVersion[]> {
  validateMessageId(messageId);
  const dir = noteHistoryDir(home, chatId);
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return [];
  }
  const matching = entries.filter((name) => name.endsWith(`-${messageId}.md`));
  matching.sort((a, b) => (a > b ? -1 : 1));
  const versions: NoteVersion[] = [];
  for (const name of matching) {
    const body = await fs.readFile(path.join(dir, name), "utf-8");
    const isoPart = name.slice(0, -`-${messageId}.md`.length);
    // Restore the colons we stripped for filesystem safety.
    const restored = restoreIsoColons(isoPart);
    versions.push({ timestamp: restored, body });
  }
  return versions;
}

function restoreIsoColons(stripped: string): string {
  // `2026-04-23T09-15-30.123Z` → `2026-04-23T09:15:30.123Z`
  const tIdx = stripped.indexOf("T");
  if (tIdx === -1) return stripped;
  const date = stripped.slice(0, tIdx);
  const time = stripped.slice(tIdx + 1).replace(/-/g, ":");
  return `${date}T${time}`;
}
