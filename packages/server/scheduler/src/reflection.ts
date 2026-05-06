import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Cron } from "croner";
import type { Pool } from "@agent-desk/db";
import { queries } from "@agent-desk/db";

/**
 * Memory-system Phase 5 — daily reflection.
 *
 * Runs once per day per user. Two passes:
 *   1. Per-workspace pass — for every workspace the user touched
 *      yesterday, summarize the day's activity and write
 *      `<workspace>/.memory/journal/<date>.md` plus any workspace
 *      memory edits the AI considers worth keeping.
 *   2. Per-user roll-up pass — once all workspace passes finish,
 *      consume the per-workspace journals and write the user-level
 *      `~/Desk/.memory/journal/<date>.md` plus user memory edits.
 *
 * The AI call is abstracted as `ReflectFn` so unit tests can inject a
 * deterministic stub. Production should pass a real opencode-backed
 * implementation that calls the free `opencode/gpt-5-nano` model with
 * the reflection prompt.
 *
 * Output format conventions (driven by the reflection prompt):
 *   - The AI returns a JSON object `{ journal: string, memoryEdits?:
 *     Array<{ path: string, body: string }> }`.
 *   - `journal` lands at the spec-mandated path (workspace or user
 *     journal directory).
 *   - Each `memoryEdits` entry is a write to a memory topic file.
 *     `path` is interpreted relative to the workspace's `.memory/`
 *     directory (per-workspace pass) or `~/Desk/.memory/` (user pass).
 *     This is how the agent promotes inline preferences to dedicated
 *     topic files.
 */

/** Inputs the reflection AI receives for a single workspace. */
export interface WorkspaceReflectionInput {
  workspaceSlug: string;
  workspaceName: string;
  date: string;          // yesterday, "YYYY-MM-DD"
  /** Yesterday's user + agent messages, oldest first. */
  activity: Array<{ chatId: string; role: string; createdAt: string; body: string }>;
}

/** Inputs the reflection AI receives for the per-user rollup. */
export interface UserReflectionInput {
  userId: string;
  date: string;
  /** Per-workspace journal bodies produced upstream this run. */
  workspaceJournals: Array<{ workspaceSlug: string; body: string }>;
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
  /** Optional override of the date we're reflecting *on* (defaults to yesterday in UTC). */
  date?: string;
  /** Per-workspace AI call. */
  reflectWorkspace: ReflectFn<WorkspaceReflectionInput>;
  /** Per-user AI call (rollup). */
  reflectUser: ReflectFn<UserReflectionInput>;
}

function isoDateUTC(d: Date): string {
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

/** Yesterday in UTC, formatted YYYY-MM-DD. */
export function yesterdayDateUTC(now: Date = new Date()): string {
  const y = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  return isoDateUTC(y);
}

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const TOPIC_PATTERN = /^[a-zA-Z0-9_][a-zA-Z0-9_-]*\.md$/;

function workspaceMemoryRoot(home: string, slug: string): string {
  return path.join(home, "Desk", "workspaces", slug, ".memory");
}

function userMemoryRoot(home: string): string {
  return path.join(home, "Desk", ".memory");
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
  await fs.writeFile(target, edit.body, "utf-8");
}

async function listWorkspaceActivityForDate(
  pool: Pool,
  workspaceId: string,
  date: string,
): Promise<WorkspaceReflectionInput["activity"]> {
  if (!DATE_PATTERN.test(date)) return [];
  const dayStart = `${date}T00:00:00.000Z`;
  const dayEnd = `${date}T23:59:59.999Z`;
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

/**
 * Per-workspace reflection pass. Reads yesterday's activity, calls
 * `reflectWorkspace`, writes the journal entry and any memory edits.
 * Returns the journal body (for the per-user roll-up pass) or null
 * when the workspace had no activity.
 */
export async function runWorkspaceReflection(
  opts: RunDailyReflectionOptions & {
    workspaceId: string;
    workspaceSlug: string;
    workspaceName: string;
  },
): Promise<string | null> {
  const date = opts.date ?? yesterdayDateUTC();
  const activity = await listWorkspaceActivityForDate(opts.pool, opts.workspaceId, date);
  if (activity.length === 0) return null;

  const result = await opts.reflectWorkspace({
    workspaceSlug: opts.workspaceSlug,
    workspaceName: opts.workspaceName,
    date,
    activity,
  });

  const memoryRoot = workspaceMemoryRoot(opts.home, opts.workspaceSlug);
  await fs.mkdir(path.join(memoryRoot, "journal"), { recursive: true });
  await fs.writeFile(
    path.join(memoryRoot, "journal", `${date}.md`),
    result.journal,
    "utf-8",
  );
  for (const edit of result.memoryEdits ?? []) {
    await writeMemoryEdit(memoryRoot, edit);
  }
  return result.journal;
}

/**
 * Per-user roll-up. Consumes all per-workspace journal bodies the
 * upstream pass produced, calls `reflectUser`, and writes the
 * user-level journal and user memory edits.
 */
export async function runUserReflectionRollup(
  opts: RunDailyReflectionOptions & {
    userId: string;
    workspaceJournals: Array<{ workspaceSlug: string; body: string }>;
  },
): Promise<void> {
  const date = opts.date ?? yesterdayDateUTC();
  if (opts.workspaceJournals.length === 0) return;

  const result = await opts.reflectUser({
    userId: opts.userId,
    date,
    workspaceJournals: opts.workspaceJournals,
  });

  const userRoot = userMemoryRoot(opts.home);
  await fs.mkdir(path.join(userRoot, "journal"), { recursive: true });
  await fs.writeFile(
    path.join(userRoot, "journal", `${date}.md`),
    result.journal,
    "utf-8",
  );
  for (const edit of result.memoryEdits ?? []) {
    await writeMemoryEdit(userRoot, edit);
  }
}

/**
 * Orchestrator. Runs the per-workspace pass for every user-owned
 * workspace touched yesterday, then runs the user roll-up pass.
 */
export async function runDailyReflection(opts: RunDailyReflectionOptions): Promise<void> {
  const date = opts.date ?? yesterdayDateUTC();
  const { rows: users } = await opts.pool.query<{ id: string; username: string }>(
    `SELECT id, username FROM users`,
  );

  for (const user of users) {
    const userId = user.id;
    const workspaces = await queries.workspaces.listByUser(opts.pool, userId);
    const journals: Array<{ workspaceSlug: string; body: string }> = [];
    for (const ws of workspaces) {
      const body = await runWorkspaceReflection({
        ...opts,
        date,
        workspaceId: ws.id,
        workspaceSlug: ws.path,
        workspaceName: ws.name,
      });
      if (body !== null) {
        journals.push({ workspaceSlug: ws.path, body });
      }
    }
    await runUserReflectionRollup({
      ...opts,
      date,
      userId,
      workspaceJournals: journals,
    });
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
