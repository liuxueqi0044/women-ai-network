import { HttpException, Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import {
  OPEN_ENDED,
  type EligibilityStatusResponse,
  type JurisdictionDeclarationResponse,
  type JurisdictionPolicySelector,
} from '@wai/contracts';
import {
  EligibilityConflictError,
  type AgeCredentialRepository,
  type JurisdictionDeclarationRepository,
  type JurisdictionDeclarationRow,
} from '@wai/db';
import {
  ELG_CLOCK,
  ELG_REPOSITORIES,
  JURISDICTION_POLICY_SELECTOR,
} from '../eligibility.tokens.js';
import { isWithinValidity } from '../domain/age.js';
import type { ElgClock } from '../infra/elg-clock.js';

@Injectable()
export class JurisdictionService {
  constructor(
    // Explicit @Inject: vitest's esbuild transform cannot emit
    // design:paramtypes, so interface-typed params must declare their token.
    @Inject(ELG_REPOSITORIES)
    private readonly deps: {
      jurisdictionDeclarations: Pick<
        JurisdictionDeclarationRepository,
        'upsertCurrent' | 'current'
      >;
      ageCredentials: Pick<AgeCredentialRepository, 'current'>;
    },
    @Inject(JURISDICTION_POLICY_SELECTOR)
    private readonly selector: JurisdictionPolicySelector,
    @Inject(ELG_CLOCK)
    private readonly clock: ElgClock,
  ) {}

  async declare(
    accountId: string,
    countryCode: string,
    subdivisionCode: string | null,
  ): Promise<JurisdictionDeclarationResponse> {
    const now = this.clock.now();
    try {
      const row = await this.deps.jurisdictionDeclarations.upsertCurrent({
        id: randomUUID(),
        accountId,
        countryCode,
        subdivisionCode,
        now,
      });
      return toDeclarationResponse(row);
    } catch (error) {
      // Two concurrent first declarations raced the partial unique index.
      if (error instanceof EligibilityConflictError) {
        throw new HttpException(
          { code: 'VALIDATION_ERROR', message: 'concurrent_declaration_update' },
          409,
        );
      }
      throw error;
    }
  }

  async status(accountId: string): Promise<EligibilityStatusResponse> {
    const now = this.clock.now();
    const declaration = await this.deps.jurisdictionDeclarations.current(accountId);
    const selection = await this.selector.select(accountId, now.toISOString());
    const credential = await this.deps.ageCredentials.current(accountId);
    const usableCredential =
      credential !== null &&
      selection !== null &&
      isWithinValidity(credential.validFrom, credential.validUntil, now) &&
      credential.jurisdictionPolicyId === selection.policy_id &&
      credential.jurisdictionKey === selection.jurisdiction_key &&
      credential.policyRevision === selection.revision
        ? credential
        : null;
    return {
      jurisdiction: declaration === null ? null : toDeclarationResponse(declaration),
      active_policy:
        selection === null
          ? null
          : {
              policy_id: selection.policy_id,
              jurisdiction_key: selection.jurisdiction_key,
              revision: selection.revision,
              effective_from: selection.effective_from,
              effective_until: selection.effective_until,
              timezone: selection.timezone,
            },
      age:
        usableCredential === null
          ? null
          : {
              credential_id: usableCredential.id,
              age_band: usableCredential.ageBand,
              cohort_key: usableCredential.cohortKey,
              assurance_level: usableCredential.assuranceLevel,
              valid_from: usableCredential.validFrom.toISOString(),
              valid_until: isOpenEnded(usableCredential.validUntil)
                ? OPEN_ENDED
                : usableCredential.validUntil.toISOString(),
            },
    };
  }
}

function toDeclarationResponse(row: JurisdictionDeclarationRow): JurisdictionDeclarationResponse {
  const base = {
    declaration_id: row.id,
    country_code: row.countryCode,
    review_state: row.reviewState,
    effective_from: row.effectiveFrom.toISOString(),
  };
  return row.subdivisionCode === null ? base : { ...base, subdivision_code: row.subdivisionCode };
}

/** Postgres 'infinity' round-trips as the number Infinity in node-postgres. */
function isOpenEnded(value: Date | number): value is number {
  return typeof value === 'number';
}
