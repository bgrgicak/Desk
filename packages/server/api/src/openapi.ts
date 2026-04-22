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
          requestBody: { content: { "application/json": { schema: { type: "object", properties: { newPassword: { type: "string" } }, required: ["newPassword"] } } } },
          responses: { "200": { description: "OK" } },
        },
      },
      "/workspaces": {
        get: { summary: "List workspaces", responses: { "200": { description: "Workspace array" } } },
      },
      "/workspaces/{id}": {
        get: { summary: "Get workspace", parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }], responses: { "200": { description: "Workspace" } } },
        patch: { summary: "Update workspace", parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }], responses: { "200": { description: "Updated workspace" } } },
        delete: { summary: "Soft-delete workspace", parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }], responses: { "200": { description: "OK" } } },
      },
      "/agents": {
        get: { summary: "List agents", responses: { "200": { description: "Agent array" } } },
      },
      "/agents/{id}": {
        get: { summary: "Get agent", parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }], responses: { "200": { description: "Agent" } } },
        patch: { summary: "Update agent", parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }], responses: { "200": { description: "Updated agent" } } },
      },
      "/chats": {
        get: { summary: "List chats", responses: { "200": { description: "Chat array with last-message snippet" } } },
        post: {
          summary: "Create chat",
          requestBody: { content: { "application/json": { schema: { type: "object", properties: { workspaceId: { type: "string" }, agentId: { type: "string" }, title: { type: "string" }, goal: { type: "string" } }, required: ["workspaceId", "agentId", "title"] } } } },
          responses: { "201": { description: "Created chat" } },
        },
      },
      "/chats/{id}": {
        get: { summary: "Get chat", parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }], responses: { "200": { description: "Chat" } } },
        patch: { summary: "Update chat", parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }], responses: { "200": { description: "Updated chat" } } },
      },
      "/chats/{id}/messages": {
        get: { summary: "List messages", parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }, { name: "cursor", in: "query", schema: { type: "string" } }], responses: { "200": { description: "Message array" } } },
        post: {
          summary: "Send message",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          requestBody: { content: { "application/json": { schema: { type: "object", properties: { content: { type: "string" } }, required: ["content"] } } } },
          responses: { "201": { description: "Created message" } },
        },
      },
      "/chats/{id}/artifacts": {
        get: { summary: "List chat artifacts", parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }], responses: { "200": { description: "File array" } } },
        post: {
          summary: "Upload artifact to chat",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          requestBody: { content: { "application/json": { schema: { type: "object", properties: { name: { type: "string" }, mime: { type: "string" }, contentBase64: { type: "string" } }, required: ["name", "mime", "contentBase64"] } } } },
          responses: { "201": { description: "Created file" } },
        },
      },
      "/library": {
        get: { summary: "List library files", parameters: [{ name: "cursor", in: "query", schema: { type: "string" } }, { name: "limit", in: "query", schema: { type: "integer" } }], responses: { "200": { description: "Library listing" } } },
        post: {
          summary: "Upload to library",
          requestBody: { content: { "application/json": { schema: { type: "object", properties: { name: { type: "string" }, mime: { type: "string" }, contentBase64: { type: "string" } }, required: ["name", "mime", "contentBase64"] } } } },
          responses: { "201": { description: "Created file" } },
        },
      },
      "/library/{id}": {
        get: { summary: "Get library file metadata", parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }], responses: { "200": { description: "File" } } },
        delete: { summary: "Delete library file", parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }], responses: { "200": { description: "OK" } } },
      },
      "/library/{id}/download": {
        get: { summary: "Download library file", parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }], responses: { "200": { description: "File content" } } },
      },
      "/library/{id}/note": {
        post: {
          summary: "Create a manual library note",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          requestBody: { content: { "application/json": { schema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } } } },
          responses: { "201": { description: "Created note file" } },
        },
      },
      "/runs": {
        get: { summary: "List runs", responses: { "200": { description: "Run array" } } },
      },
      "/runs/{id}": {
        get: { summary: "Get run", parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }], responses: { "200": { description: "Run" } } },
      },
      "/runs/{id}/logs": {
        get: { summary: "Get run logs", parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }, { name: "cursor", in: "query", schema: { type: "integer" } }], responses: { "200": { description: "Log event array" } } },
      },
      "/runs/{id}/cancel": {
        post: { summary: "Cancel run", parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }], responses: { "200": { description: "OK" } } },
      },
      "/scheduled-jobs": {
        get: {
          summary: "List active scheduled jobs",
          responses: { "200": { description: "Array of active scheduled jobs" } },
        },
        post: {
          summary: "Create scheduled job",
          requestBody: { content: { "application/json": { schema: { type: "object", properties: { chatId: { type: "string" }, prompt: { type: "string" }, mode: { type: "string", enum: ["scheduled", "recurring"] }, spec: { type: "string" } }, required: ["prompt", "mode", "spec"] } } } },
          responses: { "201": { description: "Created run" } },
        },
      },
      "/scheduled-jobs/{id}": {
        delete: { summary: "Delete scheduled job", parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }], responses: { "200": { description: "OK" } } },
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
    },
  };
}
