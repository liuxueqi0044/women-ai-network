import {
  OpenAPIRegistry,
  OpenApiGeneratorV3,
  extendZodWithOpenApi,
} from '@asteasolutions/zod-to-openapi';
import type { oas30 } from 'openapi3-ts';
import { z } from 'zod';
import {
  deviceIdParamsSchema,
  deviceListResponseSchema,
  deviceRenameRequestSchema,
  deviceRenameResponseSchema,
  errorEnvelopeSchema,
  foundationTraceRequestSchema,
  foundationTraceResponseSchema,
  healthLiveResponseSchema,
  healthReadyResponseSchema,
  loginRequestSchema,
  mfaLoginRequestSchema,
  recoveryRegenerateRequestSchema,
  recoveryRegenerateResponseSchema,
  registrationRequestSchema,
  registrationResponseSchema,
  sessionIdParamsSchema,
  sessionListResponseSchema,
  sessionResponseSchema,
  totpDisableRequestSchema,
  totpEnrollmentConfirmRequestSchema,
  totpEnrollmentConfirmResponseSchema,
  totpEnrollmentRequestSchema,
  totpEnrollmentResponseSchema,
} from '@wai/contracts';

/**
 * The OpenAPI document is GENERATED from the @wai/contracts Zod schemas —
 * the contracts remain the single source of truth (no hand-written spec to
 * drift out of sync). Served at GET /v1/docs, gated by config.openapiEnabled.
 */

// Add .openapi() to the Zod prototypes (required by zod-to-openapi, idempotent).
extendZodWithOpenApi(z);

// Attach component refIds so the generator emits named schemas. The mutation
// only adds OpenAPI metadata — runtime validation behavior is unchanged.
const errorEnvelopeRef = errorEnvelopeSchema.openapi('ErrorEnvelope');
const healthLiveResponseRef = healthLiveResponseSchema.openapi('HealthLiveResponse');
const healthReadyResponseRef = healthReadyResponseSchema.openapi('HealthReadyResponse');
const foundationTraceRequestRef = foundationTraceRequestSchema.openapi('FoundationTraceRequest');
const foundationTraceResponseRef = foundationTraceResponseSchema.openapi('FoundationTraceResponse');
const registrationRequestRef = registrationRequestSchema.openapi('RegistrationRequest');
const registrationResponseRef = registrationResponseSchema.openapi('RegistrationResponse');
const loginRequestRef = loginRequestSchema.openapi('LoginRequest');
const sessionResponseRef = sessionResponseSchema.openapi('SessionResponse');
const sessionListResponseRef = sessionListResponseSchema.openapi('SessionListResponse');
const sessionIdParamsRef = sessionIdParamsSchema.openapi('SessionIdParams');
const mfaLoginRequestRef = mfaLoginRequestSchema.openapi('MfaLoginRequest');
const totpEnrollmentRequestRef = totpEnrollmentRequestSchema.openapi('TotpEnrollmentRequest');
const totpEnrollmentResponseRef = totpEnrollmentResponseSchema.openapi('TotpEnrollmentResponse');
const totpEnrollmentConfirmRequestRef = totpEnrollmentConfirmRequestSchema.openapi(
  'TotpEnrollmentConfirmRequest',
);
const totpEnrollmentConfirmResponseRef = totpEnrollmentConfirmResponseSchema.openapi(
  'TotpEnrollmentConfirmResponse',
);
const recoveryRegenerateRequestRef = recoveryRegenerateRequestSchema.openapi(
  'RecoveryRegenerateRequest',
);
const recoveryRegenerateResponseRef = recoveryRegenerateResponseSchema.openapi(
  'RecoveryRegenerateResponse',
);
const totpDisableRequestRef = totpDisableRequestSchema.openapi('TotpDisableRequest');
const deviceListResponseRef = deviceListResponseSchema.openapi('DeviceListResponse');
const deviceRenameRequestRef = deviceRenameRequestSchema.openapi('DeviceRenameRequest');
const deviceRenameResponseRef = deviceRenameResponseSchema.openapi('DeviceRenameResponse');
const deviceIdParamsRef = deviceIdParamsSchema.openapi('DeviceIdParams');

