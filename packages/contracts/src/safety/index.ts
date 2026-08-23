import { z } from 'zod';
import { idSchema } from '../ids.js';

export const safetySurfaceSchema = z.enum([
  'profile',
  'matching',
  'chat',
  'circle',
  'event',
  'notification',
]);
export type SafetySurface = z.infer<typeof safetySurfaceSchema>;

export const blockReasonSchema = z.enum([
  'harassment',
  'unwanted_contact',
  'safety_concern',
  'privacy',
  'other',
]);
export type BlockReason = z.infer<typeof blockReasonSchema>;

export const blockCreateRequestSchema = z
  .object({
    blocked_account_id: idSchema,
    reason: blockReasonSchema,
    idempotency_key: z.string().min(16).max(128),
  })
  .strict();
export type BlockCreateRequest = z.infer<typeof blockCreateRequestSchema>;

export const blockResponseSchema = z
  .object({
    id: idSchema,
    blocked_account_id: idSchema,
    active: z.boolean(),
    created_at: z.string().datetime({ offset: true }),
  })
  .strict();
export type BlockResponse = z.infer<typeof blockResponseSchema>;

export const blockListResponseSchema = z.object({ blocks: z.array(blockResponseSchema) }).strict();
export type BlockListResponse = z.infer<typeof blockListResponseSchema>;

export const reportTargetTypeSchema = z.enum([
  'account',
  'profile',
  'message',
  'media',
  'event',
  'circle',
  'note',
]);
export const reportCategorySchema = z.enum([
  'harassment',
  'threats',
  'sexual_content',
  'hate_or_discrimination',
  'scam_or_fraud',
  'privacy_violation',
  'other',
]);
export const reportCreateRequestSchema = z
  .object({
    subject_account_id: idSchema,
    target_type: reportTargetTypeSchema,
    target_id: z.string().min(1).max(256),
    category: reportCategorySchema,
    idempotency_key: z.string().min(16).max(128),
  })
  .strict();
export type ReportCreateRequest = z.infer<typeof reportCreateRequestSchema>;

export const reportResponseSchema = z
  .object({
    id: idSchema,
    state: z.enum(['open', 'triaged', 'investigating', 'action_pending', 'resolved', 'dismissed']),
    created_at: z.string().datetime({ offset: true }),
  })
  .strict();
export type ReportResponse = z.infer<typeof reportResponseSchema>;

export const appealCreateRequestSchema = z
  .object({
    category: z.enum(['incorrect_decision', 'new_information', 'accessibility']),
    statement: z.string().trim().min(1).max(4000),
  })
  .strict();
export type AppealCreateRequest = z.infer<typeof appealCreateRequestSchema>;

export const safetyReasonCodeSchema = z.enum([
  'ACTIVE_BLOCK',
  'ACCOUNT_STATE_DENIED',
  'SAFETY_ACTION_ACTIVE',
  'SELF_BLOCK_FORBIDDEN',
]);
export type SafetyReasonCode = z.infer<typeof safetyReasonCodeSchema>;

export const actionReasonCodeSchema = z.enum([
  'POLICY_VIOLATION_CONFIRMED',
  'IMMINENT_SAFETY_RISK',
  'REPEAT_HARASSMENT',
  'YOUTH_SAFETY_ESCALATION',
  'EVIDENCE_DISCLOSURE_REQUIRED',
]);
export type ActionReasonCode = z.infer<typeof actionReasonCodeSchema>;

export type SafetyBlockDecision = { allowed: true } | { allowed: false; reason: SafetyReasonCode };

/** Stable cross-module DI token; SAF-01 remains the authoritative adapter. */
export const SAFETY_BLOCK_DECISION = 'SAFETY_BLOCK_DECISION' as const;

export interface SafetyBlockDecisionPort {
  isInteractionAllowed(
    actorAccountId: string,
    subjectAccountId: string,
    surface: SafetySurface,
  ): Promise<SafetyBlockDecision>;
}

export interface EvidenceReference {
  targetType: z.infer<typeof reportTargetTypeSchema>;
  targetId: string;
  sourceVersion: string | null;
}

const accountEvidenceMetadataSchema = z
  .object({ account_state: z.enum(['active', 'restricted', 'suspended', 'deleted']) })
  .strict();
const profileEvidenceMetadataSchema = z
  .object({
    profile_version: z.string().max(128),
    visibility: z.enum(['public', 'members', 'hidden']),
  })
  .strict();
const messageEvidenceMetadataSchema = z
  .object({
    message_version: z.string().max(128),
    moderation_state: z.enum(['visible', 'removed', 'quarantined']),
  })
  .strict();
const mediaEvidenceMetadataSchema = z
  .object({
    media_version: z.string().max(128),
    scan_state: z.enum(['clean', 'blocked', 'quarantined']),
  })
  .strict();
const eventEvidenceMetadataSchema = z
  .object({
    event_version: z.string().max(128),
    event_state: z.enum(['scheduled', 'active', 'ended', 'canceled']),
  })
  .strict();
const circleEvidenceMetadataSchema = z
  .object({
    circle_version: z.string().max(128),
    lifecycle: z.enum(['draft', 'active', 'archived']),
  })
  .strict();
const noteEvidenceMetadataSchema = z
  .object({
    note_version: z.string().max(128),
    moderation_state: z.enum(['visible', 'removed', 'quarantined']),
  })
  .strict();
