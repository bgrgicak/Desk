import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import {
  assertPortAvailable,
  resolveServerPort,
  waitForServerHealth,
  type StartupProcess,
} from "./server-startup.js";

class FakeProcess extends EventEmitter implements StartupProcess {
  exit(code: number | null): void {
    this.emit("exit", code);
  }
}

class FakeSocket extends EventEmitter {
  end = vi.fn();
  destroy = vi.fn();
}

describe("desktop server startup", () => {
  it("rejects when the local server port is already occupied", async () => {
    const socket = new FakeSocket();
    const connect = vi.fn(() => socket);
    const promise = assertPortAvailable(35138, "127.0.0.1", connect);
    socket.emit("connect");

    await expect(promise).rejects.toThrow(/already in use/);
    expect(socket.end).toHaveBeenCalled();
  });

  it("uses the preferred server port when it is free", async () => {
    const socket = new FakeSocket();
    const connect = vi.fn(() => socket);
    const promise = resolveServerPort(35138, "127.0.0.1", {
      connect,
      randomPort: vi.fn(async () => 45678),
    });
    socket.emit("error", Object.assign(new Error("refused"), { code: "ECONNREFUSED" }));

    await expect(promise).resolves.toBe(35138);
  });

  it("falls back to a random server port when the preferred port is occupied", async () => {
    const socket = new FakeSocket();
    const connect = vi.fn(() => socket);
    const randomPort = vi.fn(async () => 45678);
    const promise = resolveServerPort(35138, "127.0.0.1", { connect, randomPort });
    socket.emit("connect");

    await expect(promise).resolves.toBe(45678);
    expect(randomPort).toHaveBeenCalledWith("127.0.0.1");
  });

  it("waits for the health endpoint to become ready", async () => {
    await expect(
      waitForServerHealth("http://127.0.0.1:35138/health", new FakeProcess(), {
        timeoutMs: 1000,
        intervalMs: 10,
        fetchFn: async () => ({ ok: true }),
      }),
    ).resolves.toBeUndefined();
  });

  it("fails startup when the child server exits before health succeeds", async () => {
    const proc = new FakeProcess();
    const pending = waitForServerHealth("http://127.0.0.1:35138/health", proc, {
      timeoutMs: 1000,
      intervalMs: 10,
      fetchFn: async () => ({ ok: false }),
    });
    proc.exit(1);

    await expect(pending).rejects.toThrow(/exited before becoming ready/);
  });
});
