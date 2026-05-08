import {
  useDispatch as rawUseDispatch,
  useSelector as rawUseSelector,
  useStore as rawUseStore,
  type TypedUseSelectorHook,
} from "react-redux";
import type { AppDispatch, AppStore, RootState } from "./store";

export const useAppDispatch: () => AppDispatch = rawUseDispatch;
export const useAppSelector: TypedUseSelectorHook<RootState> = rawUseSelector;
export const useAppStore: () => AppStore = rawUseStore;
