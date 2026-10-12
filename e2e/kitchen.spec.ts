import { expect, test, type Locator, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import type { InventoryState } from '../src/domain/types';
import type { Recipe } from '../src/recipes/types';

function cookbookFixture(): Recipe[] {
  return Array.from({ length: 60 }, (_, index) => ({
    id: `wikibooks:${index + 1}`,
    title: `${index < 40 ? 'Rice dinner' : 'Egg breakfast'} ${String(index + 1).padStart(2, '0')}`,
    servings: 2,
    ingredients: [
      {
        name: index < 40 ? 'Rice' : 'Eggs',
        quantity: index < 40 ? 100 : 2,
        unit: index < 40 ? 'g' : 'each',
        original: index < 40 ? '100 g rice' : '2 eggs',
      },
    ],
    steps: ['Prepare the ingredients.', 'Cook and serve.'],
    category: index < 40 ? 'Dinner' : 'Breakfast',
    cuisine: 'American',
    source: {
      type: 'wikibooks',
      url: `https://en.wikibooks.org/w/index.php?oldid=${index + 1}`,
      attribution: 'Wikibooks contributors; adapted for Mise.',
      license: 'CC BY-SA 4.0',
      licenseUrl: 'https://creativecommons.org/licenses/by-sa/4.0/',
    },
  }));
}

async function mockCookbook(page: Page) {
  await page.route('**/data/wikibooks-recipes.json', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ version: 1, recipes: cookbookFixture() }),
    }),
  );
}

async function addItem(
  page: Page,
  name: string,
  quantity = '',
  expiresOn = '',
  purchasedOn = '2026-01-01',
  unit = 'each',
) {
  await page.getByRole('button', { name: 'Add item', exact: true }).click();
  const editor = page.getByRole('dialog', { name: 'Add an ingredient' });
  await editor.getByRole('combobox', { name: 'Item name', exact: true }).fill(name);
  if (!((await editor.locator('.food-identity-field').getAttribute('data-confirmed')) === 'true')) {
    await editor.getByRole('button', { name: 'Use product name', exact: true }).click();
  }
  await editor.getByLabel('Quantity', { exact: true }).fill(quantity);
  await editor.getByRole('combobox', { name: 'Unit', exact: true }).fill(unit);
  await editor.getByLabel('Purchased', { exact: true }).fill(purchasedOn);
  if (expiresOn) await editor.getByLabel('Expiration', { exact: false }).fill(expiresOn);
  await editor.getByRole('button', { name: 'Add to inventory', exact: true }).click();
  await expect(editor).not.toBeVisible();
}

async function enterBarcode(scanner: Locator, code: string) {
  await scanner.getByLabel('Or enter a barcode').fill(code);
  await scanner.getByRole('button', { name: 'Add', exact: true }).click();
}

test.beforeEach(async ({ page }) => {
  await page.route('https://www.themealdb.com/api/**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ meals: null }),
    }),
  );
  await page.route('https://generativelanguage.googleapis.com/**', (route) => route.abort());
  await page.goto('/');
});

