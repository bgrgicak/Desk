import { hashPassword, type Pool } from "@agent-desk/db";
import { queries } from "@agent-desk/db";
import { ConflictError, generateId, UnauthorizedError, ValidationError } from "@agent-desk/shared";
import { withModule } from "@agent-desk/shared/logger";
import { hashToken, issueSession, revokeSession } from "../auth/sessions.js";
import type { VaultStore } from "../vault/store.js";
import { createHub, createWorkspace } from "./workspaces.js";
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
 * Signup is normally gated by the DESK_ENABLE_SIGNUP env var. Desk is
 * single-user-per-host by default and exposing a public registration
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

/**
 * First-run check: returns true when no user rows exist. Used to
 * automatically unlock the signup endpoint on a fresh install — without
 * this, the only way to bootstrap an account would be the env-gated
 * DESK_ENABLE_SIGNUP flag, which the install UX shouldn't require.
 */
async function isFirstRun(pool: Pool): Promise<boolean> {
  const { rows } = await pool.query<{ c: number }>(
    "SELECT count(*) AS c FROM users",
  );
  return rows[0].c === 0;
}

/**
 * Combined signup gate: env flag OR first-run. Both the signup endpoint
 * and the `/auth/signup-status` probe consult this so the SPA and server
 * agree on when signup is available.
 */
export async function isSignupAvailable(
  pool: Pool,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ available: boolean; firstRun: boolean }> {
  const firstRun = await isFirstRun(pool);
  return { available: isSignupEnabled(env) || firstRun, firstRun };
}

const USERNAME_PATTERN = /^[a-zA-Z0-9_-]{3,32}$/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface SignupContext {
  pool: Pool;
  home: string;
  vault?: VaultStore;
  env?: NodeJS.ProcessEnv;
}

/**
 * Combined signup endpoint. The wizard collects account credentials,
 * an optional first room, and (optionally) a vault password through
 * three local steps and submits them in a single request — nothing
 * lands in the DB or on disk until the user reaches the end of the
 * wizard.
 *
 * Previously the SPA hit /auth/signup after step 1, which left an
 * orphan user + hub on disk every time someone abandoned the wizard
 * mid-flow. Those orphans would then collide with the same username
 * on a retry, so over time a few abandoned signups could lock out the
 * username space entirely. Deferring all writes to the final step
 * fixes that: if the user walks away, the DB is untouched.
 *
 * Everything past the user insert is best-effort within this call but
 * rolled back together on hard failure (e.g. issueSession). Vault
 * setup failures roll back the user too — the wizard already promised
 * the user that their credentials would be encrypted, so committing
 * the account without the vault would surface as a vault-gate prompt
 * immediately after onboarding (exactly what this redesign is meant
 * to avoid). Room creation is best-effort: a slug collision on the
 * optional first room shouldn't undo the account itself.
 */
