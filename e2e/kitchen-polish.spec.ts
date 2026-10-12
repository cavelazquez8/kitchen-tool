import { expect, test, type Page } from '@playwright/test';
import type { InventoryState } from '../src/domain/types';
import type { Recipe } from '../src/recipes/types';

const key = 'kitchen-wrapper.inventory.v1';
const soup: Recipe = {
  id: 'manual:soup',
  title: 'Personal carrot soup',
  servings: 2,
  ingredients: [{ name: 'Carrots', quantity: 200, unit: 'g' }],
  steps: ['Test-only: simmer the carrots.'],
  source: { type: 'manual' },
};
const rice: Recipe = {
  id: 'wikibooks:rice',
  title: 'Cookbook rice',
  servings: 2,
  ingredients: [{ name: 'Rice', quantity: 100, unit: 'g' }],
  steps: ['Test-only: simmer the rice.'],
  source: { type: 'wikibooks' },
};
const inventory: InventoryState = {
  products: [{ id: 'rice', name: 'Rice', isStaple: false, ingredientName: 'Rice' }],
  batches: [
    {
      id: 'rice-batch',
      productId: 'rice',
      location: 'pantry',
      quantity: 500,
      unit: 'g',
      purchasedOn: '2026-01-01',
      expiresOn: null,
    },
  ],
  tools: [],
  recipes: [soup, rice],
  mealPlan: [{ recipeId: rice.id, servings: 2 }],
  shoppingList: [
    {
      id: 'shopping:1',
      name: 'Carrots',
      quantity: 200,
      unit: 'g',
      status: 'missing',
      checked: false,
    },
    {
      id: 'shopping:2',
      name: 'Milk',
      quantity: 1,
      unit: 'bottle',
      status: 'missing',
      checked: true,
    },
  ],
};
async function navigate(page: Page, name: 'Recipes' | 'Gemini' | 'Shop') {
  const label = name === 'Shop' ? /^(Shop|Shopping list)$/ : new RegExp(`^${name}$`);
  await page.getByRole('button', { name: label }).filter({ visible: true }).first().click();
}
test.beforeEach(async ({ page }) => {
  await page.addInitScript(
    ({ inventoryKey, state }) => {
      if (!localStorage.getItem(inventoryKey))
        localStorage.setItem(inventoryKey, JSON.stringify({ schemaVersion: 1, state }));
      localStorage.setItem(
        'mise.gemini.connection.v1',
        JSON.stringify({
          url: 'https://mise.example.workers.dev',
          token: 'test_only_' + 'a'.repeat(40),
        }),
      );
    },
    { inventoryKey: key, state: inventory },
  );
  await page.route('**/data/wikibooks-recipes.json', (route) =>
    route.fulfill({ json: { version: 1, recipes: [rice] } }),
  );
  await page.route('https://www.themealdb.com/api/**', (route) =>
    route.fulfill({ json: { meals: null } }),
  );
  await page.goto('/');
});

test('clears all shopping items after review and retains the meal plan and inventory', async ({
  page,
}) => {
  await navigate(page, 'Shop');
  await expect(page.locator('.quick-foods')).toHaveCount(0);
  await expect(page.getByRole('combobox', { name: 'Quick-add ingredient' })).toBeVisible();
  await page.getByRole('button', { name: 'Clear all', exact: true }).click();
  const review = page.getByRole('dialog', { name: 'Clear shopping list?' });
  await review.getByRole('button', { name: 'Keep list' }).click();
  await expect(page.locator('.shopping-row')).toHaveCount(2);
  await page.getByRole('button', { name: 'Clear all', exact: true }).click();
  await review.getByRole('button', { name: 'Clear all items' }).click();
  await expect(page.locator('.shopping-row')).toHaveCount(0);
  const state = await page.evaluate(
    (inventoryKey) => JSON.parse(localStorage.getItem(inventoryKey)!).state,
    key,
  );
  expect(state).toEqual({ ...inventory, shoppingList: [] });
  await page.reload();
  await navigate(page, 'Shop');
  await expect(page.locator('.shopping-row')).toHaveCount(0);
});

test('removes a saved cookbook recipe while retaining its source in the cookbook', async ({
  page,
}) => {
  await navigate(page, 'Recipes');
  await page.getByRole('button', { name: 'Saved recipes', exact: true }).click();
  await page.getByRole('button', { name: `Remove ${rice.title} from saved recipes` }).click();
  const review = page.getByRole('dialog', { name: `Remove “${rice.title}” from saved recipes?` });
  await review.getByRole('button', { name: 'Remove recipe', exact: true }).click();
  await expect(page.getByRole('heading', { name: rice.title, exact: true })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: soup.title, exact: true })).toBeVisible();
  const state = await page.evaluate(
    (inventoryKey) => JSON.parse(localStorage.getItem(inventoryKey)!).state,
    key,
  );
  expect(state.recipes).toEqual([soup]);
  expect(state.mealPlan).toEqual([]);
  await page.getByRole('button', { name: 'All recipes', exact: true }).click();
  await expect(page.getByRole('heading', { name: rice.title, exact: true })).toBeVisible();
});

test('attaches several recipes to Gemini, sends both, then removes one from later messages', async ({
  page,
}) => {
  const requests: { recipe?: string }[] = [];
  await page.route('https://mise.example.workers.dev/chat', async (route) => {
    requests.push(route.request().postDataJSON());
    await route.fulfill({
      json: { message: 'Test-only reply to the attached recipes.', recipes: [], warnings: [] },
    });
  });
  await navigate(page, 'Recipes');
  for (const recipe of [soup, rice]) {
    const card = page
      .locator('.recipe-card')
      .filter({ has: page.getByRole('heading', { name: recipe.title, exact: true }) });
    await card.getByRole('button', { name: 'Add to Gemini', exact: true }).click();
    await expect(card.getByRole('button', { name: 'Added to Gemini', exact: true })).toBeDisabled();
  }
  await navigate(page, 'Gemini');
  const context = page.getByRole('region', { name: 'Gemini recipe context' });
  await expect(context).toContainText(soup.title);
  await expect(context).toContainText(rice.title);
  const message = page.getByRole('textbox', { name: 'Message Gemini' });
  await message.fill('Compare these recipes.');
  await page.getByRole('button', { name: 'Ask Gemini', exact: true }).click();
  await expect.poll(() => requests.length).toBe(1);
  expect(requests[0].recipe).toContain(soup.title);
  expect(requests[0].recipe).toContain('200 g: Carrots');
  expect(requests[0].recipe).toContain(rice.title);
  await context.getByRole('button', { name: `Remove ${soup.title} from Gemini context` }).click();
  await expect(context).not.toContainText(soup.title);
  await message.fill('Help with the remaining recipe.');
  await page.getByRole('button', { name: 'Ask Gemini', exact: true }).click();
  await expect.poll(() => requests.length).toBe(2);
  expect(requests[1].recipe).not.toContain(soup.title);
  expect(requests[1].recipe).toContain(rice.title);
  const state = await page.evaluate(
    (inventoryKey) => JSON.parse(localStorage.getItem(inventoryKey)!).state,
    key,
  );
  expect(state.recipes).toEqual(inventory.recipes);
  expect(state.batches).toEqual(inventory.batches);
});
