import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as http from "node:http";
import * as net from "node:net";
import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Pool, queries, runMigrations, seedIfEmpty } from "@agent-desk/db";
import { createRunManager } from "@agent-desk/scheduler";
import { generateId } from "@agent-desk/shared";
import { ensureLayout } from "@agent-desk/storage";
import { createApp } from "../src/app.js";
import { clearSessions } from "../src/auth/sessions.js";
import { clearConnections } from "../src/ws/registry.js";

let pool: Pool;
let server: http.Server;
let port: number;
let home: string;
let dbPath: string;
let workspaceId: string;
let agentId: string;
let sourceChatId: string;

beforeAll(async () => {
  const dbDir = await fs.mkdtemp(path.join(os.tmpdir(), "desk-sandbox-messages-db-"));
  dbPath = path.join(dbDir, "test.sqlite3");
  pool = new Pool({ path: dbPath });
  await runMigrations(pool);

  process.env.DESK_SEED_USERNAME = "sandbox-messages-user";
  process.env.DESK_SEED_PASSWORD = "pw";
  await seedIfEmpty(pool);

  home = await fs.mkdtemp(path.join(os.tmpdir(), "desk-sandbox-messages-"));
  await ensureLayout(home);
  process.env.DESK_HOME = home;

  const { rows: wsRows } = await pool.query<{ id: string }>("SELECT id FROM workspaces LIMIT 1");
  workspaceId = wsRows[0].id;
  const { rows: agentRows } = await pool.query<{ id: string }>("SELECT id FROM agents LIMIT 1");
  agentId = agentRows[0].id;

  sourceChatId = generateId("chat");
  await pool.query(
    `INSERT INTO chats (id, workspace_id, agent_id, title) VALUES (?, ?, ?, ?)`,
    [sourceChatId, workspaceId, agentId, "Source investigation chat"],
  );

  // Fake execRun so the auto-fire path on unscheduled tasks doesn't try
  // to spawn a real Docker sandbox. Resolves immediately with a short
  // stdout payload so finalizeExecution sees a clean exit.
  const runManager = createRunManager({
    pool,
    execRunFn: async (runId, _agentId, _prompt, onLog) => {
      await onLog({ runId, seq: 0, kind: "stdout", payload: JSON.stringify({ type: "text", part: { text: "ok" } }) });
      return { exitCode: 0 };
    },
  });
  server = createApp({ pool, storage: { pool, home }, runManager });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as net.AddressInfo).port;
});

afterAll(async () => {
  await clearSessions(pool);
  clearConnections();
  server?.close();
  if (pool) await pool.end();
  if (home) await fs.rm(home, { recursive: true, force: true });
  if (dbPath) await fs.rm(path.dirname(dbPath), { recursive: true, force: true });
  delete process.env.DESK_HOME;
});

async function issueSandboxToken(): Promise<string> {
  const token = `tok_${crypto.randomBytes(16).toString("hex")}`;
  await queries.sandboxSessions.issue(pool, {
    id: generateId("sandboxSession"),
    agentId,
    workspaceId,
    tokenHash: crypto.createHash("sha256").update(token).digest("hex"),
  });
  return token;
}

function sandboxPost(body: unknown, token: string, urlPath = "/sandbox/messages"): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const raw = JSON.stringify(body);
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: urlPath,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(raw),
          "X-Desk-Sandbox-Token": token,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString();
          resolve({ status: res.statusCode ?? 0, body: JSON.parse(text) });
        });
      },
    );
    req.on("error", reject);
    req.write(raw);
    req.end();
  });
}

