import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { configureStore } from '@reduxjs/toolkit'
import { Provider } from 'react-redux'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it } from 'vitest'
import { api } from '@/store/api'
import type { ServerFile } from '@/store/types'
import { PathChip } from './PathChip'
import { displayBasename, pathChipHref, workspaceRelativePath } from './PathChip'

async function renderPathChipWithMeta(file: ServerFile): Promise<string> {
  const store = configureStore({
    reducer: { [api.reducerPath]: api.reducer },
    middleware: getDefault => getDefault().concat(api.middleware),
  })
  await store.dispatch(api.util.upsertQueryData(
    'getLibraryFile',
    { workspaceId: 'wks_123', path: file.path },
    file,
  ))

  return renderToStaticMarkup(
    createElement(
      Provider,
      {
        store,
        children: createElement(
          MemoryRouter,
          null,
          createElement(PathChip, {
            sandboxPath: `/home/agent/${file.path}`,
            displayPath: `~/Roomy/demo/${file.path}`,
            workspaceId: 'wks_123',
          }),
        ),
      },
    ),
  )
}

describe('PathChip path classification', () => {
  it('maps sandbox absolute paths to workspace-relative library paths', () => {
    expect(workspaceRelativePath('/home/agent/Roomy')).toBe('Roomy')
    expect(workspaceRelativePath('~/Projects/Alpha')).toBe('Projects/Alpha')
  })
})

describe('displayBasename', () => {
  it('returns the filename for file paths', () => {
    expect(displayBasename('~/Roomy/roomy-dev/Roomy/README.md')).toBe('README.md')
  })

  it('returns the folder name for paths with a trailing slash', () => {
    expect(displayBasename('~/Roomy/roomy-dev/Roomy/.claude/worktrees/some-branch/')).toBe(
      'some-branch',
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

  it('builds app directory links as app items, not browsed folders', () => {
    expect(pathChipHref('wks_123', '/home/agent/.chats/cht_123/artifacts/rss-news-feed.app', true))
      .toBe('/w/wks_123/context?item=.chats%2Fcht_123%2Fartifacts%2Frss-news-feed.app')
  })

  it('returns undefined without a workspace', () => {
    expect(pathChipHref(undefined, '/home/agent/report.md', false)).toBeUndefined()
  })
})

describe('PathChip', () => {
  it('keeps inline app links on the app item route after directory metadata loads', async () => {
    const markup = await renderPathChipWithMeta({
      path: '.chats/cht_123/artifacts/rss-news-feed.app',
      name: 'rss-news-feed.app',
      mime: 'application/vnd.roomy.app+directory',
      size: 0,
      createdAt: '2026-05-28T00:00:00.000Z',
      isDir: true,
    })

    expect(markup).toContain('href="/w/wks_123/context?item=.chats%2Fcht_123%2Fartifacts%2Frss-news-feed.app"')
    expect(markup).not.toContain('folder=')
  })
})
