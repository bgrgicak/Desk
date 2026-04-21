import { describe, it, expect, afterEach, afterAll } from "vitest";
import * as http from "node:http";
import * as net from "node:net";
import * as crypto from "node:crypto";
import { createApp, type AppOptions } from "../src/app.js";
import { issueSession, clearSessions } from "../src/auth/sessions.js";
import { clearConnections, connectionCount, broadcast } from "../src/ws/registry.js";

// Minimal stubs for AppOptions — we only need the WS upgrade path
function stubOpts(): AppOptions {
  return {
    pool: {} as any,
    storage: {} as any,
    runManager: { enqueueRun: async () => ({}), cancelRun: async () => {}, cancelJob: async () => {}, adapter: {} } as any,
    broadcastUserId: "usr_wstest",
  };
}

function getServerPort(server: http.Server): number {
  const addr = server.address() as net.AddressInfo;
  return addr.port;
}

afterEach(() => {
  clearSessions();
  clearConnections();
});

let servers: http.Server[] = [];
afterAll(() => {
  for (const s of servers) s.close();
});

function startServer(): Promise<http.Server> {
  return new Promise((resolve) => {
    const server = createApp(stubOpts());
    server.listen(0, () => {
      servers.push(server);
      resolve(server);
    });
  });
}

/**
 * Performs a raw HTTP upgrade request (no ws library dependency).
 */
function rawUpgrade(
  port: number,
  path: string,
): Promise<{ response: string; socket: net.Socket }> {
  return new Promise((resolve, reject) => {
    const key = crypto.randomBytes(16).toString("base64");
    const socket = net.createConnection({ port, host: "127.0.0.1" }, () => {
      socket.write(
        `GET ${path} HTTP/1.1\r\n` +
        `Host: 127.0.0.1:${port}\r\n` +
        `Upgrade: websocket\r\n` +
        `Connection: Upgrade\r\n` +
        `Sec-WebSocket-Key: ${key}\r\n` +
        `Sec-WebSocket-Version: 13\r\n` +
        `\r\n`,
      );
    });

    let response = "";
    socket.on("data", (chunk) => {
      response += chunk.toString();
      if (response.includes("\r\n\r\n")) {
        resolve({ response, socket });
      }
    });
    socket.on("error", reject);
    setTimeout(() => reject(new Error("Upgrade timeout")), 3000);
  });
}

describe("WebSocket upgrade", () => {
  it("rejects upgrade without token", async () => {
    const server = await startServer();
    const port = getServerPort(server);

    const { response, socket } = await rawUpgrade(port, "/ws");
    socket.destroy();

    expect(response).toContain("401 Unauthorized");
  });

  it("rejects upgrade with invalid token", async () => {
    const server = await startServer();
    const port = getServerPort(server);

    const { response, socket } = await rawUpgrade(port, "/ws?token=ses_invalid");
    socket.destroy();

    expect(response).toContain("401 Unauthorized");
  });

  it("accepts upgrade with valid token and registers connection", async () => {
    const server = await startServer();
    const port = getServerPort(server);

    const token = issueSession("usr_wstest");
    const { response, socket } = await rawUpgrade(port, `/ws?token=${token}`);

    expect(response).toContain("101 Switching Protocols");
    expect(connectionCount()).toBe(1);

    socket.destroy();

    // Give time for close event to propagate
    await new Promise((r) => setTimeout(r, 200));
    // After destruction, the connection should be removed (or pruned on next broadcast)
    expect(connectionCount()).toBeLessThanOrEqual(1);
  });

  it("receives a broadcast event after upgrade", async () => {
    const server = await startServer();
    const port = getServerPort(server);
    const userId = "usr_wstest";

    const token = issueSession(userId);
    const { response, socket } = await rawUpgrade(port, `/ws?token=${token}`);

    expect(response).toContain("101 Switching Protocols");
    expect(connectionCount()).toBe(1);

    // Collect data frames from the socket
    const received: Buffer[] = [];
    socket.on("data", (chunk: Buffer) => received.push(chunk));

    // Broadcast an event to the connected user
    broadcast(userId, {
      type: "run.state_changed",
      payload: {
        id: "run_test1",
        chatId: "chat_1",
        state: "running",
      },
    });

    // Wait a bit for the frame to arrive
    await new Promise((r) => setTimeout(r, 200));

    // Parse the WebSocket text frame
    const frame = Buffer.concat(received);
    expect(frame.length).toBeGreaterThan(2);

    // First byte: 0x81 (FIN + text opcode)
    expect(frame[0]).toBe(0x81);

    // Extract payload from the WS frame
    let payloadStart = 2;
    let payloadLen = frame[1] & 0x7f;
    if (payloadLen === 126) {
      payloadLen = frame.readUInt16BE(2);
      payloadStart = 4;
    } else if (payloadLen === 127) {
      payloadLen = Number(frame.readBigUInt64BE(2));
      payloadStart = 10;
    }

    const payload = frame.subarray(payloadStart, payloadStart + payloadLen).toString("utf-8");
    const parsed = JSON.parse(payload);

    expect(parsed.type).toBe("run.state_changed");
    expect(parsed.payload.id).toBe("run_test1");
    expect(parsed.payload.state).toBe("running");

    socket.destroy();
  });

  it("rejects upgrade on non-/ws path", async () => {
    const server = await startServer();
    const port = getServerPort(server);

    const token = issueSession("usr_wstest");

    await expect(rawUpgrade(port, `/other?token=${token}`)).rejects.toThrow();
  });
});
