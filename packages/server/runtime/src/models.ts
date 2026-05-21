/**
 * Queries the list of AI models available inside an agent's sandbox by
 * running `pi --list-models` there. The sandbox is the source of truth
 * because the provider config (API keys, registered providers) is what
 * pi inside the container can see.
 *
 * Pi prints one `<provider>/<model>` id per line. We parse those into
 * `ModelRef`s; verbose context-window metadata is omitted (pi has no
 * --verbose equivalent yet, and Desk's UI only requires the id + provider).
 */

import { execInSandbox } from "./sandboxExec.js";

export interface ModelRef {
  /** Canonical model id, e.g. "anthropic/claude-haiku-4-5". */
  id: string;
  /** Provider portion of `id`, denormalised so UIs can group/filter without parsing. */
  provider: string;
  /** Maximum context window when known. Not surfaced by pi today. */
  contextWindow?: number;
  inputLimit?: number;
  outputLimit?: number;
}

export interface ListModelsOptions {
  /** Restrict to a single provider, e.g. "anthropic". */
  provider?: string;
  timeoutMs?: number;
  /** Provider API keys to inject when the sandbox is first created. */
  providerKeys?: Record<string, string>;
  /**
   * Extra env vars (typically from local sources) forwarded into the
   * `pi --list-models` exec so those providers light up.
   */
  env?: Record<string, string>;
}

export class SandboxExecError extends Error {
  constructor(
    message: string,
    readonly exitCode: number,
    readonly stderr: string,
  ) {
    super(message);
    this.name = "SandboxExecError";
  }
}

const FAKE_DRIVER_MODELS: ModelRef[] = [
  { id: "anthropic/claude-haiku-4-5", provider: "anthropic", contextWindow: 200_000, outputLimit: 64_000 },
];

export async function listModels(
  workspaceId: string,
  workspaceSlug: string,
  opts: ListModelsOptions = {},
): Promise<ModelRef[]> {
  if (process.env.DESK_SANDBOX_DRIVER === "fake") {
    return opts.provider
      ? FAKE_DRIVER_MODELS.filter((model) => model.provider === opts.provider)
      : FAKE_DRIVER_MODELS;
  }

  const argv = ["pi", "--list-models"];
  if (opts.provider) argv.push("--provider", opts.provider);

  const result = await execInSandbox(workspaceId, workspaceSlug, {
    argv,
    timeoutMs: opts.timeoutMs ?? 15_000,
    providerKeys: opts.providerKeys,
    env: opts.env,
  });

  if (result.exitCode !== 0) {
    throw new SandboxExecError(
      `pi --list-models failed (exit ${result.exitCode})`,
      result.exitCode,
      result.stderr,
    );
  }

  return parseModelsOutput(result.stdout);
}

/**
 * Parses pi's `--list-models` output. Each non-empty line is one
 * `<provider>/<model>` id; lines without a slash are skipped.
 */
export function parseModelsOutput(stdout: string): ModelRef[] {
  const models: ModelRef[] = [];
  for (const raw of stdout.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const slash = line.indexOf("/");
    if (slash <= 0) continue;
    const provider = line.slice(0, slash);
    if (!line.slice(slash + 1)) continue;
    models.push({ id: line, provider });
  }
  return models;
}
