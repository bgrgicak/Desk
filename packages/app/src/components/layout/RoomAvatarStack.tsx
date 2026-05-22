import { cn } from '@roomy-ai/ui'
import { useGetMeQuery, useGetWorkspacesQuery } from '@/store/api'
import { useAvatarUrl } from '@/hooks/use-avatar'
import { useWorkspaceIconUrl } from '@/hooks/use-workspace-icon'
import { initialsOf } from '@/lib/initials'
import { roomColor } from '@/components/rooms/roomColor'
import { toWorkspaceInfo } from '@/store/selectors/workspaces'
import type { WorkspaceInfo } from '@/components/layout/WorkspaceBar'

// Pair of overlapping circular avatars rendered in the top bar centre slot:
// user on the left, the active room (workspace) on the right — tinted with
// the room's accent colour. Matches the Figma "Avatar Stack" component where
// the second pill is the room's own representation, not an agent.

interface RoomAvatarStackProps {
  workspace: WorkspaceInfo
  className?: string
}

export function RoomAvatarStack({ workspace, className }: RoomAvatarStackProps) {
  const { data: me } = useGetMeQuery()
  const userAvatar = useAvatarUrl(me?.id)
  const workspaceIcon = useWorkspaceIconUrl(workspace.id)
  const accent = roomColor(workspace)

  return (
    <div className={cn('flex items-center -space-x-2', className)}>
      <Avatar
        label={me?.username ? initialsOf(me.username) : '?'}
        src={userAvatar}
        title={me?.username}
      />
      <Avatar
        label={initialsOf(workspace.name)}
        src={workspaceIcon}
        tint={accent}
        title={workspace.name}
      />
    </div>
  )
}

/**
 * Convenience wrapper that resolves the `WorkspaceInfo` for a given
 * id from the warm `/workspaces` RTK-Query cache, so the few surfaces
 * that show the stack (chat view, Tasks, the file-detail chat panel)
 * can drop it in with just a workspace id. Renders nothing until the
 * workspace is known.
 */
export function RoomAvatarStackById({
  workspaceId,
  className,
}: {
  workspaceId: string | undefined
  className?: string
}) {
  const { data: serverWorkspaces } = useGetWorkspacesQuery()
  const ws = serverWorkspaces?.find(w => w.id === workspaceId)
  if (!ws) return null
  return <RoomAvatarStack workspace={toWorkspaceInfo(ws)} className={className} />
}

interface AvatarProps {
  label: string
  src?: string | null
  tint?: string
  title?: string
}

function Avatar({ label, src, tint, title }: AvatarProps) {
  if (src) {
    return (
      <img
        src={src}
        alt={title ?? label}
        title={title}
        className="h-8 w-8 rounded-full ring-2 ring-background object-cover"
      />
    )
  }
  return (
    <span
      title={title}
      style={tint ? { backgroundColor: tint, color: 'white' } : undefined}
      className={cn(
        'flex h-8 w-8 items-center justify-center rounded-full text-sm font-semibold ring-2 ring-background select-none',
        !tint && 'bg-muted text-foreground',
      )}
    >
      {label}
    </span>
  )
}
