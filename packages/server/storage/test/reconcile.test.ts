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
      workspaceSlug: ctx.workspaceSlug,
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
    // Upload to the workspace root, then simulate moving it into a subfolder.
    const file = await uploadArtifact(ctx, {
      workspaceId: ctx.workspaceId,
      workspaceSlug: ctx.workspaceSlug,
      name: "moved-me.txt",
      mime: "text/plain",
      stream: Readable.from(Buffer.from("content")),
    });
    const mid = await insertArtifactMessage(file.path);

    const root = path.join(ctx.home, "Desk", "workspaces", "desk");
    const oldAbs = path.join(root, file.path);
    const newAbs = path.join(root, "Projects", "moved-me.txt");
    await fs.mkdir(path.dirname(newAbs), { recursive: true });
    await fs.rename(oldAbs, newAbs);

    const stats = await reconcileArtifactRefs(ctx.pool, ctx.home);
    expect(stats.repaired).toBeGreaterThanOrEqual(1);

    const content = await readContent(mid);
    expect(content.path).toBe("Projects/moved-me.txt");
    expect(content.missing).toBeUndefined();

    // Cleanup
    await fs.unlink(newAbs).catch(() => {});
    await fs.rmdir(path.dirname(newAbs)).catch(() => {});
  });

  it("marks missing when no candidate can be found", async () => {
    const mid = await insertArtifactMessage("ghost.txt");

    const stats = await reconcileArtifactRefs(ctx.pool, ctx.home);
    expect(stats.missing).toBeGreaterThanOrEqual(1);

    const content = await readContent(mid);
    expect(content.missing).toBe(true);
    expect(content.path).toBe("ghost.txt");
  });

  it("clears a missing marker if the file returns", async () => {
    const mid = await insertArtifactMessage("comeback.txt", { missing: true });

    // Create the file so reconcile finds it.
    const abs = path.join(ctx.home, "Desk", "workspaces", "desk", "comeback.txt");
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, "back!");

    await reconcileArtifactRefs(ctx.pool, ctx.home);

    const content = await readContent(mid);
    expect(content.missing).toBeUndefined();

    await fs.unlink(abs).catch(() => {});
  });

  it("does not repair when multiple candidates exist", async () => {
    // Two files named "ambig.txt" in different user-visible folders.
    const root = path.join(ctx.home, "Desk", "workspaces", "desk");
    const aAbs = path.join(root, "Projects", "ambig.txt");
    const bAbs = path.join(root, "Notes", "ambig.txt");
    await fs.mkdir(path.dirname(aAbs), { recursive: true });
    await fs.mkdir(path.dirname(bAbs), { recursive: true });
    await fs.writeFile(aAbs, "a");
    await fs.writeFile(bAbs, "b");

    // Reference a third, non-existent location.
    const mid = await insertArtifactMessage("Elsewhere/ambig.txt");

    await reconcileArtifactRefs(ctx.pool, ctx.home);

    const content = await readContent(mid);
    expect(content.missing).toBe(true);

    await fs.unlink(aAbs).catch(() => {});
    await fs.unlink(bAbs).catch(() => {});
    await fs.rmdir(path.dirname(aAbs)).catch(() => {});
    await fs.rmdir(path.dirname(bAbs)).catch(() => {});
  });
});
