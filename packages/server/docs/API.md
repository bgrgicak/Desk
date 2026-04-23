# API Documentation

All endpoints require Bearer token authentication unless noted otherwise.
The full OpenAPI 3.1.0 spec is served at `GET /openapi.json`.

### Multi-user scoping

Every route that resolves a workspace, agent, chat, or message id verifies
that the record is owned by the authenticated user. Cross-tenant access
returns `404 Not Found` (not `403`) so existence of a peer's resource is
not leaked. `GET /workspaces` returns only the caller's workspaces;
`POST /chats` validates that both `workspaceId` and `agentId` belong to the
caller.

## Auth

| Method | Path           | Auth | Description       |
|--------|----------------|------|-------------------|
| POST   | /auth/login    | No   | Log in            |
| POST   | /auth/logout   | Yes  | Log out           |

## Account

| Method | Path          | Description              |
|--------|---------------|--------------------------|
| GET    | /me           | Get current user         |
| PATCH  | /me           | Update current user      |
| DELETE | /me           | Soft-delete account      |
| POST   | /me/password  | Change password          |
| GET    | /me/providers | Get AI provider keys (masked) |
| PUT    | /me/providers | Set / update / delete AI provider keys |

## Workspaces

| Method | Path                                 | Description                          |
|--------|--------------------------------------|--------------------------------------|
| GET    | /workspaces                          | List workspaces                      |
| POST   | /workspaces                          | Create workspace                     |
| GET    | /workspaces/{id}                     | Get workspace                        |
| PATCH  | /workspaces/{id}                     | Update workspace                     |
| DELETE | /workspaces/{id}                     | Delete workspace                     |
| GET    | /workspaces/{id}/agents              | List agents enrolled in workspace    |
| POST   | /workspaces/{id}/agents              | Enroll an agent in the workspace     |
| DELETE | /workspaces/{id}/agents/{agentId}    | Remove an agent from the workspace   |
| POST   | /workspaces/{id}/default-agent       | Set the workspace default agent      |

### POST /workspaces

Create a new workspace owned by the authenticated user.

**Request body:**

```json
{
  "name": "My workspace",
  "description": "Optional description",
  "icon": "optional-icon"
}
```

Only `name` is required. `description` and `icon` default to empty strings.

**Response:** `201 Created` with the full workspace object.

## Agents

| Method | Path          | Description                    |
|--------|---------------|--------------------------------|
| GET    | /agents       | List the current user's agents |
| POST   | /agents       | Create a new agent             |
| GET    | /agents/{id}  | Get agent                      |
| PATCH  | /agents/{id}  | Update agent                   |

Agents are user-owned. A chat can only reference an agent that has been
enrolled in its workspace (via `POST /workspaces/{id}/agents`). Each
workspace has exactly one default agent; creating a chat without an
explicit `agentId` uses the workspace default.

## Chats

