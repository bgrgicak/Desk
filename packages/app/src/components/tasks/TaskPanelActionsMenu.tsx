import { useState } from 'react'
import {
  MoreVertical,
  Play,
  Pause,
  Trash2,
  CalendarClock,
  CheckCircle2,
} from 'lucide-react'
import {
  Button,
  Dialog,
  DialogContent,
  DialogTitle,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@agent-desk/ui'
import type { Task } from '@/data/ui-types'
import { SchedulePickerForm, type SchedulePickerValue } from './SchedulePicker'

export interface TaskPanelActionsMenuProps {
  task: Task
  onMarkDone: () => void
  onRunNow?: () => void
  onPause?: () => void
  onDelete?: () => void
  onSchedule?: (next: SchedulePickerValue | null) => void
}

/**
 * Vertical-dots overflow menu shown in the task chat panel's TopBar
 * slot. Mirrors the secondary actions on `TaskCard`'s footer split
 * (Run now / Pause / Schedule / Delete) and adds Mark as done so the
 * task can be dismissed without scrolling back to the list. The
 * schedule editor opens in a popover anchored to the same trigger.
 */
export function TaskPanelActionsMenu({
  task,
  onMarkDone,
  onRunNow,
  onPause,
  onDelete,
  onSchedule,
}: TaskPanelActionsMenuProps) {
  const [scheduleOpen, setScheduleOpen] = useState(false)

  const initialSchedule: SchedulePickerValue | null =
    task.schedule || task.scheduledFor
      ? {
          executeAt: task.scheduledFor ? task.scheduledFor.toISOString() : null,
          cron:      task.schedule ?? null,
          endDate:   task.scheduleEndDate
            ? `${task.scheduleEndDate.getFullYear()}-${String(task.scheduleEndDate.getMonth() + 1).padStart(2, '0')}-${String(task.scheduleEndDate.getDate()).padStart(2, '0')}`
            : null,
        }
      : null

  const isDone = task.status === 'complete'

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8 text-muted-foreground hover:text-foreground"
            aria-label="More task actions"
            data-testid={`task-panel-menu-${task.id}`}
          >
            <MoreVertical className="h-4 w-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-44">
          {onRunNow && (
            <DropdownMenuItem onClick={onRunNow}>
              <Play className="h-4 w-4 mr-2" />
              Run now
            </DropdownMenuItem>
          )}
          {onPause && (
            <DropdownMenuItem onClick={onPause}>
              <Pause className="h-4 w-4 mr-2" />
              Pause
            </DropdownMenuItem>
          )}
          {onSchedule && (
            <DropdownMenuItem
              // Defer the dialog open by a tick so the dropdown can
              // unmount cleanly before the dialog mounts. Without the
              // gap the menu's focus return interrupts the dialog and
              // the editor briefly opens then closes itself. Same
              // workaround as TaskCard.
              onClick={() => setTimeout(() => setScheduleOpen(true), 0)}
              data-testid={`task-panel-schedule-${task.id}`}
            >
              <CalendarClock className="h-4 w-4 mr-2" />
              {initialSchedule ? 'Edit schedule' : 'Schedule'}
            </DropdownMenuItem>
          )}
          {!isDone && (
            <DropdownMenuItem onClick={onMarkDone}>
              <CheckCircle2 className="h-4 w-4 mr-2" />
              Mark as done
            </DropdownMenuItem>
          )}
          {onDelete && (
            <DropdownMenuItem onClick={onDelete}>
              <Trash2 className="h-4 w-4 mr-2" />
              Delete
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      {onSchedule && (
        <Dialog open={scheduleOpen} onOpenChange={setScheduleOpen}>
          <DialogContent
            className="sm:max-w-md p-4"
            data-testid={`task-panel-schedule-dialog-${task.id}`}
          >
            <DialogTitle className="text-sm font-semibold">
              {initialSchedule ? 'Edit schedule' : 'Schedule task'}
            </DialogTitle>
            <SchedulePickerForm
              initial={initialSchedule}
              onSave={(next) => {
                onSchedule?.(next)
                setScheduleOpen(false)
              }}
              onCancel={() => setScheduleOpen(false)}
            />
          </DialogContent>
        </Dialog>
      )}
    </>
  )
}
