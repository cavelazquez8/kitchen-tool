import { expect, test, type Page } from '@playwright/test';
import type { InventoryState } from '../src/domain/types';
import type { Recipe } from '../src/recipes/types';

function makeRecipe(
  id: string,
  title: string,
  ingredients: string[],
  category = 'Dinner',
  cuisine = 'American',
): Recipe {
  return {
    id,
    title,
    servings: 2,
    ingredients: ingredients.map((name) => ({
      name,
      quantity: name === 'Eggs' ? 2 : 100,
      unit: name === 'Eggs' ? 'each' : 'g',
    })),
    steps: ['Test-only fixture: prepare and cook the ingredients.'],
    category,
    cuisine,
    source: id.startsWith('recipeapi:')
      ? { type: 'imported', name: 'RecipeAPI.io', attribution: 'RecipeAPI.io test fixture' }
      : { type: 'wikibooks', attribution: 'Wikibooks test fixture' },
  };
}

const library = [
  makeRecipe('wikibooks:1', 'A rice bowl', ['Rice']),
  makeRecipe('wikibooks:2', 'Z carrot soup', ['Carrots'], 'Soup', 'French'),
  makeRecipe('wikibooks:3', 'Egg toast', ['Eggs', 'Bread'], 'Breakfast'),
  makeRecipe('wikibooks:4', 'Pasta bake', ['Pasta', 'Basil', 'Tomatoes'], 'Dinner', 'Italian'),
  makeRecipe('wikibooks:5', 'Rice and eggs', ['Rice', 'Eggs'], 'Dinner', 'Japanese'),
  makeRecipe('wikibooks:6', 'Milk pudding', ['Milk'], 'Dessert'),
];

async function navigateRecipes(page: Page) {
  await page
    .getByRole('button', { name: 'Recipes', exact: true })
    .filter({ visible: true })
    .first()
    .click();
}

async function choose(page: Page, name: string, option: string) {
  await page.getByRole('combobox', { name, exact: true }).click();
  await page.getByRole('option', { name: option, exact: true }).click();
}

function cards(page: Page) {
  return page.locator('.kitchen-hub .recipe-grid .recipe-card');
}

async function expectCount(page: Page, count: number) {
  await expect(cards(page)).toHaveCount(count);
  await expect(page.locator('.library-results')).toContainText(
    new RegExp(`Showing ${count} of ${count} recipe`),
  );
}

test.beforeEach(async ({ page }) => {
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const expiresOn = `${tomorrow.getFullYear()}-${String(tomorrow.getMonth() + 1).padStart(2, '0')}-${String(tomorrow.getDate()).padStart(2, '0')}`;
  const inventory: InventoryState = {
    products: ['Rice', 'Carrots', 'Eggs', 'Milk'].map((name, index) => ({
      id: `test-product-${index}`,
      name,
      ingredientName: name,
      isStaple: false,
    })),
    batches: ['Rice', 'Carrots', 'Eggs', 'Milk'].map((name, index) => ({
      id: `test-batch-${index}`,
      productId: `test-product-${index}`,
      location: name === 'Rice' ? 'pantry' : 'fridge',
      quantity: name === 'Milk' ? null : name === 'Eggs' ? 6 : 500,
      unit: name === 'Eggs' ? 'each' : 'g',
      purchasedOn: '2026-01-01',
      expiresOn: name === 'Carrots' ? expiresOn : null,
    })),
    tools: [],
    recipes: [],
  };
  await page.addInitScript((state) => {
    localStorage.setItem(
      'kitchen-wrapper.inventory.v1',
      JSON.stringify({ schemaVersion: 1, state }),
    );
    localStorage.setItem(
      'mise.gemini.connection.v1',
      JSON.stringify({
        url: 'https://mise.example.workers.dev',
        token: 'test_only_' + 'a'.repeat(40),
      }),
    );
  }, inventory);
  await page.route('**/data/wikibooks-recipes.json', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ version: 1, recipes: library }),
    }),
  );
  await page.route('https://www.themealdb.com/api/**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ meals: null }),
    }),
  );
  await page.goto('/');
});

