import * as crypto from "node:crypto";
import { hashPassword, type Pool } from "@agent-desk/db";
import { queries } from "@agent-desk/db";
import { ConflictError, generateId, UnauthorizedError, ValidationError } from "@agent-desk/shared";
import { issueSession, revokeSession } from "../auth/sessions.js";
import type { VaultStore } from "../vault/store.js";
import { createHub } from "./workspaces.js";
import { withModule } from "@agent-desk/shared";
const log = withModule("api/routes/auth");

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

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
 * sets up the per-user vault when DESK_VAULT_PASSWORD is set, and
 * returns a session token. Hub creation + vault setup mirror what
 * main.ts does for users that existed at boot — a new signup gets the
 * same shape immediately so the SPA doesn't land on "No workspaces"
 * right after the redirect.
 */
export function isSignupEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.DESK_ENABLE_SIGNUP === "1";
}

const USERNAME_PATTERN = /^[a-zA-Z0-9_-]{3,32}$/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const SEED_PASSWORD = "change-me-before-first-boot";
const PASSWORD_MIN_LENGTH = 12;

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
  if (password.length < PASSWORD_MIN_LENGTH) {
    throw new ValidationError(
      `Password must be at least ${PASSWORD_MIN_LENGTH} characters`,
    );
  }
  if (password === SEED_PASSWORD) {
    throw new ValidationError("Password must differ from the default seed password");
  }

  // Single non-specific 409 for both username and email collisions. A
  // distinct message would be a user/email enumeration oracle for
  // anyone who can reach /auth/signup (rate-limited but observable).
  // The SPA shows the generic message and asks the user to try a
  // different combination.
  const existingByUsername = await queries.users.findByUsername(ctx.pool, username);
  const existingByEmail = existingByUsername ? null : await queries.users.findByEmail(ctx.pool, email);
  if (existingByUsername || existingByEmail) {
    throw new ConflictError("Account could not be created with the supplied credentials");
  }

  const id = generateId("user");
  const passwordHash = await hashPassword(password);
  await queries.users.insert(ctx.pool, { id, username, passwordHash, email });

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

  // If the server is in auto-unlock mode (DESK_VAULT_PASSWORD set), the
  // boot loop already set up vaults for the users that existed at boot.
  // A user who signs up after boot needs the same treatment so the AI
  // provider key flow (PUT /me/providers) works without a manual vault
  // setup step. Also best-effort.
  const vaultPassword = env.DESK_VAULT_PASSWORD;
  if (ctx.vault && vaultPassword) {
    try {
      await ctx.vault.setup(id, vaultPassword);
    } catch (err) {
      log.warn({ username, err: (err as Error).message }, "signup: vault auto-setup failed");
    }
  }

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
