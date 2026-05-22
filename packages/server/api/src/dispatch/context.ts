import type { Pool } from "@roomy-ai/db";
import type { StorageContext } from "@roomy-ai/storage";
import type { createRunManager } from "@roomy-ai/scheduler";
import type { WsEvent } from "@roomy-ai/shared";
import type { VaultStore } from "../vault/store.js";

/**
 * Closure context shared by every dispatch sub-module. Carving the
 * createApp closure into chunks would otherwise force each chunk to
 * accept the same long argument list — a single struct keeps the
 * signatures stable and makes adding a new dep a one-line change here
 * rather than a per-handler rewrite.
 *
 * Lives in its own module so the per-resource dispatch files don't
 * have to import from app.ts (which would create a cycle when app.ts
 * eventually re-exports the same context).
 */
export interface DispatchContext {
  pool: Pool;
  storage: StorageContext;
  vault: VaultStore;
  runManager: ReturnType<typeof createRunManager>;
  /**
   * Broadcast a WS event. Recipient is normally derived from the event
   * payload (workspaceId/chatId/messageId → owning user). The optional
   * `recipientUserId` is for events whose payload can't reveal the
   * recipient — currently global `connection.changed` toggles, which
   * carry no workspaceId.
   */
  emit: (event: WsEvent, recipientUserId?: string) => void;
  /** Hot-refresh callback for connector / local-source mutations. */
  refreshConnections: (
    userId: string,
    payload: WsEvent & { type: "connection.changed" },
    workspaceId?: string,
  ) => Promise<void>;
}
