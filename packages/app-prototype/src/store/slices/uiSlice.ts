import { createSlice, type PayloadAction } from "@reduxjs/toolkit";

export type AppView =
  | "desk"
  | "runs"
  | "context"
  | "today"
  | "chats"
  | "compose";

export interface UiState {
  activeView: AppView;
  activeWorkspaceId: string | null;
  selectedChatId: string | null;
  selectedArtifactPath: string | null;
  artifactTransitionSource: "compose" | "chat" | null;
  selectedContextPath: string | null;
  savedArtifactIds: string[];
  readUpdateIds: string[];
  readChatIds: string[];
  todaySheetOpen: boolean;
  agentationVisible: boolean;
}

const initialState: UiState = {
  activeView: "desk",
  activeWorkspaceId: null,
  selectedChatId: null,
  selectedArtifactPath: null,
  artifactTransitionSource: null,
  selectedContextPath: null,
  savedArtifactIds: [],
  readUpdateIds: [],
  readChatIds: [],
  todaySheetOpen: false,
  agentationVisible: true,
};

const slice = createSlice({
  name: "ui",
  initialState,
  reducers: {
    setActiveView(state, action: PayloadAction<AppView>) {
      state.activeView = action.payload;
    },
    setActiveWorkspaceId(state, action: PayloadAction<string | null>) {
      state.activeWorkspaceId = action.payload;
    },
    setSelectedChatId(state, action: PayloadAction<string | null>) {
      state.selectedChatId = action.payload;
    },
    setSelectedArtifact(
      state,
      action: PayloadAction<{
        path: string | null;
        source?: "compose" | "chat" | null;
      }>,
    ) {
      state.selectedArtifactPath = action.payload.path;
      state.artifactTransitionSource = action.payload.source ?? null;
    },
    setSelectedContext(state, action: PayloadAction<string | null>) {
      state.selectedContextPath = action.payload;
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
    /** Clear artifact + context detail selections (view transitions). */
    clearDetailViews(state) {
      state.selectedArtifactPath = null;
      state.artifactTransitionSource = null;
      state.selectedContextPath = null;
    },
  },
});

export const {
  setActiveView,
  setActiveWorkspaceId,
  setSelectedChatId,
  setSelectedArtifact,
  setSelectedContext,
  markArtifactSaved,
  markUpdateRead,
  markChatRead,
  setTodaySheetOpen,
  setAgentationVisible,
  clearDetailViews,
} = slice.actions;

export default slice.reducer;
