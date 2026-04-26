import { createSlice, type PayloadAction } from "@reduxjs/toolkit";

export interface UiState {
  artifactTransitionSource: "compose" | "chat" | null;
  savedArtifactIds: string[];
  readUpdateIds: string[];
  readChatIds: string[];
  todaySheetOpen: boolean;
  agentationVisible: boolean;
}

const initialState: UiState = {
  artifactTransitionSource: null,
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
    setArtifactTransitionSource(
      state,
      action: PayloadAction<"compose" | "chat" | null>,
    ) {
      state.artifactTransitionSource = action.payload;
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
  },
});

export const {
  setArtifactTransitionSource,
  markArtifactSaved,
  markUpdateRead,
  markChatRead,
  setTodaySheetOpen,
  setAgentationVisible,
} = slice.actions;

export default slice.reducer;
