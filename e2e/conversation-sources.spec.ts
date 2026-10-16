import { expect, test, type Page } from '@playwright/test';
import type { AiChatRequest } from '../src/ai/protocol';
import type { InventoryState } from '../src/domain/types';
import type { Recipe } from '../src/recipes/types';

const inventoryKey = 'kitchen-wrapper.inventory.v1';
const backend = 'https://mise.example.workers.dev';
// Synthetic recipes only: these tests never request a publisher or a real Gemini account.
const saved: Recipe = {
  id: 'manual:saved-carrot-stew',
  title: 'Saved carrot lentil stew',
  servings: 2,
  ingredients: [
    { name: 'Carrots', quantity: 2, unit: 'each' },
    { name: 'Lentils', quantity: 1, unit: 'cup' },
  ],
  steps: ['Synthetic fixture: simmer the carrots and lentils until tender.'],
  source: { type: 'manual' },
};
const bundled: Recipe = {
  id: 'wikibooks:synthetic-carrot-rice',
  title: 'Bundled carrot rice',
  servings: 2,
  ingredients: [
    { name: 'Carrots', quantity: 2, unit: 'each' },
    { name: 'Rice', quantity: 1, unit: 'cup' },
  ],
  steps: ['Synthetic fixture: cook the rice and carrots until tender.'],
  source: { type: 'wikibooks', name: 'Synthetic cookbook fixture' },
};
const publisher: Recipe = {
  id: 'publisher:synthetic-tomato-supper',
  title: 'Inspected tomato supper',
  servings: 2,
  ingredients: [{ name: 'Tomatoes', quantity: 4, unit: 'each', original: '4 tomatoes' }],
  steps: ['Synthetic fixture: cook the tomatoes and serve.'],
  source: {
    type: 'imported',
    name: 'Example publisher',
    url: 'https://recipes.example.com/tomato-supper',
  },
};
const inventory: InventoryState = {
  products: [{ id: 'carrots', name: 'Carrots', ingredientName: 'Carrots', isStaple: false }],
  batches: [
    {
      id: 'carrot-batch',
      productId: 'carrots',
      location: 'fridge',
      quantity: 3,
      unit: 'each',
      purchasedOn: '2026-10-14',
      expiresOn: null,
    },
  ],
  tools: [],
  recipes: [saved],
};

async function navigate(page: Page, name: 'Gemini' | 'Inventory') {
  await page
    .getByRole('button', { name: new RegExp(`^${name}$`) })
    .filter({ visible: true })
    .first()
    .click();
}

async function storedKitchen(page: Page): Promise<InventoryState> {
  return page.evaluate((key) => JSON.parse(localStorage.getItem(key)!).state, inventoryKey);
}

async function chooseSource(
  page: Page,
  name: 'Search the web' | 'Choose from the cookbook' | 'Create a recipe',
) {
  await page.getByRole('button', { name: 'Recipe source', exact: true }).click();
  // Selecting a source closes this menu, so assert the persisted source below.
  await page.getByRole('radio', { name, exact: true }).click();
  await expect(page.getByRole('button', { name: 'Recipe source', exact: true })).toContainText(
    name,
  );
  await expect
    .poll(async () => (await storedKitchen(page)).assistantSession?.mode)
    .toBe(
      {
        'Search the web': 'discover',
        'Choose from the cookbook': 'library',
        'Create a recipe': 'create',
      }[name],
    );
  await expect(
    page.getByRole('region', { name: 'Assistant preferences', exact: true }),
  ).not.toBeVisible();
}

async function sendMessage(page: Page, message: string) {
  await page.getByRole('textbox', { name: 'Message Gemini', exact: true }).fill(message);
  await page.getByRole('button', { name: 'Ask Gemini', exact: true }).click();
}

async function ordinaryReply(page: Page): Promise<AiChatRequest[]> {
  const requests: AiChatRequest[] = [];
  await page.route(`${backend}/chat`, async (route) => {
    requests.push(route.request().postDataJSON() as AiChatRequest);
    await route.fulfill({
      json: {
        message: `Synthetic response ${requests.length}: let’s discuss the recipe.`,
        recipes: [],
        warnings: [],
        recommendedRecipeIds: [],
      },
    });
  });
  return requests;
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
    route.fulfill({ json: { version: 1, recipes: [bundled] } }),
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
  await page.goto('/');
  await navigate(page, 'Gemini');
});

