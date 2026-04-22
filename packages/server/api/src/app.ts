import { createServer as httpCreateServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { createHash } from "node:crypto";
import pg from "pg";
import { DeskError, type WsEvent } from "@desk/shared";
import type { StorageContext } from "@desk/storage";
import type { createRunManager } from "@desk/scheduler";
import { requireAuth } from "./auth/middleware.js";
import { verifySession } from "./auth/sessions.js";
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
import * as runRoutes from "./routes/runs.js";
import * as searchRoutes from "./routes/search.js";

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

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString()));
    req.on("error", reject);
  });
}

async function parseBody(req: IncomingMessage): Promise<unknown> {
  const raw = await readBody(req);
  if (!raw) return {};
  return JSON.parse(raw);
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
      const body = await parseBody(req) as { newPassword: string };
      const result = await accountRoutes.changePassword(pool, userId, body);
      sendJson(res, 200, result);
      return;
    }

    // Workspace routes
    if (path === "/workspaces" && method === "GET") {
      const result = await workspaceRoutes.listWorkspaces(pool);
      sendJson(res, 200, result);
      return;
    }
    if (segments[0] === "workspaces" && segments.length === 2 && method === "GET") {
      const result = await workspaceRoutes.getWorkspace(pool, segments[1]);
      sendJson(res, 200, result);
      return;
    }
    if (segments[0] === "workspaces" && segments.length === 2 && method === "PATCH") {
      const body = await parseBody(req) as { name?: string; description?: string; icon?: string };
      const result = await workspaceRoutes.patchWorkspace(pool, segments[1], body);
      sendJson(res, 200, result);
      return;
    }
    if (segments[0] === "workspaces" && segments.length === 2 && method === "DELETE") {
      const result = await workspaceRoutes.deleteWorkspace(pool, segments[1]);
      sendJson(res, 200, result);
      return;
    }

    // Agent routes
    if (path === "/agents" && method === "GET") {
      const result = await agentRoutes.listAgents(pool);
      sendJson(res, 200, result);
      return;
    }
    if (segments[0] === "agents" && segments.length === 2 && method === "GET") {
      const result = await agentRoutes.getAgent(pool, segments[1]);
      sendJson(res, 200, result);
      return;
    }
    if (segments[0] === "agents" && segments.length === 2 && method === "PATCH") {
      const body = await parseBody(req) as { name?: string; instructions?: string; model?: string };
      const result = await agentRoutes.patchAgent(pool, segments[1], body);
      sendJson(res, 200, result);
      return;
    }

    // Chat routes
    if (path === "/chats" && method === "GET") {
      const workspaces = await workspaceRoutes.listWorkspaces(pool);
      const wsId = workspaces[0]?.id;
      const result = wsId ? await chatRoutes.listChats(pool, wsId) : [];
      sendJson(res, 200, result);
      return;
    }
    if (segments[0] === "chats" && segments.length === 2 && method === "GET") {
      const result = await chatRoutes.getChat(pool, segments[1]);
      sendJson(res, 200, result);
      return;
    }
    if (path === "/chats" && method === "POST") {
      const body = await parseBody(req) as { workspaceId: string; agentId: string; title: string; goal?: string };
      const result = await chatRoutes.createChat(pool, body);
      sendJson(res, 201, result);
      return;
    }
    if (segments[0] === "chats" && segments.length === 2 && method === "PATCH") {
      const body = await parseBody(req) as { title?: string; goal?: string };
      const result = await chatRoutes.patchChat(pool, segments[1], body);
      sendJson(res, 200, result);
      return;
    }
    if (segments[0] === "chats" && segments[2] === "messages" && segments.length === 3 && method === "GET") {
      const cursor = query.get("cursor") ?? undefined;
      const result = await chatRoutes.listMessages(pool, segments[1], { cursor });
      sendJson(res, 200, result);
      return;
    }
    if (segments[0] === "chats" && segments[2] === "messages" && segments.length === 3 && method === "POST") {
      const body = await parseBody(req) as { content: string };
      const result = await chatRoutes.sendMessage(pool, segments[1], body, emitEvent);

      // Trigger immediate run + AI note
      runManager.enqueueRun({
        chatId: segments[1],
        prompt: body.content,
        mode: "immediate",
      }).catch(() => {});

      runManager.scheduleAiNote(segments[1]).catch(() => {});

      sendJson(res, 201, result);
      return;
    }
    if (segments[0] === "chats" && segments[2] === "artifacts" && segments.length === 3 && method === "GET") {
      const result = await chatRoutes.listArtifacts(pool, segments[1]);
      sendJson(res, 200, result);
      return;
    }
    if (segments[0] === "chats" && segments[2] === "artifacts" && segments.length === 3 && method === "POST") {
      const body = await parseBody(req) as { name: string; mime: string; contentBase64: string };
      const result = await chatRoutes.uploadArtifactToChat(storage, segments[1], body, emitEvent);
      sendJson(res, 201, result);
      return;
    }

    // Library routes
    if (path === "/library" && method === "GET") {
      const workspaces = await workspaceRoutes.listWorkspaces(pool);
      const wsId = workspaces[0]?.id;
      const cursor = query.get("cursor") ?? undefined;
      const limit = query.get("limit") ? parseInt(query.get("limit")!) : undefined;
      const result = wsId ? await libraryRoutes.list(storage, wsId, { cursor, limit }) : { items: [] };
      sendJson(res, 200, result);
      return;
    }
    if (path === "/library" && method === "POST") {
      const body = await parseBody(req) as { name: string; mime: string; contentBase64: string };
      const workspaces = await workspaceRoutes.listWorkspaces(pool);
      const wsId = workspaces[0]?.id ?? "";
      const result = await libraryRoutes.upload(storage, wsId, body, emitEvent);
      sendJson(res, 201, result);
      return;
    }
    if (segments[0] === "library" && segments.length === 2 && method === "GET") {
      const result = await libraryRoutes.get(pool, segments[1]);
      sendJson(res, 200, result);
      return;
    }
    if (segments[0] === "library" && segments[2] === "download" && segments.length === 3 && method === "GET") {
      const { stream, file } = await libraryRoutes.download(storage, segments[1]);
      res.writeHead(200, {
        "Content-Type": file.mime,
        "Content-Disposition": `attachment; filename="${file.name}"`,
      });
      stream.pipe(res);
      return;
    }
    if (segments[0] === "library" && segments[2] === "note" && segments.length === 3 && method === "POST") {
      const body = await parseBody(req) as { text: string };
      const result = await libraryRoutes.createNote(storage, segments[1], body, emitEvent);
      sendJson(res, 201, result);
      return;
    }
    if (segments[0] === "library" && segments.length === 2 && method === "DELETE") {
      await libraryRoutes.remove(storage, segments[1], emitEvent);
      sendJson(res, 200, { ok: true });
      return;
    }

    // Run routes
    if (path === "/runs" && method === "GET") {
      const result = await runRoutes.listRuns(pool);
      sendJson(res, 200, result);
      return;
    }
    if (segments[0] === "runs" && segments.length === 2 && method === "GET") {
      const result = await runRoutes.getRun(pool, segments[1]);
      sendJson(res, 200, result);
      return;
    }
    if (segments[0] === "runs" && segments[2] === "logs" && segments.length === 3 && method === "GET") {
      const cursor = query.get("cursor") ? parseInt(query.get("cursor")!) : undefined;
      const result = await runRoutes.getRunLogs(pool, segments[1], { cursor });
      sendJson(res, 200, result);
      return;
    }
    if (segments[0] === "runs" && segments[2] === "cancel" && segments.length === 3 && method === "POST") {
      const result = await runRoutes.cancelRun(runManager, segments[1]);
      sendJson(res, 200, result);
      return;
    }
    if (path === "/scheduled-jobs" && method === "GET") {
      const result = await runRoutes.listScheduledJobs(pool);
      sendJson(res, 200, result);
      return;
    }
    if (path === "/scheduled-jobs" && method === "POST") {
      const body = await parseBody(req) as { chatId?: string; prompt: string; mode: "scheduled" | "recurring"; spec: string };
      const result = await runRoutes.createScheduledJob(runManager, body);
      sendJson(res, 201, result);
      return;
    }
    if (segments[0] === "scheduled-jobs" && segments.length === 2 && method === "DELETE") {
      const result = await runRoutes.deleteScheduledJob(runManager, segments[1]);
      sendJson(res, 200, result);
      return;
    }

    // Search
    if (path === "/search" && method === "GET") {
      const q = query.get("q") ?? "";
      const scope = (query.get("scope") ?? "all") as "artifacts" | "chats" | "library" | "all";
      const result = await searchRoutes.search(pool, q, scope);
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
