import { useEffect, useState } from 'react'

// "Show in Home" — a client-side set of entities (files, artifacts,
// chats, tasks) the user has chosen to surface in the Home screen's
// Favorites section. Prototype only: localStorage-backed, mirrors the
// `use-workspace-icon` / `use-avatar` pattern (single key + change
// event + storage event so it stays live across tabs and components).
//
// TODO(backend): replace the storage read/writes with a real
// per-user "home favorites" API; the hook/helper surface stays the same.

export type HomePinKind = 'file' | 'artifact' | 'chat' | 'task'

export interface HomePinRef {
  kind: HomePinKind
  /** Entity id: library path (file/artifact), chat id, or task message id. */
  id: string
  /** Owning workspace, when the entity is workspace-scoped. */
  workspaceId?: string
  /** Human label for the Favorites row. */
  label: string
}

const KEY = 'desk.home-pins.v1'
const CHANGE_EVENT = 'desk:home-pins-changed'

function refKey(kind: HomePinKind, id: string): string {
  return `${kind}:${id}`
}

function read(): HomePinRef[] {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? (parsed as HomePinRef[]) : []
  } catch {
    return []
  }
}

function write(refs: HomePinRef[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(refs))
    window.dispatchEvent(new CustomEvent(CHANGE_EVENT))
  } catch {
    /* ignore — quota / unavailable */
  }
}

/** Live list of pinned entities (most-recently-added first). */
export function useHomePins(): HomePinRef[] {
  const [refs, setRefs] = useState<HomePinRef[]>(() => read())
  useEffect(() => {
    const sync = () => setRefs(read())
    sync()
    window.addEventListener(CHANGE_EVENT, sync)
    window.addEventListener('storage', sync)
    return () => {
      window.removeEventListener(CHANGE_EVENT, sync)
      window.removeEventListener('storage', sync)
    }
  }, [])
  return refs
}

/** Reactive boolean for a single entity (for kebab toggle labels). */
export function useIsHomePinned(kind: HomePinKind, id: string): boolean {
  const refs = useHomePins()
  return refs.some(r => r.kind === kind && r.id === id)
}

export function isHomePinned(kind: HomePinKind, id: string): boolean {
  return read().some(r => r.kind === kind && r.id === id)
}

export function addHomePin(ref: HomePinRef): void {
  const refs = read().filter(r => refKey(r.kind, r.id) !== refKey(ref.kind, ref.id))
  write([ref, ...refs])
}

export function removeHomePin(kind: HomePinKind, id: string): void {
  write(read().filter(r => !(r.kind === kind && r.id === id)))
}

/** Add if absent, remove if present. Returns the new pinned state. */
export function toggleHomePin(ref: HomePinRef): boolean {
  if (isHomePinned(ref.kind, ref.id)) {
    removeHomePin(ref.kind, ref.id)
    return false
  }
  addHomePin(ref)
  return true
}
