import { expect, test } from '@playwright/test';

const UUID_V4 = /[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i;
const TRACE_ID = /[0-9a-f]{32}/i;

test('landing page renders the foundation scope', async ({ page }) => {
  await page.goto('/');
  await expect(page).toHaveTitle(/Women AI Network/);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('A slower way to meet.');
  await expect(page.getByRole('link', { name: 'Explore the world' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Write a letter' }).last()).toBeVisible();
  await expect(page.getByRole('link', { name: /Find a connection/ })).toBeVisible();
  await expect(page.getByRole('link', { name: /Join a circle/ })).toBeVisible();
});

test('health page shows API status and the correlation Request ID', async ({ page }) => {
  await page.goto('/health');

  await expect(page.getByTestId('ready-status')).toBeVisible();
  const readyStatus = await page.getByTestId('ready-status').innerText();
  expect(['ready', 'degraded']).toContain(readyStatus);

  // The trace must be accepted and carry a valid event id.
  await expect(page.getByTestId('trace-status')).toHaveText('accepted');
  await expect(page.getByTestId('event-id')).toHaveText(UUID_V4);

  // Correlation context: a UUID v4 Request ID and its 32-hex trace id.
  await expect(page.getByTestId('request-id')).toHaveText(UUID_V4);
  await expect(page.getByTestId('trace-id')).toHaveText(TRACE_ID);
});