test('updates local results and counts while typing, changing facets, and choosing inventory', async ({
  page,
}) => {
  await page.getByRole('checkbox', { name: 'Select Rice in Pantry', exact: true }).check();
  await navigateRecipes(page);
  await expectCount(page, 6);
  const query = page.getByRole('textbox', { name: 'Find recipes', exact: true });
  await query.fill('rice');
  await expectCount(page, 2);
  await query.fill('not a test recipe');
  await expectCount(page, 0);
  await query.fill('');
  await expectCount(page, 6);

  await page.getByText('Refine recipes', { exact: true }).click();
  await choose(page, 'Recipe category', 'Dinner');
  await expectCount(page, 3);
  await choose(page, 'Recipe cuisine', 'Japanese');
  await expectCount(page, 1);
  await expect(cards(page)).toContainText('Rice and eggs');
  await page.getByRole('button', { name: 'Clear filters', exact: true }).click();
  await page.getByRole('button', { name: 'Missing up to 2', exact: true }).click();
  await expectCount(page, 5);
  await expect(cards(page).filter({ hasText: 'Pasta bake' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Ready to cook', exact: true }).click();
  await expectCount(page, 3);
  await page.getByRole('checkbox', { name: 'Use only selected inventory', exact: true }).check();
  await expectCount(page, 1);
  await expect(cards(page)).toContainText('A rice bowl');
  await page.getByRole('checkbox', { name: 'Use only selected inventory', exact: true }).uncheck();
  await expectCount(page, 3);
  await page.getByRole('button', { name: 'All recipes', exact: true }).click();
  await page.getByRole('button', { name: 'Browse all', exact: true }).click();
  await expect(cards(page).first()).toContainText('A rice bowl');
  await page
    .getByRole('checkbox', { name: 'Prioritize expiring ingredients', exact: true })
    .check();
  await expect(cards(page).first()).toContainText('Z carrot soup');
  await page.getByRole('button', { name: 'Ready to cook', exact: true }).click();
  await page.getByRole('checkbox', { name: 'Use only selected inventory', exact: true }).check();
  await expectCount(page, 1);
  await page
    .getByRole('button', { name: 'Inventory', exact: true })
    .filter({ visible: true })
    .first()
    .click();
  await page.getByRole('button', { name: 'Clear selection', exact: true }).click();
  await navigateRecipes(page);
  await expectCount(page, 6);
  await page.getByRole('button', { name: 'Ready to cook', exact: true }).click();
  await expectCount(page, 3);
  await expect(
    page.getByRole('checkbox', { name: 'Use only selected inventory', exact: true }),
  ).toHaveCount(0);
});

test('searches a chosen provider explicitly and applies filters to its grid and counts', async ({
  page,
}) => {
  const requests: { provider: string; query: string; page: number }[] = [];
  const remote = [
    makeRecipe('recipeapi:10', 'Remote rice soup', ['Rice'], 'Soup', 'Japanese'),
    makeRecipe(
      'recipeapi:11',
      'Remote pasta soup',
      ['Pasta', 'Basil', 'Tomatoes'],
      'Soup',
      'Italian',
    ),
    makeRecipe('recipeapi:12', 'Remote egg soup', ['Eggs'], 'Dinner', 'American'),
  ];
  await page.route('https://mise.example.workers.dev/recipes/search', async (route) => {
    const input = route.request().postDataJSON();
    requests.push(input);
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        provider: 'recipeapi',
        storage: 'personal',
        recipes: remote,
        page: 1,
        hasMore: true,
        warnings: [],
      }),
    });
  });
  await navigateRecipes(page);
  await expectCount(page, 6);
  await choose(page, 'Recipe source', 'RecipeAPI.io');
  await expect(cards(page)).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'More recipes online', exact: true })).toHaveCount(
    0,
  );
  // Provider search may use metadata or synonyms absent from recipe titles and ingredients.
  await page.getByRole('textbox', { name: 'Find recipes', exact: true }).fill('dinner');
  expect(requests).toHaveLength(0);
  await page.getByRole('button', { name: 'Search RecipeAPI.io', exact: true }).click();
  await expectCount(page, 3);
  await expect(page.locator('.kitchen-hub .recipe-grid')).toHaveCount(1);
  await expect(cards(page).filter({ hasText: 'Wikibooks' })).toHaveCount(0);
  await expect(page.locator('.library-results')).toContainText('RecipeAPI.io');
  await page.getByRole('button', { name: 'Ready to cook', exact: true }).click();
  await expectCount(page, 2);
  await page.getByRole('button', { name: 'All recipes', exact: true }).click();
  await page.getByText('Refine recipes', { exact: true }).click();
  await choose(page, 'Recipe category', 'Soup');
  await expectCount(page, 2);
  await choose(page, 'Recipe cuisine', 'Japanese');
  await expectCount(page, 1);
  await expect(cards(page)).toContainText('Remote rice soup');
  expect(requests).toEqual([
    expect.objectContaining({ provider: 'recipeapi', query: 'dinner', page: 1 }),
  ]);
  await choose(page, 'Recipe source', 'Your cookbook');
  await page.getByRole('textbox', { name: 'Find recipes', exact: true }).fill('');
  await expectCount(page, 6);
  await expect(page.getByRole('combobox', { name: 'Recipe category', exact: true })).toHaveText(
    'Every category',
  );
  await expect(page.getByRole('combobox', { name: 'Recipe cuisine', exact: true })).toHaveText(
    'Every cuisine',
  );
});

