import { expect, test, type Page } from '@playwright/test';
import type { AiChatRequest } from '../src/ai/protocol';
import type { InventoryState } from '../src/domain/types';
import type { Recipe } from '../src/recipes/types';

const inventoryKey = 'kitchen-wrapper.inventory.v1';
const backend = 'https://mise.example.workers.dev';
const inventory: InventoryState = {
  products: [
    {
      id: 'chicken',
      name: 'Store brand chicken breast',
      ingredientName: 'Chicken breast',
      isStaple: false,
    },
    { id: 'rice', name: 'Long grain rice', ingredientName: 'Rice', isStaple: false },
  ],
  batches: [
    {
      id: 'chicken-batch',
      productId: 'chicken',
      location: 'freezer',
      quantity: 400,
      unit: 'g',
      purchasedOn: '2026-10-13',
      expiresOn: null,
    },
    {
      id: 'rice-batch',
      productId: 'rice',
      location: 'pantry',
      quantity: 1,
      unit: 'cup',
      purchasedOn: '2026-10-13',
      expiresOn: null,
    },
  ],
  tools: [{ id: 'pan', name: 'Frying pan' }],
};
// Synthetic publisher fixture: the browser test never fetches or copies a real publisher's content.
const publisherRecipe: Recipe = {
  id: 'publisher:test-chicken-rice',
  title: 'Chicken and rice meal prep',
  servings: 4,
  ingredients: [
    { name: 'Chicken breast', quantity: 600, unit: 'g', original: '600 g chicken breast' },
    { name: 'Rice', quantity: 2, unit: 'cup', original: '2 cups rice' },
    { name: 'Broccoli', quantity: 300, unit: 'g', original: '300 g broccoli' },
  ],
  steps: [
    'Follow the original publisher instructions to cook the chicken safely.',
    'Cook the rice and broccoli, then divide into four portions.',
  ],
  source: {
    type: 'imported',
    name: 'Example recipe publisher',
    url: 'https://recipes.example.com/chicken-rice',
    attribution: 'Example Author · Example recipe publisher',
  },
  author: 'Example Author',
  imageUrl: 'https://recipes.example.com/chicken-rice-photo.jpg',
  prepMinutes: 10,
  cookMinutes: 25,
  totalMinutes: 35,
  rating: { value: 4.8, best: 5, count: 120 },
  publisherNutrition: {
    servingSize: '1 serving',
    calories: '510 kcal',
    protein: '38 g',
    carbohydrates: '52 g',
    fat: '14 g',
  },
};

async function navigate(page: Page, name: 'Gemini' | 'Recipes' | 'Inventory' | 'Shopping list') {
  const label = name === 'Shopping list' ? /^(Shop|Shopping list)$/ : new RegExp(`^${name}$`);
  await page.getByRole('button', { name: label }).filter({ visible: true }).first().click();
}

async function storedKitchen(page: Page): Promise<InventoryState> {
  return page.evaluate((key) => JSON.parse(localStorage.getItem(key)!).state, inventoryKey);
}

async function sendMessage(page: Page, message: string) {
  await page.getByRole('textbox', { name: 'Message Gemini', exact: true }).fill(message);
  await page.getByRole('button', { name: 'Ask Gemini', exact: true }).click();
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(
    ({ inventoryKey, inventory, backend }) => {
      if (!localStorage.getItem(inventoryKey))
        localStorage.setItem(inventoryKey, JSON.stringify({ schemaVersion: 1, state: inventory }));
      if (!localStorage.getItem('mise.gemini.connection.v1'))
        localStorage.setItem(
          'mise.gemini.connection.v1',
          JSON.stringify({ url: backend, token: 'test_only_' + 'a'.repeat(40) }),
        );
    },
    { inventoryKey, inventory, backend },
  );
  await page.route('**/data/wikibooks-recipes.json', (route) =>
    route.fulfill({ json: { version: 1, recipes: [] } }),
  );
  await page.route('https://www.themealdb.com/api/**', (route) =>
    route.fulfill({ json: { meals: null } }),
  );
  await page.route(`${backend}/health**`, (route) =>
    route.fulfill({
      json: {
        ok: true,
        model: 'gemini-3.5-flash-lite',
        supportsRecipeDiscovery: true,
        recipeDiscoveryConfigured: true,
      },
    }),
  );
  await page.route(`${backend}/nutrition/status`, (route) =>
    route.fulfill({ json: { provider: 'usda', configured: false } }),
  );
  await page.route(publisherRecipe.imageUrl!, (route) =>
    route.fulfill({
      contentType: 'image/svg+xml',
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="720" height="440" viewBox="0 0 720 440"><defs><radialGradient id="bg"><stop stop-color="#45533a"/><stop offset="1" stop-color="#18251d"/></radialGradient></defs><rect width="720" height="440" fill="url(#bg)"/><ellipse cx="360" cy="228" rx="222" ry="171" fill="#d4d7cd"/><ellipse cx="360" cy="228" rx="195" ry="148" fill="#ecebdf"/><ellipse cx="310" cy="242" rx="115" ry="100" fill="#dbc98b"/><path d="M310 130q130-20 155 85t-120 90q-100-55-35-175" fill="#ba7745"/><g fill="#477847"><circle cx="450" cy="140" r="35"/><circle cx="495" cy="180" r="31"/><circle cx="480" cy="275" r="42"/><circle cx="440" cy="325" r="32"/></g></svg>',
    }),
  );
  await page.goto('/');
});