| Method | Path                      | Description               |
|--------|---------------------------|---------------------------|
| GET    | /chats?workspaceId=       | List chats (filtered by workspace; defaults to caller's first workspace) |
| POST   | /chats                    | Create chat               |
| GET    | /chats/{id}               | Get chat                  |
| PATCH  | /chats/{id}               | Update chat               |
| DELETE | /chats/{id}               | Soft-delete chat (cascades messages, cancels schedules, trashes on-disk dirs, emits `chat.deleted` WS) |
| GET    | /chats/{id}/messages                    | List messages             |
| POST   | /chats/{id}/messages                    | Send message              |
| PATCH  | /chats/{id}/messages/{messageId}        | Edit message content, cancel, reschedule |
| DELETE | /chats/{id}/messages/{messageId}        | Delete message (cancels scheduled firing) |
| GET    | /chats/{id}/messages/{messageId}/logs   | Stream execution log file |
| GET    | /chats/{id}/messages/{messageId}/note-history | List archived versions of a note-content message |
| GET    | /chats/{id}/artifacts                   | List chat artifacts       |
| POST   | /chats/{id}/artifacts                   | Upload artifact to chat (multipart/form-data) |

### GET /chats

Lists chats in one of the caller's workspaces.

**Query parameters:**

- `workspaceId` (optional) — `wks_*` id of a workspace the caller owns. Returns 404 on non-owned ids and 400 on malformed ids. When omitted, defaults to the caller's first workspace (chronological order) for backwards compatibility; returns `[]` when the caller has no workspaces.

### DELETE /chats/{id}

Soft-deletes a chat. In order:

1. Cancels any scheduler refs on pending/recurring messages in the chat (same helper used by `DELETE /chats/{id}/messages/{messageId}`).
2. Drops the chat row from Postgres; `ON DELETE CASCADE` removes its messages.
3. Moves both on-disk subtrees `~/Desk/.chats/{chatId}/` and `~/Desk/workspaces/*/chats/{chatId}/` to `~/Desk/.trash/{chatId}-{timestamp}/` (not `rm -rf`).
4. Broadcasts `chat.deleted` with `{chatId, workspaceId}` over WS to the chat's workspace room.

Returns `{ ok: true }`. Subsequent DELETE returns 404. Cross-tenant DELETE returns 404, never 403.

### POST /chats/{id}/artifacts

Accepts `multipart/form-data` with a single part named `file`. The part's
filename and `Content-Type` become the artifact's name and MIME. Returns
`201 Created` with the file record.

### Message content types

Messages carry one of:

- `{ type: "text", text }` — plain conversation
- `{ type: "toolCall", toolName, args }` / `{ type: "toolResult", ... }` — sandbox tool use
- `{ type: "events", events: [...] }` — captured opencode event stream
- `{ type: "artifactRef", path, name?, mime? }` — workspace-relative file reference
- `{ type: "note", body }` — a running AI-generated summary of the chat; rendered specially in the UI, editable via PATCH
- `{ type: "ai_note_request" }` — a scheduled system message that triggers a note refresh when fired
- `{ type: "agent_turn", userMessageId }` — pending execution slot attached to a user message. Carries no textual copy of the prompt; `fireMessage` resolves `userMessageId` to build the prompt at fire time. Hidden from the visible chat timeline.

### Message execution metadata

Messages grow optional execution fields (added M6a):

| Column | When present | Meaning |
|---|---|---|
| `executeAt` | scheduled messages | timestamp at which the at-daemon curls `/internal/messages/fire` |
| `cron` | recurring messages | cron expression; the parent stays `pending` forever, each firing creates a child |
| `state` | executing messages | `pending` / `running` / `succeeded` / `failed` / `cancelled` |
| `parentId` | output/sub-messages | the message that produced this one (execution lineage) |
| `agentId` | agent outputs | which agent produced it |
| `schedulerRef` | scheduled messages | `{ kind: 'at'|'cron', id }` — the at/cron entry this message owns |
| `startedAt` / `endedAt` | running/completed | execution timing |

### PATCH /chats/{id}/messages/{messageId}

Partial update. Body can include:

- `content` — replace the message content (e.g. user edits a note)
- `state` — only `cancelled` or `pending` allowed; arbitrary transitions are rejected
- `executeAt` / `cron` — reschedule; pass `null` to clear

Emits `message.updated` over WS.

### DELETE /chats/{id}/messages/{messageId}

Deletes the message and, if a `schedulerRef` is set, cancels the at/cron
entry. Moves the execution log file to `~/Desk/.trash/` if present.

### GET /chats/{id}/messages/{messageId}/logs

Streams the execution log file (stdout/stderr) for a running or completed
message. Served directly from
`~/Desk/workspaces/desk/.chats/{chatId}/logs/{messageId}.log`. Returns
404 when no log has been produced.

### GET /chats/{id}/messages/{messageId}/note-history

Returns every archived version of a `note`-content message, newest first.
Response shape: `{ versions: [{ timestamp, body }, ...] }`. Snapshots are
written automatically when a note is PATCH-edited or when `fireMessage`
replaces it during an AI rewrite; files live under
`~/Desk/workspaces/desk/.chats/{chatId}/note-history/`. Empty array when
nothing has been snapshotted yet.

### Internal: POST /internal/messages/fire

Loopback-only (127.0.0.1) + shared-secret. Fires a pending scheduled
message by id. Called by `at`/`cron` via curl; not intended for user
clients.

### POST /me/password

Accepts `{ currentPassword, newPassword }`. Returns `401 Unauthorized`
if `currentPassword` does not match.

### GET /me/providers

Returns every known AI provider key name with its value either masked
(first 6 + last 4 characters) or `null` when unset. Keys are encrypted
at rest in the `user_settings` table using AES-256-GCM; the encryption
key lives on disk at `DESK_SECRET_KEY_PATH` (default
`/var/lib/desk/secret.key`).

### PUT /me/providers

Partial update. Body is `{ providers: { NAME: VALUE | null, ... } }`. A
`null` value deletes the named key; any string value sets it. Names not
present in the body are left untouched. Unknown names return 400.

The set of known names is `PROVIDER_KEY_VARS` in `@desk/shared`. In
dev, values seed from `/desk/.env` once per user (gated by `DESK_DEV=1`);
in prod, the UI is the only way to populate them.

## Library

| Method | Path                           | Description                                     |
|--------|--------------------------------|-------------------------------------------------|
| GET    | /library?workspaceId=&cursor=&limit= | List library files in the given workspace  |
| POST   | /library?workspaceId=          | Upload to library (multipart/form-data)         |
| DELETE | /library?path=&workspaceId=    | Move a library file to `~/Desk/.trash/`         |
| GET    | /library/meta?path=&workspaceId=     | Stat a library file                       |
| GET    | /library/download?path=&workspaceId= | Stream a library file                     |

Files are partitioned by workspace on disk at
`~/Desk/workspaces/*/library/{workspaceId}/`. There is no DB index;
listing walks the directory. File identifiers are workspace-relative
paths inside that subtree (`foo.pdf`, `notes/bar.md`). The `path` query
parameter is url-encoded.

### Workspace scoping

All five routes accept `workspaceId=<wks_*>`:

- Present → restricts the operation to that workspace. Returns 404 on non-owned ids (existence-hiding, same as every other resource), 400 on malformed ids.
- Absent → defaults to the caller's first workspace for backwards compatibility. Returns `[]` / 404 as appropriate if the caller has no workspaces.
- `path` is interpreted relative to the resolved workspace subtree. Attempts to traverse outside that subtree (`..`, absolute paths, etc.) return 404.

## Messages (cross-chat)

| Method | Path      | Description                                 |
|--------|-----------|---------------------------------------------|
| GET    | /messages | Read-only cross-chat list with server-side filters |

### GET /messages

Lists messages across all of the caller's chats with AND-combined filters. Read-only; per-chat CRUD stays on `/chats/{id}/messages`. Ownership is enforced by SQL join on `chats → workspaces.user_id`; users can only ever see messages from chats they own.

**Query parameters (all optional, all AND-combined):**

| Param | Shape | Meaning |
|---|---|---|
| `workspaceId` | `wks_*` | Restrict to chats in this workspace. Absent = all of the caller's workspaces. |
| `chatId` | `chat_*` | Restrict to a single chat. |
| `state` | one of `pending\|running\|succeeded\|failed\|cancelled`, or comma-separated list | Filter by `Message.state`. |
| `scheduled` | `true\|false` | `true` = only rows with `executeAt IS NOT NULL OR cron IS NOT NULL`. `false` = only unscheduled. |
| `awaitingUser` | `true\|false` | Matches messages in chats whose `awaitingUser` flag is set. |
| `contentKind` | one of the `Message.content` discriminants (comma-separated list accepted) | `text\|toolCall\|toolResult\|artifactRef\|events\|note\|ai_note_request\|agent_turn` |
| `since` | ISO-8601 timestamp | `createdAt > since` (reconnect catchup). |
| `cursor` | opaque string | Same shape as `GET /chats/{id}/messages?cursor=`. |
| `limit` | integer, default 50, max 200 | Page size. |

Returns `{ items: Message[], nextCursor?: string }` — identical shape to `GET /chats/{id}/messages`. Ordering is `createdAt DESC, id DESC`.

Malformed params → 400. Non-owned `workspaceId` / `chatId` → 404.

**Use cases:**

- Runs "Upcoming": `?scheduled=true&state=pending`
- Runs "Active": `?state=running`
- Runs "Completed / Cancelled / Failed": `?scheduled=true&state=succeeded,failed,cancelled`
- Today / Inbox "Due now": `?awaitingUser=true`
- Artifact badges: `?contentKind=artifactRef&since=…`

## Runs and scheduled jobs

Removed in M6. Execution state and scheduling both live on the
`messages` table now:

- A run is a `role=system`, `state=pending`-then-`running`-then-terminal
  message carrying the prompt as its `content.text`. Its agent output
  is a child message (`role=agent`, `parentId` set).
- A scheduled job is the same shape with `executeAt` and/or `cron` set
  and a `schedulerRef` pointing at the at/cron entry. See PATCH on
  `/chats/{id}/messages/{messageId}` to reschedule or cancel.
- Logs are a file at
  `~/Desk/workspaces/desk/.chats/{chatId}/logs/{messageId}.log`, served
  by `GET /chats/{id}/messages/{messageId}/logs`.

## Tools

| Method | Path           | Description                                                |
|--------|----------------|------------------------------------------------------------|
| GET    | /tools/models  | List AI models that are ready to use (authenticated providers) |

### GET /tools/models

Returns AI models that are ready to use — every entry is a provider opencode
has authenticated inside the sandbox via a host-forwarded API key. Models are
server-wide (governed by the keys in `/etc/desk-server/env`), not agent-scoped.

Foundation of host-initiated sandboxed tool calling described in
[ARCHITECTURE.md §7](./ARCHITECTURE.md). Internally this execs `opencode models`
in a warm sandbox because opencode is the source of truth for what's
authenticated.

**Query parameters:**

- `provider` (optional) — restrict to a single provider, e.g. `anthropic`

**Response:** bare array, matching `/workspaces`, `/agents`, `/runs`.

```json
[
  { "id": "anthropic/claude-opus-4-7", "provider": "anthropic" }
]
```

`id` is opencode's canonical model id — pass it straight to `opencode run --model`.
`provider` is denormalised so UIs can group or filter without splitting the id.

## Search

| Method | Path     | Description                                 |
|--------|----------|---------------------------------------------|
| GET    | /search  | Search across artifacts, chats, and library |

## WebSocket

| Path | Description                                             |
|------|---------------------------------------------------------|
| /ws  | Upgrade to WebSocket. Authenticate via `?token=` query. |

Broadcast events (server → client):

- `chat.updated` — `Chat` object
- `chat.deleted` — `{ chatId, workspaceId }` (emitted by `DELETE /chats/{id}`)
- `message.appended` — `Message`
- `message.updated` — `Message`
- `message.streaming` — `{ chatId, messageId, delta }` (incremental assistant text)
- `message.log_appended` — `{ messageId, kind: 'stdout'|'stderr'|'event', line }`
- `artifact.created` — `FileRef`
- `library.changed` — `{ workspaceId, path, op: 'added'|'removed'|'updated'|'moved' }`

## Other

| Method | Path           | Auth | Description         |
|--------|----------------|------|---------------------|
| GET    | /              | No   | Health check        |
| GET    | /openapi.json  | No   | OpenAPI 3.1.0 spec  |
