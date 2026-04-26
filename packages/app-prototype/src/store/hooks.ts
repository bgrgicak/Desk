import {
  useDispatch as rawUseDispatch,
  useSelector as rawUseSelector,
  type TypedUseSelectorHook,
} from "react-redux";
import type { AppDispatch, RootState } from "./store";

export const useAppDispatch: () => AppDispatch = rawUseDispatch;
export const useAppSelector: TypedUseSelectorHook<RootState> = rawUseSelector;
