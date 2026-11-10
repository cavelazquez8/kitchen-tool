import { expect, test, type Locator, type Page } from '@playwright/test';
import type { AiChatRequest, GeminiConnection } from '../src/ai/protocol';
import {
  GEMINI_PRICING_URL,
  type GeminiModelCatalog,
  type GeminiModelCatalogEntry,
} from '../src/ai/models';

const connectionKey = 'mise.gemini.connection.v1';
const preferencesKey = 'mise.gemini.models.v1';
const worker = 'https://mise.example.workers.dev';
const nextWorker = 'https://new.example.workers.dev';
const token = 'model_discovery_test_' + 'a'.repeat(35);
const connection: GeminiConnection = { url: worker, token, model: 'gemini-3.1-flash-lite' };

function model(
  id: string,
  name: string,
  freeTier: GeminiModelCatalogEntry['freeTier'] = 'verified',
): GeminiModelCatalogEntry {
  return {
    id,
    name,
    description: 'Nonpersonal discovery browser-test model.',
    inputTokenLimit: 1000,
    outputTokenLimit: 100,
    freeTier,
  };
}

const future = model('gemini-4-flash', 'Gemini 4 Flash');
const unknown = model('gemini-4-preview', 'Gemini 4 Preview', 'unknown');
const paid = model('gemini-4-pro', 'Gemini 4 Pro', 'unavailable');

function catalog(models = [future, unknown, paid]): GeminiModelCatalog {
  return {
    models,
    checkedAt: new Date().toISOString(),
    pricingUrl: GEMINI_PRICING_URL,
    warnings: [],
  };
}

async function openSettings(page: Page): Promise<Locator> {
  await page
    .getByRole('button', { name: 'Settings and backup', exact: true })
    .filter({ visible: true })
    .first()
    .click();
  const settings = page.getByRole('dialog', { name: 'Your kitchen, your way' });
  await expect(settings).toBeVisible();
  return settings;
}

async function showModels(settings: Locator): Promise<Locator> {
  const region = settings.getByRole('region', { name: 'Gemini models', exact: true });
  const summary = region.locator('summary').filter({ hasText: 'Models from Google' });
  await expect(summary).toBeVisible();
  await summary.click();
  return region;
}

function modelCard(region: Locator, name: string): Locator {
  return region
    .locator('.discovered-model')
    .filter({ has: region.page().getByRole('heading', { name, exact: true }) });
}

async function enableModel(page: Page, region: Locator, entry = future): Promise<void> {
  await modelCard(region, entry.name)
    .getByRole('button', { name: `Review ${entry.name}`, exact: true })
    .click();
  const review = page.getByRole('dialog', { name: `Enable ${entry.name}?`, exact: true });
  await expect(review.getByRole('button', { name: 'Enable model', exact: true })).toBeDisabled();
  await expect(review.getByRole('link', { name: 'View Google’s pricing' })).toHaveAttribute(
    'href',
    GEMINI_PRICING_URL,
  );
  if (['cover', 'unfolded'].includes(test.info().project.name))
    await review.screenshot({ path: `/tmp/mise-model-review-${test.info().project.name}.png` });
  await review
    .getByRole('checkbox', { name: 'My Google API project has billing disabled' })
    .check();
  await review.getByRole('button', { name: 'Enable model', exact: true }).click();
  await expect(review).toBeHidden();
}

async function savedConnection(page: Page): Promise<GeminiConnection> {
  return page.evaluate((key) => JSON.parse(localStorage.getItem(key)!), connectionKey);
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(
    ({ connectionKey, connection }) => {
      if (!localStorage.getItem(connectionKey))
        localStorage.setItem(connectionKey, JSON.stringify(connection));
      if (!localStorage.getItem('kitchen-wrapper.inventory.v1'))
        localStorage.setItem(
          'kitchen-wrapper.inventory.v1',
          JSON.stringify({ schemaVersion: 1, state: { products: [], batches: [], tools: [] } }),
        );
    },
    { connectionKey, connection },
  );
  await page.route('**/data/wikibooks-recipes.json', (route) =>
    route.fulfill({ json: { version: 1, recipes: [] } }),
  );
  await page.route('https://www.themealdb.com/api/**', (route) =>
    route.fulfill({ json: { meals: null } }),
  );
  await page.route(`${worker}/models**`, (route) => route.fulfill({ json: catalog() }));
  await page.route('https://*.example.workers.dev/health**', (route) => {
    const selected = new URL(route.request().url()).searchParams.get('model');
    return route.fulfill({ json: { ok: true, model: selected ?? 'gemini-3.5-flash-lite' } });
  });
  await page.goto('/');
});

