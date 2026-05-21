import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Sun, MessageCircle, Plus } from 'lucide-react'
import {
  cn,
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
  useIsMobile,
} from '@agent-desk/ui'
import { BackgroundBlobs } from '@/components/layout/BackgroundBlobs'
import { SIDEBAR_ROW_STATE_CLASS, SidebarAccountMenu } from '@/components/layout/sidebarShared'
import { SectionHeader, SectionBody } from '@/components/shared/SectionHeader'
import { MyAccountModal } from '@/components/account/MyAccountModal'
import { useGetMeQuery, useGetWorkspacesQuery, useGetMessagesQuery } from '@/store/api'
import type { ServerWorkspace } from '@/store/types'
import { toWorkspaceInfo } from '@/store/selectors/workspaces'
import { roomColor } from '@/components/rooms/roomColor'
import { taskMessageKindsForDeveloperMode } from '@/store/selectors/tasks'
import { usePrefs } from '@/hooks/use-prefs'
import { useAvatarUrl } from '@/hooks/use-avatar'
import { useWorkspaceIconUrl } from '@/hooks/use-workspace-icon'
import { buildDefaultViewPath } from '@/App'
import { logout } from '@/auth/session'
import { DeskWordmark } from './DeskWordmark'
import { CreateWorkspaceModal } from './CreateWorkspaceModal'

/** A muted, non-interactive top-level item (Your day / Ask AI). Same
 *  row metrics as the live nav rows so they line up exactly. */
function InactiveItem({
  icon: Icon,
  label,
}: {
  icon: React.ComponentType<{ className?: string }>
  label: string
}) {
  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        disabled
        aria-disabled
        className={cn(SIDEBAR_ROW_STATE_CLASS, 'text-muted-foreground/70')}
      >
        <Icon className="h-4 w-4" />
        <span>{label}</span>
      </SidebarMenuButton>
    </SidebarMenuItem>
  )
}

/**
 * A room (workspace) row. Owns its own "Needs input" badge query so
 * each room counts the tasks awaiting the user independently (the only
 * real-data signal for the Tasks board's "Needs input" state).
 */
function HomeRoomItem({
  workspace,
  onOpen,
}: {
  workspace: ServerWorkspace
  onOpen: (ws: ServerWorkspace) => void
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
        className={cn(SIDEBAR_ROW_STATE_CLASS, 'text-foreground', needsInput > 0 && 'pr-9')}
        data-testid={`home-room-${workspace.id}`}
      >
        {icon ? (
          <img
            src={icon}
            alt=""
            className="h-4 w-4 shrink-0 rounded-full object-cover"
          />
        ) : (
          <span
            className="h-4 w-4 shrink-0 rounded-full border-2"
            style={{ borderColor: roomColor(info.bg) }}
          />
        )}
        <span className="flex-1 min-w-0 truncate text-left">{info.name}</span>
      </SidebarMenuButton>
      {needsInput > 0 && (
        <SidebarMenuBadge aria-label={`${needsInput} task${needsInput === 1 ? '' : 's'} need your input`}>
          {needsInput}
        </SidebarMenuBadge>
      )}
    </SidebarMenuItem>
  )
}

/**
 * Mobile-only main pane: a visible workspace picker. The sidebar is
 * offcanvas-collapsed by default on mobile, so without this the entire
 * `/` screen renders as a blank gradient — the user has no idea there's
 * a hamburger in the corner. We surface the workspace list directly,
 * with the same `Plus` / kebab affordances as the sidebar.
 */
function HomeMobileMain({
  workspaces,
  onOpen,
  onCreate,
}: {
  workspaces: ServerWorkspace[]
  onOpen: (ws: ServerWorkspace) => void
  onCreate: () => void
}) {
  const isMobile = useIsMobile()
  if (!isMobile) return null
  return (
    <div className="relative flex h-full w-full flex-col items-stretch overflow-y-auto px-4 pb-8 pt-16">
      {/* Mobile top-row: hamburger to expand the offcanvas sidebar so
          users can still reach "Your day" / "Ask AI" / the account
          menu. The wordmark mirrors the in-sidebar header so the
          screen still reads as "Desk" before any room is picked. */}
      <div className="absolute inset-x-0 top-0 z-10 flex h-14 items-center gap-2 px-3">
        <SidebarTrigger className="h-9 w-9 rounded-md" />
        <DeskWordmark className="h-5 w-auto text-foreground" />
      </div>
      <div className="mx-auto flex w-full max-w-md flex-col gap-4">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold text-foreground">Rooms</h2>
          <button
            type="button"
            onClick={onCreate}
            className="inline-flex h-9 items-center gap-1.5 rounded-md border border-border bg-background px-3 text-sm font-medium text-foreground hover:bg-muted/50"
          >
            <Plus className="h-4 w-4" />
            New room
          </button>
        </div>
        {workspaces.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            You don't have any rooms yet. Create one to get started.
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {workspaces.map(ws => {
              const info = toWorkspaceInfo(ws)
              return (
                <li key={ws.id}>
                  <button
                    type="button"
                    onClick={() => onOpen(ws)}
                    className="flex w-full items-center gap-3 rounded-lg border border-border bg-background px-4 py-3 text-left transition-colors hover:bg-muted/40"
                  >
                    <span
                      className="h-5 w-5 shrink-0 rounded-full border-2"
                      style={{ borderColor: roomColor(info.bg) }}
                    />
                    <span className="flex-1 min-w-0 truncate text-base font-medium text-foreground">
                      {info.name}
                    </span>
                  </button>
                </li>
              )
            })}
          </ul>
        )}
      </div>
    </div>
  )
}

