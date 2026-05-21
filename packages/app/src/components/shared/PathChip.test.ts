import { describe, expect, it } from 'vitest'
import { displayBasename, pathChipHref, workspaceRelativePath } from './PathChip'

describe('PathChip path classification', () => {
  it('maps sandbox absolute paths to workspace-relative library paths', () => {
    expect(workspaceRelativePath('/home/agent/Desk')).toBe('Desk')
    expect(workspaceRelativePath('~/Projects/Alpha')).toBe('Projects/Alpha')
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
