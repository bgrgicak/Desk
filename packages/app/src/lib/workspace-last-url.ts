const STORAGE_KEY_PREFIX = 'desk:last-workspace-url:'

function storageKey(workspaceId: string): string {
  return `${STORAGE_KEY_PREFIX}${workspaceId}`
}

function getStorage(): Storage | null {
  try {
    if (typeof window === 'undefined') return null
    return window.localStorage ?? window.sessionStorage ?? null
  } catch {
    try {
      return window.sessionStorage ?? null
    } catch {
      return null
    }
  }
}

export function isWorkspaceUrl(workspaceId: string, url: string): boolean {
  if (!workspaceId || !url.startsWith('/')) return false
  try {
    const parsed = new URL(url, 'http://desk.local')
    return parsed.origin === 'http://desk.local' && parsed.pathname.startsWith(`/w/${workspaceId}/`)
  } catch {
    return false
  }
}

export function saveLastWorkspaceUrl(workspaceId: string, url: string): void {
  if (!isWorkspaceUrl(workspaceId, url)) return
  const storage = getStorage()
  if (!storage) return
  try {
    storage.setItem(storageKey(workspaceId), url)
  } catch {
    // Ignore quota/security errors; the default workspace route still works.
  }
}

export function getLastWorkspaceUrl(workspaceId: string): string | null {
  const storage = getStorage()
  if (!storage) return null
  try {
    const url = storage.getItem(storageKey(workspaceId))
    return url && isWorkspaceUrl(workspaceId, url) ? url : null
  } catch {
    return null
  }
}
