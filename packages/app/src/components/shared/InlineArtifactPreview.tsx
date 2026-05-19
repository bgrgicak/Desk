import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { toast } from 'sonner'
import { ExternalLink, FolderOpen, MoreVertical, Trash2 } from 'lucide-react'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  cn,
} from '@agent-desk/ui'
import { iconForFile, isMarkdownFile, type FileKind } from '@/data/file-kind'
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
  params?: Record<string, string>
  onOpen?: () => void
  openHref?: string
  /** Optional extra elements rendered to the left of the standard
   *  action set in the header. Mostly unused now that the shell
   *  carries Save / Fullscreen / Delete natively. */
  actions?: ReactNode
  fallback: ReactNode
  /** Called when the user clicks "Save to library". If omitted, the
   *  click still flips the local saved-state and fires a toast — the
   *  caller can pass a handler that hits the real mutation. */
  onSave?: () => Promise<void> | void
  /** When true, the Save button starts in the disabled "Saved" state
   *  (e.g. the file is already a library artifact). */
  initiallySaved?: boolean
  /** Called when the user confirms deletion in the dialog. When
   *  omitted, the Delete button is hidden — only attachments / temp
   *  files should expose deletion. */
  onDelete?: () => Promise<void> | void
}

type PreviewState =
  | { status: 'loading' }
  | { status: 'ready'; kind: FileKind; blobUrl?: string; text?: string }
  | { status: 'fallback' }

/**
 * Whether the preview hook should try to render in-place.
 *
 *   - **Inline mode** (chat stream): only **app fragments** render
 *     inline — bare, no header, no actions. Full apps + images +
 *     everything else fall through to the artifact card, which opens
 *     the side preview panel on click.
 *   - **Panel mode** (side preview): handles every previewable kind
 *     (html / image / text / app / fragment).
 *
 * The `isFragment` argument is true when `appPreviewRef.fragment` is
 * set, which `appAttachmentToPreview` reports for paths matching
 * `*.app/dist/fragments/<name>/`.
 */
function canRenderInline(kind: FileKind, isFragment: boolean): boolean {
  return kind === 'app' && isFragment
}

function canRenderInPanel(kind: FileKind, _isFragment: boolean): boolean {
  void _isFragment
  return kind === 'html' || kind === 'image' || kind === 'text' || kind === 'app'
}

// ── Shared preview state machine ──────────────────────────────────────────
//
// `useArtifactPreview` owns the fetch + transition logic. Both the
// inline preview card and the side preview panel pull from it so they
// share a single source of truth for what's loaded, what failed, and
// which renderer to mount in the body. The hook returns the state plus
// the resolved app-preview ref when the artifact is an app directory.

interface ArtifactPreviewInput {
  workspaceId?: string
  path: string
  name: string
  mime?: string | null
  params?: Record<string, string>
  /** Which surface the hook is feeding. `inline` (default) restricts
   *  the renderer to images + apps per Phase 2's "default to panel"
   *  routing rule. `panel` opens the gate to every kind the preview
   *  body can render (HTML / text / markdown / image / app). */
  mode?: 'inline' | 'panel'
}

interface ArtifactPreviewResult {
  state: PreviewState
  appPreviewRef: Parameters<typeof AppPreview>[0] | null
}