test('filters personal imports separately from saved provider, own, and AI recipes while preserving readiness', async ({
  page,
}) => {
  const saved: Recipe[] = [
    {
      ...makeRecipe('imported:rice', 'Personal rice bowl', ['Rice']),
      source: { type: 'imported' },
    },
    {
      ...makeRecipe('imported:pasta', 'Personal pasta dish', ['Pasta', 'Basil', 'Tomatoes']),
      source: { type: 'imported' },
    },
    makeRecipe('recipeapi:50', 'Saved provider rice', ['Rice']),
    { ...makeRecipe('manual:eggs', 'My own eggs', ['Eggs']), source: { type: 'manual' } },
    { ...makeRecipe('ai:eggs', 'AI eggs', ['Eggs']), source: { type: 'ai' } },
  ];
  await page.evaluate((recipes) => {
    const key = 'kitchen-wrapper.inventory.v1';
    const document = JSON.parse(localStorage.getItem(key)!);
    document.state.recipes = recipes;
    const updated = JSON.stringify(document);
    localStorage.setItem(key, updated);
    window.dispatchEvent(
      new StorageEvent('storage', { key, newValue: updated, storageArea: localStorage }),
    );
  }, saved);
  await navigateRecipes(page);
  await expectCount(page, 11);
  await page.getByRole('button', { name: 'Imported recipes', exact: true }).click();
  await expectCount(page, 2);
  await expect(cards(page).locator('h3')).toHaveText(['Personal rice bowl', 'Personal pasta dish']);
  await expect(page.getByRole('heading', { name: 'Saved provider rice', exact: true })).toHaveCount(
    0,
  );
  await page.getByRole('button', { name: 'Ready to cook', exact: true }).click();
  await expectCount(page, 1);
  const query = page.getByRole('textbox', { name: 'Find recipes', exact: true });
  await query.fill('rice');
  await expectCount(page, 1);
  await query.fill('pasta');
  await expectCount(page, 0);
  await query.fill('');
  await choose(page, 'Recipe collection', 'Your own recipes');
  await expectCount(page, 1);
  await expect(cards(page)).toContainText('My own eggs');
  await choose(page, 'Recipe collection', 'AI-created recipes');
  await expectCount(page, 1);
  await expect(cards(page)).toContainText('AI eggs');
  await choose(page, 'Recipe collection', 'Saved recipes');
  await expectCount(page, 4);
  await page.getByRole('button', { name: 'All recipes', exact: true }).click();
  await expectCount(page, 11);
  await choose(page, 'Recipe source', 'RecipeAPI.io');
  await expect(cards(page)).toHaveCount(0);
  await choose(page, 'Recipe collection', 'Imported recipes');
  await expect(page.getByRole('combobox', { name: 'Recipe source', exact: true })).toHaveText(
    'Your cookbook',
  );
  await expectCount(page, 2);
});

