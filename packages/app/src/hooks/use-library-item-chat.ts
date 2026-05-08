export { serverMessageToChatMessage } from './use-server-chat'
import { useServerChat, type UseServerChatReturn } from './use-server-chat'

export function useLibraryItemChat(
  workspaceId: string | undefined,
  itemPath: string,
): UseServerChatReturn {
  const storageKey = workspaceId && itemPath ? `library-chat:${workspaceId}:${itemPath}` : ''
  return useServerChat(
    workspaceId,
    storageKey,
    itemPath,
    itemPath ? [{ path: itemPath, name: itemPath.split('/').pop() ?? itemPath }] : undefined,
  )
}
