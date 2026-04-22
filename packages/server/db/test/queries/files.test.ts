import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";
import { generateId } from "@desk/shared";
import { setupTestDb, teardownTestDb } from "../helpers/db.js";
import * as users from "../../src/queries/users.js";
import * as workspaces from "../../src/queries/workspaces.js";
import * as files from "../../src/queries/files.js";

let pool: pg.Pool;
let wsId: string;

beforeAll(async () => {
  pool = await setupTestDb();
  const userId = generateId("user");
  await users.insert(pool, { id: userId, username: "fileowner", passwordHash: "h", email: "file@example.com" });
  wsId = generateId("workspace");
  await workspaces.insert(pool, { id: wsId, userId, name: "FileWS" });
});

afterAll(async () => {
  await teardownTestDb(pool);
});

describe("files queries", () => {
  const fileId = generateId("file");

  it("inserts a file", async () => {
    const file = await files.insert(pool, {
      id: fileId,
      workspaceId: wsId,
      class: "artifact",
      path: "/artifacts/test.txt",
      name: "test.txt",
      mime: "text/plain",
      size: 42,
    });
    expect(file.id).toBe(fileId);
    expect(file.name).toBe("test.txt");
    expect(file.size).toBe(42);
  });

  it("finds by id", async () => {
    const file = await files.findById(pool, fileId);
    expect(file).not.toBeNull();
    expect(file!.class).toBe("artifact");
  });

  it("lists by workspace", async () => {
    const result = await files.listByWorkspace(pool, wsId);
    expect(result.items.length).toBeGreaterThanOrEqual(1);
  });

  it("lists by workspace with class filter", async () => {
    const result = await files.listByWorkspace(pool, wsId, { class: "artifact" });
    expect(result.items.length).toBeGreaterThanOrEqual(1);

    const empty = await files.listByWorkspace(pool, wsId, { class: "cache" });
    expect(empty.items).toHaveLength(0);
  });

  it("deletes by id", async () => {
    const ok = await files.deleteById(pool, fileId);
    expect(ok).toBe(true);
    const file = await files.findById(pool, fileId);
    expect(file).toBeNull();
  });
});
