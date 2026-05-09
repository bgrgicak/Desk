/**
 * Queries the list of AI models available inside an agent's sandbox by running
 * `opencode models` there. The sandbox is the source of truth for what models
 * are reachable, because the provider config (API keys, registered providers)
 * lives with the in-sandbox OpenCode installation.
 */

import { execInSandbox } from "./sandboxExec.js";

export interface ModelRef {
  /** Opencode's canonical model id, e.g. "opencode/big-pickle". Pass this to `opencode run --model`. */
  id: string;
  /** Provider portion of `id`, denormalised so UIs can group/filter without parsing. */
  provider: string;
  /** Maximum context window reported by `opencode models --verbose`, when available. */
  contextWindow?: number;
  /** Maximum input tokens reported by `opencode models --verbose`, when available. */
  inputLimit?: number;
  /** Maximum output tokens reported by `opencode models --verbose`, when available. */
  outputLimit?: number;
}

export interface ListModelsOptions {
  /** Restrict to a single provider, e.g. "opencode". */
  provider?: string;
  timeoutMs?: number;
  /** Provider API keys to inject when the sandbox is first created. */
  providerKeys?: Record<string, string>;
  /**
   * Extra env vars (typically from local sources — Codex, LM Studio, Ollama)
   * forwarded into the `opencode models` exec so those providers light up.
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
  { id: "opencode/big-pickle", provider: "opencode", contextWindow: 200_000, outputLimit: 128_000 },
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

  const argv = ["opencode", "models", "--verbose"];
  if (opts.provider) argv.push(opts.provider);

  const result = await execInSandbox(workspaceId, workspaceSlug, {
    argv,
    timeoutMs: opts.timeoutMs ?? 15_000,
    providerKeys: opts.providerKeys,
    env: opts.env,
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

/** Parses `opencode models` output, including verbose JSON metadata when present. */
export function parseModelsOutput(stdout: string): ModelRef[] {
  const models: ModelRef[] = [];
  const lines = stdout.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = raw.trim();
    if (!line) continue;
    const slash = line.indexOf("/");
    if (slash <= 0) continue;
    const provider = line.slice(0, slash);
    const rest = line.slice(slash + 1);
    if (!rest) continue;

    const jsonLines: string[] = [];
    let depth = 0;
    let sawJson = false;
    for (let j = i + 1; j < lines.length; j++) {
      const next = lines[j];
      const trimmed = next.trim();
      if (!sawJson && trimmed === "") continue;
      if (!sawJson && !trimmed.startsWith("{")) break;
      sawJson = true;
      jsonLines.push(next);
      for (const ch of next) {
        if (ch === "{") depth++;
        if (ch === "}") depth--;
      }
      if (sawJson && depth <= 0) {
        i = j;
        break;
      }
    }

    if (!sawJson) {
      models.push({ id: line, provider });
      continue;
    }

    try {
      const meta = JSON.parse(jsonLines.join("\n")) as {
        limit?: { context?: unknown; input?: unknown; output?: unknown };
      };
      const contextWindow = positiveNumber(meta.limit?.context);
      const inputLimit = positiveNumber(meta.limit?.input);
      const outputLimit = positiveNumber(meta.limit?.output);
      models.push({
        id: line,
        provider,
        ...(contextWindow !== undefined ? { contextWindow } : {}),
        ...(inputLimit !== undefined ? { inputLimit } : {}),
        ...(outputLimit !== undefined ? { outputLimit } : {}),
      });
    } catch {
      models.push({ id: line, provider });
    }
  }
  return models;
}

function positiveNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}
