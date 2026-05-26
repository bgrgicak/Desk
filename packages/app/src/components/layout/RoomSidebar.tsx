import { memo, useCallback, useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { format, isToday, isYesterday } from 'date-fns'
import { AnimatePresence, motion } from 'framer-motion'
import {
  ArrowUpRight,
  ChevronDown, ChevronRight, FolderOpen, ListFilter,
  Loader2, MessagesSquare, PinOff, Plus, Search, SlidersHorizontal,
  Zap,
  type LucideIcon,
} from 'lucide-react'
import {
  cn,
  DropdownMenuItem,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarTrigger,
  useSidebar,
} from '@roomy-ai/ui'
import { SIDEBAR_ROW_STATE_CLASS, SidebarAccountMenu } from './sidebarShared'
import { RoomyIcon } from '@/components/home/RoomyIcon'
import { useGlobalPalette } from '@/components/global-palette/GlobalPaletteProvider'
import { ChatMenuItems } from '@/components/chats/ChatMenuItems'
import { RowKebab } from '@/components/shared/RowKebab'
import { SectionBody, SectionHeader } from '@/components/shared/SectionHeader'
import { SectionEmptyState } from '@/components/shared/SectionEmptyState'
import { ChatFilterPopover, type ChatFilterValues } from './ChatFilterPopover'
import { DRAG_TYPE_CHAT, DRAG_TYPE_LIBRARY_ITEM, DRAG_TYPE_PINNED_ITEM } from '@/components/library/LibraryCard'
import { useScrolledUnder } from '@/hooks/use-scrolled-under'
import { buildPath, NEW_CHAT_ID, type RouteView } from '@/router/nav'
import { getChatIcon } from '@/data/chat-icons'
import type { Chat, PinnedEntryKind } from '@/data/ui-types'
import { useChatHierarchy } from '@/store/selectors/threads'
import type { HomePinRef } from '@/hooks/use-home-pins'

// Per-room sidebar: Tasks / Library / Settings, then Pinned + Chats (date-
// grouped), with a footer hosting Search + the profile dropdown. Extracted
// from AppShell so the shell stays slim and so the same sidebar can later be
// reused inside other room sub-views without copy-paste.

const CHATS_PER_PAGE = 10
const PINNED_PER_PAGE = 5
const EMPTY_FILTER: ChatFilterValues = { goal: null, updatesOnly: false }

/**
 * Render-shaped sidebar pin entry. The assembler in App.tsx pre-computes
 * the icon (mime-aware for files, FolderIcon for directories, chat-goal
 * for chats) and the navigation href so this component can stay dumb
 * about kind-specific routing.
 */
export interface PinnedSidebarEntry {
  /** Compound id: `${kind}:${ref}` so a chat id and a path can't collide. */
  id: string
  kind: PinnedEntryKind
  /** Library/folder: workspace-relative path. Chat: chat id. */
  ref: string
  name: string
  icon: LucideIcon
  href: string
  /** True when this entry is the currently focused row. */
  isActive?: boolean
}

/**
 * One sidebar row for a chat — used by both the chat-list grouping AND
 * the Pinned section's chat-kind entries. Keeps the spinner-or-icon +
 * red/blue status dot rendering in a single place so both surfaces
 * stay visually in sync without copy-paste.
 *
 * Behavior knobs the caller decides:
 *  - `href`: routing differs (active view + ?chat= vs the same), but
 *    the row doesn't need to know which surface it sits in.
 *  - `dragType` / `dragValue`: chat-list rows emit `DRAG_TYPE_CHAT` so
 *    they can be dropped on Pinned; pinned rows emit `DRAG_TYPE_PINNED_ITEM`
 *    so dragging them onto the chat inset triggers unpin. Pass `null`
 *    to disable drag (e.g. before the workspace resolves).
 *  - `kebab`: the row owns the kebab container; the caller passes the
 *    DropdownMenuItem children (Pin/Delete in the chat list, Unpin in
 *    the pinned section).
 */
/**
 * Visual chat row. Memoized so the sidebar's many rows don't all
 * re-render when AppInner re-renders for unrelated reasons (the
 * profile pinned this row at 52 renders / 514 commits). The row reads
 * the running/failed signals from the store directly so the parent
 * doesn't have to pass them — those slices update independently of the
 * chats list. "Running" delegates to `selectIsChatRunning`, which
 * mirrors the chat-view loader (latest agent_turn state in the
 * messages cache) so the sidebar can't disagree with the open chat.
 *
 * The row's memo skips re-renders when `chat`, `href`, `isActive`,
 * `dragType`, `dragValue`, and the kebab callbacks haven't changed —
 * callers must pass *stable* callback identities (build them with
 * useCallback) for the memo to be effective.
 */
const ChatSidebarRow = memo(function ChatSidebarRow({
  chat,
  href,
  isActive,
  dragType,
  dragValue,
  indent = false,
  threadCount = 0,
  expanded = false,
  onToggleExpand,
  onUnpinOnly,
  isPinned,
  onPin,
  onUnpin,
  onDelete,
  homePin,
}: {
  chat: Chat
  href: string
  isActive: boolean
  dragType: string | null
  dragValue: string
  /** Render as an indented child thread row. */
  indent?: boolean
  /** Number of thread chats anchored in this chat. When > 0, the row
   *  shows a chevron+count toggle next to the kebab. */
  threadCount?: number
  /** Controlled expansion state for the thread toggle. */
  expanded?: boolean
  onToggleExpand?: () => void
  /** When true, the kebab shows only a single "Unpin" item bound to
   *  {@link onUnpin}. When false, the kebab shows the full chat actions
   *  menu (Pin/Unpin/Delete). */
  onUnpinOnly: boolean
  isPinned?: boolean
  onPin?: (chatId: string) => void
  onUnpin: (chatId: string) => void
  onDelete?: (chatId: string) => void
  /** Optional "Show in Home" reference. When set, the kebab menu shows a
   *  toggle that pins/unpins this chat from Home's Favorites. */
  homePin?: HomePinRef
}) {
  // Server is the single source of truth for running/failed. Both
  // flags are computed live from the latest agent_turn in
  // queries/chats.ts and ride along on every chat.updated payload,
  // so the cache value is always current.
  const isRunning = !!chat.running
  const isFailed = !isRunning && !!chat.failed
  const isDraggable = dragType !== null
  const hasThreads = threadCount > 0
  // Swap the chat-type icon for a thread glyph when this chat is itself
  // a thread parent — the icon's job is to telegraph "there's a tree
  // here", so the count badge can stay off the row.
  const ChatIcon = hasThreads ? MessagesSquare : getChatIcon(chat)
  return (
    <SidebarMenuItem>
      <MobileDismissSidebarMenuButton
        asChild
        isActive={isActive}
        className={cn(
          SIDEBAR_ROW_STATE_CLASS,
          'text-foreground',
          // Reserve room for the kebab; when the row carries threads,
          // also reserve room for the hover-revealed chevron so the
          // title doesn't reflow when the user mouses in.
          hasThreads ? 'pr-16' : 'pr-9',
          indent && 'pl-9',
        )}
        draggable={isDraggable || undefined}
        onDragStart={isDraggable ? (e: React.DragEvent) => {
          e.dataTransfer.effectAllowed = 'move'
          e.dataTransfer.setData(dragType, dragValue)
        } : undefined}
      >
        <Link to={href}>
          <div className="relative shrink-0">
            {isRunning ? (
              <Loader2 className="h-4 w-4 animate-spin" data-testid="chat-running-spinner" />
            ) : (
              <ChatIcon className="h-4 w-4 text-muted-foreground" />
            )}
            {!isRunning && (isFailed || chat.unread) ? (
              <span className={cn(
                'absolute -top-0.5 -right-0.5 w-1 h-1 rounded-full',
                isFailed ? 'bg-red-500' : 'bg-blue-500',
              )} />
            ) : null}
          </div>
          <span className="flex-1 min-w-0 truncate">{chat.title}</span>
        </Link>
      </MobileDismissSidebarMenuButton>
      {hasThreads && (
        // Expand/collapse toggle. Sits to the left of the kebab, fades
        // in on row hover the same way the kebab does, and stays pinned
        // open once expanded so the user can collapse without hunting.
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); onToggleExpand?.() }}
          aria-label={expanded ? 'Hide threads' : 'Show threads'}
          aria-expanded={expanded}
          className={cn(
            'absolute right-9 top-1/2 -translate-y-1/2 flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-foreground/10 hover:text-foreground transition-[opacity,background-color,color] focus-visible:opacity-100',
            expanded
              ? 'opacity-100'
              : 'opacity-0 group-hover/menu-item:opacity-100',
          )}
        >
          {expanded
            ? <ChevronDown className="h-3.5 w-3.5" />
            : <ChevronRight className="h-3.5 w-3.5" />}
        </button>
      )}
      <RowKebab align="start" side="right" contentClassName="w-40" label="Chat options" forceVisible={expanded}>
        {onUnpinOnly ? (
          <DropdownMenuItem onClick={() => onUnpin(chat.id)}>
            <PinOff className="h-4 w-4 mr-2" />
            Unpin
          </DropdownMenuItem>
        ) : (
          <ChatMenuItems
            chatId={chat.id}
            isPinned={!!isPinned}
            onPin={onPin}
            onUnpin={onUnpin}
            onDelete={onDelete ?? (() => undefined)}
            homePin={homePin}
          />
        )}
      </RowKebab>
    </SidebarMenuItem>
  )
})

