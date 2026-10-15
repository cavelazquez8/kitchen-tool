import { readFile } from 'node:fs/promises';
import { expect, test, type Page } from '@playwright/test';
import type { Recipe } from '../src/recipes/types';
import { recipeNutritionKey } from '../src/nutrition/estimate';

const key = 'kitchen-wrapper.inventory.v1';
const backend = 'https://mise.example.workers.dev';
let fixtures: Recipe[];
async function recipesPage(page: Page) {
  await page
    .getByRole('button', { name: /^Recipes$/ })
    .filter({ visible: true })
    .first()
    .click();
}
test.beforeEach(async ({ page }) => {
  const collection: { recipes: Recipe[] } = JSON.parse(
    await readFile('public/data/wikibooks-recipes.json', 'utf8'),
  );
  fixtures = ['wikibooks:111890', 'wikibooks:462082', 'wikibooks:202116', 'wikibooks:22971'].map(
    (id) => collection.recipes.find((recipe) => recipe.id === id)!,
  );
  expect(fixtures.every(Boolean)).toBe(true);
  await page.addInitScript(
    ({ key, backend }) => {
      localStorage.setItem(
        key,
        JSON.stringify({ schemaVersion: 1, state: { products: [], batches: [], tools: [] } }),
      );
      localStorage.setItem(
        'mise.gemini.connection.v1',
        JSON.stringify({ url: backend, token: 'test_only_' + 'a'.repeat(40) }),
      );
      Math.random = () => 0;
    },
    { key, backend },
  );
  await page.route('**/data/wikibooks-recipes.json', (route) =>
    route.fulfill({ json: { version: 1, recipes: fixtures } }),
  );
  await page.goto('/');
});

test('shows reviewed whole-recipe nutrition when the source yield is missing', async ({ page }) => {
  const recipe: Recipe = {
    id: 'imported:nutrition-display-fixture',
    title: 'Synthetic nutrition display fixture',
    servings: null,
    ingredients: [{ name: 'Carrots', quantity: 180, unit: 'g' }],
    steps: ['Synthetic fixture only.'],
    source: { type: 'imported' },
  };
  await page.addInitScript(
    ({ key, recipe, recipeKey }) => {
      const state = {
        products: [],
        batches: [],
        tools: [],
        recipes: [recipe],
        recipeNutrition: [
          {
            recipeId: recipe.id,
            recipeKey,
            ingredients: [
              {
                ingredientIndex: 0,
                grams: 180,
                confirmed: true,
                food: {
                  fdcId: 123,
                  description: 'Synthetic fixture carrots',
                  dataType: 'Foundation',
                  sourceUrl: 'https://fdc.nal.usda.gov/food-details/123/nutrients',
                  per100g: { caloriesKcal: 40, proteinGrams: 1, carbsGrams: 9, fatGrams: 0 },
                  portions: [],
                },
              },
            ],
          },
        ],
      };
      localStorage.setItem(key, JSON.stringify({ schemaVersion: 1, state }));
    },
    { key, recipe, recipeKey: recipeNutritionKey(recipe) },
  );
  await page.reload();
  await recipesPage(page);
  await page.getByRole('button', { name: 'Imported recipes', exact: true }).click();
  await page
    .locator('.recipe-card')
    .filter({ hasText: recipe.title })
    .getByRole('button', { name: 'View recipe', exact: true })
    .click();
  const panel = page.getByRole('region', { name: 'Recipe nutrition' });
  await page.getByText('Review nutrition and portion estimates', { exact: true }).click();
  await expect(panel.getByText('72 kcal', { exact: true })).toBeVisible();
  await expect(panel.getByText('1.8 g', { exact: true })).toBeVisible();
  await expect(panel.getByRole('button', { name: 'Per serving', exact: true })).toBeDisabled();
  await expect(panel).toContainText('All nutrients available');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  if (['cover', 'unfolded'].includes(test.info().project.name))
    await panel.screenshot({ path: `/tmp/mise-nutrition-totals-${test.info().project.name}.png` });
});

