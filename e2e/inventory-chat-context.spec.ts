import { readFile } from 'node:fs/promises';
import { expect, test, type Locator, type Page } from '@playwright/test';
import type { AiChatRequest } from '../src/ai/protocol';
import type { InventoryState } from '../src/domain/types';
import type { Recipe } from '../src/recipes/types';

const inventoryKey = 'kitchen-wrapper.inventory.v1';
const backend = 'https://mise.example.workers.dev';
const recipe: Recipe = {
  id: 'manual:carrot-lentil-supper',
  title: 'Carrot and lentil supper',
  servings: 2,
  ingredients: [
    { name: 'Carrots', quantity: 2, unit: 'each' },
    { name: 'Lentils', quantity: 1, unit: 'cup' },
  ],
  steps: ['Synthetic test recipe: cook the lentils and carrots until tender.'],
  source: { type: 'manual' },
};
const inventory: InventoryState = {
  products: [
    {
      id: 'carrots',
      name: 'Selected orchard carrots',
      ingredientName: 'Carrots',
      isStaple: false,
    },
    {
      id: 'lentils',
      name: 'Excluded crimson lentils',
      ingredientName: 'Lentils',
      isStaple: false,
    },
    {
      id: 'celery',
      name: 'Excluded garden celery',
      ingredientName: 'Celery',
      isStaple: false,
    },
  ],
  batches: [
    {
      id: 'carrots-fridge',
      productId: 'carrots',
      location: 'fridge',
      quantity: 2,
      unit: 'each',
      purchasedOn: '2026-10-13',
      expiresOn: null,
    },
    {
      id: 'carrots-pantry',
      productId: 'carrots',
      location: 'pantry',
      quantity: 1,
      unit: 'each',
      purchasedOn: '2026-10-12',
      expiresOn: null,
    },
    {
      id: 'lentils-pantry',
      productId: 'lentils',
      location: 'pantry',
      quantity: 1,
      unit: 'cup',
      purchasedOn: '2026-10-12',
      expiresOn: null,
    },
    {
      id: 'celery-fridge',
      productId: 'celery',
      location: 'fridge',
      quantity: null,
      unit: 'each',
      purchasedOn: '2026-10-12',
      expiresOn: null,
    },
  ],
  tools: [{ id: 'secret-skillet', name: 'Secret titanium skillet' }],
  recipes: [recipe],
  assistantSession: { mode: 'library', recipes: [], attachedRecipes: [], draft: '' },
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

async function openPicker(page: Page): Promise<Locator> {
  await page.getByRole('button', { name: 'Inventory context', exact: true }).click();
  return page.getByRole('dialog', { name: 'Inventory in this chat', exact: true });
}

async function sendMessage(page: Page) {
  await page
    .getByRole('textbox', { name: 'Message Gemini', exact: true })
    .fill('Would the carrot and lentil supper make a good dinner?');
  await page.getByRole('button', { name: 'Ask Gemini', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Ask Gemini', exact: true })).toBeVisible();
}

async function recordRequests(page: Page): Promise<AiChatRequest[]> {
  const requests: AiChatRequest[] = [];
  await page.route(`${backend}/chat`, async (route) => {
    requests.push(route.request().postDataJSON() as AiChatRequest);
    await route.fulfill({
      json: {
        message: 'We can discuss the original recipe without assuming what else you own.',
        recipes: [],
        warnings: [],
        recommendedRecipeIds: [],
      },
    });
  });
  return requests;
}

test.beforeEach(async ({ page }) => {
  // Seed synthetic data once; reloads must exercise real persistence rather than reset it.
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
  await page.goto('/');
  await navigate(page, 'Gemini');
});

test('searches ingredient choices and sends only chosen inventory, without leaking availability', async ({
  page,
}) => {
  const requests = await recordRequests(page);
  await expect(page.getByRole('button', { name: 'Inventory context', exact: true })).toContainText(
    'All inventory',
  );
  const picker = await openPicker(page);
  await picker.getByRole('radio', { name: 'Choose ingredients', exact: true }).check();
  await picker
    .getByRole('searchbox', { name: 'Search your ingredients', exact: true })
    .fill('ORCHARD');
  await picker.getByRole('checkbox', { name: /Selected orchard carrots/ }).check();
  await expect(picker.getByRole('checkbox', { name: /Excluded crimson lentils/ })).toHaveCount(0);
  await picker.getByRole('searchbox', { name: 'Search your ingredients', exact: true }).fill('');
  await expect(picker.getByRole('checkbox', { name: /Selected orchard carrots/ })).toBeChecked();
  await expect(
    picker.getByRole('checkbox', { name: /Excluded crimson lentils/ }),
  ).not.toBeChecked();
  await picker.getByRole('button', { name: 'Apply to chat', exact: true }).click();
  await expect(picker).not.toBeVisible();
  await expect(page.getByRole('button', { name: 'Inventory context', exact: true })).toContainText(
    '1 ingredient',
  );

  await sendMessage(page);
  await expect.poll(() => requests.length).toBe(1);
  const request = requests[0];
  expect(request.inventory).toContain('Selected orchard carrots');
  expect(request.inventory).toContain('## Fridge');
  expect(request.inventory).toContain('## Pantry');
  expect(request.inventory).toContain('partial inventory');
  expect(request.candidates?.find((candidate) => candidate.id === recipe.id)).toMatchObject({
    missingIngredients: [],
  });
  for (const excluded of [
    'Excluded crimson lentils',
    'Excluded garden celery',
    'Secret titanium skillet',
  ])
    expect(JSON.stringify(request)).not.toContain(excluded);
  expect((await storedKitchen(page)).products).toEqual(inventory.products);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
});

test('keeps no inventory and an empty ingredient selection separate from sharing everything', async ({
  page,
}) => {
  const requests = await recordRequests(page);
  let picker = await openPicker(page);
  await picker.getByRole('radio', { name: 'No inventory', exact: true }).check();
  await picker.getByRole('button', { name: 'Apply to chat', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Inventory context', exact: true })).toContainText(
    'No inventory',
  );
  await sendMessage(page);
  await expect.poll(() => requests.length).toBe(1);
  expect(requests[0].inventory).toContain('Inventory not shared');

  picker = await openPicker(page);
  await picker.getByRole('radio', { name: 'Choose ingredients', exact: true }).check();
  await expect(picker.getByRole('checkbox', { checked: true })).toHaveCount(0);
  await picker.getByRole('button', { name: 'Apply to chat', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Inventory context', exact: true })).toContainText(
    '0 ingredients',
  );
  await sendMessage(page);
  await expect.poll(() => requests.length).toBe(2);
  expect(requests[1].inventory).toContain('No ingredients selected');
  for (const request of requests) {
    for (const name of [
      ...inventory.products.map((product) => product.name),
      inventory.tools[0].name,
    ])
      expect(JSON.stringify(request)).not.toContain(name);
    expect(request.candidates?.find((candidate) => candidate.id === recipe.id)).toMatchObject({
      missingIngredients: [],
    });
  }
  expect((await storedKitchen(page)).batches).toEqual(inventory.batches);
});

test('retains selected ingredients across navigation, reload, and backup restoration', async ({
  page,
}) => {
  let picker = await openPicker(page);
  await picker.getByRole('radio', { name: 'Choose ingredients', exact: true }).check();
  await picker.getByRole('checkbox', { name: /Selected orchard carrots/ }).check();
  await picker.getByRole('checkbox', { name: /Excluded crimson lentils/ }).check();
  await picker.getByRole('button', { name: 'Apply to chat', exact: true }).click();
  await navigate(page, 'Inventory');
  await navigate(page, 'Gemini');
  await expect(page.getByRole('button', { name: 'Inventory context', exact: true })).toContainText(
    '2 ingredients',
  );
  await page.reload();
  await navigate(page, 'Gemini');
  picker = await openPicker(page);
  await expect(
    picker.getByRole('radio', { name: 'Choose ingredients', exact: true }),
  ).toBeChecked();
  await expect(picker.getByRole('checkbox', { name: /Selected orchard carrots/ })).toBeChecked();
  await expect(picker.getByRole('checkbox', { name: /Excluded crimson lentils/ })).toBeChecked();
  await picker.getByRole('button', { name: 'Apply to chat', exact: true }).click();

  await page
    .getByRole('button', { name: 'Settings and backup', exact: true })
    .filter({ visible: true })
    .first()
    .click();
  const settings = page.getByRole('dialog', { name: 'Your kitchen, your way', exact: true });
  const download = page.waitForEvent('download');
  await settings.getByRole('button', { name: 'Download backup', exact: true }).click();
  const backupText = await readFile((await (await download).path())!, 'utf8');
  const backup = JSON.parse(backupText) as { inventory: InventoryState };
  expect(backup.inventory.assistantSession?.inventoryContext).toEqual({
    mode: 'selected',
    productIds: ['carrots', 'lentils'],
  });
  expect(backupText).not.toContain(backend);
  expect(backupText).not.toContain('test_only_');
  await settings.getByRole('button', { name: 'Close', exact: true }).click();

  picker = await openPicker(page);
  await picker.getByRole('radio', { name: 'No inventory', exact: true }).check();
  await picker.getByRole('button', { name: 'Apply to chat', exact: true }).click();
  await expect
    .poll(async () => (await storedKitchen(page)).assistantSession?.inventoryContext?.mode)
    .toBe('none');
  await page
    .getByRole('button', { name: 'Settings and backup', exact: true })
    .filter({ visible: true })
    .first()
    .click();
  await settings.locator('input[type=file]').setInputFiles({
    name: 'inventory-context-backup.json',
    mimeType: 'application/json',
    buffer: Buffer.from(backupText),
  });
  const restore = page.getByRole('dialog', { name: 'Restore this kitchen?', exact: true });
  await restore.getByRole('button', { name: 'Replace inventory', exact: true }).click();
  await expect(restore).not.toBeVisible();
  await settings.getByRole('button', { name: 'Close', exact: true }).click();
  await navigate(page, 'Gemini');
  await expect(page.getByRole('button', { name: 'Inventory context', exact: true })).toContainText(
    '2 ingredients',
  );
  expect((await storedKitchen(page)).assistantSession?.inventoryContext).toEqual({
    mode: 'selected',
    productIds: ['carrots', 'lentils'],
  });
});

test('scrolls long ingredient choices by touch while keeping Apply reachable on small screens', async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name === 'desktop', 'Touch scrolling is checked on mobile viewports.');
  const products = Array.from({ length: 30 }, (_, index) => ({
    id: `synthetic-${index}`,
    name: `Synthetic ingredient ${String(index + 1).padStart(2, '0')}`,
    isStaple: false,
  }));
  const longInventory: InventoryState = {
    products,
    batches: products.map((product, index) => ({
      id: `batch-${product.id}`,
      productId: product.id,
      location: index % 2 === 0 ? 'fridge' : 'pantry',
      quantity: 1,
      unit: 'each',
      purchasedOn: '2026-10-13',
      expiresOn: null,
    })),
    tools: [],
  };
  const touch = await page.context().newCDPSession(page);
  for (const viewport of [
    { width: 412, height: 915 },
    { width: 320, height: 700 },
  ]) {
    await page.evaluate(
      ({ inventoryKey, state }) => {
        localStorage.setItem(inventoryKey, JSON.stringify({ schemaVersion: 1, state }));
      },
      { inventoryKey, state: longInventory },
    );
    await page.setViewportSize(viewport);
    await page.reload();
    await navigate(page, 'Gemini');
    const picker = await openPicker(page);
    await picker.getByRole('radio', { name: 'Choose ingredients', exact: true }).check();
    const apply = picker.getByRole('button', { name: 'Apply to chat', exact: true });
    const list = picker.getByRole('group', { name: 'Your ingredients', exact: true });
    await expect(picker.getByRole('checkbox')).toHaveCount(30);
    expect(await list.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(
      true,
    );
    const initialVisibleHeight = await list.evaluate((element) => {
      const bounds = element.getBoundingClientRect();
      const body = element.closest('.inventory-context-body')!.getBoundingClientRect();
      return Math.min(bounds.bottom, body.bottom) - Math.max(bounds.top, body.top);
    });
    // A complete ingredient row should be visible before any body scrolling.
    expect(initialVisibleHeight).toBeGreaterThan(80);
    let applyBounds = await apply.boundingBox();
    expect(applyBounds).not.toBeNull();
    expect(applyBounds!.y).toBeGreaterThanOrEqual(0);
    expect(applyBounds!.y + applyBounds!.height).toBeLessThanOrEqual(viewport.height);
    await page.screenshot({
      path: `/tmp/mise-inventory-picker-${viewport.width}-${testInfo.project.name}-initial.png`,
      fullPage: false,
    });

    await list.scrollIntoViewIfNeeded();
    const visible = await list.evaluate((element) => {
      const bounds = element.getBoundingClientRect();
      const body = element.closest('.inventory-context-body')!.getBoundingClientRect();
      return {
        x: bounds.left + bounds.width / 2,
        top: Math.max(bounds.top, body.top),
        bottom: Math.min(bounds.bottom, body.bottom),
      };
    });
    expect(visible.bottom - visible.top).toBeGreaterThan(60);
    const startY = visible.bottom - 15;
    const endY = visible.top + 15;
    await touch.send('Input.dispatchTouchEvent', {
      type: 'touchStart',
      touchPoints: [{ x: visible.x, y: startY }],
    });
    for (let step = 1; step <= 10; step += 1) {
      await touch.send('Input.dispatchTouchEvent', {
        type: 'touchMove',
        touchPoints: [{ x: visible.x, y: startY + ((endY - startY) * step) / 10 }],
      });
      await page.waitForTimeout(20);
    }
    await touch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await expect.poll(() => list.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
    await expect(picker.getByRole('checkbox', { checked: true })).toHaveCount(0);
    await picker.getByRole('checkbox', { name: /Synthetic ingredient 30/ }).check();
    await expect(picker.getByRole('checkbox', { checked: true })).toHaveCount(1);
    applyBounds = await apply.boundingBox();
    expect(applyBounds).not.toBeNull();
    expect(applyBounds!.y + applyBounds!.height).toBeLessThanOrEqual(viewport.height);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await page.screenshot({
      path: `/tmp/mise-inventory-picker-${viewport.width}-${testInfo.project.name}-scrolled.png`,
      fullPage: false,
    });
    await apply.click();
    await expect(picker).not.toBeVisible();
    await expect(
      page.getByRole('button', { name: 'Inventory context', exact: true }),
    ).toContainText('1 ingredient');
  }
  await touch.detach();
});
