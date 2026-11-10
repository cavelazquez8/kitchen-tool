import type { Page } from '@playwright/test';

/** Opens Settings & backup from whichever settings control the current layout shows. */
export async function openSettings(page: Page) {
  await page
    .getByRole('button', { name: 'Settings and backup' })
    .locator('visible=true')
    .first()
    .click();
}
