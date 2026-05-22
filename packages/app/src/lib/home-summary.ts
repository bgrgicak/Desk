// AI-generated Home digest — the greeting + 2-sentence summary shown at
// the top of the Home screen.
//
// Mirrors `lib/task-title.ts`: deterministic local stubs now, an async
// seam so the call site already `await`s, and baked-in prompt constants
// that describe what a real backend call should produce. Swapping in the
// real endpoint is a one-line change in `generateHomeDigest` with no
// caller changes.

export interface HomeTaskCounts {
  /** Tasks awaiting the user across all rooms. */
  needsInput: number
  /** Tasks an agent is actively working on across all rooms. */
  active: number
  /** Tasks completed (e.g. while the user was away). */
  done: number
}

export interface HomeDigest {
  greeting: string
  summary: string
  /** Epoch ms the digest was produced — drives the "Refreshed Xm ago" pill. */
  generatedAt: number
}

/**
 * Instructions a real model should follow for the big greeting line.
 * Kept as a constant so the prototype and the future backend stay
 * consistent.
 */
export const GREETING_PROMPT = [
  'Write a single short, warm headline (max ~6 words, no period) that sets',
  "the tone for the user's day based on their task load. Examples:",
  '"You\'ve got a busy day ahead", "A calm day so far", "Not much going on',
  'today". Do not greet by name here.',
].join(' ')

/**
 * Instructions for the 2-sentence summary paragraph: focus on actionable
 * items and their impact on the user's workflow.
 */
export const SUMMARY_PROMPT = [
  'Write exactly two sentences summarising the current tasks. Sentence one:',
  'how many need the user\'s input and why it matters / where to start.',
  'Sentence two: what is in progress and what was completed while they were',
  'away. Be specific and action-oriented; no fluff, no markdown.',
].join(' ')

function timeOfDay(now = new Date()): 'morning' | 'afternoon' | 'evening' {
  const h = now.getHours()
  if (h < 12) return 'morning'
  if (h < 18) return 'afternoon'
  return 'evening'
}

/** Plain fallback greeting — used when there are no tasks to riff on. */
export function fallbackGreeting(username?: string): string {
  const part = timeOfDay()
  return username
    ? `Good ${part}, ${username}`
    : `Good ${part}`
}

/** Deterministic stand-in for the AI greeting headline. */
export function deriveGreeting(counts: HomeTaskCounts, username?: string): string {
  const load = counts.needsInput + counts.active
  if (load === 0 && counts.done === 0) return fallbackGreeting(username)
  if (counts.needsInput >= 5 || load >= 8) return "You've got a busy day ahead"
  if (load === 0) return 'Not much going on today'
  if (counts.needsInput > 0) return 'A few things need your input'
  return 'A steady day so far'
}

/** Deterministic stand-in for the 2-sentence AI summary. */
export function deriveSummary(counts: HomeTaskCounts): string {
  const { needsInput, active, done } = counts
  const s1 =
    needsInput > 0
      ? `I found ${needsInput} task${needsInput === 1 ? '' : 's'} that need your input — I've ordered them by recency so you can start with the most pressing one.`
      : `Nothing needs your input right now.`
  const s2Parts: string[] = []
  if (active > 0) s2Parts.push(`${active} ${active === 1 ? 'is' : 'are'} in progress`)
  if (done > 0) s2Parts.push(`${done} completed while you were away`)
  const s2 =
    s2Parts.length > 0
      ? `${s2Parts.join(' and ')}${done > 0 ? ' — review them to see the output.' : '.'}`
      : `No tasks are currently running.`
  return `${s1} ${s2}`
}

/**
 * Produce the Home digest. Async on purpose — replace the body with the
 * backend call (using GREETING_PROMPT / SUMMARY_PROMPT) when ready; the
 * caller already awaits this.
 */
export async function generateHomeDigest(
  counts: HomeTaskCounts,
  username?: string,
): Promise<HomeDigest> {
  // TODO(backend): call the digest endpoint with GREETING_PROMPT /
  // SUMMARY_PROMPT + the task list, and return its result instead.
  return Promise.resolve({
    greeting: deriveGreeting(counts, username),
    summary: deriveSummary(counts),
    generatedAt: Date.now(),
  })
}
