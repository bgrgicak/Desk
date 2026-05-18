import { describe, expect, it } from 'vitest'
import type { ListLibraryResponse } from '@/store/types'
import { displayBasename, isDirectoryPath, pathChipHref, workspaceRelativePath } from './PathChip'

const library: ListLibraryResponse = {
  items: [
    {
      path: 'Desk.app',
      name: 'Desk.app',
      mime: 'application/vnd.desk.app+directory',
      size: 0,
      createdAt: '2026-05-13T00:00:00.000Z',
      isDir: true,
    },
    {
      path: 'report.md',
      name: 'report.md',
      mime: 'text/markdown',
      size: 12,
      createdAt: '2026-05-13T00:00:00.000Z',
    },
  ],
  folders: [
    { path: 'Desk', name: 'Desk', createdAt: '2026-05-13T00:00:00.000Z' },
    { path: 'Projects/Alpha', name: 'Alpha', createdAt: '2026-05-13T00:00:00.000Z' },
  ],
}

describe('PathChip path classification', () => {
  it('maps sandbox absolute paths to workspace-relative library paths', () => {
    expect(workspaceRelativePath('/home/agent/Desk')).toBe('Desk')
    expect(workspaceRelativePath('~/Projects/Alpha')).toBe('Projects/Alpha')
  })

  it('treats known library folders as directories even without a trailing slash', () => {
    expect(isDirectoryPath('/home/agent/Desk', library)).toBe(true)
    expect(isDirectoryPath('/home/agent/Projects/Alpha', library)).toBe(true)
  })

  it('treats directory library items, such as .app bundles, as directories', () => {
    expect(isDirectoryPath('/home/agent/Desk.app', library)).toBe(true)
  })

  it('does not treat regular files as directories', () => {
    expect(isDirectoryPath('/home/agent/report.md', library)).toBe(false)
  })
})

describe('displayBasename', () => {
  it('returns the filename for file paths', () => {
    expect(displayBasename('~/Desk/desk-dev/Desk/README.md')).toBe('README.md')
  })

  it('returns the folder name for paths with a trailing slash', () => {
    expect(displayBasename('~/Desk/desk-dev/Desk/.claude/worktrees/opencode-serve-per-sandbox/')).toBe(
      'opencode-serve-per-sandbox',
    )
  })

  it('returns the folder name for directory paths without a trailing slash', () => {
    expect(displayBasename('~/Projects/Alpha')).toBe('Alpha')
  })

  it('falls back to the full path when there is no basename to extract', () => {
    expect(displayBasename('/')).toBe('/')
  })
})

describe('pathChipHref', () => {
  it('builds real library links for files', () => {
    expect(pathChipHref('wks_123', '/home/agent/report.md', false)).toBe('/w/wks_123/context?item=report.md')
  })

  it('builds real library links for folders', () => {
    expect(pathChipHref('wks_123', '/home/agent/Projects/Alpha', true)).toBe('/w/wks_123/context?folder=Projects%2FAlpha')
  })

  it('returns undefined without a workspace', () => {
    expect(pathChipHref(undefined, '/home/agent/report.md', false)).toBeUndefined()
  })
})
