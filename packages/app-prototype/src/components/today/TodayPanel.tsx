import { useState } from 'react'
import { Check, ArrowDownWideNarrow, Clock, X, Inbox } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { InboxCard } from './InboxCard'
import { type InboxItem } from '@/data/ui-types'
import { useGetMessagesQuery, useGetAgentsQuery } from '@/store/api'
import { toInboxItem } from '@/store/selectors/inbox'

// ── Sort options ──────────────────────────────────────────────────────────────
type SortOrder = 'priority' | 'newest'

const SORT_LABELS: Record<SortOrder, string> = {
  priority: 'Most important first',
  newest:   'Newest first',
}

const SORT_ICONS: Record<SortOrder, LucideIcon> = {
  priority: ArrowDownWideNarrow,
  newest:   Clock,
}

// ── Date helpers ──────────────────────────────────────────────────────────────
function isToday(date: Date): boolean {
  const now = new Date()
  return (
    date.getFullYear() === now.getFullYear() &&
    date.getMonth()    === now.getMonth()    &&
    date.getDate()     === now.getDate()
  )
}
function isThisWeek(date: Date): boolean {
  const now  = new Date()
  const diff = (now.getTime() - date.getTime()) / (1000 * 60 * 60 * 24)
  return diff < 7
}

// ── Sub-section heading (matches "Recent AI chats" nav style) ─────────────────
function GroupLabel({ children }: { children: React.ReactNode }) {
  return (
    <p className="px-5 pt-4 pb-3 text-xs font-medium text-muted-foreground">
      {children}
    </p>
  )
}

// ── Main panel ────────────────────────────────────────────────────────────────
interface TodayPanelProps {
  onClose?: () => void
  onSelectItem?: (item: InboxItem, focusInput?: boolean) => void
  selectedItemId?: string
}

export function TodayPanel({ onClose, onSelectItem, selectedItemId }: TodayPanelProps) {
  const { data: awaiting } = useGetMessagesQuery({ awaitingUser: true })
  const { data: agents } = useGetAgentsQuery()
  const inbox: InboxItem[] = (awaiting?.items ?? []).map((m) =>
    toInboxItem(m, agents ?? []),
  )
  const [sortOrder, setSortOrder] = useState<SortOrder>('priority')

  const totalCount = inbox.length

  // ── Priority groups ────────────────────────────────────────────────────────
  const dueNow      = inbox.filter(i => i.type === 'question')
  const goodToKnow  = inbox.filter(i => i.type === 'completion')
  const otherUpdates = inbox.filter(i => i.type === 'error')

  // ── Time groups ────────────────────────────────────────────────────────────
  const todayItems    = inbox.filter(i =>  isToday(i.timestamp))
  const thisWeekItems = inbox.filter(i => !isToday(i.timestamp) &&  isThisWeek(i.timestamp))
  const earlierItems  = inbox.filter(i => !isThisWeek(i.timestamp))

  // Shared card renderer
  const card = (item: InboxItem, i: number, offset = 0) => (
    <InboxCard
      key={item.id}
      item={item}
      index={i + offset}
      onClick={() => onSelectItem?.(item)}
      onSomethingElse={() => onSelectItem?.(item, true)}
      isSelected={item.id === selectedItemId}
    />
  )

  const SortIcon = SORT_ICONS[sortOrder]

  return (
    <div className="flex flex-1 flex-col min-h-0 bg-sidebar">

      {/* ── Header — matches secondary panel style ── */}
      <div className="h-[52px] flex items-center gap-2.5 border-b px-4 shrink-0 bg-background">
        <Inbox className="h-4 w-4 shrink-0 text-muted-foreground" />
        <span className="flex-1 min-w-0 text-sm font-medium text-foreground truncate">
          {totalCount} items need your input, Jaroslaw
        </span>
        <div className="flex items-center gap-1 shrink-0">
          {/* Sort picker */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
                aria-label="Sort order"
              >
                <SortIcon className="h-4 w-4" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-52">
              {(Object.keys(SORT_LABELS) as SortOrder[]).map(key => {
                const Icon = SORT_ICONS[key]
                return (
                  <DropdownMenuItem
                    key={key}
                    onClick={() => setSortOrder(key)}
                    className="flex items-center gap-2 cursor-pointer"
                  >
                    <Icon className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                    <span className="flex-1">{SORT_LABELS[key]}</span>
                    {sortOrder === key && <Check className="h-3.5 w-3.5 text-primary shrink-0" />}
                  </DropdownMenuItem>
                )
              })}
            </DropdownMenuContent>
          </DropdownMenu>
          {/* Close sheet */}
          <button
            onClick={onClose}
            className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto">

        {/* ── Priority sort ── */}
        {sortOrder === 'priority' && (
          <>
            {dueNow.length > 0 && (
              <>
                <GroupLabel>Due now</GroupLabel>
                <div className="mx-3 rounded-xl border overflow-hidden">
                  {dueNow.map((item, i) => card(item, i))}
                </div>
              </>
            )}
            {goodToKnow.length > 0 && (
              <>
                <GroupLabel>Good to know</GroupLabel>
                <div className="mx-3 rounded-xl border overflow-hidden">
                  {goodToKnow.map((item, i) => card(item, i, dueNow.length))}
                </div>
              </>
            )}
            {otherUpdates.length > 0 && (
              <>
                <GroupLabel>Other updates</GroupLabel>
                <div className="mx-3 rounded-xl border overflow-hidden">
                  {otherUpdates.map((item, i) => card(item, i, dueNow.length + goodToKnow.length))}
                </div>
              </>
            )}
          </>
        )}

        {/* ── Newest-first sort ── */}
        {sortOrder === 'newest' && (
          <>
            {todayItems.length > 0 && (
              <>
                <GroupLabel>Today</GroupLabel>
                <div className="mx-3 rounded-xl border overflow-hidden">
                  {todayItems.map((item, i) => card(item, i))}
                </div>
              </>
            )}
            {thisWeekItems.length > 0 && (
              <>
                <GroupLabel>This week</GroupLabel>
                <div className="mx-3 rounded-xl border overflow-hidden">
                  {thisWeekItems.map((item, i) => card(item, i, todayItems.length))}
                </div>
              </>
            )}
            {earlierItems.length > 0 && (
              <>
                <GroupLabel>Earlier</GroupLabel>
                <div className="mx-3 rounded-xl border overflow-hidden">
                  {earlierItems.map((item, i) => card(item, i, todayItems.length + thisWeekItems.length))}
                </div>
              </>
            )}
          </>
        )}

        <div className="h-6" /> {/* bottom breathing room */}
      </div>
    </div>
  )
}
