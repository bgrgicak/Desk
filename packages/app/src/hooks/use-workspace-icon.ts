import { useEffect, useState } from 'react'

// Workspace (room) icon images. Mirrors `use-avatar` exactly: a
// resized data-URL kept in localStorage, keyed by workspace id, with a
// cross-tab/in-tab change event so every avatar updates live. When set,
// this image is shown instead of the colour + initials fallback.

const ICON_KEY = (wsId: string) => `desk.workspace-icon.${wsId}`
const CHANGE_EVENT = 'desk:workspace-icon-changed'

export function useWorkspaceIconUrl(wsId: string | undefined): string | null {
  const [url, setUrl] = useState<string | null>(() =>
    wsId ? (localStorage.getItem(ICON_KEY(wsId)) ?? null) : null,
  )

  useEffect(() => {
    const read = () => setUrl(wsId ? (localStorage.getItem(ICON_KEY(wsId)) ?? null) : null)
    read()
    window.addEventListener(CHANGE_EVENT, read)
    window.addEventListener('storage', read)
    return () => {
      window.removeEventListener(CHANGE_EVENT, read)
      window.removeEventListener('storage', read)
    }
  }, [wsId])

  return url
}

export function saveWorkspaceIconUrl(wsId: string, dataUrl: string): void {
  try {
    localStorage.setItem(ICON_KEY(wsId), dataUrl)
    window.dispatchEvent(new CustomEvent(CHANGE_EVENT))
  } catch {
    /* ignore — e.g. storage quota exceeded */
  }
}

export function deleteWorkspaceIconUrl(wsId: string): void {
  try {
    localStorage.removeItem(ICON_KEY(wsId))
    window.dispatchEvent(new CustomEvent(CHANGE_EVENT))
  } catch {
    /* ignore */
  }
}
