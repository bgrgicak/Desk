export const APP_BRIDGE_REQUEST = 'desk.app.request'
export const APP_BRIDGE_RESPONSE = 'desk.app.response'

export type AppBridgeMethod =
  | 'storage.list'
  | 'storage.get'
  | 'storage.create'
  | 'storage.put'
  | 'storage.delete'

export interface AppBridgeRequest {
  type: typeof APP_BRIDGE_REQUEST
  id: string
  key?: string
  method: AppBridgeMethod
  params?: unknown
}

export interface AppBridgeResponse {
  type: typeof APP_BRIDGE_RESPONSE
  id: string
  ok: boolean
  result?: unknown
  error?: string
}

export interface ChatAppBridgeContext {
  scope: 'chat' | 'library'
  chatId: string
  appName: string
  appBasePath?: string
  capabilities: string[]
}

const STORAGE_COLLECTION_PATTERN = /^[a-z][a-z0-9_-]{0,62}$/
const STORAGE_DOC_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/

export function isAppBridgeRequest(value: unknown): value is AppBridgeRequest {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<AppBridgeRequest>
  return (
    candidate.type === APP_BRIDGE_REQUEST &&
    typeof candidate.id === 'string' &&
    candidate.id.length > 0 &&
    typeof candidate.method === 'string' &&
    isKnownMethod(candidate.method)
  )
}

export async function handleAppBridgeRequest(
  ctx: ChatAppBridgeContext,
  request: AppBridgeRequest,
): Promise<unknown> {
  switch (request.method) {
    case 'storage.list':
      requireCapability(ctx, 'storage.read')
      return appFetch(storageUrl(ctx, request.params, false), { method: 'GET' })
    case 'storage.get':
      requireCapability(ctx, 'storage.read')
      return appFetch(storageUrl(ctx, request.params, true), { method: 'GET' })
    case 'storage.create':
      requireCapability(ctx, 'storage.write')
      return appFetch(storageUrl(ctx, request.params, false), {
        method: 'POST',
        body: storageBody(request.params),
      })
    case 'storage.put':
      requireCapability(ctx, 'storage.write')
      return appFetch(storageUrl(ctx, request.params, true), {
        method: 'PUT',
        body: storageBody(request.params),
      })
    case 'storage.delete':
      requireCapability(ctx, 'storage.write')
      await appFetch(storageUrl(ctx, request.params, true), { method: 'DELETE' })
      return null
  }
}

export function bridgeResponse(id: string, result: unknown): AppBridgeResponse {
  return { type: APP_BRIDGE_RESPONSE, id, ok: true, result }
}

export function bridgeError(id: string, error: unknown): AppBridgeResponse {
  return {
    type: APP_BRIDGE_RESPONSE,
    id,
    ok: false,
    error: error instanceof Error ? error.message : String(error),
  }
}

function isKnownMethod(method: string): method is AppBridgeMethod {
  return method === 'storage.list' ||
    method === 'storage.get' ||
    method === 'storage.create' ||
    method === 'storage.put' ||
    method === 'storage.delete'
}

function requireCapability(ctx: ChatAppBridgeContext, cap: 'storage.read' | 'storage.write'): void {
  if (!ctx.capabilities.includes(cap)) {
    throw new Error(`Missing app capability: ${cap}`)
  }
}

function storageUrl(
  ctx: ChatAppBridgeContext,
  params: unknown,
  requireDocId: boolean,
): string {
  const input = paramsObject(params)
  const collection = stringParam(input, 'collection', STORAGE_COLLECTION_PATTERN)
  const appPath = ctx.appBasePath ?? (ctx.scope === 'chat'
    ? `/apps/chat/${encodeURIComponent(ctx.chatId)}/${encodeURIComponent(ctx.appName)}`
    : `/apps/library/${encodeURIComponent(ctx.appName)}`)
  const base = `${appPath}/storage/${encodeURIComponent(collection)}`
  if (!requireDocId) return base
  const id = stringParam(input, 'id', STORAGE_DOC_ID_PATTERN)
  return `${base}/${encodeURIComponent(id)}`
}

function storageBody(params: unknown): BodyInit {
  const input = paramsObject(params)
  if (!Object.prototype.hasOwnProperty.call(input, 'doc')) {
    throw new Error('Missing storage doc')
  }
  return JSON.stringify(input.doc)
}

function paramsObject(params: unknown): Record<string, unknown> {
  if (!params || typeof params !== 'object' || Array.isArray(params)) {
    throw new Error('Invalid app bridge params')
  }
  return params as Record<string, unknown>
}

function stringParam(
  params: Record<string, unknown>,
  key: string,
  pattern: RegExp,
): string {
  const value = params[key]
  if (typeof value !== 'string' || !pattern.test(value)) {
    throw new Error(`Invalid storage ${key}`)
  }
  return value
}

async function appFetch(url: string, init: RequestInit): Promise<unknown> {
  const headers = new Headers(init.headers)
  if (init.body !== undefined) headers.set('Content-Type', 'application/json')
  const res = await fetch(url, {
    ...init,
    headers,
    credentials: 'include',
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(body || `App bridge request failed (${res.status})`)
  }
  if (res.status === 204) return null
  const text = await res.text()
  if (!text) return null
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}
