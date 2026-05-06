import * as fs from "node:fs/promises";
import * as path from "node:path";
import { ValidationError, ID_PREFIXES } from "@agent-desk/shared";

/**
 * Single source of truth for resolving the Desk on-disk root.
 *
 * Every subsystem that touches files (API uploads, scheduler runs, runtime
 * bind-mounts) MUST go through this so they all land on the same tree. A
 * silent split — API writing to `$HOME` while the runtime mounts `/opt/desk`
 * — caused user uploads to vanish from inside sandboxes.
 *
 * Resolution order: explicit `DESK_HOME` env var → `HOME` (the user
 * running desk-server) → `/home/desk` (last-ditch fallback for headless
 * environments without `$HOME`).
 */
export function resolveDeskHome(): string {
  return process.env.DESK_HOME ?? process.env.HOME ?? "/home/desk";
}

/**
 * Resolves the absolute path of a workspace's root directory.
 *
 * Each workspace gets its own subdirectory under `~/Desk/workspaces/{slug}/`.
 * The `slug` is the `path` column on `workspaces` — derived from the
 * workspace name at create time and renamed in lock-step on rename.
 */
function workspaceRoot(home: string, slug: string): string {
  validateSlug(slug);
  return path.join(home, "Desk", "workspaces", slug);
}

/** Absolute path to the global trash directory. Sits outside the workspace so the agent can't see it. */
export function trashDir(home: string): string {
  return path.join(home, "Desk", ".trash");
}

/** Parent directory that holds every workspace as a subdirectory. */
export function workspacesRoot(home: string): string {
  return path.join(home, "Desk", "workspaces");
}

/** Validates that an ID string matches the expected prefix pattern and contains no path separators. */
function validateId(id: string, prefix: string): void {
  if (!id.startsWith(prefix) || id.includes("/") || id.includes("\\") || id.includes("..")) {
    throw new ValidationError(`Invalid ID: ${id}`);
  }
}

/**
 * Rejects slugs that would escape the workspaces root or name a reserved
 * system file. Valid slugs are non-empty, made of `[a-z0-9-]`, and don't
 * start or end with `-`.
 */
function validateSlug(slug: string): void {
  if (!slug || slug.includes("/") || slug.includes("\\") || slug.includes("..") || slug.startsWith(".")) {
    throw new ValidationError(`Invalid workspace slug: ${slug}`);
  }
}

/**
 * Ensures the global Desk layout exists: `~/Desk/.tmp/`, `~/Desk/.trash/`,
 * and the `~/Desk/workspaces/` parent directory. Idempotent — safe to
 * call on every boot.
 *
 * Per-workspace directories are created by `ensureWorkspaceLayout`.
 */
export async function ensureLayout(home: string): Promise<void> {
  await fs.mkdir(path.join(home, "Desk", ".tmp"), { recursive: true });
  await fs.mkdir(trashDir(home), { recursive: true });
  await fs.mkdir(workspacesRoot(home), { recursive: true });
  await ensureUserMemoryLayout(home);
}

/**
 * Ensures a single workspace's on-disk tree exists: the root directory
 * plus `.chats/` inside it. Idempotent. Called during workspace create
 * and during `ensureLayout` when bootstrapping existing workspaces.
 */
export async function ensureWorkspaceLayout(home: string, slug: string): Promise<void> {
  const root = workspaceRoot(home, slug);
  await fs.mkdir(root, { recursive: true });
  await fs.mkdir(path.join(root, ".chats"), { recursive: true });
  await ensureWorkspaceMemoryLayout(home, slug);
}

/**
 * Returns the absolute path to the chats root directory. Contains one
 * subdirectory per chat, each with `attachments/`, `logs/`, and `notes/`
 * inside. Hidden from user file listings via the
 * leading-dot convention.
 */
export function chatsDir(home: string, slug: string): string {
  return path.join(workspaceRoot(home, slug), ".chats");
}

