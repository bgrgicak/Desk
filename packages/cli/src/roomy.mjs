#!/usr/bin/env node
/**
 * Host CLI entry point for the Roomy personal AI assistant.
 *
 * Subcommands:
 *   roomy start  (default) — ensure ~/Roomy/, run migrations, start
 *                            roomy-server (and Vite, in monorepo dev only).
 *   roomy init             — bootstrap (~/Roomy/, vault password) without starting.
 *   roomy version          — print package.json version.
 *
 * Two run modes — auto-detected at boot:
 *
 *   1. Monorepo dev (default when run from the workspace checkout): spawns
 *      `tsx watch` against packages/server/api/src/main.ts and a separate
 *      Vite dev server. The SPA lives on :5174 and proxies /api/* to
 *      roomy-server. This is what `npm run dev` orchestrates.
 *
 *   2. Published install (npx @roomy-ai/cli or `npm i -g`): spawns
 *      `node` against the @roomy-ai/api dist entry, sets
 *      ROOMY_SERVE_APP=1 and ROOMY_APP_DIST, and skips Vite entirely —
 *      roomy-server itself serves the SPA bundle from @roomy-ai/app's
 *      dist directory at the same origin as the API.
 */
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { ensureColima, findColima, roomyBinDir, nerdctlWrapperPath } from "./colima.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = path.resolve(__dirname, "..");
const require = createRequire(import.meta.url);

const PORT = parseInt(process.env.PORT ?? "35138", 10);
const APP_PORT = parseInt(process.env.ROOMY_APP_PORT ?? "5173", 10);
const SOURCE_RELEASE_CONFIG = ".source-release.json";

function log(msg) {
  process.stdout.write(`==> ${msg}\n`);
}

/**
 * True when the CLI is running from inside the monorepo source tree.
 * Walks up from the package root looking for the workspace-root
 * package.json (name="roomy", workspaces array). A fresh `npm i -g
 * @roomy-ai/cli` install can never satisfy this — node_modules has
 * no such file three levels up.
 */
export function detectMonorepo(pkgRoot = PKG_ROOT) {
  const candidate = path.resolve(pkgRoot, "..", "..", "package.json");
  if (!fs.existsSync(candidate)) return null;
  try {
    const pkg = JSON.parse(fs.readFileSync(candidate, "utf-8"));
    if (pkg.name === "roomy" && Array.isArray(pkg.workspaces)) {
      return path.dirname(candidate);
    }
  } catch {
    /* fall through */
  }
  return null;
}

/**
 * Resolves the published API entry. Returns the absolute path or null
 * if the package isn't installed or the dist hasn't been built yet.
 *
 * Resolves via package.json (which is always reachable through the
 * exports field by Node's spec) and walks to dist/main.js — the api
 * package's `exports` only exposes the root entry, so a direct
 * `require.resolve("@roomy-ai/api/dist/main.js")` would throw
 * ERR_PACKAGE_PATH_NOT_EXPORTED in a real install.
 */
export function resolvePublishedApiEntry() {
  try {
    const pkgJson = require.resolve("@roomy-ai/api/package.json");
    const entry = path.join(path.dirname(pkgJson), "dist", "main.js");
    return fs.existsSync(entry) ? entry : null;
  } catch {
    return null;
  }
}

/**
 * Resolves the @roomy-ai/app dist directory by locating its
 * package.json and walking to the dist sibling. Returns null if not
 * installed or not built.
 */
export function resolveAppDist() {
  try {
    const pkgJson = require.resolve("@roomy-ai/app/package.json");
    const dist = path.join(path.dirname(pkgJson), "dist");
    return fs.existsSync(path.join(dist, "index.html")) ? dist : null;
  } catch {
    return null;
  }
}

export function packageVersion(pkgRoot = PKG_ROOT) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(pkgRoot, "package.json"), "utf-8"));
    return typeof pkg.version === "string" && pkg.version.length > 0 ? pkg.version : "latest";
  } catch {
    return "latest";
  }
}

export function defaultSandboxImage(pkgRoot = PKG_ROOT) {
  return `bgrgicak/roomy-ai:${packageVersion(pkgRoot)}`;
}

function sourceReleaseConfigPath(home) {
  return path.join(home, SOURCE_RELEASE_CONFIG);
}

function currentLinkForHome(home) {
  return process.env.ROOMY_CURRENT_LINK ?? path.join(home, "current");
}

function releasesDirForHome(home) {
  return process.env.ROOMY_RELEASES_DIR ?? path.join(home, "releases");
}

function assertExists(file, label) {
  if (!fs.existsSync(file)) {
    throw new Error(`${label} is missing: ${file}`);
  }
}

