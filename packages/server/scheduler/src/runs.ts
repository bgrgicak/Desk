import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { type Pool } from "@agent-desk/db";
import {
  generateId,
  GOAL_KEYS,
  type GoalKey,
  type Message,
  type WsEvent,
} from "@agent-desk/shared";
import { queries } from "@agent-desk/db";
import { resolveDeskHome } from "@agent-desk/storage";
import {
  buildWorkspaceMountPlan,
  createOrReuse,
  execRun as runtimeExecRun,
  classifyResourceError,
  growSandboxForResourceError,
  cancelRun as runtimeCancelRun,
  productionReflectWorkspace,
  resolveLocalSourceEnv,
  type LogEvent,
  type AgentFileInput,
} from "@agent-desk/runtime";
import * as sandboxSweep from "./runs-sandbox-sweep.js";
import { createSummaryScheduler } from "./runs-summary.js";
import { derivePromptInputs as derivePromptInputsExtern } from "./runs-prompt.js";
import * as lifecycle from "./runs-lifecycle.js";
import {
  runWorkspaceReflection,
  yesterdayDateLocal,
  type ReflectFn,
  type WorkspaceReflectionInput,
} from "./reflection.js";
import {
  buildOutputContent,
  computeNextRun,
  errorLogLines,
  isNonEmpty,
  isUnscheduledTask,
  outputContentTypeFor,
  readLogEntries,
  reflectionOutcomeText,
  type SummaryModelTokenLimits,
} from "./runs-helpers.js";
import { withModule } from "@agent-desk/shared/logger";
const log = withModule("scheduler/runs");

export interface RunManagerOptions {
  pool: Pool;
  emit?: (event: WsEvent) => void;
  /**
   * Resolves the active provider API keys for a given user/workspace. Injected
   * by the API layer (which owns the vault) so the scheduler doesn't need to
   * import VaultStore directly. Returns an empty object when unavailable.
   */
  resolveProviderKeys?: (userId: string, workspaceId?: string) => Promise<Record<string, string>>;
  /**
   * Test-injectable replacement for the runtime's opencode spawn. Called
   * by fireMessage with the run id. Return the exit code; the scheduler
   * handles state transitions and child-message insertion.
   */
  execRunFn?: (
    messageId: string,
    agentId: string,
    prompt: string,
    onLog: (evt: LogEvent) => void | Promise<void>,
    opts?: { agentFileInput: AgentFileInput; attachments?: string[] },
  ) => Promise<{ exitCode: number }>;
  /** Test-injectable replacement for the production workspace reflection call. */
  reflectWorkspace?: ReflectFn<WorkspaceReflectionInput>;
  /** DESK_HOME root. Defaults to resolveDeskHome(). */
  home?: string;
  /** Test hook for model metadata used by the adaptive summary trigger. */
  summaryModelContextWindowFn?: (chatId: string, modelId: string) => Promise<number | SummaryModelTokenLimits | null>;
}

/**
 * Always-available default the runtime falls back to when the agent's
 * configured model has no live auth in the current run env. `opencode/*`
 * models are free and require zero provider keys, so this never lands a
 * chat in a broken "no auth at all" state.
 */
export const FALLBACK_MODEL = "opencode/big-pickle";

/**
 * Reasons `resolveModelForRun` returned a model other than the requested
 * one. `null` means "the requested model was used as-is".
 */
export type ModelResolutionReason =
  | null
  | "codex-oauth"            // codex/* → openai/* via OAuth path (Codex enabled)
  | "codex-fallback-api-key" // codex/* → openai/* via API-key fallback (Codex disabled, OPENAI key present)
  | "no-auth-fallback";      // requested provider has no available auth → free default

/**
 * Pick the model that should actually run, and the provider key map to
 * forward into the daemon. Handles three concerns at once:
 *
 *  1. Codex translation: `codex/X` is a Desk-only relabel — opencode-
 *     serve only knows the `openai` provider. When Codex (OAuth) is
 *     available we route through it AND strip `OPENAI_API_KEY` so
 *     opencode picks the OAuth path instead of the cloud key. When
 *     Codex is disabled but `OPENAI_API_KEY` is present, we still
 *     unwrap the prefix and let the API key handle the call — so the
 *     user doesn't lose their chat to a toggle.
 *
 *  2. Hard fallback: when the requested model's provider has no auth
 *     at all (Codex disabled AND no `OPENAI_API_KEY`; or `anthropic/X`
 *     with no `ANTHROPIC_API_KEY`; or any future cloud provider whose
 *     key got disabled in Settings), substitute `FALLBACK_MODEL`. The
 *     run keeps going on the free `opencode/*` model instead of dying
 *     with a `ProviderModelNotFoundError` or — worse — silently using
 *     a stale auth blob the daemon still has cached.
 *
 *  3. No change for free models: `opencode/*` always runs as-is.
 *
 * Callers should forward the returned `runtimeModel` to BOTH the agent
 * file (so the daemon's startup cache picks the fallback up) AND the
 * driver's per-message `providerID/modelID`, and forward
 * `providerKeys` into the sandbox env. `reason` is for logging.
 */
