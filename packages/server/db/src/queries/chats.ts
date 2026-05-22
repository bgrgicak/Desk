import { type Pool } from "../pool.js";
import {
  ChatSchema,
  GOAL_KEYS,
  ValidationError,
  type Chat,
  type ChatWithListMeta,
  type GoalKey,
} from "@agent-desk/shared";

function validateGoal(goal: string | null | undefined): GoalKey | null | undefined {
  if (goal === undefined) return undefined;
  if (goal === null) return null;
  if (!(GOAL_KEYS as readonly string[]).includes(goal)) {
    throw new ValidationError(`Invalid chat goal: ${goal}`);
  }
  return goal as GoalKey;
}

function rowToChat(row: Record<string, unknown>): Chat {
  // `pinned`, `running`, `failed` are populated by queries that include
  // the relevant subqueries / JOINs. Forward them when present so
  // callers see the same shape `chat.updated` events ship.
  const pinned = "is_pinned" in row ? !!row.is_pinned : undefined;
  const running = "is_running" in row ? !!row.is_running : undefined;
  const failed = "is_failed" in row ? !!row.is_failed : undefined;
  return ChatSchema.parse({
    id: row.id,
    workspaceId: row.workspace_id,
    agentId: row.agent_id,
    title: row.title,
    goal: row.goal ?? undefined,
    // Pre-migration chats backfilled created_at from updated_at
    // (see migration 0042); the column is NOT NULL going forward.
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
    // SQLite stores BOOLEAN as INTEGER 0/1; coerce at the boundary.
    unread: !!row.unread,
    ...(pinned !== undefined ? { pinned } : {}),
    ...(running !== undefined ? { running } : {}),
    ...(failed !== undefined ? { failed } : {}),
  });
}

/**
 * SQL fragment that yields 1 when the chat's most recent agent_turn
 * is `pending` or `running`, 0 otherwise. Inlined so callers can pick
 * up the live signal without depending on a denormalized column —
 * dropping the trigger removed the only place that maintained it.
 *
 * Tie-break order matches the obsolete trigger (created_at DESC,
 * rowid DESC) so a same-millisecond agent_turn retry is read as
 * newer than the failed turn it replaced.
 */
function latestAgentTurnStateMatchesSql(states: readonly string[]): string {
  const list = states.map((s) => `'${s}'`).join(", ");
  return `COALESCE((
    SELECT m.state IN (${list})
    FROM messages m
    WHERE m.chat_id = c.id
      AND json_valid(m.content)
      AND json_extract(m.content, '$.type') = 'agent_turn'
    ORDER BY m.created_at DESC, m.rowid DESC
    LIMIT 1
  ), 0)`;
}

/**
 * Server-side chat-list response row.  Same shape as
 * `ChatWithListMeta` from `@agent-desk/shared`, but with the four
 * sidebar-meta fields promoted from optional to required because the
 * server query always populates them (the shared type leaves them
 * optional so the WS `chat.updated` payload — which omits them — fits
 * the same definition).
 */
export type ChatWithLastMessage = Chat & Required<Pick<ChatWithListMeta, "kind" | "running" | "failed" | "lastMessage">>;

const LAST_MESSAGE_PREVIEW_LIMIT = 200;

/**
 * Correlated subquery that returns the *raw content JSON* of the
 * chat's most recent visible user/agent message — either a plain
 * `text` payload (user messages, and the rare direct agent text
 * insertion) or the `events` log that wraps real agent_turn output.
 * The JS layer (`previewFromContent`) extracts the human-readable
 * text from whichever shape comes back.  Internal types
 * (agent_turn, summary_request, summary, artifactRef, toolCall,
 * toolResult, reflection_request) are filtered out so the preview
 * shows what the user wrote/saw, not scheduler plumbing.
 */
function lastVisibleContentSubquerySql(): string {
  return `(
    SELECT m.content
    FROM messages m
    WHERE m.chat_id = c.id
      AND m.role IN ('user', 'agent')
      AND json_valid(m.content)
      AND json_extract(m.content, '$.type') IN ('text', 'events')
    ORDER BY m.created_at DESC, m.id DESC
    LIMIT 1
  ) AS last_content`;
}

function clampPreview(text: string): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) return "";
  return normalized.length > LAST_MESSAGE_PREVIEW_LIMIT
    ? `${normalized.slice(0, LAST_MESSAGE_PREVIEW_LIMIT - 1).trimEnd()}…`
    : normalized;
}

interface EventLogEntry {
  kind?: string;
  event?: { type?: string; part?: { text?: unknown } };
}

