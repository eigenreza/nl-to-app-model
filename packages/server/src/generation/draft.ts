/**
 * The server-side draft.
 *
 * In the agent loop the model never writes the document. It calls tools, and
 * this class applies them. That inversion is the whole point: the draft is
 * always a real object held in TypeScript, each change is checked the moment it
 * is made, and the feedback the model gets is about the one thing it just did
 * rather than about the whole document.
 *
 * Every check here goes through the same validator the finished model goes
 * through. A piece is validated by dropping it into a minimal probe document
 * and keeping only the issues that belong to it. Reusing the real validator
 * this way means tool feedback and final acceptance can never disagree, which
 * a second, looser set of per-tool rules would eventually allow.
 */
import {
  LayoutSchema,
  SCHEMA_VERSION,
  validateApplicationModel,
  type ApplicationModel,
  type Component,
  type Entity,
  type Layout,
  type ValidationIssue,
} from '@nlam/shared';

export interface DraftOutcome {
  ok: boolean;
  /** Issues that belong to the element the caller was working on. */
  issues: ValidationIssue[];
}

const PLACEHOLDER_ENTITY_ID = 'probe_entity';

export class ModelDraft {
  private appName = 'Application';
  private appDescription: string | undefined;
  private planSummary: string | undefined;
  private entities: Entity[] = [];
  private components: Component[] = [];
  private layout: Layout = { type: 'vertical' };

  get entityIds(): string[] {
    return this.entities.map((entity) => entity.id);
  }

  get componentIds(): string[] {
    return this.components.map((component) => component.id);
  }

  get plan(): string | undefined {
    return this.planSummary;
  }

  get isEmpty(): boolean {
    return this.entities.length === 0 && this.components.length === 0;
  }

  setPlan(summary: string, appName?: string, appDescription?: string): void {
    this.planSummary = summary;
    if (appName) this.appName = appName;
    if (appDescription) this.appDescription = appDescription;
  }

  /** Adds an entity, or replaces the existing one with the same id. */
  createEntity(input: unknown): DraftOutcome {
    const id = readId(input) ?? PLACEHOLDER_ENTITY_ID;
    const probe = {
      schemaVersion: SCHEMA_VERSION,
      app: { name: 'probe' },
      entities: [input],
      // A component is required for the document to be structurally complete.
      // It points at the entity under test so that a valid entity produces no
      // stray issues; issues raised against it are filtered out either way.
      components: [{ id: 'probe_component', type: 'table', entityId: id }],
      layout: { type: 'vertical' },
    };

    const issues = issuesUnder(validateApplicationModel(probe).errors, 'entities[0]');
    if (issues.length > 0) return { ok: false, issues };

    const accepted = validateApplicationModel(probe).model?.entities[0];
    if (!accepted) return { ok: false, issues };

    this.upsertEntity(accepted);
    return { ok: true, issues: [] };
  }

  /** Replaces an entity's seed rows. */
  setSeedData(entityId: unknown, rows: unknown): DraftOutcome {
    const entity = this.entities.find((candidate) => candidate.id === entityId);
    if (!entity) {
      return {
        ok: false,
        issues: [
          {
            path: 'entityId',
            code: 'unknown_entity',
            severity: 'error',
            message: `No entity with id "${String(entityId)}" has been created yet. Created entity ids are ${quote(this.entityIds)}.`,
          },
        ],
      };
    }

    const candidate = { ...entity, seed: rows };
    const probe = {
      schemaVersion: SCHEMA_VERSION,
      app: { name: 'probe' },
      entities: [candidate],
      components: [{ id: 'probe_component', type: 'table', entityId: entity.id }],
      layout: { type: 'vertical' },
    };

    const validation = validateApplicationModel(probe);
    const issues = issuesUnder(validation.errors, 'entities[0]');
    if (issues.length > 0) return { ok: false, issues };

    const accepted = validation.model?.entities[0];
    if (!accepted) return { ok: false, issues };

    this.upsertEntity(accepted);
    return { ok: true, issues: [] };
  }

  /** Adds a component, or replaces the existing one with the same id. */
  addComponent(input: unknown): DraftOutcome {
    if (this.entities.length === 0 && readType(input) !== 'text') {
      return {
        ok: false,
        issues: [
          {
            path: 'entityId',
            code: 'no_entities',
            severity: 'error',
            message:
              'No entities exist yet. Call create_entity before adding a component that displays data.',
          },
        ],
      };
    }

    const probe = {
      schemaVersion: SCHEMA_VERSION,
      app: { name: 'probe' },
      entities: this.entities.length > 0 ? this.entities : [placeholderEntity()],
      components: [input],
      layout: this.layout,
    };

    const validation = validateApplicationModel(probe);
    const issues = issuesUnder(validation.errors, 'components[0]');
    if (issues.length > 0) return { ok: false, issues };

    const accepted = validation.model?.components[0];
    if (!accepted) return { ok: false, issues };

    const existing = this.components.findIndex((component) => component.id === accepted.id);
    if (existing >= 0) this.components[existing] = accepted;
    else this.components.push(accepted);

    return { ok: true, issues: [] };
  }

