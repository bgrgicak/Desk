import { type Pool, queries } from "@agent-desk/db";
import { CONNECTION_ENV_VARS, SANDBOX_CONNECTION_ENV_VARS } from "@agent-desk/shared";
import type { VaultStore } from "./vault/store.js";
import { readCredentials } from "./connectors/credentialStore.js";
import { withModule } from "@agent-desk/shared/logger";
const log = withModule("api/providerKeys");

/**
 * Resolves the connector credentials that should populate the sandbox env
 * for a given user + workspace.
 *
 * One pass over the provider registry. For each provider:
 *   1. Pick a connection: workspace grant > user default > first active.
 *   2. Read its credential bag from the vault.
 *   3. Convert credentials → env vars for the sandbox (with refresh for OAuth).
 *
 * Disabled providers (per Settings → Connections toggle) are filtered out.
 * Vault-locked produces an empty result for that provider; we never throw
 * out of the sandbox boot path.
 */

type ConnectorConnection = Awaited<ReturnType<typeof queries.connectors.listConnections>>[number];
type WorkspaceConnectorGrant = Awaited<ReturnType<typeof queries.connectors.listWorkspaceGrants>>[number];
const WORKSPACE_SCOPED_PROVIDER_IDS = new Set<string>(SANDBOX_CONNECTION_ENV_VARS);

interface ResolutionContext {
  pool: Pool;
  vault: VaultStore | undefined;
  userId: string;
  workspaceId?: string;
  workspaceGrants: WorkspaceConnectorGrant[];
  providerMeta: Awaited<ReturnType<typeof queries.userSettings.getProviderMeta>>;
}

interface ProviderHandler {
  /** providerId stored in connector_connections.provider_id */
  readonly providerId: string;
  /** Env vars this provider influences (used for the disabled toggle). */
  readonly envVars: readonly string[];
  /** Resolve the connection's credential bag → env vars, or {} on failure. */
  resolve(
    ctx: ResolutionContext,
    connection: ConnectorConnection,
  ): Promise<Record<string, string>>;
}

export async function resolveProviderKeys(
  pool: Pool,
  vault: VaultStore | undefined,
  userId?: string,
  workspaceId?: string,
): Promise<Record<string, string>> {
  let resolvedUserId = userId;
  if (!resolvedUserId) {
    const { rows } = await pool.query<{ id: string }>("SELECT id FROM users ORDER BY created_at LIMIT 1");
    if (rows.length === 0) return {};
    resolvedUserId = rows[0].id;
  }

  const ctx: ResolutionContext = {
    pool,
    vault,
    userId: resolvedUserId,
    workspaceId,
    providerMeta: await queries.userSettings.getProviderMeta(pool, resolvedUserId),
    workspaceGrants: workspaceId ? await queries.connectors.listWorkspaceGrants(pool, workspaceId) : [],
  };

  // Warn once per resolve call when the vault is locked — every handler
  // is about to return empty, and one log line per call is enough signal
  // to debug "I added a key but the sandbox can't see it" without
  // multiplying noise by the number of registered providers.
  if (vault && vault.isLocked(resolvedUserId)) {
    log.warn(
      `resolveProviderKeys: vault is locked for user ${resolvedUserId} — ` +
        `no connector credentials will be forwarded to the sandbox until /vault/unlock`,
    );
  }

  const out: Record<string, string> = {};
  for (const handler of providerHandlers()) {
    if (isDisabled(ctx, handler)) continue;
    const connection = await pickConnection(ctx, handler.providerId);
    if (!connection) continue;
    try {
      Object.assign(out, await handler.resolve(ctx, connection));
    } catch (err) {
      log.warn({ providerId: handler.providerId, err: err instanceof Error ? err.message : String(err) }, "provider resolution failed");
    }
  }
  return out;
}

// ── Provider registry ──────────────────────────────────────────────────

