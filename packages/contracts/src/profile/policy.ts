import type { Audience, AgePartition, MatchingMode, Relationship } from './enums.js';
import type { ProfileFactRecord, ProfileVisibilityDecisionPort } from './ports.js';

/** Deterministic, fail-closed field-level matrix. */
export class ProfileVisibilityPolicy implements ProfileVisibilityDecisionPort {
  decide(input: {
    viewerAccountId: string;
    subjectAccountId: string;
    relationship: Relationship;
    mode: MatchingMode;
    viewerAgePartition: AgePartition;
    subjectAgePartition: AgePartition;
    viewerCommunity: 'eligible' | 'limited' | 'denied';
    subjectCommunity: 'eligible' | 'limited' | 'denied';
    ownerBypass?: boolean;
  }) {
    const same = input.ownerBypass === true;
    const partitionOk =
      input.viewerAgePartition !== 'unknown' &&
      input.subjectAgePartition !== 'unknown' &&
      input.viewerAgePartition === input.subjectAgePartition;
    const communityOk =
      input.viewerCommunity === 'eligible' && input.subjectCommunity === 'eligible';
    const allowProfile = same || (communityOk && partitionOk && input.relationship !== 'none');

    return {
      allowProfile,
      allowFact: (
        fact: ProfileFactRecord,
        audience: Audience,
        agePartition: AgePartition,
      ): boolean => {
        if (same) return fact.state !== 'withdrawn';
        if (!allowProfile || fact.state !== 'confirmed' || fact.sensitivity === 'ai_only')
          return false;
        if (audience === 'self' || audience === 'nobody') return false;
        if (audience === 'connections' && input.relationship !== 'connection') return false;
        if (audience === 'verified_members' && input.relationship === 'none') return false;
        return agePartition === 'unknown' || agePartition === input.subjectAgePartition;
      },
    };
  }
}
