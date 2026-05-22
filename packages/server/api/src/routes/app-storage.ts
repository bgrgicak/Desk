/**
 * Per-app document-collections storage (issue #47, PR-H).
 *
 * Each `<name>.app/` carries its own SQLite file at
 * `<name>.app/.storage/data.sqlite`. The DB schema is a single `docs`
 * table keyed by `(collection, doc_id)`. The contract is intentionally
 * narrow:
 *
 *   GET    /apps/{chat,library}/.../storage/:collection            list
 *   POST   /apps/{chat,library}/.../storage/:collection            create (UUID v4)
 *   GET    /apps/{chat,library}/.../storage/:collection/:docId     read
 *   PUT    /apps/{chat,library}/.../storage/:collection/:docId     upsert
 *   DELETE /apps/{chat,library}/.../storage/:collection/:docId     delete
 *
 * Auth: the same per-app HttpOnly cookie that authenticates static
 * asset requests (PR-C). Capabilities (`storage.read`, `storage.write`)
 * are read off the issued `app_sessions` row at request time, NOT off
 * the manifest each call — once a session exists, its capability set
 * is immutable for its lifetime.
 *
 * Storage travels with the directory: promoting a chat-artifact app to
 * the library is a plain `mv` of the `<name>.app/` tree, which carries
 * `.storage/data.sqlite` along.
 */
import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { IncomingMessage, ServerResponse } from "node:http";
import { type Pool, queries } from "@roomy-ai/db";
import {
  ForbiddenError,
  NotFoundError,
  UnauthorizedError,
  ValidationError,
} from "@roomy-ai/shared";
import {
  chatArtifactsDir,
  validateLibrarySubpath,
  workspaceRootPath,
  type StorageContext,
} from "@roomy-ai/storage";

const APP_NAME_PATTERN = /^[a-z][a-z0-9-]{0,62}$/;
const COLLECTION_PATTERN = /^[a-z][a-z0-9_-]{0,62}$/;
const DOC_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS docs (
    collection TEXT NOT NULL,
    doc_id     TEXT NOT NULL,
    doc        TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (collection, doc_id)
  );
  CREATE INDEX IF NOT EXISTS docs_updated_at_idx ON docs (collection, updated_at);
