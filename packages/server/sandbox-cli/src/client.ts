import http from "node:http";
import { TOOLS, type ToolName } from "@desk/shared";
import { CliError } from "./errors.js";

export function callTool(
  name: ToolName,
  request: unknown,
): Promise<unknown> {
  const tool = TOOLS[name];
  const parsed = tool.request.parse(request);

  const token = process.env.DESK_TOOL_TOKEN;
  if (!token) {
    throw new CliError("NO_TOKEN", "DESK_TOOL_TOKEN is not set");
  }

  const socketPath = process.env.DESK_TOOL_SOCKET;
  const baseUrl = process.env.DESK_TOOL_URL;

  if (!socketPath && !baseUrl) {
    throw new CliError(
      "NO_ENDPOINT",
      "Neither DESK_TOOL_SOCKET nor DESK_TOOL_URL is set",
    );
  }

  const body = JSON.stringify(parsed);

  const options: http.RequestOptions = {
    method: "POST",
    path: `/tools/${name}`,
    headers: {
      "Content-Type": "application/json",
      "X-Desk-Sandbox-Token": token,
      "Content-Length": Buffer.byteLength(body),
    },
  };

  if (socketPath) {
    options.socketPath = socketPath;
  } else {
    const url = new URL(baseUrl!);
    options.hostname = url.hostname;
    options.port = url.port;
    options.protocol = url.protocol;
  }

  return new Promise((resolve, reject) => {
    const req = http.request(options, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => {
        const raw = Buffer.concat(chunks).toString();
        if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
          try {
            const json = JSON.parse(raw);
            const validated = tool.response.parse(json);
            resolve(validated);
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
    });

    req.on("error", (err) => {
      reject(new CliError("CONNECTION_ERROR", err.message));
    });

    req.write(body);
    req.end();
  });
}
