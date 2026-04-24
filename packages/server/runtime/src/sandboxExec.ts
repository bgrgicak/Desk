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
import { createOrReuse } from "./docker.js";

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
   * AI-provider credentials to inject when the sandbox is created on demand.
   * Only used if the container doesn't exist yet; existing containers keep
   * their original env. Omit to fall back to reading from host process env.
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
  if (process.env.DESK_SANDBOX_DRIVER === "fake") {
    return fakeExecInSandbox(opts);
  }

  const handle = await createOrReuse(workspaceId, workspaceSlug, undefined, opts.providerKeys);

  const { dockerSocketPath } = await import("./docker.js");
  const Docker = (await import("dockerode")).default;
  const docker = new Docker({ socketPath: dockerSocketPath() });
  const container = docker.getContainer(handle.containerId);

  const exec = await container.exec({
    Cmd: opts.argv,
    ...(opts.user ? { User: opts.user } : {}),
    Env: opts.env ? Object.entries(opts.env).map(([k, v]) => `${k}=${v}`) : undefined,
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

// The fake path is used by unit tests and offline dev. It recognises a small
// set of commands that the host control plane issues today; anything else
// returns a stub success so callers still get a well-formed result.
function fakeExecInSandbox(opts: ExecInSandboxOptions): ExecInSandboxResult {
  const cmd = opts.argv.join(" ");
  if (cmd.startsWith("opencode models")) {
    const provider = opts.argv[2];
    const all = [
      "anthropic/claude-opus-4-7",
      "anthropic/claude-sonnet-4-6",
      "anthropic/claude-haiku-4-5",
      "openai/gpt-5",
    ];
    const lines = provider ? all.filter((m) => m.startsWith(`${provider}/`)) : all;
    return { exitCode: 0, stdout: lines.join("\n") + "\n", stderr: "", timedOut: false };
  }
  return { exitCode: 0, stdout: "", stderr: "", timedOut: false };
}
