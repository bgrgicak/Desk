// Storage client placeholder. The full per-app storage CRUD lands in PR-H
// (issue #47). The shape is intentionally narrow so fragments and the full
// app can share a single import site once the bridge is wired.
//
// Until then, callers should treat any method here as throwing — they
// shouldn't be invoked yet. The agent that authors a real app should
// replace this file once the storage capability is enabled.

export interface StorageDoc<T = unknown> {
  id: string
  doc: T
  createdAt: number
  updatedAt: number
}

/**
 * @deprecated Until PR-H (issue #47). Methods throw at runtime — the
 * import site is stable so PR-H can fill it in without churning the
 * scaffold, but invoking any method today is a bug.
 */
export interface StorageClient {
  list<T = unknown>(collection: string): Promise<StorageDoc<T>[]>
  get<T = unknown>(collection: string, id: string): Promise<StorageDoc<T> | null>
  create<T = unknown>(collection: string, doc: T): Promise<StorageDoc<T>>
  put<T = unknown>(collection: string, id: string, doc: T): Promise<StorageDoc<T>>
  delete(collection: string, id: string): Promise<void>
}

/**
 * @deprecated Until PR-H (issue #47). Returns a client whose methods
 * throw — do not invoke from a fragment yet.
 */
export function getStorageClient(): StorageClient {
  return new NotYetWiredClient()
}

class NotYetWiredClient implements StorageClient {
  async list(): Promise<never> { throw notWired() }
  async get(): Promise<never> { throw notWired() }
  async create(): Promise<never> { throw notWired() }
  async put(): Promise<never> { throw notWired() }
  async delete(): Promise<never> { throw notWired() }
}

function notWired(): Error {
  return new Error(
    'Per-app storage is not yet enabled (PR-H, issue #47). ' +
    'Until the capability bridge is in place, do not call storage from a fragment.'
  )
}
