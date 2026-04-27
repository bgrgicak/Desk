import { useState, useEffect, useRef } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import {
  AlertTriangle, Zap, MessageSquare, Calendar, Clock, User,
  MoreHorizontal, ChevronRight, FileText, Plus, ExternalLink,
  StickyNote,
  type LucideIcon,
} from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { ChatMessage } from '@/components/compose/ChatMessage'
import { ChatInput } from '@/components/compose/ChatInput'
import { useMockChat } from '@/hooks/use-mock-chat'
import { cn } from '@/lib/utils'
import type { TodayItem, TodayBand, Chat } from '@/data/ui-types'
import { getRelativeTime } from '@/data/ui-types'

// ── Workspace name lookup ─────────────────────────────────────────────────────
const WS_NAME: Record<string, string> = {
  general:  'General',
  work:     'Work',
  creative: 'Creative Lab',
}

// ── Chat goal icon — driven by the newest non-chat message kind. ─────────────
function chatGoalIcon(chat: Chat): LucideIcon {
  switch (chat.iconKind) {
    case 'task':    return Zap
    case 'ai_note': return StickyNote
    default:        return MessageSquare
  }
}

// ── Source icon per item type ─────────────────────────────────────────────────
function SourceIcon({ type, className }: { type: TodayItem['type']; className?: string }) {
  const cls = cn('h-3.5 w-3.5 shrink-0', className)
  switch (type) {
    case 'broken-connection':    return <AlertTriangle className={cn(cls, 'text-amber-500')} />
    case 'decision-from-run':    return <Zap           className={cn(cls, 'text-violet-500')} />
    case 'agent-question':       return <MessageSquare className={cn(cls, 'text-blue-500')} />
    case 'calendar-prompt':      return <Calendar      className={cn(cls, 'text-emerald-500')} />
    case 'unresolved-follow-up': return <Clock         className={cn(cls, 'text-orange-400')} />
    case 'user-todo':            return <User          className={cn(cls, 'text-muted-foreground')} />
  }
}

// ── Band config ───────────────────────────────────────────────────────────────
const BAND_LABELS: Record<TodayBand, string> = {
  'right-now': 'Right now',
  'today':     'Today',
  'this-week': 'This week',
  'earlier':   'Earlier',
}
const BAND_ORDER: TodayBand[] = ['right-now', 'today', 'this-week', 'earlier']

// ── Props ─────────────────────────────────────────────────────────────────────
interface TodayInboxProps {
  items: TodayItem[]
  chats: Chat[]
  onOpenChat: (chatId: string, workspaceId: string) => void
  onOpenWorkspace: (workspaceId: string) => void
}

