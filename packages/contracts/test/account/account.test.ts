import { describe, expect, it } from 'vitest';
import {
  ERROR_CODES,
  accountErrorCodes,
  errorEnvelopeSchema,
  loginRequestSchema,
  mfaLoginRequestSchema,
  passwordSchema,
  recoveryCodeSchema,
  registrationRequestSchema,
  registrationResponseSchema,
  sessionSummarySchema,
  totpDisableRequestSchema,
  totpEnrollmentConfirmResponseSchema,
} from '../../src/index.js';

const EMAIL = 'member@example.invalid';
const PASSWORD = 'correct horse battery staple';

const UUID = '3f2a1b0c-6b2a-4e12-9a1c-2d3e4f5a6b7c';

describe('account error codes', () => {
  it('merges IAM codes into the shared ERROR_CODES without breaking the envelope', () => {
    expect(ERROR_CODES.INVALID_CREDENTIALS).toBe('INVALID_CREDENTIALS');
    expect(ERROR_CODES.RATE_LIMITED).toBe('RATE_LIMITED');
    expect(ERROR_CODES.SESSION_REPLAY_DETECTED).toBe('SESSION_REPLAY_DETECTED');
    // FND codes still present
    expect(ERROR_CODES.VALIDATION_ERROR).toBe('VALIDATION_ERROR');

    const envelope = errorEnvelopeSchema.parse({
      code: 'INVALID_CREDENTIALS',
      message: 'Invalid credentials',
      request_id: UUID,
    });
    expect(envelope.code).toBe('INVALID_CREDENTIALS');
  });

  it('exposes every account code as a stable literal', () => {
    expect(accountErrorCodes).toContain('INVALID_CREDENTIALS');
    expect(accountErrorCodes).toContain('SESSION_REQUIRED');
    expect(accountErrorCodes).toContain('SESSION_REPLAY_DETECTED');
    expect(accountErrorCodes).toContain('MFA_REQUIRED');
    expect(accountErrorCodes).toContain('MFA_INVALID');
    expect(accountErrorCodes).toContain('MFA_CHALLENGE_EXPIRED');
    expect(accountErrorCodes).toContain('RECOVERY_CODE_INVALID');
    expect(accountErrorCodes).toContain('ACCOUNT_STATE_DENIED');
    expect(accountErrorCodes).toContain('RATE_LIMITED');
    expect(accountErrorCodes).toContain('DEVICE_NOT_FOUND');
    expect(accountErrorCodes).toContain('FORBIDDEN');
    expect(new Set(accountErrorCodes).size).toBe(accountErrorCodes.length);
  });
});

describe('registration contracts', () => {
  it('accepts a valid registration', () => {
    expect(registrationRequestSchema.parse({ email: EMAIL, password: PASSWORD })).toEqual({
      email: EMAIL,
      password: PASSWORD,
    });
  });

  it('rejects product eligibility fields (age/birthday/gender/identity/membership)', () => {
    for (const extra of [
      { age: 30 },
      { birthday: '2000-01-01' },
      { gender: 'female' },
      { identity_document: 'passport-123' },
      { member_verified: true },
      { country: 'US' },
    ]) {
      expect(() =>
        registrationRequestSchema.parse({ email: EMAIL, password: PASSWORD, ...extra }),
      ).toThrow();
    }
  });

  it('rejects unknown keys via .strict()', () => {
    expect(() =>
      registrationRequestSchema.parse({ email: EMAIL, password: PASSWORD, name: 'x' }),
    ).toThrow();
  });

  it('rejects malformed emails and empty/missing fields', () => {
    for (const bad of [
      { email: 'not-an-email', password: PASSWORD },
      { email: '', password: PASSWORD },
      { password: PASSWORD },
      { email: EMAIL },
    ]) {
      expect(() => registrationRequestSchema.parse(bad)).toThrow();
    }
  });

  it('enforces 12–128 Unicode code points on passwords', () => {
    expect(() => passwordSchema.parse('short')).toThrow();
    expect(() => passwordSchema.parse('x'.repeat(11))).toThrow();
    expect(passwordSchema.parse('x'.repeat(12))).toBe('x'.repeat(12));
    expect(passwordSchema.parse('x'.repeat(128))).toBe('x'.repeat(128));
    expect(() => passwordSchema.parse('x'.repeat(129))).toThrow();
    // Astral-plane characters count as ONE code point, not two UTF-16 units.
    expect(passwordSchema.parse('😀'.repeat(12))).toBe('😀'.repeat(12));
    expect(() => passwordSchema.parse('😀'.repeat(6))).toThrow();
  });

  it('produces a uniform registration response', () => {
    expect(registrationResponseSchema.parse({ account_id: UUID, state: 'enabled' })).toBeTruthy();
    expect(() => registrationResponseSchema.parse({ account_id: UUID })).toThrow();
    expect(() =>
      registrationResponseSchema.parse({ account_id: UUID, state: 'suspended' }),
    ).toThrow();
  });
});

