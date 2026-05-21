import { useCallback, useEffect, useMemo } from 'react'
import { useDispatch } from 'react-redux'
import { toast } from 'sonner'
import {
  useCreateChatMutation,
  useDeleteMessageMutation,
  useGetAgentsQuery,
  useGetMessagesQuery,
  useGetMeQuery,
  useGetWorkspaceAgentsQuery,
  useGetWorkspacesQuery,
  useGetChatsQuery,
  usePatchMessageMutation,
  usePostChatMessageMutation,
  useRunMessageMutation,
} from '@/store/api'
import { useAppStore } from '@/store/hooks'
import { useAvatarUrl } from '@/hooks/use-avatar'
import { usePrefs } from '@/hooks/use-prefs'
import { markChatReadQuietly } from '@/store/ws/middleware'
import {
  isTaskListMessageForDeveloperMode,
  summaryRequestMessageKindsForDeveloperMode,
  taskMessageKindsForDeveloperMode,
  taskRunMessageKinds,
  toUiTask,
} from '@/store/selectors/tasks'
import { buildTaskLifecycleMove, buildTaskStatusMove } from '@/lib/task-status'
import { buildPath } from '@/router/nav'
import { extractApiError } from '@/lib/api-error'
import { generateTaskTitle } from '@/lib/task-title'
import type { ServerMessage } from '@/store/types'
import type { Task } from '@/data/ui-types'
import type { TaskComposerSubmit } from './TaskComposer'
import type { SchedulePickerValue } from './SchedulePicker'
import { TasksPage } from './TasksPage'

interface TasksRouteProps {
  workspaceId: string
  selectedTaskId: string | null
  onSelectTask: (id: string | null) => void
}

/**
 * Owns the four task-list queries, the per-action mutations, and the
 * tasks-board side effects.  Previously these all lived in AppInner,
 * which meant every WS-driven task refresh re-rendered the entire app
 * shell (the React profile pinned 155 AppInner-triggered commits
 * touching 1400+ fibers each).  Mounting this component only on the
 * /tasks route confines that churn to the tasks subtree.
 *
 * The action handlers (run-now / pause / delete / schedule …) keep the
 * exact same shape as before — they're constructed with `useCallback`
 * so the memoised TaskCard rows below stay stable when AppInner does
 * still re-render for unrelated reasons.
 */
