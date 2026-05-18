import { type Pool } from "@agent-desk/db";
import { queries } from "@agent-desk/db";
import {
  CONNECTION_ENV_VARS,
  NotFoundError,
  ValidationError,
} from "@agent-desk/shared";
import type { VaultStore } from "../vault/store.js";
import { deleteCredentials, readCredentials, writeCredentials } from "../connectors/credentialStore.js";

type ProviderMetaEntry = {
  name?: string;
  enabled?: boolean;
};
type ProviderMetaMap  = Record<string, ProviderMetaEntry>;
type ConnectorStatus = "active" | "disabled" | "error" | "revoked";

type ConnectionInput = {
  providerId?: unknown;
  displayName?: unknown;
  externalAccountId?: unknown;
  scopes?: unknown;
  capabilities?: unknown;
  metadata?: unknown;
  credentials?: unknown;
  status?: unknown;
  isDefault?: unknown;
};

type GrantInput = {
  connectionId?: unknown;
  providerId?: unknown;
  grantedCapabilities?: unknown;
  isDefault?: unknown;
};

const CONNECTION_STATUSES = new Set(["active", "disabled", "error", "revoked"]);

function asStringArray(value: unknown, field: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) {
    throw new ValidationError(`${field} must be an array of strings`);
  }
  return value;
}

