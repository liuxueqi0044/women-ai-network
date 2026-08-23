import {
  pino,
  stdTimeFunctions,
  type DestinationStream,
  type Logger as PinoLogger,
  type LoggerOptions as PinoOptions,
} from 'pino';
import { getRequestContext } from './request-context.js';
import { REDACTED_VALUE, sanitize, sanitizeText, type SanitizeOptions } from './redaction.js';
import { parseTraceparent } from './traceparent.js';

/**
 * Wrapped Pino logger for every app.
 *
 * Every log line carries: timestamp, level, service, environment, and —
 * when inside a request/job context — request_id and trace_id. EVERY
 * argument is defensively sanitized before it reaches Pino: the structured
 * object (key-based + content-based), the message string (content-based)
 * and all extra arguments. Errors are serialized under the shared Error
 * policy — production default keeps only type/name/stable code, so raw
 * exception message/stack can never reach production logs. An additional
 * native Pino redact layer acts as defense in depth.
 */

export interface LoggerOptions {
  service: string;
  environment: string;
  level: 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';
  /** Pretty-print for terminals (development only; rejected in production by config). */
  pretty?: boolean;
  /** Test hook: capture JSON lines here instead of stdout. */
  destination?: DestinationStream;
  /**
   * Keep Error message/stack (content-sanitized). Defaults to
   * `environment !== 'production'`: production logs never carry arbitrary
   * exception text.
   */
  includeErrorMessage?: boolean;
}

export interface LogMethod {
  (obj: Record<string, unknown>, msg?: string, ...args: unknown[]): void;
  (msg: string, ...args: unknown[]): void;
  (error: Error, msg?: string, ...args: unknown[]): void;
}

export interface WaiLogger {
  trace: LogMethod;
  debug: LogMethod;
  info: LogMethod;
  warn: LogMethod;
  error: LogMethod;
  fatal: LogMethod;
  /** Creates a logger with additional (sanitized) bindings. */
  child(bindings: Record<string, unknown>): WaiLogger;
}

const LOG_LEVELS = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'] as const;

// Native Pino redact layer, defense in depth on top of the wrapper's deep
// sanitize(). Scoped to the deny-listed keys only — non-sensitive values
// (e.g. an `accept` header) must survive. Hyphenated keys need bracket
// notation because fast-redact compiles paths as JavaScript expressions.
const PINO_REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  "req.headers['set-cookie']",
  'res.headers.authorization',
  'res.headers.cookie',
  "res.headers['set-cookie']",
  '*.headers.authorization',
  '*.headers.cookie',
  "*.headers['set-cookie']",
  '*.authorization',
  '*.cookie',
  "*['set-cookie']",
  '*.password',
  '*.token',
  '*.email',
  '*.phone',
  '*.secret',
  '*.prompt',
];

function contextFields(): Record<string, string> {
  const store = getRequestContext();
  if (store === undefined) {
    return {};
  }
  const fields: { request_id: string; trace_id?: string } = { request_id: store.requestId };
  if (store.traceparent !== undefined) {
    const parsed = parseTraceparent(store.traceparent);
    if (parsed !== null) {
      fields.trace_id = parsed.traceId;
    }
  }
  return fields;
}

interface NormalizedArgs {
  obj: Record<string, unknown>;
  msg: string | undefined;
  rest: unknown[];
}

function normalizeArgs(args: unknown[]): NormalizedArgs {
  const first = args[0];
  if (first instanceof Error) {
    const msg = typeof args[1] === 'string' ? (args[1] as string) : undefined;
    return { obj: { err: first }, msg, rest: msg === undefined ? args.slice(1) : args.slice(2) };
  }
  if (typeof first === 'string') {
    return { obj: {}, msg: first, rest: args.slice(1) };
  }
  if (first !== null && typeof first === 'object' && !Array.isArray(first)) {
    const msg = typeof args[1] === 'string' ? (args[1] as string) : undefined;
    return {
      obj: first as Record<string, unknown>,
      msg,
      rest: msg === undefined ? args.slice(1) : args.slice(2),
    };
  }
  // Unexpected first argument (array, number, ...): fold it into a field.
  return { obj: { value: first }, msg: undefined, rest: args.slice(1) };
}

function wrapLogger(inner: PinoLogger, sanitizeOptions: SanitizeOptions): WaiLogger {
  const wrapper = {} as WaiLogger;
  for (const level of LOG_LEVELS) {
    wrapper[level] = ((...args: unknown[]): void => {
      const { obj, msg, rest } = normalizeArgs(args);
      // Request context always wins over caller-supplied fields so the
      // logged request_id/trace_id can never diverge from the active one.
      const merged = {
        ...(sanitize(obj, sanitizeOptions) as Record<string, unknown>),
        ...contextFields(),
      };
      // The message and every extra argument get the same defensive
      // treatment as the structured object — free text is content-scanned
      // so sentinel/PII material cannot reach the JSON line.
      const safeMsg = msg === undefined ? undefined : sanitizeText(msg);
      const safeRest = rest.map((arg) => sanitize(arg, sanitizeOptions));
      inner[level](merged, ...(safeMsg === undefined ? [] : [safeMsg]), ...safeRest);
    }) as LogMethod;
  }
  wrapper.child = (bindings: Record<string, unknown>): WaiLogger =>
    wrapLogger(
      inner.child(sanitize(bindings, sanitizeOptions) as Record<string, unknown>),
      sanitizeOptions,
    );
  return wrapper;
}

export function createLogger(options: LoggerOptions): WaiLogger {
  // Shared Error policy for every layer of the wrapper: production default
  // drops message/stack entirely; non-production keeps sanitized copies.
  const sanitizeOptions: SanitizeOptions = {
    includeErrorMessage: options.includeErrorMessage ?? options.environment !== 'production',
  };
  const pinoOptions: PinoOptions = {
    level: options.level,
    base: { service: options.service, environment: options.environment },
    timestamp: stdTimeFunctions.isoTime,
    redact: { paths: PINO_REDACT_PATHS, censor: REDACTED_VALUE },
    serializers: {
      // Defense in depth: any Error reaching Pino outside the wrapper path
      // is serialized under the same Error policy.
      err: (err: unknown) => sanitize(err, sanitizeOptions),
    },
  };
  if (options.pretty === true) {
    pinoOptions.transport = {
      target: 'pino-pretty',
      options: { ignore: 'pid,hostname' },
    };
  }
  const instance =
    options.destination === undefined ? pino(pinoOptions) : pino(pinoOptions, options.destination);
  return wrapLogger(instance, sanitizeOptions);
}
