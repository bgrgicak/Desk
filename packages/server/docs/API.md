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
| GET    | /me/providers/local | List host-detected local sources (Codex, future LM Studio / Ollama) |
| PUT    | /me/providers/local/{kind} | Toggle a local source's per-user opt-in |

## Workspaces

| Method | Path                                 | Description                          |
|--------|--------------------------------------|--------------------------------------|
| GET    | /workspaces                          | List workspaces                      |
| POST   | /workspaces                          | Create workspace                     |
| GET    | /workspaces/{id}                     | Get workspace                        |
| PATCH  | /workspaces/{id}                     | Update workspace                     |
| DELETE | /workspaces/{id}                     | Delete workspace                     |
| GET    | /workspaces/{id}/agents              | List active models available in workspace |
| POST   | /workspaces/{id}/agents              | Enroll a model in the workspace      |
| DELETE | /workspaces/{id}/agents/{agentId}    | Remove a model from the workspace    |

### POST /workspaces

Create a new workspace owned by the authenticated user.

**Request body:**

```json
{
  "name": "My workspace",
  "description": "Optional description",
  "icon": "optional-icon",
  "color": "#fce7f3"
}
```

Only `name` is required. `description`, `icon`, and `color` default to empty
strings. `color` is a freeform hex string the UI uses as the workspace tab
background; when empty the client falls back to a palette hash of the id.
`PATCH /workspaces/{id}` accepts the same fields.

**Response:** `201 Created` with the full workspace object.

## Agents

| Method | Path            | Description                         |
|--------|-----------------|-------------------------------------|
| GET    | /agents         | List the current user's models      |
| POST   | /agents         | Create a new model                  |
| PUT    | /agents/order   | Replace the global model order      |
| GET    | /agents/{id}    | Get model                           |
| PATCH  | /agents/{id}    | Update name, model id, or active flag |

Agents/models are user-owned and ordered globally. The first active model is
the default for new workspaces/chats; subsequent active models are forwarded to
the runtime as fallbacks. `PATCH /agents/{id}` accepts `{ enabled: boolean }`.
`PUT /agents/order` accepts `{ ids: string[] }` and the array must include each
of the user's model ids exactly once.

## Chats

