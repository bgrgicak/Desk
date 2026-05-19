import { type IncomingMessage, type ServerResponse } from "node:http";
import { ValidationError, type PinKind } from "@agent-desk/shared";
import { withModule } from "@agent-desk/shared/logger";
import * as accountRoutes from "../routes/account.js";
import * as agentRoutes from "../routes/agents.js";
import * as libraryRoutes from "../routes/library.js";
import * as pinRoutes from "../routes/pins.js";
import * as workspaceRoutes from "../routes/workspaces.js";
import { parseBody, sendJson } from "../http/request-helpers.js";
import { requireOwnedAgent, requireOwnedWorkspace } from "../auth/ownership.js";
import type { DispatchContext } from "./context.js";

const log = withModule("api/dispatch/workspaces");

/**
 * Dispatcher for the workspace/agent surface:
 *
 *   /workspaces (list, create)
 *   /workspaces/{id} (get, patch, delete)
 *   /workspaces/{id}/connections (list, replace)
 *   /workspaces/{id}/agents (list, add, remove)
 *   /workspaces/{id}/pins (cross-workspace pins; list, create, delete)
 *   /workspaces/{id}/library-pins (within-workspace pins; create, delete)
 *   /agents (list, create)
 *   /agents/{id} (get, patch, delete)
 *
 * All routes are user-scoped — ownership is gated on every branch.
 * Returns `true` when handled.
 */
