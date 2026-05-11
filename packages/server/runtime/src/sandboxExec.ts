/**
 * Foundation primitive for host → sandbox command execution.
 *
 * The existing Tool API handles sandbox → host calls (agent code running inside
 * the sandbox reaches out to host-mediated tools via UDS). `execInSandbox` is
 * the inverse: the host control plane invoking a command inside a warm sandbox
 * and capturing its output. It underpins control-plane features such as model
 * discovery (`opencode models`) and is the seam through which future
 * sandbox-scoped read operations will flow.
 */

import { createOrReuse, providerKeyEnv, sandboxUser } from "./docker.js";
import { detectEngine } from "./engine.js";

export interface ExecInSandboxOptions {
  /** Command + args to run inside the container. */
  argv: string[];
  /** User to exec as. Defaults to the sandbox's primary agent user. */
  user?: string;
  /** Milliseconds before the exec is aborted. Defaults to 30_000. */
  timeoutMs?: number;
  /** Extra environment variables. */
  env?: Record<string, string>;
  /**
   * AI-provider credentials to inject. Used both when the sandbox is created
   * on demand and on every exec, so reused containers pick up rotated or
   * newly-saved keys without a restart. Omit to fall back to host process env.
   */
  providerKeys?: Record<string, string>;
}

export interface ExecInSandboxResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  /** True when the exec was aborted because `timeoutMs` elapsed. */
  timedOut: boolean;
}

/**
 * Runs a command inside the workspace's sandbox and returns captured output.
 * Creates or reuses the warm sandbox container on demand.
 */
export async function execInSandbox(
  workspaceId: string,
  workspaceSlug: string,
  opts: ExecInSandboxOptions,
): Promise<ExecInSandboxResult> {
  const handle = await createOrReuse(workspaceId, workspaceSlug, undefined, opts.providerKeys);
  const engine = await detectEngine();
  const user = opts.user ?? (await sandboxUser(engine));

  const keyEnv = providerKeyEnv(opts.providerKeys);
  const extraEnv = opts.env ? Object.entries(opts.env).map(([k, v]) => `${k}=${v}`) : [];
  const execEnv = [...keyEnv, ...extraEnv];

  const handle$ = await engine.exec({
    containerId: handle.containerId,
    cmd: opts.argv,
    user,
    env: execEnv.length > 0 ? execEnv : undefined,
  });

  const timeoutMs = opts.timeoutMs ?? 30_000;
  let timedOut = false;
  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];

  handle$.stdout.on("data", (c: Buffer) => stdoutChunks.push(c));
  handle$.stderr.on("data", (c: Buffer) => stderrChunks.push(c));

  const timer = setTimeout(() => {
    timedOut = true;
    void handle$.cancel();
  }, timeoutMs);

  let exitCode = 1;
  try {
    exitCode = await handle$.wait();
  } finally {
    clearTimeout(timer);
  }

  return {
    exitCode: timedOut ? 124 : exitCode,
    stdout: Buffer.concat(stdoutChunks).toString("utf8"),
    stderr: Buffer.concat(stderrChunks).toString("utf8"),
    timedOut,
  };
}
