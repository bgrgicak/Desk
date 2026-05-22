import { queries } from "@agent-desk/db";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  generateId,
  NotFoundError,
  ValidationError,
  MessageContentSchema,
  type Message,
  type WsEvent,
} from "@agent-desk/shared";
import { z } from "zod";
import {
  chatArtifactsDir,
  chatAttachmentsDir,
  copyLibraryAppToChat,
  deleteChatApp,
  deleteLibraryApp,
  pinLibraryFileToChat,
  removeChatAttachment,
  replaceLibraryAppFromChat,
  saveChatArtifactToLibrary,
  saveChatAttachmentToLibrary,
  validateLibrarySubpath,
  workspaceRootPath,
  type FileRef,
  type StorageContext,
} from "@agent-desk/storage";
import { writeBuiltinApps } from "@agent-desk/runtime";
import { workspaceSlugForChat } from "./chats-shared.js";

const APP_NAME_PATTERN = /^[a-z][a-z0-9-]{0,62}$/;
const APP_DIR_MIME = "application/vnd.desk.app+directory";
/** In-sandbox mount path for built-in apps (matches `APPS_SANDBOX_MOUNT_DIR` in @agent-desk/runtime). */
const GLOBAL_APP_SANDBOX_PREFIX = "/opt/desk-apps/";

/** Built-in apps live outside the workspace tree. The agent attaches them via their in-sandbox path. */
function isGlobalAppArtifactPath(raw: string): boolean {
  return raw.trim().startsWith(GLOBAL_APP_SANDBOX_PREFIX);
}

/**
 * Validates a `/opt/desk-apps/<name>.app/...` path and returns it normalized
 * (with the sandbox prefix retained — the chat stores the path verbatim so
 * the SPA can detect global-scope artifacts by prefix).
 */
function normalizeGlobalAppPath(raw: string): { sandboxPath: string; insidePath: string } {
  const trimmed = raw.trim();
  if (trimmed.includes("\0") || trimmed.includes("\\")) {
    throw new ValidationError(`Invalid artifact path: ${raw}`);
  }
  const inside = trimmed.slice(GLOBAL_APP_SANDBOX_PREFIX.length);
  if (!inside) throw new ValidationError(`Invalid built-in app path: ${raw}`);
  const segments = inside.split("/");
  for (const segment of segments) {
    if (segment === "" || segment === "." || segment === "..") {
      throw new ValidationError(`Invalid built-in app path segment: ${segment}`);
    }
  }
  const appDir = segments[0];
  if (!/^[a-z][a-z0-9-]{0,62}\.app$/.test(appDir)) {
    throw new ValidationError(`Invalid built-in app directory: ${appDir}`);
  }
  return { sandboxPath: `${GLOBAL_APP_SANDBOX_PREFIX}${inside}`, insidePath: inside };
}

function normalizeAppNameForDelete(appName: string): { appName: string; dirName: string } {
  const baseName = appName.endsWith(".app") ? appName.slice(0, -".app".length) : appName;
  if (!APP_NAME_PATTERN.test(baseName)) {
    throw new ValidationError(`Invalid app name: ${appName}`);
  }
  return { appName: baseName, dirName: `${baseName}.app` };
}

const AttachArtifactRefSchema = z.object({
  chatId: z.string(),
  path: z.string(),
  name: z.string().optional(),
  mime: z.string().optional(),
  params: z.record(z.string(), z.string()).optional(),
});

function normalizeWorkspaceRelativePath(raw: string): string {
  let relPath = raw.trim();
  if (!relPath) throw new ValidationError("Missing artifact path");
  if (relPath.includes("\0") || relPath.includes("\\")) {
    throw new ValidationError(`Invalid artifact path: ${raw}`);
  }
  if (relPath.startsWith("~/")) relPath = relPath.slice(2);
  if (relPath.startsWith("/home/agent/")) relPath = relPath.slice("/home/agent/".length);
  while (relPath.startsWith("./")) relPath = relPath.slice(2);
  if (path.isAbsolute(relPath)) throw new ValidationError(`Invalid artifact path: ${raw}`);

  const segments = relPath.split("/");
  for (const segment of segments) {
    if (segment === "" || segment === "." || segment === "..") {
      throw new ValidationError(`Invalid artifact path segment: ${segment}`);
    }
  }
  return segments.join("/");
}

