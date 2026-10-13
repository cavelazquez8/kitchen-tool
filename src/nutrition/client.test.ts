import { afterEach, describe, expect, it, vi } from 'vitest';
import { getNutritionFood, nutritionStatus, searchNutritionFoods } from './client';
import type { FoodNutrition } from './types';

const connection = {
  url: 'https://mise.example.workers.dev',
  token: 'test_only_' + 'a'.repeat(40),
};
const food: FoodNutrition = {
  fdcId: 123,
  description: 'Synthetic fixture food',
  dataType: 'Foundation',
  sourceUrl: 'https://fdc.nal.usda.gov/food-details/123/nutrients',
  per100g: { caloriesKcal: 50, proteinGrams: null, carbsGrams: 12, fatGrams: 0 },
  portions: [],
};
afterEach(() => vi.unstubAllGlobals());

describe('authenticated nutrition client', () => {
  it('explains older Workers and keeps API secrets out of browser requests', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(JSON.stringify({ provider: 'usda', configured: false })));
    vi.stubGlobal('fetch', fetcher);
    expect(await nutritionStatus(connection)).toEqual({ provider: 'usda', configured: false });
    expect(fetcher.mock.calls[0]).toMatchObject([
      `${connection.url}/nutrition/status`,
      { headers: { Authorization: `Bearer ${connection.token}` } },
    ]);
    expect(JSON.stringify(fetcher.mock.calls)).not.toContain('api_key');
    fetcher.mockResolvedValue(
      new Response(
        JSON.stringify({ error: { code: 'not_found', message: 'Old Worker fixture.' } }),
        { status: 404 },
      ),
    );
    await expect(nutritionStatus(connection)).rejects.toMatchObject({ code: 'worker_update' });
  });

  it('preserves unknown nutrients and verifies food IDs on selection', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(JSON.stringify({ query: 'fixture', foods: [food], rejectedCount: 0 })),
      );
    vi.stubGlobal('fetch', fetcher);
    expect(
      (await searchNutritionFoods(connection, ' fixture ')).foods[0].per100g.proteinGrams,
    ).toBeNull();
    expect(JSON.parse(String(fetcher.mock.calls[0][1]?.body))).toEqual({ query: 'fixture' });
    fetcher.mockResolvedValue(new Response(JSON.stringify({ food })));
    expect((await getNutritionFood(connection, 123)).fdcId).toBe(123);
    fetcher.mockResolvedValue(new Response(JSON.stringify({ food })));
    await expect(getNutritionFood(connection, 456)).rejects.toMatchObject({
      code: 'nutrition_response',
    });
  });

  it('rejects invalid input and malformed results without using them', async () => {
    const fetcher = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', fetcher);
    await expect(searchNutritionFoods(connection, 'x')).rejects.toMatchObject({
      code: 'invalid_request',
    });
    await expect(getNutritionFood(connection, NaN)).rejects.toMatchObject({
      code: 'invalid_request',
    });
    expect(fetcher).not.toHaveBeenCalled();
    fetcher.mockResolvedValue(
      new Response(
        JSON.stringify({
          query: 'fixture',
          foods: [{ ...food, per100g: { caloriesKcal: 50 } }],
          rejectedCount: 0,
        }),
      ),
    );
    await expect(searchNutritionFoods(connection, 'fixture')).rejects.toMatchObject({
      code: 'nutrition_response',
    });
  });
});
