import { describe, expect, it } from 'vitest'
import { buildTaskLifecycleMove, buildTaskStatusMove } from '@/lib/task-status'
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

  it('hides workspace reflection requests outside developer mode', () => {
    const reflection = message({
      id: 'msg_reflection_request',
      kind: 'task',
      content: { type: 'reflection_request', workspaceId: 'wks_test' },
    })
    expect(isTaskListMessageForDeveloperMode(reflection, false)).toBe(false)
    expect(isTaskListMessageForDeveloperMode(reflection, true)).toBe(true)
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
      kind: 'project',
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
      createdAt: '2099-05-07T10:00:00.000Z',
      updatedAt: '2099-05-07T10:00:00.000Z',
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

  it('shows a parent task as active when the chat has an in-flight agent_turn', () => {
    const task = toUiTask(message({
      id: 'msg_parent_chat_running',
      role: 'user',
      kind: 'task',
      title: 'Live chat task',
      content: { type: 'text', text: 'Live chat task' },
      executeAt: undefined,
      cron: undefined,
      state: 'pending',
    }), [], [{
      id: 'cht_test',
      workspaceId: 'wks_test',
      agentId: 'agent_test',
      title: 'Live chat',
      createdAt: '2099-05-07T10:00:00.000Z',
      updatedAt: '2099-05-07T10:00:00.000Z',
      unread: false,
      running: true,
    }])

    expect(task.status).toBe('active')
    expect(task.statusText).toBe('Agent working…')
  })

  it('shows a parent task as needs_input when the chat is unread (agent has spoken)', () => {
    const task = toUiTask(message({
      id: 'msg_parent_unread',
      role: 'user',
      kind: 'task',
      title: 'Awaiting reply',
      content: { type: 'text', text: 'Awaiting reply' },
      executeAt: undefined,
      cron: undefined,
      state: 'pending',
    }), [], [{
      id: 'cht_test',
      workspaceId: 'wks_test',
      agentId: 'agent_test',
      title: 'Awaiting reply',
      createdAt: '2099-05-07T10:00:00.000Z',
      updatedAt: '2099-05-07T10:00:00.000Z',
      unread: true,
    }])

    expect(task.status).toBe('needs_input')
    expect(task.statusText).toBe('Waiting for your reply')
  })

  it('shows a sub-task as needs_input when the thread chat is unread after the run finished', () => {
    // Sub-task: anchor lives in the parent chat but the agent runs in
    // the dedicated thread chat, which is where unread=1 lands when the
    // agent posts. The selector has to look the chat up by threadChatId,
    // not chatId, or the task would stay silent until the user opened
    // the thread.
    //
    // The sticky-Active contract means parent state='running' wins over
    // chat.unread while the run is in flight (the agent is still
    // working). needs_input is the post-run handoff state: parent has
    // settled back to pending and the thread carries an unread agent
    // reply waiting for the user.
    const task = toUiTask(message({
      id: 'msg_subtask_anchor',
      role: 'agent',
      kind: 'task',
      chatId: 'cht_parent',
      threadChatId: 'cht_thread',
      title: 'Investigate the leak',
      content: { type: 'text', text: 'Investigate the leak' },
      executeAt: undefined,
      cron: undefined,
      state: 'pending',
    }), [], [
      {
        id: 'cht_parent',
        workspaceId: 'wks_test',
        agentId: 'agent_test',
        title: 'Parent chat',
        createdAt: '2099-05-07T10:00:00.000Z',
        updatedAt: '2099-05-07T10:00:00.000Z',
        unread: false,
      },
      {
        id: 'cht_thread',
        workspaceId: 'wks_test',
        agentId: 'agent_test',
        title: 'Investigate the leak',
        createdAt: '2099-05-07T10:00:00.000Z',
        updatedAt: '2099-05-07T10:05:00.000Z',
        unread: true,
      },
    ])

    expect(task.status).toBe('needs_input')
    expect(task.statusText).toBe('Waiting for your reply')
  })

  it('keeps a scheduled task labeled scheduled even when the chat is unread', () => {
    const task = toUiTask(message({
      id: 'msg_scheduled_and_unread',
      role: 'user',
      kind: 'task',
      title: 'Daily check',
      content: { type: 'text', text: 'Daily check' },
      executeAt: '2099-05-08T08:00:00.000Z',
      cron: undefined,
      state: 'pending',
    }), [], [{
      id: 'cht_test',
      workspaceId: 'wks_test',
      agentId: 'agent_test',
      title: 'Daily check',
      createdAt: '2099-05-07T10:00:00.000Z',
      updatedAt: '2099-05-07T10:00:00.000Z',
      unread: true,
      running: false,
    }])

    expect(task.status).toBe('scheduled')
    expect(task.statusText).toBe(`Scheduled for ${new Date('2099-05-08T08:00:00.000Z').toLocaleString()}`)
  })

  it('lets the chat in-flight signal trump the scheduled label', () => {
    const task = toUiTask(message({
      id: 'msg_scheduled_but_running',
      role: 'user',
      kind: 'task',
      title: 'Daily check',
      content: { type: 'text', text: 'Daily check' },
      executeAt: '2099-05-08T08:00:00.000Z',
      cron: undefined,
      state: 'pending',
    }), [], [{
      id: 'cht_test',
      workspaceId: 'wks_test',
      agentId: 'agent_test',
      title: 'Daily check',
      createdAt: '2099-05-07T10:00:00.000Z',
      updatedAt: '2099-05-07T10:00:00.000Z',
      unread: false,
      running: true,
    }])

    expect(task.status).toBe('active')
  })

  it('keeps terminal task state above live chat signals', () => {
    const task = toUiTask(message({
      id: 'msg_succeeded_but_chat_active',
      role: 'user',
      kind: 'task',
      title: 'Closed task',
      content: { type: 'text', text: 'Closed task' },
      executeAt: undefined,
      cron: undefined,
      state: 'succeeded',
    }), [], [{
      id: 'cht_test',
      workspaceId: 'wks_test',
      agentId: 'agent_test',
      title: 'Closed task',
      createdAt: '2099-05-07T10:00:00.000Z',
      updatedAt: '2099-05-07T10:00:00.000Z',
      unread: true,
      running: true,
    }])

    expect(task.status).toBe('complete')
  })

  it('shows a parent task as active while an agent-owned task_run is running', () => {
    const task = toUiTask(message({
      id: 'msg_parent_running_child',
      role: 'user',
      kind: 'task',
      title: 'Run check',
      content: { type: 'text', text: 'Run check' },
      executeAt: undefined,
      cron: undefined,
      state: 'pending',
    }), [], [], [], [
      message({
        id: 'msg_run_active',
        parentId: 'msg_parent_running_child',
        kind: 'task_run',
        state: 'running',
        executeAt: undefined,
        startedAt: '2099-05-07T08:00:10.000Z',
      }),
    ])

    expect(task.status).toBe('active')
  })

  it('does not let completed agent runs move the parent task to complete', () => {
    const task = toUiTask(message({
      id: 'msg_parent_completed_child',
      role: 'user',
      kind: 'task',
      title: 'Run check',
      content: { type: 'text', text: 'Run check' },
      executeAt: undefined,
      cron: undefined,
      state: 'pending',
    }), [], [], [], [
      message({
        id: 'msg_run_done',
        parentId: 'msg_parent_completed_child',
        kind: 'task_run',
        state: 'succeeded',
        executeAt: undefined,
        startedAt: '2099-05-07T08:00:10.000Z',
        endedAt: '2099-05-07T08:00:30.000Z',
      }),
    ])

    expect(task.status).toBe('todo')
  })

  it('folds errored parent tasks into Open so failure is internal-only', () => {
    // `state='failed'` deliberately does not promote to its own UI status
    // — the user retries from the same column they created it in. The
    // statusText still says "Failed" so the detail panel can surface
    // the cause, but the kanban badge stays Open.
    const task = toUiTask(message({
      id: 'msg_parent_failed',
      role: 'user',
      kind: 'task',
      title: 'Run check',
      content: { type: 'text', text: 'Run check' },
      executeAt: undefined,
      cron: undefined,
      state: 'failed',
    }), [])

    expect(task.status).toBe('todo')
    expect(task.statusText).toBe('Failed')
  })

  it("marks an agent-authored unscheduled task Active while its parent state='running'", () => {
    // The sandbox auto-fire path promotes the parent to `running` so the
    // kanban Active badge sticks past the moment the task_run terminates.
    // The selector has to read parent state='running' as Active even when
    // no child task_run is currently in-flight; without that, the card
    // would drop back to Open the instant the run finished and before
    // afterTaskRun propagated a terminal state.
    const task = toUiTask(message({
      id: 'msg_agent_unscheduled_active',
      role: 'agent',
      kind: 'task',
      title: 'Build a small app',
      content: { type: 'text', text: 'Scaffold a hello-world page.' },
      executeAt: undefined,
      cron: undefined,
      state: 'running',
    }), [])

    expect(task.status).toBe('active')
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
    expect(task.messageRole).toBe('user')
    expect(task.messageState).toBe('pending')
  })

  it('centralizes board status moves into run or patch actions', () => {
    const base = toUiTask(message({
      id: 'msg_user_task',
      role: 'user',
      kind: 'task',
      content: { type: 'text', text: 'Ship it' },
      executeAt: undefined,
      cron: undefined,
    }), [])

    expect(buildTaskStatusMove(base, 'active')).toEqual({ kind: 'run', optimisticStatus: 'active' })
    expect(buildTaskStatusMove({ ...base, status: 'active' }, 'complete')).toEqual({
      kind: 'patch',
      optimisticStatus: 'complete',
      patch: { state: 'cancelled' },
    })
    expect(buildTaskStatusMove({ ...base, status: 'complete' }, 'todo')).toEqual({
      kind: 'patch',
      optimisticStatus: 'todo',
      patch: { executeAt: null, cron: null, state: 'pending' },
    })
    expect(buildTaskStatusMove(base, 'scheduled', 'user', () => new Date('2099-05-07T10:00:00.000Z'))).toEqual({
      kind: 'patch',
      optimisticStatus: 'scheduled',
      patch: { state: 'pending', executeAt: '2099-05-08T10:00:00.000Z' },
    })
  })

  it('uses the same status policy for paused sidebar tasks without reading labels', () => {
    const paused = toUiTask(message({
      id: 'msg_paused_task',
      role: 'user',
      kind: 'task',
      content: { type: 'text', text: 'Paused task' },
      state: 'paused',
      executeAt: undefined,
      cron: undefined,
    }), [])

    expect(paused.status).toBe('todo')
    expect(paused.messageState).toBe('paused')
    expect(buildTaskStatusMove(paused, 'todo')).toEqual({
      kind: 'patch',
      optimisticStatus: 'todo',
      patch: { executeAt: null, cron: null, state: 'pending' },
    })
    expect(buildTaskLifecycleMove(paused, 'resume')).toEqual({
      kind: 'patch',
      optimisticStatus: 'todo',
      patch: { state: 'pending' },
    })
    expect(buildTaskLifecycleMove(paused, 'pause')).toEqual({ kind: 'none' })
  })

  it('keeps sidebar lifecycle actions user-owned and task-only', () => {
    const base = toUiTask(message({
      id: 'msg_lifecycle_policy',
      role: 'user',
      kind: 'task',
      content: { type: 'text', text: 'Lifecycle policy' },
      executeAt: undefined,
      cron: undefined,
    }), [])

    expect(buildTaskLifecycleMove(base, 'pause')).toEqual({
      kind: 'patch',
      optimisticStatus: 'todo',
      patch: { state: 'paused' },
    })
    expect(buildTaskLifecycleMove(base, 'pause', 'agent')).toEqual({ kind: 'none' })
    expect(buildTaskLifecycleMove({ ...base, messageKind: 'summary' }, 'pause')).toEqual({ kind: 'none' })
  })

  it('keeps parent task status moves user-gesture-only and task-only', () => {
    const base = toUiTask(message({
      id: 'msg_user_task_policy',
      role: 'user',
      kind: 'task',
      content: { type: 'text', text: 'Policy check' },
      executeAt: undefined,
      cron: undefined,
    }), [])

    expect(buildTaskStatusMove(base, 'active', 'agent')).toEqual({ kind: 'none' })
    expect(buildTaskStatusMove({ ...base, messageKind: 'summary' }, 'active', 'user')).toEqual({ kind: 'none' })
    expect(buildTaskStatusMove({ ...base, messageRole: 'agent' }, 'active', 'agent')).toEqual({ kind: 'none' })
    expect(buildTaskStatusMove({ ...base, messageRole: 'agent' }, 'active', 'user')).toEqual({
      kind: 'run',
      optimisticStatus: 'active',
    })
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