const registry = new OpenAPIRegistry();

registry.registerPath({
  method: 'get',
  path: '/v1/health/live',
  summary: 'Process liveness — no dependency checks',
  responses: {
    200: {
      description: 'Process is alive',
      content: { 'application/json': { schema: healthLiveResponseRef } },
    },
  },
});

registry.registerPath({
  method: 'get',
  path: '/v1/health/ready',
  summary: 'Dependency readiness (PostgreSQL, Valkey, queue)',
  responses: {
    200: {
      description: 'Readiness with per-dependency state',
      content: { 'application/json': { schema: healthReadyResponseRef } },
    },
  },
});

registry.registerPath({
  method: 'post',
  path: '/v1/foundation/trace',
  summary: 'Foundation smoke flow: enqueue a foundation.trace job',
  request: {
    body: {
      required: false,
      content: { 'application/json': { schema: foundationTraceRequestRef } },
    },
  },
  responses: {
    201: {
      description: 'Job accepted',
      content: { 'application/json': { schema: foundationTraceResponseRef } },
    },
    400: {
      description: 'Validation failed',
      content: { 'application/json': { schema: errorEnvelopeRef } },
    },
    503: {
      description: 'Queue unavailable',
      content: { 'application/json': { schema: errorEnvelopeRef } },
    },
  },
});

registry.registerPath({
  method: 'post',
  path: '/v1/account/registrations',
  summary: 'IAM-01: create an account (email + password only)',
  request: {
    body: {
      required: true,
      content: { 'application/json': { schema: registrationRequestRef } },
    },
  },
  responses: {
    201: {
      description: 'Account created — identical body for duplicate registrations',
      content: { 'application/json': { schema: registrationResponseRef } },
    },
    400: {
      description: 'Validation failed',
      content: { 'application/json': { schema: errorEnvelopeRef } },
    },
    429: {
      description: 'Rate limited',
      content: { 'application/json': { schema: errorEnvelopeRef } },
    },
  },
});

registry.registerPath({
  method: 'post',
  path: '/v1/account/sessions',
  summary: 'IAM-01: log in (password) — issues a session cookie or an MFA challenge',
  request: {
    body: {
      required: true,
      content: { 'application/json': { schema: loginRequestRef } },
    },
  },
  responses: {
    201: {
      description: 'Session created — token travels only in the HttpOnly cookie',
      content: { 'application/json': { schema: sessionResponseRef } },
    },
    400: {
      description: 'Validation failed',
      content: { 'application/json': { schema: errorEnvelopeRef } },
    },
    401: {
      description: 'Invalid credentials or MFA challenge required',
      content: { 'application/json': { schema: errorEnvelopeRef } },
    },
    429: {
      description: 'Rate limited',
      content: { 'application/json': { schema: errorEnvelopeRef } },
    },
  },
});

registry.registerPath({
  method: 'get',
  path: '/v1/account/session',
  summary: 'IAM-01: current session (slides the idle window)',
  responses: {
    200: {
      description: 'Current session summary',
      content: { 'application/json': { schema: sessionResponseRef } },
    },
    401: {
      description: 'No usable session / replay detected / account state denied',
      content: { 'application/json': { schema: errorEnvelopeRef } },
    },
  },
});

registry.registerPath({
  method: 'post',
  path: '/v1/account/session/rotate',
  summary: 'IAM-01: atomic session rotation — exactly one concurrent rotate wins',
  responses: {
    200: {
      description: 'Rotated — a fresh token is set in the HttpOnly cookie',
      content: { 'application/json': { schema: sessionResponseRef } },
    },
    401: {
      description: 'No usable session / replay detected / account state denied',
      content: { 'application/json': { schema: errorEnvelopeRef } },
    },
  },
});

registry.registerPath({
  method: 'delete',
  path: '/v1/account/session',
  summary: 'IAM-01: log out the current session',
  responses: {
    204: {
      description: 'Session revoked and cookie cleared',
    },
    401: {
      description: 'No usable session / replay detected / account state denied',
      content: { 'application/json': { schema: errorEnvelopeRef } },
    },
  },
});

