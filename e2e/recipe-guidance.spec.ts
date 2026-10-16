import { readFile } from 'node:fs/promises';
import { expect, test, type Page } from '@playwright/test';
import type { AiChatRequest, AiExtractRequest } from '../src/ai/protocol';
import type { InventoryState } from '../src/domain/types';
import type { Recipe } from '../src/recipes/types';
import { chooseRecipeFilter } from './helpers/recipeFilters';

const inventoryKey = 'kitchen-wrapper.inventory.v1';
const recipeId = 'wikibooks:202116';
const recipeTitle = 'Southwestern Black Beans and Rice';
const starterIds = new Set([recipeId, 'wikibooks:385022', 'wikibooks:462082']);
const initialInventory: InventoryState = {
  products: [{ id: 'rice', name: 'Cooked rice', ingredientName: 'Cooked rice', isStaple: false }],
  batches: [
    {
      id: 'rice-batch',
      productId: 'rice',
      location: 'fridge',
      quantity: 1,
      unit: 'cup',
      purchasedOn: '2026-10-13',
      expiresOn: null,
    },
  ],
  tools: [],
};

async function navigate(page: Page, name: 'Recipes' | 'Gemini' | 'Shop') {
  const label = name === 'Shop' ? /^(Shop|Shopping list)$/ : new RegExp(`^${name}$`);
  await page.getByRole('button', { name: label }).filter({ visible: true }).first().click();
}

async function kitchen(page: Page): Promise<InventoryState> {
  return page.evaluate((key) => JSON.parse(localStorage.getItem(key)!).state, inventoryKey);
}

test.beforeEach(async ({ page }) => {
  const cookbook: { recipes: Recipe[] } = JSON.parse(
    await readFile('public/data/wikibooks-recipes.json', 'utf8'),
  );
  const recipes = cookbook.recipes.filter((recipe) => starterIds.has(recipe.id));
  expect(recipes).toHaveLength(3);
  await page.addInitScript(
    ({ key, state }) => {
      if (!localStorage.getItem(key))
        localStorage.setItem(key, JSON.stringify({ schemaVersion: 1, state }));
      localStorage.setItem(
        'mise.gemini.connection.v1',
        JSON.stringify({
          url: 'https://mise.example.workers.dev',
          token: `test_only_${'a'.repeat(40)}`,
        }),
      );
    },
    { key: inventoryKey, state: initialInventory },
  );
  await page.route('**/data/wikibooks-recipes.json', (route) =>
    route.fulfill({ json: { version: 1, recipes } }),
  );
  await page.route('https://www.themealdb.com/api/**', (route) =>
    route.fulfill({ json: { meals: null } }),
  );
  await page.route('https://mise.example.workers.dev/nutrition/status', (route) =>
    route.fulfill({ json: { provider: 'usda', configured: false } }),
  );
  await page.route('https://generativelanguage.googleapis.com/**', (route) => route.abort());
  await page.goto('/');
});

test('opens a sourced cookbook recipe offline, preserving its amounts and shopping shortages', async ({
  page,
}) => {
  await navigate(page, 'Recipes');
  await chooseRecipeFilter(page, 'Recipe collection', 'All recipes');
  await page.getByRole('textbox', { name: 'Find recipes', exact: true }).fill(recipeTitle);
  const cards = page.locator('.recipe-grid .recipe-card');
  await expect(cards).toHaveCount(1);
  if (['cover', 'unfolded'].includes(test.info().project.name))
    await page.screenshot({ path: `/tmp/mise-guidance-recipes-${test.info().project.name}.png` });
  await cards.getByRole('button', { name: 'View recipe', exact: true }).click();
  const detail = page.getByRole('dialog', { name: recipeTitle, exact: true });
  await expect(detail).toContainText('Original: 2 cups cooked rice');
  await expect(detail).toContainText('Original: 15 ounce can black beans, drained');
  await expect(detail).toContainText('Wikibooks contributors');
  await expect(
    detail.getByRole('link', { name: /Original recipe|Open source|Source recipe/ }),
  ).toHaveAttribute('href', /oldid=4525238/);
  await detail.getByRole('button', { name: 'Add to meal plan', exact: true }).click();
  await expect(page.locator('.toast')).toContainText('Added to your meal plan.');
  await detail.getByRole('button', { name: 'Close', exact: true }).click();
  await navigate(page, 'Shop');
  await page.getByRole('button', { name: 'Make shopping list', exact: true }).click();
  await expect.poll(async () => (await kitchen(page)).shoppingList?.length).toBe(4);
  const state = await kitchen(page);
  expect(state.recipes?.find((recipe) => recipe.id === recipeId)?.ingredients[0].quantity).toBe(2);
  expect(state.mealPlan).toEqual([{ recipeId, servings: 4 }]);
  expect(state.shoppingList?.find((item) => item.name === 'cooked rice')).toMatchObject({
    quantity: 1,
    unit: 'cup',
    status: 'missing',
  });
  expect(state.shoppingList?.find((item) => item.name === 'can black beans')).toMatchObject({
    quantity: 15,
    unit: 'oz',
    status: 'missing',
  });
  expect(state.batches).toEqual(initialInventory.batches);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
});

