import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { saveGeminiConnection } from '../ai/client';
import { createEmptyInventory } from '../domain/types';
import { RECIPE_PROVIDER_INFO, recipeApiToRecipe, spoonacularToRecipe } from '../recipes/providers';
import { KitchenHub } from './KitchenHub';
import { RecipeProviderSettings } from './RecipeProviderSettings';
import { loadLocalRecipes } from '../recipes/localLibrary';

vi.mock('../recipes/localLibrary', () => ({
  loadLocalRecipes: vi.fn().mockResolvedValue([]),
  searchLocalRecipes: (recipes: unknown[]) => recipes,
  recipeFacets: () => ({ categories: [], cuisines: [] }),
}));

const connection = {
  url: 'https://mise.example.workers.dev',
  token: 'test_only_' + 'a'.repeat(40),
};
const common = {
  inventory: createEmptyInventory(),
  selectedBatchIds: [],
  update: vi.fn().mockResolvedValue(undefined),
  onToast: vi.fn(),
  onQuickAdd: vi.fn(),
  onScan: vi.fn(),
  onConfigure: vi.fn(),
  onNavigate: vi.fn(),
};

beforeEach(() => {
  localStorage.clear();
  saveGeminiConnection(connection);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe('optional recipe source UI', () => {
  it('falls back to all inventory when a selected batch disappears without remounting the browser', async () => {
    const recipe = recipeApiToRecipe({
      id: 123,
      name: 'Carrot soup',
      servings: 2,
      ingredients: [{ name: 'Carrots', quantity: 100, unit: 'g' }],
      instructions: ['Simmer.'],
    })!;
    const milk = {
      ...recipe,
      id: 'manual:milk',
      title: 'Milk pudding',
      ingredients: [{ name: 'Milk', quantity: 100, unit: 'g' }],
      source: { type: 'manual' as const },
    };
    vi.mocked(loadLocalRecipes).mockResolvedValueOnce([recipe, milk]);
    const inventory = {
      products: [
        { id: 'carrots', name: 'Carrots', isStaple: false },
        { id: 'milk', name: 'Milk', isStaple: false },
      ],
      batches: ['carrots', 'milk'].map((id) => ({
        id,
        productId: id,
        quantity: 200,
        unit: 'g',
        location: 'fridge' as const,
        purchasedOn: '2026-01-01',
        expiresOn: null,
      })),
      tools: [],
    };
    const user = userEvent.setup();
    const { rerender } = render(
      <KitchenHub
        {...common}
        inventory={inventory}
        selectedBatchIds={['carrots']}
        page="recipes"
      />,
    );
    await screen.findByRole('heading', { name: 'Carrot soup' });
    await user.click(screen.getByText('Refine recipes', { exact: true }));
    await user.click(screen.getByRole('checkbox', { name: 'Use only selected inventory' }));
    await user.click(screen.getByRole('button', { name: 'Ready to cook' }));
    expect(screen.queryByRole('heading', { name: 'Milk pudding' })).not.toBeInTheDocument();
    rerender(<KitchenHub {...common} inventory={inventory} selectedBatchIds={[]} page="recipes" />);
    expect(await screen.findByRole('heading', { name: 'Milk pudding' })).toBeVisible();
    expect(
      screen.queryByRole('checkbox', { name: 'Use only selected inventory' }),
    ).not.toBeInTheDocument();
    expect(screen.getByText(/Showing 2 of 2 recipes/)).toBeVisible();
  });
  it('checks provider settings only when requested and explains older Workers', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(
          JSON.stringify({ error: { code: 'not_found', message: 'Missing endpoint' } }),
          { status: 404 },
        ),
      );
    vi.stubGlobal('fetch', fetcher);
    const user = userEvent.setup();
    render(<RecipeProviderSettings onToast={vi.fn()} />);
    expect(fetcher).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Check recipe sources' }));
    expect(await screen.findByRole('status')).toHaveTextContent('latest Worker');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('distinguishes configured sources from unverified API-key access', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>().mockResolvedValue(
        new Response(
          JSON.stringify({
            providers: RECIPE_PROVIDER_INFO.map((provider) => ({
              ...provider,
              configured: provider.id === 'recipeapi',
            })),
          }),
        ),
      ),
    );
    const user = userEvent.setup();
    render(<RecipeProviderSettings onToast={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: 'Check recipe sources' }));
    expect(await screen.findByText('Configured')).toBeVisible();
    expect(screen.getByText('Needs setup')).toBeVisible();
    expect(screen.getByRole('status')).toHaveTextContent('without calling the recipe APIs');
    expect(screen.getByRole('button', { name: 'Test RecipeAPI.io search' })).toBeEnabled();
    expect(
      screen.queryByRole('button', { name: 'Test Spoonacular search' }),
    ).not.toBeInTheDocument();
  });

  it('verifies a configured source only on request and reports readable recipes', async () => {
    const recipe = recipeApiToRecipe({
      id: 100,
      name: 'Chicken soup',
      ingredients: [{ name: 'Chicken', quantity: 100, unit: 'g' }],
      instructions: ['Simmer.'],
    })!;
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (url) =>
      String(url).endsWith('/recipe-providers')
        ? new Response(
            JSON.stringify({
              providers: RECIPE_PROVIDER_INFO.map((provider) => ({
                ...provider,
                configured: true,
              })),
            }),
          )
        : new Response(
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
    const user = userEvent.setup();
    render(<RecipeProviderSettings onToast={vi.fn()} />);
    expect(fetcher).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Check recipe sources' }));
    expect(fetcher).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole('button', { name: 'Test RecipeAPI.io search' }));
    expect(
      await screen.findByRole('status', { name: 'RecipeAPI.io search check' }),
    ).toHaveTextContent('Search verified · 1 readable recipe returned.');
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String(fetcher.mock.calls[1][1]?.body))).toEqual({
      provider: 'recipeapi',
      query: 'chicken',
      page: 1,
      limit: 1,
    });
    expect(
      screen.queryByRole('status', { name: 'Spoonacular search check' }),
    ).not.toBeInTheDocument();
    expect(common.update).not.toHaveBeenCalled();
  });

  it('keeps test-search results separate for each provider and distinguishes empty records', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (url, options) => {
      if (String(url).endsWith('/recipe-providers'))
        return new Response(
          JSON.stringify({
            providers: RECIPE_PROVIDER_INFO.map((provider) => ({ ...provider, configured: true })),
          }),
        );
      const provider = JSON.parse(String(options?.body)).provider;
      return new Response(
        JSON.stringify({
          provider,
          storage: provider === 'recipeapi' ? 'personal' : 'session',
          recipes: [],
          page: 1,
          hasMore: false,
          warnings:
            provider === 'recipeapi'
              ? ['1 recipe was omitted because complete ingredients could not be read safely.']
              : [
                  'Online discovery only. Spoonacular results are not saved or included in backups.',
                ],
          ...(provider === 'spoonacular' ? { expiresAt: Date.now() + 3600000 } : {}),
        }),
      );
    });
    vi.stubGlobal('fetch', fetcher);
    const user = userEvent.setup();
    render(<RecipeProviderSettings onToast={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: 'Check recipe sources' }));
    await user.click(screen.getByRole('button', { name: 'Test RecipeAPI.io search' }));
    const recipeApiStatus = await screen.findByRole('status', {
      name: 'RecipeAPI.io search check',
    });
    expect(recipeApiStatus).toHaveTextContent('no readable recipes were returned');
    expect(recipeApiStatus).toHaveTextContent('complete ingredients could not be read safely');
    await user.click(screen.getByRole('button', { name: 'Test Spoonacular search' }));
    expect(
      await screen.findByRole('status', { name: 'Spoonacular search check' }),
    ).toHaveTextContent('No recipes returned for “chicken”');
    expect(recipeApiStatus).toHaveTextContent('no readable recipes were returned');
    expect(screen.queryByText(/Search verified/)).not.toBeInTheDocument();
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it('reports provider failures without retrying or losing configured status', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (url) =>
      String(url).endsWith('/recipe-providers')
        ? new Response(
            JSON.stringify({
              providers: RECIPE_PROVIDER_INFO.map((provider) => ({
                ...provider,
                configured: provider.id === 'recipeapi',
              })),
            }),
          )
        : new Response(
            JSON.stringify({
              error: {
                code: 'provider_configuration',
                message: 'This source rejected its API key.',
              },
            }),
            { status: 503 },
          ),
    );
    vi.stubGlobal('fetch', fetcher);
    const user = userEvent.setup();
    render(<RecipeProviderSettings onToast={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: 'Check recipe sources' }));
    await user.click(screen.getByRole('button', { name: 'Test RecipeAPI.io search' }));
    expect(
      await screen.findByRole('alert', { name: 'RecipeAPI.io search check' }),
    ).toHaveTextContent('Search failed · This source rejected its API key.');
    expect(screen.getByText('Configured')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Test RecipeAPI.io search' })).toBeEnabled();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('prevents simultaneous checks and cancels a pending test when settings close', async () => {
    let searchSignal: AbortSignal | null = null;
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (url, options) => {
      if (String(url).endsWith('/recipe-providers'))
        return new Response(
          JSON.stringify({
            providers: RECIPE_PROVIDER_INFO.map((provider) => ({ ...provider, configured: true })),
          }),
        );
      searchSignal = options?.signal ?? null;
      return new Promise<Response>((_resolve, reject) => {
        searchSignal?.addEventListener('abort', () => reject(new Error('Request cancelled.')), {
          once: true,
        });
      });
    });
    vi.stubGlobal('fetch', fetcher);
    const user = userEvent.setup();
    const { unmount } = render(<RecipeProviderSettings onToast={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: 'Check recipe sources' }));
    await user.click(screen.getByRole('button', { name: 'Test RecipeAPI.io search' }));
    expect(screen.getByRole('status', { name: 'RecipeAPI.io search check' })).toHaveTextContent(
      'Searching for “chicken”',
    );
    expect(screen.getByRole('button', { name: 'Test RecipeAPI.io search' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Test Spoonacular search' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Check recipe sources' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Test Spoonacular search' }));
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect((searchSignal as AbortSignal | null)?.aborted).toBe(false);
    unmount();
    expect((searchSignal as AbortSignal | null)?.aborted).toBe(true);
  });

  it('keeps Spoonacular discovery link-only and clears temporary results when leaving recipes', async () => {
    const recipe = spoonacularToRecipe({
      id: 123,
      title: 'Test-only soup',
      servings: 1,
      extendedIngredients: [{ name: 'Carrots', amount: 100, unit: 'g', original: '100 g carrots' }],
      analyzedInstructions: [{ steps: [{ step: 'Test-only simmer step' }] }],
      sourceUrl: 'https://example.com/test-only',
    })!;
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          provider: 'spoonacular',
          storage: 'session',
          recipes: [recipe],
          page: 1,
          hasMore: false,
          warnings: [],
          expiresAt: Date.now() + 3600000,
        }),
      ),
    );
    vi.stubGlobal('fetch', fetcher);
    const user = userEvent.setup();
    const { rerender } = render(<KitchenHub {...common} page="recipes" />);
    await waitFor(() =>
      expect(screen.queryByText('Opening your cookbook…')).not.toBeInTheDocument(),
    );
    expect(fetcher).not.toHaveBeenCalled();
    await user.click(screen.getByRole('combobox', { name: 'Recipe source' }));
    await user.click(screen.getByRole('option', { name: 'Spoonacular' }));
    await user.type(screen.getByRole('textbox', { name: 'Find recipes' }), 'soup');
    await user.click(screen.getByRole('button', { name: 'Search Spoonacular' }));
    const results = await screen.findByRole('region', { name: 'Spoonacular search results' });
    expect(within(results).getByRole('link', { name: 'Open original recipe' })).toHaveAttribute(
      'href',
      'https://example.com/test-only',
    );
    expect(
      within(results).queryByRole('button', { name: /Save|View recipe|meal plan|Gemini/ }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText('Test-only simmer step')).not.toBeInTheDocument();
    expect(common.update).not.toHaveBeenCalled();
    rerender(<KitchenHub {...common} page="shopping" />);
    rerender(<KitchenHub {...common} page="recipes" />);
    expect(
      screen.queryByRole('region', { name: 'Spoonacular search results' }),
    ).not.toBeInTheDocument();
  });

  it('opens attributed RecipeAPI details and preserves search parameters on the next page', async () => {
    const recipe = recipeApiToRecipe({
      id: 123,
      name: 'Test-only soup',
      servings: 2,
      ingredients: [{ name: 'Carrots', quantity: 100, unit: 'g' }],
      instructions: ['Test-only simmer step'],
    })!;
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_url, options) => {
      const input = JSON.parse(String(options?.body));
      return new Response(
        JSON.stringify({
          provider: 'recipeapi',
          storage: 'personal',
          recipes: [{ ...recipe, id: `recipeapi:${input.page}` }],
          page: input.page,
          hasMore: input.page === 1,
          warnings: [],
        }),
      );
    });
    vi.stubGlobal('fetch', fetcher);
    const user = userEvent.setup();
    render(<KitchenHub {...common} page="recipes" />);
    await waitFor(() =>
      expect(screen.queryByText('Opening your cookbook…')).not.toBeInTheDocument(),
    );
    await user.click(screen.getByRole('combobox', { name: 'Recipe source' }));
    await user.click(screen.getByRole('option', { name: 'RecipeAPI.io' }));
    await user.type(screen.getByRole('textbox', { name: 'Find recipes' }), 'soup');
    await user.click(screen.getByRole('button', { name: 'Search RecipeAPI.io' }));
    const results = await screen.findByRole('region', { name: 'RecipeAPI.io search results' });
    expect(within(results).getByRole('button', { name: 'Save Test-only soup' })).toBeEnabled();
    await user.click(within(results).getByRole('button', { name: 'View recipe' }));
    const detail = screen.getByRole('dialog', { name: 'Test-only soup' });
    expect(within(detail).getByText('Test-only simmer step')).toBeVisible();
    expect(within(detail).getByText('RecipeAPI.io · recipe 123')).toBeVisible();
    await user.click(within(detail).getByRole('button', { name: 'Close' }));
    await user.click(screen.getByRole('button', { name: 'Load more from RecipeAPI.io' }));
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
    expect(JSON.parse(String(fetcher.mock.calls[1][1]?.body))).toMatchObject({
      query: 'soup',
      page: 2,
    });
    expect(within(results).getAllByRole('button', { name: 'View recipe' })).toHaveLength(2);
    await user.clear(screen.getByRole('textbox', { name: 'Find recipes' }));
    await user.type(screen.getByRole('textbox', { name: 'Find recipes' }), 'different query');
    expect(within(results).queryByRole('button', { name: 'View recipe' })).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Load more from RecipeAPI.io' }),
    ).not.toBeInTheDocument();
    expect(fetcher).toHaveBeenCalledTimes(2);
    await user.click(screen.getByRole('button', { name: 'Search RecipeAPI.io' }));
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(3));
    expect(JSON.parse(String(fetcher.mock.calls[2][1]?.body))).toMatchObject({
      query: 'different query',
      page: 1,
    });
  });
});
