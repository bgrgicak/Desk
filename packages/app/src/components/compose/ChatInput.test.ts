import { describe, expect, it } from 'vitest'
import { buildSendOptions } from './ChatInput'

describe('ChatInput send options', () => {
  it('does not turn a follow-up in a persisted task-goal chat into a new task', () => {
    expect(buildSendOptions('task', undefined, 'what can we do about it?')).toEqual(undefined)
  })

  it('creates a task only when task is explicitly selected in the composer', () => {
    expect(buildSendOptions(null, 'task', 'Review follow-up')).toEqual({
      kind: 'task',
      title: 'Review follow-up',
      goal: 'task',
    })
  })
})
