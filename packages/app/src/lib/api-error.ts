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

/**
 * True when the API rejected because the per-user vault is locked. The
 * server maps `VaultLockedError` to HTTP 423 with `code: "VAULT_LOCKED"`.
 * The caller is expected to open the VaultDialog and retry afterwards.
 */
export function isVaultLockedError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false
  const status = (err as { status?: unknown }).status
  if (status === 423) return true
  const data = (err as { data?: unknown }).data
  if (data && typeof data === 'object') {
    const code = (data as { code?: unknown }).code
    if (code === 'VAULT_LOCKED') return true
  }
  return false
}