test('Gemini chooses candidate IDs and opens the original recipe without rewriting it', async ({
  page,
}) => {
  const requests: AiChatRequest[] = [];
  await page.route('https://mise.example.workers.dev/chat', async (route) => {
    const request = route.request().postDataJSON() as AiChatRequest;
    requests.push(request);
    await route.fulfill({
      json: {
        message:
          'Beans and rice is a familiar starting point. Would you like another protein alongside it?',
        recipes: [],
        warnings: [],
        recommendedRecipeIds: [recipeId],
      },
    });
  });
  await navigate(page, 'Gemini');
  await page.getByRole('button', { name: 'Conversation options', exact: true }).click();
  await page.getByRole('radio', { name: 'Choose from the cookbook', exact: true }).click();
  await page
    .getByRole('button', {
      name: 'Help me choose dinner',
      exact: true,
    })
    .click();
  await expect.poll(() => requests.length).toBe(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  const selected = requests[0].candidates?.find((candidate) => candidate.id === recipeId);
  expect(selected?.ingredients).toContain('2 cups cooked rice');
  expect(selected?.missingIngredients).toContain('can black beans');
  expect(selected?.source).toBe('https://en.wikibooks.org/w/index.php?oldid=4525238');
  expect(selected?.nutrition).toBeUndefined();
  await expect(page.locator('.chat-history')).toContainText('Would you like another protein');
  const card = page
    .locator('.ai-recipes .recipe-card')
    .filter({ has: page.getByRole('heading', { name: recipeTitle, exact: true }) });
  if (test.info().project.name === 'cover')
    await page.screenshot({ path: '/tmp/mise-guidance-assistant-cover.png', fullPage: true });
  await card.getByRole('button', { name: 'Choose recipe', exact: true }).click();
  const detail = page.getByRole('dialog', { name: recipeTitle, exact: true });
  await expect(detail).toContainText('Original: 2 cups cooked rice');
  await expect(detail).toContainText('Serve over hot rice.');
  await detail.getByRole('button', { name: 'Add to meal plan', exact: true }).click();
  await expect(page.locator('.toast')).toContainText('Added to your meal plan.');
  const saved = (await kitchen(page)).recipes?.find((recipe) => recipe.id === recipeId);
  expect(saved?.source.type).toBe('wikibooks');
  expect(saved?.source.url).toContain('oldid=4525238');
  expect(saved?.servings).toBe(4);
  expect(saved?.steps).toEqual([
    'In medium saucepan, combine beans, tomatoes and green chiles mix, and cumin.',
    'Heat through.',
    'Serve over hot rice.',
  ]);
});

test('one recommendation request waits for the cookbook to open before contacting Gemini', async ({
  page,
}) => {
  const cookbook: { recipes: Recipe[] } = JSON.parse(
    await readFile('public/data/wikibooks-recipes.json', 'utf8'),
  );
  const recipes = cookbook.recipes.filter((recipe) => starterIds.has(recipe.id));
  let releaseCollection = () => {};
  const collectionGate = new Promise<void>((resolve) => {
    releaseCollection = resolve;
  });
  let collectionRequests = 0;
  const requests: AiChatRequest[] = [];
  await page.route('**/data/wikibooks-recipes.json', async (route) => {
    collectionRequests += 1;
    await collectionGate;
    await route.fulfill({ json: { version: 1, recipes } });
  });
  await page.route('https://mise.example.workers.dev/chat', async (route) => {
    requests.push(route.request().postDataJSON() as AiChatRequest);
    await route.fulfill({
      json: {
        message: 'The cookbook is ready. Beans and rice is a familiar dinner.',
        recipes: [],
        warnings: [],
        recommendedRecipeIds: [recipeId],
      },
    });
  });
  try {
    await navigate(page, 'Gemini');
    await page.getByRole('button', { name: 'Conversation options', exact: true }).click();
    await page.getByRole('radio', { name: 'Choose from the cookbook', exact: true }).click();
    await expect.poll(() => collectionRequests).toBe(1);
    await page.getByRole('button', { name: 'Help me choose dinner', exact: true }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Gemini is thinking…' })).toBeVisible();
    expect(requests).toHaveLength(0);
    releaseCollection();
    await expect(page.locator('.chat-history')).toContainText('The cookbook is ready.');
    expect(requests).toHaveLength(1);
    expect(collectionRequests).toBe(1);
    expect(requests[0].candidates?.some((candidate) => candidate.id === recipeId)).toBe(true);
    await expect(page.locator('.ai-recipes .recipe-card')).toHaveCount(1);
    await expect(page.getByRole('heading', { name: recipeTitle, exact: true })).toBeVisible();
  } finally {
    releaseCollection();
  }
});

test('daily targets extracted from text or a report picture require review before persistence', async ({
  page,
}) => {
  const requests: AiExtractRequest[] = [];
  await page.route('https://mise.example.workers.dev/nutrition/extract', async (route) => {
    const request = route.request().postDataJSON() as AiExtractRequest;
    requests.push(request);
    await route.fulfill({
      json: {
        targets: request.media
          ? { caloriesKcal: 2100, proteinGrams: 120, carbsGrams: null, fatGrams: null }
          : { caloriesKcal: 1800, proteinGrams: 100, carbsGrams: 200, fatGrams: 60 },
        sourceText: 'Recommended daily targets from this test report.',
        warnings: ['Review these values before saving.'],
      },
    });
  });
  await navigate(page, 'Gemini');
  await page.getByRole('button', { name: 'Your profile', exact: true }).click();
  await page.getByRole('button', { name: 'Set targets', exact: true }).click();
  let editor = page.getByRole('dialog', { name: 'Your daily nutrition targets', exact: true });
  await editor.getByText('Read targets from text or a report picture', { exact: true }).click();
  await editor
    .getByLabel('Recommended targets or report text')
    .fill('My recommended daily targets: 1800 kcal, 100 g protein, 200 g carbs, 60 g fat.');
  await editor.getByRole('button', { name: 'Extract for review', exact: true }).click();
  await expect(editor.getByRole('spinbutton', { name: /^Calories per day/ })).toHaveValue('1800');
  if (['cover', 'unfolded'].includes(test.info().project.name))
    await page.screenshot({ path: `/tmp/mise-guidance-targets-${test.info().project.name}.png` });
  expect((await kitchen(page)).nutritionTargets).toBeUndefined();
  await editor.getByRole('spinbutton', { name: /^Protein per day/ }).fill('110');
  await editor.getByRole('button', { name: 'Save reviewed targets', exact: true }).click();
  await expect(editor).not.toBeVisible();
  expect((await kitchen(page)).nutritionTargets).toMatchObject({
    caloriesKcal: 1800,
    proteinGrams: 110,
  });
  await page.reload();
  await navigate(page, 'Gemini');
  await expect(page.locator('.nutrition-summary')).toContainText('110 g protein');
  await page.getByRole('button', { name: 'Your profile', exact: true }).click();
  await page.getByRole('button', { name: 'Edit targets', exact: true }).click();
  editor = page.getByRole('dialog', { name: 'Your daily nutrition targets', exact: true });
  await expect(editor).toBeVisible();
  if (['cover', 'unfolded'].includes(test.info().project.name))
    await page.screenshot({
      path: `/tmp/mise-guidance-targets-collapsed-${test.info().project.name}.png`,
    });
  await editor.getByText('Read targets from text or a report picture', { exact: true }).click();
  await editor.getByLabel(/^Report picture/).setInputFiles({
    name: 'report.png',
    mimeType: 'image/png',
    buffer: Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a+ksAAAAASUVORK5CYII=',
      'base64',
    ),
  });
  await editor.getByRole('button', { name: 'Extract for review', exact: true }).click();
  await expect(editor.getByRole('spinbutton', { name: /^Calories per day/ })).toHaveValue('2100');
  expect(requests[1].media?.mimeType).toBe('image/png');
  expect(requests[1].media?.data).toBeTruthy();
  expect((await kitchen(page)).nutritionTargets).toMatchObject({
    caloriesKcal: 1800,
    proteinGrams: 110,
  });
  await editor.getByRole('button', { name: 'Close', exact: true }).click();
  await page.getByRole('button', { name: 'Edit targets', exact: true }).click();
  await expect(editor.getByRole('spinbutton', { name: /^Calories per day/ })).toHaveValue('1800');
  await expect(editor.getByRole('spinbutton', { name: /^Protein per day/ })).toHaveValue('110');
  expect((await kitchen(page)).nutritionTargets).not.toHaveProperty('sourceText');
});
