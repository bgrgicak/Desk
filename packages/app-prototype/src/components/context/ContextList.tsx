import { useEffect, useMemo, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import {
  Upload,
  PenLine,
  FilePlus,
  FolderOpen,
  Folder as FolderIcon,
  FolderPlus,
  Search,
  LayoutGrid,
  LayoutList,
  MessageSquarePlus,
  MoreHorizontal,
  Download,
  Trash2,
  ChevronDown,
  ChevronRight,
  Sparkles,
  Shapes,
  FileText,
  StickyNote,
  Link2,
  EyeOff,
  type LucideIcon,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { PageHeader } from '@/components/layout/PageHeader'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '@/components/ui/breadcrumb'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/components/ui/context-menu'
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
import type { ContextItem, Folder } from '@/data/ui-types'
import {
  getRelativeTime,
  getFolderById,
  getFolderPath,
  getChildFolders,
  getItemsInFolder,
  countItemsRecursive,
} from '@/data/ui-types'
import { useParams, useSearchParams } from 'react-router-dom'
import {
  useCreateLibraryFolderMutation,
  useCreateLibraryLinkMutation,
  useDeleteLibraryFileMutation,
  useGetLibraryQuery,
  useMoveLibraryEntryMutation,
  useUploadLibraryFileMutation,
} from '@/store/api'
import { downloadLibraryFile } from '@/store/library-download'
import { FileDropZone, type UploadEntry } from '@/components/upload/FileDropZone'
import { toContextItem, toFolderList } from '@/store/selectors/library'
import { LibraryCard } from '@/components/library/LibraryCard'
import { ArtifactCreationSheet, type ArtifactCreateInput } from '@/components/artifact/ArtifactCreationSheet'
import { toast } from 'sonner'
import { usePersistedState } from '@/hooks/use-persisted-state'
import { usePrefs } from '@/hooks/use-prefs'

interface ContextListProps {
  items: ContextItem[]
  onItemClick: (item: ContextItem) => void
  onCompose: (attachedItems?: ContextItem[]) => void
  onPinItem?: (item: ContextItem) => void
  onUnpinItem?: (item: ContextItem) => void
  onCreateArtifact?: (input: ArtifactCreateInput) => Promise<void>
  onSkipToChat?: (agentId?: string) => Promise<void>
}

type ViewMode = 'list' | 'grid'
type TypeFilter = 'all' | 'folder' | 'file' | 'link' | 'note' | 'hidden'
type ByFilter = 'all' | 'me' | 'ai'

const TYPE_FILTERS: { value: TypeFilter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'folder', label: 'Folders' },
  { value: 'file', label: 'Files' },
  { value: 'note', label: 'Notes' },
  { value: 'link', label: 'Links' },
]

const BY_FILTERS: { value: ByFilter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'me', label: 'By me' },
  { value: 'ai', label: 'By AI' },
]

const TYPE_FILTER_ICONS: Record<TypeFilter, LucideIcon> = {
  all: Shapes,
  folder: FolderIcon,
  file: FileText,
  note: StickyNote,
  link: Link2,
  hidden: EyeOff,
}

// Dev-only filter: surfaces dot-prefixed library entries the server hides
// from normal listings (agent artifacts, `.opencode/`, drafts, etc.).
const HIDDEN_FILTER: { value: TypeFilter; label: string } = { value: 'hidden', label: 'Hidden' }

/** True when any path segment starts with `.` — matches the server's
 *  hidden-skip rule (search.ts) so we can locally separate hidden entries
 *  from the showHidden=true superset returned by the API. */
function isHiddenPath(p: string): boolean {
  return p.split('/').some(seg => seg.startsWith('.'))
}

