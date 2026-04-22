import { configureStore, createSlice, type PayloadAction } from "@reduxjs/toolkit";
import { useSelector, useDispatch } from "react-redux";
import { useEffect } from "react";
import { api } from "./api";

interface CacheEntry {
  data: unknown;
  fetchedAt: number;
}

interface CacheState {
  entries: Record<string, CacheEntry>;
  /** Incremented on invalidation to trigger refetches in useApi hooks. */
  version: number;
}

const cacheSlice = createSlice({
  name: "cache",
  initialState: { entries: {}, version: 0 } as CacheState,
  reducers: {
    set(state, action: PayloadAction<{ key: string; data: unknown }>) {
      state.entries[action.payload.key] = {
        data: action.payload.data,
        fetchedAt: Date.now(),
      };
    },
    invalidate(state, action: PayloadAction<string>) {
      delete state.entries[action.payload];
      state.version++;
    },
    clearAll(state) {
      state.entries = {};
      state.version++;
    },
  },
});

export const store = configureStore({ reducer: { cache: cacheSlice.reducer } });
export const { set: cacheSet, invalidate: cacheInvalidate, clearAll: cacheClearAll } = cacheSlice.actions;
export type RootState = ReturnType<typeof store.getState>;
export type AppDispatch = typeof store.dispatch;

/**
 * Fetch data from the API, returning cached data immediately while
 * a fresh request runs in the background. Re-fetches when `path` changes
 * or when the cache is invalidated.
 */
export function useApi<T>(path: string | null): { data: T | null; loading: boolean } {
  const dispatch = useDispatch<AppDispatch>();
  const cached = useSelector((s: RootState) => (path ? s.cache.entries[path] : undefined));
  const version = useSelector((s: RootState) => s.cache.version);

  useEffect(() => {
    if (!path) return;
    let cancelled = false;
    api<T>(path).then(({ data }) => {
      if (!cancelled) {
        dispatch(cacheSet({ key: path, data }));
      }
    });
    return () => { cancelled = true; };
  }, [path, dispatch, version]);

  return {
    data: (cached?.data as T) ?? null,
    loading: !cached && !!path,
  };
}
