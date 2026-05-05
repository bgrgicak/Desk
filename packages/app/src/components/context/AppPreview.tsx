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
import { useEffect, useMemo, useRef, useState } from 'react'
import { Check, Loader2, RotateCw } from 'lucide-react'
import { Button } from '@agent-desk/ui'
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

interface AppManifest {
  name: string
  displayName?: string
  description?: string
  capabilities?: string[]
}

async function issueAppSession(
  chatId: string,
  appName: string,
): Promise<IssuedAppSession> {
  const token = getSessionToken()
  if (!token) throw new Error('Not signed in')
  const res = await fetch(
    `/apps/chat/${encodeURIComponent(chatId)}/${encodeURIComponent(appName)}/issue`,
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
  const [reloadKey, setReloadKey] = useState(0)
  const [manifest, setManifest] = useState<AppManifest | null>(null)
  const iframeRef = useRef<HTMLIFrameElement | null>(null)

  // Issue (or re-issue) a session whenever the iframe needs to (re)load.
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
  }, [chatId, appName, reloadKey])

  // Load the manifest for the capability checklist (independent of the
  // iframe — the manifest is also useful to display when the iframe
  // hasn't yet loaded).
  useEffect(() => {
    let cancelled = false
    const token = getSessionToken()
    if (!token) return
    const path = `.chats/${chatId}/artifacts/${appName}.app/desk.app.json`
    fetch(`/api/library/content?path=${encodeURIComponent(path)}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then(async (res) => {
        if (!res.ok) return null
        const text = await res.text()
        try {
          return JSON.parse(text) as AppManifest
        } catch {
          return null
        }
      })
      .then((m) => {
        if (!cancelled) setManifest(m)
      })
      .catch(() => {
        if (!cancelled) setManifest(null)
      })
    return () => {
      cancelled = true
    }
  }, [chatId, appName, reloadKey])

  const capabilities = useMemo(() => {
    return manifest?.capabilities ?? session?.capabilities ?? []
  }, [manifest, session])

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
    <div className="flex-1 flex flex-col min-h-0">
      <div className="border-b px-4 py-2 flex items-center justify-between gap-2 text-xs text-muted-foreground">
        <span className="font-medium">
          {manifest?.displayName ?? manifest?.name ?? appName}
        </span>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setReloadKey((k) => k + 1)}
          aria-label="Reload app"
          className="h-7"
        >
          <RotateCw className="h-3.5 w-3.5 mr-1.5" />
          Reload
        </Button>
      </div>

      <div className="flex-1 min-h-0 bg-white">
        {session ? (
          <iframe
            // The token is consumed once; reload re-issues. Each reload
            // gets a fresh url, so key on the token to force the iframe
            // to remount instead of navigating in place (which the
            // browser may suppress as same-document).
            key={session.token}
            ref={iframeRef}
            title={appName}
            src={session.url}
            sandbox="allow-scripts"
            className="w-full h-full border-0"
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

      <div className="border-t px-4 py-3 bg-muted/30">
        <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-2">
          Capabilities
        </p>
        {capabilities.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            This app declared no capabilities.
          </p>
        ) : (
          <ul className="space-y-1">
            {capabilities.map((cap) => (
              <li key={cap} className="flex items-center gap-2 text-sm">
                <Check className="h-3.5 w-3.5 text-muted-foreground" />
                <code className="text-xs">{cap}</code>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}

/**
 * Parses a workspace-relative path of the form
 * `.chats/<chatId>/artifacts/<name>.app/desk.app.json` and extracts the
 * `chatId` + `appName`. Returns null when the path doesn't match.
 */
export function parseChatAppManifestPath(
  p: string,
): { chatId: string; appName: string } | null {
  const m = /^\.chats\/([^/]+)\/artifacts\/([a-z][a-z0-9-]{0,62})\.app\/desk\.app\.json$/.exec(p)
  if (!m) return null
  return { chatId: m[1], appName: m[2] }
}
