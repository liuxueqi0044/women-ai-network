import { Inject, Injectable } from '@nestjs/common';
import type {
  CommunityAccessDecisionPort,
  CommunityAccessResponse,
  AgeAssuranceState,
} from '@wai/contracts';
import type { AccountRepository } from '@wai/db';
import { ACCOUNT_REPOSITORY } from '../account/repositories.js';
import { AgeCredentialService } from '../eligibility/services/age-credential.service.js';
import { communityAccess } from './domain/membership.js';
import { VerificationService } from './verification.service.js';

/**
 * Narrow internal gate. It checks the durable account/member/identity state
 * and requires a currently valid Eligibility-owned external credential.
 */
@Injectable()
export class CommunityAccessService implements CommunityAccessDecisionPort {
  constructor(
    @Inject(VerificationService) private readonly verification: VerificationService,
    @Inject(AgeCredentialService) private readonly ageCredentials: AgeCredentialService,
    @Inject(ACCOUNT_REPOSITORY)
    private readonly accounts: Pick<AccountRepository, 'findById'>,
  ) {}

  async decide(accountId: string, capability: string): Promise<CommunityAccessResponse> {
    // Capability is deliberately not interpreted here: ELG mode/partition
    // decisions remain the authority for Dating and cross-account actions.
    void capability;
    const [status, credential, account] = await Promise.all([
      this.verification.status(accountId),
      this.ageCredentials.current(accountId),
      this.accounts.findById(accountId),
    ]);
    const ageState: AgeAssuranceState =
      status.age_assurance === 'attested' && credential?.assurance_level === 'externally_attested'
        ? 'attested'
        : 'unverified';
    return communityAccess(
      status.identity,
      ageState,
      status.membership,
      account?.state === 'enabled',
    );
  }
}
