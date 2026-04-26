import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  MoreHorizontal, Trash2, Search, FileText,
  ChevronDown, Link2, StickyNote, Paperclip, Plus, X,
  PanelRight, PanelRightClose, BookmarkPlus, Check, ExternalLink, Sparkles,
} from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import type { UploadedFile } from '@/components/compose/ChatInput'
import { ArtifactInlineCard } from '@/components/shared/ArtifactInlineCard'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { PageHeader } from '@/components/layout/PageHeader'
import { MessageBubble } from '@/components/compose/MessageBubble'
import { ChatInput } from '@/components/compose/ChatInput'
import { StatusIndicator } from '@/components/compose/StatusIndicator'
import type { Chat, Artifact, ContextItem } from '@/data/ui-types'
import { getArtifactIcon, getRelativeTime } from '@/data/ui-types'
import {
  useGetAgentsQuery,
  useGetChatArtifactsQuery,
  useGetChatMessagesQuery,
  useGetLibraryQuery,
  usePatchChatMutation,
  usePostChatMessageMutation,
  useUploadChatArtifactMutation,
  useUploadLibraryFileMutation,
} from '@/store/api'
import { toContextItem } from '@/store/selectors/library'
import { NEW_CHAT_ID } from '@/router/nav'
import type { AttachmentRef, ServerFile, ServerMessage } from '@/store/types'
import { ArtifactsEmptyState, FilesEmptyState } from '@/components/shared/PanelEmptyStates'
import { FileDropZone, type UploadEntry } from '@/components/upload/FileDropZone'
import { useListKeyboardNav } from '@/hooks/use-list-keyboard-nav'

// ── Constants ─────────────────────────────────────────────────────────────────

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
  /**
   * Fires for the "new chat" case on first message. Optional second
   * arg is the agent id picked in the bottom toggle before sending —
   * parent should use it when POST /chats'ing the new chat.
   */
  onFirstMessage?: (message: string, agentId?: string) => void
  /** When set and the id matches a rendered message, scroll that row
   * into view instead of the default scroll-to-bottom. Drives the
   * "open in chat" affordance from the Run detail panel. */
  highlightMessageId?: string
  /** Fires when the user clicks an attachment chip on a chat message —
   * the parent navigates to the file's library detail view. */
  onAttachmentClick?: (attachment: AttachmentRef) => void
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
  artifacts,
  onArtifactClick,
  onPrefillInput,
  savedArtifactIds = new Set(),
  onSaveArtifact,
}: {
  artifacts: Artifact[]
  onArtifactClick?: (artifact: Artifact) => void
  onPrefillInput?: (text: string) => void
  savedArtifactIds?: Set<string>
  onSaveArtifact?: (artifactId: string) => void
}) {
  const [filter, setFilter] = useState<ArtifactFilter>('all')
  const [search, setSearch] = useState('')

  const filtered = artifacts.filter(a => {
    if (filter !== 'all' && a.type !== filter) return false
    if (search.trim() && !a.name.toLowerCase().includes(search.toLowerCase())) return false
    return true
  })

  if (artifacts.length === 0) {
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
        {filtered.length === 0 ? (
          <p className="text-xs text-muted-foreground text-center py-8">No results</p>
        ) : (
          filtered.map(artifact => {
            const Icon = getArtifactIcon(artifact.type)
            const isSaved = savedArtifactIds.has(artifact.id)
            return (
              <div
                key={artifact.id}
                onClick={() => onArtifactClick?.(artifact)}
                className="group flex items-center gap-3 px-2.5 py-2.5 rounded-lg hover:bg-muted/50 transition-colors cursor-pointer"
              >
                <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-muted">
                  <Icon className="h-4 w-4 text-muted-foreground/70" />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium truncate">{artifact.name}</p>
                  <p className="text-xs text-muted-foreground">{ARTIFACT_TYPE_LABELS[artifact.type]} · {getRelativeTime(artifact.updatedAt)}</p>
                </div>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <button
                      onClick={e => e.stopPropagation()}
                      className="opacity-0 group-hover:opacity-100 transition-opacity h-6 w-6 flex items-center justify-center rounded hover:bg-muted shrink-0"
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
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            )
          })
        )}
      </div>
    </div>
  )
}

// ── Right panel: Files tab ─────────────────────────────────────────────────────

