/**
 * Message-goal heuristic — what kind of output is the user steering this
 * conversation toward? Used to drive the compose-picker's placeholder hint
 * AND the chat-list sidebar icon (so chats keep the type the user typed
 * about: "create a data table" stays as a `data` chat).
 *
 * Returns null when no specific pattern hits — the compose UI layers its
 * own "long-enough → document" fallback on top, but the chat list keeps
 * `null` so we don't tag every conversation as a doc.
 */
export const GOAL_KEYS = [
  "app",
  "document",
  "image",
  "data",
  "site",
  "run",
  "task",
  "scheduled",
] as const;
export type GoalKey = (typeof GOAL_KEYS)[number];

export function inferGoal(text: string): GoalKey | null {
  const lower = text.toLowerCase().trim();
  if (!lower) return null;
  if (lower.match(/\b(every|daily|weekly|monthly|each (day|morning|week)|at \d|tomorrow|tonight|next (week|month)|cron)\b/)) return "scheduled";
  if (lower.match(/\b(todo|to do|task|remind me|follow up|chase|finish|complete by|due)\b/)) return "task";
  if (lower.match(/build|make|app|tracker|dashboard|tool|calculator/)) return "app";
  if (lower.match(/site|website|landing|portfolio|page/)) return "site";
  if (lower.match(/image|design|logo|illustration|palette|visual|photo|picture/)) return "image";
  if (lower.match(/spreadsheet|data|table|csv|metrics|numbers|chart|graph/)) return "data";
  if (lower.match(/run|check|monitor|scan|sync|automate|watch/)) return "run";
  if (lower.match(/write|draft|create|plan|strategy|brief|report|email|agenda|notes|document|summary|summarise|summarize/)) return "document";
  return null;
}
