import { expect, test } from '@playwright/test';

const apiOrigin = () => process.env['WAI_E2E_API_URL'] ?? 'http://127.0.0.1:3187';
const prefs = {
  ui_locale: 'fr',
  content_locales: ['fr', 'en'],
  time_zone: 'Asia/Kolkata',
  hour_cycle: 'h12',
  week_start: 6,
};

test('real session saves all globalization fields and survives reload', async ({ page }) => {
  const email = `glo-real-${Date.now()}@example.invalid`;
  const password = 'correct horse battery staple';
  const registration = await page.request.post(`${apiOrigin()}/v1/account/registrations`, {
    data: { email, password },
  });
  expect(registration.ok()).toBeTruthy();
  const login = await page.request.post(`${apiOrigin()}/v1/account/sessions`, {
    data: { email, password },
  });
  expect(login.ok()).toBeTruthy();
  const sessionCookie = login
    .headersArray()
    .find((header) => header.name.toLowerCase() === 'set-cookie')
    ?.value.match(/(wai_session(?:_dev)?=[^;]+)/);
  expect(sessionCookie).toBeTruthy();
  const [cookieName, session] = (sessionCookie?.[1] ?? '').split('=');
  await page.context().addCookies([
    {
      name: cookieName ?? 'wai_session_dev',
      value: session ?? '',
      domain: '127.0.0.1',
      path: '/',
    },
  ]);

  await page.goto('/settings/language');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await page.getByLabel(/Interface language|Langue de l’interface/).selectOption('fr');
  await page.getByLabel(/Content languages|Langues du contenu/).fill('fr, en, fr');
  await page.getByLabel(/Time zone|Fuseau horaire/).fill(prefs.time_zone);
  await page.getByLabel(/Clock format|Format de l’horloge/).selectOption(prefs.hour_cycle);
  await page.getByLabel(/Week starts|La semaine commence/).selectOption(String(prefs.week_start));
  await page.getByRole('button', { name: /Save preferences|Enregistrer/ }).click();
  await expect(page.getByRole('status')).toContainText(/saved|enregistr/i);
  await page.reload();
  await expect(page.getByLabel(/Time zone|Fuseau horaire/)).toHaveValue(prefs.time_zone);
  await expect(page.getByLabel(/Content languages|Langues du contenu/)).toHaveValue('fr, en');
  await expect(page.getByLabel(/Clock format|Format de l’horloge/)).toHaveValue(prefs.hour_cycle);
  await expect(page.getByLabel(/Week starts|La semaine commence/)).toHaveValue(
    String(prefs.week_start),
  );
  await expect(page.locator('select').first()).toHaveValue('fr');
  await expect(page.locator('html')).toHaveAttribute('lang', 'fr');

  const read = await page.request.get(`${apiOrigin()}/v1/globalization/preferences`);
  expect(read.status()).toBe(200);
  const current = (await read.json()) as { version: number };
  const stale = await page.request.put(`${apiOrigin()}/v1/globalization/preferences`, {
    headers: {
      'If-Match': `"${current.version}"`,
      'Idempotency-Key': `real-external-${Date.now()}`,
      Origin: `http://127.0.0.1:${process.env['WAI_E2E_WEB_PORT'] ?? 3188}`,
    },
    data: { ...prefs, week_start: 5 },
  });
  expect(stale.status()).toBe(200);
  await page.getByLabel(/Content languages|Langues du contenu/).fill('fr, en');
  await page.getByRole('button', { name: /Save preferences|Enregistrer/ }).click();
  await expect(page.locator('p[role="alert"]')).toContainText(/changed|modif/i);
});

test('real shell localizes in the same SPA and stays within a narrow viewport', async ({
  page,
}) => {
  const email = `glo-shell-${Date.now()}@example.invalid`;
  const password = 'correct horse battery staple';
  const registration = await page.request.post(`${apiOrigin()}/v1/account/registrations`, {
    data: { email, password },
  });
  expect(registration.ok()).toBeTruthy();
  const login = await page.request.post(`${apiOrigin()}/v1/account/sessions`, {
    data: { email, password },
  });
  const sessionCookie = login
    .headersArray()
    .find((header) => header.name.toLowerCase() === 'set-cookie')
    ?.value.match(/(wai_session(?:_dev)?=[^;]+)/);
  expect(sessionCookie).toBeTruthy();
  const [cookieName, session] = (sessionCookie?.[1] ?? '').split('=');
  await page.context().addCookies([
    {
      name: cookieName ?? 'wai_session_dev',
      value: session ?? '',
      domain: '127.0.0.1',
      path: '/',
    },
  ]);
  await page.goto('/settings/language');
  await page.getByLabel(/Interface language/).selectOption('fr');
  await page.getByRole('button', { name: /Save preferences/ }).click();
  await expect(page.getByRole('status')).toContainText(/saved|enregistr/i);
  await expect(page.locator('html')).toHaveAttribute('lang', 'fr');
  // Desktop home is the brand link. The approved four-tab mobile navigation
  // intentionally has no separate Home tab.
  await page.getByRole('link', { name: 'Women AI Network home', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(
    'Une façon plus douce de se rencontrer.',
  );
  await page.getByRole('link', { name: 'Monde', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Lettres du monde');
  await page.getByRole('link', { name: 'Messages', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Messages');
  await page.setViewportSize({ width: 320, height: 800 });
  for (const nav of ['Monde', 'Messages', 'Moi']) {
    await page.getByRole('link', { name: nav, exact: true }).click();
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth,
    );
    expect(overflow, `${nav} horizontally overflows at 320px`).toBe(false);
  }
});
