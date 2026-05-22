import { useMemo } from 'react'
import {
  useGetAgentsQuery,
  useGetChatsQuery,
  useGetMessagesQuery,
  useGetWorkspaceAgentsQuery,
  useGetWorkspacesQuery,
} from '@/store/api'
import { usePrefs } from '@/hooks/use-prefs'
import {
  isTaskListMessageForDeveloperMode,
  summaryRequestMessageKindsForDeveloperMode,
  taskMessageKindsForDeveloperMode,
  taskRunMessageKinds,
  toUiTask,
} from '@/store/selectors/tasks'
import type { ServerMessage } from '@/store/types'
import type { Task } from '@/data/ui-types'

interface UseTaskForChatArgs {
  chatId?: string
  workspaceId?: string
}

/**
 * Resolves the `Task` backing a given chat — either because the chat
 * holds the task's anchor message directly (standalone tasks) or
 * because it's the dedicated thread chat that the server spun up for
 * a task created from inside a chat. Returns `null` when the chat is
 * not a task surface.
 *
 * Query args mirror those in `TasksRoute` so RTK Query shares the
 * cache between the two surfaces — opening a task thread chat after
 * visiting the tasks board is free, and the cold path re-uses the
 * same list query on the next /tasks visit.
 */
export function useTaskForChat({ chatId, workspaceId }: UseTaskForChatArgs): Task | null {
  const { developerMode } = usePrefs()
  const wsId = workspaceId ?? ''
  const skipAll = !chatId || !wsId

  const { currentData: tasksResp } = useGetMessagesQuery(
    { workspaceId: wsId, kind: taskMessageKindsForDeveloperMode(developerMode) },
    { skip: skipAll },
  )
  const { currentData: summaryRequestTasksResp } = useGetMessagesQuery(
    {
      workspaceId: wsId,
      kind: summaryRequestMessageKindsForDeveloperMode(developerMode),
      contentKind: ['summary_request'],
    },
    { skip: skipAll || !developerMode },
  )
  const { currentData: taskRunsResp } = useGetMessagesQuery(
    { workspaceId: wsId, kind: taskRunMessageKinds(), limit: 500 },
    { skip: skipAll },
  )
  const { currentData: activeTaskRunsResp } = useGetMessagesQuery(
    { workspaceId: wsId, kind: taskRunMessageKinds(), state: ['running'], limit: 200 },
    { skip: skipAll },
  )

  const { data: serverWorkspaces } = useGetWorkspacesQuery()
  const { currentData: workspaceServerAgents } = useGetWorkspaceAgentsQuery(
    wsId,
    { skip: !wsId },
  )
  const { data: serverAgents } = useGetAgentsQuery(undefined, { skip: !!wsId })
  const { currentData: serverChats } = useGetChatsQuery(
    wsId ? { workspaceId: wsId } : undefined,
    { skip: !wsId },
  )

  return useMemo<Task | null>(() => {
    if (!chatId) return null
    const taskItems = [
      ...(tasksResp?.items ?? []),
      ...(summaryRequestTasksResp?.items ?? []),
    ].filter(m => isTaskListMessageForDeveloperMode(m, developerMode))

    // Match either: the chat carries the anchor (standalone task,
    // no threadChatId) or this is the spawned thread chat.
    const taskMessage = taskItems.find(m =>
      m.threadChatId === chatId || (m.chatId === chatId && !m.threadChatId),
    )
    if (!taskMessage) return null

    const runs: ServerMessage[] = []
    const seen = new Set<string>()
    for (const run of taskRunsResp?.items ?? []) {
      if (run.parentId === taskMessage.id && !seen.has(run.id)) {
        runs.push(run)
        seen.add(run.id)
      }
    }
    for (const run of activeTaskRunsResp?.items ?? []) {
      if (run.parentId === taskMessage.id && !seen.has(run.id)) {
        runs.push(run)
        seen.add(run.id)
      }
    }

    return toUiTask(
      taskMessage,
      workspaceServerAgents ?? serverAgents ?? [],
      serverChats ?? [],
      serverWorkspaces ?? [],
      runs,
    )
  }, [
    chatId,
    developerMode,
    tasksResp?.items,
    summaryRequestTasksResp?.items,
    taskRunsResp?.items,
    activeTaskRunsResp?.items,
    workspaceServerAgents,
    serverAgents,
    serverChats,
    serverWorkspaces,
  ])
}
