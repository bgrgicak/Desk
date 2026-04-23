import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import pg from "pg";
import {
  generateId,
  type Message,
  type WsEvent,
} from "@desk/shared";
import { queries } from "@desk/db";
import {
  createOrReuse,
  execRun as runtimeExecRun,
  cancelRun as runtimeCancelRun,
  createDriver,
  type LogEvent,
  type AgentFileInput,
} from "@desk/runtime";
import { createAdapter, type ScheduleAdapter } from "./scheduleAdapter.js";

export interface RunManagerOptions {
  pool: pg.Pool;
  adapter?: ScheduleAdapter;
  emit?: (event: WsEvent) => void;
  /**
   * Test-injectable replacement for the runtime's opencode spawn. Called
   * by fireMessage with the message id (as the "runId" arg, for log
   * correlation), the resolved agent, the derived prompt, and a log
   * sink. Return the exit code; the scheduler handles state transitions
   * and child-message insertion.
   */
  execRunFn?: (
    messageId: string,
    agentId: string,
    prompt: string,
    onLog: (evt: LogEvent) => void | Promise<void>,
    opts?: { agentFileInput: AgentFileInput },
  ) => Promise<{ exitCode: number }>;
}

/**
 * Builds the shell command at/cron runs to fire a scheduled message.
 * The token is read fresh from disk at fire time via $(cat ...) so
 * rotations don't invalidate scheduled entries (reconcile regenerates).
 */
