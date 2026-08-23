import type { InjectionToken } from '@nestjs/common';
import { SAFETY_BLOCK_DECISION } from '@wai/contracts';
import type { EvidenceSnapshotPort } from '@wai/contracts';
import type { PgSafetyRepository } from '@wai/db';
export const SAFETY_REPOSITORY: InjectionToken<PgSafetyRepository> = Symbol('SAFETY_REPOSITORY');
export const EVIDENCE_PROVIDER: InjectionToken<EvidenceSnapshotPort> = Symbol('EVIDENCE_PROVIDER');
export { SAFETY_BLOCK_DECISION };
