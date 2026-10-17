import { expect, test, type Page } from '@playwright/test';
import type { InventoryState } from '../src/domain/types';
import type { Recipe } from '../src/recipes/types';
import {
  chooseRecipeFilter,
  chooseRecipeSort,
  clearRecipeFilters,
  closeRecipeFilters,
  openRecipeFilters,
} from './helpers/recipeFilters';

const inventoryKey = 'kitchen-wrapper.inventory.v1';
const backend = 'https://mise.example.workers.dev';

function recipe(
  id: string,
  title: string,
  names: string[],
  category: string,
  cuisine: string,
): Recipe {
  return {
    id,
    title,
    servings: 2,
    ingredients: names.map((name) => ({ name, quantity: 100, unit: 'g' })),
    steps: ['Synthetic browser fixture: prepare and cook the listed ingredients.'],
    category,
    cuisine,
    source: id.startsWith('manual:')
      ? { type: 'manual' }
      : id.startsWith('wikibooks:')
        ? { type: 'wikibooks', attribution: 'Synthetic cookbook fixture' }
        : { type: 'imported', name: 'Synthetic publisher fixture' },
  };
}

const saved = [
  recipe('manual:carrot-soup', 'My carrot soup', ['Carrots'], 'Soup', 'French'),
  recipe('imported:tomato-pasta', 'My tomato pasta', ['Tomatoes', 'Pasta'], 'Dinner', 'Italian'),
];
const bundled = [
  recipe('wikibooks:rice', 'A rice bowl', ['Rice'], 'Dinner', 'Japanese'),
  recipe('wikibooks:carrots', 'B carrot stew', ['Carrots'], 'Dinner', 'French'),
  recipe(
    'wikibooks:salad',
    'C three-bean salad',
    ['Beans', 'Celery', 'Onion'],
    'Salad',
    'American',
  ),
  recipe('wikibooks:tomatoes', 'D tomato soup', ['Tomatoes'], 'Soup', 'American'),
];
const inventory: InventoryState = {
  products: ['Carrots', 'Rice'].map((name) => ({
    id: name,
    name,
    ingredientName: name,
    isStaple: false,
  })),
  batches: ['Carrots', 'Rice'].map((name) => ({
    id: `${name}-batch`,
    productId: name,
    location: name === 'Rice' ? 'pantry' : 'fridge',
    quantity: 500,
    unit: 'g',
    purchasedOn: '2026-10-14',
    expiresOn: null,
  })),
  tools: [],
  recipes: saved,
};

function cards(page: Page) {
  return page.locator('.recipe-grid .recipe-card');
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(
    ({ inventoryKey, inventory, backend }) => {
      if (!localStorage.getItem(inventoryKey))
        localStorage.setItem(inventoryKey, JSON.stringify({ schemaVersion: 1, state: inventory }));
      localStorage.setItem(
        'mise.gemini.connection.v1',
        JSON.stringify({ url: backend, token: 'test_only_' + 'a'.repeat(40) }),
      );
    },
    { inventoryKey, inventory, backend },
  );
  await page.route('**/data/wikibooks-recipes.json', (route) =>
    route.fulfill({ json: { version: 1, recipes: bundled } }),
  );
  await page.route('https://www.themealdb.com/api/**', (route) =>
    route.fulfill({ json: { meals: null } }),
  );
  await page.goto('/');
  await page
    .getByRole('button', { name: 'Recipes', exact: true })
    .filter({ visible: true })
    .first()
    .click();
});

