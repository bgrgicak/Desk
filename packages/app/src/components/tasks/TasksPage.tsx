import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { UIEvent } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { X, Clock, CheckCircle2, AlertCircle, Loader2 } from 'lucide-react'
import { useDispatch, useSelector } from 'react-redux'
import {
  Button,
  Skeleton,
  Popover,
  PopoverTrigger,
  PopoverContent,
  useIsMobile,
} from '@agent-desk/ui'
import type { Task, TaskOccurrence } from '@/data/ui-types'
import { getRelativeTime } from '@/data/ui-types'
import { TopBarActions, TopBarContentActions, TopBarCenter } from '@/components/layout/TopBar'
import { SplitResizeHandle } from '@/components/shared/SplitResizeHandle'
import { useSplitResize, useContentAreaInsets } from '@/components/shared/splitPane'
import {
  DESKTOP_RIGHT_PANEL_BREAKPOINT,
  isSmallRightPanelViewport,
} from '@/components/shared/rightPanelLayout'
import {
  selectTasksSplitRatio,
  setTasksSplitRatio,
  TASKS_SPLIT_RATIO_STORAGE_KEY_EXPORT,
  PREVIEW_MIN_CHAT_WIDTH,
  PREVIEW_MIN_PANEL_WIDTH,
} from '@/store/slices/previewPanelSlice'
import { TaskComposer, type TaskComposerSubmit } from './TaskComposer'
import { TaskCard } from './TaskCard'
import { TaskChatPanel } from './TaskChatPanel'
import { TaskPanelActionsMenu } from './TaskPanelActionsMenu'
import type { SchedulePickerValue } from './SchedulePicker'
import {
  TaskTabs,
  TaskFilterSearch,
  DEFAULT_TASK_FILTERS,
  type TaskTab,
  type TaskListFilters,
} from './TasksListControls'

// The room nav rail sits left of the content area (below the full-
// width top bar). Match AppShell's `--sidebar-width` so the top-bar
// tab pills line up with the list column's left edge on desktop.
const ROOM_SIDEBAR_WIDTH = '290px'

export interface TasksPageProps {
  tasks: Task[]
  isLoading?: boolean
  /** Best-effort total message counts keyed by backing chat id —
   *  the "N replies" footer button. */
  repliesByChatId?: Record<string, number>
  /** Current user — drives each task card's author avatar/name. */
  authorName?: string
  authorAvatarUrl?: string | null
  /** Selected task id (App-owned, mirrored in `?task=`). Its chat is
   *  docked in the sidebar. */
  selectedTaskId?: string | null
  /** Build the docked-chat URL for a task id. Drives the card-level
   *  `<Link>` so middle-click / cmd-click opens the task in a new tab. */
  hrefForTask: (id: string) => string
  /** Select a task (opens its docked chat) or `null` to close. */
  onSelectTask: (id: string | null) => void
  /** Create a task from the top composer (lands in idle "To do",
   *  or "Scheduled" when an executeAt was set). */
  onCreateTask: (input: TaskComposerSubmit) => void | Promise<void>
  onMarkDone: (task: Task) => void | Promise<void>
  onRunNow: (task: Task) => void | Promise<void>
  onPause: (task: Task) => void | Promise<void>
  onDelete: (task: Task) => void | Promise<void>
  /** Apply (or clear with `null`) a schedule on an existing task. */
  onSchedule: (task: Task, schedule: SchedulePickerValue | null) => void | Promise<void>
}

// Exact mirror of the chat view's conversation column: a responsive
// gutter wrapper (wider when no side panel is docked) around a
// `max-w-4xl` centred inner. Keeping these identical to ChatView's
// CHAT_GUTTER_* / CHAT_COLUMN_CLASS makes the task list + composer
// line up pixel-for-pixel with a chat thread.
const COLUMN = 'w-full max-w-4xl min-w-0 mx-auto'
// Composer is 48 px wider than the list column (still centred),
// matching the chat view's composer.
const COMPOSER_COLUMN = 'w-full max-w-[calc(56rem_+_48px)] min-w-0 mx-auto'
const GUTTER_CLOSED = 'px-4 sm:px-6 md:px-32'
// Chat docked → 24 px left gutter only; the right padding is dropped
// so list content runs flush to the list/chat seam (the resize
// handle moves into the chat pane's own left padding instead).
const GUTTER_OPEN = 'pl-6'

