import { describe, expect, it } from 'vitest';
import {
  addBatch,
  addProduct,
  addTool,
  convertQuantity,
  daysBetween,
  formatQuantity,
  groupInventory,
  moveBatch,
  removeBatch,
  setBatchRemaining,
  todayDate,
  updateBatch,
  updateProduct,
  updateTool,
  useBatch,
} from './inventory';
import {
  type Batch,
  type InventoryState,
  createEmptyInventory,
  isDateOnly,
  isInventoryState,
} from './types';

function fixture(): InventoryState {
  return {
    products: [{ id: 'milk', name: 'Milk', isStaple: false, barcode: '123456789' }],
    batches: [
      {
        id: 'milk-1',
        productId: 'milk',
        location: 'fridge',
        quantity: 2,
        unit: 'cartons',
        purchasedOn: '2026-10-01',
        expiresOn: '2026-10-10',
      },
    ],
    tools: [],
  };
}

function batch(patch: Partial<Batch> = {}): Batch {
  return {
    ...fixture().batches[0],
    id: 'milk-2',
    purchasedOn: '2026-10-05',
    expiresOn: '2026-10-15',
    ...patch,
  };
}

describe('remembered package contents', () => {
  it('retains the original reviewed contents when a batch is used or removed', () => {
    let state = fixture();
    state = updateProduct(state, 'milk', {
      packageQuantity: { quantity: 1000, unit: ' mL ' },
      ingredientName: 'Whole milk',
    });
    state = updateBatch(state, 'milk-1', { quantity: 1000, unit: 'mL' });
    state = useBatch(state, 'milk-1', { amount: 250, unit: 'mL' });
    expect(state.batches[0].quantity).toBe(750);
    expect(state.products[0].packageQuantity).toEqual({ quantity: 1000, unit: 'mL' });
    expect(removeBatch(state, 'milk-1').products[0].packageQuantity).toEqual({
      quantity: 1000,
      unit: 'mL',
    });
    expect(isInventoryState(state)).toBe(true);
  });

  it('rejects corrupt original quantities and keeps old product documents valid', () => {
    const state = fixture();
    expect(isInventoryState(state)).toBe(true);
    for (const quantity of [0, -1, Number.POSITIVE_INFINITY, Number.NaN]) {
      expect(() =>
        updateProduct(state, 'milk', { packageQuantity: { quantity, unit: 'mL' } }),
      ).toThrow('greater than zero');
      expect(
        isInventoryState({
          ...state,
          products: [{ ...state.products[0], packageQuantity: { quantity, unit: 'mL' } }],
        }),
      ).toBe(false);
    }
    expect(
      isInventoryState({
        ...state,
        products: [{ ...state.products[0], packageQuantity: { quantity: 1, unit: '' } }],
      }),
    ).toBe(false);
  });
});

describe('calendar dates', () => {
  it('uses local calendar components for today, without shifting to UTC', () => {
    expect(todayDate(new Date(2026, 9, 8, 23, 59))).toBe('2026-10-08');
  });

  it('validates leap dates and rejects overflow or timestamps', () => {
    expect(isDateOnly('2024-02-29')).toBe(true);
    expect(isDateOnly('2025-02-29')).toBe(false);
    expect(isDateOnly('2026-04-31')).toBe(false);
    expect(isDateOnly('2026-10-08T00:00:00Z')).toBe(false);
  });

  it('counts calendar days through daylight-saving boundaries', () => {
    expect(daysBetween('2026-03-07', '2026-03-09')).toBe(2);
    expect(daysBetween('2026-11-02', '2026-10-31')).toBe(-2);
    expect(() => daysBetween('2026-02-30', '2026-03-01')).toThrow('valid calendar date');
  });
});