export function validateSourceRoot(source) {
  const root = path.resolve(source);
  const pkgPath = path.join(root, "package.json");
  if (!fs.existsSync(pkgPath)) {
    throw new Error(`${root} is not a Roomy workspace root: missing package.json`);
  }
  let pkg;
  try {
    pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
  } catch (err) {
    throw new Error(`${root} is not a Roomy workspace root: invalid package.json (${err.message})`);
  }
  if (pkg.name !== "roomy" || !Array.isArray(pkg.workspaces)) {
    throw new Error(`${root} is not a Roomy workspace root`);
  }
  assertExists(path.join(root, "package-lock.json"), "root package lockfile");
  assertExists(path.join(root, "packages", "server", "api", "package.json"), "server package");
  assertExists(path.join(root, "packages", "app", "package.json"), "app package");
  assertExists(path.join(root, "packages", "server", "runtime", "Dockerfile.sandbox"), "sandbox Dockerfile");
  return root;
}

export function resolveSourceReleaseConfig(home) {
  const configPath = sourceReleaseConfigPath(home);
  if (!fs.existsSync(configPath)) return null;

  let config;
  try {
    config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
  } catch (err) {
    throw new Error(`Invalid source release config at ${configPath}: ${err.message}`);
  }

  const currentLink = config.currentLink ?? currentLinkForHome(home);
  if (!fs.existsSync(currentLink)) {
    throw new Error(`Configured source release current link is missing: ${currentLink}`);
  }
  const releaseDir = fs.realpathSync(currentLink);
  const apiEntry = path.join(releaseDir, "packages", "server", "api", "dist", "main.js");
  const appDist = path.join(releaseDir, "packages", "app", "dist");
  assertExists(apiEntry, "source release API entry");
  assertExists(path.join(appDist, "index.html"), "source release app bundle");

  return {
    ...config,
    currentLink,
    releaseDir,
    apiEntry,
    appDist,
  };
}

export function parseUpdateArgs(args) {
  const opts = {
    mode: "npm",
    tag: "latest",
    tagSpecified: false,
    source: null,
    skipDocker: false,
    skipRestart: false,
  };

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--skip-docker") {
      opts.skipDocker = true;
    } else if (arg === "--skip-restart") {
      opts.skipRestart = true;
    } else if (arg === "--source") {
      const value = args[i + 1];
      if (!value || value.startsWith("--")) throw new Error("--source requires a path");
      opts.source = value;
      opts.mode = "source";
      i += 1;
    } else if (arg.startsWith("--source=")) {
      const value = arg.slice("--source=".length);
      if (!value) throw new Error("--source requires a path");
      opts.source = value;
      opts.mode = "source";
    } else if (arg.startsWith("--tag=")) {
      opts.tag = arg.slice("--tag=".length) || "latest";
      opts.tagSpecified = true;
    } else {
      throw new Error(`unknown update option: ${arg}`);
    }
  }

  if (opts.source && opts.tagSpecified) {
    throw new Error("--source and --tag are mutually exclusive");
  }

  if (opts.mode === "source") {
    return {
      mode: "source",
      source: opts.source,
      skipDocker: opts.skipDocker,
      skipRestart: opts.skipRestart,
    };
  }

  return {
    mode: "npm",
    tag: opts.tag,
    skipDocker: opts.skipDocker,
    skipRestart: opts.skipRestart,
  };
}

/**
 * Resolves the Roomy data root and ensures it exists. Mirrors the storage
 * layer's `resolveRoomyHome`: an explicit `ROOMY_HOME` env var is treated as
 * the data root verbatim; otherwise we default to `$HOME/Roomy`. Returning
 * the same path we just created — earlier this function returned the
 * parent ($HOME) which silently scattered db/backups/memory/skills across
 * the home directory.
 */
export async function ensureRoomyHome() {
  const home = process.env.ROOMY_HOME ?? path.join(os.homedir(), "Roomy");
  await fsp.mkdir(home, { recursive: true });
  return home;
}

function spawnInherit(cmd, args, { env, cwd }) {
  return spawn(cmd, args, {
    stdio: "inherit",
    env: { ...process.env, ...env },
    cwd,
  });
}

/**
 * Prepend common tool locations to PATH so the server finds `colima` and
 * the nerdctl wrapper under launchd/systemd's minimal inherited PATH.
 */
export function augmentPath(currentPath) {
  const base = currentPath ?? "/usr/bin:/bin:/usr/sbin:/sbin";
  const extras = [
    "/usr/local/bin",
    "/opt/homebrew/bin",
    "/home/linuxbrew/.linuxbrew/bin",
  ];
  const parts = base.split(":");
  for (const dir of extras) {
    if (!parts.includes(dir)) parts.unshift(dir);
  }
  return parts.join(":");
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
  // detectMonorepo() is still useful for future init steps; called for parity
  // with `cmdStart`.
  detectMonorepo();
  const home = await ensureRoomyHome();
  log(`Roomy home: ${home}`);
  log("Init complete. Run `roomy start` to launch the server.");
}

