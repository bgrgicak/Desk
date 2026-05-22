import { type IncomingMessage, type ServerResponse } from "node:http";
import { queries } from "@roomy-ai/db";
import * as accountRoutes from "../routes/account.js";
import * as authRoutes from "../routes/auth.js";
import * as localSourceRoutes from "../routes/localSources.js";
import * as vaultRoutes from "../routes/vault.js";
import * as workspaceRoutes from "../routes/workspaces.js";
import { parseBody, sendJson } from "../http/io.js";
import { denyOverLimit } from "../http/rate-limit-response.js";
import { getClientIp } from "../auth/rateLimit.js";
import { isLoopbackAddress } from "../http/security-headers.js";
import type { DispatchContext } from "./context.js";

/**
 * Dispatcher for the user-account surface:
 *
 *   /auth/{login, auto-login, signup, signup-status, logout}
 *   /me, /me/password, /me/providers(/meta|/local), /me/connections,
 *     /me/key-access-log
 *   /vault/{status, setup, unlock, lock}
 *   /secrets (GET, POST, PUT)
 *
 * `userId` is the empty string for unauthenticated routes (the /auth/*
 * group). Returns `true` when handled.
 */
export async function dispatchAccount(
  req: IncomingMessage,
  res: ServerResponse,
  method: string,
  path: string,
  segments: string[],
  userId: string,
  query: URLSearchParams,
  ctx: DispatchContext,
): Promise<boolean> {
  const { pool, storage, vault, refreshConnections } = ctx;

  // ── Auth ────────────────────────────────────────────────────────────
  if (path === "/auth/login" && method === "POST") {
    // Per-IP cap blocks bruteforce. Applied before reading the body so
    // a slow-loris caller can't slip past the limiter by stalling the
    // POST.
    if (denyOverLimit(res, "auth.login", getClientIp(req))) return true;
    const body = await parseBody(req) as { email: string; password: string };
    const result = await authRoutes.handleLogin(pool, body);
    sendJson(res, 200, result);
    return true;
  }
  if (path === "/auth/auto-login" && method === "POST") {
    // Auto-login mints a bearer for the seed user without credentials,
    // so the call must originate from loopback. A request that reaches
    // the API from a remote address either means the operator put
    // roomy-server on a public interface deliberately or a reverse-proxy
    // forwarded it — both should fall back to the manual LoginScreen
    // rather than minting a free token. ROOMY_TRUST_PROXY=1 disables
    // the loopback check so an operator who really wants public auto-
    // login can opt in explicitly.
    const remote = req.socket?.remoteAddress ?? "";
    if (!isLoopbackAddress(remote) && process.env.ROOMY_TRUST_PROXY !== "1") {
      sendJson(res, 403, { code: "FORBIDDEN", message: "Auto-login restricted to loopback" });
      return true;
    }
    if (denyOverLimit(res, "auth.autoLogin", getClientIp(req))) return true;
    const result = await authRoutes.handleAutoLogin(pool);
    sendJson(res, 200, result);
    return true;
  }
  if (path === "/auth/signup" && method === "POST") {
    if (denyOverLimit(res, "auth.signup", getClientIp(req))) return true;
    const body = await parseBody(req) as { username?: unknown; email?: unknown; password?: unknown };
    const result = await authRoutes.handleSignup(
      { pool, home: storage.home, vault },
      body,
    );
    sendJson(res, 200, result);
    return true;
  }
  if (path === "/auth/signup-status" && method === "GET") {
    const { available, firstRun } = await authRoutes.isSignupAvailable(pool);
    sendJson(res, 200, { enabled: available, firstRun });
    return true;
  }
  if (path === "/auth/logout" && method === "POST") {
    const result = await authRoutes.handleLogout(pool, vault, req.headers.authorization);
    sendJson(res, 200, result);
    return true;
  }

  // ── /me ─────────────────────────────────────────────────────────────
  if (path === "/me" && method === "GET") {
    const result = await accountRoutes.getMe(pool, userId);
    sendJson(res, 200, result);
    return true;
  }
  if (path === "/me/ask-ai-chat" && method === "GET") {
    const result = await workspaceRoutes.getOrCreateAskAiChat(pool, userId);
    sendJson(res, 200, result);
    return true;
  }
  if (path === "/me" && method === "PATCH") {
    const body = await parseBody(req) as { username?: string; email?: string; avatarPath?: string };
    const result = await accountRoutes.patchMe(pool, userId, body);
    sendJson(res, 200, result);
    return true;
  }
  if (path === "/me" && method === "DELETE") {
    const result = await accountRoutes.deleteMe(pool, userId);
    sendJson(res, 200, result);
    return true;
  }
  if (path === "/me/password" && method === "POST") {
    if (denyOverLimit(res, "me.password", userId)) return true;
    const body = await parseBody(req) as { currentPassword: string; newPassword: string };
    const result = await accountRoutes.changePassword(pool, userId, body);
    sendJson(res, 200, result);
    return true;
  }
  if (path === "/me/providers" && method === "GET") {
    const result = await accountRoutes.getProviders(pool, vault, userId);
    sendJson(res, 200, result);
    return true;
  }
  if (path === "/me/providers" && method === "PUT") {
    const body = await parseBody(req) as { providers: Record<string, string | null> };
    const result = await accountRoutes.setProviders(pool, vault, userId, body);
    const providerIds = Object.keys(body?.providers ?? {});
    await refreshConnections(userId, {
      type: "connection.changed",
      payload: {
        kind: "connector",
        providerId: providerIds.length === 1 ? providerIds[0] : "*",
        op: "updated",
      },
    });
    sendJson(res, 200, result);
    return true;
  }
  if (path === "/me/providers/meta" && method === "GET") {
    const result = await accountRoutes.getProvidersMeta(pool, userId);
    sendJson(res, 200, result);
    return true;
  }
  if (path === "/me/key-access-log" && method === "GET") {
    const result = await accountRoutes.getKeyAccessLog(pool, userId, query.get("limit") ?? undefined);
    sendJson(res, 200, result);
    return true;
  }
  if (path === "/me/providers/meta" && method === "PUT") {
    const body = await parseBody(req) as { meta: Record<string, { name?: string; enabled?: boolean } | null> };
    const result = await accountRoutes.setProvidersMeta(pool, userId, body);
    const providerIds = Object.keys(body?.meta ?? {});
    await refreshConnections(userId, {
      type: "connection.changed",
      payload: {
        kind: "connector",
        providerId: providerIds.length === 1 ? providerIds[0] : "*",
        op: "updated",
      },
    });
    sendJson(res, 200, result);
    return true;
  }
  if (path === "/me/connections" && method === "GET") {
    const result = await accountRoutes.listConnections(pool, vault, userId, query.get("providerId") ?? undefined);
    sendJson(res, 200, result);
    return true;
  }
  if (path === "/me/connections" && method === "POST") {
    const body = await parseBody(req) as Parameters<typeof accountRoutes.createConnection>[3];
    const result = await accountRoutes.createConnection(pool, vault, userId, body, { home: storage.home });
    const providerId = result.connection?.providerId ?? "unknown";
    await refreshConnections(userId, {
      type: "connection.changed",
      payload: { kind: "connector", providerId, op: "created" },
    });
    sendJson(res, 201, result);
    return true;
  }
  {
    const m = path.match(/^\/me\/connections\/([A-Za-z0-9_-]+)$/);
    if (m && method === "PATCH") {
      const body = await parseBody(req) as Parameters<typeof accountRoutes.updateConnection>[4];
      const result = await accountRoutes.updateConnection(pool, vault, userId, m[1], body, { home: storage.home });
      const providerId = result.connection?.providerId ?? "unknown";
      await refreshConnections(userId, {
        type: "connection.changed",
        payload: { kind: "connector", providerId, op: "updated" },
      });
      sendJson(res, 200, result);
      return true;
    }
    if (m && method === "DELETE") {
      // Look up providerId before delete so the broadcast still has it.
      const before = await queries.connectors.findConnection(pool, m[1], userId);
      const result = await accountRoutes.deleteConnection(pool, vault, userId, m[1], { home: storage.home });
      await refreshConnections(userId, {
        type: "connection.changed",
        payload: {
          kind: "connector",
          providerId: before?.providerId ?? "unknown",
          op: "deleted",
        },
      });
      sendJson(res, 200, result);
      return true;
    }
  }
  if (path === "/me/providers/local" && method === "GET") {
    const result = await localSourceRoutes.listLocalSources(pool, userId);
    sendJson(res, 200, result);
    return true;
  }
  {
    const m = path.match(/^\/me\/providers\/local\/([A-Za-z0-9_-]+)$/);
    if (m && method === "PUT") {
      const body = await parseBody(req) as { enabled: boolean };
      const result = await localSourceRoutes.setLocalSourceEnabled(pool, userId, m[1], body);
      await refreshConnections(userId, {
        type: "connection.changed",
        payload: {
          kind: "local_source",
          providerId: m[1],
          op: body.enabled ? "enabled" : "disabled",
        },
      });
      sendJson(res, 200, result);
      return true;
    }
  }

  // ── Vault ───────────────────────────────────────────────────────────
  if (path === "/vault/status" && method === "GET") {
    const result = await vaultRoutes.getStatus(vault, userId);
    sendJson(res, 200, result);
    return true;
  }
  if (path === "/vault/setup" && method === "POST") {
    const body = await parseBody(req) as { password?: unknown };
    const result = await vaultRoutes.setup(vault, userId, body);
    sendJson(res, 200, result);
    return true;
  }
  if (path === "/vault/unlock" && method === "POST") {
    if (denyOverLimit(res, "vault.unlock.ip", getClientIp(req))) return true;
    if (denyOverLimit(res, "vault.unlock.user", userId)) return true;
    const body = await parseBody(req) as { password?: unknown };
    const result = await vaultRoutes.unlock(vault, userId, body);
    sendJson(res, 200, result);
    return true;
  }
  if (path === "/vault/lock" && method === "POST") {
    const result = vaultRoutes.lock(vault, userId);
    sendJson(res, 200, result);
    return true;
  }

  // ── Secrets (user side) ─────────────────────────────────────────────
  if (path === "/secrets" && method === "GET") {
    const result = vaultRoutes.listSecrets(vault, userId);
    sendJson(res, 200, result);
    return true;
  }
  if (path === "/secrets" && method === "POST") {
    const body = await parseBody(req);
    const result = await vaultRoutes.createSecret(vault, userId, body);
    sendJson(res, 201, result);
    return true;
  }
  if (segments[0] === "secrets" && segments.length === 2 && method === "PUT") {
    const body = await parseBody(req);
    const title = decodeURIComponent(segments[1]);
    const result = await vaultRoutes.updateSecret(vault, userId, title, body);
    sendJson(res, 200, result);
    return true;
  }

  return false;
}