function buildMessageFireCmd(messageId: string): string {
  const tokenPath = process.env.DESK_INTERNAL_TOKEN_PATH ?? "/etc/desk-server/internal-token";
  const port = process.env.DESK_API_PORT ?? process.env.PORT ?? "8080";
  const url = `http://127.0.0.1:${port}/internal/messages/fire`;
  const body = JSON.stringify({ messageId }).replace(/"/g, '\\"');
  return (
    `sh -c 'T=$(cat ${tokenPath}) && ` +
    `curl -sf -X POST ` +
    `-H "Authorization: Bearer $T" ` +
    `-H "Content-Type: application/json" ` +
    `-d "${body}" ` +
    `${url}'`
  );
}

export function createRunManager(opts: RunManagerOptions) {
  const { pool, emit = () => {} } = opts;
  const adapter = opts.adapter ?? createAdapter();

  async function getDefaultAgentId(): Promise<string> {
    const agents = await queries.agents.list(pool);
    if (agents.length === 0) throw new Error("No agents configured");
    return agents[0].id;
  }

  async function firstWorkspaceId(): Promise<string> {
    const { rows } = await pool.query(
      "SELECT id FROM workspaces ORDER BY created_at LIMIT 1",
    );
    return rows[0]?.id as string;
  }

  async function resolveUserIdForWorkspace(workspaceId: string): Promise<string | null> {
    if (!workspaceId) return null;
    const ws = await queries.workspaces.findById(pool, workspaceId);
    return ws?.userId ?? null;
  }

  async function ensureLogDir(chatId: string): Promise<string> {
    const home = process.env.DESK_HOME ?? "/opt/desk";
    const dir = path.join(home, "Desk", "workspaces", "desk", ".chats", chatId, "logs");
    await fsp.mkdir(dir, { recursive: true });
    return dir;
  }

  async function readLogFileBody(p: string): Promise<string> {
    try {
      const buf = await fsp.readFile(p, "utf8");
      return buf
        .split("\n")
        .map((line) => {
          const tab = line.indexOf("\t");
          return tab > 0 ? line.slice(tab + 1) : line;
        })
        .join("\n");
    } catch {
      return "";
    }
  }

  function derivePromptFromContent(content: unknown): string {
    const c = content as { type?: string; text?: string; body?: string };
    if (c?.type === "text" && typeof c.text === "string") return c.text;
    if (c?.type === "ai_note_request") {
      return "Produce a coherent running summary of this chat, in markdown.";
    }
    return JSON.stringify(content);
  }

  function outputContentTypeFor(triggerContent: unknown): "note" | "text" {
    const c = triggerContent as { type?: string };
    return c?.type === "ai_note_request" ? "note" : "text";
  }

  function buildOutputContent(kind: "note" | "text", body: string): Message["content"] {
    return kind === "note"
      ? { type: "note", body }
      : { type: "text", text: body };
  }

  /**
   * Fires a pending scheduled message: atomically claims it (pending →
   * running), runs the agent with the message content as the prompt,
   * writes stdout/stderr to a per-message log file, and inserts a child
   * message with the output. Idempotent — concurrent fires on the same
   * messageId land on the claim check and no-op.
   */
  async function fireMessage(messageId: string): Promise<{ fired: boolean; childIds: string[] }> {
    const msg = await queries.messages.findById(pool, messageId);
    if (!msg) return { fired: false, childIds: [] };

    const claimed = await queries.messages.claimPending(pool, messageId);
    if (!claimed) return { fired: false, childIds: [] };

    emit({
      type: "message.updated",
      payload: (await queries.messages.findById(pool, messageId))!,
    });

    const prompt = derivePromptFromContent(msg.content);
    const outputKind = outputContentTypeFor(msg.content);

    const logDir = await ensureLogDir(msg.chatId);
    const logFile = path.join(logDir, `${messageId}.log`);
    const logStream = fs.createWriteStream(logFile, { flags: "a" });

    const onLog = async (evt: LogEvent) => {
      logStream.write(`${evt.kind}\t${evt.payload}\n`);
      emit({
        type: "message.log_appended",
        payload: { messageId, kind: evt.kind, line: evt.payload },
      });
    };

    try {
      const chat = await queries.chats.findById(pool, msg.chatId);
      const agentId = msg.agentId ?? chat?.agentId ?? (await getDefaultAgentId());
      const workspaceId = chat?.workspaceId ?? (await firstWorkspaceId());
      const userId = await resolveUserIdForWorkspace(workspaceId);
      const userName = userId
        ? (await queries.users.findById(pool, userId))?.username ?? "User"
        : "User";
      const providerKeys = userId
        ? await queries.userSettings.getProviderKeys(pool, userId)
        : {};
      const agent = await queries.agents.findById(pool, agentId);
      const agentFileInput: AgentFileInput = {
        agentId,
        agentName: agent?.name ?? "Desk Agent",
        model: agent?.model ?? "anthropic/claude-sonnet-4-5",
        instructions: agent?.instructions ?? "",
        userName,
      };

      let result: { exitCode: number };
      if (opts.execRunFn) {
        result = await opts.execRunFn(messageId, agentId, prompt, onLog, { agentFileInput });
      } else if (process.env.DESK_SANDBOX_DRIVER === "fake") {
        const driver = createDriver();
        result = await driver.execRun(workspaceId, {
          runId: messageId,
          prompt,
          agentFileId: agentId,
          onLog,
        });
      } else {
        const home = process.env.DESK_HOME ?? "/opt/desk";
        const handle = await createOrReuse(workspaceId, home, providerKeys);
        result = await runtimeExecRun(pool, handle, {
          runId: messageId,
          prompt,
          home,
          workspaceId,
          chatId: msg.chatId,
          agent: agentFileInput,
          onLog,
        });
      }

      logStream.end();
      const terminal = result.exitCode === 0 ? "succeeded" : "failed";
      await queries.messages.finalizeExecution(pool, messageId, terminal);
      emit({
        type: "message.updated",
        payload: (await queries.messages.findById(pool, messageId))!,
      });

      const body = (await readLogFileBody(logFile)).trim();
      if (body) {
        const child = await queries.messages.insert(pool, {
          id: generateId("message"),
          chatId: msg.chatId,
          role: "agent",
          content: buildOutputContent(outputKind, body),
          parentId: messageId,
          agentId,
        });
        emit({ type: "message.appended", payload: child });
        return { fired: true, childIds: [child.id] };
      }
      return { fired: true, childIds: [] };
    } catch (err) {
      logStream.end();
      // eslint-disable-next-line no-console
      console.error(`fireMessage ${messageId} failed:`, err);
      await queries.messages.finalizeExecution(pool, messageId, "failed");
      emit({
        type: "message.updated",
        payload: (await queries.messages.findById(pool, messageId))!,
      });
      return { fired: true, childIds: [] };
    }
  }

  /**
   * Cancels a pending scheduled message: removes any at/cron entry it
   * owns via scheduler_ref and deletes the row. No-op if already gone.
   */
  async function cancelMessage(messageId: string): Promise<void> {
    const msg = await queries.messages.findById(pool, messageId);
    if (!msg) return;
    const ref = msg.schedulerRef;
    if (ref) {
      try {
        if (ref.kind === "at") await adapter.removeAt(ref.id);
        else if (ref.kind === "cron") await adapter.removeCron(ref.id);
      } catch {
        // Best-effort.
      }
    }
    await pool.query("DELETE FROM messages WHERE id = $1", [messageId]);
  }

  /**
   * Schedules a new ai-note refresh for the chat: a pending system
   * ai_note_request message with an at-job that curls
   * /internal/messages/fire 30 minutes from now. Cancels any prior
   * pending ai_note_request first so there's only ever one outstanding.
   */
  async function scheduleAiNote(chatId: string): Promise<void> {
    await cancelAiNoteForChat(chatId);

    const messageId = generateId("message");
    const atTime = `now + 30 minutes`;
    const atJobId = await adapter.scheduleAt(buildMessageFireCmd(messageId), atTime);

    await queries.messages.insert(pool, {
      id: messageId,
      chatId,
      role: "system",
      content: { type: "ai_note_request" },
      state: "pending",
      executeAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
      schedulerRef: { kind: "at", id: atJobId },
    });
  }

  async function cancelAiNoteForChat(chatId: string): Promise<void> {
    const { rows } = await pool.query(
      `SELECT id, scheduler_ref FROM messages
       WHERE chat_id = $1
         AND state = 'pending'
         AND content->>'type' = 'ai_note_request'`,
      [chatId],
    );
    for (const row of rows) {
      const ref = row.scheduler_ref as { kind: string; id: string } | null;
      if (ref?.kind === "at") {
        try { await adapter.removeAt(ref.id); } catch { /* ok */ }
      } else if (ref?.kind === "cron") {
        try { await adapter.removeCron(ref.id); } catch { /* ok */ }
      }
      await pool.query("DELETE FROM messages WHERE id = $1", [row.id]);
    }
  }

  async function cancelAiNote(chatId: string): Promise<void> {
    await cancelAiNoteForChat(chatId);
  }

  /** Cancels an in-flight exec: kills the opencode child if possible. */
  async function cancelRun(messageId: string): Promise<void> {
    await runtimeCancelRun(messageId);
    await queries.messages.updateMessage(pool, messageId, { state: "cancelled" });
    const msg = await queries.messages.findById(pool, messageId);
    if (msg) emit({ type: "message.updated", payload: msg });
  }

  return {
    fireMessage,
    cancelMessage,
    cancelRun,
    scheduleAiNote,
    cancelAiNote,
    cancelAiNoteForChat,
    adapter,
  };
}
