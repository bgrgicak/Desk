import { type IncomingMessage, type ServerResponse } from "node:http";
import { ConflictError, ValidationError } from "@roomy-ai/shared";
import * as libraryRoutes from "../routes/library.js";
import { parseBody, sendJson } from "../http/io.js";
import { parseMultipartFileStream } from "../http/multipart.js";
import {
  requireExistingLibraryPathForRoute,
  requireLibraryDestinationForRoute,
  requireReadablePathForRoute,
} from "../workspace-scope-fs.js";
import {
  requireLibraryPathInWorkspace,
  requireWorkspaceId,
  resolveWorkspaceId,
} from "../workspace-scope.js";
import type { DispatchContext } from "./context.js";

/**
 * Dispatcher for the workspace-library file surface. Library files
 * live at arbitrary nested paths on the filesystem, so the
 * workspace-relative path rides as a `?path=` query parameter rather
 * than being embedded in the URL — avoids slash-encoding gymnastics.
 *
 *   GET    /library?path=...        list one folder's immediate children
 *   GET    /library?pinned=true     list every pinned entry workspace-wide
 *   GET    /library/folders         folders-only recursive tree (no file metadata)
 *   GET    /library/search?q=...    capped recursive name search
 *   POST   /library                 multipart upload
 *   PATCH  /library                 move (from → to)
 *   DELETE /library?path=...        remove
 *   POST   /library/folder          mkdir
 *   POST   /library/link            create a URL-link entry
 *   GET    /library/meta?path=...   metadata
 *   GET    /library/download        attachment-disposition stream
 *   GET    /library/content         inline stream + ETag
 *   PUT    /library/content         write text content (If-Match)
 *
 * Returns true when handled.
 */