describe('state validation', () => {
  it('creates fresh, empty production inventories', () => {
    const first = createEmptyInventory();
    const second = createEmptyInventory();
    expect(first).toEqual({ products: [], batches: [], tools: [] });
    expect(first.products).not.toBe(second.products);
    expect(isInventoryState(first)).toBe(true);
  });

  it('rejects corrupt quantities, references, dates, and duplicate IDs', () => {
    const valid = fixture();
    expect(isInventoryState(valid)).toBe(true);
    expect(isInventoryState({ ...valid, batches: [batch({ quantity: Number.NaN })] })).toBe(false);
    expect(isInventoryState({ ...valid, batches: [batch({ productId: 'missing' })] })).toBe(false);
    expect(isInventoryState({ ...valid, batches: [batch({ expiresOn: '2026-02-30' })] })).toBe(
      false,
    );
    expect(isInventoryState({ ...valid, products: [...valid.products, valid.products[0]] })).toBe(
      false,
    );
    expect(isInventoryState({ ...valid, tools: [{ id: 'pan', name: '' }] })).toBe(false);
  });
});

describe('purchase grouping', () => {
  it('preserves separate purchase and expiration dates, grouped by location', () => {
    let state = addBatch(fixture(), batch());
    state = addBatch(state, batch({ id: 'frozen', location: 'freezer' }));
    const groups = groupInventory(state);
    expect(groups.map((group) => group.location)).toEqual(['fridge', 'freezer']);
    expect(groups[0].quantity).toBe(4);
    expect(groups[0].batches.map((item) => [item.purchasedOn, item.expiresOn])).toEqual([
      ['2026-10-01', '2026-10-10'],
      ['2026-10-05', '2026-10-15'],
    ]);
    expect(state.batches.map((item) => item.id)).toEqual(['milk-1', 'milk-2', 'frozen']);
  });

  it('keeps unknown amounts distinct from zero', () => {
    const unknown = groupInventory(addBatch(fixture(), batch({ quantity: null })))[0];
    expect(unknown.quantity).toBeNull();
    expect(unknown.hasUnknownQuantity).toBe(true);
    const zero = groupInventory(setBatchRemaining(fixture(), 'milk-1', 0))[0];
    expect(zero.quantity).toBe(0);
    expect(zero.hasUnknownQuantity).toBe(false);
    expect(formatQuantity(null, 'items')).toBe('Quantity unknown');
    expect(formatQuantity(0, 'items')).toBe('0 items');
  });

  it('sums compatible units and keeps mixed packages and weights separate', () => {
    const weighted = setBatchRemaining(fixture(), 'milk-1', 1, 'lb');
    const compatible = groupInventory(addBatch(weighted, batch({ quantity: 8, unit: 'oz' })))[0];
    expect(compatible.quantity).toBe(1.5);
    expect(compatible.unit).toBe('lb');
    const mixed = groupInventory(addBatch(weighted, batch({ quantity: 1, unit: 'package' })))[0];
    expect(mixed.quantity).toBeNull();
    expect(mixed.hasMixedUnits).toBe(true);
    expect(mixed.hasUnknownQuantity).toBe(false);
  });
});

