import { useState, useRef, useEffect, useCallback } from 'react'
import { motion } from 'framer-motion'
import {
  FileText,
  FileImage,
  Link2,
  StickyNote,
  Download,
  FolderPlus,
  Trash2,
  MoreHorizontal,
  Bot,
  ExternalLink,
  Pencil,
  Check,
  Plus,
  PanelRightClose,
  PanelRight,
  User,
  ChevronDown,
  ChevronRight,
  FileSpreadsheet,
  FileAudio,
  File,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { SidebarTrigger } from '@/components/ui/sidebar'
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
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { ImagePreview } from '@/components/ImagePreview'
import type { ContextItem, Artifact } from '@/data/ui-types'
import { getRelativeTime, getArtifactIcon, getFolderPath } from '@/data/ui-types'
import { useAppSelector } from '@/store/hooks'
import { selectFolders } from '@/store/slices/derivedSlice'
import { useGetLibraryQuery } from '@/store/api'
import { toArtifactFromFile } from '@/store/selectors/artifacts'

interface ContextDetailProps {
  item: ContextItem
  onBack: () => void
  onCompose: (items: ContextItem[]) => void
  onArtifactClick?: (artifact: Artifact) => void
}

function getFileIcon(mimeType?: string) {
  if (!mimeType) return FileText
  if (mimeType.startsWith('image/')) return FileImage
  if (mimeType.startsWith('audio/')) return FileAudio
  if (mimeType.includes('spreadsheet') || mimeType.includes('excel')) return FileSpreadsheet
  if (mimeType === 'application/pdf') return FileText
  return File
}

function canPreview(item: ContextItem): boolean {
  if (item.type === 'note') return true
  if (item.type === 'link') return true
  if (item.mimeType === 'application/pdf') return true
  if (item.mimeType?.startsWith('image/')) return true
  return false
}

export function ContextDetail({ item, onBack, onCompose, onArtifactClick }: ContextDetailProps) {
  // Pre-populate notes with file description for files that can't be previewed
  const defaultNotes = (item.type === 'file' && !canPreview(item)) ? item.content : ''
  const [notes, setNotes] = useState(defaultNotes)
  const [isEditingNotes, setIsEditingNotes] = useState(false)
  const [folder, setFolder] = useState(item.folder || '')
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false)
  const [notesExpanded, setNotesExpanded] = useState(true)
  const [detailsExpanded, setDetailsExpanded] = useState(true)

  // Editable name (for file / link items — notes use the inline title editor)
  const [itemName, setItemName] = useState(item.name)
  const [isEditingItemName, setIsEditingItemName] = useState(false)

  // Note editor state
  const [noteTitle, setNoteTitle] = useState(item.name)
  const [noteBody, setNoteBody] = useState(item.type === 'note' ? item.content : '')
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saved'>('idle')
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const titleRef = useRef<HTMLTextAreaElement>(null)
  const bodyRef = useRef<HTMLTextAreaElement>(null)

  // Auto-resize a textarea to fit its content
  const autoResize = (el: HTMLTextAreaElement | null) => {
    if (!el) return
    el.style.height = 'auto'
    el.style.height = el.scrollHeight + 'px'
  }

  useEffect(() => { autoResize(titleRef.current) }, [noteTitle])
  useEffect(() => { autoResize(bodyRef.current) }, [noteBody])

  const triggerSave = useCallback(() => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
    saveTimerRef.current = setTimeout(() => setSaveStatus('saved'), 800)
    setSaveStatus('idle')
  }, [])

  // "Related artifacts" — the server has no explicit artifact-to-context
  // relation yet. We hydrate against the library and filter by the ids
  // the UI already tracks on the item; it's empty for server-backed
  // items today. TODO(api-gap): replace with a first-class relation in
  // matrix §4.2.5 once the server exposes it.
  const folders = useAppSelector(selectFolders)
  const { data: libraryResp } = useGetLibraryQuery()
  const libraryArtifacts: Artifact[] = (libraryResp?.items ?? []).map(toArtifactFromFile)
  const relatedArtifacts = libraryArtifacts.filter(a => item.relatedArtifactIds.includes(a.id))
  const FileIcon = item.type === 'note' ? StickyNote : item.type === 'link' ? Link2 : getFileIcon(item.mimeType)

  return (
    <div className="flex flex-1 min-h-0 overflow-hidden">
      {/* Main content area — preview */}
      <div className="flex flex-1 flex-col min-w-0 overflow-hidden">
        {/* Header — breadcrumb style */}
        <div className="h-[52px] flex items-center gap-3 border-b px-4 shrink-0">
          <SidebarTrigger className="h-8 w-8 rounded-md shrink-0" />

          {/* Breadcrumb */}
          {(() => {
            const folderPath = getFolderPath(folders, item.folderId ?? null)
            return (
              <Breadcrumb className="min-w-0 flex-1">
                <BreadcrumbList className="flex-nowrap">
                  <BreadcrumbItem>
                    <BreadcrumbLink asChild>
                      <button
                        onClick={onBack}
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
                            onClick={onBack}
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
                        <>
                          <span className="truncate">{noteTitle || 'Untitled'}</span>
                          <span className={`text-[11px] font-medium text-foreground bg-muted rounded-full px-2 py-0.5 shrink-0 transition-opacity duration-300 ${saveStatus === 'saved' ? 'opacity-100' : 'opacity-0'}`}>
                            Saved
                          </span>
                        </>
                      ) : isEditingItemName ? (
                        <div className="flex items-center gap-1.5 min-w-0 flex-1">
                          <input
                            type="text"
                            value={itemName}
                            onChange={(e) => setItemName(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') setIsEditingItemName(false)
                              if (e.key === 'Escape') { setItemName(item.name); setIsEditingItemName(false) }
                            }}
                            className="flex-1 min-w-0 bg-transparent text-sm font-semibold outline-none border-b-2 border-primary pb-0.5"
                            autoFocus
                          />
                          <Button variant="ghost" size="icon" className="h-6 w-6 shrink-0" onClick={() => setIsEditingItemName(false)}>
                            <Check className="h-3.5 w-3.5" />
                          </Button>
                        </div>
                      ) : (
                        <button
                          onClick={() => setIsEditingItemName(true)}
                          className="flex items-center gap-1 min-w-0 group hover:text-foreground/70 transition-colors"
                        >
                          <span className="truncate">{itemName}</span>
                          <Pencil className="h-3 w-3 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity shrink-0" />
                        </button>
                      )}
                    </BreadcrumbPage>
                  </BreadcrumbItem>
                </BreadcrumbList>
              </Breadcrumb>
            )
          })()}

          <div className="flex items-center gap-2 shrink-0">
            <Button
              size="sm"
              className="text-xs"
              onClick={() => onCompose([item])}
            >
              Use in chat
            </Button>

            {item.type === 'file' && (
              <Button variant="outline" size="sm" className="text-xs">
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
                <DropdownMenuItem>
                  <FolderPlus className="h-4 w-4 mr-2" />
                  Move to folder
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={() => setDeleteDialogOpen(true)}>
                  <Trash2 className="h-4 w-4 mr-2" />
                  Delete
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>

            {/* Sidebar toggle */}
            {sidebarCollapsed && (
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8"
                onClick={() => setSidebarCollapsed(false)}
              >
                <PanelRight className="h-4 w-4" />
              </Button>
            )}
          </div>
        </div>

        {/* Preview area */}
        <div className="flex-1 overflow-y-auto bg-muted/20 flex flex-col">
          {item.type === 'note' ? (
            <div className="flex-1 flex flex-col">
              {/* Editor */}
              <div className="mx-auto w-full max-w-[490px] px-2 pt-8 pb-16">
                <textarea
                  ref={titleRef}
                  value={noteTitle}
                  onChange={(e) => { setNoteTitle(e.target.value); triggerSave() }}
                  placeholder="Untitled"
                  rows={1}
                  className="w-full resize-none overflow-hidden bg-transparent text-2xl font-semibold text-foreground placeholder:text-muted-foreground/30 outline-none leading-tight mb-4"
                />
                <textarea
                  ref={bodyRef}
                  value={noteBody}
                  onChange={(e) => { setNoteBody(e.target.value); triggerSave() }}
                  placeholder="Start writing…"
                  rows={1}
                  className="w-full resize-none overflow-hidden bg-transparent text-sm text-foreground/80 placeholder:text-muted-foreground/30 outline-none leading-relaxed"
                />
              </div>
            </div>
          ) : item.type === 'link' ? (
            <div className="flex flex-col h-full">
              {/* Link preview bar */}
              <div className="flex items-center gap-2 border-b bg-background px-4 py-2">
                <Link2 className="h-3.5 w-3.5 text-muted-foreground" />
                <a
                  href={item.content}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-xs text-blue-600 hover:underline flex items-center gap-1 truncate"
                >
                  {item.content}
                  <ExternalLink className="h-3 w-3 shrink-0" />
                </a>
              </div>
              {/* Embedded preview placeholder */}
              <div className="flex-1 flex items-center justify-center">
                <div className="text-center">
                  <div className="mb-4 flex h-16 w-16 mx-auto items-center justify-center rounded-2xl bg-blue-500/10">
                    <Link2 className="h-8 w-8 text-blue-500/40" />
                  </div>
                  <h3 className="text-base font-semibold mb-1">{item.name}</h3>
                  <p className="text-sm text-muted-foreground mb-4">
                    Web preview would load here
                  </p>
                  <a
                    href={item.content}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1.5 text-sm text-blue-600 hover:underline"
                  >
                    Open in browser
                    <ExternalLink className="h-3.5 w-3.5" />
                  </a>
                </div>
              </div>
            </div>
          ) : item.mimeType === 'application/pdf' ? (
            /* PDF preview — fills entire container */
            <div className="flex-1 flex flex-col bg-muted/30">
              <div className="flex-1 bg-white mx-0">
                {/* Mock PDF content filling the page */}
                <div className="max-w-3xl mx-auto px-12 py-10 space-y-4">
                  <div className="h-7 w-72 rounded bg-muted/80" />
                  <div className="h-3 w-full rounded bg-muted/50" />
                  <div className="h-3 w-full rounded bg-muted/50" />
                  <div className="h-3 w-4/5 rounded bg-muted/50" />
                  <div className="mt-8 h-48 w-full rounded bg-muted/20" />
                  <div className="h-3 w-full rounded bg-muted/50" />
                  <div className="h-3 w-full rounded bg-muted/50" />
                  <div className="h-3 w-5/6 rounded bg-muted/50" />
                  <div className="mt-6 h-5 w-56 rounded bg-muted/70" />
                  <div className="h-3 w-full rounded bg-muted/50" />
                  <div className="h-3 w-full rounded bg-muted/50" />
                  <div className="h-3 w-2/3 rounded bg-muted/50" />
                  <div className="mt-6 h-3 w-full rounded bg-muted/50" />
                  <div className="h-3 w-full rounded bg-muted/50" />
                  <div className="h-3 w-3/4 rounded bg-muted/50" />
                </div>
              </div>
              <div className="border-t px-4 py-1.5 bg-background flex items-center justify-center shrink-0">
                <span className="text-xs text-muted-foreground">Page 1 of 12</span>
              </div>
            </div>
          ) : item.mimeType?.startsWith('image/') ? (
            <ImagePreview />
          ) : (
            /* No preview available */
            <div className="flex-1 flex items-center justify-center min-h-0">
              <div className="text-center max-w-xs px-4">
                <div className="mb-5 flex h-16 w-16 mx-auto items-center justify-center rounded-2xl bg-muted/50">
                  <FileIcon className="h-8 w-8 text-muted-foreground/40" />
                </div>
                <p className="text-sm font-medium text-muted-foreground">
                  Preview not available for this file type
                </p>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Right sidebar — metadata */}
      <div className={`hidden lg:flex shrink-0 transition-all duration-300 overflow-hidden ${sidebarCollapsed ? 'w-0' : 'w-[340px]'}`}>
        <motion.div
          initial={{ opacity: 0, x: 40 }}
          animate={{ opacity: 1, x: 0 }}
          transition={{ type: 'spring', damping: 25, stiffness: 200 }}
          className="flex h-full w-[340px] flex-col border-l bg-background"
        >
          {/* Sidebar header */}
          <div className="h-[52px] flex items-center justify-between px-4 border-b shrink-0">
            <span className="text-sm font-medium">Details</span>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7 rounded-full"
              onClick={() => setSidebarCollapsed(true)}
            >
              <PanelRightClose className="h-4 w-4" />
            </Button>
          </div>

          {/* Sidebar content */}
          <div className="flex-1 overflow-y-auto">
            {/* Notes for AI */}
            <div className="border-b">
              <button
                onClick={() => setNotesExpanded(!notesExpanded)}
                className="flex items-center justify-between w-full px-4 py-3 text-left hover:bg-muted/30 transition-colors"
              >
                <span className="text-sm font-medium text-foreground">Notes for AI</span>
                {notesExpanded ? <ChevronDown className="h-4 w-4 text-muted-foreground" /> : <ChevronRight className="h-4 w-4 text-muted-foreground" />}
              </button>
              {notesExpanded && (
                <div className="px-4 pb-4">
                  <p className="text-xs text-muted-foreground mb-2">
                    Extra context the AI will see when using this item.
                  </p>
                  {isEditingNotes || !notes ? (
                    <div>
                      <textarea
                        value={notes}
                        onChange={(e) => setNotes(e.target.value)}
                        onFocus={() => setIsEditingNotes(true)}
                        placeholder="e.g., Focus on the APAC region when analyzing this data."
                        className="w-full min-h-[80px] rounded-lg border bg-background px-3 py-2 text-sm outline-none placeholder:text-muted-foreground/50 focus:ring-2 focus:ring-ring/20 focus:border-ring/40 resize-none transition-all"
                      />
                      {isEditingNotes && (
                        <div className="flex justify-end gap-2 mt-2">
                          <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => setIsEditingNotes(false)}>Cancel</Button>
                          <Button size="sm" className="h-7 text-xs" onClick={() => setIsEditingNotes(false)}>Save</Button>
                        </div>
                      )}
                    </div>
                  ) : (
                    <div
                      className="rounded-lg border bg-muted/30 px-3 py-2 text-sm text-foreground/80 cursor-pointer hover:bg-muted/50 transition-colors"
                      onClick={() => setIsEditingNotes(true)}
                    >
                      {notes}
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* Details section */}
            <div className="border-b">
              <button
                onClick={() => setDetailsExpanded(!detailsExpanded)}
                className="flex items-center justify-between w-full px-4 py-3 text-left hover:bg-muted/30 transition-colors"
              >
                <span className="text-sm font-medium text-foreground">About</span>
                {detailsExpanded ? <ChevronDown className="h-4 w-4 text-muted-foreground" /> : <ChevronRight className="h-4 w-4 text-muted-foreground" />}
              </button>
              {detailsExpanded && (
                <div className="px-4 pb-4 space-y-3">
                  {/* Folder */}
                  <div className="flex items-center justify-between">
                    <span className="text-xs text-muted-foreground">Folder</span>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <button className="flex items-center gap-1 text-xs text-foreground hover:text-foreground/80 transition-colors">
                          {folder || 'None'}
                          <ChevronDown className="h-3 w-3 text-muted-foreground" />
                        </button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end" className="w-36">
                        {['Finance', 'Strategy', 'Design', 'Research'].map(f => (
                          <DropdownMenuItem key={f} onClick={() => setFolder(f)} className={folder === f ? 'bg-muted' : ''}>{f}</DropdownMenuItem>
                        ))}
                        <DropdownMenuSeparator />
                        <DropdownMenuItem><Plus className="h-3.5 w-3.5 mr-2" />New folder</DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>

                  {/* Uploaded by */}
                  <div className="flex items-center justify-between">
                    <span className="text-xs text-muted-foreground">Uploaded by</span>
                    <div className="flex items-center gap-1.5">
                      {item.uploadedBy === 'user' ? (
                        <>
                          <User className="h-3 w-3 text-muted-foreground" />
                          <span className="text-xs text-foreground">You</span>
                        </>
                      ) : (
                        <>
                          <Bot className="h-3 w-3 text-muted-foreground" />
                          <span className="text-xs text-foreground">Claude</span>
                        </>
                      )}
                    </div>
                  </div>

                  {/* Added */}
                  <div className="flex items-center justify-between">
                    <span className="text-xs text-muted-foreground">Added</span>
                    <span className="text-xs text-foreground">
                      {item.addedAt.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                    </span>
                  </div>

                  {/* Last accessed */}
                  {item.lastAccessed && (
                    <div className="flex items-center justify-between">
                      <span className="text-xs text-muted-foreground">Last accessed</span>
                      <span className="text-xs text-foreground">{getRelativeTime(item.lastAccessed)}</span>
                    </div>
                  )}

                  {/* Type */}
                  <div className="flex items-center justify-between">
                    <span className="text-xs text-muted-foreground">Type</span>
                    <span className="text-xs text-foreground capitalize">{item.type}</span>
                  </div>

                  {/* File size */}
                  {item.fileSize && (
                    <div className="flex items-center justify-between">
                      <span className="text-xs text-muted-foreground">Size</span>
                      <span className="text-xs text-foreground">{item.fileSize}</span>
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* Used in */}
            <div className="px-4 py-3">
              <span className="text-sm font-medium text-foreground">Used in</span>
              {relatedArtifacts.length > 0 ? (
                <div className="mt-2 space-y-1">
                  {relatedArtifacts.map(artifact => (
                    <button
                      key={artifact.id}
                      onClick={() => onArtifactClick?.(artifact)}
                      className="flex items-center gap-2.5 w-full rounded-lg px-2.5 py-2 text-left hover:bg-muted/50 transition-colors group"
                    >
                      {(() => { const Icon = getArtifactIcon(artifact.type); return <Icon className="h-3.5 w-3.5 text-muted-foreground shrink-0" /> })()}
                      <div className="flex-1 min-w-0">
                        <p className="text-xs font-medium text-foreground group-hover:text-primary truncate transition-colors">
                          {artifact.name}
                        </p>
                        <p className="text-[11px] text-muted-foreground">
                          {getRelativeTime(artifact.createdAt)}
                        </p>
                      </div>
                      <ChevronRight className="h-3.5 w-3.5 text-muted-foreground/40 opacity-0 group-hover:opacity-100 transition-opacity shrink-0" />
                    </button>
                  ))}
                </div>
              ) : (
                <p className="text-xs text-muted-foreground/60 mt-2">
                  Not yet used to create any artifacts.
                </p>
              )}
            </div>
          </div>
        </motion.div>
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
              onClick={onBack}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
