import { type Pool } from "@agent-desk/db";
import { NotFoundError, PROVIDER_KEY_VARS, ValidationError } from "@agent-desk/shared";
import { queries } from "@agent-desk/db";
import {
  listModels as runtimeListModels,
  resolveLocalSourceEnv,
  SandboxExecError,
  type ModelRef,
} from "@agent-desk/runtime";
import { resolveProviderKeys } from "../providerKeys.js";
import type { VaultStore } from "../vault/store.js";

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
  vault: VaultStore | undefined,
  opts: { provider?: string; userId?: string },
): Promise<ModelRef[]> {
  if (opts.provider !== undefined && !/^[A-Za-z0-9_.-]+$/.test(opts.provider)) {
    throw new ValidationError("Invalid provider id");
  }

  // Pick any available workspace to reach a warm sandbox. Which one is an
  // implementation detail for execution only; model listing is still
  // user-global until the endpoint accepts an explicit workspace context, so
  // do not pass this workspace into provider-key resolution. Workspace grants
  // are allow-lists for runs, and using an arbitrary workspace here would make
  // the model picker depend on whichever workspace happened to sort first.
  const [firstWorkspace] = await queries.workspaces.list(pool);
  if (!firstWorkspace) throw new NotFoundError("No sandbox available to query models from");

  let providerKeys: Record<string, string>;
  try {
    const resolved = await resolveProviderKeys(pool, vault, opts.userId);
    providerKeys = Object.fromEntries(
      PROVIDER_KEY_VARS
        .map((name) => [name, resolved[name]] as const)
        .filter(([, value]) => typeof value === "string" && value.length > 0),
    );
  } catch {
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
    const listing = resolveModelListingSource(opts.provider, providerKeys, localEnv);
    const raw = await runtimeListModels(firstWorkspace.id, firstWorkspace.path, {
      provider: listing.provider,
      providerKeys: listing.providerKeys,
      env: listing.env,
    });
    return expandOpenAiBySource(raw, listing.providerKeys, listing.env)
      .filter((model) => opts.provider === undefined || model.provider === opts.provider);
  } catch (err) {
    if (err instanceof SandboxExecError) {
      throw new ValidationError(
        `Sandbox rejected model listing (exit ${err.exitCode}): ${err.stderr.trim() || "no stderr"}`,
      );
    }
    throw err;
  }
}

function resolveModelListingSource(
  provider: string | undefined,
  providerKeys: Record<string, string>,
  localEnv: Record<string, string>,
): { provider?: string; providerKeys: Record<string, string>; env: Record<string, string> } {
  if (provider === "codex") {
    const { OPENAI_API_KEY: _openAiApiKey, ...withoutOpenAiApiKey } = providerKeys;
    return { provider: "openai", providerKeys: withoutOpenAiApiKey, env: localEnv };
  }

  if (provider === "openai") {
    return { provider, providerKeys, env: {} };
  }

  return { provider, providerKeys, env: localEnv };
}

/**
 * OpenAI models reach OpenCode via either an OPENAI_API_KEY (cloud) or a
 * Codex auth blob (local). The model `id` ("openai/<name>") is the same in
 * both paths; only the auth source differs. Re-tag the `provider` field so
 * the model picker can show "Codex" vs "ChatGPT" and the user knows which
 * source is paying for the call. Codex entries get a Desk-only `codex/*` id;
 * the scheduler translates that back to OpenCode's `openai/*` id only after
 * removing OPENAI_API_KEY from the run environment.
 */
export function expandOpenAiBySource(
  models: ModelRef[],
  providerKeys: Record<string, string>,
  localEnv: Record<string, string>,
): ModelRef[] {
  const codexActive = typeof localEnv.OPENCODE_AUTH_CONTENT === "string" && localEnv.OPENCODE_AUTH_CONTENT.length > 0;
  const apiKeyActive = typeof providerKeys.OPENAI_API_KEY === "string" && providerKeys.OPENAI_API_KEY.length > 0;
  if (!codexActive) return models;

  const out: ModelRef[] = [];
  for (const model of models) {
    if (model.provider !== "openai" || !model.id.startsWith("openai/")) {
      out.push(model);
      continue;
    }

    // If both OpenAI sources are available, expose both. The API-key-backed
    // entry keeps the canonical OpenCode id (`openai/...`); the subscription-
    // backed entry gets a Desk-only id (`codex/...`) that runtime translates
    // back to `openai/...` after stripping OPENAI_API_KEY from the run env.
    if (apiKeyActive) out.push(model);
    const suffix = model.id.slice("openai/".length);
    out.push({
      ...model,
      id: `codex/${suffix}`,
      provider: "codex",
    });
  }
  return out;
}