describe("POST /sandbox/messages", () => {
  it("posts the task anchor in the source chat and spawns a dedicated thread chat", async () => {
    const token = await issueSandboxToken();
    const res = await sandboxPost({
      chatId: sourceChatId,
      title: "Stabilize blank replies",
      content: "Investigate the blank reply issue",
      attachments: [{ path: `.chats/${sourceChatId}/artifacts/report.md`, name: "report.md" }],
    }, token);

    expect(res.status).toBe(201);
    // Anchor lives in the source chat — the task message is the thread
    // start, visible inline in the source conversation.
    expect(res.body.message.chatId).toBe(sourceChatId);
    expect(res.body.message.kind).toBe("task");
    expect(res.body.message.threadChatId).toBe(res.body.threadChat.id);
    expect(res.body.message.attachments).toEqual([
      { path: `.chats/${sourceChatId}/artifacts/report.md`, name: "report.md" },
    ]);
    // Thread chat is a separate chat anchored to the task message; the
    // tasks list opens this thread (where task_runs / follow-ups land).
    expect(res.body.parentChatId).toBe(sourceChatId);
    expect(res.body.threadChat.id).not.toBe(sourceChatId);
    // Thread inherits the task anchor's title so the sidebar entry is
    // distinct from the parent ("Source investigation chat"); the
    // anchor's task title is the most informative source.
    expect(res.body.threadChat.title).toBe("Stabilize blank replies");
  });

  it("spawns a thread for scheduled and recurring tasks too — the schedule lives on the anchor", async () => {
    const token = await issueSandboxToken();
    const scheduled = await sandboxPost({
      chatId: sourceChatId,
      title: "Later one-shot",
      content: "Run later",
      executeAt: "2026-05-01T09:00:00Z",
    }, token);
    expect(scheduled.status).toBe(201);
    expect(scheduled.body.message.chatId).toBe(sourceChatId);
    expect(scheduled.body.message.executeAt).toBe("2026-05-01T09:00:00.000Z");
    expect(scheduled.body.message.threadChatId).toBe(scheduled.body.threadChat.id);
    expect(scheduled.body.threadChat.id).not.toBe(sourceChatId);

    const recurring = await sandboxPost({
      chatId: sourceChatId,
      title: "Daily ping",
      content: "Run daily",
      cron: "0 9 * * *",
    }, token);
    expect(recurring.status).toBe(201);
    expect(recurring.body.message.chatId).toBe(sourceChatId);
    expect(recurring.body.message.cron).toBe("0 9 * * *");
    expect(recurring.body.message.threadChatId).toBe(recurring.body.threadChat.id);
    expect(recurring.body.threadChat.id).not.toBe(sourceChatId);

    // Auto-fire is gated on having no schedule. Scheduled and recurring
    // tasks must NOT fire on insert — the scheduler owns their fire time.
    // We assert this on the recurring case (the riskier of the two: a
    // bug here would burn a cron tick early).
    await new Promise((r) => setTimeout(r, 50));
    const runs = await pool.query<{ count: number }>(
      `SELECT COUNT(*) AS count FROM messages
        WHERE chat_id = ? AND kind = 'task_run'`,
      [recurring.body.threadChat.id],
    );
    expect(runs.rows[0].count).toBe(0);
  });

  it("auto-fires unscheduled agent tasks — the anchor runs immediately, no manual Run click required", async () => {
    // The agent's intent when spawning an unscheduled sub-task via
    // `desk-agent task schedule` (no --at / --cron) is "go do this now."
    // Sitting in pending until the user clicks Run defeats the purpose.
    // The sandbox endpoint must insert the first task_run row before
    // returning so the response carries an `active` state and the UI's
    // status selector (which only marks a task active when a child run
    // is `running`) doesn't show `todo` for a window.
    const token = await issueSandboxToken();
    const res = await sandboxPost({
      chatId: sourceChatId,
      title: "Build a small app",
      content: "Scaffold a hello-world page.",
    }, token);
    expect(res.status).toBe(201);
    const threadChatId = res.body.threadChat.id as string;
    const anchorId = res.body.message.id as string;

    // The response itself must include the freshly-inserted task_run
    // in `running` state. This is the contract the UI's optimistic
    // active-on-create render relies on.
    expect(res.body.run).toBeDefined();
    expect(res.body.run.kind).toBe("task_run");
    expect(res.body.run.parentId).toBe(anchorId);
    expect(res.body.run.chatId).toBe(threadChatId);
    expect(res.body.run.state).toBe("running");

    // And the parent anchor must also reflect running — that's what keeps
    // the kanban Active badge sticky past the moment the task_run
    // terminates. Without this promotion the card would dip back to
    // "Open" the instant the run finished and the agent had not yet
    // called task complete.
    expect(res.body.message.state).toBe("running");

    // And the DB must reflect the same rows synchronously — no
    // poll-and-retry: the task_run exists and the parent is `running`
    // by the time the response returns. Use a single, immediate query
    // (no setTimeout loop).
    const { rows } = await pool.query<{ count: number; state: string }>(
      `SELECT COUNT(*) AS count, MIN(state) AS state FROM messages
        WHERE chat_id = ? AND kind = 'task_run' AND parent_id = ?`,
      [threadChatId, anchorId],
    );
    expect(rows[0].count).toBe(1);
    expect(rows[0].state).toBe("running");

    const { rows: anchorRows } = await pool.query<{ state: string }>(
      `SELECT state FROM messages WHERE id = ?`,
      [anchorId],
    );
    expect(anchorRows[0].state).toBe("running");
  });

  it("leaves a successful unscheduled agent task in `running` for `task complete` to close", async () => {
    // afterTaskRun deliberately does NOT propagate success onto an
    // agent-authored unscheduled parent: the canonical close is
    // `desk-agent task complete`, and auto-completing here would (a)
    // steal the Needs-input hand-off the agent's reply lands on the
    // thread chat, and (b) break callers that issue task complete after
    // the run terminates (the endpoint throws on terminal state). So
    // after a clean exit, the anchor is still `running` and the UI
    // selector renders it as Active (or Needs input if the thread is
    // unread). Failure is the only outcome that propagates from this
    // path — see the failed-run test below.
    const token = await issueSandboxToken();
    const res = await sandboxPost({
      chatId: sourceChatId,
      title: "Run that succeeds",
      content: "Print ok and exit.",
    }, token);
    expect(res.status).toBe(201);
    const anchorId = res.body.message.id as string;
    const threadChatId = res.body.threadChat.id as string;

    // Wait for the task_run to finalise: that is the signal afterTaskRun
    // has had its chance to mutate (or not) the parent. Polling on
    // task_run state is more robust than a fixed sleep — local CI is
    // bursty enough that a 100ms wait sometimes lands before the
    // background fire completes.
    let runState: string | null = null;
    for (let i = 0; i < 100; i++) {
      await new Promise((r) => setTimeout(r, 20));
      const { rows } = await pool.query<{ state: string }>(
        `SELECT state FROM messages WHERE chat_id = ? AND kind = 'task_run' AND parent_id = ?`,
        [threadChatId, anchorId],
      );
      runState = rows[0]?.state ?? null;
      if (runState === "succeeded" || runState === "failed" || runState === "cancelled") break;
    }
    expect(runState).toBe("succeeded");

    const { rows: anchorRows } = await pool.query<{ state: string }>(
      `SELECT state FROM messages WHERE id = ?`,
      [anchorId],
    );
    expect(anchorRows[0].state).toBe("running");
  });

  it("propagates a failed task_run's terminal state onto the agent-authored unscheduled parent", async () => {
    // Same contract as the success case, but for failure: the user must
    // see something other than the deceptive "Open" badge that the
    // previous policy left behind. We swap in a per-test runManager whose
    // execRunFn returns non-zero so finalizeExecution writes
    // state='failed' on the task_run and afterTaskRun mirrors that onto
    // the parent. statusText then renders "Failed" while the badge stays
    // Open (by design — failure is internal, the user retries from the
    // same column).
    const failingRunManager = createRunManager({
      pool,
      execRunFn: async (runId, _agentId, _prompt, onLog) => {
        await onLog({ runId, seq: 0, kind: "stderr", payload: "boom" });
        return { exitCode: 1 };
      },
    });
    const failingServer = createApp({ pool, storage: { pool, home }, runManager: failingRunManager });
    await new Promise<void>((resolve) => failingServer.listen(0, "127.0.0.1", resolve));
    const failingPort = (failingServer.address() as net.AddressInfo).port;
    try {
      const token = await issueSandboxToken();
      const raw = JSON.stringify({
        chatId: sourceChatId,
        title: "Run that fails",
        content: "Exit non-zero.",
      });
      const res = await new Promise<{ status: number; body: any }>((resolve, reject) => {
        const req = http.request(
          {
            hostname: "127.0.0.1",
            port: failingPort,
            path: "/sandbox/messages",
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Content-Length": Buffer.byteLength(raw),
              "X-Desk-Sandbox-Token": token,
            },
          },
          (response) => {
            const chunks: Buffer[] = [];
            response.on("data", (c) => chunks.push(c as Buffer));
            response.on("end", () => {
              const text = Buffer.concat(chunks).toString("utf8");
              try {
                resolve({ status: response.statusCode ?? 0, body: text ? JSON.parse(text) : null });
              } catch (e) {
                reject(e);
              }
            });
          },
        );
        req.on("error", reject);
        req.write(raw);
        req.end();
      });
      expect(res.status).toBe(201);
      const anchorId = res.body.message.id as string;

      let anchorState: string | null = null;
      for (let i = 0; i < 100; i++) {
        await new Promise((r) => setTimeout(r, 20));
        const { rows } = await pool.query<{ state: string }>(
          `SELECT state FROM messages WHERE id = ?`,
          [anchorId],
        );
        anchorState = rows[0]?.state ?? null;
        if (anchorState === "failed") break;
      }
      expect(anchorState).toBe("failed");
    } finally {
      failingServer.close();
    }
  });

  it("rejects requests with no chatId — agents must always anchor tasks to a chat", async () => {
    // Contract: the agent CLI's `--chat <id>` is required and the
    // sandbox endpoint mirrors that on the wire. Tasks are threads of a
    // source chat; there is no "create a chatless task" path for agents
    // today. (If we later want one, it should be an explicit opt-in
    // flag, not a missing-field fallback.)
    const token = await issueSandboxToken();
    const res = await sandboxPost({
      title: "No chat",
      content: "Should be rejected",
    }, token);
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/Missing chatId/);
  });

  it("rejects unsafe attachment paths before creating the anchor or thread", async () => {
    const token = await issueSandboxToken();
    const before = await pool.query<{ count: number }>("SELECT COUNT(*) AS count FROM chats");
    const beforeMsgs = await pool.query<{ count: number }>(
      "SELECT COUNT(*) AS count FROM messages WHERE chat_id = ?",
      [sourceChatId],
    );
    const res = await sandboxPost({
      chatId: sourceChatId,
      title: "Unsafe attachment",
      content: "This should not create a chat or message",
      attachments: [{ path: "/etc/passwd", name: "passwd" }],
    }, token);
    const after = await pool.query<{ count: number }>("SELECT COUNT(*) AS count FROM chats");
    const afterMsgs = await pool.query<{ count: number }>(
      "SELECT COUNT(*) AS count FROM messages WHERE chat_id = ?",
      [sourceChatId],
    );

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/Invalid attachment path/);
    expect(after.rows[0].count).toBe(before.rows[0].count);
    expect(afterMsgs.rows[0].count).toBe(beforeMsgs.rows[0].count);
  });
});

