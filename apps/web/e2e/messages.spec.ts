import { expect, test } from '@playwright/test';

const actor = '00000000-0000-4000-8000-000000000001';
const participantA = '00000000-0000-4000-8000-000000000002';
const participantB = '00000000-0000-4000-8000-000000000003';

const conversation = (id: string, participant: string, displayName?: string) => ({
  id,
  connection_id: `${id}-connection`,
  connection_epoch: 1,
  mode: 'friends',
  participant_account_id: participant,
  participant_display_name: displayName,
  opening_reference: null,
  opening_context: null,
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
});

test('messages ignores delayed A history after switching to B and scopes actions by ownership', async ({
  page,
}) => {
  let releaseA!: () => void;
  let markAFulfilled!: () => void;
  const delayedA = new Promise<void>((resolve) => {
    releaseA = resolve;
  });
  const aFulfilled = new Promise<void>((resolve) => {
    markAFulfilled = resolve;
  });
  await page.route('**/v1/conversations?limit=50', async (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        items: [
          conversation('conversation-a', participantA),
          conversation('conversation-b', participantB, 'Miyu'),
        ],
      }),
    }),
  );
  await page.route('**/v1/conversations/conversation-a/messages**', async (route) => {
    await delayedA;
    try {
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          items: [
            {
              id: 'message-a',
              sender_account_id: participantA,
              server_sequence: '1',
              body: 'stale A response',
              state: 'active',
              created_at: '2026-01-01T00:00:00.000Z',
            },
          ],
        }),
      });
    } catch {
      // Switching conversations may abort A's request. That is an expected
      // completion mode; the generation guard must still reject its payload.
    } finally {
      markAFulfilled();
    }
  });
  await page.route('**/v1/conversations/conversation-b/messages**', async (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        items: [
          {
            id: 'message-b-incoming',
            sender_account_id: participantB,
            server_sequence: '1',
            body: 'current B incoming',
            state: 'active',
            created_at: '2026-01-01T00:00:00.000Z',
          },
          {
            id: 'message-b-outgoing',
            sender_account_id: actor,
            server_sequence: '2',
            body: 'current B outgoing',
            state: 'active',
            created_at: '2026-01-01T00:01:00.000Z',
          },
        ],
      }),
    }),
  );
  await page.route('**/v1/conversations/*/read', async (route) =>
    route.fulfill({ contentType: 'application/json', body: JSON.stringify({ unread_count: 0 }) }),
  );
  const reportPayload = page.waitForRequest('**/v1/conversations/message-b-incoming/report');
  const withdrawPayload = page.waitForRequest('**/v1/messages/message-b-outgoing/withdraw');
  await page.route('**/v1/conversations/message-b-incoming/report', async (route) =>
    route.fulfill({ contentType: 'application/json', body: JSON.stringify({ id: 'report-b' }) }),
  );
  await page.route('**/v1/messages/message-b-outgoing/withdraw', async (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        id: 'message-b-outgoing',
        conversation_id: 'conversation-b',
        sender_account_id: actor,
        client_message_id: '00000000-0000-4000-0000-000000000001',
        server_sequence: '2',
        body: null,
        state: 'withdrawn',
        created_at: '2026-01-01T00:01:00.000Z',
        withdrawn_at: '2026-01-01T00:02:00.000Z',
      }),
    }),
  );
  page.on('dialog', (dialog) => dialog.accept());
  await page.goto('/messages');
  await page.getByRole('navigation', { name: 'Connections' }).getByRole('button').nth(1).click();
  const desktopMessages = page.locator('.messages-shell');
  await expect(desktopMessages.getByText('current B incoming')).toBeVisible();
  await expect(desktopMessages.getByText('current B outgoing')).toBeVisible();
  const incoming = desktopMessages.getByRole('article').filter({ hasText: 'current B incoming' });
  const outgoing = desktopMessages.getByRole('article').filter({ hasText: 'current B outgoing' });
  await expect(incoming.getByRole('button', { name: 'Report' })).toBeVisible();
  await expect(incoming.getByRole('button', { name: 'Withdraw' })).toHaveCount(0);
  await expect(outgoing.getByRole('button', { name: 'Withdraw' })).toBeVisible();
  await expect(outgoing.getByRole('button', { name: 'Report' })).toHaveCount(0);
  releaseA();
  await aFulfilled;
  await expect(page.getByText('stale A response')).toHaveCount(0);
  await incoming.getByRole('button', { name: 'Report' }).click();
  await outgoing.getByRole('button', { name: 'Withdraw' }).click();
  const reportRequest = await reportPayload;
  const withdrawRequest = await withdrawPayload;
  expect(reportRequest.method()).toBe('POST');
  expect(withdrawRequest.method()).toBe('POST');
  const reportBody = JSON.parse(reportRequest.postData() ?? '{}') as Record<string, unknown>;
  expect(reportBody).toMatchObject({
    subject_account_id: participantB,
    category: 'other',
  });
  expect(typeof reportBody['idempotency_key']).toBe('string');
  expect((reportBody['idempotency_key'] as string).length).toBeGreaterThanOrEqual(16);
  expect(JSON.parse(withdrawRequest.postData() ?? '{}')).toEqual({});
});

