/**
 * Deep redaction for structured logs and free text — two layers:
 *
 * 1. Key-based: deny-listed keys at any depth, case- and
 *    separator-insensitive (`access_token`, `accessToken` and `ACCESS-TOKEN`
 *    all match). Matched values become `[REDACTED]`; the field stays.
 * 2. Content-based: EVERY string that reaches the logger — message text,
 *    Error message/stack, nested values, extra arguments — is scanned for
 *    well-formed sensitive material (email addresses, `token=`-style
 *    credential assignments, Bearer/Basic auth values, JWTs, coordinate
 *    pairs) and that material is replaced with `[REDACTED]`.
 *
 * Layer 2 is a defensive backstop, not a licence to log user input: callers
 * must still use fixed message templates and never place bodies, prompts or
 * PII inside message strings (repository sensitive-logging ban). A slip,
 * however, no longer lands raw in the JSON output.
 *
 * Error policy: by default an Error logs only its type, name and a stable
 * machine `code` when present (e.g. ECONNREFUSED) — never arbitrary
 * message/stack text. Non-production loggers may opt in to sanitized
 * message/stack via `includeErrorMessage`.
 */

export const REDACTED_VALUE = '[REDACTED]' as const;

/** Default deny-list required by FND-01; extendable per service if needed. */
export const DEFAULT_REDACTION_KEYS = [
  'authorization',
  'cookie',
  'set-cookie',
  'password',
  'token',
  'access_token',
  'refresh_token',
  'secret',
  'email',
  'phone',
  'document',
  'id_number',
  'message_body',
  'prompt',
  'precise_location',
] as const;

export type RedactionKey = (typeof DEFAULT_REDACTION_KEYS)[number];

/** Lowercase and strip `-`, `_`, `.` and whitespace so key variants collide. */
function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[-_.\s]/g, '');
}

export interface SanitizeOptions {
  /** Extra keys to deny in addition to DEFAULT_REDACTION_KEYS. */
  extraKeys?: readonly string[];
  /**
   * Keep Error message/stack (content-sanitized). Defaults to false:
   * production logs carry only type/name/stable code.
   */
  includeErrorMessage?: boolean;
}

function isBinary(value: unknown): boolean {
  return (
    ArrayBuffer.isView(value) ||
    value instanceof ArrayBuffer ||
    (typeof Buffer !== 'undefined' && Buffer.isBuffer(value))
  );
}

// ---------------------------------------------------------------------------
// Content scanning (layer 2). Patterns are deliberately narrow so legitimate
// log data (timestamps, ports, durations, identifiers, plain prose) survives;
// they target only well-formed sensitive material.
// ---------------------------------------------------------------------------

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