/**
 * Built once per resolve call. Today the registry is fully derived from
 * `CONNECTION_ENV_VARS` — adding a new LLM key (extend `PROVIDER_KEY_VARS`
 * in `@agent-desk/shared`) or a new tool token (extend
 * `SANDBOX_CONNECTION_ENV_VARS`) automatically makes it resolvable here
 * with zero changes to this file. The matching DB row is written by
 * `PUT /me/providers` with `providerId = <env-var-name>` and credentials
 * `{ value: '<secret>' }`.
 *
 * Forward-compat note for the in-progress multi-account UI:
 * `POST /me/connections` allows arbitrary providerIds (typically the
 * kind, e.g. "github"). When that UI ships, register a kind-based
 * handler here that reads the same vault entry shape and emits the
 * provider's env var(s). The split mirrors what `connectionRefresh.ts`
 * already supports — both update paths trigger the same hot-refresh.
 */
function providerHandlers(): ProviderHandler[] {
  return envVarHandlers();
}

/**
 * Reads `credentials.value` first (legacy single-key shape written by
 * `PUT /me/providers`), falls back to `credentials.token` (multi-account
 * shape written by `POST /me/connections`). Returns null when the
 * credential bag is missing, the vault is locked, or neither field is a
 * non-empty string — and logs the reason so a missing key never fails
 * silently.
 */
function readSecretValue(
  ctx: ResolutionContext,
  providerId: string,
  connectionId: string,
  envVarForLog: string,
): string | null {
  const credentials = ctx.vault ? readCredentials(ctx.vault, ctx.userId, providerId, connectionId) : null;
  if (!credentials) {
    // Vault-locked is already logged once at the top of
    // resolveProviderKeys; skip the per-provider duplicate. A missing
    // vault entry while the vault is unlocked is a real anomaly (active
    // row in DB but no credential in vault) and worth surfacing per
    // provider so the operator can identify which connection is broken.
    if (!ctx.vault?.isLocked(ctx.userId)) {
      log.warn(
        `provider ${envVarForLog}: connection ${connectionId} (providerId=${providerId}) has no readable vault entry — sandbox will not see this key`,
      );
    }
    return null;
  }
  const value = stringField(credentials.value) ?? stringField(credentials.token);
  if (!value) {
    log.warn(
      `provider ${envVarForLog}: connection ${connectionId} (providerId=${providerId}) vault entry missing value/token field`,
    );
    return null;
  }
  return value;
}

function envVarHandlers(): ProviderHandler[] {
  return CONNECTION_ENV_VARS.map((envVar): ProviderHandler => ({
    providerId: envVar,
    envVars: [envVar],
    async resolve(ctx, connection) {
      const value = readSecretValue(ctx, envVar, connection.id, envVar);
      return value ? { [envVar]: value } : {};
    },
  }));
}

// ── Connection picking ────────────────────────────────────────────────

async function pickConnection(
  ctx: ResolutionContext,
  providerId: string,
): Promise<ConnectorConnection | undefined> {
  const all = await queries.connectors.listConnections(ctx.pool, ctx.userId, providerId);
  const active = all.filter((c) => c.status === "active");
  if (active.length === 0) return undefined;

  // Workspace grant is an explicit allow-list; if the granted connection is
  // missing/inactive we fail closed for this provider (return undefined) so
  // a stale grant cannot leak the user's default into a workspace.
  const grant = ctx.workspaceGrants.find((g) => g.providerId === providerId);
  if (grant) {
    const granted = active.find((c) => c.id === grant.connectionId);
    return granted;
  }

  if (ctx.workspaceId && WORKSPACE_SCOPED_PROVIDER_IDS.has(providerId)) return undefined;

  return active.find((c) => c.isDefault) ?? active[0];
}

function isDisabled(ctx: ResolutionContext, handler: ProviderHandler): boolean {
  if (WORKSPACE_SCOPED_PROVIDER_IDS.has(handler.providerId)) return false;
  // The Settings UI surfaces a per-env-var enabled/disabled toggle. A
  // provider is disabled if any of its env vars is explicitly disabled
  // — typically there is exactly one.
  return handler.envVars.some((env) => ctx.providerMeta[env]?.enabled === false);
}

function stringField(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}
