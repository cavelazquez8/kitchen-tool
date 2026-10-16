import { expect, type Page } from '@playwright/test';

export async function openRecipeFilters(page: Page) {
  const drawer = page.getByRole('dialog', { name: 'Filter recipes', exact: true });
  if (!(await drawer.isVisible()))
    await page.getByRole('button', { name: /^Filters(?:\s|\(|$)/ }).click();
  await expect(drawer).toBeVisible();
  return drawer;
}

export async function closeRecipeFilters(page: Page) {
  const drawer = page.getByRole('dialog', { name: 'Filter recipes', exact: true });
  if (await drawer.isVisible())
    await drawer.getByRole('button', { name: 'Show recipes', exact: true }).click();
  await expect(drawer).not.toBeVisible();
}

export async function chooseRecipeFilter(page: Page, label: string, option: string) {
  const drawer = await openRecipeFilters(page);
  await drawer.getByRole('combobox', { name: label, exact: true }).click();
  await page.getByRole('option', { name: option, exact: true }).click();
  await closeRecipeFilters(page);
}

export async function clearRecipeFilters(page: Page) {
  const drawer = await openRecipeFilters(page);
  const clear = drawer.getByRole('button', { name: 'Clear all', exact: true });
  if (await clear.isEnabled()) await clear.click();
  await closeRecipeFilters(page);
}

export async function chooseRecipeSort(page: Page, option: string) {
  await page.getByRole('combobox', { name: 'Sort by', exact: true }).click();
  await page.getByRole('option', { name: option, exact: true }).click();
}
