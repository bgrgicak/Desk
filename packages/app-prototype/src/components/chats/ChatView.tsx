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
import { SidebarTrigger } from '@/components/ui/sidebar'
import { ChatMessage } from '@/components/compose/ChatMessage'
import { ChatInput } from '@/components/compose/ChatInput'
import { StatusIndicator } from '@/components/compose/StatusIndicator'
import { useMockChat } from '@/hooks/use-mock-chat'
import type { Chat, Artifact, ChatMessage as ChatMessageType, ComposeScenario, ContextItem } from '@/data/ui-types'
import { getArtifactIcon, getRelativeTime } from '@/data/ui-types'
import {
  useGetChatMessagesQuery,
  useGetLibraryQuery,
  usePostChatMessageMutation,
  useUploadChatArtifactMutation,
  useUploadLibraryFileMutation,
} from '@/store/api'
import { toContextItem } from '@/store/selectors/library'
import type { AgentLogEntry, ServerMessage } from '@/store/types'
import { ArtifactsEmptyState, FilesEmptyState } from '@/components/shared/PanelEmptyStates'
import { FileDropZone } from '@/components/upload/FileDropZone'

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
  onFirstMessage?: (message: string) => void
  onArtifactAdded?: (artifact: Artifact) => void
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

function renderableTextFromLog(log: AgentLogEntry[]): string {
  const parts: string[] = []
  let sawEvent = false
  for (const e of log) {
    if (e.kind === 'event') {
      sawEvent = true
      if (e.event.type === 'text') {
        const t = e.event.part?.text
        if (typeof t === 'string') parts.push(t)
      }
    }
  }
  if (sawEvent) return parts.join('').trim()
  return log
    .filter((e) => e.kind === 'unparsed')
    .map((e) => (e as { line: string }).line)
    .join('\n')
    .trim()
}

