import { describe, expect, it, vi } from 'vitest';
import { CirclesService } from './circles.service.js';

const config = { iam: { secretPepper: 'x'.repeat(40) } } as any;
const body = {
  name: 'Circle',
  visibility: 'approval_required',
  mode: 'friends',
  scope_kind: 'online',
  topics: ['culture'],
  member_cap: 10,
};
describe('CirclesService', () => {
  it('requires final gate after create', async () => {
    const repo = {
      create: vi.fn().mockResolvedValue({
        id: '00000000-0000-4000-8000-000000000001',
        name: 'Circle',
        description_available: false,
        lifecycle: 'draft',
        visibility: 'approval_required',
        mode: 'friends',
        scope_kind: 'online',
        country_code: null,
        city_label: null,
        topic_catalog_version: 1,
        topics: ['culture'],
        member_cap: 10,
        member_count: 1,
        role: 'owner',
        created_at: '2026-08-15T00:00:00.000Z',
        updated_at: '2026-08-15T00:00:00.000Z',
      }),
    };
    const gate = { check: vi.fn().mockResolvedValue({ allowed: true, role: 'owner' }) };
    const service = new CirclesService(
      repo as any,
      gate as any,
      config,
      {
        consume: vi.fn().mockResolvedValue({ allowed: true }),
      } as any,
      { reportWithSnapshot: vi.fn() } as any,
    );
    await service.create('00000000-0000-4000-8000-000000000002', body, 'idempotency-key-123456');
    expect(gate.check).toHaveBeenCalledWith(expect.objectContaining({ operation: 'read' }));
  });
  it('fails closed when final gate denies', async () => {
    const gate = { check: vi.fn().mockResolvedValue({ allowed: false }) };
    const service = new CirclesService(
      {} as any,
      gate as any,
      config,
      {
        consume: vi.fn().mockResolvedValue({ allowed: true }),
      } as any,
      { reportWithSnapshot: vi.fn() } as any,
    );
    await expect(service.get('a', '00000000-0000-4000-8000-000000000001')).rejects.toMatchObject({
      status: 404,
    });
  });
  it.each(['notes', 'members'] as const)(
    'fails closed when %s authorization is revoked after repository read',
    async (surface) => {
      const gate = {
        check: vi
          .fn()
          .mockResolvedValueOnce({ allowed: true, role: 'member' })
          .mockResolvedValueOnce({ allowed: false }),
      };
      const repo = {
        listNotes: vi.fn().mockResolvedValue({ items: [], next_cursor: null }),
        listMembers: vi.fn().mockResolvedValue({ items: [], next_cursor: null }),
      };
      const service = new CirclesService(
        repo as any,
        gate as any,
        config,
        { consume: vi.fn().mockResolvedValue({ allowed: true }) } as any,
        { reportWithSnapshot: vi.fn() } as any,
      );
      await expect(
        service[surface]('actor', '00000000-0000-4000-8000-000000000001', {}),
      ).rejects.toMatchObject({ status: 404 });
      expect(gate.check).toHaveBeenCalledTimes(2);
    },
  );
  it.each([
    [
      'notes',
      'listNotes',
      {
        id: '00000000-0000-4000-8000-000000000011',
        circle_id: '00000000-0000-4000-8000-000000000001',
        author_account_id: '00000000-0000-4000-8000-000000000012',
        body: 'private note body',
        created_at: '2026-08-15T00:00:00.000Z',
      },
      'author_account_id',
      'read',
    ],
    [
      'members',
      'listMembers',
      {
        account_id: '00000000-0000-4000-8000-000000000022',
        role: 'member',
        created_at: '2026-08-15T00:00:00.000Z',
      },
      'account_id',
      'read',
    ],
    [
      'joinRequests',
      'listJoinRequests',
      {
        id: '00000000-0000-4000-8000-000000000031',
        account_id: '00000000-0000-4000-8000-000000000032',
        message: 'private applicant message',
        created_at: '2026-08-15T00:00:00.000Z',
      },
      'account_id',
      'admit',
    ],
  ] as const)(
    'removes revoked %s subjects after the repository scan',
    async (surface, repositoryMethod, row, subjectKey, operation) => {
      const gate = {
        check: vi
          .fn()
          .mockResolvedValueOnce({ allowed: true, role: 'moderator' })
          .mockResolvedValueOnce({ allowed: false })
          .mockResolvedValueOnce({ allowed: true, role: 'moderator' }),
      };
      const repo = {
        [repositoryMethod]: vi
          .fn()
          .mockResolvedValue({ items: [row], next_cursor: 'opaque-cursor' }),
      };
      const service = new CirclesService(
        repo as any,
        gate as any,
        config,
        { consume: vi.fn().mockResolvedValue({ allowed: true }) } as any,
        { reportWithSnapshot: vi.fn() } as any,
      );
      const result = await (service as any)[surface](
        'actor',
        '00000000-0000-4000-8000-000000000001',
        {},
      );
      expect(result).toMatchObject({ items: [], next_cursor: 'opaque-cursor' });
      expect(gate.check).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          subjectAccountId: (row as unknown as Record<string, string>)[subjectKey],
          operation,
          ...(surface === 'joinRequests' ? { requiredRole: 'moderator' } : {}),
        }),
      );
    },
  );
  it('fails closed when the listing actor is revoked after the subject recheck', async () => {
    const gate = {
      check: vi
        .fn()
        .mockResolvedValueOnce({ allowed: true })
        .mockResolvedValueOnce({ allowed: true })
        .mockResolvedValueOnce({ allowed: false }),
    };
    const repo = {
      listNotes: vi.fn().mockResolvedValue({
        items: [
          {
            id: '00000000-0000-4000-8000-000000000041',
            circle_id: '00000000-0000-4000-8000-000000000001',
            author_account_id: '00000000-0000-4000-8000-000000000042',
            body: 'must not return',
            created_at: '2026-08-15T00:00:00.000Z',
          },
        ],
        next_cursor: null,
      }),
    };
    const service = new CirclesService(
      repo as any,
      gate as any,
      config,
      { consume: vi.fn().mockResolvedValue({ allowed: true }) } as any,
      { reportWithSnapshot: vi.fn() } as any,
    );
    await expect(
      service.notes('owner', '00000000-0000-4000-8000-000000000001', {}),
    ).rejects.toMatchObject({ status: 404 });
  });
});
