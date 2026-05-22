/**
 * Hot-refresh of provider keys / local-source env / agent files when a
 * user mutates a connector or agent config.
 *
 * Under the pi runtime there is no long-lived per-container daemon to
 * restart — every turn spawns a fresh pi process via `docker exec` with
 * the current env, so a provider-key change automatically reaches the
 * next turn without any cross-call coordination. All this module has
 * left to do is **clear persisted chat sessions** so the next turn
 * starts a fresh pi session bound to the new auth/model, instead of
 * resuming one bound to whatever was active before.
 *
 * The result shape is unchanged so existing API handlers keep working;
 * the `restarted` / `skippedActive` / `skippedNoContainer` / `failed`
 * lists end up empty under pi (no daemon to act on).
 */

import type { Pool } from "@agent-desk/db";
import { queries } from "@agent-desk/db";
import type { Engine } from "./engine.js";
import { withModule } from "@agent-desk/shared/logger";
const log = withModule("runtime/connectionRefresh");

export interface RefreshSandboxConnectionsOpts {
  pool: Pool;
  userId: string;
  /**
   * Builds the full sandbox env (provider keys + extra env + apiUrl) for
   * one workspace. Retained in the API so callers don't change their
   * signature, even though pi reads env at exec time on every turn and
   * needs no pre-warmed restart.
   */
  buildSandboxEnv?: (
    userId: string,
    workspaceId: string,
  ) => Promise<Record<string, string>>;
  /** When set, refresh only this workspace. */
  workspaceId?: string;
  /** Retained for API compat; ignored by pi. */
  engine?: Engine;
}

export interface RefreshSandboxConnectionsResult {
  /** Empty under pi — there is no daemon to restart. */
  restarted: string[];
  /** Empty under pi. */
  skippedActive: string[];
  /** Empty under pi. */
  skippedNoContainer: string[];
  /** Empty under pi. */
  failed: { workspaceId: string; error: string }[];
  /** Chats whose persisted pi session id was cleared. */
  clearedSessions: { chatId: string; previousSessionId: string }[];
}

/**
 * Clears persisted pi session ids for the affected chats so the next
 * turn starts a fresh session bound to whatever auth/model is
 * configured now. Cheap DB UPDATE — safe even when no sandbox is
 * running.
 */
export async function refreshSandboxConnections(
  opts: RefreshSandboxConnectionsOpts,
): Promise<RefreshSandboxConnectionsResult> {
  const clearedSessions = await queries.chats.clearOpencodeSessionsForUser(
    opts.pool,
    opts.userId,
    opts.workspaceId,
  );

  if (clearedSessions.length > 0) {
    log.info(
      `connection refresh: cleared ${clearedSessions.length} chat session(s) for user ${opts.userId}` +
        (opts.workspaceId ? ` (workspace ${opts.workspaceId})` : ""),
    );
  }

  return {
    restarted: [],
    skippedActive: [],
    skippedNoContainer: [],
    failed: [],
    clearedSessions,
  };
}