export function resolveModelForRun(
  model: string,
  providerKeys: Record<string, string>,
  extraEnv?: Record<string, string>,
): {
  runtimeModel: string;
  providerKeys: Record<string, string>;
  reason: ModelResolutionReason;
} {
  const hasOpenAiKey = isNonEmpty(providerKeys.OPENAI_API_KEY);
  const hasAnthropicKey = isNonEmpty(providerKeys.ANTHROPIC_API_KEY);
  const oauthAvailable = isNonEmpty(extraEnv?.OPENCODE_AUTH_CONTENT);

  if (model.startsWith("codex/")) {
    const bare = `openai/${model.slice("codex/".length)}`;
    if (oauthAvailable) {
      // Codex enabled: OAuth path. Strip the cloud key so opencode
      // doesn't accidentally pick the API-key path on a tie-break.
      const { OPENAI_API_KEY: _strip, ...withoutOpenAiApiKey } = providerKeys;
      return { runtimeModel: bare, providerKeys: withoutOpenAiApiKey, reason: "codex-oauth" };
    }
    if (hasOpenAiKey) {
      return { runtimeModel: bare, providerKeys, reason: "codex-fallback-api-key" };
    }
    return { runtimeModel: FALLBACK_MODEL, providerKeys, reason: "no-auth-fallback" };
  }

  if (model.startsWith("openai/")) {
    if (hasOpenAiKey || oauthAvailable) return { runtimeModel: model, providerKeys, reason: null };
    return { runtimeModel: FALLBACK_MODEL, providerKeys, reason: "no-auth-fallback" };
  }

  if (model.startsWith("anthropic/")) {
    if (hasAnthropicKey) return { runtimeModel: model, providerKeys, reason: null };
    return { runtimeModel: FALLBACK_MODEL, providerKeys, reason: "no-auth-fallback" };
  }

  // Free `opencode/*` and any other provider Desk doesn't gatekeep
  // explicitly pass through. opencode-serve still applies its own
  // validation against the model registry — a typo there will surface
  // as a daemon-side error rather than as a silent fallback.
  return { runtimeModel: model, providerKeys, reason: null };
}

/**
 * @deprecated Kept for backwards-compatibility with existing tests
 * that import the old name. New code should use `resolveModelForRun`.
 */
export function resolveOpenAiBillingSource(
  model: string,
  providerKeys: Record<string, string>,
  extraEnv?: Record<string, string>,
): { runtimeModel: string; providerKeys: Record<string, string> } {
  const { runtimeModel, providerKeys: nextKeys } = resolveModelForRun(model, providerKeys, extraEnv);
  return { runtimeModel, providerKeys: nextKeys };
}

export interface FireMessageOptions {
  /** Manual task fires create a run now without consuming the task's schedule. */
  manual?: boolean;
}