test('keeps web discovery separate from the saved cookbook and remembers source choices', async ({
  page,
}, testInfo) => {
  const requests = await ordinaryReply(page);
  const providerSearches: string[] = [];
  page.on('request', (request) => {
    if (
      /themealdb\.com\/api|\/recipes\/search|api\.spoonacular\.com|api\.recipeapi\.io/.test(
        request.url(),
      )
    )
      providerSearches.push(request.url());
  });
  const source = page.getByRole('button', { name: 'Recipe source', exact: true });
  await expect(source).toContainText('Search the web');
  await source.click();
  const options = page.getByRole('region', { name: 'Assistant preferences', exact: true });
  await expect(options.getByRole('radio', { name: 'Search the web', exact: true })).toBeChecked();
  const sourceBounds = await source.boundingBox();
  const optionsBounds = await options.boundingBox();
  expect(sourceBounds).not.toBeNull();
  expect(optionsBounds).not.toBeNull();
  expect(optionsBounds!.y).toBeGreaterThanOrEqual(sourceBounds!.y + sourceBounds!.height);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  if (['cover', 'unfolded'].includes(testInfo.project.name))
    await page.screenshot({
      path: `/tmp/mise-conversation-source-menu-${testInfo.project.name}.png`,
      fullPage: false,
    });
  await source.click();
  await sendMessage(page, 'Find a carrot recipe on a cooking website.');
  await expect(page.locator('.chat-history')).toContainText('Synthetic response 1');
  expect(requests[0].discover).toBe(true);
  expect(requests[0].candidates).toBeUndefined();
  expect(requests[0].recipe).toBeUndefined();
  expect(JSON.stringify(requests[0])).not.toContain(saved.title);
  expect(JSON.stringify(requests[0])).not.toContain(bundled.title);

  await chooseSource(page, 'Choose from the cookbook');
  await navigate(page, 'Inventory');
  await navigate(page, 'Gemini');
  await expect(source).toContainText('Choose from the cookbook');
  await page.reload();
  await navigate(page, 'Gemini');
  await expect(source).toContainText('Choose from the cookbook');
  expect((await storedKitchen(page)).assistantSession?.mode).toBe('library');
  await sendMessage(page, 'Find a carrot recipe in my cookbook.');
  await expect(page.locator('.chat-history')).toContainText('Synthetic response 2');
  expect(requests[1].discover).toBeUndefined();
  expect(requests[1].candidates?.map((candidate) => candidate.id)).toEqual(
    expect.arrayContaining([saved.id, bundled.id]),
  );
  expect(providerSearches).toEqual([]);
  await chooseSource(page, 'Create a recipe');
  await navigate(page, 'Inventory');
  await navigate(page, 'Gemini');
  await expect(source).toContainText('Create a recipe');
  await page.reload();
  await navigate(page, 'Gemini');
  await expect(source).toContainText('Create a recipe');
  expect((await storedKitchen(page)).assistantSession?.mode).toBe('create');
});

test('reports an empty cookbook locally rather than falling back to recipe generation', async ({
  page,
}) => {
  const requests = await ordinaryReply(page);
  await page.route('**/data/wikibooks-recipes.json', (route) =>
    route.fulfill({ json: { version: 1, recipes: [] } }),
  );
  await page.evaluate(
    ({ inventoryKey, inventory }) => {
      localStorage.setItem(
        inventoryKey,
        JSON.stringify({ schemaVersion: 1, state: { ...inventory, recipes: [] } }),
      );
    },
    { inventoryKey, inventory },
  );
  await page.reload();
  await navigate(page, 'Gemini');
  await chooseSource(page, 'Choose from the cookbook');
  const message = 'Find a carrot recipe in this empty cookbook.';
  await sendMessage(page, message);
  await expect(page.getByRole('alert')).toContainText(/No cookbook recipes are available/);
  await expect(page.getByRole('textbox', { name: 'Message Gemini', exact: true })).toHaveValue(
    message,
  );
  expect(requests).toEqual([]);
  expect((await storedKitchen(page)).assistantSession?.mode).toBe('library');
  expect((await storedKitchen(page)).assistantSession?.draft).toBe(message);
});

