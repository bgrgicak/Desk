import { useState, useRef, useEffect, useCallback } from 'react'
import {
  Link2,
  Download,
  Trash2,
  MoreHorizontal,
  ExternalLink,
  Pencil,
  PanelRight,
  Save,
  ChevronRight,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { PageHeader } from '@/components/layout/PageHeader'
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '@/components/ui/breadcrumb'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import type { ContextItem, Artifact } from '@/data/ui-types'
import { getArtifactIcon, getFolderPath } from '@/data/ui-types'
import { fileKindForItem, fileKindFrom, iconForItem } from '@/data/file-kind'
import {
  useDeleteLibraryFileMutation,
  useGetLibraryQuery,
  useMoveLibraryEntryMutation,
  useSaveLibraryContentMutation,
} from '@/store/api'
import { toFolderList } from '@/store/selectors/library'
import { downloadLibraryFile, fetchLibraryContent } from '@/store/library-download'
import { TextFileEditor } from './TextFileEditor'
import { ConversationPanel } from '@/components/artifact/ConversationPanel'
import { toArtifactFromFile } from '@/store/selectors/artifacts'
import { useParams } from 'react-router-dom'
import { toast } from 'sonner'
import { usePrefs } from '@/hooks/use-prefs'

const AUTO_SAVE_DEBOUNCE_MS = 1_000
const SAVED_BADGE_TTL_MS = 2_000

interface ContextDetailProps {
  item: ContextItem
  onBack: () => void
  onCompose: (items: ContextItem[]) => void
  onArtifactClick?: (artifact: Artifact) => void
  /** Jump back to the Library view with the given folder open.
   * Pass `null` to land on the Library root. */
  onNavigateToFolder: (folderId: string | null) => void
  /** Called after a successful rename so the parent can update the
   * URL/route to the new workspace-relative path. */
  onItemPathChange?: (newPath: string) => void
}

function canPreview(item: ContextItem): boolean {
  if (item.type === 'note' || item.type === 'link') return true
  return fileKindForItem(item) !== 'unknown'
}

export function ContextDetail({ item, onBack, onCompose, onArtifactClick, onNavigateToFolder, onItemPathChange }: ContextDetailProps) {
  const { wsId: activeWorkspaceId } = useParams<{ wsId: string }>()
  const [deleteLibraryFile, deleteState] = useDeleteLibraryFileMutation()
  const [moveLibraryEntry, moveState] = useMoveLibraryEntryMutation()

  const [panelCollapsed, setPanelCollapsed] = useState(false)
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false)

  // File content fetched on demand for preview. Text files (notes, uri-list
  // links, csv/json/code, …) arrive as `previewText`; binary previews (images,
  // PDFs, video, audio) arrive as an object URL we can hand to <img>/<iframe>/
  // <video>/<audio>. Both are keyed by the item's path so switching items drops
  // any stale blob. `mediaLoadFailed` catches formats the browser advertises it
  // might render but can't (e.g. HEIC in non-Safari browsers) so we fall back
  // to the download prompt.
  const [previewText, setPreviewText] = useState<string | null>(null)
  const [previewBlobUrl, setPreviewBlobUrl] = useState<string | null>(null)
  const [previewError, setPreviewError] = useState<string | null>(null)
  const [mediaLoadFailed, setMediaLoadFailed] = useState(false)

  const kind = fileKindForItem(item)

  useEffect(() => {
    setPreviewText(null)
    setPreviewBlobUrl(null)
    setPreviewError(null)
    setMediaLoadFailed(false)
    setEditorValue(null)
    editorInitFor.current = null
    if (!activeWorkspaceId) return
    if (!canPreview(item)) return
    let cancelled = false
    let createdUrl: string | null = null
    void fetchLibraryContent({ workspaceId: activeWorkspaceId, path: item.id })
      .then(async (blob) => {
        if (cancelled) return
        const effectiveKind = fileKindFrom(item.name, blob.type || item.mimeType)
        if (effectiveKind === 'docx') {
          // Convert docx → HTML in-browser via mammoth, then hand the
          // rendered HTML to the iframe as a blob URL. Lazy-imported so
          // users who never open a .docx don't pay the bundle cost.
          const mammoth = await import('mammoth/mammoth.browser')
          const arrayBuffer = await blob.arrayBuffer()
          const { value: html } = await mammoth.convertToHtml({ arrayBuffer })
          if (cancelled) return
          const htmlDoc = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>body{font-family:system-ui,sans-serif;max-width:780px;margin:0 auto;padding:2.5rem 1.5rem;line-height:1.6;color:#111}img{max-width:100%;height:auto}table{border-collapse:collapse}td,th{border:1px solid #ddd;padding:6px 10px}</style></head><body>${html}</body></html>`
          const htmlBlob = new Blob([htmlDoc], { type: 'text/html' })
          createdUrl = URL.createObjectURL(htmlBlob)
          setPreviewBlobUrl(createdUrl)
        } else if (effectiveKind === 'text' || item.type === 'link' || item.type === 'note') {
          const text = await blob.text()
          if (!cancelled) setPreviewText(text)
        } else {
          createdUrl = URL.createObjectURL(blob)
          setPreviewBlobUrl(createdUrl)
        }
      })
      .catch((err) => {
        if (cancelled) return
        setPreviewError(err instanceof Error ? err.message : 'Preview failed')
      })
    return () => {
      cancelled = true
      if (createdUrl) URL.revokeObjectURL(createdUrl)
    }
  }, [activeWorkspaceId, item.id, item.type, item.mimeType, item.name])

  const handleDownload = async () => {
    if (!activeWorkspaceId) return
    try {
      await downloadLibraryFile({
        workspaceId: activeWorkspaceId,
        path: item.id,
        filename: item.name,
      })
    } catch (err) {
      toast.error(`Download failed: ${item.name}`, {
        description: err instanceof Error ? err.message : undefined,
      })
    }
  }

  const handleDelete = async () => {
    if (!activeWorkspaceId) return
    try {
      await deleteLibraryFile({ workspaceId: activeWorkspaceId, path: item.id }).unwrap()
      setDeleteDialogOpen(false)
      toast.success(`Deleted ${item.name}`)
      onBack()
    } catch (err) {
      toast.error(`Delete failed: ${item.name}`, {
        description: err instanceof Error ? err.message : undefined,
      })
    }
  }

  // Rename modal (for file / link items — notes use the inline title editor).
  // The parent re-keys this component on item.id, so initial state is always
  // fresh for the current item — no syncing effect needed.
  const [renameOpen, setRenameOpen] = useState(false)
  const [renameValue, setRenameValue] = useState(item.name)

  const handleRename = async () => {
    if (!activeWorkspaceId) return
    const name = renameValue.trim()
    if (!name || name === item.name) {
      setRenameOpen(false)
      return
    }
    const slash = item.id.lastIndexOf('/')
    const parent = slash >= 0 ? item.id.slice(0, slash) : ''
    const to = parent ? `${parent}/${name}` : name
    try {
      await moveLibraryEntry({ workspaceId: activeWorkspaceId, from: item.id, to }).unwrap()
      toast.success(`Renamed to "${name}"`)
      setRenameOpen(false)
      onItemPathChange?.(to)
    } catch (err) {
      toast.error(`Rename failed`, {
        description: err instanceof Error ? err.message : undefined,
      })
    }
  }

  // Editable text content for text-kind files and notes. `editorValue`
  // is the working copy; when it diverges from `previewText` (the last
  // server-known content for this item) the Save button enables.
  const [editorValue, setEditorValue] = useState<string | null>(null)
  const editorInitFor = useRef<string | null>(null)
  useEffect(() => {
    if (previewText == null) return
    if (editorInitFor.current === item.id) return
    setEditorValue(previewText)
    editorInitFor.current = item.id
  }, [previewText, item.id])

  const isTextEditable =
    (kind === 'text' && item.type === 'file') || item.type === 'note'
  const isDirty = isTextEditable && editorValue != null && editorValue !== previewText

  const [saveLibraryContent, saveState] = useSaveLibraryContentMutation()
  const [savedAt, setSavedAt] = useState<number | null>(null)
  const handleSave = useCallback(async () => {
    if (!activeWorkspaceId || !isDirty || editorValue == null) return
    try {
      await saveLibraryContent({
        workspaceId: activeWorkspaceId,
        path: item.id,
        content: editorValue,
        contentType: item.mimeType || 'text/plain',
      }).unwrap()
      setPreviewText(editorValue)
      setSavedAt(Date.now())
    } catch (err) {
      toast.error(`Save failed: ${item.name}`, {
        description: err instanceof Error ? err.message : undefined,
      })
    }
  }, [activeWorkspaceId, editorValue, isDirty, item.id, item.mimeType, item.name, saveLibraryContent])

  // Auto-save: when the pref is on, debounce a save after the last
  // edit. The Save button stays available as a "save now" affordance.
  const { autoSave } = usePrefs()
  useEffect(() => {
    if (!autoSave || !isDirty || saveState.isLoading) return
    const t = window.setTimeout(handleSave, AUTO_SAVE_DEBOUNCE_MS)
    return () => window.clearTimeout(t)
  }, [autoSave, isDirty, saveState.isLoading, handleSave])

  // Drop the "Saved" badge after a moment so the button reverts to its
  // idle "Save" label.
  useEffect(() => {
    if (savedAt == null) return
    const t = window.setTimeout(() => setSavedAt(null), SAVED_BADGE_TTL_MS)
    return () => window.clearTimeout(t)
  }, [savedAt])

  const showSavedBadge = !isDirty && !saveState.isLoading && savedAt != null
  const saveLabel = saveState.isLoading
    ? 'Saving…'
    : showSavedBadge
    ? 'Saved'
    : 'Save'

  // "Related artifacts" — the server has no explicit artifact-to-context
  // relation yet. We hydrate against the library and filter by the ids
  // the UI already tracks on the item; it's empty for server-backed
  // items today. TODO(api-gap): replace with a first-class relation in
  // matrix §4.2.5 once the server exposes it.
  const { data: libraryResp } = useGetLibraryQuery(
    activeWorkspaceId ? { workspaceId: activeWorkspaceId } : undefined,
    { skip: !activeWorkspaceId },
  )
  const folders = activeWorkspaceId
    ? toFolderList(libraryResp?.folders ?? [], activeWorkspaceId)
    : []
  const libraryArtifacts: Artifact[] = (libraryResp?.items ?? []).map(f => toArtifactFromFile(f, []))
  const relatedArtifacts = libraryArtifacts.filter(a => item.relatedArtifactIds.includes(a.id))
  const FileIcon = iconForItem(item)

  return (
    <div className="flex flex-1 min-h-0 overflow-hidden">
      {/* Main content area — preview */}
      <div className="flex flex-1 flex-col min-w-0 overflow-hidden">
        {/* Header — breadcrumb style */}
        <PageHeader
          breadcrumb={(() => {
            const folderPath = getFolderPath(folders, item.folderId ?? null)
            return (
              <Breadcrumb className="min-w-0 flex-1">
                <BreadcrumbList className="flex-nowrap">
                  <BreadcrumbItem>
                    <BreadcrumbLink asChild>
                      <button
                        onClick={() => onNavigateToFolder(null)}
                        className="text-sm font-semibold text-foreground hover:text-foreground/70 transition-colors"
                      >
                        Library
                      </button>
                    </BreadcrumbLink>
                  </BreadcrumbItem>
                  {folderPath.map((folder) => (
                    <span key={folder.id} className="flex items-center gap-1.5">
                      <BreadcrumbSeparator>
                        <ChevronRight className="h-3.5 w-3.5" />
                      </BreadcrumbSeparator>
                      <BreadcrumbItem>
                        <BreadcrumbLink asChild>
                          <button
                            onClick={() => onNavigateToFolder(folder.id)}
                            className="text-sm font-semibold text-foreground hover:text-foreground/70 transition-colors"
                          >
                            {folder.name}
                          </button>
                        </BreadcrumbLink>
                      </BreadcrumbItem>
                    </span>
                  ))}
                  <BreadcrumbSeparator>
                    <ChevronRight className="h-3.5 w-3.5" />
                  </BreadcrumbSeparator>
                  <BreadcrumbItem className="min-w-0">
                    <BreadcrumbPage className="flex items-center gap-1.5 text-sm font-semibold text-foreground min-w-0">
                      <FileIcon className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                      {item.type === 'note' ? (
                        <span className="truncate">{item.name}</span>
                      ) : (
                        <button
                          onClick={() => { setRenameValue(item.name); setRenameOpen(true) }}
                          className="flex items-center gap-1 min-w-0 group hover:text-foreground/70 transition-colors"
                        >
                          <span className="truncate">{item.name}</span>
                          <Pencil className="h-3 w-3 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity shrink-0" />
                        </button>
                      )}
                    </BreadcrumbPage>
                  </BreadcrumbItem>
                </BreadcrumbList>
              </Breadcrumb>
            )
          })()}
          actions={
            <>
              {isTextEditable && (
                <Button
                  size="sm"
                  variant="outline"
                  className="text-xs"
                  onClick={handleSave}
                  disabled={!isDirty || saveState.isLoading}
                  data-testid="library-save"
                  data-save-state={
                    saveState.isLoading ? 'saving' : showSavedBadge ? 'saved' : isDirty ? 'dirty' : 'idle'
                  }
                >
                  <Save className="h-3.5 w-3.5 mr-1.5" />
                  {saveLabel}
                </Button>
              )}

              <Button
                size="sm"
                className="text-xs"
                onClick={() => onCompose([item])}
              >
                Use in chat
              </Button>

              {item.type === 'file' && (
                <Button variant="outline" size="sm" className="text-xs" onClick={handleDownload}>
                  Download
                </Button>
              )}

              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="icon" className="h-8 w-8">
                    <MoreHorizontal className="h-4 w-4" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-44">
                  {item.type !== 'note' && (
                    <DropdownMenuItem onClick={() => { setRenameValue(item.name); setRenameOpen(true) }}>
                      <Pencil className="h-4 w-4 mr-2" />
                      Rename
                    </DropdownMenuItem>
                  )}
                  <DropdownMenuItem onClick={() => setDeleteDialogOpen(true)}>
                    <Trash2 className="h-4 w-4 mr-2" />
                    Delete
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>

              {panelCollapsed && (
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8"
                  onClick={() => setPanelCollapsed(false)}
                >
                  <PanelRight className="h-4 w-4" />
                </Button>
              )}
            </>
          }
        />

        {/* Preview area */}
        <div className="flex-1 overflow-y-auto bg-muted/20 flex flex-col">
          {item.type === 'note' ? (
            <div className="flex-1 min-h-0 bg-background">
              {editorValue !== null ? (
                <TextFileEditor
                  value={editorValue}
                  onChange={setEditorValue}
                  filename={item.name}
                  mimeType={item.mimeType}
                />
              ) : (
                <div className="flex items-center justify-center py-12">
                  <p className="text-sm text-muted-foreground">
                    {previewError ? `Failed to load: ${previewError}` : 'Loading…'}
                  </p>
                </div>
              )}
            </div>
          ) : item.type === 'link' ? (
            (() => {
              // Link entries are stored in the host OS's native shortcut
              // format (.url INI on Windows, .webloc plist on macOS,
              // .desktop on Linux). All three embed an http(s) URL —
              // pull the first such substring out as the target.
              const linkUrl =
                previewText?.match(/https?:\/\/\S+?(?=[\s<"']|$)/)?.[0] ?? ''
              return (
                <div className="flex flex-col h-full">
                  {/* Link preview bar */}
                  <div className="flex items-center gap-2 border-b bg-background px-4 py-2">
                    <Link2 className="h-3.5 w-3.5 text-muted-foreground" />
                    {linkUrl ? (
                      <a
                        href={linkUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-xs text-blue-600 hover:underline flex items-center gap-1 truncate"
                      >
                        {linkUrl}
                        <ExternalLink className="h-3 w-3 shrink-0" />
                      </a>
                    ) : (
                      <span className="text-xs text-muted-foreground">
                        {previewError ? `Failed to load link: ${previewError}` : 'Loading…'}
                      </span>
                    )}
                  </div>
                  <div className="flex-1 flex items-center justify-center">
                    <div className="text-center">
                      <div className="mb-4 flex h-16 w-16 mx-auto items-center justify-center rounded-2xl bg-blue-500/10">
                        <Link2 className="h-8 w-8 text-blue-500/40" />
                      </div>
                      <h3 className="text-base font-semibold mb-1">{item.name}</h3>
                      {linkUrl ? (
                        <a
                          href={linkUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-1.5 text-sm text-blue-600 hover:underline"
                        >
                          Open in browser
                          <ExternalLink className="h-3.5 w-3.5" />
                        </a>
                      ) : (
                        <p className="text-sm text-muted-foreground">
                          {previewError ? `Failed to load link: ${previewError}` : 'Loading…'}
                        </p>
                      )}
                    </div>
                  </div>
                </div>
              )
            })()
          ) : kind === 'pdf' ? (
            <div className="flex-1 flex flex-col bg-muted/30">
              {previewBlobUrl ? (
                <iframe
                  title={item.name}
                  src={previewBlobUrl}
                  className="flex-1 w-full border-0 bg-white"
                />
              ) : (
                <div className="flex-1 flex items-center justify-center">
                  <p className="text-sm text-muted-foreground">
                    {previewError ? `Failed to load PDF: ${previewError}` : 'Loading PDF…'}
                  </p>
                </div>
              )}
            </div>
          ) : kind === 'html' || kind === 'docx' ? (
            <div className="flex-1 flex flex-col bg-white">
              {previewBlobUrl ? (
                <iframe
                  title={item.name}
                  src={previewBlobUrl}
                  sandbox="allow-same-origin"
                  className="flex-1 w-full border-0 bg-white"
                />
              ) : (
                <div className="flex-1 flex items-center justify-center">
                  <p className="text-sm text-muted-foreground">
                    {previewError ? `Failed to load: ${previewError}` : 'Loading…'}
                  </p>
                </div>
              )}
            </div>
          ) : kind === 'image' && !mediaLoadFailed ? (
            <div className="flex-1 flex items-center justify-center bg-zinc-800 overflow-auto">
              {previewBlobUrl ? (
                <img
                  src={previewBlobUrl}
                  alt={item.name}
                  className="max-w-full max-h-full object-contain"
                  onError={() => setMediaLoadFailed(true)}
                />
              ) : (
                <p className="text-sm text-muted-foreground">
                  {previewError ? `Failed to load image: ${previewError}` : 'Loading image…'}
                </p>
              )}
            </div>
          ) : kind === 'video' && !mediaLoadFailed ? (
            <div className="flex-1 flex items-center justify-center bg-zinc-900 overflow-auto">
              {previewBlobUrl ? (
                <video
                  src={previewBlobUrl}
                  controls
                  className="max-w-full max-h-full"
                  onError={() => setMediaLoadFailed(true)}
                />
              ) : (
                <p className="text-sm text-muted-foreground">
                  {previewError ? `Failed to load video: ${previewError}` : 'Loading video…'}
                </p>
              )}
            </div>
          ) : kind === 'audio' && !mediaLoadFailed ? (
            <div className="flex-1 flex items-center justify-center px-6">
              {previewBlobUrl ? (
                <audio
                  src={previewBlobUrl}
                  controls
                  className="w-full max-w-lg"
                  onError={() => setMediaLoadFailed(true)}
                />
              ) : (
                <p className="text-sm text-muted-foreground">
                  {previewError ? `Failed to load audio: ${previewError}` : 'Loading audio…'}
                </p>
              )}
            </div>
          ) : kind === 'text' && item.type === 'file' ? (
            <div className="flex-1 min-h-0 bg-background">
              {editorValue !== null ? (
                <TextFileEditor
                  value={editorValue}
                  onChange={setEditorValue}
                  filename={item.name}
                  mimeType={item.mimeType}
                />
              ) : (
                <div className="flex items-center justify-center py-12">
                  <p className="text-sm text-muted-foreground">
                    {previewError ? `Failed to load file: ${previewError}` : 'Loading…'}
                  </p>
                </div>
              )}
            </div>
          ) : (
            /* No in-app preview — offer a download instead. */
            <div className="flex-1 flex items-center justify-center min-h-0">
              <div className="text-center max-w-xs px-4">
                <div className="mb-5 flex h-16 w-16 mx-auto items-center justify-center rounded-2xl bg-muted/50">
                  <FileIcon className="h-8 w-8 text-muted-foreground/40" />
                </div>
                <p className="text-sm font-medium text-muted-foreground mb-4">
                  {mediaLoadFailed
                    ? "Your browser can't display this file inline"
                    : 'Preview not available for this file type'}
                </p>
                {item.type === 'file' && (
                  <Button size="sm" variant="outline" className="text-xs" onClick={handleDownload}>
                    <Download className="h-3.5 w-3.5 mr-1.5" />
                    Download
                  </Button>
                )}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Right panel — conversation + details */}
      <div className={`hidden lg:flex shrink-0 transition-all duration-300 overflow-hidden ${panelCollapsed ? 'w-0' : 'w-[380px]'}`}>
        <ConversationPanel
          initialMessages={[]}
          item={item}
          onCollapse={() => setPanelCollapsed(true)}
        />
      </div>

      {/* Delete confirmation dialog */}
      <AlertDialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete "{item.name}"?</AlertDialogTitle>
            <AlertDialogDescription>
              {relatedArtifacts.length > 0 ? (
                <>
                  This item was used to create {relatedArtifacts.length} {relatedArtifacts.length === 1 ? 'artifact' : 'artifacts'} in your Desk:
                  <span className="block mt-2 space-y-1">
                    {relatedArtifacts.map(a => (
                      <span key={a.id} className="flex items-center gap-2 text-foreground">
                        {(() => { const Icon = getArtifactIcon(a.type); return <Icon className="h-3.5 w-3.5 text-muted-foreground shrink-0" /> })()}
                        <span className="font-medium">{a.name}</span>
                      </span>
                    ))}
                  </span>
                  <span className="block mt-2">
                    Those artifacts will remain in your Desk, but they will no longer reference this file as context.
                  </span>
                </>
              ) : (
                'This item is not used by any artifacts. It will be permanently removed from your context.'
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              disabled={deleteState.isLoading}
              onClick={(e) => { e.preventDefault(); void handleDelete() }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Rename dialog */}
      <Dialog
        open={renameOpen}
        onOpenChange={(open) => {
          setRenameOpen(open)
          if (!open) setRenameValue(item.name)
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Rename {item.type === 'link' ? 'link' : 'file'}</DialogTitle>
            <DialogDescription>
              Give the {item.type === 'link' ? 'link' : 'file'} a new name. Include the extension.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2 py-2">
            <label className="text-sm font-medium text-foreground">Name</label>
            <Input
              value={renameValue}
              onChange={(e) => setRenameValue(e.target.value)}
              autoFocus
              onKeyDown={(e) => {
                if (e.key === 'Enter') void handleRename()
              }}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRenameOpen(false)}>Cancel</Button>
            <Button
              disabled={
                !renameValue.trim() ||
                renameValue.trim() === item.name ||
                moveState.isLoading
              }
              onClick={() => void handleRename()}
            >
              Rename
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