| Method | Path                      | Description               |
|--------|---------------------------|---------------------------|
| GET    | /chats?workspaceId=       | List chats (filtered by workspace; defaults to caller's first workspace) |
| POST   | /chats                    | Create chat               |
| GET    | /chats/{id}               | Get chat                  |
| PATCH  | /chats/{id}               | Update chat               |
| DELETE | /chats/{id}               | Soft-delete chat (cascades messages, cancels schedules, trashes on-disk dirs, emits `chat.deleted` WS) |
| GET    | /chats/{id}/messages                    | List messages (scrollback-ready) |
| POST   | /chats/{id}/messages                    | Send message              |
| PATCH  | /chats/{id}/messages/{messageId}        | Edit message content, cancel, reschedule |
| DELETE | /chats/{id}/messages/{messageId}        | Delete message (cancels scheduled firing) |
| GET    | /chats/{id}/messages/{messageId}/logs   | Stream execution log file |
| GET    | /chats/{id}/messages/{messageId}/summary-history | List archived versions of a summary-content message |
| GET    | /chats/{id}/artifacts                   | List chat artifacts       |
| POST   | /chats/{id}/artifacts                   | Upload artifact to chat (multipart/form-data) |

### GET /chats

Lists chats in one of the caller's workspaces.

Each chat may include a persisted `goal` (`app`, `document`, `image`, `data`,
`site`, `run`, `task`, or `scheduled`). Explicit composer selections and clear
message-text inference both write to `chats.goal`; clients should use that one
field for goal icons and goal filters.

**Query parameters:**

- `workspaceId` (optional) — `wks_*` id of a workspace the caller owns. Returns 404 on non-owned ids and 400 on malformed ids. When omitted, defaults to the caller's first workspace (chronological order) for backwards compatibility; returns `[]` when the caller has no workspaces.

### PATCH /chats/{id}

Updates chat metadata. Body can include `{ title?: string, agentId?: string,
goal?: string | null }`; pass `goal: null` to clear the persisted chat goal.

### DELETE /chats/{id}

Soft-deletes a chat. In order:

1. Cancels any scheduler refs on pending/recurring messages in the chat (same helper used by `DELETE /chats/{id}/messages/{messageId}`).
2. Drops the chat row from SQLite; `ON DELETE CASCADE` removes its messages.
3. Moves the chat's on-disk subtree `~/Desk/desk/.chats/{chatId}/` to `~/Desk/.trash/{chatId}-{timestamp}/` (not `rm -rf`).
4. Broadcasts `chat.deleted` with `{chatId, workspaceId}` over WS to the chat's workspace room.

Returns `{ ok: true }`. Subsequent DELETE returns 404. Cross-tenant DELETE returns 404, never 403.

### POST /chats/{id}/artifacts

Accepts `multipart/form-data` with a single part named `file`. The part's
filename and `Content-Type` become the artifact's name and MIME. Returns
`201 Created` with the file record.

### POST /chats/{id}/library-refs

Pins an existing workspace-library file into the chat's "In this chat"
sidebar by symlinking it under `.chats/{chatId}/attachments/`. Body:
`{ path: string }` (workspace-root-relative path of the library file).
The library file itself is not copied or moved. Idempotent — pinning
the same target twice returns the same FileRef. Returns `201 Created`
with the symlink's FileRef. Returns `404` for an unknown library path,
`400` if `path` already lives inside the chat's own attachments
directory.

### Message content types

Messages carry one of:

- `{ type: "text", text }` — plain conversation
- `{ type: "toolCall", toolName, args }` / `{ type: "toolResult", ... }` — sandbox tool use
- `{ type: "events", events: [...] }` — captured opencode event stream
- `{ type: "artifactRef", path, name?, mime? }` — workspace-relative file reference
- `{ type: "summary", body }` — a running AI-generated summary of the chat; hidden unless developer mode is enabled, editable via PATCH
- `{ type: "summary_request" }` — a scheduled system message that triggers a summary refresh when fired
- `{ type: "agent_turn", userMessageId }` — pending execution slot attached to a user message. Carries no textual copy of the prompt; `fireMessage` resolves `userMessageId` to build the prompt at fire time. Hidden from the visible chat timeline.

### Message execution metadata

Messages grow optional execution fields (added M6a):

| Column | When present | Meaning |
|---|---|---|
| `executeAt` | scheduled messages | timestamp at which the at-daemon curls `/internal/messages/fire` |
| `cron` | recurring messages | cron expression; the parent stays `pending` forever, each firing creates a child |
| `state` | executing messages | `pending` / `running` / `succeeded` / `failed` / `cancelled` / `paused` |
| `parentId` | output/sub-messages | the message that produced this one (execution lineage) |
| `agentId` | agent outputs | which agent produced it |
| `schedulerRef` | scheduled messages | `{ kind: 'at'|'cron', id }` — the at/cron entry this message owns |
| `startedAt` / `endedAt` | running/completed | execution timing |
| `attachments` | user messages with uploads | array of `{ path, name, mime?, size? }` — files or directories the user attached to *this* message; paths are workspace-root-relative (chat-owned uploads land under `.chats/{chatId}/attachments/`, library mentions point straight at the library item or folder) and are forwarded to opencode as `--file` flags when the trigger fires |
| `model` | agent outputs | model id that produced the row, stamped at insert time; historical rows keep their original model even if the agent is later reconfigured |

### POST /chats/{id}/messages

Body: `{ content: string, attachments?: AttachmentRef[], goal?: string | null }`. Each
`AttachmentRef` is a workspace-relative `path` that resolves to either a
file or a directory — chat uploads (`POST /chats/{id}/attachments`),
library files, and library folders all share the same wire shape. The
server persists them on the user message envelope and `fireMessage`
forwards each path to opencode via a `--file` flag (opencode accepts
both files and directories), so the agent sees the contents of every
attached path when the trigger fires.

When `goal` is a string, it is persisted to `chats.goal`. When `goal` is `null`,
the chat goal is cleared for that send. When omitted and the chat does not
already have a goal, the server infers a goal from clear message text and
persists that instead.

### PATCH /chats/{id}/messages/{messageId}

Partial update. Body can include:

- `content` — replace the message content (e.g. user edits a summary)
- `state` — only `cancelled` or `pending` allowed; arbitrary transitions are rejected
- `executeAt` / `cron` — reschedule; pass `null` to clear

Emits `message.updated` over WS.

### GET /chats/{id}/messages

Lists messages in a chat with cursor-based pagination, supporting both
forward and backward (scrollback) directions.

**Query parameters:**

| Param    | Type   | Description |
|----------|--------|-------------|
| `cursor` | string | Page forward: return messages after this cursor (chronological). |
| `before` | string | Page backward (scrollback): return messages older than this cursor. |
| `limit` | number | Page size, clamped to 200. Defaults to 50. |
| `view` | `full` \| `compact` \| `timeline` | `compact` strips hidden tool/event payloads while keeping normal chat text; `timeline` also drops old rows that cannot render in the normal chat stream while preserving typing/error/tool-only fallback markers; `full` returns stored message content for developer/debug views. Defaults to `full`. |

When neither `cursor` nor `before` is given, returns the **newest** 50
messages so the chat opens at the bottom. The response includes
`prevCursor` when older messages exist — pass it as `?before=` to load
the next older page.

**Response:** `{ items: Message[], nextCursor?: string, prevCursor?: string }`

Items are always returned in chronological (ASC) order regardless of
pagination direction.

### DELETE /chats/{id}/messages/{messageId}

Deletes the message and, if a `schedulerRef` is set, cancels the at/cron
entry. Moves the execution log file to `~/Desk/.trash/` if present.

### GET /chats/{id}/messages/{messageId}/logs

Streams the execution log file (stdout/stderr) for a running or completed
message. Served directly from
`~/Desk/desk/.chats/{chatId}/logs/{messageId}.log`. Returns
404 when no log has been produced.

### GET /chats/{id}/messages/{messageId}/summary-history

Returns every archived version of a `summary`-content message, newest first.
Response shape: `{ versions: [{ timestamp, body }, ...] }`. Snapshots are
written automatically when a summary is PATCH-edited or when `fireMessage`
replaces it during an AI rewrite; files live under
`~/Desk/desk/.chats/{chatId}/notes/.history/`. The endpoint also
reads legacy `.chats/{chatId}/note-history/` and
`.chats/{chatId}/summary-history/` snapshots for compatibility. Empty array
when nothing has been snapshotted yet.

### Internal: POST /internal/messages/fire

Loopback-only (127.0.0.1) + shared-secret. Fires a pending scheduled
message by id. Called by `at`/`cron` via curl; not intended for user
clients.

### Sandbox: POST /sandbox/artifacts

Sandbox-token only (`X-Desk-Sandbox-Token`). Called by
`desk-agent chat attach-artifact` from inside an agent run after the agent
writes a file. Body is `{ chatId, path, name?, mime? }`, where `path` is a
workspace-relative path to an existing file, usually
`.chats/{chatId}/artifacts/{file}`. Inserts an agent message with
`content: { type: "artifactRef", path, name?, mime? }` and emits
`message.appended`. Tokens minted for internal summary refresh runs are
rejected so summaries cannot surface files as artifacts.

### POST /me/password

Accepts `{ currentPassword, newPassword }`. Returns `401 Unauthorized`
if `currentPassword` does not match.

### GET /me/providers

Returns every known connection credential name with its value either masked
(first 6 + last 4 characters) or `null` when unset. Keys live in the user's
KDBX vault, not in SQLite. The current known set
includes AI provider API keys and sandbox tool tokens such as `GITHUB_TOKEN`.

### PUT /me/providers

Partial update. Body is `{ providers: { NAME: VALUE | null, ... } }`. A
`null` value deletes the named key; any string value sets it. Names not
present in the body are left untouched. Unknown names return 400.

The set of known names is `CONNECTION_ENV_VARS` in `@agent-desk/shared`. In
dev, model-provider values seed from the repo's `.env` once per user (gated by
`DESK_DEV=1`); in prod, the UI is the only way to populate them. Model
provider keys are global user settings. Non-model sandbox credentials such as
`GITHUB_TOKEN` are only forwarded to a workspace when that workspace has a
`workspace_connector_grants` row for the saved connection. A granted
`GITHUB_TOKEN` is forwarded into sandboxes as `GITHUB_TOKEN`/`GH_TOKEN`, and
OpenCode runs prepare non-interactive HTTPS git auth via `GIT_ASKPASS`.
For GitHub, Workspace Settings → Connections currently guides users to create a
classic personal access token with the `repo` scope, plus `workflow` when agents
should edit GitHub Actions workflow files.

