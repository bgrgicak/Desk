import { LogOut, Settings2 } from 'lucide-react'
import {
  Avatar,
  AvatarFallback,
  AvatarImage,
  cn,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from '@agent-desk/ui'
import { initialsOf } from '@/lib/initials'

// Shared sidebar-row appearance — kept in lockstep with the file / task rows
// in the chat right panel (see `ChatRightPanel`'s `ROW_CLASS`). `gap-3`,
// `px-3`, and `rounded-lg` override shadcn's `gap-2 p-2 rounded-md` defaults
// so every list item across the app has the same rhythm. The height stays
// at shadcn's default `h-8` (32 px). Hover / active tokens match the Figma
// `--black/alpha-333` (`rgba(0,0,0,0.03)`); `bg-foreground/...` keeps the
// token dark-mode-aware.
export const SIDEBAR_ROW_STATE_CLASS =
  'gap-3 px-3 rounded-lg hover:bg-foreground/[0.04] data-[active=true]:bg-foreground/[0.06]'

interface SidebarAccountMenuProps {
  /** Display name shown next to the avatar (e.g. "Hello, Bero"). */
  username?: string
  /** Email shown in the dropdown header row beneath the username. */
  email?: string
  /** Resolved avatar image URL, or null/undefined to fall back to initials. */
  userAvatarUrl?: string | null
  /** Opens the My Account modal. */
  onOpenMyAccount?: () => void
  /** Signs the current user out. */
  onSignOut?: () => void
}

/**
 * The bottom profile row + dropdown, shared by the per-room sidebar and
 * the Home sidebar so both stay pixel- and behaviour-identical. The
 * menu floats just above its trigger (`side="top"` + small positive
 * sideOffset) and is locked to the trigger width via Radix's
 * `--radix-dropdown-menu-trigger-width` so it reads as an extension of
 * the row rather than a free-floating popover.
 *
 * The data-testid="account-avatar" / "open-my-account" / "sign-out-button"
 * selectors are exercised by the e2e suite (slice17-login, slice18-signout,
 * et al.) — keep them in sync if you rename anything here.
 */
export function SidebarAccountMenu({
  username,
  email,
  userAvatarUrl,
  onOpenMyAccount,
  onSignOut,
}: SidebarAccountMenuProps) {
  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <SidebarMenuButton
              data-testid="account-avatar"
              className={cn(
                SIDEBAR_ROW_STATE_CLASS,
                'h-9 text-foreground data-[state=open]:bg-foreground/[0.06]',
              )}
              aria-label={username ? `Account menu for ${username}` : 'Account menu'}
            >
              <Avatar className="size-5 shrink-0">
                {userAvatarUrl ? (
                  <AvatarImage src={userAvatarUrl} alt={username ?? 'Profile'} />
                ) : null}
                <AvatarFallback className="text-[10px]">
                  {username ? initialsOf(username) : '?'}
                </AvatarFallback>
              </Avatar>
              <span className="flex-1 min-w-0 truncate text-left">
                {username ? `Hello, ${username}` : 'Hello'}
              </span>
            </SidebarMenuButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            side="top"
            align="start"
            sideOffset={6}
            className="w-[var(--radix-dropdown-menu-trigger-width)] p-0"
          >
            {/* Header row — the avatar + name + email block is the
                primary affordance for opening My Account. A Settings2
                gear fades in on hover (`group/header`) to signal
                "click to edit your profile" without cluttering the
                resting state. */}
            <DropdownMenuItem
              data-testid="open-my-account"
              onSelect={() => onOpenMyAccount?.()}
              className="flex items-center gap-2.5 p-2.5 rounded-none group/header"
            >
              <Avatar className="h-8 w-8 shrink-0">
                {userAvatarUrl ? (
                  <AvatarImage src={userAvatarUrl} alt={username ?? 'Profile'} />
                ) : null}
                <AvatarFallback className="text-xs font-semibold">
                  {username ? initialsOf(username) : '?'}
                </AvatarFallback>
              </Avatar>
              <div className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-sm font-medium">{username ?? '…'}</span>
                {email && (
                  <span className="truncate text-xs text-muted-foreground">{email}</span>
                )}
              </div>
              <Settings2 className="h-4 w-4 shrink-0 opacity-0 transition-opacity group-hover/header:opacity-60" />
            </DropdownMenuItem>
            <DropdownMenuSeparator className="my-0" />
            <DropdownMenuItem
              data-testid="sign-out-button"
              onSelect={() => onSignOut?.()}
              className="px-2.5 py-2"
            >
              <LogOut className="h-4 w-4 mr-2" />
              Sign out
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  )
}