test('starts empty, labels local saving, and fits its screen', async ({ page }) => {
  await expect(page.getByRole('heading', { name: 'A calmer kitchen starts here.' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Local only' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.getByRole('button', { name: 'Add your first item' }).click();
  await page.getByRole('combobox', { name: 'Item name', exact: true }).fill('Carrots');
  await page.setViewportSize({ width: 896, height: 864 });
  await expect(page.getByRole('combobox', { name: 'Item name', exact: true })).toHaveValue(
    'Carrots',
  );
  await page.setViewportSize({ width: 360, height: 780 });
  await expect(page.getByRole('combobox', { name: 'Item name', exact: true })).toHaveValue(
    'Carrots',
  );
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
  await expect(page.locator('.item-quantity')).toHaveText(/^5 each(?:\s*−1)?$/);
  await page.getByRole('button', { name: 'Show batches for Apples' }).click();
  await expect(page.locator('.batch-card')).toHaveCount(2);
  await page.getByRole('button', { name: 'Used some', exact: true }).first().click();
  await page.getByRole('spinbutton').fill('1');
  await page.getByRole('button', { name: 'Update quantity', exact: true }).click();
  await expect(page.locator('.item-quantity')).toHaveText(/^4 each(?:\s*−1)?$/);
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
  await expect(page.locator('.item-quantity')).toHaveText(/^2 each(?:\s*−1)?$/);
  await page.getByRole('button', { name: 'Used some', exact: true }).click();
  await page.getByRole('spinbutton').fill('3');
  await page.getByRole('button', { name: 'Update quantity', exact: true }).click();
  await expect(page.getByRole('alert')).toBeVisible();
  await expect(page.getByRole('dialog', { name: 'Update Rice' })).toBeVisible();
  await expect(page.locator('.item-quantity')).toHaveText(/^2 each(?:\s*−1)?$/);
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

test('barcode fallback remembers manual identities, requires destinations, and confirms repeat packages', async ({
  page,
}) => {
  let lookups = 0;
  await page.route('https://world.openfoodfacts.org/api/**', (route) => {
    lookups++;
    return route.fulfill({ status: 404, contentType: 'application/json', body: '{}' });
  });
  await page.getByRole('button', { name: 'Scan groceries', exact: true }).click();
  const scanner = page.getByRole('dialog', { name: 'Stock up, simply', exact: true });
  await enterBarcode(scanner, '012345678905');
  const unknown = page.getByRole('dialog', { name: 'Product not found', exact: true });
  await expect(unknown).toBeVisible();
  await unknown.getByRole('combobox', { name: 'Item name', exact: true }).fill('Oat milk');
  await expect(unknown.locator('.grocery-match-confirmed')).toContainText('Oat milk');
  await unknown.getByRole('button', { name: 'Add & scan next', exact: true }).click();
  await expect(unknown.getByRole('alert')).toHaveText('Choose where this item will go.');
  await unknown.getByRole('button', { name: 'Fridge', exact: true }).click();
  await unknown.getByLabel('Expiration (optional)', { exact: true }).fill('2026-12-01');
  await unknown.getByRole('button', { name: 'Add & scan next', exact: true }).click();
  await expect(unknown).not.toBeVisible();
  expect((await storedKitchen(page)).batches).toHaveLength(1);
  await enterBarcode(scanner, '012345678905');
  const repeat = page.getByRole('dialog', { name: 'Add another package?', exact: true });
  await expect(repeat.getByRole('combobox', { name: 'Item name', exact: true })).toHaveValue(
    'Oat milk',
  );
  await repeat.getByRole('button', { name: 'Skip item', exact: true }).click();
  expect((await storedKitchen(page)).batches).toHaveLength(1);
  await enterBarcode(scanner, '012345678905');
  await expect(repeat.getByLabel('Quantity', { exact: true })).toHaveValue('1');
  await expect(repeat.getByLabel('Expiration (optional)', { exact: true })).toHaveValue('');
  await repeat.getByRole('button', { name: 'Fridge', exact: true }).click();
  await repeat.getByRole('button', { name: 'Add & scan next', exact: true }).click();
  await expect(repeat).not.toBeVisible();
  await scanner.getByRole('button', { name: 'Done scanning', exact: true }).click();
  await expect(scanner).not.toBeVisible();
  await expect(page.locator('.item-quantity')).toHaveText(/^2 package(?:\s*−1)?$/);
  await page.reload();
  await page.getByRole('button', { name: 'Scan groceries', exact: true }).click();
  await enterBarcode(scanner, '012345678905');
  await expect(repeat.getByRole('combobox', { name: 'Item name', exact: true })).toHaveValue(
    'Oat milk',
  );
  expect(lookups).toBe(1);
  await repeat.getByRole('button', { name: 'Fridge', exact: true }).click();
  await repeat.getByRole('button', { name: 'Add & scan next', exact: true }).click();
  await expect(repeat).not.toBeVisible();
  await scanner.getByRole('button', { name: 'Done scanning', exact: true }).click();
  expect((await storedKitchen(page)).batches).toHaveLength(3);
  await expect(page.locator('.item-quantity')).toHaveText(/^3 package(?:\s*−1)?$/);
});

test('tools and backup restore work with explicit replacement', async ({ page }) => {
  await page.getByRole('button', { name: /Kitchen tools|^Tools$/ }).click();
  await page.getByRole('combobox', { name: 'Tool name' }).fill('Air fryer');
  await page.getByRole('option', { name: 'Air fryer', exact: true }).click();
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
  await page.getByRole('combobox', { name: 'Sort inventory' }).click();
  await page.getByRole('option', { name: 'Expiration date', exact: true }).click();
  await expect(page.locator('.item-name strong').first()).toHaveText('Zucchini');
  await page.getByRole('button', { name: /Missing a date/ }).click();
  await expect(page.locator('.item-name strong')).toHaveText('Apples');
});

async function navigate(page: Page, name: 'Inventory' | 'Recipes' | 'Shopping list' | 'Gemini') {
  await page
    .getByRole('button', {
      name:
        name === 'Shopping list'
          ? /^(?:Shopping list|Shop)$/
          : name === 'Inventory'
            ? /^Inventory$/
            : name === 'Gemini'
              ? /^Gemini$/
              : /^Recipes$/,
    })
    .filter({ visible: true })
    .first()
    .click();
}
async function saveOwnRecipe(page: Page, title: string, quantity: number) {
  await page.getByRole('button', { name: 'Your own recipe', exact: true }).click();
  const editor = page.getByRole('dialog', { name: 'Review your recipe' });
  await editor.getByLabel('Recipe name', { exact: true }).fill(title);
  await editor.getByLabel('Original recipe servings', { exact: false }).fill('2');
  await editor.getByRole('combobox', { name: 'Ingredient', exact: true }).fill('Chicken breast');
  await editor.getByLabel('Amount', { exact: true }).fill(String(quantity));
  await editor.getByRole('combobox', { name: 'Unit', exact: true }).fill('g');
  await editor
    .getByLabel('Cooking steps', { exact: true })
    .fill('Prepare the ingredients.\nCook the chicken thoroughly.');
  await editor.getByRole('button', { name: 'Save recipe', exact: true }).click();
  await expect(editor).not.toBeVisible();
  const card = page
    .locator('.recipe-card')
    .filter({ has: page.getByRole('heading', { name: title, exact: true }) });
  await card.getByRole('button', { name: 'View recipe', exact: true }).click();
  const detail = page.getByRole('dialog', { name: title, exact: true });
  await detail.getByRole('button', { name: 'Add to meal plan', exact: true }).click();
  await expect(page.locator('.toast')).toContainText('Added to your meal plan.');
  await detail.getByRole('button', { name: 'Close', exact: true }).click();
}

test('uses tappable in-app suggestions with storage first and editable units', async ({ page }) => {
  await page.getByRole('button', { name: 'Add item', exact: true }).click();
  const editor = page.getByRole('dialog', { name: 'Add an ingredient' });
  const name = editor.getByRole('combobox', { name: 'Item name', exact: true });
  const storageBox = await editor.locator('.location-picker').boundingBox();
  const nameBox = await name.boundingBox();
  expect(storageBox!.y).toBeLessThan(nameBox!.y);
  await name.fill('ban');
  const option = editor.getByRole('option', { name: 'Bananas', exact: true });
  await expect(option).toBeVisible();
  await option.click();
  await expect(name).toHaveValue('Bananas');
  await expect(name).toHaveAttribute('aria-expanded', 'false');
  await editor.getByRole('button', { name: 'Pantry', exact: true }).click();
  await editor.getByLabel('Quantity', { exact: true }).fill('3');
  const unit = editor.getByRole('combobox', { name: 'Unit', exact: true });
  await unit.fill('ea');
  await editor.getByRole('option', { name: 'each', exact: true }).click();
  await editor.getByRole('button', { name: 'Add to inventory', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Pantry', exact: true })).toBeVisible();
  await expect(page.locator('.item-quantity')).toHaveText(/^3 each(?:\s*−1)?$/);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('deducts one with undo and retains flexible quantity entry', async ({ page }) => {
  await addItem(page, 'Apples', '3');
  await page.getByRole('button', { name: 'Use one Apples', exact: true }).click();
  await expect(page.locator('.item-quantity')).toHaveText(/^2 each(?:\s*−1)?$/);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(page.locator('.item-quantity')).toHaveText(/^3 each(?:\s*−1)?$/);
  await page.getByRole('button', { name: 'Show batches for Apples' }).click();
  await page.getByRole('button', { name: 'Used some', exact: true }).click();
  await page.getByRole('spinbutton').fill('2');
  await page.getByRole('button', { name: 'Update quantity', exact: true }).click();
  await expect(page.locator('.item-quantity')).toHaveText(/^1 each(?:\s*−1)?$/);
});

test('persists the automatic-next scanner preference', async ({ page }) => {
  await page.getByRole('button', { name: 'Scan groceries', exact: true }).click();
  const scanner = page.getByRole('dialog', { name: 'Stock up, simply' });
  const autoNext = scanner.getByRole('switch', { name: /Automatically scan next item/ });
  await expect(autoNext).toBeChecked();
  await autoNext.uncheck();
  await scanner.getByRole('button', { name: 'Close', exact: true }).click();
  await page.reload();
  await page.getByRole('button', { name: 'Scan groceries', exact: true }).click();
  await expect(autoNext).not.toBeChecked();
});

test('searches online recipes, compares quantities, and shows cooking steps', async ({ page }) => {
  await page.route('https://www.themealdb.com/api/**', (route) => {
    const address = new URL(route.request().url());
    const meal = {
      idMeal: '77701',
      strMeal: 'Weeknight chicken',
      strIngredient1: 'Chicken breast',
      strMeasure1: '400g',
      strInstructions: 'Prepare the chicken.\r\nCook thoroughly.',
      strSource: 'https://example.com/weeknight-chicken',
    };
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        meals: address.pathname.endsWith('filter.php')
          ? [{ idMeal: '77701', strMeal: meal.strMeal }]
          : [meal],
      }),
    });
  });
  await addItem(page, 'Chicken breast', '500', '', '2026-01-01', 'g');
  await navigate(page, 'Recipes');
  await page.getByRole('combobox', { name: 'Recipe source', exact: true }).click();
  await page.getByRole('option', { name: 'TheMealDB', exact: true }).click();
  await page.getByRole('textbox', { name: 'Find recipes', exact: true }).fill('Weeknight chicken');
  await page.getByRole('button', { name: 'Search TheMealDB', exact: true }).click();
  const card = page
    .locator('.recipe-card')
    .filter({ has: page.getByRole('heading', { name: 'Weeknight chicken', exact: true }) });
  await expect(card.getByText('Ready to cook', { exact: true })).toBeVisible();
  await card.getByRole('button', { name: 'View recipe', exact: true }).click();
  const detail = page.getByRole('dialog', { name: 'Weeknight chicken', exact: true });
  await expect(detail.getByText('400 g', { exact: true })).toBeVisible();
  await expect(detail.getByText('On hand', { exact: true })).toBeVisible();
  await expect(detail.getByText('Cook thoroughly.', { exact: true })).toBeVisible();
  await expect(detail.getByText(/Record the original yield before scaling/)).toBeVisible();
  await detail.getByLabel('Minutes for step 1', { exact: true }).fill('1');
  await detail.getByRole('button', { name: 'Start', exact: true }).first().click();
  await expect(detail.getByRole('timer')).toBeVisible();
  await detail.getByRole('checkbox', { name: 'Keep screen awake while cooking' }).check();
});

test('combines saved recipes into one shopping shortage and adds a purchase once', async ({
  page,
}) => {
  await addItem(page, 'Chicken breast', '500', '', '2026-01-01', 'g');
  await navigate(page, 'Recipes');
  await saveOwnRecipe(page, 'Chicken bowl', 400);
  await saveOwnRecipe(page, 'Chicken salad', 300);
  await navigate(page, 'Shopping list');
  await expect(page.getByRole('button', { name: 'Make shopping list', exact: true })).toBeEnabled();
  await expect(page.locator('.shopping-row')).toHaveCount(0);
  await page.getByRole('button', { name: 'Make shopping list', exact: true }).click();
  const row = page.locator('.shopping-row');
  await expect(row).toHaveCount(1);
  await expect(row.getByText('Chicken breast', { exact: true })).toBeVisible();
  await expect(row.getByText('200 g', { exact: true })).toBeVisible();
  await row.getByRole('button', { name: 'Add purchase', exact: true }).click();
  const editor = page.getByRole('dialog', { name: 'Add an ingredient' });
  await expect(editor.getByLabel('Quantity', { exact: true })).toHaveValue('200');
  await expect(editor.getByRole('combobox', { name: 'Unit', exact: true })).toHaveValue('g');
  await editor.getByRole('button', { name: 'Add to inventory', exact: true }).click();
  await expect(row.getByRole('button', { name: 'Added', exact: true })).toBeDisabled();
  await expect(row.getByRole('checkbox', { name: 'Bought Chicken breast' })).toBeChecked();
  await page.reload();
  await navigate(page, 'Shopping list');
  await expect(page.locator('.plan-row')).toHaveCount(2);
  await page.getByRole('button', { name: 'Make shopping list', exact: true }).click();
  await expect(page.locator('.shopping-row')).toHaveCount(0);
  await navigate(page, 'Recipes');
  const card = page
    .locator('.recipe-card')
    .filter({ has: page.getByRole('heading', { name: 'Chicken bowl', exact: true }) });
  await card.getByRole('button', { name: 'View recipe', exact: true }).click();
  await page
    .getByRole('dialog', { name: 'Chicken bowl', exact: true })
    .getByRole('button', { name: 'Finished cooking · review inventory', exact: true })
    .click();
  const review = page.getByRole('dialog', { name: 'Finish cooking', exact: true });
  await expect(
    review.getByRole('spinbutton', {
      name: 'Amount used from Chicken breast, bought 2026-01-01 (g)',
      exact: true,
    }),
  ).toHaveValue('400');
  await review.getByRole('button', { name: 'Update inventory', exact: true }).click();
  await expect(review).not.toBeVisible();
  await navigate(page, 'Inventory');
  await expect(page.locator('.item-quantity')).toHaveText('300 g');
});

test('imports pasted recipes through ingredient review without Gemini', async ({ page }) => {
  await navigate(page, 'Recipes');
  await page.getByRole('button', { name: 'Import recipe', exact: true }).click();
  const importer = page.getByRole('dialog', { name: 'Bring a recipe into Mise' });
  await importer
    .getByLabel('Recipe text', { exact: true })
    .fill(
      'Egg toast\nServings: 1\nIngredients\n2 eggs\n1 slice bread\nSteps\nFry the eggs.\nToast the bread.',
    );
  await importer.getByRole('button', { name: 'Review pasted recipe', exact: true }).click();
  const editor = page.getByRole('dialog', { name: 'Review your recipe' });
  await expect(editor.getByLabel('Recipe name', { exact: true })).toHaveValue('Egg toast');
  await expect(
    editor.getByRole('combobox', { name: 'Ingredient', exact: true }).first(),
  ).toHaveValue('eggs');
  await editor.getByRole('button', { name: 'Save recipe', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Egg toast', exact: true })).toBeVisible();
  await page.reload();
  await navigate(page, 'Recipes');
  await page.getByRole('button', { name: 'Saved recipes', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Egg toast', exact: true })).toBeVisible();
});

test('browses the real bundled cookbook, loads more, and finds a familiar recipe with source attribution', async ({
  page,
}) => {
  test.setTimeout(60_000);
  await navigate(page, 'Recipes');
  await expect(page.locator('.library-intro')).toContainText(/\d[\d,]* built-in recipes/);
  const recipes = page.locator('.kitchen-hub .recipe-grid .recipe-card');
  await expect(recipes).toHaveCount(24);
  const firstPage = await recipes.locator('h3').allTextContents();
  await page.getByRole('button', { name: 'Load more recipes', exact: true }).click();
  await expect(recipes).toHaveCount(48);
  expect((await recipes.locator('h3').allTextContents()).slice(0, 24)).toEqual(firstPage);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page
    .getByRole('textbox', { name: 'Find recipes', exact: true })
    .fill('Basic Scrambled Eggs');
  await page.getByRole('button', { name: 'Search library', exact: true }).click();
  const card = recipes.filter({
    has: page.getByRole('heading', { name: 'Basic Scrambled Eggs', exact: true }),
  });
  await expect(card).toBeVisible();
  await card.getByRole('button', { name: 'View recipe', exact: true }).click();
  const detail = page.getByRole('dialog', { name: 'Basic Scrambled Eggs', exact: true });
  await expect(
    detail.getByRole('link', { name: 'Original recipe source', exact: true }),
  ).toHaveAttribute('href', /en.wikibooks.org\/w\/index.php\?oldid=\d+/);
  await expect(detail.getByText(/Wikibooks contributors/)).toBeVisible();
  await expect(detail.getByRole('link', { name: 'CC BY-SA 4.0', exact: true })).toHaveAttribute(
    'href',
    'https://creativecommons.org/licenses/by-sa/4.0/',
  );
  await expect(detail.locator('.recipe-steps > li')).not.toHaveCount(0);
});

test('keeps local browsing during provider failure and saves licensed recipes into the meal plan and backup', async ({
  page,
}) => {
  await mockCookbook(page);
  await page.route('https://www.themealdb.com/api/**', (route) => route.abort());
  await addItem(page, 'Rice', '50', '', '2026-01-01', 'g');
  await navigate(page, 'Recipes');
  const recipes = page.locator('.kitchen-hub .recipe-grid .recipe-card');
  await expect(recipes).toHaveCount(24);
  await page.getByRole('combobox', { name: 'Recipe source', exact: true }).click();
  await page.getByRole('option', { name: 'TheMealDB', exact: true }).click();
  await page.getByRole('button', { name: 'Search TheMealDB', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('unavailable');
  await expect(recipes).toHaveCount(0);
  await page.getByRole('combobox', { name: 'Recipe source', exact: true }).click();
  await page.getByRole('option', { name: 'Your cookbook', exact: true }).click();
  await expect(recipes).toHaveCount(24);
  await page.getByRole('button', { name: 'Load more recipes', exact: true }).click();
  await expect(recipes).toHaveCount(48);
  await page.getByRole('button', { name: 'Load more recipes', exact: true }).click();
  await expect(recipes).toHaveCount(60);
  await expect(page.getByRole('button', { name: 'Load more recipes', exact: true })).toHaveCount(0);
  const category = page.getByRole('combobox', { name: 'Recipe category', exact: true });
  await page.getByText('Refine recipes', { exact: true }).click();
  await category.click();
  await page.getByRole('option', { name: 'Breakfast', exact: true }).click();
  await expect(recipes).toHaveCount(20);
  await expect(recipes.first()).toContainText('Egg breakfast');
  await page.getByRole('button', { name: 'Clear filters', exact: true }).click();
  await expect(recipes).toHaveCount(24);
  await page.getByRole('textbox', { name: 'Find recipes', exact: true }).fill('Rice dinner 01');
  await expect(recipes).toHaveCount(1);
  await recipes.first().getByRole('button', { name: 'View recipe', exact: true }).click();
  const detail = page.getByRole('dialog', { name: 'Rice dinner 01', exact: true });
  await detail.getByRole('button', { name: 'Add to meal plan', exact: true }).click();
  await expect(page.locator('.toast')).toContainText('Added to your meal plan');
  await detail.getByRole('button', { name: 'Close', exact: true }).click();
  await navigate(page, 'Shopping list');
  await page.getByRole('button', { name: 'Make shopping list', exact: true }).click();
  await expect(page.locator('.shopping-row')).toContainText('50 g');
  expect((await storedKitchen(page)).recipes?.[0].source.license).toBe('CC BY-SA 4.0');
  await page.getByRole('button', { name: 'Local only', exact: true }).click();
  const download = page.waitForEvent('download');
  await page
    .getByRole('dialog', { name: 'Your kitchen, your way' })
    .getByRole('button', { name: 'Download backup', exact: true })
    .click();
  const backup = JSON.parse(await readFile((await (await download).path())!, 'utf8')) as {
    inventory: InventoryState;
  };
  expect(backup.inventory.recipes?.[0].source).toMatchObject({
    type: 'wikibooks',
    license: 'CC BY-SA 4.0',
    attribution: 'Wikibooks contributors; adapted for Mise.',
  });
  await page
    .getByRole('dialog', { name: 'Your kitchen, your way' })
    .getByRole('button', { name: 'Close', exact: true })
    .click();
  await page.route('**/data/wikibooks-recipes.json', (route) => route.abort());
  await page.reload();
  await navigate(page, 'Recipes');
  await expect(page.getByRole('heading', { name: 'Rice dinner 01', exact: true })).toBeVisible();
});

test('ignores an old online recipe search after returning to the local cookbook', async ({
  page,
}) => {
  await mockCookbook(page);
  let release: () => void = () => {};
  const delayed = new Promise<void>((resolve) => {
    release = resolve;
  });
  let requested: () => void = () => {};
  const started = new Promise<void>((resolve) => {
    requested = resolve;
  });
  let fulfilled: () => void = () => {};
  const finished = new Promise<void>((resolve) => {
    fulfilled = resolve;
  });
  await page.route('https://www.themealdb.com/api/**', async (route) => {
    requested();
    await delayed;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        meals: [
          {
            idMeal: '999',
            strMeal: 'Old rice search',
            strIngredient1: 'Rice',
            strMeasure1: '100g',
            strInstructions: 'Cook the rice.',
          },
        ],
      }),
    });
    fulfilled();
  });
  await navigate(page, 'Recipes');
  await expect(page.locator('.recipe-card')).toHaveCount(24);
  const query = page.getByRole('textbox', { name: 'Find recipes', exact: true });
  await page.getByRole('combobox', { name: 'Recipe source', exact: true }).click();
  await page.getByRole('option', { name: 'TheMealDB', exact: true }).click();
  await query.fill('rice');
  await page.getByRole('button', { name: 'Search TheMealDB', exact: true }).click();
  await started;
  await page.getByRole('combobox', { name: 'Recipe source', exact: true }).click();
  await page.getByRole('option', { name: 'Your cookbook', exact: true }).click();
  await query.fill('egg');
  await expect(page.locator('.recipe-card')).toHaveCount(20);
  release();
  await finished;
  await page.getByRole('button', { name: 'Clear filters', exact: true }).click();
  await expect(page.locator('.library-results')).toContainText(/24.*60/);
  await expect(page.getByRole('heading', { name: 'Old rice search', exact: true })).toHaveCount(0);
});

async function storedKitchen(page: Page): Promise<InventoryState> {
  return page.evaluate(() => {
    const document = JSON.parse(localStorage.getItem('kitchen-wrapper.inventory.v1') ?? '{}') as {
      state: InventoryState;
    };
    return document.state;
  });
}

test('keeps different barcodes with the same name and remembers reviewed staple details', async ({
  page,
}) => {
  let lookups = 0;
  await page.route('https://world.openfoodfacts.org/api/**', (route) => {
    lookups++;
    return route.fulfill({ status: 404, contentType: 'application/json', body: '{}' });
  });
  await page.getByRole('button', { name: 'Scan groceries', exact: true }).click();
  const scanner = page.getByRole('dialog', { name: 'Stock up, simply', exact: true });
  for (const [index, barcode] of ['012345678905', '4006381333931'].entries()) {
    await enterBarcode(scanner, barcode);
    const unknown = page.getByRole('dialog', { name: 'Product not found', exact: true });
    await expect(unknown).toBeVisible();
    await unknown.getByRole('combobox', { name: 'Item name', exact: true }).fill('Pantry salt');
    await unknown.getByRole('button', { name: 'Use product name', exact: true }).click();
    await unknown.getByRole('button', { name: 'Pantry', exact: true }).click();
    if (index === 0) {
      await unknown.getByRole('button', { name: 'Edit details', exact: true }).click();
      const details = page.getByRole('dialog', { name: 'Edit scanned item', exact: true });
      await details.getByLabel('Quantity', { exact: true }).fill('');
      await details.getByRole('switch', { name: /Keep as a staple/ }).check();
      await details.getByRole('combobox', { name: 'Stock level', exact: true }).click();
      await page
        .getByRole('dialog', { name: 'Stock level', exact: true })
        .getByRole('option', { name: 'Running low', exact: true })
        .click();
      await details.getByRole('button', { name: 'Return to review', exact: true }).click();
      await expect(details).not.toBeVisible();
      await expect(unknown.getByLabel('Quantity', { exact: true })).toHaveValue('');
    }
    await unknown.getByRole('button', { name: 'Add & scan next', exact: true }).click();
    await expect(unknown).not.toBeVisible();
  }
  await scanner.getByRole('button', { name: 'Done scanning', exact: true }).click();
  const state = await storedKitchen(page);
  expect(state.products).toHaveLength(2);
  expect(new Set(state.products.map((product) => product.barcode))).toEqual(
    new Set(['0012345678905', '4006381333931']),
  );
  const staple = state.products.find((product) => product.barcode === '0012345678905')!;
  expect(staple.isStaple).toBe(true);
  expect(state.batches.find((batch) => batch.productId === staple.id)).toMatchObject({
    quantity: null,
    unit: 'package',
    location: 'pantry',
    stapleStatus: 'low',
  });
  await page.reload();
  await page.getByRole('button', { name: 'Scan groceries', exact: true }).click();
  for (const barcode of ['012345678905', '4006381333931']) {
    await enterBarcode(scanner, barcode);
    const repeat = page.getByRole('dialog', { name: 'Add another package?', exact: true });
    await expect(repeat.getByRole('combobox', { name: 'Item name', exact: true })).toHaveValue(
      'Pantry salt',
    );
    await expect(repeat.getByLabel('Quantity', { exact: true })).toHaveValue('1');
    await repeat.getByRole('button', { name: 'Pantry', exact: true }).click();
    await repeat.getByRole('button', { name: 'Add & scan next', exact: true }).click();
    await expect(repeat).not.toBeVisible();
  }
  expect(lookups).toBe(2);
  expect((await storedKitchen(page)).batches).toHaveLength(4);
  await scanner.getByRole('button', { name: 'Done scanning', exact: true }).click();
});

test('quick-add keeps a weighted ingredient unit and asks for its new amount', async ({ page }) => {
  await addItem(page, 'Chicken breast', '500', '', '2026-01-01', 'g');
  await navigate(page, 'Shopping list');
  const quick = page.locator('.quick-shopping');
  await quick
    .getByRole('combobox', { name: 'Quick-add ingredient', exact: true })
    .fill('Chicken breast');
  await quick.getByRole('option', { name: 'Chicken breast', exact: true }).click();
  await quick.getByRole('button', { name: 'Add to inventory', exact: true }).click();
  const editor = page.getByRole('dialog', { name: 'Add an ingredient' });
  await expect(editor.getByRole('combobox', { name: 'Unit', exact: true })).toHaveValue('g');
  await expect(editor.getByLabel('Quantity', { exact: true })).toHaveValue('');
  await editor.getByRole('button', { name: 'Add to inventory', exact: true }).click();
  await expect(editor).not.toBeVisible();
  const state = await storedKitchen(page);
  expect(state.batches.map((batch) => batch.unit)).toEqual(['g', 'g']);
  expect(state.batches.map((batch) => batch.quantity)).toEqual([500, null]);
});

test('locks barcode entry during lookup and saves only reviewed purchases', async ({ page }) => {
  let release: () => void = () => {};
  const delayed = new Promise<void>((resolve) => {
    release = resolve;
  });
  let pendingStarted = false;
  await page.route('https://world.openfoodfacts.org/api/**', async (route) => {
    if (route.request().url().includes('4006381333931')) {
      pendingStarted = true;
      await delayed;
    }
    const name = route.request().url().includes('4006381333931') ? 'Rice' : 'Oat milk';
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ product: { product_name: name } }),
    });
  });
  await page.getByRole('button', { name: 'Scan groceries', exact: true }).click();
  const scanner = page.getByRole('dialog', { name: 'Stock up, simply', exact: true });
  await enterBarcode(scanner, '012345678905');
  const review = page.getByRole('dialog', { name: 'Review scanned item', exact: true });
  await expect(review.getByRole('combobox', { name: 'Item name', exact: true })).toHaveValue(
    'Oat milk',
  );
  await review.getByRole('button', { name: 'Fridge', exact: true }).click();
  await review.getByRole('button', { name: 'Add & scan next', exact: true }).click();
  await expect(review).not.toBeVisible();
  await enterBarcode(scanner, '4006381333931');
  await expect.poll(() => pendingStarted).toBe(true);
  try {
    await expect(scanner.getByRole('button', { name: 'Add', exact: true })).toBeDisabled();
    expect((await storedKitchen(page)).products.map((product) => product.name)).toEqual([
      'Oat milk',
    ]);
    expect((await storedKitchen(page)).batches).toHaveLength(1);
  } finally {
    release();
  }
  await expect(review.getByRole('combobox', { name: 'Item name', exact: true })).toHaveValue(
    'Rice',
  );
  expect((await storedKitchen(page)).batches).toHaveLength(1);
  await review.getByRole('button', { name: 'Pantry', exact: true }).click();
  await review.getByRole('button', { name: 'Add & scan next', exact: true }).click();
  await expect(review).not.toBeVisible();
  await scanner.getByRole('button', { name: 'Done scanning', exact: true }).click();
  expect((await storedKitchen(page)).products.map((product) => product.name)).toEqual([
    'Oat milk',
    'Rice',
  ]);
  expect((await storedKitchen(page)).batches).toHaveLength(2);
});

test('bulk scanning remembers its destination, adds clear matches automatically, and reviews duplicates and unknown products', async ({
  page,
}) => {
  let lookups = 0;
  await page.route('https://world.openfoodfacts.org/api/**', (route) => {
    lookups++;
    return route.request().url().includes('0012345678905')
      ? route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ product: { product_name: 'Rice', quantity: '500 g' } }),
        })
      : route.fulfill({ status: 404, contentType: 'application/json', body: '{}' });
  });
  await page.getByRole('button', { name: 'Scan groceries', exact: true }).click();
  const scanner = page.getByRole('dialog', { name: 'Stock up, simply', exact: true });
  await scanner.getByRole('button', { name: 'Bulk scan', exact: true }).click();
  await scanner.getByRole('button', { name: 'Freezer', exact: true }).click();
  await scanner.getByRole('checkbox', { name: /Add clear matches automatically/ }).check();
  await enterBarcode(scanner, '012345678905');
  await expect(scanner.locator('.grocery-recent-row strong')).toHaveText('Rice');
  await expect(
    page.getByRole('dialog', { name: 'Review scanned item', exact: true }),
  ).not.toBeVisible();
  expect((await storedKitchen(page)).batches[0]).toMatchObject({
    quantity: 500,
    unit: 'g',
    location: 'freezer',
  });
  await scanner.getByRole('button', { name: 'Done scanning', exact: true }).click();
  await page.getByRole('button', { name: 'Show batches for Rice', exact: true }).click();
  await page.getByRole('button', { name: 'Used some', exact: true }).click();
  await page.getByRole('spinbutton').fill('450');
  await page.getByRole('button', { name: 'Update quantity', exact: true }).click();
  await expect.poll(async () => (await storedKitchen(page)).batches[0].quantity).toBe(50);
  await expect(page.getByRole('dialog', { name: 'Update Rice', exact: true })).not.toBeVisible();
  await page.getByRole('button', { name: 'Scan groceries', exact: true }).click();
  await enterBarcode(scanner, '012345678905');
  const duplicate = page.getByRole('dialog', { name: 'Add another package?', exact: true });
  await expect(duplicate.getByLabel('Quantity', { exact: true })).toHaveValue('500');
  await expect(duplicate.getByRole('combobox', { name: 'Unit', exact: true })).toHaveValue('g');
  await expect(duplicate.getByRole('button', { name: 'Freezer', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await duplicate.getByRole('button', { name: 'Add & scan next', exact: true }).click();
  await expect(duplicate).not.toBeVisible();
  await enterBarcode(scanner, '4006381333931');
  const unknown = page.getByRole('dialog', { name: 'Product not found', exact: true });
  await expect(unknown.getByRole('button', { name: 'Freezer', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await unknown
    .getByRole('combobox', { name: 'Item name', exact: true })
    .fill('Frozen vegetable blend');
  await unknown.getByRole('button', { name: 'Use product name', exact: true }).click();
  await unknown.getByLabel('Expiration (optional)', { exact: true }).fill('2027-01-01');
  await unknown.getByRole('button', { name: 'Add & scan next', exact: true }).click();
  await expect(unknown).not.toBeVisible();
  expect((await storedKitchen(page)).batches.map((batch) => batch.location)).toEqual([
    'freezer',
    'freezer',
    'freezer',
  ]);
  expect(lookups).toBe(2);
  await scanner.getByRole('button', { name: 'Done scanning', exact: true }).click();
  await page.reload();
  await page.getByRole('button', { name: 'Scan groceries', exact: true }).click();
  await expect(scanner.getByRole('button', { name: 'Bulk scan', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(scanner.getByRole('button', { name: 'Freezer', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(
    scanner.getByRole('checkbox', { name: /Add clear matches automatically/ }),
  ).toBeChecked();
});

test('retains Gemini setup after failed checks, returning from chat and reload, then connects with a bare hostname', async ({
  page,
}) => {
  const hostname = 'mise-test.example.workers.dev';
  const wrongToken = 'a'.repeat(43);
  const correctToken = 'b'.repeat(43);
  let healthChecks = 0;
  let chatRequests = 0;
  await page.route(`https://${hostname}/**`, (route) => {
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204 });
    const paired = route.request().headers().authorization === `Bearer ${correctToken}`;
    if (route.request().url().endsWith('/health')) {
      healthChecks++;
      return route.fulfill({
        status: paired ? 200 : 401,
        contentType: 'application/json',
        body: JSON.stringify(
          paired
            ? { ok: true, model: 'gemini-3.5-flash-lite' }
            : {
                error: {
                  code: 'unauthorized',
                  message: 'The Mise access token is missing or incorrect.',
                },
              },
        ),
      });
    }
    expect(paired).toBe(true);
    chatRequests++;
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ message: 'Ready to help with dinner.', recipes: [], warnings: [] }),
    });
  });
  await page.getByRole('button', { name: 'Local only', exact: true }).click();
  const settings = page.getByRole('dialog', { name: 'Your kitchen, your way' });
  const address = settings.getByLabel('Backend address', { exact: true });
  const token = settings.getByLabel('Pairing token', { exact: true });
  const connect = settings.getByRole('button', { name: 'Save & check connection', exact: true });
  await address.fill('example.workers.dev');
  await token.fill(wrongToken);
  await connect.click();
  await expect(settings.getByRole('status')).toContainText('Include the Worker name');
  expect(healthChecks).toBe(0);
  await address.fill(hostname);
  await connect.click();
  await expect(settings.getByRole('status')).toContainText('access token is missing or incorrect');
  expect(healthChecks).toBe(1);
  expect(await page.evaluate(() => localStorage.getItem('mise.gemini.connection.v1'))).toBeNull();
  await settings.getByRole('button', { name: 'Close', exact: true }).click();
  await navigate(page, 'Gemini');
  await page
    .getByRole('textbox', { name: 'Message Gemini', exact: true })
    .fill('Help with dinner.');
  await page.getByRole('button', { name: 'Ask Gemini', exact: true }).click();
  await expect(settings).toBeVisible();
  await expect(address).toHaveValue(hostname);
  await expect(token).toHaveValue(wrongToken);
  expect(chatRequests).toBe(0);
  await page.reload();
  await page.getByRole('button', { name: 'Local only', exact: true }).click();
  await expect(address).toHaveValue(hostname);
  await expect(token).toHaveValue(wrongToken);
  const download = page.waitForEvent('download');
  await settings.getByRole('button', { name: 'Download backup', exact: true }).click();
  const backup = await readFile((await (await download).path())!, 'utf8');
  expect(backup).not.toContain(wrongToken);
  expect(backup).not.toContain(hostname);
  await token.fill(correctToken);
  await connect.click();
  await expect(settings.getByRole('status')).toContainText('Backend connected');
  await expect(address).toHaveValue(`https://${hostname}`);
  expect(healthChecks).toBe(2);
  expect(
    await page.evaluate(() => localStorage.getItem('mise.gemini.connection-draft.v1')),
  ).toBeNull();
  await settings.getByRole('button', { name: 'Close', exact: true }).click();
  await navigate(page, 'Gemini');
  await page
    .getByRole('textbox', { name: 'Message Gemini', exact: true })
    .fill('Help with dinner.');
  await page.getByRole('button', { name: 'Ask Gemini', exact: true }).click();
  await expect(page.getByText('Ready to help with dinner.', { exact: true })).toBeVisible();
  expect(chatRequests).toBe(1);
  await page.getByRole('button', { name: 'Local only', exact: true }).click();
  await expect(settings.getByText(/Connection saved on this device/)).toBeVisible();
});

test('uses mocked Gemini recipes, keeps follow-up context, bounds history, and excludes pairing from backups', async ({
  page,
}) => {
  test.setTimeout(60_000);
  const backend = 'https://mise-test.example.workers.dev';
  const token = 'TEST_MISE_PAIRING_TOKEN_12345678901234567890';
  const requests: {
    message: string;
    inventory: string;
    recipe?: string;
    history?: { role: string; text: string }[];
  }[] = [];
  let healthChecks = 0;
  const headers = {
    'Access-Control-Allow-Origin': 'http://127.0.0.1:5173',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  };
  await page.route(`${backend}/**`, (route) => {
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
    if (route.request().url().endsWith('/health')) {
      healthChecks++;
      return route.fulfill({
        status: 200,
        headers,
        contentType: 'application/json',
        body: JSON.stringify({ ok: true, model: 'gemini-3.5-flash-lite' }),
      });
    }
    const request = route.request().postDataJSON() as (typeof requests)[number];
    requests.push(request);
    expect(route.request().headers().authorization).toBe(`Bearer ${token}`);
    const reply =
      requests.length === 1
        ? {
            message: '',
            warnings: [],
            recipes: [
              {
                title: 'Free Gemini chicken',
                servings: 2,
                ingredients: [
                  {
                    name: 'Chicken breast',
                    quantity: 400,
                    unit: 'g',
                    original: '',
                    optional: false,
                  },
                ],
                steps: ['Cook the chicken thoroughly.'],
              },
            ],
          }
        : {
            message:
              requests.length === 2
                ? 'Cook in batches. '.repeat(900)
                : 'Your recipe context is still attached.',
            recipes: [],
            warnings: [],
          };
    return route.fulfill({
      status: 200,
      headers,
      contentType: 'application/json',
      body: JSON.stringify(reply),
    });
  });
  await page.getByRole('button', { name: 'Local only', exact: true }).click();
  const settings = page.getByRole('dialog', { name: 'Your kitchen, your way' });
  await settings.getByLabel('Backend address', { exact: true }).fill(backend);
  await settings.getByLabel('Pairing token', { exact: true }).fill(token);
  await settings.getByRole('button', { name: 'Save & check connection', exact: true }).click();
  await expect(settings.getByText(/Backend connected/)).toBeVisible();
  expect(healthChecks).toBe(1);
  await settings.getByRole('button', { name: 'Close', exact: true }).click();
  await navigate(page, 'Gemini');
  const message = page.getByRole('textbox', { name: 'Message Gemini', exact: true });
  const ask = page.getByRole('button', { name: 'Ask Gemini', exact: true });
  await message.fill('Make me a familiar chicken recipe.');
  await ask.click();
  const card = page
    .locator('.ai-recipes .recipe-card')
    .filter({ has: page.getByRole('heading', { name: 'Free Gemini chicken', exact: true }) });
  await expect(card).toBeVisible();
  await card.getByRole('button', { name: 'Save Free Gemini chicken', exact: true }).click();
  const editor = page.getByRole('dialog', { name: 'Review your recipe' });
  await editor.getByRole('button', { name: 'Save recipe', exact: true }).click();
  await expect(editor).not.toBeVisible();
  await expect(
    card.getByRole('button', { name: 'Free Gemini chicken saved', exact: true }),
  ).toBeDisabled();
  expect((await storedKitchen(page)).recipes?.[0].ingredients[0].original).toBeUndefined();
  await message.fill('Can I use my frying pan?');
  await ask.click();
  await expect(
    page.locator('.chat-message.assistant').filter({ hasText: 'Cook in batches.' }),
  ).toBeVisible();
  await expect(card).toBeVisible();
  await message.fill('How should I prepare the next portion?');
  await ask.click();
  await expect(
    page.getByText('Your recipe context is still attached.', { exact: true }),
  ).toBeVisible();
  expect(requests).toHaveLength(3);
  expect(requests[1].recipe).toContain('Free Gemini chicken');
  expect(requests[2].history?.every((item) => item.text.length <= 6000)).toBe(true);
  expect(
    requests[2].history?.reduce((total, item) => total + item.text.length, 0),
  ).toBeLessThanOrEqual(30000);
  for (const request of requests) {
    expect(
      Object.keys(request).every((key) =>
        ['message', 'inventory', 'tools', 'recipe', 'history'].includes(key),
      ),
    ).toBe(true);
    expect(JSON.stringify(request)).not.toContain(token);
  }
  await page.getByRole('button', { name: 'Local only', exact: true }).click();
  const download = page.waitForEvent('download');
  await settings.getByRole('button', { name: 'Download backup', exact: true }).click();
  const file = await (await download).path();
  const backup = await readFile(file!, 'utf8');
  expect(backup).toContain('Free Gemini chicken');
  expect(backup).not.toContain(token);
  expect(backup).not.toContain(backend);
});
