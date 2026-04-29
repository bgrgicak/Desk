import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'
import { AnimatePresence } from 'framer-motion'
import {
  Pin, PinOff, Zap, FolderOpen, Plus,
  ListFilter, SlidersHorizontal,
  ChevronDown, MessageSquare, MoreHorizontal, Trash2,
  FileText,
  ImageIcon, Table, Globe, Play, ListTodo, CalendarClock,
  type LucideIcon,
} from 'lucide-react'
import {
  Sheet,
  SheetContent,
} from '@/components/ui/sheet'
import { TodayPanel } from '@/components/today/TodayPanel'
import { TodayDetailPanel } from '@/components/today/TodayDetailPanel'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
} from '@/components/ui/sidebar'
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from '@/components/ui/command'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import { ChatFilterPopover, type ChatFilterValues } from './ChatFilterPopover'
import { WorkspaceBar, type WorkspaceInfo, type WorkspaceNavView } from './WorkspaceBar'
import { SettingsModal } from '@/components/settings/SettingsModal'
import type { Chat, Artifact, InboxItem, ContextItem } from '@/data/ui-types'
import { getArtifactIcon } from '@/data/ui-types'
import { iconForItem } from '@/data/file-kind'
import {
  useGetWorkspacesQuery,
  usePatchWorkspaceMutation,
  useDeleteWorkspaceMutation,
  useSearchQuery,
  useGetAgentsQuery,
} from '@/store/api'
import { toWorkspaceInfo } from '@/store/selectors/workspaces'
import { useScrolledUnder } from '@/hooks/use-scrolled-under'
import { useAppDispatch, useAppSelector } from '@/store/hooks'
import { setPendingSettingsSection, type SettingsSection } from '@/store/slices/uiSlice'

export type View = 'today' | 'pinned' | 'desk' | 'tasks' | 'chats' | 'context' | 'compose'

// ── NAV (no Today — Today lives in the workspace bar) ────────────────────────
const NAV_ITEMS: { view: WorkspaceNavView; icon: LucideIcon; label: string }[] = [
  { view: 'context', icon: FolderOpen, label: 'Library' },
  { view: 'tasks',   icon: Zap,        label: 'Tasks'   },
]

// Fallback used only while the /workspaces query is in flight — the real
// list comes from the server via useGetWorkspacesQuery().
const LOADING_WORKSPACE: WorkspaceInfo = {
  id: '__loading__',
  name: '…',
  description: '',
  emoji: '…',
  bg: '#e5e7eb',
  unreadCount: 0,
}

const CHATS_PER_PAGE = 10
const PINNED_PER_PAGE = 5

const EMPTY_FILTER: ChatFilterValues = { goalKind: null, agentId: null, updatesOnly: false, artifactsOnly: false }

function sortedChats(chats: Chat[]): Chat[] {
  return [...chats].sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
}

// Picker-aligned icons for the inferred goal of the chat.
// Source of truth: ChatInput's GOALS list — keep these in sync so the
// sidebar mirrors what the user picked / typed about.
const GOAL_ICONS: Record<NonNullable<Chat['goalKind']>, LucideIcon> = {
  app:       Zap,
  document:  FileText,
  image:     ImageIcon,
  data:      Table,
  site:      Globe,
  run:       Play,
  task:      ListTodo,
  scheduled: CalendarClock,
}

function getChatIcon(chat: Chat): LucideIcon {
  if (chat.goalKind) return GOAL_ICONS[chat.goalKind]
  switch (chat.kind) {
    case 'task':
    case 'task_run':
      return ListTodo
    default:
      return MessageSquare
  }
}

interface AppShellProps {
  children: ReactNode
  activeView: View
  onViewChange: (view: WorkspaceNavView) => void
  onCompose: () => void
  chats: Chat[]
  artifacts: Artifact[]
  selectedChatId?: string | null
  onChatClick: (chat: Chat) => void
  onDeleteChat: (chatId: string) => void
  unreadCount?: number
  readChatIds?: Set<string>
  isDetailOpen?: boolean
  onArtifactClick?: (artifact: Artifact) => void
  // ── Workspace bar ──
  activeWorkspaceId: string
  onSelectWorkspace: (id: string) => void
  onGlobalToday: () => void
  // ── Today sheet ──
  todaySheetOpen?: boolean
  onTodaySheetClose?: () => void
  onSignOut?: () => void
  onChatWithAgent?: (agentId: string) => void
  pinnedItems?: ContextItem[]
  onPinnedItemClick?: (item: ContextItem) => void
  onUnpinItem?: (item: ContextItem) => void
  selectedItemId?: string | null
}

