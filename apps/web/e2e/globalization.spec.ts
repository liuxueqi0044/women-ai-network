import { expect, test } from '@playwright/test';

const preference = {
  account_id: '00000000-0000-4000-8000-000000000001',
  ui_locale: 'en',
  content_locales: ['en'],
  time_zone: 'UTC',
  hour_cycle: 'h23',
  week_start: 1,
  version: 0,
  updated_at: '2026-01-01T00:00:00.000Z',
};

test.beforeEach(async ({ page }) => {
  await page.route('**/v1/globalization/preferences', async (route) => {
    if (route.request().method() === 'GET')
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(preference),
      });
    const submitted = route.request().postDataJSON() as Partial<typeof preference>;
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ...preference, ...submitted, version: 1 }),
    });
  });
});

test('language settings hydrate from API and remain usable at desktop and 320px', async ({
  page,
}) => {
  await page.goto('/settings/language');
  await expect(page.getByRole('heading', { name: 'Language and time' })).toBeVisible();
  await expect(page.getByLabel('Interface language')).toHaveValue('en');
  await page.getByLabel('Interface language').selectOption('fr');
  // The active application locale changes only after the server accepts the
  // optimistic write, so the submit label remains English while editing.
  await page.getByRole('button', { name: 'Save preferences' }).click();
  await expect(page.getByRole('status')).toContainText('Préférences enregistrées.');
  await page.setViewportSize({ width: 320, height: 700 });
  await expect(page.getByRole('heading', { name: 'Langue et heure' })).toBeVisible();
  await expect(page.locator('main')).toBeVisible();
  const box = await page.locator('main').boundingBox();
  expect(box?.width).toBeLessThanOrEqual(320);
});