function sortedByUpdatedDesc(chats: Chat[]): Chat[] {
  return [...chats].sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
}

function dateGroupLabel(d: Date): string {
  if (isToday(d)) return 'Today'
  if (isYesterday(d)) return 'Yesterday'
  return format(d, 'MMM d')
}

interface ChatGroup {
  label: string
  chats: Chat[]
}

function groupChatsByDate(chats: Chat[]): ChatGroup[] {
  const groups: ChatGroup[] = []
  let current: ChatGroup | null = null
  for (const chat of chats) {
    const label = dateGroupLabel(chat.updatedAt)
    if (!current || current.label !== label) {
      current = { label, chats: [] }
      groups.push(current)
    }
    current.chats.push(chat)
  }
  return groups
}

function MobileDismissSidebarMenuButton({
  onClick,
  ...props
}: React.ComponentProps<typeof SidebarMenuButton>) {
  const { isMobile, setOpen } = useSidebar()
  return (
    <SidebarMenuButton
      onClick={(event) => {
        onClick?.(event)
        if (isMobile && !event.defaultPrevented) setOpen(false)
      }}
      {...props}
    />
  )
}

function MobileDismissLink({
  onClick,
  ...props
}: React.ComponentProps<typeof Link>) {
  const { isMobile, setOpen } = useSidebar()
  return (
    <Link
      onClick={(event) => {
        onClick?.(event)
        if (isMobile && !event.defaultPrevented) setOpen(false)
      }}
      {...props}
    />
  )
}