test('shuffles everyday dishes and the whole cookbook without changing kitchen data', async ({
  page,
}) => {
  await recipesPage(page);
  await page.getByText('Explore the community cookbook', { exact: true }).click();
  const panel = page.getByRole('region', { name: 'Recipe starting points' });
  const cards = panel.locator('.starter-recipe strong');
  await expect(cards).toHaveCount(3);
  const initial = await cards.allTextContents();
  await panel.getByRole('button', { name: 'Shuffle suggestions' }).click();
  await expect(panel.getByRole('status')).toContainText('Random picks from 3 everyday recipes');
  expect(await cards.allTextContents()).not.toEqual(initial);
  await panel.getByRole('button', { name: 'Use inventory order' }).click();
  expect(await cards.allTextContents()).toEqual(initial);
  await panel.getByRole('button', { name: 'Whole cookbook' }).click();
  await expect(panel.getByRole('status')).toContainText('Random picks from 4 cookbook recipes');
  await panel.getByRole('button', { name: 'Show more suggestions' }).click();
  await expect(cards).toHaveCount(4);
  await panel.getByRole('button', { name: /Spaghetti alla Carbonara/ }).click();
  const detail = page.getByRole('dialog', { name: 'Spaghetti alla Carbonara', exact: true });
  await expect(detail).toContainText('Wikibooks contributors');
  await detail.getByRole('button', { name: 'Close', exact: true }).click();
  await panel.getByRole('button', { name: 'Everyday picks' }).click();
  await expect(cards).toHaveCount(3);
  expect(await page.evaluate((key) => JSON.parse(localStorage.getItem(key)!).state, key)).toEqual({
    products: [],
    batches: [],
    tools: [],
  });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  if (test.info().project.name === 'cover')
    await page.screenshot({ path: '/tmp/mise-shuffle-cover.png', fullPage: true });
});

test('reviews real ingredients through USDA without diagnostic tests or auto-confirming foods', async ({
  page,
}) => {
  let searches = 0;
  await page.route(`${backend}/nutrition/status`, (route) =>
    route.fulfill({ json: { provider: 'usda', configured: true } }),
  );
  await page.route(`${backend}/nutrition/search`, (route) => {
    searches++;
    expect(route.request().postDataJSON().query).toBeTruthy();
    return route.fulfill({
      json: {
        query: route.request().postDataJSON().query,
        rejectedCount: 0,
        foods: [
          {
            fdcId: 123,
            description: 'Synthetic fixture carrots',
            dataType: 'Foundation',
            sourceUrl: 'https://fdc.nal.usda.gov/food-details/123/nutrients',
            per100g: { caloriesKcal: 40, proteinGrams: 1, carbsGrams: 9, fatGrams: 0 },
            portions: [],
          },
        ],
      },
    });
  });
  await recipesPage(page);
  await page.getByText('Explore the community cookbook', { exact: true }).click();
  await page
    .getByRole('region', { name: 'Recipe starting points' })
    .getByRole('button', { name: /Southwestern Black Beans and Rice/ })
    .click();
  const detail = page.getByRole('dialog', {
    name: 'Southwestern Black Beans and Rice',
    exact: true,
  });
  const nutrition = detail.getByRole('region', { name: 'Recipe nutrition' });
  await detail.getByText('Review nutrition and portion estimates', { exact: true }).click();
  await nutrition.getByRole('button', { name: 'Estimate with USDA' }).click();
  expect(searches).toBe(0);
  await expect(nutrition.getByRole('button', { name: 'Test USDA lookup' })).toHaveCount(0);
  await nutrition.getByRole('button', { name: 'Match food', exact: true }).first().click();
  await nutrition.getByRole('button', { name: 'Search USDA', exact: true }).click();
  await expect(nutrition.getByRole('button', { name: /Synthetic fixture carrots/ })).toBeVisible();
  expect(searches).toBe(1);
  const state = await page.evaluate((key) => JSON.parse(localStorage.getItem(key)!).state, key);
  expect(state.recipeNutrition).toBeUndefined();
  expect(state.recipes).toBeUndefined();
  await expect(nutrition).toContainText(
    'Match ingredients to USDA foods to see calories and macros.',
  );
  if (test.info().project.name === 'cover')
    await page.screenshot({ path: '/tmp/mise-usda-verified-cover.png' });
});
