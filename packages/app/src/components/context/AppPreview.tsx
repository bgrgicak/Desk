/**
 * Live preview for a chat-artifact app's `roomy.app.json` manifest.
 *
 * On mount the parent SPA calls `POST /apps/chat/:chatId/:appName/issue`
 * with its bearer token; the server mints a per-app session and returns
 * a bootstrap URL that includes a one-shot `?t=<token>` query param.
 * The iframe loads that URL once; the server validates the app token,
 * sets a path-scoped HttpOnly cookie, serves the HTML inline, and injects
 * a session-bound asset base URL for sandboxed subresource loads. See
 * `packages/server/api/src/routes/apps.ts`.
 */
import { useEffect, useRef, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { getSessionToken } from '@/auth/session'
import {
  bridgeError,
  bridgeResponse,
  handleAppBridgeRequest,
  isAppBridgeResize,
  isAppBridgeRequest,
} from '@/lib/app-bridge'
import { GENERATED_APP_IFRAME_SANDBOX } from "@/lib/iframe-sandbox";

interface IssuedAppSession {
  token: string
  url: string
  expiresAt: string
  cookieName: string
  bridgeKey: string
  capabilities: string[]
}

type AppPreviewProps =
  | { scope: 'chat'; chatId: string; appName: string; fragment?: string; params?: Record<string, string>; variant?: AppPreviewVariant }
  // `chatId` is optional for library scope: when a library-shaped artifact is
  // rendered inline inside a chat (e.g. a chat-forms fragment attached via a
  // workspace path), the surrounding chat id flows through so the bridge's
  // `chat.sendMessage` can resolve a target.
  | { scope: 'library'; appName: string; appPath?: string; workspaceId?: string; chatId?: string; fragment?: string; params?: Record<string, string>; variant?: AppPreviewVariant }
  | { scope: 'global'; chatId: string; appName: string; fragment?: string; params?: Record<string, string>; variant?: AppPreviewVariant }

export type AppPreviewVariant = 'detail' | 'inline'

function appBasePathFromSessionUrl(rawUrl: string): string {
  const url = new URL(rawUrl, window.location.origin)
  const distIndex = url.pathname.indexOf('/dist')
  return distIndex === -1 ? url.pathname.replace(/\/$/, '') : url.pathname.slice(0, distIndex)
}

async function issueAppSession(props: AppPreviewProps): Promise<IssuedAppSession> {
  const token = getSessionToken()
  if (!token) throw new Error('Not signed in')
  let url: string
  if (props.scope === 'chat') {
    url = `/api/apps/chat/${encodeURIComponent(props.chatId)}/${encodeURIComponent(props.appName)}/issue`
  } else if (props.scope === 'global') {
    url = `/api/apps/global/${encodeURIComponent(props.chatId)}/${encodeURIComponent(props.appName)}/issue`
  } else {
    const params = new URLSearchParams()
    if (props.workspaceId) params.set('workspaceId', props.workspaceId)
    if (props.appPath) params.set('path', props.appPath)
    const qs = params.toString()
    url = `/api/apps/library/${encodeURIComponent(props.appName)}/issue${qs ? `?${qs}` : ''}`
  }
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    credentials: 'include',
  })
  if (!res.ok) {
    const body = await res.text()
    throw new Error(`Issue failed (${res.status}): ${body}`)
  }
  const issued = (await res.json()) as IssuedAppSession
  if (props.fragment) {
    const u = new URL(issued.url, window.location.origin)
    const tokenParam = u.searchParams.get('t') ?? ''
    const distRoot = u.pathname.replace(/\/?$/, '/')
    u.pathname = `${distRoot}fragments/${encodeURIComponent(props.fragment)}/`
    u.searchParams.set('t', tokenParam)
    if (props.params) {
      for (const [key, value] of Object.entries(props.params)) {
        if (key !== 't') u.searchParams.set(key, value)
      }
    }
    issued.url = `${u.pathname}${u.search}`
  }
  return issued
}

