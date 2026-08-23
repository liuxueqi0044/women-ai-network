import { HttpException, Inject, Injectable } from '@nestjs/common';
import {
  canonicalJsonHash,
  ProfileConcurrencyError,
  ProfileFactError,
  ProfileIdempotencyConflictError,
} from '@wai/db';
import type {
  AgePartition,
  MatchingMode,
  ProfileAgePartitionPort,
  ProfileMutationResponse,
  ProfileRecord,
  ProfileSelfView,
  ProfileView,
  ProfilePublishResponse,
  ProfileRelationshipPort,
  ProfileRepositoryPort,
  ProfileVisibilityDecisionPort,
} from '@wai/contracts';
import { profileMemberViewSchema, profileSelfViewSchema } from '@wai/contracts';
import { COMMUNITY_ACCESS_DECISION_PORT } from '../verification/verification.tokens.js';
import {
  PROFILE_RELATIONSHIP,
  PROFILE_REPOSITORY,
  PROFILE_VISIBILITY_POLICY,
} from './profile.tokens.js';
import { PROFILE_AGE_PARTITION } from './profile.tokens.js';
import type { CommunityAccessDecisionPort } from '@wai/contracts';

@Injectable()
export class ProfileService {
  constructor(
    @Inject(PROFILE_REPOSITORY) private readonly profiles: ProfileRepositoryPort,
    @Inject(PROFILE_VISIBILITY_POLICY) private readonly policy: ProfileVisibilityDecisionPort,
    @Inject(COMMUNITY_ACCESS_DECISION_PORT) private readonly community: CommunityAccessDecisionPort,
    @Inject(PROFILE_AGE_PARTITION) private readonly partition: ProfileAgePartitionPort,
    @Inject(PROFILE_RELATIONSHIP) private readonly relationship: ProfileRelationshipPort,
  ) {}

  me(accountId: string): Promise<ProfileRecord> {
    return this.profiles.getOrCreate(accountId);
  }

  async update(
    accountId: string,
    input: { displayName: string; city?: string; countryCode?: string },
    expectedVersion: number,
    idempotencyKey: string,
  ): Promise<ProfileMutationResponse> {
    await this.profiles.getOrCreate(accountId);
    return this.mutation(
      await this.wrap(() =>
        this.profiles.updateProfile({
          accountId,
          expectedVersion,
          idempotencyKey,
          payloadDigest: canonicalJsonHash(input),
          displayName: input.displayName,
          ...(input.city === undefined ? {} : { city: input.city }),
          ...(input.countryCode === undefined ? {} : { countryCode: input.countryCode }),
        }),
      ),
    );
  }
  async putFact(
    accountId: string,
    factKey: string,
    input: { value: string | boolean | number; source: 'user_confirmed' | 'approved_draft' },
    expectedVersion: number,
    idempotencyKey: string,
  ): Promise<ProfileMutationResponse> {
    await this.profiles.getOrCreate(accountId);
    return this.mutation(
      await this.wrap(() =>
        this.profiles.putFact({
          accountId,
          factKey,
          ...input,
          expectedVersion,
          idempotencyKey,
          payloadDigest: canonicalJsonHash({ factKey, ...input }),
        }),
      ),
    );
  }
  async withdrawFact(
    accountId: string,
    factKey: string,
    expectedVersion: number,
    idempotencyKey: string,
  ): Promise<ProfileMutationResponse> {
    await this.profiles.getOrCreate(accountId);
    return this.mutation(
      await this.wrap(() =>
        this.profiles.withdrawFact({
          accountId,
          factKey,
          expectedVersion,
          idempotencyKey,
          payloadDigest: canonicalJsonHash({ factKey, withdraw: true }),
        }),
      ),
    );
  }
  async setUsage(
    accountId: string,
    factKey: string,
    input: { mode: MatchingMode; matching_enabled: boolean },
    expectedVersion: number,
    idempotencyKey: string,
  ): Promise<ProfileMutationResponse> {
    await this.profiles.getOrCreate(accountId);
    return this.mutation(
      await this.wrap(() =>
        this.profiles.setFactUsage({
          accountId,
          factKey,
          mode: input.mode,
          matchingEnabled: input.matching_enabled,
          expectedVersion,
          idempotencyKey,
          payloadDigest: canonicalJsonHash({ factKey, ...input }),
        }),
      ),
    );
  }
  async setAudience(
    accountId: string,
    factKey: string,
    input: {
      mode: MatchingMode;
      audience: 'self' | 'verified_members' | 'connections' | 'nobody';
      age_partition: AgePartition;
    },
    expectedVersion: number,
    idempotencyKey: string,
  ): Promise<ProfileMutationResponse> {
    await this.profiles.getOrCreate(accountId);
    return this.mutation(
      await this.wrap(() =>
        this.profiles.setFactAudience({
          accountId,
          factKey,
          mode: input.mode,
          audience: input.audience,
          agePartition: input.age_partition,
          expectedVersion,
          idempotencyKey,
          payloadDigest: canonicalJsonHash({ factKey, ...input }),
        }),
      ),
    );
  }
  async publish(
    accountId: string,
    expectedVersion: number,
    idempotencyKey: string,
  ): Promise<ProfilePublishResponse> {
    await this.profiles.getOrCreate(accountId);
    const result = await this.wrap(() =>
      this.profiles.publish(accountId, expectedVersion, idempotencyKey),
    );
    return {
      profile_id: result.profile.profileId,
      snapshot_id: result.snapshotId,
      version: result.profile.version,
      content_hash: result.contentHash,
      published_at: result.publishedAt.toISOString(),
    };
  }

