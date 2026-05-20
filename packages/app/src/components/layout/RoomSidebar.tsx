import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { format, isToday, isYesterday } from 'date-fns'
import {
  ChevronDown, FileText, FolderOpen, Globe, ImageIcon, ListFilter, ListTodo,
  Loader2, MessageSquare, PinOff, Play, Plus, SlidersHorizontal,
  Table, CalendarClock, Zap,
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
} from '@agent-desk/ui'
import { SIDEBAR_ROW_STATE_CLASS, SidebarAccountMenu } from './sidebarShared'
import { ChatMenuItems } from '@/components/chats/ChatMenuItems'
import { RowKebab } from '@/components/shared/RowKebab'
import { SectionBody, SectionHeader } from '@/components/shared/SectionHeader'
import { SectionEmptyState } from '@/components/shared/SectionEmptyState'
import { ChatFilterPopover, type ChatFilterValues } from './ChatFilterPopover'
import { iconForItem } from '@/data/file-kind'
import { DRAG_TYPE_LIBRARY_ITEM, DRAG_TYPE_PINNED_ITEM } from '@/components/library/LibraryCard'
import { useGetAgentsQuery } from '@/store/api'
import { useAppSelector } from '@/store/hooks'
import { selectFailedChatIds, selectRunningChatIds } from '@/store/slices/derivedSlice'
import { useScrolledUnder } from '@/hooks/use-scrolled-under'
import { buildPath, NEW_CHAT_ID, type RouteView } from '@/router/nav'
import type { Chat, ContextItem } from '@/data/ui-types'

// Per-room sidebar: Pinned + Chats (date-grouped) at the top, followed by a
// footer with Library / Tasks / Customize. Extracted from AppShell so the
// shell stays slim and so the same sidebar can later be reused inside other
// room sub-views without copy-paste.

const CHATS_PER_PAGE = 10
const PINNED_PER_PAGE = 5
const EMPTY_FILTER: ChatFilterValues = { goal: null, agentId: null, updatesOnly: false, artifactsOnly: false }

const GOAL_ICONS: Record<NonNullable<Chat['goal']>, LucideIcon> = {
  app: Zap,
  document: FileText,
  image: ImageIcon,
  data: Table,
  site: Globe,
  run: Play,
  task: ListTodo,
  scheduled: CalendarClock,
}

