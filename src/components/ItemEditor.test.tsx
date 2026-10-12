import { useState } from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ItemEditor, type ItemDraft } from './ItemEditor';

vi.mock('../food/useFoodCatalog', () => ({
  useFoodCatalog: () => ({
    names: ['Carrots', 'Chicken breast', 'Rice'],
    expanded: false,
    loading: false,
  }),
}));
afterEach(cleanup);
function Harness({ initial }: { initial?: Partial<ItemDraft> }) {
  const [draft, setDraft] = useState<ItemDraft>({
    name: '',
    brand: '',
    ingredientName: '',
    ingredientConfirmed: false,
    quantity: '',
    unit: 'each',
    location: 'fridge',
    purchasedOn: '2026-01-01',
    expiresOn: '',
    isStaple: false,
    stapleStatus: 'stocked',
    ...initial,
  });
  return (
    <ItemEditor
      editor={{ kind: 'add' }}
      draft={draft}
      onDraftChange={setDraft}
      onClose={vi.fn()}
      onSubmit={(event) => event.preventDefault()}
      onRemove={vi.fn()}
      busy={false}
      error=""
    />
  );
}
describe('compact editable recipe identity', () => {
  it('shows clear matches compactly and keeps corrections editable across parent renders', async () => {
    render(<Harness />);
    const user = userEvent.setup();
    await user.type(screen.getByRole('combobox', { name: 'Item name' }), 'Carrots');
    expect(screen.getByText(/Recipes recognize this as/)).toHaveTextContent('Carrot');
    expect(screen.queryByRole('combobox', { name: 'Ingredient name' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Change recipe match' }));
    const match = screen.getByRole('combobox', { name: 'Ingredient name' });
    await user.clear(match);
    await user.type(match, 'Chicken breast');
    expect(match).toHaveValue('Chicken breast');
    await user.click(screen.getByRole('button', { name: 'Done' }));
    expect(screen.getByText(/Recipes recognize this as/)).toHaveTextContent('Chicken breast');
    expect(screen.getByRole('combobox', { name: 'Item name' })).toHaveValue('Carrots');
  });
  it('opens unknown names for confirmation and permits keeping a separate product identity', async () => {
    render(<Harness />);
    const user = userEvent.setup();
    await user.type(screen.getByRole('combobox', { name: 'Item name' }), 'Mystery supper');
    expect(screen.getByRole('combobox', { name: 'Ingredient name' })).toHaveValue('');
    await user.click(screen.getByRole('button', { name: 'Use product name' }));
    expect(screen.getByText(/Recipes recognize this as/)).toHaveTextContent('Mystery supper');
    expect(screen.queryByRole('combobox', { name: 'Ingredient name' })).not.toBeInTheDocument();
  });
  it('invalidates an old confirmed mapping when the product name changes', async () => {
    render(
      <Harness
        initial={{ name: 'Carrots', ingredientName: 'Carrot', ingredientConfirmed: true }}
      />,
    );
    const user = userEvent.setup();
    const name = screen.getByRole('combobox', { name: 'Item name' });
    await user.clear(name);
    await user.type(name, 'Mystery supper');
    expect(screen.queryByText(/Recipes recognize this as/)).not.toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Ingredient name' })).toHaveValue('');
  });
});
