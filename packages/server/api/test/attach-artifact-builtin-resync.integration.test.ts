/**
 * Built-in app attachment lazily re-syncs the .apps mirror.
 *
 * `writeBuiltinApps` populates `${DESK_HOME}/.apps/` once at server
 * start. If desk-apps was built (or freshly checked out) after the
 * server booted, the mirror is stale and the agent's
 * `/opt/desk-apps/<name>.app/...` attach fails with NOT_FOUND, which
 * pushes the agent onto a workspace-relative fallback that gets
 * rendered in library scope and silently fails to post chat messages.
 *
 * The fix: on a global-path miss, re-run `writeBuiltinApps` once and
 * re-stat before giving up. This test simulates that exact race —
 * empty `.apps/` mirror at first call, source bundle populated, attach
 * must succeed.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Pool, runMigrations } from "@agent-desk/db";
import { generateId } from "@agent-desk/shared";
import { ensureLayout, ensureWorkspaceLayout } from "@agent-desk/storage";
import { attachArtifactRef } from "../src/routes/chats-attachments.js";

let pool: Pool;
let home: string;
let dbDir: string;
let chatId: string;

beforeAll(async () => {
  dbDir = await fs.mkdtemp(path.join(os.tmpdir(), "desk-attach-resync-db-"));
  pool = new Pool({ path: path.join(dbDir, "test.sqlite3") });
  await runMigrations(pool);

  home = await fs.mkdtemp(path.join(os.tmpdir(), "desk-attach-resync-"));
  await ensureLayout(home);

  const userId = generateId("user");
  await pool.query(
    `INSERT INTO users (id, username, password_hash, email) VALUES (?, 'resync-user', 'hash', 'resync@example.com')`,
    [userId],
  );
  const workspaceId = generateId("workspace");
  const workspaceSlug = `resync-${workspaceId.slice(-6)}`;
  await pool.query(
    `INSERT INTO workspaces (id, user_id, name, path) VALUES (?, ?, 'Resync', ?)`,
    [workspaceId, userId, workspaceSlug],
  );
  await ensureWorkspaceLayout(home, workspaceSlug);
  const agentId = generateId("agent");
  await pool.query(
    `INSERT INTO agents (id, user_id, name) VALUES (?, ?, 'test-agent')`,
    [agentId, userId],
  );
  chatId = generateId("chat");
  await pool.query(
    `INSERT INTO chats (id, workspace_id, agent_id, title) VALUES (?, ?, ?, 'Resync chat')`,
    [chatId, workspaceId, agentId],
  );
});

afterAll(async () => {
  if (pool) await pool.end();
  if (home) await fs.rm(home, { recursive: true, force: true });
  if (dbDir) await fs.rm(dbDir, { recursive: true, force: true });
});

describe("attachArtifactRef — global app path", () => {
  it("falls back to writeBuiltinApps when the .apps mirror is missing the requested file", async () => {
    // Mirror is empty: simulates "server started before desk-apps was
    // built / checked out".
    const appsDir = path.join(home, ".apps");
    await fs.rm(appsDir, { recursive: true, force: true });
    await fs.mkdir(appsDir, { recursive: true });

    // First call: writeBuiltinApps re-syncs from the bundled source
    // (the repo's `packages/desk-apps/`). chat-forms.app ships
    // multi-step, so the path should resolve on retry.
    const message = await attachArtifactRef(
      { pool, home },
      {
        chatId,
        path: "/opt/desk-apps/chat-forms.app/dist/fragments/multi-step",
        params: { steps: "[]" },
      },
      () => undefined,
    );

    expect(message.content).toMatchObject({
      type: "artifactRef",
      path: "/opt/desk-apps/chat-forms.app/dist/fragments/multi-step",
      name: "multi-step",
      mime: "inode/directory",
    });

    // And the mirror is now populated for subsequent calls.
    const stat = await fs.stat(
      path.join(appsDir, "chat-forms.app", "dist", "fragments", "multi-step"),
    );
    expect(stat.isDirectory()).toBe(true);
  });

  it("returns NOT_FOUND when the path doesn't exist even after re-sync", async () => {
    await expect(
      attachArtifactRef(
        { pool, home },
        {
          chatId,
          path: "/opt/desk-apps/chat-forms.app/dist/fragments/does-not-exist",
        },
        () => undefined,
      ),
    ).rejects.toThrow(/Built-in app artifact not found/);
  });

  // Regression: before this guard, an agent that hit a NOT_FOUND on the
  // correct `…/dist/fragments/<frag>` path (because dist hadn't been
  // built yet) could retry with the source-side `…/fragments/<frag>`
  // shape — which exists in the mounted source tree and so attached
  // successfully, but the SPA's parseGlobalAppPath only routes the dist
  // shape, leaving a stored-but-unrenderable artifactRef behind.
  it("rejects built-in app paths missing the dist/fragments/<frag> shape", async () => {
    await expect(
      attachArtifactRef(
        { pool, home },
        {
          chatId,
          path: "/opt/desk-apps/chat-forms.app/fragments/multi-step",
        },
        () => undefined,
      ),
    ).rejects.toThrow(/Built-in app path must be/);
    await expect(
      attachArtifactRef(
        { pool, home },
        {
          chatId,
          path: "/opt/desk-apps/chat-forms.app/src/main.tsx",
        },
        () => undefined,
      ),
    ).rejects.toThrow(/Built-in app path must be/);
  });
});
