import { useMemo } from 'react'
import { ChatView } from '@/components/chats/ChatView'
import { useGetAskAiChatQuery } from '@/store/api'
import { toUiChat } from '@/store/selectors/chats'

/**
 * The Home "Ask AI" surface — a thin wrapper that fetches the well-known
 * per-user chat via /me/ask-ai-chat and hands it to the regular ChatView.
 * Everything else (message rendering, composer, live updates, file panel,
 * top-bar actions) follows the same code path as any other chat — the hub
 * workspace backing this chat is now reachable through the regular
 * workspace endpoints, so no special-casing is needed.
 */
export function AskAiView() {
  const { data: askAiServerChat } = useGetAskAiChatQuery()
  const askAiChat = useMemo(
    () => (askAiServerChat ? toUiChat(askAiServerChat) : null),
    [askAiServerChat],
  )

  if (!askAiChat) {
    return <div className="flex h-full min-h-0 w-full flex-col" />
  }

  return <ChatView chat={askAiChat} />
}
