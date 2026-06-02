/**
 * Static-serve for the @roomy-ai/app SPA.
 *
 * Active only when ROOMY_SERVE_APP=1 (the CLI sets this for published
 * installs; dev never sets it because Vite serves the SPA on :5173 with
 * /api/* proxied here). Without that env, the API behaves exactly as
 * before — no static fallback, no SPA index served.
 *
 * Lookup order for the dist directory:
 *   1. ROOMY_APP_DIST env var (the CLI points this at the @roomy-ai/app
 *      install location it resolves at boot).
 *   2. ../../app/dist relative to this file (the monorepo dev fallback so
 *      a developer can flip ROOMY_SERVE_APP=1 locally to exercise the
 *      production code path without a published install).
 *   3. require.resolve('@roomy-ai/app/package.json') — walks node_modules
 *      so the api package itself can pull in @roomy-ai/app via npm.
 */
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ServerResponse } from "node:http";

const MIME_BY_EXT: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".map": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".webmanifest": "application/manifest+json",
};

function mimeFor(path: string): string {
  return MIME_BY_EXT[extname(path).toLowerCase()] ?? "application/octet-stream";
}

export function resolveAppDist(): string | null {
  const envDist = process.env.ROOMY_APP_DIST;
  if (envDist && envDist.length > 0) return resolve(envDist);

  const here = fileURLToPath(import.meta.url);
  const monorepoDev = resolve(here, "..", "..", "..", "..", "app", "dist");
  // Optimistic — caller verifies the directory exists.
  return monorepoDev;
}

/**
 * Returns true if `reqPath` is plausibly handled by static-serve (i.e.
 * it's not an API route, WS upgrade, internal hook, or sandbox callback).
 * Keep in sync with the auth middleware's prefix list.
 */
export function isStaticPath(reqPath: string): boolean {
  if (reqPath === "/ws") return false;
  if (reqPath.startsWith("/api/")) return false;
  if (reqPath.startsWith("/internal/")) return false;
  if (reqPath.startsWith("/sandbox/")) return false;
  if (reqPath.startsWith("/apps/")) return false;
  return true;
}

/**
 * Serves the file at `<distRoot>/<reqPath>` if it exists, otherwise falls
 * back to `<distRoot>/index.html` so client-side routing works (a user
 * deep-linking to `/chats/abc` on the SPA gets the index, the SPA boots,
 * and React Router resolves the route in-browser).
 *
 * Path traversal protection: any normalised path that escapes distRoot
 * is treated as not-found.
 */
export async function serveStaticOrIndex(
  reqPath: string,
  res: ServerResponse,
  distRoot: string,
): Promise<void> {
  const decoded = decodeURIComponent(reqPath);
  const candidate = decoded === "/" ? "/index.html" : decoded;
  const target = normalize(join(distRoot, candidate));

  // Refuse anything that escapes the dist root via .. traversal.
  if (!target.startsWith(distRoot)) {
    return sendIndex(res, distRoot);
  }

  try {
    const s = await stat(target);
    if (s.isFile()) {
      res.writeHead(200, {
        "Content-Type": mimeFor(target),
        "Content-Length": String(s.size),
      });
      createReadStream(target).pipe(res);
      return;
    }
  } catch {
    // Fall through to SPA index.
  }
  return sendIndex(res, distRoot);
}

async function sendIndex(res: ServerResponse, distRoot: string): Promise<void> {
  const indexPath = join(distRoot, "index.html");
  try {
    const s = await stat(indexPath);
    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Length": String(s.size),
    });
    createReadStream(indexPath).pipe(res);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("App dist not found at " + distRoot);
  }
}
