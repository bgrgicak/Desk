/**
 * Static-serve + capability bridge for Roomy apps (issue #47, PR-C, PR-E).
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
 *     Non-HTML built assets either carry an asset-token URL path injected
 *     through the HTML `<base>` tag or use the app-session cookie/query token.
 *     The route verifies the app session before opening files.
 *
 * The iframe is rendered without `allow-same-origin`, so generated app
 * JavaScript gets an opaque origin and cannot read the parent SPA's
 * sessionStorage/localStorage or act as first-party Roomy code. Privileged
 * operations go through the injected `window.roomy` postMessage bridge and
 * are mediated by the parent SPA.
 */
import { createHash, randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, realpath, stat } from "node:fs/promises";
import * as path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { type Pool, queries } from "@roomy-ai/db";
import {
  NotFoundError,
  UnauthorizedError,
  ValidationError,
  generateId,
} from "@roomy-ai/shared";
import {
  chatArtifactsDir,
  validateLibrarySubpath,
  workspaceRootPath,
  type StorageContext,
} from "@roomy-ai/storage";
import {
  applyScriptNonce,
  injectBridge,
  nonceForRequest,
  setSecurityHeaders,
  type BridgeContext,
} from "./app-response.js";

export { BRIDGE_SCRIPT_BODY } from "./app-response.js";

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
 * AGENTS.md and `roomy.app.json` examples.
 */
const KNOWN_CAPABILITIES = new Set<string>([
  "library.read",
  "library.write",
  "chats.read",
  "chats.write",
  "storage.read",
  "storage.write",
]);

const SELF_DECLARED_APP_CAPABILITIES = new Set<string>([
  "library.read",
  "chats.read",
  "storage.read",
  "storage.write",
]);

function sanitizeCapabilities(
  raw: unknown,
  allowedCapabilities: ReadonlySet<string> = KNOWN_CAPABILITIES,
): string[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of raw) {
    if (typeof value !== "string") continue;
    if (!KNOWN_CAPABILITIES.has(value)) continue;
    if (!allowedCapabilities.has(value)) continue;
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
  return `roomy_app_${chatId}_${appName}`;
}

function libraryCookieNameFor(workspaceId: string, appName: string): string {
  return `roomy_libapp_${workspaceId}_${appName}`;
}

function globalCookieNameFor(chatId: string, appName: string): string {
  return `roomy_globalapp_${chatId}_${appName}`;
}

function isInsidePath(root: string, candidate: string): boolean {
  const rel = path.relative(root, candidate);
  return rel === "" || (!!rel && !rel.startsWith("..") && !path.isAbsolute(rel));
}

function librarySessionAppKey(appPath: string): string {
  return appPath.endsWith(".app") ? appPath.slice(0, -".app".length) : appPath;
}

function chatAssetBaseHref(chatId: string, assetToken: string, appName: string): string {
  return `/apps/chat/${encodeURIComponent(chatId)}/${encodeURIComponent(assetToken)}/${encodeURIComponent(appName)}/dist/`;
}

