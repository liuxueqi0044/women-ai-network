import { describe, expect, it } from 'vitest';
import {
  notificationEventSchema,
  notificationIngestRequestSchema,
  notificationPreferencesRequestSchema,
  notificationWakeJobSchema,
} from '../../src/index.js';

describe('NTF-01 closed event registry', () => {
  it('accepts only versioned safe parameters', () => {
    expect(
      notificationEventSchema.parse({
        event_key: 'message.received',
        event_version: 1,
        parameters: { conversation_type: 'direct' },
      }),
    ).toBeTruthy();
    expect(() =>
      notificationEventSchema.parse({
        event_key: 'message.received',
        event_version: 1,
        parameters: { body: 'private text' },
      }),
    ).toThrow();
    expect(() =>
      notificationEventSchema.parse({ event_key: 'made.up', event_version: 1, parameters: {} }),
    ).toThrow();
  });
  it('rejects sensitive/open-ended ingest and accepts opaque queue jobs only', () => {
    expect(() =>
      notificationIngestRequestSchema.parse({
        recipient_account_id: '00000000-0000-4000-8000-000000000001',
        resource_kind: 'event',
        resource_id: 'event:1',
        event: { event_key: 'event.reminder', event_version: 1, parameters: { hours_before: 24 } },
        idempotency_key: '1234567890123456',
        body: 'secret',
      }),
    ).toThrow();
    expect(
      notificationWakeJobSchema.parse({ intent_id: '00000000-0000-4000-8000-000000000001' }),
    ).toEqual({ intent_id: '00000000-0000-4000-8000-000000000001' });
    expect(() =>
      notificationWakeJobSchema.parse({
        intent_id: '00000000-0000-4000-8000-000000000001',
        resource_id: 'leak',
      }),
    ).toThrow();
  });
  it('does not allow a caller to manufacture the critical-safety exception', () => {
    expect(() =>
      notificationPreferencesRequestSchema.parse({
        items: [
          {
            channel: 'email',
            category: 'critical-safety',
            enabled: true,
            quiet_start_minute: 0,
            quiet_end_minute: 1,
            digest_cadence: 'immediate',
            critical_safety_exception: true,
          },
        ],
      }),
    ).toThrow();
  });
});
