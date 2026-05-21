import { cn } from '@agent-desk/ui'

interface SplitResizeHandleProps {
  isResizing: boolean
  onMouseDown: (e: React.MouseEvent) => void
  ariaLabel?: string
  /** Default: the hit area straddles the seam (translated -50 %, half
   *  over each pane). Set when the left pane has no right padding —
   *  the handle then sits fully INSIDE the right pane's left padding
   *  so it doesn't overlap the left pane's content. */
  inset?: boolean
}

/**
 * The seam affordance shared by the chat-view preview split and the
 * Library file-detail split: a 12 px invisible hit area straddling
 * the pane boundary (translated -50 %), with a 64 × 8 rounded "grab
 * bar" that fades in on hover and stays solid while a drag is in
 * progress. Sits on the LEFT edge of the right (fixed) pane — render
 * it inside that pane's `relative` container, OUTSIDE any
 * `overflow-hidden` (its left half would otherwise be sheared off).
 */
export function SplitResizeHandle({
  isResizing,
  onMouseDown,
  ariaLabel = 'Resize panels',
  inset = false,
}: SplitResizeHandleProps) {
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={ariaLabel}
      onMouseDown={onMouseDown}
      className={cn(
        'group absolute left-0 top-0 bottom-0 z-20 w-3 cursor-ew-resize flex items-center justify-center',
        !inset && '-translate-x-1/2',
      )}
    >
      <div
        className={cn(
          'h-16 w-2 rounded-full transition-[opacity,background-color] duration-150',
          isResizing
            ? 'opacity-100 bg-foreground/40'
            : 'opacity-0 bg-foreground/20 group-hover:opacity-100 group-hover:bg-foreground/30',
        )}
      />
    </div>
  )
}
