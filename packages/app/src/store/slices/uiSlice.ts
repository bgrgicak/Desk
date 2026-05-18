import { createSlice, type PayloadAction } from "@reduxjs/toolkit";

export type SettingsSection =
  | "workspace"
  | "agents"
  | "connections"
  | "preferences";

export interface UiState {
  artifactTransitionSource: "compose" | "chat" | null;
  artifactBackLabel: string | null;
  savedArtifactIds: string[];
  readUpdateIds: string[];

  todaySheetOpen: boolean;
  /** Agent id carried over from the artifact-creation sheet's "Skip to chat"
   * path, consumed once by ChatView when the new-chat composer mounts. */
  pendingNewChatAgentId: string | null;
  /** Deep-link request from the global palette: open the SettingsModal at
   * the named section. AppShell consumes and clears. */
  pendingSettingsSection: SettingsSection | null;
}

const initialState: UiState = {
  artifactTransitionSource: null,
  artifactBackLabel: null,
  savedArtifactIds: [],
  readUpdateIds: [],

  todaySheetOpen: false,
  pendingNewChatAgentId: null,
  pendingSettingsSection: null,
};

const slice = createSlice({
  name: "ui",
  initialState,
  reducers: {
    setArtifactTransitionSource(
      state,
      action: PayloadAction<"compose" | "chat" | null>,
    ) {
      state.artifactTransitionSource = action.payload;
    },
    setArtifactBackLabel(state, action: PayloadAction<string | null>) {
      state.artifactBackLabel = action.payload;
    },
    markArtifactSaved(state, action: PayloadAction<string>) {
      if (!state.savedArtifactIds.includes(action.payload))
        state.savedArtifactIds.push(action.payload);
    },
    // Bulk variant: callers with a list (e.g. the library-load effect) used
    // to dispatch markArtifactSaved per item, which fanned out into N Redux
    // round-trips, N Immer drafts, and N SerializableStateInvariantMiddleware
    // passes — locking the UI for seconds on large libraries. This collapses
    // the work to a single action.
    markArtifactsSaved(state, action: PayloadAction<string[]>) {
      if (action.payload.length === 0) return;
      const seen = new Set(state.savedArtifactIds);
      for (const id of action.payload) {
        if (seen.has(id)) continue;
        seen.add(id);
        state.savedArtifactIds.push(id);
      }
    },
    markUpdateRead(state, action: PayloadAction<string>) {
      if (!state.readUpdateIds.includes(action.payload))
        state.readUpdateIds.push(action.payload);
    },

    setTodaySheetOpen(state, action: PayloadAction<boolean>) {
      state.todaySheetOpen = action.payload;
    },
    setPendingNewChatAgentId(state, action: PayloadAction<string | null>) {
      state.pendingNewChatAgentId = action.payload;
    },
    setPendingSettingsSection(
      state,
      action: PayloadAction<SettingsSection | null>,
    ) {
      state.pendingSettingsSection = action.payload;
    },
  },
});

export const {
  setArtifactTransitionSource,
  setArtifactBackLabel,
  markArtifactSaved,
  markArtifactsSaved,
  markUpdateRead,

  setTodaySheetOpen,
  setPendingNewChatAgentId,
  setPendingSettingsSection,
} = slice.actions;

export default slice.reducer;