// ── Main component ────────────────────────────────────────────────────────────
export function TodayInbox({ items, chats, onOpenChat, onOpenWorkspace }: TodayInboxProps) {
  const [dismissed, setDismissed]   = useState<Set<string>>(new Set())
  const [resolved, setResolved]     = useState<Set<string>>(new Set())
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [sortBy, setSortBy]         = useState<'priority' | 'recent'>('priority')
  const [captureValue, setCaptureValue] = useState('')

  const activeItems = items.filter(i => !dismissed.has(i.id) && !resolved.has(i.id))

  // Auto-select first item on mount
  useEffect(() => {
    if (activeItems.length > 0) setSelectedId(activeItems[0].id)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const selectedItem = activeItems.find(i => i.id === selectedId) ?? null

  function nextId(removedId: string): string | null {
    const idx       = activeItems.findIndex(i => i.id === removedId)
    const remaining = activeItems.filter(i => i.id !== removedId)
    return remaining.length ? remaining[Math.min(idx, remaining.length - 1)].id : null
  }

  function dismissItem(id: string) {
    const next = nextId(id)
    setDismissed(prev => new Set([...prev, id]))
    if (selectedId === id) setSelectedId(next)
    toast('Item dismissed', {
      action: {
        label: 'Undo',
        onClick: () => {
          setDismissed(prev => { const n = new Set(prev); n.delete(id); return n })
          setSelectedId(id)
        },
      },
    })
  }

  function resolveItem(id: string) {
    const next = nextId(id)
    setResolved(prev => new Set([...prev, id]))
    if (selectedId === id) setSelectedId(next)
  }

  // Group into bands
  const sorted = sortBy === 'recent'
    ? [...activeItems].sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime())
    : activeItems

  const grouped = BAND_ORDER.reduce((acc, band) => {
    const bandItems = sorted.filter(i => i.band === band)
    if (bandItems.length) acc[band] = bandItems
    return acc
  }, {} as Partial<Record<TodayBand, TodayItem[]>>)

  // Greeting
  const hour   = new Date().getHours()
  const salute = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening'
  const count  = activeItems.length

  // Recent chats strip (top 15, most recent first)
  const recentChats = [...chats]
    .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
    .slice(0, 15)

  return (
    <div className="flex flex-1 flex-col min-h-0 overflow-hidden">

      {/* ── Greeting + chat strip ── */}
      <div className="shrink-0 px-6 pt-6 pb-5 border-b">
        <h1 className="text-xl font-semibold text-foreground">{salute}, Jaroslaw.</h1>
        <p className="text-sm text-muted-foreground mt-1">
          {count > 0 ? 'Pick up where you left off.' : 'You\'re all caught up.'}
        </p>

        {/* Chat strip */}
        {recentChats.length > 0 && (
          <div className="flex gap-3 mt-5 overflow-x-auto pb-0.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            {recentChats.map(chat => (
              <ChatCard
                key={chat.id}
                chat={chat}
                onClick={() => onOpenChat(chat.id, chat.workspaceId ?? 'general')}
              />
            ))}
          </div>
        )}
      </div>

      {/* ── Main: list + detail ── */}
      <div className="flex flex-1 min-h-0">

        {/* ── Left: to-do list (sidebar-style) ── */}
        <div className="flex flex-col w-[240px] shrink-0 border-r bg-sidebar overflow-y-auto">

          {/* Quick-capture */}
          <div className="px-2 pt-2 pb-1">
            <div className="flex items-center gap-2 px-2 py-1.5 rounded-md hover:bg-sidebar-accent transition-colors">
              <Plus className="h-3.5 w-3.5 shrink-0 text-muted-foreground/60" />
              <input
                value={captureValue}
                onChange={e => setCaptureValue(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter' && captureValue.trim()) setCaptureValue('') }}
                placeholder="Add a to-do…"
                className="flex-1 min-w-0 text-sm bg-transparent outline-none placeholder:text-muted-foreground/50"
              />
            </div>
          </div>

          {/* Sort */}
          <div className="flex items-center gap-2 px-4 py-1.5">
            {(['priority', 'recent'] as const).map((s, i) => (
              <>
                {i > 0 && <span key={`sep-${s}`} className="text-muted-foreground/30 text-[10px]">·</span>}
                <button
                  key={s}
                  onClick={() => setSortBy(s)}
                  className={cn(
                    'text-[11px] transition-colors',
                    sortBy === s ? 'font-medium text-foreground' : 'text-muted-foreground hover:text-foreground'
                  )}
                >
                  {s.charAt(0).toUpperCase() + s.slice(1)}
                </button>
              </>
            ))}
          </div>

          {/* Items */}
          {activeItems.length === 0 ? (
            <p className="px-4 py-4 text-xs text-muted-foreground leading-relaxed">
              Nothing for now.
            </p>
          ) : (
            BAND_ORDER.filter(b => grouped[b]).map(band => (
              <div key={band}>
                <p className="px-4 pt-4 pb-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground/50">
                  {BAND_LABELS[band]}
                </p>
                <AnimatePresence initial={false}>
                  {grouped[band]!.map(item => (
                    <TodayListItem
                      key={item.id}
                      item={item}
                      isSelected={item.id === selectedId}
                      onSelect={() => setSelectedId(item.id)}
                      onDismiss={() => dismissItem(item.id)}
                      onNotUseful={() => dismissItem(item.id)}
                      onOpenWorkspace={() => onOpenWorkspace(item.workspaceId)}
                    />
                  ))}
                </AnimatePresence>
              </div>
            ))
          )}
        </div>

        {/* ── Right: detail (chat-style) ── */}
        <AnimatePresence mode="wait">
          {selectedItem ? (
            <TodayItemDetail
              key={selectedItem.id}
              item={selectedItem}
              onDismiss={() => dismissItem(selectedItem.id)}
              onOpenWorkspace={() => onOpenWorkspace(selectedItem.workspaceId)}
              onResolve={() => resolveItem(selectedItem.id)}
            />
          ) : (
            <motion.div
              key="empty"
              className="flex-1"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
            />
          )}
        </AnimatePresence>

      </div>
    </div>
  )
}