// `token=…`, `token: …`, `secret=…`, `api_key: …` etc. — matched at string
// start or after a delimiter so it covers URL query strings and conventional
// free-text diagnostics. Credential values are token-like and therefore stop
// at whitespace or a structural delimiter.
const SENSITIVE_CREDENTIAL_ASSIGNMENT_RE =
  /(^|[\s?&"'(;,])((?:authorization|token|access[_-]?token|refresh[_-]?token|secret|password|passwd|api[_-]?key|apikey|signature|cookie|credential|session)\s*[:=]\s*)[^\s&"'<>;,]+/gi;

// PII/body fields can legitimately contain whitespace. When someone slips a
// labelled value into free text, redact the whole value until the next clear
// field delimiter rather than leaking the tail of a phone, document or prompt.
const SENSITIVE_FREE_TEXT_ASSIGNMENT_RE =
  /(^|[\s?&"'(;,])((?:email|phone|document|id[_-]?number|message[_-]?body|prompt|precise[_-]?location)\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^;&\r\n]+)/gi;

const BEARER_RE = /\b(bearer\s+)[A-Za-z0-9._~+/=-]+/gi;
const BASIC_RE = /\b(basic\s+)[A-Za-z0-9+/=]+/gi;
const JWT_RE = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g;

// Coordinate pairs ("40.7128,-74.0060") — precise-location ban.
const COORDINATES_RE = /(-?\d{1,3}\.\d{4,})\s*,\s*(-?\d{1,3}\.\d{4,})/g;

// Phone backstops: mainland-China mobile numbers (with optional +86 and
// separators), explicitly international E.164-like numbers, and conventional
// North-American separated numbers. Labelled `phone:`/`phone=` values are
// already covered by SENSITIVE_FREE_TEXT_ASSIGNMENT_RE.
const CN_MOBILE_RE = /(^|[^\d])((?:\+?86[\s.-]?)?1[3-9]\d(?:[\s.-]?\d){8})(?!\d)/g;
const INTERNATIONAL_PHONE_RE = /(^|[^\d])(\+\d(?:[\s().-]*\d){7,14})(?!\d)/g;
const NANP_PHONE_RE = /(^|[^\d])((?:\(\d{3}\)|\d{3})[\s.-]\d{3}[\s.-]\d{4})(?!\d)/g;

// Mainland-China resident identity numbers (current 18-character and legacy
// 15-digit forms). Other document formats are caught when labelled via
// `id_number:`/`document:` and must otherwise remain in structured denied keys.
const CN_ID_NUMBER_RE = /(^|[^A-Za-z0-9])(\d{17}[\dXx]|\d{15})(?![A-Za-z0-9])/g;

/**
 * Content-scans one string and replaces well-formed sensitive material with
 * `[REDACTED]`. Idempotent; never throws.
 */
export function sanitizeText(input: string): string {
  return input
    .replace(EMAIL_RE, REDACTED_VALUE)
    .replace(BEARER_RE, `$1${REDACTED_VALUE}`)
    .replace(BASIC_RE, `$1${REDACTED_VALUE}`)
    .replace(JWT_RE, REDACTED_VALUE)
    .replace(SENSITIVE_CREDENTIAL_ASSIGNMENT_RE, `$1$2${REDACTED_VALUE}`)
    .replace(SENSITIVE_FREE_TEXT_ASSIGNMENT_RE, `$1$2${REDACTED_VALUE}`)
    .replace(COORDINATES_RE, REDACTED_VALUE)
    .replace(CN_MOBILE_RE, `$1${REDACTED_VALUE}`)
    .replace(INTERNATIONAL_PHONE_RE, `$1${REDACTED_VALUE}`)
    .replace(NANP_PHONE_RE, `$1${REDACTED_VALUE}`)
    .replace(CN_ID_NUMBER_RE, `$1${REDACTED_VALUE}`);
}

/** Stable machine codes only — anything else on an Error `code` is dropped. */
const SAFE_CODE_RE = /^[A-Za-z0-9_.-]{1,64}$/;

/**
 * Returns a deep copy of `value` with every sensitive field replaced by
 * `[REDACTED]` and every string content-scanned. Never mutates the input;
 * handles cycles.
 */
export function sanitize(
  value: unknown,
  options: SanitizeOptions = {},
  seen = new WeakSet<object>(),
): unknown {
  if (value === null || value === undefined) {
    return value;
  }
  if (typeof value === 'string') {
    return sanitizeText(value);
  }
  if (
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    typeof value === 'bigint' ||
    typeof value === 'symbol' ||
    typeof value === 'function' ||
    isBinary(value)
  ) {
    return value;
  }

  const denied = new Set(
    [...DEFAULT_REDACTION_KEYS, ...(options.extraKeys ?? [])].map(normalizeKey),
  );

  if (value instanceof Error) {
    if (seen.has(value)) {
      return '[Circular]';
    }
    seen.add(value);
    const output: Record<string, unknown> = {
      type: 'Error',
      name: value.name,
    };
    if (options.includeErrorMessage === true) {
      output['message'] = sanitizeText(value.message);
      if (value.stack !== undefined) {
        output['stack'] = sanitizeText(value.stack);
      }
    }
    for (const [key, propValue] of Object.entries(value)) {
      if (denied.has(normalizeKey(key))) {
        output[key] = REDACTED_VALUE;
      } else if (key === 'code') {
        // A `code` is kept only when it is a stable machine identifier;
        // anything else (including a copy of the message) is dropped.
        if (typeof propValue === 'string' && SAFE_CODE_RE.test(propValue)) {
          output['code'] = propValue;
        }
      } else {
        output[key] = sanitize(propValue, options, seen);
      }
    }
    return output;
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (value instanceof Map || value instanceof Set) {
    // Uncommon in log payloads; keep them serializable but opaque.
    return `[${value.constructor.name}]`;
  }

  if (Array.isArray(value)) {
    if (seen.has(value)) {
      return '[Circular]';
    }
    seen.add(value);
    return value.map((item) => sanitize(item, options, seen));
  }

  if (typeof value === 'object') {
    if (seen.has(value)) {
      return '[Circular]';
    }
    seen.add(value);
    const output: Record<string, unknown> = {};
    for (const [key, propValue] of Object.entries(value)) {
      if (denied.has(normalizeKey(key))) {
        output[key] = REDACTED_VALUE;
      } else {
        output[key] = sanitize(propValue, options, seen);
      }
    }
    return output;
  }

  return value;
}
