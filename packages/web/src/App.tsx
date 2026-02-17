import { useAppSelector } from './store/index.js';
import { PromptPanel } from './prompt/PromptPanel.js';
import { ModelEditor } from './editor/ModelEditor.js';
import { AppRenderer } from './renderer/AppRenderer.js';
import { HowTo } from './components/HowTo.js';
import { About } from './components/About.js';

export function App() {
  const model = useAppSelector((state) => state.model.model);

  return (
    <div className="app-shell">
      <header className="app-header">
        <h1>Natural language to application model</h1>
        <p className="app-lede">
          Describe an application, watch an agent build a validated model of it, and see that model
          rendered. The model is the source of truth: edit it and the application follows.
        </p>
        <HowTo />
      </header>

      <main className="panes">
        <div className="pane-column">
          <PromptPanel />
          <ModelEditor />
        </div>

        <section className="pane preview-pane" aria-label="Application">
          <header className="pane-header">
            <h2>Application</h2>
          </header>
          <p className="pane-hint">
            The model on the left, rendered and working. Filter, add rows, remove them.
          </p>
          {model ? (
            <AppRenderer model={model} />
          ) : (
            <p className="empty-state">
              Nothing to render yet. Fix the errors on the left, or load a reference model.
            </p>
          )}
        </section>
      </main>

      <About />
    </div>
  );
}
