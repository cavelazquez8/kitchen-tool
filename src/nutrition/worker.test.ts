// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import {
  createNutritionState,
  handleNutritionRequest,
  parseUsdaFood,
} from '../../server/src/nutrition';

const env = { USDA_API_KEY: 'test_only_' + 'a'.repeat(32) };
const fullFood = {
  fdcId: 123,
  description: 'Synthetic fixture raw food',
  dataType: 'Foundation',
  foodNutrients: [
    { nutrient: { id: 2048, unitName: 'KCAL' }, amount: 98 },
    { nutrient: { id: 2047, unitName: 'KCAL' }, amount: 100 },
    { nutrient: { id: 1008, unitName: 'KCAL' }, amount: 101 },
    { nutrient: { id: 1003, unitName: 'G' }, amount: 12 },
    { nutrient: { id: 1004, unitName: 'G' }, amount: 2 },
  ],
  foodPortions: [
    { gramWeight: 150, portionDescription: '1 source-recorded fixture cup' },
    { gramWeight: 50, amount: 1, measureUnit: { name: 'piece' }, modifier: 'edible part' },
  ],
};
function request(path: string, input?: unknown): Request {
  return new Request(`https://mise.example.workers.dev/nutrition/${path}`, {
    method: input === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json' },
    ...(input === undefined ? {} : { body: JSON.stringify(input) }),
  });
}

describe('USDA food record normalization', () => {
  it('supports Foundation Atwater energy, unit checks, and source-only portions', () => {
    const result = parseUsdaFood(fullFood);
    expect(result?.per100g).toEqual({
      caloriesKcal: 98,
      proteinGrams: 12,
      carbsGrams: null,
      fatGrams: 2,
    });
    expect(result?.sourceUrl).toBe('https://fdc.nal.usda.gov/food-details/123/nutrients');
    expect(result?.portions).toEqual([
      { label: '1 source-recorded fixture cup', gramWeight: 150 },
      { label: '1 piece edible part', gramWeight: 50 },
    ]);
  });

  it('handles flattened search fields and legacy nutrient numbers', () => {
    const result = parseUsdaFood({
      ...fullFood,
      foodNutrients: [
        { nutrientId: 1008, unitName: 'KCAL', value: 70 },
        { number: '203', unitName: 'g', amount: 5 },
        { nutrientNumber: '205', unitName: 'G', value: 9 },
        { nutrientId: 1004, unitName: 'mg', value: 3 },
      ],
    });
    expect(result?.per100g).toEqual({
      caloriesKcal: 70,
      proteinGrams: 5,
      carbsGrams: 9,
      fatGrams: null,
    });
  });

  it('does not confuse kJ, label servings, or invalid weights with per100g nutrition', () => {
    const result = parseUsdaFood({
      ...fullFood,
      dataType: 'Branded',
      foodNutrients: [{ nutrientId: 1008, unitName: 'kJ', value: 300 }],
      labelNutrients: { calories: { value: 200 }, protein: { value: 20 } },
      servingSize: 30,
      servingSizeUnit: 'ml',
      foodPortions: [{ gramWeight: -20 }, { gramWeight: 0 }],
    });
    expect(result?.per100g).toEqual({
      caloriesKcal: null,
      proteinGrams: null,
      carbsGrams: null,
      fatGrams: null,
    });
    expect(result?.portions).toEqual([]);
    expect(
      parseUsdaFood({
        ...fullFood,
        dataType: 'Branded',
        foodPortions: [],
        servingSize: 30,
        servingSizeUnit: 'g',
      })?.portions,
    ).toEqual([{ label: '30 g (label serving)', gramWeight: 30 }]);
  });
});

