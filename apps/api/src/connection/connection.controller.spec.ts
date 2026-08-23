import { describe, expect, it, vi } from 'vitest';
import { ConnectionController } from './connection.controller.js';

describe('CON-01 controller boundary', () => {
  it('rejects malformed connection ids before service/repository access', async () => {
    const service = { get: vi.fn(), action: vi.fn() } as never;
    const controller = new ConnectionController(service);
    const session = { accountId: '00000000-0000-4000-8000-000000000001' } as never;
    await expect(controller.get(session, 'not-a-uuid')).rejects.toMatchObject({ status: 400 });
    expect((service as { get: ReturnType<typeof vi.fn> }).get).not.toHaveBeenCalled();
  });

  it('rejects malformed request ids for actions', async () => {
    const service = { action: vi.fn() } as never;
    const controller = new ConnectionController(service);
    const session = { accountId: '00000000-0000-4000-8000-000000000001' } as never;
    await expect(controller.accept(session, 'bad', undefined, undefined)).rejects.toMatchObject({
      status: 400,
    });
  });

  it('rejects malformed list cursors at the HTTP boundary', async () => {
    const service = { list: vi.fn() } as never;
    const controller = new ConnectionController(service);
    const session = { accountId: '00000000-0000-4000-8000-000000000001' } as never;
    await expect(controller.list(session, { limit: '1', cursor: '!' })).rejects.toMatchObject({
      status: 400,
    });
    expect((service as { list: ReturnType<typeof vi.fn> }).list).not.toHaveBeenCalled();
  });
});