### GET /me/providers/local

Lists every host-detected local model source — providers Desk auto-detects
on the user's host machine and bridges into the sandbox via env vars rather
than API keys. The first such source is **Codex** (the ChatGPT-subscription
auth blob the Codex CLI stores at `~/.codex/auth.json`); LM Studio and
Ollama can register the same way later without changing the wire shape.

Response: `{ sources: Array<{ kind, available, enabled, reason?, detail? }> }`.

- `available` — a usable instance is currently detected on the host.
- `enabled` — the user has opted in (persisted in `provider_meta[<kind>]`).
- `reason` — populated when `available=false` (`missing`, `wrong_mode`,
  `no_tokens`, `expired_no_refresh`, …).
- `detail` — display-only metadata (Codex surfaces `email`, `plan`,
  `expiresAt`). Never includes credential material.

### PUT /me/providers/local/{kind}

Body `{ enabled: boolean }`. Toggles the user's opt-in for the given
local source. When opted in, the runtime calls each source's `loadEnv()`
on every sandbox spawn / exec and forwards the resulting env vars (e.g.
`OPENCODE_AUTH_CONTENT` for Codex). Returns the updated source state.

`404` for unknown kinds; `400` for missing/non-boolean `enabled`.

## Library

| Method | Path                           | Description                                     |
|--------|--------------------------------|-------------------------------------------------|
| GET    | /library?workspaceId=&path=    | List the immediate children of one folder (root by default) |
| GET    | /library?workspaceId=&pinned=true | List every pinned entry workspace-wide       |
| GET    | /library/folders?workspaceId=  | Folders-only recursive tree (no file metadata)  |
| GET    | /library/search?workspaceId=&q= | Capped (200) recursive name search             |
| POST   | /library?workspaceId=          | Upload to library (multipart/form-data)         |
| PUT    | /library/content?path=&workspaceId=  | Save content to a file (upsert — creates if missing) |
| POST   | /library/link?workspaceId=     | Save a URL as a host-native shortcut file       |
| DELETE | /library?path=&workspaceId=    | Move a library file to `~/Desk/.trash/`         |
| GET    | /library/meta?path=&workspaceId=     | Stat a library file                       |
| GET    | /library/content?path=&workspaceId=  | Stream a library file inline (for preview)      |
| GET    | /library/download?path=&workspaceId= | Stream a library file (for download)            |