export async function dispatchLibrary(
  req: IncomingMessage,
  res: ServerResponse,
  method: string,
  path: string,
  userId: string,
  query: URLSearchParams,
  ctx: DispatchContext,
): Promise<boolean> {
  const { pool, storage, emit } = ctx;

  if (path === "/library" && method === "GET") {
    const wsId = await resolveWorkspaceId(pool, userId, query);
    if (!wsId) {
      sendJson(res, 200, { items: [], folders: [] });
      return true;
    }
    const showHidden = query.get("showHidden") === "true";
    const pinned = query.get("pinned") === "true";
    if (pinned) {
      const result = await libraryRoutes.listPinned(storage, userId, wsId);
      sendJson(res, 200, result);
      return true;
    }
    const folderPath = query.get("path") ?? undefined;
    const result = await libraryRoutes.list(storage, userId, wsId, {
      path: folderPath,
      showHidden,
    });
    sendJson(res, 200, result);
    return true;
  }
  if (path === "/library/folders" && method === "GET") {
    const wsId = await resolveWorkspaceId(pool, userId, query);
    if (!wsId) {
      sendJson(res, 200, { folders: [] });
      return true;
    }
    const showHidden = query.get("showHidden") === "true";
    const result = await libraryRoutes.listFolders(storage, userId, wsId, { showHidden });
    sendJson(res, 200, result);
    return true;
  }
  if (path === "/library/search" && method === "GET") {
    const wsId = await resolveWorkspaceId(pool, userId, query);
    if (!wsId) {
      sendJson(res, 200, { items: [], folders: [], truncated: false });
      return true;
    }
    const q = query.get("q") ?? "";
    const showHidden = query.get("showHidden") === "true";
    const limit = query.get("limit") ? parseInt(query.get("limit")!) : undefined;
    const result = await libraryRoutes.search(storage, userId, wsId, { q, showHidden, limit });
    sendJson(res, 200, result);
    return true;
  }
  if (path === "/library" && method === "POST") {
    const wsId = await requireWorkspaceId(pool, userId, query);
    const { name, mime, stream, subpath } = await parseMultipartFileStream(req);
    const result = await libraryRoutes.upload(storage, wsId, { name, mime, stream, subpath }, emit);
    sendJson(res, 201, result);
    return true;
  }
  if (path === "/library" && method === "PATCH") {
    const wsId = await requireWorkspaceId(pool, userId, query);
    const body = await parseBody(req) as { from?: unknown; to?: unknown };
    if (typeof body.from !== "string" || typeof body.to !== "string") {
      throw new ValidationError("Body must be { from: string, to: string }");
    }
    requireLibraryPathInWorkspace(body.from, wsId);
    requireLibraryPathInWorkspace(body.to, wsId);
    await requireExistingLibraryPathForRoute(pool, storage, body.from, wsId);
    await requireLibraryDestinationForRoute(pool, storage, body.to, wsId);
    const result = await libraryRoutes.move(storage, wsId, body.from, body.to, emit);
    sendJson(res, 200, result);
    return true;
  }
  if (path === "/library/folder" && method === "POST") {
    const wsId = await requireWorkspaceId(pool, userId, query);
    const body = await parseBody(req) as { path?: unknown };
    if (typeof body.path !== "string" || body.path === "") {
      throw new ValidationError("Body must include { path: string }");
    }
    requireLibraryPathInWorkspace(body.path, wsId);
    await requireLibraryDestinationForRoute(pool, storage, body.path, wsId);
    const result = await libraryRoutes.createFolder(storage, wsId, body.path, emit);
    sendJson(res, 201, result);
    return true;
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
    const result = await libraryRoutes.createLink(storage, wsId, { url: body.url, name, subpath }, emit);
    sendJson(res, 201, result);
    return true;
  }
  if (path === "/library/meta" && method === "GET") {
    const p = query.get("path");
    if (!p) throw new ValidationError("Missing path query parameter");
    const wsId = await requireWorkspaceId(pool, userId, query);
    await requireReadablePathForRoute(pool, storage, userId, p, wsId);
    const result = await libraryRoutes.get(storage, userId, wsId, p);
    // Summary mirrors live at `.chats/<id>/notes/<msgId>.md` — surface the
    // user-friendly "Chat summary" label so the detail view doesn't title
    // the page with the messageId-based filename.
    const decorated = /^\.chats\/cht_[A-Za-z0-9_-]+\/notes\/[^/]+\.md$/.test(p)
      ? { ...result, label: "Chat summary" }
      : result;
    sendJson(res, 200, decorated);
    return true;
  }
  if (path === "/library/download" && method === "GET") {
    const p = query.get("path");
    if (!p) throw new ValidationError("Missing path query parameter");
    const wsId = await requireWorkspaceId(pool, userId, query);
    await requireReadablePathForRoute(pool, storage, userId, p, wsId);
    const { stream, file } = await libraryRoutes.download(storage, userId, wsId, p);
    res.writeHead(200, {
      "Content-Type": file.mime,
      "Content-Disposition": `attachment; filename="${file.name}"`,
    });
    stream.pipe(res);
    return true;
  }
  if (path === "/library/content" && method === "GET") {
    const p = query.get("path");
    if (!p) throw new ValidationError("Missing path query parameter");
    const wsId = await requireWorkspaceId(pool, userId, query);
    await requireReadablePathForRoute(pool, storage, userId, p, wsId);
    const { stream, file } = await libraryRoutes.download(storage, userId, wsId, p);
    res.writeHead(200, {
      "Content-Type": file.mime,
      "Content-Disposition": `inline; filename="${file.name}"`,
      "Content-Length": String(file.size),
      "ETag": `"${file.updatedAtMs}"`,
    });
    stream.pipe(res);
    return true;
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
      const result = await libraryRoutes.saveContent(storage, userId, wsId, p, req, emit, ifMatch);
      sendJson(res, 200, result);
    } catch (err) {
      if (err instanceof ConflictError) {
        const { stream: currentStream, file: currentFile } = await libraryRoutes.download(storage, userId, wsId, p);
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
    return true;
  }
  if (path === "/library" && method === "DELETE") {
    const p = query.get("path");
    if (!p) throw new ValidationError("Missing path query parameter");
    const wsId = await requireWorkspaceId(pool, userId, query);
    requireLibraryPathInWorkspace(p, wsId);
    await requireExistingLibraryPathForRoute(pool, storage, p, wsId);
    await libraryRoutes.remove(storage, wsId, p, emit);
    sendJson(res, 200, { ok: true });
    return true;
  }

  return false;
}
