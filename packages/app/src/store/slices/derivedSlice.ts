/**
 * Client-derived state — counters, in-flight indicators, and the
 * "current user / current chat" pointers that don't belong in any one
 * RTK Query cache.
 *
 * Every field here is either fed by the WS middleware on a specific
 * event (running/failed chat ids, wsKnownChatIds) or mirrored from a
 * fulfilled query (currentUserId from getMe).  Nothing persists — a
 * reload clears the slice and the values rehydrate from server events
 * and fulfilled query results.
 *
 * Roadmap-shaped feature placeholders that previously lived here as
 * an api-gap comment block — folders-as-entity, notes-for-AI
 * sidecars, artifact authorship, "1 update" pills, the compose status
 * sequence — are documented in `roadmap.md` and tracked there.  They
 * are independent features that land with their own DB/API/UI surface
 * rather than client-side shims, so they no longer belong in this
 * file's preamble.
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
  /** Chat IDs whose latest agent turn failed and can be retried. */
  failedChatIds: string[]
  /**
   * Chat IDs that WS has touched (marked running or idle) since the last
   * getChats fulfillment. Guards against both stale-refetch races:
   *   - WS marked idle, server still says running (Race 1)
   *   - WS marked running, server not yet updated (Race 2)
   * For WS-known chats the current running/failed ID values win over the
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
  failedChatIds: [],
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
      state.failedChatIds = state.failedChatIds.filter(id => id !== action.payload)
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
    markChatFailed(state, action: PayloadAction<string>) {
      state.runningChatIds = state.runningChatIds.filter(id => id !== action.payload)
      if (!state.failedChatIds.includes(action.payload)) {
        state.failedChatIds.push(action.payload)
      }
      if (!state.wsKnownChatIds.includes(action.payload)) {
        state.wsKnownChatIds.push(action.payload)
      }
    },
    clearChatFailed(state, action: PayloadAction<string>) {
      state.failedChatIds = state.failedChatIds.filter(id => id !== action.payload)
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
        const chats = action.payload as Array<{ id: string; running?: boolean; failed?: boolean }>
        const wsKnownSet = new Set(state.wsKnownChatIds)
        const chatsById = new Map(chats.map((chat) => [chat.id, chat]))
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

        const runningSet = new Set(state.runningChatIds)
        const failed = new Set(
          chats
            .filter((c) => c.failed && !c.running && !wsKnownSet.has(c.id))
            .map((c) => c.id),
        )
        for (const id of state.failedChatIds) {
          if (wsKnownSet.has(id) && !runningSet.has(id)) failed.add(id)
        }
        state.failedChatIds = Array.from(failed)
        state.wsKnownChatIds = state.wsKnownChatIds.filter((id) => {
          const chat = chatsById.get(id)
          if (!chat) return true
          const serverRunning = !!chat.running
          const serverFailed = !!chat.failed && !serverRunning
          return serverRunning !== runningSet.has(id) || serverFailed !== failed.has(id)
        })
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
        const isFailed = latest?.state === "failed"
        if (latest !== null && !state.wsKnownChatIds.includes(chatId)) {
          state.wsKnownChatIds.push(chatId)
        }
        if (isRunning && !state.runningChatIds.includes(chatId)) {
          state.runningChatIds.push(chatId)
        } else if (!isRunning && state.runningChatIds.includes(chatId)) {
          state.runningChatIds = state.runningChatIds.filter(
            (id) => id !== chatId,
          )
        }
        if (isFailed && !state.failedChatIds.includes(chatId)) {
          state.failedChatIds.push(chatId)
        } else if (!isFailed && state.failedChatIds.includes(chatId)) {
          state.failedChatIds = state.failedChatIds.filter(
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
  markChatFailed,
  clearChatFailed,
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

export const selectFailedChatIds = (s: RootState): string[] =>
  s.derived.failedChatIds

export const selectViewingChatId = (s: RootState): string | null =>
  s.derived.viewingChatId

export const selectCurrentUserId = (s: RootState): string | null =>
  s.derived.currentUserId

export const selectFolders = (_s: RootState): Folder[] => []
export const selectInboxItems = (_s: RootState): InboxItem[] => []
export const selectTodayItems = (_s: RootState): TodayItem[] => []
export const selectRunById = (_s: RootState, _runId: string | undefined): Run | null => null
