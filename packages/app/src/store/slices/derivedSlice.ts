/**
 * Client-derived shims for UI concepts the server can't represent yet.
 *
 * Every piece of state here is either fed by the WS middleware (slice 12's
 * work) or derived from other RTK Query caches via selectors and matchers.
 * Nothing here persists — a reload clears the slice and the shims
 * re-hydrate from server events and fulfilled query results.
 *
 * TODO(api-gap): see feature-gap-matrix §4.2 — folders-as-entity,
 * notes-for-AI sidecars, artifact authorship, "1 update" pills, and the
 * compose status sequence all live here until the server exposes them.
 */

import { createSlice, type PayloadAction } from '@reduxjs/toolkit'
import { api } from '../api'
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
  /**
   * Bumped on `workspace.synced` events (emitted after every agent run).
   * `ContextDetail` includes this in its fetch effect deps so the open file
   * re-fetches automatically when an agent run completes. Keyed by workspaceId.
   */
  workspaceChangeCounters: Record<string, number>
  /**
   * Chat IDs that currently have an active agent turn (pending or running).
   * Fed by the WS middleware on `message.appended` / `message.updated`
   * events for `agent_turn` messages. The sidebar uses this to show a
   * spinning indicator.
   */
  runningChatIds: string[]
  /**
   * The chat the user is currently viewing. Set by ChatView on mount,
   * cleared on unmount. The WS middleware uses this to suppress the
   * unread-dot flash: messages arriving for the viewed chat don't flip
   * `unread` in the RTK Query cache because the user is already reading.
   */
  viewingChatId: string | null
}

const initialState: DerivedState = {
  artifactUpdates: [],
  fileChangeCounters: {},
  workspaceChangeCounters: {},
  runningChatIds: [],
  viewingChatId: null,
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
    /** Called by wsMiddleware on `workspace.synced`. */
    bumpWorkspaceChangeCounter(state, action: PayloadAction<string>) {
      const wsId = action.payload
      state.workspaceChangeCounters[wsId] = (state.workspaceChangeCounters[wsId] ?? 0) + 1
    },
    /** Called by wsMiddleware when an agent_turn message enters pending/running. */
    markChatRunning(state, action: PayloadAction<string>) {
      if (!state.runningChatIds.includes(action.payload)) {
        state.runningChatIds.push(action.payload)
      }
    },
    /** Called by wsMiddleware when an agent_turn message leaves pending/running. */
    markChatIdle(state, action: PayloadAction<string>) {
      state.runningChatIds = state.runningChatIds.filter(id => id !== action.payload)
    },
    /** Called by ChatView on mount/unmount to track which chat the user is viewing. */
    setViewingChat(state, action: PayloadAction<string | null>) {
      state.viewingChatId = action.payload
    },
  },
  extraReducers: (builder) => {
    // ── Cold-start hydration from chat list ────────────────────────────
    // The /chats endpoint includes a derived `running` boolean per chat.
    // When getChats fulfills (app boot, refetch), seed `runningChatIds`
    // from the server response so the sidebar spinner appears immediately
    // without waiting for WS events.
    builder.addMatcher(
      api.endpoints.getChats.matchFulfilled,
      (state, action) => {
        const chats = action.payload as Array<{ id: string; running?: boolean }>
        const serverRunning = new Set(
          chats.filter((c) => c.running).map((c) => c.id),
        )
        // Add newly-running chats the slice didn't know about yet.
        for (const id of serverRunning) {
          if (!state.runningChatIds.includes(id)) {
            state.runningChatIds.push(id)
          }
        }
        // Remove chats the server says are no longer running, unless a
        // more-recent WS event already marked them running again (which
        // would be odd but defensive).
        state.runningChatIds = state.runningChatIds.filter(
          (id) => serverRunning.has(id),
        )
      },
    )

    // ── Per-chat hydration from message fetch ─────────────────────────
    // When a user opens a chat, getChatMessages fulfills. Check the most
    // recent agent_turn to correct stale running state (e.g. if a WS
    // event was missed). Only the latest agent_turn matters — older
    // orphaned turns shouldn't light up the spinner.
    builder.addMatcher(
      api.endpoints.getChatMessages.matchFulfilled,
      (state, action) => {
        const chatId = action.meta.arg.originalArgs.chatId
        const agentTurns = action.payload.items.filter(
          (m) => m.content?.type === 'agent_turn',
        )
        // Messages are ordered by created_at; the last one is the newest.
        const latest = agentTurns.length > 0 ? agentTurns[agentTurns.length - 1] : null
        const isRunning = latest !== null &&
          (latest.state === 'pending' || latest.state === 'running')
        if (isRunning && !state.runningChatIds.includes(chatId)) {
          state.runningChatIds.push(chatId)
        } else if (!isRunning && state.runningChatIds.includes(chatId)) {
          state.runningChatIds = state.runningChatIds.filter(
            (id) => id !== chatId,
          )
        }
      },
    )
  },
})

export const { pushArtifactUpdate, clearArtifactUpdates, bumpFileChangeCounter, bumpWorkspaceChangeCounter, markChatRunning, markChatIdle, setViewingChat } = slice.actions
export default slice.reducer

// ── Selectors ────────────────────────────────────────────────────────────────

export const selectArtifactUpdates = (s: RootState): ArtifactUpdate[] =>
  s.derived.artifactUpdates

export const selectFileChangeCounter = (s: RootState, path: string): number =>
  s.derived.fileChangeCounters[path] ?? 0

export const selectWorkspaceChangeCounter = (s: RootState, wsId: string): number =>
  s.derived.workspaceChangeCounters[wsId] ?? 0

export const selectRunningChatIds = (s: RootState): string[] =>
  s.derived.runningChatIds

export const selectViewingChatId = (s: RootState): string | null =>
  s.derived.viewingChatId

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
