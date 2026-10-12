import { expect, test, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { RECIPE_PROVIDER_INFO } from '../src/recipes/providers';
import type { Recipe } from '../src/recipes/types';

const recipe: Recipe = {
  id: 'recipeapi:123',
  title: 'Test-only carrot soup',
  servings: 2,
  ingredients: [{ name: 'Carrots', quantity: 100, unit: 'g', original: '100 g carrots' }],
  steps: ['Test fixture: simmer the carrots.'],
  source: {
    type: 'imported',
    name: 'RecipeAPI.io',
    url: 'https://recipeapi.io/',
    attribution: 'RecipeAPI.io · recipe 123',
    license: 'Personal use',
    licenseUrl: 'https://recipeapi.io/legal/terms-of-service',
  },
};

async function navigate(page: Page, name: 'Recipes' | 'Inventory') {
  await page.getByRole('button', { name, exact: true }).filter({ visible: true }).first().click();
}
async function selectSource(page: Page, label: string) {
  await page.getByRole('combobox', { name: 'Recipe source', exact: true }).click();
  await page.getByRole('option', { name: label, exact: true }).click();
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem(
      'mise.gemini.connection.v1',
      JSON.stringify({
        url: 'https://mise.example.workers.dev',
        token: 'test_only_' + 'a'.repeat(40),
      }),
    );
  });
  await page.route('**/data/wikibooks-recipes.json', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        version: 1,
        recipes: [
          {
            ...recipe,
            id: 'manual:fixture',
            title: 'Test-only built-in fixture',
            source: { type: 'manual' },
          },
        ],
      }),
    }),
  );
  await page.route('https://www.themealdb.com/api/**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ meals: null }),
    }),
  );
});

test('saves a selected RecipeAPI recipe with attribution and loads another page', async ({
  page,
}) => {
  const queries: { query: string; page: number }[] = [];
  await page.route('https://mise.example.workers.dev/recipes/search', async (route) => {
    const input = route.request().postDataJSON();
    queries.push(input);
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        provider: 'recipeapi',
        storage: 'personal',
        recipes: [
          { ...recipe, id: `recipeapi:${input.page}`, title: `${recipe.title} ${input.page}` },
        ],
        page: input.page,
        hasMore: input.page === 1,
        warnings: [],
      }),
    });
  });
  await page.goto('/');
  await navigate(page, 'Recipes');
  expect(queries).toHaveLength(0);
  await selectSource(page, 'RecipeAPI.io');
  await page.getByRole('textbox', { name: 'Find recipes', exact: true }).fill('soup');
  await page.getByRole('button', { name: 'Search RecipeAPI.io', exact: true }).click();
  const results = page.getByRole('region', { name: 'RecipeAPI.io search results' });
  await expect(results.getByRole('heading', { name: 'Test-only carrot soup 1' })).toBeVisible();
  await results.getByRole('button', { name: 'Save Test-only carrot soup 1', exact: true }).click();
  const editor = page.getByRole('dialog', { name: 'Review your recipe' });
  await editor.getByRole('button', { name: 'Save recipe', exact: true }).click();
  await expect(editor).not.toBeVisible();
  await expect(page.getByRole('combobox', { name: 'Recipe source', exact: true })).toHaveText(
    'RecipeAPI.io',
  );
  await expect(results.getByRole('heading', { name: 'Test-only carrot soup 1' })).toBeVisible();
  const stored = await page.evaluate(() =>
    JSON.parse(localStorage.getItem('kitchen-wrapper.inventory.v1') ?? 'null'),
  );
  expect(stored.state.recipes[0].source.attribution).toBe('RecipeAPI.io · recipe 123');
  await results.getByRole('button', { name: 'View recipe', exact: true }).first().click();
  const detail = page.getByRole('dialog', { name: 'Test-only carrot soup 1', exact: true });
  await detail.getByRole('button', { name: 'Add to meal plan', exact: true }).click();
  await expect(detail.getByRole('button', { name: 'Update meal plan', exact: true })).toBeVisible();
  await detail.getByRole('button', { name: 'Close', exact: true }).click();
  await page.getByRole('button', { name: 'Local only', exact: true }).click();
  const settings = page.getByRole('dialog', { name: 'Your kitchen, your way' });
  const downloadPromise = page.waitForEvent('download');
  await settings.getByRole('button', { name: 'Download backup', exact: true }).click();
  const download = await downloadPromise;
  const backup = JSON.parse(await readFile((await download.path())!, 'utf8'));
  expect(backup.inventory.recipes[0].source.attribution).toBe('RecipeAPI.io · recipe 123');
  expect(backup.inventory.mealPlan[0].recipeId).toBe('recipeapi:1');
  await settings.getByRole('button', { name: 'Close', exact: true }).click();
  await page.getByRole('button', { name: 'Load more from RecipeAPI.io', exact: true }).click();
  await expect(results.getByRole('heading', { name: 'Test-only carrot soup 2' })).toBeVisible();
  expect(queries).toEqual([
    expect.objectContaining({ query: 'soup', page: 1 }),
    expect.objectContaining({ query: 'soup', page: 2 }),
  ]);
  await page.getByRole('button', { name: 'Saved recipes', exact: true }).click();
  await expect(page.getByRole('combobox', { name: 'Recipe source', exact: true })).toHaveText(
    'Your cookbook',
  );
  await expect(page.locator('.kitchen-hub .recipe-grid .recipe-card')).toHaveCount(1);
  await expect(page.getByRole('heading', { name: 'Test-only carrot soup 1' })).toBeVisible();
});

