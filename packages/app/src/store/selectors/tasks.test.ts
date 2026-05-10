import { describe, expect, it } from 'vitest'
import { isTaskListMessageForDeveloperMode, summaryRequestMessageKindsForDeveloperMode, taskMessageKindsForDeveloperMode, taskRunMessageKinds, toUiTask } from './tasks'
import type { ServerMessage } from '../types'

function message(overrides: Partial<ServerMessage> = {}): ServerMessage {
  return {
    id: 'msg_summary_request',
    chatId: 'cht_test',
    role: 'system',
    content: { type: 'summary_request' },
    createdAt: '2099-05-07T10:00:00.000Z',
    executeAt: '2099-05-07T10:30:00.000Z',
    state: 'pending',
    kind: 'summary',
    ...overrides,
  }
}

describe('task selectors', () => {
  it('queries summary task rows only in developer mode so summary requests can be listed', () => {
    expect(taskMessageKindsForDeveloperMode(false)).toEqual(['task'])
    expect(taskMessageKindsForDeveloperMode(true)).toEqual(['task'])
    expect(summaryRequestMessageKindsForDeveloperMode(false)).toEqual([])
    expect(summaryRequestMessageKindsForDeveloperMode(true)).toEqual(['summary'])
    expect(taskRunMessageKinds()).toEqual(['task_run'])
  })

  it('includes summary requests but excludes materialized summaries from developer task lists', () => {
    expect(isTaskListMessageForDeveloperMode(message(), true)).toBe(true)
    expect(isTaskListMessageForDeveloperMode(message({
      id: 'msg_summary_output',
      content: { type: 'summary', body: '# Chat Summary — Mobile Chat Width Issue' },
      state: 'succeeded',
      executeAt: undefined,
    }), true)).toBe(false)
    expect(isTaskListMessageForDeveloperMode(message(), false)).toBe(false)
    expect(isTaskListMessageForDeveloperMode(message({
      id: 'msg_task',
      kind: 'task',
      content: { type: 'text', text: 'Follow up' },
    }), false)).toBe(true)
  })

  it('maps reflection requests as readable developer tasks', () => {
    const task = toUiTask(message({
      id: 'msg_reflection_request',
      content: { type: 'reflection_request', workspaceId: 'wks_test' },
      kind: 'task',
      title: 'Daily workspace memory reflection',
      cron: '0 3 * * *',
    }), [], [], [{
      id: 'wks_test',
      userId: 'usr_test',
      name: 'Launch Workspace',
      path: 'Launch Workspace',
      description: '',
      icon: '',
      color: '',
      createdAt: '2099-05-07T10:00:00.000Z',
    }])

    expect(task.name).toBe('Reflect - Launch Workspace')
    expect(task.status).toBe('scheduled')
    expect(task.messageKind).toBe('task')
    expect(task.messageContentType).toBe('reflection_request')
  })

  it('falls back to a generic reflection task name when the workspace is unavailable', () => {
    const task = toUiTask(message({
      id: 'msg_reflection_request',
      content: { type: 'reflection_request', workspaceId: 'wks_missing' },
      kind: 'task',
    }), [], [], [])

    expect(task.name).toBe('Reflect')
  })

  it('maps scheduled summary requests as readable scheduled tasks', () => {
    const task = toUiTask(message(), [], [{
      id: 'cht_test',
      workspaceId: 'wks_test',
      agentId: 'agent_test',
      title: 'Launch planning',
      updatedAt: '2099-05-07T10:00:00.000Z',
      awaitingUser: false,
      unread: false,
    }])

    expect(task.name).toBe('Summarize - Launch planning')
    expect(task.status).toBe('scheduled')
    expect(task.statusText).toMatch(/^Scheduled for /)
    expect(task.history).toEqual([
      {
        id: 'msg_summary_request-upcoming',
        startedAt: new Date('2099-05-07T10:30:00.000Z'),
        endedAt: new Date('2099-05-07T10:30:00.000Z'),
        status: 'scheduled',
      },
    ])
  })

  it('uses embedded summary request context when chat data is unavailable', () => {
    const task = toUiTask(message({
      content: {
        type: 'summary_request',
        chatTitle: 'Launch planning',
        messagePreview: 'Draft the homepage hero copy and keep it concise.',
      },
    }), [], [])

    expect(task.name).toBe('Summarize - Launch planning')
    expect(task.description).toBe('Draft the homepage hero copy and keep it concise.')
  })

  it('includes task_run children in task history', () => {
    const task = toUiTask(message({
      id: 'msg_parent',
      role: 'user',
      kind: 'task',
      title: 'Daily check',
      content: { type: 'text', text: 'Daily check' },
      cron: '0 8 * * *',
      executeAt: '2099-05-08T08:00:00.000Z',
    }), [], [], [], [
      message({
        id: 'msg_run_old',
        parentId: 'msg_parent',
        kind: 'task_run',
        state: 'succeeded',
        createdAt: '2099-05-06T08:00:00.000Z',
        executeAt: undefined,
        startedAt: '2099-05-06T08:00:10.000Z',
        endedAt: '2099-05-06T08:01:00.000Z',
      }),
      message({
        id: 'msg_run_failed',
        parentId: 'msg_parent',
        kind: 'task_run',
        state: 'failed',
        createdAt: '2099-05-07T08:00:00.000Z',
        executeAt: undefined,
        startedAt: '2099-05-07T08:00:10.000Z',
        endedAt: '2099-05-07T08:00:30.000Z',
      }),
    ])

    expect(task.history).toEqual([
      expect.objectContaining({
        id: 'msg_run_old',
        startedAt: new Date('2099-05-06T08:00:10.000Z'),
        endedAt: new Date('2099-05-06T08:01:00.000Z'),
        status: 'completed',
        statusText: 'Completed',
      }),
      expect.objectContaining({
        id: 'msg_run_failed',
        startedAt: new Date('2099-05-07T08:00:10.000Z'),
        endedAt: new Date('2099-05-07T08:00:30.000Z'),
        status: 'failed',
        statusText: 'Failed',
      }),
      {
        id: 'msg_parent-upcoming',
        startedAt: new Date('2099-05-08T08:00:00.000Z'),
        endedAt: new Date('2099-05-08T08:00:00.000Z'),
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

  it('uses the whole task message body as the description when the title is stored separately', () => {
    const task = toUiTask(message({
      id: 'msg_task_separate_title',
      role: 'agent',
      kind: 'task',
      title: 'Show fallback for tool-only chat runs',
      content: { type: 'text', text: 'Add a visible fallback reply when a chat run only emits tool calls.' },
      executeAt: undefined,
    }), [])

    expect(task.name).toBe('Show fallback for tool-only chat runs')
    expect(task.description).toBe('Add a visible fallback reply when a chat run only emits tool calls.')
  })
})
