import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom'
import { AnimatePresence, motion } from 'framer-motion'
import { FileText, MessageSquare } from 'lucide-react'
import {
  SidebarInset,
  SidebarProvider,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
  useIsMobile,
} from '@roomy-ai/ui'
import { BackgroundBlobs } from '@/components/layout/BackgroundBlobs'
import { TopBar } from '@/components/layout/TopBar'
import { RoomSidebar, type PinnedSidebarEntry } from '@/components/layout/RoomSidebar'
import { RoomAvatarStack } from '@/components/layout/RoomAvatarStack'
import { SplitResizeHandle } from '@/components/shared/SplitResizeHandle'
import { useSplitResize } from '@/components/shared/splitPane'
import type { WorkspaceInfo } from '@/components/layout/WorkspaceBar'
import { SettingsModal } from '@/components/settings/SettingsModal'
import { MyAccountModal } from '@/components/account/MyAccountModal'
import type { Chat, Artifact } from '@/data/ui-types'
import { useChatHierarchy } from '@/store/selectors/threads'
import { getArtifactIcon } from '@/data/ui-types'
import { DRAG_TYPE_PINNED_ITEM } from '@/components/library/LibraryCard'
import {
  useGetMeQuery,
  useGetWorkspacesQuery,
  usePatchWorkspaceMutation,
  useDeleteWorkspaceMutation,
  useSearchQuery,
} from '@/store/api'
import { useAvatarUrl } from '@/hooks/use-avatar'
import { toWorkspaceInfo } from '@/store/selectors/workspaces'
import { useAppDispatch, useAppSelector } from '@/store/hooks'
import {
  setPendingSettingsSection,
  setPendingMyAccountOpen,
} from '@/store/slices/uiSlice'
import {
  PREVIEW_MIN_CHAT_WIDTH,
  PREVIEW_MIN_PANEL_WIDTH,
  PREVIEW_SPLIT_RATIO_STORAGE_KEY,
  selectIsPreviewOpen,
  selectPreviewSplitRatio,
  setSplitRatio,
} from '@/store/slices/previewPanelSlice'
import { PreviewPanel } from '@/components/chats/PreviewPanel'
import {
  buildPath,
  encodeAccountSettings,
  encodeWorkspaceSettings,
  mergeSearch,
  parseAccountSettings,
  parseWorkspaceSettings,
  type AccountSettingsSectionId,
  type AccountSettingsState,
  type ConnectionsFocus,
  type ModelsFocus,
  type RouteView,
  type WorkspaceSettingsSectionId,
  type WorkspaceSettingsState,
} from '@/router/nav'
import type { TopBarCrumb } from '@/components/layout/TopBar'

export type View = 'pinned' | 'tasks' | 'chats' | 'context' | 'compose'

// Below this width the preview panel switches from a docked flex
// sibling to a full-screen overlay (same threshold as the chat right
// panel). 1024 px is the standard "tablet → desktop" breakpoint.
const PREVIEW_DESKTOP_BREAKPOINT_PX = 1024

