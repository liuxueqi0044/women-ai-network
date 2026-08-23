import { Module, type DynamicModule, type Provider } from '@nestjs/common';
import type { AppConfig } from '@wai/config';
import {
  parsePepper,
  parsePiiKeys,
  PgIntroductionRepository,
  type Db,
  type AccountRepository,
} from '@wai/db';
import { hardRequirementsMatch, safeFactCriterion } from '@wai/contracts';
import type {
  ConnectionMaterializationPort,
  IntroductionPolicyGate,
  CommunityAccessDecisionPort,
  SafetyBlockDecisionPort,
  ProfileMatchingSafeViewPort,
  IntroductionRepositoryPort,
  ProfileRelationshipGraphPort,
} from '@wai/contracts';
import { IAM_DB, ACCOUNT_REPOSITORY } from '../account/repositories.js';
import { COMMUNITY_ACCESS_DECISION_PORT } from '../verification/verification.tokens.js';
import { SAFETY_BLOCK_DECISION } from '../safety/tokens.js';
import { OriginGuard } from '../account/guards/origin.guard.js';
import { SessionAuthGuard } from '../account/guards/session-auth.guard.js';
import {
  INTRODUCTION_GATE,
  INTRODUCTION_MATERIALIZATION,
  INTRODUCTION_REPOSITORY,
} from './introductions.tokens.js';
import { IntroductionsController } from './introductions.controller.js';
import { IntroductionsService } from './introductions.service.js';
import { PartitionDecisionService } from '../eligibility/services/partition-decision.service.js';
import { OnboardingService } from '../onboarding/onboarding.service.js';
import { CONNECTION_MATERIALIZATION } from '../connection/connection.tokens.js';
import { CONNECTION_RELATIONSHIP } from '../connection/connection.tokens.js';
import { PROFILE_MATCHING_SAFE_VIEW } from '../profile/profile.tokens.js';
import { RATE_LIMITER, type RateLimiter } from '../account/ports.js';
@Module({})
export class IntroductionsModule {
  static forRoot(
    config: AppConfig,
    accountModule: DynamicModule,
    eligibilityModule: DynamicModule,
    connectionModule: DynamicModule,
    verificationModule: DynamicModule,
    safetyModule: DynamicModule,
    onboardingModule: DynamicModule,
    profileModule: DynamicModule,
    materialization?: ConnectionMaterializationPort,
  ): DynamicModule {
    const gate: Provider = {
      provide: INTRODUCTION_GATE,
      inject: [
        ACCOUNT_REPOSITORY,
        COMMUNITY_ACCESS_DECISION_PORT,
        SAFETY_BLOCK_DECISION,
        PartitionDecisionService,
        OnboardingService,
        PROFILE_MATCHING_SAFE_VIEW,
        CONNECTION_RELATIONSHIP,
      ],
      useFactory: (
        accounts: AccountRepository,
        community: CommunityAccessDecisionPort,
        safety: SafetyBlockDecisionPort,
        partition: PartitionDecisionService,
        onboarding: OnboardingService,
        safeView: ProfileMatchingSafeViewPort,
        graph: ProfileRelationshipGraphPort,
      ): IntroductionPolicyGate => ({
        check: async ({ actorAccountId, subjectAccountId, mode, allowExistingMutual }) => {
          const actor = await accounts.findById(actorAccountId);
          const subject = await accounts.findById(subjectAccountId);
          if (actor?.state !== 'enabled' || subject?.state !== 'enabled')
            return { allowed: false, reason: 'ACCOUNT_STATE_DENIED' };
          try {
            const a = await community.decide(actorAccountId, 'introductions');
            const b = await community.decide(subjectAccountId, 'introductions');
            if (a.decision !== 'eligible' || b.decision !== 'eligible')
              return { allowed: false, reason: 'POLICY_DENIED' };
            const block = await safety.isInteractionAllowed(
              actorAccountId,
              subjectAccountId,
              'matching',
            );
            if (!block.allowed) return { allowed: false, reason: 'ACTIVE_BLOCK' };
            if (
              !allowExistingMutual &&
              (await graph.relationship(actorAccountId, subjectAccountId)).relationship ===
                'connection'
            )
              return { allowed: false, reason: 'CONNECTION_EXISTS' };
            if (
              (
                await partition.decide(actorAccountId, subjectAccountId, {
                  capability: 'introduce',
                })
              ).decision !== 'allow'
            )
              return { allowed: false, reason: 'POLICY_DENIED' };
            const actorPreferences = await onboarding.preferences(actorAccountId, 'discovery');
            const subjectPreferences = await onboarding.preferences(subjectAccountId, 'discovery');
            if (!actorPreferences.modes.includes(mode) || !subjectPreferences.modes.includes(mode))
              return { allowed: false, reason: 'POLICY_DENIED' };
            const actorRequirements = actorPreferences.preferences
              .filter((item) => item.mode === mode)
              .map((item) => ({ ...item, visible: false }));
            const subjectRequirements = subjectPreferences.preferences
              .filter((item) => item.mode === mode)
              .map((item) => ({ ...item, visible: false }));
            const subjectFacts = (
              await safeView.matchingFacts({
                subjectAccountId: subjectAccountId,
                viewerAccountId: actorAccountId,
                mode,
                purpose: 'matching',
              })
            ).facts
              .filter((fact) => fact.policyVersion === 'prf-1')
              .map((fact) => ({
                criterion: safeFactCriterion[fact.factKey] ?? '',
                value: String(fact.value),
                visible: fact.visible,
              }));
            const actorFacts = (
              await safeView.matchingFacts({
                subjectAccountId: actorAccountId,
                viewerAccountId: subjectAccountId,
                mode,
                purpose: 'matching',
              })
            ).facts
              .filter((fact) => fact.policyVersion === 'prf-1')
              .map((fact) => ({
                criterion: safeFactCriterion[fact.factKey] ?? '',
                value: String(fact.value),
                visible: fact.visible,
              }));
            if (
              !hardRequirementsMatch(actorRequirements, subjectFacts) ||
              !hardRequirementsMatch(subjectRequirements, actorFacts)
            )
              return { allowed: false, reason: 'POLICY_DENIED' };
          } catch {
            return { allowed: false, reason: 'POLICY_DENIED' };
          }
          return { allowed: true };
        },
      }),
    };
    const repositoryProvider: Provider = {
      provide: INTRODUCTION_REPOSITORY,
      inject: [IAM_DB, INTRODUCTION_GATE, INTRODUCTION_MATERIALIZATION, PROFILE_MATCHING_SAFE_VIEW],
      useFactory: (
        db: Db,
        policy: IntroductionPolicyGate,
        materializePort: ConnectionMaterializationPort,
        safeView: ProfileMatchingSafeViewPort,
      ) =>
        new PgIntroductionRepository(
          db,
          parsePepper(config.iam.secretPepper),
          parsePiiKeys(config.iam.piiKeysJson),
          policy,
          materializePort,
          safeView,
        ),
    };
    return {
      module: IntroductionsModule,
      imports: [
        accountModule,
        eligibilityModule,
        verificationModule,
        safetyModule,
        onboardingModule,
        connectionModule,
        profileModule,
      ],
      controllers: [IntroductionsController],
      providers: [
        repositoryProvider,
        gate,
        materialization
          ? { provide: INTRODUCTION_MATERIALIZATION, useValue: materialization }
          : {
              provide: INTRODUCTION_MATERIALIZATION,
              inject: [CONNECTION_MATERIALIZATION],
              useFactory: (port: ConnectionMaterializationPort) => port,
            },
        {
          provide: 'INTRODUCTIONS_SERVICE',
          inject: [INTRODUCTION_REPOSITORY, INTRODUCTION_GATE, RATE_LIMITER],
          useFactory: (
            repository: IntroductionRepositoryPort,
            policy: IntroductionPolicyGate,
            rateLimiter: RateLimiter,
          ) => new IntroductionsService(repository, policy, rateLimiter),
        },
        OriginGuard,
        SessionAuthGuard,
      ],
      exports: ['INTRODUCTIONS_SERVICE', INTRODUCTION_REPOSITORY],
    };
  }
}
