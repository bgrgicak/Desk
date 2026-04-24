import { useState } from 'react'
import type { ReactNode } from 'react'
import { AnimatePresence } from 'framer-motion'
import {
  LayoutGrid, Zap, FolderOpen, Plus, Search, X,
  SlidersHorizontal,
  ChevronDown, MessageSquare, MoreHorizontal, Trash2,
  FileText, ImageIcon, Table, Globe, Play,
  type LucideIcon,
} from 'lucide-react'
import {
  Sheet,
  SheetContent,
} from '@/components/ui/sheet'
import { TodayPanel } from '@/components/today/TodayPanel'
import { TodayDetailPanel } from '@/components/today/TodayDetailPanel'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
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
import { WorkspaceBar, type WorkspaceInfo, type WorkspaceNavView } from './WorkspaceBar'
import { SettingsModal } from '@/components/settings/SettingsModal'
import type { Chat, Artifact, InboxItem } from '@/data/mock-data'
import { getArtifactIcon } from '@/data/mock-data'

export type View = 'today' | 'desk' | 'runs' | 'chats' | 'context' | 'compose'

// ── NAV (no Today — Today lives in the workspace bar) ────────────────────────
const NAV_ITEMS: { view: View; icon: LucideIcon; label: string }[] = [
  { view: 'desk',    icon: LayoutGrid,  label: 'Desk'    },
  { view: 'runs',    icon: Zap,         label: 'Runs'    },
  { view: 'context', icon: FolderOpen,  label: 'Library' },
]

// ── Workspaces with mock unread counts ────────────────────────────────────────
const INITIAL_WORKSPACES: WorkspaceInfo[] = [
  { id: 'general',  name: 'General',      description: 'My personal AI workspace for everyday projects and tasks', emoji: '🏡', bg: '#fef3c7', unreadCount: 3 },
  { id: 'work',     name: 'Work',         description: 'Professional projects, client deliverables and briefs',    emoji: '💼', bg: '#dbeafe', unreadCount: 8 },
  { id: 'creative', name: 'Creative Lab', description: 'Design experiments, visual ideas and creative projects',   emoji: '🎨', bg: '#fce7f3', unreadCount: 0 },
]

const CHATS_PER_PAGE = 10

function sortedChats(chats: Chat[]): Chat[] {
  return [...chats].sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
}

function getChatIcon(chat: Chat, artifacts: Artifact[]): LucideIcon {
  if (chat.artifactIds?.[0]) {
    const artifact = artifacts.find(a => a.id === chat.artifactIds![0])
    if (artifact) return getArtifactIcon(artifact.type)
  }
  const t = chat.title.toLowerCase()
  if (t.match(/build|make|app|tracker|dashboard|tool|calculator/)) return Zap
  if (t.match(/site|website|landing|portfolio/))                    return Globe
  if (t.match(/image|design|logo|illustration|palette|visual/))    return ImageIcon
  if (t.match(/spreadsheet|data|table|csv|metrics|numbers|chart/)) return Table
  if (t.match(/run|schedule|automate|monitor|sync/))               return Play
  if (t.match(/write|draft|plan|strategy|brief|report|email|doc|summary|summarise|summarize/)) return FileText
  return MessageSquare
}