test('messages presents one searchable inbox for private and future circle conversations', async ({
  page,
}) => {
  await page.route('**/v1/conversations?limit=50', async (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        items: [
          conversation('conversation-private', participantA, 'Nadia'),
          {
            id: 'conversation-circle',
            conversation_type: 'circle',
            circle_context: {
              circle_id: '00000000-0000-4000-8000-000000000020',
              name: 'Books & Libraries',
              member_count: 12,
              role: 'member',
            },
            mode: 'circles',
            opening_reference: null,
            opening_context: null,
            created_at: '2026-01-02T00:00:00.000Z',
            updated_at: '2026-01-02T00:00:00.000Z',
          },
        ],
      }),
    }),
  );
  await page.route('**/v1/conversations/conversation-circle/messages**', async (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        items: [
          {
            id: 'message-circle-incoming',
            sender_account_id: participantB,
            sender_display_name: 'Samira',
            owned_by_actor: false,
            server_sequence: '1',
            body: 'Has anyone read this translation?',
            state: 'active',
            created_at: '2026-01-02T09:30:00.000Z',
          },
        ],
      }),
    }),
  );
  await page.route('**/v1/conversations/*/read', async (route) =>
    route.fulfill({ contentType: 'application/json', body: JSON.stringify({ unread_count: 0 }) }),
  );

  await page.goto('/messages');
  await expect(page.getByRole('tab', { name: /All/ })).toHaveAttribute('aria-selected', 'true');
  await page.getByRole('tab', { name: /Circles/ }).click();
  await expect(page.getByRole('button', { name: /Books & Libraries/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /Nadia/ })).toHaveCount(0);
  await page.getByRole('button', { name: /Books & Libraries/ }).click();
  await expect(page.getByRole('heading', { name: 'Books & Libraries' })).toBeVisible();
  const desktopMessages = page.locator('.messages-shell');
  await expect(desktopMessages.getByText('Has anyone read this translation?')).toBeVisible();
  await expect(desktopMessages.getByText('Samira')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Leave circle' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Suggest a draft' })).toHaveCount(0);
  await expect(page.getByRole('textbox', { name: 'Write a message' })).toHaveAttribute(
    'placeholder',
    'Write to the circle…',
  );

  await page.getByRole('tab', { name: /All/ }).click();
  await page.getByRole('searchbox', { name: 'Search conversations' }).fill('nadia');
  await expect(page.getByRole('button', { name: /Nadia/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /Books & Libraries/ })).toHaveCount(0);
});

test('mobile inbox announces a real server summary and marks the viewed boundary read', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const conversationId = '00000000-0000-4000-8000-000000000301';
  const messageId = '00000000-0000-4000-8000-000000000302';
  const inboxItem = {
    ...conversation(conversationId, participantA, 'Aisha Rahman'),
    unread_count: 1,
    last_message: {
      id: messageId,
      conversation_id: conversationId,
      sender_account_id: participantA,
      client_message_id: '00000000-0000-4000-8000-000000000303',
      server_sequence: '7',
      body: 'A new story from my city',
      state: 'active',
      created_at: '2026-08-21T10:24:00.000Z',
      withdrawn_at: null,
    },
  };
  await page.route('**/v1/conversations/unread-count', async (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ unread_count: 1, capped: false }),
    }),
  );
  await page.route('**/v1/conversations?limit=50', async (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ items: [inboxItem], next_cursor: null }),
    }),
  );
  await page.route(`**/v1/conversations/${conversationId}/messages**`, async (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ items: [inboxItem.last_message], next_cursor: null }),
    }),
  );
  const markReadRequest = page.waitForRequest(`**/v1/conversations/${conversationId}/read`);
  await page.route(`**/v1/conversations/${conversationId}/read`, async (route) =>
    route.fulfill({ contentType: 'application/json', body: JSON.stringify({ unread_count: 0 }) }),
  );

  await page.goto('/messages');
  const mobile = page.locator('.mobile-messages-screen');
  await expect(mobile.getByRole('button', { name: '打开 Aisha Rahman 的新消息' })).toBeVisible();
  await expect(
    mobile.locator('.mobile-conversation-list').getByText('A new story from my city'),
  ).toBeVisible();
  await expect(mobile.locator('.mobile-unread-badge')).toHaveText('1');
  await expect(page.locator('.mobile-nav__badge')).toHaveText('1');

  await mobile.getByRole('button', { name: '打开 Aisha Rahman 的新消息' }).click();
  await expect(mobile.getByText('A new story from my city')).toBeVisible();
  const request = await markReadRequest;
  expect(request.method()).toBe('POST');
  expect(JSON.parse(request.postData() ?? '{}')).toEqual({ through_message_id: messageId });
  await expect(page.locator('.mobile-nav__badge')).toHaveCount(0);
});
