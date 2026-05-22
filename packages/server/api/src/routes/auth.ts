import { hashPassword, type Pool } from "@agent-desk/db";
import { queries } from "@agent-desk/db";
import { ConflictError, generateId, UnauthorizedError, ValidationError } from "@agent-desk/shared";
import { withModule } from "@agent-desk/shared/logger";
import { hashToken, issueSession, revokeSession } from "../auth/sessions.js";
import type { VaultStore } from "../vault/store.js";
import { createHub } from "./workspaces.js";
import { enforcePasswordPolicy } from "../auth/passwordPolicy.js";
const log = withModule("api/routes/auth");

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export async function handleLogin(
  pool: Pool,
  body: { username: string; password: string },
): Promise<{ token: string }> {
  const user = await queries.users.login(pool, body.username, body.password);
  if (!user) throw new UnauthorizedError("Invalid credentials");

  const token = await issueSession(pool, user.id);
  return { token };
}

/**
 * Auto-login for the local Desk owner. This is intentionally not tied to
 * Vite/dev mode: production desktop/static-server builds need the same
 * no-friction boot path as `npm run dev`.
 *
 * Set DESK_AUTO_LOGIN=off to force the manual LoginScreen instead.
 */
export async function handleAutoLogin(
  pool: Pool,
): Promise<{ token: string }> {
  if ((process.env.DESK_AUTO_LOGIN ?? "on").toLowerCase() === "off") {
    throw new UnauthorizedError("Auto-login is disabled");
  }

  const preferredUsername = process.env.DESK_SEED_USERNAME ?? "desk";
  const preferred = await queries.users.findByUsername(pool, preferredUsername);
  let userId = preferred?.id;

  if (!userId) {
    const { rows } = await pool.query<{ id: string }>(
      "SELECT id FROM users ORDER BY created_at ASC LIMIT 1",
    );
    userId = rows[0]?.id;
  }

  if (!userId) throw new UnauthorizedError("No user is available for auto-login");

  const token = await issueSession(pool, userId);
  return { token };
}

/**
 * Signup is intentionally gated by the DESK_ENABLE_SIGNUP env var. Desk
 * is single-user-per-host by default and exposing a public registration
 * endpoint on a misconfigured deployment would let anyone create
 * accounts. Operators who want multi-user mode opt in explicitly with
 * `DESK_ENABLE_SIGNUP=1`.
 *
 * When enabled, this creates the user row, bootstraps a hub workspace,
 * and returns a session token. The per-user vault is NOT created here —
 * the user picks a vault password through the VaultDialog the first time
 * they store an API key, so the master never lives in the server .env.
 */
export function isSignupEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.DESK_ENABLE_SIGNUP === "1";
}

const USERNAME_PATTERN = /^[a-zA-Z0-9_-]{3,32}$/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface SignupContext {
  pool: Pool;
  home: string;
  vault?: VaultStore;
  env?: NodeJS.ProcessEnv;
}

