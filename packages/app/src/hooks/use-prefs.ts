import { useEffect, useState } from 'react'
import { useGetMeQuery } from '@/store/api'
import { loadPrefs, type PrefsShape } from '@/components/settings/SettingsModal'

const PREFS_CHANGED_EVENT = 'roomy:prefs-changed'

export function notifyPrefsChanged(): void {
  window.dispatchEvent(new CustomEvent(PREFS_CHANGED_EVENT))
}

export function usePrefs(): PrefsShape & { loaded: boolean } {
  const { data: me } = useGetMeQuery()
  const userId = me?.id
  // Bump on prefs-change events to force a re-read; the actual values are
  // derived from `userId` + localStorage during render below, so they're
  // always in sync with the current `userId` (no stale-state window between
  // userId resolving and an effect copying real prefs into state).
  const [, setVersion] = useState(0)

  useEffect(() => {
    const handler = (): void => setVersion(v => v + 1)
    window.addEventListener(PREFS_CHANGED_EVENT, handler)
    // Cross-tab sync: storage events fire in OTHER tabs when this tab writes.
    window.addEventListener('storage', handler)
    return () => {
      window.removeEventListener(PREFS_CHANGED_EVENT, handler)
      window.removeEventListener('storage', handler)
    }
  }, [])

  // `loaded` distinguishes "user not fetched yet → using defaults" from
  // "real prefs". Effects that destructively react to a pref being false
  // must gate on `loaded` so they don't clobber persisted UI state on the
  // first render when the user query hasn't resolved.
  return { ...loadPrefs(userId), loaded: userId !== undefined }
}
