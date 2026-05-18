import http from "node:http";
import { URL } from "node:url";
import { CliError } from "./errors.js";

function resolveTarget(pathname: string): URL {
  const apiUrl = process.env.DESK_API_URL;
  if (!apiUrl) {
    throw new CliError("NO_ENDPOINT", "DESK_API_URL is not set");
  }
  return new URL(pathname, apiUrl);
}

function requireToken(): string {
  // Direct env path: caller already wired the token in. Trunk-shaped.
  const direct = process.env.DESK_SANDBOX_TOKEN;
  if (direct) return direct;
  // File path: the host runtime writes the per-run token to a known
  // file before each turn and exposes DESK_SANDBOX_TOKEN_PATH on the
  // daemon's stable env. The daemon's child tool processes (this CLI)
  // inherit that env and read the freshest token off disk. This keeps
  // the daemon's process env stable across runs (the env-digest stays
  // the same so the daemon doesn't restart per turn) while preserving
  // per-run token rotation semantics.
  const tokenPath = process.env.DESK_SANDBOX_TOKEN_PATH;
  if (tokenPath) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const fs = require("node:fs") as typeof import("node:fs");
      const fileToken = fs.readFileSync(tokenPath, "utf8").trim();
      if (fileToken) return fileToken;
    } catch {
      // fall through to NO_TOKEN
    }
  }
  throw new CliError(
    "NO_TOKEN",
    "DESK_SANDBOX_TOKEN is not set and DESK_SANDBOX_TOKEN_PATH did not yield a token",
  );
}

function handleResponse(
  res: http.IncomingMessage,
  resolve: (v: unknown) => void,
  reject: (e: Error) => void,
): void {
  const chunks: Buffer[] = [];
  res.on("data", (chunk: Buffer) => chunks.push(chunk));
  res.on("end", () => {
    const raw = Buffer.concat(chunks).toString();
    if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
      try {
        resolve(raw.length === 0 ? {} : JSON.parse(raw));
      } catch (err) {
        reject(
          new CliError(
            "INVALID_RESPONSE",
            err instanceof Error ? err.message : String(err),
          ),
        );
      }
    } else {
      let code = "HTTP_ERROR";
      let message = `HTTP ${res.statusCode}: ${raw}`;
      try {
        const parsed = JSON.parse(raw);
        if (parsed.code) code = parsed.code;
        if (parsed.message) message = parsed.message;
      } catch {
        // use defaults
      }
      reject(new CliError(code, message));
    }
  });
}

/**
 * Posts to the host-side desk-server REST API. Resolves the API URL from
 * `DESK_API_URL` and authenticates with the per-run sandbox session token
 * in `DESK_SANDBOX_TOKEN` — both injected by the runtime when OpenCode is
 * started for a run.
 */
export async function postJson(
  pathname: string,
  body: unknown,
): Promise<unknown> {
  const token = requireToken();
  const target = resolveTarget(pathname);
  const json = JSON.stringify(body);

  return await new Promise((resolve, reject) => {
    const req = http.request(
      {
        method: "POST",
        hostname: target.hostname,
        port: target.port || (target.protocol === "https:" ? 443 : 80),
        path: target.pathname + target.search,
        protocol: target.protocol,
        headers: {
          "Content-Type": "application/json",
          "X-Desk-Sandbox-Token": token,
          "Content-Length": Buffer.byteLength(json),
        },
      },
      (res) => handleResponse(res, resolve, reject),
    );
    req.on("error", (err) => {
      reject(new CliError("CONNECTION_ERROR", err.message));
    });
    req.write(json);
    req.end();
  });
}

/** GET sibling of postJson — used by read-only commands like `secret get`. */
export async function getJson(pathname: string): Promise<unknown> {
  const token = requireToken();
  const target = resolveTarget(pathname);

  return await new Promise((resolve, reject) => {
    const req = http.request(
      {
        method: "GET",
        hostname: target.hostname,
        port: target.port || (target.protocol === "https:" ? 443 : 80),
        path: target.pathname + target.search,
        protocol: target.protocol,
        headers: {
          "X-Desk-Sandbox-Token": token,
        },
      },
      (res) => handleResponse(res, resolve, reject),
    );
    req.on("error", (err) => {
      reject(new CliError("CONNECTION_ERROR", err.message));
    });
    req.end();
  });
}
