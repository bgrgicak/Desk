import { generateId } from "@agent-desk/shared";
import { type Pool, transact } from "../pool.js";

export type ConnectorStatus = "active" | "disabled" | "error" | "revoked";

export interface ConnectorConnection {
  id: string;
  providerId: string;
  ownerUserId: string;
  externalAccountId?: string;
  displayName: string;
  scopes: string[];
  capabilities: string[];
  metadata: Record<string, unknown>;
  status: ConnectorStatus;
  isDefault: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface WorkspaceConnectorGrant {
  id: string;
  workspaceId: string;
  connectionId: string;
  providerId: string;
  grantedCapabilities: string[];
  grantedByUserId: string;
  isDefault: boolean;
  createdAt: string;
  updatedAt: string;
}

type ConnectionRow = {
  id: string;
  provider_id: string;
  owner_user_id: string;
  external_account_id: string | null;
  display_name: string;
  scopes_json: string;
  capabilities_json: string;
  metadata_json: string | null;
  status: ConnectorStatus;
  is_default: number;
  created_at: string;
  updated_at: string;
};

type GrantRow = {
  id: string;
  workspace_id: string;
  connection_id: string;
  provider_id: string;
  granted_capabilities_json: string;
  granted_by_user_id: string;
  is_default: number;
  created_at: string;
  updated_at: string;
};

function parseArray(value: string): string[] {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((v) => typeof v === "string") : [];
  } catch {
    return [];
  }
}

function parseObject(value: string | null): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return parsed as Record<string, unknown>;
  } catch {
    return {};
  }
}

