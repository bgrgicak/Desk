import { configureStore } from "@reduxjs/toolkit";
import { setupListeners } from "@reduxjs/toolkit/query";
import { api } from "./api";
import uiReducer from "./slices/uiSlice";
import derivedReducer from "./slices/derivedSlice";
import previewPanelReducer from "./slices/previewPanelSlice";
import { wsMiddleware } from "./ws/middleware";

export const store = configureStore({
  reducer: {
    ui: uiReducer,
    derived: derivedReducer,
    previewPanel: previewPanelReducer,
    [api.reducerPath]: api.reducer,
  },
  middleware: (getDefault) =>
    getDefault({
      // RTK Query state is serializable by construction (Immer-produced) and
      // can grow large (cached chats, messages, library, artifacts). Walking
      // it on every dispatch was tripping the 32ms dev-mode warning at ~97ms.
      // The mutation args for postChatMessage / uploadLibraryFile also carry
      // File / FormData, which are intentionally non-serializable.
      serializableCheck: {
        ignoredPaths: [api.reducerPath],
        ignoredActionPaths: ["meta.arg.originalArgs.files", "meta.arg.originalArgs.file", "meta.baseQueryMeta"],
      },
      immutableCheck: { ignoredPaths: [api.reducerPath] },
    }).concat(api.middleware, wsMiddleware),
  // Suppress token leakage into devtools output.
  devTools: {
    actionSanitizer: (action) => {
      const a = action as { type?: string; meta?: unknown };
      if (typeof a.type === "string" && a.type.includes("/executeMutation")) {
        return { ...(action as object), meta: "[redacted]" } as unknown as typeof action;
      }
      return action;
    },
  },
});

setupListeners(store.dispatch);

export type RootState = ReturnType<typeof store.getState>;
export type AppDispatch = typeof store.dispatch;
export type AppStore = typeof store;
