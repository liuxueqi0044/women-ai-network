import { describe, expect, it } from 'vitest';
import {
  blockCreateRequestSchema,
  evidenceSafeMetadataSchema,
  reportCreateRequestSchema,
} from '../../src/safety/index.js';
describe('SAF contracts', () => {
  it('rejects self block shape extras and weak idempotency', () => {
    expect(
      blockCreateRequestSchema.safeParse({
        blocked_account_id: 'x',
        reason: 'other',
        idempotency_key: 'short',
      }).success,
    ).toBe(false);
    expect(
      blockCreateRequestSchema.safeParse({
        blocked_account_id: '123e4567-e89b-42d3-a456-426614174000',
        reason: 'other',
        idempotency_key: '1234567890123456',
        extra: 'x',
      }).success,
    ).toBe(false);
  });
  it('closes evidence metadata to the allowlist', () => {
    expect(
      evidenceSafeMetadataSchema.safeParse({ account_state: 'active', email: 'secret' }).success,
    ).toBe(false);
    expect(
      evidenceSafeMetadataSchema.safeParse({ message_version: 'v1', moderation_state: 'visible' })
        .success,
    ).toBe(true);
  });
  it('does not accept client evidence body fields', () => {
    expect(
      reportCreateRequestSchema.safeParse({
        subject_account_id: '123e4567-e89b-42d3-a456-426614174000',
        target_type: 'message',
        target_id: 'm1',
        category: 'other',
        idempotency_key: '1234567890123456',
        body: 'secret',
      }).success,
    ).toBe(false);
  });
});
