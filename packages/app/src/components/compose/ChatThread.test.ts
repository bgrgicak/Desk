import { describe, expect, it } from 'vitest'
import { isMessageVisible, messagesToClipboardText } from './messageVisibility'
import type { ServerMessage } from '@/store/types'

function message(content: ServerMessage['content'], overrides: Partial<ServerMessage> = {}): ServerMessage {
  return {
    id: 'msg_test',
    chatId: 'cht_test',
    role: 'agent',
    content,
    createdAt: '2026-05-04T10:00:00.000Z',
    ...overrides,
  }
}

describe('isMessageVisible', () => {
  it('shows summary messages only in developer mode', () => {
    const summary = message({ type: 'summary', body: '# Chat Summary' })

    expect(isMessageVisible(summary, false)).toBe(false)
    expect(isMessageVisible(summary, true)).toBe(true)
  })

  it('keeps summary requests hidden even in developer mode', () => {
    const request = message({ type: 'summary_request' }, { role: 'system' })

    expect(isMessageVisible(request, false)).toBe(false)
    expect(isMessageVisible(request, true)).toBe(false)
  })
})

describe('messagesToClipboardText', () => {
  it('includes user and agent text messages', () => {
    const msgs = [
      message({ type: 'text', text: 'Hello' }, { role: 'user', id: '1' }),
      message({ type: 'text', text: 'Hi there!' }, { role: 'agent', id: '2' }),
    ]
    expect(messagesToClipboardText(msgs)).toBe('You: Hello\n\nAgent: Hi there!')
  })

  it('excludes system messages (summary, summary_request, agent_turn)', () => {
    const msgs = [
      message({ type: 'text', text: 'Hello' }, { role: 'user', id: '1' }),
      message({ type: 'summary', body: 'Summary body' }, { role: 'system', id: '2' }),
      message({ type: 'summary_request' }, { role: 'system', id: '3' }),
      message({ type: 'agent_turn', userMessageId: '1' }, { role: 'system', id: '4' }),
      message({ type: 'text', text: 'Reply' }, { role: 'agent', id: '5' }),
    ]
    expect(messagesToClipboardText(msgs)).toBe('You: Hello\n\nAgent: Reply')
  })

  it('excludes tool calls and tool results', () => {
    const msgs = [
      message({ type: 'text', text: 'Do something' }, { role: 'user', id: '1' }),
      message({ type: 'toolCall', toolName: 'bash', args: { cmd: 'ls' } }, { role: 'agent', id: '2' }),
      message({ type: 'toolResult', toolName: 'bash', result: 'file.txt' }, { role: 'agent', id: '3' }),
      message({ type: 'text', text: 'Done' }, { role: 'agent', id: '4' }),
    ]
    expect(messagesToClipboardText(msgs)).toBe('You: Do something\n\nAgent: Done')
  })

  it('excludes task_run messages', () => {
    const msgs = [
      message({ type: 'text', text: 'Run task' }, { role: 'user', id: '1' }),
      message({ type: 'text', text: 'Running...' }, { role: 'user', id: '2', kind: 'task_run' }),
      message({ type: 'text', text: 'Completed' }, { role: 'agent', id: '3' }),
    ]
    expect(messagesToClipboardText(msgs)).toBe('You: Run task\n\nAgent: Completed')
  })

  it('extracts text from events log entries', () => {
    const msgs = [
      message({
        type: 'events',
        log: [
          { kind: 'event', event: { type: 'text', part: { text: 'Hello ' } } },
          { kind: 'event', event: { type: 'text', part: { text: 'world' } } },
        ],
      }, { role: 'agent', id: '1' }),
    ]
    expect(messagesToClipboardText(msgs)).toBe('Agent: Hello world')
  })

  it('extracts unparsed lines when no events precede them', () => {
    const msgs = [
      message({
        type: 'events',
        log: [
          { kind: 'unparsed', line: 'plain output' },
        ],
      }, { role: 'agent', id: '1' }),
    ]
    expect(messagesToClipboardText(msgs)).toBe('Agent: plain output')
  })

  it('skips events with only tool events and no text', () => {
    const msgs = [
      message({ type: 'text', text: 'Question' }, { role: 'user', id: '1' }),
      message({
        type: 'events',
        log: [
          { kind: 'event', event: { type: 'tool-call', part: { name: 'bash' } } },
        ],
      }, { role: 'agent', id: '2' }),
      message({ type: 'text', text: 'Answer' }, { role: 'agent', id: '3' }),
    ]
    expect(messagesToClipboardText(msgs)).toBe('You: Question\n\nAgent: Answer')
  })

  it('skips artifact ref messages (no copyable text)', () => {
    const msgs = [
      message({ type: 'text', text: 'Here you go' }, { role: 'agent', id: '1' }),
      message({ type: 'artifactRef', path: '/file.txt', name: 'file.txt' }, { role: 'agent', id: '2' }),
    ]
    expect(messagesToClipboardText(msgs)).toBe('Agent: Here you go')
  })

  it('returns empty string when no messages are visible', () => {
    const msgs = [
      message({ type: 'summary', body: 'Sum' }, { id: '1' }),
      message({ type: 'toolCall', toolName: 'x', args: {} }, { id: '2' }),
    ]
    expect(messagesToClipboardText(msgs)).toBe('')
  })
})
