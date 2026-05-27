import { app, utilityProcess, type UtilityProcess } from "electron/main";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";
import * as crypto from "crypto";
import { buildServerEnvConfig } from "./server-env.js";
import { resolveServerPort, waitForServerHealth } from "./server-startup.js";

const PREFERRED_PORT = parseInt(process.env.PORT ?? "35138", 10);

function resolveServerEntry(): string {
  if (app.isPackaged) {
    // Staged by scripts/stage-server.mjs as a node_modules tree so the
    // bundled server can resolve @roomy-ai/* + transitive npm deps.
    return path.join(
      process.resourcesPath,
      "server",
      "node_modules",
      "@roomy-ai",
      "api",
      "dist",
      "main.js"
    );
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

function ensureSecretKey(roomyDir: string): string {
  const keyFile = path.join(roomyDir, ".secret-key");
  if (fs.existsSync(keyFile)) {
    const raw = fs.readFileSync(keyFile, "utf-8").trim();
    if (raw.length > 0) return raw;
  }
  const key = crypto.randomBytes(32).toString("base64");
  fs.mkdirSync(roomyDir, { recursive: true });
  fs.writeFileSync(keyFile, key + "\n", { mode: 0o600 });
  return key;
}

function buildServerEnv(roomyHome: string, port: number): NodeJS.ProcessEnv {
  const secretKey = ensureSecretKey(roomyHome);
  return buildServerEnvConfig({
    roomyHome,
    secretKey,
    appDist: resolveAppDist(),
    port,
  });
}

export class ServerManager {
  private proc: UtilityProcess | null = null;
  private readonly roomyHome: string;
  private serverPort = PREFERRED_PORT;

  constructor() {
    // ROOMY_HOME is the data root itself (~/Roomy), matching what dev.sh and
    // resolveRoomyHome() expect: process.env.ROOMY_HOME ?? $HOME/Roomy.
    this.roomyHome = process.env.ROOMY_HOME ?? path.join(os.homedir(), "Roomy");
  }

  get port(): number {
    return this.serverPort;
  }

  get url(): string {
    return `http://127.0.0.1:${this.serverPort}`;
  }

  async start(): Promise<void> {
    this.serverPort = await resolveServerPort(PREFERRED_PORT);
    if (this.serverPort !== PREFERRED_PORT) {
      console.warn(`roomy-server preferred port ${PREFERRED_PORT} is occupied; using ${this.serverPort}`);
    }

    const entry = resolveServerEntry();
    if (!fs.existsSync(entry)) {
      throw new Error(
        `Server entry not found: ${entry}\n` +
        `Run "npm run build:server" first (dev) or reinstall (packaged).`,
      );
    }

    fs.mkdirSync(this.roomyHome, { recursive: true });

    this.proc = utilityProcess.fork(entry, [], {
      env: buildServerEnv(this.roomyHome, this.serverPort),
      stdio: "inherit",
    });

    this.proc.on("exit", (code) => {
      console.error(`roomy-server exited with code ${code}`);
      this.proc = null;
    });

    await waitForServerHealth(`${this.url}/health`, this.proc);
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
