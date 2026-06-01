import { useState } from 'react'
import { Button } from '@roomy-ai/ui'
import { TaskCard } from '@/components/tasks/TaskCard'
import type { HomeTask } from './HomeWorkspaceTasks'
import { useLatestAgentMessage } from '@/hooks/use-latest-agent-message'

interface HomeTaskListProps {
  items: HomeTask[]
  authorName?: string
  authorAvatarUrl?: string | null
  /** Task currently displayed in the docked side panel — gets the
   *  active-card highlight on the matching card. */
  selectedTaskId?: string | null
  onOpenTask: (h: HomeTask) => void
  onMarkDone: (h: HomeTask) => void
  onReopen: (h: HomeTask) => void
  onRunNow: (h: HomeTask) => void
  onPause: (h: HomeTask) => void
  onDelete: (h: HomeTask) => void
}

/** First N cards rendered upfront; the rest reveal behind a centred
 *  "Show more" outline button. Matches the Tasks page's vertical card
 *  stack so a Home section's "Needs your input" rhythm reads the
 *  same as the room's Tasks list. */
const COLLAPSED_LIMIT = 5

/**
 * Vertical task-card list for a Home section. Same rhythm as the
 * Tasks page (`flex flex-col gap-3`) — Home aggregates across rooms
 * but the per-card layout stays identical so the user's eye doesn't
 * have to re-learn the format between Home and a room.
 */
export function HomeTaskList({
  items,
  authorName,
  authorAvatarUrl,
  selectedTaskId,
  onOpenTask,
  onMarkDone,
  onReopen,
  onRunNow,
  onPause,
  onDelete,
}: HomeTaskListProps) {
  const [expanded, setExpanded] = useState(false)
  const visible = expanded ? items : items.slice(0, COLLAPSED_LIMIT)
  const hidden = items.length - visible.length

  return (
    <div className="flex flex-col gap-3">
      {visible.map(h => (
        <HomeTaskCard
          key={`${h.workspaceId}:${h.task.id}`}
          item={h}
          authorName={authorName}
          authorAvatarUrl={authorAvatarUrl}
          isActive={selectedTaskId === h.task.id}
          onOpenTask={onOpenTask}
          onMarkDone={onMarkDone}
          onReopen={onReopen}
          onRunNow={onRunNow}
          onPause={onPause}
          onDelete={onDelete}
        />
      ))}
      {hidden > 0 && (
        <div className="flex justify-center pt-1">
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-8"
            onClick={() => setExpanded(true)}
            data-testid="home-task-list-show-more"
          >
            Show {hidden} more
          </Button>
        </div>
      )}
    </div>
  )
}

function HomeTaskCard({
  item,
  authorName,
  authorAvatarUrl,
  isActive,
  onOpenTask,
  onMarkDone,
  onReopen,
  onRunNow,
  onPause,
  onDelete,
}: {
  item: HomeTask
  authorName?: string
  authorAvatarUrl?: string | null
  isActive: boolean
  onOpenTask: (h: HomeTask) => void
  onMarkDone: (h: HomeTask) => void
  onReopen: (h: HomeTask) => void
  onRunNow: (h: HomeTask) => void
  onPause: (h: HomeTask) => void
  onDelete: (h: HomeTask) => void
}) {
  const h = item
  const latestPreview = useLatestAgentMessage(h.task.threadChatId ?? h.task.chatId)

  return (
    <TaskCard
      task={h.task}
      workspaceId={h.workspaceId}
      latestPreview={latestPreview}
      authorName={authorName}
      authorAvatarUrl={authorAvatarUrl}
      isActive={isActive}
      // Card href keeps the user on Home but sets `?task=<id>`,
      // which opens the docked task chat. cmd-click / middle-
      // click on the card opens the same deep-linked view in a
      // new tab.
      href={`/?task=${encodeURIComponent(h.task.id)}`}
      onSelect={() => onOpenTask(h)}
      onMarkDone={() => onMarkDone(h)}
      onReopen={() => onReopen(h)}
      onRunNow={h.task.status === 'scheduled' ? () => onRunNow(h) : undefined}
      onPause={
        (h.task.status === 'active' || h.task.status === 'scheduled') &&
        h.task.messageState !== 'paused'
          ? () => onPause(h)
          : undefined
      }
      onDelete={() => onDelete(h)}
    />
  )
}