/**
 * Exported so the JSON-walking logic that turns a server-side
 * message row into the sidebar preview can be unit-tested directly
 * against the discriminated union without round-tripping through
 * SQLite.  Not part of the public queries surface — consumers
 * should call `listWithLatestMessage` instead.
 */
export function previewFromContent(raw: unknown): string {
  if (raw === null || raw === undefined) return "";
  let parsed: unknown = raw;
  if (typeof raw === "string") {
    try {
      parsed = JSON.parse(raw);
    } catch {
      // Pre-JSON-content rows (or corrupt rows) — best-effort plain
      // string preview.
      return clampPreview(raw);
    }
  }
  if (!parsed || typeof parsed !== "object") return "";
  const content = parsed as { type?: string; text?: unknown; log?: unknown };
  if (content.type === "text" && typeof content.text === "string") {
    return clampPreview(content.text);
  }
  if (content.type === "events" && Array.isArray(content.log)) {
    // Concatenate every visible text part from the agent's event
    // stream — same shape `runs-helpers.deriveTextFromLog` walks at
    // run-completion time, but we don't dedupe against reasoning
    // parts because that's a developer-mode concern and not worth
    // the cycles on every chat-list refresh.
    const parts: string[] = [];
    for (const entry of content.log as EventLogEntry[]) {
      if (
        entry &&
        typeof entry === "object" &&
        entry.kind === "event" &&
        entry.event?.type === "text" &&
        typeof entry.event.part?.text === "string"
      ) {
        parts.push(entry.event.part.text);
      }
    }
    return clampPreview(parts.join(""));
  }
  return "";
}

export async function listWithLatestMessage(
  db: Pool,
  workspaceId: string,
): Promise<ChatWithLastMessage[]> {
  // LEFT JOIN chat_pins so the sidebar can render pin state without a
  // second round-trip. Pinned rows return `is_pinned = 1`; everything
  // else returns NULL → coerced to 0 by the `!!` boundary in rowToChat.
  //
  // `is_running` / `is_failed` are computed live from the latest
  // agent_turn message — no denormalized column to drift.
  const { rows } = await db.query(
    `SELECT c.*,
            c.list_kind AS kind,
            ${latestAgentTurnStateMatchesSql(["pending", "running"])} AS is_running,
            ${latestAgentTurnStateMatchesSql(["failed"])} AS is_failed,
            (cp.chat_id IS NOT NULL) AS is_pinned,
            ${lastVisibleContentSubquerySql()}
      FROM chats c
      LEFT JOIN chat_pins cp
        ON cp.workspace_id = c.workspace_id AND cp.chat_id = c.id
      WHERE c.workspace_id = ?
        AND c.list_internal = 0
      ORDER BY c.updated_at DESC`,
    [workspaceId],
  );
  return rows.map((r) => ({
    ...rowToChat(r),
    kind: r.kind as ChatWithLastMessage["kind"],
    running: !!r.is_running,
    failed: !!r.is_failed,
    lastMessage: previewFromContent(r.last_content),
  }));
}

/**
 * Returns the oldest chat in a workspace whose title matches exactly,
 * or `null` if none exist. Used by `getOrCreateAskAiChat` to find the
 * single titled hub chat that backs the Home → Ask AI surface without
 * being confused by sibling internal chats (reflections, future
 * automation) that may have landed in the hub first.
 */
export async function findByWorkspaceAndTitle(
  db: Pool,
  workspaceId: string,
  title: string,
): Promise<Chat | null> {
  const { rows } = await db.query(
    `SELECT c.*,
            ${latestAgentTurnStateMatchesSql(["pending", "running"])} AS is_running,
            ${latestAgentTurnStateMatchesSql(["failed"])} AS is_failed,
            (cp.chat_id IS NOT NULL) AS is_pinned
       FROM chats c
       LEFT JOIN chat_pins cp
         ON cp.workspace_id = c.workspace_id AND cp.chat_id = c.id
      WHERE c.workspace_id = ?
        AND c.title = ?
      ORDER BY c.created_at ASC, c.id ASC
      LIMIT 1`,
    [workspaceId, title],
  );
  return rows.length ? rowToChat(rows[0]) : null;
}

export async function findById(db: Pool, id: string): Promise<Chat | null> {
  // LEFT JOIN chat_pins so the WS chat.updated payload always carries
  // the current pinned flag, plus inline subqueries for running/failed
  // so every chat.updated emit ships the live state — the client never
  // has to infer it from message-state events.
  const { rows } = await db.query(
    `SELECT c.*,
            ${latestAgentTurnStateMatchesSql(["pending", "running"])} AS is_running,
            ${latestAgentTurnStateMatchesSql(["failed"])} AS is_failed,
            (cp.chat_id IS NOT NULL) AS is_pinned
       FROM chats c
       LEFT JOIN chat_pins cp
         ON cp.workspace_id = c.workspace_id AND cp.chat_id = c.id
      WHERE c.id = ?`,
    [id],
  );
  return rows.length ? rowToChat(rows[0]) : null;
}

