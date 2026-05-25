/**
 * Pure env-construction logic for the roomy-server child process.
 *
 * Lives in its own module (no Electron imports) so it can be unit-tested
 * in plain Node without needing a mock of `electron/main`.
 */

export const DEFAULT_SANDBOX_IMAGE = "bgrgicak/roomy-ai:latest";

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
    ROOMY_SECRET_KEY: opts.secretKey,
    ROOMY_HOME: opts.roomyHome,
    PORT: String(opts.port),
    ROOMY_SERVE_APP: "1",
    ROOMY_APP_DIST: opts.appDist,
    // Mirror what the CLI does in published mode. The default "roomy/sandbox:v1"
    // only exists in a monorepo dev checkout (built locally); distributed
    // desktop users have no such image and Docker cannot pull it from any
    // registry — causing every chat turn to fail with "Agent run failed before
    // it could complete." Point at the registry-published image instead.
    ROOMY_SANDBOX_IMAGE: process.env.ROOMY_SANDBOX_IMAGE ?? DEFAULT_SANDBOX_IMAGE,
  };
}
