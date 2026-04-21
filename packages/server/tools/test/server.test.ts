import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as http from "node:http";
import {
  setupTestTools,
  teardownTestTools,
  toolRequest,
  type TestToolContext,
} from "./helpers/toolServer.js";

let ctx: TestToolContext;

beforeAll(async () => {
  ctx = await setupTestTools();
});

afterAll(async () => {
  await teardownTestTools(ctx);
});

describe("tool server", () => {
  it("returns 401 for missing token", async () => {
    const data = JSON.stringify({ fileId: "fil_test" });
    const result = await new Promise<{ status: number; body: unknown }>((resolve, reject) => {
      const req = http.request(
        {
          hostname: "127.0.0.1",
          port: ctx.port,
          path: "/tools/file.read",
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(data),
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk: Buffer) => chunks.push(chunk));
          res.on("end", () => {
            resolve({ status: res.statusCode!, body: JSON.parse(Buffer.concat(chunks).toString()) });
          });
        },
      );
      req.on("error", reject);
      req.write(data);
      req.end();
    });

    expect(result.status).toBe(401);
  });

  it("returns 401 for invalid token", async () => {
    const result = await toolRequest(
      { ...ctx, token: "tok_invalid" },
      "file.read",
      { fileId: "fil_test" },
    );
    expect(result.status).toBe(401);
  });

  it("returns 404 for unknown tool", async () => {
    const result = await toolRequest(ctx, "nonexistent.tool", { foo: "bar" });
    expect(result.status).toBe(404);
  });

  it("returns 400 for invalid body", async () => {
    const result = await toolRequest(ctx, "file.read", { wrong: "field" });
    expect(result.status).toBe(400);
  });

  describe("file.read", () => {
    it("reads an uploaded file", async () => {
      // First upload a file via file.write
      const writeResult = await toolRequest(ctx, "file.write", {
        workspaceId: ctx.workspaceId,
        name: "test-read.txt",
        mime: "text/plain",
        contentBase64: Buffer.from("hello tools").toString("base64"),
      });
      expect(writeResult.status).toBe(200);
      const written = writeResult.body as { id: string };

      // Then read it
      const readResult = await toolRequest(ctx, "file.read", { fileId: written.id });
      expect(readResult.status).toBe(200);
      const read = readResult.body as { content: string; mime: string };
      expect(read.content).toBe("hello tools");
      expect(read.mime).toBe("text/plain");
    });
  });

  describe("file.write", () => {
    it("writes a file and returns the file record", async () => {
      const result = await toolRequest(ctx, "file.write", {
        workspaceId: ctx.workspaceId,
        name: "written.txt",
        mime: "text/plain",
        contentBase64: Buffer.from("written content").toString("base64"),
      });
      expect(result.status).toBe(200);
      const file = result.body as { id: string; name: string };
      expect(file.id).toMatch(/^fil_/);
      expect(file.name).toBe("written.txt");
    });
  });

  describe("library.list", () => {
    it("returns a list of library files", async () => {
      const result = await toolRequest(ctx, "library.list", {
        workspaceId: ctx.workspaceId,
      });
      expect(result.status).toBe(200);
      const body = result.body as { items: unknown[] };
      expect(Array.isArray(body.items)).toBe(true);
    });
  });

  describe("library.get", () => {
    it("gets a file by ID", async () => {
      // Upload a file first
      const writeResult = await toolRequest(ctx, "file.write", {
        workspaceId: ctx.workspaceId,
        name: "lib-get-test.txt",
        mime: "text/plain",
        contentBase64: Buffer.from("lib content").toString("base64"),
      });
      const file = writeResult.body as { id: string };

      const result = await toolRequest(ctx, "library.get", { fileId: file.id });
      expect(result.status).toBe(200);
      const body = result.body as { id: string; name: string };
      expect(body.id).toBe(file.id);
    });
  });

  describe("chat.send_message", () => {
    it("inserts a message and emits an event", async () => {
      const initialEventCount = ctx.events.length;

      const result = await toolRequest(ctx, "chat.send_message", {
        chatId: ctx.chatId,
        content: "Hello from agent",
      });
      expect(result.status).toBe(200);
      const msg = result.body as { id: string; role: string };
      expect(msg.id).toMatch(/^msg_/);
      expect(msg.role).toBe("agent");

      // Check WS event was emitted
      expect(ctx.events.length).toBeGreaterThan(initialEventCount);
      const lastEvent = ctx.events[ctx.events.length - 1];
      expect(lastEvent.type).toBe("message.appended");
    });
  });

  describe("chat.attach_artifact", () => {
    it("attaches a file to a chat", async () => {
      // Upload file first
      const writeResult = await toolRequest(ctx, "file.write", {
        workspaceId: ctx.workspaceId,
        chatId: ctx.chatId,
        name: "artifact.txt",
        mime: "text/plain",
        contentBase64: Buffer.from("artifact").toString("base64"),
      });
      const file = writeResult.body as { id: string };

      const result = await toolRequest(ctx, "chat.attach_artifact", {
        chatId: ctx.chatId,
        fileId: file.id,
      });
      expect(result.status).toBe(200);
      const msg = result.body as { id: string; content: { type: string; fileId: string } };
      expect(msg.content.type).toBe("artifactRef");
      expect(msg.content.fileId).toBe(file.id);
    });
  });

  describe("web.fetch", () => {
    it("rejects private/loopback IPs (SSRF guard)", async () => {
      const blockedUrls = [
        "http://127.0.0.1/secret",
        "http://10.0.0.1/internal",
        "http://172.16.0.1/internal",
        "http://192.168.1.1/internal",
        "http://169.254.169.254/metadata",
      ];

      for (const url of blockedUrls) {
        const result = await toolRequest(ctx, "web.fetch", { url });
        expect(result.status).toBe(403);
      }
    });

    it("allows a harmless public URL", async () => {
      // Use a well-known public URL that returns quickly
      const result = await toolRequest(ctx, "web.fetch", {
        url: "https://httpbin.org/status/200",
        method: "GET",
      });
      // Should succeed (200) or at least not be blocked by SSRF guard
      expect(result.status).not.toBe(403);
    });
  });

  describe("allowlist enforcement", () => {
    it("returns 403 when tool is not in agent allowlist", async () => {
      // Update agent to have a restricted allowlist
      await ctx.pool.query(
        `UPDATE agents SET tool_allowlist = $1 WHERE id = $2`,
        [JSON.stringify(["file.read"]), ctx.agentId],
      );

      const result = await toolRequest(ctx, "file.write", {
        workspaceId: ctx.workspaceId,
        name: "blocked.txt",
        mime: "text/plain",
        contentBase64: Buffer.from("blocked").toString("base64"),
      });
      expect(result.status).toBe(403);

      // Restore full allowlist
      await ctx.pool.query(
        `UPDATE agents SET tool_allowlist = $1 WHERE id = $2`,
        [JSON.stringify(Object.keys(await import("@desk/shared").then((m) => m.TOOLS))), ctx.agentId],
      );
    });
  });
});
