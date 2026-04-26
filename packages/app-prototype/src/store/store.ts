import { configureStore } from "@reduxjs/toolkit";
import { setupListeners } from "@reduxjs/toolkit/query";
import { api } from "./api";
import uiReducer from "./slices/uiSlice";
import derivedReducer from "./slices/derivedSlice";
import { wsMiddleware } from "./ws/middleware";

export const store = configureStore({
  reducer: {
    ui: uiReducer,
    derived: derivedReducer,
    [api.reducerPath]: api.reducer,
  },
  middleware: (getDefault) =>
    getDefault().concat(api.middleware, wsMiddleware),
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
