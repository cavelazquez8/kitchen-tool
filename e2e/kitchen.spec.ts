import { expect, test, type Page } from '@playwright/test';

async function addItem(
  page: Page,
  name: string,
  quantity = '',
  expiresOn = '',
  purchasedOn = '2026-01-01',
) {
  await page.getByRole('button', { name: 'Add item', exact: true }).click();
  const editor = page.getByRole('dialog', { name: 'Add an ingredient' });
  await editor.getByLabel('Item name', { exact: true }).fill(name);
  await editor.getByLabel('Quantity', { exact: true }).fill(quantity);
  await editor.getByLabel('Purchased', { exact: true }).fill(purchasedOn);
  if (expiresOn) await editor.getByLabel('Expiration', { exact: false }).fill(expiresOn);
  await editor.getByRole('button', { name: 'Add to inventory', exact: true }).click();
  await expect(editor).not.toBeVisible();
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
});

test('starts empty, labels local saving, and fits its screen', async ({ page }) => {
  await expect(page.getByRole('heading', { name: 'A calmer kitchen starts here.' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Local only' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.getByRole('button', { name: 'Add your first item' }).click();
  await page.getByLabel('Item name', { exact: true }).fill('Carrots');
  await page.setViewportSize({ width: 896, height: 864 });
  await expect(page.getByLabel('Item name', { exact: true })).toHaveValue('Carrots');
  await page.setViewportSize({ width: 360, height: 780 });
  await expect(page.getByLabel('Item name', { exact: true })).toHaveValue('Carrots');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
});

test('saves unknown quantity across reload and exports Markdown', async ({ page }) => {
  await addItem(page, 'Carrots');
  await page.reload();
  await expect(page.getByText('Carrots', { exact: true })).toBeVisible();
  await expect(page.getByText('Quantity unknown', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Preview inventory export' }).click();
  await expect(page.getByLabel('Copyable inventory Markdown')).toHaveValue(
    /Carrots[^\n]*Quantity unknown/,
  );
  await expect(page.getByLabel('Copyable inventory Markdown')).toHaveValue(/Fridge/);
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download .md' }).click();
  expect((await downloadPromise).suggestedFilename()).toMatch(/mise-inventory-.*\.md/);
});

test('keeps purchase batches independent and deducts only the chosen batch', async ({ page }) => {
  await addItem(page, 'Apples', '2', '2026-12-01');
  await addItem(page, 'Apples', '3', '2026-12-15', '2026-01-02');
  await expect(
    page.getByRole('button', { name: 'Apples 2 purchase batches', exact: true }),
  ).toBeVisible();
  await expect(page.locator('.item-quantity')).toHaveText('5 each');
  await page.getByRole('button', { name: 'Show batches for Apples' }).click();
  await expect(page.locator('.batch-card')).toHaveCount(2);
  await page.getByRole('button', { name: 'Used some', exact: true }).first().click();
  await page.getByRole('spinbutton').fill('1');
  await page.getByRole('button', { name: 'Update quantity', exact: true }).click();
  await expect(page.locator('.item-quantity')).toHaveText('4 each');
  await page.getByRole('button', { name: 'Edit', exact: true }).last().click();
  const editor = page.getByRole('dialog', { name: 'Edit item' });
  await editor.getByRole('button', { name: 'Freezer', exact: true }).click();
  await editor.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Freezer', exact: true })).toBeVisible();
  await expect(page.locator('.inventory-group')).toHaveCount(2);
});

test('unknown quantity needs remaining amount and rejects excess deductions', async ({ page }) => {
  await addItem(page, 'Rice');
  await page.getByRole('button', { name: 'Show batches for Rice' }).click();
  await page.getByRole('button', { name: 'Used some', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Amount used', exact: true })).toBeDisabled();
  await page.getByRole('spinbutton').fill('2');
  await page.getByRole('button', { name: 'Update quantity', exact: true }).click();
  await expect(page.locator('.item-quantity')).toHaveText('2 each');
  await page.getByRole('button', { name: 'Used some', exact: true }).click();
  await page.getByRole('spinbutton').fill('3');
  await page.getByRole('button', { name: 'Update quantity', exact: true }).click();
  await expect(page.getByRole('alert')).toBeVisible();
  await expect(page.getByRole('dialog', { name: 'Update Rice' })).toBeVisible();
  await expect(page.locator('.item-quantity')).toHaveText('2 each');
});

test('selected export contains only chosen ingredients', async ({ page }) => {
  await addItem(page, 'Carrots', '2');
  await addItem(page, 'Potatoes', '5');
  await page.getByRole('checkbox', { name: 'Select Carrots in Fridge' }).check();
  await page.getByRole('button', { name: 'Preview inventory export' }).click();
  await page.getByRole('checkbox', { name: 'Only selected ingredients' }).check();
  const value = await page.getByLabel('Copyable inventory Markdown').inputValue();
  expect(value).toContain('Carrots');
  expect(value).not.toContain('Potatoes');
});

test('barcode fallback remembers manual names and reviews packages before saving', async ({
  page,
}) => {
  let lookups = 0;
  await page.route('https://world.openfoodfacts.org/api/**', (route) => {
    lookups++;
    return route.fulfill({ status: 404, contentType: 'application/json', body: '{}' });
  });
  await page.getByRole('button', { name: 'Scan groceries', exact: true }).click();
  const scanner = page.getByRole('dialog', { name: 'Stock up, simply' });
  await scanner.getByLabel('Or enter a barcode').fill('012345678905');
  await scanner.getByRole('button', { name: 'Add', exact: true }).click();
  await scanner.getByLabel('Item name', { exact: true }).fill('Oat milk');
  await scanner.getByLabel('Or enter a barcode').fill('012345678905');
  await scanner.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(scanner.getByLabel('Packages')).toHaveValue('2');
  await scanner.getByRole('button', { name: 'Add to inventory', exact: true }).click();
  await expect(page.locator('.item-quantity')).toHaveText('2 package');
  await page.reload();
  await page.getByRole('button', { name: 'Scan groceries', exact: true }).click();
  await scanner.getByLabel('Or enter a barcode').fill('012345678905');
  await scanner.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(scanner.getByLabel('Item name', { exact: true })).toHaveValue('Oat milk');
  expect(lookups).toBe(1);
  await scanner.getByRole('button', { name: 'Add to inventory', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Oat milk 2 purchase batches', exact: true }),
  ).toBeVisible();
  await expect(page.locator('.item-quantity')).toHaveText('3 package');
});

test('tools and backup restore work with explicit replacement', async ({ page }) => {
  await page.getByRole('button', { name: /Kitchen tools|^Tools$/ }).click();
  await page.getByRole('textbox', { name: 'Tool name' }).fill('Air fryer');
  await page.getByRole('button', { name: 'Add tool', exact: true }).click();
  await expect(page.getByText('Air fryer', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Local only' }).click();
  const fileInput = page.locator('input[type=file]');
  const inventory = {
    products: [{ id: 'p', name: 'Backup carrots', isStaple: false }],
    batches: [
      {
        id: 'b',
        productId: 'p',
        location: 'pantry',
        quantity: null,
        unit: 'each',
        purchasedOn: '2026-01-01',
        expiresOn: null,
      },
    ],
    tools: [],
  };
  await fileInput.setInputFiles({
    name: 'backup.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify({ version: 1, inventory })),
  });
  await expect(page.getByRole('heading', { name: 'Restore this kitchen?' })).toBeVisible();
  await expect(page.getByText('Air fryer', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Replace inventory', exact: true }).click();
  await page
    .getByRole('dialog', { name: 'Your kitchen, your way' })
    .getByRole('button', { name: 'Close', exact: true })
    .click();
  await expect(page.getByText('Air fryer', { exact: true })).not.toBeVisible();
  await page.getByRole('button', { name: 'Inventory', exact: false }).first().click();
  await expect(page.getByText('Backup carrots', { exact: true })).toBeVisible();
});

test('expiration sorting puts missing dates after dated items', async ({ page }) => {
  await addItem(page, 'Apples', '1');
  await addItem(page, 'Zucchini', '2', '2026-12-01');
  await page.getByRole('combobox', { name: 'Sort inventory' }).selectOption('expiry');
  await expect(page.locator('.item-name strong').first()).toHaveText('Zucchini');
  await page.getByRole('button', { name: /Missing a date/ }).click();
  await expect(page.locator('.item-name strong')).toHaveText('Apples');
});
