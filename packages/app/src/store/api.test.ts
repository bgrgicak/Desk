import { configureStore } from '@reduxjs/toolkit'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { api, buildChatMessagesQuery, buildMessagesQuery, shouldForceRefetchChatMessages } from './api'
import type { ServerFile } from './types'

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

describe('postChatMessage cache activity', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('pushes the chat to the top of the cached sidebar list after sending even when the echoed message timestamp is older', async () => {
    const store = configureStore({
      reducer: { [api.reducerPath]: api.reducer },
      middleware: (getDefault) => getDefault().concat(api.middleware),
    })

    await store.dispatch(api.util.upsertQueryData('getChats', { workspaceId: 'wks_1' }, [
      {
        id: 'cht_buried', workspaceId: 'wks_1', agentId: 'agt_1', title: 'Buried',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z', unread: false,
        kind: 'chat', running: false, failed: false,
      },
      {
        id: 'cht_top', workspaceId: 'wks_1', agentId: 'agt_1', title: 'Top',
        createdAt: '2099-01-01T00:00:00.000Z',
        updatedAt: '2099-01-01T00:00:00.000Z', unread: false,
        kind: 'chat', running: false, failed: false,
      },
    ]))

    const NativeRequest = globalThis.Request
    class AbsoluteRequest extends NativeRequest {
      constructor(input: RequestInfo | URL, init?: RequestInit) {
        super(typeof input === 'string' && input.startsWith('/') ? `http://localhost${input}` : input, init)
      }
    }
    vi.stubGlobal('Request', AbsoluteRequest)

    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      id: 'msg_1',
      chatId: 'cht_buried',
      role: 'user',
      content: { type: 'text', text: 'hello' },
      createdAt: '2026-01-01T00:05:00.000Z',
      kind: 'chat',
    }), { status: 201, headers: { 'Content-Type': 'application/json' } }))

    await store.dispatch(api.endpoints.postChatMessage.initiate({ chatId: 'cht_buried', content: 'hello' }))

    const entry = api.endpoints.getChats.select({ workspaceId: 'wks_1' })(store.getState())
    expect(entry.data?.map((chat) => chat.id)).toEqual(['cht_buried', 'cht_top'])
    expect(Date.parse(entry.data?.[0]?.updatedAt ?? '')).toBeGreaterThan(Date.parse('2099-01-01T00:00:00.000Z'))
  })
})

describe('deleteChatAttachment optimistic removal', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  const file = (name: string): ServerFile => ({
    path: `.chats/cht_1/attachments/${name}`,
    name,
    mime: 'text/plain',
    size: 10,
    createdAt: '2026-01-01T00:00:00.000Z',
    kind: 'attachment',
  })

  function makeStore() {
    return configureStore({
      reducer: { [api.reducerPath]: api.reducer },
      middleware: (getDefault) => getDefault().concat(api.middleware),
    })
  }

  function stubAbsoluteRequest() {
    const NativeRequest = globalThis.Request
    class AbsoluteRequest extends NativeRequest {
      constructor(input: RequestInfo | URL, init?: RequestInit) {
        super(typeof input === 'string' && input.startsWith('/') ? `http://localhost${input}` : input, init)
      }
    }
    vi.stubGlobal('Request', AbsoluteRequest)
  }

  const cachedNames = (store: ReturnType<typeof makeStore>) =>
    api.endpoints.getChatArtifacts
      .select({ chatId: 'cht_1', includeArtifacts: true })(store.getState())
      .data?.map((f) => f.name)
      .sort()

  it('drops the file from the cached Files list immediately on delete', async () => {
    const store = makeStore()
    await store.dispatch(api.util.upsertQueryData('getChatArtifacts', { chatId: 'cht_1', includeArtifacts: true }, [file('keep.txt'), file('remove.txt')]))
    stubAbsoluteRequest()
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } }))

    // The optimistic patch in onQueryStarted runs synchronously as the
    // mutation dispatches — assert before awaiting (the unsubscribed
    // cache entry is dropped by the post-success tag invalidation).
    const promise = store.dispatch(api.endpoints.deleteChatAttachment.initiate({ chatId: 'cht_1', name: 'remove.txt' }))
    expect(cachedNames(store)).toEqual(['keep.txt'])
    await promise
  })

  it('restores the file when the server rejects the delete', async () => {
    const store = makeStore()
    stubAbsoluteRequest()
    // Hold an active subscription so the cache entry survives the
    // mutation lifecycle; the GET returns the seeded list, the DELETE 500s.
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      if ((input as Request).method === 'DELETE') return new Response('nope', { status: 500 })
      return new Response(JSON.stringify([file('keep.txt'), file('remove.txt')]), { status: 200, headers: { 'Content-Type': 'application/json' } })
    })
    const sub = store.dispatch(api.endpoints.getChatArtifacts.initiate({ chatId: 'cht_1', includeArtifacts: true }))
    await sub
    expect(cachedNames(store)).toEqual(['keep.txt', 'remove.txt'])

    const promise = store.dispatch(api.endpoints.deleteChatAttachment.initiate({ chatId: 'cht_1', name: 'remove.txt' }))
    expect(cachedNames(store)).toEqual(['keep.txt']) // optimistically removed
    await promise
    // Let onQueryStarted's rejection handler run its rollback (no
    // invalidation fires on failure, so the entry is restored, not refetched).
    await new Promise((r) => setTimeout(r, 0))
    expect(cachedNames(store)).toEqual(['keep.txt', 'remove.txt'])

    sub.unsubscribe()
  })
})
