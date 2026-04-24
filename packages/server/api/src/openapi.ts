/**
 * Generates the OpenAPI 3.1.0 specification for the Desk API.
 * Covers all v1 routes with request/response shapes.
 */

interface OpenApiSpec {
  openapi: string;
  info: { title: string; version: string; description: string };
  paths: Record<string, unknown>;
  components: { schemas: Record<string, unknown>; securitySchemes: Record<string, unknown> };
  security: Array<Record<string, unknown>>;
}

export function generateOpenApiSpec(): OpenApiSpec {
  return {
    openapi: "3.1.0",
    info: {
      title: "Desk API",
      version: "1.0.0",
      description: "HTTP + WS gateway for the Desk personal AI assistant.",
    },
    security: [{ bearerAuth: [] }],
    components: {
      securitySchemes: {
        bearerAuth: {
          type: "http",
          scheme: "bearer",
        },
      },
      schemas: {
        Error: {
          type: "object",
          properties: {
            code: { type: "string" },
            message: { type: "string" },
          },
          required: ["code", "message"],
        },
        Ok: {
          type: "object",
          properties: { ok: { type: "boolean" } },
        },
      },
    },
    paths: {
      "/": {
        get: {
          summary: "Health check",
          security: [],
          responses: {
            "200": {
              description: "Server is up",
              content: {
                "text/plain": { schema: { type: "string", example: "hello world" } },
              },
            },
          },
        },
      },
      "/auth/login": {
        post: {
          summary: "Log in",
          security: [],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    username: { type: "string" },
                    password: { type: "string" },
                  },
                  required: ["username", "password"],
                },
              },
            },
          },
          responses: {
            "200": { description: "Session token", content: { "application/json": { schema: { type: "object", properties: { token: { type: "string" } } } } } },
            "401": { description: "Invalid credentials" },
          },
        },
      },
      "/auth/logout": {
        post: { summary: "Log out", responses: { "200": { description: "OK" } } },
      },
      "/me": {
        get: { summary: "Get current user", responses: { "200": { description: "User object" } } },
        patch: {
          summary: "Update current user",
          requestBody: { content: { "application/json": { schema: { type: "object", properties: { username: { type: "string" }, email: { type: "string" }, avatarPath: { type: "string" } } } } } },
          responses: { "200": { description: "Updated user" } },
        },
        delete: { summary: "Soft-delete current account", responses: { "200": { description: "Acknowledged" } } },
      },
      "/me/password": {
        post: {
          summary: "Change password",
          requestBody: { content: { "application/json": { schema: { type: "object", properties: { currentPassword: { type: "string" }, newPassword: { type: "string" } }, required: ["currentPassword", "newPassword"] } } } },
          responses: { "200": { description: "OK" }, "401": { description: "Current password is incorrect" } },
        },
      },
      "/me/providers": {
        get: {
          summary: "Get AI provider keys (masked)",
          description: "Returns every known provider key name with its value masked to first 6 + last 4 chars, or null when unset. Keys are encrypted at rest in the DB.",
          responses: {
            "200": {
              description: "Masked provider keys",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      providers: {
                        type: "object",
                        additionalProperties: { type: ["string", "null"] },
                      },
                    },
                    required: ["providers"],
                  },
                },
              },
            },
          },
        },
        put: {
          summary: "Update AI provider keys",
          description: "Partial update. Null value deletes a key; string value sets it. Unknown names return 400.",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    providers: {
                      type: "object",
                      additionalProperties: { type: ["string", "null"] },
                    },
                  },
                  required: ["providers"],
                },
              },
            },
          },
          responses: {
            "200": { description: "Updated masked keys (same shape as GET)" },
            "400": { description: "Unknown provider name" },
          },
        },
      },
      "/workspaces": {
        get: { summary: "List workspaces", responses: { "200": { description: "Workspace array" } } },
        post: {
          summary: "Create workspace",
          requestBody: { content: { "application/json": { schema: { type: "object", properties: { name: { type: "string" }, description: { type: "string" }, icon: { type: "string" } }, required: ["name"] } } } },
          responses: { "201": { description: "Created workspace" } },
        },
      },
      "/workspaces/{id}": {
        get: { summary: "Get workspace", parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }], responses: { "200": { description: "Workspace" } } },
        patch: { summary: "Update workspace", parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }], responses: { "200": { description: "Updated workspace" } } },
        delete: {
          summary: "Delete workspace (cascades chats, messages, memberships)",
          description: "Hard-deletes the workspace row. Refuses with 400 when the caller has only one workspace — every user must retain at least one.",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          responses: {
            "200": { description: "OK" },
            "400": { description: "Cannot delete the caller's last workspace" },
            "404": { description: "Workspace not found" },
          },
        },
      },
      "/workspaces/{id}/agents": {
        get: {
          summary: "List agents enrolled in the workspace (with default flag)",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          responses: { "200": { description: "Enrolled agents" } },
        },
        post: {
          summary: "Enroll an agent in the workspace",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          requestBody: { required: true, content: { "application/json": { schema: { type: "object", properties: { agentId: { type: "string" } }, required: ["agentId"] } } } },
          responses: { "201": { description: "Membership created" }, "400": { description: "Owner mismatch" } },
        },
      },
      "/workspaces/{id}/agents/{agentId}": {
        delete: {
          summary: "Remove an agent from the workspace",
          parameters: [
            { name: "id", in: "path", required: true, schema: { type: "string" } },
            { name: "agentId", in: "path", required: true, schema: { type: "string" } },
          ],
          responses: { "200": { description: "OK" } },
        },
      },
      "/agents": {
        get: { summary: "List the current user's agents", responses: { "200": { description: "Agent array" } } },
        post: {
          summary: "Create an agent",
          requestBody: { required: true, content: { "application/json": { schema: { type: "object", properties: { name: { type: "string" }, instructions: { type: "string" }, model: { type: "string" } }, required: ["name"] } } } },
          responses: { "201": { description: "Created agent" } },
        },
      },
      "/agents/{id}": {
        get: { summary: "Get agent", parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }], responses: { "200": { description: "Agent" } } },
        patch: {
          summary: "Update agent (name, instructions, model)",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          requestBody: { content: { "application/json": { schema: { type: "object", properties: { name: { type: "string" }, instructions: { type: "string" }, model: { type: "string" } } } } } },
          responses: { "200": { description: "Updated agent" } },
        },
        delete: {
          summary: "Delete agent (cascades chats, messages, workspace memberships)",
          description: "Hard-deletes the agent row. `ON DELETE CASCADE` removes the agent's chats (and their messages) plus any workspace_agents rows. Chat on-disk directories are not cleaned up; revisit if agent deletion becomes user-visible in production. Refuses with 400 when the caller has only one agent — every user must retain at least one.",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          responses: {
            "200": { description: "OK", content: { "application/json": { schema: { $ref: "#/components/schemas/Ok" } } } },
            "400": { description: "Cannot delete the caller's last agent" },
            "404": { description: "Agent not found" },
          },
        },
      },
      "/chats": {
        get: {
          summary: "List chats",
          description: "Lists chats in the given workspace. When `workspaceId` is omitted, defaults to the caller's first workspace. Returns `[]` when the user has no workspaces. 400 if `workspaceId` is malformed; 404 when it refers to a workspace the caller does not own.",
          parameters: [
            { name: "workspaceId", in: "query", schema: { type: "string", pattern: "^wks_[A-Za-z0-9_-]+$" } },
          ],
          responses: { "200": { description: "Chat array with last-message snippet" } },
        },
        post: {
          summary: "Create chat",
          requestBody: { content: { "application/json": { schema: { type: "object", properties: { workspaceId: { type: "string" }, agentId: { type: "string" }, title: { type: "string" }, goal: { type: "string" } }, required: ["workspaceId", "agentId", "title"] } } } },
          responses: { "201": { description: "Created chat" } },
        },
      },
      "/chats/{id}": {
        get: { summary: "Get chat", parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }], responses: { "200": { description: "Chat" } } },
        patch: {
          summary: "Update chat",
          description: "Patch chat metadata. `agentId` re-binds the chat to a different agent (the new agent must be enabled in the chat's workspace) — subsequent messages use the new agent's model and instructions.",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          requestBody: {
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    title: { type: "string" },
                    goal: { type: "string" },
                    agentId: { type: "string", description: "Must be an agent enabled in this chat's workspace." },
                  },
                },
              },
            },
          },
          responses: { "200": { description: "Updated chat" } },
        },
        delete: {
          summary: "Delete chat (cascades messages + on-disk dirs)",
          description: "Cancels any pending/recurring scheduler entries owned by the chat's messages, deletes the chat row (FK ON DELETE CASCADE drops all messages), and moves the chat's on-disk directories (`.chats/{chatId}/` hidden state and `chats/{chatId}/` attachments) to `~/Desk/.trash/`. Emits a `chat.deleted` WS event.",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          responses: {
            "200": { description: "OK", content: { "application/json": { schema: { $ref: "#/components/schemas/Ok" } } } },
            "404": { description: "Chat not found" },
          },
        },
      },
      "/chats/{id}/messages": {
        get: { summary: "List messages", parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }, { name: "cursor", in: "query", schema: { type: "string" } }], responses: { "200": { description: "Message array" } } },
        post: {
          summary: "Send message",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          requestBody: {
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    content: { type: "string" },
                    attachments: {
                      type: "array",
                      description: "Files the user attached to this message. Each item references a file already uploaded via POST /chats/{id}/attachments — the path is workspace-relative, forward-slash separated.",
                      items: {
                        type: "object",
                        properties: {
                          path: { type: "string" },
                          name: { type: "string" },
                          mime: { type: "string" },
                          size: { type: "integer", minimum: 0 },
                        },
                        required: ["path", "name"],
                      },
                    },
                  },
                  required: ["content"],
                },
              },
            },
          },
          responses: { "201": { description: "Created message" } },
        },
      },
      "/chats/{id}/messages/{messageId}": {
        patch: {
          summary: "Edit a message (content, cancel, reschedule)",
          description: "Update content (e.g. user edits a note), transition state (only 'cancelled' or 'pending' allowed), or reschedule (execute_at/cron). Emits message.updated.",
          parameters: [
            { name: "id", in: "path", required: true, schema: { type: "string" } },
            { name: "messageId", in: "path", required: true, schema: { type: "string" } },
          ],
          requestBody: {
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    content: { type: "object" },
                    state: { type: "string", enum: ["cancelled", "pending"] },
                    executeAt: { type: ["string", "null"] },
                    cron: { type: ["string", "null"] },
                  },
                },
              },
            },
          },
          responses: {
            "200": { description: "Updated message" },
            "400": { description: "Invalid state or payload" },
            "404": { description: "Message not found in chat" },
          },
        },
        delete: {
          summary: "Delete a message (cancels any scheduled firing)",
          parameters: [
            { name: "id", in: "path", required: true, schema: { type: "string" } },
            { name: "messageId", in: "path", required: true, schema: { type: "string" } },
          ],
          responses: {
            "200": { description: "OK" },
            "404": { description: "Message not found in chat" },
          },
        },
      },
      "/chats/{id}/messages/{messageId}/logs": {
        get: {
          summary: "Stream a message's execution log file",
          description: "Returns the accumulated stdout/stderr from an executing or completed message. Served directly from ~/Desk/workspaces/desk/.chats/{chatId}/logs/{messageId}.log — no DB involvement. 404 if no log file exists yet.",
          parameters: [
            { name: "id", in: "path", required: true, schema: { type: "string" } },
            { name: "messageId", in: "path", required: true, schema: { type: "string" } },
          ],
          responses: {
            "200": { description: "Log file contents (text/plain)" },
            "404": { description: "No log for that message" },
          },
        },
      },
      "/chats/{id}/messages/{messageId}/note-history": {
        get: {
          summary: "List archived versions of a note-content message",
          description: "Each PATCH of a `note`-content message and each AI rewrite snapshots the prior body under .chats/{chatId}/note-history/. This endpoint returns every snapshot, newest first.",
          parameters: [
            { name: "id", in: "path", required: true, schema: { type: "string" } },
            { name: "messageId", in: "path", required: true, schema: { type: "string" } },
          ],
          responses: {
            "200": {
              description: "Note version array",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      versions: {
                        type: "array",
                        items: {
                          type: "object",
                          properties: {
                            timestamp: { type: "string", format: "date-time" },
                            body: { type: "string" },
                          },
                          required: ["timestamp", "body"],
                        },
                      },
                    },
                    required: ["versions"],
                  },
                },
              },
            },
            "404": { description: "Message not found in chat" },
          },
        },
      },
      "/chats/{id}/attachments": {
        get: {
          summary: "List chat attachments",
          description: "Returns visible (non-dot) attachments by default. Pass ?showHidden=true to include dot-prefixed agent artifacts.",
          parameters: [
            { name: "id", in: "path", required: true, schema: { type: "string" } },
            { name: "showHidden", in: "query", schema: { type: "boolean" } },
          ],
          responses: { "200": { description: "File array" } },
        },
        post: {
          summary: "Upload attachment to chat",
          description: "Accepts multipart/form-data with a single 'file' part. The part's filename and Content-Type become the attachment's name and MIME. Filenames starting with '.' are rejected (reserved for agent artifacts).",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          requestBody: {
            required: true,
            content: {
              "multipart/form-data": {
                schema: {
                  type: "object",
                  properties: {
                    file: { type: "string", format: "binary" },
                  },
                  required: ["file"],
                },
              },
            },
          },
          responses: { "201": { description: "Created file" }, "400": { description: "Missing or malformed multipart body" } },
        },
      },
      "/library": {
        get: {
          summary: "List library files and folders",
          description: "Recursively reads the workspace library directory; returns `items` (FileRef entries) and `folders` (FolderRef entries) describing the full tree. Files/folders with a leading dot are hidden. Scoped to `workspaceId`; defaults to the caller's first workspace. Returns `{items: [], folders: []}` when the user has no workspaces. 400 if `workspaceId` is malformed; 404 when it refers to a workspace the caller does not own.",
          parameters: [
            { name: "workspaceId", in: "query", schema: { type: "string", pattern: "^wks_[A-Za-z0-9_-]+$" } },
            { name: "cursor", in: "query", schema: { type: "string" } },
            { name: "limit", in: "query", schema: { type: "integer" } },
          ],
          responses: { "200": { description: "Library listing" } },
        },
        post: {
          summary: "Upload a file to the workspace library",
          description: "Accepts multipart/form-data with a single 'file' part and an optional 'subpath' text field naming a library-relative subdirectory (e.g. `Photos/2024`). Missing subdirectories are created recursively. Filename becomes the library entry's name; filename collisions get suffixed with -1, -2, ... Destination workspace comes from `workspaceId` (falls back to the caller's first workspace). 400 on invalid `subpath` (traversal, dotfile segments, backslashes).",
          parameters: [
            { name: "workspaceId", in: "query", schema: { type: "string", pattern: "^wks_[A-Za-z0-9_-]+$" } },
          ],
          requestBody: {
            required: true,
            content: {
              "multipart/form-data": {
                schema: {
                  type: "object",
                  properties: {
                    file: { type: "string", format: "binary" },
                    subpath: { type: "string", description: "Library-relative subdirectory to place the file in." },
                  },
                  required: ["file"],
                },
              },
            },
          },
          responses: { "201": { description: "Created file ref" }, "400": { description: "Malformed workspaceId or subpath" }, "404": { description: "Workspace not found / no workspace available" } },
        },
        patch: {
          summary: "Move or rename a library file or folder",
          description: "Renames or moves an entry within the workspace. Both `from` and `to` are workspace-root-relative paths (e.g. `Photos/2024/beach.jpg`); traversal and dot-prefixed segments are rejected. The destination must not already exist. For folders, the entire subtree moves.",
          parameters: [
            { name: "workspaceId", in: "query", schema: { type: "string", pattern: "^wks_[A-Za-z0-9_-]+$" } },
          ],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    from: { type: "string" },
                    to: { type: "string" },
                  },
                  required: ["from", "to"],
                },
              },
            },
          },
          responses: { "200": { description: "Moved" }, "400": { description: "Invalid body or destination exists" }, "404": { description: "Source not in workspace or not found" } },
        },
        delete: {
          summary: "Delete a library entry (moves it to ~/Desk/.trash/)",
          description: "Works for both files and folders. Folders are recursively moved to the trash.",
          parameters: [
            { name: "path", in: "query", required: true, schema: { type: "string" } },
            { name: "workspaceId", in: "query", schema: { type: "string", pattern: "^wks_[A-Za-z0-9_-]+$" } },
          ],
          responses: { "200": { description: "OK" }, "404": { description: "No such path in the resolved workspace" } },
        },
      },
      "/library/folder": {
        post: {
          summary: "Create an empty library folder",
          description: "Creates an empty directory at the workspace-root-relative `path`. The `path` is validated against traversal, dotfile segments, and backslashes. Intermediate parents are created automatically.",
          parameters: [
            { name: "workspaceId", in: "query", schema: { type: "string", pattern: "^wks_[A-Za-z0-9_-]+$" } },
          ],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: { path: { type: "string" } },
                  required: ["path"],
                },
              },
            },
          },
          responses: { "201": { description: "Created FolderRef" }, "400": { description: "Invalid or empty path" }, "404": { description: "Workspace not found" } },
        },
      },
      "/library/meta": {
        get: {
          summary: "Stat a library file by workspace-relative path",
          parameters: [
            { name: "path", in: "query", required: true, schema: { type: "string" } },
            { name: "workspaceId", in: "query", schema: { type: "string", pattern: "^wks_[A-Za-z0-9_-]+$" } },
          ],
          responses: { "200": { description: "FileRef" }, "404": { description: "No such path in the resolved workspace" } },
        },
      },
      "/library/download": {
        get: {
          summary: "Stream a library file's bytes",
          parameters: [
            { name: "path", in: "query", required: true, schema: { type: "string" } },
            { name: "workspaceId", in: "query", schema: { type: "string", pattern: "^wks_[A-Za-z0-9_-]+$" } },
          ],
          responses: { "200": { description: "File content" }, "404": { description: "No such path in the resolved workspace" } },
        },
      },
      "/library/content": {
        get: {
          summary: "Stream a library file's bytes inline (for in-app preview)",
          parameters: [
            { name: "path", in: "query", required: true, schema: { type: "string" } },
            { name: "workspaceId", in: "query", schema: { type: "string", pattern: "^wks_[A-Za-z0-9_-]+$" } },
          ],
          responses: { "200": { description: "File content (Content-Disposition: inline)" }, "404": { description: "No such path in the resolved workspace" } },
        },
        put: {
          summary: "Overwrite an existing library file's contents",
          description: "Replaces the file at `path` with the request body. Fails with 404 if the file doesn't exist — use POST /library to create.",
          parameters: [
            { name: "path", in: "query", required: true, schema: { type: "string" } },
            { name: "workspaceId", in: "query", schema: { type: "string", pattern: "^wks_[A-Za-z0-9_-]+$" } },
          ],
          requestBody: {
            required: true,
            content: { "application/octet-stream": { schema: { type: "string", format: "binary" } } },
          },
          responses: {
            "200": { description: "Updated FileRef" },
            "404": { description: "No such path in the resolved workspace" },
            "413": { description: "File exceeds maximum size" },
          },
        },
      },
      // Runs / scheduled-jobs endpoints are gone — execution state lives
      // on messages. See /chats/{id}/messages/{messageId}/... for the
      // replacement surface.
      "/messages": {
        get: {
          summary: "List messages across the caller's chats",
          description: "Cross-chat, read-only paginator. AND-combines the optional filters; ownership is enforced via a join on chats → workspaces so results are naturally scoped to the caller. Ordered by `createdAt DESC`, with `id DESC` as the stable tiebreaker. Response shape matches `GET /chats/{id}/messages`. Unknown `workspaceId` / `chatId` that the caller does not own → 404 (existence-hiding, same as the rest of the API).",
          parameters: [
            { name: "workspaceId", in: "query", schema: { type: "string", pattern: "^wks_[A-Za-z0-9_-]+$" }, description: "Restrict to chats in this workspace. Absent = all of the caller's workspaces." },
            { name: "chatId", in: "query", schema: { type: "string", pattern: "^cht_[A-Za-z0-9_-]+$" }, description: "Restrict to a single chat. Absent = all of the caller's chats." },
            { name: "state", in: "query", schema: { type: "string" }, description: "Comma-separated list of `Message.state` values (`pending|running|succeeded|failed|cancelled`)." },
            { name: "scheduled", in: "query", schema: { type: "string", enum: ["true", "false"] }, description: "`true` = only rows with `executeAt` or `cron`; `false` = only unscheduled." },
            { name: "awaitingUser", in: "query", schema: { type: "string", enum: ["true", "false"] }, description: "`true` = the message is an agent message in state `succeeded`, the latest in its chat, and its chat's `awaitingUser` flag is set." },
            { name: "contentKind", in: "query", schema: { type: "string" }, description: "Comma-separated list of `Message.content` discriminant values (e.g. `text,artifactRef`)." },
            { name: "since", in: "query", schema: { type: "string", format: "date-time" }, description: "Only messages with `createdAt > since`. Useful for WS-reconnect catchup." },
            { name: "cursor", in: "query", schema: { type: "string" }, description: "Opaque pagination cursor returned as `nextCursor` in the previous page." },
            { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 200, default: 50 } },
          ],
          responses: {
            "200": {
              description: "Paginated message array; same shape as `GET /chats/{id}/messages`.",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      items: { type: "array", items: { type: "object" } },
                      nextCursor: { type: "string" },
                    },
                    required: ["items"],
                  },
                },
              },
            },
            "400": { description: "Invalid query parameter (malformed id, unknown state, etc.)" },
            "404": { description: "Explicit `workspaceId` or `chatId` is not owned by the caller" },
          },
        },
      },
      "/tools/models": {
        get: {
          summary: "List AI models that are ready to use",
          description: "Returns the set of models reachable with currently configured provider credentials (server-wide, not agent-scoped). Every returned model is ready — opencode only surfaces models for providers whose API key is present in the sandbox env. Foundation of host-initiated sandboxed tool calling (ARCHITECTURE.md §7).",
          parameters: [
            { name: "provider", in: "query", schema: { type: "string" }, description: "Restrict to a single provider id, e.g. \"anthropic\"." },
          ],
          responses: {
            "200": {
              description: "Array of ready-to-use models",
              content: {
                "application/json": {
                  schema: {
                    type: "array",
                    items: {
                      type: "object",
                      properties: {
                        id: { type: "string", description: "Opencode canonical id, e.g. \"anthropic/claude-opus-4-7\"." },
                        provider: { type: "string", description: "Provider portion of id, e.g. \"anthropic\"." },
                      },
                      required: ["id", "provider"],
                    },
                  },
                },
              },
            },
            "400": { description: "Sandbox rejected the listing" },
            "404": { description: "No sandbox available" },
          },
        },
      },
      "/search": {
        get: {
          summary: "Search across artifacts, chats, and library",
          parameters: [
            { name: "q", in: "query", required: true, schema: { type: "string" } },
            { name: "scope", in: "query", schema: { type: "string", enum: ["all", "artifacts", "chats", "library"] } },
          ],
          responses: { "200": { description: "Search result array" } },
        },
      },
      "/ws": {
        get: {
          summary: "WebSocket upgrade",
          description: "Upgrades to WebSocket. Authenticate via ?token= query parameter.",
          parameters: [{ name: "token", in: "query", required: true, schema: { type: "string" } }],
          responses: { "101": { description: "Switching Protocols" } },
        },
      },
      "/openapi.json": {
        get: {
          summary: "OpenAPI specification",
          security: [],
          responses: { "200": { description: "OpenAPI 3.1.0 JSON document" } },
        },
      },
      "/internal/messages/fire": {
        post: {
          summary: "Fire a scheduled message (server-internal)",
          description: "Fires a pending scheduled message by id. Invoked by at/cron via curl. Loopback + shared-secret required. Idempotent — concurrent fires on the same messageId converge on one execution via a pending→running state transition.",
          security: [],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: { type: "object", properties: { messageId: { type: "string" } }, required: ["messageId"] },
              },
            },
          },
          responses: {
            "200": {
              description: "Fire result",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      ok: { type: "boolean" },
                      fired: { type: "boolean" },
                      childIds: { type: "array", items: { type: "string" } },
                    },
                  },
                },
              },
            },
            "400": { description: "Missing messageId" },
            "401": { description: "Missing/invalid token or non-loopback origin" },
          },
        },
      },
    },
  };
}