export function createRunManager(opts: RunManagerOptions) {
  const { pool, emit = () => {} } = opts;
  const home = opts.home ?? resolveDeskHome();
  const resolveProviderKeys = opts.resolveProviderKeys ?? (() => Promise.resolve({}));

  let inFlight = 0;
  const MAX_CONCURRENT = parseInt(process.env.DESK_SCHEDULER_MAX_CONCURRENT ?? "10", 10);

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

  async function ensureLogDir(workspaceSlug: string, chatId: string): Promise<string> {
    const dir = path.join(home, workspaceSlug, ".chats", chatId, "logs");
    await fsp.mkdir(dir, { recursive: true });
    return dir;
  }

  const derivePromptInputs = (msg: Message) => derivePromptInputsExtern(pool, msg);

  async function fireReflectionTask(
    msg: Message,
    workspaceId: string,
    workspaceSlug: string,
    workspaceName: string,
    userId: string | null,
    userName: string,
    userTimezone: string | undefined,
    manual: boolean,
  ): Promise<string | null> {
    const c = msg.content as { type?: string; workspaceId?: string };
    if (c.type !== "reflection_request" || c.workspaceId !== workspaceId) {
      throw new Error("reflection request does not match its chat workspace");
    }
    const agentId = msg.agentId ?? (await getDefaultAgentId());
    const agent = await queries.agents.findById(pool, agentId);
    if (!agent) throw new Error(`Reflection agent not found: ${agentId}`);
    const providerKeys = userId ? await resolveProviderKeys(userId, workspaceId) : {};
    const extraEnv = userId ? await resolveLocalSourceEnv(pool, userId) : {};
    return await runWorkspaceReflection({
      pool,
      home,
      date: yesterdayDateLocal(),
      workspaceId,
      workspaceSlug,
      workspaceName,
      userId: userId ?? "",
      userName,
      userTimezone,
      agent: { id: agent.id, name: agent.name, model: agent.model },
      providerKeys,
      extraEnv,
      reflectWorkspace: opts.reflectWorkspace ?? productionReflectWorkspace,
      reflectOnEmptyActivity: manual,
    });
  }

  async function logReflectionOutcome(runId: string, journal: string | null, onLog: (evt: LogEvent) => void | Promise<void>): Promise<void> {
    const text = reflectionOutcomeText(journal);
    await onLog({
      runId,
      seq: 0,
      kind: "stdout",
      payload: JSON.stringify({ type: "text", part: { text } }),
    });
  }

  /**
   * Fires a scheduled message. Behaviour branches on `kind`:
   *
   *   - `task`: inserts a fresh `task_run` child of the task and runs the
   *     agent against it. The scheduler does not mutate the parent through
   *     pending → running; each fire produces
   *     a new run row with its own state/started_at/ended_at, so a cron
   *     task accumulates a real run history. Concurrent fires of the same
   *     task converge in `startTaskRun` (locks the task, refuses if a run
   *     is already in flight). One-shot tasks (executeAt, no cron) also
   *     transition the parent definition to mirror the run's terminal
   *     state and clear executeAt once the run completes — so they leave
   *     the "scheduled" column.
   *
   *   - `chat` / `summary`: claims the message itself (pending → running)
   *     and finalises it in place. Idempotent on `messageId` — these
   *     kinds fire once per row (a fresh row per chat agent_turn or per
   *     scheduleSummary refresh).
   *
   * Returns `fired: false` if the row is missing, the kind doesn't fire,
   * or another fire is already in flight (the task lock declined us).
   */
  async function fireMessage(messageId: string, fireOptions: FireMessageOptions = {}): Promise<{ fired: boolean; childIds: string[] }> {
    try {
      return await fireMessageImpl(messageId, fireOptions);
    } catch (err) {
      // The inner fireMessageImpl has its own big try/catch that
      // routes most failures through finalizeExecution + a failed
      // child message, so the UI sees them. This outer catch covers
      // pre-claim failures (findById/claimPending throwing a DB
      // error before the inner try/catch is entered): without it,
      // the message would be stuck in `pending`/`running` forever
      // and the user sees an HTTP 201 but no chat feedback. Mark it
      // failed and emit so the FailedRunBanner ("Try again") renders.
      log.error({ messageId, err }, "fireMessage outer failure — marking message failed");
      try {
        await queries.messages.finalizeExecution(pool, messageId, "failed");
        const failed = await queries.messages.findById(pool, messageId);
        if (failed) emit({ type: "message.updated", payload: failed });
      } catch (fallbackErr) {
        log.error({ messageId, fallbackErr }, "fireMessage failure-finalize also threw");
      }
      throw err;
    }
  }

  async function fireMessageImpl(messageId: string, fireOptions: FireMessageOptions = {}): Promise<{ fired: boolean; childIds: string[] }> {
    const msg = await queries.messages.findById(pool, messageId);
    if (!msg) return { fired: false, childIds: [] };
    const { rows: fireChatRows } = await pool.query<{ workspace_id: string }>(
      `SELECT workspace_id FROM chats WHERE id = ?`,
      [msg.chatId],
    );
    const eventWorkspaceId = fireChatRows[0]?.workspace_id;

    // Execution target: the row whose state/started_at/ended_at this fire
    // owns. For a task, it's a freshly-inserted task_run child; for other
    // kinds, it's the message itself.
    let runId: string;
    if (msg.kind === "task") {
      const newRunId = generateId("message");
      const run = await queries.messages.startTaskRun(pool, {
        runId: newRunId,
        taskId: messageId,
        chatId: msg.chatId,
        role: msg.role,
        content: msg.content,
        agentId: msg.agentId ?? null,
        model: msg.model ?? null,
      });
      if (!run) return { fired: false, childIds: [] };
      runId = run.id;
      emit({ type: "message.appended", payload: run, workspaceId: eventWorkspaceId });
      // The task_run child is the authoritative agent-owned Active signal. The
      // parent is emitted only when a lifecycle policy below changes it.
    } else {
      const claimed = await queries.messages.claimPending(pool, messageId);
      if (!claimed) return { fired: false, childIds: [] };
      runId = messageId;
      emit({
        type: "message.updated",
        payload: (await queries.messages.findById(pool, messageId))!,
      });
    }

    // All post-claim work is wrapped in a single try/catch so any failure
    // — including pre-execution setup like prompt building or workspace lookup
    // — always reaches finalizeExecution and never leaves the message stuck
    // in `running` state.
    let logStream: fs.WriteStream | undefined;
    let logFile: string | undefined;

    const onLog = async (evt: LogEvent) => {
      if (!logStream) return;
      // Split on internal newlines so each log file line is exactly one
      // `kind\tpayload\n` record. A single onLog call may carry several
      // events concatenated by the driver (a stdout chunk covering
      // multiple lines); without splitting, the \n framing breaks and
      // readLogEntries can't associate continuation lines with a kind.
      const lines = evt.payload.split("\n");
      for (const line of lines) {
        if (!line) continue;
        logStream.write(`${evt.kind}\t${line}\n`);
        emit({
          type: "message.log_appended",
          payload: { messageId: runId, kind: evt.kind, line },
        });
      }
    };

    try {
      const { prompt, attachments } = await derivePromptInputs(msg);
      const outputKind = outputContentTypeFor(msg);

      // Single JOIN resolves workspace slug, agent, user, timezone, and the
      // chat's persistent goal in one round-trip. `chat_goal` feeds the
      // per-chat goal fragment into the rendered system prompt.
      const { rows: ctxRows } = await pool.query<{
        workspace_id: string;
        workspace_path: string;
        workspace_name: string;
        workspace_kind: string | null;
        agent_id: string | null;
        user_id: string | null;
        username: string | null;
        timezone: string | null;
        chat_goal: string | null;
      }>(
        `SELECT w.id AS workspace_id, w.path AS workspace_path, w.name AS workspace_name,
                w.kind AS workspace_kind, c.agent_id,
                u.id AS user_id, u.username, u.timezone,
                c.goal AS chat_goal
         FROM chats c
         JOIN workspaces w ON w.id = c.workspace_id
         LEFT JOIN users u ON u.id = w.user_id
         WHERE c.id = ?`,
        [msg.chatId],
      );
      const ctxRow = ctxRows[0];
      const workspaceId = ctxRow?.workspace_id ?? (await firstWorkspaceId());
      const workspaceSlug = ctxRow?.workspace_path ?? "desk";
      const workspaceName = ctxRow?.workspace_name ?? workspaceSlug;
      const workspaceKind: "project" | "hub" =
        ctxRow?.workspace_kind === "hub" ? "hub" : "project";
      const chatAgentId = ctxRow?.agent_id ?? null;
      const userId = ctxRow?.user_id ?? null;
      const userName = ctxRow?.username ?? "User";
      const userTimezone = ctxRow?.timezone ?? undefined;
      // Validate against the known goal keys before treating the column as a
      // GoalKey: if a row holds a value outside GOAL_KEYS (legacy data, manual
      // SQL edit), `goal/<key>.md` would not exist and the run would crash on
      // ENOENT mid-render. Fall back to no goal in that case.
      const rawGoal = ctxRow?.chat_goal ?? null;
      const chatGoal: GoalKey | null =
        rawGoal !== null && (GOAL_KEYS as readonly string[]).includes(rawGoal)
          ? (rawGoal as GoalKey)
          : null;

      const logDir = await ensureLogDir(workspaceSlug, msg.chatId);
      logFile = path.join(logDir, `${runId}.log`);
      // `flags: "w"` so a manual re-fire of a previously-failed
      // chat/summary message starts with a clean log instead of
      // appending the prior failure's stderr to the new attempt's
      // event stream. (Task fires use a fresh task_run child runId so
      // their log is always brand-new; "w" is equivalent to "a" in
      // that case.) The resource-retry path already truncates
      // explicitly mid-fire; this matches that behaviour at the start.
      logStream = fs.createWriteStream(logFile, { flags: "w" });
      const agentId = msg.agentId ?? chatAgentId ?? (await getDefaultAgentId());
      const providerKeys = userId ? await resolveProviderKeys(userId, workspaceId) : {};
      if (userId && Object.keys(providerKeys).length > 0) {
        await queries.providerKeyAccessLog.logKeyAccess(
          pool, userId, "read", Object.keys(providerKeys), `sandbox_run:${runId}`,
        );
      }
      // Codex/ChatGPT bridge: when the user has opted in and the host has a
      // valid `~/.codex/auth.json`, translate it to OpenCode's auth blob and
      // forward it as OPENCODE_AUTH_CONTENT. Re-read per run so a refresh on
      // the host (interactive `codex` use) propagates without recreating the
      // sandbox.
      const extraEnv = userId ? await resolveLocalSourceEnv(pool, userId) : {};
      const siblingSlugs = workspaceKind === "hub" && userId
        ? (await queries.workspaces.listByUser(pool, userId))
            .filter((w) => w.id !== workspaceId)
            .map((w) => w.path)
        : [];
      const localFsResolution = await buildWorkspaceMountPlan(pool, {
        home,
        workspaceId,
        workspaceSlug,
        userId,
        siblingWorkspaceSlugs: workspaceKind === "hub" ? siblingSlugs : [],
      });
      const agent = await queries.agents.findById(pool, agentId);
      const agentFileInput: AgentFileInput = {
        agentId,
        agentName: agent?.name ?? "Desk Agent",
        model: agent?.model ?? "opencode/big-pickle",
        userName,
        userTimezone,
        chatId: msg.chatId,
        goal: chatGoal,
        runMode: outputKind === "summary" ? "summary" : (msg.kind === "task" && (msg.executeAt || msg.cron) ? "scheduled-task" : "chat"),
        workspaceKind,
        localFilesystemDirectories: localFsResolution.agentDirectories,
      };

      let result: { exitCode: number };
      if (msg.content.type === "reflection_request") {
        // Reflections run in their own short-lived sandbox and never
        // surface a non-zero exit through this path, so they bypass
        // the resource-retry loop entirely.
        const journal = await fireReflectionTask(
          msg,
          workspaceId,
          workspaceSlug,
          workspaceName,
          userId,
          userName,
          userTimezone,
          fireOptions.manual === true,
        );
        await logReflectionOutcome(runId, journal, onLog);
        result = { exitCode: 0 };
      } else {
        // Hub mounts every owned project workspace read-only at
        // `~/workspaces/{slug}/`. Project-workspace runs get the default
        // single-workspace mount plan (no siblings).
        const mountPlan = workspaceKind === "hub" || localFsResolution.agentDirectories.length > 0
          ? localFsResolution.mountPlan
          : undefined;

        // Event-driven resource auto-scaling: capture stderr per-attempt
        // and, if a non-zero exit looks resource-shaped (`spawn EAGAIN`,
        // OOM-killer, ENOMEM), grow the sandbox in place and re-run the
        // same message. The user sees a delay, not an error.
        //
        // MAX_RESOURCE_RETRIES caps both retry-loop runaway (a
        // misclassified non-resource failure) and the reachable
        // ceiling. From the 512 baseline, 3 retries hit 1024 → 2048
        // → 4096, matching SANDBOX_MAX_PIDS / SANDBOX_MAX_MEMORY_BYTES.
        const MAX_RESOURCE_RETRIES = 3;
        // Keep only the tail of stderr — a long build can emit MBs of
        // output, and we run `toLowerCase()` plus several regex/includes
        // against this buffer every time we classify. Resource-failure
        // markers all appear near the end of stderr, right before the
        // process exits.
        const STDERR_TAIL_BYTES = 8 * 1024;
        let stderrCapture = "";
        const captureStderr = (payload: string): void => {
          stderrCapture += payload + "\n";
          if (stderrCapture.length > STDERR_TAIL_BYTES) {
            stderrCapture = stderrCapture.slice(-STDERR_TAIL_BYTES);
          }
        };
        const onLogWithStderrCapture = async (evt: LogEvent) => {
          if (evt.kind === "stderr") captureStderr(evt.payload);
          await onLog(evt);
        };
        let attempt = 0;
        // One opencode-serve session per Desk chat. Read the chat's
        // currently-bound session id (null on the chat's first turn) and
        // pass it into the runtime; the runtime returns the session that
        // actually handled the run, which may be a freshly-created one if
        // the chat had none or the stored id was stale on the daemon.
        let opencodeSessionId = await queries.chats.getOpencodeSessionId(pool, msg.chatId);
        // `resolveModelForRun` settles three concerns at once: it
        // translates `codex/<name>` to opencode-serve's `openai/<name>`
        // and strips `OPENAI_API_KEY` when the OAuth path is the
        // intended one; it falls back to the cloud key when Codex is
        // disabled; and — critically — it substitutes the free
        // `FALLBACK_MODEL` when no auth at all is available for the
        // requested provider. Without the last branch, a chat whose
        // agent still points at `codex/X` or `openai/X` after the user
        // disabled every model provider stalls on a daemon-side
        // `ProviderModelNotFoundError` or, worse, silently rides a
        // stale OAuth blob that opencode-serve cached from a previous
        // spawn.
        const billing = resolveModelForRun(agentFileInput.model, providerKeys, extraEnv);
        if (billing.reason === "no-auth-fallback") {
          // Surface the downgrade so the user sees what changed.
          //
          // Important caveat we name explicitly: the free fallback runs
          // through opencode.ai's zen endpoint and that tier has
          // historically been intermittently available — deprecated
          // model ids, rate limits, regional outages. When zen is
          // down, the daemon resolves the sendMessage call cleanly
          // with an `info.error` payload (no HTTP exception) and the
          // driver reports it via the upstream-error stderr line.
          // Setting expectations here so the user reads "enable a
          // provider" as the fix path, not "try again."
          await onLog({
            runId,
            seq: 0,
            kind: "stderr",
            payload:
              `No live auth for ${agentFileInput.model}; falling back to the free ${billing.runtimeModel}. ` +
              `Free fallback can be rate-limited or unavailable upstream — ` +
              `enable a model provider in Settings → Connections to restore the picked model reliably.`,
          });
        }
        const runtimeAgentInput: AgentFileInput =
          billing.runtimeModel === agentFileInput.model
            ? agentFileInput
            : { ...agentFileInput, model: billing.runtimeModel };
        while (true) {
          if (opts.execRunFn) {
            result = await opts.execRunFn(runId, agentId, prompt, onLogWithStderrCapture, { agentFileInput: runtimeAgentInput, attachments });
          } else {
            const handle = process.env.DESK_SANDBOX_DRIVER === "fake"
              ? { containerId: "fake-sandbox", workspaceId }
              : await createOrReuse(
                  workspaceId,
                  workspaceSlug,
                  home,
                  billing.providerKeys,
                  mountPlan,
                  extraEnv,
                  workspaceKind,
                );
            result = await runtimeExecRun(pool, handle, {
              runId,
              prompt,
              home,
              workspaceId,
              workspaceSlug,
              workspaceKind,
              chatId: msg.chatId,
              agent: runtimeAgentInput,
              attachments,
              providerKeys: billing.providerKeys,
              extraEnv,
              mountPlan,
              opencodeSessionId,
              onLog: onLogWithStderrCapture,
            });
            // Persist the session id after every attempt (not just success):
            // a resource-retry inside the loop should reuse the same session
            // so the model's context across attempts stays consistent.
            const nextSessionId = (result as { opencodeSessionId?: string }).opencodeSessionId;
            if (nextSessionId && nextSessionId !== opencodeSessionId) {
              await queries.chats.setOpencodeSessionId(pool, msg.chatId, nextSessionId);
              opencodeSessionId = nextSessionId;
            }
          }
          if (result.exitCode === 0) break;
          if (attempt >= MAX_RESOURCE_RETRIES) break;
          const failure = classifyResourceError(result.exitCode, stderrCapture);
          if (!failure) break;
          // Stop the current logStream and truncate the file so the retry
          // log doesn't tail-mix with the failed attempt's events. The user
          // shouldn't see "agent crashed then succeeded"; they should see
          // only the successful attempt's events.
          await new Promise<void>((resolve) => {
            logStream!.once("close", resolve);
            logStream!.end();
          });
          await fs.promises.truncate(logFile!, 0);
          logStream = fs.createWriteStream(logFile!, { flags: "a" });
          stderrCapture = "";
          const growth = await growSandboxForResourceError(workspaceId, failure);
          if (!growth.grew) {
            // Already at the maximum — no point retrying. Fall through to
            // finalise as failed; the user does see the failure in this case.
            log.warn(
              `runId=${runId}: ${failure} pressure but sandbox already at maximum; surfacing failure`,
            );
            break;
          }
          attempt++;
          log.info(
            `runId=${runId}: ${failure} resource failure on attempt ${attempt - 1}, ` +
              `grew sandbox (pids=${growth.pidsLimit}, memory=${growth.memoryBytes}); retrying`,
          );
        }
      }

      // Wait for pending writes to flush before reading the file back.
      await new Promise<void>((resolve) => {
        logStream!.once("finish", resolve);
        logStream!.end();
      });
      const terminal = result.exitCode === 0 ? "succeeded" : "failed";
      await queries.messages.finalizeExecution(pool, runId, terminal);
      emit({
        type: "message.updated",
        payload: (await queries.messages.findById(pool, runId))!,
      });
      await afterTaskRun(msg, terminal, fireOptions);

      const entries = await readLogEntries(logFile);
      const content = buildOutputContent(outputKind, entries);
      if (content) {
        // When the run produced a new summary, snapshot the previous summary
        // (if any) so a bad rewrite doesn't silently erase user edits.
        if (outputKind === "summary") {
          const { snapshotSummary } = await import("@agent-desk/storage");
          const prev = await pool.query(
            `SELECT id, content FROM messages
             WHERE chat_id = ? AND json_extract(content, '$.type') = 'summary'
             ORDER BY created_at DESC LIMIT 1`,
            [msg.chatId],
          );
          if (prev.rows[0]) {
            // SQLite returns JSON columns as TEXT; parse before reading.
            const prevRow = prev.rows[0] as { id: string; content: string };
            const parsed = JSON.parse(prevRow.content) as { body?: string };
            if (typeof parsed.body === "string") {
              await snapshotSummary(home, workspaceSlug, msg.chatId, prevRow.id, parsed.body).catch(() => { /* best-effort */ });
            }
          }
        }

        // Summary runs carry kind="summary" on the output child so the
        // insert path treats them as internal (no unread flip).
        const childKind = outputKind === "summary" ? "summary" : undefined;
        const child = await queries.messages.insert(pool, {
          id: generateId("message"),
          chatId: msg.chatId,
          role: "agent",
          content,
          parentId: runId,
          agentId,
          model: agentFileInput.model,
          ...(childKind ? { kind: childKind } : {}),
        });
        // Summary output: also write the body to the notes/ dir so the
        // agent (and any other filesystem consumer) can see the latest
        // summary alongside its own files. Best-effort — the DB row is the
        // source of truth.
        if (content.type === "summary") {
          const { materializeSummary } = await import("@agent-desk/storage");
          await materializeSummary(home, workspaceSlug, msg.chatId, child.id, content.body).catch(() => { /* best-effort */ });
        }
        emit({ type: "message.appended", payload: child, workspaceId });
        emit({ type: "workspace.synced", payload: { workspaceId } });
        return { fired: true, childIds: [child.id] };
      }
      emit({ type: "workspace.synced", payload: { workspaceId } });
      return { fired: true, childIds: [] };
    } catch (err) {
      log.error({ messageId, err }, "fireMessage failed");
      for (const line of errorLogLines(err)) {
        await onLog({ runId, seq: 0, kind: "stderr", payload: line });
      }
      if (logStream) {
        await new Promise<void>((resolve) => {
          logStream!.once("finish", resolve);
          logStream!.end();
        });
      }
      await queries.messages.finalizeExecution(pool, runId, "failed");
      const failedMsg = await queries.messages.findById(pool, runId);
      if (failedMsg) emit({ type: "message.updated", payload: failedMsg });
      await afterTaskRun(msg, "failed", fireOptions);
      if (!logFile) return { fired: true, childIds: [] };
      const entries = await readLogEntries(logFile);
      const content = buildOutputContent("text", entries);
      if (!content) {
        return { fired: true, childIds: [] };
      }
      // Failed summary runs: tag the error output child with
      // kind="summary" so it doesn't flip unread.
      const errorChildKind = outputContentTypeFor(msg) === "summary" ? "summary" : undefined;
      const child = await queries.messages.insert(pool, {
        id: generateId("message"),
        chatId: msg.chatId,
        role: "agent",
        content,
        parentId: runId,
        ...(errorChildKind ? { kind: errorChildKind } : {}),
      });
      emit({ type: "message.appended", payload: child, workspaceId: eventWorkspaceId });
      return { fired: true, childIds: [child.id] };
    }
  }

  /**
   * After a task run completes: cron tasks advance execute_at to the next
   * occurrence and stay pending; successful one-shot tasks transition to done
   * and clear execute_at. Failed one-shot runs clear the missed occurrence but
   * keep the parent task pending so an error does not count as completion.
   */
  async function afterTaskRun(
    task: Message,
    terminal: "succeeded" | "failed" | "cancelled",
    fireOptions: FireMessageOptions = {},
  ): Promise<void> {
    if (task.kind !== "task") return;
    if (fireOptions.manual && (task.executeAt || task.cron)) {
      const result = await pool.query(
        `UPDATE messages
         SET state = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
         WHERE id = ? AND state = 'running'`,
        [task.state, task.id],
      );
      if ((result.rowCount ?? 0) > 0) {
        const updated = await queries.messages.findById(pool, task.id);
        if (updated) emit({ type: "message.updated", payload: updated });
      }
      const latest = await queries.messages.findById(pool, task.id);
      if (latest?.state === "pending" && latest.cron && !latest.executeAt) {
        const updated = await queries.messages.updateMessage(pool, task.id, {
          executeAt: computeNextRun(latest.cron),
        });
        if (updated) emit({ type: "message.updated", payload: updated });
      }
      return;
    }
    if (task.cron) {
      const nextRun = computeNextRun(task.cron);
      const updated = await queries.messages.updateMessage(pool, task.id, { state: "pending", executeAt: nextRun });
      if (updated) emit({ type: "message.updated", payload: updated });
      return;
    }
    if (isUnscheduledTask(task)) return;
    const updated = await queries.messages.updateMessage(pool, task.id, {
      state: terminal === "failed" ? "pending" : terminal,
      executeAt: null,
    });
    if (updated) emit({ type: "message.updated", payload: updated });
  }

  /**
   * Polls for due pending messages and fires them up to MAX_CONCURRENT at a time.
   * Awaits all fires so callers (and tests) get a consistent DB state on return.
   */
  async function tickScheduled(): Promise<void> {
    const available = MAX_CONCURRENT - inFlight;
    if (available <= 0) return;
    const { rows } = await pool.query<{ id: string }>(
      `SELECT id FROM messages
       WHERE state = 'pending'
         AND execute_at IS NOT NULL
         AND execute_at <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       ORDER BY execute_at
       LIMIT ?`,
      [available],
    );
    await Promise.all(
      rows.map((row) => {
        inFlight++;
        return fireMessage(row.id)
          .catch((err: unknown) => {
            log.error({ messageId: row.id, err }, "fireMessage failed");
          })
          .finally(() => {
            inFlight--;
          });
      }),
    );
  }

  function startPolling(intervalMs: number): NodeJS.Timeout {
    const timer = setInterval(() => { void tickScheduled(); }, intervalMs);
    timer.unref();
    return timer;
  }

  // Sandbox sweep functions live in runs-sandbox-sweep.ts. Bind them to
  // the closure's pool so callers can use them without re-passing.
  const getActiveWorkspaceIds = (idleMs: number) => sandboxSweep.getActiveWorkspaceIds(pool, idleMs);
  const sweepIdleSandboxes = (idleMs?: number) => sandboxSweep.sweepIdleSandboxes(pool, idleMs);
  const startIdleSweeper = (intervalMs?: number) => sandboxSweep.startIdleSweeper(pool, intervalMs);
  const sweepIdleDaemons = (softIdleMs?: number) => sandboxSweep.sweepIdleDaemons(pool, softIdleMs);
  const startSoftIdleDaemonSweeper = (intervalMs?: number) => sandboxSweep.startSoftIdleDaemonSweeper(pool, intervalMs);
  // Note: an earlier draft of this file shipped a stale-run watchdog that
  // cancelled any `state='running'` row whose `started_at` was older than
  // 30 minutes. That was the wrong shape of fix — a single task should be
  // free to run for 24-48 hours, and silently killing valid long jobs
  // masks the actual root cause of any stuck rows we may see. If we end
  // up with stuck rows in practice, fix the path that left them stuck
  // instead of adding a watchdog that reaps them.

  /** Permanently deletes a message row. Used for ephemeral rows (e.g. summary) that should leave no trace. */
  async function cancelMessage(messageId: string): Promise<void> {
    await pool.query("DELETE FROM messages WHERE id = ?", [messageId]);
  }

  /**
   * Hybrid summary trigger (memory-system spec, P2.2).
   *
   * Counts tokens in the transcript-since-last-summary; if the transcript
   * crosses an adaptive model-aware budget, fire the summary immediately
   * (executeAt = now). Otherwise the existing time-based 30-minute fallback
   * applies.
   *
   * The trigger uses the active chat agent's OpenCode-reported context window
   * when available. Defaults follow long-context RAG/memory practice: summarize
   * at a small fraction of the model window, but clamp the threshold so small
   * local models keep enough working context and frontier models do not wait
   * until chats become unwieldy. Env overrides remain available for ops.
   */
  // Summary scheduling lives in runs-summary.ts. The factory owns the
  // per-chat model-context cache; we just hold its bound methods here so
  // the rest of the closure (and the public return surface) can call
  // them under their old names.
  const summaryScheduler = createSummaryScheduler({
    pool,
    resolveProviderKeys,
    summaryModelContextWindowFn: opts.summaryModelContextWindowFn,
    getDefaultAgentId,
  });
  const scheduleSummary = summaryScheduler.scheduleSummary;
  const cancelSummary = summaryScheduler.cancelSummary;
  const cancelSummaryForChat = summaryScheduler.cancelSummaryForChat;

  /** Cancels an in-flight exec: kills the opencode child if possible. */
  async function cancelRun(messageId: string): Promise<void> {
    await runtimeCancelRun(messageId);
    await queries.messages.updateMessage(pool, messageId, { state: "cancelled" });
    const msg = await queries.messages.findById(pool, messageId);
    if (msg) emit({ type: "message.updated", payload: msg });
  }

  /**
   * Find the chat's currently-running chat-kind agent_turn, if any.
   * Returns `null` when there is nothing in flight. Filtered to
   * `kind='chat'` so a scheduled `task_run` in the same chat doesn't
   * get preempted by an interactive follow-up.
   */
  async function findRunningChatTurn(chatId: string): Promise<
    | { id: string; workspaceSlug: string; startedAt: string | null }
    | null
  > {
    const { rows } = await pool.query<{
      id: string;
      workspace_slug: string;
      started_at: string | null;
    }>(
      `SELECT m.id, w.path AS workspace_slug, m.started_at
         FROM messages m
         JOIN chats c ON c.id = m.chat_id
         JOIN workspaces w ON w.id = c.workspace_id
        WHERE m.chat_id = ?
          AND m.state = 'running'
          AND m.kind = 'chat'
          AND json_valid(m.content)
          AND json_extract(m.content, '$.type') = 'agent_turn'
        ORDER BY m.created_at DESC
        LIMIT 1`,
      [chatId],
    );
    if (rows.length === 0) return null;
    return {
      id: rows[0].id,
      workspaceSlug: rows[0].workspace_slug,
      startedAt: rows[0].started_at,
    };
  }

  /**
   * Unconditionally cancel the chat's in-flight agent_turn so a new
   * user send can fire cleanly. This matches opencode's own client
   * pattern: opencode itself silently drops the new message's `parts`
   * if you POST to a busy session, so its bundled TUI/CLI calls
   * `session.abort(...)` before any new turn. We mirror that here.
   *
   * `POST /session/:id/abort` is safe to follow with a fresh send:
   * opencode preserves session history/messages-on-disk and the new
   * turn starts cleanly against an `Idle` session. The prior turn's
   * partial assistant reply is kept on the row (the cancel path
   * resolves with `Cancelled` after `lastAssistant` is captured).
   *
   * Returns the preempted run id, or `null` when nothing was running.
   */
  async function preemptChatRun(
    chatId: string,
  ): Promise<{ preempted: string } | null> {
    const running = await findRunningChatTurn(chatId);
    if (!running) return null;
    await cancelRun(running.id);
    return { preempted: running.id };
  }

  /**
   * Older, stale-only variant. Kept for diagnostics / scripted recovery
   * of zombie rows: only cancels when the log file has been silent for
   * `staleAfterMs`, so a healthy long-running step is never killed by
   * a periodic sweep. Not wired to the chat-send route any more — that
   * uses `preemptChatRun` (always-preempt) to match opencode semantics.
   *
   * Why we keep it: a follow-up that catches a wedged daemon (e.g. a
   * deadlocked tool with the row stuck in `running` and no log
   * activity) can call this explicitly without forcing a preempt
   * decision on healthy runs. The signal is log mtime — opencode
   * writes to the per-message log file on every event, so a
   * legitimately long-running step keeps the file growing.
   */
  async function preemptStalledChatRun(
    chatId: string,
    opts: { staleAfterMs?: number } = {},
  ): Promise<{ preempted: string } | null> {
    const staleAfterMs = opts.staleAfterMs
      ?? parseInt(process.env.DESK_RUN_STALE_PREEMPT_MS ?? "30000", 10);
    const running = await findRunningChatTurn(chatId);
    if (!running) return null;
    const logPath = path.join(
      home,
      running.workspaceSlug,
      ".chats",
      chatId,
      "logs",
      `${running.id}.log`,
    );
    let mtimeMs: number;
    try {
      const stat = await fsp.stat(logPath);
      mtimeMs = stat.mtimeMs;
    } catch {
      // Missing log file means opencode hasn't emitted its first event
      // yet — usually container cold-start (entrypoint downloading
      // deps, `.deskrc` running). Stale-only mode is conservative:
      // skip rather than risk killing legitimately-progressing work.
      // Stuck-with-no-log rows are recovered by `recoverOrphanedRuns`
      // at the requeue cap.
      return null;
    }
    const ageMs = Date.now() - mtimeMs;
    if (ageMs < staleAfterMs) return null;
    await cancelRun(running.id);
    return { preempted: running.id };
  }

  const pauseMessage = (messageId: string) => lifecycle.pauseMessage(pool, emit, messageId);
  const resumeMessage = (messageId: string) => lifecycle.resumeMessage(pool, emit, messageId);
  const rescheduleMessage = (messageId: string) => lifecycle.rescheduleMessage(pool, emit, messageId);
  const cancelScheduledMessage = (messageId: string) => lifecycle.cancelScheduledMessage(pool, emit, messageId);

  return {
    fireMessage,
    tickScheduled,
    startPolling,
    sweepIdleSandboxes,
    startIdleSweeper,
    sweepIdleDaemons,
    startSoftIdleDaemonSweeper,
    getActiveWorkspaceIds,
    cancelMessage,
    cancelRun,
    preemptChatRun,
    preemptStalledChatRun,
    pauseMessage,
    resumeMessage,
    rescheduleMessage,
    cancelScheduledMessage,
    scheduleSummary,
    cancelSummary,
    cancelSummaryForChat,
  };
}
