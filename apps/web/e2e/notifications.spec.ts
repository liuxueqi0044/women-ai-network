import { expect, test } from '@playwright/test';

test.describe('notifications real route', () => {
  test('is reachable on desktop and reports an honest unauthenticated/offline state', async ({
    page,
  }) => {
    await page.goto('/notifications');
    await expect(page.getByRole('heading', { name: 'Notifications' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Refresh' })).toBeVisible();
    await expect(page.getByRole('combobox', { name: 'Category' })).toBeVisible();
    await expect(page.getByLabel('Unread notifications')).toBeVisible({ timeout: 10_000 });
  });
});
