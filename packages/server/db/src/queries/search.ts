import { type Pool } from "../pool.js";

export interface SearchChatMessagesParams {
  /**
   * Free-text query. Splits on whitespace; each whitespace-separated
   * token must appear (case-insensitive) in the indexed body. This is
   * the LIKE-based interim implementation — see migration
   * `0028_chat_search_fts.sql` for the FTS5 swap path.
   */
  query: string;
  /** Restrict to a single chat (in-chat recall). */
  chatId?: string;
  /**
   * Workspace scope. Pass a slug for a specific workspace, or `"*"` for
   * cross-workspace search. Default behavior is to leave unscoped — the
   * route layer should apply the user's current workspace by default
   * and only widen on explicit request, per Section 3 of the
   * memory-system spec.
   */
  workspaceSlug?: string;
  /** Restrict to any of these workspace slugs, used for authorized cross-workspace search. */
  workspaceSlugs?: string[];
  /** Filter by content kind. `'any'` searches every indexed kind unless `kinds` is supplied. */
  kind?: SearchDocumentKind | "any";
  /** Filter to a set of indexed kinds. Takes precedence over `kind`. */
  kinds?: SearchDocumentKind[];
  /** Include indexed chat title rows alongside message/summary body rows. */
  includeTitles?: boolean;
  /** Max rows returned. Defaults to 25. */
  limit?: number;
}

export interface SearchChatMessagesHit {
  chatId: string | null;
  refId: string;
  messageId: string;
  workspaceSlug: string | null;
  kind: SearchDocumentKind;
  /** Truncated body excerpt around the first match, with `<mark>…</mark>` highlights. */
  snippet: string;
  /** ISO8601 timestamp of the indexed row. */
  createdAt: string;
  /**
   * Match score (higher = better). Sum of token occurrences across the
   * body. Used as the order key — surfaced for UI / debugging.
   */
  score: number;
}

export type SearchDocumentKind =
  | "chat"
  | "message"
  | "summary"
  | "library_file"
  | "attachment"
  | "artifact"
  | "app_file";

export interface UpsertSearchDocumentParams {
  refId: string;
  body: string;
  chatId?: string | null;
  workspaceSlug?: string | null;
  kind: SearchDocumentKind;
  createdAt?: string;
}

const SNIPPET_RADIUS = 60;

/** Tokenize a free-text query: lowercase, whitespace-split, dedupe, drop empty. */
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

/** Escape `_` and `%` so LIKE treats them as literals. */
function escapeLike(s: string): string {
  return s.replace(/[%_\\]/g, "\\$&");
}

