import { createReadStream } from "node:fs";
import { createServer as httpCreateServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { mkdir as fsMkdir, realpath as fsRealpath, stat as fsStat } from "node:fs/promises";
import { dirname as pathDirname, extname as pathExtname, join as pathJoin, normalize as pathNormalize, sep as pathSep } from "node:path";
import { type Pool } from "@agent-desk/db";
import { queries } from "@agent-desk/db";
import { DeskError, ValidationError, type WsEvent } from "@agent-desk/shared";
import {
  workspaceRootPath,
  type StorageContext,
} from "@agent-desk/storage";
import type { createRunManager } from "@agent-desk/scheduler";
import { enforceMustChangePassword, recordClientTimezone, requireAuth } from "./auth/middleware.js";
import { requireInternal } from "./auth/internal.js";
import { verifySession } from "./auth/sessions.js";
import {
  requireOwnedChat,
  requireOwnedWorkspace,
} from "./auth/ownership.js";
import { errorToStatus } from "./errors.js";
import { broadcast } from "./ws/registry.js";
import { installWsUpgradeHandler } from "./ws/upgrade.js";
import { generateOpenApiSpec } from "./openapi.js";
import { isStaticPath, resolveAppDist, serveStaticOrIndex } from "./static-app.js";
import * as chatRoutes from "./routes/chats.js";
import * as libraryRoutes from "./routes/library.js";
import * as messageRoutes from "./routes/messages.js";
import * as searchRoutes from "./routes/search.js";
import * as toolRoutes from "./routes/tools.js";
import { VaultStore } from "./vault/store.js";
import { withModule } from "@agent-desk/shared/logger";
import {
  defaultBackupPath,
  parseBody,
  parseMultipartFileStream,
  requireBearerForApps,
  requireReadablePathForRoute,
  sendJson,
} from "./http/request-helpers.js";
import { parseSearchKinds, parseSearchScope } from "./routes/search-params.js";
import type { DispatchContext } from "./dispatch/context.js";
import { dispatchSandbox } from "./dispatch/sandbox.js";
import { dispatchAccount } from "./dispatch/account.js";
import { dispatchWorkspaces } from "./dispatch/workspaces.js";
import { dispatchChats } from "./dispatch/chats.js";
const log = withModule("api/app");

import * as appsRoutes from "./routes/apps.js";
import { handleAppStorageRequest } from "./routes/app-storage.js";
import {
  requireLibraryPathInWorkspace,
  requireWorkspaceId,
  resolveWorkspaceId,
} from "./workspace-scope.js";

type RunManager = ReturnType<typeof createRunManager>;

export interface AppOptions {
  pool: Pool;
  storage: StorageContext;
  runManager: RunManager;
  /**
   * Shared vault instance. Pass this from the outer process so the scheduler
   * and HTTP layer operate on the same in-memory unlock state. When omitted
   * (tests, embedded usage) a fresh store is created from storage.home.
   */
  vault?: VaultStore;
  /** The userId to broadcast events to (v1: single user). */
  broadcastUserId?: string;
  /**
   * Hot-refreshes the user's sandbox daemons after a connector / local
   * source mutation. Wired by main.ts to the runtime's
   * `refreshSandboxConnections`. When omitted (tests) the routes still
   * succeed but the running sandbox keeps its old env until the next
   * env-digest restart.
   */
  refreshSandboxConnections?: (userId: string, workspaceId?: string) => Promise<void>;
}

// Security headers + WS Origin allowlist live in ./http/security-headers
// so this file isn't carrying ~100 lines of mostly-prose helpers.
// Re-exported from app.ts so the existing test imports
// (`import { isWsOriginAllowed } from "../src/app.js"`) keep working.
import { getAllowedWsOrigins, isLoopbackAddress, isWsOriginAllowed, setSecurityHeaders } from "./http/security-headers.js";
export { getAllowedWsOrigins, isLoopbackAddress, isWsOriginAllowed };

// Reserved for the upcoming route-table refactor (Phase 4) — the
// dispatcher will move from a chain of `if`s into a Map<string,
// RouteHandler>. Keeping the type definition out keeps the intended
// shape visible; renamed with leading underscore so the no-unused
// rule lets it through.
type _RouteHandler = (req: IncomingMessage, res: ServerResponse, params: RouteParams) => Promise<void>;

interface RouteParams {
  path: string;
  segments: string[];
  userId: string;
  query: URLSearchParams;
}

export function createApp(opts: AppOptions): Server {
  const { pool, storage, runManager } = opts;
  const vault = opts.vault ?? new VaultStore(pathJoin(storage.home, "vaults"));

  function emitEvent(event: WsEvent): void {
    if (opts.broadcastUserId) {
      broadcast(opts.broadcastUserId, event);
    }
  }

  /**
   * Hot-refresh after a connector / local-source mutation. Split into a
   * fast synchronous phase (awaited) and a slow background phase
   * (fire-and-forget):
   *
   *   - **Synchronous**: clear persisted opencode-serve session ids for
   *     the affected chats. This is a single DB UPDATE — completes in
   *     well under a millisecond — and is the only piece that *has* to
   *     finish before the route returns. Without it, a chat message
   *     fired right after the settings mutation could pick a session
   *     bound to the prior auth/model.
   *
   *   - **Background**: restart any warm opencode-serve daemons with
   *     fresh env, and broadcast `connection.changed` so open UIs
   *     refetch. The daemon restart can take 1–5+ seconds in the worst
   *     case (graceful kill + waitForReady), and blocking the route on
   *     it made Settings toggles feel broken: the UI waited on the
   *     mutation before re-rendering, so the toggle visibly stayed in
   *     its old position until the docker churn finished.
   *
   *     Skipping the await is safe: `ensureOpencodeServer` does its
   *     own env-digest check on every call, so the next chat turn
   *     respawns the daemon with the new env regardless. The proactive
   *     restart here is a perf nice-to-have (avoids cold-spawn latency
   *     on that first message), not a correctness lever.
   *
   *   Failures in either phase are swallowed and logged — a flaky engine
   *   must not turn a successful settings mutation into a 500.
   */
  async function refreshConnections(
    userId: string,
    payload: WsEvent & { type: "connection.changed" },
    workspaceId?: string,
  ): Promise<void> {
    try {
      await queries.chats.clearOpencodeSessionsForUser(pool, userId, workspaceId);
    } catch (err) {
      log.warn(
        { userId, workspaceId: workspaceId ?? "*", err: (err as Error).message ?? String(err) },
        "clearOpencodeSessionsForUser failed",
      );
    }
    // Fire-and-forget. refreshSandboxConnections also calls
    // clearOpencodeSessionsForUser internally; on the second pass it
    // finds nothing to clear and short-circuits. Cheap to do twice;
    // unsafe to skip on either path.
    if (opts.refreshSandboxConnections) {
      void opts.refreshSandboxConnections(userId, workspaceId).catch((err) => {
        log.warn(
          { userId, workspaceId: workspaceId ?? "*", err: (err as Error).message ?? String(err) },
          "refreshSandboxConnections failed",
        );
      });
    }
    emitEvent(payload);
  }

  // Closure bundle handed to extracted dispatch sub-modules (dispatch/*).
  // Re-built once per createApp so handlers don't have to take eight
  // separate parameters.  Add new shared deps here; per-route helpers
  // still take their narrow inputs directly.
  const dispatchCtx: DispatchContext = {
    pool,
    storage,
    vault,
    runManager,
    emit: emitEvent,
    refreshConnections,
  };

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

      setSecurityHeaders(req, res, rawPath);

      if (method === "GET" && rawPath === "/health") {
        sendJson(res, 200, { ok: true });
        return;
      }

      if (method === "GET" && rawPath === "/ready") {
        // Liveness vs readiness: /health is "process is up", /ready is
        // "process is up AND its dependencies respond." Both are
        // unauthenticated so a process supervisor (systemd, k8s,
        // docker-compose healthcheck) can probe them without a token.
        const checks: Record<string, "ok" | "fail"> = {};
        let allOk = true;
        try {
          await pool.query("SELECT 1", []);
          checks.db = "ok";
        } catch {
          checks.db = "fail";
          allOk = false;
        }
        // Vault filesystem reachability — confirm the per-user KDBX
        // directory is readable. status() for an arbitrary userId
        // exercises the fs.access path inside VaultStore without
        // requiring an actual user to exist; the response is the
        // exists/locked tuple either way.
        try {
          await vault.status("readiness-probe-user");
          checks.vault = "ok";
        } catch {
          checks.vault = "fail";
          allOk = false;
        }
        sendJson(res, allOk ? 200 : 503, { ok: allOk, checks });
        return;
      }

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
        // First-run safety: if the user is still on the documented
        // seed credential refuse every endpoint outside a small
        // allowlist (see middleware.ts MUST_CHANGE_PW_ALLOWED). The
        // SPA reads user.mustChangePassword from GET /me and routes
        // to the password-change screen; this guard ensures other
        // endpoints don't accept writes from a user who's still on
        // the public default.
        await enforceMustChangePassword(pool, userId, method, path);
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
        log.warn({ err }, "recordClientTimezone failed");
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
        log.error({ err }, "Unhandled error");
        sendJson(res, 500, { code: "INTERNAL", message: "Internal server error" });
      }
    }
  });

  // WebSocket upgrade handler. The `head` buffer holds any data that
  // arrived after the upgrade headers but before the handshake; for a
  // bare-bones WS implementation we don't need it (no protocol
  // extensions, no extensions buffer to forward), so name it _head to
  // satisfy no-unused-args while keeping the signature documented.
  installWsUpgradeHandler(server, pool);

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

    // Sandbox routes — all /sandbox/* paths share the X-Desk-Sandbox-Token
    // auth scheme and bypass requireAuth. dispatchSandbox returns true when
    // it handled the request; false means the path isn't a sandbox route
    // and we fall through to the next branch.
    if (segments[0] === "sandbox") {
      const handled = await dispatchSandbox(req, res, method, path, segments, dispatchCtx);
      if (handled) return;
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
    // Account routes — /auth/*, /me/*, /vault/*, /secrets/*
    // are all handled by the account dispatcher in dispatch/account.ts.
    // It owns rate limits + loopback gate for the unauthenticated
    // /auth/* endpoints too (userId is "" for those).
    {
      const handled = await dispatchAccount(req, res, method, path, segments, userId, query, dispatchCtx);
      if (handled) return;
    }

    // Workspace + agent + pin routes — all scoped to the authenticated
    // user.  See dispatch/workspaces.ts for the per-resource handlers.
    {
      const handled = await dispatchWorkspaces(req, res, method, path, segments, userId, dispatchCtx, { refreshSandboxConnections: opts.refreshSandboxConnections });
      if (handled) return;
    }

    // Chat-resource routes — /chats/*, /chats/{id}/messages/*, attachment/
    // library-bridge sub-routes.  See dispatch/chats.ts.
    {
      const handled = await dispatchChats(req, res, method, path, segments, userId, query, dispatchCtx);
      if (handled) return;
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
        ? await libraryRoutes.list(storage, userId, wsId, { cursor, limit, showHidden, pinned })
        : { items: [] };
      sendJson(res, 200, result);
      return;
    }
    if (path === "/library" && method === "POST") {
      const wsId = await requireWorkspaceId(pool, userId, query);
      const { name, mime, stream, subpath } = await parseMultipartFileStream(req);
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
            code: "VERSION_CONFLICT",
            message: "Library file changed since your If-Match etag — current content returned alongside",
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
      const result = await toolRoutes.listModels(pool, vault, {
        provider: query.get("provider") ?? undefined,
        userId,
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
