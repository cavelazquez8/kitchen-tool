// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { createWorker, type Env } from '../../server/src/index';
import {
  createRecipeProviderState,
  recipeProviderStatuses,
  searchRecipeProvider,
} from '../../server/src/recipeProviders';

const origin = 'https://mise-kitchen-cv8.expertroot3.chatgpt.site';
const token = 'test_only_' + 'a'.repeat(40);
const env: Env = {
  ALLOWED_ORIGIN: origin,
  GEMINI_API_KEY: 'test-only-not-real-gemini-key',
  MISE_ACCESS_TOKEN: token,
  RECIPEAPI_API_KEY: 'sk_live_' + 'test_only_'.repeat(4),
  RECIPEAPI_PLAN: 'free',
  SPOONACULAR_API_KEY: 'test_only_'.repeat(4),
  SPOONACULAR_PLAN: 'free',
};
const recipe = {
  id: 1,
  name: 'Test fixture soup',
  servings: 2,
  ingredients: [{ name: 'Carrots', quantity: 300, unit: 'g' }],
  instructions: ['Test fixture: simmer the carrots.'],
};
const input = { provider: 'recipeapi' as const, query: 'soup', page: 1, limit: 10 };
const body = () => new Response(JSON.stringify({ data: [recipe], meta: { last_page: 2 } }));
const request = (
  path = '/recipes/search',
  payload: unknown = input,
  authorization = `Bearer ${token}`,
  requestOrigin = origin,
) =>
  new Request(`https://mise.example.workers.dev${path}`, {
    method: path === '/recipe-providers' ? 'GET' : 'POST',
    headers: {
      Origin: requestOrigin,
      Authorization: authorization,
      'Content-Type': 'application/json',
    },
    ...(path === '/recipe-providers' ? {} : { body: JSON.stringify(payload) }),
  });