describe('optional USDA Worker module', () => {
  it('reports configuration without contacting USDA or exposing its secret', async () => {
    const fetcher = vi.fn<typeof fetch>();
    const result = await handleNutritionRequest(request('status'), env, fetcher);
    expect(result).toEqual({ status: 200, body: { provider: 'usda', configured: true } });
    expect(await handleNutritionRequest(request('status'), {}, fetcher)).toEqual({
      status: 200,
      body: { provider: 'usda', configured: false },
    });
    expect(JSON.stringify(result)).not.toContain(env.USDA_API_KEY);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('makes one bounded fixed-host search with a server key and conservative Worker transport', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(JSON.stringify({ foods: [fullFood] })));
    const result = await handleNutritionRequest(
      request('search', { query: 'raw fixture food' }),
      env,
      fetcher,
      createNutritionState(),
    );
    expect(result.status).toBe(200);
    const [address, options] = fetcher.mock.calls[0];
    const url = new URL(String(address));
    expect(url.origin).toBe('https://api.nal.usda.gov');
    expect(url.pathname).toBe('/fdc/v1/foods/search');
    expect(url.searchParams.get('api_key')).toBe(env.USDA_API_KEY);
    expect(options).toMatchObject({
      redirect: 'manual',
      method: 'POST',
      headers: { 'Cache-Control': 'no-cache, no-store', Pragma: 'no-cache' },
      cf: { cacheTtlByStatus: { '200-599': -1 } },
    });
    expect(options).not.toHaveProperty('cache');
    expect(JSON.parse(String(options?.body))).toMatchObject({
      query: 'raw fixture food',
      pageSize: 10,
    });
    expect(JSON.stringify(result)).not.toContain(env.USDA_API_KEY);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('loads the chosen record and rejects a mismatched upstream ID', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(fullFood)));
    expect(
      (
        await handleNutritionRequest(
          request('food', { fdcId: 123 }),
          env,
          fetcher,
          createNutritionState(),
        )
      ).body,
    ).toMatchObject({ food: { fdcId: 123 } });
    fetcher.mockResolvedValue(new Response(JSON.stringify(fullFood)));
    await expect(
      handleNutritionRequest(request('food', { fdcId: 456 }), env, fetcher, createNutritionState()),
    ).rejects.toMatchObject({ code: 'nutrition_response' });
  });

  it('rejects invalid or oversized inputs before contacting USDA', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const [path, input] of [
      ['search', { query: 'x' }],
      ['search', { query: 'rice', api_key: 'browser-key' }],
      ['search', { query: 'a'.repeat(5000) }],
      ['food', { fdcId: -1 }],
      ['food', { fdcId: '123' }],
    ] as const)
      await expect(
        handleNutritionRequest(request(path, input), env, fetcher),
      ).rejects.toMatchObject({ status: 400 });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('never follows an upstream redirect or exposes its location', async () => {
    const cancel = vi.fn();
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(new ReadableStream({ cancel }), {
        status: 302,
        headers: { Location: 'https://attacker.example' },
      }),
    );
    await expect(
      handleNutritionRequest(
        request('search', { query: 'fixture' }),
        env,
        fetcher,
        createNutritionState(),
      ),
    ).rejects.toMatchObject({ code: 'nutrition_redirect', status: 502 });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('pauses lookup after 429 and distinguishes malformed records from zero hits', async () => {
    const state = createNutritionState();
    const now = () => 1_000_000;
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('', { status: 429 }));
    await expect(
      handleNutritionRequest(request('search', { query: 'fixture' }), env, fetcher, state, now),
    ).rejects.toMatchObject({ code: 'nutrition_quota' });
    await expect(
      handleNutritionRequest(request('search', { query: 'fixture' }), env, fetcher, state, now),
    ).rejects.toMatchObject({ code: 'nutrition_quota' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    fetcher.mockResolvedValue(new Response(JSON.stringify({ foods: [{ fdcId: 1 }] })));
    await expect(
      handleNutritionRequest(
        request('search', { query: 'fixture' }),
        env,
        fetcher,
        createNutritionState(),
      ),
    ).rejects.toMatchObject({ code: 'nutrition_response' });
    fetcher.mockResolvedValue(new Response(JSON.stringify({ foods: [] })));
    expect(
      (
        await handleNutritionRequest(
          request('search', { query: 'fixture' }),
          env,
          fetcher,
          createNutritionState(),
        )
      ).body,
    ).toEqual({ query: 'fixture', foods: [], rejectedCount: 0 });
  });

  it('enforces the streamed response size even without Content-Length', async () => {
    const cancel = vi.fn();
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array(800 * 1024));
          },
          cancel,
        }),
      ),
    );
    await expect(
      handleNutritionRequest(
        request('search', { query: 'fixture' }),
        env,
        fetcher,
        createNutritionState(),
      ),
    ).rejects.toMatchObject({ code: 'nutrition_response' });
    expect(cancel).toHaveBeenCalledOnce();
  });
});
