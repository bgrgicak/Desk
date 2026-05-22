import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type UIEvent } from 'react'
import { useDispatch, useSelector } from 'react-redux'
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router-dom'
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
  Search,
  X,
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
  Badge,
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
import { useGlobalPalette } from '@/components/global-palette/GlobalPaletteProvider'
import { SectionHeader, SectionBody } from '@/components/shared/SectionHeader'
import { SectionEmptyState } from '@/components/shared/SectionEmptyState'
import { RowKebab } from '@/components/shared/RowKebab'
import { MyAccountModal } from '@/components/account/MyAccountModal'
import {
  api,
  useGetMeQuery,
  useGetWorkspacesQuery,
  useGetMessagesQuery,
  useGetChatsQuery,
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
import {
  buildPath,
  encodeAccountSettings,
  mergeSearch,
  parseAccountSettings,
  type AccountSettingsSectionId,
  type AccountSettingsState,
  type ModelsFocus,
  type RouteView,
} from '@/router/nav'
import { buildDefaultViewPath } from '@/App'
import { logout } from '@/auth/session'
import { DeskWordmark } from './DeskWordmark'
import { CreateWorkspaceModal } from './CreateWorkspaceModal'
import { HomeSettingsPopover } from './HomeSettingsPopover'
import { AskAiView } from './AskAiView'
import { HomeTaskList } from './HomeTaskList'
import { HomeSectionTabs } from './HomeSectionTabs'
import { TaskChatPanel } from '@/components/tasks/TaskChatPanel'
import { RoomAvatarStack } from '@/components/layout/RoomAvatarStack'
import { SplitResizeHandle } from '@/components/shared/SplitResizeHandle'
import { useSplitResize } from '@/components/shared/splitPane'
import {
  selectTasksSplitRatio,
  setTasksSplitRatio,
  TASKS_SPLIT_RATIO_STORAGE_KEY_EXPORT,
  PREVIEW_MIN_CHAT_WIDTH,
  PREVIEW_MIN_PANEL_WIDTH,
} from '@/store/slices/previewPanelSlice'
import { AnimatePresence, motion } from 'framer-motion'
import {
  HomeWorkspaceTasks,
  type HomeTask,
  type HomeWorkspaceBuckets,
} from './HomeWorkspaceTasks'

// Main column — matches the Tasks page (`max-w-4xl`) so Home and a
// room view share one content rhythm.
const COLUMN = 'w-full max-w-4xl min-w-0 mx-auto'

// Set on the user's very first visit to Home. Until it's present, an
// unparameterised Home URL redirects to `?view=askai` so a brand-new
// account lands in the Ask AI chat instead of the (empty) day digest.
const HOME_VISITED_KEY = 'desk.home.has-visited'

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

/** A click that the browser should handle natively (open in a new tab,
 *  background tab, new window) rather than our client-side handler. We
 *  let it fall through so middle-click and cmd/ctrl/shift-click on a
 *  Link still open in a new tab, even when the row's onClick would
 *  otherwise preventDefault to run a slide-out animation. */
function isModifiedClick(e: React.MouseEvent): boolean {
  return (
    e.button !== 0 ||
    e.metaKey ||
    e.ctrlKey ||
    e.shiftKey ||
    e.altKey
  )
}

/** A selectable top-level nav row (Your day / Ask AI). Rendered as a
 *  Link so middle/cmd-click opens the view in a new tab. */
function HomeNavItem({
  icon: Icon,
  label,
  href,
  active,
  badge,
}: {
  icon: React.ComponentType<{ className?: string }>
  label: string
  href: string
  active: boolean
  badge?: number
}) {
  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        asChild
        isActive={active}
        className={cn(SIDEBAR_ROW_STATE_CLASS, 'text-foreground', badge ? 'pr-10' : undefined)}
      >
        <Link to={href}>
          <Icon className="h-4 w-4 text-muted-foreground" />
          <span className="flex-1 min-w-0 truncate text-left">{label}</span>
        </Link>
      </SidebarMenuButton>
      {badge ? (
        // Outline-style badge. `right-2` puts the badge's right edge
        // 8 px from the row — same column the section-header icon
        // buttons live in (they sit inside the header's `pr-2`).
        <SidebarMenuBadge
          className="right-2 rounded-full border border-border px-2 text-foreground"
          aria-label={`${badge} need your input`}
        >
          {badge}
        </SidebarMenuBadge>
      ) : null}
    </SidebarMenuItem>
  )
}

