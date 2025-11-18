/**
 * Hand-written reference models.
 *
 * These came before any generation code existed. Building the renderer against
 * models written by hand meant the renderer could be finished and tested while
 * the schema was still moving, and it left behind a set of documents that
 * exercise every component type, every field type and every operator class.
 *
 * They are still useful in three places: the browser loads one on first visit,
 * the schema documentation quotes one as a worked example, and the test suite
 * asserts that all of them validate, which catches accidental narrowing of the
 * schema immediately.
 */
import { SCHEMA_VERSION, type ApplicationModel, type ApplicationModelInput } from './model.js';
import { assertApplicationModel } from './validate.js';

const bookTracker: ApplicationModelInput = {
  schemaVersion: SCHEMA_VERSION,
  app: {
    name: 'Book tracker',
    description: 'A reading list with a genre filter and a count of what is still unread.',
  },
  entities: [
    {
      id: 'book',
      name: 'Book',
      pluralName: 'Books',
      fields: [
        { id: 'title', label: 'Title', type: 'string', required: true },
        { id: 'author', label: 'Author', type: 'string' },
        {
          id: 'genre',
          label: 'Genre',
          type: 'enum',
          options: ['Fiction', 'Nonfiction', 'Science', 'History'],
        },
        { id: 'pages', label: 'Pages', type: 'number' },
        { id: 'finished', label: 'Finished', type: 'boolean' },
        { id: 'added_on', label: 'Added on', type: 'date' },
      ],
      seed: [
        {
          title: 'The Long Way to a Small Angry Planet',
          author: 'Becky Chambers',
          genre: 'Fiction',
          pages: 404,
          finished: true,
          added_on: '2024-01-12',
        },
        {
          title: 'Thinking in Systems',
          author: 'Donella Meadows',
          genre: 'Nonfiction',
          pages: 240,
          finished: true,
          added_on: '2024-02-02',
        },
        {
          title: 'The Making of the Atomic Bomb',
          author: 'Richard Rhodes',
          genre: 'History',
          pages: 886,
          finished: false,
          added_on: '2024-03-19',
        },
        {
          title: 'Godel, Escher, Bach',
          author: 'Douglas Hofstadter',
          genre: 'Science',
          pages: 777,
          finished: false,
          added_on: '2024-04-04',
        },
        {
          title: 'Piranesi',
          author: 'Susanna Clarke',
          genre: 'Fiction',
          pages: 245,
          finished: false,
          added_on: '2024-05-21',
        },
      ],
    },
  ],
  components: [
    {
      id: 'total_books',
      type: 'metric',
      title: 'Books tracked',
      entityId: 'book',
      aggregate: 'count',
      width: 'half',
    },
    {
      id: 'unread_books',
      type: 'metric',
      title: 'Still to read',
      entityId: 'book',
      aggregate: 'count',
      caption: 'not finished yet',
      width: 'half',
      where: { conditions: [{ fieldId: 'finished', op: 'isFalse' }] },
    },
    {
      id: 'book_table',
      type: 'table',
      title: 'Library',
      entityId: 'book',
      columns: ['title', 'author', 'genre', 'pages', 'finished'],
      filters: [
        { fieldId: 'genre', control: 'select', label: 'Genre' },
        { fieldId: 'title', control: 'text', label: 'Search titles' },
      ],
      emptyMessage: 'No books match the current filters.',
    },
    {
      id: 'add_book',
      type: 'form',
      title: 'Add a book',
      entityId: 'book',
      fieldIds: ['title', 'author', 'genre', 'pages', 'finished'],
      submitLabel: 'Add to library',
    },
  ],
  layout: { type: 'grid', columns: 2 },
};

