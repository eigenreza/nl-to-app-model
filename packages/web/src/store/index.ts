import { configureStore } from '@reduxjs/toolkit';
import { useDispatch, useSelector } from 'react-redux';
import { generationReducer } from './generationSlice.js';
import { modelReducer } from './modelSlice.js';
import { runtimeReducer } from './runtimeSlice.js';

export function createAppStore() {
  return configureStore({
    reducer: {
      model: modelReducer,
      runtime: runtimeReducer,
      generation: generationReducer,
    },
  });
}

export const store = createAppStore();

export type AppStore = ReturnType<typeof createAppStore>;
export type RootState = ReturnType<AppStore['getState']>;
export type AppDispatch = AppStore['dispatch'];

export const useAppDispatch = useDispatch.withTypes<AppDispatch>();
export const useAppSelector = useSelector.withTypes<RootState>();

export * from './actions.js';
export * from './runtimeSlice.js';

export * from './generationSlice.js';
