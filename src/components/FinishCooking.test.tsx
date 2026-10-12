import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Batch, InventoryState } from '../domain/types';
import type { Recipe } from '../recipes/types';
import { FinishCooking } from './FinishCooking';

function stock(batches: Partial<Batch>[] = [{ quantity: 500, unit: 'g' }]): InventoryState {
  return {
    products: [
      { id: 'flour', name: 'Brand flour', ingredientName: 'All-purpose flour', isStaple: false },
    ],
    batches: batches.map((batch, index) => ({
      id: `batch:${index}`,
      productId: 'flour',
      quantity: 500,
      unit: 'g',
      location: 'pantry',
      purchasedOn: `2026-01-${String(index + 1).padStart(2, '0')}`,
      expiresOn: null,
      ...batch,
    })),
    tools: [],
  };
}
function meal(extra: Partial<Recipe> = {}): Recipe {
  return {
    id: 'recipe',
    title: 'Flour recipe',
    servings: 2,
    ingredients: [{ name: 'All-purpose flour', quantity: 300, unit: 'g' }],
    steps: ['Prepare the dish.'],
    source: { type: 'manual' },
    ...extra,
  };
}
function setup(recipe = meal(), inventory = stock(), servings?: number) {
  let current = inventory;
  const update = vi.fn(async (reducer: (state: InventoryState) => InventoryState) => {
    current = reducer(current);
    return current;
  });
  const close = vi.fn();
  const toast = vi.fn();
  render(
    <FinishCooking
      recipe={recipe}
      inventory={inventory}
      servings={servings}
      update={update}
      onClose={close}
      onToast={toast}
    />,
  );
  return {
    update,
    close,
    toast,
    state: () => current,
    setState: (next: InventoryState) => {
      current = next;
    },
  };
}
function amount(date = '2026-01-01', unit = 'g') {
  return screen.getByRole('spinbutton', {
    name: `Amount used from Brand flour, bought ${date} (${unit})`,
  });
}
afterEach(cleanup);