const expenseLog: ApplicationModelInput = {
  schemaVersion: SCHEMA_VERSION,
  app: {
    name: 'Expense log',
    description: 'Expenses by category, with totals and a reimbursable count.',
  },
  entities: [
    {
      id: 'expense',
      name: 'Expense',
      pluralName: 'Expenses',
      fields: [
        { id: 'description', label: 'Description', type: 'string', required: true },
        {
          id: 'category',
          label: 'Category',
          type: 'enum',
          required: true,
          options: ['Travel', 'Food', 'Software', 'Hardware', 'Other'],
        },
        { id: 'amount', label: 'Amount', type: 'number', required: true },
        { id: 'spent_on', label: 'Spent on', type: 'date' },
        { id: 'reimbursable', label: 'Reimbursable', type: 'boolean' },
      ],
      seed: [
        {
          description: 'Train to Berlin',
          category: 'Travel',
          amount: 118.4,
          spent_on: '2024-06-03',
          reimbursable: true,
        },
        {
          description: 'Team lunch',
          category: 'Food',
          amount: 64,
          spent_on: '2024-06-04',
          reimbursable: true,
        },
        {
          description: 'Editor licence',
          category: 'Software',
          amount: 89,
          spent_on: '2024-06-11',
          reimbursable: false,
        },
        {
          description: 'Mechanical keyboard',
          category: 'Hardware',
          amount: 142.5,
          spent_on: '2024-06-18',
          reimbursable: false,
        },
        {
          description: 'Conference ticket',
          category: 'Travel',
          amount: 350,
          spent_on: '2024-06-24',
          reimbursable: true,
        },
      ],
    },
  ],
  components: [
    {
      id: 'total_spend',
      type: 'metric',
      title: 'Total spend',
      entityId: 'expense',
      aggregate: 'sum',
      fieldId: 'amount',
      width: 'third',
    },
    {
      id: 'average_spend',
      type: 'metric',
      title: 'Average expense',
      entityId: 'expense',
      aggregate: 'average',
      fieldId: 'amount',
      width: 'third',
    },
    {
      id: 'reimbursable_count',
      type: 'metric',
      title: 'Awaiting reimbursement',
      entityId: 'expense',
      aggregate: 'count',
      caption: 'marked reimbursable',
      width: 'third',
      where: { conditions: [{ fieldId: 'reimbursable', op: 'isTrue' }] },
    },
    {
      id: 'expense_table',
      type: 'table',
      title: 'All expenses',
      entityId: 'expense',
      filters: [
        { fieldId: 'category', control: 'select', label: 'Category' },
        { fieldId: 'description', control: 'text', label: 'Search' },
      ],
    },
    {
      id: 'large_expenses',
      type: 'table',
      title: 'Over 100',
      entityId: 'expense',
      columns: ['description', 'category', 'amount'],
      where: { conditions: [{ fieldId: 'amount', op: 'greaterThan', value: 100 }] },
      emptyMessage: 'Nothing over 100 yet.',
    },
    {
      id: 'add_expense',
      type: 'form',
      title: 'Log an expense',
      entityId: 'expense',
      submitLabel: 'Log expense',
    },
  ],
  layout: { type: 'grid', columns: 3 },
};