interface RoomSidebarProps {
  activeView: RouteView
  activeWorkspaceId: string
  selectedChatId?: string | null
  selectedItemId?: string | null
  isDetailOpen?: boolean
  chats: Chat[]
  isChatsLoading?: boolean
  pinnedEntries?: PinnedSidebarEntry[]
  isPinnedLoading?: boolean
  onDeleteChat: (chatId: string) => void
  /** Pins a library file or directory by workspace-relative path. */
  onPinItem?: (path: string) => void
  /** Pins a chat by id. */
  onPinChat?: (chatId: string) => void
  /** Unpins any kind — the entry carries `kind` so the handler can
   *  dispatch to the right endpoint. */
  onUnpinEntry?: (entry: PinnedSidebarEntry) => void
  onOpenSettings: () => void
  /** Display name shown next to the bottom profile avatar (e.g.
   *  "Hello, Bero"). Optional while the /me query is in flight. */
  username?: string
  /** Email shown in the dropdown header row beneath the username. */
  email?: string
  /** Resolved avatar image URL for the current user, or `null` /
   *  `undefined` to fall back to initials. */
  userAvatarUrl?: string | null
  /** Opens the My Account modal. Wired by AppShell. */
  onOpenMyAccount?: () => void
  /** Signs the current user out. Wired by AppShell from App.tsx. */
  onSignOut?: () => void
}

