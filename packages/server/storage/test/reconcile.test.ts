import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Readable } from "node:stream";
import { generateId } from "@desk/shared";
import { uploadArtifact } from "../src/files.js";
import { reconcileArtifactRefs } from "../src/reconcile.js";
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

async function insertArtifactMessage(
  filePath: string,
  extra: Record<string, unknown> = {},
): Promise<string> {
  const id = generateId("message");
  const content = { type: "artifactRef", path: filePath, name: path.basename(filePath), ...extra };
  await ctx.pool.query(
    `INSERT INTO messages (id, chat_id, role, content)
     VALUES ($1, $2, 'agent', $3)`,
    [id, ctx.chatId, JSON.stringify(content)],
  );
  return id;
}

async function readContent(messageId: string): Promise<Record<string, unknown>> {
  const { rows } = await ctx.pool.query(
    "SELECT content FROM messages WHERE id = $1",
    [messageId],
  );
  return rows[0].content;
}

describe("reconcileArtifactRefs", () => {
  it("no-op when all referenced paths exist", async () => {
    const file = await uploadArtifact(ctx, {
      workspaceId: ctx.workspaceId,
      name: "present.txt",
      mime: "text/plain",
      stream: Readable.from(Buffer.from("hi")),
    });
    const mid = await insertArtifactMessage(file.path);

    const stats = await reconcileArtifactRefs(ctx.pool, ctx.home);
    expect(stats.checked).toBeGreaterThanOrEqual(1);

    const content = await readContent(mid);
    expect(content.path).toBe(file.path);
    expect(content.missing).toBeUndefined();
  });

  it("repairs a moved file when exactly one candidate by basename exists", async () => {
    const file = await uploadArtifact(ctx, {
      workspaceId: ctx.workspaceId,
      name: "moved-me.txt",
      mime: "text/plain",
      stream: Readable.from(Buffer.from("content")),
    });
    const mid = await insertArtifactMessage(file.path);

    // Move the file out of library/ into the workspace root (simulate rename).
    const root = path.join(ctx.home, "Desk", "workspaces", "desk");
    const oldAbs = path.join(root, file.path);
    const newAbs = path.join(root, "moved-me.txt");
    await fs.rename(oldAbs, newAbs);

    const stats = await reconcileArtifactRefs(ctx.pool, ctx.home);
    expect(stats.repaired).toBeGreaterThanOrEqual(1);

    const content = await readContent(mid);
    expect(content.path).toBe("moved-me.txt");
    expect(content.missing).toBeUndefined();

    // Cleanup
    await fs.unlink(newAbs).catch(() => {});
  });

  it("marks missing when no candidate can be found", async () => {
    const mid = await insertArtifactMessage("library/ghost.txt");

    const stats = await reconcileArtifactRefs(ctx.pool, ctx.home);
    expect(stats.missing).toBeGreaterThanOrEqual(1);

    const content = await readContent(mid);
    expect(content.missing).toBe(true);
    expect(content.path).toBe("library/ghost.txt");
  });

  it("clears a missing marker if the file returns", async () => {
    const mid = await insertArtifactMessage("library/comeback.txt", { missing: true });

    // Create the file so reconcile finds it.
    const abs = path.join(ctx.home, "Desk", "workspaces", "desk", "library", "comeback.txt");
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, "back!");

    await reconcileArtifactRefs(ctx.pool, ctx.home);

    const content = await readContent(mid);
    expect(content.missing).toBeUndefined();

    await fs.unlink(abs).catch(() => {});
  });

  it("does not repair when multiple candidates exist", async () => {
    // Two files named "ambig.txt" in different places.
    const libAbs = path.join(ctx.home, "Desk", "workspaces", "desk", "library", "ambig.txt");
    const filesAbs = path.join(ctx.home, "Desk", "workspaces", "desk", "files", "ambig.txt");
    await fs.writeFile(libAbs, "a");
    await fs.writeFile(filesAbs, "b");

    // Reference a third, non-existent location.
    const mid = await insertArtifactMessage("chats/other/ambig.txt");

    await reconcileArtifactRefs(ctx.pool, ctx.home);

    const content = await readContent(mid);
    expect(content.missing).toBe(true);

    await fs.unlink(libAbs).catch(() => {});
    await fs.unlink(filesAbs).catch(() => {});
  });
});
