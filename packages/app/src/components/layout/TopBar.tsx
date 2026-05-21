import { createContext, useContext, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Link } from 'react-router-dom'
import { Home } from 'lucide-react'
import { cn, SidebarTrigger } from '@agent-desk/ui'
import { roomColor } from '@/components/rooms/roomColor'
import { buildPath } from '@/router/nav'
import type { WorkspaceInfo } from '@/components/layout/WorkspaceBar'

// Global 64 px top bar. Left: home icon, `/`, room name tinted with the
// room's accent colour, then an optional view label. Right: actions slot,
// populated by descendant routes via `<TopBarActions>` (portal — avoids
// prop drilling through AppShell). The avatar stack used to live in the
// centre here; it now renders as a `position: fixed` overlay inside
// `ChatView` so it can be centred on the chat column directly rather than
// on the viewport.

const TopBarActionsTargetContext = createContext<HTMLElement | null>(null)
// Second portal target: actions that belong to the *content* pane
// (the file preview), positioned at that pane's right edge via the
// `--topbar-content-actions-right` CSS var (a view sets it to the
// chat-pane width so the controls sit at the file/chat seam; default
// = the normal 24 px gutter). Both slots are ABSOLUTE so neither
// affects the breadcrumb's flow — the bar never reflows between
// views.
const TopBarContentActionsTargetContext = createContext<HTMLElement | null>(
  null,
)
// Third portal target: centred content that overlays the bar row
// (e.g. the Tasks status-tab pills, pixel-aligned over the task
// list). Absolute + full-row; the portalled content owns its own
// left/right insets so it can track a resizable split. `pointer-
// events-none` here so empty areas don't eat breadcrumb clicks — the
// portalled inner re-enables pointer events on the actual controls.
const TopBarCenterTargetContext = createContext<HTMLElement | null>(null)

/** A single trailing breadcrumb segment after the workspace name.
 *  `to` makes it a router link (intermediate crumbs); omit it for the
 *  current page (rendered as plain, non-interactive text). */
export interface TopBarCrumb {
  label: string
  to?: string
}

interface TopBarProps {
  workspace: WorkspaceInfo | null
  /** Trailing crumbs after the workspace name, e.g.
   *  `[{label:'Library', to:'/w/…/context'}, {label:'file.md'}]`
   *  renders `… / Workspace / Library / file.md`. */
  trailing?: TopBarCrumb[]
  className?: string
  /** Hides the breadcrumb (home icon + workspace name + view label)
   *  while keeping the right-side actions slot. Used when the chat
   *  enters preview-focused mode (sidebar collapsed + preview panel
   *  open) so the chrome shrinks to just the avatar stack. */
  hideBreadcrumb?: boolean
  /** Hides the mobile-only `SidebarTrigger` button (top-left). Used
   *  when the per-room sidebar isn't mounted (e.g. preview-focused
   *  mode), so tapping the trigger wouldn't do anything useful. The
   *  right-side actions slot (chat kebab, etc.) stays visible —
   *  callers that need to control individual items should portal
   *  through `TopBarActions` instead. */
  hideSidebarTrigger?: boolean
  children?: ReactNode
}