export function RoomSidebar({
  activeView,
  activeWorkspaceId,
  selectedChatId,
  isDetailOpen = false,
  chats,
  isChatsLoading = false,
  pinnedEntries = [],
  isPinnedLoading = false,
  onDeleteChat,
  onPinItem,
  onPinChat,
  onUnpinEntry,
  onOpenSettings,
  username,
  email,
  userAvatarUrl,
  onOpenMyAccount,
  onSignOut,
}: RoomSidebarProps) {
  const [chatPage, setChatPage] = useState(1)
  const [pinnedPage, setPinnedPage] = useState(1)
  const [pinnedCollapsed, setPinnedCollapsed] = useState(false)
  const [chatsCollapsed, setChatsCollapsed] = useState(false)
  // Per-chat thread-tree expansion. Component-local for the prototype —
  // not persisted across reloads. Promote to a localStorage-backed
  // hook (mirror `use-prefs` / `use-workspace-icon`) if we want
  // expansion to stick.
  const [expandedThreadParents, setExpandedThreadParents] = useState<Set<string>>(() => new Set())
  const [isDraggingPinnable, setIsDraggingPinnable] = useState(false)
  const [isPinnedDropOver, setIsPinnedDropOver] = useState(false)
  const pinnedDropCounter = useRef(0)

  const palette = useGlobalPalette()

  const [appliedFilter, setAppliedFilter] = useState<ChatFilterValues>(EMPTY_FILTER)
  const [pendingFilter, setPendingFilter] = useState<ChatFilterValues>(EMPTY_FILTER)
  const [filterOpen, setFilterOpen] = useState(false)
  const hasActiveFilter =
    appliedFilter.goal !== null ||
    appliedFilter.updatesOnly

  const { ref: sidebarScrollRef, scrolledUnder: sidebarScrolledUnder } = useScrolledUnder()

  // Library AND chat drags both light up the Pinned drop zone — listen
  // globally for either payload so the affordance appears regardless of
  // which surface the drag started in.
  useEffect(() => {
    const onStart = (e: DragEvent) => {
      const t = e.dataTransfer?.types
      if (!t) return
      if (t.includes(DRAG_TYPE_LIBRARY_ITEM) || t.includes(DRAG_TYPE_CHAT)) {
        setIsDraggingPinnable(true)
      }
    }
    const onEnd = () => {
      setIsDraggingPinnable(false)
      setIsPinnedDropOver(false)
      pinnedDropCounter.current = 0
    }
    document.addEventListener('dragstart', onStart)
    document.addEventListener('dragend', onEnd)
    return () => {
      document.removeEventListener('dragstart', onStart)
      document.removeEventListener('dragend', onEnd)
    }
  }, [])

  function dragHasPinnable(types: DOMStringList | ReadonlyArray<string>): boolean {
    const arr = Array.from(types as ArrayLike<string>)
    return arr.includes(DRAG_TYPE_LIBRARY_ITEM) || arr.includes(DRAG_TYPE_CHAT)
  }

  const handlePinnedDragEnter = (e: React.DragEvent) => {
    if (!dragHasPinnable(e.dataTransfer.types)) return
    e.preventDefault()
    pinnedDropCounter.current += 1
    setIsPinnedDropOver(true)
  }
  const handlePinnedDragOver = (e: React.DragEvent) => {
    if (!dragHasPinnable(e.dataTransfer.types)) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
  }
  const handlePinnedDragLeave = () => {
    pinnedDropCounter.current = Math.max(0, pinnedDropCounter.current - 1)
    if (pinnedDropCounter.current === 0) setIsPinnedDropOver(false)
  }
  const handlePinnedDrop = (e: React.DragEvent) => {
    e.preventDefault()
    pinnedDropCounter.current = 0
    setIsPinnedDropOver(false)
    setIsDraggingPinnable(false)
    const libraryPath = e.dataTransfer.getData(DRAG_TYPE_LIBRARY_ITEM)
    if (libraryPath) {
      onPinItem?.(libraryPath)
      return
    }
    const chatId = e.dataTransfer.getData(DRAG_TYPE_CHAT)
    if (chatId) onPinChat?.(chatId)
  }

  // Stable callbacks for ChatSidebarRow. Parent props may change
  // identity on every AppShell render; the refs below decouple memoized
  // rows from that churn.
  const propsRef = useRef({ onDeleteChat, onPinChat, onUnpinEntry, chats, pinnedEntries })
  propsRef.current = { onDeleteChat, onPinChat, onUnpinEntry, chats, pinnedEntries }
  const stablePin = useCallback((chatId: string) => {
    propsRef.current.onPinChat?.(chatId)
  }, [])
  const stableDelete = useCallback((chatId: string) => {
    propsRef.current.onDeleteChat(chatId)
  }, [])
  // Looks up the live pinned entry for `chatId`; falls back to a
  // synthetic one if the user clicks Unpin in the chat-list kebab on a
  // chat that isn't currently pinned (no-op safety).
  const stableUnpin = useCallback((chatId: string) => {
    const { chats: liveChats, pinnedEntries: livePinned, onUnpinEntry: liveOnUnpin } = propsRef.current
    const entry = livePinned.find(e => e.kind === 'chat' && e.ref === chatId)
    if (entry) { liveOnUnpin?.(entry); return }
    const chat = liveChats.find(c => c.id === chatId)
    if (!chat) return
    liveOnUnpin?.({
      id: `chat:${chatId}`,
      kind: 'chat',
      ref: chatId,
      name: chat.title,
      icon: getChatIcon(chat),
      href: '#',
    })
  }, [])
  const stableUnpinPinnedEntry = useCallback((entry: PinnedSidebarEntry) => {
    propsRef.current.onUnpinEntry?.(entry)
  }, [])

  // Pinned chats render in the Pinned section above; hide them here so
  // the same chat isn't shown twice in the sidebar.
  const allChats = sortedByUpdatedDesc(chats).filter(c => !c.pinned)
  // Resolve parent/child thread relationships across the workspace so
  // thread chats can be hidden from the top-level list and rendered as
  // indented children under their parents.
  const chatHierarchy = useChatHierarchy(chats, activeWorkspaceId)
  const filteredChats = allChats.filter(chat => {
    if (appliedFilter.goal && chat.goal !== appliedFilter.goal) return false
    if (appliedFilter.updatesOnly && !chat.unread) return false
    // Hide thread chats from the top-level list — they appear nested
    // under their parent below. Orphans (parent missing from the list)
    // fall through and stay visible at the top level so they aren't lost.
    if (chatHierarchy.linkByChild.has(chat.id) && chatHierarchy.parentOf(chat.id)) return false
    return true
  })
  const visibleChats = filteredChats.slice(0, chatPage * CHATS_PER_PAGE)
  const hasMore = filteredChats.length > visibleChats.length
  const groups = groupChatsByDate(visibleChats)

  const toggleThreadExpand = (chatId: string) => {
    setExpandedThreadParents(prev => {
      const next = new Set(prev)
      if (next.has(chatId)) next.delete(chatId)
      else next.add(chatId)
      return next
    })
  }

  return (
    <Sidebar className="bg-transparent border-r-0 pl-4 pr-0 pt-0 pb-6">
      <SidebarHeader className="bg-transparent p-0">
        <div className="md:hidden flex items-center justify-between px-2 pt-2 pb-1">
          <RoomyIcon className="h-4 w-auto" aria-hidden />
          <SidebarTrigger className="h-8 w-8 rounded-md" />
        </div>

        {/* ── Top-level workspace nav: Tasks / Library / Settings.
            Sits above Pinned so the most-used workspace destinations
            are reachable without scrolling past Pinned + Chats.
            Search lives down by the profile dropdown (footer). ── */}
        <SidebarMenu className="pt-2 md:pt-6 pb-1">
          <SidebarMenuItem>
            <MobileDismissSidebarMenuButton
              asChild
              isActive={activeView === 'tasks' && !selectedChatId && !isDetailOpen}
              className={cn(SIDEBAR_ROW_STATE_CLASS, 'text-foreground')}
            >
              <Link to={activeWorkspaceId ? buildPath(activeWorkspaceId, 'tasks') : '#'}>
                <Zap className="h-4 w-4 text-muted-foreground" />
                <span>Tasks</span>
              </Link>
            </MobileDismissSidebarMenuButton>
          </SidebarMenuItem>
          <SidebarMenuItem>
            <MobileDismissSidebarMenuButton
              asChild
              isActive={activeView === 'context' && !selectedChatId && !isDetailOpen}
              className={cn(SIDEBAR_ROW_STATE_CLASS, 'text-foreground')}
            >
              <Link to={activeWorkspaceId ? buildPath(activeWorkspaceId, 'context') : '#'}>
                <FolderOpen className="h-4 w-4 text-muted-foreground" />
                <span>Library</span>
              </Link>
            </MobileDismissSidebarMenuButton>
          </SidebarMenuItem>
          <SidebarMenuItem>
            <MobileDismissSidebarMenuButton onClick={onOpenSettings} className={cn(SIDEBAR_ROW_STATE_CLASS, 'group/settings text-foreground')}>
              <SlidersHorizontal className="h-4 w-4 text-muted-foreground" />
              <span className="flex-1">Settings</span>
              <ArrowUpRight className="h-4 w-4 text-muted-foreground opacity-0 transition-opacity group-hover/settings:opacity-100" />
            </MobileDismissSidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>

        {/* ── Pinned ── */}
        <div
          onDragEnter={handlePinnedDragEnter}
          onDragOver={handlePinnedDragOver}
          onDragLeave={handlePinnedDragLeave}
          onDrop={handlePinnedDrop}
        >
          <SectionHeader
            label="Pinned"
            collapsed={pinnedCollapsed}
            onToggle={() => setPinnedCollapsed(c => !c)}
          />
          <SectionBody collapsed={pinnedCollapsed}>
            {isDraggingPinnable ? (
              <div className={cn(
                'mx-2 rounded-lg border border-dashed p-4 min-h-[52px] flex items-center justify-center transition-colors',
                isPinnedDropOver ? 'border-primary/40 bg-primary/5' : 'border-foreground/20 bg-foreground/5',
              )}>
                <p className="text-xs text-muted-foreground">Drop here to pin</p>
              </div>
            ) : isPinnedLoading ? (
              <div className="mx-2 rounded-lg border border-dashed border-foreground/10 p-3 flex items-center gap-2 text-xs text-muted-foreground">
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                <span>Loading pinned items…</span>
              </div>
            ) : pinnedEntries.length === 0 ? (
              <SectionEmptyState>
                Pin or drag items from Library or Chats to see them here.
              </SectionEmptyState>
            ) : (
              <SidebarMenu>
                {pinnedEntries.slice(0, pinnedPage * PINNED_PER_PAGE).map(entry => {
                  // Chat entries share the exact ChatSidebarRow used by
                  // the chats list below — same icon, same spinner, same
                  // red/blue status dot. Looking up the underlying chat
                  // by ref keeps the row reactive to chat.updated WS
                  // events (e.g. a pinned chat's run finishing flips the
                  // spinner off in both surfaces simultaneously).
                  if (entry.kind === 'chat') {
                    const chat = chats.find(c => c.id === entry.ref)
                    if (!chat) return null
                    return (
                      <ChatSidebarRow
                        key={entry.id}
                        chat={chat}
                        isActive={!!entry.isActive}
                        href={entry.href}
                        dragType={DRAG_TYPE_PINNED_ITEM}
                        dragValue={entry.id}
                        onUnpinOnly
                        onUnpin={stableUnpin}
                      />
                    )
                  }
                  const ItemIcon = entry.icon
                  return (
                    <SidebarMenuItem key={entry.id}>
                      <MobileDismissSidebarMenuButton
                        asChild
                        isActive={!!entry.isActive}
                        className={cn(SIDEBAR_ROW_STATE_CLASS, 'pr-9 text-foreground')}
                        draggable
                        onDragStart={(e: React.DragEvent) => {
                          e.dataTransfer.effectAllowed = 'move'
                          e.dataTransfer.setData(DRAG_TYPE_PINNED_ITEM, entry.id)
                        }}
                      >
                        <Link to={entry.href}>
                          <ItemIcon className="h-4 w-4 shrink-0 text-muted-foreground" />
                          <span className="flex-1 min-w-0 truncate">{entry.name}</span>
                        </Link>
                      </MobileDismissSidebarMenuButton>
                      <RowKebab align="start" side="right" contentClassName="w-36" label="Item options">
                        <DropdownMenuItem onClick={() => stableUnpinPinnedEntry(entry)}>
                          <PinOff className="h-4 w-4 mr-2" />
                          Unpin
                        </DropdownMenuItem>
                      </RowKebab>
                    </SidebarMenuItem>
                  )
                })}
                {pinnedEntries.length > pinnedPage * PINNED_PER_PAGE && (
                  <SidebarMenuItem>
                    <SidebarMenuButton onClick={() => setPinnedPage(p => p + 1)} className={cn('text-muted-foreground', SIDEBAR_ROW_STATE_CLASS)}>
                      <ChevronDown className="h-4 w-4 shrink-0" />
                      <span>Show more</span>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                )}
              </SidebarMenu>
            )}
          </SectionBody>
        </div>

        {/* ── Chats header (label + filter + new) ── */}
        <SectionHeader
          label="Chats"
          collapsed={chatsCollapsed}
          onToggle={() => setChatsCollapsed(c => !c)}
          className="mt-3"
          actions={
            <>
              <Popover
                open={filterOpen}
                onOpenChange={(open) => {
                  if (!open) setPendingFilter(appliedFilter)
                  setFilterOpen(open)
                }}
              >
                <PopoverTrigger asChild>
                  <button
                    title="Filter chats"
                    className="relative flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-foreground/10 hover:text-foreground transition-colors"
                  >
                    <ListFilter className="h-4 w-4" />
                    <span className="sr-only">Filter chats</span>
                    {hasActiveFilter && (
                      <span className="absolute top-0.5 right-0.5 w-1.5 h-1.5 rounded-full bg-blue-500" />
                    )}
                  </button>
                </PopoverTrigger>
                <PopoverContent align="center" sideOffset={8} className="w-auto p-0">
                  <ChatFilterPopover
                    values={pendingFilter}
                    onChange={setPendingFilter}
                    onApply={() => { setAppliedFilter(pendingFilter); setFilterOpen(false) }}
                    onCancel={() => { setPendingFilter(appliedFilter); setFilterOpen(false) }}
                  />
                </PopoverContent>
              </Popover>
              <MobileDismissLink
                to={activeWorkspaceId ? buildPath(activeWorkspaceId, activeView, { chat: NEW_CHAT_ID }) : '#'}
                title="New chat"
                className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-foreground/10 hover:text-foreground transition-colors"
              >
                <Plus className="h-4 w-4" />
                <span className="sr-only">New chat</span>
              </MobileDismissLink>
            </>
          }
        />
      </SidebarHeader>

      {/* ── Chat list (date-grouped) ── */}
      <SidebarContent ref={sidebarScrollRef} className="bg-transparent">
        <SectionBody collapsed={chatsCollapsed}>
          <SidebarGroup className="p-0">
            <SidebarGroupContent className="pb-6">
              {isChatsLoading ? (
                <div className="mx-2 rounded-lg border border-dashed border-foreground/10 p-3 flex items-center gap-2 text-xs text-muted-foreground">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  <span>Loading chats…</span>
                </div>
              ) : filteredChats.length === 0 ? (
                hasActiveFilter ? (
                  <SectionEmptyState>
                    No chats found.{' '}
                    <button
                      className="underline decoration-muted-foreground/40 underline-offset-2 hover:text-foreground hover:decoration-muted-foreground transition-colors"
                      onClick={() => { setAppliedFilter(EMPTY_FILTER); setPendingFilter(EMPTY_FILTER) }}
                    >
                      Clear filters
                    </button>
                  </SectionEmptyState>
                ) : (
                  <SectionEmptyState>
                    <Link to={activeWorkspaceId ? buildPath(activeWorkspaceId, activeView, { chat: NEW_CHAT_ID }) : '#'} className="underline decoration-muted-foreground/40 underline-offset-2 hover:text-foreground hover:decoration-muted-foreground transition-colors">Start a chat</Link>
                    {' '}with an AI agent to see it here.
                  </SectionEmptyState>
                )
              ) : (
                groups.map(group => (
                  <div key={group.label} className="mb-2 last:mb-0">
                    <div className="pl-2 pr-0 pt-2 pb-2 text-xs font-medium leading-4 text-muted-foreground">
                      {group.label}
                    </div>
                    <SidebarMenu>
                      <AnimatePresence initial={false}>
                        {group.chats.flatMap(chat => {
                          const threadCount = chatHierarchy.threadCountOf(chat.id)
                          const expanded = expandedThreadParents.has(chat.id)
                          // Order child threads by recency so the newest
                          // thread is closest to its parent — matches the
                          // top-level list's sort.
                          const sortedChildren = sortedByUpdatedDesc(
                            chatHierarchy.childrenByParent.get(chat.id) ?? [],
                          )
                          return [
                            <ChatSidebarRow
                              key={chat.id}
                              chat={chat}
                              isActive={chat.id === selectedChatId && !isDetailOpen}
                              href={activeWorkspaceId ? buildPath(activeWorkspaceId, activeView, { chat: chat.id }) : '#'}
                              dragType={onPinChat ? DRAG_TYPE_CHAT : null}
                              dragValue={chat.id}
                              threadCount={threadCount}
                              expanded={expanded}
                              onToggleExpand={threadCount > 0 ? () => toggleThreadExpand(chat.id) : undefined}
                              onUnpinOnly={false}
                              isPinned={chat.pinned}
                              onPin={stablePin}
                              onUnpin={stableUnpin}
                              onDelete={stableDelete}
                              homePin={{
                                kind: 'chat',
                                id: chat.id,
                                workspaceId: activeWorkspaceId,
                                label: chat.title,
                              }}
                            />,
                            // Animated thread-children wrapper. Held in
                            // its own <li> so the surrounding SidebarMenu
                            // (<ul>) stays valid; the inner <ul> resets
                            // padding so the indented child rows align
                            // with their parent's icon column.
                            expanded ? (
                              <motion.li
                                key={`${chat.id}-children`}
                                initial={{ height: 0, opacity: 0 }}
                                animate={{ height: 'auto', opacity: 1 }}
                                exit={{ height: 0, opacity: 0 }}
                                transition={{ duration: 0.18, ease: 'easeOut' }}
                                className="list-none overflow-hidden"
                              >
                                <ul className="flex flex-col gap-1 pt-1">
                                  {sortedChildren.map(thread => (
                                    <ChatSidebarRow
                                      key={thread.id}
                                      chat={thread}
                                      isActive={thread.id === selectedChatId && !isDetailOpen}
                                      href={activeWorkspaceId ? buildPath(activeWorkspaceId, activeView, { chat: thread.id }) : '#'}
                                      dragType={null}
                                      dragValue={thread.id}
                                      indent
                                      onUnpinOnly={false}
                                      isPinned={thread.pinned}
                                      onPin={stablePin}
                                      onUnpin={stableUnpin}
                                      onDelete={stableDelete}
                                      homePin={{
                                        kind: 'chat',
                                        id: thread.id,
                                        workspaceId: activeWorkspaceId,
                                        label: thread.title,
                                      }}
                                    />
                                  ))}
                                </ul>
                              </motion.li>
                            ) : null,
                          ]
                        })}
                      </AnimatePresence>
                    </SidebarMenu>
                  </div>
                ))
              )}
              {hasMore && (
                <SidebarMenu>
                  <SidebarMenuItem>
                    <SidebarMenuButton onClick={() => setChatPage(p => p + 1)} className={cn('text-muted-foreground', SIDEBAR_ROW_STATE_CLASS)}>
                      <ChevronDown className="h-4 w-4 shrink-0" />
                      <span>Show more</span>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                </SidebarMenu>
              )}
            </SidebarGroupContent>
          </SidebarGroup>
        </SectionBody>
      </SidebarContent>

      {/* ── Footer: Search + Profile.
          Search sits just above the Profile dropdown so the global
          palette trigger is always one click away regardless of how
          far the user has scrolled the chat list.

          The Profile row opens a DropdownMenu that floats just above
          its trigger (`side="top"` + small positive sideOffset). The
          menu's width is locked to the trigger width via Radix's
          `--radix-dropdown-menu-trigger-width` CSS var so it reads as
          an extension of the row rather than a free-floating popover.

          The data-testid="account-avatar" / "sign-out-button"
          selectors are exercised by the e2e suite (slice17-login,
          slice18-signout, et al.) — keep them in sync if you rename
          anything here. ── */}
      <SidebarFooter className={cn('bg-transparent p-0 border-t border-transparent', sidebarScrolledUnder && 'border-foreground/10')}>
        <SidebarMenu className="pb-1">
          <SidebarMenuItem>
            <MobileDismissSidebarMenuButton
              onClick={() => palette.open()}
              className={cn(SIDEBAR_ROW_STATE_CLASS, 'text-foreground')}
            >
              <Search className="h-4 w-4 text-muted-foreground" />
              <span>Search</span>
            </MobileDismissSidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
        <SidebarAccountMenu
          username={username}
          email={email}
          userAvatarUrl={userAvatarUrl}
          onOpenMyAccount={onOpenMyAccount}
          onSignOut={onSignOut}
        />
      </SidebarFooter>
    </Sidebar>
  )
}
