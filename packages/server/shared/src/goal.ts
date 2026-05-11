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
