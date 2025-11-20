import type { FormEvent } from 'react';
import { formFields, normaliseRow, type Entity, type FormComponent } from '@nlam/shared';
import { useAppDispatch, useAppSelector } from '../store/index.js';
import { formErrorsReported, formFieldChanged, rowAdded } from '../store/runtimeSlice.js';
import { coerceDraft, draftValue } from './formValues.js';

interface Props {
  component: FormComponent;
  entity: Entity;
}

export function FormView({ component, entity }: Props) {
  const dispatch = useAppDispatch();
  const draft = useAppSelector((state) => state.runtime.formDrafts[component.id] ?? {});
  const errors = useAppSelector((state) => state.runtime.formErrors[component.id] ?? {});
  const notice = useAppSelector((state) => state.runtime.notice);

  const fields = formFields(component, entity);

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const { values, errors: found } = coerceDraft(fields, draft);

    if (Object.keys(found).length > 0) {
      dispatch(formErrorsReported({ componentId: component.id, errors: found }));
      return;
    }

    dispatch(
      rowAdded({
        componentId: component.id,
        entityId: entity.id,
        row: normaliseRow(entity, values),
        notice: `${entity.name} added.`,
      }),
    );
  }

  return (
    <form className="form-view" onSubmit={handleSubmit} noValidate>
      {fields.map((field) => {
        const controlId = `${component.id}-${field.id}`;
        const value = draftValue(field, draft);
        const error = errors[field.id];
        const describedBy = error ? `${controlId}-error` : undefined;

        const onChange = (next: string) =>
          dispatch(formFieldChanged({ componentId: component.id, fieldId: field.id, value: next }));

        return (
          <div className={`form-row${error ? ' has-error' : ''}`} key={field.id}>
            <label htmlFor={controlId}>
              {field.label}
              {field.required && (
                <span className="required" aria-hidden="true">
                  *
                </span>
              )}
            </label>

            {field.type === 'boolean' ? (
              <input
                id={controlId}
                type="checkbox"
                checked={value === 'true'}
                onChange={(event) => onChange(event.target.checked ? 'true' : 'false')}
              />
            ) : field.type === 'enum' ? (
              <select
                id={controlId}
                value={value}
                aria-invalid={error ? true : undefined}
                aria-describedby={describedBy}
                onChange={(event) => onChange(event.target.value)}
              >
                <option value="">Choose one</option>
                {(field.options ?? []).map((option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
              </select>
            ) : (
              <input
                id={controlId}
                type={field.type === 'number' ? 'number' : field.type === 'date' ? 'date' : 'text'}
                step={field.type === 'number' ? 'any' : undefined}
                value={value}
                aria-invalid={error ? true : undefined}
                aria-describedby={describedBy}
                onChange={(event) => onChange(event.target.value)}
              />
            )}

            {error && (
              <p className="field-error" id={`${controlId}-error`} role="alert">
                {error}
              </p>
            )}
          </div>
        );
      })}

      <div className="form-actions">
        <button type="submit">{component.submitLabel ?? `Add ${entity.name.toLowerCase()}`}</button>
        {notice && <span className="form-notice">{notice}</span>}
      </div>
    </form>
  );
}
