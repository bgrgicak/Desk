import { useEffect, useState } from 'react'

export type Theme = 'light' | 'dark' | 'system'

const STORAGE_KEY = 'roomy.theme'
const CHANGE_EVENT = 'roomy:theme-changed'

function loadTheme(): Theme {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw === 'light' || raw === 'dark' || raw === 'system') return raw
  } catch {
    /* ignore */
  }
  return 'system'
}

function prefersDark(): boolean {
  try {
    return window.matchMedia('(prefers-color-scheme: dark)').matches
  } catch {
    return false
  }
}

function applyTheme(theme: Theme): void {
  const isDark = theme === 'dark' || (theme === 'system' && prefersDark())
  document.documentElement.classList.toggle('dark', isDark)
}

// Apply once on module load so the first render after a refresh matches the
// stored preference instead of flashing the default.
if (typeof document !== 'undefined') {
  applyTheme(loadTheme())
}

export function useTheme(): {
  theme: Theme
  resolved: 'light' | 'dark'
  setTheme: (next: Theme) => void
} {
  const [theme, setThemeState] = useState<Theme>(() => loadTheme())
  const [systemDark, setSystemDark] = useState<boolean>(() => prefersDark())

  // Cross-tab + same-tab sync.
  useEffect(() => {
    const onChange = () => setThemeState(loadTheme())
    window.addEventListener('storage', onChange)
    window.addEventListener(CHANGE_EVENT, onChange)
    return () => {
      window.removeEventListener('storage', onChange)
      window.removeEventListener(CHANGE_EVENT, onChange)
    }
  }, [])

  // Track system preference changes so 'system' updates live.
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const onMq = (e: MediaQueryListEvent) => setSystemDark(e.matches)
    mq.addEventListener('change', onMq)
    return () => mq.removeEventListener('change', onMq)
  }, [])

  // Reflect changes to the DOM.
  useEffect(() => {
    applyTheme(theme)
  }, [theme, systemDark])

  const setTheme = (next: Theme): void => {
    try {
      localStorage.setItem(STORAGE_KEY, next)
    } catch {
      /* ignore */
    }
    setThemeState(next)
    window.dispatchEvent(new CustomEvent(CHANGE_EVENT))
  }

  const resolved: 'light' | 'dark' =
    theme === 'dark' || (theme === 'system' && systemDark) ? 'dark' : 'light'

  return { theme, resolved, setTheme }
}
