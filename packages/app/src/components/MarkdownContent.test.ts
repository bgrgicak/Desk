import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { configureStore } from '@reduxjs/toolkit'
import { Provider } from 'react-redux'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it } from 'vitest'
import type { ComponentProps } from 'react'
import { api } from '@/store/api'
import type { ServerChat, ServerWorkspace } from '@/store/types'
import { MarkdownContent, parseEntityUrl } from './MarkdownContent'

async function renderMarkdown(
  props: ComponentProps<typeof MarkdownContent>,
  cache: { chats?: ServerChat[]; workspaces?: ServerWorkspace[] } = {},
): Promise<string> {
  const store = configureStore({
    reducer: { [api.reducerPath]: api.reducer },
    middleware: getDefault => getDefault().concat(api.middleware),
  })

  if (cache.chats) await store.dispatch(api.util.upsertQueryData('getChats', undefined, cache.chats))
  if (cache.workspaces) await store.dispatch(api.util.upsertQueryData('getWorkspaces', undefined, cache.workspaces))

  return renderToStaticMarkup(
    createElement(
      Provider,
      {
        store,
        children: createElement(
          MemoryRouter,
          null,
          createElement(MarkdownContent, props),
        ),
      },
    ),
  )
}

describe('parseEntityUrl', () => {
  it('ignores malformed encoded entity links', () => {
    expect(parseEntityUrl('roomy-entity:chat:%')).toBeNull()
  })

  it('renders malformed encoded entity links as inert text', async () => {
    const markup = await renderMarkdown({ text: '[bad](roomy-entity:chat:%)' })

    expect(markup).toContain('bad')
    expect(markup).not.toContain('<a')
    expect(markup).not.toContain('roomy-entity:chat:%')
  })

  it('renders chat IDs as real links when the current workspace is known', async () => {
    const markup = await renderMarkdown({ text: 'Open cht_123', workspaceId: 'wks_123' })

    expect(markup).toContain('<a')
    expect(markup).toContain('href="/w/wks_123/pinned?chat=cht_123"')
    expect(markup).not.toContain('<button')
  })

  it('renders cached chat titles without making chips inert', async () => {
    const markup = await renderMarkdown(
      { text: 'Open cht_123' },
      {
        chats: [{
          id: 'cht_123',
          workspaceId: 'wks_456',
          agentId: 'agent_1',
          title: 'Planning thread',
          createdAt: '2026-05-13T00:00:00.000Z',
          updatedAt: '2026-05-13T00:00:00.000Z',
          
          unread: false,
        }],
      },
    )

    expect(markup).toContain('Planning thread')
    expect(markup).toContain('href="/w/wks_456/pinned?chat=cht_123"')
    expect(markup).not.toContain('<button')
  })
})
