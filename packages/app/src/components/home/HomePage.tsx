import { useCallback, useEffect, useMemo, useState, type UIEvent } from 'react'
import { useDispatch } from 'react-redux'
import { useNavigate } from 'react-router-dom'
import { toast } from 'sonner'
import {
  Sun,
  MessageCircle,
  Plus,
  MoreVertical,
  FileText,
  Sparkles,
  Zap,
  Trash2,
  PinOff,
  ChevronDown,
  HelpCircle,
  Activity,
  CheckCircle2,
  RotateCcw,
} from 'lucide-react'
import {
  cn,
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  Button,
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarTrigger,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@agent-desk/ui'
import { BackgroundBlobs } from '@/components/layout/BackgroundBlobs'
import { SIDEBAR_ROW_STATE_CLASS, SidebarAccountMenu } from '@/components/layout/sidebarShared'
import { SectionHeader, SectionBody } from '@/components/shared/SectionHeader'
import { SectionEmptyState } from '@/components/shared/SectionEmptyState'
import { RowKebab } from '@/components/shared/RowKebab'
import { MyAccountModal } from '@/components/account/MyAccountModal'
import {
  api,
  useGetMeQuery,
  useGetWorkspacesQuery,
  useGetMessagesQuery,
  usePatchMessageMutation,
  useRunMessageMutation,
  useDeleteMessageMutation,
  useDeleteWorkspaceMutation,
} from '@/store/api'
import type { ServerWorkspace } from '@/store/types'
import type { Task } from '@/data/ui-types'
import { getRelativeTime } from '@/data/ui-types'
import { toWorkspaceInfo } from '@/store/selectors/workspaces'
import { roomColor } from '@/components/rooms/roomColor'
import { taskMessageKindsForDeveloperMode } from '@/store/selectors/tasks'
import { buildTaskStatusMove, buildTaskLifecycleMove } from '@/lib/task-status'
import { usePrefs } from '@/hooks/use-prefs'
import { useAvatarUrl } from '@/hooks/use-avatar'
import { useWorkspaceIconUrl } from '@/hooks/use-workspace-icon'
import { useHomePins, removeHomePin, type HomePinKind } from '@/hooks/use-home-pins'
import { useHomeSections, HOME_SECTION_LABELS, type HomeSectionKey } from '@/hooks/use-home-sections'
import { generateHomeDigest, type HomeDigest } from '@/lib/home-summary'
import { buildPath } from '@/router/nav'
import { logout } from '@/auth/session'
import { DeskWordmark } from './DeskWordmark'
import { CreateWorkspaceModal } from './CreateWorkspaceModal'
import { HomeSettingsPopover } from './HomeSettingsPopover'
import { AskAiView } from './AskAiView'
import {
  HomeWorkspaceTasks,
  type HomeTask,
  type HomeWorkspaceBuckets,
} from './HomeWorkspaceTasks'
import { TaskCard } from '@/components/tasks/TaskCard'

// Main column — bumped from 4xl → 5xl per the v2 design (gives the
// horizontally-scrolling task rows more breathing room).
const COLUMN = 'w-full max-w-5xl min-w-0 mx-auto'

function errMsg(err: unknown): string | undefined {
  if (typeof err === 'object' && err && 'data' in err) {
    const data = (err as { data?: unknown }).data
    if (typeof data === 'string') return data
    if (typeof data === 'object' && data && 'message' in data) {
      const m = (data as { message?: unknown }).message
      if (typeof m === 'string') return m
    }
  }
  return undefined
}

function recency(t: Task): number {
  return (t.completedAt ?? t.nextRun ?? t.startedAt).getTime()
}

/** A selectable top-level nav row (Your day / Ask AI). */
function HomeNavItem({
  icon: Icon,
  label,
  active,
  badge,
  onSelect,
}: {
  icon: React.ComponentType<{ className?: string }>
  label: string
  active: boolean
  badge?: number
  onSelect: () => void
}) {
  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        isActive={active}
        onClick={onSelect}
        className={cn(SIDEBAR_ROW_STATE_CLASS, 'text-foreground', badge ? 'pr-9' : undefined)}
      >
        <Icon className="h-4 w-4 text-muted-foreground" />
        <span className="flex-1 min-w-0 truncate text-left">{label}</span>
      </SidebarMenuButton>
      {badge ? (
        <SidebarMenuBadge aria-label={`${badge} need your input`}>{badge}</SidebarMenuBadge>
      ) : null}
    </SidebarMenuItem>
  )
}

