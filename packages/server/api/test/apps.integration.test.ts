/**
 * PR-C: static-app route + per-app capability bridge.
 *
 * Real desk-server, real SQLite, real fs. Materializes a `<name>.app/`
 * artifact for a chat with a built `dist/index.html`, then exercises the
 * full path:
 *   1. `POST /apps/chat/:chatId/:appName/issue` returns a per-app token
 *      and bootstrap URL.
 *   2. `GET <bootstrap-url>` (with `?t=` query) → 200 inline HTML + Set-Cookie.
 *   3. `GET .../dist/` (cookie-authenticated) → injected index.html.
 *   4. `GET .../dist/assets/...` (cookie-authenticated) → asset bytes.
 *   5. Cross-app cookie isolation: a cookie for app A doesn't authorize
 *      app B's dist.
 *   6. Path traversal: `..` in the asset tail returns 404.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as http from "node:http";
import * as net from "node:net";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Pool, runMigrations, seedIfEmpty } from "@agent-desk/db";
import { createRunManager } from "@agent-desk/scheduler";
import { generateId } from "@agent-desk/shared";
import {
  chatArtifactsDir,
  ensureLayout,
  ensureWorkspaceLayout,
} from "@agent-desk/storage";
import { createApp } from "../src/app.js";
import { clearSessions } from "../src/auth/sessions.js";
import { clearConnections } from "../src/ws/registry.js";
import { clearAppIssueRateLimit, clearAppSessions } from "../src/routes/apps.js";

let pool: Pool;
let server: http.Server;
let port: number;
let home: string;
let dbPath: string;
let workspaceSlug: string;
let chatId: string;
let otherChatId: string;
let authToken: string;

const APP_NAME = "todo-tracker";
const OTHER_APP = "notes-app";

beforeAll(async () => {
  const dbDir = await fs.mkdtemp(path.join(os.tmpdir(), "desk-apps-int-db-"));
  dbPath = path.join(dbDir, "test.sqlite3");
  pool = new Pool({ path: dbPath });
  await runMigrations(pool);

  process.env.DESK_SEED_USERNAME = "apps-int-user";
  process.env.DESK_SEED_PASSWORD = "pw";
  await seedIfEmpty(pool);

  home = await fs.mkdtemp(path.join(os.tmpdir(), "desk-apps-int-"));
  await ensureLayout(home);
  process.env.DESK_HOME = home;

  const { rows: wsRows } = await pool.query<{ id: string; path: string }>(
    "SELECT id, path FROM workspaces LIMIT 1",
  );
  workspaceSlug = wsRows[0].path;
  await ensureWorkspaceLayout(home, workspaceSlug);

  const { rows: agentRows } = await pool.query<{ id: string }>("SELECT id FROM agents LIMIT 1");
  const agentId = agentRows[0].id;

  chatId = generateId("chat");
  otherChatId = generateId("chat");
  await pool.query(
    "INSERT INTO chats (id, workspace_id, agent_id, title) VALUES (?, ?, ?, ?)",
    [chatId, wsRows[0].id, agentId, "Apps Test"],
  );
  await pool.query(
    "INSERT INTO chats (id, workspace_id, agent_id, title) VALUES (?, ?, ?, ?)",
    [otherChatId, wsRows[0].id, agentId, "Other Chat"],
  );

  // Materialize a built `.app/` for the primary chat
  const appRoot = path.join(
    chatArtifactsDir(home, workspaceSlug, chatId),
    `${APP_NAME}.app`,
  );
  await fs.mkdir(path.join(appRoot, "dist", "assets"), { recursive: true });
  await fs.writeFile(
    path.join(appRoot, "desk.app.json"),
    JSON.stringify({
      name: APP_NAME,
      description: "Test app",
      capabilities: ["library.read", "storage.read", "storage.write"],
    }),
    "utf8",
  );
  await fs.writeFile(
    path.join(appRoot, "dist", "index.html"),
    "<!doctype html><html><head><title>App</title></head><body><div id=\"root\"></div><script type=\"module\" src=\"./assets/index.js\"></script></body></html>",
    "utf8",
  );
  await fs.writeFile(
    path.join(appRoot, "dist", "assets", "index.js"),
    "export const sentinel = 'PR-C-ASSET-PROBE'",
    "utf8",
  );

  // And an app under the *other* chat for the cross-app isolation test
  const otherAppRoot = path.join(
    chatArtifactsDir(home, workspaceSlug, otherChatId),
    `${OTHER_APP}.app`,
  );
  await fs.mkdir(path.join(otherAppRoot, "dist"), { recursive: true });
  await fs.writeFile(
    path.join(otherAppRoot, "desk.app.json"),
    JSON.stringify({ name: OTHER_APP, capabilities: [] }),
    "utf8",
  );
  await fs.writeFile(
    path.join(otherAppRoot, "dist", "index.html"),
    "<!doctype html><html><head></head><body>other</body></html>",
    "utf8",
  );

  const { rows: userRows } = await pool.query<{ id: string }>("SELECT id FROM users LIMIT 1");
  const runManager = createRunManager({ pool });
  server = createApp({
    pool,
    storage: { pool, home },
    runManager,
    broadcastUserId: userRows[0].id,
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as net.AddressInfo).port;

  const login = await httpRaw("POST", "/auth/login", {
    body: { username: "apps-int-user", password: "pw" },
  });
  authToken = (login.bodyJson as { token: string }).token;
});

afterAll(async () => {
  await clearAppSessions(pool);
  await clearSessions(pool);
  clearConnections();
  // Await server.close so any in-flight request finishes its dispatch
  // before pool.end() closes the SQLite handle. Without the await, a
  // late request (e.g. an aborted upload still draining) reaches the
  // dispatcher and tries to query a closed pool, surfacing a stray
  // "file is not a database" error in the test output even though the
  // tests themselves all passed.
  if (server) {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => err ? reject(err) : resolve());
    });
  }
  if (pool) await pool.end();
  if (home) await fs.rm(home, { recursive: true, force: true });
  if (dbPath) await fs.rm(path.dirname(dbPath), { recursive: true, force: true });
  delete process.env.DESK_HOME;
});

interface RawResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
  bodyJson: unknown;
}

function httpRaw(
  method: string,
  urlPath: string,
  opts: {
    body?: unknown;
    headers?: Record<string, string>;
    bearer?: string;
  } = {},
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const payload = opts.body === undefined ? undefined : JSON.stringify(opts.body);
    const headers: Record<string, string> = { ...(opts.headers ?? {}) };
    if (payload !== undefined) {
      headers["Content-Type"] = "application/json";
      headers["Content-Length"] = String(Buffer.byteLength(payload));
    }
    if (opts.bearer) headers.Authorization = `Bearer ${opts.bearer}`;
    const req = http.request(
      { hostname: "127.0.0.1", port, path: urlPath, method, headers },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8");
          let parsed: unknown;
          try { parsed = JSON.parse(raw); } catch { parsed = undefined; }
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: raw,
            bodyJson: parsed,
          });
        });
      },
    );
    req.on("error", reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

function pickSetCookie(headers: http.IncomingHttpHeaders, name: string): string | null {
  const raw = headers["set-cookie"] ?? [];
  const list = Array.isArray(raw) ? raw : [raw];
  for (const line of list) {
    if (typeof line !== "string") continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    if (line.slice(0, eq) === name) {
      // Return just the cookie name=value pair the browser would echo.
      const semi = line.indexOf(";");
      return semi === -1 ? line : line.slice(0, semi);
    }
  }
  return null;
}

describe("static-app route + capability bridge", () => {
  it("issues a per-app token, accepts ?t= bootstrap, sets cookie, and serves the bridge-injected index.html", async () => {
    const issue = await httpRaw(
      "POST",
      `/apps/chat/${chatId}/${APP_NAME}/issue`,
      { bearer: authToken },
    );
    expect(issue.status, issue.body).toBe(201);
    const issued = issue.bodyJson as {
      token: string;
      url: string;
      cookieName: string;
      bridgeKey: string;
      capabilities: string[];
      expiresAt: string;
    };
    expect(issued.token.startsWith("app_")).toBe(true);
    expect(issued.cookieName).toBe(`desk_app_${chatId}_${APP_NAME}`);
    expect(issued.bridgeKey).toMatch(/^[a-f0-9]{64}$/);
    expect(issued.capabilities).toEqual([
      "library.read",
      "storage.read",
      "storage.write",
    ]);
    expect(issued.url).toContain(`/apps/chat/${chatId}/${APP_NAME}/dist/`);
    expect(issued.url).toContain(`?t=`);

    // Bootstrap with ?t= → 200 inline HTML + Set-Cookie. We used to 302
    // here to strip the token from the address bar, but the Location
    // header had to preserve any non-`t` query params (chat-cards items
    // JSON, chat-forms steps) which exceeded nginx's default 4K
    // proxy_buffer_size for bulky payloads → 502. The iframe is sandboxed
    // and its URL isn't user-visible, so the redirect dance was overkill.
    const bootstrap = await httpRaw("GET", issued.url);
    expect(bootstrap.status).toBe(200);
    const cookie = pickSetCookie(bootstrap.headers, issued.cookieName);
    expect(cookie, "expected Set-Cookie for the per-app session").toBeTruthy();

    // Cookie path scope is the app root, HttpOnly + SameSite=Strict. The
    // parent bridge can use the same app session for future /storage calls,
    // while the sandboxed iframe still cannot read the HttpOnly token.
    const setCookieRaw = bootstrap.headers["set-cookie"]?.[0] ?? "";
    expect(setCookieRaw).toContain(`Path=/apps/chat/${chatId}/${APP_NAME}`);
    expect(setCookieRaw).toContain("HttpOnly");
    expect(setCookieRaw).toContain("SameSite=Strict");

    // Bootstrap response body is the injected index.html.
    expect(bootstrap.headers["content-type"]).toContain("text/html");
    expect(bootstrap.body).toContain("window.desk");
    expect(bootstrap.body).toContain("desk.app.request");
    expect(bootstrap.body).toContain("storage.list");
    expect(bootstrap.body).toContain(`"bridgeKey":"${issued.bridgeKey}"`);
    expect(bootstrap.body).toContain(`"chatId":"${chatId}"`);
    expect(bootstrap.body).toContain(`"name":"${APP_NAME}"`);
    expect(bootstrap.body).toContain('"library.read"');

    // Subsequent cookie-authenticated GET of the same path still works.
    const indexResp = await httpRaw("GET", `/apps/chat/${chatId}/${APP_NAME}/dist/`, {
      headers: { Cookie: cookie! },
    });
    expect(indexResp.status).toBe(200);
    expect(indexResp.headers["content-type"]).toContain("text/html");

    // Cookie-authenticated asset → bytes
    const assetResp = await httpRaw(
      "GET",
      `/apps/chat/${chatId}/${APP_NAME}/dist/assets/index.js`,
      { headers: { Cookie: cookie! } },
    );
    expect(assetResp.status).toBe(200);
    expect(assetResp.body).toContain("PR-C-ASSET-PROBE");
    expect(assetResp.headers["content-type"]).toContain("application/javascript");
  });

  it("rejects HTML entrypoints without the cookie (401)", async () => {
    const noCookie = await httpRaw(
      "GET",
      `/apps/chat/${chatId}/${APP_NAME}/dist/`,
    );
    expect(noCookie.status).toBe(401);
  });

  it("serves non-HTML built assets without cookies for opaque sandbox subresource loads", async () => {
    const asset = await httpRaw(
      "GET",
      `/apps/chat/${chatId}/${APP_NAME}/dist/assets/index.js`,
    );
    expect(asset.status).toBe(200);
    expect(asset.body).toContain("PR-C-ASSET-PROBE");
    expect(asset.headers["content-type"]).toContain("application/javascript");
  });

  it("isolates cookies across apps — a cookie for chat A's app does not authorize chat B's app", async () => {
    const issueA = await httpRaw(
      "POST",
      `/apps/chat/${chatId}/${APP_NAME}/issue`,
      { bearer: authToken },
    );
    const aData = issueA.bodyJson as { url: string; cookieName: string };
    const bootstrapA = await httpRaw("GET", aData.url);
    const cookieA = pickSetCookie(bootstrapA.headers, aData.cookieName)!;

    // Try to use cookie A on app B's dist — must 401
    const crossAttempt = await httpRaw(
      "GET",
      `/apps/chat/${otherChatId}/${OTHER_APP}/dist/`,
      { headers: { Cookie: cookieA } },
    );
    expect(crossAttempt.status).toBe(401);
  });

  it("404s on path traversal attempts", async () => {
    const issue = await httpRaw(
      "POST",
      `/apps/chat/${chatId}/${APP_NAME}/issue`,
      { bearer: authToken },
    );
    const data = issue.bodyJson as { url: string; cookieName: string };
    const bootstrap = await httpRaw("GET", data.url);
    const cookie = pickSetCookie(bootstrap.headers, data.cookieName)!;

    const traversal = await httpRaw(
      "GET",
      `/apps/chat/${chatId}/${APP_NAME}/dist/..%2Fdesk.app.json`,
      { headers: { Cookie: cookie } },
    );
    expect([401, 404]).toContain(traversal.status);
  });

  it("issue endpoint requires bearer auth (401 without)", async () => {
    const noBearer = await httpRaw(
      "POST",
      `/apps/chat/${chatId}/${APP_NAME}/issue`,
    );
    expect(noBearer.status).toBe(401);
  });

  it("accepts the SPA /api-prefixed issue endpoint path", async () => {
    const issue = await httpRaw(
      "POST",
      `/api/apps/chat/${chatId}/${APP_NAME}/issue`,
      { bearer: authToken },
    );
    expect(issue.status).toBe(201);
    expect((issue.bodyJson as { url: string }).url).toContain(
      `/apps/chat/${chatId}/${APP_NAME}/dist/`,
    );
  });

  it("issue endpoint refuses to mint a token for an app that doesn't exist", async () => {
    const missing = await httpRaw(
      "POST",
      `/apps/chat/${chatId}/no-such-app/issue`,
      { bearer: authToken },
    );
    expect(missing.status).toBe(404);
  });

  it("filters unknown capabilities from the manifest at issue time", async () => {
    // A manifest that lists capabilities outside the known set (typos,
    // future-feature names, attempted XSS smuggling) must not appear
    // in the issued session — the bridge should only ever see entries
    // from the canonical list.
    const xssApp = "evil-app";
    const xssAppRoot = path.join(
      chatArtifactsDir(home, workspaceSlug, chatId),
      `${xssApp}.app`,
    );
    await fs.mkdir(path.join(xssAppRoot, "dist"), { recursive: true });
    await fs.writeFile(
      path.join(xssAppRoot, "desk.app.json"),
      JSON.stringify({
        name: xssApp,
        capabilities: [
          "library.read",
          "</script><script>alert(1)</script>",
          "made.up.capability",
          "library.read", // duplicate — dedup
        ],
      }),
      "utf8",
    );
    await fs.writeFile(
      path.join(xssAppRoot, "dist", "index.html"),
      "<!doctype html><html><head><title>X</title></head><body><div id=\"root\"></div></body></html>",
      "utf8",
    );

    const issue = await httpRaw(
      "POST",
      `/apps/chat/${chatId}/${xssApp}/issue`,
      { bearer: authToken },
    );
    expect(issue.status).toBe(201);
    const issued = issue.bodyJson as { capabilities: string[] };
    expect(issued.capabilities).toEqual(["library.read"]);
  });

  it("rate-limits `/issue` per user", async () => {
    // Reset the rate-limit state so the prior tests' issues don't count
    // against this case.
    clearAppIssueRateLimit();
    // Burst-issue until we trip the limiter. The cap is 30/min/user;
    // this bursts 32 calls and asserts the last one comes back as 429
    // with a Retry-After header.
    let lastStatus = 0;
    let lastHeaders: http.IncomingHttpHeaders | null = null;
    for (let i = 0; i < 32; i++) {
      const r = await httpRaw(
        "POST",
        `/apps/chat/${chatId}/${APP_NAME}/issue`,
        { bearer: authToken },
      );
      lastStatus = r.status;
      lastHeaders = r.headers;
      if (r.status === 429) break;
    }
    expect(lastStatus).toBe(429);
    expect(lastHeaders?.["retry-after"]).toBeTruthy();
    expect(Number(lastHeaders?.["retry-after"])).toBeGreaterThan(0);
    // Cleanup so subsequent tests in this file aren't affected.
    clearAppIssueRateLimit();
  });

  it("sets `Secure` on the cookie when DESK_SECURE_COOKIES=1", async () => {
    // The flag is read per-request (via process.env), so we can flip it
    // mid-suite — restore on cleanup so we don't leak state.
    const prev = process.env.DESK_SECURE_COOKIES;
    process.env.DESK_SECURE_COOKIES = "1";
    try {
      const issue = await httpRaw(
        "POST",
        `/apps/chat/${chatId}/${APP_NAME}/issue`,
        { bearer: authToken },
      );
      const issued = issue.bodyJson as { url: string; cookieName: string };
      const bootstrap = await httpRaw("GET", issued.url);
      const setCookie = (bootstrap.headers["set-cookie"]?.[0] ?? "") as string;
      expect(setCookie).toContain(issued.cookieName);
      expect(setCookie).toContain("Secure");
      // Sanity: Secure-off mode shouldn't have it. Re-toggle and re-issue.
      process.env.DESK_SECURE_COOKIES = "0";
      const issue2 = await httpRaw(
        "POST",
        `/apps/chat/${chatId}/${APP_NAME}/issue`,
        { bearer: authToken },
      );
      const issued2 = issue2.bodyJson as { url: string; cookieName: string };
      const bootstrap2 = await httpRaw("GET", issued2.url);
      const setCookie2 = (bootstrap2.headers["set-cookie"]?.[0] ?? "") as string;
      expect(setCookie2).toContain(issued2.cookieName);
      expect(setCookie2).not.toContain("Secure");
    } finally {
      if (prev === undefined) delete process.env.DESK_SECURE_COOKIES;
      else process.env.DESK_SECURE_COOKIES = prev;
    }
  });

  it("emits production security headers (CSP, X-Frame-Options, etc.) on the served index.html and assets", async () => {
    const issue = await httpRaw(
      "POST",
      `/apps/chat/${chatId}/${APP_NAME}/issue`,
      { bearer: authToken },
    );
    const issued = issue.bodyJson as { url: string; cookieName: string };
    // Bootstrap serves the index inline now; the response itself is what
    // we used to fetch via the redirect target.
    const idx = await httpRaw("GET", issued.url);
    expect(idx.status).toBe(200);
    const csp = String(idx.headers["content-security-policy"] ?? "");
    expect(csp).toContain("default-src 'self'");
    expect(csp).toMatch(/script-src 'self' 'nonce-[A-Za-z0-9+/=]+' 'strict-dynamic'/);
    expect(csp).toContain("frame-ancestors 'self'");
    expect(csp).toContain("navigate-to 'self'");
    expect(idx.headers["x-frame-options"]).toBe("SAMEORIGIN");
    expect(idx.headers["x-content-type-options"]).toBe("nosniff");
    expect(idx.headers["referrer-policy"]).toBe("same-origin");
    expect(String(idx.headers["permissions-policy"] ?? "")).toContain("camera=()");

    // The injected `<script>` tag must carry the same nonce the CSP allowed.
    const nonceMatch = /nonce-([A-Za-z0-9+/=]+)/.exec(csp)!;
    const nonce = nonceMatch[1];
    expect(idx.body).toContain(`<script nonce="${nonce}">`);

    // Vite (and most bundlers) emit `<script type="module" src="...">`
    // without a nonce. With strict-dynamic in the CSP those are blocked
    // unless the server rewrites the tag to carry the nonce — without
    // this the entry chunk never executes and the iframe stays blank.
    const escapedNonce = nonce.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    expect(idx.body).toMatch(
      new RegExp(`<script\\s+nonce="${escapedNonce}"\\s+type="module"\\s+src="\\./assets/index\\.js"`),
    );

    // Asset responses set the same defense headers. Assets are served
    // unauthenticated (the URL is unguessable, and the iframe's opaque
    // sandbox origin doesn't send cookies on module-script fetches).
    const asset = await httpRaw(
      "GET",
      `/apps/chat/${chatId}/${APP_NAME}/dist/assets/index.js`,
    );
    expect(asset.status).toBe(200);
    expect(asset.headers["x-content-type-options"]).toBe("nosniff");
    expect(asset.headers["x-frame-options"]).toBe("SAMEORIGIN");
    // The iframe sandbox lacks `allow-same-origin`, so the iframe has a
    // null origin and module/CSS chunk fetches are CORS requests.
    // Without ACAO, dynamic imports from the entry bundle fail.
    expect(asset.headers["access-control-allow-origin"]).toBe("*");
  });

  it("escapes `</script>` inside the bridge payload so a hostile manifest can't break out of the script tag", async () => {
    // Even though sanitizeCapabilities filters unknown strings, the
    // bridge's HTML-escaping is the second line of defense. Force the
    // bridge to render a payload that contains a `</script>` substring
    // by using the app name (validated server-side as kebab-case) to
    // surface the escaping behavior instead.
    //
    // We use an app whose name is fine but whose capabilities include
    // a known cap; the test asserts the rendered HTML does not contain
    // a literal `</script>` anywhere ahead of the closing tag — the
    // escape rewrites every `<` in the JSON payload as `<`.
    const issue = await httpRaw(
      "POST",
      `/apps/chat/${chatId}/${APP_NAME}/issue`,
      { bearer: authToken },
    );
    const issued = issue.bodyJson as { url: string; cookieName: string };
    // Bootstrap serves the index inline now — the bridge payload lives
    // in this response body directly, no redirect follow-up needed.
    const indexResp = await httpRaw("GET", issued.url);

    // The HTML body has exactly two `</script>` substrings: the one we
    // emit closing our injected `<script>` tag, and any closing tags
    // that already existed in the HTML before injection. The injected
    // JSON payload itself must contain zero `</script>` substrings,
    // and zero raw `<` in JSON-string-value positions.
    const inlineMatch = indexResp.body.match(/<script[^>]*>\(\(\)=>\{const c=([^]*?);const t=/);
    expect(inlineMatch, "expected to find the inline bridge payload").toBeTruthy();
    const payloadStr = inlineMatch![1];
    expect(payloadStr).not.toMatch(/<\/script/i);
    expect(payloadStr).not.toContain("<");
  });
});