registry.registerPath({
  method: 'get',
  path: '/v1/account/sessions',
  summary: 'IAM-01: list the caller’s active sessions, newest first',
  responses: {
    200: {
      description: 'Active sessions of the caller',
      content: { 'application/json': { schema: sessionListResponseRef } },
    },
    401: {
      description: 'No usable session / replay detected / account state denied',
      content: { 'application/json': { schema: errorEnvelopeRef } },
    },
  },
});

registry.registerPath({
  method: 'delete',
  path: '/v1/account/sessions/{sessionId}',
  summary: 'IAM-01: revoke one of the caller’s sessions',
  request: {
    params: sessionIdParamsRef,
  },
  responses: {
    204: {
      description: 'Session revoked',
    },
    401: {
      description: 'No usable session / replay detected / account state denied',
      content: { 'application/json': { schema: errorEnvelopeRef } },
    },
    404: {
      description: 'Unknown or cross-account session id (uniform)',
      content: { 'application/json': { schema: errorEnvelopeRef } },
    },
  },
});

registry.registerPath({
  method: 'post',
  path: '/v1/account/sessions/mfa',
  summary: 'IAM-01: complete an MFA challenge into an AAL2 session',
  request: {
    body: {
      required: true,
      content: { 'application/json': { schema: mfaLoginRequestRef } },
    },
  },
  responses: {
    200: {
      description: 'AAL2 session created — token travels only in the HttpOnly cookie',
      content: { 'application/json': { schema: sessionResponseRef } },
    },
    400: {
      description: 'Validation failed',
      content: { 'application/json': { schema: errorEnvelopeRef } },
    },
    401: {
      description: 'Challenge missing/consumed/invalid code, or account state denied',
      content: { 'application/json': { schema: errorEnvelopeRef } },
    },
    429: {
      description: 'Rate limited',
      content: { 'application/json': { schema: errorEnvelopeRef } },
    },
  },
});

registry.registerPath({
  method: 'post',
  path: '/v1/account/mfa/totp/enrollment',
  summary:
    'IAM-01: start TOTP enrollment (password re-verified) — the otpauth URI is returned once',
  request: {
    body: {
      required: true,
      content: { 'application/json': { schema: totpEnrollmentRequestRef } },
    },
  },
  responses: {
    201: {
      description: 'Pending factor created; the URI embeds the secret and is never returned again',
      content: { 'application/json': { schema: totpEnrollmentResponseRef } },
    },
    400: {
      description: 'Validation failed',
      content: { 'application/json': { schema: errorEnvelopeRef } },
    },
    401: {
      description: 'Invalid password / no usable session',
      content: { 'application/json': { schema: errorEnvelopeRef } },
    },
    409: {
      description: 'MFA already enabled',
      content: { 'application/json': { schema: errorEnvelopeRef } },
    },
  },
});

registry.registerPath({
  method: 'post',
  path: '/v1/account/mfa/totp/enrollment/confirm',
  summary:
    'IAM-01: confirm with the first TOTP code — enables the factor, mints 10 recovery codes, rotates to AAL2',
  request: {
    body: {
      required: true,
      content: { 'application/json': { schema: totpEnrollmentConfirmRequestRef } },
    },
  },
  responses: {
    200: {
      description: 'Factor enabled; the 10 one-time recovery codes are shown exactly once',
      content: { 'application/json': { schema: totpEnrollmentConfirmResponseRef } },
    },
    400: {
      description: 'Validation failed',
      content: { 'application/json': { schema: errorEnvelopeRef } },
    },
    401: {
      description: 'Invalid TOTP code / replay detected / no usable session',
      content: { 'application/json': { schema: errorEnvelopeRef } },
    },
    404: {
      description: 'No pending enrollment',
      content: { 'application/json': { schema: errorEnvelopeRef } },
    },
    409: {
      description: 'MFA already enabled',
      content: { 'application/json': { schema: errorEnvelopeRef } },
    },
  },
});