function validateAttachableArtifactPath(relPath: string, _chatId: string): void {
  // Accepts three shapes:
  //   `.chats/<sourceChatId>/artifacts/<rest>` — any chat's artifact dir
  //     in the same workspace. Cross-chat refs are intentional: an agent
  //     running in chat A can surface a file from chat B's artifact dir
  //     in chat C. The downstream fs-stat check enforces that the file
  //     actually exists in the *target* chat's workspace tree, which
  //     implicitly rejects cross-workspace references.
  //   `<library/path>` — workspace-library files, the natural shared bucket.
  //   anything else under `.chats/` (e.g. `.chats/X/logs/`) is rejected —
  //     only the `artifacts/` subtree is attachable.
  if (relPath.startsWith(".chats/")) {
    const parts = relPath.split("/");
    if (parts.length < 4 || parts[0] !== ".chats" || parts[2] !== "artifacts") {
      throw new ValidationError("Artifact path under .chats/ must be in some chat's artifacts directory");
    }
    for (const segment of parts) {
      // Dot-prefixed segments are allowed — hidden files inside the
      // artifacts dir behave like regular files.
      if (segment === "" || segment === "." || segment === "..") {
        throw new ValidationError(`Invalid artifact path segment: ${segment}`);
      }
    }
    return;
  }

  // Library files are also workspace-relative and may be surfaced when the
  // agent created or promoted a finished artifact outside the chat scratchpad.
  validateLibrarySubpath(relPath);
}

