import { type Pool } from "../pool.js";
import { PinSchema, type Pin, type PinKind } from "@roomy-ai/shared";

function rowToPin(row: Record<string, unknown>): Pin {
  return PinSchema.parse({
    id: row.id,
    workspaceId: row.workspace_id,
    sourceWorkspaceId: row.source_workspace_id,
    kind: row.kind as PinKind,
    refId: row.ref_id,
    pinnedAt: row.pinned_at as string,
  });
}

/** Lists pins on a workspace (the hub) ordered by most-recent first. */
export async function listByWorkspace(db: Pool, workspaceId: string): Promise<Pin[]> {
  const { rows } = await db.query(
    `SELECT * FROM pins WHERE workspace_id = ? ORDER BY pinned_at DESC, id`,
    [workspaceId],
  );
  return rows.map(rowToPin);
}

export async function findById(db: Pool, id: string): Promise<Pin | null> {
  const { rows } = await db.query(`SELECT * FROM pins WHERE id = ?`, [id]);
  return rows.length ? rowToPin(rows[0]) : null;
}

/**
 * Inserts a pin. The `(workspace_id, kind, source_workspace_id, ref_id)`
 * uniqueness constraint makes this idempotent at the DB level: a duplicate
 * insert raises and callers can treat it as a no-op.
 */
export async function insert(
  db: Pool,
  data: {
    id: string;
    workspaceId: string;
    sourceWorkspaceId: string;
    kind: PinKind;
    refId: string;
  },
): Promise<Pin> {
  const { rows } = await db.query(
    `INSERT INTO pins (id, workspace_id, source_workspace_id, kind, ref_id)
     VALUES (?, ?, ?, ?, ?)
     RETURNING *`,
    [data.id, data.workspaceId, data.sourceWorkspaceId, data.kind, data.refId],
  );
  return rowToPin(rows[0]);
}

export async function findExisting(
  db: Pool,
  data: {
    workspaceId: string;
    sourceWorkspaceId: string;
    kind: PinKind;
    refId: string;
  },
): Promise<Pin | null> {
  const { rows } = await db.query(
    `SELECT * FROM pins
      WHERE workspace_id = ? AND kind = ? AND source_workspace_id = ? AND ref_id = ?
      LIMIT 1`,
    [data.workspaceId, data.kind, data.sourceWorkspaceId, data.refId],
  );
  return rows.length ? rowToPin(rows[0]) : null;
}

export async function deleteById(
  db: Pool,
  workspaceId: string,
  pinId: string,
): Promise<boolean> {
  const result = await db.query(
    `DELETE FROM pins WHERE id = ? AND workspace_id = ? RETURNING id`,
    [pinId, workspaceId],
  );
  return result.rows.length > 0;
}
