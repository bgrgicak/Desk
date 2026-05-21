import { MoreVertical, PanelRight, PanelRightClose } from 'lucide-react'
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from '@agent-desk/ui'
import { ChatMenuItems } from '@/components/chats/ChatMenuItems'
import { TopBarActions } from '@/components/layout/TopBar'
import { TaskPanelActionsMenu } from '@/components/tasks/TaskPanelActionsMenu'
import type { TaskActionHandlers } from '@/components/tasks/useTaskActions'
import type { Task } from '@/data/ui-types'

// Right-aligned action cluster for chat routes: kebab menu and the
// right-panel toggle. Portals into the top bar via `TopBarActions`.
// For task-thread chats the kebab swaps to `TaskPanelActionsMenu` so
// the chat header offers the same Run now / Schedule / Mark as done /
// Delete actions as the tasks board — keeping the two surfaces in
// lock-step. Search/filter icons live on the TasksPage top bar — the
// chat right panel just shows files + tasks for this chat without
// filtering.

interface RoomTopBarActionsProps {
  chatId: string
  onDeleteChat?: (chatId: string) => void
  panelOpen: boolean
  onTogglePanel: () => void
  /** Hides the right-panel toggle button. The toggle controls the
   *  Files + Tasks panel, which is replaced by the preview panel when
   *  an artifact is open — so the button would be a no-op there. The
   *  kebab menu stays visible regardless. Defaults to shown. */
  showPanelToggle?: boolean
  /** When set, the kebab renders the task action menu instead of the
   *  default chat menu. Supplied alongside `taskActions` from
   *  `useTaskActions()`. */
  task?: Task | null
  taskActions?: TaskActionHandlers
  /** Invoked after a successful task delete from the menu — lets the
   *  host navigate away from the now-orphan thread chat. */
  onTaskDeleted?: () => void
}

export function RoomTopBarActions({
  chatId,
  onDeleteChat,
  panelOpen,
  onTogglePanel,
  showPanelToggle = true,
  task,
  taskActions,
  onTaskDeleted,
}: RoomTopBarActionsProps) {
  const showTaskMenu = !!task && !!taskActions
  return (
    <TopBarActions>
      {showTaskMenu ? (
        <TaskPanelActionsMenu
          task={task!}
          onMarkDone={() => void taskActions!.onMarkDone(task!)}
          onRunNow={
            task!.status === 'scheduled' ||
            task!.status === 'todo' ||
            task!.status === 'complete'
              ? () => void taskActions!.onRunNow(task!)
              : undefined
          }
          onPause={
            (task!.status === 'active' || task!.status === 'scheduled') &&
            task!.messageState !== 'paused'
              ? () => void taskActions!.onPause(task!)
              : undefined
          }
          onSchedule={(next) => void taskActions!.onSchedule(task!, next)}
          onDelete={async () => {
            await taskActions!.onDelete(task!)
            onTaskDeleted?.()
          }}
        />
      ) : (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" className="h-8 w-8">
              <MoreVertical className="h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-40">
            <ChatMenuItems chatId={chatId} onDelete={(id) => onDeleteChat?.(id)} />
          </DropdownMenuContent>
        </DropdownMenu>
      )}
      {showPanelToggle && (
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8"
          onClick={onTogglePanel}
          aria-label={panelOpen ? 'Close side panel' : 'Open side panel'}
        >
          {panelOpen ? (
            <PanelRightClose className="h-4 w-4" />
          ) : (
            <PanelRight className="h-4 w-4" />
          )}
        </Button>
      )}
    </TopBarActions>
  )
}
