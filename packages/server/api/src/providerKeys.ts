import { type Pool, queries } from "@agent-desk/db";
import { CONNECTION_ENV_VARS } from "@agent-desk/shared";
import type { VaultStore } from "./vault/store.js";
import { readCredentials } from "./connectors/credentialStore.js";

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

  const out: Record<string, string> = {};
  for (const handler of providerHandlers()) {
    if (isDisabled(ctx, handler)) continue;
    const connection = await pickConnection(ctx, handler.providerId);
    if (!connection) continue;
    try {
      Object.assign(out, await handler.resolve(ctx, connection));
    } catch (err) {
      console.warn(`provider ${handler.providerId} resolution failed:`, err instanceof Error ? err.message : err);
    }
  }
  return out;
}

// ── Provider registry ──────────────────────────────────────────────────

function providerHandlers(): ProviderHandler[] {
  return [
    githubHandler,
    ...legacyApiKeyHandlers(),
  ];
}

const githubHandler: ProviderHandler = {
  providerId: "github",
  envVars: ["GITHUB_TOKEN", "GH_TOKEN"],
  async resolve(ctx, connection) {
    const credentials = ctx.vault ? readCredentials(ctx.vault, ctx.userId, "github", connection.id) : null;
    const token = stringField(credentials?.token) ?? stringField(credentials?.value);
    const out: Record<string, string> = {};
    if (!token) return out;
    out.GITHUB_TOKEN = token;
    out.GH_TOKEN = token;
    return out;
  },
};

/**
 * Legacy API-key providers — providerId is the env var name itself
 * (e.g. ANTHROPIC_API_KEY, OPENAI_API_KEY). Credential bag shape:
 * `{ value: '<api-key>' }`. New providers should be modeled like
 * githubHandler above (named providerId, explicit env-var list).
 */
function legacyApiKeyHandlers(): ProviderHandler[] {
  const skip = new Set<string>(["GITHUB_TOKEN"]);
  return CONNECTION_ENV_VARS.filter((envVar) => !skip.has(envVar)).map((envVar): ProviderHandler => ({
    providerId: envVar,
    envVars: [envVar],
    async resolve(ctx, connection) {
      const credentials = ctx.vault ? readCredentials(ctx.vault, ctx.userId, envVar, connection.id) : null;
      const value = stringField(credentials?.value) ?? stringField(credentials?.token);
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

  return active.find((c) => c.isDefault) ?? active[0];
}

function isDisabled(ctx: ResolutionContext, handler: ProviderHandler): boolean {
  // The Settings UI surfaces a per-env-var enabled/disabled toggle. A
  // provider is disabled if any of its env vars is explicitly disabled
  // — typically there is exactly one.
  return handler.envVars.some((env) => ctx.providerMeta[env]?.enabled === false);
}

function stringField(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}
