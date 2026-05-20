import { useEffect, useMemo, useRef, useState, type MouseEvent, type ReactNode } from 'react'
import { ExternalLink } from 'lucide-react'
import { Button, buttonVariants, cn } from '@agent-desk/ui'
import { isMarkdownFile, type FileKind } from '@/data/file-kind'
import { MarkdownContent } from '@/components/MarkdownContent'
import { AppPreview, appAttachmentToPreview } from '@/components/context/AppPreview'
import { useGetLibraryFileQuery } from '@/store/api'
import { fetchLibraryContent } from '@/store/library-download'
import { GENERATED_APP_IFRAME_SANDBOX } from '@/lib/iframe-sandbox'
import { previewBlobFor, previewKindFrom } from '@/lib/preview-blob'

const MAX_INLINE_PREVIEW_BYTES = 5 * 1024 * 1024
const INLINE_PREVIEW_MAX_HEIGHT_VH = 60

interface InlineArtifactPreviewProps {
  workspaceId?: string
  chatId?: string
  path: string
  name: string
  mime?: string | null
  params?: Record<string, string>
  onOpen?: () => void
  openHref?: string
  actions?: ReactNode
  fallback: ReactNode
}

type PreviewState =
  | { status: 'loading' }
  | { status: 'ready'; kind: FileKind; blobUrl?: string; text?: string }
  | { status: 'fallback' }

export function canRenderInline(kind: FileKind): boolean {
  return kind !== 'unknown'
}

export function inlineAppPreviewFor(
  path: string,
  name: string,
  mime?: string | null,
): ReturnType<typeof appAttachmentToPreview> {
  void name
  void mime
  return appAttachmentToPreview(path)
}

