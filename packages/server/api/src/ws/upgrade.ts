import { type Server } from "node:http";
import { createHash } from "node:crypto";
import { type Pool } from "@agent-desk/db";
import { DeskError } from "@agent-desk/shared";
import { withModule } from "@agent-desk/shared/logger";
import { enforceMustChangePassword } from "../auth/middleware.js";
import { verifySession } from "../auth/sessions.js";
import { isWsOriginAllowed } from "../http/security-headers.js";
import { addConnection, removeConnection } from "./registry.js";

const log = withModule("api/ws/upgrade");

// RFC 6455 §1.3: fixed magic GUID for the WebSocket handshake.
const WS_MAGIC_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

/**
 * Wires the `/ws` upgrade handler onto the supplied HTTP server.
 *
 * Sequence of checks before the 101 handshake completes:
 *   1. Path must be `/ws` (anything else closes the socket).
 *   2. Origin must be on the WS allowlist (CSWSH mitigation) — runs
 *      before the token check so a malicious page can't probe whether
 *      a token is valid by reading the response code.
 *   3. `?token=` must resolve to a live session.
 *   4. The session's user must not be on the must-change-password gate
 *      (live WS connections receive workspace events; a user still on
 *      the public seed credential would defeat the gate otherwise).
 *
 * On success, registers a minimal WS-like sender object (text frames
 * only — that's all the broadcast bus needs) with the connection
 * registry and unhooks it on close/error.
 */
export function installWsUpgradeHandler(server: Server, pool: Pool): void {
  server.on("upgrade", (req, socket, _head) => {
    void (async () => {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (url.pathname !== "/ws") {
        socket.destroy();
        return;
      }

      const origin = req.headers.origin;
      const originHeader = Array.isArray(origin) ? origin[0] : origin;
      if (!isWsOriginAllowed(originHeader)) {
        socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
        socket.destroy();
        return;
      }

      const token = url.searchParams.get("token");
      if (!token) {
        socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
        socket.destroy();
        return;
      }

      const userId = await verifySession(pool, token);
      if (!userId) {
        socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
        socket.destroy();
        return;
      }

      // Distinguish ForbiddenError (must-change gate) from other
      // failures (transient DB issue, etc.) so a hiccup on findById
      // doesn't false-positive into a 403 for a non-must-change user.
      try {
        await enforceMustChangePassword(pool, userId, "GET", "/ws");
      } catch (err) {
        if (err instanceof DeskError && err.code === "FORBIDDEN") {
          socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
        } else {
          log.warn({ err, userId }, "ws upgrade: must-change-password check threw");
          socket.write("HTTP/1.1 500 Internal Server Error\r\n\r\n");
        }
        socket.destroy();
        return;
      }

      // Perform the WebSocket handshake. The header may be a string or an
      // array of strings; the RFC says take the first.
      const rawKey = req.headers["sec-websocket-key"];
      const key = Array.isArray(rawKey) ? rawKey[0] : rawKey;
      if (!key) {
        socket.destroy();
        return;
      }

      const acceptKey = createHash("sha1")
        .update(key + WS_MAGIC_GUID)
        .digest("base64");

      socket.write(
        "HTTP/1.1 101 Switching Protocols\r\n" +
        "Upgrade: websocket\r\n" +
        "Connection: Upgrade\r\n" +
        `Sec-WebSocket-Accept: ${acceptKey}\r\n` +
        "\r\n",
      );

      // Minimal WS-like sender object: text frames only — that's all
      // the broadcast bus emits.  No client-→-server message parsing
      // needed; the client only listens.
      const ws = {
        readyState: 1,
        send(data: string) {
          const payload = Buffer.from(data, "utf-8");
          let header: Buffer;
          if (payload.length < 126) {
            header = Buffer.alloc(2);
            header[0] = 0x81; // FIN + text opcode
            header[1] = payload.length;
          } else if (payload.length < 65536) {
            header = Buffer.alloc(4);
            header[0] = 0x81;
            header[1] = 126;
            header.writeUInt16BE(payload.length, 2);
          } else {
            header = Buffer.alloc(10);
            header[0] = 0x81;
            header[1] = 127;
            header.writeBigUInt64BE(BigInt(payload.length), 2);
          }
          socket.write(Buffer.concat([header, payload]));
        },
      };

      addConnection(userId, ws);

      // Keepalive ping. Browser WebSocket auto-responds to PING frames
      // with PONG (RFC 6455 §5.5.2), so server-initiated pings are
      // enough to keep the connection above proxy idle timeouts. Live
      // repro confirmed nginx (default proxy_read_timeout=60s) drops an
      // idle WS at exactly t=60s; 25s leaves a comfortable margin under
      // any reasonable upstream timeout. The interval is unref()d so
      // it doesn't block process shutdown.
      // `DESK_WS_PING_INTERVAL_MS` overrides the default — tests use a
      // much shorter value so they don't sit through 25 s per assertion.
      const wsPingIntervalMs = Math.max(
        100,
        parseInt(process.env.DESK_WS_PING_INTERVAL_MS ?? "25000", 10),
      );
      const pingFrame = Buffer.from([0x89, 0x00]); // FIN + ping opcode, zero-length payload
      const pingTimer = setInterval(() => {
        if (ws.readyState !== 1) return;
        try {
          socket.write(pingFrame);
        } catch {
          // socket already dead — close handler will clean up the registry
        }
      }, wsPingIntervalMs);
      pingTimer.unref();

      socket.on("close", () => {
        ws.readyState = 3; // CLOSED
        clearInterval(pingTimer);
        removeConnection(userId, ws);
      });

      socket.on("error", () => {
        ws.readyState = 3;
        clearInterval(pingTimer);
        removeConnection(userId, ws);
      });
    })().catch((err) => {
      log.error("WebSocket upgrade failed:", err);
      try { socket.destroy(); } catch { /* ignore */ }
    });
  });
}
