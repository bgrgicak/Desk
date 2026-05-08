/**
 * Codex (ChatGPT subscription) local source.
 *
 * The Codex CLI on the host stores OAuth tokens in `~/.codex/auth.json`. The
 * OpenCode CLI we ship in the sandbox uses the same OAuth client and accepts
 * an out-of-band auth blob via `OPENCODE_AUTH_CONTENT`. So when the user
 * opts in to the Codex source, we read the host's tokens, translate them
 * into OpenCode's schema, and inject them into every sandbox exec — no
 * Codex binary, no bind-mount, no API key required.
 *
 * Token refresh: OpenCode refreshes inline when needed by hitting OpenAI's
 * oauth/token endpoint. The host's Codex CLI does the same independently —
 * each side keeps its own copy. The only hazard is parallel refresh racing
 * the same refresh_token; in practice the user's interactive `codex` use is
 * sparse compared to sandbox runs and the host file is re-read per sandbox
 * start, so the freshest tokens propagate forward.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { LocalSource, LocalSourceStatus } from "./types.js";

/** Resolves the host's `~/.codex/auth.json` path. Override-able for tests. */
export function defaultCodexAuthPath(): string {
  if (process.env.DESK_CODEX_AUTH_PATH) return process.env.DESK_CODEX_AUTH_PATH;
  return path.join(os.homedir(), ".codex", "auth.json");
}

interface CodexAuthFile {
  auth_mode?: string;
  OPENAI_API_KEY?: string | null;
  tokens?: {
    id_token?: string;
    access_token?: string;
    refresh_token?: string;
    account_id?: string;
  };
  last_refresh?: string;
}

interface JwtClaims {
  exp?: number;
  email?: string;
  chatgpt_account_id?: string;
  organizations?: { id?: string; is_default?: boolean }[];
  ["https://api.openai.com/auth"]?: {
    chatgpt_account_id?: string;
    chatgpt_plan_type?: string;
  };
  ["https://api.openai.com/profile"]?: {
    email?: string;
    email_verified?: boolean;
  };
}

function decodeJwtClaims(jwt: string): JwtClaims | null {
  const parts = jwt.split(".");
  if (parts.length < 2) return null;
  try {
    return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as JwtClaims;
  } catch {
    return null;
  }
}

function readAuthFile(filePath: string): CodexAuthFile | null {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as CodexAuthFile;
  } catch {
    return null;
  }
}

function deriveAccountId(file: CodexAuthFile, idClaims: JwtClaims | null): string | null {
  if (file.tokens?.account_id) return file.tokens.account_id;
  if (!idClaims) return null;
  const auth = idClaims["https://api.openai.com/auth"];
  if (auth?.chatgpt_account_id) return auth.chatgpt_account_id;
  if (idClaims.chatgpt_account_id) return idClaims.chatgpt_account_id;
  const orgs = idClaims.organizations ?? [];
  const def = orgs.find((o) => o.is_default && o.id) ?? orgs.find((o) => o.id);
  return def?.id ?? null;
}

/** Detection. Never returns secrets — the surfaced fields are display-only. */
export function detectCodex(filePath = defaultCodexAuthPath()): LocalSourceStatus {
  const file = readAuthFile(filePath);
  if (!file) return { kind: "codex", available: false, reason: "missing" };
  if (file.auth_mode !== "chatgpt") {
    return { kind: "codex", available: false, reason: "wrong_mode" };
  }
  const tokens = file.tokens;
  if (!tokens?.access_token || !tokens.refresh_token) {
    return { kind: "codex", available: false, reason: "no_tokens" };
  }

  const accessClaims = decodeJwtClaims(tokens.access_token);
  const idClaims = tokens.id_token ? decodeJwtClaims(tokens.id_token) : null;
  const expSec = accessClaims?.exp ?? 0;
  const expiresAt = expSec ? expSec * 1000 : undefined;
  if (expiresAt && expiresAt < Date.now() && !tokens.refresh_token) {
    return { kind: "codex", available: false, reason: "expired_no_refresh" };
  }

  const detail: Record<string, string | number | boolean> = {};
  const email =
    idClaims?.["https://api.openai.com/profile"]?.email ??
    idClaims?.email ??
    undefined;
  if (email) detail.email = email;
  const plan = idClaims?.["https://api.openai.com/auth"]?.chatgpt_plan_type;
  if (plan) detail.plan = plan;
  if (expiresAt) detail.expiresAt = expiresAt;

  return { kind: "codex", available: true, detail };
}

/** Translates the host's Codex tokens into OpenCode's auth-blob env var. */
export function loadCodexEnv(filePath = defaultCodexAuthPath()): Record<string, string> | null {
  const file = readAuthFile(filePath);
  if (!file || file.auth_mode !== "chatgpt") return null;
  const tokens = file.tokens;
  if (!tokens?.access_token || !tokens.refresh_token) return null;

  const accessClaims = decodeJwtClaims(tokens.access_token);
  const idClaims = tokens.id_token ? decodeJwtClaims(tokens.id_token) : null;
  const accountId = deriveAccountId(file, idClaims);
  if (!accountId) return null;

  const expSec = accessClaims?.exp ?? 0;
  const expiresAt = expSec ? expSec * 1000 : Date.now() + 60 * 60 * 1000;

  const blob = {
    openai: {
      type: "oauth",
      refresh: tokens.refresh_token,
      access: tokens.access_token,
      expires: expiresAt,
      accountId,
    },
  };
  return { OPENCODE_AUTH_CONTENT: JSON.stringify(blob) };
}

export const codexLocalSource: LocalSource = {
  kind: "codex",
  detect: () => detectCodex(),
  loadEnv: () => loadCodexEnv(),
};
