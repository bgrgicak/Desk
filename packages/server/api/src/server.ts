import { createServer as httpCreateServer, type Server } from "node:http";

/**
 * Creates a minimal HTTP server (backward-compatible hello-world).
 * For the full API, use createApp from ./app.ts instead.
 */
export function createServer(): Server {
  return httpCreateServer((req, res) => {
    if (req.method === "GET" && req.url === "/") {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("hello world");
      return;
    }
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("not found");
  });
}
