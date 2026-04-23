import * as fs from "node:fs/promises";
import * as path from "node:path";
import { ValidationError, ID_PREFIXES } from "@desk/shared";

const WORKSPACE_SLUG = "desk";

function workspaceRoot(home: string): string {
  return path.join(home, "Desk", "workspaces", WORKSPACE_SLUG);
}

/** Absolute path to the global trash directory. Not mounted into sandboxes. */
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
 */
export async function ensureLayout(home: string): Promise<void> {
  const root = workspaceRoot(home);
  await fs.mkdir(path.join(root, "files"), { recursive: true });
  await fs.mkdir(path.join(root, "chats"), { recursive: true });
  await fs.mkdir(path.join(root, "library"), { recursive: true });
  await fs.mkdir(path.join(home, "Desk", ".tmp"), { recursive: true });
  await fs.mkdir(trashDir(home), { recursive: true });
}

/** Returns the root directory for a workspace. */
export function workspaceDir(_workspaceId: string): string {
  // v1: single workspace, ID is ignored — always returns the "desk" workspace
  return "";
}

/** Returns the absolute path to the workspace files directory. */
export function filesDir(home: string): string {
  return path.join(workspaceRoot(home), "files");
}

/**
 * Returns the absolute path to the chats root directory. Contains one
 * subdirectory per chat, each with its own `attachments/` inside.
 */
export function chatsDir(home: string): string {
  return path.join(workspaceRoot(home), "chats");
}

/** Returns the absolute path to a chat's attachments directory. Creates it lazily. */
export async function chatAttachmentsDir(home: string, chatId: string): Promise<string> {
  validateId(chatId, ID_PREFIXES.chat);
  const dir = path.join(workspaceRoot(home), "chats", chatId, "attachments");
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

/** Returns the absolute path to the shared library root (contains per-workspace subdirs). */
export function libraryDir(home: string): string {
  return path.join(workspaceRoot(home), "library");
}

/**
 * Returns the absolute path to a workspace's library subdirectory. Each
 * workspace owns a subtree under `library/` keyed by workspaceId so that
 * GET/POST/DELETE /library?workspaceId=... can filter by real on-disk
 * scope, not a DB column.
 */
export function workspaceLibraryDir(home: string, workspaceId: string): string {
  validateId(workspaceId, ID_PREFIXES.workspace);
  return path.join(libraryDir(home), workspaceId);
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