function recentTime(t: Task): number {
  return (t.completedAt ?? t.nextRun ?? t.startedAt).getTime()
}

// Per-tab empty-state copy so each filtered view explains itself
// instead of a generic "no tasks".
const EMPTY_COPY: Record<TaskTab, { title: string; body: string }> = {
  all:         { title: 'No tasks yet',            body: 'Describe what you want to achieve in the composer below to create your first task.' },
  todo:        { title: 'Nothing to do',           body: "Tasks you've created that haven't started yet will appear here." },
  needs_input: { title: 'Nothing needs your input', body: 'When an agent has a question for you, it shows up here.' },
  active:      { title: 'Nothing in progress',      body: 'Tasks an agent is actively working on appear here.' },
  scheduled:   { title: 'Nothing scheduled',        body: 'Give a task a schedule when you create it to see it here.' },
  failed:      { title: 'Nothing failed',           body: "Tasks whose run errored out appear here so you can retry or close them." },
  complete:    { title: 'Nothing done yet',         body: 'Completed tasks are kept here for reference.' },
}

// Loading placeholder — mirrors a TaskCard's silhouette so the list
// doesn't jump when real cards swap in.
function TaskCardSkeleton() {
  return (
    <div className="flex flex-col gap-4 rounded-2xl border border-border bg-background p-6">
      <div className="flex items-start gap-3">
        <Skeleton className="h-10 w-10 shrink-0 rounded-full" />
        <div className="flex flex-col gap-1.5">
          <Skeleton className="h-3.5 w-24" />
          <Skeleton className="h-3 w-16" />
        </div>
        <Skeleton className="ml-auto h-5 w-16 rounded-full" />
      </div>
      <div className="space-y-2">
        <Skeleton className="h-3.5 w-full" />
        <Skeleton className="h-3.5 w-4/5" />
      </div>
      <div className="flex items-center gap-2 border-t border-border pt-4">
        <Skeleton className="h-8 w-24 rounded-md" />
        <Skeleton className="h-8 w-28 rounded-md" />
      </div>
    </div>
  )
}

function OccurrenceStatusIcon({ status }: { status: TaskOccurrence['status'] }) {
  switch (status) {
    case 'active':
      return <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-blue-500" />
    case 'completed':
      return <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-emerald-500" />
    case 'failed':
      return <AlertCircle className="h-3.5 w-3.5 shrink-0 text-red-500" />
    default:
      return <Clock className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
  }
}

/**
 * Clock button + scrollable "recent runs" popover for the chat-panel
 * header. Shown only for scheduled tasks. Mirrors the run-history rows
 * from the (trunk) task-details panel: status icon, date · time, and a
 * relative timestamp; the upcoming/placeholder occurrence is filtered
 * out and runs are newest-first.
 */
function RecentRunsPopover({ task }: { task: Task }) {
  const runs = task.history
    .filter((o) => o.status !== 'scheduled')
    .slice()
    .sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime())

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8 text-muted-foreground hover:text-foreground"
          aria-label="Recent runs"
        >
          <Clock className="h-4 w-4" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72 p-0">
        <div className="border-b px-3 py-2 text-xs font-medium text-muted-foreground">
          Recent runs
        </div>
        {runs.length === 0 ? (
          <p className="px-3 py-3 text-xs text-muted-foreground">No runs yet.</p>
        ) : (
          <div className="max-h-72 overflow-y-auto py-1">
            {runs.map((o) => (
              <div
                key={o.id}
                className="flex items-start gap-2.5 px-3 py-2 transition-colors hover:bg-muted/30"
              >
                <span className="mt-0.5">
                  <OccurrenceStatusIcon status={o.status} />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="text-xs text-foreground">
                    {o.startedAt.toLocaleString(undefined, {
                      weekday: 'short',
                      month: 'short',
                      day: 'numeric',
                      hour: 'numeric',
                      minute: '2-digit',
                    })}
                  </p>
                  {o.statusText && (
                    <p className="mt-0.5 truncate text-xs text-muted-foreground">
                      {o.statusText}
                    </p>
                  )}
                </div>
                <span className="shrink-0 text-xs text-muted-foreground">
                  {getRelativeTime(o.startedAt)}
                </span>
              </div>
            ))}
          </div>
        )}
      </PopoverContent>
    </Popover>
  )
}

