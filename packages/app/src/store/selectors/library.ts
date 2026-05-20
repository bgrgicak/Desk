import type { ContextItem, Folder } from "@/data/ui-types";
import type { ServerAgent, ServerFile, ServerFolder } from "../types";

/**
 * A library entry targeted by a move-to-folder action. Shared by the
 * Library list (bulk + single, files & folders) and the file-detail
 * view (single file) so both drive the same `MoveToFolderDialog`.
 */
export type MoveTarget = {
  path: string;
  name: string;
  kind: "item" | "folder";
};

export function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function inferType(mime: string, name: string, isDir = false): ContextItem["type"] {
  // `<name>.app/` directory entries surface as `type: "app"` so the
  // library renders the app icon + ContextDetail picks the AppPreview
  // variant. Issue #47, PR-E.
  if (isDir && name.endsWith(".app") && name !== ".app") return "app";
  if (mime === "application/vnd.desk.app+directory") return "app";
  if (mime === "text/markdown") return "note";
  if (mime.startsWith("text/uri-list")) return "link";
  return "file";
}

/**
 * Given a workspace-root-relative file path like `Photos/2024/beach.jpg`,
 * returns the folder id of the containing directory, or `null` when the
 * file lives at the workspace root.
 */
function folderIdForFile(filePath: string): string | null {
  const lastSlash = filePath.lastIndexOf("/");
  if (lastSlash === -1) return null;
  return filePath.slice(0, lastSlash);
}

/**
 * Folder hierarchy is derived from the server's `ServerFolder[]`
 * directly; the workspaceId is a no-op in v1 but kept in the signature
 * for forward compatibility. `agents`, when provided, lets the selector
 * resolve a display name for the originating agent.
 */
export function toContextItem(
  f: ServerFile,
  _workspaceId: string,
  agents: ServerAgent[] = [],
): ContextItem {
  const creatorAgent = f.creatorAgentId
    ? agents.find((a) => a.id === f.creatorAgentId)
    : undefined;
  return {
    id: f.path,
    type: inferType(f.mime, f.name, f.isDir ?? false),
    // Prefer the server's display label when present (e.g. "Chat summary")
    // so notes don't surface the messageId-based filename as their title.
    name: f.label ?? f.name,
    content: "",
    folder: undefined,
    folderId: folderIdForFile(f.path),
    addedAt: new Date(f.createdAt),
    usedBy: [],
    uploadedBy: f.creatorAgentId ? "ai" : "user",
    agentName: creatorAgent?.name,
    pinned: f.pinned ?? false,
    lastAccessed: undefined,
    relatedArtifactIds: [],
    fileSize: humanSize(f.size),
    size: f.size,
    mimeType: f.mime,
  };
}

/**
 * Converts server-side FolderRefs into the UI's Folder shape. `id`
 * equals the workspace-root-relative path; `parentId` is the path of
 * the containing directory, or `null` when the folder sits at the root.
 */
export function toFolderList(
  folders: ServerFolder[],
  _workspaceId: string,
): Folder[] {
  return folders.map((f) => {
    const lastSlash = f.path.lastIndexOf("/");
    const parentId = lastSlash === -1 ? null : f.path.slice(0, lastSlash);
    return {
      id: f.path,
      name: f.name,
      parentId,
      createdAt: new Date(f.createdAt),
      pinned: f.pinned ?? false,
    };
  });
}
