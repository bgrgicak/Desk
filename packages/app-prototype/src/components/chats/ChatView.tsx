import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  MoreHorizontal, Trash2, Search, FileText,
  ChevronDown, Link2, StickyNote, Paperclip, Plus, X,
  PanelRight, PanelRightClose, BookmarkPlus, Check, ExternalLink, Sparkles,
} from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import type { UploadedFile, SendOptions } from '@/components/compose/ChatInput'
import { ArtifactInlineCard } from '@/components/shared/ArtifactInlineCard'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { PageHeader } from '@/components/layout/PageHeader'
import { ChatThread } from '@/components/compose/ChatThread'
import { ChatInput } from '@/components/compose/ChatInput'
import type { Chat, Artifact, ContextItem } from '@/data/ui-types'
import { getArtifactIcon, getRelativeTime } from '@/data/ui-types'
import {
  useGetAgentsQuery,
  useGetChatArtifactsQuery,
  useGetLibraryQuery,
  usePatchChatMutation,
  usePinChatLibraryRefMutation,
  usePostChatMessageMutation,
} from '@/store/api'
import { toContextItem } from '@/store/selectors/library'
import { NEW_CHAT_ID } from '@/router/nav'
import { useAppDispatch, useAppSelector } from '@/store/hooks'
import { setPendingNewChatAgentId } from '@/store/slices/uiSlice'
import type { AttachmentRef, ServerFile } from '@/store/types'
import { ArtifactsEmptyState, FilesEmptyState } from '@/components/shared/PanelEmptyStates'
import { FileDropZone, type UploadEntry } from '@/components/upload/FileDropZone'
import { useListKeyboardNav } from '@/hooks/use-list-keyboard-nav'
import { usePersistedState } from '@/hooks/use-persisted-state'
import { useClickOrDoubleClick } from '@/hooks/use-click-or-double-click'
import { usePrefs } from '@/hooks/use-prefs'

const STARTER_CHIPS = [
  'Draft a project brief',
  'Build an expense tracker',
  'Summarise my notes',
  'Design a color palette',
]

// ── Types ──────────────────────────────────────────────────────────────────────

type RightTab = 'artifacts' | 'files'
type ArtifactFilter = 'all' | 'document' | 'app' | 'image' | 'spreadsheet' | 'site'

interface ChatViewProps {
  chat: Chat
  artifacts?: Artifact[]
  onArtifactClick?: (artifact: Artifact) => void
  onDeleteChat?: (chatId: string) => void
  showNewBadge?: boolean
  savedArtifactIds?: Set<string>
  onSaveArtifact?: (artifactId: string) => void
  onDeleteArtifact?: (artifact: Artifact) => void
  /**
   * Fires for the "new chat" case on first message. Optional second
   * arg is the agent id picked in the bottom toggle before sending —
   * parent should use it when POST /chats'ing the new chat. Optional
   * third arg carries any files the user attached (via @ mention or
   * the staging tray) so they ride the very first POST /messages.
   */
  onFirstMessage?: (
    message: string,
    agentId?: string,
    attachments?: AttachmentRef[],
    options?: SendOptions,
    files?: File[],
  ) => void
  /** When set and the id matches a rendered message, scroll that row
   * into view instead of the default scroll-to-bottom. Drives the
   * "open in chat" affordance from the Run detail panel. */
  highlightMessageId?: string
  /** Fires when the user clicks an attachment chip on a chat message —
   * the parent navigates to the file's library detail view. */
  onAttachmentClick?: (attachment: AttachmentRef) => void
  /** Library items to pre-stage in the input tray for the new-chat case.
   * Mirrors the right-sidebar "+ Add" flow (`addStagedFromLibrary`): the
   * items ride the first POST /messages as attachments, and the parent
   * pins them via library-refs once the chat exists. Only consumed on
   * mount, so re-clicking "Use in chat" while already on the new-chat
   * stub requires the parent to remount the view. */
  initialStagedItems?: ContextItem[]
}

// ── Icon helpers ───────────────────────────────────────────────────────────────

const CONTEXT_ICON: Record<ContextItem['type'], typeof FileText> = {
  file: FileText,
  note: StickyNote,
  link: Link2,
}

const ARTIFACT_TYPE_LABELS: Record<string, string> = {
  document: 'Doc', app: 'App', image: 'Image', spreadsheet: 'Sheet', site: 'Site',
}

// ── Right panel: Artifacts tab ─────────────────────────────────────────────────