test('discusses a sourced meal, preserves its context, and produces the scaled grocery shortages', async ({
  page,
}, testInfo) => {
  const requests: AiChatRequest[] = [];
  await page.route(`${backend}/chat`, async (route) => {
    requests.push(route.request().postDataJSON() as AiChatRequest);
    await route.fulfill({
      json:
        requests.length === 1
          ? {
              message:
                'Here is a familiar meal-prep option from a recipe publisher. You can buy the missing broccoli and keep the original recipe intact.',
              recipes: [],
              warnings: [],
              recommendedRecipeIds: [publisherRecipe.id],
              sourceRecipes: [publisherRecipe],
            }
          : {
              message:
                'Yes. Follow the original recipe, refrigerate the portions promptly, and reheat each portion thoroughly.',
              recipes: [],
              warnings: [],
              recommendedRecipeIds: [],
            },
    });
  });
  await navigate(page, 'Gemini');
  await sendMessage(page, 'Help me choose something familiar to meal prep. I can buy ingredients.');
  const suggestions = page.getByRole('region', { name: 'Recipe suggestions' });
  const card = suggestions.locator('.recipe-card').filter({ hasText: publisherRecipe.title });
  await expect(card).toBeVisible();
  await expect(card).toContainText('Example recipe publisher');
  await expect(card).toContainText('35 minutes');
  await expect(card.locator('img')).toHaveAttribute('src', publisherRecipe.imageUrl!);
  expect(requests[0].discover).toBe(true);
  expect(requests[0].inventory).toContain('Store brand chicken breast');
  expect(requests[0].inventory).toContain('Long grain rice');
  expect((await storedKitchen(page)).recipes).toBeUndefined();
  await card.getByRole('button', { name: 'Ask about this recipe', exact: true }).click();
  await sendMessage(page, 'Will this reheat well? Please keep the original recipe intact.');
  await expect(page.locator('.chat-history')).toContainText('Follow the original recipe');
  await expect(card).toBeVisible();
  expect(requests[1].recipe).toContain('600 g chicken breast');
  expect(requests[1].recipe).toContain('https://recipes.example.com/chicken-rice');
  expect(requests[1].history?.some((item) => item.text.includes('buy ingredients'))).toBe(true);
  const draft = 'Could I prepare six portions instead?';
  await page.getByRole('textbox', { name: 'Message Gemini', exact: true }).fill(draft);
  await navigate(page, 'Inventory');
  await navigate(page, 'Recipes');
  await navigate(page, 'Gemini');
  await expect(card).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Message Gemini', exact: true })).toHaveValue(
    draft,
  );
  await page.reload();
  await navigate(page, 'Gemini');
  await expect(card).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Message Gemini', exact: true })).toHaveValue(
    draft,
  );
  await expect(
    page.getByRole('button', { name: `Remove ${publisherRecipe.title} from Gemini context` }),
  ).toBeVisible();
  if (['cover', 'unfolded'].includes(testInfo.project.name))
    await page.screenshot({
      path: `/tmp/mise-assistant-new-${testInfo.project.name}.png`,
      fullPage: true,
    });
  await card.getByRole('button', { name: 'Choose recipe', exact: true }).click();
  const detail = page.getByRole('dialog', { name: publisherRecipe.title, exact: true });
  await expect(detail).toContainText('Example Author');
  await expect(detail).toContainText('35 minutes');
  await detail.getByRole('spinbutton', { name: /Cooking for/ }).fill('6');
  await detail.getByRole('button', { name: 'Make shopping list', exact: true }).click();
  await expect(detail).not.toBeVisible();
  await expect(page.getByRole('heading', { name: 'What to buy', exact: true })).toBeVisible();
  await expect.poll(async () => (await storedKitchen(page)).shoppingList?.length).toBe(3);
  const state = await storedKitchen(page);
  expect(state.recipes).toEqual([publisherRecipe]);
  expect(state.mealPlan).toEqual([{ recipeId: publisherRecipe.id, servings: 6 }]);
  for (const [name, quantity, unit] of [
    ['Chicken breast', 500, 'g'],
    ['Rice', 2, 'cup'],
    ['Broccoli', 450, 'g'],
  ] as const)
    expect(
      state.shoppingList?.find((item) => item.name.toLowerCase() === name.toLowerCase()),
    ).toMatchObject({
      quantity,
      unit,
      status: 'missing',
      checked: false,
    });
  expect(state.batches).toEqual(inventory.batches);
  expect(state.assistantSession?.attachedRecipes[0]).toEqual(publisherRecipe);
  expect(state.assistantSession?.draft).toBe(draft);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
});