interface AppShellProps {
  children: ReactNode
  activeView: View
  onViewChange: (view: View) => void
  onCompose: () => void
  chats: Chat[]
  artifacts: Artifact[]
  selectedChatId?: string | null
  onChatClick: (chat: Chat) => void
  onDeleteChat: (chatId: string) => void
  unreadCount?: number
  deskUnreadCount?: number
  readChatIds?: Set<string>
  isDetailOpen?: boolean
  onArtifactClick?: (artifact: Artifact) => void
  // ── Workspace bar ──
  activeWorkspaceId: string
  onSelectWorkspace: (id: string) => void
  onGlobalToday: () => void
  onNavigateWorkspace: (id: string, view: WorkspaceNavView) => void
  // ── Today sheet ──
  todaySheetOpen?: boolean
  onTodaySheetClose?: () => void
  onSignOut?: () => void
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
  deskUnreadCount = 0,
  readChatIds = new Set(),
  isDetailOpen = false,
  onArtifactClick,
  activeWorkspaceId,
  onSelectWorkspace,
  onGlobalToday,
  onNavigateWorkspace,
  todaySheetOpen = false,
  onTodaySheetClose,
  onSignOut,
}: AppShellProps) {
  const [chatPage, setChatPage] = useState(1)
  const [chatSearchOpen, setChatSearchOpen] = useState(false)
  const [chatSearchQuery, setChatSearchQuery] = useState('')
  const [selectedTodayItem, setSelectedTodayItem] = useState<InboxItem | null>(null)
  const [focusTodayInput, setFocusTodayInput] = useState(false)
  const [workspaces, setWorkspaces] = useState<WorkspaceInfo[]>(INITIAL_WORKSPACES)
  const [settingsOpen, setSettingsOpen] = useState(false)

  const activeWorkspace = workspaces.find(w => w.id === activeWorkspaceId) ?? workspaces[0]
  const allChats        = sortedChats(chats)
  const visibleChats    = allChats.slice(0, chatPage * CHATS_PER_PAGE)
  const hasMore         = allChats.length > visibleChats.length

  return (
    <div className="flex flex-col h-dvh overflow-hidden bg-muted" style={{ '--topbar-height': '51px' } as React.CSSProperties}>

      {/* ── Global workspace bar ── */}
      <WorkspaceBar
        workspaces={workspaces}
        activeWorkspaceId={activeWorkspaceId}
        isGlobalToday={todaySheetOpen}
        todayUnreadCount={unreadCount}
        onGlobalToday={onGlobalToday}
        onSelectWorkspace={onSelectWorkspace}
        onNavigate={onNavigateWorkspace}
        onCompose={onCompose}
        onSignOut={onSignOut}
      />

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
      <div className="flex-1 min-h-0 overflow-hidden px-3 pb-3">
      <div className="flex flex-col h-full relative rounded-xl border overflow-hidden bg-background">

      {/* ── Sidebar + content ── */}
      <SidebarProvider style={{ height: 'auto' } as React.CSSProperties} className="flex-1 min-h-0">
        <Sidebar className="hidden md:flex">

          {/* ── Header: workspace identity ── */}
          <SidebarHeader>
            <SidebarMenu>
              {/* Workspace identity — static, switching happens in the top bar */}
              <SidebarMenuItem>
                <SidebarMenuButton size="lg" className="pointer-events-none select-none">
                  <div
                    className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-base"
                    style={{ backgroundColor: activeWorkspace.bg }}
                  >
                    {activeWorkspace.emoji}
                  </div>
                  <div className="flex min-w-0 flex-col gap-0.5 leading-none">
                    <span className="font-semibold text-sm truncate">{activeWorkspace.name}</span>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <span className="text-xs text-muted-foreground truncate cursor-default">
                          {activeWorkspace.description}
                        </span>
                      </TooltipTrigger>
                      <TooltipContent side="right" className="max-w-56 text-xs">
                        {activeWorkspace.description}
                      </TooltipContent>
                    </Tooltip>
                  </div>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>

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
                  {view === 'desk' && deskUnreadCount > 0 && (
                    <SidebarMenuBadge className="text-muted-foreground text-xs font-medium !top-1/2 !-translate-y-1/2 mr-1">
                      {deskUnreadCount}
                    </SidebarMenuBadge>
                  )}
                </SidebarMenuItem>
              ))}
            </SidebarMenu>

            {/* "Recent AI chats" label + search + new chat buttons */}
            <div className="flex items-center justify-between px-2 mt-3">
              <span className="text-xs font-medium text-sidebar-foreground/70">Recent AI chats</span>
              <div className="flex items-center gap-0.5">
                <button
                  onClick={() => setChatSearchOpen(true)}
                  title="Search chats"
                  className="flex h-5 w-5 shrink-0 items-center justify-center rounded-md text-sidebar-foreground/70 hover:text-sidebar-foreground hover:bg-sidebar-accent transition-colors"
                >
                  <Search className="h-3.5 w-3.5" />
                  <span className="sr-only">Search chats</span>
                </button>
                <button
                  onClick={onCompose}
                  title="New chat"
                  className="flex h-5 w-5 shrink-0 items-center justify-center rounded-md text-sidebar-foreground/70 hover:text-sidebar-foreground hover:bg-sidebar-accent transition-colors"
                >
                  <Plus className="h-3.5 w-3.5" />
                  <span className="sr-only">New chat</span>
                </button>
              </div>
            </div>
          </SidebarHeader>

          {/* ── Content: scrollable chat list ── */}
          <SidebarContent>
            <SidebarGroup className="px-2 py-0">
              <SidebarGroupContent className="pb-10">
                <SidebarMenu>
                  {visibleChats.map(chat => {
                    const ChatIcon = getChatIcon(chat, artifacts)
                    return (
                      <SidebarMenuItem key={chat.id}>
                        <SidebarMenuButton
                          isActive={chat.id === selectedChatId && !isDetailOpen}
                          onClick={() => onChatClick(chat)}
                          className="pr-7"
                        >
                          <div className="relative shrink-0">
                            <ChatIcon className="h-4 w-4 text-muted-foreground/60" />
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
            </SidebarGroup>
          </SidebarContent>

          {/* ── Footer: Customize only ── */}
          <SidebarFooter className="relative pt-3">
            <div className="absolute -top-12 inset-x-0 h-12 bg-gradient-to-b from-sidebar/0 to-sidebar pointer-events-none" />
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
        <SidebarInset>
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
                {view === 'desk' && deskUnreadCount > 0 && (
                  <span className="absolute -top-1 -right-1.5 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-primary px-0.5 text-[9px] font-medium text-primary-foreground">
                    {deskUnreadCount}
                  </span>
                )}
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
        onUpdateWorkspace={updated => {
          setWorkspaces(prev => prev.map(w => w.id === updated.id ? updated : w))
        }}
        onDeleteWorkspace={() => {
          setWorkspaces(prev => {
            const next = prev.filter(w => w.id !== activeWorkspace.id)
            if (next.length > 0) onSelectWorkspace(next[0].id)
            return next
          })
        }}
      />

      {/* ── Chat search command palette ── */}
      <CommandDialog
        open={chatSearchOpen}
        onOpenChange={(open) => { setChatSearchOpen(open); if (!open) setChatSearchQuery('') }}
        showCloseButton={false}
        className="top-[20%] translate-y-0"
      >
        <CommandInput
          placeholder="Search chats and artifacts…"
          value={chatSearchQuery}
          onValueChange={setChatSearchQuery}
        />
        <CommandList>
          <CommandEmpty>No results found.</CommandEmpty>

          {/* Default state: recent 5 chats */}
          {!chatSearchQuery.trim() && (
            <CommandGroup heading="Recent chats">
              {allChats.slice(0, 5).map(chat => {
                const ChatIcon = getChatIcon(chat, artifacts)
                return (
                  <CommandItem
                    key={chat.id}
                    value={chat.title}
                    onSelect={() => { onChatClick(chat); setChatSearchOpen(false); setChatSearchQuery('') }}
                  >
                    <ChatIcon className="h-4 w-4 text-muted-foreground" />
                    <span className="truncate">{chat.title}</span>
                  </CommandItem>
                )
              })}
            </CommandGroup>
          )}

          {/* Search state: all matching chats + artifacts */}
          {chatSearchQuery.trim() && (
            <>
              <CommandGroup heading="Chats">
                {allChats.map(chat => {
                  const ChatIcon = getChatIcon(chat, artifacts)
                  return (
                    <CommandItem
                      key={chat.id}
                      value={chat.title}
                      onSelect={() => { onChatClick(chat); setChatSearchOpen(false); setChatSearchQuery('') }}
                    >
                      <ChatIcon className="h-4 w-4 text-muted-foreground" />
                      <span className="truncate">{chat.title}</span>
                    </CommandItem>
                  )
                })}
              </CommandGroup>
              <CommandSeparator />
              <CommandGroup heading="Artifacts">
                {artifacts.map(artifact => {
                  const ArtifactIcon = getArtifactIcon(artifact.type)
                  return (
                    <CommandItem
                      key={artifact.id}
                      value={artifact.name}
                      onSelect={() => { onArtifactClick?.(artifact); setChatSearchOpen(false); setChatSearchQuery('') }}
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

