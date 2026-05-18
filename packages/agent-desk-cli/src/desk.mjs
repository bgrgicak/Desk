#!/usr/bin/env node
/**
 * Host CLI entry point for the Desk personal AI assistant.
 *
 * Subcommands:
 *   desk start  (default) — ensure ~/Desk/, run migrations, start
 *                            desk-server (and Vite, in monorepo dev only).
 *   desk init             — bootstrap (~/Desk/, secret key) without starting.
 *   desk version          — print package.json version.
 *
 * Two run modes — auto-detected at boot:
 *
 *   1. Monorepo dev (default when run from the workspace checkout): spawns
 *      `tsx watch` against packages/server/api/src/main.ts and a separate
 *      Vite dev server. The SPA lives on :5173 and proxies /api/* to
 *      desk-server. This is what `npm run dev` orchestrates.
 *
 *   2. Published install (npx @agent-desk/cli or `npm i -g`): spawns
 *      `node` against the @agent-desk/api dist entry, sets
 *      DESK_SERVE_APP=1 and DESK_APP_DIST, and skips Vite entirely —
 *      desk-server itself serves the SPA bundle from @agent-desk/app's
 *      dist directory at the same origin as the API.
 */
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = path.resolve(__dirname, "..");
const require = createRequire(import.meta.url);

const PORT = parseInt(process.env.PORT ?? "35138", 10);
const APP_PORT = parseInt(process.env.DESK_APP_PORT ?? "5173", 10);

function log(msg) {
  process.stdout.write(`==> ${msg}\n`);
}

/**
 * True when the CLI is running from inside the monorepo source tree.
 * Walks up from the package root looking for the workspace-root
 * package.json (name="desk", workspaces array). A fresh `npm i -g
 * @agent-desk/cli` install can never satisfy this — node_modules has
 * no such file three levels up.
 */
export function detectMonorepo(pkgRoot = PKG_ROOT) {
  const candidate = path.resolve(pkgRoot, "..", "..", "package.json");
  if (!fs.existsSync(candidate)) return null;
  try {
    const pkg = JSON.parse(fs.readFileSync(candidate, "utf-8"));
    if (pkg.name === "desk" && Array.isArray(pkg.workspaces)) {
      return path.dirname(candidate);
    }
  } catch {
    /* fall through */
  }
  return null;
}

/**
 * Resolves the published API entry. Returns the absolute path or null
 * if the package isn't installed (monorepo dev) or the dist hasn't been
 * built yet.
 */
export function resolvePublishedApiEntry() {
  try {
    const entry = require.resolve("@agent-desk/api/dist/main.js");
    return fs.existsSync(entry) ? entry : null;
  } catch {
    return null;
  }
}

/**
 * Resolves the @agent-desk/app dist directory by locating its
 * package.json and walking to the dist sibling. Returns null if not
 * installed or not built.
 */
export function resolveAppDist() {
  try {
    const pkgJson = require.resolve("@agent-desk/app/package.json");
    const dist = path.join(path.dirname(pkgJson), "dist");
    return fs.existsSync(path.join(dist, "index.html")) ? dist : null;
  } catch {
    return null;
  }
}

async function ensureDeskHome() {
  const home = process.env.DESK_HOME ?? os.homedir();
  await fsp.mkdir(path.join(home, "Desk"), { recursive: true });
  return home;
}

/**
 * Where the secret key lives.
 *   - Monorepo dev: repo-root .env (existing behaviour, dev.sh shares it).
 *   - Published install: ~/Desk/.secret-key (file mode 0600).
 *
 * Returns the in-memory key. Generates one on first call.
 */
