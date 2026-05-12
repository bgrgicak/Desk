import { describe, expect, it } from 'vitest'
import { buildChatMessagesQuery, buildMessagesQuery, shouldForceRefetchChatMessages } from './api'

describe('message query builders', () => {
  it('requests full chat payloads when developer mode is enabled', () => {
    expect(buildChatMessagesQuery({ chatId: 'cht_test', full: true })).toBe('/chats/cht_test/messages?view=full')
  })

  it('requests timeline chat payloads for regular mode', () => {
    expect(buildChatMessagesQuery({ chatId: 'cht_test', full: false })).toBe('/chats/cht_test/messages?view=timeline')
  })

  it('requests full cross-chat payloads when the full flag is enabled', () => {
    expect(buildMessagesQuery({ chatId: 'cht_test', full: true })).toBe('/messages?view=full&chatId=cht_test')
  })

  it('requests compact cross-chat payloads by default', () => {
    expect(buildMessagesQuery({ chatId: 'cht_test' })).toBe('/messages?view=compact&chatId=cht_test')
  })

  it('does not refetch chat messages just because equivalent args are recreated', () => {
    expect(shouldForceRefetchChatMessages(
      { chatId: 'cht_test', full: true },
      { chatId: 'cht_test', full: true },
    )).toBe(false)
    expect(shouldForceRefetchChatMessages(
      { chatId: 'cht_test', full: true },
      { chatId: 'cht_test', full: false },
    )).toBe(true)
  })
})
