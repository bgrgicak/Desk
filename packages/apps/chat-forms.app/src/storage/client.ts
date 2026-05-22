// Storage client for Roomy's parent-mediated app capability bridge. The app
// iframe is sandboxed without same-origin privileges, so persistence must go
// through `window.roomy.storage` instead of localStorage, IndexedDB, or direct
// Roomy API fetches.

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
  if (!window.roomy?.storage) {
    throw new Error('Roomy storage bridge is unavailable. Is this app running inside Roomy?')
  }
  return window.roomy.storage
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
  if (!window.roomy?.chat) {
    throw new Error('Roomy chat bridge is unavailable. Is this app running inside Roomy with chats.write?')
  }
  return window.roomy.chat
}

declare global {
  interface Window {
    roomy?: {
      app: { name: string }
      chatId: string
      capabilities: string[]
      storage?: StorageClient
      chat?: ChatBridgeClient
    }
  }
}