// ── Chat card (horizontal strip) ──────────────────────────────────────────────
function ChatCard({ chat, onClick }: { chat: Chat; onClick: () => void }) {
  const Icon = chatGoalIcon(chat)
  return (
    <button
      onClick={onClick}
      className="w-[200px] shrink-0 rounded-lg border bg-background p-3 text-left hover:border-foreground/20 hover:bg-muted/50 transition-colors"
    >
      <div className="flex items-center gap-2 mb-1.5">
        <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground/50" />
        <span className="text-sm font-medium truncate flex-1">{chat.title}</span>
        {chat.unread && (
          <span className="h-1.5 w-1.5 rounded-full bg-primary shrink-0" />
        )}
      </div>
      {chat.lastMessage && (
        <p className="text-xs text-muted-foreground leading-relaxed line-clamp-2">
          {chat.lastMessage}
        </p>
      )}
      {chat.workspaceId && (
        <p className="mt-2 text-[10px] text-muted-foreground/50">
          {WS_NAME[chat.workspaceId] ?? chat.workspaceId}
        </p>
      )}
    </button>
  )
}

// ── List item ─────────────────────────────────────────────────────────────────
function TodayListItem({
  item, isSelected, onSelect, onDismiss, onNotUseful, onOpenWorkspace,
}: {
  item: TodayItem
  isSelected: boolean
  onSelect: () => void
  onDismiss: () => void
  onNotUseful: () => void
  onOpenWorkspace: () => void
}) {
  return (
    <motion.div
      layout
      initial={{ opacity: 0, height: 0 }}
      animate={{ opacity: 1, height: 'auto' }}
      exit={{ opacity: 0, height: 0 }}
      transition={{ duration: 0.18, ease: 'easeInOut' }}
      style={{ overflow: 'hidden' }}
    >
      <div className="group flex items-start gap-0 px-2 py-0.5">
        <button
          onClick={onSelect}
          className={cn(
            'flex flex-1 min-w-0 items-start gap-2 rounded-md px-2 py-2 text-left transition-colors',
            isSelected
              ? 'bg-sidebar-accent text-sidebar-accent-foreground'
              : 'text-sidebar-foreground hover:bg-sidebar-accent/60'
          )}
        >
          <SourceIcon type={item.type} className="mt-0.5" />
          <div className="flex-1 min-w-0">
            <p className="text-sm truncate leading-snug">{item.ask}</p>
            <p className="mt-0.5 text-[11px] text-muted-foreground/70 truncate">
              {item.sourceLabel} · {item.workspaceName} · {getRelativeTime(item.timestamp)}
            </p>
          </div>
        </button>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              onClick={e => e.stopPropagation()}
              className="mt-2 mr-1 flex h-5 w-5 shrink-0 items-center justify-center rounded-md text-muted-foreground opacity-0 group-hover:opacity-100 hover:bg-muted transition-all"
            >
              <MoreHorizontal className="h-3.5 w-3.5" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-48">
            <DropdownMenuItem onSelect={onDismiss}>Dismiss</DropdownMenuItem>
            <DropdownMenuItem onSelect={onNotUseful} className="text-muted-foreground focus:text-foreground">
              Not useful
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={onOpenWorkspace}>
              Open in {item.workspaceName}
              <ChevronRight className="ml-auto h-3.5 w-3.5 text-muted-foreground" />
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </motion.div>
  )
}