function toUiChatMessage(m: ServerMessage): ChatMessageType {
  const role: ChatMessageType['role'] = m.role === 'agent' ? 'assistant' : 'user'
  let content = ''
  if (m.content.type === 'text') content = m.content.text
  else if (m.content.type === 'note') content = m.content.body
  else if (m.content.type === 'artifactRef') content = `(artifact) ${m.content.name ?? m.content.path}`
  else if (m.content.type === 'events') content = renderableTextFromLog(m.content.log)
  else content = `(${m.content.type})`
  return {
    id: m.id,
    role,
    content,
    timestamp: new Date(m.createdAt),
  }
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

function FilesPanel({
  initialReferenceIds,
  libraryItems,
  workspaceId,
}: {
  initialReferenceIds: string[]
  libraryItems: ContextItem[]
  workspaceId?: string
}) {
  const [refs, setRefs] = useState<ContextItem[]>(() =>
    initialReferenceIds
      .map(id => libraryItems.find(c => c.id === id))
      .filter(Boolean) as ContextItem[]
  )
  const [pickerOpen, setPickerOpen] = useState(false)
  const [search, setSearch] = useState('')
  const [pickerSearch, setPickerSearch] = useState('')
  const [uploadLibraryFile, uploadState] = useUploadLibraryFileMutation()

  const handleUpload = async (files: File[]) => {
    if (!workspaceId) {
      toast.error('Cannot upload: no workspace context')
      return
    }
    for (const file of files) {
      try {
        const serverFile = await uploadLibraryFile({ workspaceId, file }).unwrap()
        setRefs(prev => [
          ...prev,
          {
            id: serverFile.id ?? serverFile.path ?? `upload-${Date.now()}`,
            type: 'file',
            name: serverFile.name ?? file.name,
            content: '',
            addedAt: new Date(),
            usedBy: [],
            uploadedBy: 'user',
            relatedArtifactIds: [],
          },
        ])
        toast.success(`Uploaded ${file.name}`)
      } catch (err) {
        toast.error(`Upload failed: ${file.name}`, {
          description: err instanceof Error ? err.message : undefined,
        })
      }
    }
    setPickerOpen(false)
  }

  const filteredRefs = refs.filter(r =>
    !search.trim() || r.name.toLowerCase().includes(search.toLowerCase())
  )

  const available = libraryItems.filter(
    c => !refs.some(r => r.id === c.id) &&
    (!pickerSearch || c.name.toLowerCase().includes(pickerSearch.toLowerCase()))
  )

  const removeRef = (id: string) => setRefs(prev => prev.filter(r => r.id !== id))
  const addRef = (item: ContextItem) => {
    setRefs(prev => [...prev, item])
    setPickerOpen(false)
    setPickerSearch('')
  }

  return (
    <FileDropZone
      onFiles={handleUpload}
      disabled={!workspaceId || uploadState.isLoading}
      overlayLabel={workspaceId ? 'Drop to add to Library' : 'No workspace selected'}
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
                {available.map(item => {
                  const Icon = CONTEXT_ICON[item.type] ?? FileText
                  return (
                    <button
                      key={item.id}
                      onClick={() => addRef(item)}
                      className="flex items-center gap-2 w-full px-3 py-1.5 text-sm hover:bg-muted/50 transition-colors text-left"
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
                  disabled={!workspaceId || uploadState.isLoading}
                  data-testid="files-panel-upload-a-file"
                  className="flex items-center gap-2 w-full px-3 py-2 text-sm hover:bg-muted/50 transition-colors text-left text-muted-foreground disabled:opacity-50 disabled:pointer-events-none"
                >
                  <Paperclip className="h-3.5 w-3.5 shrink-0" />
                  <span>{uploadState.isLoading ? 'Uploading…' : 'Upload a file…'}</span>
                </button>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Reference list */}
      <div className="flex-1 overflow-y-auto py-1.5 px-1.5 flex flex-col gap-0.5">
        {refs.length === 0 ? (
          <FilesEmptyState />
        ) : filteredRefs.length === 0 ? (
          <p className="text-xs text-muted-foreground text-center py-8">No results</p>
        ) : (
          filteredRefs.map(ref => {
            const Icon = CONTEXT_ICON[ref.type] ?? FileText
            return (
              <div
                key={ref.id}
                className="group flex items-center gap-3 px-2.5 py-2 rounded-lg hover:bg-muted/40 transition-colors"
              >
                <Icon className="h-4 w-4 shrink-0 text-muted-foreground/60" />
                <div className="flex-1 min-w-0">
                  <p className="text-sm truncate">{ref.name}</p>
                  <p className="text-xs text-muted-foreground capitalize">{ref.type}</p>
                </div>
                <button
                  onClick={() => removeRef(ref.id)}
                  className="opacity-0 group-hover:opacity-100 transition-opacity p-1 rounded hover:bg-muted text-muted-foreground hover:text-destructive"
                  title="Remove from chat"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            )
          })
        )}
      </div>
    </div>
      )}
    </FileDropZone>
  )
}

// ── Uploaded file card (shown above user message) ─────────────────────────────

function UploadedFileCard({ file }: { file: UploadedFile }) {
  const [saved, setSaved] = useState(false)
  return (
    <div className="flex items-center gap-3 rounded-lg border bg-background px-3 py-2.5 mb-1.5 w-80">
      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-muted">
        <FileText className="h-3.5 w-3.5 text-muted-foreground/70" />
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-xs font-medium truncate">{file.name}</p>
        <p className="text-[11px] text-muted-foreground">Uploaded file</p>
      </div>
      {saved ? (
        <button disabled className="flex items-center gap-1.5 text-xs text-muted-foreground border border-border rounded-md px-2.5 py-1 cursor-default shrink-0">
          <Check className="h-3 w-3" />
          Saved
        </button>
      ) : (
        <button
          onClick={() => setSaved(true)}
          className="flex items-center gap-1.5 text-xs font-medium border border-border rounded-md px-2.5 py-1 hover:bg-muted/50 transition-colors shrink-0"
        >
          <BookmarkPlus className="h-3 w-3" />
          Save to library
        </button>
      )}
    </div>
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
  onArtifactAdded,
}: ChatViewProps) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const [rightTab, setRightTab] = useState<RightTab>('artifacts')
  const [panelOpen, setPanelOpen] = useState(true)
  const [prefillText, setPrefillText] = useState<string | undefined>(undefined)
  // Map from message index → uploaded files for that message
  const [uploadsByIndex, setUploadsByIndex] = useState<Map<number, UploadedFile[]>>(new Map())
  // Artifacts created by the compose flow in this session, keyed by the assistant
  // message id they were produced for. Rendered inline under that message.
  const [composeArtifacts, setComposeArtifacts] = useState<Map<string, Artifact>>(new Map())

  const isNewChat = chat.id === '__new__'

  // Fetch persisted messages for this chat from the server. Skipped for
  // the "new chat" placeholder (not yet created) and until we have a
  // real server id.
  const { data: serverMsgs } = useGetChatMessagesQuery(
    { chatId: chat.id },
    { skip: isNewChat || chat.id.startsWith('chat-new-') },
  )
  const [postMessageMutation] = usePostChatMessageMutation()

  // Upload ownership lives at ChatView so the entire chat screen (not
  // just the small input strip) can be a drop target.
  const [uploadChatArtifact, chatUploadState] = useUploadChatArtifactMutation()
  const [uploadLibraryFile, libraryUploadState] = useUploadLibraryFileMutation()
  const isUploading = chatUploadState.isLoading || libraryUploadState.isLoading
  const hasRealChatId = !chat.id.startsWith('chat-new-')
  const [pendingUploads, setPendingUploads] = useState<UploadedFile[]>([])

  const handleUpload = useCallback(async (files: File[]) => {
    for (const file of files) {
      try {
        if (hasRealChatId) {
          const serverFile = await uploadChatArtifact({ chatId: chat.id, file }).unwrap()
          setPendingUploads(prev => [
            ...prev,
            { id: `upload-${serverFile.id ?? serverFile.path ?? Date.now()}`, name: serverFile.name ?? file.name },
          ])
        } else if (chat.workspaceId) {
          const serverFile = await uploadLibraryFile({ workspaceId: chat.workspaceId, file }).unwrap()
          setPendingUploads(prev => [
            ...prev,
            { id: `upload-${serverFile.id ?? serverFile.path ?? Date.now()}`, name: serverFile.name ?? file.name },
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

  // Library items for the workspace backing this chat. Used as the pool
  // for the "Add files to chat" picker in the right panel. If the chat
  // doesn't carry a workspaceId yet (new-chat stub) we skip the query.
  const { data: libraryResp } = useGetLibraryQuery(
    chat.workspaceId ? { workspaceId: chat.workspaceId } : undefined,
    { skip: !chat.workspaceId },
  )
  const libraryItems: ContextItem[] = (libraryResp?.items ?? []).map(toContextItem)

  // Map the server's message shape onto what the existing compose UI
  // expects. Non-text content types (toolCall, events, notes, …) are
  // currently squashed to a text label — the full renderer is slice 12.
  const serverInitialMessages: ChatMessageType[] = (serverMsgs?.items ?? [])
    .filter(m => m.role === 'user' || m.role === 'agent')
    .map(toUiChatMessage)

  // Prioritise the chat's own messages (server-loaded if present);
  // fall back to the linked artifact's conversation for mocked rows.
  const initialMessages: ChatMessageType[] =
    serverInitialMessages.length > 0
      ? serverInitialMessages
      : chat.messages ?? artifacts[0]?.conversation ?? []

  const lastInitialAssistantId = useMemo(() => {
    for (let i = initialMessages.length - 1; i >= 0; i--) {
      if (initialMessages[i].role === 'assistant') return initialMessages[i].id
    }
    return null
  }, [initialMessages])

  // Keep a ref to the live message list so the artifact-created callback (fired
  // from a setTimeout inside useMockChat) can read the most recent assistant id.
  const messagesRef = useRef<ChatMessageType[]>([])

  const handleArtifactCreated = useCallback((scenario: ComposeScenario) => {
    const artifact: Artifact = {
      id: `art-new-${Date.now()}`,
      ...scenario.resultArtifact,
      createdAt: new Date(),
      updatedAt: new Date(),
      conversation: messagesRef.current.map(m => ({ ...m })),
    }
    const msgs = messagesRef.current
    let anchorId: string | null = null
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i].role === 'assistant') { anchorId = msgs[i].id; break }
    }
    if (anchorId) {
      setComposeArtifacts(prev => {
        const next = new Map(prev)
        next.set(anchorId!, artifact)
        return next
      })
    }
    onArtifactAdded?.(artifact)
  }, [onArtifactAdded])

  const chatMode = isNewChat ? 'compose' : 'conversation'

  const { messages, isTyping, statusText, sendMessage } = useMockChat({
    initialMessages,
    mode: chatMode,
    onArtifactCreated: isNewChat ? handleArtifactCreated : undefined,
  })

  messagesRef.current = messages

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [messages])

  const agentModel = artifacts[0]?.agentModel ?? 'Claude Sonnet 4'

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

        {/* Header — Compose-style compact bar */}
        <div className="h-[52px] flex items-center gap-2 border-b px-4 shrink-0">
          <SidebarTrigger className="h-8 w-8 rounded-md" />

          <div className="flex-1 min-w-0">
            <span className="text-sm font-medium truncate block">{chat.title}</span>
          </div>

          <div className="flex items-center gap-1 shrink-0">
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

            {/* PanelRight — show in header when panel is closed */}
            {!panelOpen && (
              <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => setPanelOpen(true)}>
                <PanelRight className="h-4 w-4" />
              </Button>
            )}
          </div>
        </div>

        {/* Messages */}
        <div ref={scrollRef} className="flex-1 overflow-y-auto">
          <div className="max-w-2xl mx-auto px-6 py-8 space-y-6">

            {/* Empty state — shown before any message is sent */}
            {messages.length === 0 && initialMessages.length === 0 && (
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
                        onFirstMessage?.(chip)
                        sendMessage(chip)
                      }}
                      className="rounded-full border bg-background px-3.5 py-1.5 text-sm text-muted-foreground hover:text-foreground hover:border-foreground/20 transition-colors"
                    >
                      {chip}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {messages.map((msg, i) => {
              const composeArtifact = composeArtifacts.get(msg.id)
              return (
                <div key={msg.id}>
                  {/* Uploaded file cards above this user message */}
                  {msg.role === 'user' && uploadsByIndex.has(i) && (
                    <div className="mb-2 flex flex-col items-end">
                      {uploadsByIndex.get(i)!.map(file => (
                        <UploadedFileCard key={file.id} file={file} />
                      ))}
                    </div>
                  )}
                  <ChatMessage
                    message={msg}
                    agentModel={agentModel}
                    isFirstInGroup={i === 0 || messages[i - 1].role !== msg.role}
                    isNew={showNewBadge && msg.id === lastInitialAssistantId}
                  />
                  {/* Inline artifact card for a compose scenario produced after this assistant message */}
                  {composeArtifact && (
                    <div className="mt-4">
                      <ArtifactInlineCard
                        artifact={composeArtifact}
                        isSaved={savedArtifactIds.has(composeArtifact.id)}
                        onOpen={() => onArtifactClick?.(composeArtifact)}
                        onSave={() => onSaveArtifact?.(composeArtifact.id)}
                      />
                    </div>
                  )}
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
              )
            })}
            <StatusIndicator text={statusText} isTyping={isTyping && !statusText} />
          </div>
        </div>

        {/* Input */}
        <div className="border-t shrink-0">
          <div className="max-w-2xl mx-auto px-6 py-4">
            <ChatInput
              onSend={(msg, uploads) => {
                if (messages.length === 0 && initialMessages.length === 0) {
                  onFirstMessage?.(msg)
                }
                if (uploads.length > 0) {
                  setUploadsByIndex(prev => new Map([...prev, [messages.length, uploads]]))
                }
                setPendingUploads([])
                // For real chats, persist the user message so it's there
                // on reload and so other clients see it. New-chat flow
                // delegates to onFirstMessage (which creates the chat).
                if (!isNewChat && !chat.id.startsWith('chat-new-')) {
                  void postMessageMutation({ chatId: chat.id, content: msg })
                }
                sendMessage(msg)
                setPrefillText(undefined)
              }}
              disabled={isTyping}
              placeholder={initialMessages.length === 0 ? 'Ask anything, start a task, build something…' : 'Continue the conversation...'}
              compact={true}
              showGoalPicker={true}
              prefillValue={prefillText}
              chatAgentId={chat.agentId}
              chatWorkspaceId={chat.workspaceId}
              chatId={chat.id}
              onOpenUploadPicker={openPicker}
              extraUploads={pendingUploads}
              onRemoveExtraUpload={removePendingUpload}
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
                initialReferenceIds={chat.referenceIds ?? []}
                libraryItems={libraryItems}
                workspaceId={chat.workspaceId}
              />
            )}
          </div>
        </div>
      )}

    </div>
  )
}
