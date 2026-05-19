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
import { buildPath } from '@/router/nav'
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
    awaitingUser: true,
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
    window.setTimeout(() => navigate(buildPath(ws.id, 'tasks')), 200)
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

      {/* Blank canvas — the rest is intentionally empty for now. */}
      <main className="relative z-10 flex-1" />

      <CreateWorkspaceModal
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={openRoom}
      />
      <MyAccountModal open={myAccountOpen} onOpenChange={setMyAccountOpen} />
    </SidebarProvider>
  )
}