export function AppPreview(props: AppPreviewProps) {
  const { appName } = props
  const variant: AppPreviewVariant = props.variant ?? 'detail'
  const initialHeight = variant === 'inline' ? 240 : 640
  const appPath = props.scope === 'library' ? props.appPath : undefined
  const workspaceId = props.scope === 'library' ? props.workspaceId : undefined
  const chatId =
    props.scope === 'chat' || props.scope === 'global'
      ? props.chatId
      : props.chatId ?? null
  const fragment = props.fragment ?? null
  const paramsKey = props.params ? JSON.stringify(props.params) : ''
  const [session, setSession] = useState<IssuedAppSession | null>(null)
  const [error, setError] = useState<string | null>(null)
  // Counter that the error-state Retry button increments to force a fresh
  // `issueAppSession` round-trip without remounting the component.
  const [retryToken, setRetryToken] = useState(0)
  const [frameHeight, setFrameHeight] = useState(initialHeight)
  const iframeRef = useRef<HTMLIFrameElement | null>(null)
  // Inline iframes match content exactly — the wrapper around them
  // (`InlineArtifactPreview`) has its own `max-h-[60vh] overflow-y-auto`
  // that provides the scrollable cap. Capping the iframe here would
  // create empty space whenever content is shorter than the cap (because
  // the iframe would render at the cap, not the content). The detail
  // panel still caps at 85% of viewport so a runaway fragment can't push
  // the page chrome off-screen.
  const getMaxFrameHeight = () =>
    variant === 'inline'
      ? Number.POSITIVE_INFINITY
      : Math.floor(window.innerHeight * 0.85)

  useEffect(() => {
    let cancelled = false
    setSession(null)
    setError(null)
    issueAppSession(props)
      .then((s) => {
        if (!cancelled) setSession(s)
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err))
      })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.scope, chatId, appName, appPath, workspaceId, fragment, paramsKey, retryToken])

  useEffect(() => {
    setFrameHeight(initialHeight)
  }, [initialHeight])

  useEffect(() => {
    const onResize = () => {
      setFrameHeight((height) => Math.min(height, getMaxFrameHeight()))
    }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [variant])

  useEffect(() => {
    if (!session) return
    const onMessage = (event: MessageEvent) => {
      const iframeWindow = iframeRef.current?.contentWindow
      if (!iframeWindow || event.source !== iframeWindow) return
      if (isAppBridgeResize(event.data)) {
        if (event.data.key !== session.bridgeKey) return
        const nextHeight = Math.ceil(event.data.height)
        if (nextHeight <= 0) return
        setFrameHeight(Math.min(nextHeight, getMaxFrameHeight()))
        return
      }
      if (!isAppBridgeRequest(event.data)) return
      if (event.data.key !== session.bridgeKey) return

      void handleAppBridgeRequest(
        {
          scope: props.scope,
          chatId: chatId ?? '',
          appName,
          appBasePath: appBasePathFromSessionUrl(session.url),
          capabilities: session.capabilities,
        },
        event.data,
      )
        .then((result) => {
          iframeWindow.postMessage(bridgeResponse(event.data.id, result), '*')
        })
        .catch((err) => {
          iframeWindow.postMessage(bridgeError(event.data.id, err), '*')
        })
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [props.scope, chatId, appName, session, variant])

  const iframe = session ? (
    <iframe
      key={session.token}
      ref={iframeRef}
      title={appName}
      src={session.url}
      sandbox={GENERATED_APP_IFRAME_SANDBOX}
      className="block w-full border-0"
      style={{ height: frameHeight }}
    />
  ) : error ? (
    <div className="flex flex-col items-center justify-center gap-2 px-4 text-center" style={{ height: frameHeight }}>
      <p className="text-sm text-destructive">Failed to load app: {error}</p>
      <button
        type="button"
        onClick={() => setRetryToken((n) => n + 1)}
        className="text-xs text-muted-foreground underline hover:text-foreground"
      >
        Retry
      </button>
    </div>
  ) : (
    <div className="flex items-center justify-center text-muted-foreground" style={{ height: frameHeight }}>
      <Loader2 className="h-4 w-4 animate-spin mr-2" />
      <span className="text-sm">Issuing app session…</span>
    </div>
  );

  if (variant === 'inline') {
    return <div className="w-full min-w-0 bg-background">{iframe}</div>
  }

  return (
    <div className="flex flex-col bg-background">
      {iframe}
    </div>
  )
}

/**
 * Parses a workspace-relative path that targets a chat-artifact app and
 * extracts its `chatId` + `appName`.
 */
export function parseChatAppManifestPath(
  p: string,
): { chatId: string; appName: string } | null {
  const m = /^\.chats\/([^/]+)\/artifacts\/([a-z][a-z0-9-]{0,62})\.app\/roomy\.app\.json$/.exec(p)
  if (!m) return null
  return { chatId: m[1], appName: m[2] }
}

/**
 * Parses a workspace-relative path of the form `<name>.app/roomy.app.json`
 * (a library app's manifest). Returns null when the path doesn't match.
 * `subpath/<name>.app/...` library apps under a subfolder also match —
 * the appName is the basename of the directory chain's leaf.
 */
export function parseLibraryAppManifestPath(p: string): { appName: string } | null {
  const m = /(?:^|\/)([a-z][a-z0-9-]{0,62})\.app\/roomy\.app\.json$/.exec(p)
  if (!m) return null
  // Reject the chat-artifact form so callers can pick the right scope
  // unambiguously.
  if (p.startsWith('.chats/')) return null
  return { appName: m[1] }
}

function libraryAppPathFromManifestPath(p: string): string {
  return p.slice(0, -'/roomy.app.json'.length)
}

/**
 * Parses a workspace-relative path that points at a `<name>.app/`
 * directory itself (no `roomy.app.json` suffix). Used when the user
 * clicks the directory entry in the library list — ContextDetail then
 * resolves `<dir>/roomy.app.json` for the manifest.
 */
export function parseLibraryAppDirPath(p: string): { appName: string } | null {
  const m = /(?:^|\/)([a-z][a-z0-9-]{0,62})\.app$/.exec(p)
  if (!m) return null
  if (p.startsWith('.chats/')) return null
  return { appName: m[1] }
}

export function parseChatAppDirPath(
  p: string,
): { chatId: string; appName: string } | null {
  const m = /^\.chats\/([^/]+)\/artifacts\/([a-z][a-z0-9-]{0,62})\.app$/.exec(p)
  if (!m) return null
  return { chatId: m[1], appName: m[2] }
}

export function parseChatAppFragmentPath(
  p: string,
): { chatId: string; appName: string; fragment: string } | null {
  const m =
    /^\.chats\/([^/]+)\/artifacts\/([a-z][a-z0-9-]{0,62})\.app\/dist\/fragments\/([a-z][a-z0-9-]{0,62})(?:\/(?:index\.html)?)?$/.exec(
      p,
    )
  if (!m) return null
  return { chatId: m[1], appName: m[2], fragment: m[3] }
}

/**
 * Built-in apps are attached with their in-sandbox path
 * `/opt/roomy-apps/<name>.app/dist/...` (mirrors `APPS_SANDBOX_MOUNT_DIR`
 * in @roomy-ai/runtime). This parser recognizes those paths so the
 * chat UI can render them via the global app scope.
 */
export function parseGlobalAppPath(
  p: string,
): { appName: string; fragment?: string } | null {
  const fragmentMatch =
    /^\/opt\/roomy-apps\/([a-z][a-z0-9-]{0,62})\.app\/dist\/fragments\/([a-z][a-z0-9-]{0,62})(?:\/(?:index\.html)?)?$/.exec(
      p,
    )
  if (fragmentMatch) return { appName: fragmentMatch[1], fragment: fragmentMatch[2] }
  const appMatch = /^\/opt\/roomy-apps\/([a-z][a-z0-9-]{0,62})\.app(?:\/dist(?:\/(?:index\.html)?)?)?$/.exec(p)
  if (appMatch) return { appName: appMatch[1] }
  return null
}

export function parseLibraryAppFragmentPath(
  p: string,
): { appName: string; appPath: string; fragment: string } | null {
  if (p.startsWith('.chats/')) return null
  const m =
    /(?:^|\/)([a-z][a-z0-9-]{0,62})\.app\/dist\/fragments\/([a-z][a-z0-9-]{0,62})(?:\/(?:index\.html)?)?$/.exec(
      p,
    )
  if (!m) return null
  const marker = `${m[1]}.app/dist/fragments/`
  const markerIndex = p.indexOf(marker)
  return { appName: m[1], appPath: p.slice(0, markerIndex + `${m[1]}.app`.length), fragment: m[2] }
}

export function appAttachmentToPreview(
  path: string,
):
  | { scope: 'chat'; chatId: string; appName: string; fragment?: string }
  | { scope: 'library'; appName: string; appPath?: string; fragment?: string }
  | { scope: 'global'; appName: string; fragment?: string }
  | null {
  // Global scope is checked first: built-in app paths under
  // `/opt/roomy-apps/<name>.app/...` would otherwise match the (looser)
  // library parser, which accepts any `<name>.app/...` form.
  const globalApp = parseGlobalAppPath(path)
  if (globalApp) {
    return globalApp.fragment
      ? { scope: 'global', appName: globalApp.appName, fragment: globalApp.fragment }
      : { scope: 'global', appName: globalApp.appName }
  }
  const chatFragment = parseChatAppFragmentPath(path)
  if (chatFragment) {
    return {
      scope: 'chat',
      chatId: chatFragment.chatId,
      appName: chatFragment.appName,
      fragment: chatFragment.fragment,
    }
  }
  const libraryFragment = parseLibraryAppFragmentPath(path)
  if (libraryFragment) return { scope: 'library', ...libraryFragment }
  const chatDir = parseChatAppDirPath(path)
  if (chatDir) return { scope: 'chat', chatId: chatDir.chatId, appName: chatDir.appName }
  const chatManifest = parseChatAppManifestPath(path)
  if (chatManifest) return { scope: 'chat', chatId: chatManifest.chatId, appName: chatManifest.appName }
  const libraryDir = parseLibraryAppDirPath(path)
  if (libraryDir) return { scope: 'library', appName: libraryDir.appName, appPath: path }
  const libraryManifest = parseLibraryAppManifestPath(path)
  if (libraryManifest) return { scope: 'library', appName: libraryManifest.appName, appPath: libraryAppPathFromManifestPath(path) }
  return null
}
