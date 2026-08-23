import { Module, type DynamicModule, type Provider } from '@nestjs/common';
import type { AppConfig } from '@wai/config';
import { createDb, parsePepper, parsePiiKeys, type Db } from '@wai/db';
import {
  PgAccountRepository,
  PgAuditRepository,
  PgDeviceRepository,
  PgMfaRepository,
  PgPasswordCredentialRepository,
  PgSessionRepository,
} from '@wai/db';
import type { Pool } from 'pg';
import { IAM_POOL } from '../tokens.js';
import { DevicesController } from './controllers/devices.controller.js';
import { MfaController } from './controllers/mfa.controller.js';
import { RegistrationsController } from './controllers/registrations.controller.js';
import { SessionController } from './controllers/session.controller.js';
import { SessionsController } from './controllers/sessions.controller.js';
import { OriginGuard } from './guards/origin.guard.js';
import { SessionAuthGuard } from './guards/session-auth.guard.js';
import { Argon2OtpAuthProvider } from './infra/argon2-auth-provider.js';
import { CspRandomSource } from './infra/csp-random-source.js';
import { NodeSecretCipher } from './infra/node-secret-cipher.js';
import { NodeTokenDigester } from './infra/node-token-digester.js';
import { SystemClock } from './infra/system-clock.js';
import { AUTH_PROVIDER, CLOCK, RANDOM_SOURCE, SECRET_CIPHER, TOKEN_DIGESTER } from './ports.js';
import {
  ACCOUNT_REPOSITORY,
  AUDIT_REPOSITORY,
  DEVICE_REPOSITORY,
  IAM_DB,
  MFA_REPOSITORY,
  PASSWORD_CREDENTIAL_REPOSITORY,
  SESSION_REPOSITORY,
} from './repositories.js';
import { AccountStateService } from './services/account-state.service.js';
import { DeviceService } from './services/device.service.js';
import { LoginService } from './services/login.service.js';
import { MfaService } from './services/mfa.service.js';
import { RegistrationService } from './services/registration.service.js';
import { SessionService } from './services/session.service.js';

/**
 * IAM-01 account slice: repositories over the iam schema, the real
 * implementations of the AuthProvider/SecretCipher/TokenDigester/Clock/
 * RandomSource ports, and the registration/login services + controllers.
 *
 * RATE_LIMITER and the pg Pool come from InfraModule (they share the app's
 * Valkey/PostgreSQL connections); everything else is scoped here.
 */
@Module({})
export class AccountModule {
  static forRoot(config: AppConfig): DynamicModule {
    const providers: Provider[] = [
      { provide: AUTH_PROVIDER, useValue: new Argon2OtpAuthProvider() },
      {
        provide: SECRET_CIPHER,
        useValue: new NodeSecretCipher(parsePiiKeys(config.iam.piiKeysJson)),
      },
      {
        provide: TOKEN_DIGESTER,
        useValue: new NodeTokenDigester(parsePepper(config.iam.secretPepper)),
      },
      { provide: CLOCK, useClass: SystemClock },
      { provide: RANDOM_SOURCE, useClass: CspRandomSource },
      { provide: IAM_DB, inject: [IAM_POOL], useFactory: (pool: Pool) => createDb(pool) },
      {
        provide: ACCOUNT_REPOSITORY,
        inject: [IAM_DB],
        useFactory: (db: Db) => new PgAccountRepository(db),
      },
      {
        provide: PASSWORD_CREDENTIAL_REPOSITORY,
        inject: [IAM_DB],
        useFactory: (db: Db) => new PgPasswordCredentialRepository(db),
      },
      {
        provide: SESSION_REPOSITORY,
        inject: [IAM_DB],
        useFactory: (db: Db) => new PgSessionRepository(db),
      },
      {
        provide: DEVICE_REPOSITORY,
        inject: [IAM_DB],
        useFactory: (db: Db) => new PgDeviceRepository(db),
      },
      {
        provide: MFA_REPOSITORY,
        inject: [IAM_DB],
        useFactory: (db: Db) => new PgMfaRepository(db),
      },
      {
        provide: AUDIT_REPOSITORY,
        inject: [IAM_DB],
        useFactory: (db: Db) => new PgAuditRepository(db),
      },
      AccountStateService,
      RegistrationService,
      LoginService,
      SessionService,
      DeviceService,
      MfaService,
      OriginGuard,
      SessionAuthGuard,
    ];

    return {
      module: AccountModule,
      controllers: [
        RegistrationsController,
        SessionsController,
        SessionController,
        MfaController,
        DevicesController,
      ],
      providers,
      // ELG-01 deviation (recorded in the handoff): SessionAuthGuard and its
      // private dependencies are exported so the eligibility routes can sit
      // behind the same guard. Pure additive change — IAM-01 semantics and
      // visibility are untouched.
      exports: [
        AccountStateService,
        LoginService,
        RegistrationService,
        SessionService,
        MfaService,
        OriginGuard,
        SessionAuthGuard,
        TOKEN_DIGESTER,
        CLOCK,
        SESSION_REPOSITORY,
        ACCOUNT_REPOSITORY,
        AUDIT_REPOSITORY,
        IAM_DB,
      ],
    };
  }
}