  async selfView(accountId: string): Promise<ProfileSelfView> {
    return (await this.serialize(
      await this.profiles.getOrCreate(accountId),
      accountId,
      accountId,
      'friends',
      'self',
    )) as ProfileSelfView;
  }
  async preview(
    accountId: string,
    view: 'self' | 'member' | 'matching',
    mode: MatchingMode,
  ): Promise<ProfileView> {
    return this.serialize(
      await this.profiles.getOrCreate(accountId),
      accountId,
      accountId,
      mode,
      view,
    );
  }
  async viewerView(
    viewerAccountId: string,
    profileId: string,
    mode: MatchingMode,
  ): Promise<ProfileView> {
    const subject = await this.profiles.findByProfileId(profileId);
    if (subject === null)
      throw new HttpException({ code: 'NOT_FOUND', message: 'profile not found' }, 404);
    return this.serialize(subject, viewerAccountId, subject.accountId, mode, 'member');
  }

  private async serialize(
    profile: ProfileRecord,
    viewer: string,
    subject: string,
    mode: MatchingMode,
    view: 'self' | 'member' | 'matching',
  ): Promise<ProfileView> {
    const selfView = view === 'self' && viewer === subject;
    if (!selfView && profile.state !== 'active')
      throw new HttpException({ code: 'NOT_FOUND', message: 'profile not found' }, 404);
    const [viewerAccess, subjectAccess] = selfView
      ? [{ decision: 'eligible' as const }, { decision: 'eligible' as const }]
      : await Promise.all([
          this.community.decide(viewer, 'discover'),
          this.community.decide(subject, 'discover'),
        ]);
    const partition = selfView
      ? null
      : viewer === subject
        ? await this.partition.self(subject).then((value) =>
            value === null
              ? null
              : {
                  decision: 'allow' as const,
                  actorAgeBand: value.ageBand,
                  subjectAgeBand: value.ageBand,
                },
          )
        : await this.partition.decide(viewer, subject, mode === 'dating' ? 'dating' : 'discover');
    if (!selfView && partition?.decision !== 'allow')
      throw new HttpException({ code: 'NOT_FOUND', message: 'profile not found' }, 404);
    const viewerAgePartition =
      partition === null ? 'unknown' : agePartition(partition.actorAgeBand);
    const subjectAgePartition =
      partition === null ? 'unknown' : agePartition(partition.subjectAgeBand);
    const relationship = selfView
      ? ('self' as const)
      : (await this.relationship.decide(viewer, subject)).relationship;
    const decision = this.policy.decide({
      viewerAccountId: viewer,
      subjectAccountId: subject,
      relationship,
      mode,
      viewerAgePartition,
      subjectAgePartition,
      viewerCommunity: viewerAccess.decision,
      subjectCommunity: subjectAccess.decision,
      ownerBypass: selfView,
    });
    if (!decision.allowProfile)
      throw new HttpException({ code: 'NOT_FOUND', message: 'profile not found' }, 404);
    const facts = [];
    for (const fact of profile.facts) {
      const audience = selfView
        ? { audience: 'self' as const, agePartition: 'unknown' as const }
        : await this.profiles.getAudience(subject, fact.factKey, mode);
      const matching =
        view === 'matching'
          ? await this.profiles.isMatchingEnabled(subject, fact.factKey, mode)
          : true;
      const allowed =
        audience !== null &&
        matching &&
        decision.allowFact(
          fact,
          audience?.audience ?? 'nobody',
          audience?.agePartition ?? 'unknown',
        );
      if (!selfView && fact.sensitivity === 'sensitive')
        await this.profiles.appendSensitiveAudit({
          actorAccountId: viewer,
          subjectAccountId: subject,
          factKey: fact.factKey,
          purpose: view,
          decision: allowed ? 'allow' : 'deny',
          policyVersion: 'prf-1',
        });
      if (allowed) {
        facts.push({
          fact_key: fact.factKey,
          value: fact.value,
          sensitivity: fact.sensitivity,
          state: fact.state,
          source: fact.source,
          confirmed_at: fact.confirmedAt.toISOString(),
        });
      }
    }
    const payload = {
      profile_id: profile.profileId,
      display_name: profile.displayName,
      ...(selfView ? { account_id: profile.accountId } : {}),
      ...(profile.city === undefined ? {} : { city: profile.city }),
      ...(profile.countryCode === undefined ? {} : { country_code: profile.countryCode }),
      state: profile.state,
      version: profile.version,
      facts,
    };
    return (
      selfView ? profileSelfViewSchema.parse(payload) : profileMemberViewSchema.parse(payload)
    ) as ProfileView;
  }
  private async wrap<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (error) {
      if (error instanceof ProfileConcurrencyError)
        throw new HttpException({ code: 'CONFLICT', message: 'profile version conflict' }, 409);
      if (error instanceof ProfileIdempotencyConflictError)
        throw new HttpException({ code: 'CONFLICT', message: 'idempotency key conflict' }, 409);
      if (error instanceof ProfileFactError)
        throw new HttpException({ code: 'VALIDATION_ERROR', message: error.message }, 400);
      throw error;
    }
  }
  private mutation(profile: {
    profileId: string;
    version: number;
    state: ProfileRecord['state'];
  }): ProfileMutationResponse {
    return { profile_id: profile.profileId, version: profile.version, state: profile.state };
  }
}

function agePartition(band: string): AgePartition {
  if (band === 'adult') return 'adult';
  if (band === 'youth') return 'youth';
  return 'unknown';
}