`;

/**
 * Open a per-app SQLite handle, run `fn`, and always close.
 *
 * We deliberately do NOT cache the handle. The `<name>.app/` directory
 * (and therefore the `data.sqlite` file inside it) is movable: PR-E
 * promotes a chat artifact into the library, and PR-G's
 * `replaceLibraryAppFromChat` does two `fs.rename`s that trade the
 * library copy with a chat copy. A cached handle survives those renames
 * (open file descriptors stay valid through `rename` on Linux) and
 * silently keeps writing to the *original* inode — which is now in
 * `.trash/.app-versions/...`. Re-opening per request always lands on
 * whichever inode currently lives at the path.
 *
 * SQLite open cost on an existing WAL-mode DB is microseconds — the
 * cache buys very little and lost a correctness invariant.
 */
async function withAppDb<T>(
  ctx: AppStorageContext,
  fn: (db: DatabaseSync) => T,
): Promise<T> {
  const storageDirReal = await ensureSafeStorageDir(ctx);
  const dbPath = path.join(storageDirReal, "data.sqlite");
  const db = new DatabaseSync(dbPath);
  try {
    db.exec("PRAGMA journal_mode=WAL");
    db.exec("PRAGMA foreign_keys=ON");
    db.exec(SCHEMA_SQL);
    return fn(db);
  } finally {
    try { db.close(); } catch { /* best-effort */ }
  }
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function parseCookies(req: IncomingMessage): Record<string, string> {
  const raw = req.headers.cookie;
  if (!raw) return {};
  const out: Record<string, string> = {};
  for (const part of raw.split(";")) {
    const i = part.indexOf("=");
    if (i === -1) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}

function chatCookieName(chatId: string, appName: string): string {
  return `roomy_app_${chatId}_${appName}`;
}

// Shared prefix for every library-scope cookie. The full cookie name
// is `roomy_libapp_<workspaceId>_<appName>`; the workspaceId is encoded
// at request time so cross-workspace replay fails the verify step.
const LIBRARY_COOKIE_PREFIX = "roomy_libapp_";

function normalizeLibraryAppPath(appPathOrName: string): { appPath: string; appName: string } | null {
  const appPath = appPathOrName.endsWith(".app") || appPathOrName.includes("/")
    ? appPathOrName
    : `${appPathOrName}.app`;
  validateLibrarySubpath(appPath);
  if (!appPath.endsWith(".app")) return null;
  const appName = path.basename(appPath, ".app");
  if (!APP_NAME_PATTERN.test(appName)) return null;
  return { appPath, appName };
}

interface AppStorageContext {
  scope: "chat" | "library";
  storageDir: string;          // <appRoot>/.storage
  appRootReal: string;
  capabilities: string[];
  appName: string;
  chatId: string | null;
}

async function resolveSafeAppRoot(
  appRoot: string,
  workspaceRoot: string,
  appName: string,
): Promise<string> {
  const linkStat = await fs.lstat(appRoot).catch(() => null);
  if (!linkStat || linkStat.isSymbolicLink() || !linkStat.isDirectory()) {
    throw new NotFoundError(`App not found: ${appName}`);
  }

  const [appRootReal, workspaceRootReal] = await Promise.all([
    fs.realpath(appRoot),
    fs.realpath(workspaceRoot).catch(() => workspaceRoot),
  ]);
  if (!appRootReal.startsWith(workspaceRootReal + path.sep) && appRootReal !== workspaceRootReal) {
    throw new NotFoundError(`App not found: ${appName}`);
  }
  return appRootReal;
}

async function ensureSafeStorageDir(ctx: AppStorageContext): Promise<string> {
  await fs.mkdir(ctx.storageDir, { recursive: true });
  const linkStat = await fs.lstat(ctx.storageDir).catch(() => null);
  if (!linkStat || linkStat.isSymbolicLink() || !linkStat.isDirectory()) {
    throw new NotFoundError(`App storage not found: ${ctx.appName}`);
  }

  const storageDirReal = await fs.realpath(ctx.storageDir);
  if (!storageDirReal.startsWith(ctx.appRootReal + path.sep)) {
    throw new NotFoundError(`App storage not found: ${ctx.appName}`);
  }
  return storageDirReal;
}

async function resolveChatStorage(
  pool: Pool,
  storage: StorageContext,
  req: IncomingMessage,
  chatId: string,
  appName: string,
): Promise<AppStorageContext> {
  const cookies = parseCookies(req);
  const cookieToken = cookies[chatCookieName(chatId, appName)];
  if (!cookieToken) throw new UnauthorizedError("Missing app token");
  const session = await queries.appSessions.verify(pool, hashToken(cookieToken));
  if (!session) throw new UnauthorizedError("Invalid app token");
  if (session.scope !== "chat") throw new UnauthorizedError("Wrong scope");
  if (session.chatId !== chatId || session.appName !== appName) {
    throw new UnauthorizedError("Token scope mismatch");
  }

  const { rows } = await pool.query<{ path: string }>(
    "SELECT w.path FROM chats c JOIN workspaces w ON w.id = c.workspace_id WHERE c.id = ?",
    [chatId],
  );
  if (rows.length === 0) throw new NotFoundError(`Chat not found: ${chatId}`);
  const slug = rows[0].path;
  const workspaceRoot = workspaceRootPath(storage.home, slug);
  const appRoot = path.join(
    chatArtifactsDir(storage.home, slug, chatId),
    `${appName}.app`,
  );
  const appRootReal = await resolveSafeAppRoot(appRoot, workspaceRoot, appName);
  const storageDir = path.join(appRoot, ".storage");
  return {
    scope: "chat",
    storageDir,
    appRootReal,
    capabilities: session.capabilities,
    appName,
    chatId,
  };
}

async function resolveLibraryStorage(
  pool: Pool,
  storage: StorageContext,
  req: IncomingMessage,
  appName: string,
  appPath: string,
  expectedWorkspaceId?: string,
  expectedAssetToken?: string,
): Promise<AppStorageContext> {
  const cookies = parseCookies(req);
  const cookieEntry = Object.entries(cookies).find(
    ([k]) => k.startsWith(LIBRARY_COOKIE_PREFIX) && k.endsWith(`_${appName}`),
  );
  if (!cookieEntry) throw new UnauthorizedError("Missing app token");
  const cookieToken = cookieEntry[1];
  const session = await queries.appSessions.verify(pool, hashToken(cookieToken));
  if (!session) throw new UnauthorizedError("Invalid app token");
  if (session.scope !== "library") throw new UnauthorizedError("Wrong scope");
  if (session.appName !== appName) {
    throw new UnauthorizedError("Token scope mismatch");
  }
  if (expectedWorkspaceId && session.workspaceId !== expectedWorkspaceId) {
    throw new UnauthorizedError("Token scope mismatch");
  }
  if (expectedAssetToken && session.tokenHash !== expectedAssetToken) {
    throw new UnauthorizedError("Token scope mismatch");
  }

  const { rows } = await pool.query<{ path: string }>(
    "SELECT path FROM workspaces WHERE id = ?",
    [session.workspaceId],
  );
  if (rows.length === 0) throw new NotFoundError("Workspace not found");
  const wsRoot = workspaceRootPath(storage.home, rows[0].path);
  const appRoot = path.join(wsRoot, appPath);
  const appRootReal = await resolveSafeAppRoot(appRoot, wsRoot, appName);
  const storageDir = path.join(appRoot, ".storage");
  return {
    scope: "library",
    storageDir,
    appRootReal,
    capabilities: session.capabilities,
    appName,
    chatId: null,
  };
}

function requireCapability(
  ctx: AppStorageContext,
  cap: "storage.read" | "storage.write",
): void {
  if (!ctx.capabilities.includes(cap)) {
    // 403, not 401: the per-app session is valid, the operation just
    // isn't authorized for it.
    throw new ForbiddenError(`Missing capability: ${cap}`);
  }
}

interface DocRow {
  collection: string;
  doc_id: string;
  doc: string;
  created_at: number;
  updated_at: number;
}

interface DocResult {
  id: string;
  doc: unknown;
  createdAt: number;
  updatedAt: number;
}

function rowToDoc(row: DocRow): DocResult {
  return {
    id: row.doc_id,
    doc: JSON.parse(row.doc),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

interface ListPage {
  items: DocResult[];
  nextCursor: string | null;
}

const LIST_DEFAULT_LIMIT = 100;
const LIST_MAX_LIMIT = 500;

interface DecodedCursor {
  updatedAt: number;
  docId: string;
}

/**
 * Cursor format: base64url(`<updatedAtMs>:<docId>`). The list query is
 * `ORDER BY updated_at DESC, doc_id DESC` so a cursor pointing at the
 * last row of page N returns rows strictly older than that row on
 * page N+1, with `doc_id` breaking ties for rows sharing an `updated_at`.
 */
function decodeCursor(raw: string): DecodedCursor | null {
  try {
    const decoded = Buffer.from(raw, "base64url").toString("utf8");
    const sep = decoded.indexOf(":");
    if (sep <= 0) return null;
    const updatedAt = Number(decoded.slice(0, sep));
    const docId = decoded.slice(sep + 1);
    if (!Number.isFinite(updatedAt) || !docId) return null;
    return { updatedAt, docId };
  } catch {
    return null;
  }
}

function encodeCursor(updatedAt: number, docId: string): string {
  return Buffer.from(`${updatedAt}:${docId}`, "utf8").toString("base64url");
}

async function listDocs(
  ctx: AppStorageContext,
  collection: string,
  opts: { limit?: number; cursor?: string | null } = {},
): Promise<ListPage> {
  requireCapability(ctx, "storage.read");
  const limit = Math.min(
    Math.max(1, Math.floor(opts.limit ?? LIST_DEFAULT_LIMIT)),
    LIST_MAX_LIMIT,
  );
  const cursor = opts.cursor ? decodeCursor(opts.cursor) : null;
  return withAppDb(ctx, (db) => {
    const rows = cursor
      ? (db
          .prepare(
            `SELECT * FROM docs
             WHERE collection = ?
               AND (updated_at < ? OR (updated_at = ? AND doc_id < ?))
             ORDER BY updated_at DESC, doc_id DESC
             LIMIT ?`,
          )
          .all(
            collection,
            cursor.updatedAt,
            cursor.updatedAt,
            cursor.docId,
            limit + 1,
          ) as unknown as DocRow[])
      : (db
          .prepare(
            `SELECT * FROM docs
             WHERE collection = ?
             ORDER BY updated_at DESC, doc_id DESC
             LIMIT ?`,
          )
          .all(collection, limit + 1) as unknown as DocRow[]);
    const items = rows.slice(0, limit).map(rowToDoc);
    const nextCursor =
      rows.length > limit && items.length > 0
        ? encodeCursor(items[items.length - 1].updatedAt, items[items.length - 1].id)
        : null;
    return { items, nextCursor };
  });
}

async function getDoc(
  ctx: AppStorageContext,
  collection: string,
  docId: string,
): Promise<DocResult | null> {
  requireCapability(ctx, "storage.read");
  return withAppDb(ctx, (db) => {
    const row = db
      .prepare("SELECT * FROM docs WHERE collection = ? AND doc_id = ?")
      .get(collection, docId) as unknown as DocRow | undefined;
    return row ? rowToDoc(row) : null;
  });
}

async function createDoc(
  ctx: AppStorageContext,
  collection: string,
  doc: unknown,
): Promise<DocResult> {
  requireCapability(ctx, "storage.write");
  return withAppDb(ctx, (db) => {
    const docId = randomUUID();
    const now = Date.now();
    db.prepare(
      "INSERT INTO docs (collection, doc_id, doc, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
    ).run(collection, docId, JSON.stringify(doc), now, now);
    return { id: docId, doc, createdAt: now, updatedAt: now };
  });
}

async function putDoc(
  ctx: AppStorageContext,
  collection: string,
  docId: string,
  doc: unknown,
): Promise<DocResult> {
  requireCapability(ctx, "storage.write");
  return withAppDb(ctx, (db) => {
    const now = Date.now();
    // Upsert: ON CONFLICT preserves the original created_at if the row
    // already existed; updated_at advances either way.
    db.prepare(
      `INSERT INTO docs (collection, doc_id, doc, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(collection, doc_id) DO UPDATE
         SET doc = excluded.doc, updated_at = excluded.updated_at`,
    ).run(collection, docId, JSON.stringify(doc), now, now);
    const row = db
      .prepare("SELECT * FROM docs WHERE collection = ? AND doc_id = ?")
      .get(collection, docId) as unknown as DocRow;
    return rowToDoc(row);
  });
}

async function deleteDoc(
  ctx: AppStorageContext,
  collection: string,
  docId: string,
): Promise<boolean> {
  requireCapability(ctx, "storage.write");
  return withAppDb(ctx, (db) => {
    const info = db
      .prepare("DELETE FROM docs WHERE collection = ? AND doc_id = ?")
      .run(collection, docId);
    return Number(info.changes) > 0;
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(json),
    "Cache-Control": "no-store",
  });
  res.end(json);
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
    if (chunks.reduce((sum, c) => sum + c.length, 0) > 1024 * 1024) {
      throw new ValidationError("Request body too large");
    }
  }
  if (chunks.length === 0) return undefined;
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    throw new ValidationError("Invalid JSON body");
  }
}

interface RouteMatch {
  scope: "chat" | "library";
  segmentsAfterStorage: string[];
  resolveCtx: () => Promise<AppStorageContext>;
}

function matchAppStoragePath(
  pool: Pool,
  storage: StorageContext,
  segments: string[],
  req: IncomingMessage,
): RouteMatch | null {
  // /apps/chat/:chatId/:appName/storage/...
  if (
    segments.length >= 6 &&
    segments[0] === "apps" &&
    segments[1] === "chat" &&
    segments[4] === "storage"
  ) {
    const chatId = decodeURIComponent(segments[2]);
    const appName = decodeURIComponent(segments[3]);
    if (!APP_NAME_PATTERN.test(appName)) return null;
    return {
      scope: "chat",
      segmentsAfterStorage: segments.slice(5),
      resolveCtx: () => resolveChatStorage(pool, storage, req, chatId, appName),
    };
  }
  // /apps/library/:workspaceId/:assetToken/:appPath/storage/...
  // Mirrors the tokenized static-app URL so the HttpOnly cookie can stay
  // path-scoped to one library app and still cover storage calls.
  const tokenizedLibraryStorageIndex = segments.findIndex((segment, index) => index >= 5 && segment === "storage");
  if (
    segments.length >= 7 &&
    segments[0] === "apps" &&
    segments[1] === "library" &&
    /^wks_[A-Za-z0-9_-]+$/.test(decodeURIComponent(segments[2])) &&
    /^[a-f0-9]{64}$/.test(decodeURIComponent(segments[3])) &&
    tokenizedLibraryStorageIndex !== -1
  ) {
    const workspaceId = decodeURIComponent(segments[2]);
    const assetToken = decodeURIComponent(segments[3]);
    const appPath = segments.slice(4, tokenizedLibraryStorageIndex).map((s) => decodeURIComponent(s)).join("/");
    const parsed = normalizeLibraryAppPath(appPath);
    if (!parsed) return null;
    return {
      scope: "library",
      segmentsAfterStorage: segments.slice(tokenizedLibraryStorageIndex + 1),
      resolveCtx: () => resolveLibraryStorage(pool, storage, req, parsed.appName, parsed.appPath, workspaceId, assetToken),
    };
  }

  // /apps/library/:appName/storage/...
  if (
    segments.length >= 5 &&
    segments[0] === "apps" &&
    segments[1] === "library" &&
    segments[3] === "storage"
  ) {
    const parsed = normalizeLibraryAppPath(decodeURIComponent(segments[2]));
    if (!parsed) return null;
    return {
      scope: "library",
      segmentsAfterStorage: segments.slice(4),
      resolveCtx: () => resolveLibraryStorage(pool, storage, req, parsed.appName, parsed.appPath),
    };
  }
  return null;
}

/**
 * Returns true when the request was handled (a status was written).
 * False means the path doesn't match the storage route shape.
 */
export async function handleAppStorageRequest(
  pool: Pool,
  storage: StorageContext,
  segments: string[],
  method: string,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  const match = matchAppStoragePath(pool, storage, segments, req);
  if (!match) return false;

  const [collectionRaw, docIdRaw] = match.segmentsAfterStorage;
  if (match.segmentsAfterStorage.length > 2) {
    throw new ValidationError("Too many storage path segments");
  }
  const collection = collectionRaw ? decodeURIComponent(collectionRaw) : "";
  const docId = docIdRaw ? decodeURIComponent(docIdRaw) : null;
  if (!collection) {
    throw new ValidationError("Missing collection");
  }
  if (!COLLECTION_PATTERN.test(collection)) {
    throw new ValidationError(`Invalid collection name: ${collection}`);
  }
  if (docId !== null && !DOC_ID_PATTERN.test(docId)) {
    throw new ValidationError(`Invalid doc id: ${docId}`);
  }

  const ctx = await match.resolveCtx();
  const url = new URL(req.url ?? "/", "http://localhost");

  if (docId === null) {
    if (method === "GET") {
      const limitParam = url.searchParams.get("limit");
      const limit = limitParam ? Number(limitParam) : undefined;
      if (limit !== undefined && (!Number.isFinite(limit) || limit <= 0)) {
        throw new ValidationError(`Invalid limit: ${limitParam}`);
      }
      const cursor = url.searchParams.get("cursor") ?? null;
      if (cursor && !decodeCursor(cursor)) {
        throw new ValidationError("Invalid cursor");
      }
      const page = await listDocs(ctx, collection, { limit, cursor });
      sendJson(res, 200, page);
      return true;
    }
    if (method === "POST") {
      const body = await readJsonBody(req);
      // Reject empty body explicitly. `null` is a valid JSON value the
      // caller may want to store, but a missing body is a client bug.
      if (body === undefined) {
        throw new ValidationError("Missing JSON body");
      }
      const doc = await createDoc(ctx, collection, body);
      sendJson(res, 201, doc);
      return true;
    }
    throw new ValidationError(`Method ${method} not supported on collection`);
  }

  if (method === "GET") {
    const doc = await getDoc(ctx, collection, docId);
    if (!doc) throw new NotFoundError(`Doc not found: ${collection}/${docId}`);
    sendJson(res, 200, doc);
    return true;
  }
  if (method === "PUT") {
    const body = await readJsonBody(req);
    if (body === undefined) {
      throw new ValidationError("Missing JSON body");
    }
    const doc = await putDoc(ctx, collection, docId, body);
    sendJson(res, 200, doc);
    return true;
  }
  if (method === "DELETE") {
    const removed = await deleteDoc(ctx, collection, docId);
    if (!removed) throw new NotFoundError(`Doc not found: ${collection}/${docId}`);
    res.writeHead(204);
    res.end();
    return true;
  }
  throw new ValidationError(`Method ${method} not supported on doc`);
}
