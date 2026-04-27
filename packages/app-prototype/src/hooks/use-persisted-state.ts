import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react'

function readStored<T>(key: string | null, defaultValue: T): T {
  if (!key || typeof window === 'undefined') return defaultValue
  try {
    const raw = window.localStorage.getItem(key)
    if (raw === null) return defaultValue
    return JSON.parse(raw) as T
  } catch {
    return defaultValue
  }
}

/**
 * Like useState, but persists to localStorage under `key`.
 *
 * `key` may be null (e.g. while waiting on a chat id) — values aren't
 * persisted in that case. When the key changes, state is reloaded from
 * storage so per-entity switchers (per chat, per artifact, per task)
 * pick up that entity's last selection.
 */
export function usePersistedState<T>(
  key: string | null,
  defaultValue: T,
): [T, Dispatch<SetStateAction<T>>] {
  const [state, setState] = useState<T>(() => readStored(key, defaultValue))
  const keyRef = useRef(key)

  useEffect(() => {
    if (keyRef.current === key) return
    keyRef.current = key
    setState(readStored(key, defaultValue))
  }, [key, defaultValue])

  const setPersisted = useCallback<Dispatch<SetStateAction<T>>>(
    (valueOrFn) => {
      setState(prev => {
        const next = typeof valueOrFn === 'function'
          ? (valueOrFn as (p: T) => T)(prev)
          : valueOrFn
        const k = keyRef.current
        if (k && typeof window !== 'undefined') {
          try {
            window.localStorage.setItem(k, JSON.stringify(next))
          } catch {
            // Quota / disabled storage — fall through, in-memory state still updates.
          }
        }
        return next
      })
    },
    [],
  )

  return [state, setPersisted]
}
