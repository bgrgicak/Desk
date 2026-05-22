// Parses URL params for chat-forms fragments. Safe to import server-side
// (returns empty when `window` is undefined) so the wizard renders during
// vitest SSR without a jsdom env.

export function readParams(): URLSearchParams {
  if (typeof window === 'undefined' || !window.location) {
    return new URLSearchParams()
  }
  return new URLSearchParams(window.location.search)
}

export function readQuestion(): string {
  return readParams().get('question') ?? ''
}

/**
 * Parses an `options` URL param into a list. Accepts either a JSON-encoded
 * array (`["a","b"]`) or a simple comma-separated string (`a,b,c`). Comma
 * form is forgiving — empty entries are dropped, surrounding whitespace
 * trimmed.
 */
export function readOptions(): string[] {
  const raw = readParams().get('options')
  if (!raw) return []
  if (raw.trim().startsWith('[')) {
    try {
      const parsed = JSON.parse(raw)
      if (Array.isArray(parsed)) {
        return parsed.filter((x): x is string => typeof x === 'string')
      }
    } catch {
      // fall through to CSV
    }
  }
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
}

export function readNumberParam(name: string): number | undefined {
  const raw = readParams().get(name)
  if (raw === null || raw === '') return undefined
  const n = Number(raw)
  return Number.isFinite(n) ? n : undefined
}

export function readStringParam(name: string): string | undefined {
  const raw = readParams().get(name)
  return raw ?? undefined
}

/**
 * Reads a boolean URL param. Returns `defaultValue` when the param is
 * absent. "false" / "0" / "no" / "off" (case-insensitive) read as false;
 * any other present value reads as true so `?foo` and `?foo=1` both work.
 */
export function readBooleanParam(name: string, defaultValue: boolean): boolean {
  const raw = readParams().get(name)
  if (raw === null) return defaultValue
  const normalized = raw.trim().toLowerCase()
  if (normalized === 'false' || normalized === '0' || normalized === 'no' || normalized === 'off') {
    return false
  }
  return true
}