  removeComponent(componentId: unknown): DraftOutcome {
    const before = this.components.length;
    this.components = this.components.filter((component) => component.id !== componentId);
    if (this.components.length === before) {
      return {
        ok: false,
        issues: [
          {
            path: 'componentId',
            code: 'unknown_component',
            severity: 'error',
            message: `No component with id "${String(componentId)}" exists. Current component ids are ${quote(this.componentIds)}.`,
          },
        ],
      };
    }
    return { ok: true, issues: [] };
  }

  setLayout(input: unknown): DraftOutcome {
    const parsed = LayoutSchema.safeParse(input);
    if (!parsed.success) {
      return {
        ok: false,
        issues: parsed.error.issues.map((issue) => ({
          path: issue.path.join('.') || '(layout)',
          code: issue.code ?? 'invalid_value',
          severity: 'error' as const,
          message: issue.message,
        })),
      };
    }
    this.layout = parsed.data;
    return { ok: true, issues: [] };
  }

  /** The document as it currently stands, valid or not. */
  snapshot(): unknown {
    return {
      schemaVersion: SCHEMA_VERSION,
      app: {
        name: this.appName,
        ...(this.appDescription ? { description: this.appDescription } : {}),
      },
      entities: this.entities,
      components: this.components,
      layout: this.layout,
    };
  }

  validate() {
    return validateApplicationModel(this.snapshot());
  }

  /**
   * The best model that can be salvaged when the loop runs out of budget.
   *
   * Returning nothing at all after eight iterations of work is the wrong
   * answer: the user usually has a working application minus one broken
   * component. This drops the smallest thing that unblocks acceptance, in
   * increasing order of destructiveness, and reports what it removed so the
   * failure notice can say so honestly.
   */
  salvage(): { model: ApplicationModel | null; removed: string[] } {
    const direct = this.validate();
    if (direct.ok && direct.model) return { model: direct.model, removed: [] };

    const removed: string[] = [];
    const broken = new Set(
      direct.errors
        .map((issue) => /^components\[(\d+)\]/.exec(issue.path)?.[1])
        .filter((index): index is string => index !== undefined)
        .map(Number),
    );

    if (broken.size > 0 && broken.size < this.components.length) {
      const kept = this.components.filter((component, index) => {
        if (!broken.has(index)) return true;
        removed.push(component.id);
        return false;
      });

      const attempt = validateApplicationModel({
        ...(this.snapshot() as object),
        components: kept,
      });
      if (attempt.ok && attempt.model) return { model: attempt.model, removed };
    }

    // Seed data is the other common casualty: rows are the part most likely to
    // disagree with the field types, and an application with empty tables is
    // still an application.
    const withoutSeed = this.entities.map(({ seed: _seed, ...entity }) => entity);
    const attempt = validateApplicationModel({
      ...(this.snapshot() as object),
      entities: withoutSeed,
      components: this.components.filter((_component, index) => !broken.has(index)),
    });

    if (attempt.ok && attempt.model) {
      return { model: attempt.model, removed: [...removed, 'seed data'] };
    }

    return { model: null, removed: [] };
  }

  /**
   * Redefining an entity keeps rows that were already seeded, unless the caller
   * supplied new ones. Losing the data because one field type was corrected
   * would make the obvious repair expensive, and rows that no longer fit the
   * new definition are caught by validate_model and, failing that, by salvage.
   */
  private upsertEntity(entity: Entity): void {
    const existing = this.entities.findIndex((candidate) => candidate.id === entity.id);
    if (existing < 0) {
      this.entities.push(entity);
      return;
    }

    const previous = this.entities[existing];
    this.entities[existing] =
      entity.seed === undefined && previous?.seed !== undefined
        ? { ...entity, seed: previous.seed }
        : entity;
  }
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

function readId(input: unknown): string | undefined {
  if (input === null || typeof input !== 'object') return undefined;
  const id = (input as { id?: unknown }).id;
  return typeof id === 'string' && /^[a-z][a-z0-9_]*$/.test(id) ? id : undefined;
}

function readType(input: unknown): string | undefined {
  if (input === null || typeof input !== 'object') return undefined;
  const type = (input as { type?: unknown }).type;
  return typeof type === 'string' ? type : undefined;
}

function placeholderEntity(): Entity {
  return {
    id: PLACEHOLDER_ENTITY_ID,
    name: 'Probe',
    fields: [{ id: 'label', label: 'Label', type: 'string', required: false }],
  };
}

/**
 * Keeps the issues raised against one element of the probe document and
 * rewrites their paths to be relative to that element, so the model sees
 * "fields[1].options" rather than "entities[0].fields[1].options".
 */
function issuesUnder(issues: readonly ValidationIssue[], prefix: string): ValidationIssue[] {
  return issues
    .filter(
      (issue) =>
        issue.path === prefix ||
        issue.path.startsWith(`${prefix}.`) ||
        issue.path.startsWith(`${prefix}[`),
    )
    .map((issue) => {
      const relative = issue.path.slice(prefix.length).replace(/^\./, '');
      return { ...issue, path: relative === '' ? '(this element)' : relative };
    });
}

function quote(values: readonly string[]): string {
  return values.length === 0 ? '(none)' : values.map((value) => `"${value}"`).join(', ');
}
