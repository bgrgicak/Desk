import { createServer as httpCreateServer, type Server } from "node:http";

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