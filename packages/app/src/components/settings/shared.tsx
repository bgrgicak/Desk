import type { ReactNode } from 'react'

export function PreferenceRow({
  title, description, children,
}: { title: string; description: string; children: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 first:pt-0 py-4 border-b last:border-b-0">
      <div className="min-w-0">
        <p className="text-sm font-medium">{title}</p>
        <p className="text-xs text-muted-foreground mt-0.5">{description}</p>
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  )
}
