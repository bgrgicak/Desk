import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { configureStore } from '@reduxjs/toolkit'
import { Provider } from 'react-redux'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'
import type { HomeDayItem } from '@/store/types'
import type { LatestAgentMessage } from '@/hooks/use-latest-agent-message'
import { api } from '@/store/api'
import { HomeDayList } from './HomeDayList'

const mockLatest = vi.hoisted((): { value: LatestAgentMessage | undefined } => ({
  value: undefined,
}))

vi.mock('@/hooks/use-latest-agent-message', () => ({
  useLatestAgentMessage: () => mockLatest.value,
}))

const baseChatItem: HomeDayItem = {
  kind: 'chat',
  id: 'chat_1',
  title: 'Launch decision',
  preview: 'Normal preview message',
  status: 'needs_input',
  statusLabel: 'Needs input',
  updatedAt: '2026-05-28T18:00:00.000Z',
  href: '/w/ws_1/pinned?chat=chat_1',
  room: {
    id: 'ws_1',
    name: 'Test room',
    color: 'purple',
    icon: '',
  },
  chat: {
    id: 'chat_1',
    unread: true,
    running: false,
    failed: false,
    latestFailedMessageId: null,
  },
}

const baseTaskItem: HomeDayItem = {
  kind: 'task',
  id: 'msg_task',
  title: 'Summarize blockers',
  preview: 'Plain fallback',
  status: 'needs_input',
  statusLabel: 'Needs input',
  updatedAt: '2026-05-28T18:00:00.000Z',
  href: '/w/ws_1/tasks?task=msg_task',
  room: {
    id: 'ws_1',
    name: 'Test room',
    color: 'purple',
    icon: '',
  },
  task: {
    id: 'msg_task',
    chatId: 'chat_1',
    role: 'user',
    content: { type: 'text', text: 'Summarize blockers\n\nPlain fallback' },
    kind: 'task',
    state: 'pending',
    title: 'Summarize blockers',
    createdAt: '2026-05-28T18:00:00.000Z',
    updatedAt: '2026-05-28T18:00:00.000Z',
    taskStatus: 'needs_input',
  },
}

const fragmentPreview: LatestAgentMessage = {
  kind: 'fragment',
  createdAt: new Date('2026-05-28T20:00:00.000Z'),
  artifact: {
    path: '/opt/roomy-apps/chat-forms.app/dist/fragments/yes-no',
    name: 'chat-forms',
    mime: 'inode/directory',
    params: { question: 'Ship it?' },
  },
}

function renderList(item: HomeDayItem) {
  const store = configureStore({
    reducer: { [api.reducerPath]: api.reducer },
    middleware: getDefault => getDefault().concat(api.middleware),
  })

  return renderToStaticMarkup(
    createElement(
      Provider,
      {
        store,
        children: createElement(
          MemoryRouter,
          null,
          createElement(HomeDayList, { items: [item] }),
        ),
      },
    ),
  )
}

describe('HomeDayList', () => {
  it('renders fragment previews only for Needs input cards', () => {
    mockLatest.value = fragmentPreview

    const needsInputMarkup = renderList(baseChatItem)
    expect(needsInputMarkup).toContain('data-testid="home-day-fragment-preview"')
    expect(needsInputMarkup).not.toContain('Normal preview message')

    const doneMarkup = renderList({
      ...baseChatItem,
      status: 'done',
      statusLabel: 'Done',
    })
    expect(doneMarkup).not.toContain('data-testid="home-day-fragment-preview"')
    expect(doneMarkup).toContain('Normal preview message')
  })

  it('renders text previews as markdown HTML', () => {
    mockLatest.value = undefined

    const markup = renderList({
      ...baseChatItem,
      preview: '## Attention highlights\n\n**Blocked** on `chat-forms`. See [details](https://example.com).',
    })

    expect(markup).toContain('<h2')
    expect(markup).toContain('Attention highlights')
    expect(markup).toContain('<strong>Blocked</strong>')
    expect(markup).toContain('<code')
    expect(markup).toContain('details')
    expect(markup).not.toContain('href="https://example.com"')
    expect(markup).not.toContain('## Attention highlights')
    expect(markup).not.toContain('**Blocked**')
  })

  it('uses the latest text chat message for the markdown preview when available', () => {
    mockLatest.value = {
      kind: 'text',
      text: '**Latest reply** from the agent.',
      createdAt: new Date('2026-05-28T21:00:00.000Z'),
    }

    const markup = renderList({
      ...baseChatItem,
      preview: 'Older plain preview',
    })

    expect(markup).toContain('<strong>Latest reply</strong>')
    expect(markup).not.toContain('Older plain preview')
  })

  it('renders task items with the real task-card controls', () => {
    mockLatest.value = undefined

    const markup = renderList(baseTaskItem)

    expect(markup).toContain('data-testid="task-card-msg_task"')
    expect(markup).toContain('data-testid="task-replies-msg_task"')
    expect(markup).toContain('data-testid="task-done-msg_task"')
    expect(markup).toContain('Mark as done')
    expect(markup).not.toContain('data-testid="home-day-item-msg_task"')
  })

  it('renders chat items with chat-specific card actions', () => {
    mockLatest.value = undefined

    const markup = renderList(baseChatItem)

    expect(markup).toContain('data-testid="home-day-item-chat_1"')
    expect(markup).toContain('data-testid="home-day-open-chat-chat_1"')
    expect(markup).toContain('data-testid="home-day-mark-read-chat_1"')
    expect(markup).toContain('Mark read')
    expect(markup).not.toContain('Mark as done')
  })
})
