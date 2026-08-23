import { describe, expect, it } from 'vitest';
import { Writable } from 'node:stream';
import { createLogger, type WaiLogger } from './logger.js';
import { REDACTED_VALUE } from './redaction.js';
import { runWithRequestContext } from './request-context.js';

/** Shape of a parsed JSON log line used by the assertions below. */
interface LogLine {
  level?: number;
  msg?: string;
  service?: string;
  environment?: string;
  event?: string;
  value?: unknown;
  time?: string;
  request_id?: string;
  trace_id?: string;
  token?: string;
  component?: string;
  req?: {
    headers: {
      authorization?: string;
      cookie?: string;
      accept?: string;
    };
  };
  body?: { user: { Email: string } };
  err?: {
    message?: string;
    password?: string;
    email?: string;
    stack?: string;
    type?: string;
    name?: string;
    code?: string;
  };
}

class CollectingStream extends Writable {
  lines: LogLine[] = [];
  rawLines: string[] = [];

  override _write(
    chunk: Buffer | string,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    const text = chunk.toString();
    for (const line of text.split('\n').filter((part) => part.length > 0)) {
      this.rawLines.push(line);
      this.lines.push(JSON.parse(line) as LogLine);
    }
    callback(null);
  }
}

function captureLogger(): { logger: WaiLogger; stream: CollectingStream } {
  const stream = new CollectingStream();
  const logger = createLogger({
    service: 'test-service',
    environment: 'test',
    level: 'trace',
    destination: stream,
  });
  return { logger, stream };
}

const TRACEPARENT = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';

describe('createLogger', () => {
  it('emits timestamp, level, service and environment on every line', () => {
    const { logger, stream } = captureLogger();
    logger.info({ event: 'unit.test', value: 1 }, 'hello');
    const line = stream.lines[0] ?? {};
    expect(line.level).toBe(30);
    expect(line.msg).toBe('hello');
    expect(line.service).toBe('test-service');
    expect(line.environment).toBe('test');
    expect(line.event).toBe('unit.test');
    expect(line.value).toBe(1);
    expect(typeof line.time).toBe('string');
    expect(Number.isNaN(Date.parse(line.time ?? ''))).toBe(false);
  });

  it('redacts sensitive HTTP headers passed through the logger', () => {
    const { logger, stream } = captureLogger();
    logger.info({
      event: 'http.request',
      req: {
        headers: {
          authorization: 'Bearer top-secret',
          cookie: 'sid=1',
          accept: 'application/json',
        },
      },
    });
    const headers = stream.lines[0]?.req?.headers;
    expect(headers?.authorization).toBe(REDACTED_VALUE);
    expect(headers?.cookie).toBe(REDACTED_VALUE);
    expect(headers?.accept).toBe('application/json');
  });

  it('redacts Error metadata but keeps message and stack', () => {
    const { logger, stream } = captureLogger();
    const error = new Error('db exploded');
    (error as unknown as Record<string, unknown>)['password'] = 'leak-me';
    logger.error({ event: 'unit.error', err: error }, 'request failed');
    const line = stream.lines[0] ?? {};
    expect(line.msg).toBe('request failed');
    const loggedErr = line.err;
    expect(loggedErr?.message).toBe('db exploded');
    expect(loggedErr?.password).toBe(REDACTED_VALUE);
    expect(typeof loggedErr?.stack).toBe('string');
  });

  it('accepts a positional Error as the first argument', () => {
    const { logger, stream } = captureLogger();
    const error = new Error('boom');
    (error as unknown as Record<string, unknown>)['email'] = 'leak@example.com';
    logger.error(error, 'it broke');
    const line = stream.lines[0] ?? {};
    expect(line.msg).toBe('it broke');
    const loggedErr = line.err;
    expect(loggedErr?.message).toBe('boom');
    expect(loggedErr?.email).toBe(REDACTED_VALUE);
  });

  it('merges request_id and trace_id from the request context', () => {
    const { logger, stream } = captureLogger();
    runWithRequestContext(
      { requestId: 'f0b4f0b4-6b2a-4e12-9a1c-2d3e4f5a6b7c', traceparent: TRACEPARENT },
      () => {
        logger.info({ event: 'unit.context' }, 'in context');
      },
    );
    const line = stream.lines[0] ?? {};
    expect(line.request_id).toBe('f0b4f0b4-6b2a-4e12-9a1c-2d3e4f5a6b7c');
    expect(line.trace_id).toBe('4bf92f3577b34da6a3ce929d0e0e4736');
  });

  it('lets the request context win over caller-supplied request_id', () => {
    const { logger, stream } = captureLogger();
    runWithRequestContext({ requestId: 'f0b4f0b4-6b2a-4e12-9a1c-2d3e4f5a6b7c' }, () => {
      logger.info({ event: 'unit.context', request_id: 'ffffffff-ffff-4fff-8fff-ffffffffffff' });
    });
    expect((stream.lines[0] ?? {}).request_id).toBe('f0b4f0b4-6b2a-4e12-9a1c-2d3e4f5a6b7c');
  });

  it('omits request_id/trace_id outside a request context', () => {
    const { logger, stream } = captureLogger();
    logger.info({ event: 'unit.nocontext' });
    const line = stream.lines[0] ?? {};
    expect('request_id' in line).toBe(false);
    expect('trace_id' in line).toBe(false);
  });

  it('redacts sensitive fields in child bindings', () => {
    const { logger, stream } = captureLogger();
    const child = logger.child({ token: 'child-token', component: 'c1' });
    child.info({ event: 'unit.child' });
    const line = stream.lines[0] ?? {};
    expect(line.token).toBe(REDACTED_VALUE);
    expect(line.component).toBe('c1');
  });

  it('redacts deeply nested values (nested objects with mixed casing)', () => {
    const { logger, stream } = captureLogger();
    logger.info({ event: 'unit.nested', body: { user: { Email: 'x@y.z' } } });
    const body = stream.lines[0]?.body?.user;
    expect(body?.Email).toBe(REDACTED_VALUE);
  });

  it('redacts sensitive fields at every log level', () => {
    const { logger, stream } = captureLogger();
    logger.trace({ token: 'a' });
    logger.debug({ token: 'b' });
    logger.warn({ token: 'c' });
    logger.fatal({ token: 'd' });
    for (const line of stream.lines) {
      expect(line.token).toBe(REDACTED_VALUE);
    }
  });
});

