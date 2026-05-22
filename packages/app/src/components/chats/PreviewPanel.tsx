import { useCallback, useEffect, useMemo, useState } from 'react'
import { X } from 'lucide-react'
import { Button, cn } from '@roomy-ai/ui'
import {
  ArtifactKebab,
  ArtifactPreviewBody,
  useArtifactPreview,
} from '@/components/shared/InlineArtifactPreview'
import { iconForFile } from '@/data/file-kind'
import { useDeleteLibraryFileMutation } from '@/store/api'
import { useAppDispatch, useAppSelector } from '@/store/hooks'
import {
  closeArtifact,
  selectPreviewArtifact,
} from '@/store/slices/previewPanelSlice'
import { buildPath } from '@/router/nav'

/**
 * Side-mounted preview panel for artifact refs whose `presentation` is
 * `panel` (or whose mime defaults to panel rendering — code, HTML, PDFs,
 * etc.). One artifact at a time — opening a different card via
 * `dispatch(openArtifact(...))` swaps the contents in place; closing
 * (X button, route change, chat switch) returns the layout to the
 * standard chat-thread + right-sidebar view.
 *
 * Phase 2 still uses a fixed 35/65 split; the resize handle + per-user
 * persistence + mobile-overlay variant are tracked as Phase 2b work.
 */
export function PreviewPanel({ className }: { className?: string }) {
  const dispatch = useAppDispatch()
  const artifact = useAppSelector(selectPreviewArtifact)
  const [deleteLibraryFile] = useDeleteLibraryFileMutation()

  // While the wrapper plays its exit animation in AppShell, the slice
  // has already cleared `artifact` (the close click dispatched
  // `closeArtifact`). We mirror the last non-null artifact in local
  // state so the header + body keep rendering during the ~250 ms
  // close, then unmount cleanly when AnimatePresence removes us.
  const [stickyArtifact, setStickyArtifact] = useState(artifact)
  useEffect(() => {
    if (artifact) setStickyArtifact(artifact)
  }, [artifact])
  const display = artifact ?? stickyArtifact

  const handleClose = useCallback(() => {
    dispatch(closeArtifact())
  }, [dispatch])

  const handleDelete = useMemo(() => {
    if (!display) return undefined
    return async () => {
      await deleteLibraryFile({ workspaceId: display.workspaceId, path: display.path }).unwrap()
      // Closing the panel after a successful delete avoids leaving a
      // stale preview header pointing at a file that no longer exists.
      dispatch(closeArtifact())
    }
  }, [display, deleteLibraryFile, dispatch])

  // Hooks must run in the same order on every render — call
  // `useArtifactPreview` with a safe fallback path when no artifact is
  // selected. The body never renders in that case, so the stale state
  // never reaches the DOM.
  const previewInput = useMemo(() => ({
    workspaceId: display?.workspaceId,
    path: display?.path ?? '',
    name: display?.name ?? '',
    mime: display?.mime ?? undefined,
    params: display?.params,
    mode: 'panel' as const,
  }), [display])
  const { state, appPreviewRef } = useArtifactPreview(previewInput)

  if (!display) return null

  const detailHref = buildPath(display.workspaceId, 'context', { item: display.path })
  const FileIcon = iconForFile(display.name, display.mime ?? undefined)

  // Empty state for files the panel can't render inline (PDFs,
  // archives, anything `previewBlobFor` rejects). Header already
  // carries the file metadata + Save / Open / Remove via the kebab,
  // so the body just needs to explain what's going on rather than
  // duplicate the card.
  const fallback = (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
      <div className="h-14 w-14 rounded-xl bg-foreground/[0.04] flex items-center justify-center">
        <FileIcon className="h-7 w-7 text-muted-foreground" />
      </div>
      <p className="text-sm font-medium text-foreground">No preview available</p>
      <p className="text-xs text-muted-foreground max-w-sm">
        This file type can't be previewed inline. Use the kebab menu above to open it in a new tab.
      </p>
    </div>
  )

  return (
    <aside
      className={cn(
        // Panel itself is transparent — the AppShell blob backdrop
        // bleeds through. Only the inner content card carries chrome
        // (bg + border + radius). 12 px left inset applied here so
        // the header content and the card share the same baseline
        // (no risk of `pl-3` on the header and `ml-3` on the card
        // drifting apart).
        'flex h-full min-w-0 flex-col bg-transparent pl-3',
        className,
      )}
      data-testid="preview-panel"
    >
      {/* Header — transparent, asymmetric padding (12 left / 24
          right) so the file icon lines up with the content card's
          left edge while the close button hugs the panel right
          edge. Same Icon / Name / Save / Kebab / Close cluster as
          the inline artifact card. */}
      <div className="shrink-0 flex items-center gap-2 pl-2 pr-6 py-4">
        <FileIcon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <a
          href={detailHref}
          target="_blank"
          rel="noopener noreferrer"
          className="min-w-0 flex-1 truncate text-sm font-medium text-foreground hover:underline decoration-foreground/30 underline-offset-2"
        >
          {display.name}
        </a>

        {/* Save to library — local-state flow for now (Phase 2b plumbs
            the real "copy to library" mutation). */}
        <Button
          variant="outline"
          size="sm"
          className="h-7 gap-1.5 px-2.5 text-xs"
          onClick={() => {
            // TODO(Phase 2b): wire to the real save mutation.
          }}
        >
          Save to library
        </Button>

        <ArtifactKebab
          fileName={display.name}
          openHref={detailHref}
          onDelete={handleDelete}
        />

        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7 text-muted-foreground hover:text-foreground"
          onClick={handleClose}
          title="Close preview"
          aria-label="Close preview"
        >
          <X className="h-4 w-4" />
        </Button>
      </div>

      {/* Content card — the visible "preview surface". Holds its own
          chrome (rounded + border + bg) so it reads as a distinct
          object on top of the blob backdrop, while the panel and
          header stay transparent. */}
      <div className="min-h-0 flex-1 mr-6 mb-6 overflow-hidden rounded-xl border border-foreground/10 bg-background shadow-md">
        <ArtifactPreviewBody
          state={state}
          name={display.name}
          mime={display.mime}
          appPreviewRef={appPreviewRef}
          fallback={fallback}
        />
      </div>
    </aside>
  )
}
