import { describe, expect, it } from 'vitest';
import {
  privateDeliveryCreateRequestSchema,
  privateDeliveryWakeupSchema,
} from '../../src/private-delivery/index.js';

describe('PVL private-delivery contracts', () => {
  it('rejects client-controlled sender, connection, epoch, policy, and snapshot fields', () => {
    const result = privateDeliveryCreateRequestSchema.safeParse({
      recipient_id: '00000000-0000-4000-8000-000000000001',
      letter_id: '00000000-0000-4000-8000-000000000002',
      revision: 1,
      purpose: 'private_letter_delivery',
      consent: { explicit: true },
      sender_id: '00000000-0000-4000-8000-000000000003',
      connection_id: '00000000-0000-4000-8000-000000000004',
    });
    expect(result.success).toBe(false);
  });

  it('accepts only opaque UUID worker wakeups', () => {
    expect(
      privateDeliveryWakeupSchema.safeParse({
        delivery_id: '00000000-0000-4000-8000-000000000001',
      }).success,
    ).toBe(true);
    expect(
      privateDeliveryWakeupSchema.safeParse({ delivery_id: 'not-a-uuid', body: 'secret' }).success,
    ).toBe(false);
  });
});
