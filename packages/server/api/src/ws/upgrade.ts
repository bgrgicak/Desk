import { type Server } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import { type Pool } from "@agent-desk/db";
import { DeskError } from "@agent-desk/shared";
import { withModule } from "@agent-desk/shared/logger";
import { enforceMustChangePassword } from "../auth/middleware.js";
import { verifySession } from "../auth/sessions.js";
import { isWsOriginAllowed } from "../http/security-headers.js";
import { addConnection, removeConnection } from "./registry.js";

const log = withModule("api/ws/upgrade");

/**
 * Wires the `/ws` upgrade handler onto the supplied HTTP server.
 *
 * Uses the `ws` library for the protocol layer (frame encoding, ping/
 * pong keepalives, proper close handshaking) so the bespoke RFC 6455
 * code that used to live here is gone — the moment anyone needs binary
 * frames, fragmentation, or close-code handling we get it for free.
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
 * On success, registers the WebSocket with the broadcast registry and
 * unhooks it on close/error.  `noServer:true` lets us run all four
 * pre-handshake checks against the raw socket before the ws library
 * commits to the upgrade — failed checks write a plain HTTP error
 * response and destroy the socket without ever calling `handleUpgrade`.
 */
export function installWsUpgradeHandler(server: Server, pool: Pool): void {
  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (req, socket, head) => {
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

      wss.handleUpgrade(req, socket, head, (ws: WebSocket) => {
        addConnection(userId, ws);
        ws.on("close", () => removeConnection(userId, ws));
        ws.on("error", (err: Error) => {
          log.warn({ err, userId }, "ws connection error");
          removeConnection(userId, ws);
        });
      });
    })().catch((err) => {
      log.error({ err }, "WebSocket upgrade failed");
      try { socket.destroy(); } catch { /* ignore */ }
    });
  });
}
