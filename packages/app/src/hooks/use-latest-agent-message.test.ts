import { describe, expect, it } from 'vitest'
import { latestAgentMessageFromItems } from './use-latest-agent-message'
import type { ServerMessage } from '@/store/types'

function message(
  content: ServerMessage['content'],
  overrides: Partial<ServerMessage> = {},
): ServerMessage {
  return {
    id: overrides.id ?? 'msg_test',
    chatId: 'cht_test',
    role: 'agent',
    kind: 'chat',
    content,
    createdAt: overrides.createdAt ?? '2026-05-28T10:00:00.000Z',
    ...overrides,
  }
}

describe('latestAgentMessageFromItems', () => {
  it('returns the latest app fragment artifact ref', () => {
    const preview = latestAgentMessageFromItems([
      message({ type: 'text', text: 'older reply' }, { id: 'text' }),
      message({
        type: 'artifactRef',
        path: '/opt/roomy-apps/chat-forms.app/dist/fragments/yes-no',
        name: 'chat-forms',
        mime: 'inode/directory',
        params: { question: 'Ship today?' },
      }, { id: 'fragment', createdAt: '2026-05-28T10:01:00.000Z' }),
    ])

    expect(preview).toEqual({
      kind: 'fragment',
      createdAt: new Date('2026-05-28T10:01:00.000Z'),
      artifact: {
        path: '/opt/roomy-apps/chat-forms.app/dist/fragments/yes-no',
        name: 'chat-forms',
        mime: 'inode/directory',
        params: { question: 'Ship today?' },
      },
    })
  })

  it('does not fall back to older text when the latest visible agent output is a non-fragment artifact', () => {
    const preview = latestAgentMessageFromItems([
      message({ type: 'text', text: 'older reply' }, { id: 'text' }),
      message({
        type: 'artifactRef',
        path: '.chats/cht_test/artifacts/report.pdf',
        name: 'report.pdf',
        mime: 'application/pdf',
      }, { id: 'pdf', createdAt: '2026-05-28T10:01:00.000Z' }),
    ])

    expect(preview).toBeUndefined()
  })

  it('does not show an older fragment after the user has already replied', () => {
    const preview = latestAgentMessageFromItems([
      message({
        type: 'artifactRef',
        path: '/opt/roomy-apps/chat-forms.app/dist/fragments/yes-no',
        name: 'chat-forms',
      }, { id: 'fragment' }),
      message(
        { type: 'text', text: 'Yes' },
        { id: 'user-reply', role: 'user', createdAt: '2026-05-28T10:02:00.000Z' },
      ),
    ])

    expect(preview).toBeUndefined()
  })

  it('keeps an attached fragment actionable when the next agent event only records the attachment tool call', () => {
    const preview = latestAgentMessageFromItems([
      message({
        type: 'artifactRef',
        path: '/opt/roomy-apps/chat-forms.app/dist/fragments/multi-step',
        name: 'multi-step',
        mime: 'inode/directory',
        params: { steps: '[]' },
      }, { id: 'fragment', createdAt: '2026-05-28T10:01:00.000Z' }),
      message({
        type: 'events',
        log: [
          {
            kind: 'event',
            event: {
              type: 'tool',
              part: {
                type: 'tool',
                tool: 'bash',
                state: {
                  status: 'completed',
                  output: {
                    content: [
                      {
                        type: 'text',
                        text: '{"content":{"type":"artifactRef","path":"/opt/roomy-apps/chat-forms.app/dist/fragments/multi-step"}}',
                      },
                    ],
                  },
                },
              },
            },
          },
          {
            kind: 'event',
            event: {
              type: 'text',
              part: { text: 'Fill that in and I will narrow it down.' },
            },
          },
        ],
      }, { id: 'events', createdAt: '2026-05-28T10:02:00.000Z' }),
    ])

    expect(preview).toEqual({
      kind: 'fragment',
      createdAt: new Date('2026-05-28T10:01:00.000Z'),
      artifact: {
        path: '/opt/roomy-apps/chat-forms.app/dist/fragments/multi-step',
        name: 'multi-step',
        mime: 'inode/directory',
        params: { steps: '[]' },
      },
    })
  })

  it('does not fall back to older text when a fragment attachment event has no fragment row behind it', () => {
    const preview = latestAgentMessageFromItems([
      message({ type: 'text', text: 'older reply' }, { id: 'text' }),
      message({
        type: 'events',
        log: [
          {
            kind: 'event',
            event: {
              type: 'tool',
              part: {
                output: '/opt/roomy-apps/chat-forms.app/dist/fragments/multi-step',
              },
            },
          },
          {
            kind: 'event',
            event: {
              type: 'text',
              part: { text: 'Fill that in.' },
            },
          },
        ],
      }, { id: 'events', createdAt: '2026-05-28T10:02:00.000Z' }),
    ])

    expect(preview).toBeUndefined()
  })

  it('returns latest text when the newest visible agent output is text', () => {
    const preview = latestAgentMessageFromItems([
      message({
        type: 'artifactRef',
        path: '/opt/roomy-apps/chat-forms.app/dist/fragments/yes-no',
        name: 'chat-forms',
      }, { id: 'fragment' }),
      message({ type: 'text', text: 'Please choose.' }, { id: 'text', createdAt: '2026-05-28T10:02:00.000Z' }),
    ])

    expect(preview).toEqual({
      kind: 'text',
      text: 'Please choose.',
      createdAt: new Date('2026-05-28T10:02:00.000Z'),
    })
  })
})