async function ensureSecretKey({ monorepoRoot, deskHome }) {
  if (monorepoRoot) {
    const envFile = path.join(monorepoRoot, ".env");
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

  const keyFile = path.join(deskHome, "Desk", ".secret-key");
  if (fs.existsSync(keyFile)) {
    const raw = await fsp.readFile(keyFile, "utf-8");
    const trimmed = raw.trim();
    if (trimmed.length > 0) return trimmed;
  }
  const { randomBytes } = await import("node:crypto");
  const key = randomBytes(32).toString("base64");
  log(`Generating DESK_SECRET_KEY → ${keyFile}`);
  await fsp.mkdir(path.dirname(keyFile), { recursive: true });
  await fsp.writeFile(keyFile, key + "\n", { mode: 0o600 });
  return key;
}

function spawnInherit(cmd, args, { env, cwd }) {
  return spawn(cmd, args, {
    stdio: "inherit",
    env: { ...process.env, ...env },
    cwd,
  });
}

function attachStopHandlers(...children) {
  const stop = () => {
    for (const child of children) child.kill("SIGTERM");
    setTimeout(() => {
      for (const child of children) child.kill("SIGKILL");
    }, 3000).unref();
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  for (const child of children) child.on("exit", stop);
}

async function cmdInit() {
  const monorepoRoot = detectMonorepo();
  const home = await ensureDeskHome();
  await ensureSecretKey({ monorepoRoot, deskHome: home });
  log(`Desk home: ${path.join(home, "Desk")}`);
  log("Init complete. Run `desk start` to launch the server.");
}

async function cmdStart() {
  const monorepoRoot = detectMonorepo();
  const home = await ensureDeskHome();
  const secret = await ensureSecretKey({ monorepoRoot, deskHome: home });

  if (monorepoRoot) {
    return cmdStartDev({ monorepoRoot, home, secret });
  }
  return cmdStartPublished({ home, secret });
}

async function cmdStartDev({ monorepoRoot, home, secret }) {
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

  const server = spawnInherit(
    "npx",
    ["tsx", "watch", "packages/server/api/src/main.ts"],
    { env, cwd: monorepoRoot },
  );
  const vite = spawnInherit(
    "npm",
    ["-w", "@agent-desk/app", "run", "dev"],
    { env, cwd: monorepoRoot },
  );
  attachStopHandlers(server, vite);
}

async function cmdStartPublished({ home, secret }) {
  const apiEntry = resolvePublishedApiEntry();
  if (!apiEntry) {
    process.stderr.write(
      "desk: cannot find @agent-desk/api/dist/main.js. Reinstall @agent-desk/cli.\n",
    );
    process.exit(1);
  }
  const appDist = resolveAppDist();
  if (!appDist) {
    process.stderr.write(
      "desk: cannot find @agent-desk/app/dist/index.html. Reinstall @agent-desk/cli.\n",
    );
    process.exit(1);
  }

  const env = {
    DESK_SECRET_KEY: secret,
    DESK_HOME: home,
    PORT: String(PORT),
    DESK_API_URL: `http://127.0.0.1:${PORT}`,
    DESK_SERVE_APP: "1",
    DESK_APP_DIST: appDist,
  };

  log(`desk-server → http://127.0.0.1:${PORT}/  (serves API + SPA)`);
  log(`app dist    → ${appDist}`);

  const server = spawnInherit("node", [apiEntry], { env, cwd: home });
  attachStopHandlers(server);
}

async function cmdVersion() {
  const pkg = JSON.parse(await fsp.readFile(path.join(PKG_ROOT, "package.json"), "utf-8"));
  process.stdout.write(`${pkg.version}\n`);
}

// ---------------------------------------------------------------------------
// desk service — install / uninstall / start / stop / status
// ---------------------------------------------------------------------------

const LAUNCHD_LABEL = "com.agentdesk.desk";
const LAUNCHD_PLIST_PATH = path.join(
  os.homedir(), "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`,
);
const SYSTEMD_UNIT_DIR = path.join(os.homedir(), ".config", "systemd", "user");
const SYSTEMD_UNIT_NAME = "desk.service";
const SYSTEMD_UNIT_PATH = path.join(SYSTEMD_UNIT_DIR, SYSTEMD_UNIT_NAME);
const WIN_TASK_NAME = "AgentDeskServer";

function launchdPlist(nodeBin, deskBin, home) {
  const deskHome = path.join(home, "Desk");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key><string>${LAUNCHD_LABEL}</string>
    <key>ProgramArguments</key>
    <array>
        <string>${nodeBin}</string>
        <string>${deskBin}</string>
        <string>start</string>
    </array>
    <key>EnvironmentVariables</key>
    <dict><key>DESK_HOME</key><string>${home}</string></dict>
    <key>RunAtLoad</key><true/>
    <key>KeepAlive</key><true/>
    <key>StandardOutPath</key><string>${path.join(deskHome, "logs", "desk.log")}</string>
    <key>StandardErrorPath</key><string>${path.join(deskHome, "logs", "desk.error.log")}</string>
    <key>ThrottleInterval</key><integer>10</integer>
</dict>
</plist>
`;
}

function systemdUnit(nodeBin, deskBin, home) {
  return `[Unit]
Description=Desk personal AI assistant server
After=network.target

[Service]
Type=simple
ExecStart=${nodeBin} ${deskBin} start
Restart=on-failure
RestartSec=10
Environment=DESK_HOME=${home}

[Install]
WantedBy=default.target
`;
}

async function installService() {
  const home = await ensureDeskHome();
  const nodeBin = process.execPath;
  const deskBin = path.resolve(__dirname, "desk.mjs");
  await fsp.mkdir(path.join(home, "Desk", "logs"), { recursive: true });

  if (process.platform === "darwin") {
    await fsp.mkdir(path.dirname(LAUNCHD_PLIST_PATH), { recursive: true });
    await fsp.writeFile(LAUNCHD_PLIST_PATH, launchdPlist(nodeBin, deskBin, home));
    log(`Wrote ${LAUNCHD_PLIST_PATH}`);
    const { status } = spawnSync("launchctl", ["load", "-w", LAUNCHD_PLIST_PATH], { stdio: "inherit" });
    if (status !== 0) { process.stderr.write("launchctl load failed\n"); process.exit(1); }
    log("Service installed and started.");
  } else if (process.platform === "linux") {
    await fsp.mkdir(SYSTEMD_UNIT_DIR, { recursive: true });
    await fsp.writeFile(SYSTEMD_UNIT_PATH, systemdUnit(nodeBin, deskBin, home));
    log(`Wrote ${SYSTEMD_UNIT_PATH}`);
    spawnSync("systemctl", ["--user", "daemon-reload"], { stdio: "inherit" });
    spawnSync("systemctl", ["--user", "enable", "--now", SYSTEMD_UNIT_NAME], { stdio: "inherit" });
    log("Service installed and started.");
  } else if (process.platform === "win32") {
    const cmd = `schtasks /Create /F /TN "${WIN_TASK_NAME}" /TR "${nodeBin} ${deskBin} start" /SC ONLOGON /RL LIMITED`;
    const { status } = spawnSync("cmd", ["/C", cmd], { stdio: "inherit" });
    if (status !== 0) process.exit(1);
    log(`Task Scheduler task "${WIN_TASK_NAME}" created.`);
  } else {
    process.stderr.write(`desk service install: unsupported platform ${process.platform}\n`);
    process.exit(1);
  }
}

async function uninstallService() {
  if (process.platform === "darwin") {
    if (fs.existsSync(LAUNCHD_PLIST_PATH)) {
      spawnSync("launchctl", ["unload", "-w", LAUNCHD_PLIST_PATH], { stdio: "inherit" });
      await fsp.rm(LAUNCHD_PLIST_PATH);
      log("Service removed.");
    } else {
      log("Service is not installed.");
    }
  } else if (process.platform === "linux") {
    if (fs.existsSync(SYSTEMD_UNIT_PATH)) {
      spawnSync("systemctl", ["--user", "disable", "--now", SYSTEMD_UNIT_NAME], { stdio: "inherit" });
      await fsp.rm(SYSTEMD_UNIT_PATH);
      spawnSync("systemctl", ["--user", "daemon-reload"], { stdio: "inherit" });
      log("Service removed.");
    } else {
      log("Service is not installed.");
    }
  } else if (process.platform === "win32") {
    spawnSync("schtasks", ["/Delete", "/F", "/TN", WIN_TASK_NAME], { stdio: "inherit" });
    log("Task removed.");
  } else {
    process.stderr.write(`desk service uninstall: unsupported platform ${process.platform}\n`);
    process.exit(1);
  }
}

function serviceControl(action) {
  if (process.platform === "darwin") {
    const cmds = {
      start: ["launchctl", ["load", "-w", LAUNCHD_PLIST_PATH]],
      stop: ["launchctl", ["unload", LAUNCHD_PLIST_PATH]],
      status: ["launchctl", ["list", LAUNCHD_LABEL]],
    };
    const c = cmds[action];
    if (!c) { process.stderr.write(`Unknown action: ${action}\n`); process.exit(2); }
    spawnSync(c[0], c[1], { stdio: "inherit" });
  } else if (process.platform === "linux") {
    const cmds = {
      start: ["systemctl", ["--user", "start", SYSTEMD_UNIT_NAME]],
      stop: ["systemctl", ["--user", "stop", SYSTEMD_UNIT_NAME]],
      status: ["systemctl", ["--user", "status", SYSTEMD_UNIT_NAME]],
    };
    const c = cmds[action];
    if (!c) { process.stderr.write(`Unknown action: ${action}\n`); process.exit(2); }
    spawnSync(c[0], c[1], { stdio: "inherit" });
  } else if (process.platform === "win32") {
    const cmds = {
      start: ["schtasks", ["/Run", "/TN", WIN_TASK_NAME]],
      stop: ["schtasks", ["/End", "/TN", WIN_TASK_NAME]],
      status: ["schtasks", ["/Query", "/TN", WIN_TASK_NAME]],
    };
    const c = cmds[action];
    if (!c) { process.stderr.write(`Unknown action: ${action}\n`); process.exit(2); }
    spawnSync(c[0], c[1], { stdio: "inherit" });
  } else {
    process.stderr.write(`desk service: unsupported platform ${process.platform}\n`);
    process.exit(1);
  }
}

async function cmdService(action) {
  if (!action) {
    process.stderr.write("Usage: desk service install|uninstall|start|stop|status\n");
    process.exit(2);
  }
  if (action === "install") return installService();
  if (action === "uninstall") return uninstallService();
  if (action === "start" || action === "stop" || action === "status") return serviceControl(action);
  process.stderr.write(`Unknown service action: ${action}\nUsage: desk service install|uninstall|start|stop|status\n`);
  process.exit(2);
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
    case "service": return cmdService(process.argv[3]);
    case "version":
    case "--version":
    case "-v":
      return cmdVersion();
    case "help":
    case "--help":
    case "-h":
      process.stdout.write(
        "Usage: desk [start|init|service|version]\n" +
        "  start                          boot desk-server (default)\n" +
        "  init                           create ~/Desk + DESK_SECRET_KEY without starting\n" +
        "  service install|uninstall      register/unregister Desk as a system service\n" +
        "  service start|stop|status      control the installed system service\n" +
        "  version                        print version\n",
      );
      return;
    default:
      process.stderr.write(`unknown subcommand: ${sub}\n`);
      process.exit(2);
  }
}

// Don't auto-run when this module is imported (e.g. by tests).
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    process.stderr.write(`desk: ${err?.stack ?? err}\n`);
    process.exit(1);
  });
}
