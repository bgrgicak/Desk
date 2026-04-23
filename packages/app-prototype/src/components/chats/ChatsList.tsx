import { useState, useRef, useEffect } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { ExternalLink, MessageSquare, Plus, Search, FileText, StickyNote, Link2, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ChatMessage } from '@/components/compose/ChatMessage'
import { ChatInput } from '@/components/compose/ChatInput'
import { StatusIndicator } from '@/components/compose/StatusIndicator'
import { useMockChat } from '@/hooks/use-mock-chat'
import type { Chat, Artifact, ChatMessage as ChatMessageType, ContextItem } from '@/data/mock-data'
import { MOCK_CONTEXT, getArtifactIcon, getRelativeTime } from '@/data/mock-data'
import { ArtifactsEmptyState, FilesEmptyState } from '@/components/shared/PanelEmptyStates'

// ── Time grouping ─────────────────────────────────────────────────────────────

type Section = 'today' | 'this-week' | 'earlier'

function getSection(date: Date): Section {
  const now     = new Date('2026-04-16T10:00:00')
  const today   = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const weekAgo = new Date(today); weekAgo.setDate(today.getDate() - 7)
  if (date >= today)   return 'today'
  if (date >= weekAgo) return 'this-week'
  return 'earlier'
}

const SECTION_LABELS: Record<Section, string> = {
  'today':     'Today',
  'this-week': 'This week',
  'earlier':   'Earlier',
}

// ── Props ─────────────────────────────────────────────────────────────────────

interface ChatsListProps {
  chats: Chat[]
  artifacts: Artifact[]
  onCompose: () => void
  onArtifactClick: (artifact: Artifact) => void
}

// ── Main component ────────────────────────────────────────────────────────────

