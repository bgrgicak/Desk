import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { configureStore } from '@reduxjs/toolkit'
import { Provider } from 'react-redux'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it } from 'vitest'
import type { ComponentProps } from 'react'
import type { Task } from '@/data/ui-types'
import { api } from '@/store/api'
import { TaskCard } from './TaskCard'

const baseTask: Task = {
  id: 'msg_task',
  name: 'Summarize blockers',
  title: 'Summarize blockers',
  description: 'Plain fallback',
  agentName: 'Agent',
  status: 'needs_input',
  statusText: 'Needs input',
  startedAt: new Date('2026-05-28T18:00:00.000Z'),
  artifactIds: [],
  color: 'blue',
  history: [],
}

function renderCard(task: Task, latestPreview?: ComponentProps<typeof TaskCard>['latestPreview']) {
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
          createElement(TaskCard, {
            task,
            latestPreview,
            href: '/tasks/msg_task',
            onSelect: () => undefined,
            onMarkDone: () => undefined,
          }),
        ),
      },
    ),
  )
}

describe('TaskCard', () => {
  it('renders latest chat-message previews as markdown HTML', () => {
    const markup = renderCard(baseTask, {
      kind: 'text',
      text: '## Attention highlights\n\n**Blocked** / possibly broken - `chat-forms` render path. See [docs](https://example.com).',
      createdAt: new Date('2026-05-28T20:00:00.000Z'),
    })

    expect(markup).toContain('<h2')
    expect(markup).toContain('Attention highlights')
    expect(markup).toContain('<strong>Blocked</strong>')
    expect(markup).toContain('<code')
    expect(markup).toContain('docs')
    expect(markup).not.toContain('href="https://example.com"')
    expect(markup).not.toContain('## Attention highlights')
    expect(markup).not.toContain('**Blocked**')
  })

  it('renders fallback task descriptions as markdown HTML', () => {
    const markup = renderCard({
      ...baseTask,
      description: 'Review **launch notes** before `ship`.',
    })

    expect(markup).toContain('<strong>launch notes</strong>')
    expect(markup).toContain('<code')
    expect(markup).not.toContain('**launch notes**')
  })

  it('renders fragment previews only while the task needs input', () => {
    const latestPreview: ComponentProps<typeof TaskCard>['latestPreview'] = {
      kind: 'fragment',
      createdAt: new Date('2026-05-28T20:00:00.000Z'),
      artifact: {
        path: '/opt/roomy-apps/chat-forms.app/dist/fragments/yes-no',
        name: 'chat-forms',
        mime: 'inode/directory',
        params: { question: 'Ship it?' },
      },
    }

    const needsInputMarkup = renderCard(baseTask, latestPreview)
    expect(needsInputMarkup).toContain('data-testid="home-task-fragment-preview"')
    expect(needsInputMarkup).not.toContain('Plain fallback')

    const completeMarkup = renderCard({
      ...baseTask,
      status: 'complete',
      statusText: 'Done',
    }, latestPreview)
    expect(completeMarkup).not.toContain('data-testid="home-task-fragment-preview"')
    expect(completeMarkup).toContain('Plain fallback')
  })
})
