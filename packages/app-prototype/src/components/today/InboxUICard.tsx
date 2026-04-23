import { Mail, Calendar, Receipt } from 'lucide-react'
import type { InboxUICard as InboxUICardData } from '@/data/ui-types'

interface InboxUICardProps {
  card: InboxUICardData
}

export function InboxUICard({ card }: InboxUICardProps) {
  if (card.type === 'email-draft') {
    return (
      <div className="rounded-xl border bg-muted/30 overflow-hidden text-sm mt-3">
        {/* Header */}
        <div className="flex items-center gap-2 px-3.5 py-2.5 border-b bg-muted/40">
          <Mail className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
          <span className="text-xs font-medium text-foreground truncate">{card.subject}</span>
        </div>
        {/* Meta */}
        <div className="px-3.5 pt-2.5 pb-1 space-y-0.5">
          <p className="text-xs text-muted-foreground truncate">
            <span className="text-foreground/50">To </span>{card.to}
          </p>
        </div>
        {/* Body */}
        <p className="px-3.5 pt-1 pb-3 text-sm leading-relaxed text-foreground/80 whitespace-pre-wrap line-clamp-4">
          {card.body}
        </p>
        {/* Actions */}
        <div className="flex gap-2 px-3.5 pb-3">
          <button className="flex-1 rounded-lg border bg-background py-1.5 text-xs font-medium text-foreground hover:bg-muted transition-colors">
            Review
          </button>
          <button className="flex-1 rounded-lg border bg-background py-1.5 text-xs font-medium text-foreground hover:bg-muted transition-colors">
            Edit
          </button>
        </div>
      </div>
    )
  }

  if (card.type === 'expense-flags') {
    return (
      <div className="rounded-xl border bg-muted/30 overflow-hidden text-sm mt-3">
        {/* Header */}
        <div className="flex items-center gap-2 px-3.5 py-2.5 border-b bg-muted/40">
          <Receipt className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
          <span className="text-xs font-medium text-foreground">
            {card.entries.length} entries missing receipts
          </span>
        </div>
        {/* Rows */}
        <div className="divide-y">
          {card.entries.map((entry, i) => (
            <div key={i} className="flex items-center justify-between px-3.5 py-2.5 gap-3">
              <div className="min-w-0">
                <p className="text-sm text-foreground truncate">{entry.description}</p>
                <p className="text-xs text-muted-foreground">{entry.date}</p>
              </div>
              <div className="text-right shrink-0">
                <p className="text-sm font-medium text-foreground">{entry.amount}</p>
                <p className="text-xs text-amber-600 dark:text-amber-400">No receipt</p>
              </div>
            </div>
          ))}
        </div>
      </div>
    )
  }

  if (card.type === 'reconnect') {
    return (
      <div className="rounded-xl border bg-muted/30 overflow-hidden text-sm mt-3">
        <div className="px-3.5 py-3 flex items-center gap-3">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-background border">
            <Calendar className="h-4 w-4 text-muted-foreground" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium text-foreground">{card.service}</p>
            <p className="text-xs text-muted-foreground">{card.detail}</p>
          </div>
          <button className="shrink-0 rounded-lg border bg-background px-3 py-1.5 text-xs font-medium text-foreground hover:bg-muted transition-colors">
            Reconnect
          </button>
        </div>
      </div>
    )
  }

  return null
}
