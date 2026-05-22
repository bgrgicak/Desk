import { describe, expect, it } from 'vitest'
import { artifactRefHref, attachmentAlignmentClass, eventDisplayChunks } from './MessageBubble'

describe('artifactRefHref', () => {
  it('opens chat artifact app directories as items instead of library folders', () => {
    expect(artifactRefHref('ws_123', '.chats/cht_123/artifacts/my-app.app', 'inode/directory'))
      .toBe('/w/ws_123/context?item=.chats%2Fcht_123%2Fartifacts%2Fmy-app.app')
  })

  it('keeps regular directories routed to the folder browser', () => {
    expect(artifactRefHref('ws_123', 'Project Files', 'inode/directory'))
      .toBe('/w/ws_123/context?folder=Project+Files')
  })
})

describe('attachmentAlignmentClass', () => {
  it('right-aligns user-uploaded message attachments', () => {
    expect(attachmentAlignmentClass('right')).toBe('self-end ml-auto')
  })

  it('keeps agent-written file attachments left-aligned', () => {
    expect(attachmentAlignmentClass('left')).toBe('self-start mr-auto')
  })
})

describe('eventDisplayChunks', () => {
  it('keeps raw diagnostic/error rows developer-only', () => {
    const log = [
      { kind: 'event' as const, event: { type: 'tool', part: { input: 'query' } } },
      { kind: 'stderr' as const, line: '\u001b[91mError:\u001b[0m Unexpected error, check log file at /tmp/log' },
      { kind: 'event' as const, event: { type: 'error', error: { data: { message: 'Model not found: openai/gpt-5.5.' } } } },
    ]

    expect(eventDisplayChunks(log, false)).toEqual([])
    expect(eventDisplayChunks(log, true)).toEqual([
      { kind: 'events', entries: [log[0]] },
      { kind: 'stderr', lines: [log[1].line, 'Model not found: openai/gpt-5.5.'] },
    ])
  })

  it('keeps assistant text visible while hiding adjacent diagnostics in regular mode', () => {
    const log = [
      { kind: 'event' as const, event: { type: 'text', part: { text: 'Visible answer' } } },
      { kind: 'stderr' as const, line: 'Failed to run the query `PRAGMA journal_mode = WAL`' },
    ]

    expect(eventDisplayChunks(log, false)).toEqual([{ kind: 'text', text: 'Visible answer' }])
  })

  it('keeps reasoning hidden from regular users and grouped with tool events for developers', () => {
    const log = [
      { kind: 'event' as const, event: { type: 'reasoning', part: { text: 'Private chain of thought.' } } },
    ]

    expect(eventDisplayChunks(log, false)).toEqual([])
    expect(eventDisplayChunks(log, true)).toEqual([{ kind: 'events', entries: log }])
  })

  it('hides text deltas that duplicate a reasoning part', () => {
    const log = [
      { kind: 'event' as const, event: { type: 'text', part: { id: 'prt_reason', text: 'Private chain' } } },
      { kind: 'event' as const, event: { type: 'reasoning', part: { id: 'prt_reason', text: 'Private chain' } } },
      { kind: 'event' as const, event: { type: 'text', part: { id: 'prt_answer', text: 'Visible answer' } } },
    ]

    expect(eventDisplayChunks(log, false)).toEqual([{ kind: 'text', text: 'Visible answer' }])
    expect(eventDisplayChunks(log, true)).toEqual([
      { kind: 'events', entries: [log[1]] },
      { kind: 'text', text: 'Visible answer' },
    ])
  })

  it('does not render tool payload text as an error just because it mentions errors', () => {
    const log = [
      {
        kind: 'event' as const,
        event: {
          type: 'tool',
          part: {
            tool: 'skill',
            content: '<skill_content name="roomy-cli-task-schedule">failure modes and error handling</skill_content>',
          },
        },
      },
    ]

    expect(eventDisplayChunks(log, true)).toEqual([{ kind: 'events', entries: log }])
  })

  it('renders post-event unparsed stdout as neutral diagnostics in developer mode', () => {
    const log = [
      { kind: 'event' as const, event: { type: 'tool', part: { tool: 'skill' } } },
      { kind: 'unparsed' as const, line: '<skill_content name="roomy-goal-app">reference text</skill_content>' },
    ]

    expect(eventDisplayChunks(log, true)).toEqual([
      { kind: 'events', entries: [log[0]] },
      { kind: 'diagnostic', lines: [log[1].line] },
    ])
  })

  it('renders structured tool stderr payloads as neutral diagnostics in developer mode', () => {
    const log = [
      { kind: 'stderr' as const, line: '<path>/home/agent/.config/pi/skills/roomy-goal-app/SKILL.md</path> <type>file</type> <content>error handling notes</content>' },
    ]

    expect(eventDisplayChunks(log, true)).toEqual([
      { kind: 'diagnostic', lines: [log[0].line] },
    ])
  })

  it('renders escaped structured tool stderr payloads as neutral diagnostics in developer mode', () => {
    const log = [
      { kind: 'stderr' as const, line: '&lt;skill_content name="roomy-goal-app"&gt;failure modes and error handling&lt;/skill_content&gt;' },
    ]

    expect(eventDisplayChunks(log, true)).toEqual([
      { kind: 'diagnostic', lines: [log[0].line] },
    ])
  })

  it('renders non-error stderr as neutral diagnostics in developer mode', () => {
    const log = [
      { kind: 'stderr' as const, line: 'debug noise' },
    ]

    expect(eventDisplayChunks(log, true)).toEqual([
      { kind: 'diagnostic', lines: [log[0].line] },
    ])
  })
})
