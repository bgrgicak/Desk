// Storage client for Desk's parent-mediated app capability bridge. The app
// iframe is sandboxed without same-origin privileges, so persistence must go
// through `window.desk.storage` instead of localStorage, IndexedDB, or direct
// Desk API fetches.

export interface StorageDoc<T = unknown> {
  id: string
  doc: T
  createdAt: number
  updatedAt: number
}

export interface StorageClient {
  list<T = unknown>(collection: string): Promise<StorageDoc<T>[]>
  get<T = unknown>(collection: string, id: string): Promise<StorageDoc<T> | null>
  create<T = unknown>(collection: string, doc: T): Promise<StorageDoc<T>>
  put<T = unknown>(collection: string, id: string, doc: T): Promise<StorageDoc<T>>
  delete(collection: string, id: string): Promise<void>
}

export function getStorageClient(): StorageClient {
  if (!window.desk?.storage) {
    throw new Error('Desk storage bridge is unavailable. Is this app running inside Desk?')
  }
  return window.desk.storage
}

/**
 * Posts a chat message on behalf of the iframe. Used by fragments that ask
 * the user a structured question via UI (yes/no, radio, checkbox, form).
 * Requires the `chats.write` capability.
 */
export interface ChatBridgeClient {
  sendMessage(
    text: string,
    opts?: { artifactRefMessageId?: string },
  ): Promise<unknown>
}

export function getChatClient(): ChatBridgeClient {
  if (!window.desk?.chat) {
    throw new Error('Desk chat bridge is unavailable. Is this app running inside Desk with chats.write?')
  }
  return window.desk.chat
}

declare global {
  interface Window {
    desk?: {
      app: { name: string }
      chatId: string
      capabilities: string[]
      storage?: StorageClient
      chat?: ChatBridgeClient
    }
  }
}