export const evidenceSafeMetadataSchema = z.union([
  accountEvidenceMetadataSchema,
  profileEvidenceMetadataSchema,
  messageEvidenceMetadataSchema,
  mediaEvidenceMetadataSchema,
  eventEvidenceMetadataSchema,
  circleEvidenceMetadataSchema,
  noteEvidenceMetadataSchema,
]);
export type EvidenceSafeMetadata = z.infer<typeof evidenceSafeMetadataSchema>;

export interface CanonicalEvidenceSnapshot {
  schemaVersion: 1;
  targetType: z.infer<typeof reportTargetTypeSchema>;
  reference: EvidenceReference;
  capturedAt: string;
  category: z.infer<typeof reportCategorySchema>;
  // Provider implementations must omit bodies, media bytes, precise location and DOB.
  safeMetadata: EvidenceSafeMetadata;
}

const canonicalEvidenceBase = z
  .object({
    schemaVersion: z.literal(1),
    capturedAt: z.string().datetime({ offset: true }),
    category: reportCategorySchema,
  })
  .strict();
export const canonicalEvidenceSnapshotSchema = z.discriminatedUnion('targetType', [
  canonicalEvidenceBase.extend({
    targetType: z.literal('account'),
    reference: z
      .object({
        targetType: z.literal('account'),
        targetId: z.string().min(1).max(256),
        sourceVersion: z.string().max(128).nullable(),
      })
      .strict(),
    safeMetadata: accountEvidenceMetadataSchema,
  }),
  canonicalEvidenceBase.extend({
    targetType: z.literal('circle'),
    reference: z
      .object({
        targetType: z.literal('circle'),
        targetId: z.string().min(1).max(256),
        sourceVersion: z.string().max(128).nullable(),
      })
      .strict(),
    safeMetadata: circleEvidenceMetadataSchema,
  }),
  canonicalEvidenceBase.extend({
    targetType: z.literal('note'),
    reference: z
      .object({
        targetType: z.literal('note'),
        targetId: z.string().min(1).max(256),
        sourceVersion: z.string().max(128).nullable(),
      })
      .strict(),
    safeMetadata: noteEvidenceMetadataSchema,
  }),
  canonicalEvidenceBase.extend({
    targetType: z.literal('profile'),
    reference: z
      .object({
        targetType: z.literal('profile'),
        targetId: z.string().min(1).max(256),
        sourceVersion: z.string().max(128).nullable(),
      })
      .strict(),
    safeMetadata: profileEvidenceMetadataSchema,
  }),
  canonicalEvidenceBase.extend({
    targetType: z.literal('message'),
    reference: z
      .object({
        targetType: z.literal('message'),
        targetId: z.string().min(1).max(256),
        sourceVersion: z.string().max(128).nullable(),
      })
      .strict(),
    safeMetadata: messageEvidenceMetadataSchema,
  }),
  canonicalEvidenceBase.extend({
    targetType: z.literal('media'),
    reference: z
      .object({
        targetType: z.literal('media'),
        targetId: z.string().min(1).max(256),
        sourceVersion: z.string().max(128).nullable(),
      })
      .strict(),
    safeMetadata: mediaEvidenceMetadataSchema,
  }),
  canonicalEvidenceBase.extend({
    targetType: z.literal('event'),
    reference: z
      .object({
        targetType: z.literal('event'),
        targetId: z.string().min(1).max(256),
        sourceVersion: z.string().max(128).nullable(),
      })
      .strict(),
    safeMetadata: eventEvidenceMetadataSchema,
  }),
]);
export type CanonicalEvidenceSnapshotValidated = z.infer<typeof canonicalEvidenceSnapshotSchema>;

export interface EvidenceSnapshotPort {
  // Implementations authorize the reporter against the target and return null
  // for both an invisible target and a missing target (uniform IDOR behavior).
  capture(
    reference: EvidenceReference,
    reporterAccountId: string,
    subjectAccountId: string,
    category: z.infer<typeof reportCategorySchema>,
  ): Promise<CanonicalEvidenceSnapshot | null>;
}

export interface SafetyVault {
  readEvidence(
    actor: SafetyVaultActor,
    snapshotId: string,
    purpose: string,
  ): Promise<CanonicalEvidenceSnapshot>;
}
export interface SafetyVaultActor {
  principalId: string;
  role: 'safety_operator' | 'compliance_officer' | 'ordinary_admin';
}

export type SafetyCaseState =
  | 'open'
  | 'triaged'
  | 'investigating'
  | 'action_pending'
  | 'resolved'
  | 'dismissed';
export type SafetyActionType =
  | 'temporary_restriction'
  | 'permanent_ban'
  | 'youth_restriction'
  | 'evidence_export';

export interface SafetyCaseLease {
  caseId: string;
  leaseOwner: string;
  leaseToken: string;
  leaseUntil: Date;
}

export interface SafetyActionRepository {
  propose(input: {
    caseId: string;
    actionType: SafetyActionType;
    proposerId: string;
    reasonCode: ActionReasonCode;
  }): Promise<string>;
  approve(actionId: string, approverId: string): Promise<void>;
  execute(actionId: string, executionToken: string): Promise<'executed' | 'already_executed'>;
}
