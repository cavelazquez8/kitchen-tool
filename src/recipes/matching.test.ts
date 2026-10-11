import { describe, expect, it } from 'vitest';
import type { Batch, InventoryState } from '../domain/types';
import type { Recipe } from './types';
import { buildShoppingList, canonicalIngredientName, matchRecipe, rankRecipes } from './matching';

function inventory(
  name: string,
  batches: Partial<Batch>[] = [{ quantity: 250, unit: 'g' }],
): InventoryState {
  return {
    products: [{ id: 'food', name, isStaple: false }],
    batches: batches.map((batch, index) => ({
      id: `batch:${index}`,
      productId: 'food',
      quantity: 250,
      unit: 'g',
      location: 'fridge',
      purchasedOn: '2026-10-01',
      expiresOn: null,
      ...batch,
    })),
    tools: [],
  };
}
function recipe(
  quantity: number | null = 400,
  unit = 'g',
  name = 'Chicken breast',
  extra: Partial<Recipe> = {},
): Recipe {
  return {
    id: 'recipe:1',
    title: 'Chicken dinner',
    servings: 2,
    ingredients: [{ name, quantity, unit }],
    steps: ['Cook thoroughly.'],
    source: { type: 'manual' },
    ...extra,
  };
}
const options = { today: '2026-10-10' };

describe('quantity-aware recipe matching', () => {
  it('combines compatible batches and computes a fractional shortage', () => {
    const state = inventory('Chicken breasts', [
      { quantity: 0.25, unit: 'kg' },
      { quantity: 50, unit: 'g', location: 'freezer' },
    ]);
    const match = matchRecipe(recipe(), state, options);
    expect(match.status).toBe('almost');
    expect(match.ingredients[0]).toMatchObject({ status: 'short', available: 300, shortage: 100 });
    expect(state.batches[0].quantity).toBe(0.25);
    expect(matchRecipe(recipe(299.5), state, options).status).toBe('ready');
  });
  it('does not count absent ingredients, empty staples, or zero stock', () => {
    expect(
      matchRecipe(recipe(), inventory('Chicken breast', [{ quantity: 0 }]), options).ingredients[0]
        .status,
    ).toBe('missing');
    expect(
      matchRecipe(
        recipe(),
        inventory('Chicken breast', [{ quantity: null, stapleStatus: 'empty' }]),
        options,
      ).ingredients[0].status,
    ).toBe('missing');
    expect(matchRecipe(recipe(), inventory('Whole chicken'), options).ingredients[0].status).toBe(
      'missing',
    );
  });
  it('flags unknown amounts, package contents, and mass-volume conversions', () => {
    expect(
      matchRecipe(
        recipe(),
        inventory('Chicken breast', [{ quantity: 1, unit: 'package' }]),
        options,
      ).status,
    ).toBe('check');
    expect(
      matchRecipe(
        recipe(),
        inventory('Chicken breast', [{ quantity: null, unit: 'g', stapleStatus: 'stocked' }]),
        options,
      ).status,
    ).toBe('check');
    expect(matchRecipe(recipe(1, 'cup'), inventory('Chicken breast'), options).status).toBe(
      'check',
    );
    expect(matchRecipe(recipe(null), inventory('Chicken breast'), options).status).toBe('check');
  });
  it('does not let an unrelated unknown batch obscure sufficient known amounts', () => {
    expect(
      matchRecipe(
        recipe(),
        inventory('Chicken breast', [{ quantity: 500 }, { quantity: null, unit: 'package' }]),
        options,
      ).status,
    ).toBe('ready');
  });
  it('excludes past-date stock, permits explicit override, and honors selected items', () => {
    const state = inventory('Chicken breast', [{ quantity: 500, expiresOn: '2026-10-09' }]);
    expect(matchRecipe(recipe(), state, options).ingredients[0].reason).toContain('past-date');
    expect(matchRecipe(recipe(), state, { ...options, excludeExpired: false }).status).toBe(
      'ready',
    );
    expect(
      matchRecipe(recipe(), state, { ...options, excludeExpired: false, selectedProductIds: [] })
        .ingredients[0].status,
    ).toBe('missing');
  });
  it('scales known yields and warns instead of inventing unknown serving amounts', () => {
    const state = inventory('Chicken breast', [{ quantity: 500 }]);
    expect(matchRecipe(recipe(), state, { ...options, servings: 4 }).ingredients[0].shortage).toBe(
      300,
    );
    const unknown = matchRecipe(recipe(400, 'g', 'Chicken breast', { servings: null }), state, {
      ...options,
      servings: 4,
    });
    expect(unknown.status).toBe('check');
    expect(unknown.ingredients[0].required).toBeNull();
    expect(unknown.warnings[0]).toContain('yield is unknown');
    expect(
      matchRecipe(recipe(400, 'g', 'Chicken breast', { servings: null }), state, options).status,
    ).toBe('ready');
  });
  it('combines repeat ingredient lines and omits optional additions', () => {
    const repeated = recipe(200, 'g', 'Chicken breast');
    repeated.ingredients.push(
      { name: 'Chicken breast', quantity: 200, unit: 'g' },
      { name: 'Parsley', quantity: null, unit: '', optional: true },
    );
    const match = matchRecipe(repeated, inventory('Chicken breast'), options);
    expect(match.ingredients).toHaveLength(1);
    expect(match.ingredients[0].shortage).toBe(150);
  });
  it('ranks ready recipes ahead of uncertain and near matches', () => {
    const matches = rankRecipes(
      [
        recipe(400),
        recipe(200, 'g', 'Chicken breast', { id: 'ready', title: 'Ready' }),
        recipe(null, 'g', 'Chicken breast', { id: 'check', title: 'Check' }),
      ],
      inventory('Chicken breast'),
      options,
    );
    expect(matches.map((match) => match.status)).toEqual(['ready', 'check', 'almost']);
  });
  it('respects stocked staples, low unknown amounts, and explicit branded ingredient mapping', () => {
    const state = inventory('Pantry salt', [
      { quantity: null, unit: 'package', stapleStatus: 'stocked' },
    ]);
    state.products[0] = { ...state.products[0], isStaple: true, ingredientName: 'Salt' };
    expect(matchRecipe(recipe(null, '', 'Salt'), state, options).status).toBe('ready');
    expect(buildShoppingList([{ recipe: recipe(1, 'tsp', 'Salt') }], state, options).items).toEqual(
      [],
    );
    state.batches[0].stapleStatus = 'low';
    expect(matchRecipe(recipe(1, 'tsp', 'Salt'), state, options).status).toBe('check');
    state.batches[0].stapleStatus = 'empty';
    expect(matchRecipe(recipe(1, 'tsp', 'Salt'), state, options).ingredients[0].status).toBe(
      'missing',
    );
  });
  it('only maps explicit conservative ingredient aliases', () => {
    expect(canonicalIngredientName(' Green_Onions ')).toBe('green onion');
    expect(canonicalIngredientName('Eggs')).toBe('egg');
    expect(canonicalIngredientName('Ground beef')).not.toBe(canonicalIngredientName('Beef steak'));
    expect(canonicalIngredientName('Chicken breast')).not.toBe(
      canonicalIngredientName('Chicken thigh'),
    );
  });
});

