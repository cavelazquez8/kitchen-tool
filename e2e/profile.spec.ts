import { readFile } from 'node:fs/promises';
import { expect, test, type Locator, type Page } from '@playwright/test';
import type { InventoryState } from '../src/domain/types';
import type { AiChatRequest } from '../src/ai/protocol';
import type { ProfileBackup } from '../src/profile/backup';

const inventoryKey = 'kitchen-wrapper.inventory.v1';
const connectionKey = 'mise.gemini.connection.v1';
const worker = 'https://mise.example.workers.dev';
const token = 'test_only_' + 'a'.repeat(40);
const pdfText = '%PDF-1.7\nNonpersonal browser-test document\n%%EOF';
const reviewedText = 'Example report: recommended daily intake 2100 kcal, protein 100 g.';
const inventory: InventoryState = { products: [], batches: [], tools: [] };

async function navigateGemini(page: Page) {
  await page
    .getByRole('button', { name: 'Gemini', exact: true })
    .filter({ visible: true })
    .first()
    .click();
}

async function openProfile(page: Page): Promise<Locator> {
  await navigateGemini(page);
  await page.getByRole('button', { name: 'Your profile', exact: true }).click();
  const profile = page.getByRole('dialog', { name: 'Your profile', exact: true });
  await expect(profile).toBeVisible();
  return profile;
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

async function stateOf(page: Page): Promise<InventoryState> {
  return page.evaluate((key) => JSON.parse(localStorage.getItem(key)!).state, inventoryKey);
}

async function originalFiles(page: Page): Promise<{ id: string; type: string; text: string }[]> {
  return page.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('mise-profile-documents.v1', 1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      const { keys, blobs } = await new Promise<{ keys: IDBValidKey[]; blobs: Blob[] }>(
        (resolve, reject) => {
          const transaction = database.transaction('documents', 'readonly');
          const store = transaction.objectStore('documents');
          const keyRequest = store.getAllKeys();
          const blobRequest = store.getAll();
          transaction.oncomplete = () =>
            resolve({ keys: keyRequest.result, blobs: blobRequest.result });
          transaction.onabort = () => reject(transaction.error);
        },
      );
      return Promise.all(
        blobs.map(async (blob, index) => ({
          id: String(keys[index]),
          type: blob.type,
          text: await blob.text(),
        })),
      );
    } finally {
      database.close();
    }
  });
}

function card(profile: Locator, name: string): Locator {
  return profile
    .locator('.profile-scan-card')
    .filter({ has: profile.page().getByRole('heading', { name, exact: true }) });
}

async function ask(page: Page, message: string) {
  const replies = page.locator('.chat-history .chat-message.assistant');
  const previous = await replies.count();
  await page.getByRole('textbox', { name: 'Message Gemini' }).fill(message);
  await page.getByRole('button', { name: 'Ask Gemini', exact: true }).click();
  await expect(replies).toHaveCount(previous + 1);
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(
    ({ key, connectionKey, inventory, token, worker }) => {
      if (!localStorage.getItem(key))
        localStorage.setItem(key, JSON.stringify({ schemaVersion: 1, state: inventory }));
      if (!localStorage.getItem(connectionKey))
        localStorage.setItem(connectionKey, JSON.stringify({ url: worker, token }));
    },
    { key: inventoryKey, connectionKey, inventory, token, worker },
  );
  await page.route('**/data/wikibooks-recipes.json', (route) =>
    route.fulfill({ json: { version: 1, recipes: [] } }),
  );
  await page.route('https://www.themealdb.com/api/**', (route) =>
    route.fulfill({ json: { meals: null } }),
  );
  await page.goto('/');
});

