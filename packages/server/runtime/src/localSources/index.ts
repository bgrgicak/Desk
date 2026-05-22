/**
 * Local source registry. Each entry is a model provider running on the
 * user's host (Codex CLI auth, future LM Studio / Ollama servers, …) that
 * Desk can detect and bridge into the sandbox via env vars.
 *
 * To register a new local source: add its `LocalSource` implementation
 * under `./<name>.ts`, then add it to `LOCAL_SOURCES` keyed by `kind`.
 * No call sites elsewhere in the codebase need to know about the new
 * kind — `listLocalSources()` and `loadLocalSourceEnv()` iterate the
 * registry.
 */
import { type Pool, queries } from "@agent-desk/db";
import { codexLocalSource } from "./codex.js";
import type { LocalSource, LocalSourceKind, LocalSourceStatus } from "./types.js";

export const LOCAL_SOURCES: Record<LocalSourceKind, LocalSource> = {
  codex: codexLocalSource,
};

/** Stable list of registered kinds, useful for iteration in API/UI code. */
export const LOCAL_SOURCE_KINDS: readonly LocalSourceKind[] = Object.keys(LOCAL_SOURCES) as LocalSourceKind[];

/**
 * Names of env vars that local sources inject into the sandbox.
 *
 * Per-run env builders prepend these as empty strings (alongside the
 * cloud `CONNECTION_ENV_VARS`) so a `docker exec -e KEY=` launching pi
 * overrides anything the container inherited at create time. Without
 * this, a local source the user disabled in Settings stays visible to
 * pi through the container's birth env — e.g. Codex's pi auth blob
 * keeps flowing into pi even after the user toggles Codex off, and pi
 * keeps using the stale OAuth path.
 *
 * Hand-maintained for the prototype: each entry must match the keys a
 * `LocalSource.loadEnv()` implementation can emit. When you add a new
 * local source, append its env vars here too.
 */
export const LOCAL_SOURCE_ENV_NAMES: readonly string[] = [
  // Pi reads this in piClient.ts to seed each per-invocation auth.json
  // from the host's OAuth credentials (e.g. ~/.codex/auth.json). Empty
  // means "no codex/oauth-based provider — pi falls back to env-vars
  // or its own auth.json if one exists".
  "PI_AUTH_JSON_BASE64",
];

/** Run every registered detector. Order is `LOCAL_SOURCE_KINDS`. */
export function listLocalSourceStatuses(): LocalSourceStatus[] {
  return LOCAL_SOURCE_KINDS.map((k) => LOCAL_SOURCES[k].detect());
}

/** Detect a single registered source by kind. */
export function detectLocalSource(kind: LocalSourceKind): LocalSourceStatus | null {
  return LOCAL_SOURCES[kind]?.detect() ?? null;
}

/**
 * Returns the env-var map for a single source, or null if it's currently
 * unusable. Caller must have already verified the user opted in.
 */
export function loadLocalSourceEnv(kind: LocalSourceKind): Record<string, string> | null {
  return LOCAL_SOURCES[kind]?.loadEnv() ?? null;
}

/**
 * Builds the merged env-var map of every local source the given user has
 * opted in to and that is currently usable on the host. Re-read on every
 * sandbox run so refreshed Codex tokens / a newly-launched LM Studio
 * server propagate without recreating the sandbox.
 *
 * Opt-in is persisted as `provider_meta[<kind>].enabled = true`.
 */
export async function resolveLocalSourceEnv(
  pool: Pool,
  userId: string,
): Promise<Record<string, string>> {
  const meta = await queries.userSettings.getProviderMeta(pool, userId);
  const out: Record<string, string> = {};
  for (const kind of LOCAL_SOURCE_KINDS) {
    if (meta[kind]?.enabled !== true) continue;
    const env = loadLocalSourceEnv(kind);
    if (!env) continue;
    Object.assign(out, env);
  }
  return out;
}

export type { LocalSource, LocalSourceKind, LocalSourceStatus } from "./types.js";
