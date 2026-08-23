import { describe, expect, it } from 'vitest';
import { MediaController } from './media.controller.js';

const session = { accountId: '11111111-1111-4111-8111-111111111111' } as never;
const malformed = 'not-a-uuid';
const service = {
  completeIntent: async () => ({ state: 'uploaded', jobId: null }),
  status: async () => ({
    asset_id: malformed,
    state: 'clean',
    detected_type: null,
    rendition: null,
  }),
  accessAsset: async () => ({
    token: 'x',
    expiresAt: new Date(),
    contentType: 'image/jpeg',
    bytes: 1,
  }),
  redeemAccess: async () => ({
    token: 'x',
    expiresAt: new Date(),
    contentType: 'image/jpeg',
    bytes: 1,
    deliveryTarget: 'https://media.test/clean/x',
  }),
  delete: async () => undefined,
} as never;

describe('MED-01 controller asset id boundary', () => {
  it.each(['complete', 'status', 'access', 'redeem', 'delete'])(
    'rejects malformed UUID before %s service call',
    async (route) => {
      const controller = new MediaController(service);
      const call =
        route === 'complete'
          ? controller.complete(session, malformed, { idempotency_key: 'complete-key-123' })
          : route === 'status'
            ? controller.status(session, malformed)
            : route === 'access'
              ? controller.access(session, malformed, { purpose: 'profile_avatar' })
              : route === 'redeem'
                ? controller.redeem(session, malformed, {
                    token: 'token',
                    purpose: 'profile_avatar',
                  })
                : controller.remove(session, malformed, { asset_id: malformed });
      await expect(call).rejects.toThrow(/UUID v4/);
    },
  );
});
