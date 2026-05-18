import { app, utilityProcess, type UtilityProcess } from "electron/main";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";
import * as crypto from "crypto";

const PORT = parseInt(process.env.PORT ?? "35138", 10);
const HEALTH_URL = `http://127.0.0.1:${PORT}/health`;

function resolveServerEntry(): string {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, "server", "api", "dist", "main.js");
  }
  // Dev: monorepo relative to packages/desktop/
  return path.resolve(import.meta.dirname, "..", "..", "server", "api", "dist", "main.js");
}

function resolveAppDist(): string {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, "app", "dist");
  }
  return path.resolve(import.meta.dirname, "..", "..", "app", "dist");
}

function ensureSecretKey(deskDir: string): string {
  const keyFile = path.join(deskDir, ".secret-key");
  if (fs.existsSync(keyFile)) {
    const raw = fs.readFileSync(keyFile, "utf-8").trim();
    if (raw.length > 0) return raw;
  }
  const key = crypto.randomBytes(32).toString("base64");
  fs.mkdirSync(deskDir, { recursive: true });
  fs.writeFileSync(keyFile, key + "\n", { mode: 0o600 });
  return key;
}

function buildServerEnv(deskHome: string): NodeJS.ProcessEnv {
  const secretKey = ensureSecretKey(deskHome);
  return {
    ...process.env,
    DESK_SECRET_KEY: secretKey,
    DESK_HOME: deskHome,
    PORT: String(PORT),
    DESK_SERVE_APP: "1",
    DESK_APP_DIST: resolveAppDist(),
  };
}

async function pollHealth(timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(HEALTH_URL);
      if (res.ok) return;
    } catch {
      // not ready yet
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`Server did not become ready within ${timeoutMs / 1000}s`);
}

export class ServerManager {
  private proc: UtilityProcess | null = null;
  private readonly deskHome: string;

  constructor() {
    // DESK_HOME is the data root itself (~/Desk), matching what dev.sh and
    // resolveDeskHome() expect: process.env.DESK_HOME ?? $HOME/Desk.
    this.deskHome = process.env.DESK_HOME ?? path.join(os.homedir(), "Desk");
  }

  get port(): number {
    return PORT;
  }

  get url(): string {
    return `http://127.0.0.1:${PORT}`;
  }

  async start(): Promise<void> {
    const entry = resolveServerEntry();
    if (!fs.existsSync(entry)) {
      throw new Error(
        `Server entry not found: ${entry}\n` +
        `Run "npm run build:server" first (dev) or reinstall (packaged).`,
      );
    }

    fs.mkdirSync(this.deskHome, { recursive: true });

    this.proc = utilityProcess.fork(entry, [], {
      env: buildServerEnv(this.deskHome),
      stdio: "inherit",
    });

    this.proc.on("exit", (code) => {
      console.error(`desk-server exited with code ${code}`);
      this.proc = null;
    });

    await pollHealth();
  }

  stop(): void {
    if (this.proc) {
      this.proc.kill();
      this.proc = null;
    }
  }

  isRunning(): boolean {
    return this.proc !== null;
  }
}