/** Room row — owns its own per-room "Needs input" badge query, and a
 *  hover kebab with a Delete-room action (AlertDialog confirm). */
function HomeRoomItem({
  workspace,
  onOpen,
  onRequestDelete,
}: {
  workspace: ServerWorkspace
  onOpen: (ws: ServerWorkspace) => void
  onRequestDelete: (ws: ServerWorkspace) => void
}) {
  const { developerMode } = usePrefs()
  const info = toWorkspaceInfo(workspace)
  const icon = useWorkspaceIconUrl(workspace.id)
  const { data } = useGetMessagesQuery({
    workspaceId: workspace.id,
    kind: taskMessageKindsForDeveloperMode(developerMode),
    unread: true,
  })
  const needsInput = data?.items.length ?? 0

  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        onClick={() => onOpen(workspace)}
        className={cn(SIDEBAR_ROW_STATE_CLASS, 'pr-9 text-foreground')}
        data-testid={`home-room-${workspace.id}`}
      >
        {icon ? (
          <img src={icon} alt="" className="h-4 w-4 shrink-0 rounded-full object-cover" />
        ) : (
          <span
            className="h-4 w-4 shrink-0 rounded-full border-2"
            style={{ borderColor: roomColor(info.bg) }}
          />
        )}
        <span className="flex-1 min-w-0 truncate text-left">{info.name}</span>
      </SidebarMenuButton>
      {needsInput > 0 && (
        <SidebarMenuBadge
          // Fade the badge out on row-hover so the kebab (also at
          // `right-1/2`) reads cleanly without overlapping.
          className="transition-opacity group-hover/menu-item:opacity-0 group-focus-within/menu-item:opacity-0"
          aria-label={`${needsInput} task${needsInput === 1 ? '' : 's'} need your input`}
        >
          {needsInput}
        </SidebarMenuBadge>
      )}
      <RowKebab align="start" side="right" contentClassName="w-40" label="Room options">
        <DropdownMenuItem
          className="text-destructive focus:text-destructive"
          onClick={() => onRequestDelete(workspace)}
        >
          <Trash2 className="h-4 w-4 mr-2" />
          Delete room
        </DropdownMenuItem>
      </RowKebab>
    </SidebarMenuItem>
  )
}

const FAVORITE_ICON: Record<HomePinKind, React.ComponentType<{ className?: string }>> = {
  file: FileText,
  artifact: Sparkles,
  chat: MessageCircle,
  task: Zap,
}

/** Per-section visual: an icon shown in the empty state. */
const SECTION_EMPTY_ICON: Record<Exclude<HomeSectionKey, 'summary'>, React.ComponentType<{ className?: string }>> = {
  needsInput: HelpCircle,
  nowHappening: Activity,
  done: CheckCircle2,
}

/** One dropdown row for the "Create new task" room picker. Pulls its
 *  own icon URL so each row can show the same icon-or-ring affordance
 *  the sidebar uses for room rows. */
function RoomMenuItem({
  workspace,
  onSelect,
}: {
  workspace: ServerWorkspace
  onSelect: (ws: ServerWorkspace) => void
}) {
  const info = toWorkspaceInfo(workspace)
  const iconUrl = useWorkspaceIconUrl(workspace.id)
  return (
    <DropdownMenuItem onClick={() => onSelect(workspace)}>
      {iconUrl ? (
        <img
          src={iconUrl}
          alt=""
          aria-hidden
          className="h-4 w-4 shrink-0 rounded-full object-cover"
        />
      ) : (
        <span
          aria-hidden
          className="h-4 w-4 shrink-0 rounded-full border-2"
          style={{ borderColor: roomColor(info.bg) }}
        />
      )}
      <span className="truncate">{info.name}</span>
    </DropdownMenuItem>
  )
}

/**
 * The empty-state for a Home section — centred, subtler muted icon,
 * "Create new task" outline button with a chevron-down opening a room
 * picker. Each room row in the picker shows its icon-or-ring +
 * name (mirrors the sidebar). Picking a room navigates to that room's
 * Tasks view with a router-state hint so the composer auto-focuses on
 * arrival.
 */