function asRecord(value: unknown, field: string): Record<string, unknown> | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ValidationError(`${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function asOptionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new ValidationError(`${field} must be a string`);
  return value;
}

function asOptionalBoolean(value: unknown, field: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw new ValidationError(`${field} must be a boolean`);
  return value;
}

function asInputRecord<T extends Record<string, unknown>>(value: unknown, field: string): T {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ValidationError(`${field} must be an object`);
  }
  return value as T;
}

export async function getMe(pool: Pool, userId: string) {
  const user = await queries.users.findById(pool, userId);
  if (!user) throw new NotFoundError("User not found");
  return user;
}

export async function patchMe(
  pool: Pool,
  userId: string,
  data: { username?: string; email?: string; avatarPath?: string },
) {
  const user = await queries.users.updateProfile(pool, userId, data);
  if (!user) throw new NotFoundError("User not found");
  return user;
}

export async function changePassword(
  pool: Pool,
  userId: string,
  data: { currentPassword: string; newPassword: string },
) {
  await queries.users.setPassword(pool, userId, data.currentPassword, data.newPassword);
  return { ok: true };
}

export async function deleteMe(
  _pool: Pool,
  _userId: string,
): Promise<{ ok: true; message: string }> {
  return { ok: true, message: "Account marked for deletion" };
}

function maskKey(value: string): string {
  if (value.length <= 10) return "****";
  return `${value.slice(0, 6)}...${value.slice(-4)}`;
}

/**
 * Returns the masked default value for each known provider env var. The
 * default value comes from the user's default connection for that
 * providerId; null when the user has no connection or the vault is locked.
 */
export async function getProviders(
  pool: Pool,
  vault: VaultStore,
  userId: string,
): Promise<{ providers: Record<string, string | null> }> {
  const providers: Record<string, string | null> = {};
  for (const name of CONNECTION_ENV_VARS) providers[name] = null;

  for (const name of CONNECTION_ENV_VARS) {
    const connections = await queries.connectors.listConnections(pool, userId, name);
    const connection = connections.find((c) => c.isDefault) ?? connections[0];
    if (!connection) continue;
    const credentials = readCredentials(vault, userId, name, connection.id);
    const value = legacyApiKeyValue(credentials);
    if (value !== null) providers[name] = maskKey(value);
  }
  return { providers };
}

function legacyApiKeyValue(credentials: Record<string, unknown> | null): string | null {
  if (!credentials) return null;
  const value = credentials.value ?? credentials.token ?? credentials.apiKey;
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * Single-key shortcut for legacy provider keys (Anthropic, OpenAI, etc.).
 * Each name maps to a single connector_connections row with the env var
 * name as providerId and `{ value: '<key>' }` in the vault.
 */
export async function setProviders(
  pool: Pool,
  vault: VaultStore,
  userId: string,
  data: { providers: Record<string, string | null> },
): Promise<{ providers: Record<string, string | null> }> {
  if (!data || typeof data.providers !== "object" || data.providers === null) {
    throw new ValidationError("Missing providers object");
  }
  const allowed = new Set<string>(CONNECTION_ENV_VARS);
  for (const name of Object.keys(data.providers)) {
    if (!allowed.has(name)) throw new ValidationError(`Unknown provider key: ${name}`);
    const value = data.providers[name];
    if (value !== null && typeof value !== "string") {
      throw new ValidationError(`Provider key ${name} must be string or null`);
    }
  }

  for (const [name, value] of Object.entries(data.providers)) {
    const existing = await queries.connectors.listConnections(pool, userId, name);
    const legacy = existing.find((c) => c.isDefault) ?? existing[0];

    if (value === null || value === "") {
      if (legacy) {
        await queries.connectors.deleteConnection(pool, legacy.id, userId);
        await deleteCredentials(vault, userId, name, legacy.id);
      }
      await queries.userSettings.mergeProviderMeta(pool, userId, { [name]: null });
      continue;
    }

    if (legacy) {
      // Vault first; if locked, the row stays as-is and we surface the
      // error rather than mutating only one of the two stores.
      await writeCredentials(vault, userId, legacy, { value });
      await queries.connectors.updateConnection(pool, legacy.id, userId, {
        displayName: legacy.displayName || name,
        status: "active",
        isDefault: true,
      });
    } else {
      // Create the row, then write credentials. Vault failure rolls back
      // the row so we never leave a credentials-less "active" connection.
      const created = await queries.connectors.createConnection(pool, {
        ownerUserId: userId,
        providerId: name,
        displayName: name,
        metadata: { legacyProviderKey: true },
        status: "active",
        isDefault: true,
      });
      try {
        await writeCredentials(vault, userId, created, { value });
      } catch (err) {
        await queries.connectors.deleteConnection(pool, created.id, userId);
        throw err;
      }
    }

    // Clear any stale `enabled: false` flag left over from a prior toggle-
    // off in Settings. Without this, a user who had disabled the provider
    // and then re-entered a key would have the key saved as an "active"
    // connection but `resolveProviderKeys.isDisabled()` would still filter
    // it out — opencode never sees the credential and reports the provider
    // as unconfigured. Entering a fresh value into Settings implies the
    // user wants the key live; explicit disable still goes through the
    // separate `setProvidersMeta` toggle.
    await queries.userSettings.mergeProviderMeta(pool, userId, {
      [name]: { enabled: undefined },
    });
  }

  const written = Object.entries(data.providers).filter(([, v]) => v !== null && v !== "").map(([k]) => k);
  const deleted = Object.entries(data.providers).filter(([, v]) => v === null || v === "").map(([k]) => k);
  if (written.length > 0) {
    await queries.providerKeyAccessLog.logKeyAccess(pool, userId, "write", written, "user_update");
  }
  if (deleted.length > 0) {
    await queries.providerKeyAccessLog.logKeyAccess(pool, userId, "delete", deleted, "user_update");
  }
  return getProviders(pool, vault, userId);
}

export async function getProvidersMeta(
  pool: Pool,
  userId: string,
): Promise<{ meta: ProviderMetaMap }> {
  const meta = await queries.userSettings.getProviderMeta(pool, userId);
  return { meta };
}

export async function setProvidersMeta(
  pool: Pool,
  userId: string,
  data: { meta: Record<string, ProviderMetaEntry | null> },
): Promise<{ meta: ProviderMetaMap }> {
  if (!data || typeof data.meta !== "object" || data.meta === null) {
    throw new ValidationError("Missing meta object");
  }
  const sanitized: Record<string, ProviderMetaEntry | null> = {};
  for (const [key, entry] of Object.entries(data.meta)) {
    if (entry === null) {
      sanitized[key] = { name: undefined };
      continue;
    }
    const next: ProviderMetaEntry = {};
    if (Object.prototype.hasOwnProperty.call(entry, "name")) {
      if (entry.name !== undefined && typeof entry.name !== "string") {
        throw new ValidationError(`Provider meta ${key}.name must be a string`);
      }
      next.name = entry.name;
    }
    if (Object.prototype.hasOwnProperty.call(entry, "enabled")) {
      if (entry.enabled !== undefined && typeof entry.enabled !== "boolean") {
        throw new ValidationError(`Provider meta ${key}.enabled must be a boolean`);
      }
      next.enabled = entry.enabled;
    }
    sanitized[key] = next;
  }
  const meta = await queries.userSettings.mergeProviderMeta(pool, userId, sanitized);
  return { meta };
}

export interface ConnectionView {
  id: string;
  providerId: string;
  displayName: string;
  externalAccountId?: string;
  scopes: string[];
  capabilities: string[];
  metadata: Record<string, unknown>;
  status: ConnectorStatus;
  isDefault: boolean;
  hasCredentials: boolean;
  createdAt: string;
  updatedAt: string;
}

function viewConnection(connection: Awaited<ReturnType<typeof queries.connectors.findConnection>>, vault: VaultStore, userId: string): ConnectionView | null {
  if (!connection) return null;
  const credentials = readCredentials(vault, userId, connection.providerId, connection.id);
  return {
    id: connection.id,
    providerId: connection.providerId,
    displayName: connection.displayName,
    externalAccountId: connection.externalAccountId,
    scopes: connection.scopes,
    capabilities: connection.capabilities,
    metadata: connection.metadata,
    status: connection.status,
    isDefault: connection.isDefault,
    hasCredentials: credentials !== null,
    createdAt: connection.createdAt,
    updatedAt: connection.updatedAt,
  };
}

export async function listConnections(pool: Pool, vault: VaultStore, userId: string, providerId?: string) {
  const rows = await queries.connectors.listConnections(pool, userId, providerId);
  return { connections: rows.map((r) => viewConnection(r, vault, userId)).filter((c): c is ConnectionView => c !== null) };
}

export async function createConnection(pool: Pool, vault: VaultStore, userId: string, data: ConnectionInput) {
  data = asInputRecord<ConnectionInput>(data, "connection");
  const providerId = asOptionalString(data.providerId, "providerId");
  const displayName = asOptionalString(data.displayName, "displayName");
  if (!providerId) throw new ValidationError("providerId is required");
  if (!displayName) throw new ValidationError("displayName is required");
  const status = asOptionalString(data.status, "status");
  if (status && !CONNECTION_STATUSES.has(status)) throw new ValidationError(`Invalid status: ${status}`);
  const credentials = asRecord(data.credentials, "credentials");

  // Pre-flight: writing credentials requires an unlocked vault. Check
  // before creating the row so a locked vault does not produce an
  // orphaned active row with no credentials.
  if (credentials && vault.isLocked(userId)) {
    throw new ValidationError("Secrets vault must be unlocked to store connector credentials");
  }

  const connection = await queries.connectors.createConnection(pool, {
    ownerUserId: userId,
    providerId,
    displayName,
    externalAccountId: asOptionalString(data.externalAccountId, "externalAccountId"),
    scopes: asStringArray(data.scopes, "scopes"),
    capabilities: asStringArray(data.capabilities, "capabilities"),
    metadata: asRecord(data.metadata, "metadata"),
    status: status as ConnectorStatus | undefined,
    isDefault: asOptionalBoolean(data.isDefault, "isDefault"),
  });
  if (credentials) {
    try {
      await writeCredentials(vault, userId, connection, credentials);
    } catch (err) {
      await queries.connectors.deleteConnection(pool, connection.id, userId);
      throw err;
    }
  }
  const view = viewConnection(connection, vault, userId);
  return { connection: view };
}

export async function updateConnection(pool: Pool, vault: VaultStore, userId: string, id: string, data: ConnectionInput) {
  data = asInputRecord<ConnectionInput>(data, "connection");
  const status = asOptionalString(data.status, "status");
  if (status && !CONNECTION_STATUSES.has(status)) throw new ValidationError(`Invalid status: ${status}`);

  const credentialsField = data.credentials;
  const updateCredentials = credentialsField !== undefined;
  const newCredentials = credentialsField === null ? null : (asRecord(credentialsField, "credentials") ?? null);
  if (updateCredentials && newCredentials !== null && vault.isLocked(userId)) {
    throw new ValidationError("Secrets vault must be unlocked to store connector credentials");
  }

  const connection = await queries.connectors.updateConnection(pool, id, userId, {
    displayName: asOptionalString(data.displayName, "displayName"),
    externalAccountId: asOptionalString(data.externalAccountId, "externalAccountId"),
    scopes: asStringArray(data.scopes, "scopes"),
    capabilities: asStringArray(data.capabilities, "capabilities"),
    metadata: asRecord(data.metadata, "metadata"),
    status: status as ConnectorStatus | undefined,
    isDefault: asOptionalBoolean(data.isDefault, "isDefault"),
  });
  if (!connection) throw new NotFoundError("Connector connection not found");

  if (updateCredentials) {
    if (newCredentials === null) {
      await deleteCredentials(vault, userId, connection.providerId, connection.id);
    } else {
      await writeCredentials(vault, userId, connection, newCredentials);
    }
  }
  return { connection: viewConnection(connection, vault, userId) };
}

export async function deleteConnection(pool: Pool, vault: VaultStore, userId: string, id: string) {
  const connection = await queries.connectors.findConnection(pool, id, userId);
  const deleted = await queries.connectors.deleteConnection(pool, id, userId);
  if (!deleted) throw new NotFoundError("Connector connection not found");
  if (connection) await deleteCredentials(vault, userId, connection.providerId, connection.id);
  return { ok: true };
}

export async function listWorkspaceGrants(pool: Pool, workspaceId: string) {
  return { grants: await queries.connectors.listWorkspaceGrants(pool, workspaceId) };
}

export async function replaceWorkspaceGrants(pool: Pool, userId: string, workspaceId: string, data: { grants?: GrantInput[] }) {
  data = asInputRecord<{ grants?: GrantInput[] }>(data, "workspace connector grants");
  if (!data || !Array.isArray(data.grants)) throw new ValidationError("grants must be an array");
  const normalized: Array<{ connectionId: string; providerId: string; grantedCapabilities?: string[]; isDefault?: boolean }> = [];
  for (const rawGrant of data.grants) {
    const grant = asInputRecord<GrantInput>(rawGrant, "grant");
    const connectionId = asOptionalString(grant.connectionId, "connectionId");
    const providerId = asOptionalString(grant.providerId, "providerId");
    if (!connectionId) throw new ValidationError("connectionId is required");
    if (!providerId) throw new ValidationError("providerId is required");
    const connection = await queries.connectors.findConnection(pool, connectionId, userId);
    if (!connection) throw new NotFoundError("Connector connection not found");
    if (connection.providerId !== providerId) throw new ValidationError("Grant providerId must match the connection providerId");
    normalized.push({
      connectionId,
      providerId,
      grantedCapabilities: asStringArray(grant.grantedCapabilities, "grantedCapabilities"),
      isDefault: asOptionalBoolean(grant.isDefault, "isDefault"),
    });
  }
  return { grants: await queries.connectors.replaceWorkspaceGrants(pool, workspaceId, userId, normalized) };
}
