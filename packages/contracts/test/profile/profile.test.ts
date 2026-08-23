import { describe, expect, it } from 'vitest';
import {
  ProfileVisibilityPolicy,
  factAudienceSchema,
  factWriteSchema,
  profileWriteSchema,
  type ProfileFactRecord,
} from '../../src/index.js';

describe('PRF-01 contracts and visibility', () => {
  const fact: ProfileFactRecord = {
    factKey: 'about_me',
    value: 'hello',
    sensitivity: 'low',
    state: 'confirmed',
    source: 'user_confirmed',
    confirmedAt: new Date(),
  };

  it('rejects unknown fields in strict DTOs', () => {
    expect(profileWriteSchema.safeParse({ display_name: 'A', extra: true }).success).toBe(false);
    expect(
      factWriteSchema.safeParse({ value: 'x', source: 'user_confirmed', extra: true }).success,
    ).toBe(false);
    expect(factWriteSchema.safeParse({ value: 'x', source: 'approved_draft' }).success).toBe(false);
    expect(
      factAudienceSchema.safeParse({
        audience: 'self',
        age_partition: 'adult',
        mode: 'friends',
        extra: true,
      }).success,
    ).toBe(false);
  });

  it('viewer relationship mode and age policy matrix', () => {
    const policy = new ProfileVisibilityPolicy();
    const base = {
      viewerAccountId: 'viewer',
      subjectAccountId: 'subject',
      relationship: 'connection' as const,
      mode: 'friends' as const,
      viewerAgePartition: 'adult' as const,
      subjectAgePartition: 'adult' as const,
      viewerCommunity: 'eligible' as const,
      subjectCommunity: 'eligible' as const,
    };
    expect(policy.decide(base).allowFact(fact, 'connections', 'adult')).toBe(true);
    expect(
      policy.decide({ ...base, relationship: 'member' }).allowFact(fact, 'connections', 'adult'),
    ).toBe(false);
    expect(policy.decide({ ...base, subjectAgePartition: 'youth' }).allowProfile).toBe(false);
    expect(policy.decide({ ...base, viewerCommunity: 'limited' }).allowProfile).toBe(false);
  });

  it('AI-only facts never serialize to another member', () => {
    const policy = new ProfileVisibilityPolicy();
    const decision = policy.decide({
      viewerAccountId: 'viewer',
      subjectAccountId: 'subject',
      relationship: 'connection',
      mode: 'friends',
      viewerAgePartition: 'adult',
      subjectAgePartition: 'adult',
      viewerCommunity: 'eligible',
      subjectCommunity: 'eligible',
    });
    expect(
      decision.allowFact({ ...fact, sensitivity: 'ai_only' }, 'verified_members', 'adult'),
    ).toBe(false);
  });

  it('owner self view retains a proposed fact while member view does not', () => {
    const policy = new ProfileVisibilityPolicy();
    const input = {
      viewerAccountId: 'same',
      subjectAccountId: 'same',
      relationship: 'self' as const,
      mode: 'dating' as const,
      viewerAgePartition: 'adult' as const,
      subjectAgePartition: 'adult' as const,
      viewerCommunity: 'denied' as const,
      subjectCommunity: 'denied' as const,
      ownerBypass: true,
    };
    expect(policy.decide(input).allowFact({ ...fact, state: 'proposed' }, 'self', 'adult')).toBe(
      true,
    );
    expect(
      policy
        .decide({
          ...input,
          viewerAccountId: 'other',
          subjectAccountId: 'same',
          relationship: 'member',
          viewerCommunity: 'eligible',
          subjectCommunity: 'eligible',
          ownerBypass: false,
        })
        .allowFact({ ...fact, state: 'proposed' }, 'verified_members', 'adult'),
    ).toBe(false);
    expect(
      policy
        .decide({
          ...input,
          ownerBypass: false,
          relationship: 'member',
          viewerCommunity: 'eligible',
          subjectCommunity: 'eligible',
        })
        .allowFact({ ...fact, sensitivity: 'ai_only' }, 'verified_members', 'adult'),
    ).toBe(false);
  });
});