function useIsSmallViewport(): boolean {
  const query = `(max-width: ${PREVIEW_DESKTOP_BREAKPOINT_PX - 1}px)`
  const [small, setSmall] = useState(() =>
    typeof window !== 'undefined' && window.matchMedia(query).matches,
  )
  useEffect(() => {
    if (typeof window === 'undefined') return
    const mq = window.matchMedia(query)
    const onChange = () => setSmall(mq.matches)
    onChange()
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [query])
  return small
}

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

// Breadcrumb labels for views that should render a `/ {label}` trailing
// crumb after the workspace name. Only Library (`context`) gets one;
// other routes show just `home / workspace` (section conveyed by the
// sidebar's active state). When a Library file is open, its (truncated)
// name is appended as a further crumb — see `buildTrailingCrumbs`.
const VIEW_LABELS: Partial<Record<RouteView, string>> = {
  context: 'Library',
  tasks: 'Tasks',
}

/** Truncate a file name to 40 chars *excluding* its extension, so
 *  `my-really-long-report-name….pdf` keeps the extension legible.
 *  Names with no extension are simply capped at 40 chars. */
function truncateFileName(name: string, max = 40): string {
  const dot = name.lastIndexOf('.')
  const hasExt = dot > 0 && dot < name.length - 1
  const base = hasExt ? name.slice(0, dot) : name
  const ext = hasExt ? name.slice(dot) : ''
  return base.length > max ? `${base.slice(0, max)}…${ext}` : `${base}${ext}`
}

/**
 * The room sidebar's outer slot. Lives inside `<SidebarProvider>` so it
 * can read mobile state and the toggle's open/closed state.
 *
 * Desktop (≥768px): the slot animates its width 0 ↔ 290 px, slotting the
 * per-room sidebar into the layout as a docked flex sibling. The chat
 * column reflows to fill the remaining width.
 *
 * Mobile (<768px): the slot collapses to 0 px so the chat column gets
 * the full viewport. The sidebar's inner `<Sidebar>` (shadcn primitive)
 * is `position: absolute` + `data-collapsible=offcanvas`, so it slides
 * in from the left only when the user taps the top-bar hamburger. The
 * primitive renders its own backdrop scrim — see
 * `packages/ui/src/components/sidebar.tsx`.
 */
function RoomSidebarSlot({
  show,
  children,
}: {
  show: boolean
  children: ReactNode
}) {
  const isMobile = useIsMobile()
  return (
    <AnimatePresence initial={false}>
      {show && (
        <motion.div
          key="room-sidebar"
          initial={{ width: 0, opacity: 0, x: -24 }}
          animate={{
            width: isMobile ? 0 : 290,
            opacity: 1,
            x: 0,
          }}
          exit={{ width: 0, opacity: 0, x: -24 }}
          transition={{ duration: 0.25, ease: [0.4, 0, 0.2, 1] }}
          // Full-height flex container: the shadcn Sidebar inside
          // relies on `md:self-stretch` + an inner `flex-1` scroll
          // area, which collapse to 0 height without a flex/height
          // context. `relative` so the absolute-positioned mobile
          // drawer anchors here.
          className="relative flex h-full min-h-0 shrink-0"
        >
          {children}
        </motion.div>
      )}
    </AnimatePresence>
  )
}

interface AppShellProps {
  children: ReactNode
  activeView: RouteView
  chats: Chat[]
  isChatsLoading?: boolean
  artifacts: Artifact[]
  selectedChatId?: string | null
  onChatClick: (chat: Chat) => void
  onDeleteChat: (chatId: string) => void

  isDetailOpen?: boolean
  onArtifactClick?: (artifact: Artifact) => void
  // ── Active room ──
  activeWorkspaceId: string
  onSelectWorkspace: (id: string) => void
  getWorkspaceHref?: (id: string) => string
  onSignOut?: () => void
  pinnedEntries?: PinnedSidebarEntry[]
  isPinnedLoading?: boolean
  onPinItem?: (path: string) => void
  onPinChat?: (chatId: string) => void
  onUnpinEntry?: (entry: PinnedSidebarEntry) => void
  selectedItemId?: string | null
  /** Display name of the Library file currently open (when
   *  `activeView === 'context'` and a file detail is showing). Used
   *  to append a `/ {file}` crumb after `/ Library`. */
  libraryFileName?: string | null
}

export function AppShell({
  children,
  activeView,
  chats,
  isChatsLoading = false,
  artifacts,
  selectedChatId,
  onChatClick,
  onDeleteChat,

  isDetailOpen = false,
  onArtifactClick,
  activeWorkspaceId,
  onSelectWorkspace,
  onSignOut,
  pinnedEntries = [],
  isPinnedLoading = false,
  onPinItem,
  onPinChat,
  onUnpinEntry,
  selectedItemId,
  libraryFileName,
}: AppShellProps) {
  // Chat search command palette (global keyboard-shortcut surface).
  const [chatSearchOpen, setChatSearchOpen] = useState(false)
  const [chatSearchQuery, setChatSearchQuery] = useState('')
  const [chatSearchValue, setChatSearchValue] = useState('')
  const searchEnabled = chatSearchQuery.trim().length >= 2
  const { data: searchResults } = useSearchQuery(
    { q: chatSearchQuery.trim(), scope: 'all', workspaceId: activeWorkspaceId },
    { skip: !searchEnabled },
  )

  // Drag-onto-inset to unpin a pinned item — separate from the sidebar drop
  // zone which handles library → pinned. This one handles pinned → unpin.
  const [isInsetDropOver, setIsInsetDropOver] = useState(false)
  const insetDropCounter = useRef(0)

  // Settings modal state lives in the URL query string so reloads
  // preserve the open section + focus, and the global palette can deep-
  // link by pushing `?settings=…` / `?account=…` instead of touching
  // component state.
  const navigate = useNavigate()
  const location = useLocation()
  const [searchParams] = useSearchParams()
  const settingsState = parseWorkspaceSettings(searchParams.get('settings'))
  const accountState = parseAccountSettings(searchParams.get('account'))
  const settingsOpen = settingsState !== null
  const accountOpen = accountState !== null

  // Stable callback that patches the current URL's query string. Used
  // for every settings/account state transition so back/forward works
  // and reload restores the open page.
  const replaceQuery = useCallback(
    (patch: Record<string, string | null>, replace = false) => {
      const next = `${location.pathname}${mergeSearch(location.search, patch)}${location.hash}`
      navigate(next, { replace })
    },
    [navigate, location.pathname, location.search, location.hash],
  )

  const setWorkspaceSettings = useCallback(
    (state: WorkspaceSettingsState | null) => {
      replaceQuery({ settings: state ? encodeWorkspaceSettings(state) : null })
    },
    [replaceQuery],
  )
  const setAccountSettings = useCallback(
    (state: AccountSettingsState | null) => {
      replaceQuery({ account: state ? encodeAccountSettings(state) : null })
    },
    [replaceQuery],
  )

  // Bridge: the redux `pendingSettingsSection` / `pendingMyAccountOpen`
  // actions still exist for callers that don't have easy access to
  // `navigate` (e.g. the global palette wires them through dispatch).
  // Translate them into URL pushes and clear immediately.
  const appDispatch = useAppDispatch()
  const pendingSettingsSection = useAppSelector(s => s.ui.pendingSettingsSection)
  useEffect(() => {
    if (!pendingSettingsSection) return
    if (
      pendingSettingsSection === 'workspace'
      || pendingSettingsSection === 'connections'
    ) {
      setWorkspaceSettings({
        section: pendingSettingsSection,
        connectionsFocus: null,
      })
    } else if (pendingSettingsSection === 'preferences') {
      // Ambiguous between workspace + account. Match the historical
      // global-palette mapping (Customize → workspace preferences).
      setWorkspaceSettings({ section: 'preferences', connectionsFocus: null })
    } else {
      setAccountSettings({
        section: pendingSettingsSection as AccountSettingsSectionId,
        modelsFocus: null,
      })
    }
    appDispatch(setPendingSettingsSection(null))
  }, [pendingSettingsSection, appDispatch, setWorkspaceSettings, setAccountSettings])

  const pendingMyAccountOpen = useAppSelector(s => s.ui.pendingMyAccountOpen)
  useEffect(() => {
    if (!pendingMyAccountOpen) return
    setAccountSettings({ section: 'account', modelsFocus: null })
    appDispatch(setPendingMyAccountOpen(false))
  }, [pendingMyAccountOpen, appDispatch, setAccountSettings])

  const handleInsetDragEnter = (e: React.DragEvent) => {
    if (!e.dataTransfer.types.includes(DRAG_TYPE_PINNED_ITEM)) return
    e.preventDefault()
    insetDropCounter.current += 1
    setIsInsetDropOver(true)
  }
  const handleInsetDragOver = (e: React.DragEvent) => {
    if (!e.dataTransfer.types.includes(DRAG_TYPE_PINNED_ITEM)) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
  }
  const handleInsetDragLeave = () => {
    insetDropCounter.current = Math.max(0, insetDropCounter.current - 1)
    if (insetDropCounter.current === 0) setIsInsetDropOver(false)
  }
  const handleInsetDrop = (e: React.DragEvent) => {
    e.preventDefault()
    insetDropCounter.current = 0
    setIsInsetDropOver(false)
    const entryId = e.dataTransfer.getData(DRAG_TYPE_PINNED_ITEM)
    const entry = pinnedEntries.find(e => e.id === entryId)
    if (entry) onUnpinEntry?.(entry)
  }

  const { data: serverWorkspaces } = useGetWorkspacesQuery()
  const [patchWorkspaceMutation] = usePatchWorkspaceMutation()
  const [deleteWorkspaceMutation] = useDeleteWorkspaceMutation()

  // Current user — drives the bottom profile row in the sidebar
  // (avatar + "Hello, {username}"). Cache is warm because App.tsx
  // already fetches /me at boot, so this is a no-op read here.
  const { data: me } = useGetMeQuery()
  const userAvatarUrl = useAvatarUrl(me?.id)
  const workspaces: WorkspaceInfo[] = (serverWorkspaces ?? []).filter(w => w.kind !== 'hub').map(toWorkspaceInfo)
  const displayWorkspaces = workspaces.length > 0 ? workspaces : [LOADING_WORKSPACE]
  const activeWorkspace =
    displayWorkspaces.find(w => w.id === activeWorkspaceId) ?? displayWorkspaces[0]

  // Trailing breadcrumb crumbs after the workspace name. Library gets
  // `/ Library`, then one crumb per folder segment when the user is
  // inside a folder (`?folder=`) or viewing a file (`?item=` whose
  // parent path provides the segments), and finally the truncated
  // file name as the leaf when a file is open. Other routes get
  // nothing (workspace-only breadcrumb).
  const chatHierarchy = useChatHierarchy(chats, activeWorkspaceId)
  const trailingCrumbs: TopBarCrumb[] = (() => {
    // A chat can be opened from the Library list without the route's
    // `view` segment changing (chat nav only sets `?chat=`), so
    // `activeView` can still be `context` while a chat is actually
    // on screen. Show the chat's own title as the trailing crumb
    // (truncated to 24 chars) instead of the Library/file crumbs.
    if (selectedChatId) {
      const chatTitle = chats.find(c => c.id === selectedChatId)?.title?.trim()
      if (!chatTitle) return []
      const crumbs: TopBarCrumb[] = []
      // When the open chat is a thread, insert the parent chat's title
      // as an intermediate (clickable) crumb so the user can navigate
      // back to it. `useChatHierarchy` resolves this from server-
      // populated `parentChatId` once that lands, and from the existing
      // `message.threadChatId` back-ref until then — see
      // `packages/server/docs/plans/threads-nesting.md`.
      const parent = chatHierarchy.parentOf(selectedChatId)
      if (parent) {
        const parentTitle = parent.title.trim()
        crumbs.push({
          label: parentTitle.length > 24 ? `${parentTitle.slice(0, 24)}…` : parentTitle,
          to: activeWorkspaceId ? buildPath(activeWorkspaceId, activeView, { chat: parent.id }) : undefined,
        })
      }
      crumbs.push({
        label: chatTitle.length > 24 ? `${chatTitle.slice(0, 24)}…` : chatTitle,
      })
      return crumbs
    }
    // Library detail opened on a chat-scoped file (e.g. a file's "Open"
    // action or the preview panel's title link). These live under
    // `.chats/{chatId}/…`, which isn't a real Library location — showing
    // that raw path would leak an internal directory. Trace the file to
    // its chat instead: Home / Room / {chat title} / {filename}.
    if (activeView === 'context' && isDetailOpen) {
      const itemPath = searchParams.get('item') ?? ''
      const chatScopedMatch = /^\.chats\/([^/]+)\//.exec(itemPath)
      if (chatScopedMatch) {
        const chatId = chatScopedMatch[1]
        const crumbs: TopBarCrumb[] = []
        const chatTitle = chats.find(c => c.id === chatId)?.title?.trim()
        if (chatTitle) {
          crumbs.push({
            label: chatTitle.length > 24 ? `${chatTitle.slice(0, 24)}…` : chatTitle,
            to: activeWorkspaceId ? buildPath(activeWorkspaceId, activeView, { chat: chatId }) : undefined,
          })
        }
        const leafName = libraryFileName ?? itemPath.split('/').filter(Boolean).pop() ?? itemPath
        crumbs.push({ label: truncateFileName(leafName) })
        return crumbs
      }
    }
    const sectionLabel = VIEW_LABELS[activeView]
    if (!sectionLabel) return []
    const crumbs: TopBarCrumb[] = [
      {
        label: sectionLabel,
        to: activeWorkspaceId ? buildPath(activeWorkspaceId, activeView) : undefined,
      },
    ]
    if (activeView === 'context') {
      // Folder context: when a file is open, derive it from the
      // item's path (parent of `?item=`); otherwise read `?folder=`
      // directly. Both are workspace-relative paths.
      const itemPath = searchParams.get('item')
      const folderParam = searchParams.get('folder')
      const folderPath = itemPath
        ? (itemPath.includes('/') ? itemPath.slice(0, itemPath.lastIndexOf('/')) : '')
        : (folderParam ?? '')
      const segments = folderPath.split('/').filter(Boolean)
      segments.forEach((name, i) => {
        const cumPath = segments.slice(0, i + 1).join('/')
        crumbs.push({
          label: name,
          to: activeWorkspaceId
            ? buildPath(activeWorkspaceId, 'context', { folder: cumPath })
            : undefined,
        })
      })
      if (isDetailOpen && libraryFileName) {
        crumbs.push({ label: truncateFileName(libraryFileName) })
      }
    }
    return crumbs
  })()

  // When the preview panel is open the chat surface enters a focused
  // mode: the per-room sidebar collapses, the top-bar breadcrumb +
  // actions hide, and the PreviewPanel mounts as a flex sibling of
  // the SidebarProvider so it spans full viewport height (side-by-
  // side with — not under — the chat column's top bar).
  const isPreviewOpen = useAppSelector(selectIsPreviewOpen)
  const previewSplitRatio = useAppSelector(selectPreviewSplitRatio)
  const previewPanelWidth = `${Math.round((1 - previewSplitRatio) * 100)}vw`

  // The per-room sidebar shows on the Library list, Tasks, and the
  // chat list. On desktop it collapses in the two focused two-pane
  // modes:
  //  - chat with the preview open (chat | preview), and
  //  - a Library file open (file | chat) — ContextDetail, which the
  //    Figma shows with no nav rail.
  // Mobile has no docked sidebar — it lives as an off-canvas overlay
  // summoned by the TopBar SidebarTrigger — so the sidebar (and its
  // trigger) must stay mounted there regardless of view, or the user
  // has no menu button to navigate elsewhere from a library item.
  // Tasks keeps the nav rail visible at all times (it's a list view,
  // not a focused two-pane detail like ContextDetail) — only the
  // small-viewport gating below collapses it on narrow screens.
  const isLibraryDetail = activeView === 'context' && isDetailOpen
  const isMobile = useIsMobile()
  const showSidebar = isMobile || (!isPreviewOpen && !isLibraryDetail)

  // Reactive small-viewport flag (matches the desktop / sidebar
  // breakpoint used elsewhere). Below this width the preview panel
  // becomes a full-screen overlay instead of a flex sibling.
  const isSmallViewport = useIsSmallViewport()

  // Drag-to-resize the preview panel. The chat column is the growing
  // left pane (ratio = its viewport fraction); the preview is the
  // fixed right pane. Shared with the Library file-detail split via
  // `useSplitResize` — same math, mirrored roles. The final ratio is
  // persisted so it survives reloads (the slice reads it back on
  // init).
  const { isResizing: isResizingPreview, onMouseDown: handleResizeStart } =
    useSplitResize({
      getStartRatio: () => previewSplitRatio,
      onRatio: (r) => appDispatch(setSplitRatio(r)),
      onCommit: (r) => {
        try {
          window.localStorage.setItem(
            PREVIEW_SPLIT_RATIO_STORAGE_KEY,
            String(r),
          )
        } catch {
          // localStorage may be unavailable (private mode, quota).
          // Drop the persist silently — the ratio still applies for
          // the current session via the slice.
        }
      },
      minLeftPx: PREVIEW_MIN_CHAT_WIDTH,
      minRightPx: PREVIEW_MIN_PANEL_WIDTH,
    })

  return (
    <div
      className="relative flex w-full max-w-[100dvw] h-dvh overflow-hidden"
      style={{ '--topbar-height': '64px' } as React.CSSProperties}
    >
      <BackgroundBlobs />

      {/* Global avatar stack — a fixed overlay in the top-bar row,
          centred over the conversation column. Position comes from
          CSS vars the active view publishes via `useContentAreaInsets`
          (sidebar/preview/file-card widths). The horizontal position
          does NOT animate (no `left/right` transition) — views
          pre-position it at its eventual spot even while hidden, so
          opening a panel only fades + slides it down in place rather
          than sliding it across the viewport. Fallbacks here cover
          views that don't publish insets. */}
      <div
        // Hidden on mobile: the stacked user+workspace avatars overlap
        // the top-bar breadcrumb at narrow widths and don't add
        // information there — the workspace name is in the breadcrumb
        // and the user avatar lives in the sidebar account menu.
        className="pointer-events-none fixed top-0 z-30 py-4 hidden md:block"
        style={{
          left: `var(--content-area-left-offset, ${
            showSidebar && !isSmallViewport ? '290px' : '0px'
          })`,
          right: `var(--content-area-right-offset, ${
            isPreviewOpen && !isSmallViewport ? previewPanelWidth : '0px'
          })`,
          opacity: 'var(--content-avatar-opacity, 1)',
          transform: 'translateY(var(--content-avatar-ty, 0px))',
          transition:
            'opacity 200ms ease var(--content-avatar-delay, 0ms), ' +
            'transform 240ms cubic-bezier(0.4,0,0.2,1) var(--content-avatar-delay, 0ms)',
        }}
      >
        <div className="w-full max-w-4xl min-w-0 mx-auto px-6 flex justify-center">
          <div className="pointer-events-auto">
            <RoomAvatarStack workspace={activeWorkspace} />
          </div>
        </div>
      </div>

      {/* Chat column — top bar + sidebar + content. When the preview
          panel mounts as the right sibling, this column shrinks via
          `flex-1` to fill the remaining viewport width. */}
      <SidebarProvider
        style={{ height: 'auto', '--sidebar-width': '290px' } as React.CSSProperties}
        className="flex-1 min-w-0 min-h-0 max-w-full flex flex-col overflow-hidden"
      >
        <TopBar
          workspace={activeWorkspace}
          trailing={trailingCrumbs}
          hideBreadcrumb={isPreviewOpen}
          hideSidebarTrigger={!showSidebar}
        >
          {/* ── Sidebar + content (no card chrome — floats on the blob) ── */}
          <div className="flex flex-1 min-w-0 min-h-0 w-full max-w-full overflow-hidden">
            <RoomSidebarSlot show={showSidebar}>
              <RoomSidebar
                activeView={activeView}
                activeWorkspaceId={activeWorkspaceId}
                selectedChatId={selectedChatId}
                selectedItemId={selectedItemId}
                isDetailOpen={isDetailOpen}
                chats={chats}
                isChatsLoading={isChatsLoading}
                pinnedEntries={pinnedEntries}
                isPinnedLoading={isPinnedLoading}
                onDeleteChat={onDeleteChat}
                onPinItem={onPinItem}
                onPinChat={onPinChat}
                onUnpinEntry={onUnpinEntry}
                onOpenSettings={() =>
                  setWorkspaceSettings({ section: 'workspace', connectionsFocus: null })
                }
                username={me?.username}
                email={me?.email}
                userAvatarUrl={userAvatarUrl}
                onOpenMyAccount={() =>
                  setAccountSettings({ section: 'account', modelsFocus: null })
                }
                onSignOut={onSignOut}
              />
            </RoomSidebarSlot>

            <SidebarInset
              className="min-h-0 max-w-full overflow-hidden bg-transparent"
              onDragEnter={handleInsetDragEnter}
              onDragOver={handleInsetDragOver}
              onDragLeave={handleInsetDragLeave}
              onDrop={handleInsetDrop}
            >
              <main className="relative flex flex-1 flex-col min-w-0 min-h-0 overflow-hidden">
                {children}
                {isInsetDropOver && (
                  <div className="pointer-events-none absolute inset-0 z-50 flex items-center justify-center rounded-xl border-2 border-dashed border-primary/40 bg-primary/5 backdrop-blur-[1px]">
                    <p className="text-sm font-medium text-primary/70 bg-background/80 rounded-md px-3 py-2 shadow-sm">
                      Drop here to unpin
                    </p>
                  </div>
                )}
              </main>
            </SidebarInset>
          </div>
        </TopBar>
      </SidebarProvider>

      {/* Preview panel ─────────────────────────────────────────────────
          Desktop: docked flex sibling. `AnimatePresence` keeps it
          mounted through its exit animation so the close transition
          (width collapsing to 0) is visible. A 4 px drag divider sits
          on the left edge — dragging dispatches `setSplitRatio`,
          clamped to the configured min widths (400 chat / 512 panel).
          The avatar-stack offset on the chat side has its own 300 ms
          transition keyed on the same width, so the two move in sync.

          Below the desktop breakpoint the panel turns into a full-
          screen overlay (covers the chat) with no resize handle, so
          users on tablets / phones get a usable single-pane view
          without the geometry math breaking. */}
      <AnimatePresence initial={false}>
        {isPreviewOpen && (isSmallViewport ? (
          <motion.div
            key="preview-panel-overlay"
            initial={{ opacity: 0, x: '100%' }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: '100%' }}
            transition={{ duration: 0.25, ease: [0.4, 0, 0.2, 1] }}
            className="fixed inset-0 z-50 flex flex-col bg-background"
          >
            <PreviewPanel />
          </motion.div>
        ) : (
          <motion.div
            key="preview-panel"
            initial={{ width: 0 }}
            animate={{ width: previewPanelWidth }}
            exit={{ width: 0 }}
            transition={{ duration: 0.25, ease: [0.4, 0, 0.2, 1] }}
            className="relative shrink-0 flex flex-col"
          >
            {/* Drag handle (shared with the Library file-detail
                split). Lives OUTSIDE the overflow-hidden content
                wrapper below — its hit area is translated -50 % so
                the left half sits in the chat/panel seam; clipping it
                would shear the grab bar's left edge off. */}
            <SplitResizeHandle
              isResizing={isResizingPreview}
              onMouseDown={handleResizeStart}
              ariaLabel="Resize preview panel"
            />
            {/* Content clip lives here (not on the motion.div) so the
                panel's width-collapse close animation still hides any
                overflow without also clipping the seam handle above. */}
            <div className="flex flex-col flex-1 min-h-0 min-w-0 overflow-hidden">
              <PreviewPanel />
            </div>
          </motion.div>
        ))}
      </AnimatePresence>

      {/* ── Room settings modal ── */}
      <SettingsModal
        open={settingsOpen}
        onOpenChange={(open) => {
          if (!open) setWorkspaceSettings(null)
        }}
        workspace={activeWorkspace}
        canDeleteWorkspace={workspaces.length > 1}
        activeSection={settingsState?.section ?? 'workspace'}
        onChangeSection={(section: WorkspaceSettingsSectionId) =>
          setWorkspaceSettings({ section, connectionsFocus: null })
        }
        connectionsFocus={settingsState?.connectionsFocus ?? null}
        onChangeConnectionsFocus={(focus: ConnectionsFocus) =>
          setWorkspaceSettings({ section: 'connections', connectionsFocus: focus })
        }
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
        onDeleteWorkspace={() => {
          void deleteWorkspaceMutation(activeWorkspace.id).then(() => {
            const next = workspaces.filter(w => w.id !== activeWorkspace.id)
            if (next.length > 0) onSelectWorkspace(next[0].id)
          })
        }}
      />

      <MyAccountModal
        open={accountOpen}
        onOpenChange={(open) => {
          if (!open) setAccountSettings(null)
        }}
        activeSection={accountState?.section ?? 'account'}
        onChangeSection={(section: AccountSettingsSectionId) =>
          setAccountSettings({ section, modelsFocus: null })
        }
        modelsFocus={accountState?.modelsFocus ?? null}
        onChangeModelsFocus={(focus: ModelsFocus) =>
          setAccountSettings({ section: 'models', modelsFocus: focus })
        }
      />

      {/* ── Chat search command palette ── */}
      <CommandDialog
        open={chatSearchOpen}
        onOpenChange={(open) => { setChatSearchOpen(open); if (!open) { setChatSearchQuery(''); setChatSearchValue('') } }}
        showCloseButton={false}
        className="top-[20%] translate-y-0"
        value={chatSearchValue}
        onValueChange={setChatSearchValue}
        shouldFilter={false}
      >
        <CommandInput
          placeholder="Search chats and artifacts…"
          value={chatSearchQuery}
          onValueChange={(v) => { setChatSearchQuery(v); setChatSearchValue('') }}
        />
        <CommandList>
          <CommandEmpty>No results found.</CommandEmpty>

          {!chatSearchQuery.trim() && (
            <CommandGroup heading="Recent chats">
              {chats.slice(0, 5).map(chat => (
                <CommandItem
                  key={chat.id}
                  value={chat.id}
                  onSelect={() => { onChatClick(chat); setChatSearchOpen(false); setChatSearchQuery(''); setChatSearchValue('') }}
                >
                  <MessageSquare className="h-4 w-4 text-muted-foreground" />
                  <span className="truncate">{chat.title}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          )}

          {chatSearchQuery.trim() && (
            <>
              <CommandGroup heading="Chats">
                {(searchResults ?? [])
                  .filter(r => r.type === 'chat' || r.type === 'message')
                  .map(r => (
                    <CommandItem
                      key={r.messageId ?? r.id}
                      value={r.messageId ?? r.id}
                      onSelect={() => {
                        const chat = chats.find(c => c.id === r.id)
                        if (chat) onChatClick(chat)
                        setChatSearchOpen(false)
                        setChatSearchQuery('')
                        setChatSearchValue('')
                      }}
                    >
                      <MessageSquare className="h-4 w-4 text-muted-foreground" />
                      <span className="min-w-0 truncate">
                        <span className="block truncate">{r.title}</span>
                        {r.snippet && (
                          <span className="block truncate text-xs text-muted-foreground">{r.snippet.replace(/<\/?mark>/g, '')}</span>
                        )}
                      </span>
                    </CommandItem>
                  ))}
              </CommandGroup>
              <CommandSeparator />
              <CommandGroup heading="Artifacts">
                {(searchResults ?? [])
                  .filter(r => r.type === 'file')
                  .map(r => {
                    const artifact = artifacts.find(a => a.id === r.id)
                    if (!artifact) return (
                      <CommandItem key={r.id} value={r.id}>
                        <FileText className="h-4 w-4 text-muted-foreground" />
                        <span className="truncate">{r.title}</span>
                      </CommandItem>
                    )
                    const ArtifactIcon = getArtifactIcon(artifact.type)
                    return (
                      <CommandItem
                        key={artifact.id}
                        value={artifact.id}
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
