import { createConnection, createServer } from "node:net";
import type { AddressInfo } from "node:net";

export interface StartupProcess {
  once(event: "exit", listener: (code: number | null) => void): unknown;
}

interface ConnectSocket {
  once(event: "connect", listener: () => void): ConnectSocket;
  once(event: "error", listener: (err: NodeJS.ErrnoException) => void): ConnectSocket;
  end(): void;
  destroy(): void;
}

type ConnectFn = (opts: { host: string; port: number }) => ConnectSocket;
type FetchFn = (url: string) => Promise<{ ok: boolean }>;
type RandomPortFn = (host: string) => Promise<number>;

export class PortInUseError extends Error {
  constructor(port: number) {
    super(`Port ${port} is already in use.`);
    this.name = "PortInUseError";
  }
}

export async function assertPortAvailable(
  port: number,
  host = "127.0.0.1",
  connect: ConnectFn = createConnection,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const socket = connect({ host, port });
    socket.once("connect", () => {
      socket.end();
      reject(new PortInUseError(port));
    });
    socket.once("error", (err: NodeJS.ErrnoException) => {
      socket.destroy();
      if (err.code === "ECONNREFUSED" || err.code === "EHOSTUNREACH") {
        resolve();
        return;
      }
      reject(err);
    });
  });
}

async function randomAvailablePort(host: string): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen({ host, port: 0 }, () => {
      const address = server.address() as AddressInfo | null;
      const port = address?.port;
      server.close((err) => {
        if (err) {
          reject(err);
          return;
        }
        if (!port) {
          reject(new Error("Could not allocate a random server port"));
          return;
        }
        resolve(port);
      });
    });
  });
}

export async function resolveServerPort(
  preferredPort: number,
  host = "127.0.0.1",
  opts: { connect?: ConnectFn; randomPort?: RandomPortFn } = {},
): Promise<number> {
  try {
    await assertPortAvailable(preferredPort, host, opts.connect);
    return preferredPort;
  } catch (err) {
    if (!(err instanceof PortInUseError)) throw err;
    return await (opts.randomPort ?? randomAvailablePort)(host);
  }
}

export async function waitForServerHealth(
  healthUrl: string,
  proc: StartupProcess,
  opts: { timeoutMs?: number; intervalMs?: number; fetchFn?: FetchFn } = {},
): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const intervalMs = opts.intervalMs ?? 1000;
  const fetchFn = opts.fetchFn ?? fetch;
  const deadline = Date.now() + timeoutMs;
  let done = false;
  const exitPromise = new Promise<never>((_resolve, reject) => {
    proc.once("exit", (code) => {
      if (done) return;
      reject(new Error(`Roomy server exited before becoming ready (code ${code ?? "unknown"})`));
    });
  });

  try {
    while (Date.now() < deadline) {
      try {
        const res = await Promise.race([fetchFn(healthUrl), exitPromise]);
        if (res.ok) return;
      } catch (err) {
        if ((err as Error).message.includes("exited before becoming ready")) throw err;
        // not ready yet
      }
      await Promise.race([
        new Promise((r) => setTimeout(r, intervalMs)),
        exitPromise,
      ]);
    }

    throw new Error(`Server did not become ready within ${timeoutMs / 1000}s`);
  } finally {
    done = true;
  }
}