function SectionEmpty({
  icon: Icon,
  text,
  workspaces,
  onCreateInRoom,
}: {
  icon: React.ComponentType<{ className?: string }>
  text: string
  workspaces: ServerWorkspace[]
  onCreateInRoom: (ws: ServerWorkspace) => void
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-border p-8 text-center">
      <Icon className="h-8 w-8 text-foreground/20" />
      <p className="text-sm text-muted-foreground">{text}</p>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-8"
            disabled={workspaces.length === 0}
          >
            Create new task
            <ChevronDown className="h-4 w-4 ml-1.5" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="center" className="w-56">
          {workspaces.map(ws => (
            <RoomMenuItem key={ws.id} workspace={ws} onSelect={onCreateInRoom} />
          ))}
          {workspaces.length === 0 && (
            <DropdownMenuItem disabled>No rooms yet</DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}

/** A horizontally-scrolling row of task cards for one Home section. */
function TaskRow({
  items,
  authorName,
  authorAvatarUrl,
  onOpenTask,
  onMarkDone,
  onReopen,
  onRunNow,
  onPause,
  onDelete,
}: {
  items: HomeTask[]
  authorName?: string
  authorAvatarUrl?: string | null
  onOpenTask: (h: HomeTask) => void
  onMarkDone: (h: HomeTask) => void
  onReopen: (h: HomeTask) => void
  onRunNow: (h: HomeTask) => void
  onPause: (h: HomeTask) => void
  onDelete: (h: HomeTask) => void
}) {
  return (
    <div className="flex gap-3 overflow-x-auto pb-2">
      {items.map(h => (
        <div key={`${h.workspaceId}:${h.task.id}`} className="w-[min(420px,82vw)] shrink-0">
          <TaskCard
            task={h.task}
            roomName={h.roomName}
            roomColor={h.roomColor}
            roomIconUrl={h.roomIconUrl}
            authorName={authorName}
            authorAvatarUrl={authorAvatarUrl}
            homePinRef={{
              kind: 'task',
              id: h.task.id,
              workspaceId: h.workspaceId,
              label: h.task.title || h.task.name,
            }}
            // The card itself is a Link to the task's docked-chat URL
            // (middle-click / cmd-click opens in a new tab). The
            // Replies button still uses `onSelect` for the slide-out
            // navigation.
            href={buildPath(h.workspaceId, 'tasks', { task: h.task.id })}
            onSelect={() => onOpenTask(h)}
            onMarkDone={() => onMarkDone(h)}
            onReopen={() => onReopen(h)}
            onRunNow={h.task.status === 'scheduled' ? () => onRunNow(h) : undefined}
            onPause={
              (h.task.status === 'active' || h.task.status === 'scheduled') &&
              h.task.messageState !== 'paused'
                ? () => onPause(h)
                : undefined
            }
            onDelete={() => onDelete(h)}
          />
        </div>
      ))}
    </div>
  )
}

/**
 * Home — a cross-room digest. The sidebar mirrors the room sidebar; the
 * main area is either "Your day" (AI greeting/summary + Needs-input / Now
 * happening / Done rows aggregated from every room) or "Ask AI" (a single
 * global chat thread). Section order/visibility is user-configurable.
 */
export function HomePage() {
  const navigate = useNavigate()
  const { data: workspaces } = useGetWorkspacesQuery()
  const { data: me } = useGetMeQuery()
  const userAvatarUrl = useAvatarUrl(me?.id)
  const [createOpen, setCreateOpen] = useState(false)
  const [myAccountOpen, setMyAccountOpen] = useState(false)
  const [roomsCollapsed, setRoomsCollapsed] = useState(false)
  const [favCollapsed, setFavCollapsed] = useState(false)
  const [view, setView] = useState<'day' | 'askai'>('day')
  const [pendingDeleteWs, setPendingDeleteWs] = useState<ServerWorkspace | null>(null)

  const homePins = useHomePins()
  // The Summary section is always shown (its popover checkbox is
  // disabled-checked); the other three are user-toggleable via the
  // popover.
  const { order, isVisible } = useHomeSections()

  const dispatch = useDispatch()
  const [patchMessage] = usePatchMessageMutation()
  const [runMessage] = useRunMessageMutation()
  const [deleteMessage] = useDeleteMessageMutation()
  const [deleteWorkspace] = useDeleteWorkspaceMutation()
  // Bumped by the "Refresh" kebab action — added to the digest
  // effect's deps so the greeting/summary regenerate even when the
  // bucket counts haven't shifted.
  const [refreshNonce, setRefreshNonce] = useState(0)

  // Top-of-main fades into the page when scrolled (mirror of TasksPage).
  const [scrolled, setScrolled] = useState(false)
  const onMainScroll = (e: UIEvent<HTMLDivElement>) => {
    setScrolled(e.currentTarget.scrollTop > 0)
  }

  // ── Cross-room aggregation (one headless child per workspace) ──
  const [bucketsByWs, setBucketsByWs] = useState<Record<string, HomeWorkspaceBuckets>>({})
  const handleTasks = useCallback((wsId: string, b: HomeWorkspaceBuckets) => {
    setBucketsByWs(prev => (prev[wsId] === b ? prev : { ...prev, [wsId]: b }))
  }, [])

  const { needsInput, active, done } = useMemo(() => {
    const all = Object.values(bucketsByWs)
    const sortRows = (rows: HomeTask[]) =>
      [...rows].sort((a, b) => recency(b.task) - recency(a.task))
    return {
      needsInput: sortRows(all.flatMap(b => b.needsInput)),
      active: sortRows(all.flatMap(b => b.active)),
      done: sortRows(all.flatMap(b => b.done)),
    }
  }, [bucketsByWs])

  // ── AI digest (greeting + summary) ──
  const sig = `${needsInput.length}-${active.length}-${done.length}`
  const [digest, setDigest] = useState<HomeDigest | null>(null)
  useEffect(() => {
    let cancelled = false
    void generateHomeDigest(
      { needsInput: needsInput.length, active: active.length, done: done.length },
      me?.username,
    ).then(d => {
      if (!cancelled) setDigest(d)
    })
    return () => {
      cancelled = true
    }
    // `sig` already encodes the three counts; listed here to satisfy
    // the exhaustive-deps lint without re-running on identical counts.
  }, [sig, me?.username, needsInput.length, active.length, done.length, refreshNonce])

  // Re-render the "Refreshed Xm ago" pill every minute.
  const [, setTick] = useState(0)
  useEffect(() => {
    const id = window.setInterval(() => setTick(t => t + 1), 60_000)
    return () => window.clearInterval(id)
  }, [])

  // ── Sidebar slide-in ──
  const [entered, setEntered] = useState(false)
  const [leaving, setLeaving] = useState(false)
  useEffect(() => {
    const id = requestAnimationFrame(() => setEntered(true))
    return () => cancelAnimationFrame(id)
  }, [])
  const slideClass =
    entered && !leaving ? 'translate-x-0 opacity-100' : '-translate-x-4 opacity-0'

  const openRoom = (ws: ServerWorkspace) => {
    setLeaving(true)
    window.setTimeout(() => navigate(buildPath(ws.id, 'tasks')), 200)
  }
  const openTask = (h: HomeTask) => {
    setLeaving(true)
    window.setTimeout(
      () => navigate(buildPath(h.workspaceId, 'tasks', { task: h.task.id })),
      200,
    )
  }

  // ── Task actions (mirror App.tsx Tasks handlers) ──
  const doMarkDone = async (h: HomeTask) => {
    const t = h.task
    if (!t.chatId || !t.messageId) return
    const move = buildTaskStatusMove(t, 'complete', 'user')
    if (move.kind !== 'patch') return
    try {
      await patchMessage({ chatId: t.chatId, messageId: t.messageId, patch: move.patch }).unwrap()
    } catch (err) {
      toast.error('Failed to mark done', { description: errMsg(err) })
    }
  }
  const doReopen = async (h: HomeTask) => {
    const t = h.task
    if (!t.chatId || !t.messageId) return
    const move = buildTaskStatusMove(t, 'todo', 'user')
    if (move.kind !== 'patch') return
    try {
      await patchMessage({ chatId: t.chatId, messageId: t.messageId, patch: move.patch }).unwrap()
    } catch (err) {
      toast.error('Reopen failed', { description: errMsg(err) })
    }
  }
  const doRunNow = async (h: HomeTask) => {
    const t = h.task
    if (!t.chatId || !t.messageId) return
    try {
      await runMessage({ chatId: t.chatId, messageId: t.messageId }).unwrap()
    } catch (err) {
      toast.error('Run failed', { description: errMsg(err) })
    }
  }
  const doPause = async (h: HomeTask) => {
    const t = h.task
    if (!t.chatId || !t.messageId) return
    const move = buildTaskLifecycleMove(t, 'pause', 'user')
    if (move.kind !== 'patch') return
    try {
      await patchMessage({ chatId: t.chatId, messageId: t.messageId, patch: move.patch }).unwrap()
    } catch (err) {
      toast.error('Pause failed', { description: errMsg(err) })
    }
  }
  const doDelete = async (h: HomeTask) => {
    const t = h.task
    if (!t.chatId || !t.messageId) return
    try {
      await deleteMessage({ chatId: t.chatId, messageId: t.messageId }).unwrap()
    } catch (err) {
      toast.error('Delete failed', { description: errMsg(err) })
    }
  }

  const sectionRows: Record<Exclude<HomeSectionKey, 'summary'>, HomeTask[]> = {
    needsInput,
    nowHappening: active,
    done,
  }
  const sectionEmpty: Record<Exclude<HomeSectionKey, 'summary'>, string> = {
    needsInput: 'Nothing needs your input across your rooms.',
    nowHappening: 'No tasks are running right now.',
    done: 'Nothing completed recently.',
  }

  /** Navigate into a room's Tasks view with a router-state hint that
   *  makes the composer auto-focus on arrival. */
  const createInRoom = (ws: ServerWorkspace) => {
    setLeaving(true)
    window.setTimeout(
      () =>
        navigate(buildPath(ws.id, 'tasks'), {
          state: { focusComposer: true },
        }),
      200,
    )
  }

  /** Reload the digest (AI greeting + summary) and force every
   *  cross-room messages query to refetch. */
  const refreshHome = () => {
    dispatch(api.util.invalidateTags([{ type: 'Message', id: 'CROSS' }]))
    setRefreshNonce(n => n + 1)
  }

  /** Confirm a room delete via AlertDialog. */
  const confirmDeleteRoom = async () => {
    const ws = pendingDeleteWs
    if (!ws) return
    try {
      await deleteWorkspace(ws.id).unwrap()
    } catch (err) {
      toast.error('Failed to delete room', { description: errMsg(err) })
    } finally {
      setPendingDeleteWs(null)
    }
  }

  return (
    <SidebarProvider
      // `flex-col` (added on top of the primitive's default `flex`)
      // lets us stack a full-width top bar above the sidebar + main
      // row — same pattern AppShell uses for the room view, where the
      // global TopBar sits above the per-room sidebar.
      className="flex-col"
      style={{ '--sidebar-width': '290px' } as React.CSSProperties}
    >
      <BackgroundBlobs />

      {/* Headless cross-room fetchers (always mounted so the Your-day
          badge + digest stay live regardless of which view is open). */}
      {(workspaces ?? []).map(ws => (
        <HomeWorkspaceTasks key={ws.id} workspace={ws} onTasks={handleTasks} />
      ))}

      {/* Home top bar — 64 px, full-viewport-wide (mirrors the room
          view's global TopBar). Left: Desk wordmark sits above the
          sidebar; right: page controls. */}
      <div className="relative z-20 flex w-full min-h-16 items-center px-6 py-4 shrink-0">
        <div className="flex flex-1 items-center">
          <DeskWordmark className="h-5 w-auto text-foreground" aria-hidden />
          <span className="sr-only">Desk Home</span>
        </div>
        <div className="flex items-center gap-1">
          <HomeSettingsPopover />
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8 text-foreground"
                aria-label="More"
                data-testid="home-more-button"
              >
                <MoreVertical className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-44">
              <DropdownMenuItem onClick={refreshHome} data-testid="home-refresh">
                <RotateCcw className="h-4 w-4 mr-2" />
                Refresh
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {/* Row below the bar: sidebar (left) + main (right). */}
      <div className="flex flex-1 min-h-0 min-w-0 w-full overflow-hidden">

      <Sidebar className="bg-transparent border-r-0 pl-4 pr-0 pt-0 pb-6">
        <div
          className={cn(
            'flex h-full min-h-0 flex-col transition-[transform,opacity] duration-200 ease-out',
            slideClass,
          )}
        >
          {/* ── Sidebar mirrors the room sidebar layout exactly ──
              SidebarHeader holds the top nav + the first (Rooms)
              section header & body; SidebarContent scrolls the second
              (Favorites) section — same split RoomSidebar uses for
              Pinned + Chats. No wordmark in the sidebar. */}
          <SidebarHeader className="bg-transparent p-0">
            <SidebarTrigger className="absolute right-2 top-2 z-20 h-8 w-8 rounded-md md:hidden" />

            <SidebarMenu className="pt-6 pb-1">
              <HomeNavItem
                icon={Sun}
                label="Your day"
                active={view === 'day'}
                badge={needsInput.length || undefined}
                onSelect={() => setView('day')}
              />
              <HomeNavItem
                icon={MessageCircle}
                label="Ask AI"
                active={view === 'askai'}
                onSelect={() => setView('askai')}
              />
            </SidebarMenu>

            <SectionHeader
              label="Rooms"
              collapsed={roomsCollapsed}
              onToggle={() => setRoomsCollapsed(c => !c)}
              actions={
                <button
                  onClick={() => setCreateOpen(true)}
                  title="Create a room"
                  data-testid="home-create-room"
                  className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-foreground/10 hover:text-foreground transition-colors"
                >
                  <Plus className="h-4 w-4" />
                  <span className="sr-only">Create a room</span>
                </button>
              }
            />
            <SectionBody collapsed={roomsCollapsed}>
              <SidebarGroup className="p-0">
                <SidebarGroupContent>
                  <SidebarMenu>
                    {(workspaces ?? []).map(ws => (
                      <HomeRoomItem
                        key={ws.id}
                        workspace={ws}
                        onOpen={openRoom}
                        onRequestDelete={setPendingDeleteWs}
                      />
                    ))}
                  </SidebarMenu>
                </SidebarGroupContent>
              </SidebarGroup>
            </SectionBody>

            <SectionHeader
              label="Favorites"
              collapsed={favCollapsed}
              onToggle={() => setFavCollapsed(c => !c)}
              className="mt-3"
            />
          </SidebarHeader>

          <SidebarContent className="bg-transparent">
            <SectionBody collapsed={favCollapsed}>
              <SidebarGroup className="p-0">
                <SidebarGroupContent>
                  {homePins.length === 0 ? (
                    <SectionEmptyState>
                      Use “Show in Home” on a file, chat or task to pin it here.
                    </SectionEmptyState>
                  ) : (
                    <SidebarMenu>
                      {homePins.map(p => {
                        const Icon = FAVORITE_ICON[p.kind]
                        return (
                          <SidebarMenuItem key={`${p.kind}:${p.id}`}>
                            <SidebarMenuButton
                              className={cn(SIDEBAR_ROW_STATE_CLASS, 'pr-9 text-foreground')}
                              onClick={() => {
                                if (!p.workspaceId) return
                                const q =
                                  p.kind === 'chat'
                                    ? { chat: p.id }
                                    : p.kind === 'task'
                                      ? { task: p.id }
                                      : p.kind === 'artifact'
                                        ? { artifact: p.id }
                                        : { item: p.id }
                                const view_ = p.kind === 'task' ? 'tasks' : p.kind === 'file' ? 'context' : 'pinned'
                                setLeaving(true)
                                window.setTimeout(
                                  () => navigate(buildPath(p.workspaceId!, view_, q)),
                                  200,
                                )
                              }}
                            >
                              <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
                              <span className="flex-1 min-w-0 truncate text-left">{p.label}</span>
                            </SidebarMenuButton>
                            <RowKebab align="start" side="right" contentClassName="w-40" label="Favorite options">
                              <DropdownMenuItem onClick={() => removeHomePin(p.kind, p.id)}>
                                <PinOff className="h-4 w-4 mr-2" />
                                Hide from Home
                              </DropdownMenuItem>
                            </RowKebab>
                          </SidebarMenuItem>
                        )
                      })}
                    </SidebarMenu>
                  )}
                </SidebarGroupContent>
              </SidebarGroup>
            </SectionBody>
          </SidebarContent>

          <SidebarFooter className="bg-transparent p-0">
            <SidebarAccountMenu
              username={me?.username}
              email={me?.email}
              userAvatarUrl={userAvatarUrl}
              onOpenMyAccount={() => setMyAccountOpen(true)}
              onSignOut={() => void logout()}
            />
          </SidebarFooter>
        </div>
      </Sidebar>

      <main className="relative z-10 flex min-h-0 flex-1 flex-col">
        {view === 'askai' ? (
          <AskAiView />
        ) : (
          <>
            {/* Scroll column. Mirrors the TasksPage mask: bottom always
                fades, top fades only once you've scrolled. `pt-6`
                matches the Tasks page's content inset; combined with
                the 64 px top bar above (hoisted as a sibling above
                this row), the first content row sits 88 px from the
                top of the viewport — same as a room view. */}
            <div
              className="flex-1 min-h-0 overflow-y-auto px-6 pt-6 pb-16"
              onScroll={onMainScroll}
              style={{
                maskImage: scrolled
                  ? 'linear-gradient(to bottom, transparent 0, #000 64px, #000 calc(100% - 64px), transparent 100%)'
                  : 'linear-gradient(to bottom, #000 0, #000 calc(100% - 64px), transparent 100%)',
                WebkitMaskImage: scrolled
                  ? 'linear-gradient(to bottom, transparent 0, #000 64px, #000 calc(100% - 64px), transparent 100%)'
                  : 'linear-gradient(to bottom, #000 0, #000 calc(100% - 64px), transparent 100%)',
              }}
            >
              <div className={`${COLUMN} flex flex-col gap-6`}>
                <div className="flex flex-col gap-3">
                  {digest && (
                    <span className="inline-flex w-fit items-center rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
                      Refreshed {getRelativeTime(new Date(digest.generatedAt))}
                    </span>
                  )}
                  <h1 className="text-2xl font-semibold text-foreground">
                    {digest?.greeting ?? '…'}
                  </h1>
                  {digest?.summary && (
                    <p className="text-base leading-6 text-foreground">{digest.summary}</p>
                  )}
                </div>

                {order
                  .filter((k): k is Exclude<HomeSectionKey, 'summary'> => k !== 'summary')
                  .filter(k => isVisible(k))
                  .map(key => (
                    <section key={key} className="flex flex-col gap-3">
                      <h2 className="text-lg leading-7 font-bold text-foreground">
                        {HOME_SECTION_LABELS[key]}
                      </h2>
                      {sectionRows[key].length === 0 ? (
                        <SectionEmpty
                          icon={SECTION_EMPTY_ICON[key]}
                          text={sectionEmpty[key]}
                          workspaces={workspaces ?? []}
                          onCreateInRoom={createInRoom}
                        />
                      ) : (
                        <TaskRow
                          items={sectionRows[key]}
                          authorName={me?.username}
                          authorAvatarUrl={userAvatarUrl}
                          onOpenTask={openTask}
                          onMarkDone={doMarkDone}
                          onReopen={doReopen}
                          onRunNow={doRunNow}
                          onPause={doPause}
                          onDelete={doDelete}
                        />
                      )}
                    </section>
                  ))}
              </div>
            </div>
          </>
        )}
      </main>
      </div>{/* /sidebar + main row */}

      <AlertDialog
        open={!!pendingDeleteWs}
        onOpenChange={open => { if (!open) setPendingDeleteWs(null) }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {pendingDeleteWs ? `Delete "${pendingDeleteWs.name}"?` : 'Delete room?'}
            </AlertDialogTitle>
            <AlertDialogDescription>
              This permanently removes the room and all of its chats, tasks and library
              items. This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => void confirmDeleteRoom()}
            >
              Delete room
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <CreateWorkspaceModal
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={openRoom}
      />
      <MyAccountModal open={myAccountOpen} onOpenChange={setMyAccountOpen} />
    </SidebarProvider>
  )
}