test('keeps Spoonacular discovery out of local data and expires it within an hour', async ({
  page,
}) => {
  const now = Date.now();
  await page.clock.install({ time: new Date(now) });
  let searches = 0;
  await page.route('https://mise.example.workers.dev/recipes/search', async (route) => {
    searches++;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        provider: 'spoonacular',
        storage: 'session',
        recipes: [
          {
            ...recipe,
            id: 'spoonacular:123',
            source: {
              type: 'imported',
              name: 'Spoonacular',
              url: 'https://example.com/test-only-soup',
              attribution: 'Powered by Spoonacular',
            },
          },
        ],
        page: 1,
        hasMore: false,
        warnings: [],
        expiresAt: now + 3600000,
      }),
    });
  });
  await page.goto('/');
  await navigate(page, 'Recipes');
  expect(searches).toBe(0);
  await selectSource(page, 'Spoonacular');
  await page.getByRole('textbox', { name: 'Find recipes', exact: true }).fill('soup');
  await page.getByRole('button', { name: 'Search Spoonacular', exact: true }).click();
  const results = page.getByRole('region', { name: 'Spoonacular search results' });
  await expect(results.getByRole('link', { name: 'Open original recipe' })).toHaveAttribute(
    'href',
    'https://example.com/test-only-soup',
  );
  await expect(
    results.getByRole('button', { name: /Save|View recipe|meal plan|Gemini/ }),
  ).toHaveCount(0);
  expect(
    await page.evaluate(() => localStorage.getItem('kitchen-wrapper.inventory.v1') ?? ''),
  ).not.toContain('spoonacular:123');
  await navigate(page, 'Inventory');
  await navigate(page, 'Recipes');
  await expect(results.getByRole('link', { name: 'Open original recipe' })).toHaveCount(0);
  await selectSource(page, 'Spoonacular');
  await page.getByRole('textbox', { name: 'Find recipes', exact: true }).fill('soup');
  await page.getByRole('button', { name: 'Search Spoonacular', exact: true }).click();
  await expect(results).toBeVisible();
  await page.clock.fastForward(3600001);
  await expect(results.getByRole('link', { name: 'Open original recipe' })).toHaveCount(0);
  expect(searches).toBe(2);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
});