export async function attachArtifactRef(
  storage: StorageContext,
  rawData: unknown,
  emit: (event: WsEvent) => void,
  opts?: { agentId?: string; model?: string },
): Promise<Message> {
  const parsed = AttachArtifactRefSchema.safeParse(rawData);
  if (!parsed.success) {
    throw new ValidationError(`Invalid artifact body: ${parsed.error.message}`);
  }
  const data = parsed.data;

  const chat = await queries.chats.findById(storage.pool, data.chatId);
  if (!chat) throw new NotFoundError(`Chat not found: ${data.chatId}`);

  // Built-in app path: lives outside the workspace tree, resolved against
  // ~/Desk/.apps/. The chat row stores the verbatim `/opt/desk-apps/...`
  // path so the SPA can detect global scope by prefix.
  if (isGlobalAppArtifactPath(data.path)) {
    const { sandboxPath, insidePath } = normalizeGlobalAppPath(data.path);
    const appsRoot = path.join(storage.home, ".apps");
    const abs = path.resolve(appsRoot, insidePath);
    if (!abs.startsWith(appsRoot + path.sep)) {
      throw new ValidationError(`Path traversal detected: ${data.path}`);
    }
    let stat = await fs.stat(abs).catch(() => null);
    if (!stat) {
      // The .apps mirror is populated once on server start by
      // writeBuiltinApps. If desk-apps was built (or freshly checked
      // out) after start, the mirror is stale and a path the agent
      // legitimately expects ("/opt/desk-apps/chat-forms.app/...") will
      // 404 — pushing the agent onto a workspace-relative fallback that
      // gets rendered in library scope and can't post chat messages.
      // Re-sync once on miss and retry the stat before giving up.
      await writeBuiltinApps(storage.home).catch(() => undefined);
      stat = await fs.stat(abs).catch(() => null);
    }
    if (!stat) throw new NotFoundError(`Built-in app artifact not found: ${insidePath}`);
    if (!stat.isFile() && !stat.isDirectory()) {
      throw new ValidationError(`Artifact path must point to a file or directory: ${insidePath}`);
    }
    const inferredMime = stat.isDirectory() ? "inode/directory" : undefined;
    const message = await queries.messages.insert(storage.pool, {
      id: generateId("message"),
      chatId: data.chatId,
      role: "agent",
      content: {
        type: "artifactRef",
        path: sandboxPath,
        workspaceId: chat.workspaceId,
        name: data.name?.trim() || path.basename(insidePath),
        mime: data.mime?.trim() || inferredMime,
        ...(data.params ? { params: data.params } : {}),
      },
      agentId: opts?.agentId ?? chat.agentId,
      model: opts?.model ?? null,
    });
    emit({ type: "message.appended", payload: message, workspaceId: chat.workspaceId, chatTitle: chat.title });
    emit({ type: "workspace.synced", payload: { workspaceId: chat.workspaceId } });
    return message;
  }

  const relPath = normalizeWorkspaceRelativePath(data.path);
  validateAttachableArtifactPath(relPath, data.chatId);

  const ws = await queries.workspaces.findById(storage.pool, chat.workspaceId);
  if (!ws) throw new NotFoundError(`Workspace not found: ${chat.workspaceId}`);

  const root = workspaceRootPath(storage.home, ws.path);
  const abs = path.resolve(root, relPath);
  if (!abs.startsWith(root + path.sep) && abs !== root) {
    throw new ValidationError(`Path traversal detected: ${data.path}`);
  }
  const stat = await fs.stat(abs).catch(() => null);
  if (!stat) throw new NotFoundError(`Artifact not found: ${relPath}`);
  if (!stat.isFile() && !stat.isDirectory()) {
    throw new ValidationError(`Artifact path must point to a file or directory: ${relPath}`);
  }

  const inferredMime = stat.isDirectory() ? "inode/directory" : undefined;

  const message = await queries.messages.insert(storage.pool, {
    id: generateId("message"),
    chatId: data.chatId,
    role: "agent",
    content: {
      type: "artifactRef",
      path: relPath,
      workspaceId: chat.workspaceId,
      name: data.name?.trim() || path.basename(relPath),
      mime: data.mime?.trim() || inferredMime,
      ...(data.params ? { params: data.params } : {}),
    },
    agentId: opts?.agentId ?? chat.agentId,
    model: opts?.model ?? null,
  });
  emit({ type: "message.appended", payload: message, workspaceId: chat.workspaceId, chatTitle: chat.title });
  emit({ type: "workspace.synced", payload: { workspaceId: chat.workspaceId } });
  return message;
}

export type ChatFileRef = FileRef & {
  kind: "attachment" | "artifact";
  /** True when the entry is a directory rather than a regular file. */
  isDir?: boolean;
  label?: string;
};

/**
 * Lists a chat's attachments from the filesystem. By default returns only
 * visible (non-dot) entries — the user-uploaded chat files plus any
 * agent-finalized output. Passing `showHidden: true` includes agent
 * artifacts (dot-prefixed drafts / scratch) for the chat Artifacts panel
 * or a diagnostic view. Passing `includeArtifacts: true` also walks
 * `.chats/{id}/artifacts/` so the chat Files panel can show agent-written
 * files alongside uploads — each item is tagged with `kind` so the UI can
 * render them differently. Directories in `artifacts/` are included and
 * marked with `isDir: true`.
 */
