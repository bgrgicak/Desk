/**
 * Queries the list of AI models available inside an agent's sandbox by running
 * the selected agent runtime there. The sandbox is the source of truth for what
 * models are reachable, because provider config (API keys, registered
 * providers) lives with the in-sandbox runtime installation.
 */

import { execInSandbox } from "./sandboxExec.js";
import { buildPiAuthSetup, piAgentDirForRun, shSingleQuote } from "./driver.js";

export interface ModelRef {
  /** Runtime canonical model id, e.g. "opencode/big-pickle" or "anthropic/claude-sonnet-4-5". */
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
   * forwarded into the model-list exec so those providers light up.
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

function selectedAgentRuntime(): "opencode" | "pi" {
  return process.env.DESK_AGENT_RUNTIME === "pi" ? "pi" : "opencode";
}

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

  const runtime = selectedAgentRuntime();
  const argv = runtime === "pi" ? ["pi", "--list-models"] : ["opencode", "models", "--verbose"];
  if (opts.provider) {
    if (runtime === "pi") argv.push(opts.provider);
    else argv.push(opts.provider);
  }

  const execArgv = runtime === "pi" ? buildPiListModelsCommand(argv) : argv;

  const result = await execInSandbox(workspaceId, workspaceSlug, {
    argv: execArgv,
    timeoutMs: opts.timeoutMs ?? 15_000,
    providerKeys: opts.providerKeys,
    env: runtime === "pi"
      ? { PI_TELEMETRY: "0", PI_SKIP_VERSION_CHECK: "1", PI_OFFLINE: "1", ...opts.env }
      : opts.env,
  });

  if (result.exitCode !== 0) {
    throw new SandboxExecError(
      `${runtime} model listing failed (exit ${result.exitCode})`,
      result.exitCode,
      result.stderr,
    );
  }

  return parseModelsOutput(result.stdout);
}

function buildPiListModelsCommand(argv: string[]): string[] {
  const agentDir = piAgentDirForRun("model-list");
  const setup = buildPiAuthSetup(agentDir);
  const command = argv.map(shSingleQuote).join(" ");
  return [
    "sh", "-c",
    `${setup}; PI_CODING_AGENT_DIR=${shSingleQuote(agentDir)} PI_TELEMETRY=0 PI_SKIP_VERSION_CHECK=1 PI_OFFLINE=1 exec ${command}`,
  ];
}

/** Parses runtime model-list output, including OpenCode verbose JSON metadata when present. */
export function parseModelsOutput(stdout: string): ModelRef[] {
  const models: ModelRef[] = [];
  const lines = stdout.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = raw.trim();
    if (!line) continue;
    const tableRef = parsePiTableModelLine(line);
    if (tableRef) {
      models.push(tableRef);
      continue;
    }
    // Pi prints human guidance when no providers/models are configured. Some
    // guidance lines contain slash-prefixed commands such as `/login`; don't let
    // the generic OpenCode `provider/model` parser turn those into fake models.
    if (isPiGuidanceLine(line)) {
      continue;
    }
    const slash = line.indexOf("/");
    if (slash <= 0) {
      continue;
    }
    const provider = line.slice(0, slash);
    const rest = line.slice(slash + 1);
    if (!rest) continue;

    // Brace-counted block scan. Naive: doesn't account for braces inside
    // strings, but `opencode models --verbose` doesn't currently emit
    // any string values containing `{` or `}`. JSON.parse below catches
    // mis-extracted blocks and falls back to no-metadata.
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

function isPiGuidanceLine(line: string): boolean {
  return line.startsWith("No models ") || line.startsWith("Use /") || line.startsWith("See:");
}

function parsePiTableModelLine(line: string): ModelRef | null {
  // Pi's `--list-models` output is a fixed-width-ish table:
  // provider        model                   context  max-out  thinking  images
  // github-copilot  claude-sonnet-4.5       144K     32K      yes       yes
  const parts = line.split(/\s+/).filter(Boolean);
  if (parts[0] === "provider" || parts[1] === "model") return null;
  // When Pi has no configured providers, `--list-models` prints guidance such
  // as `Use /login to log into...`. That superficially looks like a provider +
  // slash-containing model pair, so require the real table's metric columns
  // before treating a whitespace-delimited line as a model row.
  if (parts.length < 4) return null;
  const [provider, model, context, output] = parts;
  if (line.startsWith("No models ")) return null;
  if (!provider || !model || provider.includes(":") || provider.includes("/")) return null;
  if (model.startsWith("/") || model.includes(":")) return null;
  const contextWindow = parseTokenCount(context);
  const outputLimit = parseTokenCount(output);
  if (contextWindow === undefined && outputLimit === undefined) return null;
  return {
    id: `${provider}/${model}`,
    provider,
    ...(contextWindow !== undefined ? { contextWindow } : {}),
    ...(outputLimit !== undefined ? { outputLimit } : {}),
  };
}

function parseTokenCount(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const match = value.match(/^(\d+(?:\.\d+)?)([KkMm])?$/);
  if (!match) return undefined;
  const n = Number(match[1]);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  const unit = match[2]?.toLowerCase();
  if (unit === "m") return Math.round(n * 1_000_000);
  if (unit === "k") return Math.round(n * 1_000);
  return Math.round(n);
}

function positiveNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}
