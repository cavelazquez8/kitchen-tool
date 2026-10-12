import { afterEach, describe, expect, it, vi } from 'vitest';
import { queryRecipeProviders, searchRecipeProviders } from './providerClient';
import { recipeApiToRecipe, RECIPE_PROVIDER_INFO } from './providers';

const connection = {
  url: 'https://mise.example.workers.dev',
  token: 'test_only_' + 'a'.repeat(40),
};
afterEach(() => vi.unstubAllGlobals());

describe('provider client', () => {
  it('explains older Workers without breaking the existing Gemini connection', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          error: { code: 'not_found', message: 'This endpoint does not exist.' },
        }),
        { status: 404 },
      ),
    );
    vi.stubGlobal('fetch', fetcher);
    await expect(queryRecipeProviders(connection)).rejects.toMatchObject({ code: 'worker_update' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('reads configured providers through the private Worker with no provider key in browser requests', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          providers: RECIPE_PROVIDER_INFO.map((provider) => ({ ...provider, configured: true })),
        }),
      ),
    );
    vi.stubGlobal('fetch', fetcher);
    expect((await queryRecipeProviders(connection)).map((provider) => provider.configured)).toEqual(
      [true, true],
    );
    expect(fetcher.mock.calls[0]).toMatchObject([
      `${connection.url}/recipe-providers`,
      {
        credentials: 'omit',
        cache: 'no-store',
        headers: { Authorization: `Bearer ${connection.token}` },
      },
    ]);
  });

  it('validates input and source policy before returning recipes', async () => {
    const recipe = recipeApiToRecipe({
      id: 1,
      name: 'Test-only soup',
      servings: null,
      ingredients: [{ name: 'Carrots', quantity: null, unit: '' }],
      instructions: ['Test-only: simmer carrots.'],
    });
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          provider: 'recipeapi',
          storage: 'personal',
          recipes: [recipe],
          page: 1,
          hasMore: false,
          warnings: [],
        }),
      ),
    );
    vi.stubGlobal('fetch', fetcher);
    await expect(
      searchRecipeProviders(connection, { provider: 'recipeapi', query: 'soup', limit: 100 }),
    ).rejects.toMatchObject({ code: 'invalid_request' });
    expect(fetcher).not.toHaveBeenCalled();
    const result = await searchRecipeProviders(connection, {
      provider: 'recipeapi',
      query: 'soup',
    });
    expect(result.recipes[0].ingredients[0].quantity).toBeNull();
    const options = fetcher.mock.calls[0][1];
    expect(JSON.parse(String(options?.body))).toEqual({
      provider: 'recipeapi',
      query: 'soup',
      page: 1,
      limit: 10,
    });
  });
});
