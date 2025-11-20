import {
  defaultComponentTitle,
  findEntity,
  type ApplicationModel,
  type Component,
} from '@nlam/shared';
import { TableView } from './TableView.js';
import { FormView } from './FormView.js';
import { MetricView } from './MetricView.js';

/**
 * Walks the model and renders it. Every branch here is driven by the
 * discriminated union in the schema, so adding a component type is a compile
 * error until this switch handles it.
 */
export function AppRenderer({ model }: { model: ApplicationModel }) {
  const layoutClass =
    model.layout.type === 'grid' ? `layout-grid columns-${model.layout.columns ?? 2}` : 'layout-vertical';

  return (
    <section className="rendered-app" aria-label="Rendered application">
      <header className="rendered-app-header">
        <h2>{model.app.name}</h2>
        {model.app.description && <p>{model.app.description}</p>}
      </header>

      <div className={layoutClass}>
        {model.components.map((component) => (
          <ComponentCard key={component.id} component={component} model={model} />
        ))}
      </div>
    </section>
  );
}

function ComponentCard({ component, model }: { component: Component; model: ApplicationModel }) {
  const entity = component.type === 'text' ? undefined : findEntity(model, component.entityId);
  const title = defaultComponentTitle(component, entity);
  const widthClass = `width-${component.width}`;

  // Validation guarantees the entity exists. This guard only matters if a
  // caller renders an unvalidated document, and it fails visibly rather than
  // throwing inside the tree.
  if (component.type !== 'text' && !entity) {
    return (
      <article className={`card ${widthClass} card-broken`}>
        <h3>{title}</h3>
        <p className="empty-state">
          This component points at the entity &quot;{component.entityId}&quot;, which the model does
          not declare.
        </p>
      </article>
    );
  }

  return (
    <article className={`card ${widthClass} card-${component.type}`} data-component-id={component.id}>
      <h3>{title}</h3>
      {component.type === 'text' && <p className="text-block">{component.content}</p>}
      {component.type === 'table' && entity && <TableView component={component} entity={entity} />}
      {component.type === 'form' && entity && <FormView component={component} entity={entity} />}
      {component.type === 'metric' && entity && <MetricView component={component} entity={entity} />}
    </article>
  );
}