test('explains updating an older Worker without disturbing the saved Gemini connection', async ({
  page,
}) => {
  let checks = 0;
  await page.route('https://mise.example.workers.dev/recipe-providers', async (route) => {
    checks++;
    await route.fulfill({
      status: 404,
      contentType: 'application/json',
      body: JSON.stringify({
        error: { code: 'not_found', message: 'This endpoint does not exist.' },
      }),
    });
  });
  await page.goto('/');
  expect(checks).toBe(0);
  await page.getByRole('button', { name: 'Local only', exact: true }).click();
  const settings = page.getByRole('dialog', { name: 'Your kitchen, your way' });
  await settings.getByRole('button', { name: 'Check recipe sources', exact: true }).click();
  await expect(settings.getByRole('status')).toContainText('latest Worker');
  await expect(settings.getByLabel('Backend address', { exact: true })).toHaveValue(
    'https://mise.example.workers.dev',
  );
  await settings.getByText('Connect a free recipe source', { exact: true }).click();
  await expect(
    settings.getByRole('link', { name: 'Download the updated Worker code', exact: true }),
  ).toHaveAttribute('href', '/mise-gemini-worker.js');
  expect(checks).toBe(1);
});

test('tests configured recipe sources independently without saving their connection-check recipes', async ({
  page,
}) => {
  let checks = 0;
  const searches: { provider: string; query: string; page: number; limit: number }[] = [];
  await page.route('https://mise.example.workers.dev/recipe-providers', async (route) => {
    checks++;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        providers: RECIPE_PROVIDER_INFO.map((provider) => ({ ...provider, configured: true })),
      }),
    });
  });
  await page.route('https://mise.example.workers.dev/recipes/search', async (route) => {
    const input = route.request().postDataJSON();
    searches.push(input);
    await route.fulfill(
      input.provider === 'recipeapi'
        ? {
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
              provider: 'recipeapi',
              storage: 'personal',
              recipes: [recipe],
              page: 1,
              hasMore: false,
              warnings: [],
            }),
          }
        : {
            status: 503,
            contentType: 'application/json',
            body: JSON.stringify({
              error: {
                code: 'provider_unavailable',
                message: 'Spoonacular could not finish this search. Try again later.',
              },
            }),
          },
    );
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Local only', exact: true }).click();
  const settings = page.getByRole('dialog', { name: 'Your kitchen, your way' });
  expect(searches).toHaveLength(0);
  expect(checks).toBe(0);
  await settings.getByRole('button', { name: 'Check recipe sources', exact: true }).click();
  await expect(settings.getByText('Configured', { exact: true })).toHaveCount(2);
  expect(checks).toBe(1);
  expect(searches).toHaveLength(0);
  const recipeApiButton = settings.getByRole('button', {
    name: 'Test RecipeAPI.io search',
    exact: true,
  });
  const spoonacularButton = settings.getByRole('button', {
    name: 'Test Spoonacular search',
    exact: true,
  });
  await expect(recipeApiButton).toBeEnabled();
  await expect(spoonacularButton).toBeEnabled();
  await recipeApiButton.click();
  const recipeApiStatus = settings.getByRole('status', {
    name: 'RecipeAPI.io search check',
    exact: true,
  });
  await expect(recipeApiStatus).toContainText('Search verified · 1 readable recipe returned.');
  await spoonacularButton.click();
  await expect(
    settings.getByRole('alert', { name: 'Spoonacular search check', exact: true }),
  ).toContainText('Search failed · Spoonacular could not finish this search. Try again later.');
  await expect(recipeApiStatus).toContainText('Search verified · 1 readable recipe returned.');
  await expect(settings.getByText('Configured', { exact: true })).toHaveCount(2);
  await expect(recipeApiButton).toBeEnabled();
  await expect(spoonacularButton).toBeEnabled();
  expect(searches).toEqual([
    { provider: 'recipeapi', query: 'chicken', page: 1, limit: 1 },
    { provider: 'spoonacular', query: 'chicken', page: 1, limit: 1 },
  ]);
  expect(checks).toBe(1);
  expect(
    await page.evaluate(() => localStorage.getItem('kitchen-wrapper.inventory.v1') ?? ''),
  ).not.toContain(recipe.id);
  await settings.getByRole('button', { name: 'Close', exact: true }).click();
  await navigate(page, 'Recipes');
  await page.getByRole('button', { name: 'Saved recipes', exact: true }).click();
  await expect(page.getByRole('heading', { name: recipe.title, exact: true })).toHaveCount(0);
  await expect(page.locator('.kitchen-hub .recipe-grid .recipe-card')).toHaveCount(0);
});
