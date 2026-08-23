import { Inject, Injectable } from '@nestjs/common';
import type {
  CommunityAccessDecisionPort,
  InteractionGateDecision,
  SafetyBlockDecisionPort,
} from '@wai/contracts';
import { PartitionDecisionService } from '../eligibility/services/partition-decision.service.js';
import { COMMUNITY_ACCESS_DECISION_PORT } from '../verification/verification.tokens.js';
import { SAFETY_BLOCK_DECISION } from '../safety/tokens.js';

/** Discovery access does not require an accepted connection with the author. */
@Injectable()
export class WorldDiscoveryGateService {
  constructor(
    @Inject(COMMUNITY_ACCESS_DECISION_PORT)
    private readonly community: CommunityAccessDecisionPort,
    @Inject(PartitionDecisionService)
    private readonly partition: Pick<PartitionDecisionService, 'decide'>,
    @Inject(SAFETY_BLOCK_DECISION) private readonly safety: SafetyBlockDecisionPort,
  ) {}

  async check(input: {
    actorAccountId: string;
    subjectAccountId: string;
  }): Promise<InteractionGateDecision> {
    try {
      const [actor, subject, partition, block] = await Promise.all([
        this.community.decide(input.actorAccountId, 'discover'),
        this.community.decide(input.subjectAccountId, 'discover'),
        this.partition.decide(input.actorAccountId, input.subjectAccountId, {
          capability: 'discover',
        }),
        this.safety.isInteractionAllowed(input.actorAccountId, input.subjectAccountId, 'profile'),
      ]);
      if (!block.allowed) return { allowed: false, reason: 'ACTIVE_BLOCK' };
      if (actor.decision !== 'eligible' || subject.decision !== 'eligible')
        return { allowed: false, reason: 'COMMUNITY_ACCESS_DENIED' };
      if (partition.decision !== 'allow') return { allowed: false, reason: 'PARTITION_DENIED' };
      return { allowed: true };
    } catch {
      return { allowed: false, reason: 'POLICY_UNAVAILABLE' };
    }
  }
}
