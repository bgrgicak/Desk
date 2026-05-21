import { ValidationError } from "@agent-desk/shared";

export type SearchScope = "artifacts" | "chats" | "library" | "files" | "all";
export type SearchKind = "chat" | "message" | "summary" | "library_file" | "attachment" | "artifact";

const SEARCH_SCOPES = new Set(["all", "artifacts", "chats", "library", "files"]);
const SEARCH_KINDS = new Set(["chat", "message", "summary", "library_file", "attachment", "artifact"]);

export function parseSearchScope(raw: string | null): SearchScope {
  const scope = raw ?? "all";
  if (!SEARCH_SCOPES.has(scope)) throw new ValidationError(`Invalid search scope: ${scope}`);
  return scope as SearchScope;
}

export function parseSearchKinds(raw: string | null): SearchKind[] | undefined {
  if (!raw) return undefined;
  const kinds = raw.split(",").map((kind) => kind.trim()).filter(Boolean);
  for (const kind of kinds) {
    if (!SEARCH_KINDS.has(kind)) throw new ValidationError(`Invalid search kind: ${kind}`);
  }
  return kinds as SearchKind[];
}