describe("POST /sandbox/messages/reschedule", () => {
  // Each scheduled task is an anchor in the source chat + a thread chat
  // anchored to it. Reschedule targets the anchor where it actually
  // lives (`message.chatId` === source chat), not the thread chat.
  async function createScheduledTask(token: string, executeAt = "2026-06-01T09:00:00Z") {
    const create = await sandboxPost({
      chatId: sourceChatId,
      title: "Daily review",
      content: "Review the build",
      executeAt,
    }, token);
    expect(create.status).toBe(201);
    const body = create.body as {
      threadChat: { id: string };
      parentChatId: string;
      message: { id: string; chatId: string; executeAt?: string; cron?: string; createdAt: string; title?: string; threadChatId?: string };
    };
    return { ...body.message, threadChatId: body.threadChat.id };
  }

  it("updates executeAt in place — same id, same created_at, state pending", async () => {
    const token = await issueSandboxToken();
    const created = await createScheduledTask(token);

    const res = await sandboxPost({
      chatId: created.chatId,
      messageId: created.id,
      executeAt: "2026-06-02T09:00:00Z",
    }, token, "/sandbox/messages/reschedule");

    expect(res.status).toBe(200);
    expect(res.body.id).toBe(created.id);
    expect(res.body.createdAt).toBe(created.createdAt);
    expect(res.body.executeAt).toBe("2026-06-02T09:00:00.000Z");
    expect(res.body.cron).toBeFalsy();
    expect(res.body.state).toBe("pending");

    // The anchor stays put — reschedule never creates a new task row.
    const { rows } = await pool.query<{ count: number }>(
      "SELECT COUNT(*) AS count FROM messages WHERE id = ? AND kind = 'task'",
      [created.id],
    );
    expect(rows[0].count).toBe(1);
  });

  it("swaps a one-shot task to recurring by clearing executeAt when cron is provided", async () => {
    const token = await issueSandboxToken();
    const created = await createScheduledTask(token, "2026-06-10T09:00:00Z");

    const res = await sandboxPost({
      chatId: created.chatId,
      messageId: created.id,
      cron: "0 9 * * 1-5",
    }, token, "/sandbox/messages/reschedule");

    expect(res.status).toBe(200);
    expect(res.body.id).toBe(created.id);
    expect(res.body.cron).toBe("0 9 * * 1-5");
    expect(res.body.executeAt).toBeTruthy();
    // rescheduleMessage recomputes executeAt from the cron expression; it
    // should no longer equal the original one-shot timestamp.
    expect(res.body.executeAt).not.toBe("2026-06-10T09:00:00Z");
  });

  it("optionally updates title and content alongside the schedule", async () => {
    const token = await issueSandboxToken();
    const created = await createScheduledTask(token, "2026-07-01T09:00:00Z");

    const res = await sandboxPost({
      chatId: created.chatId,
      messageId: created.id,
      executeAt: "2026-07-02T09:00:00Z",
      title: "Weekly review",
      content: "Updated body",
    }, token, "/sandbox/messages/reschedule");

    expect(res.status).toBe(200);
    expect(res.body.title).toBe("Weekly review");
    expect(res.body.content).toEqual({ type: "text", text: "Updated body" });
  });

  it("resurrects a cancelled task by resetting state to pending", async () => {
    const token = await issueSandboxToken();
    const created = await createScheduledTask(token, "2026-08-01T09:00:00Z");
    await sandboxPost({
      chatId: created.chatId,
      messageId: created.id,
    }, token, "/sandbox/messages/cancel");

    const res = await sandboxPost({
      chatId: created.chatId,
      messageId: created.id,
      executeAt: "2026-08-15T09:00:00Z",
    }, token, "/sandbox/messages/reschedule");

    expect(res.status).toBe(200);
    expect(res.body.state).toBe("pending");
    expect(res.body.executeAt).toBe("2026-08-15T09:00:00.000Z");
  });

  it("rejects when neither executeAt nor cron is supplied", async () => {
    const token = await issueSandboxToken();
    const created = await createScheduledTask(token, "2026-09-01T09:00:00Z");

    const res = await sandboxPost({
      chatId: created.chatId,
      messageId: created.id,
    }, token, "/sandbox/messages/reschedule");

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/executeAt or cron/);
  });

  it("rejects executeAt and cron together", async () => {
    const token = await issueSandboxToken();
    const created = await createScheduledTask(token, "2026-09-15T09:00:00Z");

    const res = await sandboxPost({
      chatId: created.chatId,
      messageId: created.id,
      executeAt: "2026-09-16T09:00:00Z",
      cron: "0 9 * * *",
    }, token, "/sandbox/messages/reschedule");

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/mutually exclusive/);
  });

  it("rejects messages from a different chat", async () => {
    const token = await issueSandboxToken();
    const created = await createScheduledTask(token, "2026-10-01T09:00:00Z");
    const otherChatId = generateId("chat");
    await pool.query(
      `INSERT INTO chats (id, workspace_id, agent_id, title) VALUES (?, ?, ?, ?)`,
      [otherChatId, workspaceId, agentId, "Other chat"],
    );

    const res = await sandboxPost({
      chatId: otherChatId,
      messageId: created.id,
      executeAt: "2026-10-02T09:00:00Z",
    }, token, "/sandbox/messages/reschedule");

    expect(res.status).toBe(404);
  });

  it("rejects non-task message kinds", async () => {
    const token = await issueSandboxToken();
    const chatMsgId = generateId("message");
    await pool.query(
      `INSERT INTO messages (id, chat_id, role, content, kind, created_at, updated_at)
       VALUES (?, ?, 'user', '{"type":"text","text":"hi"}', 'chat', ?, ?)`,
      [chatMsgId, sourceChatId, new Date(), new Date()],
    );

    const res = await sandboxPost({
      chatId: sourceChatId,
      messageId: chatMsgId,
      executeAt: "2026-11-01T09:00:00Z",
    }, token, "/sandbox/messages/reschedule");

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/Only task messages/);
  });
});

