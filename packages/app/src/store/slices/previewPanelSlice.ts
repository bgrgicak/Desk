import { createSlice, type PayloadAction } from "@reduxjs/toolkit";

/**
 * Identity of an artifact currently mounted in the right-side preview
 * panel. Mirrors the shape of `MessageContent['artifactRef']` minus the
 * `type` discriminator — anything that can be inline-referenced by a
 * chat message can also be opened in the panel.
 */
export interface PreviewArtifact {
  workspaceId: string;
  path: string;
  name: string;
  mime?: string | null;
  params?: Record<string, string>;
}

interface PreviewPanelState {
  /** `null` = panel closed. Setting this to an artifact opens the
   *  panel and replaces the chat right-panel column. */
  artifact: PreviewArtifact | null;
  /**
   * Fraction of the available content width given to the chat column
   * (0..1). Panel takes `1 - splitRatio`. Default 0.35 → ~35 % chat,
   * 65 % panel. Persisted to localStorage (Phase 2b) but lives here
   * so any component can react to user resizes.
   */
  splitRatio: number;
  /**
   * Library file-detail split: fraction of the content width given to
   * the **file preview** card (the left, growing pane). The chat
   * panel on the right takes `1 - libraryDetailSplitRatio`. This is
   * the inverse role of `splitRatio` (there the left pane is the
   * chat). Default 0.65 mirrors the Figma 928/1440 file vs 512/1440
   * chat split. Persisted under its own storage key so resizing a
   * Library file doesn't move the chat-view preview split.
   */
  libraryDetailSplitRatio: number;
  /**
   * Tasks view split: fraction of the content width given to the
   * **task list** (the left, growing pane). The chat sidebar on the
   * right takes `1 - tasksSplitRatio`. Same role as
   * `libraryDetailSplitRatio` (left pane grows); own storage key so
   * Tasks and the Library detail remember their splits separately.
   * Default 0.5 mirrors the Figma 720/720.
   */
  tasksSplitRatio: number;
}

const DEFAULT_SPLIT_RATIO = 0.35;
const SPLIT_RATIO_STORAGE_KEY = "roomy.previewPanel.splitRatio";
const DEFAULT_LIBRARY_DETAIL_SPLIT_RATIO = 0.65;
const LIBRARY_DETAIL_SPLIT_RATIO_STORAGE_KEY =
  "roomy.libraryDetail.splitRatio";
const DEFAULT_TASKS_SPLIT_RATIO = 0.5;
const TASKS_SPLIT_RATIO_STORAGE_KEY = "roomy.tasks.splitRatio";

/**
 * Read a previously-saved split ratio from localStorage so resizing
 * persists across reloads. Falls back to `fallback` whenever storage
 * is unavailable (SSR, locked browsers, parse error) or the stored
 * value is out of the sane [0.1, 0.9] range.
 */
function readStoredRatio(key: string, fallback: number): number {
  if (typeof window === "undefined") return fallback;
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return fallback;
    const v = parseFloat(raw);
    return Number.isFinite(v) && v >= 0.1 && v <= 0.9 ? v : fallback;
  } catch {
    return fallback;
  }
}

const initialState: PreviewPanelState = {
  artifact: null,
  splitRatio: readStoredRatio(SPLIT_RATIO_STORAGE_KEY, DEFAULT_SPLIT_RATIO),
  libraryDetailSplitRatio: readStoredRatio(
    LIBRARY_DETAIL_SPLIT_RATIO_STORAGE_KEY,
    DEFAULT_LIBRARY_DETAIL_SPLIT_RATIO,
  ),
  tasksSplitRatio: readStoredRatio(
    TASKS_SPLIT_RATIO_STORAGE_KEY,
    DEFAULT_TASKS_SPLIT_RATIO,
  ),
};

const slice = createSlice({
  name: "previewPanel",
  initialState,
  reducers: {
    openArtifact(state, action: PayloadAction<PreviewArtifact>) {
      state.artifact = action.payload;
    },
    closeArtifact(state) {
      state.artifact = null;
    },
    setSplitRatio(state, action: PayloadAction<number>) {
      // Clamp to [0.1, 0.9] as a coarse safety net — the per-viewport
      // min-width clamps live in the resize handler (it knows the
      // actual pixel widths).
      state.splitRatio = Math.min(0.9, Math.max(0.1, action.payload));
    },
    setLibraryDetailSplitRatio(state, action: PayloadAction<number>) {
      state.libraryDetailSplitRatio = Math.min(
        0.9,
        Math.max(0.1, action.payload),
      );
    },
    setTasksSplitRatio(state, action: PayloadAction<number>) {
      state.tasksSplitRatio = Math.min(0.9, Math.max(0.1, action.payload));
    },
  },
});

export const {
  openArtifact,
  closeArtifact,
  setSplitRatio,
  setLibraryDetailSplitRatio,
  setTasksSplitRatio,
} = slice.actions;
export default slice.reducer;

/** Storage key for the persisted split ratio — exported so the drag
 *  handler in AppShell can write to the same slot the slice reads
 *  from on init. */
export const PREVIEW_SPLIT_RATIO_STORAGE_KEY = SPLIT_RATIO_STORAGE_KEY;
/** Storage key for the Library file-detail split ratio (separate from
 *  the chat preview split so the two surfaces remember their own
 *  proportions independently). */
export const LIBRARY_DETAIL_SPLIT_RATIO_STORAGE_KEY_EXPORT =
  LIBRARY_DETAIL_SPLIT_RATIO_STORAGE_KEY;
/** Storage key for the Tasks split ratio. */
export const TASKS_SPLIT_RATIO_STORAGE_KEY_EXPORT =
  TASKS_SPLIT_RATIO_STORAGE_KEY;
/** Min widths enforced during resize. The drag handler clamps the
 *  computed ratio to these bounds so the chat column never collapses
 *  below 400 px and the preview panel never goes below 512 px. */
export const PREVIEW_MIN_CHAT_WIDTH = 400;
export const PREVIEW_MIN_PANEL_WIDTH = 512;

// ── Selectors ─────────────────────────────────────────────────────────────

import type { RootState } from "../store";

export const selectPreviewArtifact = (state: RootState): PreviewArtifact | null =>
  state.previewPanel.artifact;

export const selectIsPreviewOpen = (state: RootState): boolean =>
  state.previewPanel.artifact !== null;

export const selectPreviewSplitRatio = (state: RootState): number =>
  state.previewPanel.splitRatio;

export const selectLibraryDetailSplitRatio = (state: RootState): number =>
  state.previewPanel.libraryDetailSplitRatio;

export const selectTasksSplitRatio = (state: RootState): number =>
  state.previewPanel.tasksSplitRatio;

/** True when the given artifact path is currently the one in the panel.
 *  Used by `UnsupportedFileCard` to render its active-state highlight. */
export const selectIsArtifactInPanel = (
  state: RootState,
  workspaceId: string | undefined,
  path: string,
): boolean => {
  const open = state.previewPanel.artifact;
  if (!open || !workspaceId) return false;
  return open.workspaceId === workspaceId && open.path === path;
};
