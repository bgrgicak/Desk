// RTK Query rejects with `{ status, data: { code, message } }` from the
// server, not Error instances — so the common `err instanceof Error ?
// err.message : undefined` pattern silently drops the only useful detail.
// Pull the server's `data.message` when present, falling back to Error.
export function extractApiError(err: unknown): string | undefined {
  if (err && typeof err === 'object' && 'data' in err) {
    const data = (err as { data?: unknown }).data
    if (data && typeof data === 'object' && 'message' in data) {
      const m = (data as { message?: unknown }).message
      if (typeof m === 'string') return m
    }
  }
  if (err instanceof Error) return err.message
  return undefined
}
