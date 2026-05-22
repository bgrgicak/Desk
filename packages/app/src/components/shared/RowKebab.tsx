import type { ComponentProps, ReactNode } from 'react'
import { MoreVertical } from 'lucide-react'
import {
  cn,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from '@agent-desk/ui'

type Align = NonNullable<ComponentProps<typeof DropdownMenuContent>['align']>
type Side = NonNullable<ComponentProps<typeof DropdownMenuContent>['side']>

interface RowKebabProps {
  /** `<DropdownMenuItem>` children — the actual menu entries. */
  children: ReactNode
  align?: Align
  side?: Side
  /** Override the dropdown panel width / extras. Default `w-44`. */
  contentClassName?: string
  /** Tooltip / SR label for the trigger. */
  label?: string
  /** Force the trigger to stay visible regardless of row hover. Use
   *  when the row is in a sticky-open state (e.g. an expanded thread
   *  tree) so the user can still reach the menu without re-hovering. */
  forceVisible?: boolean
}

/**
 * Vertical-kebab affordance for list rows across the app. Renders an
 * absolutely-positioned, vertically-centred trigger that fades in on hover
 * of its OWN row — keyed to the named `group/row` OR `group/menu-item`
 * ancestor. Named groups (not the bare `group`) are deliberate: an
 * unrelated `group` ancestor — e.g. shadcn's sidebar wrapper, which is
 * `group peer` — would otherwise reveal every row's kebab when you hover
 * anywhere in the sidebar.
 *
 * The parent row must be `position: relative` and carry `group/row`
 * (chat-panel rows) or `group/menu-item` (shadcn `SidebarMenuItem`).
 */
export function RowKebab({
  children,
  align = 'end',
  side,
  contentClassName,
  label = 'Options',
  forceVisible = false,
}: RowKebabProps) {
  return (
    <div
      className={cn(
        'absolute right-2 top-1/2 -translate-y-1/2',
        'transition-opacity',
        forceVisible
          ? 'opacity-100'
          : 'opacity-0 group-hover/row:opacity-100 group-hover/menu-item:opacity-100',
        'focus-within:opacity-100',
      )}
    >
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            onClick={e => { e.stopPropagation() }}
            className="h-6 w-6 flex items-center justify-center rounded text-muted-foreground hover:bg-foreground/10 hover:text-foreground transition-colors"
          >
            <MoreVertical className="h-3.5 w-3.5" />
            <span className="sr-only">{label}</span>
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align={align}
          side={side}
          onClick={e => e.stopPropagation()}
          className={cn('w-44', contentClassName)}
        >
          {children}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}
