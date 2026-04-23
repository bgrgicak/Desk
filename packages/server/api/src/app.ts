import { createServer as httpCreateServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { createHash } from "node:crypto";
import pg from "pg";
import { DeskError, ValidationError, type WsEvent } from "@desk/shared";
import type { StorageContext } from "@desk/storage";
import type { createRunManager } from "@desk/scheduler";
import { requireAuth } from "./auth/middleware.js";
import { requireInternal } from "./auth/internal.js";
import { verifySession } from "./auth/sessions.js";
import {
  requireOwnedAgent,
  requireOwnedChat,
  requireOwnedMessage,
  requireOwnedWorkspace,
} from "./auth/ownership.js";
import { errorToStatus } from "./errors.js";
import { addConnection, removeConnection, broadcast } from "./ws/registry.js";
import { generateOpenApiSpec } from "./openapi.js";
import { HEALTH_MESSAGE } from "./health-message.js";
import * as authRoutes from "./routes/auth.js";
import * as accountRoutes from "./routes/account.js";
import * as workspaceRoutes from "./routes/workspaces.js";
import * as agentRoutes from "./routes/agents.js";
import * as chatRoutes from "./routes/chats.js";
import * as libraryRoutes from "./routes/library.js";
import * as searchRoutes from "./routes/search.js";
import * as toolRoutes from "./routes/tools.js";

type RunManager = ReturnType<typeof createRunManager>;

export interface AppOptions {
  pool: pg.Pool;
  storage: StorageContext;
  runManager: RunManager;
  /** The userId to broadcast events to (v1: single user). */
  broadcastUserId?: string;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(json) });
  res.end(json);
}

function readRawBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

async function parseBody(req: IncomingMessage): Promise<unknown> {
  const raw = await readRawBody(req);
  if (raw.length === 0) return {};
  return JSON.parse(raw.toString());
}

/**
 * Parses a multipart/form-data body using Node's built-in Fetch API.
 * Returns a FormData instance; callers pull out parts by field name.
 */
async function parseMultipart(req: IncomingMessage): Promise<FormData> {
  const contentType = req.headers["content-type"] ?? "";
  if (!contentType.toLowerCase().startsWith("multipart/form-data")) {
    throw new ValidationError("Expected multipart/form-data body");
  }
  const body = await readRawBody(req);
  const r = new Request("http://localhost/", {
    method: "POST",
    headers: { "content-type": contentType },
    body: new Blob([new Uint8Array(body)]),
  });
  try {
    return await r.formData();
  } catch {
    throw new ValidationError("Malformed multipart body");
  }
}

type RouteHandler = (req: IncomingMessage, res: ServerResponse, params: RouteParams) => Promise<void>;

interface RouteParams {
  path: string;
  segments: string[];
  userId: string;
  query: URLSearchParams;
}

