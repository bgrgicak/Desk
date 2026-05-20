import { Button, Checkbox } from '@agent-desk/ui'
import type { Task } from '@/data/ui-types'
import { STATUS_LABELS } from '@/components/tasks/task-badges'

const STATUSES: Task['status'][] = ['todo', 'active', 'complete', 'scheduled']

/**
 * The list of statuses the user wants to **see**. By default every status is
 * checked (`ALL_STATUSES`) so the user filters _out_ rather than _in_ — they
 * uncheck what they don't want, the rest stays visible. Empty array =
 * everything is hidden.
 */
export interface TasksFilterValues {
  statuses: Task['status'][]
}

export const ALL_TASK_STATUSES: TasksFilterValues = { statuses: [...STATUSES] }

export function isTasksFilterActive(values: TasksFilterValues): boolean {
  return values.statuses.length < STATUSES.length
}

interface TasksFilterPopoverProps {
  values: TasksFilterValues
  onChange: (values: TasksFilterValues) => void
  onApply: () => void
  onCancel: () => void
}

/**
 * Status checkboxes for the chat right-panel's Tasks section. Layout mirrors
 * `ChatFilterPopover` (`p-3`, w-72, header label, Cancel + Apply footer) so
 * the chat filter and the tasks filter feel like one component family.
 */
export function TasksFilterPopover({ values, onChange, onApply, onCancel }: TasksFilterPopoverProps) {
  const toggle = (status: Task['status']) => {
    if (values.statuses.includes(status)) {
      onChange({ statuses: values.statuses.filter(s => s !== status) })
    } else {
      onChange({ statuses: [...values.statuses, status] })
    }
  }
  return (
    <div className="flex flex-col p-3 w-64">
      <label className="text-xs font-medium text-muted-foreground mb-2">Status</label>
      <div className="flex flex-col gap-2">
        {STATUSES.map(status => (
          <label
            key={status}
            className="flex items-center gap-2 text-sm cursor-pointer select-none"
          >
            <Checkbox
              checked={values.statuses.includes(status)}
              onCheckedChange={() => toggle(status)}
            />
            {STATUS_LABELS[status]}
          </label>
        ))}
      </div>
      <div className="flex justify-end gap-2 mt-4">
        <Button variant="ghost" size="sm" onClick={onCancel}>Cancel</Button>
        <Button size="sm" onClick={onApply}>Apply</Button>
      </div>
    </div>
  )
}
