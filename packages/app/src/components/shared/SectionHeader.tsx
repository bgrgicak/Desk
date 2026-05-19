import type { ReactNode } from 'react'
import { ChevronDown } from 'lucide-react'
import { cn } from '@agent-desk/ui'

/**
 * Collapsible section header used in the left sidebar (Pinned, Chats) and the
 * chat-side panel (Files, Tasks). Chevron-on-hover, button + label is the
 * click target, rotates -90deg when collapsed. Optional `actions` slot for
 * trailing icon buttons (e.g. filter, new-chat). The animation wrapper that
 * actually collapses the body is `SectionBody` (see below).
 */
export function SectionHeader({
  label,
  collapsed,
  onToggle,
  actions,
  topGap = 'normal',
  className,
}: {
  label: string
  collapsed: boolean
  onToggle: () => void
  actions?: ReactNode
  /** `first` gives 24 px top padding to anchor the section away from the top
   *  bar; `normal` gives 8 px for a follow-on section. */
  topGap?: 'first' | 'normal'
  className?: string
}) {
  return (
    <div
      className={cn(
        'group flex items-center pl-2 pr-2 pb-2',
        topGap === 'first' ? 'pt-6' : 'pt-2',
        className,
      )}
    >
      <button
        onClick={onToggle}
        aria-label={collapsed ? `Expand ${label}` : `Collapse ${label}`}
        aria-expanded={!collapsed}
        className="flex items-center gap-1 text-sm font-medium leading-5 text-foreground"
      >
        <span>{label}</span>
        <ChevronDown
          className={cn(
            'h-3 w-3 text-muted-foreground opacity-0 transition-[opacity,transform] duration-200 group-hover:opacity-100',
            collapsed && '-rotate-90',
          )}
        />
      </button>
      {actions && (
        <div
          className={cn(
            'ml-auto flex items-center gap-1',
            collapsed && 'invisible pointer-events-none',
          )}
        >
          {actions}
        </div>
      )}
    </div>
  )
}

/**
 * Animated body for a `SectionHeader`. Uses the CSS-grid trick to smoothly
 * collapse to zero height without unmounting children.
 */
export function SectionBody({
  collapsed,
  children,
  className,
}: {
  collapsed: boolean
  children: ReactNode
  className?: string
}) {
  return (
    <div
      className={cn(
        'grid transition-[grid-template-rows] duration-200 ease-out',
        collapsed ? 'grid-rows-[0fr]' : 'grid-rows-[1fr]',
        className,
      )}
    >
      <div className="overflow-hidden">{children}</div>
    </div>
  )
}