/** Room row — owns its own per-room "Needs input" badge query, and a
 *  hover kebab with a Delete-room action (AlertDialog confirm).
 *
 *  Rendered as a Link so middle/cmd-click opens the room in a new tab.
 *  Unmodified left-clicks preventDefault and route through `onOpen` so
 *  the parent can still run the sidebar slide-out animation before
 *  navigating. */
function HomeRoomItem({
  workspace,
  href,
  onOpen,
  onRequestDelete,
}: {
  workspace: ServerWorkspace
  href: string
  onOpen: (ws: ServerWorkspace) => void
  onRequestDelete: (ws: ServerWorkspace) => void
}) {
  const { developerMode } = usePrefs()
  const info = toWorkspaceInfo(workspace)
  const icon = useWorkspaceIconUrl(workspace.id)
  // Tasks awaiting the user's input — task-kind messages flagged unread.
  const { data: needsInputResp } = useGetMessagesQuery({
    workspaceId: workspace.id,
    kind: taskMessageKindsForDeveloperMode(developerMode),
    unread: true,
  })
  // Chats with unread messages — `unread` on the Chat row flips when an
  // agent message lands while the chat isn't focused (same signal the
  // RoomSidebar's unread dot uses).
  const { data: chatsResp } = useGetChatsQuery({ workspaceId: workspace.id })
  const needsInput = needsInputResp?.items.length ?? 0
  const unreadChats = chatsResp?.filter(c => c.unread).length ?? 0
  const badgeCount = needsInput + unreadChats

  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        asChild
        className={cn(SIDEBAR_ROW_STATE_CLASS, 'pr-10 text-foreground')}
        data-testid={`home-room-${workspace.id}`}
      >
        <Link
          to={href}
          onClick={(e) => {
            if (isModifiedClick(e)) return
            e.preventDefault()
            onOpen(workspace)
          }}
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
        </Link>
      </SidebarMenuButton>
      {badgeCount > 0 && (
        <SidebarMenuBadge
          // Outline-style badge, column-aligned with the section-
          // header icon buttons (`right-2` = 8 px, matching the
          // header's `pr-2`). Fades out on row-hover so the kebab
          // beneath can take over the same column without overlap.
          className="right-2 rounded-full border border-border px-2 text-foreground transition-opacity group-hover/menu-item:opacity-0 group-focus-within/menu-item:opacity-0"
          aria-label={[
            needsInput > 0 ? `${needsInput} task${needsInput === 1 ? '' : 's'} need your input` : null,
            unreadChats > 0 ? `${unreadChats} unread chat${unreadChats === 1 ? '' : 's'}` : null,
          ].filter(Boolean).join(', ')}
        >
          {badgeCount}
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

/**
 * Home — a cross-room digest. The sidebar mirrors the room sidebar; the
 * main area is either "Your day" (AI greeting/summary + Needs-input / Now
 * happening / Done rows aggregated from every room) or "Ask AI" (a single
 * global chat thread). Section order/visibility is user-configurable.
 */
export function HomePage() {
  const navigate = useNavigate()
  const location = useLocation()
  // `?task=<id>` opens that task's chat thread in a docked side panel
  // on the right (same UX as the Tasks page) without leaving Home.
  // Cmd-click / middle-click on a card hits this URL form too, so
  // the deep-link still works.
  const [searchParams, setSearchParams] = useSearchParams()
  const selectedTaskId = searchParams.get('task')
  const { data: workspaces } = useGetWorkspacesQuery()
  const { data: me } = useGetMeQuery()
  const { defaultView } = usePrefs()
  const userAvatarUrl = useAvatarUrl(me?.id)
  const [createOpen, setCreateOpen] = useState(false)
  // Account modal state lives in the URL (`?account=…`) so reloads
  // preserve the open section + sub-focus. Mirrors the AppShell wiring
  // so behavior is consistent from both Home and inside a workspace.
  const accountState = parseAccountSettings(searchParams.get('account'))
  const setAccountState = useCallback((state: AccountSettingsState | null) => {
    const next = `${location.pathname}${mergeSearch(location.search, {
      account: state ? encodeAccountSettings(state) : null,
    })}${location.hash}`
    navigate(next)
  }, [navigate, location.pathname, location.search, location.hash])
  const [roomsCollapsed, setRoomsCollapsed] = useState(false)
  const [favCollapsed, setFavCollapsed] = useState(false)
  // View is persisted in the URL (`?view=askai`) so a reload — or a
  // bookmark / shared link — keeps the user on the Ask AI screen
  // instead of snapping back to Your day.
  const view: 'day' | 'askai' = searchParams.get('view') === 'askai' ? 'askai' : 'day'

  // First-visit redirect: an unparameterised Home URL on a brand-new
  // account opens Ask AI rather than the (empty) day digest. Marker is
  // a single localStorage flag, written once and never cleared, so
  // every subsequent visit falls back to the normal `?view=` default.
  // useLayoutEffect runs before paint so the swap doesn't flash 'day'.
  const firstVisitSyncedRef = useRef(false)
  useLayoutEffect(() => {
    if (firstVisitSyncedRef.current) return
    firstVisitSyncedRef.current = true
    if (searchParams.has('view')) return
    try {
      if (window.localStorage.getItem(HOME_VISITED_KEY)) return
      window.localStorage.setItem(HOME_VISITED_KEY, '1')
      const sp = new URLSearchParams(searchParams)
      sp.set('view', 'askai')
      setSearchParams(sp, { replace: true })
    } catch {
      // localStorage unavailable — fall through to the day digest.
    }
  }, [searchParams, setSearchParams])
  // Hrefs for the top-level nav (Your day / Ask AI). Built from the
  // current URL so other params (`?task=<id>`) survive a view switch
  // AND so middle-click / cmd-click opens the same URL in a new tab.
  const dayHref = useMemo(() => {
    const sp = new URLSearchParams(searchParams)
    sp.delete('view')
    const s = sp.toString()
    return `${location.pathname}${s ? '?' + s : ''}`
  }, [searchParams, location.pathname])
  const askAiHref = useMemo(() => {
    const sp = new URLSearchParams(searchParams)
    sp.set('view', 'askai')
    return `${location.pathname}?${sp.toString()}`
  }, [searchParams, location.pathname])
  const [pendingDeleteWs, setPendingDeleteWs] = useState<ServerWorkspace | null>(null)

  const palette = useGlobalPalette()
  const homePins = useHomePins()
  // The Summary section is always shown (its popover checkbox is
  // disabled-checked); the other three are user-toggleable via the
  // popover.
  const { order, isVisible } = useHomeSections()

  const dispatch = useDispatch()
  // Docked task-chat split — Home shares the Tasks page's split
  // ratio (same Redux selector + localStorage key) so the chat
  // column width feels consistent across both surfaces. The chat
  // panel + header both consume the same `chatWidth` derived here.
  const splitRatio = useSelector(selectTasksSplitRatio)
  const chatWidth = `${Math.round((1 - splitRatio) * 100)}vw`
  const { isResizing: isChatResizing, onMouseDown: onChatResizeStart } = useSplitResize({
    getStartRatio: () => splitRatio,
    onRatio: (r) => dispatch(setTasksSplitRatio(r)),
    onCommit: (r) => {
      try {
        window.localStorage.setItem(TASKS_SPLIT_RATIO_STORAGE_KEY_EXPORT, String(r))
      } catch {
        // localStorage unavailable — ratio still applies for this session.
      }
    },
    minLeftPx: PREVIEW_MIN_PANEL_WIDTH,
    minRightPx: PREVIEW_MIN_CHAT_WIDTH,
  })
  const [patchMessage] = usePatchMessageMutation()
  const [runMessage] = useRunMessageMutation()
  const [deleteMessage] = useDeleteMessageMutation()
  const [deleteWorkspace] = useDeleteWorkspaceMutation()
  // Bumped by the "Refresh" kebab action — added to the digest
  // effect's deps so the greeting/summary regenerate even when the
  // bucket counts haven't shifted.
  const [refreshNonce, setRefreshNonce] = useState(0)

  // Refs + state for the scroll-aware section tabs in the top bar.
  // The main scroll container is the IntersectionObserver root for the
  // active-section observer below; the "show tabs" trigger uses the
  // onScroll handler directly so a stale ref + a not-yet-observed
  // target can't leave the tabs invisible.
  const scrollContainerRef = useRef<HTMLDivElement | null>(null)
  const sectionRefs = useRef<
    Partial<Record<Exclude<HomeSectionKey, 'summary'>, HTMLElement | null>>
  >({})
  const [scrolled, setScrolled] = useState(false)
  const [showSectionTabs, setShowSectionTabs] = useState(false)
  const [activeSectionKey, setActiveSectionKey] =
    useState<Exclude<HomeSectionKey, 'summary'> | null>(null)

  /** Compute show/hide for the section tabs based on the first
   *  section's H2 position. Called from `onMainScroll` (per-scroll)
   *  and once after layout (so the pills are correctly hidden at
   *  scroll=0 without waiting for a scroll event). */
  const updateShowSectionTabs = useCallback(() => {
    const containerEl = scrollContainerRef.current
    if (!containerEl) return
    const firstSection = Object.values(sectionRefs.current).find(Boolean)
    const heading = firstSection?.querySelector('h2')
    if (!heading) {
      setShowSectionTabs(false)
      return
    }
    const containerTop = containerEl.getBoundingClientRect().top
    const headingBottom = heading.getBoundingClientRect().bottom
    // Pills surface once the first section's heading has scrolled
    // above the scroll container's top edge.
    setShowSectionTabs(headingBottom < containerTop)
  }, [])

  const onMainScroll = (e: UIEvent<HTMLDivElement>) => {
    setScrolled(e.currentTarget.scrollTop > 0)
    updateShowSectionTabs()
  }

  /** Smooth-scroll the named section to the top of the main scroll
   *  container. Used by the section tab pills as anchor links. */
  const scrollToSection = useCallback(
    (key: Exclude<HomeSectionKey, 'summary'>) => {
      const target = sectionRefs.current[key]
      if (!target) return
      target.scrollIntoView({ behavior: 'smooth', block: 'start' })
    },
    [],
  )

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

  // The selected task (if any) — looked up across every bucket so a
  // deep-linked `?task=<id>` opens the panel regardless of which
  // section the task lives in. Returns the full `HomeTask` so the
  // panel inherits the room name / icon along with the task.
  const selectedHomeTask = useMemo(() => {
    if (!selectedTaskId) return null
    for (const list of [needsInput, active, done]) {
      const found = list.find(h => h.task.id === selectedTaskId)
      if (found) return found
    }
    return null
  }, [selectedTaskId, needsInput, active, done])

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

  // Visible (non-Summary) section keys — derived once for the
  // observers below and again at render time for the pills + section
  // list. Single source of truth = `order` filtered by `isVisible`.
  const visibleTaskSectionKeys = useMemo(
    () =>
      order
        .filter((k): k is Exclude<HomeSectionKey, 'summary'> => k !== 'summary')
        .filter(k => isVisible(k)),
    [order, isVisible],
  )

  // Run the section-tab visibility check once after layout (and on
  // changes that may shift the first section's position) so pills
  // appear correctly without waiting for a manual scroll event.
  useEffect(() => {
    updateShowSectionTabs()
  }, [updateShowSectionTabs, view, visibleTaskSectionKeys])

  // Observe each rendered section — the one currently crossing the
  // top half of the viewport sets itself active. `rootMargin` shifts
  // the observation band so an entry counts as "in view" only when it
  // crosses the upper third of the container.
  useEffect(() => {
    const rootEl = scrollContainerRef.current
    if (!rootEl) return
    const observers: IntersectionObserver[] = []
    for (const key of visibleTaskSectionKeys) {
      const el = sectionRefs.current[key]
      if (!el) continue
      const observer = new IntersectionObserver(
        entries => {
          for (const entry of entries) {
            if (entry.isIntersecting) setActiveSectionKey(key)
          }
        },
        { root: rootEl, rootMargin: '-25% 0px -65% 0px', threshold: 0 },
      )
      observer.observe(el)
      observers.push(observer)
    }
    return () => observers.forEach(o => o.disconnect())
  }, [visibleTaskSectionKeys, view])

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
    window.setTimeout(() => navigate(buildDefaultViewPath(ws.id, defaultView)), 200)
  }
  // Card click + Replies button → dock the task's chat in a side
  // panel on Home (URL becomes `?task=<id>`). The card's own `href`
  // points at the same URL so cmd-click / middle-click opens the
  // panelled view in a new tab.
  const openTask = (h: HomeTask) => {
    setSearchParams(
      prev => {
        const next = new URLSearchParams(prev)
        next.set('task', h.task.id)
        return next
      },
      { replace: false },
    )
  }
  const closeTaskPanel = useCallback(() => {
    setSearchParams(
      prev => {
        const next = new URLSearchParams(prev)
        next.delete('task')
        return next
      },
      { replace: false },
    )
  }, [setSearchParams])

  // Esc closes the docked task chat (parity with TasksPage's panel).
  useEffect(() => {
    if (!selectedHomeTask) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeTaskPanel()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [selectedHomeTask, closeTaskPanel])

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
  const sectionCounts: Record<Exclude<HomeSectionKey, 'summary'>, number> = {
    needsInput: needsInput.length,
    nowHappening: active.length,
    done: done.length,
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

      {/* Top bar row — Home top bar on the left (shrinks when the
          task chat panel docks on the right) + the chat panel's own
          header (avatar stack + close X) on the right when a task is
          selected. Top bar + chat header sit on the same 64 px row so
          the page reads as: `Sidebar | Home area | Chat panel`, each
          column owning its own top chrome. */}
      <div className="relative z-20 flex w-full shrink-0">
      <div className="relative flex flex-1 min-w-0 items-center px-6 py-4 min-h-16">
        <div className="flex flex-1 items-center min-w-0">
          <DeskWordmark className="h-5 w-auto text-foreground" aria-hidden />
          <span className="sr-only">Desk Home</span>
        </div>

        {/* Anchor-tabs slot — absolute, pixel-tracks the content
            column inside main (left edge of column ≈ sidebar-right +
            main-area `px-6` + `mx-auto` from `max-w-4xl`). Mirrors the
            way `TaskTabs` portals into the room TopBar's centred slot
            so Home and Tasks share one chrome rhythm. Hidden on
            mobile (offcanvas sidebar = no room to centre pills next
            to the wordmark + page controls). */}
        {view === 'day' && (
          <div
            className={cn(
              'pointer-events-none absolute inset-y-0 hidden items-center transition-opacity duration-200 md:flex',
              showSectionTabs ? 'opacity-100' : 'opacity-0',
            )}
            style={{ left: 'var(--sidebar-width)', right: 0 }}
            aria-hidden={!showSectionTabs}
          >
            <div className="w-full px-6">
              <div className={cn(COLUMN, 'flex justify-start')}>
                <HomeSectionTabs
                  keys={visibleTaskSectionKeys}
                  counts={sectionCounts}
                  activeKey={activeSectionKey}
                  onSelect={scrollToSection}
                />
              </div>
            </div>
          </div>
        )}
        <div className="flex items-center gap-1">
          {view === 'day' ? (
            <>
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
            </>
          ) : null}
        </div>
      </div>{/* /home top bar */}

      {/* Chat-panel header — sibling of the home top bar. Sits on the
          same 64 px row, holds the room+user avatar stack (centred)
          and the close X. Width is driven by the shared Tasks split
          ratio so dragging the panel resizes header and body
          together. */}
      <AnimatePresence initial={false}>
        {view === 'day' && selectedHomeTask && (
          <motion.div
            key="home-chat-header"
            initial={{ width: 0, opacity: 0 }}
            animate={{ width: chatWidth, opacity: 1 }}
            exit={{ width: 0, opacity: 0 }}
            transition={{ duration: 0.25, ease: [0.4, 0, 0.2, 1] }}
            className="relative shrink-0 flex items-center justify-center min-h-16 px-6 py-4 overflow-hidden"
          >
            <RoomAvatarStack
              workspace={{
                id: selectedHomeTask.workspaceId,
                name: selectedHomeTask.roomName,
                emoji: '',
                // `RoomAvatarStack` runs the colour through
                // `roomColor()` itself, so passing the already-
                // resolved tint here works (it'll snap to the same
                // palette entry).
                bg: selectedHomeTask.roomColor,
                description: '',
                unreadCount: 0,
              }}
            />
            <Button
              variant="ghost"
              size="icon"
              className="absolute right-4 top-1/2 -translate-y-1/2 h-8 w-8 text-muted-foreground hover:text-foreground"
              onClick={closeTaskPanel}
              aria-label="Close task chat"
              data-testid="home-task-chat-close"
            >
              <X className="h-4 w-4" />
            </Button>
          </motion.div>
        )}
      </AnimatePresence>
      </div>{/* /top bar row */}

      {/* Row below the bar: sidebar (left) + main (centre) + chat
          panel (right, when a task is selected). */}
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
                href={dayHref}
                active={view === 'day'}
                badge={needsInput.length || undefined}
              />
              <HomeNavItem
                icon={MessageCircle}
                label="Ask AI"
                href={askAiHref}
                active={view === 'askai'}
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
                        href={buildDefaultViewPath(ws.id, defaultView)}
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
                        // Pre-compute the destination so the row can be a
                        // real Link (middle/cmd-click → new tab) AND so
                        // the animated left-click path navigates to the
                        // exact same URL the browser would have followed.
                        const view_: RouteView = p.kind === 'task' ? 'tasks' : p.kind === 'file' ? 'context' : 'pinned'
                        const q =
                          p.kind === 'chat'
                            ? { chat: p.id }
                            : p.kind === 'task'
                              ? { task: p.id }
                              : p.kind === 'artifact'
                                ? { artifact: p.id }
                                : { item: p.id }
                        const href = p.workspaceId
                          ? buildPath(p.workspaceId, view_, q)
                          : '#'
                        return (
                          <SidebarMenuItem key={`${p.kind}:${p.id}`}>
                            <SidebarMenuButton
                              asChild
                              className={cn(SIDEBAR_ROW_STATE_CLASS, 'pr-9 text-foreground')}
                            >
                              <Link
                                to={href}
                                onClick={(e) => {
                                  if (!p.workspaceId) {
                                    e.preventDefault()
                                    return
                                  }
                                  if (isModifiedClick(e)) return
                                  e.preventDefault()
                                  setLeaving(true)
                                  window.setTimeout(() => navigate(href), 200)
                                }}
                              >
                                <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
                                <span className="flex-1 min-w-0 truncate text-left">{p.label}</span>
                              </Link>
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
            <SidebarMenu className="pb-1">
              <SidebarMenuItem>
                <SidebarMenuButton
                  onClick={() => palette.open()}
                  className={cn(SIDEBAR_ROW_STATE_CLASS, 'text-foreground')}
                >
                  <Search className="h-4 w-4 text-muted-foreground" />
                  <span>Search</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
            <SidebarAccountMenu
              username={me?.username}
              email={me?.email}
              userAvatarUrl={userAvatarUrl}
              onOpenMyAccount={() => setAccountState({ section: 'account', modelsFocus: null })}
              onSignOut={() => void logout()}
            />
          </SidebarFooter>
        </div>
      </Sidebar>

      {view === 'askai' ? (
        // Ask AI view: AskAiView renders the regular ChatView, which
        // brings its own Files/Tasks right panel and top-bar actions —
        // no Home-specific side panel needed.
        <main className="relative z-10 flex min-h-0 flex-1 flex-row overflow-hidden">
          <AskAiView />
        </main>
      ) : (
        // Day view — home scroll content. The docked task-chat panel
        // is mounted as a *sibling* of main (just after `</main>`)
        // so the page reads as `Sidebar | Home main | Chat panel`,
        // each column with its own top chrome (the chat panel's
        // header lives in the top-bar row above).
        <main className="relative z-10 flex min-h-0 flex-1 flex-col overflow-hidden">
          {/* Scroll column. Mirrors the TasksPage mask: bottom always
              fades, top fades only once you've scrolled. `pt-6`
              matches the Tasks page's content inset; combined with
              the 64 px top bar above (hoisted as a sibling above
              this row), the first content row sits 88 px from the
              top of the viewport — same as a room view. */}
          <div
            ref={scrollContainerRef}
            className="flex-1 min-h-0 overflow-y-auto px-6 pt-6 pb-20"
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
            {/* All sections now live inside a single `max-w-4xl`
                column — the horizontal carousel was retired in favour
                of a vertical list with a "Show more" reveal, so we no
                longer need to break out of the content column for the
                task rows. */}
            <div className={COLUMN}>
              <div className="flex flex-col gap-3">
                {digest && (
                  <span className="inline-flex w-fit items-center rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
                    Refreshed {getRelativeTime(new Date(digest.generatedAt))}
                  </span>
                )}
                {/* Greeting — page-level heading (`text-3xl`). */}
                <h1 className="text-3xl font-semibold leading-9 text-foreground">
                  {digest?.greeting ?? '…'}
                </h1>
                {digest?.summary && (
                  <p className="text-base leading-6 text-foreground">{digest.summary}</p>
                )}
              </div>

              {/* Sections live in their own wrapper. The
                  summary-to-sections gap (`mt-10` = 40 px) matches the
                  between-sections gap (`gap-10` = 40 px) so the
                  rhythm reads as one consistent spacing unit. */}
              <div className="mt-10 flex flex-col gap-10">
              {visibleTaskSectionKeys.map(key => (
                <section
                  key={key}
                  ref={el => {
                    sectionRefs.current[key] = el
                  }}
                  className="flex flex-col gap-5"
                >
                  {/* Section heading + outline counter badge. The
                      wrapper sets the 8 px (`gap-2`) spacing between
                      the heading text and the badge; `flex items-center`
                      keeps the badge vertically centred on the cap
                      height of the H2. */}
                  <div className="flex items-center gap-2">
                    <h2 className="text-xl font-semibold leading-7 text-foreground">
                      {HOME_SECTION_LABELS[key]}
                    </h2>
                    <Badge variant="outline" className="tabular-nums">
                      {sectionCounts[key]}
                    </Badge>
                  </div>
                  {sectionRows[key].length === 0 ? (
                    <SectionEmpty
                      icon={SECTION_EMPTY_ICON[key]}
                      text={sectionEmpty[key]}
                      workspaces={workspaces ?? []}
                      onCreateInRoom={createInRoom}
                    />
                  ) : (
                    <HomeTaskList
                      items={sectionRows[key]}
                      authorName={me?.username}
                      authorAvatarUrl={userAvatarUrl}
                      selectedTaskId={selectedTaskId}
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
              </div>{/* /sections wrapper */}
            </div>
          </div>
        </main>
      )}

      {/* Docked task chat — sibling of main, mounts on the right of
          the content row whenever `?task=<id>` is set. The chat
          panel's header (avatar stack + close X) lives in the top
          bar row above; this is the panel body only. Width is
          driven by `chatWidth` so the resize handle below moves
          header + body in lockstep. */}
      {view === 'day' && (
        <AnimatePresence initial={false}>
          {selectedHomeTask && (
            <motion.div
              key="home-task-chat"
              initial={{ width: 0, opacity: 0 }}
              animate={{ width: chatWidth, opacity: 1 }}
              exit={{ width: 0, opacity: 0 }}
              transition={{ duration: 0.25, ease: [0.4, 0, 0.2, 1] }}
              className="relative shrink-0 flex flex-col overflow-hidden"
            >
              <SplitResizeHandle
                isResizing={isChatResizing}
                onMouseDown={onChatResizeStart}
                ariaLabel="Resize Home and task chat panels"
                inset
              />
              <TaskChatPanel task={selectedHomeTask.task} />
            </motion.div>
          )}
        </AnimatePresence>
      )}
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
      <MyAccountModal
        open={accountState !== null}
        onOpenChange={(open) => { if (!open) setAccountState(null) }}
        activeSection={accountState?.section ?? 'account'}
        onChangeSection={(section: AccountSettingsSectionId) =>
          setAccountState({ section, modelsFocus: null })
        }
        modelsFocus={accountState?.modelsFocus ?? null}
        onChangeModelsFocus={(focus: ModelsFocus) =>
          setAccountState({ section: 'models', modelsFocus: focus })
        }
      />
    </SidebarProvider>
  )
}
