import type { ContextItem, Folder } from "@/data/ui-types";
import type { ServerFile, ServerFolder } from "../types";

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function inferType(mime: string): ContextItem["type"] {
  if (mime === "text/markdown" || mime === "text/plain") return "note";
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
 * for forward compatibility.
 */
export function toContextItem(f: ServerFile, _workspaceId: string): ContextItem {
  return {
    id: f.path,
    type: inferType(f.mime),
    // Prefer the server's display label when present (e.g. "Chat notes")
    // so notes don't surface the messageId-based filename as their title.
    name: f.label ?? f.name,
    content: "",
    folder: undefined,
    folderId: folderIdForFile(f.path),
    addedAt: new Date(f.createdAt),
    usedBy: [],
    uploadedBy: "user",
    lastAccessed: undefined,
    relatedArtifactIds: [],
    fileSize: humanSize(f.size),
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
    };
  });
}
