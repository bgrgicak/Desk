import type { ReactNode } from 'react'

/**
 * Bordered-dashed empty state used under a `SectionHeader`. Same visual rhythm
 * everywhere: 12 px horizontal inset (`mx-2`), dashed `border-foreground/10`,
 * `text-xs text-muted-foreground`. Used by Pinned, Chats, Files, Tasks.
 */
export function SectionEmptyState({ children }: { children: ReactNode }) {
  return (
    <div className="mx-2 rounded-lg border border-dashed border-foreground/10 p-2">
      <p className="text-xs text-muted-foreground">{children}</p>
    </div>
  )
}
