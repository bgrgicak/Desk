import { type Pool } from "../pool.js";

export type ArtifactKind = "app" | "fragment" | "note" | "doc";

export interface FindArtifactsParams {
  /**
   * Free-text query against name + description + body. Whitespace
   * tokenized; every token must appear (case-insensitive). Optional —
   * when missing, returns the most-recently-updated artifacts in scope.
   */
  query?: string;
  /** Filter by kind. `'any'` (default) returns all four. */
  kind?: ArtifactKind | "any";
  /**
   * Workspace scope. Pass a slug for a specific workspace, `"*"` for
   * cross-workspace (route layer scopes to user-owned workspaces),
   * or omit to leave unscoped.
   */
  workspaceSlug?: string;
  /** Max rows returned. Defaults to 25, capped at 100. */
  limit?: number;
}

export interface FindArtifactsHit {
  kind: ArtifactKind;
  /** Workspace-relative path (e.g. `notes/foo.md` or `todos.app`). */
  path: string;
  /** Display name. For files this is the basename; for manifests, the manifest `name`. */
  name: string;
  /** Description. For files: the first line of the body. For manifests: the manifest `description`. */
  description: string;
  workspaceSlug: string;
  /** ISO mtime of the underlying file/manifest. */
  lastModified: string;
  /** Relevance score: token-occurrence count. */
  score: number;
}

const ARTIFACT_KINDS: readonly ArtifactKind[] = ["app", "fragment", "note", "doc"];

function tokenize(query: string): string[] {
  const seen = new Set<string>();
  const tokens: string[] = [];
  for (const tok of query.toLowerCase().split(/\s+/g)) {
    if (tok && !seen.has(tok)) {
      seen.add(tok);
      tokens.push(tok);
    }
  }
  return tokens;
}

function escapeLike(s: string): string {
  return s.replace(/[%_\\]/g, "\\$&");
}

function basenameWithoutExt(p: string): string {
  const segs = p.split("/");
  const last = segs[segs.length - 1] ?? p;
  const dot = last.lastIndexOf(".");
  return dot > 0 ? last.slice(0, dot) : last;
}

function firstLine(s: string): string {
  const nl = s.indexOf("\n");
  return (nl === -1 ? s : s.slice(0, nl)).trim();
}

function describeHit(kind: ArtifactKind, path: string, body: string): { name: string; description: string } {
  if (kind === "app" || kind === "fragment") {
    // Manifest body is `name\ndescription\nparams`. Recover the first
    // two lines as name + description.
    const [name, ...rest] = body.split("\n");
    return {
      name: name?.trim() || basenameWithoutExt(path),
      description: rest.join("\n").split("\n")[0]?.trim() || "",
    };
  }
  return {
    name: path.split("/").pop() ?? path,
    description: firstLine(body),
  };
}

/**
 * Find apps, fragments, notes, and docs in the user's workspace
 * library by free-text match across name + description + body. The
 * underlying index is the same `chat_search_index` table populated by
 * the migration in Phase 3 (extended in Phase 4 by `libraryIndexer`).
 *
 * Memory-system spec, Section 6.
 */
export async function findArtifacts(
  db: Pool,
  params: FindArtifactsParams,
): Promise<FindArtifactsHit[]> {
  const limit = Math.max(1, Math.min(params.limit ?? 25, 100));
  const tokens = tokenize(params.query ?? "");
  const kindFilter =
    params.kind && params.kind !== "any"
      ? ARTIFACT_KINDS.includes(params.kind as ArtifactKind)
        ? `AND kind = '${params.kind}'`
        : "AND 1 = 0"
      : `AND kind IN ('app', 'fragment', 'note', 'doc')`;
  const workspaceClause =
    params.workspaceSlug && params.workspaceSlug !== "*"
      ? "AND workspace_slug = ?"
      : "";

  const sqlParams: unknown[] = [];
  // Order matters: bind in the same order placeholders appear in the SQL
  // (workspace_slug first, then the LIKE tokens, then LIMIT).
  if (params.workspaceSlug && params.workspaceSlug !== "*") {
    sqlParams.push(params.workspaceSlug);
  }
  let tokenClause = "";
  if (tokens.length > 0) {
    tokenClause = "AND " + tokens.map(() => "body_lc LIKE ?").join(" AND ");
    for (const tok of tokens) sqlParams.push(`%${escapeLike(tok)}%`);
  }
  // Pull more than `limit` so we can rank in JS.
  sqlParams.push(limit * 4);

  const { rows } = await db.query(
    `
    SELECT ref_id, body, body_lc, workspace_slug, kind, created_at
    FROM chat_search_index
    WHERE 1 = 1
      ${kindFilter}
      ${workspaceClause}
      ${tokenClause}
    ORDER BY created_at DESC
    LIMIT ?
    `,
    sqlParams,
  );

  const hits: FindArtifactsHit[] = rows.map((row) => {
    const body = row.body as string;
    const bodyLc = row.body_lc as string;
    let score = 0;
    for (const tok of tokens) {
      let from = 0;
      while (true) {
        const idx = bodyLc.indexOf(tok, from);
        if (idx === -1) break;
        score += 1;
        from = idx + tok.length;
      }
    }
    const kind = row.kind as ArtifactKind;
    const path = row.ref_id as string;
    const { name, description } = describeHit(kind, path, body);
    return {
      kind,
      path,
      name,
      description,
      workspaceSlug: (row.workspace_slug as string | null) ?? "",
      lastModified: row.created_at as string,
      score,
    };
  });

  hits.sort((a, b) => b.score - a.score || (a.lastModified < b.lastModified ? 1 : -1));
  return hits.slice(0, limit);
}
