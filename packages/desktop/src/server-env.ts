/**
 * Pure env-construction logic for the roomy-server child process.
 *
 * Lives in its own module (no Electron imports) so it can be unit-tested
 * in plain Node without needing a mock of `electron/main`.
 */

import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const pkg = require("../package.json") as { version?: string };

export const DEFAULT_SANDBOX_IMAGE = `bgrgicak/roomy-ai:${pkg.version ?? "latest"}`;

/**
 * On macOS, apps launched from the Dock/Finder receive a minimal PATH
 * (/usr/bin:/bin:/usr/sbin:/sbin) that omits Homebrew and Docker Desktop
 * install locations. Prepend the common Docker/container-runtime paths so
 * the server process can find `docker` regardless of how the app was opened.
 */
function augmentPath(env: NodeJS.ProcessEnv): string {
  const base = env.PATH ?? "/usr/bin:/bin:/usr/sbin:/sbin";
  const extras = [
    "/usr/local/bin",          // Homebrew Intel / Docker Desktop symlink
    "/opt/homebrew/bin",       // Homebrew Apple Silicon
    "/Applications/Docker.app/Contents/Resources/bin",
    "/usr/local/bin/docker",   // fallback explicit dir
  ];
  const parts = base.split(":");
  for (const dir of extras) {
    if (!parts.includes(dir)) parts.unshift(dir);
  }
  return parts.join(":");
}

/**
 * Builds the env object passed to the roomy-server utility process.
 * All Electron/FS side effects (resolving appDist, reading the secret key)
 * are pre-resolved by the caller; this function is pure.
 */
export function buildServerEnvConfig(opts: {
  roomyHome: string;
  secretKey: string;
  appDist: string;
  port: number;
}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PATH: augmentPath(process.env),
    ROOMY_SECRET_KEY: opts.secretKey,
    ROOMY_HOME: opts.roomyHome,
    PORT: String(opts.port),
    ROOMY_SERVE_APP: "1",
    ROOMY_APP_DIST: opts.appDist,
    // Mirror what the CLI does in published mode. The default "roomy/sandbox:v1"
    // only exists in a monorepo dev checkout (built locally); distributed
    // desktop users have no such image and Docker cannot pull it from any
    // registry. Use the package-version registry tag so a mutable `latest`
    // manifest cannot drift away from the installed runtime.
    ROOMY_SANDBOX_IMAGE: process.env.ROOMY_SANDBOX_IMAGE ?? DEFAULT_SANDBOX_IMAGE,
  };
}
