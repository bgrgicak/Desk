# API Documentation

All endpoints require Bearer token authentication unless noted otherwise.
The full OpenAPI 3.1.0 spec is served at `GET /openapi.json`.

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
| GET    | /chats                    | List chats                |
| POST   | /chats                    | Create chat               |
| GET    | /chats/{id}               | Get chat                  |
| PATCH  | /chats/{id}               | Update chat               |
| GET    | /chats/{id}/messages                    | List messages             |
| POST   | /chats/{id}/messages                    | Send message              |
| PATCH  | /chats/{id}/messages/{messageId}        | Edit message content, cancel, reschedule |
| DELETE | /chats/{id}/messages/{messageId}        | Delete message (cancels scheduled firing) |
| GET    | /chats/{id}/messages/{messageId}/logs   | Stream execution log file |
| GET    | /chats/{id}/artifacts                   | List chat artifacts       |
| POST   | /chats/{id}/artifacts                   | Upload artifact to chat (multipart/form-data) |

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
| GET    | /library                       | List library files                              |
| POST   | /library                       | Upload to library (multipart/form-data)         |
| DELETE | /library?path=...              | Move a library file to `~/Desk/.trash/`         |
| GET    | /library/meta?path=...         | Stat a library file                             |
| GET    | /library/download?path=...     | Stream a library file                           |

Files live on the filesystem at `~/Desk/workspaces/desk/library/`; there
is no DB index. File identifiers are workspace-relative paths
(`library/report.md`). The `path` query parameter is url-encoded.

## Runs

| Method | Path                | Description       |
|--------|---------------------|-------------------|
| GET    | /runs               | List runs         |
| GET    | /runs/{id}          | Get run           |
| GET    | /runs/{id}/logs     | Get run logs      |
| POST   | /runs/{id}/cancel   | Cancel run        |

## Scheduled Jobs

| Method | Path                  | Description              |
|--------|-----------------------|--------------------------|
| GET    | /scheduled-jobs       | List active jobs         |
| POST   | /scheduled-jobs       | Create scheduled job     |
| DELETE | /scheduled-jobs/{id}  | Delete scheduled job     |

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

## Other

| Method | Path           | Auth | Description         |
|--------|----------------|------|---------------------|
| GET    | /              | No   | Health check        |
| GET    | /openapi.json  | No   | OpenAPI 3.1.0 spec  |
