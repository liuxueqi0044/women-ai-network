import { describe, expect, it } from 'vitest';
import {
  MEDIA_STATES,
  mediaAccessRequestSchema,
  mediaCompleteSchema,
  mediaPurposeSchema,
  mediaUploadIntentSchema,
  mediaProcessJobSchema,
  canTransitionMediaState,
} from '../../src/media/index.js';

describe('MED-01 media contracts', () => {
  it('accepts only bounded upload intent declarations', () => {
    expect(
      mediaUploadIntentSchema.parse({
        purpose: 'profile_avatar',
        declared_size: 1024,
        declared_content_type: 'image/jpeg',
        idempotency_key: 'media-intent-1',
      }),
    ).toMatchObject({ purpose: 'profile_avatar', declared_size: 1024 });
    expect(() =>
      mediaUploadIntentSchema.parse({
        purpose: 'profile_avatar',
        declared_size: 25 * 1024 * 1024 + 1,
        idempotency_key: 'media-intent-1',
      }),
    ).toThrow();
    expect(() => mediaPurposeSchema.parse('chat_attachment')).toThrow();
  });

  it('rejects unknown fields and malformed complete/access payloads', () => {
    expect(() =>
      mediaCompleteSchema.parse({ object_key: 'client-controlled', unexpected: true }),
    ).toThrow();
    expect(() => mediaAccessRequestSchema.parse({ asset_id: 'not-a-uuid' })).toThrow();
  });

  it('keeps delivery unreachable until clean', () => {
    expect(MEDIA_STATES).not.toContain('delivered');
    expect(canTransitionMediaState('uploaded', 'scanning')).toBe(true);
    expect(canTransitionMediaState('uploaded', 'clean')).toBe(false);
    expect(canTransitionMediaState('rejected', 'clean')).toBe(false);
  });

  it('strictly validates media wake references before worker claims', () => {
    expect(
      mediaProcessJobSchema.parse({
        job_id: '55555555-5555-4555-8555-555555555555',
        asset_id: '33333333-3333-4333-8333-333333333333',
      }),
    ).toBeTruthy();
    expect(() =>
      mediaProcessJobSchema.parse({
        job_id: 'not-a-uuid',
        asset_id: '33333333-3333-4333-8333-333333333333',
      }),
    ).toThrow();
  });
});
