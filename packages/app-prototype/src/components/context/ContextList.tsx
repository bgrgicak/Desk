import { useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import {
  FileText,
  Link2,
  StickyNote,
  Upload,
  ClipboardPaste,
  PenLine,
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
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { SidebarTrigger } from '@/components/ui/sidebar'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
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
import type { ContextItem, Folder } from '@/data/ui-types'
import {
  getRelativeTime,
  getFolderById,
  getFolderPath,
  getChildFolders,
  getItemsInFolder,
  countItemsRecursive,
} from '@/data/ui-types'
import { useAppSelector } from '@/store/hooks'
import { selectFolders } from '@/store/slices/derivedSlice'
import { useUploadLibraryFileMutation } from '@/store/api'
import { FileDropZone } from '@/components/upload/FileDropZone'
import { toast } from 'sonner'

interface ContextListProps {
  items: ContextItem[]
  onItemClick: (item: ContextItem) => void
  onCompose: (attachedItems?: ContextItem[]) => void
}

type ViewMode = 'list' | 'grid'
type TypeFilter = 'all' | 'folder' | 'file' | 'link' | 'note'

const TYPE_ICON = {
  file: FileText,
  link: Link2,
  note: StickyNote,
}

const TYPE_FILTERS: { value: TypeFilter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'folder', label: 'Folders' },
  { value: 'file', label: 'Files' },
  { value: 'note', label: 'Notes' },
  { value: 'link', label: 'Links' },
]

export function ContextList({ items, onItemClick, onCompose }: ContextListProps) {
  const [searchQuery, setSearchQuery] = useState('')
  const [typeFilter, setTypeFilter] = useState<TypeFilter>('all')
  const [viewMode, setViewMode] = useState<ViewMode>('list')
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [currentFolderId, setCurrentFolderId] = useState<string | null>(null)

  const activeWorkspaceId = useAppSelector(s => s.ui.activeWorkspaceId) ?? undefined
  const [uploadLibraryFile, uploadState] = useUploadLibraryFileMutation()

  const handleUpload = async (files: File[]) => {
    if (!activeWorkspaceId) {
      toast.error('Pick a workspace before uploading')
      return
    }
    for (const file of files) {
      try {
        await uploadLibraryFile({ workspaceId: activeWorkspaceId, file }).unwrap()
        toast.success(`Uploaded ${file.name}`)
      } catch (err) {
        toast.error(`Upload failed: ${file.name}`, {
          description: err instanceof Error ? err.message : undefined,
        })
      }
    }
  }

  const createBlankNote = (): ContextItem => ({
    id: `note-new-${Date.now()}`,
    type: 'note',
    name: '',
    content: '',
    folderId: currentFolderId,
    addedAt: new Date(),
    usedBy: [],
    uploadedBy: 'user',
    relatedArtifactIds: [],
  })

  // New folder dialog
  const [folderDialogOpen, setFolderDialogOpen] = useState(false)
  const [newFolderName, setNewFolderName] = useState('')

  // Folders are client-derived (TODO(api-gap) — matrix §4.2.1). The
  // selector returns `[]` until path-prefix derivation lands.
  const folders = useAppSelector(selectFolders)

  const currentFolder = getFolderById(folders, currentFolderId)
  const breadcrumbPath = getFolderPath(folders, currentFolderId)
  const isInsideFolder = currentFolder != null

  // Get folders + items in current location
  const childFolders = getChildFolders(folders, currentFolderId)
  const folderItems = getItemsInFolder(currentFolderId, items)

  // Apply filters
  const showFolders = typeFilter === 'all' || typeFilter === 'folder'
  const filteredFolders = showFolders
    ? childFolders.filter(f => !searchQuery || f.name.toLowerCase().includes(searchQuery.toLowerCase()))
    : []

  const filteredItems = folderItems
    .filter(i => typeFilter === 'all' || typeFilter === i.type)
    .filter(i => typeFilter !== 'folder')
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
  const hasSelection = selectedIds.size > 0

  const navigateToFolder = (folderId: string | null) => {
    setCurrentFolderId(folderId)
    clearSelection()
    setSearchQuery('')
    setTypeFilter('all')
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
    >
      {({ openPicker }) => (
        <div className="flex flex-1 flex-col min-h-0 overflow-hidden">

      {/* ── Header bar ── */}
      <div className="h-[52px] flex items-center gap-3 border-b px-4 shrink-0">
        <SidebarTrigger className="h-8 w-8 rounded-md shrink-0" />

        {/* Breadcrumb */}
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

        <div className="ml-auto flex items-center gap-2">
          {/* Type filter pills */}
          <div className="flex items-center rounded-lg border p-0.5">
            {TYPE_FILTERS.map(f => (
              <button
                key={f.value}
                onClick={() => setTypeFilter(f.value)}
                className={`rounded-md px-3 py-1 text-xs font-medium transition-colors ${
                  typeFilter === f.value
                    ? 'bg-muted text-foreground'
                    : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                {f.label}
              </button>
            ))}
          </div>

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

          {/* New folder */}
          <Button variant="outline" size="icon" className="h-8 w-8" title="New folder" onClick={() => setFolderDialogOpen(true)}>
            <FolderPlus className="h-4 w-4" />
          </Button>

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
              <Button size="sm" variant="default" className="gap-1.5 text-xs">
                Add
                <ChevronDown className="h-3 w-3 ml-0.5" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-44">
              <DropdownMenuItem onSelect={openPicker} data-testid="library-upload-choose-file"><Upload className="h-4 w-4 mr-2" />Choose file</DropdownMenuItem>
              <DropdownMenuItem><ClipboardPaste className="h-4 w-4 mr-2" />Paste link</DropdownMenuItem>
              <DropdownMenuItem onSelect={() => onItemClick(createBlankNote())}><PenLine className="h-4 w-4 mr-2" />Write note</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {/* ── Body ── */}
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
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent>
                  <DropdownMenuItem onSelect={openPicker} data-testid="library-upload-choose-file-empty"><Upload className="h-4 w-4 mr-2" />Choose file</DropdownMenuItem>
                  <DropdownMenuItem><ClipboardPaste className="h-4 w-4 mr-2" />Paste link</DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => onItemClick(createBlankNote())}><PenLine className="h-4 w-4 mr-2" />Write note</DropdownMenuItem>
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
                          <DropdownMenuItem>
                            <PenLine className="h-4 w-4 mr-2" />
                            Rename
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem>
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
              {filteredItems.map((item, i) => {
                const Icon = TYPE_ICON[item.type]
                const isSelected = selectedIds.has(item.id)
                return (
                  <motion.div
                    key={item.id}
                    initial={{ opacity: 0, y: 5 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: (filteredFolders.length + i) * 0.02 }}
                    className={`flex items-center gap-3 rounded-lg px-3 py-2.5 transition-colors group cursor-pointer ${
                      isSelected ? 'bg-primary/5 border border-primary/10' : 'hover:bg-muted/50 border border-transparent'
                    }`}
                  >
                    <Checkbox
                      checked={isSelected}
                      onCheckedChange={() => toggleSelect(item.id)}
                      className="h-4 w-4"
                      onClick={(e) => e.stopPropagation()}
                    />
                    <div
                      className="flex items-center gap-3 flex-1 min-w-0"
                      onClick={() => onItemClick(item)}
                    >
                      <Icon className="h-4 w-4 text-muted-foreground shrink-0" />
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium text-foreground truncate">{item.name}</p>
                        {item.usedBy.length > 0 && (
                          <p className="text-xs text-muted-foreground">
                            Used by {item.usedBy.join(', ')}
                            {item.lastAccessed && ` · ${getRelativeTime(item.lastAccessed)}`}
                          </p>
                        )}
                      </div>
                    </div>
                    <span className="text-xs text-muted-foreground shrink-0 w-20 text-right capitalize">
                      {item.type}
                    </span>
                    <span className="text-xs text-muted-foreground shrink-0 w-20 text-right">
                      {getRelativeTime(item.addedAt)}
                    </span>
                    <div className="flex items-center gap-1 justify-end shrink-0 w-[140px] ml-10">
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7 text-xs opacity-0 group-hover:opacity-100 transition-opacity"
                        onClick={(e) => {
                          e.stopPropagation()
                          onCompose([item])
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
                          <DropdownMenuItem onClick={() => onCompose([item])}>
                            <MessageSquarePlus className="h-4 w-4 mr-2" />
                            Use in chat
                          </DropdownMenuItem>
                          <DropdownMenuItem>
                            <Download className="h-4 w-4 mr-2" />
                            Download
                          </DropdownMenuItem>
                          <DropdownMenuItem>
                            <FolderPlus className="h-4 w-4 mr-2" />
                            Move to folder
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem>
                            <Trash2 className="h-4 w-4 mr-2" />
                            Delete
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>
                  </motion.div>
                )
              })}
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
                        <DropdownMenuItem><PenLine className="h-4 w-4 mr-2" />Rename</DropdownMenuItem>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem><Trash2 className="h-4 w-4 mr-2" />Delete</DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                  <div className="flex flex-col items-center text-center pt-4 pb-1">
                    <FolderIcon className="h-8 w-8 text-muted-foreground/40 mb-3 fill-muted-foreground/15" />
                    <p className="text-sm font-medium text-foreground line-clamp-2 mb-1">{folder.name}</p>
                    <p className="text-xs text-muted-foreground">
                      {itemCount} {itemCount === 1 ? 'item' : 'items'}
                    </p>
                  </div>
                </motion.div>
              )
            })}

            {/* Item cards */}
            {filteredItems.map((item, i) => {
              const Icon = TYPE_ICON[item.type]
              const isSelected = selectedIds.has(item.id)
              return (
                <motion.div
                  key={item.id}
                  initial={{ opacity: 0, scale: 0.95 }}
                  animate={{ opacity: 1, scale: 1 }}
                  transition={{ delay: (filteredFolders.length + i) * 0.03 }}
                  className={`group relative rounded-xl border bg-background p-4 cursor-pointer hover:shadow-sm transition-all ${
                    isSelected ? 'ring-2 ring-primary/30 border-primary/20' : 'border-border'
                  }`}
                  onClick={() => onItemClick(item)}
                >
                  <div
                    className={`absolute top-2 left-2 transition-opacity ${isSelected || hasSelection ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'}`}
                    onClick={(e) => e.stopPropagation()}
                  >
                    <Checkbox
                      checked={isSelected}
                      onCheckedChange={() => toggleSelect(item.id)}
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
                        onCompose([item])
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
                        <DropdownMenuItem onClick={() => onCompose([item])}>
                          <MessageSquarePlus className="h-4 w-4 mr-2" />Use in chat
                        </DropdownMenuItem>
                        <DropdownMenuItem><Download className="h-4 w-4 mr-2" />Download</DropdownMenuItem>
                        <DropdownMenuItem><FolderPlus className="h-4 w-4 mr-2" />Move to folder</DropdownMenuItem>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem><Trash2 className="h-4 w-4 mr-2" />Delete</DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                  <div className="flex flex-col items-center text-center pt-4 pb-1">
                    <Icon className="h-8 w-8 text-muted-foreground/40 mb-3" />
                    <p className="text-sm font-medium text-foreground line-clamp-2 mb-1">{item.name}</p>
                    <p className="text-xs text-muted-foreground">{getRelativeTime(item.addedAt)}</p>
                  </div>
                </motion.div>
              )
            })}
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
                  <Button variant="ghost" size="sm" className="h-7 text-xs gap-1.5">
                    <FolderPlus className="h-3.5 w-3.5" />
                    Move to folder
                  </Button>
                  <Button variant="ghost" size="sm" className="h-7 text-xs gap-1.5">
                    <Download className="h-3.5 w-3.5" />
                    Download
                  </Button>
                  <Button variant="ghost" size="sm" className="h-7 text-xs gap-1.5">
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
              onClick={() => { setFolderDialogOpen(false); setNewFolderName('') }}
            >
              Create folder
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
        </div>
      )}
    </FileDropZone>
  )
}
