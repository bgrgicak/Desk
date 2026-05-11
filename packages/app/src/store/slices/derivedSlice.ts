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

import { createSlice, type PayloadAction } from "@reduxjs/toolkit"
import { api } from "../api"
import type { RootState } from "../store"
import type {
  ArtifactUpdate,
  Folder,
  InboxItem,
  TodayItem,
  Run,
} from "@/data/ui-types"

export interface DerivedState {
  artifactUpdates: ArtifactUpdate[]
  fileChangeCounters: Record<string, number>
  workspaceChangeCounters: Record<string, number>
  /**
   * Chat IDs that currently have an active agent turn (pending or running).
   * Fed by the WS middleware on message.appended / message.updated events
   * for agent_turn messages. The sidebar uses this to show a spinning
   * indicator.
   */
  runningChatIds: string[]
  /**
   * Chat IDs that WS has touched (marked running or idle) since the last
   * getChats fulfillment. Guards against both stale-refetch races:
   *   - WS marked idle, server still says running (Race 1)
   *   - WS marked running, server not yet updated (Race 2)
   * For WS-known chats the current runningChatIds value wins over the
   * server snapshot. Cleared after each matchFulfilled processes it.
   */
  wsKnownChatIds: string[]
  viewingChatId: string | null
  /**
   * Current user ID, mirrored from the most recent fulfilled `getMe` query.
   * Lets the WS middleware identify the local user without poking RTK
   * Query's internal cache shape.
   */
  currentUserId: string | null
}

const initialState: DerivedState = {
  artifactUpdates: [],
  fileChangeCounters: {},
  workspaceChangeCounters: {},
  runningChatIds: [],
  wsKnownChatIds: [],
  viewingChatId: null,
  currentUserId: null,
}

const slice = createSlice({
  name: "derived",
  initialState,
  reducers: {
    pushArtifactUpdate(state, action: PayloadAction<ArtifactUpdate>) {
      const exists = state.artifactUpdates.some(u => u.id === action.payload.id)
      if (!exists) state.artifactUpdates.unshift(action.payload)
    },
    clearArtifactUpdates(state) {
      state.artifactUpdates = []
    },
    bumpFileChangeCounter(state, action: PayloadAction<string>) {
      const path = action.payload
      state.fileChangeCounters[path] = (state.fileChangeCounters[path] ?? 0) + 1
    },
    bumpWorkspaceChangeCounter(state, action: PayloadAction<string>) {
      const wsId = action.payload
      state.workspaceChangeCounters[wsId] = (state.workspaceChangeCounters[wsId] ?? 0) + 1
    },
    markChatRunning(state, action: PayloadAction<string>) {
      if (!state.runningChatIds.includes(action.payload)) {
        state.runningChatIds.push(action.payload)
      }
      if (!state.wsKnownChatIds.includes(action.payload)) {
        state.wsKnownChatIds.push(action.payload)
      }
    },
    markChatIdle(state, action: PayloadAction<string>) {
      state.runningChatIds = state.runningChatIds.filter(id => id !== action.payload)
      if (!state.wsKnownChatIds.includes(action.payload)) {
        state.wsKnownChatIds.push(action.payload)
      }
    },
    setViewingChat(state, action: PayloadAction<string | null>) {
      state.viewingChatId = action.payload
    },
    clearWsKnownChatIds(state) {
      state.wsKnownChatIds = []
    },
  },
  extraReducers: (builder) => {
    builder.addMatcher(
      api.endpoints.getChats.matchFulfilled,
      (state, action) => {
        const chats = action.payload as Array<{ id: string; running?: boolean }>
        const wsKnownSet = new Set(state.wsKnownChatIds)
        // For non-WS-known chats, trust the server snapshot.
        const merged = new Set(
          chats.filter((c) => c.running && !wsKnownSet.has(c.id)).map((c) => c.id),
        )
        // For WS-known chats, preserve whatever the WS said last (current
        // runningChatIds reflects that). This handles both Race 1 (WS idle,
        // stale server says running) and Race 2 (WS running, stale server
        // says not running).
        for (const id of state.runningChatIds) {
          if (wsKnownSet.has(id)) merged.add(id)
        }
        state.runningChatIds = Array.from(merged)
        state.wsKnownChatIds = []
      },
    )

    builder.addMatcher(
      api.endpoints.getMe.matchFulfilled,
      (state, action) => {
        state.currentUserId = action.payload?.id ?? null
      },
    )

    builder.addMatcher(
      api.endpoints.getChatMessages.matchFulfilled,
      (state, action) => {
        // Skip scrollback (before-cursor) loads: older pages don't contain the
        // running agent_turn, so updating state from them calls markChatIdle
        // while the agent is still active at the bottom of the thread.
        if (action.meta.arg.originalArgs.before) return
        const chatId = action.meta.arg.originalArgs.chatId
        const agentTurns = action.payload.items.filter(
          (m) => m.content?.type === "agent_turn",
        )
        const latest = agentTurns.length > 0 ? agentTurns[agentTurns.length - 1] : null
        const isRunning = latest !== null &&
          (latest.state === "pending" || latest.state === "running")
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

export const {
  pushArtifactUpdate,
  clearArtifactUpdates,
  bumpFileChangeCounter,
  bumpWorkspaceChangeCounter,
  markChatRunning,
  markChatIdle,
  setViewingChat,
  clearWsKnownChatIds,
} = slice.actions
export default slice.reducer

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

export const selectCurrentUserId = (s: RootState): string | null =>
  s.derived.currentUserId

export const selectFolders = (_s: RootState): Folder[] => []
export const selectInboxItems = (_s: RootState): InboxItem[] => []
export const selectTodayItems = (_s: RootState): TodayItem[] => []
export const selectRunById = (_s: RootState, _runId: string | undefined): Run | null => null