export async function handleSignup(
  ctx: SignupContext,
  body: { username?: unknown; email?: unknown; password?: unknown },
): Promise<{ token: string }> {
  const env = ctx.env ?? process.env;
  if (!isSignupEnabled(env)) {
    throw new ValidationError("Signup is disabled on this server");
  }
  const username = typeof body.username === "string" ? body.username.trim() : "";
  const email = typeof body.email === "string" ? body.email.trim() : "";
  const password = typeof body.password === "string" ? body.password : "";

  if (!USERNAME_PATTERN.test(username)) {
    throw new ValidationError(
      "Username must be 3–32 characters of letters, digits, underscore, or dash",
    );
  }
  if (!EMAIL_PATTERN.test(email)) {
    throw new ValidationError("Email must be a valid address");
  }
  enforcePasswordPolicy(password);

  // Single non-specific 409 for both username and email collisions. A
  // distinct message would be a user/email enumeration oracle for
  // anyone who can reach /auth/signup (rate-limited but observable).
  // The SPA shows the generic message and asks the user to try a
  // different combination.
  //
  // Run both lookups in parallel so the response time doesn't reveal
  // which one matched — short-circuiting would let an attacker
  // distinguish "username taken" (1 DB query) from "email taken" or
  // "neither taken" (2 queries) by timing alone.
  const [existingByUsername, existingByEmail] = await Promise.all([
    queries.users.findByUsername(ctx.pool, username),
    queries.users.findByEmail(ctx.pool, email),
  ]);
  if (existingByUsername || existingByEmail) {
    throw new ConflictError("Account could not be created with the supplied credentials");
  }

  const id = generateId("user");
  const passwordHash = await hashPassword(password);
  // Race window: between the parallel findByUsername/findByEmail
  // above and this insert, another concurrent signup with the same
  // credentials could have committed.  Catch the UNIQUE-constraint
  // error and map it to the same generic 409 the preflight emits —
  // otherwise the SECOND request bubbles a 500 instead of a clean
  // collision response.
  try {
    await queries.users.insert(ctx.pool, { id, username, passwordHash, email });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/UNIQUE constraint failed/i.test(msg)) {
      throw new ConflictError(
        "Account could not be created with the supplied credentials",
      );
    }
    throw err;
  }

  // Mint the session first — that and the user row are the two pieces
  // the client absolutely needs to recover. If session issuance
  // throws (DB hiccup, exhausted entropy, …) we roll back the user
  // insert so a retry isn't blocked by a 409.
  let token: string;
  try {
    token = await issueSession(ctx.pool, id);
  } catch (err) {
    try {
      await ctx.pool.query("DELETE FROM users WHERE id = ?", [id]);
    } catch (rollbackErr) {
      log.warn(
        { id, username, err: (rollbackErr as Error).message },
        "signup: failed to roll back user row after issueSession failure",
      );
    }
    throw err;
  }

  // Mirror the post-boot bootstrap that existing users get in main.ts —
  // a new signup needs a hub workspace immediately, otherwise the SPA
  // lands on "No workspaces" right after the redirect. Best-effort: a
  // hub-creation failure should not undo the account; the next /me
  // hits the workspace-create path through the normal SPA flow.
  try {
    await createHub(ctx.pool, ctx.home, id, username);
  } catch (err) {
    log.warn({ username, err: (err as Error).message }, "signup: hub-creation failed");
  }

  // No vault is created at signup. The user picks a vault password on
  // their first credential-store action through the VaultDialog UI; until
  // then the per-user vault simply doesn't exist and `/vault/status`
  // returns `{ exists: false, locked: true }`.
  //
  // The DESK_VAULT_PASSWORD env still controls boot-time auto-unlock for
  // pre-existing vaults (so dev/CI restarts don't lose state), but it no
  // longer creates vaults at signup — that would re-introduce the
  // plaintext-in-.env weakness for anyone who signs up after boot.

  return { token };
}

/**
 * Logout — revokes the bearer token and, when no live sessions remain
 * for the same user, locks that user's secrets vault so the in-memory
 * master is dropped. Multi-device users keep the vault unlocked while
 * any session is alive.
 */
export async function handleLogout(
  pool: Pool,
  vault: VaultStore,
  authHeader: string | undefined,
): Promise<{ ok: boolean }> {
  if (!authHeader?.startsWith("Bearer ")) return { ok: true };
  const token = authHeader.slice(7);

  // Resolve the userId from the token before we revoke it — once revoked,
  // the row is gone and we can't look up "who was that?". The hash has
  // to be computed identically to issueSession.
  const tokenHash = hashToken(token);
  const { rows } = await pool.query(
    `SELECT user_id FROM auth_sessions WHERE token_hash = ?`,
    [tokenHash],
  );
  const userId = rows.length ? (rows[0].user_id as string) : null;

  await revokeSession(pool, token);

  if (userId) {
    const remaining = await queries.authSessions.countActiveByUserId(
      pool,
      userId,
      SESSION_TTL_MS,
    );
    if (remaining === 0) {
      vault.lock(userId);
    }
  }
  return { ok: true };
}
