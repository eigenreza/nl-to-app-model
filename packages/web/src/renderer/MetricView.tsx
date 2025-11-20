import { computeMetric, type Entity, type MetricComponent } from '@nlam/shared';
import { useAppSelector } from '../store/index.js';

interface Props {
  component: MetricComponent;
  entity: Entity;
}

export function MetricView({ component, entity }: Props) {
  const rows = useAppSelector((state) => state.runtime.data[entity.id] ?? []);
  const result = computeMetric(component, rows);

  return (
    <div className="metric-view">
      <p className="metric-value">{result.formatted}</p>
      {component.caption && <p className="metric-caption">{component.caption}</p>}
      {component.where && (
        <p className="metric-detail">
          {result.matchedRows} of {rows.length} {rows.length === 1 ? 'row' : 'rows'} matched
        </p>
      )}
    </div>
  );
}
