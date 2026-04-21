import * as http from "node:http";
import * as net from "node:net";
import pg from "pg";
import {
  TOOLS,
  type ToolName,
  type WsEvent,
  DeskError,
  ForbiddenError,
  ValidationError,
  generateId,
} from "@desk/shared";
import { queries } from "@desk/db";
import type { StorageContext } from "@desk/storage";
import { authenticate, type AuthResult } from "./auth.js";
import { handlers } from "./handlers/index.js";

export interface ToolServerOptions {
  pool: pg.Pool;
  storage: StorageContext;
  onEvent?: (event: WsEvent) => void;
}

export interface HandlerContext {
  pool: pg.Pool;
  storage: StorageContext;
  auth: AuthResult;
  emit: (event: WsEvent) => void;
}

/**
 * Creates the Tool API HTTP server.
 * Can listen on a UDS or TCP port.
 */
export function createToolServer(opts: ToolServerOptions): http.Server {
  const { pool, storage, onEvent } = opts;

  const server = http.createServer(async (req, res) => {
    try {
      // Parse the tool name from the URL
      const url = new URL(req.url ?? "/", "http://localhost");
      const match = url.pathname.match(/^\/tools\/(.+)$/);
      if (!match) {
        sendJson(res, 404, { code: "NOT_FOUND", message: "Unknown route" });
        return;
      }

      const toolName = match[1] as ToolName;
      if (!(toolName in TOOLS)) {
        sendJson(res, 404, { code: "NOT_FOUND", message: `Unknown tool: ${toolName}` });
        return;
      }

      if (req.method !== "POST") {
        sendJson(res, 405, { code: "METHOD_NOT_ALLOWED", message: "Only POST allowed" });
        return;
      }

      // Authenticate
      const auth = await authenticate(pool, req.headers["x-desk-sandbox-token"] as string | undefined);

      // Check allowlist
      if (!auth.agent.toolAllowlist.includes(toolName)) {
        throw new ForbiddenError(`Tool ${toolName} not in agent allowlist`);
      }

      // Parse body
      const body = await readBody(req);
      const tool = TOOLS[toolName];
      let parsed: unknown;
      try {
        parsed = tool.request.parse(JSON.parse(body));
      } catch (err) {
        throw new ValidationError(`Invalid request body: ${err instanceof Error ? err.message : String(err)}`);
      }

      // Build handler context
      const ctx: HandlerContext = {
        pool,
        storage,
        auth,
        emit: onEvent ?? (() => {}),
      };

      // Dispatch to handler
      const handler = handlers[toolName];
      if (!handler) {
        sendJson(res, 501, { code: "NOT_IMPLEMENTED", message: `Handler not implemented: ${toolName}` });
        return;
      }

      const startTime = Date.now();
      const result = await handler(ctx, parsed);
      const durationMs = Date.now() - startTime;

      // Validate response
      const validated = tool.response.parse(result);

      // Audit the call to run_events if there's an active run context
      // For now, we audit to a special "tool_audit" table pattern via run_events
      // The run_id comes from the session; if not available, we skip audit
      try {
        await queries.runEvents.append(pool, {
          id: generateId("runEvent"),
          runId: auth.session.id, // Use session ID as a proxy; real run_id wired later
          seq: Date.now(), // Monotonic-enough for audit
          kind: "event",
          payload: {
            type: "tool_call",
            name: toolName,
            args: parsed as Record<string, unknown>,
            outcome: "success",
            durationMs,
          },
        });
      } catch {
        // Audit failure should not block the response
      }

      sendJson(res, 200, validated);
    } catch (err) {
      if (err instanceof DeskError) {
        const status = errorToStatus(err);
        sendJson(res, status, { code: err.code, message: err.message });
      } else {
        sendJson(res, 500, { code: "INTERNAL", message: "Internal server error" });
      }
    }
  });

  return server;
}

/** Start listening on a Unix domain socket. */
export function listenOnSocket(server: http.Server, socketPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    // Remove stale socket file
    const fs = require("node:fs");
    try { fs.unlinkSync(socketPath); } catch { /* ok */ }

    server.listen(socketPath, () => resolve());
    server.once("error", reject);
  });
}

/** Start listening on a TCP port. */
export function listenOnPort(server: http.Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    server.listen(port, "127.0.0.1", () => resolve());
    server.once("error", reject);
  });
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString()));
    req.on("error", reject);
  });
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(json) });
  res.end(json);
}

function errorToStatus(err: DeskError): number {
  switch (err.code) {
    case "NOT_FOUND": return 404;
    case "UNAUTHORIZED": return 401;
    case "FORBIDDEN": return 403;
    case "VALIDATION": return 400;
    case "CONFLICT": return 409;
    default: return 500;
  }
}