// ── Item detail (chat-style) ──────────────────────────────────────────────────
function TodayItemDetail({
  item, onDismiss, onOpenWorkspace, onResolve,
}: {
  item: TodayItem
  onDismiss: () => void
  onOpenWorkspace: () => void
  onResolve: () => void
}) {
  const scrollRef = useRef<HTMLDivElement>(null)

  // Seed the conversation with the item's context as the first AI message
  const initialMessages = item.context ? [{
    id: `${item.id}-ctx`,
    role: 'assistant' as const,
    content: item.context,
    timestamp: item.timestamp,
  }] : []

  const { messages, isTyping, sendMessage } = useMockChat({
    initialMessages,
    mode: 'conversation',
  })

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [messages, isTyping])

  // Only show chips while no user replies have been sent yet
  const hasUserReplied = messages.some(m => m.role === 'user')

  return (
    <motion.div
      className="flex flex-1 flex-col min-w-0 min-h-0 overflow-hidden"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.15 }}
    >
      {/* Header */}
      <div className="h-[52px] flex items-center gap-2 border-b px-4 shrink-0">
        <span className="flex-1 min-w-0 text-sm font-medium truncate">{item.ask}</span>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 gap-1.5 text-xs text-muted-foreground hover:text-foreground shrink-0"
          onClick={onOpenWorkspace}
        >
          <ExternalLink className="h-3.5 w-3.5" />
          View in {item.workspaceName}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 text-xs text-muted-foreground hover:text-foreground shrink-0"
          onClick={onDismiss}
        >
          Dismiss
        </Button>
      </div>

      {/* Messages area */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-4 space-y-1">

        {/* User-todo: note card */}
        {item.type === 'user-todo' && item.note && (
          <div className="mb-3 rounded-lg bg-muted/60 px-4 py-3">
            <p className="text-sm text-foreground leading-relaxed">{item.note}</p>
          </div>
        )}

        {/* User-todo: attachment */}
        {item.type === 'user-todo' && item.attachment && (
          <div className="mb-3 flex items-center gap-2.5 rounded-lg border bg-background px-3 py-2.5 w-fit">
            <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
            <div className="min-w-0">
              <p className="text-sm font-medium truncate">{item.attachment.name}</p>
              <p className="text-xs text-muted-foreground">{item.attachment.size}</p>
            </div>
          </div>
        )}

        {/* Messages (description + mini-chat) */}
        {messages.map((msg, i) => (
          <ChatMessage
            key={msg.id}
            message={msg}
            isFirstInGroup={i === 0 || messages[i - 1]?.role !== msg.role}
          />
        ))}

        {isTyping && (
          <div className="flex items-center gap-2 pt-1">
            <div className="flex h-7 w-7 items-center justify-center rounded-full bg-muted shrink-0">
              <span className="text-xs">✦</span>
            </div>
            <div className="flex gap-1">
              {[0, 1, 2].map(i => (
                <motion.span
                  key={i}
                  className="h-1.5 w-1.5 rounded-full bg-muted-foreground/40"
                  animate={{ opacity: [0.3, 1, 0.3] }}
                  transition={{ duration: 1.2, repeat: Infinity, delay: i * 0.2 }}
                />
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Suggested responses (chips) — shown above input while no replies yet */}
      {item.chips && item.chips.length > 0 && !hasUserReplied && (
        <div className="px-4 pb-3 flex flex-wrap gap-2">
          {item.chips.map(chip => (
            <button
              key={chip.label}
              onClick={onResolve}
              className="rounded-full border bg-background px-4 py-1.5 text-sm text-foreground hover:bg-muted transition-colors"
            >
              {chip.label}
            </button>
          ))}
        </div>
      )}

      {/* Route-to-workspace prompt (for items with no chips) */}
      {item.routeToWorkspace && !item.chips && !hasUserReplied && (
        <div className="px-4 pb-3">
          <Button variant="outline" size="sm" className="gap-1.5" onClick={onOpenWorkspace}>
            Open in {item.workspaceName}
            <ExternalLink className="h-3.5 w-3.5" />
          </Button>
        </div>
      )}

      {/* Chat input */}
      <div className="border-t">
        <ChatInput
          onSend={(msg) => sendMessage(msg)}
          placeholder="Ask about this…"
          compact
          showGoalPicker={false}
          draftKey={`today-inbox:${item.id}`}
        />
      </div>
    </motion.div>
  )
}