function ArtifactsPanel({
  chatId,
  artifacts,
  chatNotes,
  onArtifactClick,
  onArtifactStage,
  onChatNoteClick,
  onChatNoteStage,
  onPrefillInput,
  savedArtifactIds = new Set(),
  onSaveArtifact,
  onDeleteArtifact,
  onDeleteChatNote,
}: {
  chatId: string
  artifacts: Artifact[]
  /** Materialized chat-note files (`.chats/{id}/notes/*.md`). Rendered as
   *  a "Chat notes" section above the workspace artifacts list. */
  chatNotes: ServerFile[]
  /** Double-click an artifact: open it in detail view. */
  onArtifactClick?: (artifact: Artifact) => void
  /** Single-click an artifact: stage it on the next outgoing message. */
  onArtifactStage?: (artifact: Artifact) => void
  /** Double-click a chat note: open the markdown file in detail view. */
  onChatNoteClick?: (note: ServerFile) => void
  /** Single-click a chat note: stage it on the next outgoing message. */
  onChatNoteStage?: (note: ServerFile) => void
  onPrefillInput?: (text: string) => void
  savedArtifactIds?: Set<string>
  onSaveArtifact?: (artifactId: string) => void
  onDeleteArtifact?: (artifact: Artifact) => void
  onDeleteChatNote?: (note: ServerFile) => void
}) {
  const filterKey = chatId && chatId !== NEW_CHAT_ID ? `desk.chat.${chatId}.artifactFilter` : null
  const [filter, setFilter] = usePersistedState<ArtifactFilter>(filterKey, 'all')
  const [search, setSearch] = useState('')
  const [deletingArtifact, setDeletingArtifact] = useState<Artifact | null>(null)
  const [deletingNote, setDeletingNote] = useState<ServerFile | null>(null)

  const filtered = artifacts.filter(a => {
    if (filter !== 'all' && a.type !== filter) return false
    if (search.trim() && !a.name.toLowerCase().includes(search.toLowerCase())) return false
    return true
  })
  const filteredNotes = chatNotes.filter(n =>
    !search.trim()
    || (n.label ?? '').toLowerCase().includes(search.toLowerCase())
    || n.name.toLowerCase().includes(search.toLowerCase())
  )

  // Single click → stage on the next message; double click → open in
  // detail view. The natural `dblclick` event fires after both `click`s,
  // so we debounce single-click via this helper instead.
  const handleNoteClick = useClickOrDoubleClick<ServerFile>(
    (note) => onChatNoteStage?.(note),
    (note) => onChatNoteClick?.(note),
  )
  const handleArtifactClick = useClickOrDoubleClick<Artifact>(
    (artifact) => onArtifactStage?.(artifact),
    (artifact) => onArtifactClick?.(artifact),
  )

  if (artifacts.length === 0 && chatNotes.length === 0) {
    return <ArtifactsEmptyState onPrefillInput={onPrefillInput} />
  }

  return (
    <div className="flex flex-col h-full">
      {/* Filter row */}
      <div className="flex items-center gap-2 px-3 py-2.5 border-b shrink-0">
        <div className="relative flex-1">
          <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3 w-3 text-muted-foreground" />
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search…"
            className="w-full h-7 pl-6 pr-2 rounded-md border bg-background text-xs outline-none placeholder:text-muted-foreground/50 focus:ring-1 focus:ring-ring/30"
          />
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button className="flex items-center gap-1 h-7 px-2 rounded-md border bg-background text-xs text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors shrink-0">
              {filter === 'all' ? 'All types' : ARTIFACT_TYPE_LABELS[filter]}
              <ChevronDown className="h-3 w-3 opacity-60" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-36">
            {(['all', 'document', 'app', 'image', 'spreadsheet', 'site'] as const).map(f => (
              <DropdownMenuItem key={f} onClick={() => setFilter(f)} className={filter === f ? 'bg-muted/50' : ''}>
                {f === 'all' ? 'All types' : ARTIFACT_TYPE_LABELS[f]}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {/* List */}
      <div className="flex-1 overflow-y-auto py-1.5 px-1.5 flex flex-col gap-0.5">
        {filteredNotes.length > 0 && (
          <>
            <p className="px-2 pt-1 pb-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
              Chat notes
            </p>
            {filteredNotes.map(note => (
              <div
                key={`note-${note.path}`}
                onClick={() => handleNoteClick(note)}
                title="Click to add to message · Double-click to open"
                className="group flex items-center gap-3 px-2.5 py-2.5 rounded-lg hover:bg-muted/50 transition-colors cursor-pointer"
              >
                <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-muted">
                  <StickyNote className="h-4 w-4 text-muted-foreground/70" />
                </div>
                <div className="flex-1 min-w-0 relative overflow-hidden">
                  <p className="text-sm font-medium truncate">{note.label ?? 'Chat notes'}</p>
                  <p className="text-xs text-muted-foreground truncate">{note.name} · {getRelativeTime(new Date(note.createdAt))}</p>
                  <div className="absolute inset-y-0 right-0 w-12 bg-gradient-to-r from-transparent to-muted/50 opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none" />
                </div>
                <div className="flex items-center gap-0.5 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
                  <button
                    onClick={e => { e.stopPropagation(); onChatNoteStage?.(note) }}
                    title="Add to message"
                    className="h-6 w-6 flex items-center justify-center rounded hover:bg-muted shrink-0"
                  >
                    <Paperclip className="h-3.5 w-3.5 text-muted-foreground" />
                  </button>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <button
                        onClick={e => e.stopPropagation()}
                        className="h-6 w-6 flex items-center justify-center rounded hover:bg-muted shrink-0"
                      >
                        <MoreHorizontal className="h-3.5 w-3.5 text-muted-foreground" />
                      </button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="w-44" onClick={e => e.stopPropagation()}>
                      <DropdownMenuItem onClick={() => onChatNoteClick?.(note)}>
                        <ExternalLink className="h-3.5 w-3.5 mr-2" />
                        Open
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        className="text-destructive focus:text-destructive"
                        onClick={() => setDeletingNote(note)}
                      >
                        <Trash2 className="h-3.5 w-3.5 mr-2" />
                        Delete
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              </div>
            ))}
            {filtered.length > 0 && (
              <p className="px-2 pt-2 pb-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                Artifacts
              </p>
            )}
          </>
        )}
        {filtered.length === 0 && filteredNotes.length === 0 ? (
          <p className="text-xs text-muted-foreground text-center py-8">No results</p>
        ) : filtered.length === 0 ? null : (
          filtered.map(artifact => {
            const Icon = getArtifactIcon(artifact.type)
            const isSaved = savedArtifactIds.has(artifact.id)
            return (
              <div
                key={artifact.id}
                onClick={() => handleArtifactClick(artifact)}
                title="Click to add to message · Double-click to open"
                className="group flex items-center gap-3 px-2.5 py-2.5 rounded-lg hover:bg-muted/50 transition-colors cursor-pointer"
              >
                <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-muted">
                  <Icon className="h-4 w-4 text-muted-foreground/70" />
                </div>
                <div className="flex-1 min-w-0 relative overflow-hidden">
                  <p className="text-sm font-medium truncate">{artifact.name}</p>
                  <p className="text-xs text-muted-foreground">{ARTIFACT_TYPE_LABELS[artifact.type]} · {getRelativeTime(artifact.updatedAt)}</p>
                  <div className="absolute inset-y-0 right-0 w-12 bg-gradient-to-r from-transparent to-muted/50 opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none" />
                </div>
                <div className="flex items-center gap-0.5 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
                  <button
                    onClick={e => { e.stopPropagation(); onArtifactStage?.(artifact) }}
                    title="Add to message"
                    className="h-6 w-6 flex items-center justify-center rounded hover:bg-muted shrink-0"
                  >
                    <Paperclip className="h-3.5 w-3.5 text-muted-foreground" />
                  </button>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <button
                        onClick={e => e.stopPropagation()}
                        className="h-6 w-6 flex items-center justify-center rounded hover:bg-muted shrink-0"
                      >
                        <MoreHorizontal className="h-3.5 w-3.5 text-muted-foreground" />
                      </button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="w-44" onClick={e => e.stopPropagation()}>
                      <DropdownMenuItem onClick={() => onArtifactClick?.(artifact)}>
                        <ExternalLink className="h-3.5 w-3.5 mr-2" />
                        Open
                      </DropdownMenuItem>
                      {isSaved ? (
                        <DropdownMenuItem disabled>
                          <Check className="h-3.5 w-3.5 mr-2" />
                          Saved to Desk
                        </DropdownMenuItem>
                      ) : (
                        <DropdownMenuItem onClick={() => {
                          onSaveArtifact?.(artifact.id)
                          toast.success(`"${artifact.name}" saved to your Desk`)
                        }}>
                          <BookmarkPlus className="h-3.5 w-3.5 mr-2" />
                          Save to Desk
                        </DropdownMenuItem>
                      )}
                      <DropdownMenuItem
                        className="text-destructive focus:text-destructive"
                        onClick={() => setDeletingArtifact(artifact)}
                      >
                        <Trash2 className="h-3.5 w-3.5 mr-2" />
                        Delete
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              </div>
            )
          })
        )}
      </div>

      <AlertDialog
        open={deletingArtifact !== null || deletingNote !== null}
        onOpenChange={open => { if (!open) { setDeletingArtifact(null); setDeletingNote(null) } }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Delete "{deletingArtifact?.name ?? deletingNote?.label ?? deletingNote?.name}"?
            </AlertDialogTitle>
            <AlertDialogDescription>
              This artifact will be permanently removed from your Desk. This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                if (deletingArtifact) onDeleteArtifact?.(deletingArtifact)
                if (deletingNote) onDeleteChatNote?.(deletingNote)
                setDeletingArtifact(null)
                setDeletingNote(null)
              }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

// ── Right panel: Files tab ─────────────────────────────────────────────────────

/**
 * "In this chat" panel — user uploads sitting under
 * `.chats/{chatId}/attachments/`. Note mirrors (`.chats/{id}/notes/`) are
 * surfaced separately in the Artifacts panel as "Chat notes" and are not
 * listed here.
 *
 * Sidebar uploads land in `.chats/{chatId}/attachments/` (not the workspace
 * library) so the file is scoped to this chat. Files queued for the next
 * outgoing message live in the chat input's staging tray, not here.
 */
function FilesPanel({
  stagedFiles,
  chatFiles,
  libraryItems,
  hasRealChatId,
  uploading,
  onUpload,
  onAddFromLibrary,
  onFileClick,
  onFileStage,
}: {
  stagedFiles: UploadedFile[]
  chatFiles: ServerFile[]
  libraryItems: ContextItem[]
  hasRealChatId: boolean
  uploading: boolean
  onUpload: (entries: UploadEntry[]) => Promise<void>
  onAddFromLibrary: (item: ContextItem) => void
  /** Double-click: open the file in detail view. */
  onFileClick?: (file: ServerFile) => void
  /** Single-click: stage the file on the next outgoing message. */
  onFileStage?: (file: ServerFile) => void
}) {
  const [pickerOpen, setPickerOpen] = useState(false)
  const [search, setSearch] = useState('')
  const [pickerSearch, setPickerSearch] = useState('')

  const handleUpload = async (entries: UploadEntry[]) => {
    await onUpload(entries)
    setPickerOpen(false)
  }

  const handleFileClick = useClickOrDoubleClick<ServerFile>(
    (file) => onFileStage?.(file),
    (file) => onFileClick?.(file),
  )

  // Staged ids are workspace-relative paths (`serverFile.path`), matching
  // ContextItem.id, so simple set membership works for the picker filter.
  const stagedIds = new Set(stagedFiles.map(s => s.id))
  const available = libraryItems.filter(
    c => !stagedIds.has(c.id) &&
    (!pickerSearch || c.name.toLowerCase().includes(pickerSearch.toLowerCase()))
  )

  const addRef = useCallback((item: ContextItem) => {
    onAddFromLibrary(item)
    setPickerOpen(false)
    setPickerSearch('')
  }, [onAddFromLibrary])

  const pickerNav = useListKeyboardNav({
    items: available,
    enabled: pickerOpen,
    onSelect: addRef,
  })

  const filteredChatFiles = chatFiles.filter(f =>
    !search.trim() || f.name.toLowerCase().includes(search.toLowerCase())
  )
  const dropDisabled = uploading
  const overlayLabel = uploading ? 'Uploading…' : 'Drop to add to chat'

  return (
    <FileDropZone
      onFiles={handleUpload}
      disabled={dropDisabled}
      overlayLabel={overlayLabel}
      className="flex flex-col h-full"
    >
      {({ openPicker }) => (
    <div className="flex flex-col h-full">
      {/* Search + Add row */}
      <div className="flex items-center gap-2 px-3 py-2.5 border-b shrink-0">
        <div className="relative flex-1">
          <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3 w-3 text-muted-foreground" />
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search…"
            className="w-full h-7 pl-6 pr-2 rounded-md border bg-background text-xs outline-none placeholder:text-muted-foreground/50 focus:ring-1 focus:ring-ring/30"
          />
        </div>
        <Popover
          open={pickerOpen}
          onOpenChange={open => { setPickerOpen(open); if (!open) setPickerSearch('') }}
        >
          <PopoverTrigger asChild>
            <Button
              size="sm"
              variant="outline"
              className="h-7 text-xs gap-1.5 shrink-0"
            >
              <Plus className="h-3 w-3" />
              Add
            </Button>
          </PopoverTrigger>
          <PopoverContent
            align="end"
            sideOffset={4}
            className="w-72 p-0 rounded-lg overflow-hidden flex flex-col"
          >
            <div className="flex items-center gap-2 px-3 py-2 border-b">
              <Search className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
              <input
                autoFocus
                value={pickerSearch}
                onChange={e => setPickerSearch(e.target.value)}
                onKeyDown={pickerNav.handleKeyDown}
                placeholder="Search files…"
                className="flex-1 text-xs bg-transparent outline-none placeholder:text-muted-foreground/50"
              />
              <button onClick={() => setPickerOpen(false)} className="text-muted-foreground hover:text-foreground">
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
            <div className="overflow-y-auto max-h-52">
              {available.length === 0 && (
                <p className="px-3 py-4 text-xs text-muted-foreground text-center">
                  {pickerSearch ? 'No results' : 'All library items already added'}
                </p>
              )}
              {available.map((item, i) => {
                const Icon = CONTEXT_ICON[item.type] ?? FileText
                const isSelected = pickerNav.selectedIndex === i
                return (
                  <button
                    key={item.id}
                    ref={pickerNav.itemRef(i)}
                    onClick={() => addRef(item)}
                    className={`flex items-center gap-2 w-full px-3 py-1.5 text-sm hover:bg-muted/50 transition-colors text-left ${isSelected ? 'bg-muted/50' : ''}`}
                  >
                    <Icon className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                    <span className="truncate">{item.name}</span>
                  </button>
                )
              })}
            </div>
            <div className="border-t">
              <button
                onClick={() => {
                  setPickerOpen(false)
                  openPicker()
                }}
                disabled={dropDisabled}
                data-testid="files-panel-upload-a-file"
                className="flex items-center gap-2 w-full px-3 py-2 text-sm hover:bg-muted/50 transition-colors text-left text-muted-foreground disabled:opacity-50 disabled:pointer-events-none"
              >
                <Paperclip className="h-3.5 w-3.5 shrink-0" />
                <span>{uploading ? 'Uploading…' : 'Upload a file…'}</span>
              </button>
            </div>
          </PopoverContent>
        </Popover>
      </div>

      <div className="flex-1 overflow-y-auto py-1.5 px-1.5 flex flex-col gap-2">
        {/* Persistent chat-files list — uploads under .chats/{id}/attachments/. */}
        {filteredChatFiles.length > 0 && (
          <div className="flex flex-col gap-0.5">
            <p className="px-2 pt-1 pb-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
              In this chat
            </p>
            {filteredChatFiles.map(file => (
              <button
                key={`chat-${file.path}`}
                type="button"
                onClick={() => handleFileClick(file)}
                disabled={!onFileClick && !onFileStage}
                title="Click to add to message · Double-click to open"
                className="group flex items-center gap-3 px-2.5 py-2 rounded-lg hover:bg-muted/40 transition-colors text-left disabled:cursor-default disabled:hover:bg-transparent"
              >
                <FileText className="h-4 w-4 shrink-0 text-muted-foreground/60" />
                <div className="flex-1 min-w-0">
                  <p className="text-sm truncate">{file.name}</p>
                </div>
              </button>
            ))}
          </div>
        )}

        {filteredChatFiles.length === 0 && (
          search.trim()
            ? <p className="text-xs text-muted-foreground text-center py-8">No results</p>
            : <FilesEmptyState />
        )}
      </div>
    </div>
      )}
    </FileDropZone>
  )
}

// ── Main ChatView ──────────────────────────────────────────────────────────────

export function ChatView({
  chat,
  artifacts = [],
  onArtifactClick,
  onDeleteChat,
  showNewBadge = false,
  savedArtifactIds = new Set(),
  onSaveArtifact,
  onDeleteArtifact,
  onFirstMessage,
  highlightMessageId,
  onAttachmentClick,
  initialStagedItems,
}: ChatViewProps) {
  const focusInputRef = useRef<(() => void) | null>(null)
  const rightTabKey = chat.id && chat.id !== NEW_CHAT_ID ? `desk.chat.${chat.id}.rightTab` : null
  const [rightTab, setRightTab] = usePersistedState<RightTab>(rightTabKey, 'artifacts')
  const [panelOpen, setPanelOpen] = useState(true)
  const [prefillText, setPrefillText] = useState<string | undefined>(undefined)

  const isNewChat = chat.id === NEW_CHAT_ID

  const [postMessageMutation, postMessageState] = usePostChatMessageMutation()
  const [patchChatMutation] = usePatchChatMutation()

  // Pre-creation agent pick for the "new chat" case. Once the chat
  // exists, re-binding flows through PATCH /chats/:id instead. The
  // initial value is seeded from any pending agent id stashed by the
  // artifact-creation sheet's "Skip to chat" path; ChatView is keyed by
  // chat.id, so remounting on navigation refreshes the seed.
  const dispatch = useAppDispatch()
  const pendingNewChatAgentId = useAppSelector(s => s.ui.pendingNewChatAgentId)
  const [newChatAgentId, setNewChatAgentId] = useState<string | null>(
    isNewChat ? pendingNewChatAgentId : null,
  )
  useEffect(() => {
    if (isNewChat && pendingNewChatAgentId) {
      dispatch(setPendingNewChatAgentId(null))
    }
  }, [isNewChat, pendingNewChatAgentId, dispatch])

  const handleAgentChange = useCallback(
    (agentId: string) => {
      if (isNewChat) {
        setNewChatAgentId(agentId)
        return
      }
      if (agentId === chat.agentId) return
      patchChatMutation({ id: chat.id, patch: { agentId } })
        .unwrap()
        .catch(err => {
          toast.error('Could not switch agent', {
            description: err instanceof Error ? err.message : undefined,
          })
        })
    },
    [isNewChat, chat.id, chat.agentId, patchChatMutation],
  )

  // Upload ownership lives at ChatView so the entire chat screen (not
  // just the small input strip) can be a drop target. Drops are held in
  // browser memory until the user sends — the file rides on the next
  // outgoing message as a multipart part, so there is no upload-then-
  // attach two-step and no chat-id requirement. New-chat drops work the
  // same way; the file goes out with the first message.
  const hasRealChatId = !isNewChat
  const [pendingFiles, setPendingFiles] = useState<Array<{ id: string; file: File }>>([])
  // Library-mention tray. Refs only (no File body) — these point at
  // workspace-library files the agent should read in place. Seeded from
  // `initialStagedItems` so the "Use in chat" affordance from a library
  // item lands the file in the tray on the new-chat mount.
  const [stagedFiles, setStagedFiles] = useState<UploadedFile[]>(() =>
    (initialStagedItems ?? []).map(item => ({
      id: item.id,
      name: item.name,
      path: item.id,
      mime: item.mimeType,
    }))
  )

  const handleUpload = useCallback(async (entries: UploadEntry[]) => {
    setPendingFiles(prev => [
      ...prev,
      ...entries.map(({ file }, i) => ({
        id: `pending-${Date.now()}-${i}-${file.name}`,
        file,
      })),
    ])
  }, [])

  const removePendingFile = useCallback((id: string) => {
    setPendingFiles(prev => prev.filter(p => p.id !== id))
  }, [])

  // Sidebar Files-tab dropzone funnels into the same in-memory holding —
  // the distinction between "chat-pane drop" and "Files-tab drop" only
  // existed because the old code had two separate trays. Both now mean
  // "attach to the next outgoing message".
  const handleSidebarUpload = handleUpload

  const [pinChatLibraryRef] = usePinChatLibraryRefMutation()

  // Adding a library file to the chat does two things:
  // (1) stage it for the next outgoing message (existing behavior — the
  //     attachment ref carries the original library path so the agent
  //     reads the file from its real location), and
  // (2) symlink it into `.chats/{chatId}/attachments/` so it stays
  //     visible in the "In this chat" sidebar after send. The pin is
  //     idempotent server-side and best-effort here — staging still
  //     works even if the pin call fails (e.g. on the new-chat stub).
  const addStagedFromLibrary = useCallback((item: ContextItem) => {
    setStagedFiles(prev =>
      prev.some(s => s.id === item.id)
        ? prev
        : [...prev, { id: item.id, name: item.name, path: item.id, mime: item.mimeType }],
    )
    if (hasRealChatId) {
      pinChatLibraryRef({ chatId: chat.id, path: item.id })
        .unwrap()
        .catch(err => {
          // RTK Query rejects with `{ status, data }` from fetchBaseQuery —
          // not an Error — so reach into `data` for the server's message.
          const data = (err as { data?: { message?: string } } | undefined)?.data
          const status = (err as { status?: number | string } | undefined)?.status
          const description = data?.message ?? (status !== undefined ? `HTTP ${status}` : undefined)
          toast.error(`Could not pin ${item.name}`, { description })
        })
    }
  }, [hasRealChatId, chat.id, pinChatLibraryRef])

  const removeStaged = useCallback((id: string) => {
    setStagedFiles(prev => prev.filter(s => s.id !== id))
  }, [])

  // Stages a chat-scoped server file (`.chats/{id}/attachments/...` or
  // `.chats/{id}/notes/...`). Unlike `addStagedFromLibrary`, no pin is
  // attempted — the file already lives under the chat's directory so
  // there's no library path to symlink in.
  const addStagedChatFile = useCallback((file: ServerFile) => {
    const displayName = file.label ?? file.name
    setStagedFiles(prev =>
      prev.some(s => s.id === file.path)
        ? prev
        : [...prev, { id: file.path, name: displayName, path: file.path, mime: file.mime, size: file.size }],
    )
  }, [])

  // Library items for the workspace backing this chat. Used as the pool
  // for the "Add files to chat" picker in the right panel. If the chat
  // doesn't carry a workspaceId yet (new-chat stub) we skip the query.
  const { data: libraryResp } = useGetLibraryQuery(
    chat.workspaceId ? { workspaceId: chat.workspaceId } : undefined,
    { skip: !chat.workspaceId },
  )
  const libraryItems: ContextItem[] = chat.workspaceId
    ? (libraryResp?.items ?? []).map((f) => toContextItem(f, chat.workspaceId!))
    : []

  // Files actually parked in `.chats/{chatId}/`: user uploads + note
  // mirrors. Uploads drive the Files-tab "In this chat" list; note
  // mirrors drive the Artifacts-tab "Chat notes" section. Skipped on
  // the new-chat stub since there's no chat directory yet.
  const { data: chatFilesResp } = useGetChatArtifactsQuery(
    { chatId: hasRealChatId ? chat.id : '', includeNotes: true },
    { skip: !hasRealChatId },
  )
  const chatFiles: ServerFile[] = chatFilesResp ?? []
  // Notes (`.chats/{id}/notes/*.md`) surface in the Artifacts panel under
  // a "Chat notes" section. The Files panel only shows real attachments.
  const chatNotes = useMemo(() => chatFiles.filter(f => f.kind === 'note'), [chatFiles])
  const chatAttachmentFiles = useMemo(() => chatFiles.filter(f => f.kind !== 'note'), [chatFiles])

  const { developerMode } = usePrefs()

  // Focus the composer when a chat is opened. Defers past the
  // scroll-to-bottom and message-load layout shifts that follow
  // mount, so focus reliably lands on the textarea.
  useEffect(() => {
    const t = setTimeout(() => focusInputRef.current?.(), 0)
    return () => clearTimeout(t)
  }, [chat.id])

  // Fallback model label for assistant rows predating per-message model
  // stamping: look up the chat's agent and use its configured model.
  // Post-stamp rows carry their own `model` field and don't hit this path.
  const { data: agents } = useGetAgentsQuery()
  const fallbackModel =
    agents?.find(a => a.id === chat.agentId)?.model ?? 'Agent'

  return (
    <div className="flex flex-1 min-h-0 overflow-hidden">

      {/* ── Left column: header + messages + input ──
          Dropzone stays enabled even before the first message is
          sent: we still want to capture the drop (preventDefault, no
          browser nav-to-file) and show an explanatory toast via
          handleUpload. Dropping never spills into the workspace
          library — chat drops are always chat-scoped. */}
      <FileDropZone
        onFiles={handleUpload}
        overlayLabel={hasRealChatId ? 'Drop to attach to chat' : 'Drop to attach to your first message'}
        className="flex flex-1 flex-col min-w-0 min-h-0 overflow-hidden"
      >
        {({ openPicker }) => (
      <div className="flex flex-1 flex-col min-w-0 min-h-0 overflow-hidden">

        {/* Header */}
        <PageHeader
          breadcrumb={<span className="text-sm font-semibold truncate">{chat.title}</span>}
          actions={
            <>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="icon" className="h-8 w-8">
                    <MoreHorizontal className="h-4 w-4" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-40">
                  <DropdownMenuItem
                    className="text-destructive focus:text-destructive"
                    onClick={() => onDeleteChat?.(chat.id)}
                  >
                    <Trash2 className="h-4 w-4 mr-2" />
                    Delete chat
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>

              {!panelOpen && (
                <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => setPanelOpen(true)}>
                  <PanelRight className="h-4 w-4" />
                </Button>
              )}
            </>
          }
        />

        {/* Messages + Input via shared ChatThread */}
        <ChatThread
          chatId={chat.id}
          skipQuery={isNewChat}
          fallbackModel={fallbackModel}
          developerMode={developerMode}
          isSending={postMessageState.isLoading}
          highlightMessageId={highlightMessageId}
          innerClassName="max-w-2xl mx-auto px-6 py-8 space-y-6"
          onAttachmentClick={onAttachmentClick}
          showNewBadge={showNewBadge}
          emptySlot={
            <div className="flex flex-col items-center justify-center py-24 text-center">
              <Sparkles className="mb-6 h-16 w-16 text-muted-foreground/20" strokeWidth={1} />
              <h2 className="mb-2 text-xl font-semibold text-foreground">What would you like to create?</h2>
              <p className="text-sm text-muted-foreground max-w-sm">
                Describe what you need and I'll build it for you. A document, an app, a design — just ask.
              </p>
              <div className="mt-6 flex flex-wrap justify-center gap-2">
                {STARTER_CHIPS.map((chip) => (
                  <button
                    key={chip}
                    onClick={() => {
                      if (isNewChat) onFirstMessage?.(chip, newChatAgentId ?? undefined)
                      else void postMessageMutation({ chatId: chat.id, content: chip })
                    }}
                    className="rounded-full border bg-background px-3.5 py-1.5 text-sm text-muted-foreground hover:text-foreground hover:border-foreground/20 transition-colors"
                  >
                    {chip}
                  </button>
                ))}
              </div>
            </div>
          }
          lastAssistantSlot={artifacts.length > 0 ? () => (
            <div className="mt-4 flex flex-col gap-2">
              {artifacts.map(artifact => (
                <ArtifactInlineCard
                  key={artifact.id}
                  artifact={artifact}
                  isSaved={savedArtifactIds.has(artifact.id)}
                  onOpen={() => onArtifactClick?.(artifact)}
                  onSave={() => onSaveArtifact?.(artifact.id)}
                />
              ))}
            </div>
          ) : undefined}
          footerSlot={
            <div className="border-t shrink-0">
              <div className="max-w-2xl mx-auto px-6 py-4">
                <ChatInput
                  focusRef={focusInputRef}
                  onSend={(msg, uploads, options) => {
                    // `uploads` carries library-mention refs (path set) plus
                    // pending-file chips (path undefined — the actual File
                    // object lives in `pendingFiles` state below). De-dupe
                    // refs by path so a file staged AND @-mentioned doesn't
                    // appear twice on the wire.
                    const seen = new Set<string>()
                    const attachments: AttachmentRef[] = uploads
                      .filter(u => typeof u.path === 'string')
                      .filter(u => {
                        if (seen.has(u.path!)) return false
                        seen.add(u.path!)
                        return true
                      })
                      .map(u => ({
                        path: u.path!,
                        name: u.name,
                        kind: u.kind,
                        mime: u.mime,
                        size: u.size,
                      }))
                    const files = pendingFiles.map(p => p.file)
                    setPendingFiles([])
                    setStagedFiles([])
                    if (isNewChat) {
                      onFirstMessage?.(
                        msg,
                        newChatAgentId ?? undefined,
                        attachments.length > 0 ? attachments : undefined,
                        options,
                        files.length > 0 ? files : undefined,
                      )
                    } else {
                      postMessageMutation({
                        chatId: chat.id,
                        content: msg,
                        attachments: attachments.length > 0 ? attachments : undefined,
                        files: files.length > 0 ? files : undefined,
                        kind: options?.kind,
                        title: options?.title,
                        executeAt: options?.executeAt,
                        goal: options?.goal,
                      })
                        .unwrap()
                        .catch(err => {
                          const data = (err as { data?: { message?: string } } | undefined)?.data
                          const status = (err as { status?: number | string } | undefined)?.status
                          const description = data?.message ?? (status !== undefined ? `HTTP ${status}` : undefined)
                          toast.error('Failed to send message', { description })
                        })
                    }
                    setPrefillText(undefined)
                  }}
                  placeholder={isNewChat ? 'Ask anything, start a task, build something…' : 'Continue the conversation...'}
                  compact={true}
                  showGoalPicker={true}
                  prefillValue={prefillText}
                  chatAgentId={isNewChat ? (newChatAgentId ?? undefined) : chat.agentId}
                  chatWorkspaceId={chat.workspaceId}
                  chatId={chat.id}
                  onAgentChange={handleAgentChange}
                  draftKey={`chat:${chat.id}`}
                  onOpenUploadPicker={openPicker}
                  extraUploads={[
                    ...pendingFiles.map(p => ({
                      id: p.id,
                      name: p.file.name,
                      mime: p.file.type,
                      size: p.file.size,
                    })),
                    ...stagedFiles,
                  ]}
                  onRemoveExtraUpload={(id) => {
                    removePendingFile(id)
                    removeStaged(id)
                  }}
                  uploadInProgress={false}
                />
              </div>
            </div>
          }
        />
      </div>
        )}
      </FileDropZone>

      {/* ── Right panel: full-height, parallel to the entire left column ── */}
      <div className={`shrink-0 flex flex-col border-l overflow-hidden transition-all duration-300 ${panelOpen ? 'w-[280px]' : 'w-0 border-l-0'}`}>
          {/* Panel header — same height as the main header */}
          <div className="h-[52px] flex items-center justify-between px-3 border-b shrink-0">
            <div className="flex items-center h-8 bg-muted rounded-full p-0.5">
              {(['artifacts', 'files'] as RightTab[]).map(tab => (
                <button
                  key={tab}
                  onClick={() => setRightTab(tab)}
                  className={`rounded-full px-3 text-xs font-medium capitalize transition-colors h-full flex items-center ${
                    rightTab === tab
                      ? 'bg-background text-foreground shadow-sm'
                      : 'text-muted-foreground hover:text-foreground'
                  }`}
                >
                  {tab === 'files' ? 'Files' : 'Artifacts'}
                </button>
              ))}
            </div>
            <Button variant="ghost" size="icon" className="h-8 w-8 shrink-0" onClick={() => setPanelOpen(false)}>
              <PanelRightClose className="h-4 w-4" />
            </Button>
          </div>

          {/* Tab content */}
          <div className="flex-1 overflow-hidden flex flex-col">
            {rightTab === 'artifacts' && (
              <ArtifactsPanel
                chatId={chat.id}
                artifacts={artifacts}
                chatNotes={chatNotes}
                onArtifactClick={onArtifactClick}
                onArtifactStage={(artifact) => {
                  // Workspace artifacts come from the library list — find the
                  // matching ContextItem so addStagedFromLibrary can stage AND
                  // pin (symlink into `.chats/{id}/attachments/`).
                  const item = libraryItems.find(c => c.id === artifact.id)
                  if (item) addStagedFromLibrary(item)
                }}
                onChatNoteClick={(note) =>
                  onAttachmentClick?.({ path: note.path, name: note.label ?? note.name, mime: note.mime, size: note.size })
                }
                onChatNoteStage={addStagedChatFile}
                onPrefillInput={(text) => setPrefillText(text)}
                savedArtifactIds={savedArtifactIds}
                onSaveArtifact={onSaveArtifact}
                onDeleteArtifact={onDeleteArtifact}
              />
            )}
            {rightTab === 'files' && (
              <FilesPanel
                stagedFiles={stagedFiles}
                chatFiles={chatAttachmentFiles}
                libraryItems={libraryItems}
                hasRealChatId={hasRealChatId}
                uploading={false}
                onUpload={handleSidebarUpload}
                onAddFromLibrary={addStagedFromLibrary}
                onFileClick={(file) =>
                  onAttachmentClick?.({ path: file.path, name: file.name, mime: file.mime, size: file.size })
                }
                onFileStage={addStagedChatFile}
              />
            )}
          </div>
        </div>

    </div>
  )
}
