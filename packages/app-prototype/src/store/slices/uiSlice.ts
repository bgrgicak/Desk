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
  readChatIds: string[];
  todaySheetOpen: boolean;
  agentationVisible: boolean;
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
  readChatIds: [],
  todaySheetOpen: false,
  agentationVisible: true,
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
    markUpdateRead(state, action: PayloadAction<string>) {
      if (!state.readUpdateIds.includes(action.payload))
        state.readUpdateIds.push(action.payload);
    },
    markChatRead(state, action: PayloadAction<string>) {
      if (!state.readChatIds.includes(action.payload))
        state.readChatIds.push(action.payload);
    },
    setTodaySheetOpen(state, action: PayloadAction<boolean>) {
      state.todaySheetOpen = action.payload;
    },
    setAgentationVisible(state, action: PayloadAction<boolean>) {
      state.agentationVisible = action.payload;
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
  markUpdateRead,
  markChatRead,
  setTodaySheetOpen,
  setAgentationVisible,
  setPendingNewChatAgentId,
  setPendingSettingsSection,
} = slice.actions;

export default slice.reducer;
