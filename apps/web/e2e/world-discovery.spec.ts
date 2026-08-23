import { expect, test } from '@playwright/test';

const letter = (country: string, title: string) => ({
  publication_id: `00000000-0000-4000-8000-${country === 'US' ? '000000000101' : '000000000102'}`,
  letter_id: `00000000-0000-4000-8000-${country === 'US' ? '000000000201' : '000000000202'}`,
  pen_name: 'A member',
  country_code: country,
  locale: 'en-US',
  topics: ['travel'],
  content_reminder: 'none',
  revision: 1,
  title,
  body: { paragraphs: [`${title} body`] },
  published_at: '2026-08-19T00:00:00.000Z',
  bookmarked: false,
});

test('a delayed old feed response cannot overwrite a newer filter response', async ({ page }) => {
  let requestCount = 0;
  await page.route('**/v1/world/letters*', async (route) => {
    requestCount += 1;
    if (requestCount === 1) await new Promise((resolve) => setTimeout(resolve, 350));
    const filtered = new URL(route.request().url()).searchParams.get('country') === 'CA';
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        items: [filtered ? letter('CA', 'New letter') : letter('US', 'Old letter')],
        next_cursor: null,
      }),
    });
  });

  await page.goto('/world');
  await page.locator('.desktop-experience').getByLabel('Country').fill('CA');
  await expect(page.getByRole('heading', { name: 'New letter' })).toBeVisible();
  await page.waitForTimeout(450);
  await expect(page.getByRole('heading', { name: 'New letter' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Old letter' })).toHaveCount(0);
});