test('discovers new models automatically without changing the chosen model and keeps unknown or paid models disabled', async ({
  page,
}) => {
  const discovery: string[] = [];
  await page.route(`${worker}/models**`, (route) => {
    discovery.push(route.request().url());
    return route.fulfill({ json: catalog() });
  });
  const settings = await openSettings(page);
  const region = await showModels(settings);
  expect(discovery).toEqual([`${worker}/models`]);
  await expect(region.getByRole('combobox', { name: 'Gemini model', exact: true })).toContainText(
    'Gemini 3.1 Flash-Lite',
  );
  expect(await savedConnection(page)).toEqual(connection);
  await expect(
    modelCard(region, future.name).getByRole('button', { name: `Review ${future.name}` }),
  ).toBeEnabled();
  await expect(modelCard(region, paid.name)).toContainText('Requires a paid tier; kept disabled.');
  await expect(modelCard(region, unknown.name)).toContainText(
    'Free-tier pricing could not be confirmed; kept disabled.',
  );
  await expect(modelCard(region, paid.name).getByRole('button')).toHaveCount(0);
  await expect(modelCard(region, unknown.name).getByRole('button')).toHaveCount(0);
  if (['cover', 'unfolded'].includes(test.info().project.name))
    await region.screenshot({ path: `/tmp/mise-model-discovery-${test.info().project.name}.png` });
  await region.getByRole('combobox', { name: 'Gemini model', exact: true }).click();
  const choices = page.getByRole('dialog', { name: 'Gemini model', exact: true });
  await expect(choices.getByRole('option', { name: future.name, exact: true })).toHaveCount(0);
  await expect(choices.getByRole('option', { name: paid.name, exact: true })).toHaveCount(0);
  await expect(choices.getByRole('option', { name: unknown.name, exact: true })).toHaveCount(0);
  await choices.getByRole('button', { name: 'Close gemini model options', exact: true }).click();
  await region
    .getByRole('searchbox', { name: 'Find discovered models', exact: true })
    .fill('preview');
  await expect(region.locator('.discovered-model')).toHaveCount(1);
  await expect(modelCard(region, unknown.name)).toBeVisible();
});

test('reviews a newly discovered free model explicitly, saves it, and uses it for chat after a reload', async ({
  page,
}) => {
  const health: string[] = [];
  await page.route(`${worker}/health**`, (route) => {
    health.push(route.request().url());
    return route.fulfill({ json: { ok: true, model: future.id } });
  });
  const requests: AiChatRequest[] = [];
  await page.route(`${worker}/chat`, (route) => {
    requests.push(route.request().postDataJSON());
    return route.fulfill({
      json: { message: 'Selected model test response.', recipes: [], warnings: [] },
    });
  });
  let settings = await openSettings(page);
  const region = await showModels(settings);
  await enableModel(page, region);
  await expect(region.getByRole('combobox', { name: 'Gemini model', exact: true })).toContainText(
    future.name,
  );
  expect(await savedConnection(page)).toEqual(connection);
  await settings.getByRole('button', { name: 'Save & check connection', exact: true }).click();
  await expect(settings.getByRole('status').filter({ hasText: 'Backend connected' })).toBeVisible();
  expect(health).toEqual([`${worker}/health?model=${future.id}&modelReviewed=1`]);
  expect(await savedConnection(page)).toEqual({
    ...connection,
    model: future.id,
    modelReviewed: true,
  });
  const storedPreferences = await page.evaluate(
    (key) => JSON.parse(localStorage.getItem(key)!),
    preferencesKey,
  );
  expect(storedPreferences.reviewedIds).toEqual([future.id]);
  expect(JSON.stringify(storedPreferences)).not.toContain(token);
  await page.reload();
  settings = await openSettings(page);
  await expect(settings.getByRole('combobox', { name: 'Gemini model', exact: true })).toContainText(
    future.name,
  );
  await settings.getByRole('button', { name: 'Close', exact: true }).click();
  await page
    .getByRole('button', { name: 'Gemini', exact: true })
    .filter({ visible: true })
    .first()
    .click();
  await page.getByRole('radio', { name: 'Create a recipe', exact: true }).check();
  await page
    .getByRole('textbox', { name: 'Message Gemini', exact: true })
    .fill('Help me choose dinner.');
  await page.getByRole('button', { name: 'Ask Gemini', exact: true }).click();
  await expect.poll(() => requests.length).toBe(1);
  expect(requests[0].model).toBe(future.id);
  expect(requests[0].modelReviewed).toBe(true);
  await expect(page.locator('.chat-history')).toContainText('Selected model test response.');
});

test('refreshes Google availability to add later models without any automatic selection', async ({
  page,
}) => {
  const later = model('gemini-5-flash', 'Gemini 5 Flash');
  const discovery: string[] = [];
  await page.route(`${worker}/models**`, (route) => {
    discovery.push(route.request().url());
    const refresh = new URL(route.request().url()).searchParams.get('refresh') === '1';
    return route.fulfill({ json: catalog(refresh ? [future, later] : [future]) });
  });
  const settings = await openSettings(page);
  const region = await showModels(settings);
  await expect(modelCard(region, later.name)).toHaveCount(0);
  await region.getByRole('button', { name: 'Refresh models', exact: true }).click();
  await expect(modelCard(region, later.name)).toBeVisible();
  expect(discovery).toEqual([`${worker}/models`, `${worker}/models?refresh=1`]);
  expect(await savedConnection(page)).toEqual(connection);
  await expect(region.getByRole('combobox', { name: 'Gemini model', exact: true })).toContainText(
    'Gemini 3.1 Flash-Lite',
  );
  await enableModel(page, region, later);
  await expect(region.getByRole('combobox', { name: 'Gemini model', exact: true })).toContainText(
    later.name,
  );
  expect(await savedConnection(page)).toEqual(connection);
});

