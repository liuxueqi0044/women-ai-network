import { expect, test } from '@playwright/test';

const participant = '00000000-0000-4000-8000-000000000021';

test('mobile primary surfaces use the independent black-gold shell', async ({ page }) => {
  const account = '00000000-0000-4000-8000-000000000011';
  await page.route('**/v1/account/session', async (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        session_id: '00000000-0000-4000-8000-000000000012',
        account_id: account,
        auth_level: 'aal2',
        state: 'active',
        created_at: '2026-08-19T10:00:00.000Z',
        last_seen_at: '2026-08-20T10:00:00.000Z',
        idle_expires_at: '2026-08-21T10:00:00.000Z',
        absolute_expires_at: '2026-09-20T10:00:00.000Z',
      }),
    }),
  );
  await page.route('**/v1/profile/me', async (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        profile_id: '00000000-0000-4000-8000-000000000013',
        account_id: account,
        display_name: 'Lin Xiaoman',
        city: 'Chengdu',
        country_code: 'CN',
        state: 'published',
        version: 3,
        facts: [],
      }),
    }),
  );
  await page.route('**/v1/connections?limit=20', async (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        connections: [
          {
            id: '00000000-0000-4000-8000-000000000014',
            requester_account_id: account,
            recipient_account_id: participant,
            mode: 'friends',
            state: 'accepted',
            created_at: '2026-08-19T10:00:00.000Z',
            updated_at: '2026-08-20T10:00:00.000Z',
          },
        ],
      }),
    }),
  );
  await page.route('**/v1/introductions?mode=friends&limit=1', async (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        batch_id: '00000000-0000-4000-8000-000000000015',
        mode: 'friends',
        candidates: [
          {
            id: '00000000-0000-4000-8000-000000000016',
            mode: 'friends',
            subject: { display_name: 'Sofia Petrova' },
            reasons: ['PREFERENCES_ALIGN'],
            explanation: 'Recommended for shared interests and compatible boundaries.',
            decision: null,
            outcome: null,
          },
        ],
        next_cursor: null,
        refresh_after: '2026-08-21T10:00:00.000Z',
      }),
    }),
  );
  await page.route('**/v1/circles?limit=1', async (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        items: [
          {
            id: '00000000-0000-4000-8000-000000000017',
            name: 'Writing and life',
            member_count: 24,
          },
        ],
        next_cursor: null,
      }),
    }),
  );
  await page.route('**/v1/conversations?limit=50', async (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        items: [
          {
            id: 'conversation-direct',
            participant_account_id: participant,
            participant_display_name: 'Nadia',
            conversation_type: 'direct',
            mode: 'friends',
            opening_reference: {
              delivery_id: '00000000-0000-4000-8000-000000000031',
              revision: 1,
              source_hash: 'a'.repeat(64),
            },
            opening_context: {
              status: 'delivered_reference',
              original_locale: 'en-US',
              machine_translation_available: true,
            },
            created_at: '2026-08-19T10:00:00.000Z',
            updated_at: '2026-08-20T10:00:00.000Z',
          },
          {
            id: 'conversation-circle',
            conversation_type: 'circle',
            circle_context: {
              circle_id: '00000000-0000-4000-8000-000000000041',
              name: 'Books across borders',
              member_count: 18,
              role: 'member',
            },
            mode: 'circles',
            opening_reference: null,
            opening_context: null,
            created_at: '2026-08-18T10:00:00.000Z',
            updated_at: '2026-08-20T09:00:00.000Z',
          },
        ],
      }),
    }),
  );
  await page.route('**/v1/conversations/conversation-direct/messages**', async (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        items: [
          {
            id: 'message-one',
            sender_account_id: participant,
            server_sequence: '1',
            body: 'I loved reading your letter about Chengdu.',
            state: 'active',
            created_at: '2026-08-20T10:01:00.000Z',
          },
        ],
      }),
    }),
  );
  await page.route('**/v1/world/letters**', async (route) =>
    route.fulfill({ contentType: 'application/json', body: JSON.stringify({ items: [] }) }),
  );

  await page.goto('/messages');
  await expect(page.locator('.mobile-messages-screen')).toBeVisible();
  await expect(page.locator('.messages-shell')).toBeHidden();
  await expect(page.getByRole('heading', { name: 'Messages', exact: true })).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Mobile primary' })).toBeVisible();
  await expect(page.getByRole('searchbox')).toBeHidden();
  await page.getByRole('button', { name: 'Search conversations' }).click();
  await expect(page.getByRole('searchbox')).toBeVisible();
  await expect(page.getByRole('button', { name: /Nadia/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /Books across borders/ })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
    await page.evaluate(() => document.documentElement.clientWidth),
  );

  await page.getByRole('button', { name: /Nadia/ }).click();
  const mobileThread = page.locator('.mobile-thread-screen');
  await expect(mobileThread).toBeVisible();
  await expect(mobileThread.getByText('I loved reading your letter about Chengdu.')).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Mobile primary' })).toBeHidden();
  await expect(page.getByRole('textbox', { name: 'Write a message' })).toBeVisible();

  await page.goto('/connect');
  await expect(page.locator('.mobile-connect-screen')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Connect', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Current contacts' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'People you may know' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Sofia Petrova' })).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Mobile primary' })).toBeVisible();

  await page.goto('/world');
  await expect(page.locator('.mobile-world-screen')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'World', exact: true })).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Public letters' })).toBeVisible();

  await page.goto('/me');
  await expect(page.locator('.mobile-me-screen')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Me', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Lin Xiaoman' })).toBeVisible();
  await expect(page.getByText('60% complete')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
    await page.evaluate(() => document.documentElement.clientWidth),
  );
});
