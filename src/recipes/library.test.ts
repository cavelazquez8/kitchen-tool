import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  clearRecipeLibraryCache,
  discoverRecipes,
  fetchRecipe,
  mealToRecipe,
  searchRecipes,
} from './library';
import { createEmptyInventory } from '../domain/types';

function meal(id = '42') {
  return {
    idMeal: id,
    strMeal: 'Test supper',
    strIngredient1: 'Chicken breast',
    strMeasure1: '400g',
    strIngredient2: 'Olive oil',
    strMeasure2: '2 tbsp',
    strIngredient3: 'Salt',
    strMeasure3: 'to taste',
    strInstructions: 'STEP 1\r\nPrepare the food.\r\nCook thoroughly.',
    strSource: 'https://example.com/recipe',
    strMealThumb: 'https://www.themealdb.com/images/food.jpg',
  };
}
function response(value: unknown) {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}
afterEach(() => {
  clearRecipeLibraryCache();
  vi.restoreAllMocks();
});

describe('free TheMealDB adapter', () => {
  it('preserves original measures, full steps, source, and unknown serving yield', () => {
    const result = mealToRecipe(meal());
    expect(result).toMatchObject({
      id: 'themealdb:42',
      servings: null,
      steps: ['Prepare the food.', 'Cook thoroughly.'],
      source: { type: 'themealdb', url: 'https://example.com/recipe' },
    });
    expect(result?.ingredients).toEqual([
      { name: 'Chicken breast', quantity: 400, unit: 'g', original: '400g Chicken breast' },
      { name: 'Olive oil', quantity: 2, unit: 'tbsp', original: '2 tbsp Olive oil' },
      { name: 'Salt', quantity: null, unit: '', original: 'to taste Salt' },
    ]);
  });
  it('rejects incomplete filter results and ignores unsafe source URLs', () => {
    expect(mealToRecipe({ idMeal: '42', strMeal: 'Partial' })).toBeNull();
    expect(mealToRecipe({ ...meal(), strSource: 'javascript:alert(1)' })?.source.url).toContain(
      'themealdb.com',
    );
  });
  it('uses a single cached free search and treats a no-result response normally', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response({ meals: [meal()] }));
    expect(await searchRecipes('chicken', fetcher)).toHaveLength(1);
    expect(await searchRecipes('chicken', fetcher)).toHaveLength(1);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0][0]).toBe(
      'https://www.themealdb.com/api/json/v1/1/search.php?s=chicken',
    );
    const empty = vi.fn<typeof fetch>().mockResolvedValue(response({ meals: null }));
    expect(await searchRecipes('not found', empty)).toEqual([]);
  });
  it('does not cache malformed or unavailable responses', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => response({ unexpected: [] }));
    await expect(searchRecipes('bad', fetcher)).rejects.toThrow('unexpected response');
    await expect(searchRecipes('bad', fetcher)).rejects.toThrow('unexpected response');
    expect(fetcher).toHaveBeenCalledTimes(2);
    const failed = vi.fn<typeof fetch>().mockResolvedValue(new Response('', { status: 503 }));
    await expect(searchRecipes('offline', failed)).rejects.toThrow('unavailable');
  });
  it('looks up only numeric IDs and caps inventory-driven discovery', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      const address = String(input);
      if (address.includes('filter.php'))
        return response({
          meals: Array.from({ length: 20 }, (_, index) => ({ idMeal: String(index + 1) })),
        });
      return response({ meals: [meal(new URL(address).searchParams.get('i') ?? '42')] });
    });
    await expect(fetchRecipe('../../keys', fetcher)).rejects.toThrow('valid recipe');
    const inventory = {
      ...createEmptyInventory(),
      products: ['Chicken breast', 'Pasta', 'Rice', 'Beef'].map((name, index) => ({
        id: String(index),
        name,
        isStaple: false,
      })),
      batches: ['0', '1', '2', '3'].map((productId) => ({
        id: `batch:${productId}`,
        productId,
        quantity: 1,
        unit: 'package',
        location: 'pantry' as const,
        purchasedOn: '2026-10-10',
        expiresOn: null,
      })),
    };
    expect(await discoverRecipes(inventory, fetcher)).toHaveLength(4);
    expect(
      fetcher.mock.calls.filter(([input]) => String(input).includes('filter.php')),
    ).toHaveLength(3);
    expect(
      fetcher.mock.calls.filter(([input]) => String(input).includes('lookup.php')),
    ).toHaveLength(4);
    expect(fetcher.mock.calls.every(([input]) => String(input).includes('/v1/1/'))).toBe(true);
  });
  it('provides a capped starter sample without enumerating the database', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        response({ meals: Array.from({ length: 30 }, (_, index) => meal(String(index))) }),
      );
    expect(await discoverRecipes(createEmptyInventory(), fetcher)).toHaveLength(12);
    expect(fetcher).toHaveBeenCalledTimes(3);
  });
});
