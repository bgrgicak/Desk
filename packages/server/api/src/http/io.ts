import { type IncomingMessage, type ServerResponse } from "node:http";
import { join as pathJoin } from "node:path";

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
