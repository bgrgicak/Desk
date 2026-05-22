import { cn } from '@roomy-ai/ui'
import { motion } from 'framer-motion'
import { HOME_SECTION_LABELS, type HomeSectionKey } from '@/hooks/use-home-sections'

interface HomeSectionTabsProps {
  /** Section keys to render — caller filters by `isVisible` so the
   *  Manage-sections popover's hide state is respected. */
  keys: Array<Exclude<HomeSectionKey, 'summary'>>
  /** Per-section task counts shown as a muted number after the
   *  label, mirroring the Tasks page's tab strip. */
  counts: Partial<Record<Exclude<HomeSectionKey, 'summary'>, number>>
  /** Which section is currently the topmost-in-view; pill renders
   *  with the active background. */
  activeKey: Exclude<HomeSectionKey, 'summary'> | null
  onSelect: (key: Exclude<HomeSectionKey, 'summary'>) => void
  className?: string
}

/**
 * Tab-pill row for Home's section anchors. Renders in the top bar
 * (centred between the Roomy wordmark and the right-side controls) when
 * the user has scrolled past the Summary block, so the section labels
 * stay reachable while the headings themselves are off-screen.
 *
 * Visual rhythm copies `TaskTabs` so Home and Tasks share one pill
 * style across the app — including the muted, `tabular-nums` count
 * span that sits after the label.
 */
export function HomeSectionTabs({ keys, counts, activeKey, onSelect, className }: HomeSectionTabsProps) {
  if (keys.length === 0) return null
  return (
    // `pointer-events-auto` sits *only* on the pill row, not the
    // wrapping centered slot — otherwise the empty space inside the
    // slot intercepts clicks meant for the page controls behind it.
    <div className={cn('flex items-center gap-1 pointer-events-auto', className)}>
      {keys.map(key => {
        const active = key === activeKey
        const count = counts[key] ?? 0
        return (
          <button
            key={key}
            type="button"
            onClick={() => onSelect(key)}
            className={cn(
              'relative shrink-0 rounded-full px-3 py-1.5 text-sm font-medium transition-colors',
              active
                ? 'text-secondary-foreground'
                : 'text-muted-foreground hover:bg-muted/40 hover:text-foreground',
            )}
            data-testid={`home-section-tab-${key}`}
          >
            {active && (
              <motion.span
                layoutId="home-section-tab-active"
                className="absolute inset-0 rounded-full bg-secondary"
                transition={{ type: 'spring', stiffness: 500, damping: 38 }}
              />
            )}
            <span className="relative z-10 inline-flex items-center gap-1.5">
              {HOME_SECTION_LABELS[key]}
              <span
                className={cn(
                  'tabular-nums text-xs',
                  active ? 'text-secondary-foreground/70' : 'text-muted-foreground/70',
                )}
              >
                {count}
              </span>
            </span>
          </button>
        )
      })}
    </div>
  )
}
