import { cn } from '@roomy-ai/ui'
import { useGetMeQuery } from '@/store/api'
import { useAvatarUrl } from '@/hooks/use-avatar'
import { useWorkspaceIconUrl } from '@/hooks/use-workspace-icon'
import { initialsOf } from '@/lib/initials'
import { roomColor } from '@/components/rooms/roomColor'
import type { WorkspaceInfo } from '@/components/layout/WorkspaceBar'

interface EmptyChatGreetingProps {
  /** When set, the second avatar shows the room (icon or initials on
   *  the room tint) — same affordance the chat header uses. When
   *  omitted, the second avatar is the Roomy wordmark (the Home "Ask
   *  AI" variant). */
  workspace?: WorkspaceInfo
  /** Skip the avatar stack entirely. Used by the room chat view,
   *  where the same user+room avatars already sit at the top of the
   *  page (overlaid by `AppShell`), so duplicating them in the empty
   *  state would be redundant. */
  hideAvatars?: boolean
  className?: string
}

/**
 * Hello-greeting block shown at the top of a chat's empty state
 * (Figma 747-8319). Avatar stack (user + room or Roomy wordmark)
 * sits above a `Hello, {name}` heading and a muted-tone
 * `How can I help you today?` subtitle.
 *
 * Used by both `ChatView` (new room chats with no messages yet) and
 * `AskAiView` (the Home → Ask AI thread before its first message).
 */
export function EmptyChatGreeting({ workspace, hideAvatars, className }: EmptyChatGreetingProps) {
  const { data: me } = useGetMeQuery()
  const userAvatarUrl = useAvatarUrl(me?.id)
  const workspaceIcon = useWorkspaceIconUrl(workspace?.id)
  const name = me?.username ?? 'there'

  return (
    <div className={cn('flex flex-col items-start gap-4', className)}>
      {/* Avatar stack — user first, then either the room or the Roomy
          wordmark depending on context. `-space-x-2` overlaps the
          two circles by 8 px; `ring-2 ring-background` separates
          them from each other and from the page. Skipped in the
          room chat view, where the same pair already sits at the
          top of the page. */}
      {!hideAvatars && (
        <div className="flex items-center -space-x-2">
          <UserAvatar src={userAvatarUrl} name={name} />
          {workspace && (
            <WorkspaceAvatar workspace={workspace} iconUrl={workspaceIcon} />
          )}
        </div>
      )}

      {/* Both lines share the same heading-2 typographic style (Figma
          `heading 2`: 30 px / 30 px line-height / -1 px tracking /
          semibold). Only the color differs — top line foreground,
          bottom line muted-foreground. */}
      <div className="flex flex-col gap-2">
        <h1 className="text-3xl font-semibold leading-[30px] tracking-[-0.0625rem] text-foreground">
          Hello, {name}
        </h1>
        <p className="text-3xl font-semibold leading-[30px] tracking-[-0.0625rem] text-muted-foreground">
          How can I help you today?
        </p>
      </div>
    </div>
  )
}

function UserAvatar({ src, name }: { src?: string | null; name: string }) {
  if (src) {
    return (
      <img
        src={src}
        alt={name}
        className="h-8 w-8 rounded-full ring-2 ring-background object-cover"
      />
    )
  }
  return (
    <span
      className="flex h-8 w-8 items-center justify-center rounded-full bg-muted text-sm font-semibold text-foreground ring-2 ring-background select-none"
      title={name}
    >
      {initialsOf(name)}
    </span>
  )
}

function WorkspaceAvatar({
  workspace,
  iconUrl,
}: {
  workspace: WorkspaceInfo
  iconUrl: string | null
}) {
  const tint = roomColor(workspace)
  if (iconUrl) {
    return (
      <img
        src={iconUrl}
        alt={workspace.name}
        title={workspace.name}
        className="h-8 w-8 rounded-full ring-2 ring-background object-cover"
      />
    )
  }
  return (
    <span
      style={{ backgroundColor: tint }}
      className="flex h-8 w-8 items-center justify-center rounded-full text-sm font-semibold text-white ring-2 ring-background select-none"
      title={workspace.name}
    >
      {initialsOf(workspace.name)}
    </span>
  )
}

