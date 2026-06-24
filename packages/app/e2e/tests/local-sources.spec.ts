/**
 * Settings → Connections → Local sources.
 *
 * Local sources are model providers Roomy can auto-detect on the host (Codex
 * today; LM Studio, Ollama, ... later). Host detection is deployment-gated; by
 * default Roomy should fail closed even when a Codex auth file is readable.
 *
 * This spec drives the API end of the contract. The picker/detail UI is
 * covered separately by component tests; here we verify the wire format
 * keeps the opt-in toggle durable without making the host source available
 * unless the server has explicitly enabled host-local-source admission.
 */
import * as fsp from "node:fs/promises";
import { test, expect } from "../fixtures";

function jwt(claims: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  return `${header}.${payload}.fake-signature`;
}

function writeAuthFile(opts: { email?: string; plan?: string } = {}): string {
  const exp = Math.floor(Date.now() / 1000) + 3600;
  return JSON.stringify({
    auth_mode: "chatgpt",
    OPENAI_API_KEY: null,
    tokens: {
      id_token: jwt({
        "https://api.openai.com/profile": {
          email: opts.email ?? "alice@example.com",
          email_verified: true,
        },
        "https://api.openai.com/auth": {
          chatgpt_account_id: "acct-e2e",
          chatgpt_plan_type: opts.plan ?? "pro",
        },
      }),
      access_token: jwt({ exp }),
      refresh_token: "rt-e2e",
      account_id: "acct-e2e",
    },
  });
}

test.describe("local sources — Codex", () => {
  test.beforeEach(async ({ codexAuthPath }) => {
    await fsp.rm(codexAuthPath, { force: true });
  });

  test("end-to-end: host Codex source fails closed by policy", async ({
    serverUrl,
    token,
    codexAuthPath,
  }) => {
    await fsp.writeFile(codexAuthPath, writeAuthFile({ email: "alice@example.com", plan: "pro" }));
    const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

    // GET does not surface host identity by default, even when the auth file exists.
    const detected = await fetch(`${serverUrl}/me/providers/local`, { headers })
      .then((r) => r.json()) as { sources: Array<{ kind: string; available: boolean; enabled: boolean; reason?: string; detail?: Record<string, unknown> }> };
    const codex = detected.sources.find((s) => s.kind === "codex")!;
    expect(codex.available).toBe(false);
    expect(codex.enabled).toBe(false);
    expect(codex.reason).toBe("disabled_by_policy");
    expect(codex.detail).toBeUndefined();

    // PUT still records the user's opt-in, but the host source remains unavailable.
    const enabled = await fetch(`${serverUrl}/me/providers/local/codex`, {
      method: "PUT",
      headers,
      body: JSON.stringify({ enabled: true }),
    }).then((r) => r.json()) as { enabled: boolean; available: boolean; reason?: string };
    expect(enabled.enabled).toBe(true);
    expect(enabled.available).toBe(false);
    expect(enabled.reason).toBe("disabled_by_policy");

    // GET roundtrips.
    const after = await fetch(`${serverUrl}/me/providers/local`, { headers })
      .then((r) => r.json()) as { sources: Array<{ kind: string; available: boolean; enabled: boolean; reason?: string }> };
    const after2 = after.sources.find((s) => s.kind === "codex")!;
    expect(after2.available).toBe(false);
    expect(after2.enabled).toBe(true);
    expect(after2.reason).toBe("disabled_by_policy");

    // PUT disables.
    const disabled = await fetch(`${serverUrl}/me/providers/local/codex`, {
      method: "PUT",
      headers,
      body: JSON.stringify({ enabled: false }),
    }).then((r) => r.json()) as { enabled: boolean };
    expect(disabled.enabled).toBe(false);
  });

  test("PUT to an unknown kind returns 404", async ({ serverUrl, token }) => {
    const res = await fetch(`${serverUrl}/me/providers/local/lm-studio`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: true }),
    });
    expect(res.status).toBe(404);
  });
});
