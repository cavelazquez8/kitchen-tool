import { describe, expect, it } from 'vitest';
import {
  canPersistProviderRecipe,
  parseRecipeProviderResults,
  parseRecipeProviderSearch,
  parseRecipeProviderStatuses,
  RECIPE_PROVIDER_INFO,
  recipeApiToRecipe,
  spoonacularToRecipe,
} from './providers';

const recipeApiRecord = {
  id: 449,
  name: 'Test-only vegetable soup',
  servings: 2,
  ingredients: [
    { name: 'Carrots', quantity: 300, unit: 'g', optional: false },
    { name: 'Salt', quantity: null, unit: '', optional: true },
  ],
  instructions: ['Test fixture: simmer the vegetables.'],
};
const spoonacularRecord = {
  id: 123,
  title: 'Test-only garlic soup',
  servings: 2,
  extendedIngredients: [
    { name: 'Garlic', amount: 5, unit: 'cloves', original: '5-6 cloves garlic' },
    { name: 'Olive oil', amount: 1, unit: 'tbsp', original: '1 tbsp olive oil' },
  ],
  analyzedInstructions: [{ name: '', steps: [{ step: 'Test fixture: cook the garlic.' }] }],
  sourceUrl: 'https://example.com/test-recipe',
};

describe('external recipe providers', () => {
  it('preserves explicit amounts, unknowns, optional ingredients, attribution, and recorded yield', () => {
    const recipe = recipeApiToRecipe(recipeApiRecord)!;
    expect(recipe.id).toBe('recipeapi:449');
    expect(recipe.ingredients).toEqual([
      { name: 'Carrots', quantity: 300, unit: 'g', original: '300 g Carrots', optional: false },
      { name: 'Salt', quantity: null, unit: '', original: 'Salt', optional: true },
    ]);
    expect(recipe.source.name).toBe('RecipeAPI.io');
    expect(recipe.source.licenseUrl).toBe('https://recipeapi.io/legal/terms-of-service');
    expect(recipeApiToRecipe({ ...recipeApiRecord, servings: undefined })?.servings).toBeNull();
    expect(canPersistProviderRecipe(recipe)).toBe(true);
  });

  it('rejects whole records instead of silently dropping malformed ingredients or steps', () => {
    for (const ingredients of [
      [{ name: 'Carrots', quantity: '300', unit: 'g' }],
      [{ name: 'Carrots', quantity: -1, unit: 'g' }],
      [{ name: 'Carrots', quantity: Infinity, unit: 'g' }],
      [{ name: 'Carrots', quantity: 300, unit: { guessed: true } }],
      [{ name: '', quantity: 300, unit: 'g' }],
      [...recipeApiRecord.ingredients, 'unrecognized ingredient'],
    ])
      expect(recipeApiToRecipe({ ...recipeApiRecord, ingredients })).toBeNull();
    expect(
      recipeApiToRecipe({ ...recipeApiRecord, instructions: ['Valid', { step: 'Unsupported' }] }),
    ).toBeNull();
    expect(recipeApiToRecipe({ ...recipeApiRecord, servings: 500 })).toBeNull();
  });

  it('keeps ranged Spoonacular originals unknown instead of accepting a lower-bound amount', () => {
    const recipe = spoonacularToRecipe(spoonacularRecord)!;
    expect(recipe.ingredients[0]).toMatchObject({
      quantity: null,
      unit: 'clove',
      original: '5-6 cloves garlic',
    });
    expect(recipe.ingredients[1]).toMatchObject({ quantity: 1, unit: 'tbsp' });
    expect(recipe.source.url).toBe('https://example.com/test-recipe');
    expect(canPersistProviderRecipe(recipe)).toBe(false);
    expect(canPersistProviderRecipe({ ...recipe, id: 'renamed:123' })).toBe(false);
  });

  it('reads Complex Search ingredient groups and excludes unused inventory ingredients', () => {
    const { extendedIngredients, ...record } = spoonacularRecord;
    const recipe = spoonacularToRecipe({
      ...record,
      usedIngredientCount: 1,
      missedIngredientCount: 1,
      usedIngredients: [extendedIngredients[0]],
      missedIngredients: [extendedIngredients[1]],
      unusedIngredients: [{ name: 'Milk', amount: 1000, unit: 'ml', original: '1 l milk' }],
    });
    expect(recipe?.ingredients.map((ingredient) => ingredient.name)).toEqual([
      'Garlic',
      'Olive oil',
    ]);
    expect(recipe?.ingredients[0]).toMatchObject({
      quantity: null,
      original: '5-6 cloves garlic',
    });
    expect(recipe?.ingredients[1]).toMatchObject({ quantity: 1, unit: 'tbsp' });
    expect(
      spoonacularToRecipe({
        ...record,
        extendedIngredients: [],
        usedIngredients: [extendedIngredients[0]],
        missedIngredients: [extendedIngredients[1]],
      })?.ingredients,
    ).toEqual(recipe?.ingredients);
  });

  it('rejects partial or malformed Complex Search groups instead of dropping required ingredients', () => {
    const { extendedIngredients, ...record } = spoonacularRecord;
    const grouped = {
      ...record,
      usedIngredients: [extendedIngredients[0]],
      missedIngredients: [extendedIngredients[1]],
    };
    for (const changes of [
      { missedIngredients: undefined },
      { usedIngredients: undefined },
      { missedIngredients: {} },
      { usedIngredientCount: 2 },
      { missedIngredientCount: -1 },
      { missedIngredientCount: '1' },
      { missedIngredients: [...grouped.missedIngredients, { name: '', amount: 1, unit: 'g' }] },
      { missedIngredients: [{ ...extendedIngredients[1], amount: -1 }] },
      { missedIngredients: [{ ...extendedIngredients[1], original: { guessed: true } }] },
      { missedIngredients: [{ ...extendedIngredients[1], original: 'x'.repeat(1001) }] },
      { missedIngredients: [{ ...extendedIngredients[1], unit: 'x'.repeat(41) }] },
      { extendedIngredients: {} },
    ])
      expect(spoonacularToRecipe({ ...grouped, ...changes })).toBeNull();
  });

  it('uses source instruction text only when analyzed instructions are absent or empty', () => {
    const instructions =
      '<ol><li>Test-only: warm the oil &amp; garlic.</li><li>Test-only: simmer.</li></ol>';
    expect(spoonacularToRecipe({ ...spoonacularRecord, instructions })?.steps).toEqual([
      'Test fixture: cook the garlic.',
    ]);
    for (const analyzedInstructions of [undefined, [], [{ name: 'Method', steps: [] }]])
      expect(
        spoonacularToRecipe({ ...spoonacularRecord, analyzedInstructions, instructions })?.steps,
      ).toEqual(['Test-only: warm the oil & garlic.', 'Test-only: simmer.']);
    expect(
      spoonacularToRecipe({
        ...spoonacularRecord,
        analyzedInstructions: [],
        instructions: 'Test-only: warm oil.\nTest-only: simmer.',
      })?.steps,
    ).toEqual(['Test-only: warm oil.', 'Test-only: simmer.']);
  });

  it('rejects unsupported or incomplete instructions even when another field looks usable', () => {
    for (const analyzedInstructions of [null, {}, [{ steps: [{ step: {} }] }], [{ steps: {} }]])
      expect(
        spoonacularToRecipe({
          ...spoonacularRecord,
          analyzedInstructions,
          instructions: 'Test-only: simmer.',
        }),
      ).toBeNull();
    for (const instructions of [
      '',
      {},
      '<script>Test-only script text</script>',
      '<script>Incomplete script',
      'x'.repeat(3001),
      'x'.repeat(60001),
      Array.from({ length: 201 }, () => 'Test-only step').join('\n'),
    ])
      expect(
        spoonacularToRecipe({ ...spoonacularRecord, analyzedInstructions: [], instructions }),
      ).toBeNull();
    expect(
      spoonacularToRecipe({
        ...spoonacularRecord,
        analyzedInstructions: [],
        instructions: '<script>Discard</script><p>Test-only: simmer &#38; stir.</p>',
      })?.steps,
    ).toEqual(['Test-only: simmer & stir.']);
  });

  it('limits searches to documented free operations and rejects override fields', () => {
    expect(
      parseRecipeProviderSearch({
        provider: 'recipeapi',
        query: ' soup ',
        ingredients: ['Carrots', 'Carrots'],
      }),
    ).toEqual({
      provider: 'recipeapi',
      query: 'soup',
      ingredients: ['Carrots'],
      page: 1,
      limit: 10,
    });
    expect(
      parseRecipeProviderSearch({ provider: 'recipeapi', query: '', ingredients: ['Carrots'] }),
    ).not.toBeNull();
    for (const input of [
      { provider: 'recipeapi', query: '' },
      { provider: 'paid', query: 'soup' },
      { provider: 'recipeapi', query: 'soup', url: 'https://attacker.example' },
      { provider: 'recipeapi', query: 'soup', units: 'imperial' },
      { provider: 'recipeapi', query: 'soup', apiKey: 'secret' },
      { provider: 'recipeapi', query: 'soup', limit: 11 },
      { provider: 'recipeapi', query: 'soup', page: 0 },
      { provider: 'spoonacular', query: 'soup', page: 92 },
      { provider: 'recipeapi', query: 'soup', ingredients: ['carrots,tomatoes'] },
    ])
      expect(parseRecipeProviderSearch(input)).toBeNull();
  });

  it('reconstructs trusted provider descriptions instead of trusting response links', () => {
    const result = parseRecipeProviderStatuses({
      providers: RECIPE_PROVIDER_INFO.map((provider) => ({
        ...provider,
        configured: true,
        setupUrl: 'https://attacker.example',
      })),
    });
    expect(result?.[0].setupUrl).toBe('https://recipeapi.io/register');
    expect(parseRecipeProviderStatuses({ providers: [] })).toBeNull();
  });

  it('validates source identity, storage policy, and session expiration before displaying results', () => {
    const base = {
      provider: 'spoonacular',
      recipes: [spoonacularToRecipe(spoonacularRecord)],
      page: 1,
      hasMore: false,
      warnings: [],
      storage: 'session',
      expiresAt: Date.now() + 3600000,
    };
    expect(parseRecipeProviderResults(base, 'spoonacular')).not.toBeNull();
    expect(parseRecipeProviderResults({ ...base, storage: 'personal' }, 'spoonacular')).toBeNull();
    expect(
      parseRecipeProviderResults({ ...base, expiresAt: Date.now() - 1 }, 'spoonacular'),
    ).toBeNull();
    expect(
      parseRecipeProviderResults(
        { ...base, recipes: [recipeApiToRecipe(recipeApiRecord)] },
        'spoonacular',
      ),
    ).toBeNull();
    expect(
      parseRecipeProviderResults({ ...base, expiresAt: Date.now() + 7200000 }, 'spoonacular'),
    ).toBeNull();
  });
});
