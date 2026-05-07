import { describe, expect, it } from 'vitest'
import { taskMessageKindsForDeveloperMode, toUiTask } from './tasks'
import type { ServerMessage } from '../types'

function message(overrides: Partial<ServerMessage> = {}): ServerMessage {
  return {
    id: 'msg_summary_request',
    chatId: 'cht_test',
    role: 'system',
    content: { type: 'summary_request' },
    createdAt: '2026-05-07T10:00:00.000Z',
    executeAt: '2026-05-07T10:30:00.000Z',
    state: 'pending',
    kind: 'summary',
    ...overrides,
  }
}

describe('task selectors', () => {
  it('queries summary task rows only in developer mode', () => {
    expect(taskMessageKindsForDeveloperMode(false)).toEqual(['task'])
    expect(taskMessageKindsForDeveloperMode(true)).toEqual(['task', 'summary'])
  })

  it('maps scheduled summary requests as readable scheduled tasks', () => {
    const task = toUiTask(message(), [], [{
      id: 'cht_test',
      workspaceId: 'wks_test',
      agentId: 'agent_test',
      title: 'Launch planning',
      updatedAt: '2026-05-07T10:00:00.000Z',
      awaitingUser: false,
      unread: false,
    }])

    expect(task.name).toBe('Summarize - Launch planning')
    expect(task.status).toBe('scheduled')
    expect(task.statusText).toMatch(/^Scheduled for /)
    expect(task.history).toEqual([
      {
        id: 'msg_summary_request-upcoming',
        startedAt: new Date('2026-05-07T10:30:00.000Z'),
        endedAt: new Date('2026-05-07T10:30:00.000Z'),
        status: 'scheduled',
      },
    ])
  })

  it('falls back to a generic summary task name when the chat title is unavailable', () => {
    const task = toUiTask(message({ title: 'Summary refresh' }), [], [])

    expect(task.name).toBe('Summarize')
  })

  it('maps task message body after the title as the description', () => {
    const task = toUiTask(message({
      id: 'msg_task',
      role: 'user',
      kind: 'task',
      title: 'Audit Q2',
      content: { type: 'text', text: 'Audit Q2\n\nCompare revenue and expenses.' },
      executeAt: undefined,
    }), [])

    expect(task.name).toBe('Audit Q2')
    expect(task.description).toBe('Compare revenue and expenses.')
    expect(task.messageKind).toBe('task')
    expect(task.messageContentType).toBe('text')
  })
})
