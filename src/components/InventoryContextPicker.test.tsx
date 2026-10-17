import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createEmptyInventory,
  type AssistantInventoryContext,
  type InventoryState,
} from '../domain/types';
import { InventoryContextPicker } from './InventoryContextPicker';

afterEach(cleanup);

function inventory(): InventoryState {
  return {
    ...createEmptyInventory(),
    products: [
      {
        id: 'a',
        name: 'Garden carrots',
        ingredientName: 'carrot',
        brand: 'Market garden',
        isStaple: false,
      },
      { id: 'b', name: 'Greek yogurt', brand: 'Cultured dairy', isStaple: false },
      { id: 'c', name: 'Whole milk', ingredientName: 'milk', isStaple: false },
      { id: 'old', name: 'Previously bought item', isStaple: false },
    ],
    batches: [
      {
        id: 'a1',
        productId: 'a',
        location: 'fridge',
        quantity: 2,
        unit: 'items',
        purchasedOn: '2026-10-14',
        expiresOn: null,
      },
      {
        id: 'a2',
        productId: 'a',
        location: 'freezer',
        quantity: null,
        unit: 'items',
        purchasedOn: '2026-10-14',
        expiresOn: null,
      },
      {
        id: 'a3',
        productId: 'a',
        location: 'freezer',
        quantity: 250,
        unit: 'g',
        purchasedOn: '2026-10-14',
        expiresOn: null,
      },
      {
        id: 'b1',
        productId: 'b',
        location: 'fridge',
        quantity: 4,
        unit: 'cups',
        purchasedOn: '2026-10-14',
        expiresOn: null,
      },
      {
        id: 'c1',
        productId: 'c',
        location: 'fridge',
        quantity: 1,
        unit: 'carton',
        purchasedOn: '2026-10-14',
        expiresOn: null,
      },
    ],
  };
}

function setup(value: AssistantInventoryContext = { mode: 'selected', productIds: [] }) {
  const save = vi.fn().mockResolvedValue(undefined);
  const close = vi.fn();
  render(
    <InventoryContextPicker inventory={inventory()} value={value} onSave={save} onClose={close} />,
  );
  return { save, close, user: userEvent.setup() };
}