/**
 * The top-level Home screen — mostly blank canvas with a left sidebar
 * that mirrors the per-room sidebar (same primitives, paddings, row
 * states, and the shared account dropdown). Two (inactive)
 * destinations, the user's rooms with "Needs input" badges, a `+` to
 * create a room, and the profile dropdown. Selecting a room enters its
 * workspace area (the Tasks view).
 */
export function HomePage() {
  const navigate = useNavigate()
  const { data: workspaces } = useGetWorkspacesQuery()
  const { data: me } = useGetMeQuery()
  const { defaultView } = usePrefs()
  const userAvatarUrl = useAvatarUrl(me?.id)
  const [createOpen, setCreateOpen] = useState(false)
  const [myAccountOpen, setMyAccountOpen] = useState(false)
  const [roomsCollapsed, setRoomsCollapsed] = useState(false)

  // Sidebar slide: enter from the left on arrival, slide back out to
  // the left when a room is opened (the room shell mounts as we go).
  const [entered, setEntered] = useState(false)
  const [leaving, setLeaving] = useState(false)
  useEffect(() => {
    const id = requestAnimationFrame(() => setEntered(true))
    return () => cancelAnimationFrame(id)
  }, [])

  const openRoom = (ws: ServerWorkspace) => {
    setLeaving(true)
    window.setTimeout(() => navigate(buildDefaultViewPath(ws.id, defaultView)), 200)
  }

  const slideClass =
    entered && !leaving ? 'translate-x-0 opacity-100' : '-translate-x-4 opacity-0'

  return (
    <SidebarProvider style={{ '--sidebar-width': '290px' } as React.CSSProperties}>
      <BackgroundBlobs />

      <Sidebar className="bg-transparent border-r-0 pl-4 pr-0 pt-0 pb-6">
        <div
          className={cn(
            'flex h-full min-h-0 flex-col transition-[transform,opacity] duration-200 ease-out',
            slideClass,
          )}
        >
        <SidebarHeader className="bg-transparent p-0">
          <SidebarTrigger className="absolute right-2 top-2 z-20 h-8 w-8 rounded-md md:hidden" />

          <div className="px-3 pt-6 pb-2">
            <DeskWordmark className="h-5 w-auto text-foreground" />
          </div>

          {/* Inactive top-level destinations */}
          <SidebarMenu className="pb-1">
            <InactiveItem icon={Sun} label="Your day" />
            <InactiveItem icon={MessageCircle} label="Ask AI" />
          </SidebarMenu>

          {/* Rooms header (label + create) */}
          <SectionHeader
            label="Rooms"
            collapsed={roomsCollapsed}
            onToggle={() => setRoomsCollapsed(c => !c)}
            className="mt-3"
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
        </SidebarHeader>

        <SidebarContent className="bg-transparent">
          <SectionBody collapsed={roomsCollapsed}>
            <SidebarGroup className="p-0">
              <SidebarGroupContent>
                <SidebarMenu>
                  {(workspaces ?? []).map(ws => (
                    <HomeRoomItem key={ws.id} workspace={ws} onOpen={openRoom} />
                  ))}
                </SidebarMenu>
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

      {/* Main canvas. Empty on desktop (the sidebar is the entire UI
          on this screen). On mobile the offcanvas sidebar is collapsed
          by default and the workspace picker has nowhere to surface, so
          render a minimal mobile workspace list here with an explicit
          hamburger to reveal the full sidebar. */}
      <main className="relative z-10 flex-1">
        <HomeMobileMain
          workspaces={workspaces ?? []}
          onOpen={openRoom}
          onCreate={() => setCreateOpen(true)}
        />
      </main>

      <CreateWorkspaceModal
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={openRoom}
      />
      <MyAccountModal open={myAccountOpen} onOpenChange={setMyAccountOpen} />
    </SidebarProvider>
  )
}
