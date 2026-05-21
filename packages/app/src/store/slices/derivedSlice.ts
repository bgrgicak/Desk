/**
 * Client-derived state — counters, in-flight indicators, and the
 * "current user / current chat" pointers that don't belong in any one
 * RTK Query cache.
 *
 * Every field here is either fed by the WS middleware on a specific
 * event or mirrored from a fulfilled query (currentUserId from getMe).
 * Nothing persists — a reload clears the slice and the values
 * rehydrate from server events and fulfilled query results.
 *
 * The previous `runningChatIds` / `failedChatIds` / `wsKnownChatIds`
 * machinery is gone: the chat's running/failed state is now computed
 * live on the server (queries/chats.ts) and carried by every
 * `chat.updated` WS payload, so the sidebar reads `chat.running`
 * directly from the `getChats` cache instead of reconciling three
 * shadow representations.
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
    setViewingChat(state, action: PayloadAction<string | null>) {
      state.viewingChatId = action.payload
    },
  },
  extraReducers: (builder) => {
    builder.addMatcher(
      api.endpoints.getMe.matchFulfilled,
      (state, action) => {
        state.currentUserId = action.payload?.id ?? null
      },
    )
  },
})

export const {
  pushArtifactUpdate,
  clearArtifactUpdates,
  bumpFileChangeCounter,
  bumpWorkspaceChangeCounter,
  setViewingChat,
} = slice.actions
export default slice.reducer

export const selectArtifactUpdates = (s: RootState): ArtifactUpdate[] =>
  s.derived.artifactUpdates

export const selectFileChangeCounter = (s: RootState, path: string): number =>
  s.derived.fileChangeCounters[path] ?? 0

export const selectWorkspaceChangeCounter = (s: RootState, wsId: string): number =>
  s.derived.workspaceChangeCounters[wsId] ?? 0

export const selectViewingChatId = (s: RootState): string | null =>
  s.derived.viewingChatId

export const selectCurrentUserId = (s: RootState): string | null =>
  s.derived.currentUserId

export const selectFolders = (_s: RootState): Folder[] => []
export const selectInboxItems = (_s: RootState): InboxItem[] => []
export const selectTodayItems = (_s: RootState): TodayItem[] => []
export const selectRunById = (_s: RootState, _runId: string | undefined): Run | null => null
