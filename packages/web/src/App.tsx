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
        <div className="app-title">
          <h1>Natural language to application model</h1>
          <a className="header-link" href="#about">
            About
          </a>
        </div>
        <p className="app-lede">
          Describe a small app in plain English, and an AI agent builds a working version of it in
          seconds. Use it immediately, or edit its blueprint and watch it update.
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
