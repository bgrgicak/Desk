import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { ExternalLink } from 'lucide-react'
import { Button } from '@agent-desk/ui'
import { isMarkdownFile, type FileKind } from '@/data/file-kind'
import { MarkdownContent } from '@/components/MarkdownContent'
import { AppPreview, appAttachmentToPreview } from '@/components/context/AppPreview'
import { useGetLibraryFileQuery } from '@/store/api'
import { fetchLibraryContent } from '@/store/library-download'
import { GENERATED_APP_IFRAME_SANDBOX } from '@/lib/iframe-sandbox'
import { previewBlobFor, previewKindFrom } from '@/lib/preview-blob'

const MAX_INLINE_PREVIEW_BYTES = 5 * 1024 * 1024

interface InlineArtifactPreviewProps {
  workspaceId?: string
  path: string
  name: string
  mime?: string | null
  onOpen?: () => void
  actions?: ReactNode
  fallback: ReactNode
}

type PreviewState =
  | { status: 'loading' }
  | { status: 'ready'; kind: FileKind; blobUrl?: string; text?: string }
  | { status: 'fallback' }

function canRenderInline(kind: FileKind): boolean {
  return kind === 'html' || kind === 'image' || kind === 'text' || kind === 'app'
}

export function inlineAppPreviewFor(
  path: string,
  name: string,
  mime?: string | null,
): Parameters<typeof AppPreview>[0] | null {
  void name
  void mime
  return appAttachmentToPreview(path)
}

export function InlineArtifactPreview({ workspaceId, path, name, mime, onOpen, actions, fallback }: InlineArtifactPreviewProps) {
  const [state, setState] = useState<PreviewState>({ status: 'loading' })
  const appPreviewRef = useMemo(
    () => inlineAppPreviewFor(path, name, mime),
    [path, name, mime],
  )
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

  if (state.status === 'fallback') return <>{fallback}</>

  if (state.status === 'loading') {
    return (
      <InlinePreviewShell name={name} onOpen={onOpen} actions={actions}>
        <div className="flex h-full items-center justify-center bg-muted/20 text-xs text-muted-foreground">
          Loading preview...
        </div>
      </InlinePreviewShell>
    )
  }

  return (
    <InlinePreviewShell name={name} onOpen={onOpen} actions={actions}>
      {state.kind === 'app' && appPreviewRef ? (
        <AppPreview {...appPreviewRef} />
      ) : state.kind === 'html' && state.blobUrl ? (
        <iframe
          title={name}
          src={state.blobUrl}
          sandbox={GENERATED_APP_IFRAME_SANDBOX}
          className="h-full w-full border-0 bg-white"
        />
      ) : state.kind === 'image' && state.blobUrl ? (
        <div className="flex h-full items-center justify-center overflow-auto bg-background">
          <img src={state.blobUrl} alt={name} className="h-full w-full object-contain" />
        </div>
      ) : state.kind === 'text' && typeof state.text === 'string' ? (
        isMarkdownFile(name, mime) ? (
          <div className="h-full overflow-y-auto bg-background p-4 text-sm">
            <MarkdownContent text={state.text} />
          </div>
        ) : (
          <pre className="h-full overflow-y-auto bg-background p-4 text-xs leading-relaxed whitespace-pre-wrap">
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
  actions,
  children,
}: {
  name: string
  onOpen?: () => void
  actions?: ReactNode
  children: ReactNode
}) {
  return (
    <div
      className="mx-auto w-full max-w-5xl overflow-hidden rounded-xl border-2 border-border bg-background shadow-sm"
      data-testid="artifact-inline-preview"
    >
      <div className="flex items-center gap-2 border-b bg-muted/30 px-3 py-2">
        <span className="min-w-0 flex-1 truncate text-xs font-medium text-foreground">{name}</span>
        <div className="flex items-center gap-1.5">
          {actions}
          {onOpen && (
            <Button size="sm" variant="ghost" className="h-6 gap-1 px-2 text-xs" onClick={onOpen}>
              Open
              <ExternalLink className="h-3 w-3" />
            </Button>
          )}
        </div>
      </div>
      <div className="h-[460px] max-h-[75vh] min-h-[380px] bg-background sm:h-[640px]">
        {children}
      </div>
    </div>
  )
}
