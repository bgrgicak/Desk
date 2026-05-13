import { describe, expect, it } from 'vitest'
import type { ListLibraryResponse } from '@/store/types'
import { isDirectoryPath, workspaceRelativePath } from './PathChip'

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
