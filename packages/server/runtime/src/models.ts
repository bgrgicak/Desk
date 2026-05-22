/**
 * Queries the list of AI models available inside an agent's sandbox by
 * running `pi --list-models` there. The sandbox is the source of truth
 * because the provider config (API keys, registered providers) is what
 * pi inside the container can see.
 *
 * Pi prints a fixed-width column table with a `provider model context
 * max-out thinking images` header. We parse rows back into `ModelRef`s
 * keyed by `<provider>/<model>`. When pi has no authenticated provider
 * it prints a human-readable "No models available" message instead of
 * the table; in that case we yield an empty list.
 */

import { randomUUID } from "node:crypto";
import { execInSandbox } from "./sandboxExec.js";

const PI_CLI_PATH = "/usr/local/lib/node_modules/@earendil-works/pi-coding-agent/dist/cli.js";

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
  if (process.env.ROOMY_SANDBOX_DRIVER === "fake") {
    return opts.provider
      ? FAKE_DRIVER_MODELS.filter((model) => model.provider === opts.provider)
      : FAKE_DRIVER_MODELS;
  }

  // Pi authenticates OAuth providers (openai-codex, anthropic-pro, …)
  // from `$PI_CODING_AGENT_DIR/auth.json` on disk — it does not read the
  // OAuth blob from the env directly. The chat-turn path in piClient.ts
  // base64-decodes `PI_AUTH_JSON_BASE64` into a per-invocation agent dir
  // before exec'ing pi; the model-listing path has to do the same or
  // pi only sees env-var-based providers (e.g. ANTHROPIC_API_KEY) and
  // every OAuth-backed channel — including the Codex/ChatGPT
  // subscription — vanishes from the listing.
  const argv = piListModelsArgv(opts);
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

  // Pi writes the model table to stderr, not stdout, with exit code 0. We
  // concatenate both streams so the parser works regardless of which one
  // future pi versions choose; the header sentinel makes false matches in
  // unrelated stderr noise vanishingly unlikely.
  return parseModelsOutput(`${result.stdout}\n${result.stderr}`);
}

/**
 * Builds the argv for invoking `pi --list-models` inside the sandbox.
 * When `PI_AUTH_JSON_BASE64` is present in `opts.env`, the argv is
 * actually a `sh -c '…'` wrapper that base64-decodes the blob into a
 * per-invocation `$PI_CODING_AGENT_DIR/auth.json` and then `exec`s pi
 * against that dir. Without the wrapper, OAuth-backed providers (Codex/
 * ChatGPT, Claude Pro) silently disappear from the listing because pi
 * reads auth from disk, not env. Mirrors the seed logic in
 * `piClient.ts` so the listing path can never drift from the run path.
 */
function piListModelsArgv(opts: ListModelsOptions): string[] {
  const piArgs = ["node", PI_CLI_PATH, "--list-models"];
  if (opts.provider) piArgs.push("--provider", opts.provider);

  if (!opts.env?.PI_AUTH_JSON_BASE64) return piArgs;

  const agentDir = `/tmp/pi-list-${randomUUID()}/agent`;
  const piCmd = piArgs.map(shSingleQuote).join(" ");
  const script = [
    `mkdir -p ${shSingleQuote(agentDir)}`,
    `printf '%s' "$PI_AUTH_JSON_BASE64" | base64 -d > ${shSingleQuote(`${agentDir}/auth.json`)}`,
    `chmod 600 ${shSingleQuote(`${agentDir}/auth.json`)}`,
    `PI_CODING_AGENT_DIR=${shSingleQuote(agentDir)} exec ${piCmd}`,
  ].join(" && ");
  return ["sh", "-c", script];
}

function shSingleQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * Parses pi's `--list-models` output. The CLI prints a `provider model
 * context max-out thinking images` header followed by one row per model
 * with whitespace-separated columns. We take the first two columns and
 * synthesize the canonical `<provider>/<model>` id. Lines before the
 * header (and any non-tabular noise such as the empty-state message) are
 * skipped.
 */
const TOKEN = /^[A-Za-z0-9_.-]+$/;

export function parseModelsOutput(output: string): ModelRef[] {
  const models: ModelRef[] = [];
  let inTable = false;
  for (const raw of output.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const cols = line.split(/\s+/);
    if (!inTable) {
      if (cols[0] === "provider" && cols[1] === "model") inTable = true;
      continue;
    }
    if (cols.length < 2) continue;
    const [provider, model] = cols;
    if (!TOKEN.test(provider) || !TOKEN.test(model)) continue;
    models.push({ id: `${provider}/${model}`, provider });
  }
  return models;
}