/** Returns the absolute path to a chat's attachments directory. Creates it lazily. */
export async function chatAttachmentsDir(
  home: string,
  slug: string,
  chatId: string,
): Promise<string> {
  validateId(chatId, ID_PREFIXES.chat);
  const dir = path.join(workspaceRoot(home, slug), ".chats", chatId, "attachments");
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

/** Returns the absolute path to a chat's agent-artifacts directory. Does not create it. */
export function chatArtifactsDir(home: string, slug: string, chatId: string): string {
  validateId(chatId, ID_PREFIXES.chat);
  return path.join(workspaceRoot(home, slug), ".chats", chatId, "artifacts");
}

/** Returns the temp directory for in-progress uploads. */
export function tmpDir(home: string): string {
  return path.join(home, "Desk", ".tmp");
}

/**
 * Path helpers for the memory system.
 *
 * Memory has three on-disk roots:
 *   - User memory:      ~/Desk/.memory/
 *   - Workspace memory: ~/Desk/workspaces/<slug>/.memory/
 *   - Chat memory:      existing ~/Desk/workspaces/<slug>/.chats/<id>/notes/ (covered elsewhere)
 *
 * The user and workspace roots each contain an always-injected index file
 * (`memory.md` / `workspace.md`), arbitrary topic files referenced by the
 * index, and a never-injected `journal/<YYYY-MM-DD>.md` daily logbook
 * written by the reflection job.
 *
 * Filenames are validated to prevent path traversal.
 */

const MEMORY_DIR = ".memory";
const USER_MEMORY_INDEX = "memory.md";
const WORKSPACE_MEMORY_INDEX = "workspace.md";
const JOURNAL_DIR = "journal";

/**
 * Rejects topic file names that would escape the memory directory or name
 * the index itself. Valid names are non-empty, contain no separators, and
 * end in `.md`.
 */
function validateTopicFilename(name: string): void {
  if (!name || name.includes("/") || name.includes("\\") || name.includes("..") || name.startsWith(".")) {
    throw new ValidationError(`Invalid memory topic filename: ${name}`);
  }
  if (!name.endsWith(".md")) {
    throw new ValidationError(`Memory topic filename must end with .md: ${name}`);
  }
}

/** Validates a journal date stamp. Must be exactly `YYYY-MM-DD`. */
function validateJournalDate(date: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new ValidationError(`Invalid journal date: ${date} (expected YYYY-MM-DD)`);
  }
}

/** Absolute path to the user memory root: `~/Desk/.memory/`. */
export function userMemoryDir(home: string): string {
  return path.join(home, "Desk", MEMORY_DIR);
}

/** Absolute path to the user memory index file: `~/Desk/.memory/memory.md`. */
export function userMemoryIndexPath(home: string): string {
  return path.join(userMemoryDir(home), USER_MEMORY_INDEX);
}

/** Absolute path to a user memory topic file: `~/Desk/.memory/<topic>.md`. */
export function userMemoryTopicPath(home: string, topic: string): string {
  validateTopicFilename(topic);
  return path.join(userMemoryDir(home), topic);
}

/** Absolute path to the user journal directory: `~/Desk/.memory/journal/`. */
export function userJournalDir(home: string): string {
  return path.join(userMemoryDir(home), JOURNAL_DIR);
}

/** Absolute path to a user journal entry: `~/Desk/.memory/journal/<YYYY-MM-DD>.md`. */
export function userJournalPath(home: string, date: string): string {
  validateJournalDate(date);
  return path.join(userJournalDir(home), `${date}.md`);
}

/** Absolute path to a workspace memory root: `~/Desk/workspaces/<slug>/.memory/`. */
export function workspaceMemoryDir(home: string, slug: string): string {
  return path.join(workspaceRoot(home, slug), MEMORY_DIR);
}

/** Absolute path to the workspace memory index file: `<workspace>/.memory/workspace.md`. */
export function workspaceMemoryIndexPath(home: string, slug: string): string {
  return path.join(workspaceMemoryDir(home, slug), WORKSPACE_MEMORY_INDEX);
}

/** Absolute path to a workspace memory topic file. */
export function workspaceMemoryTopicPath(home: string, slug: string, topic: string): string {
  validateTopicFilename(topic);
  return path.join(workspaceMemoryDir(home, slug), topic);
}

/** Absolute path to the workspace journal directory. */
export function workspaceJournalDir(home: string, slug: string): string {
  return path.join(workspaceMemoryDir(home, slug), JOURNAL_DIR);
}

/** Absolute path to a workspace journal entry. */
export function workspaceJournalPath(home: string, slug: string, date: string): string {
  validateJournalDate(date);
  return path.join(workspaceJournalDir(home, slug), `${date}.md`);
}

const USER_MEMORY_INDEX_SKELETON = `# User memory

_Index of long-term memory shared across every workspace. Each line points
at a topic file or carries an inline preference. Add or rewrite freely;
the agent reads this file every turn._
`;

const WORKSPACE_MEMORY_INDEX_SKELETON = `# Workspace memory

_Index of long-term memory scoped to this workspace. Workspace memory
overrides user memory on workspace-specific topics._
`;

/**
 * Ensures the user memory tree exists with an empty index skeleton and
 * journal directory. Idempotent — never overwrites an existing index.
 */
export async function ensureUserMemoryLayout(home: string): Promise<void> {
  await fs.mkdir(userMemoryDir(home), { recursive: true });
  await fs.mkdir(userJournalDir(home), { recursive: true });
  const indexPath = userMemoryIndexPath(home);
  const exists = await fs.stat(indexPath).catch(() => null);
  if (!exists) {
    await fs.writeFile(indexPath, USER_MEMORY_INDEX_SKELETON, "utf-8");
  }
}