export async function insert(
  db: Pool,
  data: { id: string; workspaceId: string; agentId: string; title?: string; goal?: string },
): Promise<Chat> {
  const goal = validateGoal(data.goal);

  // Ensure the chat's agent is enabled in the workspace. This is the M3
  // invariant — chats can only use agents the user has explicitly added to
  // the workspace (or the workspace default).
  const { rows: checkRows } = await db.query(
    `SELECT 1
       FROM workspace_agents wa
       JOIN agents a ON a.id = wa.agent_id
      WHERE wa.workspace_id = ?
        AND wa.agent_id = ?
        AND a.enabled = 1`,
    [data.workspaceId, data.agentId],
  );
  if (checkRows.length === 0) {
    throw new ValidationError(
      `Agent ${data.agentId} is not enabled in workspace ${data.workspaceId}`,
    );
  }

  // Migration 0042 added `created_at` with an empty-string default
  // because SQLite refuses non-constant DEFAULTs in ALTER TABLE ADD
  // COLUMN. Stamp it explicitly here so new chats land with a real
  // ISO timestamp instead of an empty string. (`updated_at` keeps
  // its row-level default since that column predates the ADD COLUMN
  // restriction — it lives in the original CREATE TABLE.)
  const { rows } = await db.query(
    `INSERT INTO chats (id, workspace_id, agent_id, title, goal, created_at)
     VALUES (?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
     RETURNING *`,
    [data.id, data.workspaceId, data.agentId, data.title ?? "", goal ?? null],
  );
  return rowToChat(rows[0]);
}

export async function updateMeta(
  db: Pool,
  id: string,
  data: { title?: string; goal?: string | null; agentId?: string; unread?: boolean },
): Promise<Chat | null> {
  const goal = validateGoal(data.goal);

  if (data.agentId !== undefined) {
    // Preserve the M3 invariant enforced by insert(): a chat's agent must
    // be enabled in the chat's workspace. Look up the workspace via the
    // chat row so callers don't have to pass it.
    const { rows: chatRows } = await db.query(
      "SELECT workspace_id FROM chats WHERE id = ?",
      [id],
    );
    if (chatRows.length === 0) return null;
    const workspaceId = chatRows[0].workspace_id as string;
    const { rows: enabledRows } = await db.query(
      `SELECT 1
         FROM workspace_agents wa
         JOIN agents a ON a.id = wa.agent_id
        WHERE wa.workspace_id = ?
          AND wa.agent_id = ?
          AND a.enabled = 1`,
      [workspaceId, data.agentId],
    );
    if (enabledRows.length === 0) {
      throw new ValidationError(
        `Agent ${data.agentId} is not enabled in workspace ${workspaceId}`,
      );
    }
  }

  const sets: string[] = [];
  const params: unknown[] = [];

  if (data.title !== undefined) {
    sets.push(`title = ?`);
    params.push(data.title);
  }
  if (data.goal !== undefined) {
    sets.push(`goal = ?`);
    params.push(goal);
  }
  if (data.agentId !== undefined) {
    sets.push(`agent_id = ?`);
    params.push(data.agentId);
    // Atomically forget the opencode-serve session whenever the chat's
    // agent changes. The session was bound to the old agent's
    // providerID/modelID at creation time; opencode-serve ignores per-
    // sendMessage overrides for those fields, so reusing the session
    // would silently keep using the old model. Doing this in the same
    // UPDATE removes the race where a concurrent run could read the
    // new agent_id but still see the old session_id.
    sets.push(`opencode_session_id = NULL`);
  }
  if (data.unread !== undefined) {
    sets.push(`unread = ?`);
    params.push(data.unread ? 1 : 0);
  }

  sets.push(`updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`);

  params.push(id);
  const { rows } = await db.query(
    `UPDATE chats SET ${sets.join(", ")} WHERE id = ? RETURNING *`,
    params,
  );
  return rows.length ? rowToChat(rows[0]) : null;
}

export async function markRead(db: Pool, id: string): Promise<Chat | null> {
  // Use RETURNING * so the caller gets an atomic snapshot of the chat row
  // immediately after clearing unread — no window for a concurrent
  // messages.insert to set unread=1 between the UPDATE and a separate SELECT.
  const { rows } = await db.query(
    "UPDATE chats SET unread = 0 WHERE id = ? RETURNING *",
    [id],
  );
  return rows.length ? rowToChat(rows[0]) : null;
}

