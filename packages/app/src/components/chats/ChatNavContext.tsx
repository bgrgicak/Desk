import { createContext, useContext } from 'react'

export interface ChatNavContextValue {
  buildThreadHref: (chatId: string) => string | undefined
  buildNewThreadHref: (sourceChatId: string, messageId: string) => string | undefined
  buildParentHref?: (
    parentChatId: string,
    anchorMessageId: string | undefined,
    parentWorkspaceId: string,
  ) => string
}

export const ChatNavContext = createContext<ChatNavContextValue>({
  buildThreadHref: () => undefined,
  buildNewThreadHref: () => undefined,
})

export function useChatNav() {
  return useContext(ChatNavContext)
}
