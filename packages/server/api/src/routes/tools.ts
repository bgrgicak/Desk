import { type Pool } from "@roomy-ai/db";
import { NotFoundError, PROVIDER_KEY_VARS, ValidationError } from "@roomy-ai/shared";
import { queries } from "@roomy-ai/db";
import {
  listModels as runtimeListModels,
  resolveAvailableLocalSourceEnv,
  SandboxExecError,
  type ModelRef,
} from "@roomy-ai/runtime";
import { resolveProviderKeys } from "../providerKeys.js";
import type { VaultStore } from "../vault/store.js";

const PROVIDER_KEY_NAMES = new Set<string>(PROVIDER_KEY_VARS as readonly string[]);

/**
 * Lists AI models that are ready to use — every entry is a provider pi
 * has authenticated inside the sandbox (via host-forwarded API keys *or*
 * local sources like Codex). Models are server-wide config, not agent-
 * scoped, so the response is a bare array matching the convention of
 * `/workspaces`, `/agents`, etc. We still query through a warm sandbox
 * internally because pi is the source of truth for provider
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
  // injected for the sandbox to surface their models. For listing we use
  // "available" (host-detected) instead of "enabled" (user opted in) —
  // the picker should reveal Codex models as soon as the local sign-in
  // is detected, even before the user has committed to a Codex agent.
  // Opt-in is still required at run time (see `runs.ts`).
  // Best-effort: if the host file is unreadable, listings degrade to
  // provider-key-only.
  let localEnv: Record<string, string> = {};
  try {
    localEnv = resolveAvailableLocalSourceEnv();
  } catch {
    localEnv = {};
  }

  try {
    const listing = resolveModelListingSource(opts.provider, providerKeys, localEnv);
    const raw = await runtimeListModels(firstWorkspace.id, firstWorkspace.path, {
      provider: listing.provider,
      providerKeys: listing.providerKeys,
      env: listing.env,
    });
    return expandOpenAiBySource(raw)
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

/**
 * Lists models using a candidate set of provider keys supplied by the
 * caller, without writing anything to the vault. Powers the model-picker
 * "preview" UX: as soon as the user types a valid API key in the add-
 * model form, we surface the real model catalog for that provider so
 * they don't have to guess at IDs from a static placeholder. The key
 * itself only gets persisted when the user saves the model.
 */
export async function previewModels(
  pool: Pool,
  opts: { provider?: string; providerKeys: Record<string, string>; userId?: string },
): Promise<ModelRef[]> {
  if (opts.provider !== undefined && !/^[A-Za-z0-9_.-]+$/.test(opts.provider)) {
    throw new ValidationError("Invalid provider id");
  }

  const sanitized: Record<string, string> = {};
  for (const [name, value] of Object.entries(opts.providerKeys)) {
    if (!PROVIDER_KEY_NAMES.has(name)) continue;
    if (typeof value !== "string" || value.length === 0) continue;
    sanitized[name] = value;
  }

  const [firstWorkspace] = await queries.workspaces.list(pool);
  if (!firstWorkspace) throw new NotFoundError("No sandbox available to query models from");

  let localEnv: Record<string, string> = {};
  try {
    localEnv = resolveAvailableLocalSourceEnv();
  } catch {
    localEnv = {};
  }

  try {
    const listing = resolveModelListingSource(opts.provider, sanitized, localEnv);
    const raw = await runtimeListModels(firstWorkspace.id, firstWorkspace.path, {
      provider: listing.provider,
      providerKeys: listing.providerKeys,
      env: listing.env,
    });
    return expandOpenAiBySource(raw)
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
    return { provider: "openai-codex", providerKeys, env: localEnv };
  }

  if (provider === "openai") {
    return { provider, providerKeys, env: {} };
  }

  return { provider, providerKeys, env: localEnv };
}

/**
 * Pi exposes two distinct OpenAI provider channels in `--list-models`:
 * `openai/<name>` (authed via OPENAI_API_KEY) and `openai-codex/<name>`
 * (authed via the ChatGPT subscription OAuth blob). Pi emits whichever
 * channels it has credentials for. We relabel `openai-codex/<name>` to
 * the Roomy-only `codex/<name>` (provider="codex") so the picker can brand
 * it as "Codex"; the runtime translates the prefix back to `openai-codex`
 * at run time. `openai/<name>` passes through unchanged.
 */
export function expandOpenAiBySource(models: ModelRef[]): ModelRef[] {
  return models.map((model) => {
    if (model.provider !== "openai-codex" || !model.id.startsWith("openai-codex/")) {
      return model;
    }
    return {
      ...model,
      id: `codex/${model.id.slice("openai-codex/".length)}`,
      provider: "codex",
    };
  });
}
