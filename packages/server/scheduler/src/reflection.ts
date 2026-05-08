import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Cron } from "croner";
import type { Pool } from "@agent-desk/db";
import { queries } from "@agent-desk/db";
import { workspaceJournalDir, workspaceJournalPath, workspaceMemoryDir } from "@agent-desk/storage";

/**
 * Memory-system Phase 5 — daily reflection.
 *
 * Runs once per day per user workspace. For every workspace the user
 * touched yesterday, the workspace's own enabled agent reflects inside
 * that workspace's sandbox and writes `<workspace>/.memory/journal/<date>.md`
 * plus any workspace memory edits the agent considers worth keeping.
 *
 * The AI call is abstracted as `ReflectFn` so unit tests can inject a
 * deterministic stub. Production should pass a real opencode-backed
 * implementation that calls the free `opencode/gpt-5-nano` model with
 * the reflection prompt.
 *
 * Output format conventions (driven by the reflection prompt):
 *   - The AI returns a JSON object `{ journal: string, memoryEdits?:
 *     Array<{ path: string, body: string }> }`.
 *   - `journal` lands at the workspace journal path.
 *   - Each `memoryEdits` entry is a write to a memory topic file.
 *     `path` is interpreted relative to the workspace's `.memory/`
 *     directory.
 *     This is how the agent promotes inline preferences to dedicated
 *     topic files.
 */

/** Inputs the reflection AI receives for a single workspace. */
export interface WorkspaceReflectionInput {
  pool: Pool;
  home: string;
  workspaceId: string;
  workspaceSlug: string;
  workspaceName: string;
  userId: string;
  userName: string;
  userTimezone?: string;
  agent: { id: string; name: string; model: string };
  providerKeys?: Record<string, string>;
  date: string;          // yesterday, "YYYY-MM-DD"
  /** Yesterday's user + agent messages, oldest first. */
  activity: Array<{ chatId: string; role: string; createdAt: string; body: string }>;
  /** Prior workspace journals, newest first, excluding `date`. */
  priorJournals: Array<{ date: string; body: string }>;
}

export interface ReflectionResult {
  journal: string;
  memoryEdits?: Array<{ path: string; body: string }>;
}

export type ReflectFn<I> = (input: I) => Promise<ReflectionResult>;

export interface RunDailyReflectionOptions {
  pool: Pool;
  /** DESK_HOME root. */
  home: string;
  /** Optional override of the date we're reflecting *on* (defaults to yesterday in server local time). */
  date?: string;
  /** Per-workspace AI call. */
  reflectWorkspace: ReflectFn<WorkspaceReflectionInput>;
}

/**
 * Yesterday in server *local* time, formatted YYYY-MM-DD.
 *
 * The cron schedule fires at 03:00 server local time; computing the
 * window in UTC instead would skew the date when the server's timezone
 * has a non-zero UTC offset (e.g. "yesterday at 03:00 CEST" is still
 * today's date in UTC during the second half of the day).
 */
