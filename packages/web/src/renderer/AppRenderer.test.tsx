import { describe, expect, it } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { EXAMPLE_MODELS } from '@nlam/shared';
import { AppRenderer } from './AppRenderer.js';
import { renderWithStore, storeFor } from '../testUtils.js';

function card(componentId: string): HTMLElement {
  const element = document.querySelector(`[data-component-id="${componentId}"]`);
  if (!element) throw new Error(`No component rendered with id ${componentId}`);
  return element as HTMLElement;
}

describe('AppRenderer', () => {
  it('renders the application name and every component', () => {
    renderWithStore(<AppRenderer model={EXAMPLE_MODELS.book_tracker} />, storeFor(EXAMPLE_MODELS.book_tracker));

    expect(screen.getByRole('heading', { name: 'Book tracker' })).toBeInTheDocument();
    expect(card('total_books')).toBeInTheDocument();
    expect(card('unread_books')).toBeInTheDocument();
    expect(card('book_table')).toBeInTheDocument();
    expect(card('add_book')).toBeInTheDocument();
  });

  it('computes metrics from the seeded rows', () => {
    renderWithStore(<AppRenderer model={EXAMPLE_MODELS.book_tracker} />, storeFor(EXAMPLE_MODELS.book_tracker));

    expect(within(card('total_books')).getByText('5')).toBeInTheDocument();
    expect(within(card('unread_books')).getByText('3')).toBeInTheDocument();
  });

  it('shows one table row per seeded row', () => {
    renderWithStore(<AppRenderer model={EXAMPLE_MODELS.book_tracker} />, storeFor(EXAMPLE_MODELS.book_tracker));

    const table = within(card('book_table')).getByRole('table');
    expect(within(table).getAllByRole('row')).toHaveLength(6); // header plus five books
    expect(within(card('book_table')).getByText('5 of 5 rows')).toBeInTheDocument();
  });

  it('narrows the table through a select filter', async () => {
    const user = userEvent.setup();
    renderWithStore(<AppRenderer model={EXAMPLE_MODELS.book_tracker} />, storeFor(EXAMPLE_MODELS.book_tracker));

    await user.selectOptions(within(card('book_table')).getByLabelText('Genre'), 'Fiction');

    expect(within(card('book_table')).getByText('2 of 5 rows')).toBeInTheDocument();
    expect(within(card('book_table')).queryByText('Thinking in Systems')).not.toBeInTheDocument();
  });

  it('narrows the table through a text filter and clears it again', async () => {
    const user = userEvent.setup();
    renderWithStore(<AppRenderer model={EXAMPLE_MODELS.book_tracker} />, storeFor(EXAMPLE_MODELS.book_tracker));

    await user.type(within(card('book_table')).getByLabelText('Search titles'), 'piranesi');
    expect(within(card('book_table')).getByText('1 of 5 rows')).toBeInTheDocument();

    await user.click(within(card('book_table')).getByRole('button', { name: 'Clear filters' }));
    expect(within(card('book_table')).getByText('5 of 5 rows')).toBeInTheDocument();
  });

  it('adds a row through the form and reflects it in the table and the metrics', async () => {
    const user = userEvent.setup();
    renderWithStore(<AppRenderer model={EXAMPLE_MODELS.book_tracker} />, storeFor(EXAMPLE_MODELS.book_tracker));

    await user.type(within(card('add_book')).getByLabelText(/Title/), 'Pale Fire');
    await user.click(within(card('add_book')).getByRole('button', { name: 'Add to library' }));

    expect(within(card('total_books')).getByText('6')).toBeInTheDocument();
    expect(within(card('unread_books')).getByText('4')).toBeInTheDocument();
    expect(within(card('book_table')).getByText('Pale Fire')).toBeInTheDocument();
  });

  it('refuses to add a row that is missing a required field', async () => {
    const user = userEvent.setup();
    renderWithStore(<AppRenderer model={EXAMPLE_MODELS.book_tracker} />, storeFor(EXAMPLE_MODELS.book_tracker));

    await user.click(within(card('add_book')).getByRole('button', { name: 'Add to library' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Title is required.');
    expect(within(card('total_books')).getByText('5')).toBeInTheDocument();
  });

  it('removes a row and updates the count', async () => {
    const user = userEvent.setup();
    renderWithStore(<AppRenderer model={EXAMPLE_MODELS.book_tracker} />, storeFor(EXAMPLE_MODELS.book_tracker));

    const table = within(card('book_table')).getByRole('table');
    const removeButtons = within(table).getAllByRole('button', { name: /^Remove row/ });
    await user.click(removeButtons[0]!);

    expect(within(card('book_table')).getByText('4 of 4 rows')).toBeInTheDocument();
    expect(within(card('total_books')).getByText('4')).toBeInTheDocument();
  });

  it('applies a fixed where clause without offering a control for it', () => {
    renderWithStore(<AppRenderer model={EXAMPLE_MODELS.expense_log} />, storeFor(EXAMPLE_MODELS.expense_log));

    // Three of the five seeded expenses are over 100.
    expect(within(card('large_expenses')).getByText('3 of 5 rows')).toBeInTheDocument();
  });

  it('renders a text component', () => {
    renderWithStore(<AppRenderer model={EXAMPLE_MODELS.issue_board} />, storeFor(EXAMPLE_MODELS.issue_board));

    expect(within(card('intro')).getByText(/still on the board/)).toBeInTheDocument();
  });

  it('reports a dangling entity reference instead of throwing', () => {
    const broken = {
      ...EXAMPLE_MODELS.contact_list,
      components: [
        { ...EXAMPLE_MODELS.contact_list.components[0]!, entityId: 'missing' },
      ],
    } as typeof EXAMPLE_MODELS.contact_list;

    renderWithStore(<AppRenderer model={broken} />);
    expect(screen.getByText(/does not declare/)).toBeInTheDocument();
  });
});