export function ChatsList({ chats, artifacts, onCompose, onArtifactClick }: ChatsListProps) {
  const [selectedChatId, setSelectedChatId] = useState<string | null>(null)
  const [artifactsOnly, setArtifactsOnly]   = useState(false)
  const [searchQuery, setSearchQuery]       = useState('')

  const filteredChats = chats
    .filter(c => !artifactsOnly || (c.artifactIds?.length ?? 0) > 0)
    .filter(c => !searchQuery.trim() || c.title.toLowerCase().includes(searchQuery.toLowerCase()))

  const bySection: Record<Section, Chat[]> = {
    'today':     filteredChats.filter(c => getSection(c.updatedAt) === 'today'),
    'this-week': filteredChats.filter(c => getSection(c.updatedAt) === 'this-week'),
    'earlier':   filteredChats.filter(c => getSection(c.updatedAt) === 'earlier'),
  }
  const sections: Section[] = ['today', 'this-week', 'earlier']

  const selectedChat     = chats.find(c => c.id === selectedChatId) ?? null
  const selectedArtifact = selectedChat?.artifactIds?.[0]
    ? artifacts.find(a => a.id === selectedChat.artifactIds![0])
    : undefined

  // The conversation for the selected chat: prefer artifact conversation, fall back to chat.messages
  const initialMessages: ChatMessageType[] = selectedArtifact?.conversation ?? selectedChat?.messages ?? []

  return (
    <div className="flex flex-1 flex-col min-h-0 overflow-hidden">

      {/* ── Page header ── */}
      <div className="px-6 pt-6 pb-4 shrink-0">
        <div className="flex items-start justify-between mb-1 gap-3">
          <h1 className="text-xl font-semibold">Chats</h1>
          <Button size="sm" onClick={onCompose} className="gap-1.5 shrink-0">
            <Plus className="h-4 w-4" />
            New chat
          </Button>
        </div>
        <p className="text-sm text-muted-foreground mb-4">Your conversations with AI.</p>

        {/* Filter row */}
        <div className="flex items-center gap-3">
          {/* Segmented control */}
          <div className="flex items-center rounded-lg border p-0.5">
            {([
              { value: false, label: 'All' },
              { value: true,  label: 'With artifacts' },
            ] as const).map(opt => (
              <button
                key={String(opt.value)}
                onClick={() => setArtifactsOnly(opt.value)}
                className={`rounded-md px-3 py-1 text-xs font-medium transition-colors ${
                  artifactsOnly === opt.value
                    ? 'bg-muted text-foreground'
                    : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>

          {/* Search */}
          <div className="ml-auto relative">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
            <input
              type="text"
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              placeholder="Search..."
              className="h-8 w-48 rounded-md border bg-background pl-8 pr-3 text-xs outline-none placeholder:text-muted-foreground/60 focus:ring-2 focus:ring-ring/20 focus:border-ring/40 transition-all"
            />
          </div>
        </div>
      </div>

      {/* ── Body: list + conversation ── */}
      <div className="flex flex-1 min-h-0 min-w-0 px-6 pb-6">
        <div className="flex flex-1 min-w-0 min-h-0 rounded-xl border bg-background overflow-hidden">

          {/* ── Left: chat list ── */}
          <div className="w-[300px] shrink-0 flex flex-col border-r overflow-hidden">
            <div className="flex-1 overflow-y-auto px-3 py-3">
              {filteredChats.length === 0 ? (
                <div className="flex flex-col items-center justify-center h-32 gap-2 text-center">
                  <MessageSquare className="h-8 w-8 text-muted-foreground/30" />
                  <p className="text-xs text-muted-foreground">No chats found</p>
                </div>
              ) : (
                <div className="space-y-5">
                  {sections.map(section => {
                    const items = bySection[section]
                    if (items.length === 0) return null
                    return (
                      <div key={section}>
                        <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1.5 px-1">
                          {SECTION_LABELS[section]}
                        </h3>
                        <div className="space-y-px">
                          {items.map(chat => (
                            <ChatListItem
                              key={chat.id}
                              chat={chat}
                              hasArtifact={(chat.artifactIds?.length ?? 0) > 0}
                              isSelected={chat.id === selectedChatId}
                              onClick={() => setSelectedChatId(chat.id)}
                            />
                          ))}
                        </div>
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
          </div>

          {/* ── Right: conversation panel ── */}
          <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
            <AnimatePresence mode="wait">
              {selectedChat ? (
                <ConversationView
                  key={selectedChat.id}
                  chat={selectedChat}
                  artifact={selectedArtifact}
                  initialMessages={initialMessages}
                  onArtifactClick={onArtifactClick}
                />
              ) : (
                <motion.div
                  key="empty"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.15 }}
                  className="flex-1 flex flex-col items-center justify-center gap-3 text-center p-8"
                >
                  <MessageSquare className="h-10 w-10 text-muted-foreground/20" />
                  <div>
                    <p className="text-sm font-medium text-muted-foreground">Select a chat</p>
                    <p className="text-xs text-muted-foreground/70 mt-0.5">Choose a conversation from the list to read it here.</p>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </div>

        </div>
      </div>
    </div>
  )
}

// ── Chat list item ─────────────────────────────────────────────────────────────

function ChatListItem({
  chat,
  hasArtifact,
  isSelected,
  onClick,
}: {
  chat: Chat
  hasArtifact: boolean
  isSelected: boolean
  onClick: () => void
}) {
  return (
    <button
      onClick={onClick}
      className={`w-full flex flex-col gap-0.5 rounded-lg px-3 py-2.5 text-left transition-colors ${
        isSelected ? 'bg-muted' : 'hover:bg-muted/50'
      }`}
    >
      {/* Title + time */}
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-sm font-medium text-foreground truncate leading-snug">{chat.title}</span>
        <span className="text-[11px] text-muted-foreground shrink-0">{getRelativeTime(chat.updatedAt)}</span>
      </div>
      {/* Preview + artifact badge */}
      <div className="flex items-center gap-1.5">
        <p className="text-xs text-muted-foreground truncate flex-1">{chat.lastMessage}</p>
        {hasArtifact && (
          <div className="shrink-0 w-1.5 h-1.5 rounded-full bg-muted-foreground/40" title="Has artifact" />
        )}
      </div>
    </button>
  )
}

// ── Conversation view ─────────────────────────────────────────────────────────

function ConversationView({
  chat,
  artifact,
  initialMessages,
  onArtifactClick,
}: {
  chat: Chat
  artifact?: Artifact
  initialMessages: ChatMessageType[]
  onArtifactClick: (artifact: Artifact) => void
}) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const [rightTab, setRightTab] = useState<'artifacts' | 'files'>('artifacts')
  const { messages, isTyping, sendMessage } = useMockChat({
    initialMessages,
    mode: 'conversation',
  })

  // For multi-artifact chats, gather all artifacts linked to this chat
  // In ChatsList, we only have the primary artifact passed in — show it if present
  const chatArtifacts = artifact ? [artifact] : []
  const refs: ContextItem[] = (chat.referenceIds ?? [])
    .map(id => MOCK_CONTEXT.find(c => c.id === id))
    .filter(Boolean) as ContextItem[]
  const [localRefs, setLocalRefs] = useState(refs)

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [messages])

  return (
    <motion.div
      initial={{ opacity: 0, x: 12 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, x: -12 }}
      transition={{ duration: 0.18, ease: 'easeOut' }}
      className="flex-1 flex min-h-0 h-full"
    >
      {/* Left: conversation */}
      <div className="flex-1 flex flex-col min-w-0 min-h-0">
        {/* Header */}
        <div className="h-[52px] flex items-center justify-between gap-3 px-4 border-b shrink-0">
          <div className="flex items-center gap-2 min-w-0">
            <span className="text-sm font-medium text-foreground truncate">{chat.title}</span>
          </div>
          {artifact && (
            <Button
              size="sm"
              variant="outline"
              className="h-7 text-xs gap-1.5 shrink-0"
              onClick={() => onArtifactClick(artifact)}
            >
              <ExternalLink className="h-3 w-3" />
              View in desk
            </Button>
          )}
        </div>

        {/* Messages */}
        <div ref={scrollRef} className="flex-1 overflow-y-auto">
          <div className="space-y-6 p-5">
            {messages.map((msg, i) => (
              <ChatMessage
                key={msg.id}
                message={msg}
                agentModel={artifact?.agentModel ?? 'Claude Sonnet 4'}
                isFirstInGroup={i === 0 || messages[i - 1].role !== msg.role}
              />
            ))}
            <StatusIndicator text={null} isTyping={isTyping} />
          </div>
        </div>

        {/* Input */}
        <div className="border-t p-3 shrink-0">
          <ChatInput
            onSend={(msg) => sendMessage(msg)}
            disabled={isTyping}
            placeholder="Continue the conversation..."
            compact={true}
            showGoalPicker={true}
          />
        </div>
      </div>

      {/* Right: Artifacts + Files (280px) */}
      <div className="w-[280px] shrink-0 flex flex-col border-l">
        {/* Pill tabs */}
        <div className="h-[52px] flex items-center px-3 border-b shrink-0">
          <div className="flex items-center h-8 bg-muted rounded-full p-0.5">
            {(['artifacts', 'files'] as const).map(tab => (
              <button
                key={tab}
                onClick={() => setRightTab(tab)}
                className={`rounded-full px-3 text-xs font-medium transition-colors h-full flex items-center gap-1 ${
                  rightTab === tab
                    ? 'bg-background text-foreground shadow-sm'
                    : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                {tab === 'files' ? 'Files' : 'Artifacts'}
                {tab === 'artifacts' && chatArtifacts.length > 0 && (
                  <span className="text-[10px] px-1 py-0.5 rounded-full bg-muted text-muted-foreground">{chatArtifacts.length}</span>
                )}
                {tab === 'files' && localRefs.length > 0 && (
                  <span className="text-[10px] px-1 py-0.5 rounded-full bg-muted text-muted-foreground">{localRefs.length}</span>
                )}
              </button>
            ))}
          </div>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto">
          {rightTab === 'artifacts' && (
            chatArtifacts.length === 0 ? (
              <ArtifactsEmptyState />
            ) : (
              <div className="py-1">
                {chatArtifacts.map(a => {
                  const Icon = getArtifactIcon(a.type)
                  return (
                    <button
                      key={a.id}
                      onClick={() => onArtifactClick(a)}
                      className="w-full flex items-center gap-2.5 px-3 py-2 hover:bg-muted/50 transition-colors text-left"
                    >
                      <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-muted">
                        <Icon className="h-3.5 w-3.5 text-muted-foreground/70" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="text-xs font-medium truncate">{a.name}</p>
                        <p className="text-[11px] text-muted-foreground capitalize">{a.type}</p>
                      </div>
                    </button>
                  )
                })}
              </div>
            )
          )}
          {rightTab === 'files' && (
            localRefs.length === 0 ? (
              <FilesEmptyState />
            ) : (
              <div className="py-1">
                {localRefs.map(ref => {
                  const Icon = ref.type === 'note' ? StickyNote : ref.type === 'link' ? Link2 : FileText
                  return (
                    <div key={ref.id} className="group flex items-center gap-2.5 px-3 py-2 hover:bg-muted/40 transition-colors">
                      <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground/60" />
                      <span className="text-xs truncate flex-1">{ref.name}</span>
                      <button
                        onClick={() => setLocalRefs(prev => prev.filter(r => r.id !== ref.id))}
                        className="opacity-0 group-hover:opacity-100 transition-opacity p-0.5 rounded hover:bg-muted text-muted-foreground hover:text-destructive"
                        title="Remove"
                      >
                        <Trash2 className="h-3 w-3" />
                      </button>
                    </div>
                  )
                })}
              </div>
            )
          )}
        </div>
      </div>
    </motion.div>
  )
}