describe('session contracts', () => {
  it('accepts a login request and rejects extras', () => {
    expect(loginRequestSchema.parse({ email: EMAIL, password: PASSWORD })).toBeTruthy();
    expect(() =>
      loginRequestSchema.parse({ email: EMAIL, password: PASSWORD, remember_me: true }),
    ).toThrow();
  });

  it('parses a public session summary without device_id', () => {
    const summary = {
      session_id: UUID,
      account_id: UUID,
      auth_level: 'aal1',
      state: 'active',
      created_at: '2026-08-15T12:00:00.000Z',
      last_seen_at: '2026-08-15T12:00:00.000Z',
      idle_expires_at: '2026-08-16T12:00:00.000Z',
      absolute_expires_at: '2026-09-14T12:00:00.000Z',
    };
    expect(sessionSummarySchema.parse(summary)).toEqual(summary);
  });

  it('parses a session summary with device_id and rejects unknown fields', () => {
    const summary = {
      session_id: UUID,
      account_id: UUID,
      auth_level: 'aal2',
      state: 'active',
      created_at: '2026-08-15T12:00:00.000Z',
      last_seen_at: '2026-08-15T12:00:00.000Z',
      idle_expires_at: '2026-08-16T12:00:00.000Z',
      absolute_expires_at: '2026-09-14T12:00:00.000Z',
      device_id: UUID,
    };
    expect(sessionSummarySchema.parse(summary)).toEqual(summary);
    expect(() => sessionSummarySchema.parse({ ...summary, token: 'secret' })).toThrow();
    expect(() => sessionSummarySchema.parse({ ...summary, auth_level: 'aal3' })).toThrow();
  });

  it('requires totp_code XOR recovery_code on the MFA login request', () => {
    expect(mfaLoginRequestSchema.parse({ totp_code: '123456' })).toBeTruthy();
    expect(mfaLoginRequestSchema.parse({ recovery_code: 'ABCD-2345-WXYZ-6789' })).toBeTruthy();
    expect(() => mfaLoginRequestSchema.parse({})).toThrow();
    expect(() => mfaLoginRequestSchema.parse({ totp_code: '12345' })).toThrow();
    expect(() =>
      mfaLoginRequestSchema.parse({ totp_code: '123456', recovery_code: 'a'.repeat(16) }),
    ).toThrow();
  });
});

describe('mfa contracts', () => {
  it('validates recovery code shape and normalizes case', () => {
    expect(recoveryCodeSchema.parse('W2K4-9PQR-3M5N-7X8Z')).toBe('W2K4-9PQR-3M5N-7X8Z');
    // Lowercase input is accepted and normalized to the canonical form.
    expect(recoveryCodeSchema.parse('w2k4-9pqr-3m5n-7x8z')).toBe('W2K4-9PQR-3M5N-7X8Z');
    for (const bad of [
      'W2K4-9PQR-3M5N-7X8',
      'W2K4-9PQR-3M5N-7X8ZZ',
      'W2K4 9PQR 3M5N 7X8Z',
      'IIII-IIII-IIII-IIII',
      'OOOO-OOOO-OOOO-OOOO',
      '0000-0000-0000-0000',
      'W2K4-9PQR-3M5N-7X8I',
    ]) {
      expect(() => recoveryCodeSchema.parse(bad)).toThrow();
    }
  });

  it('requires password + a second factor proof to disable MFA', () => {
    expect(
      totpDisableRequestSchema.parse({ password: PASSWORD, totp_code: '123456' }),
    ).toBeTruthy();
    expect(
      totpDisableRequestSchema.parse({ password: PASSWORD, recovery_code: 'W2K4-9PQR-3M5N-7X8Z' }),
    ).toBeTruthy();
    expect(() => totpDisableRequestSchema.parse({ password: PASSWORD })).toThrow();
    expect(() => totpDisableRequestSchema.parse({ totp_code: '123456' })).toThrow();
  });

  it('returns exactly 10 recovery codes on confirm', () => {
    const codes = Array.from({ length: 10 }, () => 'W2K4-9PQR-3M5N-7X8Z');
    expect(totpEnrollmentConfirmResponseSchema.parse({ recovery_codes: codes })).toBeTruthy();
    expect(() =>
      totpEnrollmentConfirmResponseSchema.parse({ recovery_codes: codes.slice(0, 9) }),
    ).toThrow();
    expect(() =>
      totpEnrollmentConfirmResponseSchema.parse({
        recovery_codes: [...codes, 'W2K4-9PQR-3M5N-7X8Y'],
      }),
    ).toThrow();
  });
});