describe('shopping list calculation', () => {
  it('adds requirements before subtracting shared inventory once', () => {
    const result = buildShoppingList(
      [{ recipe: recipe(400) }, { recipe: recipe(300, 'g', 'Chicken breast', { id: 'recipe:2' }) }],
      inventory('Chicken breast', [{ quantity: 500 }]),
      options,
    );
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({
      quantity: 200,
      required: 700,
      available: 500,
      recipeIds: ['recipe:1', 'recipe:2'],
    });
  });
  it('combines compatible units but keeps cans and weight uncertain', () => {
    const result = buildShoppingList(
      [{ recipe: recipe(0.5, 'kg') }, { recipe: recipe(200) }],
      inventory('Chicken breast', [{ quantity: 500 }]),
      options,
    );
    expect(result.items[0].quantity).toBeCloseTo(0.2);
    const unknown = buildShoppingList(
      [{ recipe: recipe(400) }],
      inventory('Chicken breast', [{ quantity: 2, unit: 'can' }]),
      options,
    );
    expect(unknown.items[0]).toMatchObject({ quantity: null, status: 'check' });
  });
  it('keeps incompatible demand units separate without reusing known stock', () => {
    const weight = recipe(100, 'g', 'Milk');
    const volume = recipe(1, 'cup', 'Milk', { id: 'volume' });
    const state = inventory('Milk', [{ quantity: 1, unit: 'L' }]);
    const result = buildShoppingList([{ recipe: weight }, { recipe: volume }], state, options);
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({ unit: 'g', status: 'check', quantity: null });
    const mixedRecipe = { ...weight, ingredients: [...weight.ingredients, ...volume.ingredients] };
    expect(matchRecipe(mixedRecipe, state, options).status).toBe('check');
    expect(
      matchRecipe(mixedRecipe, state, options).ingredients.filter(
        (item) => item.status === 'available',
      ),
    ).toHaveLength(1);
  });
  it('uses separate count and weight batches only for their compatible demand family', () => {
    const count = recipe(2, 'each', 'Potatoes');
    const weight = recipe(500, 'g', 'Potato', { id: 'weight' });
    const state = inventory('Potatoes', [
      { quantity: 1, unit: 'each' },
      { quantity: 500, unit: 'g' },
    ]);
    const result = buildShoppingList([{ recipe: count }, { recipe: weight }], state, options);
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({
      name: 'Potatoes',
      unit: 'each',
      status: 'check',
      quantity: null,
      available: 1,
    });
    const combined = { ...count, ingredients: [...count.ingredients, ...weight.ingredients] };
    expect(matchRecipe(combined, state, options).status).toBe('check');
    const fullyRecorded = inventory('Potatoes', [
      { quantity: 2, unit: 'each' },
      { quantity: 500, unit: 'g' },
    ]);
    expect(
      buildShoppingList([{ recipe: count }, { recipe: weight }], fullyRecorded, options).items,
    ).toEqual([]);
  });
  it('aggregates overlapping selected recipes and aliases before subtracting', () => {
    const first = recipe(0.2, 'kg', 'Chicken breasts');
    const second = recipe(200, 'g', 'Chicken breast', { id: 'other' });
    const result = buildShoppingList(
      [{ recipe: first }, { recipe: second }],
      inventory('Chicken breasts', [{ quantity: 300, unit: 'g' }]),
      options,
    );
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({
      unit: 'kg',
      quantity: 0.1,
      required: 0.4,
      available: 0.3,
    });
  });
  it('omits sufficient requirements and flags missing unspecified quantities', () => {
    expect(
      buildShoppingList([{ recipe: recipe(200) }], inventory('Chicken breast'), options).items,
    ).toEqual([]);
    const result = buildShoppingList(
      [{ recipe: recipe(null, '', 'Salt') }],
      inventory('Chicken breast'),
      options,
    );
    expect(result.items[0]).toMatchObject({ name: 'Salt', quantity: null, status: 'check' });
  });
});
