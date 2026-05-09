import { describe, expect, it, beforeEach } from 'vitest'
import { getLastWorkspaceUrl, isWorkspaceUrl, saveLastWorkspaceUrl } from './workspace-last-url'

function createMemoryStorage(): Storage {
  const items = new Map<string, string>()
  return {
    get length() { return items.size },
    clear: () => items.clear(),
    getItem: key => items.get(key) ?? null,
    key: index => Array.from(items.keys())[index] ?? null,
    removeItem: key => { items.delete(key) },
    setItem: (key, value) => { items.set(key, value) },
  }
}

describe('workspace-last-url', () => {
  beforeEach(() => {
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: { localStorage: createMemoryStorage(), sessionStorage: createMemoryStorage() },
    })
  })

  it('saves and reads a workspace URL including query and hash', () => {
    saveLastWorkspaceUrl('ws_1', '/w/ws_1/context?item=docs%2Fplan.md#notes')

    expect(getLastWorkspaceUrl('ws_1')).toBe('/w/ws_1/context?item=docs%2Fplan.md#notes')
  })

  it('rejects URLs for other workspaces', () => {
    saveLastWorkspaceUrl('ws_1', '/w/ws_2/tasks')

    expect(getLastWorkspaceUrl('ws_1')).toBeNull()
  })

  it('only accepts app-relative URLs scoped to the workspace', () => {
    expect(isWorkspaceUrl('ws_1', '/w/ws_1/tasks')).toBe(true)
    expect(isWorkspaceUrl('ws_1', 'https://example.com/w/ws_1/tasks')).toBe(false)
    expect(isWorkspaceUrl('ws_1', '/settings')).toBe(false)
  })
})
