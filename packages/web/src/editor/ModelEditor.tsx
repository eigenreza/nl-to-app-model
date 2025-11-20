import { EXAMPLE_IDS, EXAMPLE_MODELS, type ExampleId } from '@nlam/shared';
import { jsonTextApplied, modelApplied, useAppDispatch, useAppSelector } from '../store/index.js';
import { IssueList } from './IssueList.js';

const SOURCE_LABELS: Record<string, string> = {
  example: 'reference model',
  generated: 'generated',
  edited: 'edited by hand',
};

function exampleLabel(id: ExampleId): string {
  return EXAMPLE_MODELS[id].app.name;
}

/**
 * The left pane. The model is the document, not a debug view of one, so it is
 * editable and every keystroke is validated. Invalid text is kept exactly as
 * typed; only a valid document replaces the model the renderer reads.
 */
export function ModelEditor() {
  const dispatch = useAppDispatch();
  const jsonText = useAppSelector((state) => state.model.jsonText);
  const issues = useAppSelector((state) => state.model.issues);
  const source = useAppSelector((state) => state.model.source);
  const exampleId = useAppSelector((state) => state.model.exampleId);
  const model = useAppSelector((state) => state.model.model);

  const canFormat = issues.every((issue) => issue.severity !== 'error');

  return (
    <section className="pane editor-pane" aria-label="Application model">
      <header className="pane-header">
        <h2>Application model</h2>
        <span className="badge">{SOURCE_LABELS[source] ?? source}</span>
      </header>

      <div className="editor-toolbar">
        <label htmlFor="example-picker">
          Reference model
          <select
            id="example-picker"
            value={exampleId ?? ''}
            onChange={(event) => {
              const id = event.target.value as ExampleId;
              if (!id) return;
              dispatch(modelApplied(EXAMPLE_MODELS[id], 'example', id));
            }}
          >
            {exampleId === null && <option value="">Custom</option>}
            {EXAMPLE_IDS.map((id) => (
              <option key={id} value={id}>
                {exampleLabel(id)}
              </option>
            ))}
          </select>
        </label>

        <button
          type="button"
          className="link-button"
          disabled={!canFormat || !model}
          onClick={() => {
            if (model) dispatch(jsonTextApplied(JSON.stringify(model, null, 2)));
          }}
        >
          Reformat
        </button>
      </div>

      <label className="visually-hidden" htmlFor="model-json">
        Application model as JSON
      </label>
      <textarea
        id="model-json"
        className="model-json"
        spellCheck={false}
        value={jsonText}
        onChange={(event) => dispatch(jsonTextApplied(event.target.value))}
      />

      <IssueList issues={issues} />
    </section>
  );
}