export function yesterdayDateLocal(now: Date = new Date()): string {
  const y = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const yyyy = y.getFullYear();
  const mm = String(y.getMonth() + 1).padStart(2, "0");
  const dd = String(y.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

const TOPIC_PATTERN = /^[a-zA-Z0-9_][a-zA-Z0-9_-]*\.md$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const PRIOR_JOURNAL_LIMIT = 30;

/**
 * Atomic write: stage to a sibling tempfile then rename onto the
 * target. Same-filesystem rename is atomic on POSIX, so a concurrent
 * user edit will either land before or after this write — never get
 * truncated mid-stream by a failed `writeFile`.
 *
 * The randomBytes suffix avoids tmpfile collisions when two reflection
 * passes touch the same target concurrently (cron retry, or a manual
 * call alongside the scheduled job): two writers must not share a
 * tmpfile, otherwise one's rename would race the other's writeFile.
 */
async function atomicWriteFile(abs: string, body: string): Promise<void> {
  const tmp = `${abs}.${crypto.randomBytes(8).toString("hex")}.tmp`;
  await fs.writeFile(tmp, body, "utf-8");
  await fs.rename(tmp, abs);
}

async function writeMemoryEdit(
  root: string,
  edit: { path: string; body: string },
): Promise<void> {
  if (!TOPIC_PATTERN.test(edit.path)) {
    // Reject path traversal / non-md / hidden files. The reflection
    // prompt asks for plain `<topic>.md` filenames.
    return;
  }
  const target = path.join(root, edit.path);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await atomicWriteFile(target, edit.body);
}

async function listWorkspaceActivityForDate(
  pool: Pool,
  workspaceId: string,
  date: string,
): Promise<WorkspaceReflectionInput["activity"]> {
  if (!DATE_PATTERN.test(date)) return [];
  const [year, month, day] = date.split("-").map(Number);
  const dayStart = new Date(year, month - 1, day, 0, 0, 0, 0).toISOString();
  const dayEnd = new Date(year, month - 1, day, 23, 59, 59, 999).toISOString();
  const { rows } = await pool.query<{
    chat_id: string;
    role: string;
    created_at: string;
    content: string;
  }>(
    `SELECT m.chat_id, m.role, m.created_at, m.content
     FROM messages m
     JOIN chats c ON c.id = m.chat_id
     WHERE c.workspace_id = ?
       AND m.created_at BETWEEN ? AND ?
       AND m.role IN ('user', 'agent')
       AND json_valid(m.content)
       AND json_extract(m.content, '$.type') IN ('text', 'summary')
     ORDER BY m.created_at`,
    [workspaceId, dayStart, dayEnd],
  );
  return rows.map((r) => {
    const content = JSON.parse(r.content) as { text?: string; body?: string };
    return {
      chatId: r.chat_id,
      role: r.role,
      createdAt: r.created_at,
      body: content.text ?? content.body ?? "",
    };
  });
}

async function listPriorWorkspaceJournals(
  home: string,
  workspaceSlug: string,
  date: string,
): Promise<WorkspaceReflectionInput["priorJournals"]> {
  if (!DATE_PATTERN.test(date)) return [];
  const dir = workspaceJournalDir(home, workspaceSlug);
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }

  const dates = entries
    .filter((entry) => entry.endsWith(".md"))
    .map((entry) => entry.slice(0, -3))
    .filter((entryDate) => DATE_PATTERN.test(entryDate) && entryDate < date)
    .sort()
    .reverse()
    .slice(0, PRIOR_JOURNAL_LIMIT);

  const journals: WorkspaceReflectionInput["priorJournals"] = [];
  for (const journalDate of dates) {
    const body = await fs.readFile(workspaceJournalPath(home, workspaceSlug, journalDate), "utf-8");
    journals.push({ date: journalDate, body });
  }
  return journals;
}

/**
 * Per-workspace reflection pass. Reads yesterday's activity, calls
 * `reflectWorkspace`, writes the journal entry and any memory edits.
 * Returns the journal body, or null when the workspace had no activity.
 */
export async function runWorkspaceReflection(
  opts: RunDailyReflectionOptions & {
    workspaceId: string;
    workspaceSlug: string;
    workspaceName: string;
    userId: string;
    userName: string;
    userTimezone?: string;
    agent: { id: string; name: string; model: string };
    providerKeys?: Record<string, string>;
  },
): Promise<string | null> {
  const date = opts.date ?? yesterdayDateLocal();
  const activity = await listWorkspaceActivityForDate(opts.pool, opts.workspaceId, date);
  if (activity.length === 0) return null;

  const priorJournals = await listPriorWorkspaceJournals(opts.home, opts.workspaceSlug, date);
  const result = await opts.reflectWorkspace({
    pool: opts.pool,
    home: opts.home,
    workspaceId: opts.workspaceId,
    workspaceSlug: opts.workspaceSlug,
    workspaceName: opts.workspaceName,
    userId: opts.userId,
    userName: opts.userName,
    userTimezone: opts.userTimezone,
    agent: opts.agent,
    providerKeys: opts.providerKeys,
    date,
    activity,
    priorJournals,
  });

  const memoryRoot = workspaceMemoryDir(opts.home, opts.workspaceSlug);
  const journalAbs = workspaceJournalPath(opts.home, opts.workspaceSlug, date);
  await fs.mkdir(path.dirname(journalAbs), { recursive: true });
  await atomicWriteFile(journalAbs, result.journal);
  for (const edit of result.memoryEdits ?? []) {
    await writeMemoryEdit(memoryRoot, edit);
  }
  return result.journal;
}

/**
 * Orchestrator. Runs the per-workspace pass for every user-owned
 * workspace touched yesterday. Workspaces without an enabled agent are
 * skipped because there is no workspace-owned agent to manage memory.
 */
export async function runDailyReflection(opts: RunDailyReflectionOptions): Promise<void> {
  const date = opts.date ?? yesterdayDateLocal();
  const { rows: users } = await opts.pool.query<{
    id: string;
    username: string;
    timezone: string | null;
  }>(
    `SELECT id, username, timezone FROM users`,
  );

  for (const user of users) {
    const userId = user.id;
    const providerKeys = await queries.userSettings.getProviderKeys(opts.pool, userId);
    const workspaces = await queries.workspaces.listByUser(opts.pool, userId);
    for (const ws of workspaces) {
      const [workspaceAgent] = await queries.workspaceAgents.listForWorkspace(opts.pool, ws.id);
      if (!workspaceAgent) continue;
      const agent = await queries.agents.findById(opts.pool, workspaceAgent.agentId);
      if (!agent) continue;
      await runWorkspaceReflection({
        ...opts,
        date,
        workspaceId: ws.id,
        workspaceSlug: ws.path,
        workspaceName: ws.name,
        userId,
        userName: user.username,
        userTimezone: user.timezone ?? undefined,
        agent: { id: agent.id, name: agent.name, model: agent.model },
        providerKeys,
      });
    }
  }
}

export interface DailyReflectionScheduleOptions extends RunDailyReflectionOptions {
  /** Cron expression. Defaults to `0 3 * * *` per spec (03:00 server time daily). */
  cron?: string;
  /** Logger hook. Defaults to console.error on failures. */
  onError?: (err: unknown) => void;
}

/**
 * P5.1 — register a recurring daily-reflection job. Returns the
 * `Cron` instance so callers can stop it during shutdown / tests.
 */
export function startDailyReflection(opts: DailyReflectionScheduleOptions): Cron {
  const expression = opts.cron ?? "0 3 * * *";
  const job = new Cron(expression, async () => {
    try {
      await runDailyReflection(opts);
    } catch (err) {
      if (opts.onError) opts.onError(err);
      // eslint-disable-next-line no-console
      else console.error("daily reflection job failed:", err);
    }
  });
  return job;
}
