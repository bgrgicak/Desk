import { describe, it, expect, beforeEach } from "vitest";
import {
  _clearOAuthFlows,
  _oauthFlowCount,
  beginOAuthFlow,
  consumeFlowState,
  validateReturnedScopes,
} from "../src/oauth/framework.js";

beforeEach(() => {
  _clearOAuthFlows();
});

describe("OAuth framework — beginOAuthFlow + consumeFlowState", () => {
  it("issues a unique state + S256 challenge and stores the flow", () => {
    const r1 = beginOAuthFlow({
      userId: "usr_alice",
      providerId: "google-drive",
      redirectUri: "https://example.com/oauth/cb",
      allowedRedirectUris: ["https://example.com/oauth/cb"],
      scopes: ["drive.readonly"],
    });
    expect(r1.state).toHaveLength(32);
    expect(r1.codeChallengeMethod).toBe("S256");
    expect(r1.codeChallenge).toHaveLength(43); // base64url SHA-256
    expect(r1.codeVerifier.length).toBeGreaterThan(40);
    expect(_oauthFlowCount()).toBe(1);

    // Different invocations get distinct state values (entropy check).
    const r2 = beginOAuthFlow({
      userId: "usr_alice",
      providerId: "google-drive",
      redirectUri: "https://example.com/oauth/cb",
      allowedRedirectUris: ["https://example.com/oauth/cb"],
      scopes: ["drive.readonly"],
    });
    expect(r2.state).not.toEqual(r1.state);
  });

  it("refuses a redirect_uri that isn't in the allowlist", () => {
    expect(() =>
      beginOAuthFlow({
        userId: "usr_alice",
        providerId: "google-drive",
        redirectUri: "https://attacker.example/cb",
        allowedRedirectUris: ["https://example.com/oauth/cb"],
        scopes: ["drive.readonly"],
      }),
    ).toThrow(/not in the allowlist/);
  });

  it("consumeFlowState returns the record for the matching user + clears it", () => {
    const r = beginOAuthFlow({
      userId: "usr_alice",
      providerId: "google-drive",
      redirectUri: "https://example.com/oauth/cb",
      allowedRedirectUris: ["https://example.com/oauth/cb"],
      scopes: ["drive.readonly", "drive.metadata"],
    });
    const consumed = consumeFlowState(r.state, "usr_alice");
    expect(consumed?.userId).toBe("usr_alice");
    expect(consumed?.providerId).toBe("google-drive");
    expect(consumed?.scopes).toEqual(["drive.readonly", "drive.metadata"]);
    // Single-use — re-consuming the same state returns null.
    expect(consumeFlowState(r.state, "usr_alice")).toBeNull();
  });

  it("consumeFlowState refuses a state owned by a different user (CSRF)", () => {
    const r = beginOAuthFlow({
      userId: "usr_alice",
      providerId: "google-drive",
      redirectUri: "https://example.com/oauth/cb",
      allowedRedirectUris: ["https://example.com/oauth/cb"],
      scopes: ["drive.readonly"],
    });
    // An attacker who got the state value can't redeem it against
    // their own session.
    expect(consumeFlowState(r.state, "usr_eve")).toBeNull();
    // Even after the failed attempt the legitimate consumer must
    // still be able to redeem — the failed attempt MUST consume the
    // state regardless to prevent enumeration.
    expect(consumeFlowState(r.state, "usr_alice")).toBeNull();
  });

  it("consumeFlowState returns null for an unknown state", () => {
    expect(consumeFlowState("totally-fake", "usr_alice")).toBeNull();
  });
});

describe("OAuth framework — validateReturnedScopes", () => {
  it("accepts when upstream returns a subset of requested scopes", () => {
    const r = validateReturnedScopes(["drive.readonly", "drive.metadata"], ["drive.readonly"]);
    expect(r.ok).toBe(true);
    expect(r.unexpected).toEqual([]);
  });

  it("rejects when upstream returns a scope the integration didn't ask for", () => {
    const r = validateReturnedScopes(["drive.readonly"], ["drive.readonly", "drive.file"]);
    expect(r.ok).toBe(false);
    expect(r.unexpected).toEqual(["drive.file"]);
  });

  it("accepts an empty returned set", () => {
    expect(validateReturnedScopes(["drive.readonly"], []).ok).toBe(true);
  });
});
