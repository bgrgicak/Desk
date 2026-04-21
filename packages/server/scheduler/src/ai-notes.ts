/**
 * AI notes helpers — re-exported for convenience.
 * The plan-matching signatures scheduleAiNote(chatId) and cancelAiNote(chatId)
 * are methods on the RunManager returned by createRunManager().
 *
 * This module is kept for backward compatibility but simply delegates
 * to RunManager methods.
 */

import type { createRunManager } from "./runs.js";

type RunManager = ReturnType<typeof createRunManager>;

/**
 * Schedules an AI note for a chat.
 * Prefer runManager.scheduleAiNote(chatId) for plan-matching signature.
 */
export async function scheduleAiNote(
  runManager: RunManager,
  chatId: string,
): Promise<void> {
  await runManager.scheduleAiNote(chatId);
}

/**
 * Cancels any active ai_note for a chat.
 * Prefer runManager.cancelAiNote(chatId) for plan-matching signature.
 */
export async function cancelAiNote(
  runManager: RunManager,
  chatId: string,
): Promise<void> {
  await runManager.cancelAiNote(chatId);
}
