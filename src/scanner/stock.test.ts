import { describe, expect, it } from 'vitest';
import { createEmptyInventory } from '../domain/types';
import type { ItemDraft } from '../components/ItemEditor';
import {
  findBarcodeProduct,
  matchingShoppingItem,
  stockScannedItem,
  validateScanDraft,
} from './stock';

const draft: ItemDraft = {
  name: 'Brand cheddar',
  brand: 'Brand',
  ingredientName: 'Cheddar cheese',
  ingredientConfirmed: true,
  quantity: '200',
  unit: 'g',
  purchasedOn: '2026-01-01',
  expiresOn: '',
  location: 'freezer',
  isStaple: false,
  stapleStatus: 'stocked',
};
const input = {
  draft,
  barcode: '0012345678905',
  productId: 'p1',
  batchId: 'b1',
  packageQuantity: { quantity: 200, unit: 'g' },
};
describe('reviewed grocery purchases', () => {
  it('keeps a new package size distinct from old remaining stock', () => {
    let state = stockScannedItem(createEmptyInventory(), input);
    state = { ...state, batches: [{ ...state.batches[0], quantity: 30 }] };
    const next = stockScannedItem(state, {
      ...input,
      batchId: 'b2',
      productId: 'unused',
      draft: { ...draft, location: 'fridge' },
    });
    expect(next.products).toHaveLength(1);
    expect(next.products[0].packageQuantity).toEqual({ quantity: 200, unit: 'g' });
    expect(next.batches.map((batch) => [batch.quantity, batch.location])).toEqual([
      [30, 'freezer'],
      [200, 'fridge'],
    ]);
    expect(findBarcodeProduct(next, '0012345678905')?.ingredientName).toBe('Cheddar cheese');
  });
  it('retains different barcodes with identical display names', () => {
    const first = stockScannedItem(createEmptyInventory(), input);
    const next = stockScannedItem(first, {
      ...input,
      barcode: '4006381333931',
      productId: 'p2',
      batchId: 'b2',
    });
    expect(next.products).toHaveLength(2);
  });
  it.each(['package', 'packages', 'can', 'cans', 'pieces', 'ct', 'cartons'])(
    'does not remember a multi-package purchase as the size of one %s',
    (unit) => {
      const next = stockScannedItem(createEmptyInventory(), {
        ...input,
        packageQuantity: undefined,
        draft: { ...draft, quantity: '3', unit },
      });
      expect(next.batches[0].quantity).toBe(3);
      expect(next.products[0].packageQuantity).toEqual({ quantity: 1, unit });
    },
  );
  it('requires ingredient confirmation and preserves unknown amounts', () => {
    expect(validateScanDraft({ ...draft, ingredientConfirmed: false })).toMatch(/Confirm/);
    const next = stockScannedItem(createEmptyInventory(), {
      ...input,
      packageQuantity: undefined,
      draft: { ...draft, quantity: '' },
    });
    expect(next.batches[0].quantity).toBeNull();
    expect(next.products[0].packageQuantity).toBeUndefined();
  });
  it('keeps original package contents when purchase quantity differs, and changes them only on explicit confirmation', () => {
    const original = stockScannedItem(createEmptyInventory(), input);
    const purchase = {
      ...input,
      productId: 'unused',
      batchId: 'b2',
      draft: { ...draft, quantity: '400' },
    };
    const next = stockScannedItem(original, purchase);
    expect(next.batches[1].quantity).toBe(400);
    expect(next.products[0].packageQuantity).toEqual({ quantity: 200, unit: 'g' });
    const corrected = stockScannedItem(original, { ...purchase, rememberPackageQuantity: true });
    expect(corrected.products[0].packageQuantity).toEqual({ quantity: 400, unit: 'g' });
  });
  it('checks only a confirmed matching shopping line with a sufficient convertible quantity', () => {
    const state = {
      ...createEmptyInventory(),
      shoppingList: [
        {
          id: 's1',
          name: 'cheddar cheese',
          quantity: 0.15,
          unit: 'kg',
          checked: false,
          status: 'missing' as const,
        },
      ],
    };
    expect(matchingShoppingItem(state, draft)).toBe('s1');
    expect(
      matchingShoppingItem(state, { ...draft, quantity: '1', unit: 'package' }),
    ).toBeUndefined();
    expect(matchingShoppingItem(state, { ...draft, quantity: '100' })).toBeUndefined();
    const next = stockScannedItem(state, { ...input, shoppingId: 's1' });
    expect(next.shoppingList?.[0]).toMatchObject({ checked: true, addedBatchId: 'b1' });
    const insufficient = stockScannedItem(state, {
      ...input,
      draft: { ...draft, quantity: '100' },
      shoppingId: 's1',
    });
    expect(insufficient.shoppingList?.[0].checked).toBe(false);
    const changed = stockScannedItem(state, {
      ...input,
      draft: { ...draft, ingredientName: 'Milk' },
      shoppingId: 's1',
    });
    expect(changed.shoppingList?.[0].checked).toBe(false);
  });
});
