import { readFile } from 'node:fs/promises';
import { expect, test, type Page } from '@playwright/test';
import type { Recipe } from '../src/recipes/types';

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

test('shuffles everyday dishes and the whole cookbook without changing kitchen data', async ({
  page,
}) => {
  await recipesPage(page);
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

test('verifies USDA through one live lookup and leaves nutrition matches unconfirmed', async ({
  page,
}) => {
  let searches = 0;
  await page.route(`${backend}/nutrition/status`, (route) =>
    route.fulfill({ json: { provider: 'usda', configured: true } }),
  );
  await page.route(`${backend}/nutrition/search`, (route) => {
    searches++;
    expect(route.request().postDataJSON()).toEqual({ query: 'Carrots' });
    return route.fulfill({
      json: {
        query: 'Carrots',
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
  await page
    .getByRole('region', { name: 'Recipe starting points' })
    .getByRole('button', { name: /Southwestern Black Beans and Rice/ })
    .click();
  const detail = page.getByRole('dialog', {
    name: 'Southwestern Black Beans and Rice',
    exact: true,
  });
  const nutrition = detail.getByRole('region', { name: 'Recipe nutrition' });
  await nutrition.getByRole('button', { name: 'Estimate with USDA' }).click();
  await expect(nutrition).toContainText('USDA key configured. Live access has not been verified.');
  expect(searches).toBe(0);
  await nutrition.getByRole('button', { name: 'Test USDA lookup' }).click();
  await expect(nutrition).toContainText('Live USDA access verified.');
  await expect(nutrition).toContainText('1 food returned for “Carrots”');
  expect(searches).toBe(1);
  const state = await page.evaluate((key) => JSON.parse(localStorage.getItem(key)!).state, key);
  expect(state.recipeNutrition).toBeUndefined();
  expect(state.recipes).toBeUndefined();
  await expect(nutrition).toContainText(
    `0 of ${fixtures.find((recipe) => recipe.id === 'wikibooks:202116')!.ingredients.length} ingredients reviewed`,
  );
  if (test.info().project.name === 'cover')
    await page.screenshot({ path: '/tmp/mise-usda-verified-cover.png' });
});
