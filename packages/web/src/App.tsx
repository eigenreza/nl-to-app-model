import { useAppSelector } from './store/index.js';
import { ModelEditor } from './editor/ModelEditor.js';
import { AppRenderer } from './renderer/AppRenderer.js';

export function App() {
  const model = useAppSelector((state) => state.model.model);

  return (
    <div className="app-shell">
      <header className="app-header">
        <h1>Natural language to application model</h1>
        <p>
          Describe an application, get a validated model, and see it rendered. The model on the left
          is the source of truth: edit it and the application on the right follows.
        </p>
      </header>

      <main className="panes">
        <ModelEditor />

        <section className="pane preview-pane" aria-label="Preview">
          <header className="pane-header">
            <h2>Application</h2>
          </header>
          {model ? (
            <AppRenderer model={model} />
          ) : (
            <p className="empty-state">
              Nothing to render yet. Fix the errors on the left, or load a reference model.
            </p>
          )}
        </section>
      </main>
    </div>
  );
}