test('saves originals in IndexedDB, transfers them in a backup, and edits or deletes multiple reports', async ({
  page,
}) => {
  test.setTimeout(60_000);
  const extracts: { media?: { mimeType: string; data: string } }[] = [];
  await page.route(`${worker}/profile/extract`, async (route) => {
    extracts.push(route.request().postDataJSON());
    await route.fulfill({
      json: {
        text: reviewedText,
        recordedOn: '2026-10-10',
        targets: { caloriesKcal: 2100, proteinGrams: 100, carbsGrams: null, fatGrams: null },
        warnings: ['Check the report values before saving.'],
      },
    });
  });
  let profile = await openProfile(page);
  await profile.getByRole('button', { name: 'Add scan', exact: true }).click();
  let editor = page.getByRole('dialog', { name: 'Add a body scan' });
  await editor.getByLabel('Body scan file').setInputFiles({
    name: 'nonpersonal-scan.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from(pdfText),
  });
  await expect(editor.getByRole('textbox', { name: 'Report name', exact: true })).toHaveValue(
    'nonpersonal-scan',
  );
  expect((await stateOf(page)).bodyScans).toBeUndefined();
  expect(extracts).toEqual([]);
  await editor.getByRole('textbox', { name: 'Report name', exact: true }).fill('October report');
  await editor.getByRole('button', { name: 'Read with Gemini', exact: true }).click();
  await expect(editor.getByRole('textbox', { name: /^Report text/ })).toHaveValue(reviewedText);
  expect(extracts).toHaveLength(1);
  expect(extracts[0].media?.mimeType).toBe('application/pdf');
  expect(Buffer.from(extracts[0].media!.data, 'base64').toString()).toBe(pdfText);
  await editor.getByRole('button', { name: 'Save report', exact: true }).click();
  await expect(card(profile, 'October report')).toBeVisible();
  expect((await stateOf(page)).nutritionTargets).toBeUndefined();
  expect(await originalFiles(page)).toEqual([
    { id: (await stateOf(page)).bodyScans![0].file!.id, type: 'application/pdf', text: pdfText },
  ]);
  const initialFileId = (await stateOf(page)).bodyScans![0].file!.id;

  await profile.getByRole('button', { name: 'Add scan', exact: true }).click();
  editor = page.getByRole('dialog', { name: 'Add a body scan' });
  await editor.getByRole('textbox', { name: 'Report name', exact: true }).fill('Notes report');
  await editor
    .getByRole('textbox', { name: /^Report text/ })
    .fill('Second, manually entered report.');
  await editor.getByRole('button', { name: 'Save report', exact: true }).click();
  await expect(profile.locator('.profile-scan-card')).toHaveCount(2);
  if (['cover', 'unfolded'].includes(test.info().project.name))
    await profile.screenshot({ path: `/tmp/mise-body-profile-${test.info().project.name}.png` });
  await page.reload();
  profile = await openProfile(page);
  await expect(profile.locator('.profile-scan-card')).toHaveCount(2);
  await card(profile, 'October report')
    .getByRole('button', { name: 'View & edit', exact: true })
    .click();
  editor = page.getByRole('dialog', { name: 'Your body scan' });
  const originalDownload = page.waitForEvent('download');
  await editor.getByRole('button', { name: 'Download original', exact: true }).click();
  const original = await originalDownload;
  expect(original.suggestedFilename()).toBe('nonpersonal-scan.pdf');
  expect((await readFile((await original.path())!)).toString()).toBe(pdfText);
  await editor.getByRole('button', { name: 'Your profile', exact: true }).click();
  await profile.getByRole('button', { name: 'Close', exact: true }).click();

  let settings = await openSettings(page);
  const backupDownload = page.waitForEvent('download');
  await settings.getByRole('button', { name: 'Download backup', exact: true }).click();
  const backupFile = await backupDownload;
  const backupText = (await readFile((await backupFile.path())!)).toString();
  const backup: ProfileBackup = JSON.parse(backupText);
  expect(backup.inventory.bodyScans).toHaveLength(2);
  expect(backup.documents).toHaveLength(1);
  expect(Buffer.from(backup.documents![0].data, 'base64').toString()).toBe(pdfText);
  expect(backupText).not.toContain(token);
  expect(backupText).not.toContain(worker);
  await settings.getByRole('button', { name: 'Close', exact: true }).click();

  profile = await openProfile(page);
  await card(profile, 'October report')
    .getByRole('button', { name: 'View & edit', exact: true })
    .click();
  editor = page.getByRole('dialog', { name: 'Your body scan' });
  await editor.getByRole('textbox', { name: 'Report name', exact: true }).fill('Edited report');
  await editor
    .getByRole('textbox', { name: /^Report text/ })
    .fill('Manually corrected report text.');
  await editor.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect(card(profile, 'Edited report')).toContainText('Manually corrected report text.');
  expect((await stateOf(page)).bodyScans![0].targets).toBeUndefined();
  await profile.getByRole('button', { name: 'Close', exact: true }).click();

  settings = await openSettings(page);
  await settings.locator('input[type="file"][accept=".json,application/json"]').setInputFiles({
    name: 'profile-backup.json',
    mimeType: 'application/json',
    buffer: Buffer.from(backupText),
  });
  const restore = page.getByRole('dialog', { name: 'Restore this kitchen?' });
  await expect(restore).toContainText('2 body scans');
  await restore.getByRole('button', { name: 'Replace inventory', exact: true }).click();
  await expect(restore).toBeHidden();
  const restored = await stateOf(page);
  expect(restored.bodyScans![0].name).toBe('October report');
  expect(restored.bodyScans![0].text).toBe(reviewedText);
  expect(restored.bodyScans![0].file!.id).not.toBe(initialFileId);
  expect(await originalFiles(page)).toEqual([
    { id: restored.bodyScans![0].file!.id, type: 'application/pdf', text: pdfText },
  ]);
  await settings.getByRole('button', { name: 'Close', exact: true }).click();
  profile = await openProfile(page);
  for (const name of ['October report', 'Notes report']) {
    const report = card(profile, name);
    await report.getByRole('button', { name: `Delete ${name}`, exact: true }).click();
    await report.getByRole('button', { name: 'Delete report', exact: true }).click();
    await expect(report).toHaveCount(0);
  }
  expect((await stateOf(page)).bodyScans).toEqual([]);
  expect(await originalFiles(page)).toEqual([]);
  await page.reload();
  profile = await openProfile(page);
  await expect(profile.getByText('Your reports belong here', { exact: true })).toBeVisible();
});

