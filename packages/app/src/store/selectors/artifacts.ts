import type { Artifact } from "@/data/ui-types";
import { fileKindFrom } from "@/data/file-kind";
import type { ServerFile } from "../types";

function artifactType(
  mime: string,
  name: string,
  isDir = false,
): Artifact["type"] {
  // A `<name>.app/` directory is a Roomy app — the directory extension is
  // the discriminator (see chat-apps plan, PR-A). Library `.app/`
  // recognition lands in PR-E; chat-artifact recognition lands in PR-B
  // and uses this same helper.
  if (isDir && isAppDirectoryName(name)) return "app";
  if (fileKindFrom(name, mime) === "image") return "image";
  const normalizedName = name.toLowerCase();
  if (
    mime === "text/csv" ||
    normalizedName.endsWith(".csv") ||
    mime === "application/vnd.ms-excel" ||
    mime === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
  )
    return "spreadsheet";
  if (
    mime === "text/html" ||
    normalizedName.endsWith(".html") ||
    normalizedName.endsWith(".htm")
  )
    return "site";
  if (mime === "application/json" && normalizedName.endsWith(".app.json")) return "app";
  return "document";
}

/** True when `name` is a `<kebab>.app` directory entry. */
export function isAppDirectoryName(name: string): boolean {
  return name.endsWith(".app") && name !== ".app";
}

/** True when `f` is a chat or library `.app/` directory. */
export function isAppArtifactFile(f: Pick<ServerFile, "name" | "isDir">): boolean {
  return Boolean(f.isDir) && isAppDirectoryName(f.name);
}

export function toArtifactFromFile(f: ServerFile): Artifact {
  const created = new Date(f.createdAt);
  return {
    id: f.path,
    name: f.name,
    type: artifactType(f.mime, f.name, f.isDir ?? false),
    agentName: "Agent",
    agentModel: "",
    createdAt: created,
    updatedAt: created,
    content: "",
    conversation: [],
    thumbnail: undefined,
  };
}