/**
 * Ensures a workspace's memory tree exists with an empty index skeleton
 * and journal directory. Idempotent — never overwrites an existing index.
 */
export async function ensureWorkspaceMemoryLayout(home: string, slug: string): Promise<void> {
  await fs.mkdir(workspaceMemoryDir(home, slug), { recursive: true });
  await fs.mkdir(workspaceJournalDir(home, slug), { recursive: true });
  const indexPath = workspaceMemoryIndexPath(home, slug);
  const exists = await fs.stat(indexPath).catch(() => null);
  if (!exists) {
    await fs.writeFile(indexPath, WORKSPACE_MEMORY_INDEX_SKELETON, "utf-8");
  }
}

/** Absolute path to a workspace's root (used by storage to resolve relative paths). */
export function workspaceRootPath(home: string, slug: string): string {
  return workspaceRoot(home, slug);
}

const MEMORY_DIR = ".memory";
const JOURNAL_DIR = "journal";

/** Validates a journal date stamp. Must be exactly `YYYY-MM-DD`. */
function validateJournalDate(date: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new ValidationError(`Invalid journal date: ${date} (expected YYYY-MM-DD)`);
  }
}

/** Absolute path to the user memory root: `~/Desk/.memory/`. */
export function userMemoryDir(home: string): string {
  return path.join(home, "Desk", MEMORY_DIR);
}

/** Absolute path to the user journal directory: `~/Desk/.memory/journal/`. */
export function userJournalDir(home: string): string {
  return path.join(userMemoryDir(home), JOURNAL_DIR);
}

/** Absolute path to a user journal entry: `~/Desk/.memory/journal/<YYYY-MM-DD>.md`. */
export function userJournalPath(home: string, date: string): string {
  validateJournalDate(date);
  return path.join(userJournalDir(home), `${date}.md`);
}

/** Absolute path to a workspace memory root: `~/Desk/workspaces/<slug>/.memory/`. */
export function workspaceMemoryDir(home: string, slug: string): string {
  return path.join(workspaceRoot(home, slug), MEMORY_DIR);
}

/** Absolute path to the workspace journal directory. */
export function workspaceJournalDir(home: string, slug: string): string {
  return path.join(workspaceMemoryDir(home, slug), JOURNAL_DIR);
}

/** Absolute path to a workspace journal entry. */
export function workspaceJournalPath(home: string, slug: string, date: string): string {
  validateJournalDate(date);
  return path.join(workspaceJournalDir(home, slug), `${date}.md`);
}

/**
 * Resolves a file's absolute host path from its stored (workspace-relative)
 * path. Validates against path traversal.
 */
export function resolveHostPath(home: string, slug: string, storedPath: string): string {
  const root = workspaceRoot(home, slug);
  const resolved = path.resolve(root, storedPath);
  if (!resolved.startsWith(root + path.sep) && resolved !== root) {
    throw new ValidationError(`Path traversal detected: ${storedPath}`);
  }
  return resolved;
}

/**
 * Soft-deletes a workspace's on-disk directory by moving it to
 * `~/Desk/.trash/workspaces/{slug}-{timestamp}/`. Idempotent — returns
 * `{ moved: false }` if the source doesn't exist.
 */
export async function trashWorkspaceDir(
  home: string,
  slug: string,
): Promise<{ moved: boolean }> {
  const src = workspaceRoot(home, slug);
  const stat = await fs.stat(src).catch(() => null);
  if (!stat) return { moved: false };
  const stamp = Date.now();
  const dst = path.join(trashDir(home), "workspaces", `${slug}-${stamp}`);
  await fs.mkdir(path.dirname(dst), { recursive: true });
  await fs.rename(src, dst);
  return { moved: true };
}

/**
 * Renames a workspace's directory from one slug to another. Creates the
 * parent if needed and fails cleanly if the destination already exists.
 * Both the old and new directory must sit under `~/Desk/workspaces/`.
 */
export async function renameWorkspaceDir(
  home: string,
  oldSlug: string,
  newSlug: string,
): Promise<void> {
  if (oldSlug === newSlug) return;
  const from = workspaceRoot(home, oldSlug);
  const to = workspaceRoot(home, newSlug);
  await fs.mkdir(path.dirname(to), { recursive: true });
  const existing = await fs.stat(to).catch(() => null);
  if (existing) {
    throw new ValidationError(`Workspace directory already exists: ${newSlug}`);
  }
  // If the source doesn't exist (edge: legacy workspace, never initialized),
  // just create the destination empty instead of failing the rename.
  const src = await fs.stat(from).catch(() => null);
  if (!src) {
    await fs.mkdir(to, { recursive: true });
    return;
  }
  await fs.rename(from, to);
}
