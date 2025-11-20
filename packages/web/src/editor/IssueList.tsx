import type { ValidationIssue } from '@nlam/shared';

export function IssueList({ issues }: { issues: readonly ValidationIssue[] }) {
  const errors = issues.filter((issue) => issue.severity === 'error');
  const warnings = issues.filter((issue) => issue.severity === 'warning');

  if (errors.length === 0 && warnings.length === 0) {
    return (
      <p className="issue-summary ok" role="status">
        The model is valid.
      </p>
    );
  }

  return (
    <div className="issue-list">
      {errors.length > 0 && (
        <>
          <p className="issue-summary error" role="alert">
            {errors.length} {errors.length === 1 ? 'error' : 'errors'}. The application on the right
            is still showing the last valid version.
          </p>
          <ul>
            {errors.map((issue, index) => (
              <li key={`${issue.path}-${issue.code}-${index}`} className="issue error">
                <code>{issue.path}</code>
                <span>{issue.message}</span>
              </li>
            ))}
          </ul>
        </>
      )}

      {warnings.length > 0 && (
        <>
          <p className="issue-summary warning">
            {warnings.length} {warnings.length === 1 ? 'warning' : 'warnings'}.
          </p>
          <ul>
            {warnings.map((issue, index) => (
              <li key={`${issue.path}-${issue.code}-${index}`} className="issue warning">
                <code>{issue.path}</code>
                <span>{issue.message}</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
