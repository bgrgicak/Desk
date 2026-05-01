#!/usr/bin/env node
/**
 * Host CLI entry point for the Desk personal AI assistant.
 *
 * Subcommands:
 *   desk start  (default) — ensure ~/Desk/, run migrations, start
 *                            desk-server + Vite, print URL.
 *   desk init             — bootstrap (~/Desk/, secret key, sandbox image)
 *                            without starting the server.
 *   desk version          — print package.json version.
 *
 * This iteration runs the API server via tsx against the workspace
 * source tree. A future iteration will swap that for an esbuild bundle
 * that ships with the CLI, so `npx @agent-desk/cli` works from a clean
 * machine without the monorepo checkout.
 */
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = path.resolve(__dirname, "..");
const REPO_ROOT = path.resolve(PKG_ROOT, "..", "..");

const PORT = parseInt(process.env.PORT ?? "35138", 10);
const APP_PORT = parseInt(process.env.DESK_APP_PORT ?? "5173", 10);

function log(msg) {
  process.stdout.write(`==> ${msg}\n`);
}

async function ensureDeskHome() {
  const home = process.env.DESK_HOME ?? os.homedir();
  await fsp.mkdir(path.join(home, "Desk"), { recursive: true });
  return home;
}

async function ensureSecretKey() {
  const envFile = path.join(REPO_ROOT, ".env");
  let existing = "";
  if (fs.existsSync(envFile)) {
    existing = await fsp.readFile(envFile, "utf-8");
    const m = existing.match(/^DESK_SECRET_KEY=(.+)$/m);
    if (m) return m[1].trim().replace(/^"|"$/g, "").replace(/^'|'$/g, "");
  }
  const { randomBytes } = await import("node:crypto");
  const key = randomBytes(32).toString("base64");
  log(`Generating DESK_SECRET_KEY → ${envFile}`);
  let body = existing;
  if (body.length > 0 && !body.endsWith("\n")) body += "\n";
  body += `DESK_SECRET_KEY=${key}\n`;
  await fsp.writeFile(envFile, body);
  return key;
}

function spawnInherit(cmd, args, env) {
  return spawn(cmd, args, {
    stdio: "inherit",
    env: { ...process.env, ...env },
    cwd: REPO_ROOT,
  });
}

async function cmdInit() {
  const home = await ensureDeskHome();
  await ensureSecretKey();
  log(`Desk home: ${path.join(home, "Desk")}`);
  log("Init complete. Run `desk start` to launch the server.");
}

async function cmdStart() {
  const home = await ensureDeskHome();
  const secret = await ensureSecretKey();

  const env = {
    DESK_SECRET_KEY: secret,
    DESK_HOME: home,
    PORT: String(PORT),
    DESK_APP_PORT: String(APP_PORT),
    DESK_API_URL: `http://127.0.0.1:${PORT}`,
    NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --conditions @agent-desk/dev`.trim(),
  };

  log(`desk-server → http://127.0.0.1:${PORT}/`);
  log(`vite app    → http://127.0.0.1:${APP_PORT}/`);

  const server = spawnInherit("npx", ["tsx", "watch", "packages/server/api/src/main.ts"], env);
  const vite = spawnInherit("npm", ["-w", "app", "run", "dev"], env);

  const stop = () => {
    server.kill("SIGTERM");
    vite.kill("SIGTERM");
    setTimeout(() => {
      server.kill("SIGKILL");
      vite.kill("SIGKILL");
    }, 3000).unref();
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  server.on("exit", stop);
  vite.on("exit", stop);
}

async function cmdVersion() {
  const pkg = JSON.parse(await fsp.readFile(path.join(PKG_ROOT, "package.json"), "utf-8"));
  process.stdout.write(`${pkg.version}\n`);
}

function ensureNodeVersion() {
  const major = parseInt(process.versions.node.split(".")[0], 10);
  if (major === 23) return;
  process.stderr.write(
    `desk: Node 23 is required (found ${process.versions.node}).\n` +
      "  Install via:\n" +
      "    volta install node@23\n" +
      "    fnm install 23 && fnm use 23\n" +
      "    nvm install 23 && nvm use 23\n",
  );
  process.exit(1);
}

async function main() {
  ensureNodeVersion();
  const sub = process.argv[2] ?? "start";
  switch (sub) {
    case "start": return cmdStart();
    case "init": return cmdInit();
    case "version":
    case "--version":
    case "-v":
      return cmdVersion();
    case "help":
    case "--help":
    case "-h":
      process.stdout.write(
        "Usage: desk [start|init|version]\n" +
        "  start    boot desk-server + vite (default)\n" +
        "  init     create ~/Desk + DESK_SECRET_KEY without starting\n" +
        "  version  print version\n",
      );
      return;
    default:
      process.stderr.write(`unknown subcommand: ${sub}\n`);
      process.exit(2);
  }
}

main().catch((err) => {
  process.stderr.write(`desk: ${err?.stack ?? err}\n`);
  process.exit(1);
});
