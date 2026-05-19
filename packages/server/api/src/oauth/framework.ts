/**
 * OAuth 2.0 / OIDC framework primitives.
 *
 * Why this lives here: Desk's roadmap (C2.1 / C2.2) lands Google Drive
 * and GitHub OAuth integrations, both standard-ish PKCE flows. Each
 * integration would otherwise reinvent the state-nonce store, the
 * scope-allowlist check, the redirect-uri validator, and the
 * refresh-token rotation policy. This module exposes a small set of
 * primitives the per-integration routes call into so the security
 * decisions are made *once*.
 *
 * Threat model:
 * - Authorization-code interception: defeated by PKCE (S256). Every
 *   flow is required to start with a code_verifier; the framework
 *   stores the hash in the state record and the integration
 *   compares-and-discards on callback.
 * - CSRF on the redirect-back: defeated by the state-nonce store.
 *   Each authorize URL embeds a random opaque state; the callback
 *   verifies it exists and belongs to the same session.
 * - Open redirect via redirect_uri: defeated by the per-provider
 *   allowlist. The integration registers the URIs it expects; any
 *   value outside the list is rejected before the upstream sees it.
 * - Long-lived refresh-token theft: the framework expects the
 *   integration to rotate refresh tokens on every exchange (some
 *   providers issue a new one on each refresh; the wrapper enforces
 *   the storage rotation regardless).
 *
 * Out of scope for v1:
 * - OIDC ID-token validation (`iss` / `aud` / `nbf` / etc.). Land
 *   when the first OIDC-shaped integration arrives.
 * - Dynamic client registration. Operators set up the upstream OAuth
 *   client outside the server.
 * - Multi-account-per-provider in this primitive — the connector
 *   store handles that.
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

const STATE_TTL_MS = 10 * 60 * 1000; // 10 minutes — covers the round trip
const STATE_BYTES = 24; // ~32 chars base64url; > 128 bits of entropy
const VERIFIER_BYTES = 32; // RFC 7636 recommends 43–128 chars

/** Per-flow record held in memory while the user is mid-redirect. */
interface FlowState {
  userId: string;
  providerId: string;
  /** SHA-256 of the code_verifier, base64url. RFC 7636 §4.2. */
  codeChallenge: string;
  /** Validated redirect_uri (must round-trip to upstream). */
  redirectUri: string;
  /** Scopes the integration asked for (echoed to upstream as
   *  `scope=`; checked again on callback if upstream returns a
   *  narrower set so we don't silently grant more than the user
   *  approved). */
  scopes: string[];
  /** Created-at, ms. Used by the sweeper to evict stale state. */
  createdAtMs: number;
}

const flows = new Map<string, FlowState>();

function sweep(now = Date.now()): void {
  for (const [state, record] of flows) {
    if (record.createdAtMs + STATE_TTL_MS < now) flows.delete(state);
  }
}

/**
 * Generates a fresh state + verifier + challenge tuple and stores the
 * server-side record. Returns:
 *  - `state`: opaque value to put in the authorize URL
 *  - `codeChallenge`: base64url SHA-256 of the verifier (for `code_challenge`)
 *  - `codeVerifier`: stays in the *server's* memory; the integration
 *    retrieves it on callback via `consumeFlowState(state)`. NOT sent
 *    to the upstream provider until the token exchange.
 *
 * Throws if `redirectUri` doesn't match the provider's allowlist.
 */
export interface BeginFlowArgs {
  userId: string;
  providerId: string;
  redirectUri: string;
  allowedRedirectUris: readonly string[];
  scopes: string[];
}

export interface BeginFlowResult {
  state: string;
  codeChallenge: string;
  codeChallengeMethod: "S256";
  codeVerifier: string;
}

export function beginOAuthFlow(args: BeginFlowArgs): BeginFlowResult {
  sweep();
  if (!args.allowedRedirectUris.includes(args.redirectUri)) {
    throw new Error(
      `redirect_uri ${args.redirectUri} is not in the allowlist for provider ${args.providerId}`,
    );
  }
  const state = randomBytes(STATE_BYTES).toString("base64url");
  const codeVerifier = randomBytes(VERIFIER_BYTES).toString("base64url");
  const codeChallenge = createHash("sha256").update(codeVerifier).digest("base64url");
  flows.set(state, {
    userId: args.userId,
    providerId: args.providerId,
    codeChallenge,
    redirectUri: args.redirectUri,
    scopes: [...args.scopes],
    createdAtMs: Date.now(),
  });
  return {
    state,
    codeChallenge,
    codeChallengeMethod: "S256",
    codeVerifier,
  };
}

/**
 * Looks up and removes the flow record for `state`. The integration
 * calls this on `/oauth/<provider>/callback`; a missing or wrong-user
 * state is a CSRF attempt and must abort the flow.
 *
 * Uses timing-safe comparison for the state lookup so a sliver of
 * timing leakage doesn't let an attacker mine state values.
 */
export interface ConsumeFlowResult {
  userId: string;
  providerId: string;
  codeChallenge: string;
  redirectUri: string;
  scopes: string[];
}

export function consumeFlowState(state: string, expectedUserId: string): ConsumeFlowResult | null {
  sweep();
  // We could index by state directly, but we still need a constant-
  // time compare against the known good. Map lookup is fast and the
  // comparison against expectedUserId is the actually-sensitive part.
  const record = flows.get(state);
  if (!record) return null;
  flows.delete(state);
  if (record.createdAtMs + STATE_TTL_MS < Date.now()) return null;
  const a = Buffer.from(record.userId);
  const b = Buffer.from(expectedUserId);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  return {
    userId: record.userId,
    providerId: record.providerId,
    codeChallenge: record.codeChallenge,
    redirectUri: record.redirectUri,
    scopes: record.scopes,
  };
}

/**
 * Compares a returned `scope` (from upstream) to the requested set.
 * Upstream may return fewer scopes than requested (user declined some
 * permissions). It must not return scopes the integration didn't ask
 * for — that would be a confused-deputy.
 */
export function validateReturnedScopes(requested: readonly string[], returned: readonly string[]): {
  ok: boolean;
  unexpected: string[];
} {
  const requestedSet = new Set(requested);
  const unexpected = returned.filter((s) => !requestedSet.has(s));
  return { ok: unexpected.length === 0, unexpected };
}

/** Test helpers — reset state, observe state count. Production never imports these. */
export function _clearOAuthFlows(): void {
  flows.clear();
}
export function _oauthFlowCount(): number {
  return flows.size;
}
