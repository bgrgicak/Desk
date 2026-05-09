import type { ReactNode } from 'react'

export function PreferenceRow({
  title, description, children,
}: { title: string; description: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 max-w-full flex-col items-stretch gap-3 first:pt-0 py-4 border-b last:border-b-0 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
      <div className="min-w-0 max-w-full">
        <p className="text-sm font-medium">{title}</p>
        <p className="text-xs text-muted-foreground mt-0.5 break-words">{description}</p>
      </div>
      <div className="min-w-0 max-w-full sm:shrink-0">{children}</div>
    </div>
  )
}
