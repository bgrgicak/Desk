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

import { PassThrough } from "node:stream";
import { createOrReuse, providerKeyEnv } from "./docker.js";

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

  const { dockerSocketPath } = await import("./docker.js");
  const Docker = (await import("dockerode")).default;
  const docker = new Docker({ socketPath: dockerSocketPath() });
  const container = docker.getContainer(handle.containerId);

  const keyEnv = providerKeyEnv(opts.providerKeys);
  const extraEnv = opts.env ? Object.entries(opts.env).map(([k, v]) => `${k}=${v}`) : [];
  const execEnv = [...keyEnv, ...extraEnv];

  const exec = await container.exec({
    Cmd: opts.argv,
    ...(opts.user ? { User: opts.user } : {}),
    Env: execEnv.length > 0 ? execEnv : undefined,
    AttachStdout: true,
    AttachStderr: true,
  });

  const stream = await exec.start({ hijack: true, stdin: false });

  const timeoutMs = opts.timeoutMs ?? 30_000;
  let timedOut = false;

  return new Promise<ExecInSandboxResult>((resolve) => {
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    // Demux the multiplexed exec stream via dockerode's modem.
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    docker.modem.demuxStream(stream, stdout, stderr);

    stdout.on("data", (c: Buffer) => stdoutChunks.push(c));
    stderr.on("data", (c: Buffer) => stderrChunks.push(c));

    const timer = setTimeout(() => {
      timedOut = true;
      stream.destroy();
    }, timeoutMs);

    let stdoutDone = false;
    let stderrDone = false;
    let rawDone = false;

    const maybeFinish = async () => {
      if (!(stdoutDone && stderrDone && rawDone)) return;
      clearTimeout(timer);
      let exitCode = 1;
      try {
        const info = await exec.inspect();
        exitCode = info.ExitCode ?? 1;
      } catch {
        // Container may have gone away.
      }
      resolve({
        exitCode: timedOut ? 124 : exitCode,
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        stderr: Buffer.concat(stderrChunks).toString("utf8"),
        timedOut,
      });
    };

    stdout.on("end", () => { stdoutDone = true; void maybeFinish(); });
    stderr.on("end", () => { stderrDone = true; void maybeFinish(); });

    stream.on("end", () => {
      rawDone = true;
      stdout.end();
      stderr.end();
    });

    stream.on("error", () => {
      clearTimeout(timer);
      resolve({
        exitCode: 1,
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        stderr: Buffer.concat(stderrChunks).toString("utf8"),
        timedOut,
      });
    });
  });
}
