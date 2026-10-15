import { describe, expect, it } from 'vitest';
import { generateMarkdown } from '../domain/export';
import {
  MAX_ASSISTANT_INVENTORY_PRODUCTS,
  MAX_ASSISTANT_PRODUCT_ID_LENGTH,
  type InventoryState,
} from '../domain/types';
import {
  assistantInventory,
  assistantInventoryContextForSession,
  assistantInventoryMarkdown,
  normalizeAssistantInventoryContext,
} from './inventoryContext';
import { emptyAssistantSession } from './conversation';

function kitchen(): InventoryState {
  return {
    products: [
      { id: 'carrots', name: 'Selected rainbow carrots', isStaple: false },
      { id: 'private', name: 'UNSHARED_UNIQUE_FOOD', isStaple: false },
    ],
    batches: [
      {
        id: 'fresh-carrots',
        productId: 'carrots',
        location: 'fridge',
        quantity: null,
        unit: 'bag',
        purchasedOn: '2026-10-10',
        expiresOn: '2026-10-20',
      },
      {
        id: 'frozen-carrots',
        productId: 'carrots',
        location: 'freezer',
        quantity: 250,
        unit: 'g',
        purchasedOn: '2026-10-11',
        expiresOn: null,
      },
      {
        id: 'private-purchase',
        productId: 'private',
        location: 'pantry',
        quantity: 3,
        unit: 'package',
        purchasedOn: '2026-10-12',
        expiresOn: null,
      },
    ],
    tools: [{ id: 'private-tool', name: 'UNSHARED_UNIQUE_TOOL' }],
    recipes: [],
    nutritionTargets: {
      caloriesKcal: 2100,
      proteinGrams: null,
      carbsGrams: null,
      fatGrams: null,
    },
  };
}

describe('assistant inventory sharing boundary', () => {
  it('retains full context for existing sessions without a preference', () => {
    const state = kitchen();
    const defaultContext = { mode: 'all', productIds: [] };
    expect(assistantInventoryContextForSession()).toEqual(defaultContext);
    expect(assistantInventoryContextForSession(emptyAssistantSession())).toEqual(defaultContext);
    expect(assistantInventory(state)).toBe(state);
    expect(assistantInventoryMarkdown(state)).toBe(generateMarkdown(state, { includeTools: true }));
  });

  it('selects the product across all locations while preserving batch details and other context', () => {
    const state = kitchen();
    const context = { mode: 'selected' as const, productIds: ['carrots'] };
    const filtered = assistantInventory(state, context);
    expect(filtered.products.map((product) => product.id)).toEqual(['carrots']);
    expect(filtered.batches).toEqual(state.batches.slice(0, 2));
    expect(filtered.tools).toEqual([]);
    expect(filtered.recipes).toBe(state.recipes);
    expect(filtered.nutritionTargets).toBe(state.nutritionTargets);
    const markdown = assistantInventoryMarkdown(state, context);
    expect(markdown).toContain('partial inventory');
    expect(markdown).toContain('Do not assume unlisted items are missing or unavailable');
    expect(markdown).toContain('## Fridge');
    expect(markdown).toContain('## Freezer');
    expect(markdown).toContain('Quantity unknown');
    expect(markdown).toContain('250 g');
    expect(markdown).toContain('2026-10-20');
    expect(markdown).not.toContain('UNSHARED_UNIQUE_FOOD');
    expect(markdown).not.toContain('UNSHARED_UNIQUE_TOOL');
    expect(markdown).not.toContain('Kitchen tools');
    expect(state.products).toHaveLength(2);
    expect(state.tools).toHaveLength(1);
  });

  it('shares no inventory records or equipment in none mode and never implies an empty kitchen', () => {
    const state = kitchen();
    const context = { mode: 'none' as const, productIds: ['carrots'] };
    const filtered = assistantInventory(state, context);
    expect(filtered.products).toEqual([]);
    expect(filtered.batches).toEqual([]);
    expect(filtered.tools).toEqual([]);
    expect(assistantInventoryMarkdown(state, context)).toBe(
      'Inventory not shared for this message. Availability has not been checked.',
    );
  });

  it('never expands an empty or entirely deleted selection to the full kitchen', () => {
    for (const productIds of [[], ['deleted-product']]) {
      const context = { mode: 'selected' as const, productIds };
      const state = assistantInventory(kitchen(), context);
      expect(state.products).toEqual([]);
      expect(state.batches).toEqual([]);
      expect(state.tools).toEqual([]);
      const markdown = assistantInventoryMarkdown(kitchen(), context);
      expect(markdown).toContain('No ingredients selected for this message');
      expect(markdown).toContain('partial inventory');
      expect(markdown).not.toContain('Selected rainbow carrots');
      expect(markdown).not.toContain('UNSHARED');
    }
  });

  it('drops stale IDs without dropping genuine selections or changing the caller preference', () => {
    const context = { mode: 'selected' as const, productIds: ['deleted-product', 'carrots'] };
    expect(assistantInventory(kitchen(), context).products.map((product) => product.id)).toEqual([
      'carrots',
    ]);
    expect(context.productIds).toEqual(['deleted-product', 'carrots']);
  });

  it('fails closed for malformed modes and sanitizes selected IDs without switching modes', () => {
    for (const malformed of [null, [], 'all', {}, { mode: 'everything' }])
      expect(normalizeAssistantInventoryContext(malformed)).toEqual({
        mode: 'none',
        productIds: [],
      });
    expect(
      normalizeAssistantInventoryContext({
        mode: 'selected',
        productIds: [
          'carrots',
          '',
          null,
          3,
          ' ',
          'carrots',
          'x'.repeat(MAX_ASSISTANT_PRODUCT_ID_LENGTH + 1),
        ],
        token: 'MUST_NOT_COPY',
      }),
    ).toEqual({ mode: 'selected', productIds: ['carrots'] });
    expect(normalizeAssistantInventoryContext({ mode: 'selected', productIds: null })).toEqual({
      mode: 'selected',
      productIds: [],
    });
    expect(
      normalizeAssistantInventoryContext({
        mode: 'selected',
        productIds: Array.from(
          { length: MAX_ASSISTANT_INVENTORY_PRODUCTS + 1 },
          (_, i) => `id-${i}`,
        ),
      }).productIds,
    ).toHaveLength(MAX_ASSISTANT_INVENTORY_PRODUCTS);
  });
});
