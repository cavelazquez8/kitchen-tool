import { expect, test, type Page } from '@playwright/test';

async function mockCatalogs(page: Page) {
  await page.route('**/data/food-ingredients.json', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ version: 1, names: ['Furikake', 'Gochujang', 'Tamarind paste'] }),
    }),
  );
  const recipes = Array.from({ length: 40 }, (_, index) => ({
    id: `wikibooks:${index + 1}`,
    title: `Recipe ${index + 1}`,
    servings: 2,
    ingredients: [{ name: 'Rice', quantity: 100, unit: 'g', original: '100 g rice' }],
    steps: ['Cook the rice.'],
    category: `Category ${String(index + 1).padStart(2, '0')}`,
    source: {
      type: 'wikibooks',
      url: `https://en.wikibooks.org/w/index.php?oldid=${index + 1}`,
      attribution: 'Wikibooks contributors',
      license: 'CC BY-SA 4.0',
      licenseUrl: 'https://creativecommons.org/licenses/by-sa/4.0/',
    },
  }));
  await page.route('**/data/wikibooks-recipes.json', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ version: 1, recipes }),
    }),
  );
  await page.route('https://www.themealdb.com/api/**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ meals: null }),
    }),
  );
}
test.beforeEach(async ({ page }) => {
  await mockCatalogs(page);
  await page.goto('/');
});

test('scrolls a long selection picker without committing, then searches and selects', async ({
  page,
}, testInfo) => {
  await page
    .getByRole('button', { name: /^Recipes$/ })
    .filter({ visible: true })
    .first()
    .click();
  await page.getByText('Refine recipes', { exact: true }).click();
  const trigger = page.getByRole('combobox', {
    name: 'Recipe category',
    exact: true,
    includeHidden: true,
  });
  await trigger.click();
  const picker = page.getByRole('dialog', { name: 'Recipe category', exact: true });
  const list = picker.getByRole('listbox');
  await expect(list).toBeVisible();
  const box = (await list.boundingBox())!;
  if (testInfo.project.name === 'desktop') {
    await list.hover();
    await page.mouse.wheel(0, 280);
  } else {
    const client = await page.context().newCDPSession(page);
    const x = box.x + box.width / 2;
    const start = box.y + box.height * 0.8;
    await client.send('Input.dispatchTouchEvent', {
      type: 'touchStart',
      touchPoints: [{ x, y: start }],
    });
    for (let step = 1; step <= 8; step++) {
      await client.send('Input.dispatchTouchEvent', {
        type: 'touchMove',
        touchPoints: [{ x, y: start - step * box.height * 0.07 }],
      });
      await page.evaluate(
        () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
      );
    }
    await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await client.detach();
  }
  await expect.poll(() => list.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  await expect(picker).toBeVisible();
  await expect(trigger).toHaveText('Every category');
  await picker
    .getByRole('combobox', { name: 'Search recipe category', exact: true })
    .fill('Category 38');
  await expect(picker.getByRole('option')).toHaveCount(1);
  await picker.getByRole('option', { name: 'Category 38', exact: true }).click();
  await expect(picker).not.toBeVisible();
  await expect(trigger).toHaveText('Category 38');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('uses the expanded food catalog and retains manual recipe identity', async ({ page }) => {
  await page.getByRole('button', { name: 'Add item', exact: true }).click();
  const editor = page.getByRole('dialog', { name: 'Add an ingredient', exact: true });
  const name = editor.getByRole('combobox', { name: 'Item name', exact: true });
  await name.fill('furi');
  await editor.getByRole('option', { name: 'Furikake', exact: true }).click();
  await expect(name).toHaveValue('Furikake');
  await editor.getByRole('button', { name: 'Use product name', exact: true }).click();
  await expect(editor.locator('.food-identity-confirmed')).toContainText('Furikake');
  await editor.getByRole('button', { name: 'Change recipe match', exact: true }).click();
  await expect(editor.getByRole('combobox', { name: 'Ingredient name', exact: true })).toHaveValue(
    'Furikake',
  );
  await editor.getByRole('button', { name: 'Done', exact: true }).click();
  await editor.getByLabel('Quantity', { exact: true }).fill('1');
  await editor.getByRole('button', { name: 'Add to inventory', exact: true }).click();
  await expect(editor).not.toBeVisible();
  await expect(page.locator('.item-name strong')).toHaveText('Furikake');
});

test('keeps item details when a nested selection sheet is dismissed', async ({ page }) => {
  await page.getByRole('button', { name: 'Add item', exact: true }).click();
  const editor = page.getByRole('dialog', { name: 'Add an ingredient', exact: true });
  await editor.getByRole('combobox', { name: 'Item name', exact: true }).fill('Milk');
  await editor.getByRole('switch', { name: /Keep as a staple/ }).check();
  await editor.getByRole('combobox', { name: 'Stock level', exact: true }).click();
  const picker = page.getByRole('dialog', { name: 'Stock level', exact: true });
  await picker.getByRole('combobox', { name: 'Search stock level', exact: true }).fill('low');
  await picker.getByRole('combobox', { name: 'Search stock level', exact: true }).press('Escape');
  await expect(picker).not.toBeVisible();
  await expect(editor).toBeVisible();
  await expect(editor.getByRole('combobox', { name: 'Item name', exact: true })).toHaveValue(
    'Milk',
  );
  await editor.getByRole('combobox', { name: 'Stock level', exact: true }).click();
  await picker.getByRole('option', { name: 'Running low', exact: true }).click();
  await expect(editor.getByRole('combobox', { name: 'Stock level', exact: true })).toHaveText(
    'Running low',
  );
});

test('searches packaged products only after a button press and leaves quantity untouched', async ({
  page,
}) => {
  let queries = 0;
  await page.route('https://world.openfoodfacts.org/cgi/search.pl**', (route) => {
    queries++;
    expect(new URL(route.request().url()).searchParams.get('search_terms')).toBe('Acme sauce');
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        products: [{ code: '0123456789012', product_name: 'Tomato sauce', brands: 'Acme' }],
      }),
    });
  });
  await page.getByRole('button', { name: 'Add item', exact: true }).click();
  const editor = page.getByRole('dialog', { name: 'Add an ingredient', exact: true });
  await editor.getByRole('combobox', { name: 'Item name', exact: true }).fill('Acme sauce');
  expect(queries).toBe(0);
  await editor.getByRole('button', { name: 'Find packaged products', exact: true }).click();
  await editor.getByRole('button', { name: /Tomato sauce Acme/ }).click();
  await expect(editor.getByRole('combobox', { name: 'Item name', exact: true })).toHaveValue(
    'Tomato sauce',
  );
  await expect(editor.getByLabel('Brand', { exact: false })).toHaveValue('Acme');
  await expect(editor.getByLabel('Quantity', { exact: true })).toHaveValue('');
  expect(queries).toBe(1);
});