test('starts with saved recipes and keeps searching, filters, sorting, and reset in one grid', async ({
  page,
}, testInfo) => {
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Recipes');
  await expect(cards(page)).toHaveCount(2);
  await expect(page.getByRole('region', { name: 'Recipe starting points' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'For your kitchen', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Browse all', exact: true })).toHaveCount(0);
  await expect(page.getByRole('combobox', { name: 'Recipe collection', exact: true })).toHaveCount(
    0,
  );
  await page.screenshot({
    path: `/tmp/mise-recipes-simple-default-${testInfo.project.name}.png`,
    fullPage: false,
  });
  const drawer = await openRecipeFilters(page);
  await expect(drawer.getByRole('combobox', { name: 'Recipe collection', exact: true })).toHaveText(
    'Saved recipes',
  );
  await expect(drawer.getByRole('heading', { name: 'Availability', exact: true })).toHaveCount(0);
  await expect(drawer.getByRole('heading', { name: 'Your kitchen', exact: true })).toHaveCount(0);
  await expect(
    drawer.getByRole('heading', { name: 'Category & cuisine', exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: `/tmp/mise-recipes-simple-filters-${testInfo.project.name}.png`,
    fullPage: false,
  });
  await chooseRecipeFilter(page, 'Recipe collection', 'All recipes');
  await expect(cards(page)).toHaveCount(6);
  await chooseRecipeFilter(page, 'Recipe cuisine', 'Italian');
  await expect(cards(page)).toHaveCount(1);
  await expect(cards(page)).toContainText('My tomato pasta');
  await page.getByRole('button', { name: 'Remove Italian filter', exact: true }).click();
  await expect(cards(page)).toHaveCount(6);
  await chooseRecipeFilter(page, 'Recipe cuisine', 'French');
  await expect(cards(page)).toHaveCount(2);
  await chooseRecipeFilter(page, 'Recipe category', 'Soup');
  await expect(cards(page)).toHaveCount(1);
  await expect(cards(page)).toContainText('My carrot soup');
  const query = page.getByRole('textbox', { name: 'Find recipes', exact: true });
  await query.fill('carrot');
  await clearRecipeFilters(page);
  await expect(query).toHaveValue('carrot');
  await expect(cards(page)).toHaveCount(2);
  await query.fill('');
  await expect(cards(page)).toHaveCount(6);
  await chooseRecipeSort(page, 'Name');
  expect(await cards(page).locator('h3').allTextContents()).toEqual(
    [...saved, ...bundled].map((item) => item.title).sort((a, b) => a.localeCompare(b)),
  );
  await chooseRecipeSort(page, 'Most matches');
  await expect(cards(page).first()).toContainText('Ready to cook');
  await expect(cards(page).last()).toContainText('C three-bean salad');
  await expect(cards(page).last()).toContainText('0 matching ingredients · 3 short');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(
    await page.evaluate((key) => JSON.parse(localStorage.getItem(key)!).state, inventoryKey),
  ).toEqual(inventory);
});

test('keeps external search explicit and sorts or filters loaded recipes without searching again', async ({
  page,
}) => {
  const requests: { provider: string; query: string; page: number }[] = [];
  const remote = [
    recipe('recipeapi:rice', 'Z remote rice plate', ['Rice'], 'Dinner', 'Japanese'),
    recipe('recipeapi:pasta', 'A remote pasta plate', ['Pasta', 'Tomatoes'], 'Dinner', 'Italian'),
  ].map((item) => ({ ...item, source: { ...item.source, name: 'RecipeAPI.io' } }));
  await page.route(`${backend}/recipes/search`, async (route) => {
    requests.push(route.request().postDataJSON());
    await route.fulfill({
      json: {
        provider: 'recipeapi',
        storage: 'personal',
        recipes: remote,
        page: 1,
        hasMore: false,
        warnings: [],
      },
    });
  });
  await chooseRecipeFilter(page, 'Recipe source', 'RecipeAPI.io');
  await page.getByRole('textbox', { name: 'Find recipes', exact: true }).fill('dinner');
  expect(requests).toHaveLength(0);
  await page.getByRole('button', { name: 'Search RecipeAPI.io', exact: true }).click();
  await expect(cards(page)).toHaveCount(2);
  await chooseRecipeSort(page, 'Name');
  await expect(cards(page).first()).toContainText('A remote pasta plate');
  await chooseRecipeSort(page, 'Most matches');
  await expect(cards(page).first()).toContainText('Z remote rice plate');
  await chooseRecipeFilter(page, 'Recipe cuisine', 'Japanese');
  await expect(cards(page)).toHaveCount(1);
  await expect(cards(page)).toContainText('Z remote rice plate');
  await clearRecipeFilters(page);
  await expect(cards(page)).toHaveCount(2);
  const drawer = await openRecipeFilters(page);
  await expect(drawer.getByRole('combobox', { name: 'Recipe source', exact: true })).toHaveText(
    'RecipeAPI.io',
  );
  await closeRecipeFilters(page);
  expect(requests).toEqual([
    expect.objectContaining({ provider: 'recipeapi', query: 'dinner', page: 1 }),
  ]);
});
