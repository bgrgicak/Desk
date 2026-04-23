import type { ContextItem } from "@/data/mock-data";
import type { ServerFile } from "../types";

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

export function toContextItem(f: ServerFile): ContextItem {
  return {
    id: f.path,
    type: inferType(f.mime),
    name: f.name,
    content: "",
    folder: undefined,
    folderId: null,
    addedAt: new Date(f.createdAt),
    usedBy: [],
    uploadedBy: "user",
    lastAccessed: undefined,
    relatedArtifactIds: [],
    fileSize: humanSize(f.size),
    mimeType: f.mime,
  };
}