export function TasksRoute({ workspaceId, selectedTaskId, onSelectTask }: TasksRouteProps) {
  const dispatch = useDispatch()
  const appStore = useAppStore()
  const { data: me } = useGetMeQuery()
  const userAvatarUrl = useAvatarUrl(me?.id)
  const { developerMode } = usePrefs()

  // These three queries are also fired by AppInner today; RTK Query
  // hits the cache when both call sites use the same args, so the
  // extra hooks here cost nothing — they're just additional
  // subscribers.  Naming them locally keeps the dependency surface
  // explicit.
  const { data: serverWorkspaces } = useGetWorkspacesQuery()
  const { currentData: workspaceServerAgents } = useGetWorkspaceAgentsQuery(
    workspaceId,
    { skip: !workspaceId, refetchOnMountOrArgChange: true },
  )
  const { data: serverAgents } = useGetAgentsQuery(undefined, { skip: !!workspaceId })
  const { currentData: serverChats } = useGetChatsQuery(
    workspaceId ? { workspaceId } : undefined,
    { skip: !workspaceId },
  )

  const { currentData: tasksResp, isFetching: tasksFetching, isLoading: tasksLoading } = useGetMessagesQuery(
    { workspaceId, kind: taskMessageKindsForDeveloperMode(developerMode) },
    { skip: !workspaceId, refetchOnMountOrArgChange: true },
  )
  const { currentData: summaryRequestTasksResp } = useGetMessagesQuery(
    {
      workspaceId,
      kind: summaryRequestMessageKindsForDeveloperMode(developerMode),
      contentKind: ['summary_request'],
    },
    { skip: !workspaceId || !developerMode, refetchOnMountOrArgChange: true },
  )
  const { currentData: taskRunsResp } = useGetMessagesQuery(
    { workspaceId, kind: taskRunMessageKinds(), limit: 500 },
    { skip: !workspaceId, refetchOnMountOrArgChange: true },
  )
  const { currentData: activeTaskRunsResp } = useGetMessagesQuery(
    { workspaceId, kind: taskRunMessageKinds(), state: ['running'], limit: 200 },
    { skip: !workspaceId, refetchOnMountOrArgChange: true },
  )

  const taskRunsByParent = useMemo(() => {
    const byParent = new Map<string, ServerMessage[]>()
    const byId = new Map<string, ServerMessage>()
    for (const run of taskRunsResp?.items ?? []) byId.set(run.id, run)
    for (const run of activeTaskRunsResp?.items ?? []) byId.set(run.id, run)
    for (const run of byId.values()) {
      if (!run.parentId) continue
      const runs = byParent.get(run.parentId) ?? []
      runs.push(run)
      byParent.set(run.parentId, runs)
    }
    return byParent
  }, [taskRunsResp?.items, activeTaskRunsResp?.items])

  const tasks = useMemo(() => (
    [...(tasksResp?.items ?? []), ...(summaryRequestTasksResp?.items ?? [])]
      .filter(m => isTaskListMessageForDeveloperMode(m, developerMode))
      .map(m => toUiTask(
        m,
        workspaceServerAgents ?? serverAgents ?? [],
        serverChats ?? [],
        serverWorkspaces ?? [],
        taskRunsByParent.get(m.id) ?? [],
      ))
  ), [
    tasksResp?.items,
    summaryRequestTasksResp?.items,
    developerMode,
    workspaceServerAgents,
    serverAgents,
    serverChats,
    serverWorkspaces,
    taskRunsByParent,
  ])

  // Opening a task's detail panel counts as engagement: clear the
  // backing chat's unread flag so the task drops out of "Needs input"
  // without the user navigating into the chat view.  Driven off the
  // URL param (selectedTaskId) rather than the card's onSelect — the
  // card itself navigates via <Link to={href}>, which never fires
  // onSelect.
  useEffect(() => {
    if (!selectedTaskId) return
    const chatId = tasks.find(t => t.id === selectedTaskId)?.chatId
    if (!chatId) return
    markChatReadQuietly(chatId, dispatch, appStore.getState)
  }, [selectedTaskId, tasks, dispatch, appStore])

  const [createChatMutation] = useCreateChatMutation()
  const [postMessageMutation] = usePostChatMessageMutation()
  const [patchMessageMutation] = usePatchMessageMutation()
  const [runMessageMutation] = useRunMessageMutation()
  const [deleteMessageMutation] = useDeleteMessageMutation()

  const hrefForTask = useCallback(
    (id: string) => buildPath(workspaceId, 'tasks', { task: id }),
    [workspaceId],
  )

  const onCreateTask = useCallback(async (input: TaskComposerSubmit) => {
    if (!workspaceId) return
    const pickedAgentId = workspaceServerAgents?.[0]?.id ?? serverAgents?.[0]?.id
    if (!pickedAgentId) {
      toast.error('No agent enabled in this workspace', {
        description: 'Open Settings → Agents to enable one.',
      })
      return
    }
    try {
      const generatedTitle = await generateTaskTitle(input.content)
      const newChat = await createChatMutation({
        workspaceId,
        agentId: pickedAgentId,
        title: generatedTitle,
      }).unwrap()
      await postMessageMutation({
        chatId: newChat.id,
        content: input.content,
        kind: 'task',
        title: generatedTitle,
        executeAt: input.executeAt,
        cron: input.cron,
        attachments: input.attachments.length ? input.attachments : undefined,
      }).unwrap()
    } catch (err) {
      toast.error('Failed to create task', { description: extractApiError(err) })
    }
  }, [workspaceId, workspaceServerAgents, serverAgents, createChatMutation, postMessageMutation])

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
        // `null` clears both fields; a populated `next` overwrites
        // executeAt + cron together so the picker is the source of
        // truth for the task's schedule.
        patch: {
          executeAt: next?.executeAt ?? null,
          cron:      next?.cron ?? null,
        },
      }).unwrap()
    } catch (err) {
      toast.error('Schedule update failed', { description: extractApiError(err) })
    }
  }, [patchMessageMutation])

  const tasksListLoading = !!workspaceId && !tasksResp && (tasksLoading || tasksFetching)

  return (
    <TasksPage
      tasks={tasks}
      isLoading={tasksListLoading}
      authorName={me?.username}
      authorAvatarUrl={userAvatarUrl}
      selectedTaskId={selectedTaskId}
      hrefForTask={hrefForTask}
      onSelectTask={onSelectTask}
      onCreateTask={onCreateTask}
      onMarkDone={onMarkDone}
      onRunNow={onRunNow}
      onPause={onPause}
      onDelete={onDelete}
      onSchedule={onSchedule}
    />
  )
}
