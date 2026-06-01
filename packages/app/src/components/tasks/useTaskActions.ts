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
  onReopen:   (task: Task) => Promise<void>
  onSchedule: (task: Task, next: SchedulePickerValue | null) => Promise<void>
}

/**
 * Shared task-action handlers. Used by the tasks board, Home task rows,
 * and the chat-header overflow menu when viewing a task's thread chat.
 * All surfaces dispatch the same mutations and surface the same error
 * toasts, so consolidating them here keeps the menus in lock-step.
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
      // A task carrying any terminal parent state (succeeded / cancelled /
      // failed) must be reset to `pending` before a re-run: the status
      // selector treats succeeded/cancelled as Done and the scheduler's
      // promotion path in fireMessage only flips `pending → running`, so
      // hitting Run on a failed/done card without a reset would either
      // surface stale Done (parent unchanged) or skip the kanban-Active
      // promotion (state guard refuses non-pending input). Key off
      // `messageState` rather than `status` because `failed` is folded
      // into the Open badge by the selector — the underlying state is
      // still terminal and needs resetting.
      const ms = task.messageState
      if (ms === 'succeeded' || ms === 'cancelled' || ms === 'failed') {
        await patchMessageMutation({
          chatId: task.chatId,
          messageId: task.messageId,
          patch: { state: 'pending' },
        }).unwrap()
      }
      await runMessageMutation({
        chatId: task.chatId,
        messageId: task.messageId,
      }).unwrap()
    } catch (err) {
      toast.error('Run failed', { description: extractApiError(err) })
    }
  }, [patchMessageMutation, runMessageMutation])

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

  const onReopen = useCallback(async (task: Task) => {
    if (!task.chatId || !task.messageId) return
    const move = buildTaskStatusMove(task, 'todo', 'user')
    if (move.kind !== 'patch') return
    try {
      await patchMessageMutation({
        chatId: task.chatId,
        messageId: task.messageId,
        patch: move.patch,
      }).unwrap()
    } catch (err) {
      toast.error('Reopen failed', { description: extractApiError(err) })
    }
  }, [patchMessageMutation])

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

  return { onMarkDone, onRunNow, onPause, onDelete, onReopen, onSchedule }
}
