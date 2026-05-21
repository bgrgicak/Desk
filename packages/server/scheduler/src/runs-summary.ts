import { type Pool, queries } from "@agent-desk/db";
import { estimateMessagesTokens, listModels, resolveLocalSourceEnv } from "@agent-desk/runtime";
import { generateId } from "@agent-desk/shared";
import {
  envPositiveInt,
  formatMessageForPrompt,
  modelLimitsFromRef,
  normalizeModelLimits,
  shouldIncludeInPromptContext,
  summarizeMessagePreview,
  summaryTriggerBudget,
  type SummaryModelTokenLimits,
} from "./runs-helpers.js";

export interface SummarySchedulerDeps {
  pool: Pool;
  resolveProviderKeys: (userId: string, workspaceId?: string) => Promise<Record<string, string>>;
  /** Test hook overriding the model-metadata lookup. */
  summaryModelContextWindowFn?: (chatId: string, modelId: string) => Promise<number | SummaryModelTokenLimits | null>;
  /** Resolves the default agent id for chats without an explicit agent. */
  getDefaultAgentId: () => Promise<string>;
}

export interface SummaryScheduler {
  scheduleSummary(chatId: string): Promise<void>;
  cancelSummary(chatId: string): Promise<void>;
  cancelSummaryForChat(chatId: string): Promise<void>;
  isSummaryBudgetExceeded(chatId: string): Promise<boolean>;
}

/**
 * Hybrid summary trigger (memory-system spec, P2.2).
 *
 * Counts tokens in the transcript-since-last-summary; if the transcript
 * crosses an adaptive model-aware budget, fire the summary immediately
 * (executeAt = now). Otherwise the existing time-based 30-minute fallback
 * applies. Lives in its own module so the per-chat model-context cache
 * doesn't pollute the run-manager closure.
 */