test('shares only explicitly attached report text and clears selection after a reload', async ({
  page,
}) => {
  test.setTimeout(60_000);
  const reports = [
    {
      id: 'one',
      name: 'First report',
      recordedOn: '2026-01-01',
      text: 'First selected report information.',
    },
    {
      id: 'two',
      name: 'Second report',
      recordedOn: '2026-02-01',
      text: 'Second selected report information.',
    },
  ];
  await page.evaluate(
    ({ key, state }) => localStorage.setItem(key, JSON.stringify({ schemaVersion: 1, state })),
    { key: inventoryKey, state: { ...inventory, bodyScans: reports } },
  );
  await page.reload();
  const requests: AiChatRequest[] = [];
  await page.route(`${worker}/chat`, async (route) => {
    requests.push(route.request().postDataJSON());
    await route.fulfill({
      json: { message: 'Nonpersonal test response.', recipes: [], warnings: [] },
    });
  });
  await navigateGemini(page);
  await page.getByRole('radio', { name: 'Create with my inventory', exact: true }).check();
  await ask(page, 'Suggest a simple dinner.');
  await expect.poll(() => requests.length).toBe(1);
  expect(requests[0].profile).toBeUndefined();
  expect(JSON.stringify(requests[0])).not.toContain(reports[0].text);
  expect(JSON.stringify(requests[0])).not.toContain(reports[1].text);

  let profile = await openProfile(page);
  await card(profile, 'First report')
    .getByRole('button', { name: 'Add to Gemini', exact: true })
    .click();
  const context = page.getByRole('region', { name: 'Gemini body scan context' });
  await expect(context).toContainText('First report');
  await expect(context).not.toContainText('Second report');
  await ask(page, 'Consider the report I attached.');
  await expect.poll(() => requests.length).toBe(2);
  expect(requests[1].profile).toContain(reports[0].text);
  expect(requests[1].profile).not.toContain(reports[1].text);

  profile = await openProfile(page);
  await card(profile, 'Second report')
    .getByRole('button', { name: 'Add to Gemini', exact: true })
    .click();
  await expect(context).toContainText('Second report');
  await ask(page, 'Compare the attached reports.');
  await expect.poll(() => requests.length).toBe(3);
  expect(requests[2].profile).toContain(reports[0].text);
  expect(requests[2].profile).toContain(reports[1].text);
  await context
    .getByRole('button', { name: 'Remove First report from Gemini context', exact: true })
    .click();
  await ask(page, 'Use the remaining report.');
  await expect.poll(() => requests.length).toBe(4);
  expect(requests[3].profile).not.toContain(reports[0].text);
  expect(requests[3].profile).toContain(reports[1].text);
  await page.reload();
  await navigateGemini(page);
  await expect(context).toHaveCount(0);
  await page.getByRole('radio', { name: 'Create with my inventory', exact: true }).check();
  await ask(page, 'Suggest another dinner.');
  await expect.poll(() => requests.length).toBe(5);
  expect(requests[4].profile).toBeUndefined();
  expect((await stateOf(page)).bodyScans).toEqual(reports);
});

test('saves the chosen Gemini model, verifies its backend setting, and uses it for chat after reload', async ({
  page,
}) => {
  const health: string[] = [];
  await page.route(`${worker}/health**`, async (route) => {
    health.push(route.request().url());
    const model =
      new URL(route.request().url()).searchParams.get('model') ?? 'gemini-3.5-flash-lite';
    await route.fulfill({ json: { ok: true, model } });
  });
  const requests: AiChatRequest[] = [];
  await page.route(`${worker}/chat`, async (route) => {
    requests.push(route.request().postDataJSON());
    await route.fulfill({
      json: { message: 'Nonpersonal selected-model response.', recipes: [], warnings: [] },
    });
  });
  const settings = await openSettings(page);
  await settings.getByRole('combobox', { name: 'Gemini model', exact: true }).click();
  const choices = page.getByRole('dialog', { name: 'Gemini model', exact: true });
  await choices.getByRole('option', { name: 'Gemini 3.1 Flash-Lite', exact: true }).click();
  await settings.getByRole('button', { name: 'Save & check connection', exact: true }).click();
  await expect(settings.getByRole('status')).toContainText('Backend connected');
  expect(health).toEqual([`${worker}/health?model=gemini-3.1-flash-lite`]);
  expect(
    await page.evaluate((key) => JSON.parse(localStorage.getItem(key)!).model, connectionKey),
  ).toBe('gemini-3.1-flash-lite');
  await page.reload();
  const reloadedSettings = await openSettings(page);
  await expect(
    reloadedSettings.getByRole('combobox', { name: 'Gemini model', exact: true }),
  ).toContainText('Gemini 3.1 Flash-Lite');
  await reloadedSettings.getByRole('button', { name: 'Close', exact: true }).click();
  await navigateGemini(page);
  await page.getByRole('radio', { name: 'Create with my inventory', exact: true }).check();
  await ask(page, 'Help me choose a meal.');
  await expect.poll(() => requests.length).toBe(1);
  expect(requests[0].model).toBe('gemini-3.1-flash-lite');
});
