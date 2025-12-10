import type { FailureReport, GenerationStep } from '@nlam/shared';
import type { GenerationStatus, GenerationSummary } from '../store/generationSlice.js';

interface Props {
  status: GenerationStatus;
  steps: readonly GenerationStep[];
  summary: GenerationSummary | null;
  failure: FailureReport | null;
  error: { code: string; message: string } | null;
}

/**
 * The trace, rendered as it arrives.
 *
 * Showing the tool calls is not decoration. A rejected call followed by a
 * corrected one is the system working as designed, and hiding that behind a
 * spinner would make the interesting behaviour invisible.
 */
export function TraceView({ status, steps, summary, failure, error }: Props) {
  if (status === 'idle' && steps.length === 0) return null;

  return (
    <div className="trace">
      {steps.length > 0 && (
        <ol className="trace-steps">
          {steps.map((step) => (
            <li key={step.index} className={step.ok ? 'trace-step ok' : 'trace-step failed'}>
              <span className="trace-marker" aria-hidden="true">
                {step.ok ? '+' : '!'}
              </span>
              <div>
                <p className="trace-label">{step.label}</p>
                {step.detail && <p className="trace-detail">{step.detail}</p>}
                {step.issues && step.issues.length > 0 && (
                  <ul className="trace-issues">
                    {step.issues.slice(0, 4).map((issue, index) => (
                      <li key={`${issue.path}-${index}`}>
                        <code>{issue.path}</code> {issue.message}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </li>
          ))}
        </ol>
      )}

      {status === 'running' && (
        <p className="trace-status" role="status">
          Working...
        </p>
      )}

      {error && (
        <p className="trace-status error" role="alert">
          {error.message}
        </p>
      )}

      {failure && (
        <p className="trace-status warning" role="alert">
          {failure.message}
        </p>
      )}

      {summary && (
        <dl className="trace-summary">
          <div>
            <dt>Iterations</dt>
            <dd>{summary.iterations}</dd>
          </div>
          <div>
            <dt>Time</dt>
            <dd>{(summary.latencyMs / 1000).toFixed(1)}s</dd>
          </div>
          <div>
            <dt>Tokens</dt>
            <dd>
              {summary.usage.inputTokens.toLocaleString()} in,{' '}
              {summary.usage.outputTokens.toLocaleString()} out
            </dd>
          </div>
          <div>
            <dt>List price</dt>
            <dd>
              {summary.estimatedCostUsd === null
                ? 'not priced'
                : `$${summary.estimatedCostUsd.toFixed(4)}`}
            </dd>
          </div>
          <div>
            <dt>Source</dt>
            <dd>{summary.source === 'replay' ? 'recorded trace' : `${summary.model}`}</dd>
          </div>
        </dl>
      )}
    </div>
  );
}
