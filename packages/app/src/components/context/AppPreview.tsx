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

interface AppPreviewProps {
  chatId: string
  appName: string
}

async function issueAppSession(
  chatId: string,
  appName: string,
): Promise<IssuedAppSession> {
  const token = getSessionToken()
  if (!token) throw new Error('Not signed in')
  const res = await fetch(
    `/api/apps/chat/${encodeURIComponent(chatId)}/${encodeURIComponent(appName)}/issue`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      credentials: 'include',
    },
  )
  if (!res.ok) {
    const body = await res.text()
    throw new Error(`Issue failed (${res.status}): ${body}`)
  }
  return (await res.json()) as IssuedAppSession
}

export function AppPreview({ chatId, appName }: AppPreviewProps) {
  const [session, setSession] = useState<IssuedAppSession | null>(null)
  const [error, setError] = useState<string | null>(null)
  const iframeRef = useRef<HTMLIFrameElement | null>(null)

  useEffect(() => {
    let cancelled = false
    setSession(null)
    setError(null)
    issueAppSession(chatId, appName)
      .then((s) => {
        if (!cancelled) setSession(s)
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err))
      })
    return () => {
      cancelled = true
    }
  }, [chatId, appName])

  useEffect(() => {
    if (!session) return
    const onMessage = (event: MessageEvent) => {
      const iframeWindow = iframeRef.current?.contentWindow
      if (!iframeWindow || event.source !== iframeWindow) return
      if (!isAppBridgeRequest(event.data)) return
      if (event.data.key !== session.bridgeKey) return

      void handleAppBridgeRequest(
        { chatId, appName, capabilities: session.capabilities },
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

  return (
    <div className="flex flex-col bg-white" style={{ height: '100vh' }}>
      {session ? (
        <iframe
          key={session.token}
          ref={iframeRef}
          title={appName}
          src={session.url}
          sandbox="allow-scripts"
          className="w-full border-0"
          style={{ height: '100vh' }}
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
      )}
    </div>
  )
}

/**
 * Parses a workspace-relative path that targets a chat-artifact app and
 * extracts its `chatId` + `appName`. Accepts both the `.app/` directory
 * path (how the library identifies the artifact) and the manifest file
 * path (how the chat surfaces the JSON inside it). Returns null when
 * the path doesn't reference a chat-artifact app.
 */
export function parseChatAppManifestPath(
  p: string,
): { chatId: string; appName: string } | null {
  const m = /^\.chats\/([^/]+)\/artifacts\/([a-z][a-z0-9-]{0,62})\.app(?:\/desk\.app\.json)?$/.exec(p)
  if (!m) return null
  return { chatId: m[1], appName: m[2] }
}
