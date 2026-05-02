export function describeApiError(err: unknown): string {
  if (err && typeof err === 'object') {
    const e = err as { data?: { message?: unknown }; error?: unknown }
    if (typeof e.data?.message === 'string') return e.data.message
    if (typeof e.error === 'string') return e.error
  }
  if (err instanceof Error) return err.message
  return 'Unknown error'
}