async function cmdStart() {
  const monorepoRoot = detectMonorepo();
  const home = await ensureRoomyHome();

  if (monorepoRoot) {
    return cmdStartDev({ monorepoRoot, home });
  }
  const sourceRelease = resolveSourceReleaseConfig(home);
  // macOS has no container runtime by default — auto-install Colima with
  // containerd and create ~/Roomy/bin/nerdctl wrapper.
  // Linux uses Docker natively; engine.ts auto-detects Docker Desktop's socket.
  if (process.platform === "darwin") {
    await ensureColima(home);
  }
  if (sourceRelease) {
    return cmdStartSourceRelease({ home, release: sourceRelease });
  }
  return cmdStartPublished({ home });
}

async function cmdStartDev({ monorepoRoot, home }) {
  const devSh = path.resolve(
    monorepoRoot,
    "packages/server/setup/scripts/dev.sh",
  );
  const proc = spawnInherit("bash", [devSh], {
    env: { ROOMY_HOME: home },
    cwd: monorepoRoot,
  });
  attachStopHandlers(proc);
}

async function cmdStartPublished({ home }) {
  const apiEntry = resolvePublishedApiEntry();
  if (!apiEntry) {
    process.stderr.write(
      "roomy: cannot find @roomy-ai/api/dist/main.js. Reinstall @roomy-ai/cli.\n",
    );
    process.exit(1);
  }
  const appDist = resolveAppDist();
  if (!appDist) {
    process.stderr.write(
      "roomy: cannot find @roomy-ai/app/dist/index.html. Reinstall @roomy-ai/cli.\n",
    );
    process.exit(1);
  }

  const env = {
    ROOMY_HOME: home,
    PORT: String(PORT),
    ROOMY_API_URL: `http://127.0.0.1:${PORT}`,
    ROOMY_SERVE_APP: "1",
    ROOMY_APP_DIST: appDist,
    // Point the runtime at the registry-published sandbox image. The
    // server's docker.ts default of `roomy/sandbox:v1` is fine for a
    // monorepo dev checkout (where `npm run dev` builds it locally) but
    // useless for `npx @roomy-ai/cli` users — they have no local image
    // to fall back on. Pulls from Docker Hub on first sandbox start.
    // Use the package-version tag so a mutable `latest` manifest cannot
    // drift away from the CLI/runtime code the user installed.
    // Set ROOMY_SANDBOX_IMAGE to override (e.g. point at your own fork).
    ROOMY_SANDBOX_IMAGE: process.env.ROOMY_SANDBOX_IMAGE ?? defaultSandboxImage(),
    // Prepend ~/Roomy/bin (nerdctl wrapper + colima binary) and common
    // tool locations so the server finds them under launchd/systemd PATH.
    PATH: `${roomyBinDir(home)}:${augmentPath(process.env.PATH)}`,
  };

  log(`roomy-server → http://127.0.0.1:${PORT}/  (serves API + SPA)`);
  log(`app dist    → ${appDist}`);

  // Spawn the same Node binary that's running us, not bare "node". Under
  // launchd / systemd / sandboxed shells, PATH may not include the Node
  // we were launched with (e.g. nvm-managed), and `spawn("node", ...)`
  // hits ENOENT.
  const server = spawnInherit(process.execPath, [apiEntry], { env, cwd: home });
  attachStopHandlers(server);
}

export function resolveSourceReleaseSandboxImage(release, env = process.env) {
  return release.sandboxImage ?? env.ROOMY_SANDBOX_IMAGE;
}

async function cmdStartSourceRelease({ home, release }) {
  const env = {
    ROOMY_HOME: home,
    PORT: String(PORT),
    ROOMY_API_URL: `http://127.0.0.1:${PORT}`,
    ROOMY_SERVE_APP: "1",
    ROOMY_APP_DIST: release.appDist,
    PATH: `${roomyBinDir(home)}:${augmentPath(process.env.PATH)}`,
  };
  const sandboxImage = resolveSourceReleaseSandboxImage(release);
  if (sandboxImage) env.ROOMY_SANDBOX_IMAGE = sandboxImage;

  log(`roomy-server → http://127.0.0.1:${PORT}/  (source release ${release.releaseId ?? "local"})`);
  log(`release     → ${release.releaseDir}`);
  log(`app dist    → ${release.appDist}`);

  const server = spawnInherit(process.execPath, [release.apiEntry], {
    env,
    cwd: release.releaseDir,
  });
  attachStopHandlers(server);
}