test('keeps the cached model list and saved pairing when an offline or unreadable refresh fails', async ({
  page,
}) => {
  let refresh = 0;
  await page.route(`${worker}/models**`, (route) => {
    if (!new URL(route.request().url()).searchParams.has('refresh'))
      return route.fulfill({ json: catalog() });
    refresh += 1;
    return refresh === 1
      ? route.abort('failed')
      : route.fulfill({ json: { models: 'unreadable' } });
  });
  const settings = await openSettings(page);
  const region = await showModels(settings);
  await region.getByRole('button', { name: 'Refresh models', exact: true }).click();
  await expect(region.getByRole('status')).toContainText('Could not reach');
  await expect(modelCard(region, future.name)).toBeVisible();
  await expect(
    modelCard(region, future.name).getByRole('button', { name: `Review ${future.name}` }),
  ).toBeDisabled();
  expect(await savedConnection(page)).toEqual(connection);
  await region.getByRole('button', { name: 'Refresh models', exact: true }).click();
  await expect(region.getByRole('status')).toContainText('unreadable Gemini model list');
  expect(await savedConnection(page)).toEqual(connection);
  await region.getByRole('combobox', { name: 'Gemini model', exact: true }).click();
  const choices = page.getByRole('dialog', { name: 'Gemini model', exact: true });
  await expect(
    choices.getByRole('option', { name: 'Gemini 3.1 Flash-Lite', exact: true }),
  ).toBeVisible();
});

test('explains the update needed for an older Worker while preserving existing model choices', async ({
  page,
}) => {
  await page.route(`${worker}/models**`, (route) =>
    route.fulfill({ status: 404, json: { error: { code: 'not_found', message: 'Not found.' } } }),
  );
  const settings = await openSettings(page);
  const region = settings.getByRole('region', { name: 'Gemini models', exact: true });
  await expect(region.getByRole('status')).toContainText('Update your Cloudflare Worker');
  await expect(
    region.getByRole('link', { name: 'Download updated Worker', exact: true }),
  ).toHaveAttribute('href', '/mise-gemini-worker.js');
  await settings.locator('summary').filter({ hasText: 'Set up the free connection' }).click();
  await expect(
    settings.getByRole('link', { name: 'Download Worker code', exact: true }),
  ).toHaveAttribute('href', '/mise-gemini-worker.js');
  expect(await savedConnection(page)).toEqual(connection);
  await region.getByRole('combobox', { name: 'Gemini model', exact: true }).click();
  const choices = page.getByRole('dialog', { name: 'Gemini model', exact: true });
  await expect(
    choices.getByRole('option', { name: 'Gemini 3.1 Flash-Lite', exact: true }),
  ).toBeVisible();
  await expect(choices.getByRole('option', { name: 'Worker default', exact: true })).toBeVisible();
});

test('ignores a late catalog from the previous Worker after saving a different connection', async ({
  page,
}) => {
  let releasePrevious: (() => void) | undefined;
  let previousStarted = false;
  await page.route(`${worker}/models**`, async (route) => {
    previousStarted = true;
    await new Promise<void>((resolve) => {
      releasePrevious = resolve;
    });
    await route.fulfill({ json: catalog([future]) }).catch(() => undefined);
  });
  const replacement = model('gemini-5-flash', 'New Worker Gemini');
  await page.route(`${nextWorker}/models**`, (route) =>
    route.fulfill({ json: catalog([replacement]) }),
  );
  const settings = await openSettings(page);
  await expect.poll(() => previousStarted).toBe(true);
  await settings.getByRole('textbox', { name: 'Backend address', exact: true }).fill(nextWorker);
  await expect(
    settings.getByRole('button', { name: 'Refreshing models…', exact: true }),
  ).toBeDisabled();
  await settings.getByRole('button', { name: 'Save & check connection', exact: true }).click();
  await expect(settings.getByRole('status').filter({ hasText: 'Backend connected' })).toBeVisible();
  const region = await showModels(settings);
  await expect(modelCard(region, replacement.name)).toBeVisible();
  releasePrevious?.();
  await expect(modelCard(region, future.name)).toHaveCount(0);
  await expect(
    region.getByRole('button', { name: `Review ${replacement.name}`, exact: true }),
  ).toBeEnabled();
  expect((await savedConnection(page)).url).toBe(nextWorker);
  expect(
    await page.evaluate((key) => JSON.parse(localStorage.getItem(key)!).url, preferencesKey),
  ).toBe(nextWorker);
});
