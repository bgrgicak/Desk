/**
 * Demo server: builds the app, serves static files, and proxies API + WS
 * traffic to the running desk-server — all on one origin so the browser
 * doesn't need CORS workarounds.
 *
 * Usage: DESK_API_PORT=18080 DESK_APP_PORT=14173 npx tsx scripts/serve.ts
 */
import * as http from "node:http";
import * as net from "node:net";
import * as fsSync from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(__dirname, "..");
const DIST_DIR = path.join(APP_ROOT, "dist");

const API_PORT = parseInt(process.env.DESK_API_PORT ?? "18080", 10);
const APP_PORT = parseInt(process.env.DESK_APP_PORT ?? "14173", 10);

const MIME: Record<string, string> = {
  ".html": "text/html",
  ".js": "application/javascript",
  ".mjs": "application/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

const API_PREFIXES = [
  "/auth/", "/me", "/workspaces", "/agents", "/chats",
  "/library", "/runs", "/scheduled-jobs", "/search", "/openapi.json", "/ws",
];

function isApiPath(p: string): boolean {
  for (const pref of API_PREFIXES) {
    if (p === pref || p.startsWith(pref)) return true;
  }
  return false;
}

console.log("building app...");
execSync("npx vite build", { cwd: APP_ROOT, stdio: "inherit" });

const server = http.createServer((req, res) => {
  const urlPath = (req.url ?? "/").split("?")[0];
  if (isApiPath(urlPath)) {
    const proxyReq = http.request({
      hostname: "127.0.0.1", port: API_PORT, path: req.url, method: req.method, headers: req.headers,
    }, (proxyRes) => {
      res.writeHead(proxyRes.statusCode ?? 500, proxyRes.headers);
      proxyRes.pipe(res);
    });
    proxyReq.on("error", () => { res.writeHead(502); res.end("Bad gateway"); });
    req.pipe(proxyReq);
    return;
  }

  let filePath = path.join(DIST_DIR, urlPath === "/" ? "index.html" : urlPath);
  if (!fsSync.existsSync(filePath)) filePath = path.join(DIST_DIR, "index.html");
  const ext = path.extname(filePath);
  const mime = MIME[ext] ?? "application/octet-stream";
  try {
    const content = fsSync.readFileSync(filePath);
    res.writeHead(200, { "Content-Type": mime });
    res.end(content);
  } catch {
    res.writeHead(404); res.end("Not found");
  }
});

server.on("upgrade", (req, socket, head) => {
  const proxy = net.createConnection({ host: "127.0.0.1", port: API_PORT }, () => {
    let reqLine = `${req.method} ${req.url} HTTP/1.1\r\n`;
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      reqLine += `${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}\r\n`;
    }
    reqLine += "\r\n";
    proxy.write(reqLine);
    if (head.length) proxy.write(head);
    proxy.pipe(socket); socket.pipe(proxy);
  });
  proxy.on("error", () => socket.destroy());
  socket.on("error", () => proxy.destroy());
});

server.listen(APP_PORT, "127.0.0.1", () => {
  console.log(`desk app ready: http://127.0.0.1:${APP_PORT}`);
  console.log(`(proxies /auth /me /workspaces /agents /chats /library /runs /scheduled-jobs /search /openapi.json /ws → 127.0.0.1:${API_PORT})`);
});
