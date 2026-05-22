import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  LOCAL_SOURCES,
  LOCAL_SOURCE_KINDS,
  detectLocalSource,
  loadLocalSourceEnv,
  listLocalSourceStatuses,
} from "../src/localSources/index.js";
import { defaultCodexAuthPath } from "../src/localSources/codex.js";

function jwt(claims: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  return `${header}.${payload}.fake-signature`;
}

let tmpDir: string;
let authPath: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "desk-local-sources-"));
  authPath = path.join(tmpDir, "auth.json");
  process.env.DESK_CODEX_AUTH_PATH = authPath;
});
afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.DESK_CODEX_AUTH_PATH;
});

describe("registry", () => {
  it("registers Codex under its kind", () => {
    expect(LOCAL_SOURCE_KINDS).toContain("codex");
    expect(LOCAL_SOURCES.codex).toBeDefined();
    expect(LOCAL_SOURCES.codex.kind).toBe("codex");
  });

  it("listLocalSourceStatuses runs every detector", () => {
    const all = listLocalSourceStatuses();
    expect(all.length).toBe(LOCAL_SOURCE_KINDS.length);
    expect(all.map((s) => s.kind).sort()).toEqual([...LOCAL_SOURCE_KINDS].sort());
  });
});

describe("Codex local source", () => {
  it("defaultCodexAuthPath honors DESK_CODEX_AUTH_PATH override", () => {
    expect(defaultCodexAuthPath()).toBe(authPath);
  });

  it("detect() returns missing when the file does not exist", () => {
    const status = detectLocalSource("codex");
    expect(status?.kind).toBe("codex");
    expect(status?.available).toBe(false);
    expect(status?.reason).toBe("missing");
  });

  it("detect() surfaces email/plan/expiresAt when the host file is good", () => {
    const exp = Math.floor(Date.now() / 1000) + 3600;
    fs.writeFileSync(authPath, JSON.stringify({
      auth_mode: "chatgpt",
      tokens: {
        id_token: jwt({
          "https://api.openai.com/profile": { email: "user@example.com", email_verified: true },
          "https://api.openai.com/auth": { chatgpt_account_id: "acct-1", chatgpt_plan_type: "pro" },
        }),
        access_token: jwt({ exp }),
        refresh_token: "rt_xxx",
        account_id: "acct-1",
      },
    }));
    const status = detectLocalSource("codex");
    expect(status?.available).toBe(true);
    expect(status?.detail).toEqual({ email: "user@example.com", plan: "pro", expiresAt: exp * 1000 });
  });

  it("detect() reports wrong_mode when not in chatgpt mode", () => {
    fs.writeFileSync(authPath, JSON.stringify({ auth_mode: "apikey" }));
    expect(detectLocalSource("codex")?.reason).toBe("wrong_mode");
  });

  it("detect() reports no_tokens when access_token / refresh_token are missing", () => {
    fs.writeFileSync(authPath, JSON.stringify({
      auth_mode: "chatgpt",
      tokens: { access_token: "x" },
    }));
    expect(detectLocalSource("codex")?.reason).toBe("no_tokens");
  });

  it("loadEnv() emits OPENCODE_AUTH_CONTENT in OpenCode auth-blob format", () => {
    const exp = Math.floor(Date.now() / 1000) + 3600;
    const access = jwt({ exp });
    fs.writeFileSync(authPath, JSON.stringify({
      auth_mode: "chatgpt",
      tokens: {
        id_token: jwt({ "https://api.openai.com/auth": { chatgpt_account_id: "acct-7" } }),
        access_token: access,
        refresh_token: "rt_yyy",
        account_id: "acct-7",
      },
    }));
    const env = loadLocalSourceEnv("codex");
    expect(env).not.toBeNull();
    const blob = JSON.parse(env!.OPENCODE_AUTH_CONTENT);
    expect(blob.openai.type).toBe("oauth");
    expect(blob.openai.refresh).toBe("rt_yyy");
    expect(blob.openai.access).toBe(access);
    expect(blob.openai.accountId).toBe("acct-7");
    expect(blob.openai.expires).toBe(exp * 1000);
  });

  it("loadEnv() returns null when the host file is missing or incomplete", () => {
    expect(loadLocalSourceEnv("codex")).toBeNull();
    fs.writeFileSync(authPath, JSON.stringify({
      auth_mode: "chatgpt",
      tokens: { access_token: "x" },
    }));
    expect(loadLocalSourceEnv("codex")).toBeNull();
  });

  it("loadEnv() falls back to id_token claims for accountId when account_id is absent", () => {
    const access = jwt({ exp: Math.floor(Date.now() / 1000) + 3600 });
    const idToken = jwt({ "https://api.openai.com/auth": { chatgpt_account_id: "acct-from-id" } });
    fs.writeFileSync(authPath, JSON.stringify({
      auth_mode: "chatgpt",
      tokens: { id_token: idToken, access_token: access, refresh_token: "rt_z" },
    }));
    const blob = JSON.parse(loadLocalSourceEnv("codex")!.OPENCODE_AUTH_CONTENT);
    expect(blob.openai.accountId).toBe("acct-from-id");
  });

  it("loadEnv() falls back to organizations[].id when no chatgpt_account_id claim is present", () => {
    const access = jwt({ exp: Math.floor(Date.now() / 1000) + 3600 });
    const idToken = jwt({ organizations: [{ id: "org-default", is_default: true }] });
    fs.writeFileSync(authPath, JSON.stringify({
      auth_mode: "chatgpt",
      tokens: { id_token: idToken, access_token: access, refresh_token: "rt_z" },
    }));
    const blob = JSON.parse(loadLocalSourceEnv("codex")!.OPENCODE_AUTH_CONTENT);
    expect(blob.openai.accountId).toBe("org-default");
  });

  it("loadEnv() also emits PI_AUTH_JSON_BASE64 in pi's openai-codex shape", () => {
    const access = jwt({ exp: Math.floor(Date.now() / 1000) + 3600 });
    fs.writeFileSync(authPath, JSON.stringify({
      auth_mode: "chatgpt",
      tokens: {
        access_token: access,
        refresh_token: "rt_pi",
        account_id: "acct_pi_123",
      },
    }));
    const env = loadLocalSourceEnv("codex")!;
    expect(env.PI_AUTH_JSON_BASE64).toBeTruthy();
    const decoded = Buffer.from(env.PI_AUTH_JSON_BASE64, "base64").toString("utf8");
    const parsed = JSON.parse(decoded);
    // Pi looks up the OAuth provider by id `openai-codex`. The shape
    // mirrors what pi's `oauth/openai-codex.js` writes after a real
    // /login flow: {type: "oauth", access, refresh, accountId, expires}.
    expect(parsed["openai-codex"].type).toBe("oauth");
    expect(parsed["openai-codex"].access).toBe(access);
    expect(parsed["openai-codex"].refresh).toBe("rt_pi");
    expect(parsed["openai-codex"].accountId).toBe("acct_pi_123");
    expect(typeof parsed["openai-codex"].expires).toBe("number");
    // The two blobs are semantically equivalent — Codex auth, same
    // tokens — but the provider-id key and the absence of `id_token`
    // are what differ between the opencode-serve daemon path and pi.
    const opencodeBlob = JSON.parse(env.OPENCODE_AUTH_CONTENT);
    expect(opencodeBlob.openai.access).toBe(parsed["openai-codex"].access);
    expect(opencodeBlob.openai.refresh).toBe(parsed["openai-codex"].refresh);
  });
});
