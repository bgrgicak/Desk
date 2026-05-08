import { createReadStream } from "node:fs";
import { createServer as httpCreateServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { createHash } from "node:crypto";
import { mkdir as fsMkdir, realpath as fsRealpath, stat as fsStat } from "node:fs/promises";
import { dirname as pathDirname, extname as pathExtname, join as pathJoin, normalize as pathNormalize, sep as pathSep } from "node:path";
import { type Pool } from "@agent-desk/db";
import { queries } from "@agent-desk/db";
import { DeskError, NotFoundError, UnauthorizedError, ValidationError, type WsEvent } from "@agent-desk/shared";
import {
  chatArtifactsDir,
  ReplaceLibraryAppConflictError,
  resolveHostPath,
  workspaceRootPath,
  type StorageContext,
} from "@agent-desk/storage";
import type { createRunManager } from "@agent-desk/scheduler";
import { requireAuth, recordClientTimezone } from "./auth/middleware.js";
import { requireInternal } from "./auth/internal.js";
import { authenticateSandboxToken } from "./auth/sandboxToken.js";
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
import { isStaticPath, resolveAppDist, serveStaticOrIndex } from "./static-app.js";
import * as authRoutes from "./routes/auth.js";
import * as accountRoutes from "./routes/account.js";
import * as workspaceRoutes from "./routes/workspaces.js";
import * as agentRoutes from "./routes/agents.js";
import * as chatRoutes from "./routes/chats.js";
import * as libraryRoutes from "./routes/library.js";
import * as messageRoutes from "./routes/messages.js";
import * as searchRoutes from "./routes/search.js";
import * as toolRoutes from "./routes/tools.js";
import * as appsRoutes from "./routes/apps.js";
import { handleAppStorageRequest } from "./routes/app-storage.js";
import {
  requireLibraryPathInWorkspace,
  parseReadableChatArtifactPath,
  requireReadablePathInWorkspace,
  requireWorkspaceId,
  resolveWorkspaceId,
} from "./workspace-scope.js";

type RunManager = ReturnType<typeof createRunManager>;

const SEARCH_SCOPES = new Set(["all", "artifacts", "chats", "library", "files"]);
const SEARCH_KINDS = new Set(["chat", "message", "summary", "library_file", "attachment", "artifact"]);
type SearchScope = "artifacts" | "chats" | "library" | "files" | "all";
type SearchKind = "chat" | "message" | "summary" | "library_file" | "attachment" | "artifact";

function parseSearchScope(raw: string | null): SearchScope {
  const scope = raw ?? "all";
  if (!SEARCH_SCOPES.has(scope)) throw new ValidationError(`Invalid search scope: ${scope}`);
  return scope as SearchScope;
}

function parseSearchKinds(raw: string | null): SearchKind[] | undefined {
  if (!raw) return undefined;
  const kinds = raw.split(",").map((kind) => kind.trim()).filter(Boolean);
  for (const kind of kinds) {
    if (!SEARCH_KINDS.has(kind)) throw new ValidationError(`Invalid search kind: ${kind}`);
  }
  return kinds as SearchKind[];
}

export interface AppOptions {
  pool: Pool;
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

/**
 * The /apps/* dispatcher's `issue` endpoint runs after requireAuth has
 * already let the path through (no global Bearer check on /apps/*). This
 * helper re-applies the Bearer check locally so the issue endpoint
 * cannot mint app-session tokens without a valid user session.
 */
async function requireBearerForApps(pool: Pool, req: IncomingMessage): Promise<string> {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith("Bearer ")) {
    throw new UnauthorizedError("Missing or invalid Authorization header");
  }
  const userId = await verifySession(pool, auth.slice(7));
  if (!userId) {
    throw new UnauthorizedError("Invalid or expired session token");
  }
  return userId;
}

async function requireReadablePathForRoute(
  pool: Pool,
  storage: StorageContext,
  userId: string,
  relPath: string,
  workspaceId: string,
): Promise<void> {
  await requireReadablePathInWorkspace(pool, userId, relPath, workspaceId);
  const artifact = parseReadableChatArtifactPath(relPath);
  if (!artifact) return;

  const { rows: chatRows } = await pool.query<{ workspace_id: string }>(
    "SELECT workspace_id FROM chats WHERE id = ?",
    [artifact.chatId],
  );
  if (chatRows[0]?.workspace_id !== workspaceId) {
    throw new NotFoundError(`File not found: ${relPath}`);
  }

  const { rows } = await pool.query<{ path: string }>(
    "SELECT path FROM workspaces WHERE id = ?",
    [workspaceId],
  );
  const workspaceSlug = rows[0]?.path;
  if (!workspaceSlug) throw new NotFoundError(`Workspace not found: ${workspaceId}`);

  const artifactRoot = chatArtifactsDir(storage.home, workspaceSlug, artifact.chatId);
  const workspaceRoot = workspaceRootPath(storage.home, workspaceSlug);
  const target = resolveHostPath(storage.home, workspaceSlug, relPath);
  let realWorkspaceRoot: string;
  let realRoot: string;
  let realTarget: string;
  try {
    [realWorkspaceRoot, realRoot, realTarget] = await Promise.all([
      fsRealpath(workspaceRoot),
      fsRealpath(artifactRoot),
      fsRealpath(target),
    ]);
  } catch {
    throw new NotFoundError(`File not found: ${relPath}`);
  }
  if (realRoot !== realWorkspaceRoot && !realRoot.startsWith(realWorkspaceRoot + pathSep)) {
    throw new NotFoundError(`File not found: ${relPath}`);
  }
  if (realTarget !== realRoot && !realTarget.startsWith(realRoot + pathSep)) {
    throw new NotFoundError(`File not found: ${relPath}`);
  }
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
 * Default destination for `/internal/backup`. Lands next to the live DB
 * inside `~/Desk/backups/` so file ownership matches the DB and the
 * directory is included in any host-level backup of `~/Desk`. Uses
 * UTC date so multi-region rsync targets don't fight over filenames.
 */
function defaultBackupPath(deskHome: string): string {
  const ts = new Date().toISOString().replace(/[:T]/g, "-").slice(0, 19);
  return pathJoin(deskHome, "Desk", "backups", `desk-${ts}.sqlite3`);
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

  // SPA static-serve is opt-in via DESK_SERVE_APP=1 — the CLI flips this
  // for published installs, dev never does (Vite serves the SPA on :5173
  // and proxies /api/* here). When off, the request handler skips the
  // static branch entirely and behaves identically to the pre-§3 server.
  const serveApp = process.env.DESK_SERVE_APP === "1";
  const appDist = serveApp ? resolveAppDist() : null;

  const server = httpCreateServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const rawPath = url.pathname;
      const method = req.method ?? "GET";

      // SPA static-serve: GETs that aren't API/WS/internal/sandbox routes
      // get the SPA. No auth — these are the unauthenticated assets the
      // browser fetches before login (index.html, JS bundles, fonts).
      if (serveApp && appDist && method === "GET" && isStaticPath(rawPath)) {
        await serveStaticOrIndex(rawPath, res, appDist);
        return;
      }

      // Strip the /api/ prefix the SPA's RTK Query baseUrl carries. In
      // dev, Vite rewrites this away before the request reaches us; in
      // prod the server itself does it so internal route handlers see
      // the same path shape in both modes.
      const path = rawPath.startsWith("/api/")
        ? rawPath.slice(4)
        : rawPath === "/api"
          ? "/"
          : rawPath;

      // Auth
      let userId: string;
      try {
        // For /apps/* routes the client is an iframe that can't send custom
        // headers. Allow the session token via the ?token= query param as a
        // fallback, the same pattern used by the WebSocket upgrade.
        // For /apps/* routes the client is an iframe. The initial index.html
        // request carries ?token= but sub-resource requests (JS/CSS) do not.
        // We accept the token from:
        //   1. The Authorization header (normal API calls)
        //   2. The ?token= query param (initial iframe navigation)
        //   3. The `desk-app-token` cookie set when index.html was served
        let appsTokenHeader = req.headers.authorization;
        if (!appsTokenHeader && path.startsWith("/apps/")) {
          const queryToken = url.searchParams.get("token");
          if (queryToken) {
            appsTokenHeader = `Bearer ${queryToken}`;
          } else {
            // Parse cookies manually (no dependency needed)
            const cookieHeader = req.headers.cookie ?? "";
            const cookieToken = cookieHeader
              .split(";")
              .map((c) => c.trim())
              .find((c) => c.startsWith("desk-app-token="))
              ?.slice("desk-app-token=".length);
            if (cookieToken) appsTokenHeader = `Bearer ${decodeURIComponent(cookieToken)}`;
          }
        }
        userId = await requireAuth(pool, path, appsTokenHeader);
      } catch (err) {
        if (err instanceof DeskError) {
          sendJson(res, errorToStatus(err), { code: err.code, message: err.message });
        } else {
          sendJson(res, 500, { code: "INTERNAL", message: "Internal error" });
        }
        return;
      }

      // Self-healing timezone: every authed request carries X-Client-Timezone
      // from the app; the helper UPDATEs only when it drifts. Failure is
      // non-fatal — never block a real request because the timezone write
      // hiccuped.
      recordClientTimezone(pool, userId, req.headers["x-client-timezone"]).catch((err) => {
        // eslint-disable-next-line no-console
        console.warn("recordClientTimezone failed:", err);
      });

      const segments = path.split("/").filter(Boolean);
      const params: RouteParams = { path, segments, userId, query: url.searchParams };

      // Route dispatch
      await dispatch(method, params, req, res);
    } catch (err) {
      if (err instanceof appsRoutes.IssueRateLimitError) {
        // Rate-limit response carries Retry-After so the parent SPA can
        // back off cleanly instead of hammering the endpoint.
        res.setHeader("Retry-After", String(err.retryAfterSeconds));
        sendJson(res, 429, {
          code: "RATE_LIMITED",
          message: err.message,
          retryAfterSeconds: err.retryAfterSeconds,
        });
      } else if (err instanceof DeskError) {
        sendJson(res, errorToStatus(err), { code: err.code, message: err.message });
      } else {
        console.error("Unhandled error:", err);
        sendJson(res, 500, { code: "INTERNAL", message: "Internal server error" });
      }
    }
  });

  // WebSocket upgrade handler
  server.on("upgrade", (req, socket, head) => {
    void (async () => {
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

    const userId = await verifySession(pool, token);
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
    })().catch((err) => {
      console.error("WebSocket upgrade failed:", err);
      try { socket.destroy(); } catch { /* ignore */ }
    });
  });

  async function dispatch(method: string, params: RouteParams, req: IncomingMessage, res: ServerResponse): Promise<void> {
    const { segments, userId, query } = params;
    const path = params.path;

    // Health check — confirms the server is up.
    if (path === "/" && method === "GET") {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("hello world");
      return;
    }

    // Online backup. The pool opens its DB with locking_mode=EXCLUSIVE,
    // which blocks other connections (including a host-side
    // `sqlite3 .backup` CLI) from opening the file. `VACUUM INTO` runs
    // on the existing connection, produces a checkpointed snapshot,
    // and works while the server is up — exactly what BACKUP.md needs.
    //
    // Path defaults to ${DESK_HOME}/Desk/backups/desk-<ISO date>.sqlite3
    // (alongside the live DB, on the host mount). Request body may
    // override with `{ "path": "..." }`; the path must not already
    // exist (VACUUM INTO refuses to overwrite).
    if (path === "/internal/backup" && method === "POST") {
      requireInternal(req);
      const body = await parseBody(req) as { path?: string };
      const targetPath = body.path ?? defaultBackupPath(storage.home);
      const targetDir = pathDirname(targetPath);
      await fsMkdir(targetDir, { recursive: true });
      pool.exec(`VACUUM INTO '${targetPath.replace(/'/g, "''")}'`);
      const stat = await fsStat(targetPath);
      sendJson(res, 200, { ok: true, path: targetPath, sizeBytes: stat.size });
      return;
    }

    // Per-app storage routes (PR-H). Match before the static-app
    // dispatcher so a request to `.../storage/...` doesn't get caught
    // by the dist-serve branch.
    if (segments[0] === "apps" && segments.includes("storage")) {
      const handled = await handleAppStorageRequest(
        pool,
        storage,
        segments,
        method,
        req,
        res,
      );
      if (handled) return;
    }

    // Static-app routes — `/apps/chat/:chatId/:appName/dist/*` and the
    // companion `POST /apps/chat/:chatId/:appName/issue` mint-token
    // endpoint. Auth: the static GET path validates a per-app HttpOnly
    // cookie issued on first load; the issue endpoint re-validates the
    // user's bearer session directly because requireAuth let it through.
    if (segments[0] === "apps" && segments[1] === "chat" && segments.length >= 4) {
      if (
        method === "POST" &&
        segments.length === 5 &&
        segments[4] === "issue"
      ) {
        const issuerId = await requireBearerForApps(pool, req);
        const chatId = decodeURIComponent(segments[2]);
        const appName = decodeURIComponent(segments[3]);
        const result = await appsRoutes.handleIssueAppSession(
          pool,
          storage,
          issuerId,
          chatId,
          appName,
        );
        sendJson(res, 201, result);
        return;
      }
      if (
        method === "DELETE" &&
        segments.length === 4
      ) {
        // PR-E: delete a chat-artifact `<name>.app/`. Cascade-revokes any
        // active app_sessions bound to (chatId, appName). The .storage/
        // SQLite file goes with the directory.
        const issuerId = await requireBearerForApps(pool, req);
        const chatId = decodeURIComponent(segments[2]);
        const appName = decodeURIComponent(segments[3]);
        await requireOwnedChat(pool, chatId, issuerId);
        await chatRoutes.removeChatApp(storage, chatId, appName, emitEvent);
        sendJson(res, 200, { ok: true });
        return;
      }
      if (method === "GET" && segments.length >= 5 && segments[4] === "dist") {
        const handled = await appsRoutes.handleStaticAppRequest(
          pool,
          storage,
          segments,
          new URL(req.url ?? "/", "http://localhost"),
          req,
          res,
        );
        if (handled) return;
      }
    }

    // Library-scoped variant: /apps/library/:appName/dist/* and the
    // companion `POST /apps/library/:appName/issue` (PR-E).
    if (segments[0] === "apps" && segments[1] === "library" && segments.length >= 3) {
      if (
        method === "POST" &&
        segments.length === 4 &&
        segments[3] === "issue"
      ) {
        const issuerId = await requireBearerForApps(pool, req);
        const appName = decodeURIComponent(segments[2]);
        const result = await appsRoutes.handleIssueLibraryAppSession(
          pool,
          storage,
          issuerId,
          appName,
          {
            workspaceId: query.get("workspaceId") ?? undefined,
            appPath: query.get("path") ?? undefined,
          },
        );
        sendJson(res, 201, result);
        return;
      }
      if (method === "DELETE" && segments.length === 3) {
        // PR-E: delete a library `<name>.app/` (moves it to .trash for
        // recovery) and revoke all sessions for that app. Library scope
        // doesn't include a sub-path: the route deletes the
        // workspace-root `<appName>.app/`. Library apps under a
        // subfolder are deleted via the generic library-delete path.
        const issuerId = await requireBearerForApps(pool, req);
        const appName = decodeURIComponent(segments[2]);
        await chatRoutes.removeLibraryApp(storage, issuerId, appName, emitEvent);
        sendJson(res, 200, { ok: true });
        return;
      }
      if (method === "GET") {
        const handled = await appsRoutes.handleStaticLibraryAppRequest(
          pool,
          storage,
          segments,
          new URL(req.url ?? "/", "http://localhost"),
          req,
          res,
        );
        if (handled) return;
      }
    }

    // Sandbox routes — called by `desk` CLI from inside an OpenCode run.
    // Auth is X-Desk-Sandbox-Token; the token resolves to (session, agent),
    // and we use the agent's userId to gate the chat ownership check.
    if (path === "/sandbox/messages" && method === "POST") {
      const tokenHeader = req.headers["x-desk-sandbox-token"];
      const token = Array.isArray(tokenHeader) ? tokenHeader[0] : tokenHeader;
      const { agent } = await authenticateSandboxToken(pool, token);
      const body = await parseBody(req) as { chatId?: string } & Record<string, unknown>;
      if (!body.chatId || typeof body.chatId !== "string") {
        throw new ValidationError("Missing chatId");
      }
      const chatId = body.chatId;
      await requireOwnedChat(pool, chatId, agent.userId);

      // Default kind = "task" for sandbox-issued messages: the agent calls
      // this from `desk-agent task schedule`, so a chat reply isn't the intent.
      // Caller can still override (e.g. kind="summary") if they have a
      // reason to.
      const sendBody = { kind: "task", ...body };
      delete (sendBody as { chatId?: string }).chatId;

      const { userMessage } = await chatRoutes.sendMessage(pool, chatId, sendBody, emitEvent, { role: "agent" });
      sendJson(res, 201, userMessage);
      return;
    }

    // Memory-system P3.5 — full-text search for the in-sandbox agent.
    // Auth is X-Desk-Sandbox-Token. Recall is scoped to the sandbox
    // session's workspace; cross-workspace recall requires a future
    // explicit home-workspace exception, not workspace=*.
    if (path === "/sandbox/search/messages" && method === "GET") {
      const tokenHeader = req.headers["x-desk-sandbox-token"];
      const token = Array.isArray(tokenHeader) ? tokenHeader[0] : tokenHeader;
      const { session, agent } = await authenticateSandboxToken(pool, token);
      const params = new URL(req.url ?? "/", "http://localhost").searchParams;
      const q = params.get("q") ?? params.get("query") ?? "";
      const chatIdParam = params.get("chat") ?? undefined;
      const workspaceParam = params.get("workspace") ?? undefined;
      const kindParam = params.get("kind") ?? "any";
      const limitParam = Number.parseInt(params.get("limit") ?? "25", 10);

      if (!session.workspaceId) {
        throw new NotFoundError("Workspace not found for sandbox session");
      }
      const ws = await queries.workspaces.findById(pool, session.workspaceId);
      if (!ws || ws.userId !== agent.userId) {
        throw new NotFoundError(`Workspace not found: ${session.workspaceId}`);
      }
      if (workspaceParam && workspaceParam !== ws.path && workspaceParam !== "*") {
        throw new NotFoundError(`Workspace not found: ${workspaceParam}`);
      }

      // When chatId is supplied, gate ownership.
      if (chatIdParam) {
        const chat = await requireOwnedChat(pool, chatIdParam, agent.userId);
        if (chat.workspaceId !== session.workspaceId) {
          throw new NotFoundError(`Chat not found: ${chatIdParam}`);
        }
      }

      const hits = await queries.search.searchChatMessages(pool, {
        query: q,
        chatId: chatIdParam,
        workspaceSlug: ws.path,
        kind: kindParam === "message" || kindParam === "summary" ? kindParam : "any",
        limit: Number.isFinite(limitParam) && limitParam > 0 ? Math.min(limitParam, 100) : 25,
      });

      sendJson(res, 200, { hits });
      return;
    }

    if (path === "/sandbox/search" && method === "GET") {
      const tokenHeader = req.headers["x-desk-sandbox-token"];
      const token = Array.isArray(tokenHeader) ? tokenHeader[0] : tokenHeader;
      const { session, agent } = await authenticateSandboxToken(pool, token);
      const params = new URL(req.url ?? "/", "http://localhost").searchParams;
      const q = params.get("q") ?? params.get("query") ?? "";
      const workspaceParam = params.get("workspace") ?? undefined;
      const ownedWorkspaces = await queries.workspaces.listByUser(pool, agent.userId);
      if (!session.workspaceId) {
        throw new NotFoundError("Workspace not found for sandbox session");
      }
      const sessionWorkspace = ownedWorkspaces.find((w) => w.id === session.workspaceId);
      if (!sessionWorkspace) {
        throw new NotFoundError(`Workspace not found: ${session.workspaceId}`);
      }
      if (
        workspaceParam &&
        workspaceParam !== "*" &&
        workspaceParam !== sessionWorkspace.path &&
        workspaceParam !== sessionWorkspace.id
      ) {
        throw new NotFoundError(`Workspace not found: ${workspaceParam}`);
      }
      const result = await searchRoutes.search(
        pool,
        storage,
        agent.userId,
        q,
        parseSearchScope(params.get("scope")),
        {
          workspaceId: sessionWorkspace.id,
          chatId: params.get("chatId") ?? params.get("chat") ?? undefined,
          kinds: parseSearchKinds(params.get("kind")),
          showHidden: params.get("showHidden") === "true",
        },
      );
      sendJson(res, 200, { hits: result });
      return;
    }

    if ((path === "/sandbox/find/library" || path === "/sandbox/find/artifacts") && method === "GET") {
      const tokenHeader = req.headers["x-desk-sandbox-token"];
      const token = Array.isArray(tokenHeader) ? tokenHeader[0] : tokenHeader;
      const { session, agent } = await authenticateSandboxToken(pool, token);
      const params = new URL(req.url ?? "/", "http://localhost").searchParams;
      const workspaceParam = params.get("workspace") ?? undefined;
      const ownedWorkspaces = await queries.workspaces.listByUser(pool, agent.userId);
      if (!session.workspaceId) {
        throw new NotFoundError("Workspace not found for sandbox session");
      }
      const sessionWorkspace = ownedWorkspaces.find((w) => w.id === session.workspaceId);
      if (!sessionWorkspace) {
        throw new NotFoundError(`Workspace not found: ${session.workspaceId}`);
      }
      if (
        workspaceParam &&
        workspaceParam !== "*" &&
        workspaceParam !== sessionWorkspace.path &&
        workspaceParam !== sessionWorkspace.id
      ) {
        throw new NotFoundError(`Workspace not found: ${workspaceParam}`);
      }
      const kindParam = params.get("kind") ?? "any";
      const limitParam = Number.parseInt(params.get("limit") ?? "25", 10);
      const result = await searchRoutes.findLibraryItems(pool, storage, agent.userId, {
        query: params.get("q") ?? params.get("query") ?? undefined,
        kind:
          kindParam === "app" || kindParam === "fragment" || kindParam === "note" || kindParam === "doc"
            ? kindParam
            : "any",
        workspaceId: sessionWorkspace.id,
        limit: Number.isFinite(limitParam) && limitParam > 0 ? Math.min(limitParam, 100) : 25,
      });
      sendJson(res, 200, { hits: result });
      return;
    }

    if (path === "/sandbox/artifacts" && method === "POST") {
      const tokenHeader = req.headers["x-desk-sandbox-token"];
      const token = Array.isArray(tokenHeader) ? tokenHeader[0] : tokenHeader;
      const { session, agent } = await authenticateSandboxToken(pool, token);
      const body = await parseBody(req) as { chatId?: string } & Record<string, unknown>;
      if (!body.chatId || typeof body.chatId !== "string") {
        throw new ValidationError("Missing chatId");
      }
      const chat = await requireOwnedChat(pool, body.chatId, agent.userId);
      if (session.workspaceId && chat.workspaceId !== session.workspaceId) {
        throw new NotFoundError(`Chat not found: ${body.chatId}`);
      }
      if (session.runId) {
        const runMessage = await queries.messages.findById(pool, session.runId);
        if (!runMessage) {
          throw new ValidationError("Sandbox run is no longer active");
        }
        if (runMessage.kind === "summary" || runMessage.content.type === "summary_request") {
          throw new ValidationError("Summary runs cannot attach artifacts");
        }
      }

      const message = await chatRoutes.attachArtifactRef(storage, body, emitEvent, {
        agentId: agent.id,
        model: agent.model,
      });
      sendJson(res, 201, message);
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
      const result = await authRoutes.handleLogout(pool, req.headers.authorization);
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
    if (path === "/me/providers/meta" && method === "GET") {
      const result = await accountRoutes.getProvidersMeta(pool, userId);
      sendJson(res, 200, result);
      return;
    }
    if (path === "/me/providers/meta" && method === "PUT") {
      const body = await parseBody(req) as { meta: Record<string, { name?: string } | null> };
      const result = await accountRoutes.setProvidersMeta(pool, userId, body);
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
      const body = await parseBody(req) as { name: string; description?: string; icon?: string; color?: string };
      const result = await workspaceRoutes.createWorkspace(pool, userId, storage.home, body);
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
      const body = await parseBody(req) as { name?: string; description?: string; icon?: string; color?: string };
      const result = await workspaceRoutes.patchWorkspace(pool, storage.home, segments[1], body);
      sendJson(res, 200, result);
      return;
    }
    if (segments[0] === "workspaces" && segments.length === 2 && method === "DELETE") {
      await requireOwnedWorkspace(pool, segments[1], userId);
      const result = await workspaceRoutes.deleteWorkspace(pool, storage.home, userId, segments[1]);
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

    // Library pin routes
    if (segments[0] === "workspaces" && segments[2] === "library-pins" && segments.length === 3 && method === "POST") {
      await requireOwnedWorkspace(pool, segments[1], userId);
      const body = (await parseBody(req)) as { path?: unknown };
      const filePath = typeof body?.path === "string" ? body.path : "";
      if (!filePath) throw new ValidationError("Missing 'path' in body");
      await libraryRoutes.pin(storage, segments[1], filePath);
      sendJson(res, 201, { ok: true });
      return;
    }
    if (segments[0] === "workspaces" && segments[2] === "library-pins" && segments.length === 3 && method === "DELETE") {
      await requireOwnedWorkspace(pool, segments[1], userId);
      const body = (await parseBody(req)) as { path?: unknown };
      const filePath = typeof body?.path === "string" ? body.path : "";
      if (!filePath) throw new ValidationError("Missing 'path' in body");
      await libraryRoutes.unpin(storage, segments[1], filePath);
      sendJson(res, 200, { ok: true });
      return;
    }

    // Agent routes
    if (path === "/agents" && method === "GET") {
      const result = await agentRoutes.listAgents(pool, userId);
      sendJson(res, 200, result);
      return;
    }
    if (path === "/agents" && method === "POST") {
      const body = await parseBody(req) as { name: string; model?: string };
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
      const body = await parseBody(req) as { name?: string; model?: string };
      const result = await agentRoutes.patchAgent(pool, segments[1], body);
      sendJson(res, 200, result);
      return;
    }
    if (segments[0] === "agents" && segments.length === 2 && method === "DELETE") {
      await requireOwnedAgent(pool, segments[1], userId);
      const result = await agentRoutes.deleteAgent(pool, userId, segments[1]);
      sendJson(res, 200, result);
      return;
    }

    // Chat routes
    if (path === "/chats" && method === "GET") {
      const wsId = await resolveWorkspaceId(pool, userId, query);
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
      const body = await parseBody(req) as { title?: string; goal?: string | null; agentId?: string };
      if (body.agentId !== undefined) {
        await requireOwnedAgent(pool, body.agentId, userId);
      }
      const result = await chatRoutes.patchChat(pool, segments[1], body);
      sendJson(res, 200, result);
      return;
    }
    if (segments[0] === "chats" && segments.length === 2 && method === "DELETE") {
      await requireOwnedChat(pool, segments[1], userId);
      const result = await chatRoutes.deleteChat(
        pool,
        storage,
        segments[1],
        emitEvent,
      );
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
      const ct = (req.headers["content-type"] ?? "").toLowerCase();
      const body = ct.startsWith("multipart/form-data")
        ? await chatRoutes.buildSendMessageBodyFromForm(storage, segments[1], await parseMultipart(req))
        : await parseBody(req);
      const { userMessage, triggerId } = await chatRoutes.sendMessage(pool, segments[1], body, emitEvent);

      // Self-firing kinds (task / summary): execute_at is computed at insert
      // time; the DB poll loop fires them when due. Unscheduled tasks just sit.
      if (userMessage.kind && userMessage.kind !== "chat") {
        sendJson(res, 201, userMessage);
        return;
      }

      // Default chat path: fire the pending trigger message and schedule
      // a summary refresh for this chat.
      runManager.fireMessage(triggerId).catch((err) => {
        // eslint-disable-next-line no-console
        console.error(`fireMessage for trigger ${triggerId} failed:`, err);
      });
      runManager.scheduleSummary(segments[1]).catch(() => {});

      sendJson(res, 201, userMessage);
      return;
    }
    if (segments[0] === "chats" && segments[2] === "messages" && segments.length === 4 && method === "PATCH") {
      await requireOwnedMessage(pool, segments[1], segments[3], userId);
      const body = await parseBody(req) as { content?: unknown; state?: string; executeAt?: string | null; cron?: string | null; title?: string | null };
      const result = await chatRoutes.patchMessage(pool, storage, segments[1], segments[3], body, emitEvent, runManager);
      sendJson(res, 200, result);
      return;
    }
    if (segments[0] === "chats" && segments[2] === "messages" && segments[4] === "run" && segments.length === 5 && method === "POST") {
      await requireOwnedMessage(pool, segments[1], segments[3], userId);
      const result = await chatRoutes.runMessage(pool, segments[1], segments[3], runManager, emitEvent);
      sendJson(res, 200, result);
      return;
    }
    if (segments[0] === "chats" && segments[2] === "messages" && segments[4] === "summary-history" && segments.length === 5 && method === "GET") {
      await requireOwnedMessage(pool, segments[1], segments[3], userId);
      const result = await chatRoutes.getSummaryHistory(storage, segments[1], segments[3]);
      sendJson(res, 200, result);
      return;
    }
    if (segments[0] === "chats" && segments[2] === "messages" && segments.length === 4 && method === "DELETE") {
      await requireOwnedMessage(pool, segments[1], segments[3], userId);
      await chatRoutes.deleteMessage(pool, storage, segments[1], segments[3]);
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
    if (segments[0] === "chats" && segments[2] === "attachments" && segments.length === 3 && method === "GET") {
      await requireOwnedChat(pool, segments[1], userId);
      const showHidden = query.get("showHidden") === "true";
      const includeArtifacts = query.get("includeArtifacts") === "true";
      const result = await chatRoutes.listAttachments(storage, segments[1], {
        showHidden,
        includeArtifacts,
      });
      sendJson(res, 200, result);
      return;
    }
    if (segments[0] === "chats" && segments[2] === "attachments" && segments.length === 3 && method === "DELETE") {
      await requireOwnedChat(pool, segments[1], userId);
      const name = query.get("name") ?? "";
      if (!name) throw new ValidationError("Missing 'name' query parameter");
      const result = await chatRoutes.removeAttachment(storage, segments[1], name);
      sendJson(res, 200, result);
      return;
    }
    if (segments[0] === "chats" && segments[2] === "library-refs" && segments.length === 3 && method === "POST") {
      await requireOwnedChat(pool, segments[1], userId);
      const body = (await parseBody(req)) as { path?: unknown };
      const libraryPath = typeof body?.path === "string" ? body.path : "";
      if (!libraryPath) {
        throw new ValidationError("Missing 'path' in body");
      }
      const result = await chatRoutes.pinLibraryFile(
        storage,
        segments[1],
        libraryPath,
        emitEvent,
      );
      sendJson(res, 201, result);
      return;
    }
    if (segments[0] === "chats" && segments[2] === "save-to-library" && segments.length === 3 && method === "POST") {
      await requireOwnedChat(pool, segments[1], userId);
      const body = (await parseBody(req)) as { name?: unknown; destSubpath?: unknown };
      const attachmentName = typeof body?.name === "string" ? body.name : "";
      if (!attachmentName) {
        throw new ValidationError("Missing 'name' in body");
      }
      const destSubpath =
        typeof body?.destSubpath === "string" && body.destSubpath.length > 0
          ? body.destSubpath
          : undefined;
      const result = await chatRoutes.saveAttachmentToLibrary(
        storage,
        segments[1],
        attachmentName,
        destSubpath,
        emitEvent,
      );
      sendJson(res, 201, result);
      return;
    }
    if (segments[0] === "chats" && segments[2] === "copy-library-app" && segments.length === 3 && method === "POST") {
      await requireOwnedChat(pool, segments[1], userId);
      const body = (await parseBody(req)) as { path?: unknown };
      const libraryPath = typeof body?.path === "string" ? body.path : "";
      if (!libraryPath) throw new ValidationError("Missing 'path' in body");
      const result = await chatRoutes.copyAppFromLibrary(
        storage,
        segments[1],
        libraryPath,
        emitEvent,
      );
      sendJson(res, 201, result);
      return;
    }
    if (segments[0] === "chats" && segments[2] === "replace-library-app" && segments.length === 3 && method === "POST") {
      await requireOwnedChat(pool, segments[1], userId);
      const body = (await parseBody(req)) as {
        name?: unknown;
        targetPath?: unknown;
        expectedSourceVersion?: unknown;
      };
      const artifactName = typeof body?.name === "string" ? body.name : "";
      const targetPath = typeof body?.targetPath === "string" ? body.targetPath : "";
      if (!artifactName) throw new ValidationError("Missing 'name' in body");
      if (!targetPath) throw new ValidationError("Missing 'targetPath' in body");
      const headerIfMatch = req.headers["if-match"];
      const ifMatch = Array.isArray(headerIfMatch) ? headerIfMatch[0] : headerIfMatch;
      const expectedSourceVersion =
        typeof body?.expectedSourceVersion === "string"
          ? body.expectedSourceVersion
          : typeof ifMatch === "string" && ifMatch
            ? ifMatch
            : undefined;
      try {
        const result = await chatRoutes.replaceLibraryAppWithChatArtifact(
          storage,
          segments[1],
          artifactName,
          targetPath,
          emitEvent,
          { expectedSourceVersion },
        );
        sendJson(res, 200, result);
      } catch (err) {
        if (err instanceof ReplaceLibraryAppConflictError) {
          sendJson(res, 409, {
            code: "VERSION_CONFLICT",
            message: err.message,
            expected: err.expected,
            actual: err.actual,
          });
          return;
        }
        throw err;
      }
      return;
    }
    if (segments[0] === "chats" && segments[2] === "save-artifact-to-library" && segments.length === 3 && method === "POST") {
      // Promotes a `<name>.app/` chat artifact directory into the
      // workspace library. Sibling of save-to-library which only
      // handles single-file attachments. Issue #47, PR-E.
      await requireOwnedChat(pool, segments[1], userId);
      const body = (await parseBody(req)) as { name?: unknown; destSubpath?: unknown };
      const artifactName = typeof body?.name === "string" ? body.name : "";
      if (!artifactName) {
        throw new ValidationError("Missing 'name' in body");
      }
      const destSubpath =
        typeof body?.destSubpath === "string" && body.destSubpath.length > 0
          ? body.destSubpath
          : undefined;
      const result = await chatRoutes.saveArtifactToLibrary(
        storage,
        segments[1],
        artifactName,
        destSubpath,
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
      const wsId = await resolveWorkspaceId(pool, userId, query);
      const cursor = query.get("cursor") ?? undefined;
      const limit = query.get("limit") ? parseInt(query.get("limit")!) : undefined;
      const showHidden = query.get("showHidden") === "true";
      const pinned = query.get("pinned") === "true";
      const result = wsId
        ? await libraryRoutes.list(storage, wsId, { cursor, limit, showHidden, pinned })
        : { items: [] };
      sendJson(res, 200, result);
      return;
    }
    if (path === "/library" && method === "POST") {
      const wsId = await requireWorkspaceId(pool, userId, query);
      const form = await parseMultipart(req);
      const part = form.get("file");
      if (!(part instanceof Blob)) {
        throw new ValidationError("Missing 'file' part in multipart body");
      }
      const name = (part as File).name || (typeof form.get("name") === "string" ? (form.get("name") as string) : "upload");
      const mime = part.type || "application/octet-stream";
      const subpathRaw = form.get("subpath");
      const subpath = typeof subpathRaw === "string" && subpathRaw !== "" ? subpathRaw : undefined;
      const stream = (await import("node:stream")).Readable.from(Buffer.from(await part.arrayBuffer()));
      const result = await libraryRoutes.upload(storage, wsId, { name, mime, stream, subpath }, emitEvent);
      sendJson(res, 201, result);
      return;
    }
    if (path === "/library" && method === "PATCH") {
      const wsId = await requireWorkspaceId(pool, userId, query);
      const body = await parseBody(req) as { from?: unknown; to?: unknown };
      if (typeof body.from !== "string" || typeof body.to !== "string") {
        throw new ValidationError("Body must be { from: string, to: string }");
      }
      requireLibraryPathInWorkspace(body.from, wsId);
      requireLibraryPathInWorkspace(body.to, wsId);
      const result = await libraryRoutes.move(storage, wsId, body.from, body.to, emitEvent);
      sendJson(res, 200, result);
      return;
    }
    if (path === "/library/folder" && method === "POST") {
      const wsId = await requireWorkspaceId(pool, userId, query);
      const body = await parseBody(req) as { path?: unknown };
      if (typeof body.path !== "string" || body.path === "") {
        throw new ValidationError("Body must include { path: string }");
      }
      const result = await libraryRoutes.createFolder(storage, wsId, body.path, emitEvent);
      sendJson(res, 201, result);
      return;
    }
    if (path === "/library/link" && method === "POST") {
      const wsId = await requireWorkspaceId(pool, userId, query);
      const body = await parseBody(req) as { url?: unknown; name?: unknown; subpath?: unknown };
      if (typeof body.url !== "string" || body.url === "") {
        throw new ValidationError("Body must include { url: string, name?: string, subpath?: string }");
      }
      const name = typeof body.name === "string" && body.name.trim() !== ""
        ? body.name
        : new URL(body.url).hostname || body.url;
      const subpath = typeof body.subpath === "string" && body.subpath !== "" ? body.subpath : undefined;
      const result = await libraryRoutes.createLink(storage, wsId, { url: body.url, name, subpath }, emitEvent);
      sendJson(res, 201, result);
      return;
    }
    if (path === "/library/meta" && method === "GET") {
      const p = query.get("path");
      if (!p) throw new ValidationError("Missing path query parameter");
      const wsId = await requireWorkspaceId(pool, userId, query);
      await requireReadablePathForRoute(pool, storage, userId, p, wsId);
      const result = await libraryRoutes.get(storage, wsId, p);
      // Summary mirrors live at `.chats/<id>/notes/<msgId>.md` — surface the
      // user-friendly "Chat summary" label so the detail view doesn't title
      // the page with the messageId-based filename.
      const decorated = /^\.chats\/cht_[A-Za-z0-9_-]+\/notes\/[^/]+\.md$/.test(p)
        ? { ...result, label: "Chat summary" }
        : result;
      sendJson(res, 200, decorated);
      return;
    }
    if (path === "/library/download" && method === "GET") {
      const p = query.get("path");
      if (!p) throw new ValidationError("Missing path query parameter");
      const wsId = await requireWorkspaceId(pool, userId, query);
      await requireReadablePathForRoute(pool, storage, userId, p, wsId);
      const { stream, file } = await libraryRoutes.download(storage, wsId, p);
      res.writeHead(200, {
        "Content-Type": file.mime,
        "Content-Disposition": `attachment; filename="${file.name}"`,
      });
      stream.pipe(res);
      return;
    }
    if (path === "/library/content" && method === "GET") {
      const p = query.get("path");
      if (!p) throw new ValidationError("Missing path query parameter");
      const wsId = await requireWorkspaceId(pool, userId, query);
      await requireReadablePathForRoute(pool, storage, userId, p, wsId);
      const { stream, file } = await libraryRoutes.download(storage, wsId, p);
      res.writeHead(200, {
        "Content-Type": file.mime,
        "Content-Disposition": `inline; filename="${file.name}"`,
        "Content-Length": String(file.size),
        "ETag": `"${file.updatedAtMs}"`,
      });
      stream.pipe(res);
      return;
    }
    if (path === "/library/content" && method === "PUT") {
      const p = query.get("path");
      if (!p) throw new ValidationError("Missing path query parameter");
      const wsId = await requireWorkspaceId(pool, userId, query);
      requireLibraryPathInWorkspace(p, wsId);
      const rawIfMatch = req.headers["if-match"];
      // Strip quotes from ETag header value: "123" → 123
      const ifMatch = rawIfMatch ? rawIfMatch.replace(/^"|"$/g, "") : undefined;
      try {
        const result = await libraryRoutes.saveContent(storage, wsId, p, req, emitEvent, ifMatch);
        sendJson(res, 200, result);
      } catch (err) {
        if (err instanceof (await import("@agent-desk/shared")).ConflictError) {
          const { stream: currentStream, file: currentFile } = await libraryRoutes.download(storage, wsId, p);
          const chunks: Buffer[] = [];
          await new Promise<void>((resolve, reject) => {
            currentStream.on("data", (c: Buffer) => chunks.push(c));
            currentStream.on("end", resolve);
            currentStream.on("error", reject);
          });
          sendJson(res, 409, {
            conflict: true,
            content: Buffer.concat(chunks).toString("utf8"),
            etag: currentFile.updatedAtMs,
          });
        } else {
          throw err;
        }
      }
      return;
    }
    if (path === "/library" && method === "DELETE") {
      const p = query.get("path");
      if (!p) throw new ValidationError("Missing path query parameter");
      const wsId = await requireWorkspaceId(pool, userId, query);
      requireLibraryPathInWorkspace(p, wsId);
      await libraryRoutes.remove(storage, wsId, p, emitEvent);
      sendJson(res, 200, { ok: true });
      return;
    }

    // Legacy /runs and /scheduled-jobs routes are gone — chat-scoped
    // execution state now lives on the messages table; use
    // GET /chats/{id}/messages and its PATCH/DELETE/logs sub-routes.

    // Cross-chat message listing — read-only, AND-combined filters.
    // Powers the Runs page (scheduled/state filters) and Today / Inbox
    // (awaitingUser) without introducing new top-level resources.
    if (path === "/messages" && method === "GET") {
      const result = await messageRoutes.listMessages(pool, userId, query);
      sendJson(res, 200, result);
      return;
    }

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
      const scope = parseSearchScope(query.get("scope"));
      const showHidden = query.get("showHidden") === "true";
      const workspaceId = query.get("workspaceId") ?? undefined;
      const chatId = query.get("chatId") ?? undefined;
      const kinds = parseSearchKinds(query.get("kind"));
      const result = await searchRoutes.search(pool, storage, userId, q, scope, {
        showHidden,
        workspaceId,
        chatId,
        kinds,
      });
      sendJson(res, 200, result);
      return;
    }

    // OpenAPI spec
    if (path === "/openapi.json" && method === "GET") {
      sendJson(res, 200, openApiSpec);
      return;
    }

    // App static-file serving: /apps/<workspaceId>/<...appRelPath>/dist/<...file>
    // Serves the built dist/ output of a `.app/` directory so the frontend
    // can embed the app in an iframe.
    if (segments[0] === "apps" && segments.length >= 4 && method === "GET") {
      const wsId = segments[1];
      if (!wsId || !/^wks_[A-Za-z0-9_-]+$/.test(wsId)) {
        sendJson(res, 400, { code: "BAD_REQUEST", message: "Invalid workspaceId in path" });
        return;
      }
      // /apps/* is skipped by the global auth middleware; resolve the user
      // here from Bearer header, ?token= query param, or desk-app-token cookie.
      let appsUserId: string;
      {
        let tokenHeader = req.headers.authorization;
        if (!tokenHeader) {
          const qt = query.get("token");
          if (qt) {
            tokenHeader = `Bearer ${qt}`;
          } else {
            const cookieHeader = req.headers.cookie ?? "";
            const cookieToken = cookieHeader
              .split(";")
              .map((c) => c.trim())
              .find((c) => c.startsWith("desk-app-token="))
              ?.slice("desk-app-token=".length);
            if (cookieToken) tokenHeader = `Bearer ${decodeURIComponent(cookieToken)}`;
          }
        }
        if (!tokenHeader || !tokenHeader.startsWith("Bearer ")) {
          sendJson(res, 401, { code: "UNAUTHORIZED", message: "Missing or invalid Authorization" });
          return;
        }
        const resolvedId = await verifySession(pool, tokenHeader.slice(7));
        if (!resolvedId) {
          sendJson(res, 401, { code: "UNAUTHORIZED", message: "Invalid or expired session token" });
          return;
        }
        appsUserId = resolvedId;
      }
      await requireOwnedWorkspace(pool, wsId, appsUserId);

      // segments: ['apps', wsId, ...appParts, 'dist', ...fileParts]
      // Find the 'dist' marker — it must appear after at least one app segment.
      const distIdx = segments.indexOf("dist", 2);
      if (distIdx < 3) {
        sendJson(res, 404, { code: "NOT_FOUND", message: "Not found" });
        return;
      }
      // Reconstruct the workspace-relative app path and the in-dist file path.
      // Segments from url.pathname are still percent-encoded; decode each one
      // and reject any that normalise to '.' or '..' to prevent traversal.
      const decodeSeg = (s: string) => {
        try { return decodeURIComponent(s); } catch { return s; }
      };
      const appSegments = segments.slice(2, distIdx).map(decodeSeg);
      const fileSegmentsRaw = segments.slice(distIdx + 1).map(decodeSeg);
      // Reject traversal attempts in either the app path or the file path.
      if ([...appSegments, ...fileSegmentsRaw].some((s) => s === ".." || s === ".")) {
        sendJson(res, 403, { code: "FORBIDDEN", message: "Path traversal detected" });
        return;
      }
      const appRelPath = appSegments.join("/");
      const distRelFile = fileSegmentsRaw.length > 0 ? fileSegmentsRaw.join("/") : "index.html";

      // Validate: appRelPath must end with .app
      if (!appRelPath.endsWith(".app")) {
        sendJson(res, 404, { code: "NOT_FOUND", message: "Not found" });
        return;
      }

      // Verify the user can read the app directory (re-uses existing auth logic).
      await requireReadablePathForRoute(pool, storage, appsUserId, appRelPath, wsId);

      const { rows: wsRows } = await pool.query<{ path: string }>(
        "SELECT path FROM workspaces WHERE id = ?",
        [wsId],
      );
      const slug = wsRows[0]?.path;
      if (!slug) {
        sendJson(res, 404, { code: "NOT_FOUND", message: "Workspace not found" });
        return;
      }

      const wsRoot = workspaceRootPath(storage.home, slug);
      // Build the candidate dist file path. We must not allow path traversal.
      const distRoot = pathJoin(wsRoot, appRelPath, "dist");
      const candidate = pathNormalize(pathJoin(distRoot, distRelFile));
      if (!candidate.startsWith(distRoot + pathSep) && candidate !== distRoot) {
        sendJson(res, 403, { code: "FORBIDDEN", message: "Path traversal detected" });
        return;
      }

      const realDistRoot = await fsRealpath(distRoot).catch(() => null);
      if (!realDistRoot) {
        sendJson(res, 404, { code: "NOT_FOUND", message: "App dist not found" });
        return;
      }
      const assertInsideDist = async (filePath: string): Promise<string | null> => {
        const realCandidate = await fsRealpath(filePath).catch(() => null);
        if (!realCandidate) return null;
        return realCandidate === realDistRoot || realCandidate.startsWith(realDistRoot + pathSep)
          ? realCandidate
          : null;
      };

      const APP_MIME: Record<string, string> = {
        ".html": "text/html; charset=utf-8",
        ".js":   "application/javascript; charset=utf-8",
        ".mjs":  "application/javascript; charset=utf-8",
        ".css":  "text/css; charset=utf-8",
        ".json": "application/json; charset=utf-8",
        ".svg":  "image/svg+xml",
        ".png":  "image/png",
        ".jpg":  "image/jpeg",
        ".jpeg": "image/jpeg",
        ".gif":  "image/gif",
        ".webp": "image/webp",
        ".ico":  "image/x-icon",
        ".woff": "font/woff",
        ".woff2":"font/woff2",
        ".ttf":  "font/ttf",
        ".map":  "application/json; charset=utf-8",
        ".txt":  "text/plain; charset=utf-8",
      };
      const mime = APP_MIME[pathExtname(candidate).toLowerCase()] ?? "application/octet-stream";

      const appQueryToken = query.get("token");
      const appTokenCookie = appQueryToken
        ? `desk-app-token=${encodeURIComponent(appQueryToken)}; HttpOnly; SameSite=Strict; Path=/api/apps/`
        : null;

      try {
        const st = await fsStat(candidate);
        if (!st.isFile()) throw new Error("not a file");
        const realCandidate = await assertInsideDist(candidate);
        if (!realCandidate) {
          sendJson(res, 403, { code: "FORBIDDEN", message: "Path traversal detected" });
          return;
        }
        const headers: Record<string, string | string[]> = {
          "Content-Type": mime,
          "Content-Length": String(st.size),
          "Cache-Control": "no-cache",
        };
        if (appTokenCookie && mime.startsWith("text/html")) {
          headers["Set-Cookie"] = appTokenCookie;
        }
        res.writeHead(200, headers);
        createReadStream(realCandidate).pipe(res);
      } catch {
        // Fallback to index.html for SPA client-side routing within the app.
        const indexPath = pathJoin(distRoot, "index.html");
        try {
          const ist = await fsStat(indexPath);
          const realIndexPath = await assertInsideDist(indexPath);
          if (!realIndexPath) {
            sendJson(res, 403, { code: "FORBIDDEN", message: "Path traversal detected" });
            return;
          }
          const headers: Record<string, string | string[]> = {
            "Content-Type": "text/html; charset=utf-8",
            "Content-Length": String(ist.size),
            "Cache-Control": "no-cache",
          };
          if (appTokenCookie) headers["Set-Cookie"] = appTokenCookie;
          res.writeHead(200, headers);
          createReadStream(realIndexPath).pipe(res);
        } catch {
          sendJson(res, 404, { code: "NOT_FOUND", message: "App dist not found" });
        }
      }
      return;
    }

    // Fallback
    sendJson(res, 404, { code: "NOT_FOUND", message: "Not found" });
  }

  return server;
}