export function createApp(opts: AppOptions): Server {
  const { pool, storage, runManager } = opts;

  function emitEvent(event: WsEvent): void {
    if (opts.broadcastUserId) {
      broadcast(opts.broadcastUserId, event);
    }
  }

  // Pre-generate the OpenAPI spec
  const openApiSpec = generateOpenApiSpec();

  const server = httpCreateServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const path = url.pathname;
      const method = req.method ?? "GET";

      // Auth
      let userId: string;
      try {
        userId = requireAuth(path, req.headers.authorization);
      } catch (err) {
        if (err instanceof DeskError) {
          sendJson(res, errorToStatus(err), { code: err.code, message: err.message });
        } else {
          sendJson(res, 500, { code: "INTERNAL", message: "Internal error" });
        }
        return;
      }

      const segments = path.split("/").filter(Boolean);
      const params: RouteParams = { path, segments, userId, query: url.searchParams };

      // Route dispatch
      await dispatch(method, params, req, res);
    } catch (err) {
      if (err instanceof DeskError) {
        sendJson(res, errorToStatus(err), { code: err.code, message: err.message });
      } else {
        console.error("Unhandled error:", err);
        sendJson(res, 500, { code: "INTERNAL", message: "Internal server error" });
      }
    }
  });

  // WebSocket upgrade handler
  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname !== "/ws") {
      socket.destroy();
      return;
    }

    // Authenticate via ?token= query param
    const token = url.searchParams.get("token");
    if (!token) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }

    const userId = verifySession(token);
    if (!userId) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }

    // Perform the WebSocket handshake. The header may be a string or an
    // array of strings; the RFC says take the first.
    const rawKey = req.headers["sec-websocket-key"];
    const key = Array.isArray(rawKey) ? rawKey[0] : rawKey;
    if (!key) {
      socket.destroy();
      return;
    }

    // RFC 6455 §1.3: fixed magic GUID for the WebSocket handshake.
    const WS_MAGIC_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
    const acceptKey = createHash("sha1")
      .update(key + WS_MAGIC_GUID)
      .digest("base64");

    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\n" +
      "Upgrade: websocket\r\n" +
      "Connection: Upgrade\r\n" +
      `Sec-WebSocket-Accept: ${acceptKey}\r\n` +
      "\r\n",
    );

    // Create a minimal WS-like object for the registry
    const ws = {
      readyState: 1,
      send(data: string) {
        // WebSocket text frame encoding
        const payload = Buffer.from(data, "utf-8");
        let header: Buffer;
        if (payload.length < 126) {
          header = Buffer.alloc(2);
          header[0] = 0x81; // FIN + text opcode
          header[1] = payload.length;
        } else if (payload.length < 65536) {
          header = Buffer.alloc(4);
          header[0] = 0x81;
          header[1] = 126;
          header.writeUInt16BE(payload.length, 2);
        } else {
          header = Buffer.alloc(10);
          header[0] = 0x81;
          header[1] = 127;
          header.writeBigUInt64BE(BigInt(payload.length), 2);
        }
        socket.write(Buffer.concat([header, payload]));
      },
    };

    addConnection(userId, ws);

    socket.on("close", () => {
      ws.readyState = 3; // CLOSED
      removeConnection(userId, ws);
    });

    socket.on("error", () => {
      ws.readyState = 3;
      removeConnection(userId, ws);
    });
  });

  async function dispatch(method: string, params: RouteParams, req: IncomingMessage, res: ServerResponse): Promise<void> {
    const { segments, userId, query } = params;
    const path = params.path;

    // Health check — used by install.sh + VM e2e tests to confirm the server is up.
    if (path === "/" && method === "GET") {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end(HEALTH_MESSAGE);
      return;
    }

    // Internal routes — loopback + shared-secret auth (not the user session).
    if (path === "/internal/messages/fire" && method === "POST") {
      requireInternal(req);
      const body = await parseBody(req) as { messageId?: string };
      if (!body.messageId) throw new ValidationError("Missing messageId");
      const result = await runManager.fireMessage(body.messageId);
      sendJson(res, 200, { ok: true, ...result });
      return;
    }

    // Auth routes
    if (path === "/auth/login" && method === "POST") {
      const body = await parseBody(req) as { username: string; password: string };
      const result = await authRoutes.handleLogin(pool, body);
      sendJson(res, 200, result);
      return;
    }
    if (path === "/auth/logout" && method === "POST") {
      const result = authRoutes.handleLogout(req.headers.authorization);
      sendJson(res, 200, result);
      return;
    }

    // Account routes
    if (path === "/me" && method === "GET") {
      const result = await accountRoutes.getMe(pool, userId);
      sendJson(res, 200, result);
      return;
    }
    if (path === "/me" && method === "PATCH") {
      const body = await parseBody(req) as { username?: string; email?: string; avatarPath?: string };
      const result = await accountRoutes.patchMe(pool, userId, body);
      sendJson(res, 200, result);
      return;
    }
    if (path === "/me" && method === "DELETE") {
      const result = await accountRoutes.deleteMe(pool, userId);
      sendJson(res, 200, result);
      return;
    }
    if (path === "/me/password" && method === "POST") {
      const body = await parseBody(req) as { currentPassword: string; newPassword: string };
      const result = await accountRoutes.changePassword(pool, userId, body);
      sendJson(res, 200, result);
      return;
    }
    if (path === "/me/providers" && method === "GET") {
      const result = await accountRoutes.getProviders(pool, userId);
      sendJson(res, 200, result);
      return;
    }
    if (path === "/me/providers" && method === "PUT") {
      const body = await parseBody(req) as { providers: Record<string, string | null> };
      const result = await accountRoutes.setProviders(pool, userId, body);
      sendJson(res, 200, result);
      return;
    }

    // Workspace routes — all scoped to the authenticated user. Non-owned
    // workspaces return 404 to avoid leaking existence.
    if (path === "/workspaces" && method === "GET") {
      const result = await workspaceRoutes.listWorkspaces(pool, userId);
      sendJson(res, 200, result);
      return;
    }
    if (path === "/workspaces" && method === "POST") {
      const body = await parseBody(req) as { name: string; description?: string; icon?: string };
      const result = await workspaceRoutes.createWorkspace(pool, userId, body);
      sendJson(res, 201, result);
      return;
    }
    if (segments[0] === "workspaces" && segments.length === 2 && method === "GET") {
      await requireOwnedWorkspace(pool, segments[1], userId);
      const result = await workspaceRoutes.getWorkspace(pool, segments[1]);
      sendJson(res, 200, result);
      return;
    }
    if (segments[0] === "workspaces" && segments.length === 2 && method === "PATCH") {
      await requireOwnedWorkspace(pool, segments[1], userId);
      const body = await parseBody(req) as { name?: string; description?: string; icon?: string };
      const result = await workspaceRoutes.patchWorkspace(pool, segments[1], body);
      sendJson(res, 200, result);
      return;
    }
    if (segments[0] === "workspaces" && segments.length === 2 && method === "DELETE") {
      await requireOwnedWorkspace(pool, segments[1], userId);
      const result = await workspaceRoutes.deleteWorkspace(pool, segments[1]);
      sendJson(res, 200, result);
      return;
    }
    if (segments[0] === "workspaces" && segments[2] === "agents" && segments.length === 3 && method === "GET") {
      await requireOwnedWorkspace(pool, segments[1], userId);
      const result = await workspaceRoutes.listWorkspaceAgents(pool, segments[1]);
      sendJson(res, 200, result);
      return;
    }
    if (segments[0] === "workspaces" && segments[2] === "agents" && segments.length === 3 && method === "POST") {
      await requireOwnedWorkspace(pool, segments[1], userId);
      const body = await parseBody(req) as { agentId: string };
      await requireOwnedAgent(pool, body.agentId, userId);
      const result = await workspaceRoutes.addAgentToWorkspace(pool, segments[1], body.agentId);
      sendJson(res, 201, result);
      return;
    }
    if (segments[0] === "workspaces" && segments[2] === "agents" && segments.length === 4 && method === "DELETE") {
      await requireOwnedWorkspace(pool, segments[1], userId);
      const result = await workspaceRoutes.removeAgentFromWorkspace(pool, segments[1], segments[3]);
      sendJson(res, 200, result);
      return;
    }
    if (segments[0] === "workspaces" && segments[2] === "default-agent" && segments.length === 3 && method === "POST") {
      await requireOwnedWorkspace(pool, segments[1], userId);
      const body = await parseBody(req) as { agentId: string };
      await requireOwnedAgent(pool, body.agentId, userId);
      const result = await workspaceRoutes.setWorkspaceDefaultAgent(pool, segments[1], body.agentId);
      sendJson(res, 200, result);
      return;
    }

    // Agent routes
    if (path === "/agents" && method === "GET") {
      const result = await agentRoutes.listAgents(pool, userId);
      sendJson(res, 200, result);
      return;
    }
    if (path === "/agents" && method === "POST") {
      const body = await parseBody(req) as { name: string; instructions?: string; model?: string; toolAllowlist?: string[] };
      const result = await agentRoutes.createAgent(pool, userId, body);
      sendJson(res, 201, result);
      return;
    }
    if (segments[0] === "agents" && segments.length === 2 && method === "GET") {
      await requireOwnedAgent(pool, segments[1], userId);
      const result = await agentRoutes.getAgent(pool, segments[1]);
      sendJson(res, 200, result);
      return;
    }
    if (segments[0] === "agents" && segments.length === 2 && method === "PATCH") {
      await requireOwnedAgent(pool, segments[1], userId);
      const body = await parseBody(req) as { name?: string; instructions?: string; model?: string };
      const result = await agentRoutes.patchAgent(pool, segments[1], body);
      sendJson(res, 200, result);
      return;
    }

    // Chat routes
    if (path === "/chats" && method === "GET") {
      const workspaces = await workspaceRoutes.listWorkspaces(pool, userId);
      const wsId = workspaces[0]?.id;
      const result = wsId ? await chatRoutes.listChats(pool, wsId) : [];
      sendJson(res, 200, result);
      return;
    }
    if (segments[0] === "chats" && segments.length === 2 && method === "GET") {
      await requireOwnedChat(pool, segments[1], userId);
      const result = await chatRoutes.getChat(pool, segments[1]);
      sendJson(res, 200, result);
      return;
    }
    if (path === "/chats" && method === "POST") {
      const body = await parseBody(req) as { workspaceId: string; agentId: string; title: string; goal?: string };
      await requireOwnedWorkspace(pool, body.workspaceId, userId);
      await requireOwnedAgent(pool, body.agentId, userId);
      const result = await chatRoutes.createChat(pool, body);
      sendJson(res, 201, result);
      return;
    }
    if (segments[0] === "chats" && segments.length === 2 && method === "PATCH") {
      await requireOwnedChat(pool, segments[1], userId);
      const body = await parseBody(req) as { title?: string; goal?: string };
      const result = await chatRoutes.patchChat(pool, segments[1], body);
      sendJson(res, 200, result);
      return;
    }
    if (segments[0] === "chats" && segments[2] === "messages" && segments.length === 3 && method === "GET") {
      await requireOwnedChat(pool, segments[1], userId);
      const cursor = query.get("cursor") ?? undefined;
      const result = await chatRoutes.listMessages(pool, segments[1], { cursor });
      sendJson(res, 200, result);
      return;
    }
    if (segments[0] === "chats" && segments[2] === "messages" && segments.length === 3 && method === "POST") {
      await requireOwnedChat(pool, segments[1], userId);
      const body = await parseBody(req) as { content: string };
      const { userMessage, triggerId } = await chatRoutes.sendMessage(pool, segments[1], body, emitEvent);

      // Fire the pending trigger message (messages-as-truth path) and
      // schedule an ai-note refresh for this chat.
      runManager.fireMessage(triggerId).catch((err) => {
        // eslint-disable-next-line no-console
        console.error(`fireMessage for trigger ${triggerId} failed:`, err);
      });
      runManager.scheduleAiNote(segments[1]).catch(() => {});

      sendJson(res, 201, userMessage);
      return;
    }
    if (segments[0] === "chats" && segments[2] === "messages" && segments.length === 4 && method === "PATCH") {
      await requireOwnedMessage(pool, segments[1], segments[3], userId);
      const body = await parseBody(req) as { content?: unknown; state?: string; executeAt?: string | null; cron?: string | null };
      const result = await chatRoutes.patchMessage(pool, storage, segments[1], segments[3], body, emitEvent);
      sendJson(res, 200, result);
      return;
    }
    if (segments[0] === "chats" && segments[2] === "messages" && segments[4] === "note-history" && segments.length === 5 && method === "GET") {
      await requireOwnedMessage(pool, segments[1], segments[3], userId);
      const result = await chatRoutes.getNoteHistory(storage, segments[1], segments[3]);
      sendJson(res, 200, result);
      return;
    }
    if (segments[0] === "chats" && segments[2] === "messages" && segments.length === 4 && method === "DELETE") {
      await requireOwnedMessage(pool, segments[1], segments[3], userId);
      await chatRoutes.deleteMessage(pool, storage, segments[1], segments[3], runManager.adapter);
      sendJson(res, 200, { ok: true });
      return;
    }
    if (segments[0] === "chats" && segments[2] === "messages" && segments[4] === "logs" && segments.length === 5 && method === "GET") {
      await requireOwnedMessage(pool, segments[1], segments[3], userId);
      const { stream, contentType } = await chatRoutes.getMessageLogs(storage, segments[1], segments[3]);
      res.writeHead(200, { "Content-Type": contentType });
      stream.pipe(res);
      return;
    }
    if (segments[0] === "chats" && segments[2] === "artifacts" && segments.length === 3 && method === "GET") {
      await requireOwnedChat(pool, segments[1], userId);
      const result = await chatRoutes.listArtifacts(storage, segments[1]);
      sendJson(res, 200, result);
      return;
    }
    if (segments[0] === "chats" && segments[2] === "artifacts" && segments.length === 3 && method === "POST") {
      await requireOwnedChat(pool, segments[1], userId);
      const form = await parseMultipart(req);
      const part = form.get("file");
      if (!(part instanceof Blob)) {
        throw new ValidationError("Missing 'file' part in multipart body");
      }
      const name = (part as File).name || (typeof form.get("name") === "string" ? (form.get("name") as string) : "upload");
      const mime = part.type || "application/octet-stream";
      const content = Buffer.from(await part.arrayBuffer());
      const result = await chatRoutes.uploadArtifactToChat(
        storage,
        segments[1],
        { name, mime, content },
        emitEvent,
      );
      sendJson(res, 201, result);
      return;
    }

    // Library routes. Because library files live at arbitrary nested paths
    // on the filesystem, we pass the workspace-relative path via ?path=...
    // query parameter rather than embedding it in the URL path — simpler to
    // parse and no URL-encoding of slashes.
    if (path === "/library" && method === "GET") {
      const workspaces = await workspaceRoutes.listWorkspaces(pool, userId);
      const wsId = workspaces[0]?.id;
      const cursor = query.get("cursor") ?? undefined;
      const limit = query.get("limit") ? parseInt(query.get("limit")!) : undefined;
      const result = wsId ? await libraryRoutes.list(storage, wsId, { cursor, limit }) : { items: [] };
      sendJson(res, 200, result);
      return;
    }
    if (path === "/library" && method === "POST") {
      const form = await parseMultipart(req);
      const part = form.get("file");
      if (!(part instanceof Blob)) {
        throw new ValidationError("Missing 'file' part in multipart body");
      }
      const name = (part as File).name || (typeof form.get("name") === "string" ? (form.get("name") as string) : "upload");
      const mime = part.type || "application/octet-stream";
      const stream = (await import("node:stream")).Readable.from(Buffer.from(await part.arrayBuffer()));
      const workspaces = await workspaceRoutes.listWorkspaces(pool, userId);
      const wsId = workspaces[0]?.id ?? "";
      const result = await libraryRoutes.upload(storage, wsId, { name, mime, stream }, emitEvent);
      sendJson(res, 201, result);
      return;
    }
    if (path === "/library/meta" && method === "GET") {
      const p = query.get("path");
      if (!p) throw new ValidationError("Missing path query parameter");
      const result = await libraryRoutes.get(storage, p);
      sendJson(res, 200, result);
      return;
    }
    if (path === "/library/download" && method === "GET") {
      const p = query.get("path");
      if (!p) throw new ValidationError("Missing path query parameter");
      const { stream, file } = await libraryRoutes.download(storage, p);
      res.writeHead(200, {
        "Content-Type": file.mime,
        "Content-Disposition": `attachment; filename="${file.name}"`,
      });
      stream.pipe(res);
      return;
    }
    if (path === "/library" && method === "DELETE") {
      const p = query.get("path");
      if (!p) throw new ValidationError("Missing path query parameter");
      const workspaces = await workspaceRoutes.listWorkspaces(pool, userId);
      const wsId = workspaces[0]?.id ?? "";
      await libraryRoutes.remove(storage, wsId, p, emitEvent);
      sendJson(res, 200, { ok: true });
      return;
    }

    // Legacy /runs and /scheduled-jobs routes are gone — chat-scoped
    // execution state now lives on the messages table; use
    // GET /chats/{id}/messages and its PATCH/DELETE/logs sub-routes.

    // Tools (host-initiated sandbox queries)
    if (path === "/tools/models" && method === "GET") {
      const result = await toolRoutes.listModels(pool, {
        provider: query.get("provider") ?? undefined,
      });
      sendJson(res, 200, result);
      return;
    }

    // Search
    if (path === "/search" && method === "GET") {
      const q = query.get("q") ?? "";
      const scope = (query.get("scope") ?? "all") as "artifacts" | "chats" | "library" | "all";
      const result = await searchRoutes.search(pool, storage, q, scope);
      sendJson(res, 200, result);
      return;
    }

    // OpenAPI spec
    if (path === "/openapi.json" && method === "GET") {
      sendJson(res, 200, openApiSpec);
      return;
    }

    // Fallback
    sendJson(res, 404, { code: "NOT_FOUND", message: "Not found" });
  }

  return server;
}