describe("POST /sandbox/messages/complete", () => {
  // The agent sits inside the sub-task thread; it passes the thread chat
  // id and the server walks back to the anchor in the parent chat.
  async function spawnSubTask(token: string, opts?: { cron?: string; at?: string }) {
    const body: Record<string, unknown> = {
      chatId: sourceChatId,
      title: "Sub-task",
      content: "Investigate the spike",
    };
    if (opts?.cron) body.cron = opts.cron;
    if (opts?.at) body.executeAt = opts.at;
    const create = await sandboxPost(body, token);
    expect(create.status).toBe(201);
    const result = create.body as {
      message: { id: string; chatId: string; state: string };
      threadChat: { id: string };
      parentChatId: string;
    };
    return result;
  }

  it("flips the anchor to succeeded and posts the report back to the parent chat", async () => {
    const token = await issueSandboxToken();
    const spawned = await spawnSubTask(token);

    const before = await pool.query<{ count: number }>(
      "SELECT COUNT(*) AS count FROM messages WHERE chat_id = ?",
      [spawned.parentChatId],
    );
    const res = await sandboxPost({
      chatId: spawned.threadChat.id,
      message: "Done — 3 PRs flagged: #145, #161, #163.",
    }, token, "/sandbox/messages/complete");
    expect(res.status).toBe(200);

    // Anchor transitioned to succeeded, executeAt cleared.
    expect(res.body.task.id).toBe(spawned.message.id);
    expect(res.body.task.state).toBe("succeeded");
    expect(res.body.task.executeAt).toBeFalsy();
    expect(res.body.parentChatId).toBe(spawned.parentChatId);

    // Report message landed in the *parent* chat with parentId = anchor.
    expect(res.body.report).toBeTruthy();
    expect(res.body.report.chatId).toBe(spawned.parentChatId);
    expect(res.body.report.role).toBe("agent");
    expect(res.body.report.parentId).toBe(spawned.message.id);
    expect(res.body.report.content).toEqual({
      type: "text",
      text: "Done — 3 PRs flagged: #145, #161, #163.",
    });

    // Exactly one new row in the parent chat (the report). Anchor was
    // already there from spawn; thread messages live elsewhere.
    const after = await pool.query<{ count: number }>(
      "SELECT COUNT(*) AS count FROM messages WHERE chat_id = ?",
      [spawned.parentChatId],
    );
    expect(after.rows[0].count).toBe(before.rows[0].count + 1);
  });

  it("works without a --message — anchor flips to succeeded but no report is posted", async () => {
    const token = await issueSandboxToken();
    const spawned = await spawnSubTask(token);

    const before = await pool.query<{ count: number }>(
      "SELECT COUNT(*) AS count FROM messages WHERE chat_id = ?",
      [spawned.parentChatId],
    );
    const res = await sandboxPost({
      chatId: spawned.threadChat.id,
    }, token, "/sandbox/messages/complete");
    expect(res.status).toBe(200);
    expect(res.body.task.state).toBe("succeeded");
    expect(res.body.report).toBeUndefined();

    const after = await pool.query<{ count: number }>(
      "SELECT COUNT(*) AS count FROM messages WHERE chat_id = ?",
      [spawned.parentChatId],
    );
    expect(after.rows[0].count).toBe(before.rows[0].count);
  });

  it("rejects recurring (cron) tasks — they're not the right shape for completion", async () => {
    const token = await issueSandboxToken();
    const spawned = await spawnSubTask(token, { cron: "0 9 * * *" });

    const res = await sandboxPost({
      chatId: spawned.threadChat.id,
      message: "Should be rejected",
    }, token, "/sandbox/messages/complete");
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/Recurring tasks cannot be marked complete/);

    // Anchor unchanged (still pending).
    const anchor = await pool.query<{ state: string }>(
      "SELECT state FROM messages WHERE id = ?",
      [spawned.message.id],
    );
    expect(anchor.rows[0].state).toBe("pending");
  });

  it("rejects a second complete on a task that's already terminal", async () => {
    const token = await issueSandboxToken();
    const spawned = await spawnSubTask(token);

    const first = await sandboxPost({
      chatId: spawned.threadChat.id,
    }, token, "/sandbox/messages/complete");
    expect(first.status).toBe(200);

    const second = await sandboxPost({
      chatId: spawned.threadChat.id,
      message: "second attempt",
    }, token, "/sandbox/messages/complete");
    expect(second.status).toBe(400);
    expect(second.body.message).toMatch(/already in terminal state/);
  });

  it("rejects when the chat is not a thread chat (no anchor pointing at it)", async () => {
    const token = await issueSandboxToken();
    const orphanChatId = generateId("chat");
    await pool.query(
      `INSERT INTO chats (id, workspace_id, agent_id, title) VALUES (?, ?, ?, ?)`,
      [orphanChatId, workspaceId, agentId, "Not a thread"],
    );

    const res = await sandboxPost({
      chatId: orphanChatId,
    }, token, "/sandbox/messages/complete");
    expect(res.status).toBe(404);
    expect(res.body.message).toMatch(/No task anchor/);
  });

  it("rejects requests with neither chatId nor messageId", async () => {
    const token = await issueSandboxToken();
    const res = await sandboxPost({
      message: "no chat",
    }, token, "/sandbox/messages/complete");
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/Missing messageId or chatId/);
  });

  // Lets the agent complete a task from outside its thread — e.g. from
  // the source chat or an unrelated interactive run where the agent has
  // the anchor id in context but isn't sitting inside the thread chat.
  it("completes a task by messageId from any chat (no thread chat required)", async () => {
    const token = await issueSandboxToken();
    const spawned = await spawnSubTask(token);

    const before = await pool.query<{ count: number }>(
      "SELECT COUNT(*) AS count FROM messages WHERE chat_id = ?",
      [spawned.parentChatId],
    );
    const res = await sandboxPost({
      messageId: spawned.message.id,
      message: "Done — closed via messageId path.",
    }, token, "/sandbox/messages/complete");
    expect(res.status).toBe(200);

    expect(res.body.task.id).toBe(spawned.message.id);
    expect(res.body.task.state).toBe("succeeded");
    expect(res.body.parentChatId).toBe(spawned.parentChatId);
    expect(res.body.report).toBeTruthy();
    expect(res.body.report.chatId).toBe(spawned.parentChatId);
    expect(res.body.report.parentId).toBe(spawned.message.id);

    const after = await pool.query<{ count: number }>(
      "SELECT COUNT(*) AS count FROM messages WHERE chat_id = ?",
      [spawned.parentChatId],
    );
    expect(after.rows[0].count).toBe(before.rows[0].count + 1);
  });

  it("messageId path: 404s when the task id doesn't exist", async () => {
    const token = await issueSandboxToken();
    const res = await sandboxPost({
      messageId: "msg_does_not_exist",
    }, token, "/sandbox/messages/complete");
    expect(res.status).toBe(404);
    expect(res.body.message).toMatch(/Task not found/);
  });

  it("messageId path: rejects when the message isn't a task", async () => {
    const token = await issueSandboxToken();
    // A plain chat message in the source chat — not a task anchor.
    const plainId = generateId("message");
    await pool.query(
      `INSERT INTO messages (id, chat_id, role, kind, content) VALUES (?, ?, ?, ?, ?)`,
      [plainId, sourceChatId, "user", "chat", JSON.stringify({ type: "text", text: "hi" })],
    );

    const res = await sandboxPost({
      messageId: plainId,
    }, token, "/sandbox/messages/complete");
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/is not a task/);
  });
});
