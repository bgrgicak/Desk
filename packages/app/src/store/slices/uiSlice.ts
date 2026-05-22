import { createSlice, type PayloadAction } from "@reduxjs/toolkit";

export type SettingsSection =
  | "account"
  | "models"
  | "workspace"
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
  /** Deep-link request from the global palette: open the matching account
   * or workspace settings modal at the named section. AppShell consumes and
   * clears. */
  pendingSettingsSection: SettingsSection | null;
  /** Per-user vault password dialog. Driven by VaultGate on app load and
   * by mutation error handlers that catch HTTP 423 (VAULT_LOCKED). When
   * `forced` is true the user cannot dismiss the dialog (it's the app
   * gate); otherwise it can be cancelled. */
  vaultDialog: { open: boolean; forced: boolean };
}

const initialState: UiState = {
  artifactTransitionSource: null,
  artifactBackLabel: null,
  savedArtifactIds: [],
  readUpdateIds: [],

  todaySheetOpen: false,
  pendingNewChatAgentId: null,
  pendingSettingsSection: null,
  vaultDialog: { open: false, forced: false },
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
    openVaultDialog(
      state,
      action: PayloadAction<{ forced?: boolean } | undefined>,
    ) {
      state.vaultDialog = {
        open: true,
        // forced sticks once set — a save-triggered open shouldn't
        // downgrade a gate-driven force, and a gate render shouldn't
        // accidentally trap a user who opened the dialog manually.
        forced: action.payload?.forced ?? state.vaultDialog.forced,
      };
    },
    closeVaultDialog(state) {
      state.vaultDialog = { open: false, forced: false };
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
  openVaultDialog,
  closeVaultDialog,
} = slice.actions;

export default slice.reducer;
