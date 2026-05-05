/**
 * Live preview for a chat-artifact app's `desk.app.json` manifest.
 *
 * On mount the parent SPA calls `POST /apps/chat/:chatId/:appName/issue`
 * with its bearer token; the server mints a per-app session and returns
 * a bootstrap URL that includes a one-shot `?t=<token>` query param.
 * The iframe loads that URL once; the server consumes the query token,
 * sets a path-scoped HttpOnly cookie, and 302-redirects to the clean
 * `dist/` URL so subsequent asset requests carry the cookie. See
 * `packages/server/api/src/routes/apps.ts`.
 */
import { useEffect, useRef, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { getSessionToken } from '@/auth/session'
import {
  bridgeError,
  bridgeResponse,
  handleAppBridgeRequest,
  isAppBridgeRequest,
} from '@/lib/app-bridge'

interface IssuedAppSession {
  token: string
  url: string
  expiresAt: string
  cookieName: string
  bridgeKey: string
  capabilities: string[]
}

type AppPreviewProps =
  | { scope: 'chat'; chatId: string; appName: string; fragment?: string; variant?: AppPreviewVariant }
  | { scope: 'library'; appName: string; fragment?: string; variant?: AppPreviewVariant }

export type AppPreviewVariant = 'detail' | 'inline'

async function issueAppSession(props: AppPreviewProps): Promise<IssuedAppSession> {
  const token = getSessionToken()
  if (!token) throw new Error('Not signed in')
  const url =
    props.scope === 'chat'
      ? `/api/apps/chat/${encodeURIComponent(props.chatId)}/${encodeURIComponent(props.appName)}/issue`
      : `/api/apps/library/${encodeURIComponent(props.appName)}/issue`
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
    issued.url = `${u.pathname}${u.search}`
  }
  return issued
}

export function AppPreview(props: AppPreviewProps) {
  const { appName } = props
  const variant: AppPreviewVariant = props.variant ?? 'detail'
  const chatId = props.scope === 'chat' ? props.chatId : null
  const fragment = props.fragment ?? null
  const [session, setSession] = useState<IssuedAppSession | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [reloadKey, setReloadKey] = useState(0)
  const iframeRef = useRef<HTMLIFrameElement | null>(null)

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
  }, [props.scope, chatId, appName, fragment, reloadKey])

  useEffect(() => {
    if (!session) return
    const onMessage = (event: MessageEvent) => {
      const iframeWindow = iframeRef.current?.contentWindow
      if (!iframeWindow || event.source !== iframeWindow) return
      if (!isAppBridgeRequest(event.data)) return
      if (event.data.key !== session.bridgeKey) return

      void handleAppBridgeRequest(
        { chatId: chatId ?? '', appName, capabilities: session.capabilities },
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
  }, [chatId, appName, session])

  const iframe = session ? (
        <iframe
          key={session.token}
          ref={iframeRef}
          title={appName}
          src={session.url}
          sandbox="allow-scripts"
          className="h-full min-h-0 w-full flex-1 border-0"
        />
      ) : error ? (
        <div className="h-full flex items-center justify-center px-4">
          <p className="text-sm text-destructive">Failed to load app: {error}</p>
        </div>
      ) : (
        <div className="h-full flex items-center justify-center text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin mr-2" />
          <span className="text-sm">Issuing app session…</span>
        </div>
      )

  if (variant === 'inline') {
    return (
      <div className="max-w-[480px] overflow-hidden rounded-lg border bg-background">
        <div className="flex items-center justify-between gap-2 border-b px-3 py-2 text-xs">
          <span className="truncate font-medium">{fragment ? `${appName}/${fragment}` : appName}</span>
          <button
            type="button"
            onClick={() => setReloadKey((k) => k + 1)}
            className="text-muted-foreground hover:text-foreground"
          >
            Reload
          </button>
        </div>
        <div className="bg-white" style={{ height: 280 }}>{iframe}</div>
      </div>
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-white">
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
  const m = /^\.chats\/([^/]+)\/artifacts\/([a-z][a-z0-9-]{0,62})\.app\/desk\.app\.json$/.exec(p)
  if (!m) return null
  return { chatId: m[1], appName: m[2] }
}

/**
 * Parses a workspace-relative path of the form `<name>.app/desk.app.json`
 * (a library app's manifest). Returns null when the path doesn't match.
 * `subpath/<name>.app/...` library apps under a subfolder also match —
 * the appName is the basename of the directory chain's leaf.
 */
export function parseLibraryAppManifestPath(p: string): { appName: string } | null {
  const m = /(?:^|\/)([a-z][a-z0-9-]{0,62})\.app\/desk\.app\.json$/.exec(p)
  if (!m) return null
  // Reject the chat-artifact form so callers can pick the right scope
  // unambiguously.
  if (p.startsWith('.chats/')) return null
  return { appName: m[1] }
}

/**
 * Parses a workspace-relative path that points at a `<name>.app/`
 * directory itself (no `desk.app.json` suffix). Used when the user
 * clicks the directory entry in the library list — ContextDetail then
 * resolves `<dir>/desk.app.json` for the manifest.
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

export function parseLibraryAppFragmentPath(
  p: string,
): { appName: string; fragment: string } | null {
  if (p.startsWith('.chats/')) return null
  const m =
    /(?:^|\/)([a-z][a-z0-9-]{0,62})\.app\/dist\/fragments\/([a-z][a-z0-9-]{0,62})(?:\/(?:index\.html)?)?$/.exec(
      p,
    )
  if (!m) return null
  return { appName: m[1], fragment: m[2] }
}

export function appAttachmentToPreview(
  path: string,
):
  | { scope: 'chat'; chatId: string; appName: string; fragment?: string }
  | { scope: 'library'; appName: string; fragment?: string }
  | null {
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
  if (libraryDir) return { scope: 'library', appName: libraryDir.appName }
  const libraryManifest = parseLibraryAppManifestPath(path)
  if (libraryManifest) return { scope: 'library', appName: libraryManifest.appName }
  return null
}