async function cmdVersion() {
  const pkg = JSON.parse(await fsp.readFile(path.join(PKG_ROOT, "package.json"), "utf-8"));
  process.stdout.write(`${pkg.version}\n`);
}

// ---------------------------------------------------------------------------
// roomy service — install / uninstall / start / stop / status
// ---------------------------------------------------------------------------

const LAUNCHD_LABEL = "com.roomy-ai.roomy";
const LAUNCHD_PLIST_PATH = path.join(
  os.homedir(), "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`,
);
const SYSTEMD_UNIT_DIR = path.join(os.homedir(), ".config", "systemd", "user");
const SYSTEMD_UNIT_NAME = "roomy.service";
const SYSTEMD_UNIT_PATH = path.join(SYSTEMD_UNIT_DIR, SYSTEMD_UNIT_NAME);
const WIN_TASK_NAME = "RoomyServer";

function launchdPlist(nodeBin, roomyBin, home) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key><string>${LAUNCHD_LABEL}</string>
    <key>ProgramArguments</key>
    <array>
        <string>${nodeBin}</string>
        <string>${roomyBin}</string>
        <string>start</string>
    </array>
    <key>EnvironmentVariables</key>
    <dict><key>ROOMY_HOME</key><string>${home}</string></dict>
    <key>RunAtLoad</key><true/>
    <key>KeepAlive</key><true/>
    <key>StandardOutPath</key><string>${path.join(home, "logs", "roomy.log")}</string>
    <key>StandardErrorPath</key><string>${path.join(home, "logs", "roomy.error.log")}</string>
    <key>ThrottleInterval</key><integer>10</integer>
</dict>
</plist>
`;
}

function systemdUnit(nodeBin, roomyBin, home) {
  return `[Unit]
Description=Roomy personal AI assistant server
After=network.target

[Service]
Type=simple
ExecStart=${nodeBin} ${roomyBin} start
Restart=on-failure
RestartSec=10
Environment=ROOMY_HOME=${home}

