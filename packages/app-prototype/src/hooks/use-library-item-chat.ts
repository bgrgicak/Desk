export { serverMessageToChatMessage } from './use-server-chat'
import { useServerChat } from './use-server-chat'
import type { ChatMessage } from '@/data/ui-types'

interface UseLibraryItemChatReturn {
  messages: ChatMessage[]
  isTyping: boolean
  agentModel: string
  sendMessage: (content: string) => Promise<void>
}

/**
 * Backs the ConversationPanel with a real server chat for a library item.
 * Every outgoing message automatically attaches the open file so the agent
 * always has the current content in context. The chat id is persisted in
 * localStorage so the conversation survives page reloads.
 */
export function useLibraryItemChat(
  workspaceId: string | undefined,
  itemPath: string,
): UseLibraryItemChatReturn {
  return useServerChat(
    workspaceId,
    workspaceId && itemPath ? `desk.libchat.${workspaceId}.${itemPath}` : '',
    itemPath,
    itemPath ? [{ path: itemPath, name: itemPath.split('/').pop() ?? itemPath }] : undefined,
  )
}