export async function listAttachments(
  storage: StorageContext,
  chatId: string,
  opts?: { showHidden?: boolean; includeArtifacts?: boolean },
): Promise<ChatFileRef[]> {
  const slug = await workspaceSlugForChat(storage.pool, chatId);
  const root = workspaceRootPath(storage.home, slug);
  const showHidden = opts?.showHidden ?? false;
  const out: ChatFileRef[] = [];
  const attachmentNames = new Set<string>();

  const attDir = await chatAttachmentsDir(storage.home, slug, chatId);
  const attNames = await fs.readdir(attDir).catch(() => [] as string[]);
  for (const name of attNames) {
    if (!showHidden && name.startsWith(".")) continue;
    const abs = path.join(attDir, name);
    const stat = await fs.stat(abs).catch(() => null);
    if (!stat) continue;
    const isAppDir = stat.isDirectory() && name.endsWith(".app") && name !== ".app";
    if (!stat.isFile() && !isAppDir) continue;
    attachmentNames.add(name);
    out.push({
      path: path.relative(root, abs).split(path.sep).join("/"),
      name,
      mime: isAppDir ? APP_DIR_MIME : "application/octet-stream",
      size: isAppDir ? 0 : stat.size,
      createdAt: stat.birthtime.toISOString(),
      updatedAtMs: String(stat.mtimeMs),
      kind: "attachment",
      isDir: isAppDir || undefined,
    });
  }

  if (opts?.includeArtifacts) {
    const artDir = chatArtifactsDir(storage.home, slug, chatId);
    const attachedArtifactPaths = new Set<string>();
    const { rows } = await storage.pool.query<{ content: string | unknown }>(
      "SELECT content FROM messages WHERE chat_id = ?",
      [chatId],
    );
    for (const row of rows) {
      let content: unknown = row.content;
      if (typeof row.content === "string") {
        try {
          content = JSON.parse(row.content) as unknown;
        } catch {
          continue;
        }
      }
      const parsed = MessageContentSchema.safeParse(content);
      if (!parsed.success || parsed.data.type !== "artifactRef") continue;
      if (parsed.data.path.startsWith(`.chats/${chatId}/artifacts/`)) {
        attachedArtifactPaths.add(parsed.data.path);
      }
    }

    const artNames = await fs.readdir(artDir).catch(() => [] as string[]);
    for (const name of artNames) {
      if (!showHidden && name.startsWith(".")) continue;
      const abs = path.join(artDir, name);
      const stat = await fs.stat(abs).catch(() => null);
      if (!stat) continue;
      const isDir = stat.isDirectory();
      const relPath = path.relative(root, abs).split(path.sep).join("/");
      const isAppArtifactDir = isDir && name.endsWith(".app");
      if (!isAppArtifactDir && !attachedArtifactPaths.has(relPath)) continue;
      // If a library app was pinned into the chat, it appears in attachments/
      // with the same basename while the original chat artifact may still be
      // present in artifacts/. Surface the pinned/library copy once; otherwise
      // the chat sidebar shows two indistinguishable app entries after pinning.
      if (isAppArtifactDir && attachmentNames.has(name)) continue;
      out.push({
        path: relPath,
        name,
        mime: isDir ? "inode/directory" : "application/octet-stream",
        size: stat.size,
        createdAt: stat.birthtime.toISOString(),
        updatedAtMs: String(stat.mtimeMs),
        kind: "artifact",
        isDir,
      });
    }
  }

  out.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  return out;
}

/**
 * Pins a library file into the chat's "In this chat" sidebar by
 * symlinking it under `.chats/{chatId}/attachments/`. The library file
 * stays where it is — only a link is created, so deleting the chat
 * doesn't affect the workspace library.
 */
export async function pinLibraryFile(
  storage: StorageContext,
  chatId: string,
  libraryPath: string,
  emit: (event: WsEvent) => void,
): Promise<FileRef> {
  const chat = await queries.chats.findById(storage.pool, chatId);
  if (!chat) throw new NotFoundError(`Chat not found: ${chatId}`);
  const ws = await queries.workspaces.findById(storage.pool, chat.workspaceId);
  if (!ws) throw new NotFoundError(`Workspace not found: ${chat.workspaceId}`);

  const file = await pinLibraryFileToChat(storage, ws.path, chatId, libraryPath);
  emit({ type: "artifact.created", payload: file });
  return file;
}

/**
 * Promotes a chat attachment from `.chats/{chatId}/attachments/` into the
 * primary workspace library. The original location becomes a symlink to the
 * new path, so the chat's "In this chat" sidebar continues to surface the
 * file. `attachmentName` is a basename (e.g. `chart.png`); `destSubpath`
 * (optional) is a workspace-root-relative library folder.
 */