export async function dispatchWorkspaces(
  req: IncomingMessage,
  res: ServerResponse,
  method: string,
  path: string,
  segments: string[],
  userId: string,
  ctx: DispatchContext,
  opts: {
    refreshSandboxConnections?: (userId: string, workspaceId?: string) => Promise<void>;
  },
): Promise<boolean> {
  const { pool, storage, refreshConnections } = ctx;

  // ── Workspaces ──────────────────────────────────────────────────────
  if (path === "/workspaces" && method === "GET") {
    const result = await workspaceRoutes.listWorkspaces(pool, userId);
    sendJson(res, 200, result);
    return true;
  }
  if (path === "/workspaces" && method === "POST") {
    const body = (await parseBody(req)) as Record<string, unknown>;
    // `kind` is server-only; the API never trusts a client-supplied
    // value. Internal callers (createHub) bypass this layer entirely.
    if ("kind" in body) {
      throw new ValidationError("`kind` is not accepted in workspace creation requests");
    }
    const data = {
      name: typeof body.name === "string" ? body.name : "",
      description: typeof body.description === "string" ? body.description : undefined,
      icon: typeof body.icon === "string" ? body.icon : undefined,
      color: typeof body.color === "string" ? body.color : undefined,
    };
    const result = await workspaceRoutes.createWorkspace(pool, userId, storage.home, data);
    sendJson(res, 201, result);
    return true;
  }
  if (segments[0] === "workspaces" && segments.length === 2 && method === "GET") {
    await requireOwnedWorkspace(pool, segments[1], userId);
    const result = await workspaceRoutes.getWorkspace(pool, segments[1]);
    sendJson(res, 200, result);
    return true;
  }
  if (segments[0] === "workspaces" && segments.length === 2 && method === "PATCH") {
    await requireOwnedWorkspace(pool, segments[1], userId);
    const body = (await parseBody(req)) as Record<string, unknown>;
    if ("kind" in body) {
      throw new ValidationError("`kind` is not accepted in workspace patch requests");
    }
    const data = {
      name: typeof body.name === "string" ? body.name : undefined,
      description: typeof body.description === "string" ? body.description : undefined,
      icon: typeof body.icon === "string" ? body.icon : undefined,
      color: typeof body.color === "string" ? body.color : undefined,
    };
    const result = await workspaceRoutes.patchWorkspace(pool, storage.home, segments[1], data);
    sendJson(res, 200, result);
    return true;
  }
  if (segments[0] === "workspaces" && segments.length === 2 && method === "DELETE") {
    await requireOwnedWorkspace(pool, segments[1], userId);
    const result = await workspaceRoutes.deleteWorkspace(pool, storage.home, userId, segments[1]);
    sendJson(res, 200, result);
    return true;
  }
  if (segments[0] === "workspaces" && segments[2] === "connections" && segments.length === 3 && method === "GET") {
    await requireOwnedWorkspace(pool, segments[1], userId);
    const result = await accountRoutes.listWorkspaceGrants(pool, segments[1]);
    sendJson(res, 200, result);
    return true;
  }
  if (segments[0] === "workspaces" && segments[2] === "connections" && segments.length === 3 && method === "PUT") {
    await requireOwnedWorkspace(pool, segments[1], userId);
    const body = await parseBody(req) as Parameters<typeof accountRoutes.replaceWorkspaceGrants>[3];
    const result = await accountRoutes.replaceWorkspaceGrants(pool, userId, segments[1], body);
    await refreshConnections(
      userId,
      {
        type: "connection.changed",
        payload: {
          kind: "connector",
          providerId: "*",
          op: "updated",
          workspaceId: segments[1],
        },
      },
      segments[1],
    );
    sendJson(res, 200, result);
    return true;
  }
  if (segments[0] === "workspaces" && segments[2] === "agents" && segments.length === 3 && method === "GET") {
    await requireOwnedWorkspace(pool, segments[1], userId);
    const result = await workspaceRoutes.listWorkspaceAgents(pool, segments[1]);
    sendJson(res, 200, result);
    return true;
  }
  if (segments[0] === "workspaces" && segments[2] === "agents" && segments.length === 3 && method === "POST") {
    await requireOwnedWorkspace(pool, segments[1], userId);
    const body = await parseBody(req) as { agentId: string };
    await requireOwnedAgent(pool, body.agentId, userId);
    const result = await workspaceRoutes.addAgentToWorkspace(pool, segments[1], body.agentId);
    sendJson(res, 201, result);
    return true;
  }
  if (segments[0] === "workspaces" && segments[2] === "agents" && segments.length === 4 && method === "DELETE") {
    await requireOwnedWorkspace(pool, segments[1], userId);
    const result = await workspaceRoutes.removeAgentFromWorkspace(pool, segments[1], segments[3]);
    sendJson(res, 200, result);
    return true;
  }

  // ── Cross-workspace pins (hub only) ─────────────────────────────────
  if (segments[0] === "workspaces" && segments[2] === "pins" && segments.length === 3 && method === "GET") {
    await requireOwnedWorkspace(pool, segments[1], userId);
    const result = await pinRoutes.listPins(pool, segments[1], userId);
    sendJson(res, 200, result);
    return true;
  }
  if (segments[0] === "workspaces" && segments[2] === "pins" && segments.length === 3 && method === "POST") {
    await requireOwnedWorkspace(pool, segments[1], userId);
    const body = (await parseBody(req)) as {
      sourceWorkspaceId?: unknown;
      kind?: unknown;
      refId?: unknown;
    };
    const sourceWorkspaceId = typeof body.sourceWorkspaceId === "string" ? body.sourceWorkspaceId : "";
    const kind = typeof body.kind === "string" ? body.kind : "";
    const refId = typeof body.refId === "string" ? body.refId : "";
    const result = await pinRoutes.createPin(pool, segments[1], userId, {
      sourceWorkspaceId,
      kind: kind as PinKind,
      refId,
    });
    sendJson(res, 201, result);
    return true;
  }
  if (segments[0] === "workspaces" && segments[2] === "pins" && segments.length === 4 && method === "DELETE") {
    await requireOwnedWorkspace(pool, segments[1], userId);
    const result = await pinRoutes.deletePin(pool, segments[1], userId, segments[3]);
    sendJson(res, 200, result);
    return true;
  }

  // ── Library pins (within-workspace) ─────────────────────────────────
  if (segments[0] === "workspaces" && segments[2] === "library-pins" && segments.length === 3 && method === "POST") {
    await requireOwnedWorkspace(pool, segments[1], userId);
    const body = (await parseBody(req)) as { path?: unknown };
    const filePath = typeof body?.path === "string" ? body.path : "";
    if (!filePath) throw new ValidationError("Missing 'path' in body");
    await libraryRoutes.pin(storage, segments[1], filePath);
    sendJson(res, 201, { ok: true });
    return true;
  }
  if (segments[0] === "workspaces" && segments[2] === "library-pins" && segments.length === 3 && method === "DELETE") {
    await requireOwnedWorkspace(pool, segments[1], userId);
    const body = (await parseBody(req)) as { path?: unknown };
    const filePath = typeof body?.path === "string" ? body.path : "";
    if (!filePath) throw new ValidationError("Missing 'path' in body");
    await libraryRoutes.unpin(storage, segments[1], filePath);
    sendJson(res, 200, { ok: true });
    return true;
  }

  // ── Agents ──────────────────────────────────────────────────────────
  if (path === "/agents" && method === "GET") {
    const result = await agentRoutes.listAgents(pool, userId);
    sendJson(res, 200, result);
    return true;
  }
  if (path === "/agents" && method === "POST") {
    const body = await parseBody(req) as { name: string; model?: string };
    const result = await agentRoutes.createAgent(pool, userId, body);
    sendJson(res, 201, result);
    return true;
  }
  if (segments[0] === "agents" && segments.length === 2 && method === "GET") {
    await requireOwnedAgent(pool, segments[1], userId);
    const result = await agentRoutes.getAgent(pool, segments[1]);
    sendJson(res, 200, result);
    return true;
  }
  if (segments[0] === "agents" && segments.length === 2 && method === "PATCH") {
    await requireOwnedAgent(pool, segments[1], userId);
    const body = await parseBody(req) as { name?: string; model?: string };
    const { agent, modelChanged } = await agentRoutes.patchAgent(pool, segments[1], body);
    if (modelChanged && opts.refreshSandboxConnections) {
      // opencode-serve caches each agent file's `model:` field at
      // startup and ignores rewrites. Clearing chat sessions (done
      // inside patchAgent) is necessary but not sufficient — a new
      // session in the same daemon still inherits the cached agent
      // config. Restart the daemons so they re-read the agent files.
      // Fire-and-forget: the HTTP response shouldn't block on a
      // Docker round-trip, and a transient engine hiccup must not
      // turn a successful agent update into a 500.
      void opts.refreshSandboxConnections(userId).catch((err: unknown) => {
        log.warn(
          { agentId: segments[1], err: (err as Error)?.message ?? String(err) },
          "refreshSandboxConnections after agent model change failed",
        );
      });
    }
    sendJson(res, 200, agent);
    return true;
  }
  if (segments[0] === "agents" && segments.length === 2 && method === "DELETE") {
    await requireOwnedAgent(pool, segments[1], userId);
    const result = await agentRoutes.deleteAgent(pool, userId, segments[1]);
    sendJson(res, 200, result);
    return true;
  }

  return false;
}
