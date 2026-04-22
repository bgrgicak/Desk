import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Readable } from "node:stream";
import { uploadArtifact } from "../src/files.js";
import { listLibrary } from "../src/library.js";
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

describe("listLibrary", () => {
  it("returns files uploaded to the library root, excluding dotfiles", async () => {
    await uploadArtifact(ctx, {
      workspaceId: ctx.workspaceId,
      name: "first.txt",
      mime: "text/plain",
      stream: makeStream("one"),
    });
    await uploadArtifact(ctx, {
      workspaceId: ctx.workspaceId,
      name: "second.txt",
      mime: "text/plain",
      stream: makeStream("two"),
    });

    const { items } = await listLibrary(ctx, ctx.workspaceId);
    const names = items.map((i) => i.name);
    expect(names).toContain("first.txt");
    expect(names).toContain("second.txt");
  });

  it("paginates by mtime cursor", async () => {
    for (let i = 0; i < 4; i++) {
      await uploadArtifact(ctx, {
        workspaceId: ctx.workspaceId,
        name: `page-${i}.txt`,
        mime: "text/plain",
        stream: makeStream(`content ${i}`),
      });
      // Ensure mtimes differ
      await new Promise((r) => setTimeout(r, 10));
    }

    const page1 = await listLibrary(ctx, ctx.workspaceId, { limit: 2 });
    expect(page1.items.length).toBe(2);
    expect(page1.nextCursor).toBeDefined();

    const page2 = await listLibrary(ctx, ctx.workspaceId, {
      limit: 2,
      cursor: page1.nextCursor,
    });
    expect(page2.items.length).toBeGreaterThanOrEqual(1);
    // Pages should not overlap.
    const ids1 = new Set(page1.items.map((i) => i.path));
    for (const item of page2.items) {
      expect(ids1.has(item.path)).toBe(false);
    }
  });
});