test('keeps a pending search valid when changing a presentation filter and applies it on arrival', async ({
  page,
}) => {
  let release: () => void = () => {};
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  let requests = 0;
  await page.route('https://mise.example.workers.dev/recipes/search', async (route) => {
    requests++;
    await waiting;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        provider: 'recipeapi',
        storage: 'personal',
        recipes: [
          makeRecipe('recipeapi:20', 'Remote rice soup', ['Rice']),
          makeRecipe('recipeapi:21', 'Remote pasta soup', ['Pasta', 'Basil', 'Tomatoes']),
        ],
        page: 1,
        hasMore: false,
        warnings: [],
      }),
    });
  });
  await navigateRecipes(page);
  await choose(page, 'Recipe source', 'RecipeAPI.io');
  await page.getByRole('textbox', { name: 'Find recipes', exact: true }).fill('soup');
  await page.getByRole('button', { name: 'Search RecipeAPI.io', exact: true }).click();
  await expect.poll(() => requests).toBe(1);
  await page.getByRole('button', { name: 'Ready to cook', exact: true }).click();
  release();
  await expectCount(page, 1);
  await expect(cards(page)).toContainText('Remote rice soup');
  await page.getByRole('button', { name: 'All recipes', exact: true }).click();
  await expectCount(page, 2);
  expect(requests).toBe(1);
});

test('loads provider pages with the submitted query and invalidates paging when the query changes', async ({
  page,
}) => {
  const requests: { provider: string; query: string; page: number }[] = [];
  await page.route('https://mise.example.workers.dev/recipes/search', async (route) => {
    const input = route.request().postDataJSON();
    requests.push(input);
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        provider: 'recipeapi',
        storage: 'personal',
        recipes: [
          makeRecipe(`recipeapi:${input.page}`, `Remote ${input.query} ${input.page}`, ['Rice']),
        ],
        page: input.page,
        hasMore: input.page === 1,
        warnings: [],
      }),
    });
  });
  await navigateRecipes(page);
  await choose(page, 'Recipe source', 'RecipeAPI.io');
  const query = page.getByRole('textbox', { name: 'Find recipes', exact: true });
  await query.fill('rice');
  await page.getByRole('button', { name: 'Search RecipeAPI.io', exact: true }).click();
  await expectCount(page, 1);
  await page.getByRole('button', { name: 'Load more from RecipeAPI.io', exact: true }).click();
  await expectCount(page, 2);
  expect(requests).toEqual([
    expect.objectContaining({ provider: 'recipeapi', query: 'rice', page: 1 }),
    expect.objectContaining({ provider: 'recipeapi', query: 'rice', page: 2 }),
  ]);
  await query.fill('carrot');
  await expect(cards(page)).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: 'Load more from RecipeAPI.io', exact: true }),
  ).toHaveCount(0);
  expect(requests).toHaveLength(2);
  await page.getByRole('button', { name: 'Search RecipeAPI.io', exact: true }).click();
  await expectCount(page, 1);
  await expect(cards(page)).toContainText('Remote carrot 1');
  expect(requests[2]).toEqual(
    expect.objectContaining({ provider: 'recipeapi', query: 'carrot', page: 1 }),
  );
});

test('discards provider responses after typing a new query or choosing another source', async ({
  page,
}) => {
  const pending: { query: string; release: () => void; done: Promise<void> }[] = [];
  await page.route('https://mise.example.workers.dev/recipes/search', async (route) => {
    const input = route.request().postDataJSON();
    let release: () => void = () => {};
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    let finish: () => void = () => {};
    const done = new Promise<void>((resolve) => {
      finish = resolve;
    });
    pending.push({ query: input.query, release, done });
    await waiting;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        provider: 'recipeapi',
        storage: 'personal',
        recipes: [makeRecipe('recipeapi:99', `Stale ${input.query}`, ['Rice'])],
        page: 1,
        hasMore: true,
        warnings: [],
      }),
    });
    finish();
  });
  await navigateRecipes(page);
  await choose(page, 'Recipe source', 'RecipeAPI.io');
  const query = page.getByRole('textbox', { name: 'Find recipes', exact: true });
  await query.fill('rice');
  await page.getByRole('button', { name: 'Search RecipeAPI.io', exact: true }).click();
  await expect.poll(() => pending.length).toBe(1);
  await query.fill('egg');
  pending[0].release();
  await pending[0].done;
  await expect(cards(page)).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: 'Load more from RecipeAPI.io', exact: true }),
  ).toHaveCount(0);
  await page.getByRole('button', { name: 'Search RecipeAPI.io', exact: true }).click();
  await expect.poll(() => pending.length).toBe(2);
  await choose(page, 'Recipe source', 'Your cookbook');
  await query.fill('');
  pending[1].release();
  await pending[1].done;
  await expectCount(page, 6);
  await expect(page.getByRole('heading', { name: /^Stale / })).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: 'Load more from RecipeAPI.io', exact: true }),
  ).toHaveCount(0);
});
