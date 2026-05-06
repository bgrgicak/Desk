import http from "node:http";
import { URL } from "node:url";
import { CliError } from "./errors.js";

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
  const token = process.env.DESK_SANDBOX_TOKEN;
  if (!token) {
    throw new CliError("NO_TOKEN", "DESK_SANDBOX_TOKEN is not set");
  }
  const apiUrl = process.env.DESK_API_URL;
  if (!apiUrl) {
    throw new CliError("NO_ENDPOINT", "DESK_API_URL is not set");
  }

  const target = new URL(pathname, apiUrl);
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
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString();
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            try {
              resolve(JSON.parse(raw));
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
      },
    );
    req.on("error", (err) => {
      reject(new CliError("CONNECTION_ERROR", err.message));
    });
    req.write(json);
    req.end();
  });
}

/**
 * GETs from the host-side desk-server REST API. Mirrors `postJson` for
 * read-only sandbox calls (e.g. memory-system search). Same env-var
 * contract: `DESK_API_URL` + `DESK_SANDBOX_TOKEN`.
 */
export async function getJson(pathname: string): Promise<unknown> {
  const token = process.env.DESK_SANDBOX_TOKEN;
  if (!token) {
    throw new CliError("NO_TOKEN", "DESK_SANDBOX_TOKEN is not set");
  }
  const apiUrl = process.env.DESK_API_URL;
  if (!apiUrl) {
    throw new CliError("NO_ENDPOINT", "DESK_API_URL is not set");
  }

  const target = new URL(pathname, apiUrl);
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
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString();
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            try {
              resolve(JSON.parse(raw));
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
      },
    );
    req.on("error", (err) => {
      reject(new CliError("CONNECTION_ERROR", err.message));
    });
    req.end();
  });
}