[Install]
WantedBy=default.target
`;
}

async function installService() {
  const home = await ensureRoomyHome();
  const nodeBin = process.execPath;
  const roomyBin = path.resolve(__dirname, "roomy.mjs");
  await fsp.mkdir(path.join(home, "logs"), { recursive: true });

  if (process.platform === "darwin") {
    await fsp.mkdir(path.dirname(LAUNCHD_PLIST_PATH), { recursive: true });
    await fsp.writeFile(LAUNCHD_PLIST_PATH, launchdPlist(nodeBin, roomyBin, home));
    log(`Wrote ${LAUNCHD_PLIST_PATH}`);
    const { status } = spawnSync("launchctl", ["load", "-w", LAUNCHD_PLIST_PATH], { stdio: "inherit" });
    if (status !== 0) { process.stderr.write("launchctl load failed\n"); process.exit(1); }
    log("Service installed and started.");
  } else if (process.platform === "linux") {
    await fsp.mkdir(SYSTEMD_UNIT_DIR, { recursive: true });
    await fsp.writeFile(SYSTEMD_UNIT_PATH, systemdUnit(nodeBin, roomyBin, home));
    log(`Wrote ${SYSTEMD_UNIT_PATH}`);
    spawnSync("systemctl", ["--user", "daemon-reload"], { stdio: "inherit" });
    spawnSync("systemctl", ["--user", "enable", "--now", SYSTEMD_UNIT_NAME], { stdio: "inherit" });
    log("Service installed and started.");
  } else if (process.platform === "win32") {
    const cmd = `schtasks /Create /F /TN "${WIN_TASK_NAME}" /TR "${nodeBin} ${roomyBin} start" /SC ONLOGON /RL LIMITED`;
    const { status } = spawnSync("cmd", ["/C", cmd], { stdio: "inherit" });
    if (status !== 0) process.exit(1);
    log(`Task Scheduler task "${WIN_TASK_NAME}" created.`);
  } else {
    process.stderr.write(`roomy service install: unsupported platform ${process.platform}\n`);
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
    process.stderr.write(`roomy service uninstall: unsupported platform ${process.platform}\n`);
    process.exit(1);
  }
}

function serviceControl(action) {
  let cmds;
  if (process.platform === "darwin") {
    cmds = {
      start: ["launchctl", ["load", "-w", LAUNCHD_PLIST_PATH]],
      stop: ["launchctl", ["unload", LAUNCHD_PLIST_PATH]],
      status: ["launchctl", ["list", LAUNCHD_LABEL]],
    };
  } else if (process.platform === "linux") {
    cmds = {
      start: ["systemctl", ["--user", "start", SYSTEMD_UNIT_NAME]],
      stop: ["systemctl", ["--user", "stop", SYSTEMD_UNIT_NAME]],
      restart: ["systemctl", ["--user", "restart", SYSTEMD_UNIT_NAME]],
      status: ["systemctl", ["--user", "status", SYSTEMD_UNIT_NAME]],
    };
  } else if (process.platform === "win32") {
    cmds = {
      start: ["schtasks", ["/Run", "/TN", WIN_TASK_NAME]],
      stop: ["schtasks", ["/End", "/TN", WIN_TASK_NAME]],
      status: ["schtasks", ["/Query", "/TN", WIN_TASK_NAME]],
    };
  } else {
    process.stderr.write(`roomy service: unsupported platform ${process.platform}\n`);
    process.exit(1);
  }
  // macOS launchd has no first-class "restart" — unload then reload picks
  // up the new on-disk binaries. Windows schtasks: end then run.
  if (action === "restart" && !cmds.restart) {
    if (!cmds.stop || !cmds.start) {
      process.stderr.write(`roomy service restart: unsupported platform ${process.platform}\n`);
      process.exit(1);
    }
    // Stop is best-effort — if it wasn't running, start will still bring it up.
    spawnSync(cmds.stop[0], cmds.stop[1], { stdio: "inherit" });
    const { status } = spawnSync(cmds.start[0], cmds.start[1], { stdio: "inherit" });
    if (status !== 0) process.exit(status ?? 1);
    log("Service restarted.");
    return;
  }
  const c = cmds[action];
  if (!c) { process.stderr.write(`Unknown action: ${action}\n`); process.exit(2); }
  const { status } = spawnSync(c[0], c[1], { stdio: "inherit" });
  if (status !== 0) process.exit(status ?? 1);
  // start/stop/restart succeed silently on every platform's underlying tool;
  // print a friendly confirmation so the user doesn't have to re-check with
  // `service status` to know it worked. The status command's own output
  // is the answer, so we skip the extra line there.
  if (action === "start") log("Service started.");
  else if (action === "stop") log("Service stopped.");
  else if (action === "restart") log("Service restarted.");
}

/**
 * True when the OS-level service is currently registered. The
 * uninstallService() helpers tolerate "not installed" silently, but the
 * uninstall summary reads better when we report it accurately.
 */
function isServiceInstalled() {
  if (process.platform === "darwin") return fs.existsSync(LAUNCHD_PLIST_PATH);
  if (process.platform === "linux") return fs.existsSync(SYSTEMD_UNIT_PATH);
  if (process.platform === "win32") {
    const { status } = spawnSync(
      "schtasks", ["/Query", "/TN", WIN_TASK_NAME],
      { stdio: "ignore" },
    );
    return status === 0;
  }
  return false;
}

/**
 * Remove every `roomy/*` container image. Best-effort: a stopped runtime
 * or missing binary exits silently.
 *
 * macOS uses the nerdctl wrapper (Colima/containerd); Linux uses Docker.
 */
function removeRoomyImages() {
  const home = process.env.ROOMY_HOME ?? path.join(os.homedir(), "Roomy");
  const wrapper = nerdctlWrapperPath(home);
  // macOS: prefer the nerdctl wrapper, fall back to bare nerdctl if colima is
  // on PATH. Linux: Docker is the native runtime.
  const tool = fs.existsSync(wrapper)
    ? wrapper
    : (process.platform === "darwin" ? (findColima(home) ? "nerdctl" : null) : "docker");
  if (!tool) return 0;

  const list = spawnSync(tool, ["images", "--format", "{{.Repository}}:{{.Tag}}"], { encoding: "utf-8" });
  if (list.status !== 0) return 0;

  let removed = 0;
  for (const tag of list.stdout.split("\n").map((l) => l.trim()).filter((l) => l.startsWith("roomy/"))) {
    const { status } = spawnSync(tool, ["rmi", "-f", tag], { stdio: "inherit" });
    if (status === 0) removed += 1;
  }
  return removed;
}

async function cmdUninstall(args) {
  const removeFiles = args.includes("--remove-roomy-files");
  const summary = { service: false, images: 0, files: null, npmHint: null };

  if (isServiceInstalled()) {
    log("Stopping and unregistering the background service…");
    await uninstallService();
    summary.service = true;
  } else {
    log("Background service: not installed.");
  }

  const removed = removeRoomyImages();
  summary.images = removed;
  if (removed > 0) log(`Removed ${removed} roomy/* container image(s).`);
  else log("Container images: nothing to remove.");

  if (removeFiles) {
    const home = process.env.ROOMY_HOME ?? path.join(os.homedir(), "Roomy");
    if (fs.existsSync(home)) {
      log(`Removing ${home}…`);
      await fsp.rm(home, { recursive: true, force: true });
      summary.files = home;
    } else {
      log(`No data directory at ${home}.`);
    }
  } else {
    log("Data files preserved. Re-run with --remove-roomy-files to delete ~/Roomy.");
  }

  log("");
  log("Roomy has been uninstalled from this machine.");
  log("To finish removing the CLI itself:");
  log("  • If installed globally:  npm uninstall -g @roomy-ai/cli");
  log("  • If used via npx:        npx clear-npx-cache  (or just stop calling it)");
}