// ---------------------------------------------------------------------------
// R1-02 regression: sentinel containment on the FINAL serialized JSON line.
// The assertions below always check the raw JSON text of every emitted line
// (not just the [REDACTED] of one field), so a sentinel that slips through
// any path — object, message, Error, nested Error, array, rest argument —
// fails the test even if one field looks clean.
// ---------------------------------------------------------------------------

const SENTINEL_TOKEN = 'fake-review-token';
const SENTINEL_EMAIL = 'review-user@example.invalid';
const SENTINEL_PHONE = '+86 138 0013 8000';
const SENTINEL_ID_NUMBER = '11010519491231002X';

function expectNoSentinelInRawLines(stream: CollectingStream): void {
  expect(stream.rawLines.length).toBeGreaterThan(0);
  for (const raw of stream.rawLines) {
    expect(raw).not.toContain(SENTINEL_TOKEN);
    expect(raw).not.toContain(SENTINEL_EMAIL);
    expect(raw).not.toContain(SENTINEL_PHONE);
    expect(raw).not.toContain(SENTINEL_ID_NUMBER);
  }
}

describe('logger — sentinel containment on final JSON lines (R1-02)', () => {
  it('keeps raw query strings out: the review URL shape leaks nothing', () => {
    const { logger, stream } = captureLogger();
    logger.info(
      { event: 'unit.sentinel.url' },
      `/v1/health/live?token=${SENTINEL_TOKEN}&email=${SENTINEL_EMAIL}`,
    );
    expectNoSentinelInRawLines(stream);
    expect(stream.lines[0]?.msg).toContain(REDACTED_VALUE);
    expect(stream.lines[0]?.msg).toContain('/v1/health/live?');
  });

  it('redacts sentinels in a plain logger message', () => {
    const { logger, stream } = captureLogger();
    logger.info(
      { event: 'unit.sentinel.msg' },
      `probe failed with token=${SENTINEL_TOKEN} for ${SENTINEL_EMAIL}`,
    );
    expectNoSentinelInRawLines(stream);
    expect(stream.lines[0]?.msg).toContain(`token=${REDACTED_VALUE}`);
  });

  it('redacts phone, identity number and colon-form token in the final production JSON', () => {
    const stream = new CollectingStream();
    const logger = createLogger({
      service: 'test-service',
      environment: 'production',
      level: 'trace',
      destination: stream,
    });
    logger.info(
      { event: 'unit.sentinel.r1_1' },
      `phone ${SENTINEL_PHONE}; token: ${SENTINEL_TOKEN}; id ${SENTINEL_ID_NUMBER}`,
    );
    expectNoSentinelInRawLines(stream);
    expect(stream.lines[0]?.msg).toBe(
      `phone ${REDACTED_VALUE}; token: ${REDACTED_VALUE}; id ${REDACTED_VALUE}`,
    );
  });

  it('redacts labelled prompt, message body, document and URL-encoded email values', () => {
    const { logger, stream } = captureLogger();
    logger.info(
      { event: 'unit.sentinel.r1_1.labels' },
      'prompt=private user message; message_body: private conversation; document=AB123456; email=review-user%40example.invalid',
    );
    expectNoSentinelInRawLines(stream);
    expect(stream.lines[0]?.msg).toBe(
      `prompt=${REDACTED_VALUE}; message_body: ${REDACTED_VALUE}; document=${REDACTED_VALUE}; email=${REDACTED_VALUE}`,
    );
  });

  it('redacts sentinels in nested case-variant fields, arrays and objects', () => {
    const { logger, stream } = captureLogger();
    logger.info({
      event: 'unit.sentinel.obj',
      outer: {
        inner: {
          TOKEN: SENTINEL_TOKEN,
          Email: SENTINEL_EMAIL,
        },
        list: [`mail ${SENTINEL_EMAIL}`, { Message_Body: SENTINEL_TOKEN }],
      },
    });
    expectNoSentinelInRawLines(stream);
    const outer = (
      stream.lines[0] as {
        outer?: {
          inner?: { TOKEN?: string; Email?: string };
          list?: Array<string | { Message_Body?: string }>;
        };
      }
    ).outer;
    expect(outer?.inner?.TOKEN).toBe(REDACTED_VALUE);
    expect(outer?.inner?.Email).toBe(REDACTED_VALUE);
    expect(outer?.list?.[0]).toContain(REDACTED_VALUE);
    expect(
      typeof outer?.list?.[1] === 'object' &&
        (outer.list[1] as { Message_Body?: string }).Message_Body,
    ).toBe(REDACTED_VALUE);
  });

  it('redacts sentinels in rest arguments after the message', () => {
    const { logger, stream } = captureLogger();
    logger.info({ event: 'unit.sentinel.rest' }, 'rest args', `cc ${SENTINEL_EMAIL}`, {
      Token: SENTINEL_TOKEN,
    });
    expectNoSentinelInRawLines(stream);
  });

  it('redacts sentinels in an Error message and stack (non-production policy)', () => {
    const { logger, stream } = captureLogger();
    const error = new Error(`boom token=${SENTINEL_TOKEN} ${SENTINEL_EMAIL}`);
    logger.error({ event: 'unit.sentinel.err', err: error }, 'request failed');
    expectNoSentinelInRawLines(stream);
    const loggedErr = stream.lines[0]?.err;
    expect(loggedErr?.message).toContain(`token=${REDACTED_VALUE}`);
    expect(loggedErr?.message).not.toContain(SENTINEL_EMAIL);
    expect(loggedErr?.stack).toContain(REDACTED_VALUE);
    expect(loggedErr?.stack).not.toContain(SENTINEL_TOKEN);
  });

  it('redacts sentinels inside nested Errors', () => {
    const { logger, stream } = captureLogger();
    const inner = new Error(`token=${SENTINEL_TOKEN}`);
    logger.error({ event: 'unit.sentinel.errnest', err: { wrapped: inner } }, 'request failed');
    expectNoSentinelInRawLines(stream);
    const wrapped = (stream.lines[0] as { err?: { wrapped?: { message?: string } } }).err?.wrapped;
    expect(wrapped?.message).toContain(REDACTED_VALUE);
    expect(wrapped?.message).not.toContain(SENTINEL_TOKEN);
  });

  it('drops Error message/stack entirely under the production default', () => {
    const stream = new CollectingStream();
    const logger = createLogger({
      service: 'test-service',
      environment: 'production',
      level: 'trace',
      destination: stream,
    });
    const error = new Error(`boom token=${SENTINEL_TOKEN} ${SENTINEL_EMAIL}`);
    logger.error({ event: 'unit.sentinel.prod', err: error }, 'request failed');
    expectNoSentinelInRawLines(stream);
    const loggedErr = stream.lines[0]?.err ?? {};
    expect('message' in loggedErr).toBe(false);
    expect('stack' in loggedErr).toBe(false);
    expect(loggedErr.type).toBe('Error');
    expect(loggedErr.name).toBe('Error');
  });
});
