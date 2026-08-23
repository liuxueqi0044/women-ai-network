import type { InjectionToken } from '@nestjs/common';
import type { Db } from '@wai/db';
import type {
  AccountRepository,
  AuditRepository,
  DeviceRepository,
  MfaRepository,
  PasswordCredentialRepository,
  SessionRepository,
} from '@wai/db';

/** Drizzle Db handle bound to the iam schema — the repositories' single data source. */
export const IAM_DB: InjectionToken<Db> = Symbol('IAM_DB');
export const ACCOUNT_REPOSITORY: InjectionToken<AccountRepository> = Symbol('ACCOUNT_REPOSITORY');
export const PASSWORD_CREDENTIAL_REPOSITORY: InjectionToken<PasswordCredentialRepository> = Symbol(
  'PASSWORD_CREDENTIAL_REPOSITORY',
);
export const SESSION_REPOSITORY: InjectionToken<SessionRepository> = Symbol('SESSION_REPOSITORY');
export const DEVICE_REPOSITORY: InjectionToken<DeviceRepository> = Symbol('DEVICE_REPOSITORY');
export const MFA_REPOSITORY: InjectionToken<MfaRepository> = Symbol('MFA_REPOSITORY');
export const AUDIT_REPOSITORY: InjectionToken<AuditRepository> = Symbol('AUDIT_REPOSITORY');