export function useArtifactPreview({ workspaceId, path, name, mime, params, mode = 'inline' }: ArtifactPreviewInput): ArtifactPreviewResult {
  const canRender = mode === 'panel' ? canRenderInPanel : canRenderInline
  const [state, setState] = useState<PreviewState>({ status: 'loading' })
  const appPreviewRef = useMemo(() => {
    const base = inlineAppPreviewFor(path, name, mime)
    if (!base) return null
    return {
      ...base,
      ...(base.scope === 'library' ? { workspaceId } : {}),
      ...(params ? { params } : {}),
    }
  }, [path, name, mime, params, workspaceId])
  // Fragment = piece of an app meant to embed in chat. Detected via
  // `appAttachmentToPreview` which already returns `fragment` for paths
  // shaped like `*.app/dist/fragments/<name>/`.
  const isFragment = !!appPreviewRef?.fragment
  const guessedKind = appPreviewRef ? 'app' : previewKindFrom(name, path, mime)
  const shouldTryPreview = !!workspaceId && canRender(guessedKind, isFragment)
  const shouldFetchFile = shouldTryPreview && guessedKind !== 'app'
  const { data: fileMeta, isError: metaError } = useGetLibraryFileQuery(
    { workspaceId: workspaceId ?? '', path },
    { skip: !shouldFetchFile },
  )

  useEffect(() => {
    if (guessedKind === 'app') {
      // Apps need a valid preview ref AND, in inline mode, the
      // fragment marker. Full apps in inline mode fall to the card
      // (which the parent renders via the fallback branch).
      if (!appPreviewRef) {
        setState({ status: 'fallback' })
        return
      }
      if (mode === 'inline' && !isFragment) {
        setState({ status: 'fallback' })
        return
      }
      setState({ status: 'ready', kind: 'app' })
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
        if (!canRender(kind, isFragment) || kind === 'app') {
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
  }, [workspaceId, path, name, mime, mode, shouldTryPreview, metaError, fileMeta, guessedKind, appPreviewRef, isFragment, canRender])

  return { state, appPreviewRef }
}

// ── Shared body renderer ──────────────────────────────────────────────────
//
// Picks the right viewer (iframe / image / markdown / pre) based on the
// hook's resolved kind. Designed to fill its parent's height — the
// caller decides how tall the body should be.

interface ArtifactPreviewBodyProps {
  state: PreviewState
  name: string
  mime?: string | null
  appPreviewRef: Parameters<typeof AppPreview>[0] | null
  /** Rendered when the state lands in `fallback`. Inline preview passes
   *  its small file pill; the side panel can pass a richer empty / error
   *  state. */
  fallback: ReactNode
}

export function ArtifactPreviewBody({ state, name, mime, appPreviewRef, fallback }: ArtifactPreviewBodyProps) {
  if (state.status === 'fallback') return <>{fallback}</>
  if (state.status === 'loading') {
    return (
      <div className="flex h-full items-center justify-center bg-muted/20 text-xs text-muted-foreground">
        Loading preview...
      </div>
    )
  }
  if (state.kind === 'app' && appPreviewRef) {
    return <AppPreview {...appPreviewRef} />
  }
  if (state.kind === 'html' && state.blobUrl) {
    return (
      <iframe
        title={name}
        src={state.blobUrl}
        sandbox={GENERATED_APP_IFRAME_SANDBOX}
        className="h-full w-full border-0 bg-white"
      />
    )
  }
  if (state.kind === 'image' && state.blobUrl) {
    return (
      <div className="flex h-full items-center justify-center overflow-auto bg-background">
        <img src={state.blobUrl} alt={name} className="h-full w-full object-contain" />
      </div>
    )
  }
  if (state.kind === 'text' && typeof state.text === 'string') {
    return isMarkdownFile(name, mime) ? (
      <div className="h-full overflow-y-auto bg-background p-4 text-sm">
        <MarkdownContent text={state.text} />
      </div>
    ) : (
      <pre className="h-full overflow-y-auto bg-background p-4 text-xs leading-relaxed whitespace-pre-wrap">
        {state.text}
      </pre>
    )
  }
  return <>{fallback}</>
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

export function InlineArtifactPreview({ workspaceId, path, name, mime, params, onOpen, openHref, actions, fallback, onSave, initiallySaved = false, onDelete }: InlineArtifactPreviewProps) {
  const { state, appPreviewRef } = useArtifactPreview({ workspaceId, path, name, mime, params })

  // Caller props that are no longer surfaced inline (apps and images
  // now route through the card → panel pattern, so the shell's Save /
  // Open / Delete chrome doesn't render here). Touch them so eslint's
  // no-unused-vars doesn't trip while keeping the prop API stable for
  // callers that still pass them.
  void onOpen
  void openHref
  void actions
  void onSave
  void initiallySaved
  void onDelete

  // Fallback gets rendered raw so the parent's card shows up exactly
  // as designed (no inline shell wrapping it). This is the path for
  // every non-fragment artifactRef now — full apps, images, code,
  // markdown, etc. all land here and the parent's card opens the
  // preview panel on click.
  if (state.status === 'fallback') return <>{fallback}</>

  // Only fragments reach this branch (canRenderInline gates inline
  // mode to `kind === 'app' && isFragment`). Render the AppPreview
  // iframe naked, wrapped only in the standard inline card chrome
  // (rounded + border + shadow + my-5 vertical breathing room) so the
  // fragment feels like a sibling of every other inline card in the
  // chat.
  return (
    <div
      className="my-5 mx-auto w-full min-w-0 max-w-full overflow-hidden rounded-xl border border-foreground/10 bg-background shadow-md sm:max-w-5xl"
      data-testid="artifact-fragment-inline"
      style={{ height: 280 }}
    >
      <ArtifactPreviewBody
        state={state}
        name={name}
        mime={mime}
        appPreviewRef={appPreviewRef}
        fallback={fallback}
      />
    </div>
  )
}

// Re-export the input type so external consumers (PreviewPanel) can
// match the prop shape exactly.
export type { ArtifactPreviewInput }

// ── Shared action buttons ─────────────────────────────────────────────────
//
// Both `InlinePreviewShell` (the rendered preview card) and
// `UnsupportedFileCard` (the unrenderable-file row) need the Save and
// Delete affordances with identical UX. Pulling them into small inline
// components keeps the state + dialog wiring colocated with the button.

function SaveToLibraryButton({
  onSave,
  initiallySaved = false,
  viewHref,
}: {
  onSave?: () => Promise<void> | void
  initiallySaved?: boolean
  /** Route to the file's detail view in the library. Once the file is
   *  saved, the button flips into a "View in library" link that opens
   *  this route in a new tab. */
  viewHref?: string
}) {
  const [saved, setSaved] = useState(initiallySaved)
  const [saving, setSaving] = useState(false)
  const handle = useCallback(async () => {
    if (saved || saving) return
    setSaving(true)
    try {
      await onSave?.()
      setSaved(true)
      toast.success('Saved to library')
    } catch (err) {
      toast.error('Failed to save', {
        description: err instanceof Error ? err.message : undefined,
      })
    } finally {
      setSaving(false)
    }
  }, [onSave, saved, saving])
  // Post-save: the affordance becomes a way back into the library
  // entry instead of an inert confirmation. Same outline shape so the
  // surface doesn't jump when state changes.
  if (saved && viewHref) {
    return (
      <Button
        variant="outline"
        size="sm"
        className="h-7 gap-1.5 px-2.5 text-xs"
        asChild
      >
        <a href={viewHref} target="_blank" rel="noopener noreferrer">
          <FolderOpen className="h-3.5 w-3.5" />
          View in library
        </a>
      </Button>
    )
  }
  return (
    <Button
      variant="outline"
      size="sm"
      className="h-7 gap-1.5 px-2.5 text-xs"
      disabled={saved || saving}
      onClick={handle}
    >
      {saved ? 'Saved' : saving ? 'Saving…' : 'Save to library'}
    </Button>
  )
}

/**
 * Unified kebab menu used by the artifact card and the preview-panel
 * header. Collapses what used to be two separate icon buttons (Open in
 * new tab + Delete) into one `MoreVertical` trigger with two menu
 * items. The destructive Remove action still routes through a confirm
 * dialog so an accidental click can't blow away a file.
 */
export function ArtifactKebab({
  fileName,
  openHref,
  onDelete,
}: {
  fileName: string
  openHref?: string
  onDelete?: () => Promise<void> | void
}) {
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const handleConfirm = useCallback(async () => {
    if (busy || !onDelete) return
    setBusy(true)
    try {
      await onDelete()
      toast.success('Removed from this chat')
      setConfirmOpen(false)
    } catch (err) {
      toast.error('Failed to delete', {
        description: err instanceof Error ? err.message : undefined,
      })
    } finally {
      setBusy(false)
    }
  }, [onDelete, busy])

  if (!openHref && !onDelete) return null

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7 text-muted-foreground hover:text-foreground"
            title="Options"
            aria-label="Options"
          >
            <MoreVertical className="h-3.5 w-3.5" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-40">
          {openHref && (
            <DropdownMenuItem asChild>
              <a href={openHref} target="_blank" rel="noopener noreferrer">
                <ExternalLink className="h-3.5 w-3.5 mr-2" />
                Open
              </a>
            </DropdownMenuItem>
          )}
          {onDelete && (
            <DropdownMenuItem
              onSelect={(e) => { e.preventDefault(); setConfirmOpen(true) }}
            >
              <Trash2 className="h-3.5 w-3.5 mr-2" />
              Remove
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      <AlertDialog open={confirmOpen} onOpenChange={next => { if (!busy) setConfirmOpen(next) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove "{fileName}" from this chat?</AlertDialogTitle>
            <AlertDialogDescription>
              The file will disappear from the chat and the Files panel. If you've already saved it to the library, the library copy is unaffected.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={busy}
              onClick={() => { void handleConfirm() }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}

// ── Artifact card (panel-mode) ────────────────────────────────────────────
//
// The default surface for artifactRef messages that open in the preview
// side panel rather than rendering inline (PDFs, code, markdown, HTML,
// most documents). Clicking the card — anywhere — fires `onPreview`,
// which the parent wires up to the preview-panel store. Save / Delete /
// Open-in-new-tab affordances live in the panel header now, not on the
// card; the card is intentionally minimal so it doesn't compete with
// surrounding text for attention.

interface UnsupportedFileCardProps {
  name: string
  path: string
  mime?: string | null
  /** Workspace the artifact lives in. Required to fetch image
   *  thumbnails — when omitted (or the artifact isn't an image), the
   *  card falls back to the file-type icon swatch. */
  workspaceId?: string
  /** Workspace name to show alongside the path in the secondary line.
   *  Surfaced only in the global / home chat — workspace-scoped chats
   *  omit it because the workspace context is already implicit. */
  workspaceName?: string
  /** Highlight treatment for when this artifact is currently mounted
   *  in the preview panel. Subtle bg tint + darker border. */
  isActive?: boolean
  /** Called when the user clicks the card body. The panel-mode flow
   *  routes this to the preview-panel store. */
  onPreview?: () => void
  /** In-app route to the file's detail view, opened in a new browser
   *  tab via the Open action. */
  openHref?: string
  onSave?: () => Promise<void> | void
  initiallySaved?: boolean
  onDelete?: () => Promise<void> | void
}

export function UnsupportedFileCard({
  name,
  path,
  mime,
  workspaceId,
  workspaceName,
  isActive = false,
  onPreview,
  openHref,
  onSave,
  initiallySaved = false,
  onDelete,
}: UnsupportedFileCardProps) {
  const FileIcon = useMemo(() => iconForFile(name, mime ?? undefined), [name, mime])
  const secondary = workspaceName ? `${workspaceName} · ${path}` : path

  // For image artifacts, swap the file-type icon swatch for a real
  // thumbnail of the image. We reuse `useArtifactPreview` in panel
  // mode (it knows how to fetch images and create a blob URL); for
  // non-images we pass `undefined` workspaceId so the hook
  // short-circuits without fetching.
  const isImage = (mime ?? '').toLowerCase().startsWith('image/')
  const thumbnailInput = useMemo(() => ({
    workspaceId: isImage ? workspaceId : undefined,
    path,
    name,
    mime: mime ?? undefined,
    mode: 'panel' as const,
  }), [isImage, workspaceId, path, name, mime])
  const { state: thumbnailState } = useArtifactPreview(thumbnailInput)
  const thumbnailUrl = isImage
    && thumbnailState.status === 'ready'
    && thumbnailState.kind === 'image'
    ? thumbnailState.blobUrl
    : undefined

  // Card body is keyboard-activatable as a button, but rendered as a
  // div so the inner Save / Open / Delete action buttons remain real
  // `<button>` elements (nested buttons are invalid HTML). Enter / Space
  // on the card itself triggers the preview; the inner cluster stops
  // propagation so clicking an action doesn't also fire preview.
  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget) return
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      onPreview?.()
    }
  }

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onPreview}
      onKeyDown={handleKeyDown}
      className={cn(
        'group w-full min-w-0 max-w-full mt-3 mb-5 cursor-pointer',
        'rounded-xl border transition-colors',
        'flex items-center gap-3 px-4 py-3',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        // Active state uses a clean `bg-background` (lighter than the
        // previous `foreground/[0.04]` tint, which blended into the
        // blob backdrop) plus a darker border + subtle shadow so the
        // card reads as a separate surface even on coloured patches.
        isActive
          ? 'border-foreground/40 bg-secondary shadow-sm'
          : 'border-foreground/10 bg-background hover:bg-foreground/[0.02]',
      )}
      data-testid="artifact-inline-fallback"
      aria-pressed={isActive}
    >
      {/* 40-px swatch: file-type icon by default, real thumbnail when
          the artifact is an image and the fetch has resolved. The
          `bg-foreground/[0.04]` shows through any transparent regions
          in the image (e.g. PNGs with alpha). */}
      <div className="h-10 w-10 shrink-0 overflow-hidden rounded-lg bg-foreground/[0.04] flex items-center justify-center">
        {thumbnailUrl ? (
          <img
            src={thumbnailUrl}
            alt={name}
            className="h-full w-full object-cover"
          />
        ) : (
          <FileIcon className="h-5 w-5 text-muted-foreground" />
        )}
      </div>

      {/* Name + secondary description (workspace · path) */}
      <div className="min-w-0 flex-1 flex flex-col">
        <span className="truncate text-sm font-medium text-foreground">{name}</span>
        <span className="truncate text-xs text-muted-foreground">{secondary}</span>
      </div>

      {/* Action cluster — stops click propagation so individual button
          presses don't also trigger the card-level preview. The Open /
          Remove pair is collapsed into a single kebab to keep the
          card surface uncluttered. */}
      <div
        className="flex shrink-0 items-center gap-1"
        onClick={(e) => e.stopPropagation()}
      >
        <SaveToLibraryButton onSave={onSave} initiallySaved={initiallySaved} viewHref={openHref} />
        <ArtifactKebab fileName={name} openHref={openHref} onDelete={onDelete} />
      </div>
    </div>
  )
}