export async function saveAttachmentToLibrary(
  storage: StorageContext,
  chatId: string,
  attachmentName: string,
  destSubpath: string | undefined,
  emit: (event: WsEvent) => void,
): Promise<FileRef> {
  const chat = await queries.chats.findById(storage.pool, chatId);
  if (!chat) throw new NotFoundError(`Chat not found: ${chatId}`);
  const ws = await queries.workspaces.findById(storage.pool, chat.workspaceId);
  if (!ws) throw new NotFoundError(`Workspace not found: ${chat.workspaceId}`);

  const file = await saveChatAttachmentToLibrary(
    storage,
    ws.path,
    chatId,
    attachmentName,
    destSubpath,
  );

  emit({
    type: "library.changed",
    payload: { workspaceId: chat.workspaceId, path: file.path, op: "added" },
  });

  return file;
}

/**
 * Promotes a `<name>.app/` chat artifact into the primary workspace
 * library. Mirrors `saveAttachmentToLibrary` but operates on directories
 * inside `.chats/{chatId}/artifacts/`. The chat artifact is removed from
 * the chat's artifacts dir on success.
 */
export async function saveArtifactToLibrary(
  storage: StorageContext,
  chatId: string,
  artifactName: string,
  destSubpath: string | undefined,
  emit: (event: WsEvent) => void,
): Promise<FileRef> {
  const chat = await queries.chats.findById(storage.pool, chatId);
  if (!chat) throw new NotFoundError(`Chat not found: ${chatId}`);
  const ws = await queries.workspaces.findById(storage.pool, chat.workspaceId);
  if (!ws) throw new NotFoundError(`Workspace not found: ${chat.workspaceId}`);

  const file = await saveChatArtifactToLibrary(
    storage,
    ws.path,
    chatId,
    artifactName,
    destSubpath,
  );

  emit({
    type: "library.changed",
    payload: { workspaceId: chat.workspaceId, path: file.path, op: "added" },
  });

  return file;
}

/**
 * Modify-as-version: copy a library `<name>.app/` into a chat's
 * artifacts dir so the agent can iterate on it without disturbing the
 * library copy.
 */
export async function copyAppFromLibrary(
  storage: StorageContext,
  chatId: string,
  libraryPath: string,
  emit: (event: WsEvent) => void,
): Promise<FileRef> {
  const chat = await queries.chats.findById(storage.pool, chatId);
  if (!chat) throw new NotFoundError(`Chat not found: ${chatId}`);
  const ws = await queries.workspaces.findById(storage.pool, chat.workspaceId);
  if (!ws) throw new NotFoundError(`Workspace not found: ${chat.workspaceId}`);

  const ref = await copyLibraryAppToChat(storage, ws.path, chatId, libraryPath);
  emit({
    type: "library.changed",
    payload: {
      workspaceId: chat.workspaceId,
      path: ref.path,
      op: "added",
      affectedChatIds: [chatId],
    },
  });
  return ref;
}

/**
 * Modify-as-version: replace a library `<name>.app/` with the
 * chat-artifact version of the same app. The prior library copy is
 * moved to `~/Desk/.trash/.app-versions/` for recovery.
 *
 * Concurrency: pass `expectedSourceVersion` (captured by the UI from
 * `copyLibraryAppToChat`'s response) to enforce an If-Match-style
 * version check. The caller surfaces the resulting `ConflictError` as
 * a 409 to the client.
 */
export async function replaceLibraryAppWithChatArtifact(
  storage: StorageContext,
  chatId: string,
  artifactName: string,
  targetPath: string,
  emit: (event: WsEvent) => void,
  opts: { expectedSourceVersion?: string } = {},
): Promise<FileRef> {
  const chat = await queries.chats.findById(storage.pool, chatId);
  if (!chat) throw new NotFoundError(`Chat not found: ${chatId}`);
  const ws = await queries.workspaces.findById(storage.pool, chat.workspaceId);
  if (!ws) throw new NotFoundError(`Workspace not found: ${chat.workspaceId}`);

  const ref = await replaceLibraryAppFromChat(
    storage,
    ws.path,
    chatId,
    artifactName,
    targetPath,
    { expectedSourceVersion: opts.expectedSourceVersion },
  );
  emit({
    type: "library.changed",
    payload: { workspaceId: chat.workspaceId, path: ref.path, op: "updated" },
  });
  return ref;
}

