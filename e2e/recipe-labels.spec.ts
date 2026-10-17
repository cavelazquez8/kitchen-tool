import { expect, test } from '@playwright/test';
import type { InventoryState } from '../src/domain/types';
import type { Recipe } from '../src/recipes/types';
import { chooseRecipeFilter, openRecipeFilters } from './helpers/recipeFilters';

const key = 'kitchen-wrapper.inventory.v1';
const recipe: Recipe = {
  id: 'wikibooks:synthetic-label-fixture',
  title: 'Carrot supper fixture',
  servings: 2,
  category: 'Source category',
  cuisine: 'Source cuisine',
  ingredients: [{ name: 'Carrots', quantity: 200, unit: 'g' }],
  steps: ['Synthetic test recipe: cook the carrots.'],
  source: {
    type: 'wikibooks',
    name: 'Wikibooks Cookbook',
    attribution: 'Synthetic attribution fixture',
    license: 'CC BY-SA 4.0',
    url: 'https://example.com/original',
  },
};
const inventory: InventoryState = { products: [], batches: [], tools: [], recipes: [recipe] };

test('edits category and cuisine, retains personal overrides and attribution, and allows clearing labels', async ({
  page,
}, testInfo) => {
  await page.addInitScript(
    ({ key, inventory }) => {
      if (!localStorage.getItem(key))
        localStorage.setItem(key, JSON.stringify({ schemaVersion: 1, state: inventory }));
    },
    { key, inventory },
  );
  await page.route('**/data/wikibooks-recipes.json', (route) =>
    route.fulfill({ json: { version: 1, recipes: [recipe] } }),
  );
  await page.route('https://www.themealdb.com/api/**', (route) =>
    route.fulfill({ json: { meals: null } }),
  );
  const navigate = async () => {
    await page
      .getByRole('button', { name: 'Recipes', exact: true })
      .filter({ visible: true })
      .first()
      .click();
  };
  const openEditor = async () => {
    await page.getByRole('button', { name: 'View recipe', exact: true }).click();
    await page.getByRole('button', { name: 'Edit & save', exact: true }).click();
    return page.getByRole('dialog', { name: 'Review your recipe', exact: true });
  };
  await page.goto('/');
  await navigate();
  let editor = await openEditor();
  await expect(editor.getByRole('textbox', { name: 'Category', exact: true })).toHaveValue(
    'Source category',
  );
  await editor.getByRole('textbox', { name: 'Category', exact: true }).fill('  Meal prep  ');
  await editor.getByRole('textbox', { name: 'Cuisine', exact: true }).fill('  Mexican  ');
  await page.screenshot({ path: `/tmp/mise-recipe-labels-${testInfo.project.name}.png` });
  await editor.getByRole('button', { name: 'Save recipe', exact: true }).click();
  await expect(editor).not.toBeVisible();
  await chooseRecipeFilter(page, 'Recipe category', 'Meal prep');
  await chooseRecipeFilter(page, 'Recipe cuisine', 'Mexican');
  await expect(page.locator('.recipe-grid .recipe-card')).toHaveCount(1);
  await page.reload();
  await navigate();
  await chooseRecipeFilter(page, 'Recipe collection', 'All recipes');
  await page.getByRole('button', { name: 'View recipe', exact: true }).click();
  const detail = page.getByRole('dialog', { name: recipe.title, exact: true });
  await expect(detail.locator('.recipe-label-summary')).toContainText('Meal prep');
  await expect(detail.locator('.recipe-label-summary')).toContainText('Mexican');
  await page.getByRole('button', { name: 'Edit & save', exact: true }).click();
  editor = page.getByRole('dialog', { name: 'Review your recipe', exact: true });
  await expect(editor.getByRole('textbox', { name: 'Category', exact: true })).toHaveValue(
    'Meal prep',
  );
  await expect(editor.getByRole('textbox', { name: 'Cuisine', exact: true })).toHaveValue(
    'Mexican',
  );
  const stored = await page.evaluate(
    (key) => JSON.parse(localStorage.getItem(key)!).state as InventoryState,
    key,
  );
  expect(stored.recipes?.[0]).toEqual({ ...recipe, category: 'Meal prep', cuisine: 'Mexican' });
  await editor.getByRole('textbox', { name: 'Category', exact: true }).fill('');
  await editor.getByRole('textbox', { name: 'Cuisine', exact: true }).fill('');
  await editor.getByRole('button', { name: 'Save recipe', exact: true }).click();
  await expect(editor).not.toBeVisible();
  const drawer = await openRecipeFilters(page);
  await drawer.getByRole('combobox', { name: 'Recipe category', exact: true }).click();
  await expect(page.getByRole('option')).toHaveCount(1);
  await expect(page.getByRole('option')).toHaveText('Every category');
  const cleared = await page.evaluate(
    (key) => JSON.parse(localStorage.getItem(key)!).state as InventoryState,
    key,
  );
  expect(cleared.recipes?.[0].category).toBeUndefined();
  expect(cleared.recipes?.[0].cuisine).toBeUndefined();
  expect(cleared.recipes?.[0].source).toEqual(recipe.source);
});
