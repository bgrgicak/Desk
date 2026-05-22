/**
 * Lightweight token counter for the messages-since-last-summary transcript.
 *
 * Goal: estimate, within ~5% of pi/Anthropic accounting, how many
 * tokens a transcript consumes — enough precision to drive the
 * compaction trigger (Section 2 of the memory-system spec). This is not
 * a tokenizer; we use a character-based heuristic that has held up
 * empirically across English prose, code, and short-message chat:
 *
 *   tokens ≈ ceil(chars / 4)
 *
 * Plus a small per-message overhead for role/structural framing the
 * provider injects when packing chat messages.
 *
 * Why not call into a real tokenizer (tiktoken, etc.)? Pulling a native
 * dep into the runtime package adds engine pinning + cross-platform
 * builds for a single threshold check. The 4-chars-per-token rule is
 * documented by Anthropic for English text and is conservative enough
 * to fire compaction at the right moment. If empirical drift exceeds
 * ~10%, swap the implementation here without touching callers.
 */

/** Bytes-of-overhead added to each message for role/structural framing. */
const PER_MESSAGE_OVERHEAD_TOKENS = 4;

/** Estimate the token count of a single string. */
export function estimateStringTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

export interface TokenizableMessage {
  /** Free-text body. Usually the user's prompt or the agent's reply. */
  text?: string;
  /** Free-text role label ("user" / "agent" / "system"). Counted in overhead. */
  role?: string;
}

/**
 * Sum the estimated tokens across an array of messages.
 *
 * Each message contributes:
 *   - ceil(text.length / 4) for the body, plus
 *   - PER_MESSAGE_OVERHEAD_TOKENS for the framing the provider wraps it in.
 *
 * The role string is folded into the overhead and not counted separately
 * — it's negligible vs. the body and reduces variance from differently
 * named roles ("user" vs "agent" vs "assistant").
 */
export function estimateMessagesTokens(messages: TokenizableMessage[]): number {
  let total = 0;
  for (const m of messages) {
    total += estimateStringTokens(m.text ?? "");
    total += PER_MESSAGE_OVERHEAD_TOKENS;
  }
  return total;
}

/**
 * Returns whether the running transcript has crossed the configured
 * fraction of the model context window. The fraction is the
 * "compaction threshold" in the spec — defaults to 0.6 (60%) per the
 * resolved-decisions section of the plan.
 */
export function transcriptExceedsBudget(
  messages: TokenizableMessage[],
  modelContextWindow: number,
  fraction = 0.6,
): boolean {
  if (modelContextWindow <= 0) return false;
  const used = estimateMessagesTokens(messages);
  const budget = Math.floor(modelContextWindow * fraction);
  return used >= budget;
}
