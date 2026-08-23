import { describe, expect, it } from 'vitest';
import {
  runAuthProviderCompliance,
  MockAuthProvider,
  type AuthProvider as ContractAuthProvider,
} from '@wai/testkit';
import { Argon2OtpAuthProvider } from '../infra/argon2-auth-provider.js';
import type { AuthProvider } from '../ports.js';

/**
 * CP1/CP3 evidence: the REAL Argon2+OTPAuth provider and the deterministic
 * mock run through the IDENTICAL compliance suite (packages/testkit).
 * The type assignment below is the compile-time contract check between the
 * API port and the harness shape.
 */
const providers: AuthProvider[] = [new Argon2OtpAuthProvider(), new MockAuthProvider()];

// Compile-time: the API AuthProvider must satisfy the harness contract.
const contractCheck: Array<ContractAuthProvider> = providers;
void contractCheck;

for (const provider of providers) {
  runAuthProviderCompliance(provider, { describe, it, expect });
}

describe('real provider hardening (argon2-otpauth only)', () => {
  const provider = new Argon2OtpAuthProvider();

  it('emits Argon2id PHC strings at the OWASP baseline cost', async () => {
    const hashValue = await provider.hashPassword('correct horse battery staple');
    expect(hashValue.startsWith('$argon2id$v=19$m=19456,t=2,p=1')).toBe(true);
  });

  it('rejects a malformed stored hash instead of throwing', async () => {
    expect(await provider.verifyPassword('not-a-phc-hash', 'whatever')).toBe(false);
  });

  it('does not leak password values into hashes', async () => {
    const hashValue = await provider.hashPassword('super-secret-password-value');
    expect(hashValue).not.toContain('super-secret-password-value');
  });
});
