/**
 * Client-derived shims for UI concepts the server can't represent yet.
 *
 * Every piece of state here is either fed by the WS middleware (slice 12's
 * work) or derived from other RTK Query caches via selectors. Nothing here
 * persists — a reload clears the slice and the shims re-hydrate from
 * server events.
 *
 * TODO(api-gap): see feature-gap-matrix §4.2 — folders-as-entity,
 * notes-for-AI sidecars, artifact authorship, "1 update" pills, and the
 * compose status sequence all live here until the server exposes them.
 */

import { createSlice, type PayloadAction } from '@reduxjs/toolkit'
import type { RootState } from '../store'
import type {
  ArtifactUpdate,
  Folder,
  InboxItem,
  TodayItem,
  Run,
} from '@/data/ui-types'

export interface DerivedState {
  /**
   * Populated by the WS middleware from `artifact.created` events so the
   * Desk surface can render the "1 update" pill and Today's artifact
   * callouts without a dedicated endpoint. Matrix §4.2.4.
   */
  artifactUpdates: ArtifactUpdate[]
  /**
   * Monotonic counters bumped by the WS middleware on `library.changed`
   * events. Components subscribe to the counter for the file they display
   * and use it as a `useEffect` dependency to re-fetch content when an
   * agent writes new data. Keyed by library path.
   */
  fileChangeCounters: Record<string, number>
}

const initialState: DerivedState = {
  artifactUpdates: [],
  fileChangeCounters: {},
}

const slice = createSlice({
  name: 'derived',
  initialState,
  reducers: {
    /** Called by wsMiddleware on `artifact.created`. */
    pushArtifactUpdate(state, action: PayloadAction<ArtifactUpdate>) {
      const exists = state.artifactUpdates.some(u => u.id === action.payload.id)
      if (!exists) state.artifactUpdates.unshift(action.payload)
    },
    clearArtifactUpdates(state) {
      state.artifactUpdates = []
    },
    /** Called by wsMiddleware on `library.changed`. */
    bumpFileChangeCounter(state, action: PayloadAction<string>) {
      const path = action.payload
      state.fileChangeCounters[path] = (state.fileChangeCounters[path] ?? 0) + 1
    },
  },
})

export const { pushArtifactUpdate, clearArtifactUpdates, bumpFileChangeCounter } = slice.actions
export default slice.reducer

// ── Selectors ────────────────────────────────────────────────────────────────

export const selectArtifactUpdates = (s: RootState): ArtifactUpdate[] =>
  s.derived.artifactUpdates

export const selectFileChangeCounter = (s: RootState, path: string): number =>
  s.derived.fileChangeCounters[path] ?? 0

/**
 * Folders view of the library.
 *
 * TODO(api-gap): derive from library path prefixes (e.g. `work/finance/*.md`
 * → {id: 'work/finance', name: 'finance'}). Returning `[]` for now keeps
 * the Library surface flat — matrix §4.2.1.
 */
export const selectFolders = (_s: RootState): Folder[] => []

/**
 * Inbox items. Awaiting-user messages now arrive from
 * `useGetMessagesQuery({ awaitingUser: true })`, so selecting from the API
 * cache here would duplicate caching. Components call the query directly
 * and pass through `toInboxItem`; this selector returns `[]` as a safety
 * net while the shape stabilises — matrix §4.3.6.
 */
export const selectInboxItems = (_s: RootState): InboxItem[] => []

/**
 * Today items. The 7 client-side TodayItemType categories collapse onto
 * `awaitingUser` + content kind once wired. Selector returns `[]` until
 * the mapping is finalised (slice 6 covers the direct awaiting-user path;
 * matrix §4.3.6 tracks the rest).
 */
export const selectTodayItems = (_s: RootState): TodayItem[] => []

/**
 * Lookup for a run by id. Used by Inbox / Today to show a run title on
 * an agent question card. Runs live in the RTK Query cache; this helper
 * returns `null` until the lookup is needed — then a component should
 * select the matching run from `useGetMessagesQuery({ scheduled: true })`
 * results. Matrix §4.3.5.
 */
export const selectRunById = (_s: RootState, _runId: string | undefined): Run | null => null
