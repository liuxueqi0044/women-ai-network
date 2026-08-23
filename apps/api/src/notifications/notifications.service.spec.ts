import { describe, expect, it, vi } from 'vitest';
import { NotificationsService } from './notifications.service.js';

const accountId = '00000000-0000-4000-8000-000000000001';
const hidden = {
  id: '00000000-0000-4000-8000-000000000101',
  recipient_account_id: accountId,
  resource_kind: 'letter' as const,
  resource_id: 'hidden-resource',
  event_key: 'letter.received' as const,
  event_version: 1,
  category: 'letters' as const,
  message_key: 'notifications.letter.received',
  parameters: { source: 'member' },
  read_at: null,
  created_at: '2026-01-01T00:00:00.000Z',
};
const visible = {
  ...hidden,
  id: '00000000-0000-4000-8000-000000000102',
  resource_id: 'allowed-resource',
};
const globalization = {
  account_id: accountId,
  ui_locale: 'en' as const,
  content_locales: ['en' as const],
  time_zone: 'UTC',
  hour_cycle: 'h23' as const,
  week_start: 1 as const,
  version: 1,
  updated_at: '2026-01-01T00:00:00.000Z',
};

describe('NotificationsService scan budget', () => {
  it('returns a resumable cursor after 100 hidden pages instead of scanning unbounded history', async () => {
    let calls = 0;
    const repo = {
      list: vi.fn(async (_accountId: string, _input: unknown) => {
        calls += 1;
        return { items: [hidden], next_cursor: `cursor-${calls}` as string | null };
      }),
    };
    const service = new NotificationsService(
      repo as never,
      { iam: { secretPepper: 'c'.repeat(64) } } as never,
      { enqueue: vi.fn() } as never,
      { read: vi.fn(async () => globalization) } as never,
      {
        check: vi.fn(async ({ resourceId }: { resourceId: string }) => ({
          allowed: resourceId === 'allowed-resource',
        })),
      } as never,
    );

    const first = await service.list(accountId, 1);
    expect(calls).toBe(100);
    expect(first.items).toEqual([]);
    expect(first.next_cursor).toBe('cursor-100');

    repo.list.mockResolvedValueOnce({ items: [visible], next_cursor: null });
    const second = await service.list(accountId, 1, first.next_cursor ?? undefined);
    expect(second.items).toHaveLength(1);
    expect(second.items[0]).toMatchObject({ id: visible.id });
  });
});
