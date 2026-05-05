import type { Artifact } from "@/data/ui-types";
import { fileKindFrom } from "@/data/file-kind";
import type { ServerFile } from "../types";

function artifactType(mime: string, name: string): Artifact["type"] {
  const normalizedName = name.toLowerCase();
  if (fileKindFrom(name, mime) === "image") return "image";
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

export function toArtifactFromFile(f: ServerFile): Artifact {
  const created = new Date(f.createdAt);
  return {
    id: f.path,
    name: f.name,
    type: artifactType(f.mime, f.name),
    agentName: "Agent",
    agentModel: "",
    createdAt: created,
    updatedAt: created,
    content: "",
    conversation: [],
    thumbnail: undefined,
  };
}
