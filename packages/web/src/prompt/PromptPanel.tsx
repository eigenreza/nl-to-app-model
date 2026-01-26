import { useEffect, type FormEvent } from 'react';
import { useAppDispatch, useAppSelector } from '../store/index.js';
import {
  descriptionChanged,
  generate,
  loadDeploymentInfo,
  modeChanged,
} from '../store/generationSlice.js';
import { TraceView } from './TraceView.js';

export function PromptPanel() {
  const dispatch = useAppDispatch();
  const {
    status,
    description,
    mode,
    steps,
    summary,
    failure,
    error,
    health,
    catalogue,
    unreachable,
  } = useAppSelector((state) => state.generation);

  useEffect(() => {
    void dispatch(loadDeploymentInfo());
  }, [dispatch]);

  const running = status === 'running';
  const replayOnly = health !== null && !health.liveGenerationEnabled;
  const canSubmit = description.trim().length >= 3 && !running && !unreachable;

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canSubmit) return;
    void dispatch(generate());
  }

  return (
    <section className="pane prompt-pane" aria-label="Describe an application">
      <header className="pane-header">
        <h2>Describe an application</h2>
        {health && (
          <span className="badge" title={`${health.provider} ${health.model}`}>
            {replayOnly ? 'replay mode' : 'live'}
          </span>
        )}
        {unreachable && <span className="badge">api offline</span>}
      </header>

      <form onSubmit={handleSubmit}>
        <label className="visually-hidden" htmlFor="description">
          Description
        </label>
        <textarea
          id="description"
          className="prompt-input"
          rows={3}
          placeholder="a book tracker with a table of books, a filter by genre, and a count of unread books"
          value={description}
          disabled={running}
          onChange={(event) => dispatch(descriptionChanged(event.target.value))}
        />

        <div className="prompt-actions">
          <fieldset className="mode-picker">
            <legend className="visually-hidden">Generation mode</legend>
            {(['agent', 'baseline'] as const).map((option) => (
              <label key={option}>
                <input
                  type="radio"
                  name="mode"
                  value={option}
                  checked={mode === option}
                  disabled={running}
                  onChange={() => dispatch(modeChanged(option))}
                />
                {option === 'agent' ? 'Agent loop' : 'One-shot baseline'}
              </label>
            ))}
          </fieldset>

          <button type="submit" disabled={!canSubmit}>
            {running ? 'Generating...' : 'Generate'}
          </button>
        </div>
      </form>

      {unreachable && (
        <p className="trace-status error" role="alert">
          The API is not responding, so nothing can be generated. The reference models below
          still work: this pane is the only part that needs the server.
        </p>
      )}

      {replayOnly && catalogue.length > 0 && (
        <div className="replay-catalogue">
          <p>
            This deployment answers from recorded traces, so it costs nothing to run and cannot
            reach a provider. Try one of these:
          </p>
          <ul>
            {catalogue.map((entry) => (
              <li key={`${entry.mode}-${entry.id}`}>
                <button
                  type="button"
                  className="link-button"
                  disabled={running}
                  onClick={() => {
                    dispatch(descriptionChanged(entry.description));
                    dispatch(modeChanged(entry.mode));
                  }}
                >
                  {entry.description}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {replayOnly && catalogue.length === 0 && (
        <p className="empty-state">
          This deployment is in replay mode and has no recorded traces yet. The reference models
          below still work.
        </p>
      )}

      <TraceView status={status} steps={steps} summary={summary} failure={failure} error={error} />
    </section>
  );
}
