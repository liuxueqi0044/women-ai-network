import { Inject, Injectable } from '@nestjs/common';
import type {
  CommunityAccessDecisionPort,
  InteractionGateDecision,
  InteractionGatePort,
  ProfileRelationshipGraphPort,
  ConnectionMode,
  SafetyBlockDecisionPort,
  SafetySurface,
} from '@wai/contracts';
import { PartitionDecisionService } from '../eligibility/services/partition-decision.service.js';
import { COMMUNITY_ACCESS_DECISION_PORT } from '../verification/verification.tokens.js';
import { SAFETY_BLOCK_DECISION } from '@wai/contracts';
import { CONNECTION_RELATIONSHIP } from './connection.tokens.js';

@Injectable()
export class InteractionGateService implements InteractionGatePort {
  constructor(
    @Inject(COMMUNITY_ACCESS_DECISION_PORT) private readonly community: CommunityAccessDecisionPort,
    @Inject(PartitionDecisionService)
    private readonly partition: Pick<PartitionDecisionService, 'decide'>,
    @Inject(SAFETY_BLOCK_DECISION) private readonly safety: SafetyBlockDecisionPort,
    @Inject(CONNECTION_RELATIONSHIP)
    private readonly graph: ProfileRelationshipGraphPort,
  ) {}

  async check(input: {
    actorAccountId: string;
    subjectAccountId: string;
    capability: 'discover' | 'introduce' | 'direct_message' | 'event_visibility' | 'dating';
    mode: ConnectionMode;
    surface: SafetySurface;
    requireConnection?: boolean;
    connectionId?: string;
    acceptedEpoch?: number;
  }): Promise<InteractionGateDecision> {
    const capability = input.mode === 'dating' ? 'dating' : input.capability;
    try {
      const [actorCommunity, subjectCommunity, partition, block] = await Promise.all([
        this.community.decide(input.actorAccountId, capability),
        this.community.decide(input.subjectAccountId, capability),
        this.partition.decide(input.actorAccountId, input.subjectAccountId, { capability }),
        this.safety.isInteractionAllowed(
          input.actorAccountId,
          input.subjectAccountId,
          input.surface,
        ),
      ]);
      if (!block.allowed) return { allowed: false, reason: 'ACTIVE_BLOCK' };
      if (actorCommunity.decision !== 'eligible' || subjectCommunity.decision !== 'eligible')
        return { allowed: false, reason: 'COMMUNITY_ACCESS_DENIED' };
      if (partition.decision !== 'allow') return { allowed: false, reason: 'PARTITION_DENIED' };
      if (input.requireConnection) {
        if (input.connectionId !== undefined || input.acceptedEpoch !== undefined) {
          if (input.connectionId === undefined || input.acceptedEpoch === undefined)
            return { allowed: false, reason: 'PARTITION_DENIED' };
          const exact = await this.graph.getForActor(input.connectionId, input.actorAccountId);
          if (
            !exact ||
            exact.state !== 'accepted' ||
            exact.version !== input.acceptedEpoch ||
            exact.mode !== input.mode ||
            ![exact.requesterAccountId, exact.recipientAccountId].includes(input.subjectAccountId)
          )
            return { allowed: false, reason: 'PARTITION_DENIED' };
        }
        const relationship = await this.graph.relationship(
          input.actorAccountId,
          input.subjectAccountId,
        );
        if (relationship.relationship !== 'connection')
          return { allowed: false, reason: 'PARTITION_DENIED' };
      }
      return { allowed: true };
    } catch {
      return { allowed: false, reason: 'POLICY_UNAVAILABLE' };
    }
  }
}
