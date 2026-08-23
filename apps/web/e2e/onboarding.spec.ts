import { expect, test, type Page } from '@playwright/test';

const session = {
  session_id: '11111111-1111-4111-8111-111111111111',
  purpose: 'discovery',
  modes: ['friends', 'activities'],
  modes_version: 1,
  dating_enabled: false,
  state: 'active',
  version: 0,
  answer_revision: 0,
};
const preferences = {
  account_id: '22222222-2222-4222-8222-222222222222',
  purpose: 'discovery',
  version: 1,
  modes: ['friends', 'activities'],
  modes_version: 1,
  preferences: [
    {
      mode: 'friends',
      criterion: 'values',
      strength: 'strong_preference',
      value: 'Existing friends values',
      deal_breaker: false,
    },
    {
      mode: 'activities',
      criterion: 'availability',
      strength: 'weak_preference',
      value: 'Existing activities availability',
      deal_breaker: false,
    },
  ],
  confirmed_at: '2026-08-19T00:00:00.000Z',
};

async function mockOnboarding(page: Page, replaceStatus = 200) {
  let saved = false;
  let stateCalls = 0;
  const answerModes: string[] = [];
  const preferenceModes: string[] = [];
  await page.route('**/v1/onboarding/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() === 'POST' && url.pathname.endsWith('/sessions'))
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(session),
      });
    if (request.method() === 'GET' && url.pathname.endsWith('/state') && stateCalls++ === 0)
      return route.fulfill({
        status: 404,
        contentType: 'application/json',
        body: JSON.stringify({ code: 'NOT_FOUND' }),
      });
    if (request.method() === 'GET' && url.pathname.endsWith('/state'))
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          session,
          preferences: saved ? preferences : null,
          proposal: null,
          consent: null,
        }),
      });
    if (request.method() === 'GET' && url.pathname.endsWith('/sessions'))
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(session),
      });
    if (request.method() === 'POST' && url.pathname.includes('/answers'))
      answerModes.push((request.postDataJSON() as { mode: string }).mode);
    if (request.method() === 'POST' && url.pathname.includes('/answers'))
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ...session, answer_revision: 1, version: 1 }),
      });
    if (request.method() === 'PUT' && url.pathname.endsWith('/preferences')) {
      saved = replaceStatus === 200;
      preferenceModes.push((request.postDataJSON() as { mode: string }).mode);
      return route.fulfill({
        status: replaceStatus,
        contentType: 'application/json',
        body: JSON.stringify(
          replaceStatus === 200
            ? preferences
            : { code: 'OPTIMISTIC_CONCURRENCY_CONFLICT', message: 'onboarding version conflict' },
        ),
      });
    }
    if (request.method() === 'POST' && url.pathname.endsWith('/consent'))
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          consent_id: '33333333-3333-4333-8333-333333333333',
          receipt_version: 1,
          granted: true,
        }),
      });
    if (request.method() === 'POST' && url.pathname.endsWith('/extract'))
      return route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({
          code: 'PROVIDER_UNAVAILABLE',
          message: 'AI draft is unavailable; continue manually',
        }),
      });
    return route.fulfill({
      status: 404,
      contentType: 'application/json',
      body: JSON.stringify({ code: 'NOT_FOUND' }),
    });
  });
  return { answerModes, preferenceModes };
}

test('desktop manual path persists through refresh and never uses alert', async ({ page }) => {
  const calls = await mockOnboarding(page);
  let dialog = false;
  page.on('dialog', () => {
    dialog = true;
  });
  await page.goto('/onboarding');
  await page.getByRole('button', { name: 'Create session' }).click();
  await expect(page.getByRole('heading', { name: 'Tell us in your own words' })).toBeVisible();
  await page.getByRole('button', { name: 'Skip to manual review' }).click();
  await page.getByRole('button', { name: 'Save manually' }).click();
  await expect(
    page.getByRole('heading', { name: /Saved, with your control intact/ }),
  ).toBeVisible();
  const stored = await page.evaluate(() => window.localStorage.getItem('wai:onboarding:draft:v1'));
  expect(stored).not.toMatch(/slow|preferences|consent_id|session_id|answer/);
  await page.reload();
  await expect(
    page.getByRole('heading', { name: /Saved, with your control intact/ }),
  ).toBeVisible();
  const beforeEdit = calls.preferenceModes.length;
  await page.getByRole('button', { name: 'Edit choices' }).click();
  await page.getByRole('button', { name: 'Save manually' }).click();
  await expect(page.getByRole('status')).toContainText('Existing choices kept');
  expect(calls.preferenceModes).toHaveLength(beforeEdit);
  expect(dialog).toBe(false);
});

test('multi-mode editor sends each answer and manual save to the active mode', async ({ page }) => {
  const calls = await mockOnboarding(page);
  await page.goto('/onboarding');
  await page.getByRole('button', { name: 'Create session' }).click();
  await expect(page.getByRole('tab', { name: 'Friends' })).toBeVisible();
  await page.getByRole('tab', { name: 'Activities' }).click();
  await page
    .getByLabel('What would make a connection feel worthwhile?')
    .fill('Shared activities on weekday evenings');
  await page.getByRole('button', { name: 'Save and review' }).click();
  await page.getByRole('button', { name: 'Save manually' }).click();
  await expect(
    page.getByRole('heading', { name: /Saved, with your control intact/ }),
  ).toBeVisible();
  expect(calls.answerModes).toEqual(['activities']);
  expect(calls.preferenceModes).toEqual(['activities']);
});

test('provider unavailable and version conflict are presented in the mobile flow', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mockOnboarding(page, 409);
  await page.goto('/onboarding');
  await page.getByRole('button', { name: 'Create session' }).click();
  await page.getByRole('button', { name: 'Skip to manual review' }).click();
  await page.getByRole('button', { name: 'Request editable AI suggestion' }).click();
  const errorAlert = page.locator('p[role="alert"]');
  await expect(errorAlert).toContainText('503');
  await expect(errorAlert).toHaveCount(1);
  await page.getByRole('button', { name: 'Save manually' }).click();
  await expect(errorAlert).toContainText('409');
  await expect(page.getByText('Save manually')).toBeVisible();
});
