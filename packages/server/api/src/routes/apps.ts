/**
 * Static-serve + capability bridge for Desk apps (issue #47, PR-C, PR-E).
 *
 * URL scheme:
 *   GET  /apps/chat/:chatId/:appName/dist/*    → serves a chat-artifact app
 *   POST /apps/chat/:chatId/:appName/issue     → mints a per-app session token
 *   GET  /apps/library/:appName/dist/*         → serves a library app (PR-E)
 *   POST /apps/library/:appName/issue          → mints a session for a library app
 *
 * Auth model:
 *   - The "issue" endpoint requires the user's bearer token and validates
 *     ownership: chat-scope verifies the user owns the chat; library-scope
 *     verifies the user owns the workspace and the `<appName>.app/`
 *     directory exists at the workspace root.
 *   - It mints an `app_sessions` row scoped to (userId, chatId|null,
 *     appName, capabilities) and returns the raw token to the parent SPA.
 *   - The parent loads the iframe at the bootstrap URL with `?t=<token>`.
 *     The first response sets a path-scoped HttpOnly cookie and redirects
 *     to the clean URL.
 *   - HTML entrypoints require that cookie and receive the injected bridge.
 *     Non-HTML built assets are served as unprivileged subresources because
 *     opaque sandbox origins do not send cookies for module-script loads.
 *
 * The iframe is rendered without `allow-same-origin`, so generated app
 * JavaScript gets an opaque origin and cannot read the parent SPA's
 * sessionStorage/localStorage or act as first-party Desk code. Privileged
 * operations go through the injected `window.desk` postMessage bridge and
 * are mediated by the parent SPA.
 */
import { createHash, randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, realpath, stat } from "node:fs/promises";
import * as path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { type Pool, queries } from "@agent-desk/db";
import {
  NotFoundError,
  UnauthorizedError,
  ValidationError,
  generateId,
} from "@agent-desk/shared";
import {
  chatArtifactsDir,
  workspaceRootPath,
  type StorageContext,
} from "@agent-desk/storage";

const APP_TOKEN_PREFIX = "app_";
const APP_TOKEN_BYTES = 32;
const APP_TOKEN_TTL_MS = 60 * 60 * 1000; // 1 hour

/**
 * Per-user rate limit on `POST /apps/.../issue`. The endpoint is bearer-
 * authed so a malicious *site* can't reach it, but a compromised SPA on
 * the user's machine could spam it. Cap at N issues per window — if a
 * legitimate UI ever needs more, the limits land here.
 */
const ISSUE_LIMIT_WINDOW_MS = 60 * 1000;       // 1 minute
const ISSUE_LIMIT_PER_WINDOW = 30;             // 30 issues / minute / user

const issueLimitTimestamps = new Map<string, number[]>();

function recordIssueAndCheck(userId: string): boolean {
  const now = Date.now();
  const windowStart = now - ISSUE_LIMIT_WINDOW_MS;
  const stamps = (issueLimitTimestamps.get(userId) ?? []).filter(
    (t) => t > windowStart,
  );
  if (stamps.length >= ISSUE_LIMIT_PER_WINDOW) {
    issueLimitTimestamps.set(userId, stamps);
    return false;
  }
  stamps.push(now);
  issueLimitTimestamps.set(userId, stamps);
  return true;
}

/** Test helper — clears the in-memory rate-limit state. */
export function clearAppIssueRateLimit(): void {
  issueLimitTimestamps.clear();
}

const APP_NAME_PATTERN = /^[a-z][a-z0-9-]{0,62}$/;

/**
 * Capability strings the bridge recognizes. Unknown capabilities in the
 * manifest are dropped silently at issue time so a malformed or hostile
 * manifest can't widen the visible capability set or smuggle markup
 * through the bridge `<script>` payload (the bridge also escapes `</` to
 * defeat `</script>` breakout — see injectBridge — but we filter here as
 * defense in depth).
 *
 * Keep this in sync with the capability list documented in the scaffold's
 * AGENTS.md and `desk.app.json` examples.
 */
const KNOWN_CAPABILITIES = new Set<string>([
  "library.read",
  "library.write",
  "chats.read",
  "chats.write",
  "storage.read",
  "storage.write",
]);