describe('free recipe provider Worker endpoints', () => {
  it('authenticates before revealing configuration or contacting a provider', async () => {
    const fetcher = vi.fn<typeof fetch>();
    const worker = createWorker(fetcher);
    expect((await worker.fetch(request('/recipe-providers', undefined, ''), env)).status).toBe(401);
    expect((await worker.fetch(request('/recipes/search', input, '', origin), env)).status).toBe(
      401,
    );
    expect(
      (
        await worker.fetch(
          request('/recipes/search', input, undefined, 'https://attacker.example'),
          env,
        )
      ).status,
    ).toBe(403);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('reports optional configuration without leaking credentials or consuming upstream quota', async () => {
    const fetcher = vi.fn<typeof fetch>();
    const response = await createWorker(fetcher).fetch(request('/recipe-providers'), env);
    expect(response.status).toBe(200);
    const raw = await response.text();
    expect(raw).not.toContain(env.RECIPEAPI_API_KEY);
    expect(raw).not.toContain(env.SPOONACULAR_API_KEY);
    expect(
      JSON.parse(raw).providers.every((provider: { configured: boolean }) => provider.configured),
    ).toBe(true);
    expect(recipeProviderStatuses({ ...env, RECIPEAPI_PLAN: 'paid' })[0].configured).toBe(false);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('makes one fixed-host request with a server-only header key and no paid parameters', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => body());
    const response = await createWorker(fetcher).fetch(
      request('/recipes/search', { ...input, ingredients: ['Carrots', 'Garlic'] }),
      env,
    );
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result).toMatchObject({
      provider: 'recipeapi',
      page: 1,
      hasMore: true,
      storage: 'personal',
    });
    expect(result.recipes[0].ingredients[0].quantity).toBe(300);
    const [url, options] = fetcher.mock.calls[0];
    const parsed = new URL(String(url));
    expect(parsed.origin).toBe('https://recipeapi.io');
    expect(parsed.searchParams.get('ingredients')).toBe('Carrots,Garlic');
    expect(parsed.searchParams.get('per_page')).toBe('10');
    for (const forbidden of ['apiKey', 'apikey', 'servings', 'units', 'lang'])
      expect(parsed.searchParams.has(forbidden)).toBe(false);
    expect(String(url)).not.toContain(env.RECIPEAPI_API_KEY);
    expect(options).toMatchObject({
      headers: { Authorization: `Bearer ${env.RECIPEAPI_API_KEY}` },
      redirect: 'error',
      cache: 'no-store',
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('rejects invalid searches, missing keys, and undeclared free plans before contacting providers', async () => {
    const fetcher = vi.fn<typeof fetch>();
    const worker = createWorker(fetcher);
    for (const payload of [
      { ...input, limit: 100 },
      { ...input, provider: 'attacker' },
      { ...input, apiKey: 'browser-secret' },
    ])
      expect((await worker.fetch(request('/recipes/search', payload), env)).status).toBe(400);
    expect((await worker.fetch(request(), { ...env, RECIPEAPI_PLAN: undefined })).status).toBe(503);
    expect((await worker.fetch(request(), { ...env, RECIPEAPI_API_KEY: undefined })).status).toBe(
      503,
    );
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('stops at the calendar-month 500-request limit, then resets at the next month', async () => {
    const state = createRecipeProviderState();
    state.recipeapi.month = '2026-10';
    state.recipeapi.monthlyRequests = 500;
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => body());
    await expect(
      searchRecipeProvider(input, env, state, fetcher, () => Date.parse('2026-10-12T12:00:00Z')),
    ).rejects.toMatchObject({ status: 429, code: 'provider_quota' });
    expect(fetcher).not.toHaveBeenCalled();
    await expect(
      searchRecipeProvider(input, env, state, fetcher, () => Date.parse('2026-11-01T00:00:00Z')),
    ).resolves.toMatchObject({ provider: 'recipeapi' });
    expect(state.recipeapi.monthlyRequests).toBe(1);
  });

  it('stops on upstream quota without retrying and hides private error details', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(`private ${env.RECIPEAPI_API_KEY}`, {
        status: 429,
        headers: { 'Retry-After': '120' },
      }),
    );
    const worker = createWorker(fetcher, () => Date.parse('2026-10-12T12:00:00Z'));
    const first = await worker.fetch(request(), env);
    const second = await worker.fetch(request(), env);
    expect(first.status).toBe(429);
    expect(first.headers.get('Retry-After')).toBe('120');
    expect(await first.text()).not.toContain(env.RECIPEAPI_API_KEY);
    expect(second.status).toBe(429);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('bounds streamed upstream bodies and omits entire unsupported recipes with an explanation', async () => {
    const oversized = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(512 * 1024 + 1));
        controller.close();
      },
    });
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(oversized))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: [
              recipe,
              { ...recipe, ingredients: [...recipe.ingredients, 'unrecognized required item'] },
            ],
            meta: { last_page: 1 },
          }),
        ),
      );
    const worker = createWorker(fetcher);
    expect((await worker.fetch(request(), env)).status).toBe(502);
    const response = await worker.fetch(request(), env);
    const result = await response.json();
    expect(result.recipes).toHaveLength(1);
    expect(result.warnings[0]).toContain('omitted');
    expect(result.hasMore).toBe(false);
  });

  it('returns Spoonacular discovery as session-only and observes API-reported daily usage', async () => {
    const now = Date.parse('2026-10-12T12:00:00Z');
    const state = createRecipeProviderState();
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          results: [
            {
              id: 2,
              title: 'Test-only soup',
              servings: 1,
              extendedIngredients: [
                { name: 'Carrots', amount: 100, unit: 'g', original: '100 g carrots' },
              ],
              analyzedInstructions: [{ steps: [{ step: 'Test-only: simmer carrots.' }] }],
              sourceUrl: 'https://example.com/test-only',
            },
          ],
          totalResults: 1,
        }),
        { headers: { 'X-API-Quota-Used': '49.5' } },
      ),
    );
    const search = { ...input, provider: 'spoonacular' as const };
    const result = await searchRecipeProvider(search, env, state, fetcher, () => now);
    expect(result).toMatchObject({ storage: 'session', expiresAt: now + 3600000, hasMore: false });
    expect(result.warnings.join(' ')).toContain('not saved');
    const [url, options] = fetcher.mock.calls[0];
    expect(new URL(String(url)).origin).toBe('https://api.spoonacular.com');
    expect(options?.headers).toMatchObject({ 'x-api-key': env.SPOONACULAR_API_KEY });
    expect(String(url)).not.toContain(env.SPOONACULAR_API_KEY);
    await expect(
      searchRecipeProvider(search, env, state, fetcher, () => now + 2000),
    ).rejects.toMatchObject({ code: 'provider_quota' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('requests and reads the documented Spoonacular Complex Search ingredient groups', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          results: [
            {
              id: 3,
              title: 'Test-only garlic soup',
              servings: 2,
              usedIngredientCount: 1,
              missedIngredientCount: 1,
              usedIngredients: [
                { name: 'Garlic', amount: 5, unit: 'cloves', original: '5-6 cloves garlic' },
              ],
              missedIngredients: [
                { name: 'Olive oil', amount: 1, unit: 'tbsp', original: '1 tbsp olive oil' },
              ],
              unusedIngredients: [{ name: 'Milk', amount: 1, unit: 'cup', original: '1 cup milk' }],
              analyzedInstructions: [],
              instructions: '<p>Test-only: simmer the garlic.</p>',
              sourceUrl: 'https://example.com/test-only',
            },
          ],
          totalResults: 1,
        }),
      ),
    );
    const state = createRecipeProviderState();
    const result = await searchRecipeProvider(
      { ...input, provider: 'spoonacular', ingredients: ['Garlic'] },
      env,
      state,
      fetcher,
    );
    expect(result.recipes[0].ingredients.map((ingredient) => ingredient.name)).toEqual([
      'Garlic',
      'Olive oil',
    ]);
    expect(result.recipes[0].ingredients[0].quantity).toBeNull();
    expect(result.recipes[0].steps).toEqual(['Test-only: simmer the garlic.']);
    const endpoint = new URL(String(fetcher.mock.calls[0][0]));
    expect(endpoint.searchParams.get('fillIngredients')).toBe('true');
    expect(endpoint.searchParams.get('ignorePantry')).toBe('false');
    expect(endpoint.searchParams.get('addRecipeInformation')).toBe('true');
    expect(endpoint.searchParams.get('addRecipeInstructions')).toBe('true');
    expect(state.spoonacular.dailyPoints).toBeCloseTo(1.85);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('distinguishes unreadable upstream recipes from a successful search with no matches', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ data: [{ ...recipe, instructions: [] }] })),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [], meta: { last_page: 1 } })))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ results: [{ id: 12, title: 'Test-only incomplete' }] })),
      );
    const worker = createWorker(fetcher);
    const unreadable = await worker.fetch(request(), env);
    expect(unreadable.status).toBe(502);
    const error = await unreadable.json();
    expect(error.error.code).toBe('provider_response');
    expect(error.error.message).toContain('RecipeAPI.io returned 1 recipe');
    expect(error.error.message).toContain('Update your Cloudflare Worker');
    const empty = await worker.fetch(request(), env);
    expect(empty.status).toBe(200);
    expect(await empty.json()).toMatchObject({ recipes: [], hasMore: false });
    const spoonacular = await worker.fetch(
      request('/recipes/search', { ...input, provider: 'spoonacular' }),
      env,
    );
    expect(spoonacular.status).toBe(502);
    expect((await spoonacular.json()).error.message).toContain('Spoonacular returned 1 recipe');
  });

  it('reserves the complete Spoonacular search cost before reaching the free daily cap', async () => {
    const now = Date.parse('2026-10-12T12:00:00Z');
    const state = createRecipeProviderState();
    state.spoonacular.day = Math.floor(now / 86400000);
    state.spoonacular.dailyPoints = 48.2;
    const fetcher = vi.fn<typeof fetch>();
    await expect(
      searchRecipeProvider({ ...input, provider: 'spoonacular' }, env, state, fetcher, () => now),
    ).rejects.toMatchObject({ status: 429, code: 'provider_quota' });
    expect(fetcher).not.toHaveBeenCalled();
  });
});