function getChatIcon(chat: Chat): LucideIcon {
  if (chat.goal && Object.prototype.hasOwnProperty.call(GOAL_ICONS, chat.goal)) {
    return GOAL_ICONS[chat.goal]
  }
  switch (chat.kind) {
    case 'task':
    case 'task_run':
      return ListTodo
    default:
      return MessageSquare
  }
}

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
  pinnedItems?: ContextItem[]
  isPinnedLoading?: boolean
  onDeleteChat: (chatId: string) => void
  onPinItem?: (itemId: string) => void
  onUnpinItem?: (item: ContextItem) => void
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
  selectedItemId,
  isDetailOpen = false,
  chats,
  isChatsLoading = false,
  pinnedItems = [],
  isPinnedLoading = false,
  onDeleteChat,
  onPinItem,
  onUnpinItem,
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
  const [isDraggingLibraryItem, setIsDraggingLibraryItem] = useState(false)
  const [isPinnedDropOver, setIsPinnedDropOver] = useState(false)
  const pinnedDropCounter = useRef(0)

  const [appliedFilter, setAppliedFilter] = useState<ChatFilterValues>(EMPTY_FILTER)
  const [pendingFilter, setPendingFilter] = useState<ChatFilterValues>(EMPTY_FILTER)
  const [filterOpen, setFilterOpen] = useState(false)
  const hasActiveFilter =
    appliedFilter.goal !== null ||
    appliedFilter.agentId !== null ||
    appliedFilter.updatesOnly ||
    appliedFilter.artifactsOnly

  const { data: agents = [] } = useGetAgentsQuery()
  const runningChatIds = useAppSelector(selectRunningChatIds)
  const failedChatIds = useAppSelector(selectFailedChatIds)
  const { ref: sidebarScrollRef, scrolledUnder: sidebarScrolledUnder } = useScrolledUnder()

  // Library drags from the LibraryCard set the DRAG_TYPE_LIBRARY_ITEM
  // payload — listen globally so the Pinned section can offer a dropzone.
  useEffect(() => {
    const onStart = (e: DragEvent) => {
      if (e.dataTransfer?.types.includes(DRAG_TYPE_LIBRARY_ITEM)) {
        setIsDraggingLibraryItem(true)
      }
    }
    const onEnd = () => {
      setIsDraggingLibraryItem(false)
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

  const handlePinnedDragEnter = (e: React.DragEvent) => {
    if (!e.dataTransfer.types.includes(DRAG_TYPE_LIBRARY_ITEM)) return
    e.preventDefault()
    pinnedDropCounter.current += 1
    setIsPinnedDropOver(true)
  }
  const handlePinnedDragOver = (e: React.DragEvent) => {
    if (!e.dataTransfer.types.includes(DRAG_TYPE_LIBRARY_ITEM)) return
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
    setIsDraggingLibraryItem(false)
    const itemId = e.dataTransfer.getData(DRAG_TYPE_LIBRARY_ITEM)
    if (itemId) onPinItem?.(itemId)
  }

  const allChats = sortedByUpdatedDesc(chats)
  const filteredChats = allChats.filter(chat => {
    if (appliedFilter.goal && chat.goal !== appliedFilter.goal) return false
    if (appliedFilter.agentId && chat.agentId !== appliedFilter.agentId) return false
    if (appliedFilter.updatesOnly && !chat.unread) return false
    if (appliedFilter.artifactsOnly && !(chat.artifactIds?.length)) return false
    return true
  })
  const visibleChats = filteredChats.slice(0, chatPage * CHATS_PER_PAGE)
  const hasMore = filteredChats.length > visibleChats.length
  const groups = groupChatsByDate(visibleChats)

  return (
    <Sidebar className="bg-transparent border-r-0 pl-4 pr-0 pt-0 pb-6">
      <SidebarHeader className="bg-transparent p-0">
        <SidebarTrigger className="absolute right-2 top-2 z-20 h-8 w-8 rounded-md md:hidden" />

        {/* ── Top-level workspace nav: Tasks / Library / Settings.
            Sits above Pinned so the most-used workspace destinations
            are reachable without scrolling past Pinned + Chats. The
            profile dropdown stays pinned to the SidebarFooter. ── */}
        <SidebarMenu className="pt-6 pb-1">
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
            <MobileDismissSidebarMenuButton onClick={onOpenSettings} className={cn(SIDEBAR_ROW_STATE_CLASS, 'text-foreground')}>
              <SlidersHorizontal className="h-4 w-4 text-muted-foreground" />
              <span>Settings</span>
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
            {isDraggingLibraryItem ? (
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
            ) : pinnedItems.length === 0 ? (
              <SectionEmptyState>
                Pin or drag items from Library to see them here.
              </SectionEmptyState>
            ) : (
              <SidebarMenu>
                {pinnedItems.slice(0, pinnedPage * PINNED_PER_PAGE).map(item => {
                  const ItemIcon = iconForItem(item)
                  return (
                    <SidebarMenuItem key={item.id}>
                      <MobileDismissSidebarMenuButton
                        asChild
                        isActive={item.id === selectedItemId}
                        className={cn(SIDEBAR_ROW_STATE_CLASS, 'pr-9 text-foreground')}
                        draggable
                        onDragStart={(e: React.DragEvent) => {
                          e.dataTransfer.effectAllowed = 'move'
                          e.dataTransfer.setData(DRAG_TYPE_PINNED_ITEM, item.id)
                        }}
                      >
                        <Link to={activeWorkspaceId ? buildPath(activeWorkspaceId, 'context', { item: item.id }) : '#'}>
                          <ItemIcon className="h-4 w-4 shrink-0 text-muted-foreground" />
                          <span className="flex-1 min-w-0 truncate">{item.name}</span>
                        </Link>
                      </MobileDismissSidebarMenuButton>
                      <RowKebab align="start" side="right" contentClassName="w-36" label="Item options">
                        <DropdownMenuItem onClick={() => onUnpinItem?.(item)}>
                          <PinOff className="h-4 w-4 mr-2" />
                          Unpin
                        </DropdownMenuItem>
                      </RowKebab>
                    </SidebarMenuItem>
                  )
                })}
                {pinnedItems.length > pinnedPage * PINNED_PER_PAGE && (
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
                    agents={agents}
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
                      {group.chats.map(chat => {
                        const ChatIcon = getChatIcon(chat)
                        const isRunning = runningChatIds.includes(chat.id) || !!chat.running
                        const isFailed = !isRunning && (failedChatIds.includes(chat.id) || !!chat.failed)
                        return (
                          <SidebarMenuItem key={chat.id}>
                            <MobileDismissSidebarMenuButton
                              asChild
                              isActive={chat.id === selectedChatId && !isDetailOpen}
                              className={cn(SIDEBAR_ROW_STATE_CLASS, 'pr-9 text-foreground')}
                            >
                              <Link to={activeWorkspaceId ? buildPath(activeWorkspaceId, activeView, { chat: chat.id }) : '#'}>
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
                            <RowKebab align="start" side="right" contentClassName="w-40" label="Chat options">
                              <ChatMenuItems chatId={chat.id} onDelete={onDeleteChat} />
                            </RowKebab>
                          </SidebarMenuItem>
                        )
                      })}
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

      {/* ── Footer: Profile only.
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