export function AppShell({
  children,
  activeView,
  onViewChange,
  onCompose,
  chats,
  artifacts,
  selectedChatId,
  onChatClick,
  onDeleteChat,
  unreadCount = 0,
  readChatIds = new Set(),
  isDetailOpen = false,
  onArtifactClick,
  activeWorkspaceId,
  onSelectWorkspace,
  onGlobalToday,
  todaySheetOpen = false,
  onTodaySheetClose,
  onSignOut,
  onChatWithAgent,
  pinnedItems = [],
  onPinnedItemClick,
  onUnpinItem,
  selectedItemId,
}: AppShellProps) {
  const [chatPage, setChatPage] = useState(1)
  const [pinnedPage, setPinnedPage] = useState(1)
  const [pinnedCollapsed, setPinnedCollapsed] = useState(false)
  const [chatsCollapsed, setChatsCollapsed] = useState(false)
  const [chatSearchOpen, setChatSearchOpen] = useState(false)
  const [chatSearchQuery, setChatSearchQuery] = useState('')
  const [chatSearchValue, setChatSearchValue] = useState('')
  // Server-side search — live query when the palette has ≥2 chars.
  const searchEnabled = chatSearchQuery.trim().length >= 2
  const { data: searchResults } = useSearchQuery(
    { q: chatSearchQuery.trim(), scope: 'all' },
    { skip: !searchEnabled },
  )

  const [appliedFilter, setAppliedFilter] = useState<ChatFilterValues>(EMPTY_FILTER)
  const [pendingFilter, setPendingFilter] = useState<ChatFilterValues>(EMPTY_FILTER)
  const [filterOpen, setFilterOpen] = useState(false)
  const hasActiveFilter =
    appliedFilter.goalKind !== null ||
    appliedFilter.agentId !== null ||
    appliedFilter.updatesOnly ||
    appliedFilter.artifactsOnly

  const { data: agents = [] } = useGetAgentsQuery()
  const [selectedTodayItem, setSelectedTodayItem] = useState<InboxItem | null>(null)
  const [focusTodayInput, setFocusTodayInput] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [settingsInitialSection, setSettingsInitialSection] = useState<SettingsSection | undefined>(undefined)

  const appDispatch = useAppDispatch()
  const pendingSettingsSection = useAppSelector(s => s.ui.pendingSettingsSection)
  useEffect(() => {
    if (!pendingSettingsSection) return
    setSettingsInitialSection(pendingSettingsSection)
    setSettingsOpen(true)
    appDispatch(setPendingSettingsSection(null))
  }, [pendingSettingsSection, appDispatch])
  const { ref: sidebarScrollRef, scrolledUnder: sidebarScrolledUnder } = useScrolledUnder()

  // Server-backed workspaces. The WorkspaceBar/Settings components still
  // consume the shape `{ id, name, description, emoji, bg, unreadCount }`
  // — we map in a selector so nothing in the render tree needs to change.
  const { data: serverWorkspaces } = useGetWorkspacesQuery()
  const [patchWorkspaceMutation] = usePatchWorkspaceMutation()
  const [deleteWorkspaceMutation] = useDeleteWorkspaceMutation()
  // Keep mutations reachable; the `create` modal lives inside WorkspaceBar
  // and can be wired when we expose it via props. For now mutations below
  // cover update + delete from the settings modal.
  const workspaces: WorkspaceInfo[] = (serverWorkspaces ?? []).map(toWorkspaceInfo)
  const displayWorkspaces = workspaces.length > 0 ? workspaces : [LOADING_WORKSPACE]
  const activeWorkspace =
    displayWorkspaces.find(w => w.id === activeWorkspaceId) ?? displayWorkspaces[0]

  const allChats = sortedChats(chats)
  const filteredChats = allChats.filter(chat => {
    if (appliedFilter.goalKind && chat.goalKind !== appliedFilter.goalKind) return false
    if (appliedFilter.agentId && chat.agentId !== appliedFilter.agentId) return false
    if (appliedFilter.updatesOnly && !(chat.unread && !readChatIds.has(chat.id))) return false
    if (appliedFilter.artifactsOnly && !(chat.artifactIds?.length)) return false
    return true
  })
  const visibleChats = filteredChats.slice(0, chatPage * CHATS_PER_PAGE)
  const hasMore      = filteredChats.length > visibleChats.length

  return (
    <div className="flex flex-col h-dvh overflow-hidden bg-muted bg-cover bg-center" style={{ '--topbar-height': '51px', backgroundImage: 'url(/background2.jpg)' } as React.CSSProperties}>


      {/* ── Today sheet (slides in from left) ── */}
      <Sheet
        open={todaySheetOpen}
        onOpenChange={open => {
          if (!open) {
            setSelectedTodayItem(null)
            onTodaySheetClose?.()
          }
        }}
      >
        <SheetContent
          side="left"
          showCloseButton={false}
          className="flex flex-row p-0 gap-0 sm:max-w-none overflow-hidden"
          style={{
            width: selectedTodayItem ? '75vw' : '560px',
            transition: 'width 0.25s ease',
          }}
        >
          {/* Primary panel */}
          <div className="relative flex flex-col shrink-0 overflow-hidden border-r" style={{ width: '560px' }}>
            <TodayPanel
              onClose={() => { setSelectedTodayItem(null); onTodaySheetClose?.() }}
              onSelectItem={(item, focusInput) => {
                setFocusTodayInput(focusInput ?? false)
                setSelectedTodayItem(prev => prev?.id === item.id && !focusInput ? null : item)
              }}
              selectedItemId={selectedTodayItem?.id}
            />
          </div>

          {/* Detail panel — wrapper gives it a stable layout box during transitions */}
          <div className="flex-1 min-w-0 relative overflow-hidden">
          <AnimatePresence>
            {selectedTodayItem && (
              <TodayDetailPanel
                key={selectedTodayItem.id}
                item={selectedTodayItem}
                focusInput={focusTodayInput}
                onFocusConsumed={() => setFocusTodayInput(false)}
                onClose={() => setSelectedTodayItem(null)}
                onOpenArtifact={(artifactId) => {
                  const artifact = artifacts.find(a => a.id === artifactId)
                  if (artifact) {
                    onArtifactClick?.(artifact)
                    setSelectedTodayItem(null)
                    onTodaySheetClose?.()
                  }
                }}
              />
            )}
          </AnimatePresence>
          </div>
        </SheetContent>
      </Sheet>

      {/* ── Card wrapper ── */}
      <div className="flex-1 min-h-0 overflow-hidden p-2">

      {/* ── Single app card: workspace bar + sidebar + content ── */}
      <div className="flex-1 min-h-0 h-full flex flex-col relative rounded-xl border overflow-hidden bg-sidebar/85 backdrop-blur-xl">

        <WorkspaceBar
          workspaces={workspaces}
          activeWorkspaceId={activeWorkspaceId}
          isGlobalToday={todaySheetOpen}
          todayUnreadCount={unreadCount}
          onGlobalToday={onGlobalToday}
          onSelectWorkspace={onSelectWorkspace}
          onSignOut={onSignOut}
        />

      {/* ── Sidebar + content ── */}
      <SidebarProvider style={{ height: 'auto' } as React.CSSProperties} className="flex-1 min-h-0">
        <Sidebar className="hidden md:flex">

          {/* ── Header: nav items ── */}
          <SidebarHeader style={{ paddingTop: 'calc(var(--spacing) * 2.5)' }}>
            {/* Nav items: Desk / Runs / Library */}
            <SidebarMenu>
              {NAV_ITEMS.map(({ view, icon: Icon, label }) => (
                <SidebarMenuItem key={view}>
                  <SidebarMenuButton
                    isActive={activeView === view && !selectedChatId && !isDetailOpen}
                    onClick={() => onViewChange(view)}
                  >
                    <Icon className="h-4 w-4" />
                    <span>{label}</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>

            {/* ── Pinned items section ── */}
            <div className="mt-3">
              <div className="group flex items-center px-2 mb-2 gap-1">
                <span className="text-xs font-medium text-foreground/70">Pinned</span>
                <button
                  onClick={() => setPinnedCollapsed(c => !c)}
                  className="opacity-0 group-hover:opacity-100 flex h-4 w-4 items-center justify-center rounded text-muted-foreground hover:text-foreground transition-opacity"
                  aria-label={pinnedCollapsed ? 'Expand Pinned' : 'Collapse Pinned'}
                >
                  <ChevronDown className={`h-3 w-3 transition-transform duration-200 ${pinnedCollapsed ? '-rotate-90' : ''}`} />
                </button>
              </div>
              {!pinnedCollapsed && (pinnedItems.length === 0 ? (
                <div className="mx-2 rounded-lg border border-dashed border-foreground/10 p-2">
                  <p className="text-xs text-muted-foreground">
                    Pin or drag items from Library to see them here.
                  </p>
                </div>
              ) : (
                <SidebarMenu>
                  {pinnedItems.slice(0, pinnedPage * PINNED_PER_PAGE).map(item => {
                    const ItemIcon = iconForItem(item)
                    return (
                      <SidebarMenuItem key={item.id}>
                        <SidebarMenuButton
                          isActive={item.id === selectedItemId}
                          onClick={() => onPinnedItemClick?.(item)}
                          className="text-foreground/70"
                        >
                          <ItemIcon className="h-4 w-4 shrink-0" />
                          <span className="truncate">{item.name}</span>
                        </SidebarMenuButton>
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <SidebarMenuAction showOnHover onClick={e => e.stopPropagation()} className="!right-2">
                              <MoreHorizontal />
                              <span className="sr-only">Item options</span>
                            </SidebarMenuAction>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent side="right" align="start" className="w-36">
                            <DropdownMenuItem onClick={() => onUnpinItem?.(item)}>
                              <PinOff className="h-4 w-4 mr-2" />
                              Unpin
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </SidebarMenuItem>
                    )
                  })}
                  {pinnedItems.length > pinnedPage * PINNED_PER_PAGE && (
                    <SidebarMenuItem>
                      <SidebarMenuButton onClick={() => setPinnedPage(p => p + 1)} className="text-muted-foreground">
                        <ChevronDown className="h-4 w-4 shrink-0" />
                        <span>Show more</span>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  )}
                </SidebarMenu>
              ))}
            </div>

            {/* Chats label + filter + new chat buttons */}
            <div className="group flex items-center justify-between px-2 mt-3">
              <div className="flex items-center gap-1">
                <span className="text-xs font-medium text-foreground/70">Chats</span>
                <button
                  onClick={() => setChatsCollapsed(c => !c)}
                  className="opacity-0 group-hover:opacity-100 flex h-4 w-4 items-center justify-center rounded text-muted-foreground hover:text-foreground transition-opacity"
                  aria-label={chatsCollapsed ? 'Expand Chats' : 'Collapse Chats'}
                >
                  <ChevronDown className={`h-3 w-3 transition-transform duration-200 ${chatsCollapsed ? '-rotate-90' : ''}`} />
                </button>
              </div>
              <div className={`flex items-center gap-0.5 ${chatsCollapsed ? 'invisible pointer-events-none' : ''}`}>
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
                      className="relative flex h-5 w-5 shrink-0 items-center justify-center rounded-md text-foreground/70 hover:text-foreground hover:bg-background/40 transition-colors"
                    >
                      <ListFilter className="h-3.5 w-3.5" />
                      <span className="sr-only">Filter chats</span>
                      {hasActiveFilter && (
                        <span className="absolute -top-0.5 -right-0.5 w-1 h-1 rounded-full bg-blue-500" />
                      )}
                    </button>
                  </PopoverTrigger>
                  <PopoverContent align="end" className="w-auto p-0">
                    <ChatFilterPopover
                      agents={agents}
                      values={pendingFilter}
                      onChange={setPendingFilter}
                      onApply={() => { setAppliedFilter(pendingFilter); setFilterOpen(false) }}
                      onCancel={() => { setPendingFilter(appliedFilter); setFilterOpen(false) }}
                    />
                  </PopoverContent>
                </Popover>
                <button
                  onClick={onCompose}
                  title="New chat"
                  className="flex h-5 w-5 shrink-0 items-center justify-center rounded-md text-foreground/70 hover:text-foreground hover:bg-background/40 transition-colors"
                >
                  <Plus className="h-3.5 w-3.5" />
                  <span className="sr-only">New chat</span>
                </button>
              </div>
            </div>
          </SidebarHeader>

          {/* ── Content: scrollable chat list ── */}
          <SidebarContent ref={sidebarScrollRef}>
            {!chatsCollapsed && <SidebarGroup className="px-2 py-0">
              <SidebarGroupContent className="pb-10">
                {filteredChats.length === 0 && (
                  <div className="mx-2 rounded-lg border border-dashed border-foreground/10 p-2">
                    {hasActiveFilter ? (
                      <p className="text-xs text-muted-foreground">
                        No chats found.{' '}
                        <button
                          className="underline decoration-muted-foreground/40 underline-offset-2 hover:text-foreground hover:decoration-muted-foreground transition-colors"
                          onClick={() => { setAppliedFilter(EMPTY_FILTER); setPendingFilter(EMPTY_FILTER) }}
                        >
                          Clear filters
                        </button>
                      </p>
                    ) : (
                      <p className="text-xs text-muted-foreground">
                        <button onClick={onCompose} className="underline decoration-muted-foreground/40 underline-offset-2 hover:text-foreground hover:decoration-muted-foreground transition-colors">Start a chat</button>
                        {' '}with an AI agent to see it here.
                      </p>
                    )}
                  </div>
                )}
                <SidebarMenu>
                  {visibleChats.map(chat => {
                    const ChatIcon = getChatIcon(chat)
                    return (
                      <SidebarMenuItem key={chat.id}>
                        <SidebarMenuButton
                          isActive={chat.id === selectedChatId && !isDetailOpen}
                          onClick={() => onChatClick(chat)}
                          className="pr-7 text-foreground/70"
                        >
                          <div className="relative shrink-0">
                            <ChatIcon className="h-4 w-4" />
                            {chat.unread && !readChatIds.has(chat.id) && (
                              <span className="absolute -top-0.5 -right-0.5 w-1 h-1 rounded-full bg-blue-500" />
                            )}
                          </div>
                          <span className="truncate">{chat.title}</span>
                        </SidebarMenuButton>

                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <SidebarMenuAction showOnHover onClick={e => e.stopPropagation()} className="!right-2">
                              <MoreHorizontal />
                              <span className="sr-only">Chat options</span>
                            </SidebarMenuAction>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent side="right" align="start" className="w-40">
                            <DropdownMenuItem
                              className="text-destructive focus:text-destructive"
                              onClick={e => { e.stopPropagation(); onDeleteChat(chat.id) }}
                            >
                              <Trash2 className="h-4 w-4 mr-2" />
                              Delete
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </SidebarMenuItem>
                    )
                  })}

                  {hasMore && (
                    <SidebarMenuItem>
                      <SidebarMenuButton onClick={() => setChatPage(p => p + 1)} className="text-muted-foreground">
                        <ChevronDown className="h-4 w-4 shrink-0" />
                        <span>Show more</span>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  )}
                </SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>}
          </SidebarContent>

          {/* ── Footer: Customize only ── */}
          <SidebarFooter className={cn('border-t border-transparent', sidebarScrolledUnder && 'border-foreground/10')}>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton onClick={() => setSettingsOpen(true)}>
                  <SlidersHorizontal className="h-4 w-4" />
                  <span>Customize</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarFooter>
        </Sidebar>

        {/* Main content */}
        <SidebarInset className="rounded-xl overflow-hidden shadow-xs mr-2 mb-2 md:peer-data-[state=collapsed]:ml-2">
          <main className="flex flex-1 flex-col min-w-0 min-h-0 overflow-hidden pb-16 md:pb-0">
            {children}
          </main>
        </SidebarInset>

        {/* Mobile bottom nav */}
        <nav className="md:hidden fixed bottom-0 left-0 right-0 z-30 flex items-center justify-around border-t bg-background/95 backdrop-blur-sm px-2 py-1 safe-area-pb">
          {NAV_ITEMS.map(({ view, icon: Icon, label }) => (
            <button
              key={view}
              onClick={() => onViewChange(view)}
              className={`flex flex-col items-center gap-0.5 px-3 py-1.5 rounded-lg transition-colors ${
                activeView === view ? 'text-primary' : 'text-muted-foreground'
              }`}
            >
              <div className="relative">
                <Icon className="h-5 w-5" />
              </div>
              <span className="text-[10px] font-medium">{label}</span>
            </button>
          ))}
          <button onClick={onCompose} className="flex flex-col items-center gap-0.5 px-3 py-1.5">
            <div className="flex h-7 w-7 items-center justify-center rounded-full bg-primary">
              <Plus className="h-4 w-4 text-primary-foreground" />
            </div>
            <span className="text-[10px] font-medium text-primary">New</span>
          </button>
        </nav>
      </SidebarProvider>

      </div>{/* end card inner */}
      </div>{/* end card outer */}

      {/* ── Workspace settings modal ── */}
      <SettingsModal
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
        workspace={activeWorkspace}
        canDeleteWorkspace={workspaces.length > 1}
        initialSection={settingsInitialSection}
        onUpdateWorkspace={updated => {
          void patchWorkspaceMutation({
            id: updated.id,
            patch: {
              name: updated.name,
              description: updated.description,
              icon: updated.emoji,
              color: updated.bg,
            },
          })
        }}
        onChatWithAgent={onChatWithAgent}
        onDeleteWorkspace={() => {
          void deleteWorkspaceMutation(activeWorkspace.id).then(() => {
            const next = workspaces.filter(w => w.id !== activeWorkspace.id)
            if (next.length > 0) onSelectWorkspace(next[0].id)
          })
        }}
      />

      {/* ── Chat search command palette ── */}
      <CommandDialog
        open={chatSearchOpen}
        onOpenChange={(open) => { setChatSearchOpen(open); if (!open) { setChatSearchQuery(''); setChatSearchValue('') } }}
        showCloseButton={false}
        className="top-[20%] translate-y-0"
        value={chatSearchValue}
        onValueChange={setChatSearchValue}
      >
        <CommandInput
          placeholder="Search chats and artifacts…"
          value={chatSearchQuery}
          onValueChange={(v) => { setChatSearchQuery(v); setChatSearchValue('') }}
        />
        <CommandList>
          <CommandEmpty>No results found.</CommandEmpty>

          {/* Default state: recent 5 chats */}
          {!chatSearchQuery.trim() && (
            <CommandGroup heading="Recent chats">
              {allChats.slice(0, 5).map(chat => {
                const ChatIcon = getChatIcon(chat)
                return (
                  <CommandItem
                    key={chat.id}
                    value={chat.id}
                    keywords={[chat.title]}
                    onSelect={() => { onChatClick(chat); setChatSearchOpen(false); setChatSearchQuery(''); setChatSearchValue('') }}
                  >
                    <ChatIcon className="h-4 w-4 text-muted-foreground" />
                    <span className="truncate">{chat.title}</span>
                  </CommandItem>
                )
              })}
            </CommandGroup>
          )}

          {/* Search state — results come from the server /search endpoint. */}
          {chatSearchQuery.trim() && (
            <>
              <CommandGroup heading="Chats">
                {(searchResults ?? [])
                  .filter(r => r.type === 'chat')
                  .map(r => {
                    const chat = allChats.find(c => c.id === r.id)
                    const ChatIcon = chat ? getChatIcon(chat) : MessageSquare
                    return (
                      <CommandItem
                        key={r.id}
                        value={r.id}
                        keywords={[r.title]}
                        onSelect={() => {
                          if (chat) onChatClick(chat)
                          setChatSearchOpen(false)
                          setChatSearchQuery('')
                          setChatSearchValue('')
                        }}
                      >
                        <ChatIcon className="h-4 w-4 text-muted-foreground" />
                        <span className="truncate">{r.title}</span>
                      </CommandItem>
                    )
                  })}
              </CommandGroup>
              <CommandSeparator />
              <CommandGroup heading="Artifacts">
                {(searchResults ?? [])
                  .filter(r => r.type === 'file')
                  .map(r => {
                    const artifact = artifacts.find(a => a.id === r.id)
                    if (!artifact) return (
                      <CommandItem key={r.id} value={r.id} keywords={[r.title]}>
                        <FileText className="h-4 w-4 text-muted-foreground" />
                        <span className="truncate">{r.title}</span>
                      </CommandItem>
                    )
                    const ArtifactIcon = getArtifactIcon(artifact.type)
                    return (
                    <CommandItem
                      key={artifact.id}
                      value={artifact.id}
                      keywords={[artifact.name]}
                      onSelect={() => { onArtifactClick?.(artifact); setChatSearchOpen(false); setChatSearchQuery(''); setChatSearchValue('') }}
                    >
                      <ArtifactIcon className="h-4 w-4 text-muted-foreground" />
                      <span className="truncate">{artifact.name}</span>
                    </CommandItem>
                  )
                })}
              </CommandGroup>
            </>
          )}
        </CommandList>
      </CommandDialog>
    </div>
  )
}

