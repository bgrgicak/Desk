import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { Link as RouterLink, useLocation } from 'react-router-dom'
import {
  MoreHorizontal, Trash2, Search, FileText,
  ChevronDown, Folder, Zap, Link2, StickyNote, Paperclip, Plus, X,
  PanelRight, PanelRightClose, BookmarkPlus, Check, ExternalLink, Sparkles,
} from 'lucide-react'
import { toast } from 'sonner'
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
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@agent-desk/ui'
import type { UploadedFile, SendOptions } from '@/components/compose/ChatInput'
import { ArtifactInlineCard } from '@/components/shared/ArtifactInlineCard'
import { PageHeader } from '@/components/layout/PageHeader'
import { ChatThread } from '@/components/compose/ChatThread'
import { MessageBubble } from '@/components/compose/MessageBubble'
import { ChatMenuItems } from '@/components/chats/ChatMenuItems'
import { ChatInput } from '@/components/compose/ChatInput'
import type { Chat, Artifact, ContextItem } from '@/data/ui-types'
import { getArtifactIcon, getRelativeTime } from '@/data/ui-types'
import {
  useDeleteChatAttachmentMutation,
  useGetAgentsQuery,
  useGetChatArtifactsQuery,
  useGetLibraryQuery,
  usePatchChatMutation,
  usePinChatLibraryRefMutation,
  usePostChatMessageMutation,
} from '@/store/api'
import { toContextItem } from '@/store/selectors/library'
import { iconForFile } from '@/data/file-kind'
import { isAppArtifactFile } from '@/store/selectors/artifacts'
import { buildPath, NEW_CHAT_ID } from '@/router/nav'
import { useAppDispatch, useAppSelector, useAppStore } from '@/store/hooks'
import { setPendingNewChatAgentId } from '@/store/slices/uiSlice'
import { setViewingChat } from '@/store/slices/derivedSlice'
import { markChatReadQuietly } from '@/store/ws/middleware'
import type { AttachmentRef, ServerFile, ServerMessage } from '@/store/types'
import { ArtifactsEmptyState, FilesEmptyState } from '@/components/shared/PanelEmptyStates'
import { FileDropZone, type UploadEntry } from '@/components/upload/FileDropZone'
import { useListKeyboardNav } from '@/hooks/use-list-keyboard-nav'
import { usePersistedState } from '@/hooks/use-persisted-state'
import { usePrefs } from '@/hooks/use-prefs'
import { DESKTOP_SIDEBAR_BREAKPOINT, chatRightPanelClassName, isSmallChatViewport, shouldOpenChatSidebarsByDefault } from './chatViewUtils'

function activateOnEnterOrSpace(e: KeyboardEvent<HTMLElement>, action: () => void) {
  if (e.currentTarget !== e.target) return
  if (e.key !== 'Enter' && e.key !== ' ') return
  e.preventDefault()
  action()
}

const STARTER_CHIPS = [
  'Draft a project brief',
  'Build an expense tracker',
  'Summarise my notes',
  'Design a color palette',
]

function isSmallScreen() {
  return isSmallChatViewport()
}

function useIsSmallScreen() {
  const [smallScreen, setSmallScreen] = useState(isSmallScreen)

  useEffect(() => {
    if (typeof window === 'undefined') return

    const query = window.matchMedia(`(max-width: ${DESKTOP_SIDEBAR_BREAKPOINT - 1}px)`)
    const update = () => setSmallScreen(isSmallScreen())

    update()
    query.addEventListener('change', update)
    return () => query.removeEventListener('change', update)
  }, [])

  return smallScreen
}

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
  onFirstMessage?: (
    message: string,
    agentId?: string,
    attachments?: AttachmentRef[],
    options?: SendOptions,
    files?: File[],
    /** Library paths to pin as chat attachments when the chat is created. */
    pinPaths?: string[],
  ) => void
  highlightMessageId?: string
  onAttachmentClick?: (attachment: AttachmentRef) => void
  /** Library items to show in the Files sidebar for the new-chat stub.
   * They are pinned via library-refs once the first message creates the chat. */
  initialStagedItems?: ContextItem[]
  /** When set, the new-chat stub renders this message as the thread anchor. */
  startThread?: string | null
}

// ── Icon helpers ───────────────────────────────────────────────────────────────

