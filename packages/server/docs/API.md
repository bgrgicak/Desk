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

## Workspaces

| Method | Path              | Description         |
|--------|-------------------|---------------------|
| GET    | /workspaces       | List workspaces     |
| POST   | /workspaces       | Create workspace    |
| GET    | /workspaces/{id}  | Get workspace       |
| PATCH  | /workspaces/{id}  | Update workspace    |
| DELETE | /workspaces/{id}  | Delete workspace    |

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

| Method | Path          | Description    |
|--------|---------------|----------------|
| GET    | /agents       | List agents    |
| GET    | /agents/{id}  | Get agent      |
| PATCH  | /agents/{id}  | Update agent   |

## Chats

| Method | Path                      | Description               |
|--------|---------------------------|---------------------------|
| GET    | /chats                    | List chats                |
| POST   | /chats                    | Create chat               |
| GET    | /chats/{id}               | Get chat                  |
| PATCH  | /chats/{id}               | Update chat               |
| GET    | /chats/{id}/messages      | List messages             |
| POST   | /chats/{id}/messages      | Send message              |
| GET    | /chats/{id}/artifacts     | List chat artifacts       |
| POST   | /chats/{id}/artifacts     | Upload artifact to chat   |

## Library

| Method | Path                   | Description              |
|--------|------------------------|--------------------------|
| GET    | /library               | List library files       |
| POST   | /library               | Upload to library        |
| GET    | /library/{id}          | Get file metadata        |
| DELETE | /library/{id}          | Delete file              |
| GET    | /library/{id}/download | Download file content    |
| POST   | /library/{id}/note     | Create a manual note     |

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
| GET    | /tools/models  | List AI models available inside the agent's sandbox        |

### GET /tools/models

Runs `opencode models` inside the target agent's warm sandbox and returns the
parsed `provider/model` pairs. This is the foundation of host-initiated
sandboxed tool calling described in [ARCHITECTURE.md §7](./ARCHITECTURE.md).
The sandbox is the source of truth for model availability because provider
credentials and OpenCode configuration live inside it.

**Query parameters:**

- `agentId` (optional) — defaults to the first registered agent
- `provider` (optional) — restrict to a single provider, e.g. `anthropic`

**Response:**

```json
{
  "agentId": "agt_abc",
  "provider": "anthropic",
  "models": [
    { "providerId": "anthropic", "modelId": "claude-opus-4-7", "fullId": "anthropic/claude-opus-4-7" }
  ]
}
```

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
