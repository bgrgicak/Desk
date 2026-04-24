import * as fs from "node:fs/promises";
import * as path from "node:path";
import { ValidationError, ID_PREFIXES } from "@desk/shared";

const WORKSPACE_SLUG = "desk";

function workspaceRoot(home: string): string {
  return path.join(home, "Desk", "workspaces", WORKSPACE_SLUG);
}

/** Absolute path to the global trash directory. Sits outside the workspace so the agent can't see it. */
export function trashDir(home: string): string {
  return path.join(home, "Desk", ".trash");
}

/** Validates that an ID string matches the expected prefix pattern and contains no path separators. */
function validateId(id: string, prefix: string): void {
  if (!id.startsWith(prefix) || id.includes("/") || id.includes("\\") || id.includes("..")) {
    throw new ValidationError(`Invalid ID: ${id}`);
  }
}

/**
 * Ensures the workspace directory tree + trash directory exist.
 * Idempotent — safe to call on every boot.
 *
 * Under the workspace-as-home model the workspace root itself is the
 * library; user files live at this root. Hidden (dot-prefixed) subdirs
 * hold conversation state, agent config, and any other app infrastructure.
 */
export async function ensureLayout(home: string): Promise<void> {
  const root = workspaceRoot(home);
  await fs.mkdir(root, { recursive: true });
  await fs.mkdir(path.join(root, ".chats"), { recursive: true });
  await fs.mkdir(path.join(home, "Desk", ".tmp"), { recursive: true });
  await fs.mkdir(trashDir(home), { recursive: true });
}

/** Returns the root directory for a workspace. */
export function workspaceDir(_workspaceId: string): string {
  // v1: single workspace, ID is ignored — always returns the "desk" workspace
  return "";
}

/**
 * Returns the absolute path to the chats root directory. Contains one
 * subdirectory per chat, each with `attachments/`, `logs/`, and
 * `note-history/` inside. Hidden from user file listings via the
 * leading-dot convention.
 */
export function chatsDir(home: string): string {
  return path.join(workspaceRoot(home), ".chats");
}

/** Returns the absolute path to a chat's attachments directory. Creates it lazily. */
export async function chatAttachmentsDir(home: string, chatId: string): Promise<string> {
  validateId(chatId, ID_PREFIXES.chat);
  const dir = path.join(workspaceRoot(home), ".chats", chatId, "attachments");
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

/** Returns the temp directory for in-progress uploads. */
export function tmpDir(home: string): string {
  return path.join(home, "Desk", ".tmp");
}

/** Absolute path to the workspace root (used by storage to resolve relative paths). */
export function workspaceRootPath(home: string): string {
  return workspaceRoot(home);
}

/**
 * Resolves a file's absolute host path from its stored relative path.
 * Validates against path traversal.
 */
export function resolveHostPath(home: string, storedPath: string): string {
  const root = workspaceRoot(home);
  const resolved = path.resolve(root, storedPath);
  if (!resolved.startsWith(root + path.sep) && resolved !== root) {
    throw new ValidationError(`Path traversal detected: ${storedPath}`);
  }
  return resolved;
}
