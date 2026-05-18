/**
 * Hot-refresh of provider keys / local-source env for already-running
 * sandbox daemons.
 *
 * When a user adds, edits, or removes a connector connection (GitHub
 * token, OPENAI_API_KEY, …) — or toggles a local source like Codex
 * — three layers of "stickiness" stand between the change and the
 * agent inside the sandbox:
 *
 *   1. The container's birth env (handled at exec time elsewhere).
 *   2. The opencode-serve daemon's process env. The daemon reads
 *      provider keys at spawn time; a new key only reaches the daemon
 *      when it's restarted with fresh env.
 *   3. The opencode-serve session bound to the chat. opencode-serve
 *      binds providerID / modelID / auth at session creation and
 *      ignores per-message overrides for those fields, so a chat
 *      whose session was created with the OAuth blob keeps using it
 *      even after we strip OPENCODE_AUTH_CONTENT from the env.
 *
 * This module pierces (2) and (3): we restart the daemon with freshly
 * resolved env, and we null out persisted opencode session ids so the
 * next turn creates a session bound to whatever is configured now.
 *
 * Workspaces with an in-flight run skip the daemon restart (it would
 * kill the in-flight model call). The existing env-digest check in
 * `ensureOpencodeServer` will pick up the new env on the next turn for
 * those workspaces. Sessions are still cleared regardless, since that's
 * a DB-only operation that doesn't disturb the in-flight call.
 */

import type { Pool } from "@agent-desk/db";
import { queries } from "@agent-desk/db";
import { detectEngine, type Engine } from "./engine.js";
import { hasActiveRunForContainer } from "./driver.js";
import {
  invalidateOpencodeServerCache,
  restartOpencodeServer,
} from "./opencodeServer.js";
import { sandboxUser } from "./docker.js";
import { SANDBOX_HOME } from "./mounts.js";

export interface RefreshSandboxConnectionsOpts {
  pool: Pool;
  userId: string;
  /**
   * Builds the full daemon env (provider keys + extra env + apiUrl) for
   * one workspace. The caller composes the same env the scheduler uses
   * at run-fire time — keeping the two paths in sync means the digest
   * check inside `ensureOpencodeServer` matches what the scheduler
   * expects on the very next message.
   */
  buildSandboxEnv: (
    userId: string,
    workspaceId: string,
  ) => Promise<Record<string, string>>;
  /**
   * If set, refresh only this workspace. Otherwise every workspace the
   * user owns. A workspace-grant change is per-workspace; user-level
   * connection or local-source changes touch every workspace.
   */
  workspaceId?: string;
  /** Defaults to host-side `detectEngine()`. Overridable for tests. */
  engine?: Engine;
}

export interface RefreshSandboxConnectionsResult {
  /** Workspace ids whose daemon was restarted with fresh env. */
  restarted: string[];
  /** Workspace ids skipped because a run was in flight on that container. */
  skippedActive: string[];
  /** Workspace ids skipped because no sandbox container exists yet. */
  skippedNoContainer: string[];
  /** Workspace ids whose restart attempt failed (logged, not thrown). */
  failed: { workspaceId: string; error: string }[];
  /** Chats whose persisted opencode session id was cleared. */
  clearedSessions: { chatId: string; previousSessionId: string }[];
}

/**
 * Hot-refreshes the opencode-serve daemon for affected sandboxes and
 * clears any persisted session ids so the next turn creates a session
 * bound to whatever auth/model is configured now. Failures are
 * swallowed per-workspace and surfaced in the result; the caller
 * (an HTTP route handler responding to a connection mutation) should
 * not 500 on a transient Docker hiccup.
 */
export async function refreshSandboxConnections(
  opts: RefreshSandboxConnectionsOpts,
): Promise<RefreshSandboxConnectionsResult> {
  const result: RefreshSandboxConnectionsResult = {
    restarted: [],
    skippedActive: [],
    skippedNoContainer: [],
    failed: [],
    clearedSessions: [],
  };

  // Step 1: Clear persisted opencode-serve session ids for the affected
  // chats. This is the only way to undo provider/model bindings baked
  // into a session at creation time. Cheap DB UPDATE — safe even when
  // no sandbox is running.
  result.clearedSessions = await queries.chats.clearOpencodeSessionsForUser(
    opts.pool,
    opts.userId,
    opts.workspaceId,
  );

  const workspaceIds = opts.workspaceId
    ? [opts.workspaceId]
    : (await queries.workspaces.listByUser(opts.pool, opts.userId)).map((w) => w.id);
  if (workspaceIds.length === 0) return result;

  // Step 2: Restart the daemon for each running sandbox so the new env
  // takes effect immediately, not on the next message.
  let engine: Engine;
  try {
    engine = opts.engine ?? (await detectEngine());
  } catch (err) {
    // No container runtime available (CI without Docker, dev without
    // Docker installed). Sessions are cleared above; the env-digest
    // restart in ensureOpencodeServer will pick up the new env on the
    // next message anyway. Treat as a soft failure per workspace so
    // the caller can log/metric, not a hard error.
    for (const workspaceId of workspaceIds) {
      result.failed.push({
        workspaceId,
        error: `engine unavailable: ${(err as Error).message ?? String(err)}`,
      });
    }
    return result;
  }

  const user = await sandboxUser(engine).catch(() => "1000:1000");

  await Promise.all(
    workspaceIds.map(async (workspaceId) => {
      try {
        const containerName = `desk-sandbox-${workspaceId}`;
        const info = await engine.inspect(containerName);
        if (!info || !info.running) {
          // Nothing to refresh: the next createOrReuse will bake the
          // current keys into the container's birth env.
          result.skippedNoContainer.push(workspaceId);
          return;
        }

        if (hasActiveRunForContainer(info.id)) {
          // A turn is in flight on this sandbox. Restarting the daemon
          // would kill the in-flight model call. Drop the cache entry
          // so when the in-flight run completes and the next call
          // arrives, ensureOpencodeServer will respawn with fresh env
          // (rather than re-using the cached daemon and its stale env).
          invalidateOpencodeServerCache(info.id);
          result.skippedActive.push(workspaceId);
          return;
        }

        const env = await opts.buildSandboxEnv(opts.userId, workspaceId);
        await restartOpencodeServer(engine, {
          containerId: info.id,
          cwd: SANDBOX_HOME,
          user,
          env,
        });
        result.restarted.push(workspaceId);
      } catch (err) {
        result.failed.push({
          workspaceId,
          error: (err as Error).message ?? String(err),
        });
      }
    }),
  );

  return result;
}
