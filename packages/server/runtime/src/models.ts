/**
 * Queries the list of AI models available inside an agent's sandbox by running
 * `opencode models` there. The sandbox is the source of truth for what models
 * are reachable, because the provider config (API keys, registered providers)
 * lives with the in-sandbox OpenCode installation.
 */

import { execInSandbox } from "./sandboxExec.js";

export interface ModelRef {
  providerId: string;
  modelId: string;
  /** Provider-prefixed id, e.g. "anthropic/claude-opus-4-7". */
  fullId: string;
}

export interface ListModelsOptions {
  /** Restrict to a single provider, e.g. "anthropic". */
  provider?: string;
  timeoutMs?: number;
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

export async function listModels(
  agentId: string,
  opts: ListModelsOptions = {},
): Promise<ModelRef[]> {
  const argv = ["opencode", "models"];
  if (opts.provider) argv.push(opts.provider);

  const result = await execInSandbox(agentId, {
    argv,
    timeoutMs: opts.timeoutMs ?? 15_000,
  });

  if (result.exitCode !== 0) {
    throw new SandboxExecError(
      `opencode models failed (exit ${result.exitCode})`,
      result.exitCode,
      result.stderr,
    );
  }

  return parseModelsOutput(result.stdout);
}

/** Parses newline-delimited `provider/model` pairs, tolerating stray whitespace. */
export function parseModelsOutput(stdout: string): ModelRef[] {
  const models: ModelRef[] = [];
  for (const raw of stdout.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const slash = line.indexOf("/");
    if (slash <= 0) continue;
    const providerId = line.slice(0, slash);
    const modelId = line.slice(slash + 1);
    if (!modelId) continue;
    models.push({ providerId, modelId, fullId: line });
  }
  return models;
}
