import { useEffect } from 'react'
import type { Task } from '@/data/ui-types'
import type { ServerMessage, ServerWorkspace } from '@/store/types'
import { useGetMessagesQuery } from '@/store/api'
import { toUiTask, taskMessageKindsForDeveloperMode } from '@/store/selectors/tasks'
import { roomColor } from '@/components/rooms/roomColor'
import { usePrefs } from '@/hooks/use-prefs'
import { useWorkspaceIconUrl } from '@/hooks/use-workspace-icon'

export interface HomeTask {
  task: Task
  roomName: string
  roomColor: string
  /** Resolved icon URL for the owning workspace, or `null` if the
   *  workspace has no custom icon (TaskCard then renders a colored
   *  ring instead, mirroring the sidebar). */
  roomIconUrl: string | null
  workspaceId: string
}

export interface HomeWorkspaceBuckets {
  needsInput: HomeTask[]
  active: HomeTask[]
  done: HomeTask[]
}

const EMPTY: HomeWorkspaceBuckets = { needsInput: [], active: [], done: [] }

/**
 * Headless per-workspace task fetcher. `ServerMessage` carries no
 * `workspaceId` and there's no global chats query, so we resolve room
 * identity by scoping one of these per workspace (mirrors the
 * `HomeRoomItem` badge pattern). Reports its three buckets up to Home,
 * which merges + recency-sorts across rooms.
 */
export function HomeWorkspaceTasks({
  workspace,
  onTasks,
}: {
  workspace: ServerWorkspace
  onTasks: (workspaceId: string, buckets: HomeWorkspaceBuckets) => void
}) {
  const { developerMode } = usePrefs()
  const kind = taskMessageKindsForDeveloperMode(developerMode)
  const iconUrl = useWorkspaceIconUrl(workspace.id)

  const { currentData: needsInputResp } = useGetMessagesQuery({
    workspaceId: workspace.id,
    kind,
    // Trunk renamed `awaitingUser` → `unread` and tightened the
    // semantics: unread now flips only on agent-authored visible
    // rows, which is exactly the "Needs your input" signal we want.
    unread: true,
  })
  const { currentData: activeResp } = useGetMessagesQuery({
    workspaceId: workspace.id,
    kind,
    state: ['running'],
  })
  const { currentData: doneResp } = useGetMessagesQuery({
    workspaceId: workspace.id,
    kind,
    state: ['succeeded', 'cancelled'],
  })

  useEffect(() => {
    const tint = roomColor(workspace.color)
    const toHomeTasks = (items: ServerMessage[] | undefined): HomeTask[] =>
      (items ?? []).map(m => ({
        task: toUiTask(m, [], [], [workspace], []),
        roomName: workspace.name,
        roomColor: tint,
        roomIconUrl: iconUrl,
        workspaceId: workspace.id,
      }))

    const buckets: HomeWorkspaceBuckets =
      !needsInputResp && !activeResp && !doneResp
        ? EMPTY
        : {
            needsInput: toHomeTasks(needsInputResp?.items),
            active: toHomeTasks(activeResp?.items),
            done: toHomeTasks(doneResp?.items),
          }
    onTasks(workspace.id, buckets)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [needsInputResp, activeResp, doneResp, workspace.id, workspace.name, workspace.color, iconUrl])

  return null
}