describe('cooking completion review', () => {
  it('never allocates a related ingredient variant before its identity has been reviewed', () => {
    const inventory = stock([{ quantity: 1000, unit: 'mL' }]);
    inventory.products[0] = {
      ...inventory.products[0],
      name: 'Brand whole milk',
      ingredientName: 'Whole milk',
    };
    const view = setup(
      meal({ ingredients: [{ name: 'Milk', quantity: 100, unit: 'mL' }] }),
      inventory,
    );
    expect(screen.queryByRole('spinbutton')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Update inventory' })).toBeDisabled();
    expect(view.update).not.toHaveBeenCalled();
    expect(view.state().batches[0].quantity).toBe(1000);
  });
  it('sums repeated compatible ingredient lines once and allocates oldest purchases with unit conversion', () => {
    setup(
      meal({
        ingredients: [
          { name: 'All-purpose flour', quantity: 100, unit: 'g' },
          { name: 'All purpose flour', quantity: 0.2, unit: 'kg' },
        ],
      }),
      stock([
        { quantity: 0.15, unit: 'kg' },
        { quantity: 500, unit: 'g' },
      ]),
    );
    expect(amount('2026-01-01', 'kg')).toHaveValue(0.15);
    expect(amount('2026-01-02')).toHaveValue(150);
  });

  it('excludes past-date and unknown batches from automatic allocations', () => {
    setup(
      meal(),
      stock([
        { quantity: 500, expiresOn: '2000-01-01' },
        { quantity: null },
        { quantity: 500, expiresOn: '2099-01-01' },
      ]),
    );
    expect(amount()).toHaveValue(null);
    expect(amount('2026-01-02')).toBeDisabled();
    expect(amount('2026-01-03')).toHaveValue(300);
    expect(screen.getByText(/Past entered date/)).toBeInTheDocument();
  });

  it('scales only when the source serving yield is recorded', () => {
    setup(meal(), stock([{ quantity: 1000 }]), 4);
    expect(amount()).toHaveValue(600);
  });

  it('keeps amounts unfilled when serving yield is unknown', () => {
    setup(meal({ servings: null }), stock(), 4);
    expect(amount()).toHaveValue(null);
    expect(screen.getByRole('button', { name: 'Update inventory' })).toBeDisabled();
    expect(screen.getByText(/serving yield is unknown/)).toBeInTheDocument();
  });

  it('never guesses package contents or mass-to-volume conversion', () => {
    setup(
      meal({ ingredients: [{ name: 'All-purpose flour', quantity: 1, unit: 'cup' }] }),
      stock([
        { quantity: 2, unit: 'package' },
        { quantity: 500, unit: 'g' },
      ]),
    );
    expect(amount('2026-01-01', 'package')).toHaveValue(null);
    expect(amount('2026-01-02')).toHaveValue(null);
    expect(screen.getByText(/full recipe amount cannot be allocated/)).toBeInTheDocument();
  });

  it('allows explicit manual package use and preserves unknown stock', async () => {
    const view = setup(
      meal({ ingredients: [{ name: 'All-purpose flour', quantity: 1, unit: 'cup' }] }),
      stock([
        { quantity: 2, unit: 'package' },
        { quantity: null, unit: 'g' },
      ]),
    );
    fireEvent.change(amount('2026-01-01', 'package'), { target: { value: '0.5' } });
    fireEvent.click(screen.getByRole('button', { name: 'Update inventory' }));
    await waitFor(() => expect(view.close).toHaveBeenCalledTimes(1));
    expect(view.state().batches[0].quantity).toBe(1.5);
    expect(view.state().batches[1].quantity).toBeNull();
    expect(view.toast).toHaveBeenCalledWith('Inventory updated for Flour recipe.');
  });

  it('allows usage corrections and restores suggested amounts only on explicit request', () => {
    setup();
    fireEvent.change(amount(), { target: { value: '125' } });
    expect(amount()).toHaveValue(125);
    fireEvent.click(screen.getByRole('button', { name: 'Use suggested amounts' }));
    expect(amount()).toHaveValue(300);
  });

  it('deducts against the latest state instead of overwriting intervening changes', async () => {
    const view = setup();
    fireEvent.change(amount(), { target: { value: '100' } });
    view.setState({ ...view.state(), batches: [{ ...view.state().batches[0], quantity: 400 }] });
    fireEvent.click(screen.getByRole('button', { name: 'Update inventory' }));
    await waitFor(() => expect(view.close).toHaveBeenCalledTimes(1));
    expect(view.state().batches[0].quantity).toBe(300);
  });

  it('rejects a deduction exceeding newly recorded stock and retains the review for correction', async () => {
    const view = setup();
    view.setState({ ...view.state(), batches: [{ ...view.state().batches[0], quantity: 200 }] });
    fireEvent.click(screen.getByRole('button', { name: 'Update inventory' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('only 200 g is now recorded');
    expect(view.state().batches[0].quantity).toBe(200);
    expect(view.close).not.toHaveBeenCalled();
    fireEvent.change(amount(), { target: { value: '150' } });
    fireEvent.click(screen.getByRole('button', { name: 'Update inventory' }));
    await waitFor(() => expect(view.close).toHaveBeenCalledTimes(1));
    expect(view.state().batches[0].quantity).toBe(50);
  });

  it('does not partially deduct when a later batch changed units', async () => {
    const view = setup(
      meal({ ingredients: [{ name: 'All-purpose flour', quantity: 600, unit: 'g' }] }),
      stock([{ quantity: 300 }, { quantity: 500 }]),
    );
    view.setState({
      ...view.state(),
      batches: view
        .state()
        .batches.map((batch, index) => (index === 1 ? { ...batch, unit: 'kg' } : batch)),
    });
    fireEvent.click(screen.getByRole('button', { name: 'Update inventory' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('unit or ingredient changed');
    expect(view.state().batches.map((batch) => batch.quantity)).toEqual([300, 500]);
    expect(view.toast).not.toHaveBeenCalled();
  });

  it('leaves inventory unchanged when the user cancels', () => {
    const view = setup();
    fireEvent.click(screen.getByRole('button', { name: 'Keep inventory unchanged' }));
    expect(view.close).toHaveBeenCalledTimes(1);
    expect(view.update).not.toHaveBeenCalled();
    expect(view.state().batches[0].quantity).toBe(500);
  });

  it('shows matching batches only through explicit ingredient mappings or canonical aliases', () => {
    const inventory = stock();
    inventory.products.push({ id: 'unrelated', name: 'Whole-wheat flour', isStaple: false });
    inventory.batches.push({ ...inventory.batches[0], id: 'other', productId: 'unrelated' });
    setup(meal(), inventory);
    expect(screen.getAllByRole('spinbutton')).toHaveLength(1);
    expect(amount()).toHaveValue(300);
  });
});
