import {
  filterOptions,
  formatCellValue,
  selectTableRows,
  type Entity,
  type TableComponent,
} from '@nlam/shared';
import { useAppDispatch, useAppSelector } from '../store/index.js';
import { rowRemoved, tableFilterChanged, tableFiltersCleared } from '../store/runtimeSlice.js';

interface Props {
  component: TableComponent;
  entity: Entity;
}

export function TableView({ component, entity }: Props) {
  const dispatch = useAppDispatch();
  const rows = useAppSelector((state) => state.runtime.data[entity.id] ?? []);
  const filterState = useAppSelector((state) => state.runtime.tableFilters[component.id] ?? {});

  const columns = component.columns?.length
    ? component.columns
        .map((id) => entity.fields.find((field) => field.id === id))
        .filter((field): field is Entity['fields'][number] => field !== undefined)
    : entity.fields;

  const visible = selectTableRows(component, entity, rows, filterState);
  const hasActiveFilter = Object.values(filterState).some((value) => value !== '');

  return (
    <div className="table-view">
      {component.filters && component.filters.length > 0 && (
        <div className="filter-bar">
          {component.filters.map((filter) => {
            const field = entity.fields.find((f) => f.id === filter.fieldId);
            if (!field) return null;
            const value = filterState[filter.fieldId] ?? '';
            const label = filter.label ?? field.label;
            const controlId = `${component.id}-${filter.fieldId}`;

            return (
              <label className="filter-control" key={filter.fieldId} htmlFor={controlId}>
                <span>{label}</span>
                {filter.control === 'select' ? (
                  <select
                    id={controlId}
                    value={value}
                    onChange={(event) =>
                      dispatch(
                        tableFilterChanged({
                          componentId: component.id,
                          fieldId: filter.fieldId,
                          value: event.target.value,
                        }),
                      )
                    }
                  >
                    {filterOptions(field).map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                ) : (
                  <input
                    id={controlId}
                    type="search"
                    value={value}
                    placeholder={`Search ${field.label.toLowerCase()}`}
                    onChange={(event) =>
                      dispatch(
                        tableFilterChanged({
                          componentId: component.id,
                          fieldId: filter.fieldId,
                          value: event.target.value,
                        }),
                      )
                    }
                  />
                )}
              </label>
            );
          })}
          {hasActiveFilter && (
            <button
              type="button"
              className="link-button"
              onClick={() => dispatch(tableFiltersCleared({ componentId: component.id }))}
            >
              Clear filters
            </button>
          )}
        </div>
      )}

      {visible.length === 0 ? (
        <p className="empty-state">{component.emptyMessage ?? 'Nothing to show yet.'}</p>
      ) : (
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                {columns.map((field) => (
                  <th key={field.id} className={field.type === 'number' ? 'numeric' : undefined}>
                    {field.label}
                  </th>
                ))}
                <th className="row-actions">
                  <span className="visually-hidden">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {visible.map((row) => (
                <tr key={row.id}>
                  {columns.map((field) => {
                    const text = formatCellValue(row.values[field.id], field);
                    return (
                      <td
                        key={field.id}
                        className={field.type === 'number' ? 'numeric' : undefined}
                      >
                        {text === '' ? <span className="muted">not set</span> : text}
                      </td>
                    );
                  })}
                  <td className="row-actions">
                    <button
                      type="button"
                      className="link-button"
                      onClick={() => dispatch(rowRemoved({ entityId: entity.id, rowId: row.id }))}
                      aria-label={`Remove row ${row.id}`}
                    >
                      Remove
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p className="table-footer">
        {visible.length} of {rows.length} {rows.length === 1 ? 'row' : 'rows'}
      </p>
    </div>
  );
}
