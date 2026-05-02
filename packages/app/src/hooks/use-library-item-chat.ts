export { serverMessageToChatMessage } from './use-server-chat'
import { useServerChat, type UseServerChatReturn } from './use-server-chat'

export function useLibraryItemChat(
  workspaceId: string | undefined,
  itemPath: string,
): UseServerChatReturn {
  return useServerChat(
    workspaceId,
    '',
    itemPath,
    itemPath ? [{ path: itemPath, name: itemPath.split('/').pop() ?? itemPath }] : undefined,
  )
}
