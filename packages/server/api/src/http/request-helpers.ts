import { type IncomingMessage, type ServerResponse } from "node:http";
import { type Readable } from "node:stream";
import { join as pathJoin, sep as pathSep } from "node:path";
import { realpath as fsRealpath } from "node:fs/promises";
import Busboy from "busboy";
import { type Pool } from "@agent-desk/db";
import { NotFoundError, UnauthorizedError, ValidationError } from "@agent-desk/shared";
import {
  chatArtifactsDir,
  resolveHostPath,
  workspaceRootPath,
  type StorageContext,
} from "@agent-desk/storage";
import { verifySession } from "../auth/sessions.js";
import { consumeRateLimit } from "../auth/rateLimit.js";
import {
  parseReadableChatArtifactPath,
  requireReadablePathInWorkspace,
} from "../workspace-scope.js";

/**
 * HTTP request/response helpers shared by every route in app.ts.
 * Extracted into its own module so app.ts can focus on the dispatcher
 * chain instead of carrying ~200 lines of plumbing.
 */

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(json) });
  res.end(json);
}

/**
 * Consults a named rate-limit bucket and emits a 429 if the key is
 * over budget. Returns true when a response has been written and the
 * caller should early-return.
 *
 * The Retry-After header carries the time-to-recover in seconds, with
 * a floor of 1s so well-behaved clients don't busy-loop.
 */
export function denyOverLimit(res: ServerResponse, bucket: string, key: string): boolean {
  if (!key) return false; // unknown client IP — don't block, log only
  const decision = consumeRateLimit(bucket, key);
  if (decision.allowed) return false;
  const retryAfterSec = Math.max(1, Math.ceil(decision.retryAfterMs / 1000));
  res.setHeader("Retry-After", String(retryAfterSec));
  sendJson(res, 429, {
    code: "RATE_LIMITED",
    message: "Too many requests; slow down",
  });
  return true;
}

export function readRawBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

export async function parseBody(req: IncomingMessage): Promise<unknown> {
  const raw = await readRawBody(req);
  if (raw.length === 0) return {};
  return JSON.parse(raw.toString());
}

/**
 * Default destination for `/internal/backup`. Lands next to the live DB
 * inside `$DESK_HOME/backups/` so file ownership matches the DB and the
 * directory is included in any host-level backup of the data root. Uses
 * UTC date so multi-region rsync targets don't fight over filenames.
 */
export function defaultBackupPath(deskHome: string): string {
  const ts = new Date().toISOString().replace(/[:T]/g, "-").slice(0, 19);
  return pathJoin(deskHome, "backups", `desk-${ts}.sqlite3`);
}

/**
 * Parses a multipart/form-data body using Node's built-in Fetch API.
 * Returns a FormData instance; callers pull out parts by field name.
 */
export async function parseMultipart(req: IncomingMessage): Promise<FormData> {
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

/**
 * Streaming multipart parser for single-file uploads. Text fields must
 * appear before the file part in the body (the client must append them
 * first). The returned stream is busboy's raw file stream — callers must
 * consume it fully so the underlying HTTP request drains.
 */
export function parseMultipartFileStream(req: IncomingMessage): Promise<{
  name: string;
  mime: string;
  stream: Readable;
  subpath?: string;
}> {
  const contentType = req.headers["content-type"] ?? "";
  if (!contentType.toLowerCase().startsWith("multipart/form-data")) {
    return Promise.reject(new ValidationError("Expected multipart/form-data body"));
  }
  return new Promise((resolve, reject) => {
    const bb = Busboy({ headers: req.headers });
    const fields: Record<string, string> = {};
    let resolved = false;

    bb.on("field", (fieldname, value) => { fields[fieldname] = value; });

    bb.on("file", (fieldname, fileStream, info) => {
      if (fieldname !== "file" || resolved) {
        fileStream.resume();
        return;
      }
      resolved = true;
      const name = info.filename || fields["name"] || "upload";
      const mime = info.mimeType || "application/octet-stream";
      const subpath = fields["subpath"] && fields["subpath"] !== "" ? fields["subpath"] : undefined;
      resolve({ name, mime, stream: fileStream, subpath });
    });

    bb.on("error", reject);
    bb.on("close", () => {
      if (!resolved) reject(new ValidationError("Missing 'file' part in multipart body"));
    });

    req.pipe(bb);
  });
}

/**
 * The /apps/* dispatcher's `issue` endpoint runs after requireAuth has
 * already let the path through (no global Bearer check on /apps/*). This
 * helper re-applies the Bearer check locally so the issue endpoint
 * cannot mint app-session tokens without a valid user session.
 */
export async function requireBearerForApps(pool: Pool, req: IncomingMessage): Promise<string> {
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

export async function requireReadablePathForRoute(
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