test('fills editable report fields while preserving recommendation ranges separately from daily goals', async ({
  page,
}) => {
  await page.route(`${backend}/profile/extract`, (route) =>
    route.fulfill({
      json: {
        text: 'Synthetic report: body fat 20.5%, BMR 1600 kcal, recommended intake 1900–2100 kcal.',
        recordedOn: '2026-10-10',
        targets: { caloriesKcal: null, proteinGrams: null, carbsGrams: null, fatGrams: null },
        readings: [
          { label: 'Body fat', value: '20.5%', kind: 'measurement' },
          { label: 'BMR', value: '1600 kcal', kind: 'measurement' },
          { label: 'Daily calories', value: '1900–2100 kcal', kind: 'recommendation' },
        ],
        warnings: ['Review the values against your original report.'],
      },
    }),
  );
  await navigate(page, 'Gemini');
  await page.getByRole('button', { name: 'Your profile', exact: true }).click();
  const profile = page.getByRole('dialog', { name: 'Your profile', exact: true });
  await profile.getByRole('button', { name: 'Add scan', exact: true }).click();
  const editor = page.getByRole('dialog', { name: 'Add a body scan', exact: true });
  await editor.getByLabel('Body scan file', { exact: true }).setInputFiles({
    name: 'synthetic-body-report.png',
    mimeType: 'image/png',
    buffer: Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a+ksAAAAASUVORK5CYII=',
      'base64',
    ),
  });
  await editor.getByRole('button', { name: 'Read with Gemini', exact: true }).click();
  await expect(editor.getByRole('textbox', { name: 'Report value 1', exact: true })).toHaveValue(
    '20.5%',
  );
  await expect(editor.getByRole('textbox', { name: 'Report value 2', exact: true })).toHaveValue(
    '1600 kcal',
  );
  await expect(editor.getByRole('textbox', { name: 'Report value 3', exact: true })).toHaveValue(
    '1900–2100 kcal',
  );
  await editor.getByRole('textbox', { name: 'Report value 1', exact: true }).fill('20.6%');
  await editor.getByRole('button', { name: 'Save report', exact: true }).click();
  await expect(editor).not.toBeVisible();
  const state = await storedKitchen(page);
  expect(state.nutritionTargets).toBeUndefined();
  expect(state.bodyScans?.[0].readings).toEqual([
    { label: 'Body fat', value: '20.6%', kind: 'measurement' },
    { label: 'BMR', value: '1600 kcal', kind: 'measurement' },
    { label: 'Daily calories', value: '1900–2100 kcal', kind: 'recommendation' },
  ]);
  await expect(profile.getByText(/1900–2100 kcal/)).toBeVisible();
  await profile.getByRole('button', { name: 'Add to Gemini', exact: true }).click();
  await expect(profile).not.toBeVisible();
  await expect(
    page.getByRole('button', { name: 'synthetic-body-report', exact: true }),
  ).toBeVisible();
  expect((await storedKitchen(page)).nutritionTargets).toBeUndefined();
});
