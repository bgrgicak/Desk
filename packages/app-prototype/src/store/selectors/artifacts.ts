import type { Artifact } from "@/data/ui-types";
import type { ServerAgent, ServerFile } from "../types";

function artifactType(mime: string, name: string): Artifact["type"] {
  if (mime.startsWith("image/")) return "image";
  if (
    mime === "text/csv" ||
    name.endsWith(".csv") ||
    mime === "application/vnd.ms-excel" ||
    mime === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
  )
    return "spreadsheet";
  if (
    mime === "text/html" ||
    name.endsWith(".html") ||
    name.endsWith(".htm")
  )
    return "site";
  if (mime === "application/json" && name.endsWith(".app.json")) return "app";
  return "document";
}

export function toArtifactFromFile(f: ServerFile, agents: ServerAgent[]): Artifact {
  const created = new Date(f.createdAt);
  const agent = agents.find((a) => a.id === f.agentId);
  return {
    id: f.path,
    name: f.name,
    type: artifactType(f.mime, f.name),
    agentName: agent?.name ?? "Agent",
    agentModel: agent?.model ?? "",
    createdAt: created,
    updatedAt: created,
    content: "",
    conversation: [],
    thumbnail: undefined,
  };
}
