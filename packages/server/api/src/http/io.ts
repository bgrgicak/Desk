import { type IncomingMessage, type ServerResponse } from "node:http";
import { join as pathJoin } from "node:path";
import { MAX_MESSAGE_BYTES, ValidationError } from "@roomy-ai/shared";

/**
 * Low-level request/response I/O helpers — pure plumbing with no
 * application state.  Kept separate from multipart/auth/path-traversal
 * helpers so each module is reviewed in isolation.
 */

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(json) });
  res.end(json);
}

export function readRawBody(
  req: IncomingMessage,
  opts: { limitBytes?: number } = {},
): Promise<Buffer> {
  const limitBytes = opts.limitBytes ?? MAX_MESSAGE_BYTES;
  const headers = req.headers ?? {};
  const contentLength = headers["content-length"];
  const contentLengthValue = Array.isArray(contentLength) ? contentLength[0] : contentLength;
  if (contentLengthValue) {
    const parsed = Number(contentLengthValue);
    if (Number.isFinite(parsed) && parsed > limitBytes) {
      return Promise.reject(new ValidationError(`Request body exceeds maximum size of ${limitBytes} bytes`));
    }
  }
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;

    req.on("data", (chunk: Buffer) => {
      if (done) return;
      size += chunk.length;
      if (size > limitBytes) {
        done = true;
        reject(new ValidationError(`Request body exceeds maximum size of ${limitBytes} bytes`));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (!done) resolve(Buffer.concat(chunks, size));
    });
    req.on("error", (err) => {
      if (!done) reject(err);
    });
  });
}

export async function parseBody(req: IncomingMessage): Promise<unknown> {
  const raw = await readRawBody(req);
  if (raw.length === 0) return {};
  return JSON.parse(raw.toString());
}

/**
 * Default destination for `/internal/backup`. Lands next to the live DB
 * inside `$ROOMY_HOME/backups/` so file ownership matches the DB and the
 * directory is included in any host-level backup of the data root. Uses
 * UTC date so multi-region rsync targets don't fight over filenames.
 */
export function defaultBackupPath(roomyHome: string): string {
  const ts = new Date().toISOString().replace(/[:T]/g, "-").slice(0, 19);
  return pathJoin(roomyHome, "backups", `roomy-${ts}.sqlite3`);
}
