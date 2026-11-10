import { describe, expect, it } from 'vitest';
import type { Batch, InventoryState } from '../domain/types';
import type { Recipe } from './types';
import {
  buildShoppingList,
  canonicalIngredientName,
  matchRecipe,
  rankRecipes,
  readinessBadge,
} from './matching';

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

  it('matches a confirmed branded identity against prepared recipe names using recorded net contents', () => {
    const state = inventory('Example Organic Carrots', [{ quantity: 500, unit: 'g' }]);
    state.products[0].ingredientName = 'Carrots';
    state.products[0].packageQuantity = { quantity: 500, unit: 'g' };
    const prepared = recipe(300, 'g', 'Carrots, finely chopped');
    expect(matchRecipe(prepared, state, options).ingredients[0]).toMatchObject({
      status: 'available',
      available: 500,
    });
    state.batches[0].quantity = 100;
    expect(matchRecipe(prepared, state, options).ingredients[0]).toMatchObject({
      status: 'short',
      available: 100,
      shortage: 200,
    });
    // The saved original package size must not replenish a partly used batch.
    expect(state.products[0].packageQuantity.quantity).toBe(500);
  });

  it('does not substitute a scanned flavored product or a different ingredient family', () => {
    expect(
      matchRecipe(recipe(100, 'g', 'Chicken'), inventory('Example chicken flavored soup'), options)
        .ingredients[0].status,
    ).toBe('missing');
    expect(
      matchRecipe(recipe(100, 'g', 'Milk'), inventory('Almond milk'), options).ingredients[0]
        .status,
    ).toBe('missing');
    expect(
      matchRecipe(recipe(100, 'g', 'All-purpose flour'), inventory('Rice flour'), options)
        .ingredients[0].status,
    ).toBe('missing');
  });

  it.each([
    ['Milk', 'Whole milk'],
    ['Fresh basil', 'Dried basil'],
    ['Rice', 'Jasmine rice'],
  ])('shows %s versus %s as a possible match requiring ingredient review', (needed, stocked) => {
    const dish = recipe(100, 'g', needed);
    const state = inventory(stocked, [{ quantity: 1000, unit: 'g' }]);
    const result = matchRecipe(dish, state, options);
    expect(result.status).toBe('check');
    expect(result.ingredients[0]).toMatchObject({
      status: 'check',
      available: null,
      shortage: null,
    });
    expect(result.ingredients[0].reason).toContain('Quantities have not been compared');
    expect(buildShoppingList([{ recipe: dish }], state, options).items[0]).toMatchObject({
      name: needed,
      quantity: null,
      available: null,
      status: 'check',
    });
    state.batches[0].quantity = 0;
    expect(matchRecipe(dish, state, options).ingredients[0].status).toBe('missing');
    state.batches[0].quantity = 1000;
    state.batches[0].expiresOn = '2026-10-09';
    expect(matchRecipe(dish, state, options).ingredients[0].status).toBe('missing');
  });

  it('keeps exact shortfalls precise and unrelated or explicitly separate products missing', () => {
    const state = inventory('Whole milk', [{ quantity: 1000, unit: 'g' }]);
    state.products.push({ id: 'generic', name: 'Milk', isStaple: false });
    state.batches.push({
      ...state.batches[0],
      id: 'generic-batch',
      productId: 'generic',
      quantity: 10,
    });
    expect(matchRecipe(recipe(100, 'g', 'Milk'), state, options).ingredients[0]).toMatchObject({
      status: 'short',
      available: 10,
      shortage: 90,
    });
    for (const [needed, supplied] of [
      ['Milk', 'Soy milk'],
      ['Rice', 'Cooked rice'],
      ['Chicken', 'Chicken thigh'],
      ['All-purpose flour', 'Rice flour'],
      ['Basil', 'Example basil flavored dressing'],
    ])
      expect(
        matchRecipe(recipe(100, 'g', needed), inventory(supplied), options).ingredients[0].status,
      ).toBe('missing');
  });

  it('ranks a large library with the same inventory exclusions and quantity results as individual checks', () => {
    const state = inventory('Organic carrots', [{ quantity: 500, expiresOn: '2026-10-11' }]);
    const recipes = Array.from({ length: 1500 }, (_, index) =>
      recipe(index % 3 === 0 ? 600 : 100, 'g', index % 2 === 0 ? 'Carrots, diced' : 'Potatoes', {
        id: `catalog:${index}`,
        title: `Recipe ${index}`,
      }),
    );
    const ranked = rankRecipes(recipes, state, { ...options, prioritizeExpiration: true });
    expect(ranked).toHaveLength(recipes.length);
    for (const id of ['catalog:0', 'catalog:1', 'catalog:2', 'catalog:1498']) {
      const source = recipes.find((item) => item.id === id)!;
      expect(ranked.find((item) => item.recipe.id === id)).toEqual(
        matchRecipe(source, state, { ...options, prioritizeExpiration: true }),
      );
    }
    expect(
      rankRecipes(recipes, state, { ...options, selectedProductIds: [] }).every(
        (item) => item.ingredients[0].status === 'missing',
      ),
    ).toBe(true);
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

describe('readiness badge', () => {
  it('reserves "Almost ready" for short lists and keeps the ranking status intact', () => {
    expect(readinessBadge({ status: 'ready', missingCount: 0 }).label).toBe('Ready to cook');
    expect(readinessBadge({ status: 'check', missingCount: 0 }).label).toBe('Check quantities');
    expect(readinessBadge({ status: 'almost', missingCount: 1 })).toEqual({
      tone: 'almost',
      label: 'Almost ready',
    });
    expect(readinessBadge({ status: 'almost', missingCount: 2 }).label).toBe('Almost ready');
    expect(readinessBadge({ status: 'almost', missingCount: 3 })).toEqual({
      tone: 'shopping',
      label: 'Needs shopping',
    });
    expect(readinessBadge({ status: 'almost', missingCount: 31 }).label).toBe('Needs shopping');
  });
});

describe('recipe wording against plain stock', () => {
  it('finds stocked onions and eggs behind preparation and size wording', () => {
    const onions = inventory('Onions', [{ quantity: 3, unit: 'each' }]);
    const eggs = inventory('Eggs', [{ quantity: 12, unit: 'each' }]);
    expect(matchRecipe(recipe(0.5, 'each', 'onion, diced small'), onions, options).status).toBe(
      'ready',
    );
    expect(matchRecipe(recipe(1, 'each', 'medium onion'), onions, options).status).toBe('ready');
    expect(matchRecipe(recipe(2, 'each', 'large eggs'), eggs, options).status).toBe('ready');
    expect(matchRecipe(recipe(3, 'each', 'eggs, separated'), eggs, options).status).toBe('ready');
    expect(matchRecipe(recipe(2, 'each', 'egg whites'), eggs, options).ingredients[0].status).toBe(
      'missing',
    );
  });
});