function sanitizeReleaseId(value) {
  const cleaned = String(value).replace(/[^0-9A-Za-z_.-]+/g, "-").replace(/^-+|-+$/g, "");
  return cleaned.slice(0, 96) || "source";
}

function defaultSourceReleaseId(sourceRoot, now = () => new Date().toISOString()) {
  const stamp = now().replace(/[^0-9A-Za-z]+/g, "");
  const result = spawnSync("git", ["-C", sourceRoot, "rev-parse", "--short=12", "HEAD"], {
    encoding: "utf-8",
  });
  const sha = result.status === 0 ? result.stdout.trim() : "source";
  return sanitizeReleaseId(`${stamp}-${process.pid}-${sha}`);
}

async function copySourceToStaging(sourceRoot, stagingDir) {
  await fsp.rm(stagingDir, { recursive: true, force: true });
  await fsp.mkdir(path.dirname(stagingDir), { recursive: true });
  await fsp.cp(sourceRoot, stagingDir, {
    recursive: true,
    verbatimSymlinks: true,
    filter(src) {
      const rel = path.relative(sourceRoot, src);
      if (!rel) return true;
      const parts = rel.split(path.sep);
      const name = parts[parts.length - 1];
      if (parts.includes(".git") || parts.includes("node_modules") || parts.includes("dist")) return false;
      if (name === ".env" || name === ".env.local") return false;
      if (parts[0] === ".nx" || parts[0] === "coverage") return false;
      return true;
    },
  });
}

function runChecked(runSync, command, args, options, label) {
  const result = runSync(command, args, {
    stdio: "inherit",
    ...options,
    env: { ...process.env, ...(options?.env ?? {}) },
  });
  if (result.status !== 0) {
    throw new Error(`${label} failed (exit ${result.status ?? 1})`);
  }
}

async function switchCurrentLink(currentLink, releaseDir) {
  await fsp.mkdir(path.dirname(currentLink), { recursive: true });
  const nextLink = `${currentLink}.next-${process.pid}`;
  await fsp.rm(nextLink, { recursive: true, force: true });
  await fsp.symlink(releaseDir, nextLink, "dir");
  try {
    await fsp.rename(nextLink, currentLink);
  } catch (err) {
    if (err?.code !== "EEXIST" && err?.code !== "ENOTEMPTY" && err?.code !== "EPERM") {
      throw err;
    }
    await fsp.rm(currentLink, { recursive: true, force: true });
    await fsp.rename(nextLink, currentLink);
  }
}

async function writeSourceReleaseConfig(home, manifest) {
  await fsp.writeFile(sourceReleaseConfigPath(home), `${JSON.stringify(manifest, null, 2)}\n`);
}

async function clearSourceReleaseConfig(home) {
  await fsp.rm(sourceReleaseConfigPath(home), { force: true });
}

