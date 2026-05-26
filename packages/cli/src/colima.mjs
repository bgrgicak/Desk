/**
 * Colima container runtime management.
 *
 * Colima (https://colima.run) is a self-contained VM-based container runtime
 * that works on both macOS and Linux. We run a dedicated "roomy" profile with
 * the containerd runtime so `colima nerdctl --profile roomy` works without
 * interfering with the user's own default Colima instance.
 *
 * The thin `~/Roomy/bin/nerdctl` wrapper calls
 * `colima nerdctl --profile roomy "$@"`, so engine.ts sees nerdctl as usual.
 */

import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createWriteStream } from "node:fs";

const COLIMA_VERSION = "v0.10.1";
const COLIMA_PROFILE = "roomy";

function colimaOS() {
  return process.platform === "darwin" ? "Darwin" : "Linux";
}

function colimaArch() {
  if (process.arch === "arm64") {
    return process.platform === "linux" ? "aarch64" : "arm64";
  }
  return "x86_64";
}

function colimaBinaryName() {
  return `colima-${colimaOS()}-${colimaArch()}`;
}

/** Search common locations for a colima binary. Returns the path or null. */
export function findColima(roomyHome) {
  const candidates = [
    path.join(roomyHome, "bin", "colima"),
    "/usr/local/bin/colima",
    "/opt/homebrew/bin/colima",
    "/home/linuxbrew/.linuxbrew/bin/colima",
    "/usr/bin/colima",
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

/** Download the Colima binary from GitHub releases into roomyHome/bin. */
export async function downloadColima(roomyHome) {
  const binDir = path.join(roomyHome, "bin");
  await fsp.mkdir(binDir, { recursive: true });
  const dest = path.join(binDir, "colima");

  const version = COLIMA_VERSION.replace(/^v/, "");
  const url = `https://github.com/abiosoft/colima/releases/download/v${version}/${colimaBinaryName()}`;

  process.stdout.write(`==> Downloading Colima ${COLIMA_VERSION}…\n`);
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Failed to download Colima (HTTP ${resp.status}): ${url}`);

  const writer = createWriteStream(dest);
  await pipeline(Readable.fromWeb(resp.body), writer);
  await fsp.chmod(dest, 0o755);

  process.stdout.write(`==> Colima installed to ${dest}\n`);
  return dest;
}

/**
 * Parse Colima's JSON status for the roomy profile, or return null on error.
 *
 * Colima v0.10+ exits non-zero when the profile is absent/stopped and exits 0
 * with instance details (driver, runtime, …) when running. Older versions may
 * include a `"status": "Running"` field; we handle both.
 */
function colimaStatus(colima) {
  const result = spawnSync(colima, ["status", "--json", "--profile", COLIMA_PROFILE], {
    encoding: "utf-8",
    timeout: 10_000,
  });
  if (result.status !== 0 || !result.stdout) return null;
  try {
    return JSON.parse(result.stdout);
  } catch {
    return null;
  }
}

function isStatusRunning(s) {
  if (s === null) return false;
  // Older Colima: explicit status field.
  if (typeof s.status === "string") return s.status === "Running";
  // v0.10+: exits non-zero when stopped, so any valid JSON means running.
  return Boolean(s.driver || s.runtime);
}

/** Returns true if the roomy Colima profile is running. */
export function isColimaRunning(colima) {
  return isStatusRunning(colimaStatus(colima));
}

/** Returns true if the roomy profile is running with containerd (required for nerdctl). */
export function isColimaRunningWithContainerd(colima) {
  const s = colimaStatus(colima);
  return isStatusRunning(s) && s?.runtime === "containerd";
}

/**
 * Start the roomy Colima profile with containerd runtime.
 * First run downloads a VM image — may take a few minutes.
 */
export function startColima(colima) {
  process.stdout.write("==> Starting Colima (first run downloads a VM image, may take a few minutes)…\n");
  const result = spawnSync(
    colima,
    ["start", "--profile", COLIMA_PROFILE, "--runtime", "containerd"],
    { stdio: "inherit" },
  );
  if (result.status !== 0) {
    throw new Error(`colima start failed. Run \`colima start --profile ${COLIMA_PROFILE} --runtime containerd\` to see details.`);
  }
}

/** Path for the nerdctl wrapper script inside roomyHome/bin. */
export function nerdctlWrapperPath(roomyHome) {
  return path.join(roomyHome, "bin", "nerdctl");
}

/**
 * Write ~/Roomy/bin/nerdctl — a thin shell script that forwards every call
 * to `colima nerdctl --profile roomy`. Engine.ts probes and uses this
 * transparently without knowing about Colima.
 */
export async function createNerdctlWrapper(roomyHome) {
  const binDir = path.join(roomyHome, "bin");
  await fsp.mkdir(binDir, { recursive: true });
  await fsp.writeFile(
    nerdctlWrapperPath(roomyHome),
    // `--` separates colima's own flags from the nerdctl subcommand and its flags.
    `#!/bin/sh\nexec colima nerdctl --profile ${COLIMA_PROFILE} -- "$@"\n`,
    { mode: 0o755 },
  );
}

/**
 * Ensure the roomy Colima profile is installed, running with containerd,
 * and the nerdctl wrapper exists. Call this before starting the server on macOS.
 *
 * If the roomy profile exists but uses the wrong runtime (Docker), it is
 * deleted and recreated with containerd. The profile is managed exclusively
 * by Roomy so deletion is safe.
 */
export async function ensureColima(roomyHome) {
  let colima = findColima(roomyHome);
  if (!colima) colima = await downloadColima(roomyHome);

  const status = colimaStatus(colima);

  if (status?.status === "Running" && status?.runtime !== "containerd") {
    process.stdout.write("==> Recreating Colima roomy profile with containerd runtime…\n");
    spawnSync(colima, ["stop", "--profile", COLIMA_PROFILE], { stdio: "inherit" });
    spawnSync(colima, ["delete", "--profile", COLIMA_PROFILE, "--force"], { stdio: "inherit" });
  }

  if (!isColimaRunningWithContainerd(colima)) startColima(colima);
  await createNerdctlWrapper(roomyHome);
}

/** ~/Roomy/bin — must be prepended to PATH so the server finds colima and the nerdctl wrapper. */
export function roomyBinDir(roomyHome) {
  return path.join(roomyHome, "bin");
}