function sanitizeCapabilities(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of raw) {
    if (typeof value !== "string") continue;
    if (!KNOWN_CAPABILITIES.has(value)) continue;
    if (seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

// Mirrors the static-app MIME table; trimmed to what an app's `dist/`
// realistically ships.
const MIME_BY_EXT: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".map": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
};

function mimeFor(p: string): string {
  return MIME_BY_EXT[path.extname(p).toLowerCase()] ?? "application/octet-stream";
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function bridgeKeyFor(token: string): string {
  return createHash("sha256").update(`bridge:${token}`).digest("hex");
}

function cookieNameFor(chatId: string, appName: string): string {
  // SameSite=Strict + path scope means the per-app cookie can never be
  // sent to another app's URL space. The cookie name itself encodes the
  // scope so a fetch from the parent SPA can't accidentally pick up the
  // wrong cookie either.
  return `desk_app_${chatId}_${appName}`;
}

function libraryCookieNameFor(workspaceId: string, appName: string): string {
  return `desk_libapp_${workspaceId}_${appName}`;
}

function parseCookies(req: IncomingMessage): Record<string, string> {
  const raw = req.headers.cookie;
  if (!raw) return {};
  const out: Record<string, string> = {};
  for (const part of raw.split(";")) {
    const i = part.indexOf("=");
    if (i === -1) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}

interface AppManifest {
  name: string;
  displayName?: string;
  description?: string;
  capabilities?: string[];
}

async function readManifest(distAppDir: string): Promise<AppManifest | null> {
  // The manifest sits at the app root, NOT inside dist/. distAppDir
  // ends in `/dist`, so step back one.
  const appRoot = path.dirname(distAppDir);
  const manifestPath = path.join(appRoot, "desk.app.json");
  try {
    const raw = await readFile(manifestPath, "utf-8");
    const parsed = JSON.parse(raw) as AppManifest;
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

async function workspaceSlugForChat(pool: Pool, chatId: string): Promise<{ slug: string; workspaceId: string } | null> {
  const { rows } = await pool.query<{ path: string; workspace_id: string }>(
    "SELECT w.path, c.workspace_id FROM chats c JOIN workspaces w ON w.id = c.workspace_id WHERE c.id = ?",
    [chatId],
  );
  if (rows.length === 0) return null;
  return { slug: rows[0].path, workspaceId: rows[0].workspace_id };
}

async function ensureUserOwnsChat(
  pool: Pool,
  userId: string,
  chatId: string,
): Promise<void> {
  const { rows } = await pool.query<{ user_id: string | null }>(
    `SELECT w.user_id FROM chats c JOIN workspaces w ON w.id = c.workspace_id WHERE c.id = ?`,
    [chatId],
  );
  if (rows.length === 0) throw new NotFoundError(`Chat not found: ${chatId}`);
  if (!rows[0].user_id || rows[0].user_id !== userId) {
    throw new NotFoundError(`Chat not found: ${chatId}`);
  }
}

/**
 * Resolves the app's `dist/` path on disk for a chat-artifact app. Throws
 * NotFoundError if the chat, app directory, or dist directory is missing.
 *
 * The function also enforces the `<appName>.app/` directory naming
 * (kebab-case) and refuses to step outside the chat artifacts root via
 * symlink resolution.
 *
 * Symlink defense: `realpath` resolves the entire path including any
 * symlinks anywhere in the chain (the artifacts dir, the `<name>.app/`
 * dir itself, the `dist/` dir, or any of their parents). The post-resolve
 * `startsWith(wsRoot + path.sep)` check then ensures the final inode lives
 * under the workspace root — so a symlink pointing at /etc or another
 * workspace's data still gets rejected. We only serve out of the realpath,
 * never the symlinked path, so subsequent `path.join`s can't reintroduce
 * a `..`-style escape.
 */
export async function resolveChatAppDist(
  pool: Pool,
  storage: StorageContext,
  chatId: string,
  appName: string,
): Promise<{ distDir: string; workspaceId: string; slug: string }> {
  if (!APP_NAME_PATTERN.test(appName)) {
    throw new NotFoundError(`Unknown app: ${appName}`);
  }
  const ws = await workspaceSlugForChat(pool, chatId);
  if (!ws) throw new NotFoundError(`Chat not found: ${chatId}`);
  const artifactsRoot = chatArtifactsDir(storage.home, ws.slug, chatId);
  const appRoot = path.join(artifactsRoot, `${appName}.app`);
  const distDir = path.join(appRoot, "dist");
  const wsRoot = await realpath(workspaceRootPath(storage.home, ws.slug)).catch(() => workspaceRootPath(storage.home, ws.slug));
  let real: string;
  try {
    real = await realpath(distDir);
  } catch {
    throw new NotFoundError(`App dist not found: ${appName}.app/dist`);
  }
  if (!real.startsWith(wsRoot + path.sep) && real !== wsRoot) {
    throw new NotFoundError(`App dist not found: ${appName}.app/dist`);
  }
  return { distDir: real, workspaceId: ws.workspaceId, slug: ws.slug };
}

export interface IssueResult {
  token: string;
  expiresAt: string;
  url: string;
  cookieName: string;
  bridgeKey: string;
  capabilities: string[];
}

/**
 * Mints an `app_sessions` row for the given user/chat/app combo, derives
 * the iframe's bootstrap URL, and returns the raw token to the caller.
 * The caller is the parent SPA, which must hold the token in memory only
 * — it's never persisted client-side.
 */
export async function issueAppSession(
  pool: Pool,
  storage: StorageContext,
  userId: string,
  chatId: string,
  appName: string,
): Promise<IssueResult> {
  await ensureUserOwnsChat(pool, userId, chatId);
  const { distDir, workspaceId } = await resolveChatAppDist(
    pool,
    storage,
    chatId,
    appName,
  );

  const manifest = await readManifest(distDir);
  const capabilities = sanitizeCapabilities(manifest?.capabilities);

  const raw = randomBytes(APP_TOKEN_BYTES).toString("hex");
  const token = APP_TOKEN_PREFIX + raw;
  const expiresAt = new Date(Date.now() + APP_TOKEN_TTL_MS);
  await queries.appSessions.issue(pool, {
    id: generateId("appSession"),
    userId,
    scope: "chat",
    chatId,
    workspaceId,
    appName,
    capabilities,
    tokenHash: hashToken(token),
    expiresAt,
  });

  const url = `/apps/chat/${encodeURIComponent(chatId)}/${encodeURIComponent(appName)}/dist/?t=${encodeURIComponent(token)}`;
  return {
    token,
    expiresAt: expiresAt.toISOString(),
    url,
    cookieName: cookieNameFor(chatId, appName),
    bridgeKey: bridgeKeyFor(token),
    capabilities,
  };
}

interface VerifiedSession {
  userId: string;
  chatId: string;
  appName: string;
  capabilities: string[];
}

async function verifyAppToken(
  pool: Pool,
  token: string,
  expectedChatId: string,
  expectedAppName: string,
): Promise<VerifiedSession | null> {
  const session = await queries.appSessions.verify(pool, hashToken(token));
  if (!session) return null;
  // Strict scope check: a leaked token for app A must not unlock app B.
  if (session.chatId !== expectedChatId) return null;
  if (session.appName !== expectedAppName) return null;
  return {
    userId: session.userId,
    chatId: session.chatId,
    appName: session.appName,
    capabilities: session.capabilities,
  };
}

interface BridgeContext {
  chatId: string;
  appName: string;
  bridgeKey: string;
  capabilities: string[];
}

/**
  * Inlines `window.desk` into the served `index.html`. The bridge exposes
  * identity, declared capabilities, and narrow postMessage-backed methods.
  * The parent SPA validates the source iframe and performs privileged calls
  * on the app's behalf; the app itself runs with an opaque sandbox origin.
 *
 * Security: the JSON payload is escaped so any `</script>` sequence inside
 * a string value (e.g. a capability the manifest tampered with) becomes
 * `<\/script>` — JS parses the string the same, but the HTML parser no
 * longer terminates the script tag early. Capabilities are also filtered
 * against `KNOWN_CAPABILITIES` at issue time, so this is defense in depth
 * rather than the primary gate.
 */
/**
 * Vite (and most bundlers) emit `<script type="module" src="...">` tags
 * with no nonce. Our CSP uses `strict-dynamic`, which ignores `'self'`
 * and only trusts scripts with the matching nonce (plus what those
 * scripts dynamically import). Without this rewrite the entry bundle is
 * blocked and the app never boots. Apply to every `<script>` that
 * doesn't already carry a nonce — including the bridge tag would be a
 * no-op since `injectBridge` already sets one.
 */
function applyScriptNonce(html: string, nonce: string): string {
  return html.replace(
    /<script\b(?![^>]*\bnonce=)([^>]*)>/g,
    `<script nonce="${nonce}"$1>`,
  );
}

function injectBridge(html: string, ctx: BridgeContext, nonce: string): string {
  const payload = JSON.stringify({
    app: { name: ctx.appName },
    chatId: ctx.chatId,
    bridgeKey: ctx.bridgeKey,
    capabilities: ctx.capabilities,
  })
    // Escape all `<` so `</script>`, `<!--`, and `<![CDATA[` inside a JSON
    // string can't break out of the surrounding `<script>` tag.
    .replace(/</g, "\\u003c");
  // The bridge is small enough to inline. The bridge key lets the parent
  // reject messages from any later iframe navigation that did not receive
  // this injected script. `postMessage('*')` is deliberate:
  // sandboxed iframes without `allow-same-origin` have an opaque `null`
  // origin, so the parent authenticates messages by exact contentWindow
  // identity instead of by Origin.
  const script = `<script nonce="${nonce}">(()=>{const c=${payload};const t="desk.app.request";const r="desk.app.response";let n=0;const p=new Map;function q(method,params){return new Promise((resolve,reject)=>{const id=Date.now()+":"+(++n);p.set(id,{resolve,reject});window.parent.postMessage({type:t,id,key:c.bridgeKey,method,params},"*")})}window.addEventListener("message",e=>{const m=e.data;if(!m||m.type!==r||!p.has(m.id))return;const h=p.get(m.id);p.delete(m.id);m.ok?h.resolve(m.result):h.reject(new Error(m.error||"Desk app bridge request failed"))});const storage={list(collection){return q("storage.list",{collection})},get(collection,id){return q("storage.get",{collection,id})},create(collection,doc){return q("storage.create",{collection,doc})},put(collection,id,doc){return q("storage.put",{collection,id,doc})},delete(collection,id){return q("storage.delete",{collection,id})}};window.desk={app:c.app,chatId:c.chatId,capabilities:c.capabilities,storage,fetch(){throw new Error("desk.fetch is not enabled; use explicit window.desk capabilities")}};})();</script>`;
  if (html.includes("</head>")) {
    return html.replace("</head>", `${script}</head>`);
  }
  // No </head> (rare but possible for hand-rolled HTML) — prepend.
  return script + html;
}

/**
 * `true` when desk-server is being terminated over TLS. Driven by the
 * `DESK_SECURE_COOKIES` env var: set it to `1` (or any non-empty value
 * other than `0` / `false`) in production behind HTTPS so per-app
 * cookies carry the `Secure` attribute. Defaults to off because dev runs
 * over plain HTTP — forcing `Secure` there causes browsers to drop the
 * cookie silently and the iframe loses its session.
 */
function secureCookies(): boolean {
  const raw = process.env.DESK_SECURE_COOKIES;
  if (!raw) return false;
  const v = raw.toLowerCase();
  return v !== "0" && v !== "false";
}

function setAppCookie(
  res: ServerResponse,
  cookieName: string,
  token: string,
  cookiePath: string,
): void {
  // App-scoped + HttpOnly + SameSite=Strict means a leaked token can't
  // be reused by JS in a different origin, can't be sent on cross-site
  // navigations, and is invisible to the iframe's own scripts. `Secure`
  // is gated on DESK_SECURE_COOKIES so dev keeps working over HTTP.
  const flags = [
    `${cookieName}=${encodeURIComponent(token)}`,
    `Path=${cookiePath}`,
    "HttpOnly",
    "SameSite=Strict",
    `Max-Age=${Math.floor(APP_TOKEN_TTL_MS / 1000)}`,
  ];
  if (secureCookies()) flags.push("Secure");
  const value = flags.join("; ");
  res.appendHeader?.("Set-Cookie", value);
  // Older Node where appendHeader is missing — fall back to setHeader.
  if (!res.appendHeader) res.setHeader("Set-Cookie", value);
}

/**
 * Production security headers shared by every `/apps/*` response. These
 * apply to both `index.html` and asset bytes — the iframe's contents
 * never load cross-origin scripts, never get framed in another tab,
  * never sniff MIME types. The iframe itself is sandboxed to an opaque
  * origin; these headers protect both direct navigations and subresources.
 *
 * Tradeoffs:
 * - **`Content-Security-Policy`**: `'self'` for scripts + styles +
  *   images + fonts + connect lets the app load its own bundles and
  *   embed `@agent-desk/ui` styles. Privileged Desk calls go through the
  *   parent postMessage bridge, not direct iframe fetches. Inline `<script>`
 *   from the bridge is gated on its sha256 hash so the CSP doesn't
 *   need `'unsafe-inline'`. Inline styles from Tailwind v4 / shadcn
 *   require `'unsafe-inline'` for now — Tailwind emits a few inline
 *   `<style>` blocks at build time and there's no easy hash story.
 * - **`X-Frame-Options: SAMEORIGIN`**: only the parent SPA (same
 *   origin) is allowed to embed the iframe. Defeats clickjacking via
 *   evil-iframe-on-other-origin.
 * - **`X-Content-Type-Options: nosniff`**: browsers must respect our
 *   declared `Content-Type`; no MIME-sniffing-as-script attack on a
 *   text/plain response.
 * - **`Referrer-Policy: same-origin`**: any link the app produces
 *   sends the full URL only to same-origin destinations and `Origin`
 *   only otherwise — keeps app-specific paths from leaking.
 * - **`Permissions-Policy`**: refuse the most dangerous platform
 *   features at the iframe level — camera/microphone/geolocation
 *   should require explicit Desk capability, not be implicitly
 *   available because the iframe is same-origin.
 */
function nonceForRequest(): string {
  return randomBytes(16).toString("base64");
}

function setSecurityHeaders(res: ServerResponse, nonce: string): void {
  // CSP: scripts only from same-origin, plus the nonce so our injected
  // bridge runs. No inline styles from external sources; inline-style
  // 'unsafe-inline' is allowed only because Tailwind/shadcn emit a small
  // number of style blocks at build time and we don't have hashes for
  // those yet. Connect is `'self'` for app-owned assets and non-privileged
  // same-origin calls; Desk capabilities are parent-mediated.
  const csp = [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "frame-ancestors 'self'",
    "navigate-to 'self'",
    "base-uri 'self'",
    "form-action 'self'",
    "object-src 'none'",
  ].join("; ");
  res.setHeader("Content-Security-Policy", csp);
  res.setHeader("X-Frame-Options", "SAMEORIGIN");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "same-origin");
  res.setHeader(
    "Permissions-Policy",
    "camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=()",
  );
}

/**
 * Serves a single asset under the app's dist directory. Caller must have
 * already validated authentication.
 */
async function serveAsset(
  distDir: string,
  relPath: string,
  res: ServerResponse,
): Promise<void> {
  const target = path.normalize(path.join(distDir, relPath));
  if (!target.startsWith(distDir + path.sep) && target !== distDir) {
    throw new NotFoundError("Asset not found");
  }
  let s;
  try {
    s = await stat(target);
  } catch {
    throw new NotFoundError("Asset not found");
  }
  if (!s.isFile()) throw new NotFoundError("Asset not found");
  // Set security headers before writeHead so they ride along on the 200.
  setSecurityHeaders(res, nonceForRequest());
  res.writeHead(200, {
    "Content-Type": mimeFor(target),
    "Content-Length": String(s.size),
    "Cache-Control": "no-store",
    // The iframe sandbox lacks `allow-same-origin`, so it has a null
    // origin and module/CSS chunk fetches go out as CORS requests.
    // These bytes are public-by-design (URL is unguessable; privileged
    // calls go through the bridge), so `*` is safe and matches the
    // null-origin requester without credentials.
    "Access-Control-Allow-Origin": "*",
  });
  createReadStream(target).pipe(res);
}

interface IndexResponseOpts {
  distDir: string;
  subpath: string;
  bridge: BridgeContext;
  res: ServerResponse;
}

async function serveIndex({ distDir, subpath, bridge, res }: IndexResponseOpts): Promise<void> {
  const indexPath = path.join(distDir, subpath, "index.html");
  const normalized = path.normalize(indexPath);
  if (!normalized.startsWith(distDir + path.sep) && normalized !== path.join(distDir, "index.html")) {
    throw new NotFoundError("index.html not found");
  }
  let html: string;
  try {
    html = await readFile(indexPath, "utf-8");
  } catch {
    throw new NotFoundError("index.html not found");
  }
  const nonce = nonceForRequest();
  const injected = applyScriptNonce(injectBridge(html, bridge, nonce), nonce);
  const buf = Buffer.from(injected, "utf-8");
  setSecurityHeaders(res, nonce);
  res.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Length": String(buf.length),
    "Cache-Control": "no-store",
  });
  res.end(buf);
}

function matchEntryPoint(tail: string): { subpath: string } | null {
  if (tail === "" || tail === "index.html") return { subpath: "" };
  const fragment = /^fragments\/([a-z][a-z0-9-]{0,62})(?:\/(?:index\.html)?)?$/.exec(tail);
  if (!fragment) return null;
  return { subpath: `fragments/${fragment[1]}` };
}

/**
 * Handler for `GET /apps/chat/:chatId/:appName/dist/...`. Returns true
 * when the request was handled (status code already written), false when
 * the path doesn't match the app-route pattern (caller should fall
 * through).
 */
export async function handleStaticAppRequest(
  pool: Pool,
  storage: StorageContext,
  segments: string[],
  url: URL,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  // Expect: ["apps", "chat", chatId, appName, "dist", ...rest]
  if (
    segments.length < 5 ||
    segments[0] !== "apps" ||
    segments[1] !== "chat" ||
    segments[4] !== "dist"
  ) {
    return false;
  }
  const chatId = decodeURIComponent(segments[2]);
  const appName = decodeURIComponent(segments[3]);
  if (!APP_NAME_PATTERN.test(appName)) {
    throw new NotFoundError(`Unknown app: ${appName}`);
  }

  const tail = segments.slice(5).map((s) => decodeURIComponent(s)).join("/");

  // Sandboxed iframes without `allow-same-origin` have an opaque origin.
  // Chromium does not send same-site cookies for module-script subresource
  // loads from that opaque origin, so built JS/CSS/image assets cannot rely
  // on the app-session cookie. Keep HTML entrypoints authenticated and bridge-
  // injected; serve non-HTML assets as unprivileged bytes under an unguessable
  // chat/app URL. Privileged data still requires the parent-mediated bridge.
  if (tail !== "" && path.extname(tail).toLowerCase() !== ".html") {
    const { distDir } = await resolveChatAppDist(pool, storage, chatId, appName);
    await serveAsset(distDir, tail, res);
    return true;
  }

  const cookies = parseCookies(req);
  const cookieName = cookieNameFor(chatId, appName);
  const queryToken = url.searchParams.get("t");
  const cookieToken = cookies[cookieName];

  let session: VerifiedSession | null = null;
  if (queryToken) {
    session = await verifyAppToken(pool, queryToken, chatId, appName);
    if (!session) throw new UnauthorizedError("Invalid app token");
  } else if (cookieToken) {
    session = await verifyAppToken(pool, cookieToken, chatId, appName);
    if (!session) throw new UnauthorizedError("Invalid app token");
  } else {
    throw new UnauthorizedError("Missing app token");
  }

  const { distDir } = await resolveChatAppDist(pool, storage, chatId, appName);
  const cookiePath = `/apps/chat/${encodeURIComponent(chatId)}/${encodeURIComponent(appName)}`;

  // Bootstrap (query token present): set cookie, redirect to clean URL
  // so the address bar doesn't leak the token to copy-paste. Preserve a
  // trailing slash on the requested path so the browser treats the
  // redirected URL as a directory (relative asset paths inside the
  // served HTML resolve correctly).
  if (queryToken) {
    setAppCookie(res, cookieName, queryToken, cookiePath);
    const incoming = new URL(req.url ?? "/", "http://localhost").pathname;
    const trailingSlash = incoming.endsWith("/") ? "/" : "";
    const cleanPath = `/${segments.join("/")}${trailingSlash}`;
    res.writeHead(302, { Location: cleanPath });
    res.end();
    return true;
  }

  // Cookie-authenticated request — serve the asset.
  const entry = matchEntryPoint(tail);
  if (entry) {
    await serveIndex({
      distDir,
      subpath: entry.subpath,
      bridge: {
        chatId,
        appName,
        bridgeKey: bridgeKeyFor(cookieToken),
        capabilities: session.capabilities,
      },
      res,
    });
    return true;
  }
  await serveAsset(distDir, tail, res);
  return true;
}

/**
 * Handler for `POST /apps/chat/:chatId/:appName/issue`. Mints an app
 * session and returns the bootstrap URL to the parent SPA.
 *
 * Rate-limited per-user: 30 issues / minute. Returns a `RateLimitError`
 * when exceeded so the caller maps it to 429.
 */
export async function handleIssueAppSession(
  pool: Pool,
  storage: StorageContext,
  userId: string,
  chatId: string,
  appName: string,
): Promise<IssueResult> {
  if (!APP_NAME_PATTERN.test(appName)) {
    throw new ValidationError(`Invalid app name: ${appName}`);
  }
  if (!recordIssueAndCheck(userId)) {
    throw new IssueRateLimitError();
  }
  return issueAppSession(pool, storage, userId, chatId, appName);
}

/**
 * Thrown when a user exceeds the `/issue` rate limit. The dispatcher
 * maps this to a 429 with a `Retry-After` hint.
 */
export class IssueRateLimitError extends Error {
  readonly retryAfterSeconds: number;
  constructor() {
    super("Too many app sessions issued in a short time");
    this.name = "IssueRateLimitError";
    this.retryAfterSeconds = Math.ceil(ISSUE_LIMIT_WINDOW_MS / 1000);
  }
}

// ── Library scope (PR-E) ──────────────────────────────────────────────
//
// Library apps live at the workspace root (`~/<name>.app/`). The URL
// scheme is `/apps/library/:appName/dist/*` — there is no workspaceId
// segment. That assumes a single active workspace per user; we look up
// the user's oldest workspace as the implicit target. When multi-workspace
// support arrives, the URL gains a `:workspaceId` segment and this
// resolver becomes a (workspaceId, userId) lookup. See plan §PR-E review.

async function workspaceForUser(
  pool: Pool,
  userId: string,
): Promise<{ id: string; slug: string } | null> {
  const { rows } = await pool.query<{ id: string; path: string }>(
    "SELECT id, path FROM workspaces WHERE user_id = ? ORDER BY created_at LIMIT 1",
    [userId],
  );
  if (rows.length === 0) return null;
  return { id: rows[0].id, slug: rows[0].path };
}

export async function resolveLibraryAppDist(
  storage: StorageContext,
  workspaceSlug: string,
  appName: string,
): Promise<{ distDir: string }> {
  if (!APP_NAME_PATTERN.test(appName)) {
    throw new NotFoundError(`Unknown app: ${appName}`);
  }
  const wsRoot = await realpath(workspaceRootPath(storage.home, workspaceSlug)).catch(() => workspaceRootPath(storage.home, workspaceSlug));
  const appRoot = path.join(wsRoot, `${appName}.app`);
  const distDir = path.join(appRoot, "dist");
  const fsp = await import("node:fs/promises");
  let real: string;
  try {
    real = await fsp.realpath(distDir);
  } catch {
    throw new NotFoundError(`App dist not found: ${appName}.app/dist`);
  }
  if (!real.startsWith(wsRoot + path.sep) && real !== wsRoot) {
    throw new NotFoundError(`App dist not found: ${appName}.app/dist`);
  }
  return { distDir: real };
}

export async function issueLibraryAppSession(
  pool: Pool,
  storage: StorageContext,
  userId: string,
  appName: string,
): Promise<IssueResult> {
  if (!APP_NAME_PATTERN.test(appName)) {
    throw new ValidationError(`Invalid app name: ${appName}`);
  }
  const ws = await workspaceForUser(pool, userId);
  if (!ws) throw new NotFoundError("No workspace for user");
  const { distDir } = await resolveLibraryAppDist(storage, ws.slug, appName);

  const manifest = await readManifest(distDir);
  // Same sanitization as the chat scope — drop unknown capabilities and
  // dedupe so the bridge payload is well-formed.
  const capabilities = sanitizeCapabilities(manifest?.capabilities);

  const raw = randomBytes(APP_TOKEN_BYTES).toString("hex");
  const token = APP_TOKEN_PREFIX + raw;
  const expiresAt = new Date(Date.now() + APP_TOKEN_TTL_MS);
  await queries.appSessions.issue(pool, {
    id: generateId("appSession"),
    userId,
    scope: "library",
    chatId: null,
    workspaceId: ws.id,
    appName,
    capabilities,
    tokenHash: hashToken(token),
    expiresAt,
  });

  const assetToken = hashToken(token);
  const url = `/apps/library/${encodeURIComponent(ws.id)}/${encodeURIComponent(assetToken)}/${encodeURIComponent(appName)}/dist/?t=${encodeURIComponent(token)}`;
  return {
    token,
    expiresAt: expiresAt.toISOString(),
    url,
    cookieName: libraryCookieNameFor(ws.id, appName),
    bridgeKey: bridgeKeyFor(token),
    capabilities,
  };
}

async function verifyLibraryAppToken(
  pool: Pool,
  token: string,
  expectedAppName: string,
  expectedWorkspaceId: string,
): Promise<VerifiedSession | null> {
  const session = await queries.appSessions.verify(pool, hashToken(token));
  if (!session) return null;
  if (session.scope !== "library") return null;
  if (session.appName !== expectedAppName) return null;
  if (session.workspaceId !== expectedWorkspaceId) return null;
  return {
    userId: session.userId,
    chatId: session.chatId ?? "",
    appName: session.appName,
    capabilities: session.capabilities,
  };
}

/**
 * Handles `GET /apps/library/:workspaceId/:assetToken/:appName/dist/...`. The
 * asset token is in the path so sandboxed iframe subresource loads can resolve
 * JS/CSS chunks even when Chromium omits cookies for the opaque origin.
 * The legacy `/apps/library/:appName/dist/...` shape is still accepted for
 * cookie/query-authenticated HTML entrypoints.
 */
export async function handleStaticLibraryAppRequest(
  pool: Pool,
  storage: StorageContext,
  segments: string[],
  url: URL,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  if (segments[0] !== "apps" || segments[1] !== "library") {
    return false;
  }

  const hasWorkspaceAssetSegment =
    segments.length >= 6 &&
    /^wks_[A-Za-z0-9_-]+$/.test(decodeURIComponent(segments[2])) &&
    /^[a-f0-9]{64}$/.test(decodeURIComponent(segments[3])) &&
    segments[5] === "dist";
  const hasWorkspaceSegment = segments.length >= 5 && /^wks_[A-Za-z0-9_-]+$/.test(decodeURIComponent(segments[2])) && segments[4] === "dist";
  const legacyShape = segments.length >= 4 && segments[3] === "dist";
  if (!hasWorkspaceAssetSegment && !hasWorkspaceSegment && !legacyShape) return false;

  const routeWorkspaceId = (hasWorkspaceAssetSegment || hasWorkspaceSegment) ? decodeURIComponent(segments[2]) : null;
  const routeAssetToken = hasWorkspaceAssetSegment ? decodeURIComponent(segments[3]) : null;
  const appName = decodeURIComponent(segments[hasWorkspaceAssetSegment ? 4 : hasWorkspaceSegment ? 3 : 2]);
  if (!APP_NAME_PATTERN.test(appName)) {
    throw new NotFoundError(`Unknown app: ${appName}`);
  }
  const tailStart = hasWorkspaceAssetSegment ? 6 : hasWorkspaceSegment ? 5 : 4;
  const tail = segments.slice(tailStart).map((s) => decodeURIComponent(s)).join("/");

  if (routeWorkspaceId && tail !== "" && path.extname(tail).toLowerCase() !== ".html") {
    if (!routeAssetToken) throw new UnauthorizedError("Missing app asset token");
    const ses = await queries.appSessions.verify(pool, routeAssetToken);
    if (
      !ses ||
      ses.scope !== "library" ||
      ses.workspaceId !== routeWorkspaceId ||
      ses.appName !== appName
    ) {
      throw new UnauthorizedError("Invalid app asset token");
    }
    const { rows } = await pool.query<{ path: string }>(
      "SELECT path FROM workspaces WHERE id = ?",
      [routeWorkspaceId],
    );
    const workspaceSlug = rows[0]?.path;
    if (!workspaceSlug) throw new NotFoundError("Workspace not found");
    const { distDir } = await resolveLibraryAppDist(storage, workspaceSlug, appName);
    await serveAsset(distDir, tail, res);
    return true;
  }

  const queryToken = url.searchParams.get("t");
  // Library cookie name embeds the workspaceId, so we can't compute the
  // expected name without first knowing it. Resolve via the (single
  // active) cookie that matches our prefix; the verify call then enforces
  // the workspace match.
  const cookies = parseCookies(req);
  const cookieEntry = Object.entries(cookies).find(
    ([k]) => k.startsWith("desk_libapp_") && k.endsWith(`_${appName}`),
  );
  const cookieToken = cookieEntry ? cookieEntry[1] : undefined;

  let session: VerifiedSession | null = null;
  let workspaceSlug: string | null = null;
  let workspaceId: string | null = null;

  if (queryToken) {
    const ses = await queries.appSessions.verify(pool, hashToken(queryToken));
    if (!ses || ses.scope !== "library" || ses.appName !== appName) {
      throw new UnauthorizedError("Invalid app token");
    }
    session = {
      userId: ses.userId,
      chatId: "",
      appName: ses.appName,
      capabilities: ses.capabilities,
    };
    workspaceId = routeWorkspaceId ?? ses.workspaceId;
    if (workspaceId !== ses.workspaceId) throw new UnauthorizedError("Invalid app token");
  } else if (cookieToken) {
    const ses = await queries.appSessions.verify(pool, hashToken(cookieToken));
    if (!ses || ses.scope !== "library" || ses.appName !== appName) {
      throw new UnauthorizedError("Invalid app token");
    }
    // The cookie name we matched on encodes the workspaceId — re-check
    // against the session row (defense in depth).
    const cookieWs = cookieEntry![0].slice("desk_libapp_".length, -1 - appName.length);
    if (ses.workspaceId !== cookieWs) {
      throw new UnauthorizedError("Invalid app token");
    }
    session = await verifyLibraryAppToken(pool, cookieToken, appName, ses.workspaceId);
    if (!session) throw new UnauthorizedError("Invalid app token");
    workspaceId = routeWorkspaceId ?? ses.workspaceId;
    if (workspaceId !== ses.workspaceId) throw new UnauthorizedError("Invalid app token");
  } else {
    throw new UnauthorizedError("Missing app token");
  }

  const { rows } = await pool.query<{ path: string }>(
    "SELECT path FROM workspaces WHERE id = ?",
    [workspaceId],
  );
  workspaceSlug = rows[0]?.path ?? null;
  if (!workspaceSlug) throw new NotFoundError("Workspace not found");

  const { distDir } = await resolveLibraryAppDist(storage, workspaceSlug, appName);
  const cookiePath = routeWorkspaceId
    ? `/apps/library/${encodeURIComponent(routeWorkspaceId)}/${encodeURIComponent(routeAssetToken ?? hashToken(queryToken ?? cookieToken ?? ""))}/${encodeURIComponent(appName)}`
    : `/apps/library/${encodeURIComponent(appName)}`;
  const cookieName = libraryCookieNameFor(workspaceId!, appName);

  if (queryToken) {
    setAppCookie(res, cookieName, queryToken, cookiePath);
    const incoming = new URL(req.url ?? "/", "http://localhost").pathname;
    const trailingSlash = incoming.endsWith("/") ? "/" : "";
    const cleanPath = `/${segments.join("/")}${trailingSlash}`;
    res.writeHead(302, { Location: cleanPath });
    res.end();
    return true;
  }

  const entry = matchEntryPoint(tail);
  if (entry) {
    await serveIndex({
      distDir,
      subpath: entry.subpath,
        bridge: {
          chatId: "",
          appName,
          bridgeKey: bridgeKeyFor(cookieToken!),
          capabilities: session.capabilities,
        },
        res,
      });
    return true;
  }
  await serveAsset(distDir, tail, res);
  return true;
}

export async function handleIssueLibraryAppSession(
  pool: Pool,
  storage: StorageContext,
  userId: string,
  appName: string,
): Promise<IssueResult> {
  // Same per-user rate limit as the chat scope — both endpoints share
  // the bucket so a parent SPA can't dodge the cap by alternating.
  if (!recordIssueAndCheck(userId)) {
    throw new IssueRateLimitError();
  }
  return issueLibraryAppSession(pool, storage, userId, appName);
}

/** Exposed for tests so they can reset state between cases. */
export async function clearAppSessions(pool: Pool): Promise<void> {
  await queries.appSessions.deleteAll(pool);
}
