// AI-generated task titles — parity with how chats get an AI title.
//
// The backend will eventually summarise the user's task message into a
// short title (the same way chat titles are produced server-side). Until
// that endpoint exists, `generateTaskTitle` is a deterministic local
// stub. It is intentionally async so the call site (App's onCreateTask)
// already `await`s it — swapping in a real API call later is a one-line
// change inside this function with no caller changes.

const MAX_TITLE_LEN = 60

/** Synchronous best-effort title from the message (the stub's brain,
 *  and a safe fallback). First sentence / first line, de-bulleted,
 *  trimmed, capped, first letter capitalised. */
export function deriveTaskTitle(message: string): string {
  const collapsed = message.replace(/\s+/g, ' ').trim()
  if (!collapsed) return 'New task'
  // First sentence if there's a clear terminator early, else first line.
  const firstLine = message.split('\n')[0]?.trim() ?? collapsed
  const sentenceEnd = collapsed.search(/[.!?](\s|$)/)
  let base =
    sentenceEnd > 0 && sentenceEnd < MAX_TITLE_LEN
      ? collapsed.slice(0, sentenceEnd)
      : firstLine || collapsed
  // Strip a leading list/marker prefix like "- ", "* ", "1. ", "TODO: ".
  base = base.replace(/^\s*(?:[-*]|\d+[.)]|todo:?|task:?)\s+/i, '').trim()
  if (base.length > MAX_TITLE_LEN) {
    base = `${base.slice(0, MAX_TITLE_LEN).trimEnd()}…`
  }
  return base.charAt(0).toUpperCase() + base.slice(1)
}

/**
 * Produce a concise title for a freshly-created task from the user's
 * message. Async on purpose: this is the seam for the future
 * server-side AI titling — replace the body with the API call when the
 * backend is ready; callers already await it.
 */
export async function generateTaskTitle(message: string): Promise<string> {
  // TODO(backend): call the task-title endpoint here (mirrors chat
  // title generation) and return its result instead of the local stub.
  return Promise.resolve(deriveTaskTitle(message))
}
