/**
 * Settings → Connections → Local sources.
 *
 * Local sources are model providers Desk auto-detects on the host (Codex
 * today; LM Studio, Ollama, … later). The user opt-ins via /me/providers/local
 * and Desk forwards the source's env vars (PI_AUTH_JSON_BASE64 for Codex,
 * base URLs for HTTP servers) into every sandbox exec.
 *
 * This spec drives the API end of the contract. The picker/detail UI is
 * covered separately by component tests; here we verify the wire format
 * tolerates a Codex auth file going missing/being restored, and that
 * opt-in is durable.
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

  test("end-to-end: detect, enable, list, disable", async ({
    serverUrl,
    token,
    codexAuthPath,
  }) => {
    await fsp.writeFile(codexAuthPath, writeAuthFile({ email: "alice@example.com", plan: "pro" }));
    const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

    // GET surfaces the source.
    const detected = await fetch(`${serverUrl}/me/providers/local`, { headers })
      .then((r) => r.json()) as { sources: Array<{ kind: string; available: boolean; enabled: boolean; detail?: Record<string, unknown> }> };
    const codex = detected.sources.find((s) => s.kind === "codex")!;
    expect(codex.available).toBe(true);
    expect(codex.enabled).toBe(false);
    expect(codex.detail?.email).toBe("alice@example.com");
    expect(codex.detail?.plan).toBe("pro");
    expect(typeof codex.detail?.expiresAt).toBe("number");

    // PUT enables.
    const enabled = await fetch(`${serverUrl}/me/providers/local/codex`, {
      method: "PUT",
      headers,
      body: JSON.stringify({ enabled: true }),
    }).then((r) => r.json()) as { enabled: boolean };
    expect(enabled.enabled).toBe(true);

    // GET roundtrips.
    const after = await fetch(`${serverUrl}/me/providers/local`, { headers })
      .then((r) => r.json()) as { sources: Array<{ kind: string; enabled: boolean }> };
    expect(after.sources.find((s) => s.kind === "codex")!.enabled).toBe(true);

    // Removing the host file flips available without losing opt-in — the
    // user said "use Codex when it's there", so we keep enabled=true.
    await fsp.rm(codexAuthPath, { force: true });
    const stillEnabled = await fetch(`${serverUrl}/me/providers/local`, { headers })
      .then((r) => r.json()) as { sources: Array<{ kind: string; available: boolean; enabled: boolean; reason?: string }> };
    const after2 = stillEnabled.sources.find((s) => s.kind === "codex")!;
    expect(after2.available).toBe(false);
    expect(after2.enabled).toBe(true);
    expect(after2.reason).toBe("missing");

    // Restoring the file makes the source usable again immediately.
    await fsp.writeFile(codexAuthPath, writeAuthFile());
    const restored = await fetch(`${serverUrl}/me/providers/local`, { headers })
      .then((r) => r.json()) as { sources: Array<{ kind: string; available: boolean; enabled: boolean }> };
    const after3 = restored.sources.find((s) => s.kind === "codex")!;
    expect(after3.available).toBe(true);
    expect(after3.enabled).toBe(true);

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