const CONTEXT_ICON: Record<ContextItem['type'], typeof FileText> = {
  file: FileText,
  note: StickyNote,
  link: Link2,
  app: Zap,
}

const ARTIFACT_TYPE_LABELS: Record<string, string> = {
  document: 'Doc', app: 'App', image: 'Image', spreadsheet: 'Sheet', site: 'Site',
}

// ── Right panel: Artifacts tab ─────────────────────────────────────────────────

function ArtifactsPanel({
  chatId,
  workspaceId,
  artifacts,
  chatArtifactFiles,
  onArtifactClick,
  onArtifactStage,
  onChatArtifactClick,
  onChatArtifactStage,
  onPrefillInput,
  savedArtifactIds = new Set(),
  onSaveArtifact,
  onDeleteArtifact,
}: {
  chatId: string
  workspaceId?: string
  artifacts: Artifact[]
  /** Agent-written files/dirs from `.chats/{id}/artifacts/`. Rendered as
   *  a "Chat files" section above the workspace artifacts list. */
  chatArtifactFiles: ServerFile[]
  /** Double-click an artifact: open it in detail view. */
  onArtifactClick?: (artifact: Artifact) => void
  /** Single-click an artifact: stage it on the next outgoing message. */
  onArtifactStage?: (artifact: Artifact) => void
  /** Double-click a chat artifact file: open it in detail view. */
  onChatArtifactClick?: (file: ServerFile) => void
  /** Single-click a chat artifact file: stage it on the next outgoing message. */
  onChatArtifactStage?: (file: ServerFile) => void
  onPrefillInput?: (text: string) => void
  savedArtifactIds?: Set<string>
  onSaveArtifact?: (artifactId: string) => void
  onDeleteArtifact?: (artifact: Artifact) => void
}) {
  const filterKey = chatId && chatId !== NEW_CHAT_ID ? `desk.chat.${chatId}.artifactFilter` : null
  const [filter, setFilter] = usePersistedState<ArtifactFilter>(filterKey, 'all')
  const [search, setSearch] = useState('')
  const [deletingArtifact, setDeletingArtifact] = useState<Artifact | null>(null)

  const filtered = artifacts.filter(a => {
    if (filter !== 'all' && a.type !== filter) return false
    if (search.trim() && !a.name.toLowerCase().includes(search.toLowerCase())) return false
    return true
  })
  const filteredChatArtifacts = chatArtifactFiles.filter(n =>
    !search.trim()
    || (n.label ?? '').toLowerCase().includes(search.toLowerCase())
    || n.name.toLowerCase().includes(search.toLowerCase())
  )

  if (artifacts.length === 0 && chatArtifactFiles.length === 0) {
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
        {filteredChatArtifacts.length > 0 && (
          <>
            <p className="px-2 pt-1 pb-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
              Chat files
            </p>
            {filteredChatArtifacts.map(file => {
              const isApp = isAppArtifactFile(file)
              // App directories are openable (the click target points the
              // detail view at the app's manifest so PR-C can render the
              // session-scoped iframe). Plain directories stay
              // non-interactive.
              const isClickable = !file.isDir || isApp
              const FileIcon = isApp ? Zap : file.isDir ? Folder : iconForFile(file.name)
              const subtitle = isApp ? 'App' : file.isDir ? 'Directory' : getRelativeTime(new Date(file.createdAt))
              const href = isClickable && workspaceId ? buildPath(workspaceId, 'context', { item: isApp ? `${file.path}/desk.app.json` : file.path }) : undefined
              const content = (
                <>
                  <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-muted">
                    <FileIcon className="h-4 w-4 text-muted-foreground/70" />
                  </div>
                  <div className="flex-1 min-w-0 relative overflow-hidden">
                    <p className="text-sm font-medium truncate">{file.name}</p>
                    <p className="text-xs text-muted-foreground truncate">{subtitle}</p>
                    <div className="absolute inset-y-0 right-0 w-12 bg-gradient-to-r from-transparent to-muted/50 opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none" />
                  </div>
                </>
              )
              const className = `group flex items-center gap-3 px-2.5 py-2.5 rounded-lg hover:bg-muted/50 transition-colors ${isClickable ? 'cursor-pointer' : ''}`
              return href ? (
                <div key={`artifact-file-${file.path}`} className={className} title={isClickable ? 'Click to open' : file.name}>
                  <RouterLink
                    to={href}
                    className="flex min-w-0 flex-1 items-center gap-3"
                    onClick={(e) => {
                      if (e.button !== 0 || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return
                      onChatArtifactClick?.(file)
                    }}
                    aria-label={`Open ${file.name}`}
                  >
                    {content}
                  </RouterLink>
                  {!file.isDir && (
                    <div className="flex items-center gap-0.5 shrink-0 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity">
                      <button
                        onClick={e => { e.stopPropagation(); onChatArtifactStage?.(file) }}
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
                          {href ? (
                            <DropdownMenuItem asChild>
                              <RouterLink to={href} onClick={() => onChatArtifactClick?.(file)}>
                                <ExternalLink className="h-3.5 w-3.5 mr-2" />
                                Open
                              </RouterLink>
                            </DropdownMenuItem>
                          ) : (
                            <DropdownMenuItem onClick={() => onChatArtifactClick?.(file)}>
                              <ExternalLink className="h-3.5 w-3.5 mr-2" />
                              Open
                            </DropdownMenuItem>
                          )}
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>
                  )}
                </div>
              ) : (
                <div
                  key={`artifact-file-${file.path}`}
                  onClick={() => isClickable && onChatArtifactClick?.(file)}
                  onKeyDown={e => {
                    if (isClickable) activateOnEnterOrSpace(e, () => onChatArtifactClick?.(file))
                  }}
                  role={isClickable ? 'button' : undefined}
                  tabIndex={isClickable ? 0 : undefined}
                  aria-label={isClickable ? `Open ${file.name}` : undefined}
                  title={isClickable ? 'Click to open' : file.name}
                  className={className}
                >
                  {content}
                  {!file.isDir && (
                    <div className="flex items-center gap-0.5 shrink-0 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity">
                      <button
                        onClick={e => { e.stopPropagation(); onChatArtifactStage?.(file) }}
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
                          <DropdownMenuItem onClick={() => onChatArtifactClick?.(file)}>
                            <ExternalLink className="h-3.5 w-3.5 mr-2" />
                            Open
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>
                  )}
                </div>
              )
            })}
            {filtered.length > 0 && (
              <p className="px-2 pt-2 pb-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                Artifacts
              </p>
            )}
          </>
        )}
        {filtered.length === 0 && filteredChatArtifacts.length === 0 ? (
          <p className="text-xs text-muted-foreground text-center py-8">No results</p>
        ) : filtered.length === 0 ? null : (
          filtered.map(artifact => {
            const Icon = getArtifactIcon(artifact.type)
            const isSaved = savedArtifactIds.has(artifact.id)
            const href = workspaceId ? buildPath(workspaceId, 'pinned', { artifact: artifact.id }) : undefined
            const content = (
              <>
                <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-muted">
                  <Icon className="h-4 w-4 text-muted-foreground/70" />
                </div>
                <div className="flex-1 min-w-0 relative overflow-hidden">
                  <p className="text-sm font-medium truncate">{artifact.name}</p>
                  <p className="text-xs text-muted-foreground">{ARTIFACT_TYPE_LABELS[artifact.type]} · {getRelativeTime(artifact.updatedAt)}</p>
                  <div className="absolute inset-y-0 right-0 w-12 bg-gradient-to-r from-transparent to-muted/50 opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none" />
                </div>
              </>
            )
            const actions = (
              <div className="flex items-center gap-0.5 shrink-0 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity">
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
                    {href ? (
                      <DropdownMenuItem asChild>
                        <RouterLink to={href} onClick={() => onArtifactClick?.(artifact)}>
                          <ExternalLink className="h-3.5 w-3.5 mr-2" />
                          Open
                        </RouterLink>
                      </DropdownMenuItem>
                    ) : (
                      <DropdownMenuItem onClick={() => onArtifactClick?.(artifact)}>
                        <ExternalLink className="h-3.5 w-3.5 mr-2" />
                        Open
                      </DropdownMenuItem>
                    )}
                    {isSaved ? (
                      <DropdownMenuItem disabled>
                        <Check className="h-3.5 w-3.5 mr-2" />
                        In Library
                      </DropdownMenuItem>
                    ) : (
                      <DropdownMenuItem onClick={() => {
                        onSaveArtifact?.(artifact.id)
                        toast.success(`"${artifact.name}" moved to your Library`)
                      }}>
                        <BookmarkPlus className="h-3.5 w-3.5 mr-2" />
                        Save to Library
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
            )
            if (href) {
              return (
                <div
                  key={artifact.id}
                  title="Click to open"
                  className="group flex items-center gap-3 px-2.5 py-2.5 rounded-lg hover:bg-muted/50 transition-colors cursor-pointer"
                >
                  <RouterLink
                    to={href}
                    className="flex min-w-0 flex-1 items-center gap-3"
                    onClick={(e) => {
                      if (e.button !== 0 || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return
                      onArtifactClick?.(artifact)
                    }}
                    aria-label={`Open ${artifact.name}`}
                  >
                    {content}
                  </RouterLink>
                  {actions}
                </div>
              )
            }
            return (
              <div
                key={artifact.id}
                onClick={() => onArtifactClick?.(artifact)}
                onKeyDown={e => activateOnEnterOrSpace(e, () => onArtifactClick?.(artifact))}
                role="button"
                tabIndex={0}
                aria-label={`Open ${artifact.name}`}
                title="Click to open"
                className="group flex items-center gap-3 px-2.5 py-2.5 rounded-lg hover:bg-muted/50 transition-colors cursor-pointer"
              >
                {content}
                <div className="flex items-center gap-0.5 shrink-0 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity">
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
                          In Library
                        </DropdownMenuItem>
                      ) : (
                        <DropdownMenuItem onClick={() => {
                          onSaveArtifact?.(artifact.id)
                          toast.success(`"${artifact.name}" moved to your Library`)
                        }}>
                          <BookmarkPlus className="h-3.5 w-3.5 mr-2" />
                          Save to Library
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
        open={deletingArtifact !== null}
        onOpenChange={open => { if (!open) setDeletingArtifact(null) }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Delete "{deletingArtifact?.name}"?
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
                setDeletingArtifact(null)
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
 * `.chats/{chatId}/attachments/`. Summary mirrors (`.chats/{id}/notes/`) are
 * Desk-managed memory and are not listed here; summary messages are visible in
 * the chat stream only when developer mode is enabled.
 *
 * Sidebar uploads land in `.chats/{chatId}/attachments/` (not the workspace
 * library) so the file is scoped to this chat. Files queued for the next
 * outgoing message live in the chat input's staging tray, not here.
 */
function FilesPanel({
  workspaceId,
  stagedFiles,
  chatFiles,
  libraryItems,
  uploading,
  onUpload,
  onAddFromLibrary,
  onFileClick,
  onFileStage,
  onFileRemove,
}: {
  workspaceId?: string
  stagedFiles: UploadedFile[]
  chatFiles: ServerFile[]
  libraryItems: ContextItem[]
  hasRealChatId: boolean
  uploading: boolean
  onUpload: (entries: UploadEntry[]) => Promise<void>
  onAddFromLibrary: (item: ContextItem) => void
  /** Double-click: open the file in detail view. */
  onFileClick?: (file: ServerFile) => void
  /** Single-click (or kebab "Use in chat"): stage the file for the
   * next outgoing message. */
  onFileStage?: (file: ServerFile) => void
  /** Kebab "Remove": unlink the entry from the chat's attachments dir. */
  onFileRemove?: (file: ServerFile) => void
}) {
  const [pickerOpen, setPickerOpen] = useState(false)
  const [search, setSearch] = useState('')
  const [pickerSearch, setPickerSearch] = useState('')
  const [removingFile, setRemovingFile] = useState<ServerFile | null>(null)

  const handleUpload = async (entries: UploadEntry[]) => {
    await onUpload(entries)
    setPickerOpen(false)
  }

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
            <div className="border-b">
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
            {filteredChatFiles.map(file => {
              const Icon = iconForFile(file.name, file.mime)
              const interactive = onFileClick || onFileStage
              const href = onFileClick && workspaceId ? buildPath(workspaceId, 'context', { item: file.path }) : undefined
              const className = `group flex items-center gap-3 px-2.5 py-2 rounded-lg hover:bg-muted/40 transition-colors ${interactive ? 'cursor-pointer' : ''}`
              const content = (
                <>
                  <Icon className="h-4 w-4 shrink-0 text-muted-foreground/60" />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm truncate">{file.name}</p>
                  </div>
                </>
              )
              const actions = (
                <div className="flex items-center gap-0.5 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
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
                      {onFileStage && (
                        <DropdownMenuItem onClick={() => onFileStage(file)}>
                          <Paperclip className="h-3.5 w-3.5 mr-2" />
                          Use in chat
                        </DropdownMenuItem>
                      )}
                      {onFileClick && (
                        href ? (
                          <DropdownMenuItem asChild>
                            <RouterLink to={href} onClick={() => onFileClick(file)}>
                              <ExternalLink className="h-3.5 w-3.5 mr-2" />
                              Open
                            </RouterLink>
                          </DropdownMenuItem>
                        ) : (
                          <DropdownMenuItem onClick={() => onFileClick(file)}>
                            <ExternalLink className="h-3.5 w-3.5 mr-2" />
                            Open
                          </DropdownMenuItem>
                        )
                      )}
                      {onFileRemove && (
                        <DropdownMenuItem
                          className="text-destructive focus:text-destructive"
                          onClick={() => setRemovingFile(file)}
                        >
                          <Trash2 className="h-3.5 w-3.5 mr-2" />
                          Remove
                        </DropdownMenuItem>
                      )}
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              )
              if (href) {
                return (
                  <div
                    key={`chat-${file.path}`}
                    title="Click to open"
                    className={className}
                  >
                    <RouterLink
                      to={href}
                      className="flex min-w-0 flex-1 items-center gap-3"
                      onClick={(e) => {
                        if (e.button !== 0 || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return
                        onFileClick?.(file)
                      }}
                    >
                      {content}
                    </RouterLink>
                    {actions}
                  </div>
                )
              }
              return (
                <div
                  key={`chat-${file.path}`}
                  onClick={interactive ? () => onFileClick?.(file) : undefined}
                  title="Click to open"
                  className={className}
                >
                  {content}
                  {actions}
                </div>
              )
            })}
          </div>
        )}

        {filteredChatFiles.length === 0 && (
          search.trim()
            ? <p className="text-xs text-muted-foreground text-center py-8">No results</p>
            : <FilesEmptyState />
        )}
      </div>

      <AlertDialog
        open={removingFile !== null}
        onOpenChange={open => { if (!open) setRemovingFile(null) }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Remove "{removingFile?.label ?? removingFile?.name}" from this chat?
            </AlertDialogTitle>
            <AlertDialogDescription>
              The file's library entry (if any) will not be affected. Direct chat uploads are removed permanently.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                if (removingFile) onFileRemove?.(removingFile)
                setRemovingFile(null)
              }}
            >
              Remove
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
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
  startThread,
}: ChatViewProps) {
  const focusInputRef = useRef<(() => void) | null>(null)
  const location = useLocation()
  const anchorMessage = startThread
    ? (location.state as { anchorMessage?: ServerMessage } | null)?.anchorMessage ?? null
    : null
  const rightTabKey = chat.id && chat.id !== NEW_CHAT_ID ? `desk.chat.${chat.id}.rightTab` : null
  const [rightTab, setRightTab] = usePersistedState<RightTab>(rightTabKey, 'artifacts')
  const rightPanelOpenKey = chat.id && chat.id !== NEW_CHAT_ID ? `desk.chat.${chat.id}.rightPanelOpen` : null
  const [panelOpen, setPanelOpen] = usePersistedState<boolean>(rightPanelOpenKey, shouldOpenChatSidebarsByDefault())
  const isSmallViewport = useIsSmallScreen()
  const [prefillText, setPrefillText] = useState<string | undefined>(undefined)

  const setPanelOpenFromUser = useCallback((open: boolean) => {
    setPanelOpen(open)
  }, [setPanelOpen])

  const isNewChat = chat.id === NEW_CHAT_ID

  const dispatch = useAppDispatch()
  const store = useAppStore()
  const [postMessageMutation, postMessageState] = usePostChatMessageMutation()
  const [patchChatMutation] = usePatchChatMutation()

  // Track which chat the user is viewing so the WS middleware can suppress
  // unread-dot flashes for messages arriving in the active chat.
  // useLayoutEffect ensures viewingChatId is set synchronously before the
  // browser paints, closing the window where a WS event could arrive
  // between mount and viewingChatId being set (useEffect fires after
  // paint, leaving a gap where the middleware treats the viewed chat as
  // non-viewed and flashes the unread dot).
  useLayoutEffect(() => {
    if (!isNewChat) {
      dispatch(setViewingChat(chat.id))
      return () => { dispatch(setViewingChat(null)) }
    }
  }, [isNewChat, chat.id, dispatch])

  // Mark the chat as read on the server whenever the user is viewing it
  // and the server-side unread flag is true (initial open or agent reply).
  // Uses markChatReadQuietly (raw PATCH + cache patch) instead of the RTK
  // Query mutation to avoid Chat tag invalidation which races with the
  // unread update and causes a visible dot flash.
  useEffect(() => {
    if (!isNewChat && chat.unread) {
      markChatReadQuietly(chat.id, dispatch, store.getState)
    }
  }, [isNewChat, chat.id, chat.unread, dispatch, store])

  // Pre-creation agent pick for the "new chat" case. Once the chat
  // exists, re-binding flows through PATCH /chats/:id instead. The
  // initial value is seeded from any pending agent id stashed by the
  // artifact-creation sheet's "Skip to chat" path; ChatView is keyed by
  // chat.id, so remounting on navigation refreshes the seed.
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
  // workspace-library files the agent should read in place.
  const [stagedFiles, setStagedFiles] = useState<UploadedFile[]>([])
  // Library items to be pinned as chat attachments when the first message
  // creates the chat. Shown in the Files sidebar (not the message input tray).
  const [pendingChatItems, setPendingChatItems] = useState<ContextItem[]>(
    () => initialStagedItems ?? [],
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
  const [deleteChatAttachment] = useDeleteChatAttachmentMutation()

  const addStagedFromLibrary = useCallback((item: ContextItem) => {
    if (hasRealChatId) {
      pinChatLibraryRef({ chatId: chat.id, path: item.id })
        .unwrap()
        .catch(err => {
          const data = (err as { data?: { message?: string } } | undefined)?.data
          const status = (err as { status?: number | string } | undefined)?.status
          const description = data?.message ?? (status !== undefined ? `HTTP ${status}` : undefined)
          toast.error(`Could not pin ${item.name}`, { description })
        })
    } else {
      // New-chat stub: track as pending so it shows in the Files sidebar.
      // The pin fires via pinPaths when the first message creates the chat.
      setPendingChatItems(prev =>
        prev.some(p => p.id === item.id) ? prev : [...prev, item],
      )
    }
  }, [hasRealChatId, chat.id, pinChatLibraryRef])

  const removeStaged = useCallback((id: string) => {
    setStagedFiles(prev => prev.filter(s => s.id !== id))
  }, [])

  // Stages a chat-scoped server file (`.chats/{id}/attachments/...` or
  // `.chats/{id}/artifacts/...`). Unlike `addStagedFromLibrary`, no pin is
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

  // Removes a chat attachment (kebab → "Remove" in the Files panel).
  // Symlinks: only the link in `.chats/{chatId}/attachments/` goes away
  // — the source library file is untouched. Direct uploads are gone for
  // good. Also drops the row from the staging tray if it was queued.
  const removeChatFile = useCallback((file: ServerFile) => {
    if (!hasRealChatId) return
    const name = file.label ?? file.name
    setStagedFiles(prev => prev.filter(s => s.id !== file.path))
    deleteChatAttachment({ chatId: chat.id, name: file.name })
      .unwrap()
      .then(() => {
        toast.success(`Removed "${name}" from chat`)
      })
      .catch(err => {
        const data = (err as { data?: { message?: string } } | undefined)?.data
        const status = (err as { status?: number | string } | undefined)?.status
        const description = data?.message ?? (status !== undefined ? `HTTP ${status}` : undefined)
        toast.error(`Could not remove ${name}`, { description })
      })
  }, [hasRealChatId, chat.id, deleteChatAttachment])

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

  // Files actually parked in `.chats/{chatId}/`: user uploads + agent
  // artifact files/dirs. Uploads drive the Files-tab "In this chat" list;
  // artifact entries drive the Artifacts-tab "Chat files" section. Skipped
  // on the new-chat stub since there's no chat directory yet.
  const { data: chatFilesResp } = useGetChatArtifactsQuery(
    { chatId: hasRealChatId ? chat.id : '', includeArtifacts: true },
    { skip: !hasRealChatId },
  )
  const chatFiles: ServerFile[] = chatFilesResp ?? []
  // Agent artifacts (`.chats/{id}/artifacts/`) surface in the Artifacts panel
  // under a "Chat files" section. The Files panel only shows real attachments.
  const chatArtifactFiles = useMemo(() => chatFiles.filter(f => f.kind === 'artifact'), [chatFiles])
  const chatAttachmentFiles = useMemo(() => chatFiles.filter(f => f.kind !== 'artifact'), [chatFiles])
  // Merge pending-chat items into the sidebar list without duplicating files
  // that were already pinned (the server query will include them after the pin).
  const visibleChatAttachmentFiles = useMemo(() => {
    if (pendingChatItems.length === 0) return chatAttachmentFiles
    const pinnedPaths = new Set(chatAttachmentFiles.map(f => f.path.split('/').pop()))
    const pendingFiles = pendingChatItems
      .filter(item => !pinnedPaths.has(item.name))
      .map(item => ({
        path: item.id,
        name: item.name,
        mime: item.mimeType ?? 'application/octet-stream',
        size: item.size ?? 0,
        createdAt: item.addedAt.toISOString(),
        kind: 'attachment' as const,
      }))
    return [...chatAttachmentFiles, ...pendingFiles]
  }, [chatAttachmentFiles, pendingChatItems])

  const { developerMode } = usePrefs()

  // Focus the composer when a chat is opened. Defers past the
  // scroll-to-bottom and message-load layout shifts that follow
  // mount, so focus reliably lands on the textarea.
  useEffect(() => {
    const t = setTimeout(() => focusInputRef.current?.(), 0)
    return () => clearTimeout(t)
  }, [chat.id])

  const { data: agents } = useGetAgentsQuery()
  const agentName =
    agents?.find(a => a.id === chat.agentId)?.name ?? 'Agent'

  return (
    <div className="relative flex w-full max-w-full flex-1 min-w-0 min-h-0 overflow-hidden">

      {/* ── Left column: header + messages + input ──
          Dropzone stays enabled even before the first message is
          sent: we still want to capture the drop (preventDefault, no
          browser nav-to-file) and show an explanatory toast via
          handleUpload. Dropping never spills into the workspace
          library — chat drops are always chat-scoped. */}
      <FileDropZone
        onFiles={handleUpload}
        overlayLabel={hasRealChatId ? 'Drop to attach to chat' : 'Drop to attach to your first message'}
        className="flex flex-1 flex-col min-w-0 min-h-0 w-full max-w-full overflow-hidden"
      >
        {({ openPicker }) => (
      <div className="flex flex-1 flex-col min-w-0 min-h-0 w-full max-w-full overflow-hidden">

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
                  <ChatMenuItems chatId={chat.id} onDelete={(id) => onDeleteChat?.(id)} />
                </DropdownMenuContent>
              </DropdownMenu>

              {!panelOpen && (
                <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => setPanelOpenFromUser(true)}>
                  <PanelRight className="h-4 w-4" />
                </Button>
              )}
            </>
          }
        />

        {/* Messages + Input via shared ChatThread */}
        <ChatThread
          chatId={chat.id}
          workspaceId={chat.workspaceId}
          skipQuery={isNewChat}
          agentName={agentName}
          developerMode={developerMode}
          isSending={postMessageState.isLoading}
          highlightMessageId={highlightMessageId}
          innerClassName="px-4 sm:px-6 py-8 space-y-6"
          messageClassName={message => {
            if (message.content.type !== 'artifactRef') return 'max-w-2xl min-w-0 mx-auto'
            return 'max-w-2xl min-w-0 mx-auto'
          }}
          statusClassName="max-w-2xl min-w-0 mx-auto"
          agentHeaderClassName="max-w-2xl min-w-0 mx-auto"
          lastAssistantSlotClassName="w-full min-w-0"
          onAttachmentClick={onAttachmentClick}
          showNewBadge={showNewBadge}
          emptySlot={
            anchorMessage ? (
              <div className="max-w-2xl min-w-0 mx-auto">
                <MessageBubble
                  message={anchorMessage}
                  workspaceId={anchorMessage.chatId ? chat.workspaceId : undefined}
                />
              </div>
            ) : (
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
            )
          }
          lastAssistantSlot={artifacts.length > 0 ? () => (
            <div className="mt-4 flex flex-col gap-2">
              {artifacts.map(artifact => (
                <ArtifactInlineCard
                  key={artifact.id}
                  artifact={artifact}
                  workspaceId={chat.workspaceId}
                  isSaved={savedArtifactIds.has(artifact.id)}
                  onOpen={() => onArtifactClick?.(artifact)}
                  onSave={() => onSaveArtifact?.(artifact.id)}
                />
              ))}
            </div>
          ) : undefined}
          footerSlot={
            <div className="border-t shrink-0 min-w-0 max-w-full overflow-hidden">
              <div className="w-full max-w-2xl min-w-0 mx-auto px-4 sm:px-6 py-4">
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
                    const pinPaths = pendingChatItems.map(i => i.id)
                    setPendingFiles([])
                    setStagedFiles([])
                    setPendingChatItems([])
                    if (isNewChat) {
                      onFirstMessage?.(
                        msg,
                        newChatAgentId ?? undefined,
                        attachments.length > 0 ? attachments : undefined,
                        options,
                        files.length > 0 ? files : undefined,
                        pinPaths.length > 0 ? pinPaths : undefined,
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
                        goal: options && 'goal' in options ? options.goal : undefined,
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
                  goal={chat.goal ?? null}
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
      <div className={chatRightPanelClassName(panelOpen, isSmallViewport)}>
        {panelOpen && (
          <>
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
            <Button variant="ghost" size="icon" className="h-8 w-8 shrink-0" onClick={() => setPanelOpenFromUser(false)}>
              <PanelRightClose className="h-4 w-4" />
            </Button>
          </div>

          {/* Tab content */}
          <div className="flex-1 overflow-hidden flex flex-col">
            {rightTab === 'artifacts' && (
              <ArtifactsPanel
                chatId={chat.id}
                workspaceId={chat.workspaceId}
                artifacts={artifacts}
                chatArtifactFiles={chatArtifactFiles}
                onArtifactClick={onArtifactClick}
                onArtifactStage={(artifact) => {
                  // Workspace artifacts come from the library list — find the
                  // matching ContextItem so addStagedFromLibrary can stage AND
                  // pin (symlink into `.chats/{id}/attachments/`).
                  const item = libraryItems.find(c => c.id === artifact.id)
                  if (item) addStagedFromLibrary(item)
                }}
                onChatArtifactClick={(file) => {
                  // For a `<name>.app/` chat artifact, route the click at the
                  // app's `desk.app.json`; ContextDetail uses AppPreview to
                  // issue a scoped app session and render `/apps/chat/...`.
                  if (isAppArtifactFile(file)) {
                    onAttachmentClick?.({
                      path: `${file.path}/desk.app.json`,
                      name: file.label ?? file.name,
                      mime: 'application/json',
                      size: file.size,
                    })
                    return
                  }
                  onAttachmentClick?.({
                    path: file.path,
                    name: file.label ?? file.name,
                    mime: file.mime,
                    size: file.size,
                  })
                }}
                onChatArtifactStage={addStagedChatFile}
                onPrefillInput={(text) => setPrefillText(text)}
                savedArtifactIds={savedArtifactIds}
                onSaveArtifact={onSaveArtifact}
                onDeleteArtifact={onDeleteArtifact}
              />
            )}
            {rightTab === 'files' && (
              <FilesPanel
                workspaceId={chat.workspaceId}
                stagedFiles={stagedFiles}
                chatFiles={visibleChatAttachmentFiles}
                libraryItems={libraryItems}
                hasRealChatId={hasRealChatId}
                uploading={false}
                onUpload={handleSidebarUpload}
                onAddFromLibrary={addStagedFromLibrary}
                onFileClick={(file) =>
                  onAttachmentClick?.({ path: file.path, name: file.name, mime: file.mime, size: file.size })
                }
                onFileStage={addStagedChatFile}
                onFileRemove={hasRealChatId ? removeChatFile : undefined}
              />
            )}
          </div>
          </>
        )}
        </div>

    </div>
  )
}
