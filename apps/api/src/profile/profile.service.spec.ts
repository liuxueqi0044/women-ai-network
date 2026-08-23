import { describe, expect, it, vi } from 'vitest';
import { ProfileVisibilityPolicy, type ProfileRecord } from '@wai/contracts';
import { ProfileService } from './profile.service.js';

const SUBJECT = '11111111-1111-4111-8111-111111111111';
const VIEWER = '22222222-2222-4222-8222-222222222222';
const PROFILE_ID = '33333333-3333-4333-8333-333333333333';
const confirmedAt = new Date('2026-01-01T00:00:00.000Z');

function profile(state: ProfileRecord['state'] = 'active'): ProfileRecord {
  return {
    profileId: PROFILE_ID,
    accountId: SUBJECT,
    displayName: 'Member',
    state,
    version: 2,
    facts: [
      {
        factKey: 'about_me',
        value: 'hello',
        sensitivity: 'low',
        state: 'confirmed',
        source: 'user_confirmed',
        confirmedAt,
      },
      {
        factKey: 'availability',
        value: 'weekends',
        sensitivity: 'sensitive',
        state: 'confirmed',
        source: 'user_confirmed',
        confirmedAt,
      },
      {
        factKey: 'ai_profile_summary',
        value: 'private inference',
        sensitivity: 'ai_only',
        state: 'confirmed',
        source: 'approved_draft',
        confirmedAt,
      },
    ],
  };
}

function makeService(
  relationship: 'none' | 'member' | 'connection' = 'member',
  state: ProfileRecord['state'] = 'active',
) {
  const subject = profile(state);
  const audits: Array<{ decision: string; factKey: string }> = [];
  const repo = {
    getOrCreate: vi.fn().mockResolvedValue(subject),
    findByProfileId: vi.fn().mockResolvedValue(subject),
    getAudience: vi.fn(async (_account: string, factKey: string, mode: string) => {
      if (factKey === 'about_me')
        return { audience: 'verified_members' as const, agePartition: 'adult' as const };
      if (factKey === 'availability' && mode === 'professional')
        return { audience: 'connections' as const, agePartition: 'adult' as const };
      if (factKey === 'ai_profile_summary')
        return { audience: 'verified_members' as const, agePartition: 'adult' as const };
      return null;
    }),
    isMatchingEnabled: vi.fn(
      async (_account: string, factKey: string, mode: string) =>
        factKey === 'about_me' || (factKey === 'availability' && mode === 'professional'),
    ),
    appendSensitiveAudit: vi.fn(async (input: { decision: string; factKey: string }) => {
      audits.push(input);
    }),
  };
  const community = { decide: vi.fn().mockResolvedValue({ decision: 'eligible' as const }) };
  const partition = {
    self: vi.fn().mockResolvedValue({ ageBand: 'adult' }),
    decide: vi.fn().mockResolvedValue({
      decision: 'allow' as const,
      actorAgeBand: 'adult',
      subjectAgeBand: 'adult',
    }),
  };
  const relationshipPort = {
    decide: vi.fn().mockResolvedValue({ relationship }),
  };
  const service = new ProfileService(
    repo as never,
    new ProfileVisibilityPolicy(),
    community,
    partition,
    relationshipPort,
  );
  return { service, repo, community, partition, relationshipPort, audits };
}

describe('PRF-01 ProfileService serialization and access audit', () => {
  it('keeps AI-only facts self-only and excludes them from member/matching DTOs', async () => {
    const { service } = makeService('member');
    const self = await service.selfView(SUBJECT);
    expect(self.facts.map((fact) => fact.fact_key)).toContain('ai_profile_summary');
    expect(self).toHaveProperty('account_id', SUBJECT);

    const member = await service.preview(SUBJECT, 'member', 'friends');
    expect(member.facts.map((fact) => fact.fact_key)).toEqual(['about_me']);
    expect(member).not.toHaveProperty('account_id');

    const matching = await service.preview(SUBJECT, 'matching', 'friends');
    expect(matching.facts.map((fact) => fact.fact_key)).toEqual(['about_me']);
    expect(matching).not.toHaveProperty('account_id');
  });

  it('uses the actual relationship and per-mode matching use for connection fields', async () => {
    const memberService = makeService('member').service;
    const member = await memberService.viewerView(VIEWER, PROFILE_ID, 'professional');
    expect(member.facts.map((fact) => fact.fact_key)).toEqual(['about_me']);

    const connection = makeService('connection');
    const matching = await connection.service.viewerView(VIEWER, PROFILE_ID, 'professional');
    expect(matching.facts.map((fact) => fact.fact_key)).toEqual(['about_me', 'availability']);
    expect(matching).not.toHaveProperty('account_id');
  });

  it('audits sensitive allow and deny decisions through the service', async () => {
    const allowed = makeService('connection');
    await allowed.service.viewerView(VIEWER, PROFILE_ID, 'professional');
    expect(allowed.audits).toContainEqual(
      expect.objectContaining({ decision: 'allow', factKey: 'availability' }),
    );

    const denied = makeService('member');
    await denied.service.viewerView(VIEWER, PROFILE_ID, 'professional');
    expect(denied.audits).toContainEqual(
      expect.objectContaining({ decision: 'deny', factKey: 'availability' }),
    );
  });

  it('uniformly denies inactive profiles, ELG denial, and verification/community denial', async () => {
    await expect(
      makeService('member', 'draft').service.viewerView(VIEWER, PROFILE_ID, 'friends'),
    ).rejects.toMatchObject({ status: 404 });

    const elg = makeService('member');
    elg.partition.decide.mockResolvedValue({
      decision: 'deny',
      actorAgeBand: 'adult',
      subjectAgeBand: 'adult',
    });
    await expect(elg.service.viewerView(VIEWER, PROFILE_ID, 'friends')).rejects.toMatchObject({
      status: 404,
    });

    const verification = makeService('member');
    verification.community.decide.mockResolvedValue({ decision: 'denied' });
    await expect(
      verification.service.viewerView(VIEWER, PROFILE_ID, 'friends'),
    ).rejects.toMatchObject({ status: 404 });
  });
});