/**
 * "In this chat" panel — everything currently sitting under
 * `.chats/{chatId}/`: user uploads (`attachments/`) and materialized note
 * mirrors (`notes/`). Notes are read-only here — they're owned by their DB
 * message row.
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
}: {
  stagedFiles: UploadedFile[]
  chatFiles: ServerFile[]
  libraryItems: ContextItem[]
  hasRealChatId: boolean
  uploading: boolean
  onUpload: (entries: UploadEntry[]) => Promise<void>
  onAddFromLibrary: (item: ContextItem) => void
}) {
  const [pickerOpen, setPickerOpen] = useState(false)
  const [search, setSearch] = useState('')
  const [pickerSearch, setPickerSearch] = useState('')

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
  const dropDisabled = !hasRealChatId || uploading
  const overlayLabel = !hasRealChatId
    ? 'Send a message first to enable uploads'
    : uploading
      ? 'Uploading…'
      : 'Drop to add to chat'

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
        <div className="relative shrink-0">
          <Button
            size="sm"
            variant="outline"
            className="h-7 text-xs gap-1.5"
            onClick={() => { setPickerOpen(v => !v); setPickerSearch('') }}
          >
            <Plus className="h-3 w-3" />
            Add
          </Button>

          {/* Inline dropdown picker */}
          {pickerOpen && (
            <div className="absolute right-0 top-full mt-1 w-72 rounded-lg border bg-background shadow-lg z-50 overflow-hidden flex flex-col">
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
            </div>
          )}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto py-1.5 px-1.5 flex flex-col gap-2">
        {/* Persistent chat-files list — everything under .chats/{id}/. */}
        {filteredChatFiles.length > 0 && (
          <div className="flex flex-col gap-0.5">
            <p className="px-2 pt-1 pb-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
              In this chat
            </p>
            {filteredChatFiles.map(file => {
              const Icon = file.kind === 'note' ? StickyNote : FileText
              return (
                <div
                  key={`chat-${file.path}`}
                  className="group flex items-center gap-3 px-2.5 py-2 rounded-lg hover:bg-muted/40 transition-colors"
                  title={file.kind === 'note' ? 'Note (read-only mirror of a chat note)' : undefined}
                >
                  <Icon className="h-4 w-4 shrink-0 text-muted-foreground/60" />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm truncate">{file.name}</p>
                  </div>
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
  onFirstMessage,
  highlightMessageId,
  onAttachmentClick,
}: ChatViewProps) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const messageRefs = useRef<Map<string, HTMLDivElement>>(new Map())
  const focusInputRef = useRef<(() => void) | null>(null)
  const [rightTab, setRightTab] = useState<RightTab>('artifacts')
  const [panelOpen, setPanelOpen] = useState(true)
  const [prefillText, setPrefillText] = useState<string | undefined>(undefined)

  const isNewChat = chat.id === NEW_CHAT_ID

  // Fetch persisted messages for this chat from the server. Skipped for
  // the "new chat" placeholder (not yet created).
  const { data: serverMsgs, isLoading: messagesLoading } = useGetChatMessagesQuery(
    { chatId: chat.id },
    { skip: isNewChat },
  )
  const [postMessageMutation, postMessageState] = usePostChatMessageMutation()
  const [patchChatMutation] = usePatchChatMutation()

  // Pre-creation agent pick for the "new chat" case. Once the chat
  // exists, re-binding flows through PATCH /chats/:id instead.
  const [newChatAgentId, setNewChatAgentId] = useState<string | null>(null)

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
  // just the small input strip) can be a drop target.
  const [uploadChatArtifact, chatUploadState] = useUploadChatArtifactMutation()
  const [uploadLibraryFile, libraryUploadState] = useUploadLibraryFileMutation()
  const isUploading = chatUploadState.isLoading || libraryUploadState.isLoading
  const hasRealChatId = !isNewChat
  const [pendingUploads, setPendingUploads] = useState<UploadedFile[]>([])
  // Sidebar Files-tab staging tray. Adds (upload or pick-from-library)
  // queue here; on send these merge into the message's `attachments[]`
  // and the tray is cleared. Removing only unstages — the underlying
  // file stays on disk in the library.
  const [stagedFiles, setStagedFiles] = useState<UploadedFile[]>([])

  const handleUpload = useCallback(async (entries: UploadEntry[]) => {
    for (const { file, relativePath } of entries) {
      // For library uploads of dropped folders, preserve the directory
      // structure via `subpath`. Chat artifact uploads live in a flat
      // per-chat folder, so we ignore the subpath there.
      const relDir = relativePath.includes('/')
        ? relativePath.slice(0, relativePath.lastIndexOf('/'))
        : ''
      try {
        if (hasRealChatId) {
          const serverFile = await uploadChatArtifact({ chatId: chat.id, file }).unwrap()
          setPendingUploads(prev => [
            ...prev,
            {
              id: `upload-${serverFile.path ?? Date.now()}`,
              name: serverFile.name ?? file.name,
              path: serverFile.path,
              mime: serverFile.mime,
              size: serverFile.size,
            },
          ])
        } else if (chat.workspaceId) {
          const serverFile = await uploadLibraryFile({
            workspaceId: chat.workspaceId,
            file,
            subpath: relDir || undefined,
          }).unwrap()
          setPendingUploads(prev => [
            ...prev,
            {
              id: `upload-${serverFile.path ?? Date.now()}`,
              name: serverFile.name ?? file.name,
              path: serverFile.path,
              mime: serverFile.mime,
              size: serverFile.size,
            },
          ])
        } else {
          toast.error('Cannot upload: no chat or workspace context')
          return
        }
        toast.success(`Uploaded ${file.name}`)
      } catch (err) {
        toast.error(`Upload failed: ${file.name}`, {
          description: err instanceof Error ? err.message : undefined,
        })
      }
    }
  }, [hasRealChatId, chat.id, chat.workspaceId, uploadChatArtifact, uploadLibraryFile])

  const removePendingUpload = (id: string) =>
    setPendingUploads(prev => prev.filter(u => u.id !== id))

  // Sidebar tray: uploads land in `.chats/{chatId}/attachments/` so the
  // file is scoped to this chat (vs. the workspace library, where every
  // chat sees it). The returned ServerFile is pushed onto the staging
  // tray so it auto-attaches to the next send. Disabled until the chat
  // has a real id — the new-chat stub has no `.chats/{id}/` directory
  // to write into yet.
  const handleSidebarUpload = useCallback(async (entries: UploadEntry[]) => {
    if (!hasRealChatId) {
      toast.error('Send your first message before adding files')
      return
    }
    for (const { file } of entries) {
      try {
        const serverFile = await uploadChatArtifact({ chatId: chat.id, file }).unwrap()
        // Key staging-tray rows by the workspace-relative path so an
        // identical re-upload (rare) collapses cleanly and picker-add
        // dedup uses the same key.
        setStagedFiles(prev =>
          prev.some(s => s.id === serverFile.path)
            ? prev
            : [
                ...prev,
                {
                  id: serverFile.path,
                  name: serverFile.name ?? file.name,
                  path: serverFile.path,
                  mime: serverFile.mime,
                  size: serverFile.size,
                },
              ],
        )
        toast.success(`Uploaded ${file.name}`)
      } catch (err) {
        toast.error(`Upload failed: ${file.name}`, {
          description: err instanceof Error ? err.message : undefined,
        })
      }
    }
  }, [hasRealChatId, chat.id, uploadChatArtifact])

  const addStagedFromLibrary = useCallback((item: ContextItem) => {
    setStagedFiles(prev =>
      prev.some(s => s.id === item.id)
        ? prev
        : [...prev, { id: item.id, name: item.name, path: item.id, mime: item.mimeType }],
    )
  }, [])

  const removeStaged = useCallback((id: string) => {
    setStagedFiles(prev => prev.filter(s => s.id !== id))
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
  // mirrors. Drives the Files-tab "In this chat" section. Skipped on
  // the new-chat stub since there's no chat directory yet.
  const { data: chatFilesResp } = useGetChatArtifactsQuery(
    { chatId: hasRealChatId ? chat.id : '', includeNotes: true },
    { skip: !hasRealChatId },
  )
  const chatFiles: ServerFile[] = chatFilesResp ?? []

  // Filter server messages to what the bubble stream renders. System trigger
  // rows (agent_turn / ai_note_request) are hidden — they drive the typing
  // indicator via `hasPendingTrigger` below, not bubbles.
  const messages: ServerMessage[] = useMemo(
    () => (serverMsgs?.items ?? []).filter(m => m.role === 'user' || m.role === 'agent'),
    [serverMsgs],
  )

  const lastInitialAssistantId = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'agent') return messages[i].id
    }
    return null
  }, [messages])

  // Agent is considered "typing" while the agent_turn trigger for this
  // chat is pending or running, or while the user's POST is in flight.
  // ai_note_request triggers (scheduled ~30 min out) are excluded — those
  // aren't responses to the user's last message.
  const hasPendingTrigger = (serverMsgs?.items ?? []).some(
    m =>
      m.role === 'system' &&
      m.content.type === 'agent_turn' &&
      (m.state === 'pending' || m.state === 'running'),
  )
  const isTyping = hasPendingTrigger || postMessageState.isLoading

  useEffect(() => {
    // Highlight target wins over scroll-to-bottom — only when it
    // matches a rendered message. System messages (agent_turn /
    // ai_note_request) are filtered out of `messages`, so opening a
    // chat via a run that's never fired falls through to normal
    // scroll-to-bottom behaviour.
    if (highlightMessageId) {
      const el = messageRefs.current.get(highlightMessageId)
      if (el) {
        el.scrollIntoView({ block: 'center' })
        return
      }
    }
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [messages, isTyping, highlightMessageId])

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

      {/* ── Left column: header + messages + input ── */}
      <FileDropZone
        onFiles={handleUpload}
        disabled={isUploading}
        overlayLabel={
          isUploading
            ? 'Uploading…'
            : hasRealChatId
              ? 'Drop to attach to chat'
              : chat.workspaceId
                ? 'Drop to add to Library'
                : 'Pick a workspace first'
        }
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

        {/* Messages */}
        <div ref={scrollRef} className="flex-1 overflow-y-auto">
          <div className="max-w-2xl mx-auto px-6 py-8 space-y-6">

            {/* Empty state — shown before any message is sent.
                Suppressed during the initial messages fetch so a slow load
                doesn't briefly look like an empty chat. */}
            {messages.length === 0 && !messagesLoading && (
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
            )}

            {messages.map((msg, i) => (
              <div
                key={msg.id}
                data-message-id={msg.id}
                ref={(el) => {
                  if (el) messageRefs.current.set(msg.id, el)
                  else messageRefs.current.delete(msg.id)
                }}
              >
                <MessageBubble
                  message={msg}
                  fallbackModel={fallbackModel}
                  isFirstInGroup={i === 0 || messages[i - 1].role !== msg.role}
                  isNew={showNewBadge && msg.id === lastInitialAssistantId}
                  onAttachmentClick={onAttachmentClick}
                />
                {/* Inline artifact cards after the last initial assistant message */}
                {artifacts.length > 0 && msg.id === lastInitialAssistantId && (
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
                )}
              </div>
            ))}
            <StatusIndicator text={null} isTyping={isTyping} />
          </div>
        </div>

        {/* Input */}
        <div className="border-t shrink-0">
          <div className="max-w-2xl mx-auto px-6 py-4">
            <ChatInput
              focusRef={focusInputRef}
              onSend={(msg, uploads) => {
                // `uploads` already includes both pendingUploads (chat-input
                // strip) and stagedFiles (sidebar tray) — both flow through
                // ChatInput.extraUploads below. De-dupe by path so a file
                // staged AND attached inline doesn't appear twice.
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
                setPendingUploads([])
                setStagedFiles([])
                if (isNewChat) {
                  onFirstMessage?.(msg, newChatAgentId ?? undefined)
                } else {
                  postMessageMutation({
                    chatId: chat.id,
                    content: msg,
                    attachments: attachments.length > 0 ? attachments : undefined,
                  })
                    .unwrap()
                    .catch(err => {
                      toast.error('Failed to send message', {
                        description: err instanceof Error ? err.message : undefined,
                      })
                    })
                }
                setPrefillText(undefined)
              }}
              placeholder={messages.length === 0 ? 'Ask anything, start a task, build something…' : 'Continue the conversation...'}
              compact={true}
              showGoalPicker={true}
              prefillValue={prefillText}
              chatAgentId={isNewChat ? (newChatAgentId ?? undefined) : chat.agentId}
              chatWorkspaceId={chat.workspaceId}
              chatId={chat.id}
              onAgentChange={handleAgentChange}
              draftKey={`chat:${chat.id}`}
              onOpenUploadPicker={openPicker}
              extraUploads={[...pendingUploads, ...stagedFiles]}
              onRemoveExtraUpload={(id) => {
                removePendingUpload(id)
                removeStaged(id)
              }}
              uploadInProgress={isUploading}
            />
          </div>
        </div>
      </div>
        )}
      </FileDropZone>

      {/* ── Right panel: full-height, parallel to the entire left column ── */}
      {panelOpen && (
        <div className="w-[280px] shrink-0 flex flex-col border-l overflow-hidden">
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
                artifacts={artifacts}
                onArtifactClick={onArtifactClick}
                onPrefillInput={(text) => setPrefillText(text)}
                savedArtifactIds={savedArtifactIds}
                onSaveArtifact={onSaveArtifact}
              />
            )}
            {rightTab === 'files' && (
              <FilesPanel
                stagedFiles={stagedFiles}
                chatFiles={chatFiles}
                libraryItems={libraryItems}
                hasRealChatId={hasRealChatId}
                uploading={chatUploadState.isLoading}
                onUpload={handleSidebarUpload}
                onAddFromLibrary={addStagedFromLibrary}
              />
            )}
          </div>
        </div>
      )}

    </div>
  )
}
