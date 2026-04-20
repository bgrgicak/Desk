import { describe, it, expect } from "vitest";
import { TOOLS } from "../src/index.js";

const now = new Date().toISOString();

const expectedTools = [
  "file.read",
  "file.write",
  "library.list",
  "library.get",
  "chat.send_message",
  "chat.attach_artifact",
  "web.fetch",
] as const;

describe("TOOLS registry", () => {
  it("contains all expected tool keys", () => {
    expect(Object.keys(TOOLS).sort()).toEqual([...expectedTools].sort());
  });

  for (const name of expectedTools) {
    describe(name, () => {
      it("has name, request, and response schemas", () => {
        const tool = TOOLS[name];
        expect(tool.name).toBe(name);
        expect(tool.request).toBeDefined();
        expect(tool.request.parse).toBeTypeOf("function");
        expect(tool.response).toBeDefined();
        expect(tool.response.parse).toBeTypeOf("function");
      });
    });
  }
});

describe("tool request/response parsing", () => {
  it("file.read request", () => {
    expect(TOOLS["file.read"].request.parse({ fileId: "fil_abc" })).toEqual({ fileId: "fil_abc" });
  });

  it("file.read response", () => {
    expect(TOOLS["file.read"].response.parse({ content: "data", mime: "text/plain" })).toEqual({ content: "data", mime: "text/plain" });
  });

  it("file.write request", () => {
    const req = { workspaceId: "wks_abc", name: "f.txt", mime: "text/plain", contentBase64: "aGVsbG8=" };
    expect(TOOLS["file.write"].request.parse(req)).toEqual(req);
  });

  it("file.write request with optional chatId", () => {
    const req = { workspaceId: "wks_abc", name: "f.txt", mime: "text/plain", contentBase64: "aGVsbG8=", chatId: "cht_abc" };
    expect(TOOLS["file.write"].request.parse(req)).toEqual(req);
  });

  it("file.write response", () => {
    const res = { id: "fil_abc", workspaceId: "wks_abc", class: "artifact", path: "/f.txt", name: "f.txt", mime: "text/plain", size: 5, createdAt: now };
    expect(TOOLS["file.write"].response.parse(res)).toEqual(res);
  });

  it("library.list request", () => {
    expect(TOOLS["library.list"].request.parse({ workspaceId: "wks_abc" })).toEqual({ workspaceId: "wks_abc" });
  });

  it("library.list request with optional fields", () => {
    expect(TOOLS["library.list"].request.parse({ workspaceId: "wks_abc", cursor: "c1", limit: 10 })).toEqual({ workspaceId: "wks_abc", cursor: "c1", limit: 10 });
  });

  it("library.list response", () => {
    const res = { items: [], nextCursor: "c2" };
    expect(TOOLS["library.list"].response.parse(res)).toEqual(res);
  });

  it("library.get request", () => {
    expect(TOOLS["library.get"].request.parse({ fileId: "fil_abc" })).toEqual({ fileId: "fil_abc" });
  });

  it("library.get response", () => {
    const res = { id: "fil_abc", workspaceId: "wks_abc", class: "artifact", path: "/f.txt", name: "f.txt", mime: "text/plain", size: 5, createdAt: now, previewUrl: "http://x" };
    expect(TOOLS["library.get"].response.parse(res)).toEqual(res);
  });

  it("chat.send_message request", () => {
    expect(TOOLS["chat.send_message"].request.parse({ chatId: "cht_abc", content: "hi" })).toEqual({ chatId: "cht_abc", content: "hi" });
  });

  it("chat.send_message response", () => {
    const res = { id: "msg_abc", chatId: "cht_abc", role: "user", content: { type: "text", text: "hi" }, createdAt: now };
    expect(TOOLS["chat.send_message"].response.parse(res)).toEqual(res);
  });

  it("chat.attach_artifact request", () => {
    expect(TOOLS["chat.attach_artifact"].request.parse({ chatId: "cht_abc", fileId: "fil_abc" })).toEqual({ chatId: "cht_abc", fileId: "fil_abc" });
  });

  it("chat.attach_artifact response", () => {
    const res = { id: "msg_abc", chatId: "cht_abc", role: "system", content: { type: "artifactRef", fileId: "fil_abc" }, createdAt: now };
    expect(TOOLS["chat.attach_artifact"].response.parse(res)).toEqual(res);
  });

  it("web.fetch request", () => {
    expect(TOOLS["web.fetch"].request.parse({ url: "http://example.com" })).toEqual({ url: "http://example.com" });
  });

  it("web.fetch request with optional fields", () => {
    const req = { url: "http://example.com", method: "POST", headers: { "x-key": "v" }, bodyBase64: "aGk=" };
    expect(TOOLS["web.fetch"].request.parse(req)).toEqual(req);
  });

  it("web.fetch response", () => {
    const res = { status: 200, headers: { "content-type": "text/html" }, bodyBase64: "aGk=" };
    expect(TOOLS["web.fetch"].response.parse(res)).toEqual(res);
  });
});
