import { type Pool } from "@agent-desk/db";
import { NotFoundError, ValidationError } from "@agent-desk/shared";
import { queries } from "@agent-desk/db";
import {
  listModels as runtimeListModels,
  resolveLocalSourceEnv,
  SandboxExecError,
  type ModelRef,
} from "@agent-desk/runtime";
import { resolveProviderKeys } from "../providerKeys.js";

/**
 * Lists AI models that are ready to use — every entry is a provider opencode
 * has authenticated inside the sandbox (via host-forwarded API keys *or*
 * local sources like Codex). Models are server-wide config, not agent-
 * scoped, so the response is a bare array matching the convention of
 * `/workspaces`, `/agents`, etc. We still query through a warm sandbox
 * internally because opencode is the source of truth for provider
 * availability.
 *
 * Foundation of host-initiated sandboxed tool calling per ARCHITECTURE.md §7.
 */
export async function listModels(
  pool: Pool,
  opts: { provider?: string; userId?: string },
): Promise<ModelRef[]> {
  if (opts.provider !== undefined && !/^[A-Za-z0-9_.-]+$/.test(opts.provider)) {
    throw new ValidationError("Invalid provider id");
  }

  // Pick any available workspace to reach a warm sandbox. Which one is an
  // implementation detail — all sandboxes see the same user-scoped keys.
  const [firstWorkspace] = await queries.workspaces.list(pool);
  if (!firstWorkspace) throw new NotFoundError("No sandbox available to query models from");

  let providerKeys: Record<string, string>;
  try {
    providerKeys = await resolveProviderKeys(pool, opts.userId);
  } catch {
    // Decryption failure (key rotation, corrupted data). Proceed with no keys
    // so the sandbox can still list provider-agnostic models.
    providerKeys = {};
  }

  // Local sources (Codex, future LM Studio / Ollama) need their env vars
  // injected for the sandbox to surface their models. Best-effort: if the
  // host file is unreadable, listings degrade to provider-key-only.
  let localEnv: Record<string, string> = {};
  if (opts.userId) {
    try {
      localEnv = await resolveLocalSourceEnv(pool, opts.userId);
    } catch {
      localEnv = {};
    }
  }

  try {
    const raw = await runtimeListModels(firstWorkspace.id, firstWorkspace.path, {
      provider: opts.provider,
      providerKeys,
      env: localEnv,
    });
    return relabelOpenAiBySource(raw, providerKeys, localEnv);
  } catch (err) {
    if (err instanceof SandboxExecError) {
      throw new ValidationError(
        `Sandbox rejected model listing (exit ${err.exitCode}): ${err.stderr.trim() || "no stderr"}`,
      );
    }
    throw err;
  }
}

/**
 * OpenAI models reach OpenCode via either an OPENAI_API_KEY (cloud) or a
 * Codex auth blob (local). The model `id` ("openai/<name>") is the same in
 * both paths; only the auth source differs. Re-tag the `provider` field so
 * the model picker can show "Codex" vs "ChatGPT" and the user knows which
 * source is paying for the call. The `id` is left untouched so OpenCode
 * still resolves the model through its native registry.
 */
export function relabelOpenAiBySource(
  models: ModelRef[],
  providerKeys: Record<string, string>,
  localEnv: Record<string, string>,
): ModelRef[] {
  const codexActive = typeof localEnv.OPENCODE_AUTH_CONTENT === "string" && localEnv.OPENCODE_AUTH_CONTENT.length > 0;
  const apiKeyActive = typeof providerKeys.OPENAI_API_KEY === "string" && providerKeys.OPENAI_API_KEY.length > 0;
  // Codex enabled but no cloud key → label as Codex. Cloud key takes
  // precedence when both are set: the user opted in explicitly to billing
  // through their own OpenAI account.
  if (!codexActive || apiKeyActive) return models;
  return models.map((m) => (m.provider === "openai" ? { ...m, provider: "codex" } : m));
}