export function ContextList({ items, onItemClick, onCompose, onPinItem, onUnpinItem, onCreateArtifact, onSkipToChat }: ContextListProps) {
  const [searchQuery, setSearchQuery] = useState('')
  const [typeFilter, setTypeFilter] = usePersistedState<TypeFilter>('desk.context.typeFilter', 'all')
  const [byFilter, setByFilter] = usePersistedState<ByFilter>('desk.context.byFilter', 'all')
  const [viewMode, setViewMode] = usePersistedState<ViewMode>('desk.context.viewMode', 'list')
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())

  const { developerMode, loaded: prefsLoaded } = usePrefs()
  // Reset the persisted 'hidden' filter when developer mode flips off — the
  // chip wouldn't render and the user would otherwise see an empty list with
  // no obvious way back. Wait for prefs to actually load: on first paint the
  // user query hasn't resolved yet, so `developerMode` is the default `false`
  // and would otherwise clobber a persisted 'hidden' selection.
  useEffect(() => {
    if (!prefsLoaded) return
    if (!developerMode && typeFilter === 'hidden') setTypeFilter('all')
  }, [prefsLoaded, developerMode, typeFilter, setTypeFilter])
  const isHiddenMode = developerMode && typeFilter === 'hidden'
  const filterChips = useMemo(
    () => (developerMode ? [...TYPE_FILTERS, HIDDEN_FILTER] : TYPE_FILTERS),
    [developerMode],
  )

  const { wsId: activeWorkspaceId } = useParams<{ wsId: string }>()
  // Folder selection lives in the URL (?folder=<workspace-relative-path>) so
  // it survives unmount/remount when the user opens a file detail and comes
  // back, and so breadcrumb links in the detail view can jump straight to a
  // specific folder.
  const [searchParams, setSearchParams] = useSearchParams()
  const currentFolderId = searchParams.get('folder') || null
  const [uploadLibraryFile, uploadState] = useUploadLibraryFileMutation()
  const [deleteLibraryFile] = useDeleteLibraryFileMutation()
  const [createLibraryFolder] = useCreateLibraryFolderMutation()
  const [createLibraryLink] = useCreateLibraryLinkMutation()
  const [moveLibraryEntry] = useMoveLibraryEntryMutation()
  // Hidden mode pulls the showHidden=true superset directly so we can render
  // dot-prefixed entries that the parent's items prop excludes by default.
  const { data: libraryResp } = useGetLibraryQuery(
    activeWorkspaceId
      ? { workspaceId: activeWorkspaceId, ...(isHiddenMode ? { showHidden: true } : {}) }
      : undefined,
    { skip: !activeWorkspaceId },
  )

  const effectiveItems: ContextItem[] = useMemo(() => {
    if (!isHiddenMode) return items
    if (!activeWorkspaceId) return []
    return (libraryResp?.items ?? [])
      .filter(f => isHiddenPath(f.path))
      .map(f => toContextItem(f, activeWorkspaceId))
  }, [isHiddenMode, items, libraryResp, activeWorkspaceId])

  /**
   * Delete dialog targets can be files/notes (ContextItem) or folders.
   * Both funnel through DELETE /library?path=..., so we only need the
   * path and a display name.
   */
  type DeleteTarget = { path: string; name: string; kind: 'item' | 'folder' }
  const [deleteTargets, setDeleteTargets] = useState<DeleteTarget[] | null>(null)
  const [renameTarget, setRenameTarget] = useState<Folder | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [moveTargets, setMoveTargets] = useState<
    Array<{ path: string; name: string; kind: 'item' | 'folder' }> | null
  >(null)

  const handleDownload = async (item: ContextItem) => {
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

  const confirmDelete = async () => {
    if (!activeWorkspaceId || !deleteTargets) return
    const targets = deleteTargets
    setDeleteTargets(null)
    const results = await Promise.allSettled(
      targets.map(t =>
        deleteLibraryFile({ workspaceId: activeWorkspaceId, path: t.path }).unwrap(),
      ),
    )
    const failed = results.filter(r => r.status === 'rejected').length
    if (failed === 0) {
      toast.success(
        targets.length === 1 ? `Deleted ${targets[0].name}` : `Deleted ${targets.length} items`,
      )
    } else {
      toast.error(`Failed to delete ${failed} of ${targets.length} items`)
    }
    clearSelection()
  }

  /**
   * Folder ids ARE workspace-root-relative paths — turning one into the
   * server's `subpath` is a no-op, save for treating a null selection
   * (the library root) as `""`.
   */
  const subpathFromFolderId = (folderId: string | null): string => folderId ?? ''

  const handleUpload = async (entries: UploadEntry[]) => {
    if (!activeWorkspaceId) {
      toast.error('Pick a workspace before uploading')
      return
    }
    const basePath = subpathFromFolderId(currentFolderId)
    for (const { file, relativePath } of entries) {
      // The relativePath keeps the folder structure from the drop/pick;
      // the filename is already in file.name, so we only pass the
      // directory portion as the subpath.
      const relDir = relativePath.includes('/')
        ? relativePath.slice(0, relativePath.lastIndexOf('/'))
        : ''
      const subpath = [basePath, relDir].filter(Boolean).join('/')
      try {
        await uploadLibraryFile({
          workspaceId: activeWorkspaceId,
          file,
          subpath: subpath || undefined,
        }).unwrap()
      } catch (err) {
        // RTK Query rejects with `{ status, data }` from fetchBaseQuery —
        // not an Error — so reach into `data` for the server's message.
        const data = (err as { data?: { message?: string } } | undefined)?.data
        const status = (err as { status?: number | string } | undefined)?.status
        const description = data?.message ?? (status !== undefined ? `HTTP ${status}` : undefined)
        toast.error(`Upload failed: ${relativePath}`, { description })
      }
    }
    // A single toast for the batch — one-per-file is noisy on folder drops.
    toast.success(
      entries.length === 1
        ? `Uploaded ${entries[0].file.name}`
        : `Uploaded ${entries.length} files`,
    )
  }

  const handleCreateFolder = async () => {
    const name = newFolderName.trim()
    if (!name || !activeWorkspaceId) return
    const base = subpathFromFolderId(currentFolderId)
    const subpath = base ? `${base}/${name}` : name
    try {
      await createLibraryFolder({ workspaceId: activeWorkspaceId, path: subpath }).unwrap()
      toast.success(`Folder "${name}" created`)
    } catch (err) {
      toast.error(`Failed to create folder`, {
        description: err instanceof Error ? err.message : undefined,
      })
    }
    setFolderDialogOpen(false)
    setNewFolderName('')
  }

  const handleRenameFolder = async () => {
    if (!renameTarget || !activeWorkspaceId) return
    const name = renameValue.trim()
    if (!name || name === renameTarget.name) {
      setRenameTarget(null)
      return
    }
    const parentPath = renameTarget.parentId ?? ''
    const to = parentPath ? `${parentPath}/${name}` : name
    try {
      await moveLibraryEntry({
        workspaceId: activeWorkspaceId,
        from: renameTarget.id,
        to,
      }).unwrap()
      toast.success(`Renamed to "${name}"`)
    } catch (err) {
      toast.error(`Rename failed`, {
        description: err instanceof Error ? err.message : undefined,
      })
    }
    setRenameTarget(null)
  }

  const handleMoveToFolder = async (destFolderId: string | null) => {
    if (!moveTargets || !activeWorkspaceId) return
    const destDir = destFolderId ?? ''
    const targets = moveTargets
    setMoveTargets(null)
    const results = await Promise.allSettled(
      targets.map((t) =>
        moveLibraryEntry({
          workspaceId: activeWorkspaceId,
          from: t.path,
          to: destDir ? `${destDir}/${t.name}` : t.name,
        }).unwrap(),
      ),
    )
    const failed = results.filter((r) => r.status === 'rejected').length
    if (failed === 0) {
      toast.success(
        targets.length === 1 ? `Moved ${targets[0].name}` : `Moved ${targets.length} items`,
      )
    } else {
      toast.error(`Failed to move ${failed} of ${targets.length} items`)
    }
    clearSelection()
  }

  // Artifact creation sheet
  const [createSheetOpen, setCreateSheetOpen] = useState(false)

  // New folder dialog
  const [folderDialogOpen, setFolderDialogOpen] = useState(false)
  const [newFolderName, setNewFolderName] = useState('')

  // Create blank file dialog
  const [createFileDialogOpen, setCreateFileDialogOpen] = useState(false)
  const [newFileName, setNewFileName] = useState('')

  // Paste link dialog — name is optional; falls back to the URL hostname.
  const [pasteLinkDialogOpen, setPasteLinkDialogOpen] = useState(false)
  const [linkUrl, setLinkUrl] = useState('')
  const [linkName, setLinkName] = useState('')

  const handleCreateLink = async () => {
    const url = linkUrl.trim()
    if (!url || !activeWorkspaceId) return
    const subpath = subpathFromFolderId(currentFolderId)
    try {
      await createLibraryLink({
        workspaceId: activeWorkspaceId,
        url,
        name: linkName.trim() || undefined,
        subpath: subpath || undefined,
      }).unwrap()
      toast.success(`Link added`)
      setPasteLinkDialogOpen(false)
      setLinkUrl('')
      setLinkName('')
    } catch (err) {
      const data = (err as { data?: { message?: string } } | undefined)?.data
      const status = (err as { status?: number | string } | undefined)?.status
      const description = data?.message ?? (status !== undefined ? `HTTP ${status}` : undefined)
      toast.error(`Failed to add link`, { description })
    }
  }

  const handleCreateFile = async () => {
    const name = newFileName.trim()
    if (!name || !activeWorkspaceId) return
    const subpath = subpathFromFolderId(currentFolderId)
    const blob = new File([''], name, { type: 'application/octet-stream' })
    try {
      await uploadLibraryFile({
        workspaceId: activeWorkspaceId,
        file: blob,
        subpath: subpath || undefined,
      }).unwrap()
      toast.success(`Created ${name}`)
    } catch (err) {
      const data = (err as { data?: { message?: string } } | undefined)?.data
      const status = (err as { status?: number | string } | undefined)?.status
      const description = data?.message ?? (status !== undefined ? `HTTP ${status}` : undefined)
      toast.error(`Failed to create file`, { description })
    }
    setCreateFileDialogOpen(false)
    setNewFileName('')
  }

  // Folders come from the server's recursive library listing; the
  // selector maps each FolderRef to a UI Folder whose `id` is the
  // workspace-relative path so navigation and filtering just work.
  const folders = activeWorkspaceId
    ? toFolderList(libraryResp?.folders ?? [], activeWorkspaceId)
    : []

  const currentFolder = getFolderById(folders, currentFolderId)
  const breadcrumbPath = getFolderPath(folders, currentFolderId)
  const isInsideFolder = currentFolder != null

  // Get folders + items in current location
  const childFolders = getChildFolders(folders, currentFolderId)
  const folderItems = getItemsInFolder(currentFolderId, effectiveItems)

  // Apply filters. Hidden mode is its own slice — surfaces every dot-prefixed
  // entry (file or folder) regardless of mime kind, so the user can also
  // navigate into hidden subtrees like `.opencode/`.
  // Authorship filter narrows to user-uploaded vs AI-created items. Folders
  // don't carry authorship metadata, so they're hidden whenever the filter is
  // active — otherwise they'd misleadingly appear in a "By me" / "By AI" view.
  const showFolders =
    (typeFilter === 'all' || typeFilter === 'folder' || typeFilter === 'hidden') &&
    byFilter === 'all'
  const filteredFolders = showFolders
    ? childFolders
        .filter(f => !isHiddenMode || isHiddenPath(f.id))
        .filter(f => !searchQuery || f.name.toLowerCase().includes(searchQuery.toLowerCase()))
    : []

  const filteredItems = folderItems
    .filter(i => typeFilter === 'all' || typeFilter === 'hidden' || typeFilter === i.type)
    .filter(() => typeFilter !== 'folder')
    .filter(i => byFilter === 'all' || (byFilter === 'ai' ? i.uploadedBy === 'ai' : i.uploadedBy === 'user'))
    .filter(i => !searchQuery || i.name.toLowerCase().includes(searchQuery.toLowerCase()))
    .sort((a, b) => b.addedAt.getTime() - a.addedAt.getTime())

  // Combine for display: folders first, then items
  const totalCount = filteredFolders.length + filteredItems.length

  const selectAllState: boolean | 'indeterminate' =
    selectedIds.size === 0 ? false
    : selectedIds.size === totalCount ? true
    : 'indeterminate'

  const toggleSelect = (id: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const toggleSelectAll = () => {
    const allIds = [...filteredFolders.map(f => f.id), ...filteredItems.map(i => i.id)]
    if (selectedIds.size === allIds.length) {
      setSelectedIds(new Set())
    } else {
      setSelectedIds(new Set(allIds))
    }
  }

  const clearSelection = () => setSelectedIds(new Set())

  const selectedItems = items.filter(i => selectedIds.has(i.id))
  // Bulk actions that funnel through /library (move, delete) apply to
  // folders too — build a flat target list from both folders and items.
  const selectedTargets: Array<{ path: string; name: string; kind: 'item' | 'folder' }> = [
    ...folders
      .filter(f => selectedIds.has(f.id))
      .map(f => ({ path: f.id, name: f.name, kind: 'folder' as const })),
    ...selectedItems.map(i => ({ path: i.id, name: i.name, kind: 'item' as const })),
  ]
  const hasSelection = selectedIds.size > 0

  const navigateToFolder = (folderId: string | null) => {
    setSearchParams(prev => {
      const next = new URLSearchParams(prev)
      if (folderId) next.set('folder', folderId)
      else next.delete('folder')
      return next
    })
    clearSelection()
    setSearchQuery('')
    // Don't reset the type filter on navigation — it's a persisted user
    // choice. Forcing it back to 'all' (and writing 'all' to localStorage)
    // makes any chosen filter feel like it randomly drops itself.
  }

  // Compose with the entire current folder's contents
  const handleAddFolderToChat = () => {
    if (!currentFolder) return
    onCompose(folderItems)
  }

  return (
    <FileDropZone
      onFiles={handleUpload}
      disabled={!activeWorkspaceId || uploadState.isLoading}
      overlayLabel={activeWorkspaceId ? 'Drop to add to Library' : 'Pick a workspace first'}
      className="flex flex-1 flex-col min-h-0 overflow-hidden"
      directory
    >
      {({ openPicker, openDirectoryPicker }) => (
        <div className="flex flex-1 flex-col min-h-0 overflow-hidden">

      {/* ── Header bar ── */}
      <PageHeader
        breadcrumb={
          <Breadcrumb className="shrink-0">
            <BreadcrumbList>
              <BreadcrumbItem>
                {currentFolderId ? (
                  <BreadcrumbLink asChild>
                    <button
                      onClick={() => navigateToFolder(null)}
                      className="text-sm font-semibold text-foreground hover:text-foreground/70 transition-colors"
                    >
                      Library
                    </button>
                  </BreadcrumbLink>
                ) : (
                  <BreadcrumbPage className="text-sm font-semibold text-foreground">Library</BreadcrumbPage>
                )}
              </BreadcrumbItem>
              {breadcrumbPath.map((folder, idx) => {
                const isLast = idx === breadcrumbPath.length - 1
                return (
                  <span key={folder.id} className="flex items-center gap-1.5">
                    <BreadcrumbSeparator><ChevronRight className="h-3.5 w-3.5" /></BreadcrumbSeparator>
                    <BreadcrumbItem>
                      {isLast ? (
                        <BreadcrumbPage className="text-sm font-semibold text-foreground">{folder.name}</BreadcrumbPage>
                      ) : (
                        <BreadcrumbLink asChild>
                          <button
                            onClick={() => navigateToFolder(folder.id)}
                            className="text-sm font-semibold text-foreground hover:text-foreground/70 transition-colors"
                          >
                            {folder.name}
                          </button>
                        </BreadcrumbLink>
                      )}
                    </BreadcrumbItem>
                  </span>
                )
              })}
            </BreadcrumbList>
          </Breadcrumb>
        }
        actions={<div className="flex items-center gap-2">
          {/* Authorship filter pills */}
          <div className="flex items-center rounded-lg border p-0.5">
            {BY_FILTERS.map(f => (
              <button
                key={f.value}
                onClick={() => setByFilter(f.value)}
                className={`rounded-md px-3 py-1 text-xs font-medium transition-colors ${
                  byFilter === f.value
                    ? 'bg-muted text-foreground'
                    : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                {f.label}
              </button>
            ))}
          </div>

          {/* Type dropdown */}
          {(() => {
            const TypeIcon = TYPE_FILTER_ICONS[typeFilter]
            const currentLabel = typeFilter === 'all' ? 'All' : filterChips.find(f => f.value === typeFilter)?.label ?? 'All'
            return (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button
                    type="button"
                    data-testid="library-type-filter"
                    className="flex items-center gap-1.5 h-8 rounded-md border px-2.5 text-xs font-medium hover:bg-accent/30 transition-colors"
                  >
                    <TypeIcon className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                    <span className="text-muted-foreground">{currentLabel}</span>
                    <ChevronDown className="h-3 w-3 text-muted-foreground shrink-0" />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="w-40">
                  {filterChips.map(f => {
                    const FIcon = TYPE_FILTER_ICONS[f.value]
                    return (
                      <DropdownMenuItem key={f.value} onSelect={() => setTypeFilter(f.value)}>
                        <FIcon className="h-4 w-4 text-muted-foreground" />
                        {f.label}
                      </DropdownMenuItem>
                    )
                  })}
                </DropdownMenuContent>
              </DropdownMenu>
            )
          })()}

          {/* Search */}
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search..."
              className="h-8 w-40 rounded-md border bg-background pl-8 pr-3 text-xs outline-none placeholder:text-muted-foreground/60 focus:ring-2 focus:ring-ring/20 focus:border-ring/40 transition-all"
            />
          </div>

          {/* View toggle */}
          <div className="flex items-center rounded-lg border p-0.5">
            <button onClick={() => setViewMode('list')} className={`rounded-md p-1.5 transition-colors ${viewMode === 'list' ? 'bg-muted text-foreground' : 'text-muted-foreground hover:text-foreground'}`}>
              <LayoutList className="h-3.5 w-3.5" />
            </button>
            <button onClick={() => setViewMode('grid')} className={`rounded-md p-1.5 transition-colors ${viewMode === 'grid' ? 'bg-muted text-foreground' : 'text-muted-foreground hover:text-foreground'}`}>
              <LayoutGrid className="h-3.5 w-3.5" />
            </button>
          </div>

          {/* Use in chat — only inside a folder */}
          {isInsideFolder && (
            <Button size="sm" variant="outline" className="text-xs" onClick={handleAddFolderToChat}>
              Use in chat
            </Button>
          )}

          {/* Add dropdown */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="sm" variant="default" className="gap-1.5 text-xs" data-testid="library-add-button">
                Add
                <ChevronDown className="h-3 w-3 ml-0.5" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-44">
              {onCreateArtifact && (
                <>
                  <DropdownMenuItem onSelect={() => setCreateSheetOpen(true)} data-testid="library-create-ai-artifact"><Sparkles className="h-4 w-4 mr-2" />AI artifact</DropdownMenuItem>
                  <DropdownMenuSeparator />
                </>
              )}
              <DropdownMenuItem onSelect={() => setCreateFileDialogOpen(true)} data-testid="library-create-file"><FilePlus className="h-4 w-4 mr-2" />New file</DropdownMenuItem>
              <DropdownMenuItem onSelect={() => setFolderDialogOpen(true)} data-testid="library-create-folder"><FolderPlus className="h-4 w-4 mr-2" />New folder</DropdownMenuItem>
              <DropdownMenuItem onSelect={() => setPasteLinkDialogOpen(true)} data-testid="library-paste-link"><Link2 className="h-4 w-4 mr-2" />New link</DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={openPicker} data-testid="library-upload-choose-file"><Upload className="h-4 w-4 mr-2" />Upload file</DropdownMenuItem>
              <DropdownMenuItem onSelect={openDirectoryPicker} data-testid="library-upload-choose-folder"><FolderPlus className="h-4 w-4 mr-2" />Upload folder</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>}
      />

      {/* ── Body ── */}
      <ContextMenu>
      <ContextMenuTrigger asChild>
      <div className="flex flex-col flex-1 min-h-0 overflow-hidden">
      <div className="flex-1 overflow-y-auto px-4 py-3">
        {totalCount === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 text-center">
            <div className="mb-4">
              {isInsideFolder
                ? <FolderOpen className="h-10 w-10 text-muted-foreground/40" />
                : <FolderIcon className="h-10 w-10 text-muted-foreground/40" />
              }
            </div>
            <p className="text-sm font-medium text-foreground mb-1">
              {isInsideFolder ? 'This folder is empty' : 'Nothing yet'}
            </p>
            <p className="text-xs text-muted-foreground mb-4">
              {searchQuery ? 'Try a different search.' : 'Add a new item or adjust your filters'}
            </p>
            {!searchQuery && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button size="sm" className="gap-1.5">
                    Add
                    <ChevronDown className="h-3 w-3 ml-0.5" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="center" className="w-44">
                  {onCreateArtifact && (
                    <>
                      <DropdownMenuItem onSelect={() => setCreateSheetOpen(true)}><Sparkles className="h-4 w-4 mr-2" />AI artifact</DropdownMenuItem>
                      <DropdownMenuSeparator />
                    </>
                  )}
                  <DropdownMenuItem onSelect={() => setCreateFileDialogOpen(true)}><FilePlus className="h-4 w-4 mr-2" />New file</DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => setFolderDialogOpen(true)}><FolderPlus className="h-4 w-4 mr-2" />New folder</DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => setPasteLinkDialogOpen(true)}><Link2 className="h-4 w-4 mr-2" />New link</DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onSelect={openPicker} data-testid="library-upload-choose-file-empty"><Upload className="h-4 w-4 mr-2" />Upload file</DropdownMenuItem>
                  <DropdownMenuItem onSelect={openDirectoryPicker}><FolderPlus className="h-4 w-4 mr-2" />Upload folder</DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </div>
        ) : viewMode === 'list' ? (
          /* ─── List view ─── */
          <div>
            {/* Column headers */}
            <div className="flex items-center gap-3 px-3 py-1.5 mb-1">
              <Checkbox
                checked={selectAllState}
                onCheckedChange={toggleSelectAll}
                className="h-4 w-4"
              />
              <span className="text-xs text-muted-foreground font-medium flex-1">Name</span>
              <span className="text-xs text-muted-foreground font-medium w-20 text-right">Type</span>
              <span className="text-xs text-muted-foreground font-medium w-20 text-right">Added</span>
              <span className="w-[140px] ml-10 shrink-0 text-xs text-muted-foreground font-medium text-right">Actions</span>
            </div>
            <div className="space-y-0.5">
              {/* Folders */}
              {filteredFolders.map((folder, i) => {
                const isSelected = selectedIds.has(folder.id)
                const itemCount = countItemsRecursive(folders, folder.id, items)
                return (
                  <motion.div
                    key={folder.id}
                    initial={{ opacity: 0, y: 5 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: i * 0.02 }}
                    className={`flex items-center gap-3 rounded-lg px-3 py-2.5 transition-colors group cursor-pointer ${
                      isSelected ? 'bg-primary/5 border border-primary/10' : 'hover:bg-muted/50 border border-transparent'
                    }`}
                  >
                    <Checkbox
                      checked={isSelected}
                      onCheckedChange={() => toggleSelect(folder.id)}
                      className="h-4 w-4"
                      onClick={(e) => e.stopPropagation()}
                    />
                    <div
                      className="flex items-center gap-3 flex-1 min-w-0"
                      onClick={() => navigateToFolder(folder.id)}
                    >
                      <FolderIcon className="h-4 w-4 text-muted-foreground shrink-0 fill-muted-foreground/20" />
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium text-foreground truncate">{folder.name}</p>
                        <p className="text-xs text-muted-foreground">
                          {itemCount} {itemCount === 1 ? 'item' : 'items'}
                        </p>
                      </div>
                    </div>
                    <span className="text-xs text-muted-foreground shrink-0 w-20 text-right capitalize">
                      Folder
                    </span>
                    <span className="text-xs text-muted-foreground shrink-0 w-20 text-right">
                      {getRelativeTime(folder.createdAt)}
                    </span>
                    <div className="flex items-center gap-1 justify-end shrink-0 w-[140px] ml-10">
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7 text-xs opacity-0 group-hover:opacity-100 transition-opacity"
                        onClick={(e) => {
                          e.stopPropagation()
                          onCompose(getItemsInFolder(folder.id, items))
                        }}
                      >
                        Use in chat
                      </Button>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="icon" className="h-7 w-7" onClick={(e) => e.stopPropagation()}>
                            <MoreHorizontal className="h-3.5 w-3.5" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" className="w-40">
                          <DropdownMenuItem onClick={() => onCompose(getItemsInFolder(folder.id, items))}>
                            <MessageSquarePlus className="h-4 w-4 mr-2" />
                            Use in chat
                          </DropdownMenuItem>
                          <DropdownMenuItem onClick={() => { setRenameTarget(folder); setRenameValue(folder.name) }}>
                            <PenLine className="h-4 w-4 mr-2" />
                            Rename
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            onClick={() => setMoveTargets([{ path: folder.id, name: folder.name, kind: 'folder' }])}
                          >
                            <FolderPlus className="h-4 w-4 mr-2" />
                            Move to folder
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem
                            onClick={() => setDeleteTargets([{ path: folder.id, name: folder.name, kind: 'folder' }])}
                          >
                            <Trash2 className="h-4 w-4 mr-2" />
                            Delete
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>
                  </motion.div>
                )
              })}

              {/* Items */}
              {filteredItems.map((item, i) => (
                <LibraryCard
                  key={item.id}
                  item={item}
                  layout="list"
                  index={filteredFolders.length + i}
                  selected={selectedIds.has(item.id)}
                  onSelectChange={() => toggleSelect(item.id)}
                  onClick={() => onItemClick(item)}
                  onUseInChat={() => onCompose([item])}
                  onDownload={() => handleDownload(item)}
                  onMove={() => setMoveTargets([{ path: item.id, name: item.name, kind: 'item' }])}
                  onDelete={() => setDeleteTargets([{ path: item.id, name: item.name, kind: 'item' }])}
                  isPinned={item.pinned}
                  onPin={onPinItem ? () => onPinItem(item) : undefined}
                  onUnpin={onUnpinItem ? () => onUnpinItem(item) : undefined}
                  isDraggable={!!onPinItem}
                />
              ))}
            </div>
          </div>
        ) : (
          /* ─── Grid view ─── */
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-3 mt-2">
            {/* Folder cards */}
            {filteredFolders.map((folder, i) => {
              const isSelected = selectedIds.has(folder.id)
              const itemCount = countItemsRecursive(folders, folder.id, items)
              return (
                <motion.div
                  key={folder.id}
                  initial={{ opacity: 0, scale: 0.95 }}
                  animate={{ opacity: 1, scale: 1 }}
                  transition={{ delay: i * 0.03 }}
                  className={`group relative rounded-xl border bg-background p-4 cursor-pointer hover:shadow-sm transition-all ${
                    isSelected ? 'ring-2 ring-primary/30 border-primary/20' : 'border-border'
                  }`}
                  onClick={() => navigateToFolder(folder.id)}
                >
                  <div
                    className={`absolute top-2 left-2 transition-opacity ${isSelected || hasSelection ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'}`}
                    onClick={(e) => e.stopPropagation()}
                  >
                    <Checkbox
                      checked={isSelected}
                      onCheckedChange={() => toggleSelect(folder.id)}
                      className="h-4 w-4 bg-background/80 backdrop-blur"
                    />
                  </div>
                  <div className="absolute top-2 right-2 flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                    <Button
                      variant="outline"
                      size="icon"
                      className="h-6 w-6 bg-background/80 backdrop-blur"
                      onClick={(e) => {
                        e.stopPropagation()
                        onCompose(getItemsInFolder(folder.id, items))
                      }}
                    >
                      <MessageSquarePlus className="h-3 w-3" />
                    </Button>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="outline" size="icon" className="h-6 w-6 bg-background/80 backdrop-blur" onClick={(e) => e.stopPropagation()}>
                          <MoreHorizontal className="h-3 w-3" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end" className="w-40">
                        <DropdownMenuItem onClick={() => onCompose(getItemsInFolder(folder.id, items))}>
                          <MessageSquarePlus className="h-4 w-4 mr-2" />Use in chat
                        </DropdownMenuItem>
                        <DropdownMenuItem onClick={() => { setRenameTarget(folder); setRenameValue(folder.name) }}>
                          <PenLine className="h-4 w-4 mr-2" />Rename
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          onClick={() => setMoveTargets([{ path: folder.id, name: folder.name, kind: 'folder' }])}
                        >
                          <FolderPlus className="h-4 w-4 mr-2" />Move to folder
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem
                          onClick={() => setDeleteTargets([{ path: folder.id, name: folder.name, kind: 'folder' }])}
                        >
                          <Trash2 className="h-4 w-4 mr-2" />Delete
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                  <div className="flex flex-col items-center text-center pt-4 pb-1">
                    <FolderIcon className="h-8 w-8 text-muted-foreground/40 mb-3 fill-muted-foreground/15" />
                    <p className="text-sm font-medium text-foreground line-clamp-2 break-all mb-1 w-full">{folder.name}</p>
                    <p className="text-xs text-muted-foreground">
                      {itemCount} {itemCount === 1 ? 'item' : 'items'}
                    </p>
                  </div>
                </motion.div>
              )
            })}

            {/* Item cards */}
            {filteredItems.map((item, i) => (
              <LibraryCard
                key={item.id}
                item={item}
                layout="grid"
                index={filteredFolders.length + i}
                selected={selectedIds.has(item.id)}
                hasSelection={hasSelection}
                onSelectChange={() => toggleSelect(item.id)}
                onClick={() => onItemClick(item)}
                onUseInChat={() => onCompose([item])}
                onDownload={() => handleDownload(item)}
                onMove={() => setMoveTargets([{ path: item.id, name: item.name, kind: 'item' }])}
                onDelete={() => setDeleteTargets([{ path: item.id, name: item.name, kind: 'item' }])}
                isPinned={item.pinned}
                onPin={onPinItem ? () => onPinItem(item) : undefined}
                onUnpin={onUnpinItem ? () => onUnpinItem(item) : undefined}
                isDraggable={!!onPinItem}
              />
            ))}
          </div>
        )}
      </div>

        {/* Bulk actions bar */}
        <AnimatePresence>
          {hasSelection && (
            <motion.div
              initial={{ opacity: 0, maxHeight: 0 }}
              animate={{ opacity: 1, maxHeight: 120 }}
              exit={{ opacity: 0, maxHeight: 0 }}
              transition={{ duration: 0.2 }}
              className="border-t bg-muted/30 overflow-hidden shrink-0"
            >
              <div className="flex items-center gap-3 px-5 py-3">
                <Checkbox
                  checked={selectAllState}
                  onCheckedChange={toggleSelectAll}
                  className="h-4 w-4"
                />
                <span className="text-xs text-muted-foreground font-medium">
                  {selectedIds.size} selected
                </span>
                <div className="flex items-center gap-1 ml-2">
                  <Button variant="ghost" size="sm" className="h-7 text-xs gap-1.5" onClick={() => onCompose(selectedItems)}>
                    <MessageSquarePlus className="h-3.5 w-3.5" />
                    Use in chat
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 text-xs gap-1.5"
                    onClick={async () => {
                      for (const item of selectedItems) await handleDownload(item)
                    }}
                  >
                    <Download className="h-3.5 w-3.5" />
                    Download
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 text-xs gap-1.5"
                    onClick={() => setMoveTargets(selectedTargets)}
                  >
                    <FolderPlus className="h-3.5 w-3.5" />
                    Move
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 text-xs gap-1.5"
                    onClick={() => setDeleteTargets(selectedTargets)}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                    Delete
                  </Button>
                </div>
                <button onClick={clearSelection} className="ml-auto text-xs text-muted-foreground hover:text-foreground transition-colors">
                  Clear
                </button>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
      </ContextMenuTrigger>
      <ContextMenuContent className="w-44">
        {onCreateArtifact && (
          <>
            <ContextMenuItem onSelect={() => setCreateSheetOpen(true)}><Sparkles className="h-4 w-4 mr-2" />AI artifact</ContextMenuItem>
            <ContextMenuSeparator />
          </>
        )}
        <ContextMenuItem onSelect={() => setCreateFileDialogOpen(true)}><FilePlus className="h-4 w-4 mr-2" />New file</ContextMenuItem>
        <ContextMenuItem onSelect={() => setFolderDialogOpen(true)}><FolderPlus className="h-4 w-4 mr-2" />New folder</ContextMenuItem>
        <ContextMenuItem onSelect={() => setPasteLinkDialogOpen(true)}><Link2 className="h-4 w-4 mr-2" />New link</ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={openPicker}><Upload className="h-4 w-4 mr-2" />Upload file</ContextMenuItem>
        <ContextMenuItem onSelect={openDirectoryPicker}><FolderPlus className="h-4 w-4 mr-2" />Upload folder</ContextMenuItem>
      </ContextMenuContent>
      </ContextMenu>

      {/* New folder dialog */}
      <Dialog open={folderDialogOpen} onOpenChange={(open) => {
        setFolderDialogOpen(open)
        if (!open) setNewFolderName('')
      }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>New folder</DialogTitle>
            <DialogDescription>
              {currentFolder
                ? `Create a folder inside "${currentFolder.name}".`
                : 'Create a folder to organize your library.'}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2 py-2">
            <label className="text-sm font-medium text-foreground">Folder name</label>
            <Input
              placeholder="e.g., Q2 plans"
              value={newFolderName}
              onChange={(e) => setNewFolderName(e.target.value)}
              autoFocus
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => { setFolderDialogOpen(false); setNewFolderName('') }}>
              Cancel
            </Button>
            <Button
              disabled={!newFolderName.trim()}
              onClick={handleCreateFolder}
            >
              Create folder
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Create blank file dialog */}
      <Dialog
        open={createFileDialogOpen}
        onOpenChange={(open) => {
          setCreateFileDialogOpen(open)
          if (!open) setNewFileName('')
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Create file</DialogTitle>
            <DialogDescription>
              {currentFolder
                ? `Create a new blank file inside "${currentFolder.name}". Include the extension in the name.`
                : 'Create a new blank file. Include the extension in the name.'}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2 py-2">
            <label className="text-sm font-medium text-foreground">File name</label>
            <Input
              placeholder="e.g., notes.md"
              value={newFileName}
              onChange={(e) => setNewFileName(e.target.value)}
              autoFocus
              onKeyDown={(e) => {
                if (e.key === 'Enter' && newFileName.trim()) handleCreateFile()
              }}
            />
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => { setCreateFileDialogOpen(false); setNewFileName('') }}
            >
              Cancel
            </Button>
            <Button
              disabled={!newFileName.trim()}
              onClick={handleCreateFile}
            >
              Create file
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Paste link dialog */}
      <Dialog
        open={pasteLinkDialogOpen}
        onOpenChange={(open) => {
          setPasteLinkDialogOpen(open)
          if (!open) { setLinkUrl(''); setLinkName('') }
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Paste link</DialogTitle>
            <DialogDescription>
              {currentFolder
                ? `Save a URL to "${currentFolder.name}".`
                : 'Save a URL to your library.'}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <div className="space-y-1.5">
              <label className="text-sm font-medium text-foreground">URL</label>
              <Input
                placeholder="https://example.com"
                value={linkUrl}
                onChange={(e) => setLinkUrl(e.target.value)}
                autoFocus
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && linkUrl.trim()) handleCreateLink()
                }}
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-sm font-medium text-foreground">
                Name <span className="text-muted-foreground font-normal">(optional)</span>
              </label>
              <Input
                placeholder="Defaults to the URL hostname"
                value={linkName}
                onChange={(e) => setLinkName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && linkUrl.trim()) handleCreateLink()
                }}
              />
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => { setPasteLinkDialogOpen(false); setLinkUrl(''); setLinkName('') }}
            >
              Cancel
            </Button>
            <Button disabled={!linkUrl.trim()} onClick={handleCreateLink}>
              Save link
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Rename folder dialog */}
      <Dialog
        open={renameTarget !== null}
        onOpenChange={(open) => { if (!open) setRenameTarget(null) }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Rename folder</DialogTitle>
            <DialogDescription>Give the folder a new name.</DialogDescription>
          </DialogHeader>
          <div className="space-y-2 py-2">
            <label className="text-sm font-medium text-foreground">Folder name</label>
            <Input
              value={renameValue}
              onChange={(e) => setRenameValue(e.target.value)}
              autoFocus
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleRenameFolder()
              }}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRenameTarget(null)}>Cancel</Button>
            <Button
              disabled={!renameValue.trim() || renameValue.trim() === renameTarget?.name}
              onClick={handleRenameFolder}
            >
              Rename
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Move-to-folder dialog */}
      <Dialog
        open={moveTargets !== null}
        onOpenChange={(open) => { if (!open) setMoveTargets(null) }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              {moveTargets && moveTargets.length === 1
                ? `Move "${moveTargets[0].name}"`
                : `Move ${moveTargets?.length ?? 0} items`}
            </DialogTitle>
            <DialogDescription>Pick a destination folder.</DialogDescription>
          </DialogHeader>
          <div className="max-h-[50vh] overflow-y-auto py-2 space-y-1">
            <button
              className="w-full text-left rounded-md px-3 py-2 text-sm hover:bg-muted"
              onClick={() => handleMoveToFolder(null)}
            >
              <FolderIcon className="h-4 w-4 mr-2 inline" />
              Library (root)
            </button>
            {folders
              // Can't move an item into itself or one of its descendants.
              .filter((f) => {
                if (!moveTargets) return true
                for (const t of moveTargets) {
                  if (t.path === f.id) return false
                  if (f.id.startsWith(`${t.path}/`)) return false
                }
                return true
              })
              .sort((a, b) => a.id.localeCompare(b.id))
              .map((f) => (
                <button
                  key={f.id}
                  className="w-full text-left rounded-md px-3 py-2 text-sm hover:bg-muted"
                  onClick={() => handleMoveToFolder(f.id)}
                >
                  <FolderIcon className="h-4 w-4 mr-2 inline" />
                  {f.id}
                </button>
              ))}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setMoveTargets(null)}>Cancel</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog
        open={deleteTargets !== null}
        onOpenChange={(open) => { if (!open) setDeleteTargets(null) }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {deleteTargets && deleteTargets.length === 1
                ? `Delete "${deleteTargets[0].name}"?`
                : `Delete ${deleteTargets?.length ?? 0} items?`}
            </AlertDialogTitle>
            <AlertDialogDescription>
              This permanently removes the selected items from your library.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={confirmDelete}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
          {onCreateArtifact && (
            <ArtifactCreationSheet
              open={createSheetOpen}
              onOpenChange={setCreateSheetOpen}
              workspaceId={activeWorkspaceId}
              onCreateArtifact={async (input) => {
                setCreateSheetOpen(false)
                await onCreateArtifact(input)
              }}
              onSkipToChat={async (agentId) => {
                setCreateSheetOpen(false)
                await onSkipToChat?.(agentId)
              }}
            />
          )}
        </div>
      )}
    </FileDropZone>
  )
}