// Small-viewport detection — the chat pane becomes a right overlay
// instead of a docked, resizable split (mirror of ContextDetail).
function useIsSmallRightPanelScreen() {
  const [smallScreen, setSmallScreen] = useState(() => isSmallRightPanelViewport())

  useEffect(() => {
    if (typeof window === 'undefined') return

    const query = window.matchMedia(`(max-width: ${DESKTOP_RIGHT_PANEL_BREAKPOINT - 1}px)`)
    const update = () => setSmallScreen(isSmallRightPanelViewport())

    update()
    query.addEventListener('change', update)
    return () => query.removeEventListener('change', update)
  }, [])

  return smallScreen
}

/**
 * Redesigned Tasks view: a bulletin-board list that opens the
 * selected task's chat in a docked sidebar — the *same* two-pane
 * split pattern as the chat view and ContextDetail (resizable on
 * desktop, right overlay on small screens). The list is the growing
 * left pane; the chat is the fixed right pane. Selection lives in the
 * URL (`?task=`) so the shell can slide the nav out and centre the
 * avatar stack over the chat pane, exactly like the Library detail.
 */
export function TasksPage({
  tasks,
  isLoading = false,
  repliesByChatId = {},
  authorName,
  authorAvatarUrl,
  selectedTaskId = null,
  hrefForTask,
  onSelectTask,
  onCreateTask,
  onMarkDone,
  onRunNow,
  onPause,
  onDelete,
  onSchedule,
}: TasksPageProps) {
  // The top fade only kicks in once the list is scrolled — at rest
  // (scrollTop 0) the composer must stay crisp, not faded. The fade
  // then lives at the very top of the scroll area, tucking content
  // softly under the top bar instead of a hard cut-off.
  const [scrolled, setScrolled] = useState(false)
  const onListScroll = (e: UIEvent<HTMLDivElement>) => {
    setScrolled(e.currentTarget.scrollTop > 0)
  }

  const [tab, setTab] = useState<TaskTab>('all')
  const [filters, setFilters] = useState<TaskListFilters>(DEFAULT_TASK_FILTERS)
  const [search, setSearch] = useState('')

  // Stable action dispatcher passed to every memoized TaskCardRow.
  // AppInner re-creates these handlers on every render; without
  // indirection through a ref every visible TaskCard would re-render
  // alongside any AppInner state change (the profile shows 201 such
  // renders across an 85s session). The ref keeps the latest closure
  // values available without changing identity.
  const actionsRef = useRef({
    onSelectTask,
    onMarkDone,
    onRunNow,
    onPause,
    onDelete,
    onSchedule,
  })
  actionsRef.current = {
    onSelectTask,
    onMarkDone,
    onRunNow,
    onPause,
    onDelete,
    onSchedule,
  }
  const cardActions = useMemo<TaskCardActions>(() => ({
    selectTask: (id) => actionsRef.current.onSelectTask(id),
    markDone:   (task) => { void actionsRef.current.onMarkDone(task) },
    runNow:     (task) => { void actionsRef.current.onRunNow(task) },
    pause:      (task) => { void actionsRef.current.onPause(task) },
    delete:     (task) => { void actionsRef.current.onDelete(task) },
    schedule:   (task, next) => { void actionsRef.current.onSchedule(task, next) },
  }), [])

  const allTasks = tasks

  // Per-tab counts shown inline in the tabs. Computed off the full
  // task list (independent of search) so the numbers stay
  // a stable "how many in each state" readout.
  const counts = useMemo<Record<TaskTab, number>>(() => {
    const c: Record<TaskTab, number> = {
      all: 0,
      todo: 0,
      needs_input: 0,
      active: 0,
      scheduled: 0,
      failed: 0,
      complete: 0,
    }
    for (const t of allTasks) {
      c[t.status] = (c[t.status] ?? 0) + 1
      // "All" mirrors the list: done tasks are excluded unless the
      // "Show done" toggle is on.
      if (t.status !== 'complete' || filters.showDone) c.all += 1
    }
    return c
  }, [allTasks, filters.showDone])

  const selectedTask = useMemo(
    () => (selectedTaskId ? allTasks.find(t => t.id === selectedTaskId) ?? null : null),
    [selectedTaskId, allTasks],
  )
  const panelOpen = !!selectedTask
  const isSmallViewport = useIsSmallRightPanelScreen()
  // Mobile (<768px) renders the status tabs inline below the breadcrumb
  // instead of overlaying them on the top bar (where they collide with
  // the breadcrumb at narrow widths).
  const isMobile = useIsMobile()

  // ── Resizable two-pane split (mirror of ContextDetail) ──
  // The list is the growing LEFT pane (its viewport fraction =
  // tasksSplitRatio); the chat panel is the fixed right pane. Only a
  // docked desktop panel resizes — closed → the list is full-width
  // (no handle); small screens → the panel is a full-screen overlay.
  const dispatch = useDispatch()
  const splitRatio = useSelector(selectTasksSplitRatio)
  const listWidth = `${Math.round(splitRatio * 100)}vw`
  const chatWidth = `${Math.round((1 - splitRatio) * 100)}vw`
  const { isResizing, onMouseDown: onResizeStart } = useSplitResize({
    getStartRatio: () => splitRatio,
    onRatio: (r) => dispatch(setTasksSplitRatio(r)),
    onCommit: (r) => {
      try {
        window.localStorage.setItem(
          TASKS_SPLIT_RATIO_STORAGE_KEY_EXPORT,
          String(r),
        )
      } catch {
        // localStorage unavailable — ratio still applies this session.
      }
    },
    minLeftPx: PREVIEW_MIN_PANEL_WIDTH,
    minRightPx: PREVIEW_MIN_CHAT_WIDTH,
  })
  // Keep the global avatar overlay centred over the chat pane. Pass
  // the eventual left inset (= list width) even while the chat is
  // closed, so opening it only fades + slides the stack in place — it
  // never travels horizontally across the viewport.
  useContentAreaInsets(listWidth, '0px', { hidden: !panelOpen })

  // Geometry shared by the list column, the bottom composer and the
  // top-bar tab pills so all three stay pixel-aligned. The list
  // column lives right of the room nav rail and yields `chatWidth` on
  // the right while the chat is docked (desktop only); the tab-pill
  // overlay tracks that same box.
  const dockedChat = panelOpen && !isSmallViewport
  // Narrower gutter once a chat is docked — same swap the chat view
  // makes when its preview/panel opens.
  const gutter = `${dockedChat ? GUTTER_OPEN : GUTTER_CLOSED} transition-[padding] duration-300`
  const tabsLeftInset = isSmallViewport ? '0px' : ROOM_SIDEBAR_WIDTH
  const tabsRightInset = dockedChat ? chatWidth : '0px'

  // Align the list-controls TopBar slot to the list pane's right edge
  // (the list/chat seam while docked, the 24 px gutter otherwise) —
  // exactly how ContextDetail positions its file controls, keeping
  // list actions separate from the chat-pane collapse X.
  useEffect(() => {
    const root = document.documentElement
    root.style.setProperty(
      '--topbar-content-actions-right',
      dockedChat ? chatWidth : '1.5rem',
    )
    return () => {
      root.style.removeProperty('--topbar-content-actions-right')
    }
  }, [dockedChat, chatWidth])

  // Esc closes the docked chat (parity with the collapse X).
  useEffect(() => {
    if (!panelOpen) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onSelectTask(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [panelOpen, onSelectTask])

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase()
    const list = allTasks.filter(t => {
      if (tab !== 'all' && t.status !== tab) return false
      // Hide done unless the Done tab or the "show done" toggle.
      if (
        t.status === 'complete' &&
        tab !== 'complete' &&
        !filters.showDone
      ) {
        return false
      }
      if (q && !t.name.toLowerCase().includes(q)) return false
      return true
    })
    list.sort((a, b) =>
      filters.sort === 'newest'
        ? b.startedAt.getTime() - a.startedAt.getTime()
        : recentTime(b) - recentTime(a),
    )
    return list
  }, [allTasks, tab, filters, search])

  return (
    <div className="relative flex flex-1 min-h-0 overflow-hidden">
      {/* List column — always `flex-1`. The chat pane animates its own
          width (below), so this column simply yields space as the chat
          grows / reclaims it as the chat shrinks — one smooth flex
          transition, no competing width animation here. */}
      <div className="flex flex-1 flex-col min-w-0 overflow-hidden">
        {/* List controls — the filter (funnel) + search toggles.
            These belong to the *list* pane, so they render in the
            content-actions slot pinned to the list/chat seam (or the
            24 px gutter when no chat is docked), separate from the
            chat-pane collapse X — mirroring ContextDetail.
            Skipped on mobile when the chat overlay is open: the list
            is fully covered by the overlay, and both slots resolve to
            `right-6` at that breakpoint (no resizable split to push
            list controls leftward), so the filter/search and the
            chat-close X would otherwise stack on top of each other. */}
        {!(panelOpen && isSmallViewport) && (
          <TopBarContentActions>
            <TaskFilterSearch
              filters={filters}
              onFiltersChange={setFilters}
              search={search}
              onSearchChange={setSearch}
            />
          </TopBarContentActions>
        )}

        {/* Status-tab pills — hoisted into the global top bar (same
            row as the breadcrumb) on desktop. The wrapper pixel-tracks
            the list column box ([room rail, viewport − chat pane]) so
            the pills sit exactly over the list, even as the split is
            dragged.
            On mobile (<768px) the breadcrumb already fills the bar so
            we render the pills inline below it (see "Inline mobile tab
            strip" below) instead. */}
        {!isMobile && (
          <TopBarCenter>
            <div
              className="pointer-events-none absolute inset-y-0 flex items-center"
              style={{ left: tabsLeftInset, right: tabsRightInset }}
            >
              <div className={`w-full ${gutter}`}>
                <div className={`${COLUMN} pointer-events-auto`}>
                  <TaskTabs tab={tab} onTabChange={setTab} counts={counts} />
                </div>
              </div>
            </div>
          </TopBarCenter>
        )}

        {/* Inline mobile tab strip — sits directly under the top bar,
            scrolls horizontally if the labels overflow the 375 px
            viewport. The chip pill backgrounds + horizontal padding
            keep adjacent label/count pairs visually separated when the
            strip overflows. */}
        {isMobile && (
          <div className="shrink-0 border-b border-border/40 px-3 py-2">
            <TaskTabs tab={tab} onTabChange={setTab} counts={counts} />
          </div>
        )}

        {/* The list. Always fades into the bottom edge; the top edge
            only fades once scrolled, tucking scrolled content under
            the top bar. */}
        <div
          className="flex-1 min-h-0 overflow-y-auto"
          onScroll={onListScroll}
          style={{
            // Bottom fade kept short (16 px) so the last card's
            // action buttons stay readable instead of fading to
            // sub-WCAG contrast against the composer below — the
            // previous 64 px tail bled the Replies/Mark-as-done/More
            // icons into the composer card on iPhone-SE-class
            // viewports.
            maskImage: scrolled
              ? 'linear-gradient(to bottom, transparent 0, #000 64px, #000 calc(100% - 16px), transparent 100%)'
              : 'linear-gradient(to bottom, #000 0, #000 calc(100% - 16px), transparent 100%)',
            WebkitMaskImage: scrolled
              ? 'linear-gradient(to bottom, transparent 0, #000 64px, #000 calc(100% - 16px), transparent 100%)'
              : 'linear-gradient(to bottom, #000 0, #000 calc(100% - 16px), transparent 100%)',
          }}
        >
          {/* Chat-view column geometry: responsive gutter → centred
              `max-w-4xl` inner, so the list lines up with a chat
              thread. `pb-32` is intentionally generous: the bottom
              composer is in-flow, but cards near the foot of the
              scroll viewport still need slack so their action row
              isn't crowded against the composer's top edge. */}
          <div className={`${gutter} pb-32 pt-6`}>
          <div className={`${COLUMN} flex flex-col`}>
            {/* List (tabs are in the top bar; filter/search far-right
                in the top bar — nothing else above the cards). */}
            {isLoading ? (
              <div className="flex flex-col gap-3">
                {Array.from({ length: 4 }).map((_, i) => (
                  <TaskCardSkeleton key={i} />
                ))}
              </div>
            ) : visible.length === 0 ? (
              <div className="flex flex-col items-center justify-center gap-1 rounded-xl border border-dashed border-border p-8 text-center">
                <p className="text-sm font-medium text-foreground">
                  {search.trim() ? 'No tasks match' : EMPTY_COPY[tab].title}
                </p>
                <p className="text-sm text-muted-foreground">
                  {search.trim() ? 'Try a different search.' : EMPTY_COPY[tab].body}
                </p>
              </div>
            ) : (
              <div>
                <h3 className="mb-6 text-xl font-semibold leading-6 text-foreground">
                  {visible.length} {visible.length === 1 ? 'task' : 'tasks'}
                </h3>
                <div className="flex flex-col gap-3">
                {visible.map(task => (
                  <TaskCardRow
                    key={task.id}
                    task={task}
                    authorName={authorName}
                    authorAvatarUrl={authorAvatarUrl}
                    repliesCount={task.chatId ? repliesByChatId[task.chatId] ?? 0 : 0}
                    isActive={selectedTaskId === task.id}
                    href={hrefForTask(task.id)}
                    actions={cardActions}
                  />
                ))}
                </div>
              </div>
            )}
          </div>
          </div>
        </div>

        {/* Bottom composer — fixed to the foot of the list column,
            same as the chat view's composer. It slides down out of
            view (and unmounts; its draft is persisted by `draftKey`)
            when a task's chat is docked, so the chat becomes the sole
            focus. */}
        <AnimatePresence initial={false}>
          {!panelOpen && (
            <motion.div
              key="task-composer"
              initial={{ y: '100%', opacity: 0 }}
              // Re-entry waits for the chat pane to finish collapsing
              // (list back to full width) so it rises straight *up*,
              // not from the bottom-left as the column re-widens —
              // the mirror of the open-side delay on the chat pane.
              animate={{
                y: 0,
                opacity: 1,
                transition: { duration: 0.25, ease: [0.4, 0, 0.2, 1], delay: 0.2 },
              }}
              exit={{
                y: '100%',
                opacity: 0,
                transition: { duration: 0.25, ease: [0.4, 0, 0.2, 1] },
              }}
              className="shrink-0 overflow-hidden"
            >
              <div className={`${gutter} pt-2 pb-6`}>
                <div className={COMPOSER_COLUMN}>
                  <TaskComposer onSubmit={onCreateTask} />
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* Right pane — the docked task chat (mirror of the chat-view
          preview split). One element that animates as a single piece:
          desktop docks and animates its `width` 0↔chatWidth (the list
          column yields via flex); small screens slide in as a right
          overlay. The grab bar sits on the left seam, outside the
          overflow-hidden inner so its hit area isn't clipped. */}
      <AnimatePresence initial={false}>
        {panelOpen && selectedTask && (isSmallViewport ? (
          <motion.div
            key="task-chat-overlay"
            initial={{ opacity: 0, x: '100%' }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: '100%' }}
            transition={{ duration: 0.25, ease: [0.4, 0, 0.2, 1] }}
            // Full-width overlay on small viewports (was capped at
            // 320 px, which left ~55 px of the list peeking through on
            // a 375 px phone with no close affordance on the visible
            // strip). At the iPhone-SE width this fully replaces the
            // list; on tablets the panel still respects the
            // `<768 px` breakpoint above which it docks as a
            // resizable split.
            className="absolute inset-0 z-40 flex flex-col bg-background shadow-xl"
          >
            <TaskChatPanel task={selectedTask} />
          </motion.div>
        ) : (
          <motion.div
            key="task-chat"
            initial={{ width: 0 }}
            // Hold the width (and therefore the list reflow) for a
            // beat on open so the bottom composer can finish sliding
            // straight *down* before the column narrows — otherwise it
            // appears to drift down-and-left as it exits.
            animate={{
              width: chatWidth,
              transition: { duration: 0.25, ease: [0.4, 0, 0.2, 1], delay: 0.18 },
            }}
            exit={{
              width: 0,
              transition: { duration: 0.25, ease: [0.4, 0, 0.2, 1] },
            }}
            className="relative shrink-0 flex flex-col bg-transparent"
          >
            <SplitResizeHandle
              isResizing={isResizing}
              onMouseDown={onResizeStart}
              ariaLabel="Resize task list and chat panels"
              // List has no right padding while docked — keep the
              // handle inside the chat pane's left padding so it
              // doesn't overlap the list content.
              inset
            />
            <div className="flex flex-1 min-h-0 min-w-0 overflow-hidden">
              <TaskChatPanel task={selectedTask} />
            </div>
          </motion.div>
        ))}
      </AnimatePresence>

      {/* The chat panel's own control: the collapse X, in the
          far-right actions slot over the chat pane. Kept with the
          chat-panel container and separate from the list controls
          (filter/search) above — same split as ContextDetail. */}
      {panelOpen && selectedTask && (
        <TopBarActions>
          {selectedTask.status === 'scheduled' && (
            <RecentRunsPopover task={selectedTask} />
          )}
          <TaskPanelActionsMenu
            task={selectedTask}
            onMarkDone={() => void onMarkDone(selectedTask)}
            onRunNow={
              selectedTask.status === 'scheduled' ||
              selectedTask.status === 'todo' ||
              selectedTask.status === 'complete' ||
              selectedTask.status === 'failed'
                ? () => void onRunNow(selectedTask)
                : undefined
            }
            onPause={
              (selectedTask.status === 'active' || selectedTask.status === 'scheduled') &&
              selectedTask.messageState !== 'paused'
                ? () => void onPause(selectedTask)
                : undefined
            }
            onSchedule={(next) => void onSchedule(selectedTask, next)}
            onDelete={() => void onDelete(selectedTask)}
          />
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8 text-muted-foreground hover:text-foreground"
            onClick={() => onSelectTask(null)}
            aria-label="Close chat"
          >
            <X className="h-4 w-4" />
          </Button>
        </TopBarActions>
      )}
    </div>
  )
}

// Stable action dispatcher passed into every row. Constructed once in
// TasksPage and proxied through a ref so AppInner's per-render closures
// don't break TaskCardRow's memo.
interface TaskCardActions {
  selectTask: (id: string) => void
  markDone:   (task: Task) => void
  runNow:     (task: Task) => void
  pause:      (task: Task) => void
  delete:     (task: Task) => void
  schedule:   (task: Task, next: SchedulePickerValue | null) => void
}

interface TaskCardRowProps {
  task: Task
  authorName?: string
  authorAvatarUrl?: string | null
  repliesCount: number
  isActive: boolean
  href: string
  actions: TaskCardActions
}

const TaskCardRow = memo(function TaskCardRow({
  task,
  authorName,
  authorAvatarUrl,
  repliesCount,
  isActive,
  href,
  actions,
}: TaskCardRowProps) {
  // Stable per-row closures: bound to `task` (the only thing that
  // changes here) and the stable `actions` dispatcher. Row-level
  // useCallback is sound because each row is its own keyed instance.
  const onSelect   = useCallback(() => actions.selectTask(task.id), [actions, task.id])
  const onMarkDone = useCallback(() => actions.markDone(task),       [actions, task])
  const onSchedule = useCallback((next: SchedulePickerValue | null) => actions.schedule(task, next), [actions, task])
  const onDelete   = useCallback(() => actions.delete(task),         [actions, task])
  // Run/Pause visibility tracks status — keep the prop-level "menu item
  // hidden" affordance by returning undefined when not applicable.
  // Run now is for activating a task that isn't already running, so it
  // doesn't apply to status === 'active'. On 'complete' / 'failed' it
  // re-runs the task and moves it back out of its terminal column (see
  // useTaskActions.onRunNow, which resets the parent state first).
  const onRunNow =
    task.status === 'scheduled' ||
    task.status === 'todo' ||
    task.status === 'complete' ||
    task.status === 'failed'
      ? () => actions.runNow(task)
      : undefined
  const onPause = (task.status === 'active' || task.status === 'scheduled') &&
    task.messageState !== 'paused'
      ? () => actions.pause(task)
      : undefined
  return (
    <TaskCard
      task={task}
      authorName={authorName}
      authorAvatarUrl={authorAvatarUrl}
      repliesCount={repliesCount}
      isActive={isActive}
      href={href}
      onSelect={onSelect}
      onMarkDone={onMarkDone}
      onRunNow={onRunNow}
      onPause={onPause}
      onSchedule={onSchedule}
      onDelete={onDelete}
    />
  )
})
