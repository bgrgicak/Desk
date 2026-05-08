import { type Pool } from "@agent-desk/db";
import { queries } from "@agent-desk/db";
import {
  MESSAGE_KINDS,
  MESSAGE_STATES,
  ValidationError,
  type MessageKind,
  type MessageState,
} from "@agent-desk/shared";
import { requireOwnedChat, requireOwnedWorkspace } from "../auth/ownership.js";

const WORKSPACE_ID_PATTERN = /^wks_[A-Za-z0-9_-]+$/;
const CHAT_ID_PATTERN = /^cht_[A-Za-z0-9_-]+$/;
const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 50;

const CONTENT_KINDS = [
  "text",
  "toolCall",
  "toolResult",
  "artifactRef",
  "events",
  "summary",
  "summary_request",
  "reflection_request",
  "agent_turn",
] as const;

function parseCsv(raw: string): string[] {
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function parseBool(name: string, raw: string): boolean {
  if (raw === "true") return true;
  if (raw === "false") return false;
  throw new ValidationError(`Invalid ${name}: expected "true" or "false"`);
}

/**
 * Cross-chat message listing. AND-combines the query filters; ownership is
 * enforced at the DB join (w.user_id = caller) plus up-front existence
 * checks on explicit workspaceId/chatId so unknown IDs 404 rather than
 * returning an empty list.
 */
export async function listMessages(
  pool: Pool,
  userId: string,
  query: URLSearchParams,
) {
  const workspaceIdRaw = query.get("workspaceId");
  let workspaceId: string | undefined;
  if (workspaceIdRaw !== null && workspaceIdRaw !== "") {
    if (!WORKSPACE_ID_PATTERN.test(workspaceIdRaw)) {
      throw new ValidationError(`Invalid workspaceId: ${workspaceIdRaw}`);
    }
    await requireOwnedWorkspace(pool, workspaceIdRaw, userId);
    workspaceId = workspaceIdRaw;
  }

  const chatIdRaw = query.get("chatId");
  let chatId: string | undefined;
  if (chatIdRaw !== null && chatIdRaw !== "") {
    if (!CHAT_ID_PATTERN.test(chatIdRaw)) {
      throw new ValidationError(`Invalid chatId: ${chatIdRaw}`);
    }
    await requireOwnedChat(pool, chatIdRaw, userId);
    chatId = chatIdRaw;
  }

  const stateRaw = query.get("state");
  let states: MessageState[] | undefined;
  if (stateRaw !== null && stateRaw !== "") {
    const parsed = parseCsv(stateRaw);
    for (const s of parsed) {
      if (!(MESSAGE_STATES as readonly string[]).includes(s)) {
        throw new ValidationError(`Invalid state: ${s}`);
      }
    }
    states = parsed as MessageState[];
  }

  const scheduledRaw = query.get("scheduled");
  const scheduled = scheduledRaw !== null && scheduledRaw !== ""
    ? parseBool("scheduled", scheduledRaw)
    : undefined;

  const awaitingUserRaw = query.get("awaitingUser");
  const awaitingUser = awaitingUserRaw !== null && awaitingUserRaw !== ""
    ? parseBool("awaitingUser", awaitingUserRaw)
    : undefined;

  const contentKindRaw = query.get("contentKind");
  let contentKinds: string[] | undefined;
  if (contentKindRaw !== null && contentKindRaw !== "") {
    const parsed = parseCsv(contentKindRaw);
    for (const k of parsed) {
      if (!(CONTENT_KINDS as readonly string[]).includes(k)) {
        throw new ValidationError(`Invalid contentKind: ${k}`);
      }
    }
    contentKinds = parsed;
  }

  const kindRaw = query.get("kind");
  let kinds: MessageKind[] | undefined;
  if (kindRaw !== null && kindRaw !== "") {
    const parsed = parseCsv(kindRaw);
    for (const k of parsed) {
      if (!(MESSAGE_KINDS as readonly string[]).includes(k)) {
        throw new ValidationError(`Invalid kind: ${k}`);
      }
    }
    kinds = parsed as MessageKind[];
  }

  const parentIdRaw = query.get("parentId");
  let parentId: string | undefined;
  if (parentIdRaw !== null && parentIdRaw !== "") {
    // Match the message id format (msg_<nanoid>). The check rejects garbage
    // without requiring a DB round-trip; missing/unknown ids will just
    // return an empty list naturally.
    if (!/^msg_[A-Za-z0-9_-]+$/.test(parentIdRaw)) {
      throw new ValidationError(`Invalid parentId: ${parentIdRaw}`);
    }
    parentId = parentIdRaw;
  }

  const sinceRaw = query.get("since");
  let since: string | undefined;
  if (sinceRaw !== null && sinceRaw !== "") {
    const date = new Date(sinceRaw);
    if (Number.isNaN(date.getTime())) {
      throw new ValidationError(`Invalid since: ${sinceRaw}`);
    }
    since = date.toISOString();
  }

  const limitRaw = query.get("limit");
  let limit = DEFAULT_LIMIT;
  if (limitRaw !== null && limitRaw !== "") {
    const n = Number(limitRaw);
    if (!Number.isInteger(n) || n <= 0) {
      throw new ValidationError(`Invalid limit: ${limitRaw}`);
    }
    limit = Math.min(n, MAX_LIMIT);
  }

  const cursor = query.get("cursor") ?? undefined;
  if (cursor !== undefined && cursor.indexOf("|") === -1) {
    throw new ValidationError("Invalid cursor");
  }

  return queries.messages.listCrossChat(pool, {
    userId,
    workspaceId,
    chatId,
    states,
    scheduled,
    awaitingUser,
    contentKinds,
    kinds,
    parentId,
    since,
    cursor,
    limit,
  });
}
