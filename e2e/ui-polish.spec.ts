import { expect, test, type Page } from '@playwright/test';
import type { InventoryState } from '../src/domain/types';

const inventory: InventoryState = {
  products: [
    { id: 'apples', name: 'Apples', ingredientName: 'Apple', isStaple: false },
    { id: 'mystery', name: 'Mystery sauce', isStaple: false },
  ],
  batches: [
    {
      id: 'apples-one',
      productId: 'apples',
      location: 'fridge',
      quantity: 1,
      unit: 'each',
      purchasedOn: '2026-01-01',
      expiresOn: '2026-12-01',
    },
    {
      id: 'mystery-one',
      productId: 'mystery',
      location: 'pantry',
      quantity: null,
      unit: 'g',
      purchasedOn: '2026-01-01',
      expiresOn: null,
    },
  ],
  tools: [],
};

test.beforeEach(async ({ page }) => {
  await page.addInitScript((state) => {
    localStorage.setItem(
      'kitchen-wrapper.inventory.v1',
      JSON.stringify({ schemaVersion: 1, state }),
    );
  }, inventory);
  await page.goto('/');
});

async function storedInventory(page: Page): Promise<InventoryState> {
  return page.evaluate(
    () => JSON.parse(localStorage.getItem('kitchen-wrapper.inventory.v1') ?? '{}').state,
  );
}

test('supports quantity icons through depletion and reverses additions with Undo', async ({
  page,
}) => {
  const quick = page.getByRole('group', { name: 'Quick quantity for Apples', exact: true });
  const minus = quick.getByRole('button', { name: 'Use one Apples', exact: true });
  const plus = quick.getByRole('button', { name: 'Add one Apples', exact: true });
  await minus.click();
  await expect(page.locator('.quantity-text').filter({ hasText: '0 each' })).toBeVisible();
  await expect(minus).toBeDisabled();
  await plus.click();
  await expect(page.locator('.quantity-text').filter({ hasText: '1 each' })).toBeVisible();
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(page.locator('.quantity-text').filter({ hasText: '0 each' })).toBeVisible();
  await plus.click();
  await expect(page.locator('.quantity-text').filter({ hasText: '1 each' })).toBeVisible();
  expect(
    (await storedInventory(page)).batches.find((batch) => batch.id === 'apples-one')?.quantity,
  ).toBe(1);
  expect(
    (await storedInventory(page)).batches.find((batch) => batch.id === 'mystery-one')?.quantity,
  ).toBeNull();
  await page.getByRole('button', { name: 'Show batches for Apples', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Used some', exact: true })).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Use 1 each of Apples', exact: true }),
  ).toBeVisible();
});

test('flags missing recipe identity and opens its editor while preserving unknown stock', async ({
  page,
}) => {
  const flag = page.getByRole('button', {
    name: 'Set recipe match for Mystery sauce',
    exact: true,
  });
  await expect(flag).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Set recipe match for Apples', exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole('group', { name: 'Quick quantity for Mystery sauce', exact: true }),
  ).toHaveCount(0);
  await flag.click();
  const editor = page.getByRole('dialog', { name: 'Edit item', exact: true });
  const ingredient = editor.getByRole('combobox', { name: 'Ingredient name', exact: true });
  await expect(ingredient).toHaveValue('');
  await ingredient.fill('Tomato sauce');
  await ingredient.press('Tab');
  await editor.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect(editor).not.toBeVisible();
  await expect(flag).toHaveCount(0);
  expect(
    (await storedInventory(page)).products.find((product) => product.id === 'mystery')
      ?.ingredientName,
  ).toBe('Tomato sauce');
  expect(
    (await storedInventory(page)).batches.find((batch) => batch.id === 'mystery-one')?.quantity,
  ).toBeNull();
  await page.getByRole('button', { name: 'Show batches for Mystery sauce', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Used some', exact: true })).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Use 1 g of Mystery sauce', exact: true }),
  ).toHaveCount(0);
});

test('gives inventory search usable space and keeps quantity controls inside the screen', async ({
  page,
}) => {
  const search = page.getByRole('textbox', { name: 'Search inventory', exact: true });
  const sort = page.getByRole('combobox', { name: 'Sort inventory', exact: true });
  const searchBox = await search.boundingBox();
  const sortBox = await sort.boundingBox();
  const width = page.viewportSize()!.width;
  expect(searchBox?.width).toBeGreaterThanOrEqual(Math.min(250, width * 0.55));
  if (width <= 720) expect(sortBox!.y).toBeGreaterThan(searchBox!.y + searchBox!.height);
  await search.fill('Mystery');
  await expect(
    page.getByRole('button', { name: 'Show batches for Mystery sauce', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Show batches for Apples', exact: true }),
  ).toHaveCount(0);
  await search.clear();
  await page.getByRole('button', { name: 'Show batches for Apples', exact: true }).click();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  const plus = await page
    .getByRole('button', { name: 'Add 1 each to Apples', exact: true })
    .boundingBox();
  expect(plus!.width).toBeGreaterThanOrEqual(44);
  expect(plus!.height).toBeGreaterThanOrEqual(44);
  expect(plus!.x + plus!.width).toBeLessThanOrEqual(width);
});
