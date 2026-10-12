import { useState } from 'react';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { groupInventory, setBatchRemaining, useBatch as consumeBatch } from '../domain/inventory';
import type { Batch, InventoryState, Product } from '../domain/types';
import { InventoryList } from './InventoryList';

afterEach(cleanup);

const product: Product = {
  id: 'apples',
  name: 'Apples',
  ingredientName: 'Apple',
  isStaple: false,
};
const batch: Batch = {
  id: 'apples-one',
  productId: product.id,
  location: 'fridge',
  quantity: 2,
  unit: 'each',
  purchasedOn: '2026-01-01',
  expiresOn: '2026-12-01',
};

function Harness({
  batches = [batch],
  item = product,
  onEdit = vi.fn(),
  onUse = vi.fn(),
}: {
  batches?: Batch[];
  item?: Product;
  onEdit?: (batch: Batch, product: Product) => void;
  onUse?: (batch: Batch) => void;
}) {
  const [state, setState] = useState<InventoryState>({ products: [item], batches, tools: [] });
  const [expanded, setExpanded] = useState<string | null>(null);
  return (
    <InventoryList
      groups={groupInventory(state)}
      expanded={expanded}
      selected={[]}
      onToggleGroup={(id) => setExpanded((current) => (current === id ? null : id))}
      onToggleSelected={vi.fn()}
      onEdit={onEdit}
      onUse={onUse}
      onDeduct={(purchase) =>
        setState((current) =>
          consumeBatch(current, purchase.id, { amount: 1, unit: purchase.unit }),
        )
      }
      onAddOne={(purchase) =>
        setState((current) => {
          const stored = current.batches.find((entry) => entry.id === purchase.id)!;
          return setBatchRemaining(current, purchase.id, stored.quantity! + 1);
        })
      }
      onClearFilters={vi.fn()}
    />
  );
}

describe('quick inventory quantities', () => {
  it('deducts down to zero and allows adding back without a negative quantity', async () => {
    render(<Harness />);
    const user = userEvent.setup();
    const quick = screen.getByRole('group', { name: 'Quick quantity for Apples' });
    const minus = within(quick).getByRole('button', { name: 'Use one Apples' });
    await user.click(minus);
    await user.click(minus);
    expect(screen.getByText('0 each')).toBeInTheDocument();
    expect(minus).toBeDisabled();
    await user.click(minus);
    expect(screen.getByText('0 each')).toBeInTheDocument();
    await user.click(within(quick).getByRole('button', { name: 'Add one Apples' }));
    expect(screen.getByText('1 each')).toBeInTheDocument();
    expect(minus).toBeEnabled();
  });

  it('updates one available purchase batch and keeps other quantities independent', async () => {
    render(
      <Harness
        batches={[
          { ...batch, quantity: 0, expiresOn: '2026-11-01' },
          {
            ...batch,
            id: 'apples-two',
            quantity: 3,
            purchasedOn: '2026-01-02',
            expiresOn: '2026-12-01',
          },
        ]}
      />,
    );
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Use one Apples' }));
    await user.click(screen.getByRole('button', { name: 'Show batches for Apples' }));
    const purchases = screen.getAllByRole('group', { name: /^Quantity for Apples, bought/ });
    expect(purchases).toHaveLength(2);
    expect(
      within(purchases[0]).getByRole('button', { name: 'Use 1 each of Apples' }),
    ).toBeDisabled();
    expect(screen.getByText('0 each')).toBeInTheDocument();
    expect(screen.getAllByText('2 each')).toHaveLength(2);
    await user.click(within(purchases[0]).getByRole('button', { name: 'Add 1 each to Apples' }));
    expect(screen.getByText('1 each')).toBeInTheDocument();
    expect(screen.getByText('2 each')).toBeInTheDocument();
    expect(screen.getByText('3 each')).toBeInTheDocument();
  });

  it('preserves unknown quantities and keeps the remaining-quantity action available', async () => {
    const onUse = vi.fn();
    render(<Harness batches={[{ ...batch, quantity: null }]} onUse={onUse} />);
    const user = userEvent.setup();
    expect(
      screen.queryByRole('group', { name: 'Quick quantity for Apples' }),
    ).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Show batches for Apples' }));
    expect(screen.queryByRole('button', { name: /^Use 1|^Add 1/ })).not.toBeInTheDocument();
    expect(screen.getAllByText('Quantity unknown')).toHaveLength(2);
    await user.click(screen.getByRole('button', { name: 'Used some' }));
    expect(onUse).toHaveBeenCalledWith({ ...batch, quantity: null });
  });

  it('uses the recorded unit in measured batches and disables excessive deductions', async () => {
    render(<Harness batches={[{ ...batch, quantity: 0.5, unit: 'kg' }]} />);
    const user = userEvent.setup();
    expect(
      screen.queryByRole('group', { name: 'Quick quantity for Apples' }),
    ).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Show batches for Apples' }));
    const minus = screen.getByRole('button', { name: 'Use 1 kg of Apples' });
    expect(minus).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Add 1 kg to Apples' }));
    expect(screen.getAllByText('1.5 kg')).toHaveLength(2);
    expect(minus).toBeEnabled();
    await user.click(minus);
    expect(screen.getAllByText('0.5 kg')).toHaveLength(2);
  });
});

describe('missing recipe identity indicator', () => {
  it.each([undefined, '', '  '])(
    'offers editing when the ingredient name is %s',
    async (ingredientName) => {
      const onEdit = vi.fn();
      const item = { ...product, ingredientName };
      render(<Harness item={item} onEdit={onEdit} />);
      const user = userEvent.setup();
      await user.click(screen.getByRole('button', { name: 'Set recipe match for Apples' }));
      expect(onEdit).toHaveBeenCalledWith(batch, item);
    },
  );

  it('leaves confirmed ingredients unflagged', () => {
    render(<Harness />);
    expect(
      screen.queryByRole('button', { name: 'Set recipe match for Apples' }),
    ).not.toBeInTheDocument();
  });
});
