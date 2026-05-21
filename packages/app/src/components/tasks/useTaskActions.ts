import { useCallback } from 'react'
import { toast } from 'sonner'
import {
  useDeleteMessageMutation,
  usePatchMessageMutation,
  useRunMessageMutation,
} from '@/store/api'
import { buildTaskLifecycleMove, buildTaskStatusMove } from '@/lib/task-status'
import { extractApiError } from '@/lib/api-error'
import type { Task } from '@/data/ui-types'
import type { SchedulePickerValue } from './SchedulePicker'

export interface TaskActionHandlers {
  onMarkDone: (task: Task) => Promise<void>
  onRunNow:   (task: Task) => Promise<void>
  onPause:    (task: Task) => Promise<void>
  onDelete:   (task: Task) => Promise<void>
  onSchedule: (task: Task, next: SchedulePickerValue | null) => Promise<void>
}

/**
 * Shared task-action handlers. Used by the tasks board and by the
 * chat-header overflow menu when viewing a task's thread chat — both
 * surfaces dispatch the same mutations and surface the same error
 * toasts, so consolidating them here keeps the two menus in lock-step.
 */
export function useTaskActions(): TaskActionHandlers {
  const [patchMessageMutation]  = usePatchMessageMutation()
  const [runMessageMutation]    = useRunMessageMutation()
  const [deleteMessageMutation] = useDeleteMessageMutation()

  const onMarkDone = useCallback(async (task: Task) => {
    if (!task.chatId || !task.messageId) return
    const move = buildTaskStatusMove(task, 'complete', 'user')
    if (move.kind !== 'patch') return
    try {
      await patchMessageMutation({
        chatId: task.chatId,
        messageId: task.messageId,
        patch: move.patch,
      }).unwrap()
    } catch (err) {
      toast.error('Failed to mark done', { description: extractApiError(err) })
    }
  }, [patchMessageMutation])

  const onRunNow = useCallback(async (task: Task) => {
    if (!task.chatId || !task.messageId) return
    try {
      await runMessageMutation({
        chatId: task.chatId,
        messageId: task.messageId,
      }).unwrap()
    } catch (err) {
      toast.error('Run failed', { description: extractApiError(err) })
    }
  }, [runMessageMutation])

  const onPause = useCallback(async (task: Task) => {
    if (!task.chatId || !task.messageId) return
    const move = buildTaskLifecycleMove(task, 'pause', 'user')
    if (move.kind !== 'patch') return
    try {
      await patchMessageMutation({
        chatId: task.chatId,
        messageId: task.messageId,
        patch: move.patch,
      }).unwrap()
    } catch (err) {
      toast.error('Pause failed', { description: extractApiError(err) })
    }
  }, [patchMessageMutation])

  const onDelete = useCallback(async (task: Task) => {
    if (!task.chatId || !task.messageId) return
    try {
      await deleteMessageMutation({
        chatId: task.chatId,
        messageId: task.messageId,
      }).unwrap()
    } catch (err) {
      toast.error('Delete failed', { description: extractApiError(err) })
    }
  }, [deleteMessageMutation])

  const onSchedule = useCallback(async (task: Task, next: SchedulePickerValue | null) => {
    if (!task.chatId || !task.messageId) return
    try {
      await patchMessageMutation({
        chatId: task.chatId,
        messageId: task.messageId,
        patch: {
          executeAt: next?.executeAt ?? null,
          cron:      next?.cron ?? null,
        },
      }).unwrap()
    } catch (err) {
      toast.error('Schedule update failed', { description: extractApiError(err) })
    }
  }, [patchMessageMutation])

  return { onMarkDone, onRunNow, onPause, onDelete, onSchedule }
}
