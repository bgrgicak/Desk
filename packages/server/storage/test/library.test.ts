import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Readable } from "node:stream";
import { uploadArtifact } from "../src/files.js";
import { listLibrary, promoteToLibrary } from "../src/library.js";
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

describe("promoteToLibrary", () => {
  it("moves a chat attachment to the library directory and updates class", async () => {
    const uploaded = await uploadArtifact(ctx, {
      workspaceId: ctx.workspaceId,
      chatId: ctx.chatId,
      name: "promote-me.txt",
      mime: "text/plain",
      stream: makeStream("library content"),
    });

    expect(uploaded.class).toBe("artifact");

    const promoted = await promoteToLibrary(ctx, uploaded.id);
    expect(promoted.class).toBe("library");
    expect(promoted.path).toContain("library/");

    // Verify file is in library dir on disk
    const hostPath = path.join(ctx.home, "Desk", "workspaces", "desk", promoted.path);
    const content = await fs.readFile(hostPath, "utf-8");
    expect(content).toBe("library content");
  });

  it("is a no-op if file is already in library", async () => {
    const uploaded = await uploadArtifact(ctx, {
      workspaceId: ctx.workspaceId,
      chatId: ctx.chatId,
      name: "already-lib.txt",
      mime: "text/plain",
      stream: makeStream("already here"),
    });

    const promoted = await promoteToLibrary(ctx, uploaded.id);
    expect(promoted.class).toBe("library");

    // Promote again — should be no-op
    const again = await promoteToLibrary(ctx, promoted.id);
    expect(again.id).toBe(promoted.id);
    expect(again.class).toBe("library");
  });
});

describe("listLibrary", () => {
  it("returns only library-class files", async () => {
    // Upload a workspace file (not library)
    await uploadArtifact(ctx, {
      workspaceId: ctx.workspaceId,
      name: "not-library.txt",
      mime: "text/plain",
      stream: makeStream("workspace file"),
    });

    // Upload and promote to library
    const toPromote = await uploadArtifact(ctx, {
      workspaceId: ctx.workspaceId,
      chatId: ctx.chatId,
      name: "is-library.txt",
      mime: "text/plain",
      stream: makeStream("library file"),
    });
    await promoteToLibrary(ctx, toPromote.id);

    const { items } = await listLibrary(ctx, ctx.workspaceId);
    // All returned items should be library class
    for (const item of items) {
      expect(item.class).toBe("library");
    }
    // The promoted file should be in the list
    expect(items.some((f) => f.id === toPromote.id)).toBe(true);
  });
});
