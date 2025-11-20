import type { ReactElement, ReactNode } from 'react';
import { render } from '@testing-library/react';
import { Provider } from 'react-redux';
import type { ApplicationModel } from '@nlam/shared';
import { createAppStore, type AppStore } from './store/index.js';
import { modelApplied } from './store/actions.js';

/** Renders with a fresh store so tests never share application state. */
export function renderWithStore(ui: ReactElement, store: AppStore = createAppStore()) {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <Provider store={store}>{children}</Provider>
  );
  return { store, ...render(ui, { wrapper }) };
}

/**
 * Loads a model into a fresh store before rendering, which is what the running
 * application does. Rendering a component against a store that was never told
 * about the model would leave it without any rows.
 */
export function storeFor(model: ApplicationModel): AppStore {
  const store = createAppStore();
  store.dispatch(modelApplied(model, 'example'));
  return store;
}