/**
 * Returns the opencode-serve session id bound to this chat, if any.
 * Each chat owns at most one session that turns are appended to. A null
 * return means the chat hasn't had its first turn yet under the new
 * runtime — the driver will create one and persist it via
 * `setOpencodeSessionId`.
 */
export async function getOpencodeSessionId(
  db: Pool,
  id: string,
): Promise<string | null> {
  const { rows } = await db.query(
    "SELECT opencode_session_id FROM chats WHERE id = ?",
    [id],
  );
  if (rows.length === 0) return null;
  const value = rows[0].opencode_session_id;
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * Writes (or clears) the opencode-serve session bound to a chat. We
 * intentionally don't bump `updated_at` here — this is internal runtime
 * metadata, not a user-visible event, and bumping the chat would shuffle
 * the chat-list ordering on every turn.
 */
export async function setOpencodeSessionId(
  db: Pool,
  id: string,
  sessionId: string | null,
): Promise<void> {
  await db.query(
    "UPDATE chats SET opencode_session_id = ? WHERE id = ?",
    [sessionId, id],
  );
}

/**
 * Clear the opencode-serve session id from every chat using a given agent.
 * Used when the agent's model changes — the existing daemon session is
 * bound to the prior model and won't honor the new one on subsequent
 * turns. Forgetting the id makes the next turn create a fresh session
 * with the current agent.model bound from the start.
 *
 * Returns the chat ids whose session was cleared so callers can
 * best-effort delete them on the daemon side too.
 */
export async function clearOpencodeSessionsForAgent(
  db: Pool,
  agentId: string,
): Promise<Array<{ chatId: string; previousSessionId: string }>> {
  const { rows } = await db.query<{ id: string; opencode_session_id: string | null }>(
    "SELECT id, opencode_session_id FROM chats WHERE agent_id = ? AND opencode_session_id IS NOT NULL",
    [agentId],
  );
  const cleared: Array<{ chatId: string; previousSessionId: string }> = [];
  for (const row of rows) {
    if (typeof row.opencode_session_id !== "string" || row.opencode_session_id.length === 0) continue;
    cleared.push({ chatId: row.id, previousSessionId: row.opencode_session_id });
  }
  if (cleared.length > 0) {
    await db.query(
      "UPDATE chats SET opencode_session_id = NULL WHERE agent_id = ?",
      [agentId],
    );
  }
  return cleared;
}

/**
 * Clear opencode-serve session ids for every chat owned by the user
 * (optionally scoped to a single workspace). Used when a user-level
 * connector or local source changes — the affected chats' sessions may
 * still be bound to the old auth/provider, so we forget the ids and let
 * the next turn create a fresh session against whatever is configured now.
 *
 * Returns the chat ids whose session was cleared.
 */
export async function clearOpencodeSessionsForUser(
  db: Pool,
  userId: string,
  workspaceId?: string,
): Promise<Array<{ chatId: string; previousSessionId: string }>> {
  const baseSelect = `SELECT c.id, c.opencode_session_id
       FROM chats c
       JOIN workspaces w ON w.id = c.workspace_id
      WHERE w.user_id = ?
        AND c.opencode_session_id IS NOT NULL`;
  const params: unknown[] = [userId];
  let sql = baseSelect;
  if (workspaceId) {
    sql += " AND c.workspace_id = ?";
    params.push(workspaceId);
  }
  const { rows } = await db.query<{ id: string; opencode_session_id: string | null }>(sql, params);
  const cleared: Array<{ chatId: string; previousSessionId: string }> = [];
  for (const row of rows) {
    if (typeof row.opencode_session_id !== "string" || row.opencode_session_id.length === 0) continue;
    cleared.push({ chatId: row.id, previousSessionId: row.opencode_session_id });
  }
  if (cleared.length > 0) {
    const updateSql = workspaceId
      ? `UPDATE chats SET opencode_session_id = NULL
          WHERE id IN (SELECT c.id FROM chats c
                        JOIN workspaces w ON w.id = c.workspace_id
                       WHERE w.user_id = ? AND c.workspace_id = ?)`
      : `UPDATE chats SET opencode_session_id = NULL
          WHERE id IN (SELECT c.id FROM chats c
                        JOIN workspaces w ON w.id = c.workspace_id
                       WHERE w.user_id = ?)`;
    const updateParams = workspaceId ? [userId, workspaceId] : [userId];
    await db.query(updateSql, updateParams);
  }
  return cleared;
}