function mapConnection(row: ConnectionRow): ConnectorConnection {
  return {
    id: row.id,
    providerId: row.provider_id,
    ownerUserId: row.owner_user_id,
    externalAccountId: row.external_account_id ?? undefined,
    displayName: row.display_name,
    scopes: parseArray(row.scopes_json),
    capabilities: parseArray(row.capabilities_json),
    metadata: parseObject(row.metadata_json),
    status: row.status,
    isDefault: row.is_default === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapGrant(row: GrantRow): WorkspaceConnectorGrant {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    connectionId: row.connection_id,
    providerId: row.provider_id,
    grantedCapabilities: parseArray(row.granted_capabilities_json),
    grantedByUserId: row.granted_by_user_id,
    isDefault: row.is_default === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function listConnections(db: Pool, ownerUserId: string, providerId?: string): Promise<ConnectorConnection[]> {
  const params: unknown[] = [ownerUserId];
  let where = "owner_user_id = ?";
  if (providerId) {
    where += " AND provider_id = ?";
    params.push(providerId);
  }
  const { rows } = await db.query<ConnectionRow>(
    `SELECT * FROM connector_connections WHERE ${where} ORDER BY provider_id, is_default DESC, created_at`,
    params,
  );
  return rows.map(mapConnection);
}

export async function findConnection(db: Pool, id: string, ownerUserId?: string): Promise<ConnectorConnection | null> {
  const params: unknown[] = [id];
  let where = "id = ?";
  if (ownerUserId) {
    where += " AND owner_user_id = ?";
    params.push(ownerUserId);
  }
  const { rows } = await db.query<ConnectionRow>(`SELECT * FROM connector_connections WHERE ${where}`, params);
  return rows[0] ? mapConnection(rows[0]) : null;
}

export async function createConnection(
  db: Pool,
  data: {
    ownerUserId: string;
    providerId: string;
    displayName: string;
    externalAccountId?: string;
    scopes?: string[];
    capabilities?: string[];
    metadata?: Record<string, unknown>;
    status?: ConnectorStatus;
    isDefault?: boolean;
  },
): Promise<ConnectorConnection> {
  const id = generateId("connectorConnection");
  transact(db, (tx) => {
    if (data.isDefault) {
      tx.querySync("UPDATE connector_connections SET is_default = 0 WHERE owner_user_id = ? AND provider_id = ?", [data.ownerUserId, data.providerId]);
    }
    tx.querySync(
      `INSERT INTO connector_connections
        (id, provider_id, owner_user_id, external_account_id, display_name, scopes_json, capabilities_json, metadata_json, status, is_default)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        data.providerId,
        data.ownerUserId,
        data.externalAccountId ?? null,
        data.displayName,
        JSON.stringify(data.scopes ?? []),
        JSON.stringify(data.capabilities ?? []),
        data.metadata ? JSON.stringify(data.metadata) : null,
        data.status ?? "active",
        data.isDefault ? 1 : 0,
      ],
    );
  });
  const created = await findConnection(db, id, data.ownerUserId);
  if (!created) throw new Error("Failed to create connector connection");
  return created;
}

export async function updateConnection(
  db: Pool,
  id: string,
  ownerUserId: string,
  patch: Partial<Pick<ConnectorConnection, "displayName" | "externalAccountId" | "scopes" | "capabilities" | "metadata" | "status" | "isDefault">>,
): Promise<ConnectorConnection | null> {
  const current = await findConnection(db, id, ownerUserId);
  if (!current) return null;
  if (patch.isDefault) {
    await db.query("UPDATE connector_connections SET is_default = 0 WHERE owner_user_id = ? AND provider_id = ?", [ownerUserId, current.providerId]);
  }
  await db.query(
    `UPDATE connector_connections SET
       display_name = ?, external_account_id = ?, scopes_json = ?, capabilities_json = ?, metadata_json = ?, status = ?, is_default = ?,
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
     WHERE id = ? AND owner_user_id = ?`,
    [
      patch.displayName ?? current.displayName,
      patch.externalAccountId ?? current.externalAccountId ?? null,
      JSON.stringify(patch.scopes ?? current.scopes),
      JSON.stringify(patch.capabilities ?? current.capabilities),
      patch.metadata ? JSON.stringify(patch.metadata) : (Object.keys(current.metadata).length > 0 ? JSON.stringify(current.metadata) : null),
      patch.status ?? current.status,
      patch.isDefault ?? current.isDefault ? 1 : 0,
      id,
      ownerUserId,
    ],
  );
  return findConnection(db, id, ownerUserId);
}

export async function deleteConnection(db: Pool, id: string, ownerUserId: string): Promise<boolean> {
  const result = await db.query("DELETE FROM connector_connections WHERE id = ? AND owner_user_id = ?", [id, ownerUserId]);
  return result.rowCount > 0;
}

export async function listWorkspaceGrants(db: Pool, workspaceId: string): Promise<WorkspaceConnectorGrant[]> {
  const { rows } = await db.query<GrantRow>(
    "SELECT * FROM workspace_connector_grants WHERE workspace_id = ? ORDER BY provider_id, is_default DESC, created_at",
    [workspaceId],
  );
  return rows.map(mapGrant);
}

export async function replaceWorkspaceGrants(
  db: Pool,
  workspaceId: string,
  grantedByUserId: string,
  grants: Array<{ connectionId: string; providerId: string; grantedCapabilities?: string[]; isDefault?: boolean }>,
): Promise<WorkspaceConnectorGrant[]> {
  transact(db, (tx) => {
    tx.querySync("DELETE FROM workspace_connector_grants WHERE workspace_id = ?", [workspaceId]);
    const seenDefault = new Set<string>();
    for (const grant of grants) {
      const id = generateId("workspaceConnectorGrant");
      const isDefault = grant.isDefault && !seenDefault.has(grant.providerId);
      if (isDefault) seenDefault.add(grant.providerId);
      tx.querySync(
        `INSERT INTO workspace_connector_grants
          (id, workspace_id, connection_id, provider_id, granted_capabilities_json, granted_by_user_id, is_default)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [id, workspaceId, grant.connectionId, grant.providerId, JSON.stringify(grant.grantedCapabilities ?? []), grantedByUserId, isDefault ? 1 : 0],
      );
    }
  });
  return listWorkspaceGrants(db, workspaceId);
}
