import { useCallback, useEffect, useState } from 'react'

// Home page section order + visibility, set from the Home Settings
// popover. Client-only, localStorage-backed (mirrors `use-home-pins` /
// `use-workspace-icon`: single key + change event + cross-tab storage
// sync). Kept out of the shared PrefsShape so it stays isolated and
// doesn't need the (private) prefs write path.

export type HomeSectionKey = 'summary' | 'needsInput' | 'nowHappening' | 'done'

export const HOME_SECTION_LABELS: Record<HomeSectionKey, string> = {
  summary: 'Summary',
  needsInput: 'Needs your input',
  nowHappening: 'Now happening',
  done: 'Recently done',
}

const DEFAULT_ORDER: HomeSectionKey[] = ['summary', 'needsInput', 'nowHappening', 'done']
const ALL = new Set<HomeSectionKey>(DEFAULT_ORDER)

interface HomeSectionsState {
  order: HomeSectionKey[]
  hidden: HomeSectionKey[]
}

const KEY = 'roomy.home-sections.v1'
const CHANGE_EVENT = 'roomy:home-sections-changed'

function normalize(raw: Partial<HomeSectionsState> | null): HomeSectionsState {
  const stored = (raw?.order ?? []).filter((k): k is HomeSectionKey => ALL.has(k as HomeSectionKey))
  // Keep stored order; append any keys added since (forward-compatible).
  const order = [...stored, ...DEFAULT_ORDER.filter(k => !stored.includes(k))]
  const hidden = (raw?.hidden ?? []).filter((k): k is HomeSectionKey => ALL.has(k as HomeSectionKey))
  return { order, hidden }
}

function read(): HomeSectionsState {
  try {
    const raw = localStorage.getItem(KEY)
    return normalize(raw ? (JSON.parse(raw) as Partial<HomeSectionsState>) : null)
  } catch {
    return normalize(null)
  }
}

function write(state: HomeSectionsState): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(state))
    window.dispatchEvent(new CustomEvent(CHANGE_EVENT))
  } catch {
    /* ignore — quota / unavailable */
  }
}

export interface UseHomeSections {
  /** Sections in display order. */
  order: HomeSectionKey[]
  /** Whether a section is currently shown. */
  isVisible: (key: HomeSectionKey) => boolean
  /** Persist a new order (from drag-reorder). */
  setOrder: (order: HomeSectionKey[]) => void
  /** Show/hide a section (from the checkbox). */
  toggle: (key: HomeSectionKey) => void
}

export function useHomeSections(): UseHomeSections {
  const [state, setState] = useState<HomeSectionsState>(() => read())

  useEffect(() => {
    const sync = () => setState(read())
    sync()
    window.addEventListener(CHANGE_EVENT, sync)
    window.addEventListener('storage', sync)
    return () => {
      window.removeEventListener(CHANGE_EVENT, sync)
      window.removeEventListener('storage', sync)
    }
  }, [])

  const setOrder = useCallback((order: HomeSectionKey[]) => {
    setState(prev => {
      const next = normalize({ order, hidden: prev.hidden })
      write(next)
      return next
    })
  }, [])

  const toggle = useCallback((key: HomeSectionKey) => {
    setState(prev => {
      const hidden = prev.hidden.includes(key)
        ? prev.hidden.filter(k => k !== key)
        : [...prev.hidden, key]
      const next = { order: prev.order, hidden }
      write(next)
      return next
    })
  }, [])

  const isVisible = useCallback(
    (key: HomeSectionKey) => !state.hidden.includes(key),
    [state.hidden],
  )

  return { order: state.order, isVisible, setOrder, toggle }
}
