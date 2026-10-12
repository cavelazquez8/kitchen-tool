import { expect, test, type Page } from '@playwright/test';
import type { InventoryState, ShoppingItem } from '../src/domain/types';

async function openShopping(page: Page, items: ShoppingItem[]) {
  await page.addInitScript((shoppingList) => {
    localStorage.setItem(
      'kitchen-wrapper.inventory.v1',
      JSON.stringify({
        schemaVersion: 1,
        state: { products: [], batches: [], tools: [], shoppingList },
      }),
    );
  }, items);
  await page.goto('/');
  await page
    .getByRole('button', { name: /^(?:Shopping list|Shop)$/ })
    .filter({ visible: true })
    .first()
    .click();
}

async function storedKitchen(page: Page): Promise<InventoryState> {
  return page.evaluate(
    () => JSON.parse(localStorage.getItem('kitchen-wrapper.inventory.v1') ?? '{}').state,
  );
}

for (const correction of ['smaller quantity', 'different ingredient'] as const) {
  test(`keeps a shopping requirement incomplete after adding a purchase with a ${correction}`, async ({
    page,
  }) => {
    await openShopping(page, [
      {
        id: 'shopping:test-chicken',
        name: 'Chicken breast',
        quantity: 200,
        unit: 'g',
        checked: false,
        status: 'missing',
      },
    ]);
    const chicken = page
      .locator('.shopping-row')
      .filter({ has: page.getByText('Chicken breast', { exact: true }) });
    await chicken.getByRole('button', { name: 'Add purchase', exact: true }).click();
    const editor = page.getByRole('dialog', { name: 'Add an ingredient', exact: true });
    if (correction === 'smaller quantity') {
      await editor.getByLabel('Quantity', { exact: true }).fill('50');
    } else {
      await editor.getByRole('combobox', { name: 'Item name', exact: true }).fill('Milk');
      await editor.getByRole('button', { name: 'Fridge', exact: true }).click();
      await expect(editor.locator('.food-identity-confirmed')).toContainText('Milk');
    }
    await editor.getByRole('button', { name: 'Add to inventory', exact: true }).click();
    await expect(editor).not.toBeVisible();
    await expect(
      chicken.getByRole('checkbox', { name: 'Bought Chicken breast', exact: true }),
    ).not.toBeChecked();
    const state = await storedKitchen(page);
    expect(state.batches).toHaveLength(1);
    expect(state.batches[0].quantity).toBe(correction === 'smaller quantity' ? 50 : 200);
    expect(state.products[0].ingredientName).toBe(
      correction === 'smaller quantity' ? 'Chicken breast' : 'Milk',
    );
    expect(state.shoppingList?.[0]).toMatchObject({ checked: false });
    expect(state.shoppingList?.[0].addedBatchId).toBeUndefined();
  });
}

test('requires a new shopping confirmation after changing a scanned ingredient in details', async ({
  page,
}) => {
  let lookups = 0;
  await page.route('https://world.openfoodfacts.org/api/**', (route) => {
    lookups++;
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        product: {
          product_name: 'Test-only cheddar cheese',
          generic_name: 'Cheddar cheese',
          brands: 'Test Brand',
          quantity: '200 g',
          categories_tags: ['en:cheddar-cheeses'],
        },
      }),
    });
  });
  await openShopping(page, [
    {
      id: 'shopping:test-cheddar',
      name: 'Cheddar cheese',
      quantity: 200,
      unit: 'g',
      checked: false,
      status: 'missing',
    },
    {
      id: 'shopping:test-milk',
      name: 'Milk',
      quantity: 200,
      unit: 'g',
      checked: false,
      status: 'missing',
    },
  ]);
  await page.locator('.quick-shopping').getByRole('button', { name: 'Scan', exact: true }).click();
  const scanner = page.getByRole('dialog', { name: 'Stock up, simply', exact: true });
  await scanner.getByLabel('Or enter a barcode').fill('012345678905');
  await scanner.getByRole('button', { name: 'Add', exact: true }).click();
  const review = page.getByRole('dialog', { name: 'Review scanned item', exact: true });
  await expect(review.getByLabel('Quantity', { exact: true })).toHaveValue('200');
  await review.getByRole('button', { name: 'Fridge', exact: true }).click();
  await review.getByRole('button', { name: 'Cheddar cheese', exact: true }).click();
  await review
    .getByRole('checkbox', {
      name: 'Also check off Cheddar cheese on my shopping list',
      exact: true,
    })
    .check();
  await review.getByRole('button', { name: 'Edit details', exact: true }).click();
  const details = page.getByRole('dialog', { name: 'Edit scanned item', exact: true });
  await details.getByRole('combobox', { name: 'Item name', exact: true }).fill('Milk');
  await details.getByRole('button', { name: 'Fridge', exact: true }).click();
  await details.getByRole('button', { name: 'Change recipe match', exact: true }).click();
  await details.getByRole('combobox', { name: 'Ingredient name', exact: true }).fill('Milk');
  await details.getByRole('button', { name: 'Fridge', exact: true }).click();
  await details.getByRole('button', { name: 'Return to review', exact: true }).click();
  await expect(details).not.toBeVisible();
  await expect(
    review.getByRole('checkbox', { name: 'Also check off Milk on my shopping list', exact: true }),
  ).not.toBeChecked();
  await review.getByRole('button', { name: 'Add & scan next', exact: true }).click();
  await expect(review).not.toBeVisible();
  await scanner.getByRole('button', { name: 'Done scanning', exact: true }).click();
  await expect(
    page.getByRole('checkbox', { name: 'Bought Cheddar cheese', exact: true }),
  ).not.toBeChecked();
  await expect(page.getByRole('checkbox', { name: 'Bought Milk', exact: true })).not.toBeChecked();
  const state = await storedKitchen(page);
  expect(state.batches).toHaveLength(1);
  expect(state.products[0]).toMatchObject({ name: 'Milk', ingredientName: 'Milk' });
  expect(state.shoppingList?.every((item) => !item.checked && !item.addedBatchId)).toBe(true);
  expect(lookups).toBe(1);
});