/** Build a snippet around the first match of any of `tokens`. */
function buildSnippet(body: string, tokens: string[]): string {
  const lc = body.toLowerCase();
  let firstIdx = -1;
  let firstLen = 0;
  for (const tok of tokens) {
    const idx = lc.indexOf(tok);
    if (idx !== -1 && (firstIdx === -1 || idx < firstIdx)) {
      firstIdx = idx;
      firstLen = tok.length;
    }
  }
  if (firstIdx === -1) {
    return body.length > SNIPPET_RADIUS * 2
      ? body.slice(0, SNIPPET_RADIUS * 2) + "…"
      : body;
  }
  const start = Math.max(0, firstIdx - SNIPPET_RADIUS);
  const end = Math.min(body.length, firstIdx + firstLen + SNIPPET_RADIUS);
  let snippet = body.slice(start, end);
  if (start > 0) snippet = "…" + snippet;
  if (end < body.length) snippet = snippet + "…";
  // Highlight every occurrence of every token (case-insensitive) with <mark>.
  for (const tok of tokens) {
    snippet = snippet.replace(
      new RegExp(escapeRegex(tok), "gi"),
      (m) => `<mark>${m}</mark>`,
    );
  }
  return snippet;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Run a free-text search against the `chat_search_index` table built
 * by migration 0028. Returns the top `limit` hits ordered by match
 * score (token-occurrence count) descending, then by recency.
 *
 * The query is whitespace-tokenized; **every** token must appear in
 * the body (AND-of-tokens). This matches user intuition for short
 * multi-word queries and is the same default FTS5 would apply with
 * the `unicode61` tokenizer.
 */
export async function searchChatMessages(
  db: Pool,
  params: SearchChatMessagesParams,
): Promise<SearchChatMessagesHit[]> {
  const tokens = tokenize(params.query ?? "");
  if (tokens.length === 0) return [];
  if (params.workspaceSlugs && params.workspaceSlugs.length === 0) return [];

  const limit = params.limit ?? 25;
  const kinds = params.kinds && params.kinds.length > 0
    ? params.kinds
    : params.kind && params.kind !== "any"
      ? [params.kind]
      : params.includeTitles
        ? ["chat", "message", "summary"] satisfies SearchDocumentKind[]
        : ["message", "summary"] satisfies SearchDocumentKind[];
  const kindClause = `AND kind IN (${kinds.map(() => "?").join(", ")})`;
  const chatClause = params.chatId ? "AND chat_id = ?" : "";
  let workspaceClause = "";
  if (params.workspaceSlugs) {
    workspaceClause = `AND workspace_slug IN (${params.workspaceSlugs.map(() => "?").join(", ")})`;
  } else if (params.workspaceSlug && params.workspaceSlug !== "*") {
    workspaceClause = "AND workspace_slug = ?";
  }

  const tokenClauses = tokens.map(() => "body_lc LIKE ? ESCAPE '\\'").join(" AND ");
  const scoreExpr = tokens
    .map(() => "((length(body_lc) - length(replace(body_lc, ?, ''))) / length(?))")
    .join(" + ");

  const sqlParams: unknown[] = [];
  for (const tok of tokens) sqlParams.push(`%${escapeLike(tok)}%`);
  if (params.chatId) sqlParams.push(params.chatId);
  if (params.workspaceSlugs) {
    sqlParams.push(...params.workspaceSlugs);
  } else if (params.workspaceSlug && params.workspaceSlug !== "*") {
    sqlParams.push(params.workspaceSlug);
  }
  sqlParams.push(...kinds);
  for (const tok of tokens) sqlParams.push(tok, tok);
  sqlParams.push(limit);
  const { rows } = await db.query(
    `
    SELECT ref_id, body, body_lc, chat_id, workspace_slug, kind, created_at
    FROM chat_search_index
    WHERE ${tokenClauses}
      ${chatClause}
      ${workspaceClause}
      ${kindClause}
    ORDER BY ${scoreExpr} DESC, created_at DESC
    LIMIT ?
    `,
    sqlParams,
  );

  const hits: SearchChatMessagesHit[] = rows.map((row) => {
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
    return {
      chatId: (row.chat_id as string | null) ?? null,
      refId: row.ref_id as string,
      messageId: row.ref_id as string,
      workspaceSlug: (row.workspace_slug as string | null) ?? null,
      kind: row.kind as SearchDocumentKind,
      snippet: buildSnippet(body, tokens),
      createdAt: row.created_at as string,
      score,
    };
  });

  hits.sort((a, b) => b.score - a.score || (a.createdAt < b.createdAt ? 1 : -1));
  return hits.slice(0, limit);
}

export async function upsertSearchDocument(
  db: Pool,
  params: UpsertSearchDocumentParams,
): Promise<void> {
  await db.query(
    `INSERT OR REPLACE INTO chat_search_index
      (ref_id, body, body_lc, chat_id, workspace_slug, kind, created_at)
     VALUES (?, ?, LOWER(?), ?, ?, ?, ?)`,
    [
      params.refId,
      params.body,
      params.body,
      params.chatId ?? null,
      params.workspaceSlug ?? null,
      params.kind,
      params.createdAt ?? new Date().toISOString(),
    ],
  );
}

export async function deleteSearchDocumentsForWorkspace(
  db: Pool,
  workspaceSlug: string,
  kinds: SearchDocumentKind[],
): Promise<void> {
  if (kinds.length === 0) return;
  await db.query(
    `DELETE FROM chat_search_index
     WHERE workspace_slug = ? AND kind IN (${kinds.map(() => "?").join(", ")})`,
    [workspaceSlug, ...kinds],
  );
}
