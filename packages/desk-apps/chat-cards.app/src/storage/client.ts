// Chat bridge for the chat-cards app. The iframe runs sandboxed, so card
// "reply" actions go through `window.desk.chat.sendMessage()` rather than
// posting to the Desk API directly. Requires the `chats.write` capability.

export interface ChatBridgeClient {
  sendMessage(
    text: string,
    opts?: { artifactRefMessageId?: string },
  ): Promise<unknown>
}

export function getChatClient(): ChatBridgeClient {
  if (!window.desk?.chat) {
    throw new Error(
      'Desk chat bridge is unavailable. Is this app running inside Desk with chats.write?',
    )
  }
  return window.desk.chat
}

declare global {
  interface Window {
    desk?: {
      app: { name: string }
      chatId: string
      capabilities: string[]
      chat?: ChatBridgeClient
    }
  }
}
