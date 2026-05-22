// Chat bridge for the chat-cards app. The iframe runs sandboxed, so card
// "reply" actions go through `window.roomy.chat.sendMessage()` rather than
// posting to the Roomy API directly. Requires the `chats.write` capability.

export interface ChatBridgeClient {
  sendMessage(
    text: string,
    opts?: { artifactRefMessageId?: string },
  ): Promise<unknown>
}

export function getChatClient(): ChatBridgeClient {
  if (!window.roomy?.chat) {
    throw new Error(
      'Roomy chat bridge is unavailable. Is this app running inside Roomy with chats.write?',
    )
  }
  return window.roomy.chat
}

declare global {
  interface Window {
    roomy?: {
      app: { name: string }
      chatId: string
      capabilities: string[]
      chat?: ChatBridgeClient
    }
  }
}