/**
 * Removes a chat attachment by basename. The mutation only unlinks the
 * entry inside `.chats/{chatId}/attachments/`: pinned library files
 * stay put, direct chat uploads are permanently removed (no
 * `.trash/` redirect — chat-scoped uploads are scratch, not library).
 */
export async function removeAttachment(
  storage: StorageContext,
  chatId: string,
  attachmentName: string,
): Promise<{ ok: true }> {
  const chat = await queries.chats.findById(storage.pool, chatId);
  if (!chat) throw new NotFoundError(`Chat not found: ${chatId}`);
  const ws = await queries.workspaces.findById(storage.pool, chat.workspaceId);
  if (!ws) throw new NotFoundError(`Workspace not found: ${chat.workspaceId}`);
  await removeChatAttachment(storage, ws.path, chatId, attachmentName);
  return { ok: true };
}

/**
 * Deletes a chat-artifact `<name>.app/` directory and revokes any active
 * app_sessions bound to it. Issue #47, PR-E.
 *
 * The cascade is: filesystem removal → token revocation. We delete the
 * fs first so a cookie-using iframe can't keep authoring data after the
 * directory is gone (the storage backing file goes with the directory),
 * then revoke the sessions so future requests get a clean 401.
 */
export async function removeChatApp(
  storage: StorageContext,
  chatId: string,
  appName: string,
  emit: (event: WsEvent) => void,
): Promise<void> {
  const chat = await queries.chats.findById(storage.pool, chatId);
  if (!chat) throw new NotFoundError(`Chat not found: ${chatId}`);
  const ws = await queries.workspaces.findById(storage.pool, chat.workspaceId);
  if (!ws) throw new NotFoundError(`Workspace not found: ${chat.workspaceId}`);

  const { appName: normalizedAppName, dirName } = normalizeAppNameForDelete(appName);
  await deleteChatApp(storage, ws.path, chatId, dirName);

  // Revoke any active sessions for this chat+app.
  await storage.pool.query(
    `DELETE FROM app_sessions WHERE chat_id = ? AND app_name = ?`,
    [chatId, normalizedAppName],
  );

  emit({
    type: "library.changed",
    payload: {
      workspaceId: chat.workspaceId,
      path: `.chats/${chatId}/artifacts/${dirName}`,
      op: "removed",
      affectedChatIds: [chatId],
    },
  });
}

/**
 * Deletes a library `<name>.app/` (workspace root only — subfoldered
 * apps go through the generic library-delete path). Cascade-revokes
 * any library-scope app_sessions bound to it. Issue #47, PR-E.
 */
export async function removeLibraryApp(
  storage: StorageContext,
  userId: string,
  appName: string,
  emit: (event: WsEvent) => void,
): Promise<void> {
  // Resolve the user's workspace the same way issueLibraryAppSession does.
  const { rows } = await storage.pool.query<{ id: string; path: string }>(
    "SELECT id, path FROM workspaces WHERE user_id = ? ORDER BY created_at LIMIT 1",
    [userId],
  );
  if (rows.length === 0) throw new NotFoundError("No workspace for user");
  const ws = rows[0];

  const { appName: normalizedAppName, dirName } = normalizeAppNameForDelete(appName);
  await deleteLibraryApp(storage, ws.path, dirName);

  await storage.pool.query(
    `DELETE FROM app_sessions WHERE scope = 'library' AND app_name = ? AND workspace_id = ?`,
    [normalizedAppName, ws.id],
  );

  emit({
    type: "library.changed",
    payload: { workspaceId: ws.id, path: dirName, op: "removed" },
  });
}
