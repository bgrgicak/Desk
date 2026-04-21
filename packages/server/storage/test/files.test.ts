import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Readable } from "node:stream";
import { NotFoundError, ValidationError, MAX_UPLOAD_BYTES } from "@desk/shared";
import { queries } from "@desk/db";
import {
  uploadArtifact,
  readFile,
  downloadFile,
  deleteFile,
  resolveForSandbox,
} from "../src/files.js";
import {
  setupTestStorage,
  teardownTestStorage,
  type TestStorageContext,
} from "./helpers/storage.js";

let ctx: TestStorageContext;

beforeAll(async () => {
  ctx = await setupTestStorage();
});

afterAll(async () => {
  await teardownTestStorage(ctx);
});

function makeStream(content: string): Readable {
  return Readable.from(Buffer.from(content));
}

describe("uploadArtifact", () => {
  it("uploads a workspace file and inserts a DB row", async () => {
    const file = await uploadArtifact(ctx, {
      workspaceId: ctx.workspaceId,
      name: "hello.txt",
      mime: "text/plain",
      stream: makeStream("hello world"),
    });

    expect(file.id).toMatch(/^fil_/);
    expect(file.name).toBe("hello.txt");
    expect(file.mime).toBe("text/plain");
    expect(file.class).toBe("workspace");
    expect(file.size).toBe(11);
    expect(file.workspaceId).toBe(ctx.workspaceId);

    // Verify DB row
    const dbFile = await queries.files.findById(ctx.pool, file.id);
    expect(dbFile).not.toBeNull();
    expect(dbFile!.name).toBe("hello.txt");

    // Verify file on disk
    const hostPath = path.join(ctx.home, "Desk", "workspaces", "desk", file.path);
    const content = await fs.readFile(hostPath, "utf-8");
    expect(content).toBe("hello world");
  });

  it("uploads a library file to library/, not files/", async () => {
    const file = await uploadArtifact(ctx, {
      workspaceId: ctx.workspaceId,
      name: "report.md",
      mime: "text/markdown",
      class: "library",
      stream: makeStream("library content"),
    });

    expect(file.class).toBe("library");
    // Path is stored relative to the workspace root — must live under library/,
    // NOT under files/. This regressed once; the test guards that.
    expect(file.path).toMatch(/^library\//);
    expect(file.path).not.toMatch(/^files\//);

    // And the bytes must actually exist at that path on disk.
    const hostPath = path.join(ctx.home, "Desk", "workspaces", "desk", file.path);
    const content = await fs.readFile(hostPath, "utf-8");
    expect(content).toBe("library content");
  });

  it("uploads a chat attachment", async () => {
    const file = await uploadArtifact(ctx, {
      workspaceId: ctx.workspaceId,
      chatId: ctx.chatId,
      name: "artifact.png",
      mime: "image/png",
      stream: makeStream("fake-png-data"),
    });

    expect(file.class).toBe("artifact");
    expect(file.chatId).toBe(ctx.chatId);
    expect(file.path).toContain("chats/");
  });

  it("rejects files exceeding MAX_UPLOAD_BYTES", async () => {
    // Create a stream that produces more than MAX_UPLOAD_BYTES
    const bigChunk = Buffer.alloc(MAX_UPLOAD_BYTES + 1, "x");
    const stream = Readable.from(bigChunk);

    await expect(
      uploadArtifact(ctx, {
        workspaceId: ctx.workspaceId,
        name: "toobig.bin",
        mime: "application/octet-stream",
        stream,
      }),
    ).rejects.toThrow(ValidationError);
  });
});

describe("readFile", () => {
  it("returns stream and metadata for an uploaded file", async () => {
    const uploaded = await uploadArtifact(ctx, {
      workspaceId: ctx.workspaceId,
      name: "read-test.txt",
      mime: "text/plain",
      stream: makeStream("read me"),
    });

    const { stream, file } = await readFile(ctx, uploaded.id);
    expect(file.id).toBe(uploaded.id);

    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(Buffer.from(chunk));
    }
    expect(Buffer.concat(chunks).toString()).toBe("read me");
  });

  it("throws NotFoundError for unknown ID", async () => {
    await expect(readFile(ctx, "fil_nonexistent123456789")).rejects.toThrow(NotFoundError);
  });
});

describe("downloadFile", () => {
  it("returns same result as readFile", async () => {
    const uploaded = await uploadArtifact(ctx, {
      workspaceId: ctx.workspaceId,
      name: "download-test.txt",
      mime: "text/plain",
      stream: makeStream("download me"),
    });

    const { stream, file } = await downloadFile(ctx, uploaded.id);
    expect(file.id).toBe(uploaded.id);

    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(Buffer.from(chunk));
    }
    expect(Buffer.concat(chunks).toString()).toBe("download me");
  });
});

describe("deleteFile", () => {
  it("removes the DB row and unlinks the file", async () => {
    const uploaded = await uploadArtifact(ctx, {
      workspaceId: ctx.workspaceId,
      name: "delete-me.txt",
      mime: "text/plain",
      stream: makeStream("bye"),
    });

    const hostPath = path.join(ctx.home, "Desk", "workspaces", "desk", uploaded.path);
    // File exists on disk
    await fs.access(hostPath);

    await deleteFile(ctx, uploaded.id);

    // DB row gone
    const dbFile = await queries.files.findById(ctx.pool, uploaded.id);
    expect(dbFile).toBeNull();

    // File gone from disk
    await expect(fs.access(hostPath)).rejects.toThrow();
  });

  it("throws NotFoundError for unknown ID", async () => {
    await expect(deleteFile(ctx, "fil_nonexistent123456789")).rejects.toThrow(NotFoundError);
  });
});

describe("resolveForSandbox", () => {
  it("returns the absolute host path", async () => {
    const uploaded = await uploadArtifact(ctx, {
      workspaceId: ctx.workspaceId,
      name: "sandbox-resolve.txt",
      mime: "text/plain",
      stream: makeStream("sandbox"),
    });

    const resolved = await resolveForSandbox(ctx, uploaded.id);
    expect(path.isAbsolute(resolved)).toBe(true);
    expect(resolved).toContain("desk-storage-test-");
    expect(resolved).toContain("sandbox-resolve.txt");

    // Verify the file actually exists at that path
    await fs.access(resolved);
  });

  it("throws NotFoundError for unknown ID", async () => {
    await expect(resolveForSandbox(ctx, "fil_nonexistent123456789")).rejects.toThrow(NotFoundError);
  });
});