describe('chat inventory selection', () => {
  it('shows each stocked product once and keeps mixed units and unknown amounts explicit', () => {
    setup();
    expect(screen.getAllByRole('checkbox')).toHaveLength(3);
    expect(
      screen.getByRole('checkbox', {
        name: /Garden carrots.*Fridge.*Freezer.*2 items \+ 250 g \+ Quantity unknown/,
      }),
    ).toBeInTheDocument();
    expect(screen.queryByText('Previously bought item')).not.toBeInTheDocument();
    expect(
      screen.getByText('No ingredients selected. Your inventory will not be shared.'),
    ).toBeVisible();
  });

  it('searches by ingredient mapping and brand, preserving selections outside the search', async () => {
    const { user, save, close } = setup();
    await user.click(screen.getByRole('checkbox', { name: /Greek yogurt/ }));
    const search = screen.getByRole('searchbox', { name: 'Search your ingredients' });
    await user.type(search, 'CARROT');
    expect(screen.getAllByRole('checkbox')).toHaveLength(1);
    expect(screen.getByRole('status')).toHaveTextContent('1 selected');
    await user.click(screen.getByRole('button', { name: 'Select all results' }));
    expect(screen.getByRole('status')).toHaveTextContent('2 selected');
    await user.clear(search);
    await user.type(search, 'cultured');
    expect(screen.getByRole('checkbox', { name: /Greek yogurt/ })).toBeChecked();
    await user.click(screen.getByRole('button', { name: 'Apply to chat' }));
    expect(save).toHaveBeenCalledExactlyOnceWith({ mode: 'selected', productIds: ['b', 'a'] });
    expect(close).toHaveBeenCalledOnce();
  });

  it('keeps a draft while switching modes and cancels without changing saved context', async () => {
    const value: AssistantInventoryContext = { mode: 'all', productIds: ['a'] };
    const { user, save, close } = setup(value);
    await user.click(screen.getByRole('radio', { name: /Choose ingredients/ }));
    await user.click(screen.getByRole('checkbox', { name: /Whole milk/ }));
    await user.click(screen.getByRole('radio', { name: /No inventory/ }));
    expect(screen.queryByRole('searchbox')).not.toBeInTheDocument();
    await user.click(screen.getByRole('radio', { name: /Choose ingredients/ }));
    expect(screen.getByRole('checkbox', { name: /Garden carrots/ })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: /Whole milk/ })).toBeChecked();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(save).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
    expect(value).toEqual({ mode: 'all', productIds: ['a'] });
  });

  it('saves No inventory explicitly without discarding the remembered ingredient selection', async () => {
    const { user, save } = setup({ mode: 'selected', productIds: ['a'] });
    await user.click(screen.getByRole('radio', { name: /No inventory/ }));
    await user.click(screen.getByRole('button', { name: 'Apply to chat' }));
    expect(save).toHaveBeenCalledExactlyOnceWith({ mode: 'none', productIds: ['a'] });
  });

  it('allows an explicitly empty selection and Clear removes selections outside the current search', async () => {
    const { user, save } = setup({ mode: 'selected', productIds: ['a', 'b'] });
    await user.type(screen.getByRole('searchbox'), 'milk');
    await user.click(screen.getByRole('button', { name: 'Clear' }));
    expect(screen.getByRole('status')).toHaveTextContent('0 selected');
    await user.click(screen.getByRole('button', { name: 'Apply to chat' }));
    expect(save).toHaveBeenCalledExactlyOnceWith({ mode: 'selected', productIds: [] });
  });

  it('retains the selection after a failed save and waits for a successful retry before closing', async () => {
    const { user, save, close } = setup({ mode: 'selected', productIds: ['b'] });
    save.mockRejectedValueOnce(new Error('Your browser could not save this change.'));
    await user.click(screen.getByRole('button', { name: 'Apply to chat' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Your browser could not save this change.',
    );
    expect(screen.getByRole('checkbox', { name: /Greek yogurt/ })).toBeChecked();
    expect(close).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Apply to chat' }));
    expect(save).toHaveBeenCalledTimes(2);
    expect(close).toHaveBeenCalledOnce();
  });

  it('shows useful empty inventory and no search results states', async () => {
    const { user } = setup();
    await user.type(screen.getByRole('searchbox'), 'dragon fruit');
    expect(screen.getByText('No matching ingredients. Try another name or brand.')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Select all results' })).toBeDisabled();
    cleanup();
    render(
      <InventoryContextPicker
        inventory={createEmptyInventory()}
        value={{ mode: 'selected', productIds: [] }}
        onSave={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(
      screen.getByText('Your inventory is empty. Add ingredients in Inventory when you’re ready.'),
    ).toBeVisible();
  });
});

describe('soft ingredient priorities', () => {
  it('stars an ingredient independently of sharing and disables stars for unshared ingredients', async () => {
    const { user, save } = setup({ mode: 'selected', productIds: ['a'] });
    const carrots = screen.getByRole('checkbox', { name: /Garden carrots/ });
    const priority = screen.getByRole('button', { name: 'Prioritize Garden carrots' });
    expect(screen.getByRole('button', { name: 'Prioritize Greek yogurt' })).toBeDisabled();
    await user.click(priority);
    expect(priority).toHaveAttribute('aria-pressed', 'true');
    expect(carrots).toBeChecked();
    expect(screen.getByRole('status')).toHaveTextContent('1 selected · 1 prioritized');
    await user.click(priority);
    expect(priority).toHaveAttribute('aria-pressed', 'false');
    expect(carrots).toBeChecked();
    await user.click(priority);
    await user.click(screen.getByRole('button', { name: 'Apply to chat' }));
    expect(save).toHaveBeenCalledExactlyOnceWith({
      mode: 'selected',
      productIds: ['a'],
      preferredProductIds: ['a'],
    });
  });

  it('removes a priority when its ingredient is unshared and Clear also removes hidden priorities', async () => {
    const { user, save } = setup({
      mode: 'selected',
      productIds: ['a', 'b'],
      preferredProductIds: ['a', 'b'],
    });
    await user.click(screen.getByRole('checkbox', { name: /Garden carrots/ }));
    const priority = screen.getByRole('button', { name: 'Prioritize Garden carrots' });
    expect(priority).toBeDisabled();
    expect(priority).toHaveAttribute('aria-pressed', 'false');
    await user.click(screen.getByRole('checkbox', { name: /Garden carrots/ }));
    expect(priority).toHaveAttribute('aria-pressed', 'false');
    await user.type(screen.getByRole('searchbox'), 'milk');
    await user.click(screen.getByRole('button', { name: 'Clear' }));
    expect(screen.getByRole('status')).toHaveTextContent('0 selected');
    await user.click(screen.getByRole('button', { name: 'Apply to chat' }));
    expect(save).toHaveBeenCalledExactlyOnceWith({ mode: 'selected', productIds: [] });
  });

  it('lets all-inventory users choose and clear priorities without changing remembered selections', async () => {
    const { user, save } = setup({ mode: 'all', productIds: ['a'] });
    await user.click(screen.getByRole('button', { name: 'Prioritize ingredients' }));
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Prioritize Greek yogurt' }));
    expect(screen.getByRole('status')).toHaveTextContent('All inventory shared · 1 prioritized');
    await user.type(screen.getByRole('searchbox'), 'carrot');
    await user.click(screen.getByRole('button', { name: 'Clear priorities' }));
    expect(screen.getByRole('status')).not.toHaveTextContent('prioritized');
    await user.click(screen.getByRole('button', { name: 'Apply to chat' }));
    expect(save).toHaveBeenCalledExactlyOnceWith({ mode: 'all', productIds: ['a'] });
  });

  it('keeps saved priorities when reopened and discards a cancelled priority draft', async () => {
    const value: AssistantInventoryContext = {
      mode: 'all',
      productIds: [],
      preferredProductIds: ['a'],
    };
    let controls = setup(value);
    expect(screen.getByRole('button', { name: 'Prioritize Garden carrots' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await controls.user.click(screen.getByRole('button', { name: 'Prioritize Greek yogurt' }));
    await controls.user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(controls.save).not.toHaveBeenCalled();
    expect(value.preferredProductIds).toEqual(['a']);
    cleanup();
    controls = setup(value);
    expect(screen.getByRole('button', { name: 'Prioritize Garden carrots' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(screen.getByRole('button', { name: 'Prioritize Greek yogurt' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
    await controls.user.click(screen.getByRole('button', { name: 'Prioritize Greek yogurt' }));
    await controls.user.click(screen.getByRole('button', { name: 'Apply to chat' }));
    const saved = controls.save.mock.calls[0][0] as AssistantInventoryContext;
    cleanup();
    setup(saved);
    expect(screen.getByRole('button', { name: 'Prioritize Garden carrots' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(screen.getByRole('button', { name: 'Prioritize Greek yogurt' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });

  it('retains a priority after a failed save and shares none while No inventory is selected', async () => {
    const { user, save, close } = setup({
      mode: 'selected',
      productIds: ['a'],
      preferredProductIds: ['a'],
    });
    save.mockRejectedValueOnce(new Error('Please retry saving.'));
    await user.click(screen.getByRole('button', { name: 'Apply to chat' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Please retry saving.');
    expect(screen.getByRole('button', { name: 'Prioritize Garden carrots' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(close).not.toHaveBeenCalled();
    await user.click(screen.getByRole('radio', { name: 'No inventory' }));
    expect(
      screen.queryByRole('button', { name: 'Prioritize Garden carrots' }),
    ).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Apply to chat' }));
    expect(save).toHaveBeenLastCalledWith({
      mode: 'none',
      productIds: ['a'],
      preferredProductIds: ['a'],
    });
    expect(close).toHaveBeenCalledOnce();
  });
});

it('disables ingredient priorities for empty or past-date stock', () => {
  const state = inventory();
  state.batches
    .filter((batch) => batch.productId === 'a')
    .forEach((batch) => {
      batch.quantity = 0;
    });
  state.batches.find((batch) => batch.productId === 'b')!.expiresOn = '1900-01-01';
  render(
    <InventoryContextPicker
      inventory={state}
      value={{ mode: 'selected', productIds: ['a', 'b', 'c'], preferredProductIds: ['a', 'b'] }}
      onSave={vi.fn()}
      onClose={vi.fn()}
    />,
  );
  expect(screen.getByRole('button', { name: 'Prioritize Garden carrots' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Prioritize Greek yogurt' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Prioritize Whole milk' })).toBeEnabled();
  expect(screen.getByRole('status')).not.toHaveTextContent('prioritized');
});