const issueBoard: ApplicationModelInput = {
  schemaVersion: SCHEMA_VERSION,
  app: {
    name: 'Issue board',
    description: 'Open work by priority, with a separate view of what is finished.',
  },
  entities: [
    {
      id: 'issue',
      name: 'Issue',
      pluralName: 'Issues',
      fields: [
        { id: 'summary', label: 'Summary', type: 'string', required: true },
        {
          id: 'status',
          label: 'Status',
          type: 'enum',
          required: true,
          options: ['open', 'in_progress', 'done'],
        },
        {
          id: 'priority',
          label: 'Priority',
          type: 'enum',
          options: ['low', 'medium', 'high'],
        },
        { id: 'estimate_hours', label: 'Estimate (hours)', type: 'number' },
        { id: 'opened_on', label: 'Opened on', type: 'date' },
      ],
      seed: [
        {
          summary: 'Rate limiter rejects valid retries',
          status: 'open',
          priority: 'high',
          estimate_hours: 4,
          opened_on: '2024-07-01',
        },
        {
          summary: 'Add pagination to the results table',
          status: 'in_progress',
          priority: 'medium',
          estimate_hours: 6,
          opened_on: '2024-07-03',
        },
        {
          summary: 'Typo on the settings page',
          status: 'done',
          priority: 'low',
          estimate_hours: 1,
          opened_on: '2024-06-28',
        },
        {
          summary: 'Session expires too early',
          status: 'open',
          priority: 'high',
          estimate_hours: 8,
          opened_on: '2024-07-05',
        },
        {
          summary: 'Export to CSV loses accents',
          status: 'open',
          priority: 'low',
          estimate_hours: 2,
          opened_on: '2024-07-09',
        },
      ],
    },
  ],
  components: [
    {
      id: 'intro',
      type: 'text',
      title: 'This week',
      content:
        'Everything not marked done is still on the board. High priority items are counted separately so they do not get lost in the list.',
    },
    {
      id: 'open_count',
      type: 'metric',
      title: 'Open issues',
      entityId: 'issue',
      aggregate: 'count',
      width: 'third',
      where: { conditions: [{ fieldId: 'status', op: 'notEquals', value: 'done' }] },
    },
    {
      id: 'high_priority_count',
      type: 'metric',
      title: 'High priority',
      entityId: 'issue',
      aggregate: 'count',
      caption: 'open and marked high',
      width: 'third',
      where: {
        combinator: 'and',
        conditions: [
          { fieldId: 'status', op: 'notEquals', value: 'done' },
          { fieldId: 'priority', op: 'equals', value: 'high' },
        ],
      },
    },
    {
      id: 'remaining_hours',
      type: 'metric',
      title: 'Estimated hours left',
      entityId: 'issue',
      aggregate: 'sum',
      fieldId: 'estimate_hours',
      width: 'third',
      where: { conditions: [{ fieldId: 'status', op: 'notEquals', value: 'done' }] },
    },
    {
      id: 'board',
      type: 'table',
      title: 'Board',
      entityId: 'issue',
      columns: ['summary', 'status', 'priority', 'estimate_hours'],
      filters: [
        { fieldId: 'status', control: 'select', label: 'Status' },
        { fieldId: 'priority', control: 'select', label: 'Priority' },
      ],
    },
    {
      id: 'finished',
      type: 'table',
      title: 'Recently finished',
      entityId: 'issue',
      columns: ['summary', 'opened_on'],
      where: { conditions: [{ fieldId: 'status', op: 'equals', value: 'done' }] },
      emptyMessage: 'Nothing finished yet.',
    },
    {
      id: 'add_issue',
      type: 'form',
      title: 'Report an issue',
      entityId: 'issue',
      fieldIds: ['summary', 'status', 'priority', 'estimate_hours'],
      submitLabel: 'Report',
    },
  ],
  layout: { type: 'grid', columns: 3 },
};

const contactList: ApplicationModelInput = {
  schemaVersion: SCHEMA_VERSION,
  app: {
    name: 'Contact list',
    description: 'The smallest useful application: one entity, one table, one form.',
  },
  entities: [
    {
      id: 'contact',
      name: 'Contact',
      pluralName: 'Contacts',
      fields: [
        { id: 'name', label: 'Name', type: 'string', required: true },
        { id: 'email', label: 'Email', type: 'string' },
        { id: 'team', label: 'Team', type: 'enum', options: ['Design', 'Engineering', 'Sales'] },
      ],
      seed: [
        { name: 'Ada Okonkwo', email: 'ada@example.com', team: 'Engineering' },
        { name: 'Bo Lindqvist', email: 'bo@example.com', team: 'Design' },
        { name: 'Chen Wei', email: 'chen@example.com', team: 'Sales' },
      ],
    },
  ],
  components: [
    {
      id: 'contact_table',
      type: 'table',
      title: 'Contacts',
      entityId: 'contact',
      filters: [{ fieldId: 'team', control: 'select', label: 'Team' }],
    },
    {
      id: 'add_contact',
      type: 'form',
      title: 'Add a contact',
      entityId: 'contact',
      submitLabel: 'Add contact',
    },
  ],
  layout: { type: 'vertical' },
};

const RAW_EXAMPLES = {
  book_tracker: bookTracker,
  expense_log: expenseLog,
  issue_board: issueBoard,
  contact_list: contactList,
} satisfies Record<string, ApplicationModelInput>;

export type ExampleId = keyof typeof RAW_EXAMPLES;

export const EXAMPLE_IDS = Object.keys(RAW_EXAMPLES) as ExampleId[];

/**
 * Parsed once at module load. If an edit to the schema invalidates one of these
 * documents, everything that imports this module fails loudly and immediately
 * rather than at render time.
 */
export const EXAMPLE_MODELS: Record<ExampleId, ApplicationModel> = Object.fromEntries(
  Object.entries(RAW_EXAMPLES).map(([id, input]) => [id, assertApplicationModel(input)]),
) as Record<ExampleId, ApplicationModel>;

export function getExampleModel(id: ExampleId): ApplicationModel {
  return EXAMPLE_MODELS[id];
}

/** The model the browser shows before anything has been generated. */
export const DEFAULT_EXAMPLE_ID: ExampleId = 'book_tracker';