function globalAssetBaseHref(chatId: string, assetToken: string, appName: string): string {
  return `/apps/global/${encodeURIComponent(chatId)}/${encodeURIComponent(assetToken)}/${encodeURIComponent(appName)}/dist/`;
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
  const manifestPath = path.join(appRoot, "roomy.app.json");
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
  const capabilities = sanitizeCapabilities(
    manifest?.capabilities,
    SELF_DECLARED_APP_CAPABILITIES,
  );

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
  if (session.scope !== "chat") return null;
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

/**
 * `true` when roomy-server is being terminated over TLS. Driven by the
 * `ROOMY_SECURE_COOKIES` env var: set it to `1` (or any non-empty value
 * other than `0` / `false`) in production behind HTTPS so per-app
 * cookies carry the `Secure` attribute. Defaults to off because dev runs
 * over plain HTTP — forcing `Secure` there causes browsers to drop the
 * cookie silently and the iframe loses its session.
 */
function secureCookies(): boolean {
  const raw = process.env.ROOMY_SECURE_COOKIES;
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
  // is gated on ROOMY_SECURE_COOKIES so dev keeps working over HTTP.
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
 * Serves a single asset under the app's dist directory. Caller must have
 * already validated authentication.
 */
async function resolveDistFile(
  distDir: string,
  relPath: string,
  notFoundMessage: string,
): Promise<{ realPath: string; size: number }> {
  const target = path.normalize(path.join(distDir, relPath));
  if (!isInsidePath(distDir, target)) {
    throw new NotFoundError(notFoundMessage);
  }
  let realTarget: string;
  try {
    realTarget = await realpath(target);
  } catch {
    throw new NotFoundError(notFoundMessage);
  }
  if (!isInsidePath(distDir, realTarget)) {
    throw new NotFoundError(notFoundMessage);
  }
  let s;
  try {
    s = await stat(realTarget);
  } catch {
    throw new NotFoundError(notFoundMessage);
  }
  if (!s.isFile()) throw new NotFoundError(notFoundMessage);
  return { realPath: realTarget, size: s.size };
}

async function serveAsset(
  distDir: string,
  relPath: string,
  res: ServerResponse,
): Promise<void> {
  const { realPath, size } = await resolveDistFile(
    distDir,
    relPath,
    "Asset not found",
  );
  // Set security headers before writeHead so they ride along on the 200.
  setSecurityHeaders(res, nonceForRequest());
  res.writeHead(200, {
    "Content-Type": mimeFor(realPath),
    "Content-Length": String(size),
    "Cache-Control": "no-store",
    // The iframe sandbox lacks `allow-same-origin`, so it has a null
    // origin and module/CSS chunk fetches go out as CORS requests.
    // The route has already verified the app session or session-bound
    // asset token; `*` lets the null-origin requester read only those
    // scoped bytes without credentials.
    "Access-Control-Allow-Origin": "*",
  });
  createReadStream(realPath).pipe(res);
}

interface IndexResponseOpts {
  distDir: string;
  subpath: string;
  bridge: BridgeContext;
  res: ServerResponse;
  assetBaseHref?: string;
}

function injectAssetBase(html: string, href: string): string {
  const tag = `<base href="${href}">`;
  if (/<base\b/i.test(html)) {
    return html.replace(/<base\b[^>]*>/i, tag);
  }
  if (/<head\b[^>]*>/i.test(html)) {
    return html.replace(/<head\b([^>]*)>/i, `<head$1>${tag}`);
  }
  return tag + html;
}

function entryAssetBaseHref(rootHref: string, subpath: string): string {
  const root = rootHref.endsWith("/") ? rootHref : `${rootHref}/`;
  const clean = subpath.replace(/^\/+|\/+$/g, "");
  return clean ? `${root}${clean}/` : root;
}

async function serveIndex({
  distDir,
  subpath,
  bridge,
  res,
  assetBaseHref,
}: IndexResponseOpts): Promise<void> {
  const relPath = path.join(subpath, "index.html");
  const { realPath } = await resolveDistFile(
    distDir,
    relPath,
    "index.html not found",
  );
  let html: string;
  try {
    html = await readFile(realPath, "utf-8");
  } catch {
    throw new NotFoundError("index.html not found");
  }
  const nonce = nonceForRequest();
  const withBase = assetBaseHref
    ? injectAssetBase(html, entryAssetBaseHref(assetBaseHref, subpath))
    : html;
  const injected = applyScriptNonce(injectBridge(withBase, bridge, nonce), nonce);
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
  // Expect one of:
  //   ["apps", "chat", chatId, appName, "dist", ...rest]
  //   ["apps", "chat", chatId, assetToken, appName, "dist", ...rest]
  const routeAssetToken =
    segments.length >= 6 && /^[a-f0-9]{64}$/.test(decodeURIComponent(segments[3] ?? "")) && segments[5] === "dist"
      ? decodeURIComponent(segments[3])
      : null;
  const legacyShape =
    segments.length < 5 ||
    segments[0] !== "apps" ||
    segments[1] !== "chat" ||
    segments[4] !== "dist";
  const tokenizedShape =
    !!routeAssetToken &&
    segments[0] === "apps" &&
    segments[1] === "chat" &&
    segments[5] === "dist";
  if (legacyShape && !tokenizedShape) {
    return false;
  }
  const chatId = decodeURIComponent(segments[2]);
  const appName = decodeURIComponent(routeAssetToken ? segments[4] : segments[3]);
  if (!APP_NAME_PATTERN.test(appName)) {
    throw new NotFoundError(`Unknown app: ${appName}`);
  }

  const tailStart = routeAssetToken ? 6 : 5;
  const tail = segments.slice(tailStart).map((s) => decodeURIComponent(s)).join("/");
  const chatEntry = matchEntryPoint(tail);
  const isNonHtmlAsset = tail !== "" && !chatEntry && path.extname(tail).toLowerCase() !== ".html";
  if (isNonHtmlAsset && routeAssetToken) {
    const ses = await queries.appSessions.verify(pool, routeAssetToken);
    if (
      !ses ||
      ses.scope !== "chat" ||
      ses.chatId !== chatId ||
      ses.appName !== appName
    ) {
      throw new UnauthorizedError("Invalid app asset token");
    }
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

  // Bootstrap (query token present): set the cookie and serve the
  // response inline. Earlier versions 302-redirected here to strip the
  // token from the address bar, but the redirect Location had to preserve
  // any non-`t` query params the caller passed (e.g. chat-cards' `items`
  // JSON or chat-forms' `steps`). For bulky payloads that header blew
  // past nginx's default 4K `proxy_buffer_size` and surfaced as a 502 —
  // see commit log + the `upstream sent too big header` nginx errors.
  // The iframe is sandboxed to an opaque origin, the user never sees its
  // URL, and the bearer token is a short-lived one-shot hashed in DB, so
  // the original "address-bar leak" risk doesn't apply here.
  if (queryToken) {
    setAppCookie(res, cookieName, queryToken, cookiePath);
  }

  const bridgeToken = queryToken ?? cookieToken!;
  const entry = matchEntryPoint(tail);
  if (entry) {
    await serveIndex({
      distDir,
      subpath: entry.subpath,
      bridge: {
        chatId,
        appName,
        bridgeKey: bridgeKeyFor(bridgeToken),
        capabilities: session.capabilities,
      },
      res,
      assetBaseHref: chatAssetBaseHref(chatId, hashToken(bridgeToken), appName),
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

// ── Global scope (built-in apps) ───────────────────────────────────────
//
// Built-in apps live in `${ROOMY_HOME}/.apps/<name>.app/`, populated by
// `writeBuiltinApps` on server start (mirrors @roomy-ai/apps) and
// mounted into every sandbox at `/opt/roomy-apps/`. They're visible from
// every chat without being scoped to any particular workspace.
//
// URL scheme: `/apps/global/:chatId/:appName/dist/*`. The chatId is in the
// path purely for session and cookie scoping — global apps resolve only
// against `${ROOMY_HOME}/.apps/`. The bridge's `chatId` still binds
// `chats.write` capability to the calling chat.

async function resolveGlobalAppDist(
  storage: StorageContext,
  appName: string,
): Promise<{ distDir: string }> {
  if (!APP_NAME_PATTERN.test(appName)) {
    throw new NotFoundError(`Unknown app: ${appName}`);
  }
  const appsRoot = path.join(storage.home, ".apps");
  const distDir = path.join(appsRoot, `${appName}.app`, "dist");
  let real: string;
  try {
    real = await realpath(distDir);
  } catch {
    throw new NotFoundError(`Built-in app dist not found: ${appName}.app/dist`);
  }
  const appsRootReal = await realpath(appsRoot).catch(() => appsRoot);
  if (!real.startsWith(appsRootReal + path.sep) && real !== appsRootReal) {
    throw new NotFoundError(`Built-in app dist not found: ${appName}.app/dist`);
  }
  return { distDir: real };
}

export async function issueGlobalAppSession(
  pool: Pool,
  storage: StorageContext,
  userId: string,
  chatId: string,
  appName: string,
): Promise<IssueResult> {
  await ensureUserOwnsChat(pool, userId, chatId);
  const ws = await workspaceSlugForChat(pool, chatId);
  if (!ws) throw new NotFoundError(`Chat not found: ${chatId}`);
  const { distDir } = await resolveGlobalAppDist(storage, appName);

  const manifest = await readManifest(distDir);
  const capabilities = sanitizeCapabilities(manifest?.capabilities);

  const raw = randomBytes(APP_TOKEN_BYTES).toString("hex");
  const token = APP_TOKEN_PREFIX + raw;
  const expiresAt = new Date(Date.now() + APP_TOKEN_TTL_MS);
  await queries.appSessions.issue(pool, {
    id: generateId("appSession"),
    userId,
    scope: "global",
    chatId,
    // workspace_id is NOT NULL on the table; use the chat's workspace as a
    // bookkeeping anchor. Resolution and serving are workspace-independent.
    workspaceId: ws.workspaceId,
    appName,
    capabilities,
    tokenHash: hashToken(token),
    expiresAt,
  });

  const url = `/apps/global/${encodeURIComponent(chatId)}/${encodeURIComponent(appName)}/dist/?t=${encodeURIComponent(token)}`;
  return {
    token,
    expiresAt: expiresAt.toISOString(),
    url,
    cookieName: globalCookieNameFor(chatId, appName),
    bridgeKey: bridgeKeyFor(token),
    capabilities,
  };
}

async function verifyGlobalAppToken(
  pool: Pool,
  token: string,
  expectedChatId: string,
  expectedAppName: string,
): Promise<VerifiedSession | null> {
  const session = await queries.appSessions.verify(pool, hashToken(token));
  if (!session) return null;
  if (session.scope !== "global") return null;
  if (session.chatId !== expectedChatId) return null;
  if (session.appName !== expectedAppName) return null;
  return {
    userId: session.userId,
    chatId: session.chatId,
    appName: session.appName,
    capabilities: session.capabilities,
  };
}

/**
 * Handler for `GET /apps/global/:chatId/:appName/dist/*`. Mirrors the chat
 * scope's token/cookie/bridge flow, but resolves the app's dist directory
 * against `${ROOMY_HOME}/.apps/` (Roomy-shipped built-in apps), independent
 * of any workspace.
 */
export async function handleStaticGlobalAppRequest(
  pool: Pool,
  storage: StorageContext,
  segments: string[],
  url: URL,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  // Expect one of:
  //   ["apps", "global", chatId, appName, "dist", ...rest]
  //   ["apps", "global", chatId, assetToken, appName, "dist", ...rest]
  const routeAssetToken =
    segments.length >= 6 && /^[a-f0-9]{64}$/.test(decodeURIComponent(segments[3] ?? "")) && segments[5] === "dist"
      ? decodeURIComponent(segments[3])
      : null;
  const legacyShape =
    segments.length < 5 ||
    segments[0] !== "apps" ||
    segments[1] !== "global" ||
    segments[4] !== "dist";
  const tokenizedShape =
    !!routeAssetToken &&
    segments[0] === "apps" &&
    segments[1] === "global" &&
    segments[5] === "dist";
  if (legacyShape && !tokenizedShape) {
    return false;
  }
  const chatId = decodeURIComponent(segments[2]);
  const appName = decodeURIComponent(routeAssetToken ? segments[4] : segments[3]);
  if (!APP_NAME_PATTERN.test(appName)) {
    throw new NotFoundError(`Unknown app: ${appName}`);
  }

  const tailStart = routeAssetToken ? 6 : 5;
  const tail = segments.slice(tailStart).map((s) => decodeURIComponent(s)).join("/");
  const globalEntry = matchEntryPoint(tail);
  const isNonHtmlAsset = tail !== "" && !globalEntry && path.extname(tail).toLowerCase() !== ".html";
  if (isNonHtmlAsset && routeAssetToken) {
    const ses = await queries.appSessions.verify(pool, routeAssetToken);
    if (
      !ses ||
      ses.scope !== "global" ||
      ses.chatId !== chatId ||
      ses.appName !== appName
    ) {
      throw new UnauthorizedError("Invalid app asset token");
    }
    const { distDir } = await resolveGlobalAppDist(storage, appName);
    await serveAsset(distDir, tail, res);
    return true;
  }

  const cookies = parseCookies(req);
  const cookieName = globalCookieNameFor(chatId, appName);
  const queryToken = url.searchParams.get("t");
  const cookieToken = cookies[cookieName];

  let session: VerifiedSession | null = null;
  if (queryToken) {
    session = await verifyGlobalAppToken(pool, queryToken, chatId, appName);
    if (!session) throw new UnauthorizedError("Invalid app token");
  } else if (cookieToken) {
    session = await verifyGlobalAppToken(pool, cookieToken, chatId, appName);
    if (!session) throw new UnauthorizedError("Invalid app token");
  } else {
    throw new UnauthorizedError("Missing app token");
  }

  const { distDir } = await resolveGlobalAppDist(storage, appName);
  const cookiePath = `/apps/global/${encodeURIComponent(chatId)}/${encodeURIComponent(appName)}`;

  // Bootstrap (query token present): see the chat handler above — we set
  // the cookie and serve the response inline rather than 302-redirecting,
  // because preserving bulky fragment params in the Location header blew
  // past nginx's default 4K `proxy_buffer_size` and produced a 502.
  if (queryToken) {
    setAppCookie(res, cookieName, queryToken, cookiePath);
  }

  const bridgeToken = queryToken ?? cookieToken!;
  const entry = matchEntryPoint(tail);
  if (entry) {
    await serveIndex({
      distDir,
      subpath: entry.subpath,
      bridge: {
        chatId,
        appName,
        bridgeKey: bridgeKeyFor(bridgeToken),
        capabilities: session.capabilities,
      },
      res,
      assetBaseHref: globalAssetBaseHref(chatId, hashToken(bridgeToken), appName),
    });
    return true;
  }
  await serveAsset(distDir, tail, res);
  return true;
}

/**
 * Handler for `POST /apps/global/:chatId/:appName/issue`. Mints a global
 * app session and returns the bootstrap URL to the parent SPA. Shares the
 * same per-user `/issue` rate limit as chat/library scopes.
 */
export async function handleIssueGlobalAppSession(
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
  return issueGlobalAppSession(pool, storage, userId, chatId, appName);
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

function normalizeLibraryAppPath(appPathOrName: string): { appPath: string; appName: string } {
  const appPath = appPathOrName.endsWith(".app") || appPathOrName.includes("/")
    ? appPathOrName
    : `${appPathOrName}.app`;
  validateLibrarySubpath(appPath);
  if (!appPath.endsWith(".app")) {
    throw new NotFoundError(`Unknown app: ${appPathOrName}`);
  }
  const appName = path.basename(appPath, ".app");
  if (!APP_NAME_PATTERN.test(appName)) {
    throw new NotFoundError(`Unknown app: ${appName}`);
  }
  return { appPath, appName };
}

function encodeAppPathForUrl(appPath: string): string {
  return appPath.split("/").map((part) => encodeURIComponent(part)).join("/");
}

export async function resolveLibraryAppDist(
  storage: StorageContext,
  workspaceSlug: string,
  appPathOrName: string,
): Promise<{ distDir: string; appPath: string; appName: string }> {
  const { appPath, appName } = normalizeLibraryAppPath(appPathOrName);
  const wsRoot = await realpath(workspaceRootPath(storage.home, workspaceSlug)).catch(() => workspaceRootPath(storage.home, workspaceSlug));
  const appRoot = path.join(wsRoot, appPath);
  const distDir = path.join(appRoot, "dist");
  const fsp = await import("node:fs/promises");
  let real: string;
  try {
    real = await fsp.realpath(distDir);
  } catch {
    throw new NotFoundError(`App dist not found: ${appPath}/dist`);
  }
  if (!real.startsWith(wsRoot + path.sep) && real !== wsRoot) {
    throw new NotFoundError(`App dist not found: ${appPath}/dist`);
  }
  return { distDir: real, appPath, appName };
}

export async function issueLibraryAppSession(
  pool: Pool,
  storage: StorageContext,
  userId: string,
  appName: string,
  opts: { workspaceId?: string; appPath?: string } = {},
): Promise<IssueResult> {
  if (!APP_NAME_PATTERN.test(appName)) {
    throw new ValidationError(`Invalid app name: ${appName}`);
  }
  const ws = opts.workspaceId
    ? await queries.workspaces.findById(pool, opts.workspaceId).then((w) => {
        if (!w || w.userId !== userId) throw new NotFoundError(`Workspace not found: ${opts.workspaceId}`);
        return { id: w.id, slug: w.path };
      })
    : await workspaceForUser(pool, userId);
  if (!ws) throw new NotFoundError("No workspace for user");
  const { distDir, appPath, appName: resolvedAppName } = await resolveLibraryAppDist(storage, ws.slug, opts.appPath ?? appName);
  if (resolvedAppName !== appName) {
    throw new ValidationError(`App path does not match app name: ${opts.appPath}`);
  }

  const manifest = await readManifest(distDir);
  const capabilities = sanitizeCapabilities(
    manifest?.capabilities,
    SELF_DECLARED_APP_CAPABILITIES,
  );

  const raw = randomBytes(APP_TOKEN_BYTES).toString("hex");
  const token = APP_TOKEN_PREFIX + raw;
  const expiresAt = new Date(Date.now() + APP_TOKEN_TTL_MS);
  await queries.appSessions.issue(pool, {
    id: generateId("appSession"),
    userId,
    scope: "library",
    chatId: null,
    workspaceId: ws.id,
    appName: librarySessionAppKey(appPath),
    capabilities,
    tokenHash: hashToken(token),
    expiresAt,
  });

  const assetToken = hashToken(token);
  const url = `/apps/library/${encodeURIComponent(ws.id)}/${encodeURIComponent(assetToken)}/${encodeAppPathForUrl(appPath)}/dist/?t=${encodeURIComponent(token)}`;
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
  expectedAppPath: string,
  expectedAppName: string,
  expectedWorkspaceId: string,
): Promise<VerifiedSession | null> {
  const session = await queries.appSessions.verify(pool, hashToken(token));
  if (!session) return null;
  if (session.scope !== "library") return null;
  if (session.appName !== librarySessionAppKey(expectedAppPath)) return null;
  if (session.workspaceId !== expectedWorkspaceId) return null;
  return {
    userId: session.userId,
    chatId: session.chatId ?? "",
    appName: expectedAppName,
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

  const workspaceAssetDistIndex = segments.findIndex((segment, index) => index >= 5 && segment === "dist");
  const workspaceDistIndex = segments.findIndex((segment, index) => index >= 4 && segment === "dist");
  const hasWorkspaceAssetSegment =
    segments.length >= 6 &&
    /^wks_[A-Za-z0-9_-]+$/.test(decodeURIComponent(segments[2])) &&
    /^[a-f0-9]{64}$/.test(decodeURIComponent(segments[3])) &&
    workspaceAssetDistIndex !== -1;
  const hasWorkspaceSegment = segments.length >= 5 && /^wks_[A-Za-z0-9_-]+$/.test(decodeURIComponent(segments[2])) && workspaceDistIndex !== -1;
  const legacyShape = segments.length >= 4 && segments[3] === "dist";
  if (!hasWorkspaceAssetSegment && !hasWorkspaceSegment && !legacyShape) return false;

  const routeWorkspaceId = (hasWorkspaceAssetSegment || hasWorkspaceSegment) ? decodeURIComponent(segments[2]) : null;
  const routeAssetToken = hasWorkspaceAssetSegment ? decodeURIComponent(segments[3]) : null;
  const appPath = hasWorkspaceAssetSegment
    ? segments.slice(4, workspaceAssetDistIndex).map((s) => decodeURIComponent(s)).join("/")
    : hasWorkspaceSegment
      ? segments.slice(3, workspaceDistIndex).map((s) => decodeURIComponent(s)).join("/")
      : decodeURIComponent(segments[2]);
  const { appName } = normalizeLibraryAppPath(appPath);
  if (!APP_NAME_PATTERN.test(appName)) {
    throw new NotFoundError(`Unknown app: ${appName}`);
  }
  const tailStart = hasWorkspaceAssetSegment ? workspaceAssetDistIndex + 1 : hasWorkspaceSegment ? workspaceDistIndex + 1 : 4;
  const tail = segments.slice(tailStart).map((s) => decodeURIComponent(s)).join("/");

  const entryPoint = matchEntryPoint(tail);
  if (routeWorkspaceId && tail !== "" && !entryPoint && path.extname(tail).toLowerCase() !== ".html") {
    if (!routeAssetToken) throw new UnauthorizedError("Missing app asset token");
    const ses = await queries.appSessions.verify(pool, routeAssetToken);
    if (
      !ses ||
      ses.scope !== "library" ||
      ses.workspaceId !== routeWorkspaceId ||
      ses.appName !== librarySessionAppKey(appPath)
    ) {
      throw new UnauthorizedError("Invalid app asset token");
    }
    const { rows } = await pool.query<{ path: string }>(
      "SELECT path FROM workspaces WHERE id = ?",
      [routeWorkspaceId],
    );
    const workspaceSlug = rows[0]?.path;
    if (!workspaceSlug) throw new NotFoundError("Workspace not found");
    const { distDir } = await resolveLibraryAppDist(storage, workspaceSlug, appPath);
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
    ([k]) => k.startsWith("roomy_libapp_") && k.endsWith(`_${appName}`),
  );
  const cookieToken = cookieEntry ? cookieEntry[1] : undefined;

  let session: VerifiedSession | null = null;
  let workspaceSlug: string | null = null;
  let workspaceId: string | null = null;

  if (queryToken) {
    const ses = await queries.appSessions.verify(pool, hashToken(queryToken));
    if (
      !ses ||
      ses.scope !== "library" ||
      ses.appName !== librarySessionAppKey(appPath)
    ) {
      throw new UnauthorizedError("Invalid app token");
    }
    session = {
      userId: ses.userId,
      chatId: "",
      appName,
      capabilities: ses.capabilities,
    };
    workspaceId = routeWorkspaceId ?? ses.workspaceId;
    if (workspaceId !== ses.workspaceId) throw new UnauthorizedError("Invalid app token");
  } else if (cookieToken) {
    const ses = await queries.appSessions.verify(pool, hashToken(cookieToken));
    if (
      !ses ||
      ses.scope !== "library" ||
      ses.appName !== librarySessionAppKey(appPath)
    ) {
      throw new UnauthorizedError("Invalid app token");
    }
    // The cookie name we matched on encodes the workspaceId — re-check
    // against the session row (defense in depth).
    const cookieWs = cookieEntry![0].slice("roomy_libapp_".length, -1 - appName.length);
    if (ses.workspaceId !== cookieWs) {
      throw new UnauthorizedError("Invalid app token");
    }
    session = await verifyLibraryAppToken(pool, cookieToken, appPath, appName, ses.workspaceId);
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

  const { distDir } = await resolveLibraryAppDist(storage, workspaceSlug, appPath);
  const cookiePath = routeWorkspaceId
    ? `/apps/library/${encodeURIComponent(routeWorkspaceId)}/${encodeURIComponent(routeAssetToken ?? hashToken(queryToken ?? cookieToken ?? ""))}/${encodeAppPathForUrl(appPath)}`
    : `/apps/library/${encodeURIComponent(appName)}`;
  const cookieName = libraryCookieNameFor(workspaceId!, appName);

  // Bootstrap (query token present): see the chat handler — we set the
  // cookie and serve inline. The previous 302 redirect carried any
  // non-`t` query params in the Location header, which exceeded nginx's
  // default 4K `proxy_buffer_size` for bulky fragment payloads (502).
  if (queryToken) {
    setAppCookie(res, cookieName, queryToken, cookiePath);
  }

  const bridgeToken = queryToken ?? cookieToken!;
  const entry = entryPoint;
  if (entry) {
    await serveIndex({
      distDir,
      subpath: entry.subpath,
      bridge: {
        chatId: "",
        appName,
        bridgeKey: bridgeKeyFor(bridgeToken),
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
  opts: { workspaceId?: string; appPath?: string } = {},
): Promise<IssueResult> {
  // Same per-user rate limit as the chat scope — both endpoints share
  // the bucket so a parent SPA can't dodge the cap by alternating.
  if (!recordIssueAndCheck(userId)) {
    throw new IssueRateLimitError();
  }
  return issueLibraryAppSession(pool, storage, userId, appName, opts);
}

/** Exposed for tests so they can reset state between cases. */
export async function clearAppSessions(pool: Pool): Promise<void> {
  await queries.appSessions.deleteAll(pool);
}
