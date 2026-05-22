/**
 * HTTP surface for "local sources" — model providers Roomy auto-detects on
 * the user's host machine (Codex CLI auth today; LM Studio, Ollama, and
 * similar in the future).
 *
 * GET  /me/providers/local        — every registered local source's
 *                                    detection status + this user's opt-in.
 * PUT  /me/providers/local/:kind  — `{ enabled: boolean }` toggles opt-in.
 */
import { type Pool, queries } from "@roomy-ai/db";
import { NotFoundError, ValidationError } from "@roomy-ai/shared";
import {
  LOCAL_SOURCE_KINDS,
  detectLocalSource,
  type LocalSourceKind,
  type LocalSourceStatus,
} from "@roomy-ai/runtime";

export interface LocalSourceConnectionState extends LocalSourceStatus {
  /** User has opted in to using this source in their sandboxes. */
  enabled: boolean;
}

/** Persisted opt-in lives in `provider_meta[<kind>].enabled`. */
function isEnabledForUser(meta: Record<string, { enabled?: boolean } | undefined>, kind: LocalSourceKind): boolean {
  return meta[kind]?.enabled === true;
}

function isLocalSourceKind(value: string): value is LocalSourceKind {
  return (LOCAL_SOURCE_KINDS as readonly string[]).includes(value);
}

export async function listLocalSources(
  pool: Pool,
  userId: string,
): Promise<{ sources: LocalSourceConnectionState[] }> {
  const meta = await queries.userSettings.getProviderMeta(pool, userId);
  const sources: LocalSourceConnectionState[] = LOCAL_SOURCE_KINDS.map((kind) => {
    const status = detectLocalSource(kind);
    return {
      ...(status ?? { kind, available: false, reason: "missing" }),
      enabled: isEnabledForUser(meta, kind),
    };
  });
  return { sources };
}

export async function setLocalSourceEnabled(
  pool: Pool,
  userId: string,
  kind: string,
  data: { enabled: boolean },
): Promise<LocalSourceConnectionState> {
  if (!isLocalSourceKind(kind)) {
    throw new NotFoundError(`Unknown local source: ${kind}`);
  }
  if (!data || typeof data.enabled !== "boolean") {
    throw new ValidationError("Missing enabled boolean");
  }
  const current = await queries.userSettings.getProviderMeta(pool, userId);
  const existing = current[kind] ?? {};
  await queries.userSettings.mergeProviderMeta(pool, userId, {
    [kind]: { ...existing, enabled: data.enabled },
  });

  const status = detectLocalSource(kind) ?? { kind, available: false, reason: "missing" };
  return { ...status, enabled: data.enabled };
}