export async function updateFromSource(options) {
  const sourceRoot = validateSourceRoot(options.source);
  const home = options.home ?? (process.env.ROOMY_HOME ?? path.join(os.homedir(), "Roomy"));
  const releaseId = sanitizeReleaseId(options.releaseId ?? defaultSourceReleaseId(sourceRoot, options.now));
  const releasesDir = options.releasesDir ?? releasesDirForHome(home);
  const currentLink = options.currentLink ?? currentLinkForHome(home);
  const releaseDir = path.join(releasesDir, releaseId);
  const stagingDir = path.join(releasesDir, `.staging-${releaseId}-${process.pid}`);
  const sandboxImage = options.sandboxImage ?? `roomy/source:${releaseId}`;
  const runSyncFn = options.runSync ?? spawnSync;
  const restartService = options.restartService ?? (() => serviceControl("restart"));
  const serviceInstalled = options.serviceInstalled ?? isServiceInstalled();
  const now = options.now ?? (() => new Date().toISOString());

  await fsp.mkdir(home, { recursive: true });
  await fsp.mkdir(releasesDir, { recursive: true });

  log(`Building source release from ${sourceRoot}…`);
  log(`Staging release ${releaseId} under ${releasesDir}…`);
  await copySourceToStaging(sourceRoot, stagingDir);
  // The root prepare script installs a git hook. Releases do not need git
  // history, but npm install still expects this hook directory to exist.
  await fsp.mkdir(path.join(stagingDir, ".git", "hooks"), { recursive: true });

  try {
    runChecked(
      runSyncFn,
      "npm",
      ["ci", "--include=optional", "--no-audit", "--no-fund"],
      { cwd: stagingDir },
      "npm ci",
    );
    runChecked(runSyncFn, "npm", ["run", "build"], { cwd: stagingDir }, "npm run build");

    if (options.skipDocker) {
      log("Skipping source sandbox image build (--skip-docker).");
    } else {
      runChecked(
        runSyncFn,
        "bash",
        [path.join(stagingDir, "packages", "server", "setup", "scripts", "ensure-sandbox-image.sh")],
        { cwd: stagingDir, env: { ROOMY_SANDBOX_IMAGE: sandboxImage, ROOMY_SANDBOX_STRICT: "1" } },
        "sandbox image build",
      );
    }

    const apiEntry = path.join(stagingDir, "packages", "server", "api", "dist", "main.js");
    const appIndex = path.join(stagingDir, "packages", "app", "dist", "index.html");
    assertExists(apiEntry, "built API entry");
    assertExists(appIndex, "built app bundle");

    await fsp.rm(releaseDir, { recursive: true, force: true });
    await fsp.rename(stagingDir, releaseDir);
    await switchCurrentLink(currentLink, releaseDir);
    await writeSourceReleaseConfig(home, {
      mode: "source",
      sourceRoot,
      releaseId,
      releaseDir,
      currentLink,
      sandboxImage: options.skipDocker ? null : sandboxImage,
      updatedAt: now(),
    });

    log(`Source release ready: ${releaseDir}`);
    log(`Current release → ${releaseDir}`);
  } catch (err) {
    await fsp.rm(stagingDir, { recursive: true, force: true });
    throw err;
  }

  if (options.skipRestart) {
    log("Skipping service restart (--skip-restart).");
    log("Restart whatever is running `roomy start` to pick up the source release.");
    return;
  }
  if (!serviceInstalled) {
    log("No `roomy service` installation found.");
    log("Restart whatever is running `roomy start` to pick up the source release.");
    return;
  }
  log("Restarting roomy service…");
  restartService();
}

/**
 * Pull the latest published CLI + sandbox image and restart the service.
 *
 * Three steps, in order:
 *   1. `npm install -g @roomy-ai/cli@<tag>` — replaces the CLI and every
 *      bundled @roomy-ai/* dep (api, app, runtime, …) on disk. The running
 *      process keeps its loaded modules; new code only takes effect after
 *      restart. Tag defaults to `latest` to match publishConfig.tag, override
 *      with --tag=<dist-tag-or-version>.
 *   2. `docker pull <sandbox image>` — the runtime pulls per-sandbox on
 *      first start, but the `:latest` tag is mutable; pulling now avoids a
 *      cold-start delay the next time a sandbox boots.
 *   3. Restart the OS service if one is installed (launchd/systemd/Task
 *      Scheduler). If not, tell the user to restart whatever is running
 *      the server.
 *
 * Refuses to run from a monorepo checkout — there, the equivalent is
 * `git pull && npm install` and the npm-global path doesn't apply.
 */
async function cmdUpdate(args) {
  const parsed = parseUpdateArgs(args);
  if (parsed.mode === "source") {
    return updateFromSource(parsed);
  }

  if (detectMonorepo()) {
    process.stderr.write(
      "roomy update: this command updates a published install. " +
      "You're inside the monorepo — use `git pull && npm install` instead.\n",
    );
    process.exit(2);
  }

  const { skipDocker, skipRestart, tag } = parsed;
  const home = process.env.ROOMY_HOME ?? path.join(os.homedir(), "Roomy");

  log(`Updating @roomy-ai/cli to ${tag}…`);
  const npmResult = spawnSync(
    "npm", ["install", "-g", `@roomy-ai/cli@${tag}`],
    { stdio: "inherit" },
  );
  if (npmResult.status !== 0) {
    process.stderr.write(
      "roomy update: npm install failed. " +
      "If you installed roomy with sudo or under a different node, re-run from that environment.\n",
    );
    process.exit(npmResult.status ?? 1);
  }

  if (skipDocker) {
    log("Skipping docker pull (--skip-docker).");
  } else {
    const image = process.env.ROOMY_SANDBOX_IMAGE ?? defaultSandboxImage();
    // On macOS we use the nerdctl wrapper (Colima/containerd); fall back to
    // docker on Linux or if the wrapper isn't installed yet.
    const wrapper = nerdctlWrapperPath(home);
    const pullCmd = (process.platform === "darwin" && fs.existsSync(wrapper))
      ? wrapper
      : "docker";
    log(`Pulling sandbox image ${image}…`);
    const dockerResult = spawnSync(pullCmd, ["pull", image], { stdio: "inherit" });
    if (dockerResult.status !== 0) {
      // Don't fail the whole update — the runtime will retry the pull on
      // the next sandbox boot. Common cases: runtime not running, not installed
      // yet, transient registry hiccup.
      process.stderr.write(
        "roomy update: image pull failed (continuing). " +
        "The runtime will retry on the next sandbox start.\n",
      );
    }
  }

  await clearSourceReleaseConfig(home);

  if (skipRestart) {
    log("Skipping service restart (--skip-restart).");
    log("Restart whatever is running `roomy start` to pick up the new build.");
    return;
  }
  if (!isServiceInstalled()) {
    log("No `roomy service` installation found.");
    log("Restart whatever is running `roomy start` to pick up the new build.");
    return;
  }
  log("Restarting roomy service…");
  serviceControl("restart");
}