export async function handleSignup(
  ctx: SignupContext,
  body: {
    username?: unknown;
    email?: unknown;
    password?: unknown;
    vaultPassword?: unknown;
    workspace?: unknown;
  },
): Promise<{ token: string }> {
  const env = ctx.env ?? process.env;
  const { available } = await isSignupAvailable(ctx.pool, env);
  if (!available) {
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

  const vaultPassword = parseOptionalVaultPassword(body.vaultPassword);
  const workspace = parseOptionalWorkspace(body.workspace);

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

  // Roll back the just-inserted user row when a downstream step
  // fails. FK cascades remove the hub workspace and any sessions
  // we minted along the way; the optional vault file we delete
  // explicitly because it lives outside SQLite.
  const rollback = async (reason: string, err: unknown): Promise<void> => {
    try {
      if (ctx.vault) {
        await ctx.vault.destroy(id).catch(() => {});
      }
      await ctx.pool.query("DELETE FROM users WHERE id = ?", [id]);
    } catch (rollbackErr) {
      log.warn(
        { id, username, reason, err: (rollbackErr as Error).message },
        "signup: rollback after partial failure left state behind",
      );
    }
    log.warn(
      { id, username, reason, err: (err as Error).message },
      "signup: rolled back partial account after failure",
    );
  };

  // Mint the session first — that and the user row are the two pieces
  // the client absolutely needs to recover. If session issuance
  // throws (DB hiccup, exhausted entropy, …) we roll back the user
  // insert so a retry isn't blocked by a 409.
  let token: string;
  try {
    token = await issueSession(ctx.pool, id);
  } catch (err) {
    await rollback("issueSession", err);
    throw err;
  }

  // Hub is the landing surface — without it the SPA lands on "No
  // workspaces" right after the redirect. Best-effort: a slug
  // collision in the hub layer shouldn't undo the account.
  try {
    await createHub(ctx.pool, ctx.home, id, username);
  } catch (err) {
    log.warn({ username, err: (err as Error).message }, "signup: hub-creation failed");
  }

  // Optional first room. The wizard's "Add a room" step is skippable;
  // when present, we treat it like any other workspace create call.
  // Best-effort: a name collision or validation problem on the room
  // shouldn't undo the user, since the SPA can still recover (the
  // hub workspace is sufficient to land in the app).
  if (workspace) {
    try {
      await createWorkspace(ctx.pool, id, ctx.home, workspace);
    } catch (err) {
      log.warn(
        { username, err: (err as Error).message },
        "signup: optional room creation failed (account kept)",
      );
    }
  }

  // Vault setup happens inline when the wizard collected a password —
  // a failure here is severe enough to roll the user back, because
  // the wizard already committed the user to encrypting their
  // credentials and the next thing they'd see otherwise is the
  // VaultGate prompt the wizard was redesigned to absorb.
  if (vaultPassword !== undefined) {
    if (!ctx.vault) {
      await rollback("vault-not-configured", new Error("vault not configured"));
      throw new ValidationError(
        "Vault setup requested but the server has no vault configured",
      );
    }
    try {
      const status = await ctx.vault.status(id);
      if (status.exists) {
        // Should be impossible on a fresh user, but treat it as
        // success rather than 409 — we'd rather not surface a vault
        // race to the user mid-wizard.
        log.warn({ id }, "signup: vault already existed for fresh user; skipping setup");
      } else {
        await ctx.vault.setup(id, vaultPassword);
      }
    } catch (err) {
      await rollback("vault-setup", err);
      throw err;
    }
  }

  // When no vaultPassword is provided the per-user vault simply
  // doesn't exist yet — the VaultDialog owns first-time setup later.
  // DESK_VAULT_PASSWORD still drives boot-time auto-unlock for
  // pre-existing vaults (so dev/CI restarts don't lose state).

  return { token };
}

function parseOptionalVaultPassword(raw: unknown): string | undefined {
  if (raw === undefined || raw === null || raw === "") return undefined;
  if (typeof raw !== "string") {
    throw new ValidationError("Vault password must be a string");
  }
  // Reuse the same policy /vault/setup enforces (12-char minimum,
  // rejects the documented seed password) so the wizard can't slip a
  // weaker password through the combined endpoint than a manual
  // vault setup would accept.
  enforcePasswordPolicy(raw);
  return raw;
}

interface ParsedWorkspace {
  name: string;
  description?: string;
  color?: string;
}

function parseOptionalWorkspace(raw: unknown): ParsedWorkspace | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "object") {
    throw new ValidationError("workspace must be an object");
  }
  const obj = raw as Record<string, unknown>;
  const name = typeof obj.name === "string" ? obj.name.trim() : "";
  if (name.length === 0) {
    // The wizard's "skip room" path submits no workspace key at all;
    // an empty-name object is treated as skip rather than rejected.
    return undefined;
  }
  const out: ParsedWorkspace = { name };
  if (typeof obj.description === "string" && obj.description.trim().length > 0) {
    out.description = obj.description.trim();
  }
  if (typeof obj.color === "string" && obj.color.trim().length > 0) {
    out.color = obj.color.trim();
  }
  return out;
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
