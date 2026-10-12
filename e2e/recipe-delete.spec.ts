import { expect, test, type Page } from '@playwright/test';
import type { InventoryState } from '../src/domain/types';
import type { Recipe } from '../src/recipes/types';

const inventoryKey = 'kitchen-wrapper.inventory.v1';
const importedRecipe: Recipe = {
  id: 'imported:delete-fixture',
  title: 'Test-only imported rice bowl',
  servings: 2,
  ingredients: [{ name: 'Rice', quantity: 100, unit: 'g' }],
  steps: ['Test fixture: cook and serve the rice.'],
  source: { type: 'imported', url: 'https://example.com/test-only-imported-rice' },
};
const keptRecipe: Recipe = {
  ...importedRecipe,
  id: 'manual:keep-fixture',
  title: 'Test-only saved rice soup',
  source: { type: 'manual' },
};
const inventory: InventoryState = {
  products: [{ id: 'test-rice', name: 'Rice', ingredientName: 'Rice', isStaple: false }],
  batches: [
    {
      id: 'test-rice-batch',
      productId: 'test-rice',
      location: 'pantry',
      quantity: 500,
      unit: 'g',
      purchasedOn: '2026-01-01',
      expiresOn: null,
    },
  ],
  tools: [],
  recipes: [importedRecipe, keptRecipe],
  mealPlan: [
    { recipeId: importedRecipe.id, servings: 4 },
    { recipeId: keptRecipe.id, servings: 2 },
  ],
  shoppingList: [
    {
      id: 'manual-shopping-fixture',
      name: 'Dish soap',
      quantity: 1,
      unit: 'each',
      checked: false,
      status: 'missing',
      note: 'Test-only manually added shopping item',
    },
  ],
};

async function navigateRecipes(page: Page) {
  await page
    .getByRole('button', { name: 'Recipes', exact: true })
    .filter({ visible: true })
    .first()
    .click();
}

async function storedInventory(page: Page): Promise<InventoryState> {
  return page.evaluate((key) => JSON.parse(localStorage.getItem(key)!).state, inventoryKey);
}

test('cancels or confirms deleting an imported recipe, preserving unrelated kitchen data across reload', async ({
  page,
}) => {
  await page.addInitScript(
    ({ key, state }) => {
      // A reload must read the user's updated data instead of restoring this fixture.
      if (!localStorage.getItem(key)) {
        localStorage.setItem(key, JSON.stringify({ schemaVersion: 1, state }));
      }
    },
    { key: inventoryKey, state: inventory },
  );
  await page.route('**/data/wikibooks-recipes.json', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        version: 1,
        recipes: [
          {
            ...keptRecipe,
            id: 'wikibooks:delete-fixture',
            title: 'Test-only cookbook rice',
            source: { type: 'wikibooks', attribution: 'Wikibooks test fixture' },
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
  await page.goto('/');
  await navigateRecipes(page);
  await page.getByRole('button', { name: 'Imported recipes', exact: true }).click();
  const importedCard = page.locator('.recipe-card').filter({ hasText: importedRecipe.title });
  await expect(importedCard).toBeVisible();
  await importedCard.getByRole('button', { name: 'View recipe', exact: true }).click();
  const detail = page.getByRole('dialog', { name: importedRecipe.title, exact: true });
  await detail.getByRole('button', { name: 'Delete recipe', exact: true }).click();
  const confirmation = page.getByRole('dialog', { name: /^Delete / });
  await expect(confirmation).toHaveAccessibleName(`Delete “${importedRecipe.title}”?`);
  await confirmation.getByRole('button', { name: 'Keep recipe', exact: true }).click();
  await expect(confirmation).not.toBeVisible();
  await expect(detail).toBeVisible();
  expect(await storedInventory(page)).toEqual(inventory);

  await detail.getByRole('button', { name: 'Delete recipe', exact: true }).click();
  await expect(confirmation).toBeVisible();
  await confirmation.getByRole('button', { name: 'Delete recipe', exact: true }).click();
  await expect(confirmation).not.toBeVisible();
  await expect(detail).not.toBeVisible();
  await expect(importedCard).toHaveCount(0);
  const afterDelete = await storedInventory(page);
  expect(afterDelete.recipes).toEqual([keptRecipe]);
  expect(afterDelete.mealPlan).toEqual([{ recipeId: keptRecipe.id, servings: 2 }]);
  expect(afterDelete.shoppingList).toEqual(inventory.shoppingList);
  expect(afterDelete.products).toEqual(inventory.products);
  expect(afterDelete.batches).toEqual(inventory.batches);

  await page.reload();
  await navigateRecipes(page);
  await page.getByRole('button', { name: 'Imported recipes', exact: true }).click();
  await expect(page.locator('.recipe-card')).toHaveCount(0);
  await page.getByRole('button', { name: 'Saved recipes', exact: true }).click();
  await expect(page.getByRole('heading', { name: keptRecipe.title, exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: importedRecipe.title, exact: true })).toHaveCount(
    0,
  );
  expect(await storedInventory(page)).toEqual(afterDelete);
});