async function cmdService(action, extraArgs = []) {
  if (!action) {
    process.stderr.write("Usage: roomy service install|uninstall|start|stop|restart|status|update\n");
    process.exit(2);
  }
  if (action === "install") return installService();
  if (action === "uninstall") return uninstallService();
  if (action === "update") return cmdUpdate(extraArgs);
  if (action === "start" || action === "stop" || action === "restart" || action === "status") return serviceControl(action);
  process.stderr.write(`Unknown service action: ${action}\nUsage: roomy service install|uninstall|start|stop|restart|status|update\n`);
  process.exit(2);
}

const MIN_NODE_MAJOR = 22;

function ensureNodeVersion() {
  const major = parseInt(process.versions.node.split(".")[0], 10);
  if (major >= MIN_NODE_MAJOR) return;
  process.stderr.write(
    `roomy: Node ${MIN_NODE_MAJOR}+ is required (found ${process.versions.node}).\n` +
      "  Install via:\n" +
      `    volta install node@${MIN_NODE_MAJOR}\n` +
      `    fnm install ${MIN_NODE_MAJOR} && fnm use ${MIN_NODE_MAJOR}\n` +
      `    nvm install ${MIN_NODE_MAJOR} && nvm use ${MIN_NODE_MAJOR}\n`,
  );
  process.exit(1);
}

async function main() {
  ensureNodeVersion();
  const sub = process.argv[2] ?? "start";
  switch (sub) {
    case "start": return cmdStart();
    case "init": return cmdInit();
    case "service": return cmdService(process.argv[3], process.argv.slice(4));
    case "update": return cmdUpdate(process.argv.slice(3));
    case "uninstall": return cmdUninstall(process.argv.slice(3));
    case "version":
    case "--version":
    case "-v":
      return cmdVersion();
    case "help":
    case "--help":
    case "-h":
      process.stdout.write(
        "Usage: roomy [start|init|service|update|uninstall|version]\n" +
        "  start                              boot roomy-server (default)\n" +
        "  init                               create ~/Roomy without starting\n" +
        "  service install|uninstall          register/unregister Roomy as a system service\n" +
        "  service start|stop|restart|status  control the installed system service\n" +
        "  service update [--tag=<tag>]        update from npm and restart the service\n" +
        "  service update --source <repo>      build a local checkout into ROOMY_HOME/current\n" +
        "  update [--tag=<tag>]                pull @roomy-ai/cli + sandbox image from npm\n" +
        "  update --source <repo>              build a local checkout into ROOMY_HOME/current\n" +
        "         [--skip-docker]              skip sandbox image pull/build.\n" +
        "         [--skip-restart]             --tag defaults to `latest`.\n" +
        "  uninstall [--remove-roomy-files]    remove the service + roomy/* docker images;\n" +
        "                                     pass --remove-roomy-files to also delete ~/Roomy\n" +
        "  version                            print version\n",
      );
      return;
    default:
      process.stderr.write(`unknown subcommand: ${sub}\n`);
      process.exit(2);
  }
}

// Don't auto-run when this module is imported (e.g. by tests). We compare
// realpath()s so the check survives:
//   - the .bin/roomy symlink npm drops into node_modules/.bin/
//   - macOS resolving /tmp -> /private/tmp on one side but not the other
//   - the user invoking via a direct symlink anywhere on $PATH
function isMainModule() {
  if (!process.argv[1]) return false;
  try {
    const self = fs.realpathSync(fileURLToPath(import.meta.url));
    const entry = fs.realpathSync(process.argv[1]);
    return self === entry;
  } catch {
    return false;
  }
}

if (isMainModule()) {
  main().catch((err) => {
    process.stderr.write(`roomy: ${err?.stack ?? err}\n`);
    process.exit(1);
  });
}
