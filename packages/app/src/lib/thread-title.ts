// AI-generated thread titles — parity with chat titles.
//
// Today the server creates a thread chat with the title
// `"Thread: {parentChat.title}"` (see
// `packages/server/api/src/routes/chats.ts` `createThread`). That keeps
// the sidebar recognisable but doesn't say anything about what the
// thread is actually about.
//
// This file is the seam for AI-generated thread titles, mirroring
// `lib/task-title.ts` exactly. Once the backend ships a summarisation
// endpoint, `generateThreadTitle` becomes a single `fetch` call —
// callers already `await` it.

const MAX_TITLE_LEN = 60

/** Prompt the backend will eventually use. Kept here so the intent of
 *  the seam is documented next to the stub. */
export const THREAD_TITLE_PROMPT =
  'Summarize this thread in 3–6 words. Use plain language, no quotes, no trailing punctuation. The summary should make sense alongside the parent chat title.'

/** Synchronous best-effort title from the user's first message in the
 *  thread (the stub's brain, and a safe fallback if a real backend
 *  call ever fails). Mirrors `deriveTaskTitle` so the two surfaces
 *  read consistently. */
export function deriveThreadTitle(firstMessage: string): string {
  const collapsed = firstMessage.replace(/\s+/g, ' ').trim()
  if (!collapsed) return 'New thread'
  const firstLine = firstMessage.split('\n')[0]?.trim() ?? collapsed
  const sentenceEnd = collapsed.search(/[.!?](\s|$)/)
  let base =
    sentenceEnd > 0 && sentenceEnd < MAX_TITLE_LEN
      ? collapsed.slice(0, sentenceEnd)
      : firstLine || collapsed
  base = base.replace(/^\s*(?:[-*]|\d+[.)]|todo:?|task:?)\s+/i, '').trim()
  if (base.length > MAX_TITLE_LEN) {
    base = `${base.slice(0, MAX_TITLE_LEN).trimEnd()}…`
  }
  return base.charAt(0).toUpperCase() + base.slice(1)
}

/**
 * Produce a concise title for a freshly-created thread from the user's
 * first message. Async on purpose: this is the seam for the future
 * server-side AI titling. The current server route hard-codes
 * `"Thread: {parentChat.title}"` — once the summarisation endpoint
 * exists, the route (or this function called by the client) should
 * call it and overwrite the placeholder title.
 */
export async function generateThreadTitle(firstMessage: string): Promise<string> {
  // TODO(backend): call the thread-title endpoint here. See
  // `packages/server/docs/plans/threads-nesting.md` — this is part of
  // the same workstream that adds `chats.parent_chat_id`.
  return Promise.resolve(deriveThreadTitle(firstMessage))
}