export function InlineArtifactPreview({ workspaceId, chatId, path, name, mime, params, onOpen, openHref, actions, fallback }: InlineArtifactPreviewProps) {
  const [state, setState] = useState<PreviewState>({ status: 'loading' })
  const [htmlHeight, setHtmlHeight] = useState(280)
  const htmlIframeRef = useRef<HTMLIFrameElement | null>(null)
  const appPreviewRef = useMemo((): Parameters<typeof AppPreview>[0] | null => {
    const base = inlineAppPreviewFor(path, name, mime)
    if (!base) return null
    if (base.scope === 'global') {
      // Global apps don't carry chatId in the path — it comes from the
      // chat we're rendering inside. Without it the iframe can't issue a
      // session, so fall back to the compact attachment row.
      if (!chatId) return null
      return {
        scope: 'global',
        chatId,
        appName: base.appName,
        ...(base.fragment ? { fragment: base.fragment } : {}),
        ...(params ? { params } : {}),
        variant: 'inline' as const,
      }
    }
    return {
      ...base,
      ...(base.scope === 'library' ? { workspaceId } : {}),
      ...(params ? { params } : {}),
      variant: 'inline' as const,
    }
  }, [path, name, mime, params, workspaceId, chatId])
  const guessedKind = appPreviewRef ? 'app' : previewKindFrom(name, path, mime)
  const shouldTryPreview = !!workspaceId && canRenderInline(guessedKind)
  const shouldFetchFile = shouldTryPreview && guessedKind !== 'app'
  const { data: fileMeta, isError: metaError } = useGetLibraryFileQuery(
    { workspaceId: workspaceId ?? '', path },
    { skip: !shouldFetchFile },
  )

  useEffect(() => {
    if (guessedKind === 'app') {
      setState(appPreviewRef ? { status: 'ready', kind: 'app' } : { status: 'fallback' })
      return
    }

    setState({ status: 'loading' })
    if (!workspaceId || !shouldTryPreview || metaError) {
      setState({ status: 'fallback' })
      return
    }
    if (!fileMeta) return
    if (fileMeta.size > MAX_INLINE_PREVIEW_BYTES) {
      setState({ status: 'fallback' })
      return
    }

    let cancelled = false
    let createdUrl: string | undefined

    void fetchLibraryContent({ workspaceId, path })
      .then(async ({ blob }) => {
        if (cancelled) return
        const effectiveMime = blob.type || fileMeta.mime || mime
        const kind = previewKindFrom(name, path, effectiveMime)
        if (!canRenderInline(kind) || kind === 'app') {
          setState({ status: 'fallback' })
          return
        }

        if (kind === 'html' || kind === 'image') {
          const previewBlob = await previewBlobFor(kind, blob, name, path, effectiveMime)
          if (cancelled) return
          createdUrl = URL.createObjectURL(previewBlob)
          setState({ status: 'ready', kind, blobUrl: createdUrl })
          return
        }

        if (kind === 'docx') {
          const mammoth = await import('mammoth/mammoth.browser')
          const arrayBuffer = await blob.arrayBuffer()
          const { value: html } = await mammoth.convertToHtml({ arrayBuffer })
          if (cancelled) return
          const htmlDoc = `<!doctype html><html><head><meta charset="utf-8"><style>body{font-family:system-ui,sans-serif;max-width:780px;margin:0 auto;padding:2.5rem 1.5rem;line-height:1.6;color:#111;background:#fff}img{max-width:100%;height:auto}table{border-collapse:collapse}td,th{border:1px solid #ddd;padding:6px 10px}</style></head><body>${html}</body></html>`
          const htmlBlob = await previewBlobFor('html', new Blob([htmlDoc], { type: 'text/html' }), name, path, 'text/html')
          if (cancelled) return
          createdUrl = URL.createObjectURL(htmlBlob)
          setState({ status: 'ready', kind, blobUrl: createdUrl })
          return
        }

        if (kind === 'pdf') {
          const pdfBlob = blob.type ? blob : new Blob([blob], { type: effectiveMime || 'application/pdf' })
          createdUrl = URL.createObjectURL(pdfBlob)
          setState({ status: 'ready', kind, blobUrl: createdUrl })
          return
        }

        if (kind === 'video' || kind === 'audio') {
          const mediaBlob = blob.type ? blob : new Blob([blob], { type: effectiveMime || (kind === 'video' ? 'video/mp4' : 'audio/mpeg') })
          createdUrl = URL.createObjectURL(mediaBlob)
          setState({ status: 'ready', kind, blobUrl: createdUrl })
          return
        }

        const text = await blob.text()
        if (!cancelled) setState({ status: 'ready', kind, text })
      })
      .catch(() => {
        if (!cancelled) setState({ status: 'fallback' })
      })

    return () => {
      cancelled = true
      if (createdUrl) URL.revokeObjectURL(createdUrl)
    }
  }, [workspaceId, path, name, mime, shouldTryPreview, metaError, fileMeta, guessedKind, appPreviewRef])

  useEffect(() => {
    if (state.status !== 'ready' || (state.kind !== 'html' && state.kind !== 'docx')) return
    setHtmlHeight(280)

    const onMessage = (event: MessageEvent) => {
      const iframeWindow = htmlIframeRef.current?.contentWindow
      if (!iframeWindow || event.source !== iframeWindow) return
      if (!event.data || typeof event.data !== 'object') return
      if ((event.data as { type?: unknown }).type !== 'desk.preview.resize') return
      const height = (event.data as { height?: unknown }).height
      if (typeof height !== 'number' || !Number.isFinite(height)) return
      setHtmlHeight(Math.max(0, Math.ceil(height)))
    }

    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [state])

  if (state.status === 'fallback') return <>{fallback}</>

  // Fragments are sub-routes of an app meant to inline into the conversation
  // as if they were native message content — no chrome, no header, no
  // separate max-width. Skip the shell entirely.
  //
  // The `w-full min-w-0` wrapper is load-bearing: callers (ArtifactRefRow,
  // AttachmentCard) drop this component into a `flex-col items-start` parent
  // without giving it an explicit width. Without `w-full` here the iframe
  // collapses to its CSS intrinsic 300px and the fragment renders as a tiny
  // centered card instead of filling the message column.
  if (state.status === 'ready' && state.kind === 'app' && appPreviewRef?.fragment) {
    return (
      <div className="w-full min-w-0">
        <AppPreview {...appPreviewRef} />
      </div>
    )
  }

  if (state.status === 'loading') {
    return (
      <InlinePreviewShell name={name} onOpen={onOpen} openHref={openHref} actions={actions}>
        <div className="flex items-center justify-center bg-muted/20 py-10 text-xs text-muted-foreground">
          Loading preview...
        </div>
      </InlinePreviewShell>
    )
  }

  return (
    <InlinePreviewShell name={name} onOpen={onOpen} openHref={openHref} actions={actions}>
      {state.kind === 'app' && appPreviewRef ? (
        <AppPreview {...appPreviewRef} />
      ) : (state.kind === 'html' || state.kind === 'docx') && state.blobUrl ? (
        <iframe
          ref={htmlIframeRef}
          title={name}
          src={state.blobUrl}
          sandbox={GENERATED_APP_IFRAME_SANDBOX}
          className="block w-full border-0 bg-white"
          style={{ height: htmlHeight, maxHeight: `${INLINE_PREVIEW_MAX_HEIGHT_VH}vh` }}
        />
      ) : state.kind === 'pdf' && state.blobUrl ? (
        <iframe
          title={name}
          src={state.blobUrl}
          className="block w-full border-0 bg-white"
          style={{ height: `${INLINE_PREVIEW_MAX_HEIGHT_VH}vh`, maxHeight: `${INLINE_PREVIEW_MAX_HEIGHT_VH}vh` }}
        />
      ) : state.kind === 'image' && state.blobUrl ? (
        <div className="flex items-center justify-center overflow-auto bg-background">
          <img src={state.blobUrl} alt={name} className="h-auto w-auto max-h-[60vh] max-w-full object-contain" />
        </div>
      ) : state.kind === 'video' && state.blobUrl ? (
        <div className="flex items-center justify-center overflow-auto bg-background">
          <video src={state.blobUrl} controls className="max-h-[60vh] max-w-full" />
        </div>
      ) : state.kind === 'audio' && state.blobUrl ? (
        <div className="flex items-center justify-center px-6 py-4 bg-background">
          <audio src={state.blobUrl} controls className="w-full max-w-lg" />
        </div>
      ) : state.kind === 'text' && typeof state.text === 'string' ? (
        isMarkdownFile(name, mime) ? (
          <div className="max-h-[60vh] overflow-y-auto bg-background p-4 text-sm">
            <MarkdownContent text={state.text} />
          </div>
        ) : (
          <pre className="max-h-[60vh] overflow-y-auto bg-background p-4 text-xs leading-relaxed whitespace-pre-wrap">
            {state.text}
          </pre>
        )
      ) : (
        fallback
      )}
    </InlinePreviewShell>
  )
}

function InlinePreviewShell({
  name,
  onOpen,
  openHref,
  actions,
  children,
}: {
  name: string
  onOpen?: () => void
  openHref?: string
  actions?: ReactNode
  children: ReactNode
}) {
  const handleOpenLinkClick = (e: MouseEvent<HTMLAnchorElement>) => {
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return
    onOpen?.()
  }

  return (
    <div
      className="mx-auto w-full min-w-0 max-w-full overflow-hidden rounded-xl border-2 border-border bg-background shadow-sm sm:max-w-5xl"
      data-testid="artifact-inline-preview"
    >
      <div className="flex items-center gap-2 border-b bg-muted/30 px-3 py-2">
        <span className="min-w-0 flex-1 truncate text-xs font-medium text-foreground">{name}</span>
        <div className="flex shrink-0 items-center gap-1.5">
          {actions}
          {openHref ? (
            <a
              href={openHref}
              onClick={handleOpenLinkClick}
              className={cn(buttonVariants({ size: 'sm', variant: 'ghost' }), 'h-6 gap-1 px-2 text-xs')}
            >
              Open
              <ExternalLink className="h-3 w-3" />
            </a>
          ) : onOpen ? (
            <Button size="sm" variant="ghost" className="h-6 gap-1 px-2 text-xs" onClick={onOpen}>
              Open
              <ExternalLink className="h-3 w-3" />
            </Button>
          ) : null}
        </div>
      </div>
      <div className="min-w-0 max-w-full overflow-hidden bg-background">
        {children}
      </div>
    </div>
  )
}
