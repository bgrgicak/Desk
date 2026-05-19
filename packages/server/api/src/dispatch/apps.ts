import { createReadStream } from "node:fs";
import { type IncomingMessage, type ServerResponse } from "node:http";
import { realpath as fsRealpath, stat as fsStat } from "node:fs/promises";
import { extname as pathExtname, join as pathJoin, normalize as pathNormalize, sep as pathSep } from "node:path";
import { workspaceRootPath } from "@agent-desk/storage";
import * as appsRoutes from "../routes/apps.js";
import { handleAppStorageRequest } from "../routes/app-storage.js";
import * as chatRoutes from "../routes/chats.js";
import { requireOwnedChat, requireOwnedWorkspace } from "../auth/ownership.js";
import { verifySession } from "../auth/sessions.js";
import {
  requireBearerForApps,
  requireReadablePathForRoute,
  sendJson,
} from "../http/request-helpers.js";
import type { DispatchContext } from "./context.js";

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

/**
 * Dispatcher for every `/apps/*` route family. The `/apps/*` paths are
 * intentionally excluded from the global bearer-session middleware —
 * each branch here owns its own auth check (Bearer for `issue` /
 * `DELETE`, HttpOnly app-token cookie for the static `dist/` reads).
 *
 *   /apps/.../storage/...    delegated to handleAppStorageRequest
 *   /apps/chat/:chatId/:appName/issue   mint chat-scoped app session
 *   /apps/chat/:chatId/:appName         DELETE — remove chat app
 *   /apps/chat/:chatId/:appName/dist/.. static-app dist
 *   /apps/library/:appName/issue        mint library-scoped session
 *   /apps/library/:appName              DELETE — remove library app
 *   /apps/library/:appName/dist/..      library-scoped dist
 *   /apps/:wsId/.../dist/..             workspace-scoped dist (generic)
 *
 * Returns true when handled.
 */
export async function dispatchApps(
  req: IncomingMessage,
  res: ServerResponse,
  method: string,
  segments: string[],
  query: URLSearchParams,
  ctx: DispatchContext,
): Promise<boolean> {
  const { pool, storage, emit } = ctx;

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
    if (handled) return true;
  }

  // Static-app routes — /apps/chat/:chatId/:appName/dist/* and the
  // companion POST /apps/chat/:chatId/:appName/issue mint-token endpoint.
  if (segments[0] === "apps" && segments[1] === "chat" && segments.length >= 4) {
    if (method === "POST" && segments.length === 5 && segments[4] === "issue") {
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
      return true;
    }
    if (method === "DELETE" && segments.length === 4) {
      // PR-E: delete a chat-artifact `<name>.app/`. Cascade-revokes any
      // active app_sessions bound to (chatId, appName). The .storage/
      // SQLite file goes with the directory.
      const issuerId = await requireBearerForApps(pool, req);
      const chatId = decodeURIComponent(segments[2]);
      const appName = decodeURIComponent(segments[3]);
      await requireOwnedChat(pool, chatId, issuerId);
      await chatRoutes.removeChatApp(storage, chatId, appName, emit);
      sendJson(res, 200, { ok: true });
      return true;
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
      if (handled) return true;
    }
  }

  // Library-scoped variant: /apps/library/:appName/dist/* and the
  // companion POST /apps/library/:appName/issue (PR-E).
  if (segments[0] === "apps" && segments[1] === "library" && segments.length >= 3) {
    if (method === "POST" && segments.length === 4 && segments[3] === "issue") {
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
      return true;
    }
    if (method === "DELETE" && segments.length === 3) {
      // PR-E: delete a library `<name>.app/` (moves it to .trash for
      // recovery) and revoke all sessions for that app.
      const issuerId = await requireBearerForApps(pool, req);
      const appName = decodeURIComponent(segments[2]);
      await chatRoutes.removeLibraryApp(storage, issuerId, appName, emit);
      sendJson(res, 200, { ok: true });
      return true;
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
      if (handled) return true;
    }
  }

  // Workspace-scoped app dist serving: /apps/<workspaceId>/<...appPath>/dist/<...file>.
  if (segments[0] === "apps" && segments.length >= 4 && method === "GET") {
    const wsId = segments[1];
    if (!wsId || !/^wks_[A-Za-z0-9_-]+$/.test(wsId)) {
      sendJson(res, 400, { code: "BAD_REQUEST", message: "Invalid workspaceId in path" });
      return true;
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
        return true;
      }
      const resolvedId = await verifySession(pool, tokenHeader.slice(7));
      if (!resolvedId) {
        sendJson(res, 401, { code: "UNAUTHORIZED", message: "Invalid or expired session token" });
        return true;
      }
      appsUserId = resolvedId;
    }
    await requireOwnedWorkspace(pool, wsId, appsUserId);

    // segments: ['apps', wsId, ...appParts, 'dist', ...fileParts]
    // Find the 'dist' marker — it must appear after at least one app segment.
    const distIdx = segments.indexOf("dist", 2);
    if (distIdx < 3) {
      sendJson(res, 404, { code: "NOT_FOUND", message: "Not found" });
      return true;
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
      return true;
    }
    const appRelPath = appSegments.join("/");
    const distRelFile = fileSegmentsRaw.length > 0 ? fileSegmentsRaw.join("/") : "index.html";

    // Validate: appRelPath must end with .app
    if (!appRelPath.endsWith(".app")) {
      sendJson(res, 404, { code: "NOT_FOUND", message: "Not found" });
      return true;
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
      return true;
    }

    const wsRoot = workspaceRootPath(storage.home, slug);
    // Build the candidate dist file path. We must not allow path traversal.
    const distRoot = pathJoin(wsRoot, appRelPath, "dist");
    const candidate = pathNormalize(pathJoin(distRoot, distRelFile));
    if (!candidate.startsWith(distRoot + pathSep) && candidate !== distRoot) {
      sendJson(res, 403, { code: "FORBIDDEN", message: "Path traversal detected" });
      return true;
    }

    const realDistRoot = await fsRealpath(distRoot).catch(() => null);
    if (!realDistRoot) {
      sendJson(res, 404, { code: "NOT_FOUND", message: "App dist not found" });
      return true;
    }
    const assertInsideDist = async (filePath: string): Promise<string | null> => {
      const realCandidate = await fsRealpath(filePath).catch(() => null);
      if (!realCandidate) return null;
      return realCandidate === realDistRoot || realCandidate.startsWith(realDistRoot + pathSep)
        ? realCandidate
        : null;
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
        return true;
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
          return true;
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
    return true;
  }

  return false;
}