describe('inventory edits', () => {
  it('adds and updates food and tools without changing the input', () => {
    const original = createEmptyInventory();
    const product = addProduct(original, { id: 'rice', name: ' Rice ', isStaple: true });
    let state = addBatch(product, {
      id: 'rice-1',
      productId: 'rice',
      location: 'pantry',
      quantity: null,
      unit: '',
      purchasedOn: '2026-10-08',
      expiresOn: null,
      stapleStatus: 'stocked',
    });
    state = updateBatch(state, 'rice-1', { stapleStatus: 'low' });
    state = updateProduct(state, 'rice', { name: 'Brown rice' });
    state = addTool(state, { id: 'pan', name: 'Skillet' });
    state = updateTool(state, 'pan', { name: 'Cast iron skillet' });
    expect(original).toEqual(createEmptyInventory());
    expect(product.products[0].name).toBe('Rice');
    expect(state.products[0].name).toBe('Brown rice');
    expect(state.batches[0].stapleStatus).toBe('low');
    expect(state.batches[0].quantity).toBeNull();
    expect(state.tools[0].name).toBe('Cast iron skillet');
  });

  it('preserves dates and amounts when moving storage location', () => {
    const original = fixture();
    const next = moveBatch(original, 'milk-1', 'freezer');
    expect(next.batches[0]).toEqual({ ...original.batches[0], location: 'freezer' });
    expect(original.batches[0].location).toBe('fridge');
  });

  it('requires a valid product, nonnegative quantity, and calendar date', () => {
    expect(() => addBatch(fixture(), batch({ productId: 'missing' }))).toThrow('existing product');
    expect(() => addBatch(fixture(), batch({ quantity: -1 }))).toThrow('zero or greater');
    expect(() => updateBatch(fixture(), 'milk-1', { purchasedOn: '2026-04-31' })).toThrow(
      'calendar date',
    );
    expect(() => addProduct(fixture(), { id: 'milk', name: 'Milk', isStaple: false })).toThrow(
      'already exists',
    );
  });

  it('omits optional undefined fields so normalized batches are safe to persist', () => {
    const state = addBatch(fixture(), batch({ stapleStatus: undefined }));
    expect(Object.hasOwn(state.batches[1], 'stapleStatus')).toBe(false);
    expect(isInventoryState(state)).toBe(true);
  });

  it('allows clearing a brand and barcode without persisting undefined values', () => {
    const branded = updateProduct(fixture(), 'milk', { brand: 'Whole Foods' });
    const cleared = updateProduct(branded, 'milk', { brand: undefined, barcode: '' });
    expect(branded.products[0].brand).toBe('Whole Foods');
    expect(Object.hasOwn(cleared.products[0], 'brand')).toBe(false);
    expect(Object.hasOwn(cleared.products[0], 'barcode')).toBe(false);
    expect(isInventoryState(cleared)).toBe(true);
  });

  it('keeps remembered barcode metadata when the last purchase is removed', () => {
    const original = fixture();
    const next = removeBatch(original, 'milk-1');
    expect(next.batches).toEqual([]);
    expect(next.products[0].barcode).toBe('123456789');
    expect(original.batches).toHaveLength(1);
  });
});

describe('safe consumption', () => {
  it('deducts compatible measurements without changing the original', () => {
    const original = setBatchRemaining(fixture(), 'milk-1', 2, 'lb');
    const next = useBatch(original, 'milk-1', { amount: 8, unit: 'oz' });
    expect(next.batches[0].quantity).toBe(1.5);
    expect(original.batches[0].quantity).toBe(2);
    expect(convertQuantity(3, 'tsp', 'tbsp')).toBeCloseTo(1);
    expect(convertQuantity(1, ' CUP ', 'ml')).toBeCloseTo(236.5882365);
  });

  it('rejects package-weight guesses, mass-volume conversion, and overuse', () => {
    expect(() => useBatch(fixture(), 'milk-1', { amount: 1, unit: 'cups' })).toThrow(
      'recorded unit',
    );
    expect(() => convertQuantity(1, 'oz', 'fl oz')).toThrow('recorded unit');
    expect(() => useBatch(fixture(), 'milk-1', { amount: 3, unit: 'cartons' })).toThrow(
      'more than',
    );
    expect(() => useBatch(fixture(), 'milk-1', { amount: 0, unit: 'cartons' })).toThrow(
      'greater than zero',
    );
  });

  it('requires a remaining amount when the starting quantity is unknown', () => {
    const unknown = setBatchRemaining(fixture(), 'milk-1', null);
    expect(() => useBatch(unknown, 'milk-1', { amount: 1, unit: 'cartons' })).toThrow(
      'amount remaining',
    );
    expect(setBatchRemaining(unknown, 'milk-1', 1).batches[0].quantity).toBe(1);
  });

  it('records consuming an entire batch as zero without deleting the purchase or barcode', () => {
    const emptied = useBatch(fixture(), 'milk-1', { amount: 2, unit: 'cartons' });
    expect(emptied.batches).toHaveLength(1);
    expect(emptied.batches[0].quantity).toBe(0);
    expect(emptied.products[0].barcode).toBe('123456789');
  });
});
