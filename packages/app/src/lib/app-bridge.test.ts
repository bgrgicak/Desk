import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  APP_BRIDGE_REQUEST,
  handleAppBridgeRequest,
  isAppBridgeRequest,
  type AppBridgeRequest,
} from './app-bridge'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('app bridge', () => {
  it('recognizes only known bridge requests', () => {
    expect(isAppBridgeRequest({
      type: APP_BRIDGE_REQUEST,
      id: '1',
      method: 'storage.list',
      params: { collection: 'todos' },
    })).toBe(true)

    expect(isAppBridgeRequest({
      type: APP_BRIDGE_REQUEST,
      id: '1',
      method: 'fetch',
    })).toBe(false)
    expect(isAppBridgeRequest({ type: APP_BRIDGE_REQUEST, method: 'storage.list' })).toBe(false)
  })

  it('rejects storage reads when the app lacks storage.read', async () => {
    await expect(handleAppBridgeRequest(
      { scope: 'chat', chatId: 'cht_1', appName: 'todo-app', capabilities: [] },
      request('storage.list', { collection: 'todos' }),
    )).rejects.toThrow('Missing app capability: storage.read')
  })

  it('routes storage calls to app-scoped endpoints with credentials', async () => {
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => (
      new Response(JSON.stringify({ ok: true }), { status: 200 })
    ))
    vi.stubGlobal('fetch', fetchMock)

    await expect(handleAppBridgeRequest(
      {
        scope: 'chat',
        chatId: 'cht_123',
        appName: 'todo-app',
        capabilities: ['storage.read', 'storage.write'],
      },
      request('storage.put', { collection: 'todos', id: 'doc_1', doc: { done: true } }),
    )).resolves.toEqual({ ok: true })

    expect(fetchMock).toHaveBeenCalledWith(
      '/apps/chat/cht_123/todo-app/storage/todos/doc_1',
      expect.objectContaining({
        method: 'PUT',
        credentials: 'include',
        body: JSON.stringify({ done: true }),
      }),
    )
    const init = fetchMock.mock.calls[0][1]
    expect(new Headers(init.headers).get('Content-Type')).toBe('application/json')
  })

  it('routes library storage calls to library-scoped endpoints', async () => {
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => (
      new Response(JSON.stringify({ items: [] }), { status: 200 })
    ))
    vi.stubGlobal('fetch', fetchMock)

    await expect(handleAppBridgeRequest(
      {
        scope: 'library',
        chatId: '',
        appName: 'todo-app',
        appBasePath: '/apps/library/wks_123/abc123/todo-app',
        capabilities: ['storage.read'],
      },
      request('storage.list', { collection: 'todos' }),
    )).resolves.toEqual([])

    expect(fetchMock).toHaveBeenCalledWith(
      '/apps/library/wks_123/abc123/todo-app/storage/todos',
      expect.objectContaining({ method: 'GET', credentials: 'include' }),
    )
  })

  it('rejects malformed storage list responses', async () => {
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => (
      new Response(JSON.stringify({ nextCursor: null }), { status: 200 })
    ))
    vi.stubGlobal('fetch', fetchMock)

    await expect(handleAppBridgeRequest(
      {
        scope: 'chat',
        chatId: 'cht_123',
        appName: 'todo-app',
        capabilities: ['storage.read'],
      },
      request('storage.list', { collection: 'todos' }),
    )).rejects.toThrow('Invalid storage list response')
  })

  it('rejects invalid storage paths before fetch', async () => {
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => new Response(null))
    vi.stubGlobal('fetch', fetchMock)

    await expect(handleAppBridgeRequest(
      { scope: 'chat', chatId: 'cht_1', appName: 'todo-app', capabilities: ['storage.read'] },
      request('storage.get', { collection: '../secrets', id: 'doc' }),
    )).rejects.toThrow('Invalid storage collection')
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

function request(method: AppBridgeRequest['method'], params: unknown): AppBridgeRequest {
  return { type: APP_BRIDGE_REQUEST, id: 'req_1', method, params }
}
