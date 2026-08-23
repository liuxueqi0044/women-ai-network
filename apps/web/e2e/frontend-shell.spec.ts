import { expect, test } from '@playwright/test';

const accountId = '00000000-0000-4000-8000-000000000001';
const circleId = '00000000-0000-4000-8000-000000000020';

test('editorial shell stays navigable on desktop and mobile', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'A slower way to meet.' })).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Primary', exact: true })).toContainText(
    'Circles',
  );
  await expect(page.getByRole('link', { name: 'Write a letter' }).first()).toBeVisible();

  await page.setViewportSize({ width: 390, height: 844 });
  const mobileNavigation = page.getByRole('navigation', { name: 'Mobile primary' });
  await expect(mobileNavigation).toBeVisible();
  await expect(mobileNavigation.getByRole('link')).toHaveCount(4);
  await expect(mobileNavigation.getByRole('link', { name: 'Messages', exact: true })).toBeVisible();
  await expect(mobileNavigation.getByRole('link', { name: 'Connect', exact: true })).toBeVisible();
  await expect(mobileNavigation.getByRole('link', { name: 'World', exact: true })).toBeVisible();
  await expect(mobileNavigation.getByRole('link', { name: 'Me', exact: true })).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Primary', exact: true })).toBeHidden();
  await expect(page.locator('html')).toHaveCSS('background-color', 'rgb(17, 19, 18)');
  await expect(mobileNavigation).toHaveCSS('background-color', 'rgba(11, 13, 12, 0.97)');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
});

test('mobile contact hub includes circles without adding a fifth primary tab', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/connect');

  await expect(page.getByRole('heading', { name: 'Connect', exact: true })).toBeVisible();
  const circles = page.getByRole('region', { name: 'My circles' });
  await expect(circles).toBeVisible();
  await expect(circles.getByRole('link')).toBeVisible();
  await expect(
    page.getByRole('navigation', { name: 'Mobile primary' }).getByRole('link'),
  ).toHaveCount(4);
});

test('mobile world keeps advanced filters behind a compact disclosure', async ({ page }) => {
  await page.route('**/v1/world/letters?**', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ items: [], next_cursor: null }),
    }),
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/world');

  const filters = page.getByRole('region', { name: 'Letter filters' });
  await expect(filters).toBeHidden();
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await expect(filters).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Search' })).toBeVisible();
});

test('account hub and circle list render server-authoritative data', async ({ page }) => {
  await page.route('**/v1/account/session', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        session_id: '00000000-0000-4000-8000-000000000002',
        account_id: accountId,
        auth_level: 'aal1',
        state: 'active',
        created_at: '2026-08-20T00:00:00.000Z',
        last_seen_at: '2026-08-20T00:00:00.000Z',
        idle_expires_at: '2026-08-21T00:00:00.000Z',
        absolute_expires_at: '2026-09-20T00:00:00.000Z',
      }),
    }),
  );
  await page.route('**/v1/circles?limit=50', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        items: [
          {
            id: circleId,
            name: 'Books across borders',
            description_available: true,
            lifecycle: 'active',
            visibility: 'approval_required',
            mode: 'friends',
            scope_kind: 'online',
            country_code: null,
            city_label: null,
            topic_catalog_version: 1,
            topics: ['books', 'culture'],
            member_cap: 20,
            member_count: 7,
            role: 'member',
            created_at: '2026-08-20T00:00:00.000Z',
            updated_at: '2026-08-20T00:00:00.000Z',
          },
        ],
        next_cursor: null,
      }),
    }),
  );

  await page.goto('/me');
  await expect(page.getByText('Session protected at AAL1')).toBeVisible();
  await expect(page.getByRole('link', { name: /Profile & privacy/ })).toBeVisible();

  await page.goto('/circles');
  await expect(page.getByRole('heading', { name: 'Books across borders' })).toBeVisible();
  await expect(page.getByText('7 / 20 members')).toBeVisible();
  await page.getByRole('button', { name: 'Create a circle' }).click();
  await expect(
    page.getByRole('heading', { name: 'Set the room before inviting people.' }),
  ).toBeVisible();
  await expect(page.getByRole('group', { name: 'Topics' })).toBeVisible();
});

test('circle chat deep link tells the truth when group transport is unavailable', async ({
  page,
}) => {
  await page.route('**/v1/conversations?limit=50', (route) =>
    route.fulfill({ contentType: 'application/json', body: JSON.stringify({ items: [] }) }),
  );
  await page.goto(`/messages?circle=${circleId}`);
  await expect(page.getByRole('tab', { name: /Circles/ })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('status')).toHaveText(
    'Circle conversations will appear here when group messaging is enabled.',
  );
});
