import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type Server } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync, unlinkSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const distPath = resolve(__dirname, "../../dist/desk.js");

const canRun = existsSync(distPath);

describe.skipIf(!canRun)("integration: live CLI", () => {
  let server: Server;
  let socketPath: string;
  let lastRequest: {
    method: string;
    url: string;
    headers: Record<string, string | string[] | undefined>;
    body: string;
  };

  beforeAll(async () => {
    socketPath = join(
      tmpdir(),
      `desk-test-${process.pid}-${Date.now()}.sock`,
    );

    // Clean up stale socket if it exists
    if (existsSync(socketPath)) {
      unlinkSync(socketPath);
    }

    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        lastRequest = {
          method: req.method || "",
          url: req.url || "",
          headers: req.headers as Record<string, string | string[] | undefined>,
          body: Buffer.concat(chunks).toString(),
        };

        // Route responses based on the tool path
        const url = req.url || "";
        let responseBody: unknown;

        if (url === "/tools/file.read") {
          responseBody = { content: "file-content", mime: "text/plain" };
        } else if (url === "/tools/file.write") {
          responseBody = {
            id: "f_1",
            workspaceId: "ws_1",
            class: "artifact",
            path: "/test.txt",
            name: "test.txt",
            mime: "text/plain",
            size: 5,
            createdAt: "2025-01-01T00:00:00Z",
          };
        } else {
          res.writeHead(404);
          res.end(JSON.stringify({ code: "NOT_FOUND", message: "Unknown tool" }));
          return;
        }

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(responseBody));
      });
    });

    await new Promise<void>((resolve) => {
      server.listen(socketPath, resolve);
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (existsSync(socketPath)) {
      unlinkSync(socketPath);
    }
  });

  const runCli = (args: string[], stdin?: string) => {
    const env = {
      ...process.env,
      DESK_TOOL_TOKEN: "test-token-123",
      DESK_TOOL_SOCKET: socketPath,
    };

    return new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
      const child = execFile("node", [distPath, ...args], { env }, (err, stdout, stderr) => {
        if (err && !stdout && !stderr) {
          reject(err);
        } else {
          resolve({ stdout: stdout || "", stderr: stderr || "" });
        }
      });

      if (stdin && child.stdin) {
        child.stdin.write(stdin);
        child.stdin.end();
      }
    });
  };

  it("file read sends correct request", async () => {
    const { stdout } = await runCli(["file", "read", "f_x"]);

    expect(lastRequest.method).toBe("POST");
    expect(lastRequest.url).toBe("/tools/file.read");
    expect(lastRequest.headers["x-desk-sandbox-token"]).toBe("test-token-123");
    expect(lastRequest.headers["content-type"]).toBe("application/json");

    const reqBody = JSON.parse(lastRequest.body);
    expect(reqBody).toEqual({ fileId: "f_x" });

    const resBody = JSON.parse(stdout);
    expect(resBody.content).toBe("file-content");
  });

  it("file write streams stdin correctly", async () => {
    const { stdout } = await runCli(
      ["file", "write", "--workspace", "ws_1", "--name", "test.txt", "--mime", "text/plain"],
      "hello",
    );

    expect(lastRequest.url).toBe("/tools/file.write");
    const reqBody = JSON.parse(lastRequest.body);
    expect(reqBody.contentBase64).toBe(Buffer.from("hello").toString("base64"));
    expect(reqBody.workspaceId).toBe("ws_1");

    const resBody = JSON.parse(stdout);
    expect(resBody.id).toBe("f_1");
  });
});

if (!existsSync(resolve(dirname(fileURLToPath(import.meta.url)), "../../dist/desk.js"))) {
  describe("integration: live CLI (skipped)", () => {
    it.skip("dist/desk.js not found - run build first", () => {});
  });
}
