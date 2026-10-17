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

describe('assistant ingredient priorities', () => {
  it('adds a soft preference only for shared ingredients and preserves the original inventory', () => {
    const state = kitchen();
    const context = {
      mode: 'selected' as const,
      productIds: ['carrots'],
      preferredProductIds: ['carrots', 'private', 'removed'],
    };
    const markdown = assistantInventoryMarkdown(state, context);
    const preferences = markdown.split('\n\n')[0];
    expect(preferences).toContain(
      'Ingredient preferences (soft, not required): Selected rainbow carrots',
    );
    expect(preferences).toContain('Do not exclude other recipes');
    expect(preferences).toContain("The user's current request takes precedence");
    expect(markdown).not.toContain('UNSHARED_UNIQUE_FOOD');
    expect(markdown).not.toContain('removed');
    expect(assistantInventory(state, context).batches).toEqual(state.batches.slice(0, 2));
    expect(context.preferredProductIds).toEqual(['carrots', 'private', 'removed']);
  });

  it('never shares priorities in None or widens an empty or deleted selection', () => {
    for (const context of [
      {
        mode: 'none' as const,
        productIds: ['carrots'],
        preferredProductIds: ['carrots', 'private'],
      },
      { mode: 'selected' as const, productIds: [], preferredProductIds: ['carrots', 'private'] },
      {
        mode: 'selected' as const,
        productIds: ['removed'],
        preferredProductIds: ['removed', 'private'],
      },
    ]) {
      const markdown = assistantInventoryMarkdown(kitchen(), context);
      expect(markdown).not.toContain('Ingredient preferences');
      expect(markdown).not.toContain('Selected rainbow carrots');
      expect(markdown).not.toContain('UNSHARED_UNIQUE_FOOD');
      expect(assistantInventory(kitchen(), context).products).toEqual([]);
    }
  });

  it('omits priorities for removed, empty, and past-date stock while allowing unknown usable amounts', () => {
    const state = kitchen();
    const context = {
      mode: 'all' as const,
      productIds: [],
      preferredProductIds: ['carrots', 'private', 'removed'],
    };
    state.batches[2].quantity = 0;
    let preferences = assistantInventoryMarkdown(state, context).split('\n\n')[0];
    expect(preferences).toContain('Selected rainbow carrots');
    expect(preferences).not.toContain('UNSHARED_UNIQUE_FOOD');
    state.batches[0].expiresOn = '1900-01-01';
    state.batches[1].expiresOn = '1900-01-01';
    expect(assistantInventoryMarkdown(state, context)).not.toContain('Ingredient preferences');
    state.batches[0].expiresOn = null;
    state.batches[0].stapleStatus = 'empty';
    expect(assistantInventoryMarkdown(state, context)).not.toContain('Ingredient preferences');
    state.batches[0].stapleStatus = undefined;
    preferences = assistantInventoryMarkdown(state, context).split('\n\n')[0];
    expect(preferences).toContain('Selected rainbow carrots');
  });

  it('sanitizes, bounds, and clones priorities without broadening selected inventory', () => {
    const value = {
      mode: 'selected' as const,
      productIds: ['carrots'],
      preferredProductIds: [
        'private',
        'carrots',
        'carrots',
        '',
        ' ',
        42,
        null,
        'x'.repeat(MAX_ASSISTANT_PRODUCT_ID_LENGTH + 1),
      ],
    };
    const normalized = normalizeAssistantInventoryContext(value);
    expect(normalized).toEqual({
      mode: 'selected',
      productIds: ['carrots'],
      preferredProductIds: ['carrots'],
    });
    expect(normalized.preferredProductIds).not.toBe(value.preferredProductIds);
    for (const preferredProductIds of [null, 'carrots', {}, [42, ' ']])
      expect(
        normalizeAssistantInventoryContext({ mode: 'all', productIds: [], preferredProductIds }),
      ).toEqual({ mode: 'all', productIds: [] });
    expect(
      normalizeAssistantInventoryContext({
        mode: 'selected',
        productIds: [],
        preferredProductIds: ['carrots'],
      }),
    ).toEqual({ mode: 'selected', productIds: [] });
    expect(
      normalizeAssistantInventoryContext({
        mode: 'all',
        productIds: [],
        preferredProductIds: Array.from(
          { length: MAX_ASSISTANT_INVENTORY_PRODUCTS + 1 },
          (_, i) => `id-${i}`,
        ),
      }).preferredProductIds,
    ).toHaveLength(MAX_ASSISTANT_INVENTORY_PRODUCTS);
  });
});