Library files live flat at the workspace root on disk
(`~/Desk/desk/`). There is no DB index; the list endpoint reads one
directory at a time (no recursion) and skips dot-prefixed entries
(`.chats/`, `.memory/`, etc.) unless `showHidden=true` is set. Use
`/library/folders` when you need the full folder tree (move-picker,
breadcrumb) and `/library/search` for name matching across the
workspace — these are the only endpoints that walk recursively. Hidden
(dot-prefixed) files are otherwise identical to regular files — all
CRUD operations work the same way. File identifiers are
workspace-root-relative paths (`foo.pdf`, `notes/bar.md`,
`.memory/workspace.md`). The `path` query parameter is url-encoded.

Workspace-granted local-filesystem mounts surface as top-level folder
entries on the root listing (e.g. `Downloads`); drilling into them
resolves through to the host directory transparently. Active local
filesystem connection rows without a grant are hidden from that
workspace.

### Links (`POST /library/link`)

Body: `{ url: string, name?: string, subpath?: string }`. The URL must
be `http(s)`. The on-disk format is chosen for the host OS so the file
is openable directly from the user's file manager:

- macOS → `.webloc` (Apple plist XML)
- Windows → `.url` (INI: `[InternetShortcut]` + `URL=`)
- Linux + others → `.desktop` with `Type=Link`

Listings tag these extensions with mime `text/uri-list`; the UI maps
that mime to a link entry. The URL is recovered from the file body via
a format-agnostic `https?://` regex, since each format embeds the URL
on a different syntactic line.

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
| `unread` | `true\|false` | Matches the latest succeeded agent message in each chat whose `unread` flag is set (chat has agent activity the user hasn't opened yet). |
| `contentKind` | one of the `Message.content` discriminants (comma-separated list accepted) | `text\|toolCall\|toolResult\|artifactRef\|events\|summary\|summary_request\|agent_turn` |
| `since` | ISO-8601 timestamp | `createdAt > since` (reconnect catchup). |
| `cursor` | opaque string | Same shape as `GET /chats/{id}/messages?cursor=`. |
| `limit` | integer, default 50, max 200 | Page size. |

Returns `{ items: Message[], nextCursor?: string }` — identical shape to `GET /chats/{id}/messages`. Ordering is `createdAt DESC, id DESC`.

Malformed params → 400. Non-owned `workspaceId` / `chatId` → 404.

**Use cases:**

- Runs "Upcoming": `?scheduled=true&state=pending`
- Runs "Active": `?state=running`
- Runs "Completed / Cancelled / Failed": `?scheduled=true&state=succeeded,failed,cancelled`
- Today / Inbox "Due now": `?unread=true`
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
  `~/Desk/desk/.chats/{chatId}/logs/{messageId}.log`, served
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

- `provider` (optional) — restrict to a single provider, e.g. `opencode`

**Response:** bare array, matching `/workspaces`, `/agents`, `/runs`.

```json
[
  { "id": "opencode/big-pickle", "provider": "opencode" }
]
```

`id` is opencode's canonical model id — pass it straight to `opencode run --model`.
`provider` is denormalised so UIs can group or filter without splitting the id.

If no container runtime is reachable, the endpoint returns `503` with
`code: "RUNTIME_UNAVAILABLE"` and an actionable message from runtime detection.

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