registry.registerPath({
  method: 'post',
  path: '/v1/account/mfa/recovery-codes/regenerate',
  summary: 'IAM-01: regenerate recovery codes (password re-verified) — old unused codes die',
  request: {
    body: {
      required: true,
      content: { 'application/json': { schema: recoveryRegenerateRequestRef } },
    },
  },
  responses: {
    200: {
      description: 'Fresh 10 one-time codes shown exactly once',
      content: { 'application/json': { schema: recoveryRegenerateResponseRef } },
    },
    400: {
      description: 'Validation failed',
      content: { 'application/json': { schema: errorEnvelopeRef } },
    },
    401: {
      description: 'Invalid password / no usable session',
      content: { 'application/json': { schema: errorEnvelopeRef } },
    },
    404: {
      description: 'No enabled factor',
      content: { 'application/json': { schema: errorEnvelopeRef } },
    },
  },
});

registry.registerPath({
  method: 'delete',
  path: '/v1/account/mfa/totp',
  summary: 'IAM-01: disable TOTP (password + TOTP or recovery code) — rotates to AAL1',
  request: {
    body: {
      required: true,
      content: { 'application/json': { schema: totpDisableRequestRef } },
    },
  },
  responses: {
    204: {
      description: 'Factor disabled, other sessions revoked, current session rotated to AAL1',
    },
    400: {
      description: 'Validation failed',
      content: { 'application/json': { schema: errorEnvelopeRef } },
    },
    401: {
      description: 'Invalid password / invalid TOTP or recovery code / replay detected',
      content: { 'application/json': { schema: errorEnvelopeRef } },
    },
    404: {
      description: 'No enabled factor',
      content: { 'application/json': { schema: errorEnvelopeRef } },
    },
  },
});

registry.registerPath({
  method: 'get',
  path: '/v1/account/devices',
  summary: 'IAM-01: list the caller’s devices, most recently seen first',
  responses: {
    200: {
      description: 'Un-revoked devices of the caller',
      content: { 'application/json': { schema: deviceListResponseRef } },
    },
    401: {
      description: 'No usable session / replay detected / account state denied',
      content: { 'application/json': { schema: errorEnvelopeRef } },
    },
  },
});

registry.registerPath({
  method: 'patch',
  path: '/v1/account/devices/{deviceId}',
  summary: 'IAM-01: rename one of the caller’s devices',
  request: {
    params: deviceIdParamsRef,
    body: {
      required: true,
      content: { 'application/json': { schema: deviceRenameRequestRef } },
    },
  },
  responses: {
    200: {
      description: 'Renamed device summary',
      content: { 'application/json': { schema: deviceRenameResponseRef } },
    },
    400: {
      description: 'Validation failed',
      content: { 'application/json': { schema: errorEnvelopeRef } },
    },
    401: {
      description: 'No usable session / replay detected / account state denied',
      content: { 'application/json': { schema: errorEnvelopeRef } },
    },
    404: {
      description: 'Unknown or cross-account device id (uniform)',
      content: { 'application/json': { schema: errorEnvelopeRef } },
    },
  },
});

registry.registerPath({
  method: 'delete',
  path: '/v1/account/devices/{deviceId}',
  summary: 'IAM-01: revoke a device and every active session bound to it',
  request: {
    params: deviceIdParamsRef,
  },
  responses: {
    204: {
      description: 'Device revoked and its active sessions revoked',
    },
    400: {
      description: 'Validation failed',
      content: { 'application/json': { schema: errorEnvelopeRef } },
    },
    401: {
      description: 'No usable session / replay detected / account state denied',
      content: { 'application/json': { schema: errorEnvelopeRef } },
    },
    404: {
      description: 'Unknown or cross-account device id (uniform)',
      content: { 'application/json': { schema: errorEnvelopeRef } },
    },
  },
});

const generator = new OpenApiGeneratorV3(registry.definitions);

export const openApiDocument: oas30.OpenAPIObject = generator.generateDocument({
  openapi: '3.0.3',
  info: {
    title: 'Women AI Network API — FND-01 foundation + IAM-01 account',
    version: '0.2.0',
    description:
      'Foundation endpoints (FND-01) and IAM-01 account registration/login. No other business functionality is exposed.',
  },
  servers: [{ url: 'http://127.0.0.1:3100/v1' }],
});
