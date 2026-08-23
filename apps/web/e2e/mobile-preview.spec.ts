import { expect, test } from '@playwright/test';

test('fixed mobile preview shows incoming, sent and published states in a 390px context', async ({
  page,
}) => {
  await page.goto('/mobile-preview');

  await expect(page.getByRole('heading', { name: '手机端预览' })).toBeVisible();
  const frame = page.frameLocator('iframe[title="Women AI Network · 聊天"]');
  await expect(frame.getByRole('button', { name: '打开 Aisha Rahman 的新消息' })).toBeVisible();
  await expect(frame.locator('.mobile-unread-badge').filter({ hasText: '2' })).toBeVisible();
  await expect(
    frame.locator('.mobile-conversation-list').getByText('谢谢你分享成都的生活'),
  ).toBeVisible();

  await frame.getByRole('button', { name: '打开 Aisha Rahman 的新消息' }).click();
  await expect(frame.getByRole('heading', { name: 'Aisha Rahman', exact: true })).toBeVisible();
  await expect(
    frame
      .locator('.mobile-thread-screen')
      .getByText('很高兴这封信让你产生共鸣。下次我想听听你所在城市的故事'),
  ).toBeVisible();
  await expect(frame.locator('.mobile-messages-screen')).toBeVisible();
  await expect(frame.locator('.messages-shell')).toBeHidden();

  expect(
    await page.locator('.mobile-preview-frame').evaluate((element) => element.clientWidth),
  ).toBe(390);

  await page.getByRole('button', { name: '查看已发送交流信息' }).click();
  await expect(frame.getByRole('heading', { name: 'Aisha Rahman', exact: true })).toBeVisible();

  await page.getByRole('button', { name: '查看已发布公开信' }).click();
  const worldFrame = page.frameLocator('iframe[title="Women AI Network · 世界"]');
  await expect(
    worldFrame.locator('.mobile-world-screen').getByText('写给世界：成都清晨的第一束光'),
  ).toBeVisible();
  await expect(
    worldFrame.locator('.mobile-world-screen').getByText('公开信已发布 · 仅用于手机端视觉预览'),
  ).toBeVisible();
});