export function createSummaryScheduler(deps: SummarySchedulerDeps): SummaryScheduler {
  const { pool, resolveProviderKeys, summaryModelContextWindowFn, getDefaultAgentId } = deps;
  const modelContextCache = new Map<string, { expiresAt: number; values: Map<string, SummaryModelTokenLimits> }>();

  async function latestUserMessagePreview(chatId: string): Promise<string | undefined> {
    const { rows } = await pool.query(
      `SELECT content FROM messages
       WHERE chat_id = ?
         AND role = 'user'
         AND json_extract(content, '$.type') = 'text'
       ORDER BY created_at DESC, id DESC
       LIMIT 1`,
      [chatId],
    );
    if (rows.length === 0) return undefined;
    const raw = rows[0].content;
    const content = typeof raw === "string" ? JSON.parse(raw) as { text?: unknown } : raw as { text?: unknown };
    if (typeof content.text !== "string") return undefined;
    return summarizeMessagePreview(content.text);
  }

  async function summaryRequestDisplayContext(chatId: string): Promise<{
    chatTitle?: string;
    messagePreview?: string;
    title: string;
  }> {
    const chat = await queries.chats.findById(pool, chatId);
    const chatTitle = chat?.title?.trim() || undefined;
    const messagePreview = await latestUserMessagePreview(chatId);
    const titleParts = [chatTitle, messagePreview].filter((part): part is string => !!part);
    return {
      chatTitle,
      messagePreview,
      title: titleParts.length > 0 ? `Summarize - ${titleParts.join(": ")}` : "Summarize chat",
    };
  }

  async function chatAgentModel(chatId: string): Promise<string> {
    const { rows } = await pool.query(
      `SELECT c.agent_id AS chat_agent_id
       FROM chats c
       WHERE c.id = ?`,
      [chatId],
    );
    const agentId = rows[0]?.chat_agent_id ?? (await getDefaultAgentId());
    const agent = await queries.agents.findById(pool, agentId as string);
    return agent?.model ?? "anthropic/claude-haiku-4-5";
  }

  async function summaryModelTokenLimits(chatId: string, modelId: string): Promise<SummaryModelTokenLimits> {
    const fromEnv = envPositiveInt("DESK_SUMMARY_MODEL_CONTEXT_WINDOW");
    if (fromEnv !== null) return { contextWindow: fromEnv };

    if (summaryModelContextWindowFn) {
      const resolved = normalizeModelLimits(await summaryModelContextWindowFn(chatId, modelId).catch(() => null));
      if (resolved !== null) return resolved;
    }

    const { rows } = await pool.query(
      `SELECT w.id AS workspace_id, w.path AS workspace_path, w.user_id AS user_id
       FROM chats c
       JOIN workspaces w ON w.id = c.workspace_id
       WHERE c.id = ?`,
      [chatId],
    );
    const row = rows[0];
    const workspaceId = row?.workspace_id as string | undefined;
    const workspaceSlug = row?.workspace_path as string | undefined;
    if (workspaceId && workspaceSlug) {
      const cacheKey = `${workspaceId}:${row?.user_id ?? ""}`;
      const cached = modelContextCache.get(cacheKey);
      if (cached && cached.expiresAt > Date.now()) {
        const value = cached.values.get(modelId);
        if (value !== undefined) return value;
      }
      try {
        const userId = row?.user_id as string | undefined;
        const providerKeys = userId ? await resolveProviderKeys(userId, workspaceId) : {};
        const extraEnv = userId ? await resolveLocalSourceEnv(pool, userId) : {};
        const models = await listModels(workspaceId, workspaceSlug, {
          providerKeys,
          env: extraEnv,
          timeoutMs: 5_000,
        });
        const values = new Map<string, SummaryModelTokenLimits>();
        for (const model of models) {
          const limits = modelLimitsFromRef(model);
          if (limits !== null) values.set(model.id, limits);
        }
        modelContextCache.set(cacheKey, { expiresAt: Date.now() + 5 * 60 * 1000, values });
        const value = values.get(modelId);
        if (value !== undefined) return value;
      } catch {
        // Model metadata is best-effort. Scheduling must never fail because the
        // sandbox or provider key lookup is temporarily unavailable.
      }
    }

    // Conservative fallback for unknown/local models when OpenCode metadata is
    // unavailable: enough room for a useful transcript, much lower than old 60K.
    return { contextWindow: 60_000 };
  }

  async function isSummaryBudgetExceeded(chatId: string): Promise<boolean> {
    const items = await queries.messages.listAgentContextByChat(pool, chatId);
    const taskRunParentIds = new Set(items.filter((message) => message.kind === "task_run").map((message) => message.id));
    const tokenized = items
      .filter((message) => shouldIncludeInPromptContext(message, taskRunParentIds))
      .map((m) => {
        const formatted = formatMessageForPrompt(m);
        return formatted ? { role: formatted.role, text: formatted.text } : null;
      })
      .filter((m): m is { role: string; text: string } => m !== null);
    const used = estimateMessagesTokens(tokenized);
    const modelId = await chatAgentModel(chatId);
    const limits = await summaryModelTokenLimits(chatId, modelId);
    const budget = summaryTriggerBudget(limits);
    return used >= budget;
  }

  async function cancelSummaryForChat(chatId: string): Promise<void> {
    await pool.query(
      `DELETE FROM messages WHERE chat_id = ? AND kind = 'summary' AND state = 'pending'`,
      [chatId],
    );
  }

  async function cancelSummary(chatId: string): Promise<void> {
    await cancelSummaryForChat(chatId);
  }

  async function scheduleSummary(chatId: string): Promise<void> {
    await cancelSummaryForChat(chatId);
    const urgent = await isSummaryBudgetExceeded(chatId);
    const summaryContext = await summaryRequestDisplayContext(chatId);
    const executeAt = urgent
      ? new Date().toISOString()
      : new Date(Date.now() + 30 * 60 * 1000).toISOString();
    const messageId = generateId("message");
    await queries.messages.insert(pool, {
      id: messageId,
      chatId,
      role: "system",
      content: {
        type: "summary_request",
        ...(summaryContext.chatTitle ? { chatTitle: summaryContext.chatTitle } : {}),
        ...(summaryContext.messagePreview ? { messagePreview: summaryContext.messagePreview } : {}),
      },
      state: "pending",
      kind: "summary",
      title: summaryContext.title,
      executeAt,
    });
  }

  return { scheduleSummary, cancelSummary, cancelSummaryForChat, isSummaryBudgetExceeded };
}