export function TopBar({ workspace, trailing, className, hideBreadcrumb = false, hideSidebarTrigger = false, children }: TopBarProps) {
  const [actionsEl, setActionsEl] = useState<HTMLElement | null>(null)
  const [contentActionsEl, setContentActionsEl] = useState<HTMLElement | null>(null)
  const [centerEl, setCenterEl] = useState<HTMLElement | null>(null)
  const accent = workspace ? roomColor(workspace) : null

  return (
    <TopBarActionsTargetContext.Provider value={actionsEl}>
    <TopBarContentActionsTargetContext.Provider value={contentActionsEl}>
    <TopBarCenterTargetContext.Provider value={centerEl}>
      <div
        className={cn(
          // `min-h-16` keeps the bar a constant 64 px tall even when
          // the breadcrumb is hidden (preview-focused chat mode);
          // otherwise the row collapses to just its padding and the
          // absolute action slots (inset-y-0 + items-center) center
          // within that short height — pinning the buttons to the top.
          'relative flex w-full min-h-16 items-center gap-3 px-6 py-4 shrink-0',
          className,
        )}
      >
        {/* Always reserve the mobile trigger's slot (even when the
            sidebar is hidden) so the breadcrumb's left edge doesn't
            jump horizontally when navigating between views that show
            vs. hide the sidebar. The slot itself is `md:hidden`, so
            desktop layout is unaffected either way. */}
        <div className="h-8 w-8 shrink-0 md:hidden">
          {!hideSidebarTrigger && <SidebarTrigger className="h-8 w-8 rounded-md" />}
        </div>
        {/* Reserve room for the right-side action slots (absolute,
            anchored at `right-6`) so the trailing crumb doesn't
            slide under the Filter/Search icons on narrow viewports.
            Mobile shrinks `gap-3 → gap-2` to claw back ~8 px per
            separator — three crumbs (`Home / workspace / view-label`)
            at the old gap left no room between "Tasks" and the
            filter icon on a 375 px iPhone-SE-class viewport. */}
        <nav className="flex min-w-0 flex-1 items-center gap-2 pr-20 sm:gap-3">
          {!hideBreadcrumb && (
            <>
              <Link
                to="/"
                aria-label="Home"
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-foreground/5 hover:text-foreground transition-colors"
              >
                <Home className="h-5 w-5" />
              </Link>
              {workspace && (
                // The workspace crumb hides on mobile when a trailing
                // crumb is present — the page name (chat title /
                // Library / Tasks) is the more useful context, and
                // packing both into a 375 px viewport reduced "Desk
                // dev" to an ugly "D…". The workspace's accent colour
                // still shows on the trailing crumb's separator so
                // the room identity isn't lost entirely. The desktop
                // breadcrumb stays unchanged via `sm:contents`.
                <span className={
                  (trailing && trailing.length > 0)
                    ? 'hidden sm:contents'
                    : 'contents'
                }>
                  <span aria-hidden className="text-base font-medium leading-6 text-muted-foreground sm:text-lg">/</span>
                  <Link
                    to={buildPath(workspace.id, 'tasks')}
                    className="truncate text-base font-semibold leading-6 rounded-sm transition-opacity hover:opacity-80 sm:text-xl"
                    style={accent ? { color: accent } : undefined}
                    title={`Go to ${workspace.name}`}
                  >
                    {workspace.name}
                  </Link>
                </span>
              )}
              {workspace && (trailing ?? []).map((crumb, i, arr) => {
                const isLast = i === arr.length - 1
                // Intermediate crumbs (those with a `to` link, not the
                // leaf) are hidden on mobile — the leaf is what the
                // user cares about, and packing `/ Library / file.md`
                // into 375 px squeezed the file name down to "CL…".
                // Desktop keeps the full trail via `sm:flex`.
                const isIntermediate = !isLast
                return (
                  <span
                    key={i}
                    className={
                      isIntermediate
                        ? 'hidden min-w-0 items-center gap-2 sm:flex sm:gap-3'
                        : 'flex min-w-0 items-center gap-2 sm:gap-3'
                    }
                  >
                    <span aria-hidden className="text-base font-medium leading-6 text-muted-foreground sm:text-lg">/</span>
                    {crumb.to && !isLast ? (
                      <Link
                        to={crumb.to}
                        className="block truncate text-base font-semibold leading-6 text-foreground rounded-sm transition-opacity hover:opacity-80 sm:text-xl"
                        title={crumb.label}
                      >
                        {crumb.label}
                      </Link>
                    ) : (
                      <span
                        className="block truncate text-base font-semibold leading-6 text-foreground sm:text-xl"
                        title={crumb.label}
                      >
                        {crumb.label}
                      </span>
                    )}
                  </span>
                )
              })}
            </>
          )}
        </nav>
        {/* Centred overlay slot — full row, behind the action slots
            so buttons stay clickable. The portalled content owns its
            own left/right insets (Tasks pixel-tracks the list column /
            resizable split). `pointer-events-none` so empty space
            doesn't block breadcrumb clicks. */}
        <div
          ref={setCenterEl}
          className="pointer-events-none absolute inset-0"
        />
        {/* Content-pane actions — file-preview controls. Absolute,
            its right edge aligned to the content pane via
            `--topbar-content-actions-right` (a view sets it to the
            chat-pane width so these sit at the file/chat seam;
            default = the 24 px gutter). `gap-2` baseline so adjacent
            icon buttons aren't visually fused on phones — the
            previous `gap-1.5` left only 6 px between Filter and
            Search at 375 px. */}
        <div
          ref={setContentActionsEl}
          className="absolute inset-y-0 flex items-center gap-2"
          style={{ right: 'var(--topbar-content-actions-right, 1.5rem)' }}
        />
        {/* Far-right actions slot — pinned to the true far right
            (`right-6`), over the chat pane. Holds the chat-list /
            chat-detail controls and (on the file detail) only the
            collapse X. Both slots are absolute → out of flow → the
            breadcrumb never reflows between views. `gap-2` matches
            the content-actions slot so adjacent icon buttons in this
            slot (e.g. RecentRuns clock + close-X on a docked task
            chat) aren't visually fused either. */}
        <div
          ref={setActionsEl}
          className="absolute inset-y-0 right-6 flex items-center gap-2"
        />
      </div>
      {children}
    </TopBarCenterTargetContext.Provider>
    </TopBarContentActionsTargetContext.Provider>
    </TopBarActionsTargetContext.Provider>
  )
}

export function TopBarActions({ children }: { children: ReactNode }) {
  const target = useContext(TopBarActionsTargetContext)
  if (!target) return null
  return createPortal(children, target)
}

/** Portals into the content-pane slot (aligned to the file
 *  preview's right edge) — used by the Library file detail for its
 *  file controls. */
export function TopBarContentActions({ children }: { children: ReactNode }) {
  const target = useContext(TopBarContentActionsTargetContext)
  if (!target) return null
  return createPortal(children, target)
}

/** Portals into the full-row centred slot (behind the action
 *  buttons) — used by the Tasks view for the status-tab pills,
 *  pixel-aligned over the task list column. The caller supplies its
 *  own positioned wrapper. */
export function TopBarCenter({ children }: { children: ReactNode }) {
  const target = useContext(TopBarCenterTargetContext)
  if (!target) return null
  return createPortal(children, target)
}