test('clears old suggestion cards when sources change while retaining explicit recipe attachments', async ({
  page,
}) => {
  const requests: AiChatRequest[] = [];
  await page.route(`${backend}/chat`, async (route) => {
    const request = route.request().postDataJSON() as AiChatRequest;
    requests.push(request);
    await route.fulfill({
      json: request.discover
        ? {
            message: 'Here is a synthetic inspected publisher recipe.',
            recipes: [],
            warnings: [],
            recommendedRecipeIds: [publisher.id],
            sourceRecipes: [publisher],
          }
        : {
            message: 'We can discuss your cooking question and any explicitly attached recipe.',
            recipes: [],
            warnings: [],
            recommendedRecipeIds: [],
          },
    });
  });
  await sendMessage(page, 'Find a recipe from a publisher.');
  const suggestions = page.getByRole('region', { name: 'Recipe suggestions', exact: true });
  const card = suggestions.locator('.recipe-card').filter({ hasText: publisher.title });
  await expect(card).toBeVisible();
  await chooseSource(page, 'Create a recipe');
  await expect(suggestions).not.toBeVisible();
  await expect(page.locator('.chat-history')).toContainText('Find a recipe from a publisher.');
  expect((await storedKitchen(page)).assistantSession?.recipes).toEqual([]);
  await sendMessage(page, 'Make something original without reusing the previous suggestion.');
  await expect(page.locator('.chat-history')).toContainText('explicitly attached recipe');
  expect(requests[1].discover).toBeUndefined();
  expect(requests[1].candidates).toBeUndefined();
  expect(requests[1].recipe).toBeUndefined();

  await chooseSource(page, 'Search the web');
  await sendMessage(page, 'Show me an inspected recipe again.');
  await expect(card).toBeVisible();
  await card.getByRole('button', { name: 'Ask about this recipe', exact: true }).click();
  const attachment = page.getByRole('button', {
    name: `Remove ${publisher.title} from Gemini context`,
    exact: true,
  });
  await expect(attachment).toBeVisible();
  await chooseSource(page, 'Create a recipe');
  await expect(suggestions).not.toBeVisible();
  await expect(attachment).toBeVisible();
  expect((await storedKitchen(page)).assistantSession?.attachedRecipes).toEqual([publisher]);
  await sendMessage(page, 'Explain the recipe I explicitly attached.');
  await expect.poll(() => requests.length).toBe(4);
  expect(requests[3].discover).toBeUndefined();
  expect(requests[3].candidates).toBeUndefined();
  expect(requests[3].recipe).toContain(publisher.title);
  expect(requests[3].recipe).toContain('4 tomatoes');
  expect(
    requests[3].history?.some((turn) => turn.text.includes('Find a recipe from a publisher.')),
  ).toBe(true);
});

test('clears the composer while Gemini is pending and restores retry text after a failed request', async ({
  page,
}) => {
  const requests: AiChatRequest[] = [];
  let release: (() => void) | undefined;
  await page.route(`${backend}/chat`, async (route) => {
    requests.push(route.request().postDataJSON() as AiChatRequest);
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    await route.fulfill(
      requests.length === 1
        ? {
            json: {
              message: 'The first synthetic response completed.',
              recipes: [],
              warnings: [],
              recommendedRecipeIds: [],
            },
          }
        : {
            status: 503,
            json: {
              error: {
                code: 'provider_unavailable',
                message: 'Synthetic temporary Gemini failure. Please try again.',
              },
            },
          },
    );
  });
  const input = page.getByRole('textbox', { name: 'Message Gemini', exact: true });
  await sendMessage(page, 'Help me choose dinner.');
  await expect.poll(() => requests.length).toBe(1);
  await expect(input).toHaveValue('');
  await expect(input).toBeDisabled();
  await expect.poll(async () => (await storedKitchen(page)).assistantSession?.draft).toBe('');
  await expect(page.locator('.chat-history')).toContainText('Help me choose dinner.');
  release!();
  await expect(page.locator('.chat-history')).toContainText('first synthetic response completed');
  await expect(input).toBeEnabled();
  await expect(input).toHaveValue('');

  const retry = 'Could you help me choose a meal to cook tomorrow?';
  await sendMessage(page, retry);
  await expect.poll(() => requests.length).toBe(2);
  await expect(input).toHaveValue('');
  await expect(input).toBeDisabled();
  await expect.poll(async () => (await storedKitchen(page)).assistantSession?.draft).toBe('');
  release!();
  await expect(input).toBeEnabled();
  await expect(input).toHaveValue(retry);
  await expect(page.getByRole('alert')).toBeVisible();
  await expect.poll(async () => (await storedKitchen(page)).assistantSession?.draft).toBe(retry);
});
