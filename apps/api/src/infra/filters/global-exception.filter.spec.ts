import { describe, expect, it } from 'vitest';
import { BadRequestException, HttpException, ServiceUnavailableException } from '@nestjs/common';
import type { ArgumentsHost } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { z, ZodError } from 'zod';
import { ERROR_CODES, errorEnvelopeSchema, type ErrorEnvelope } from '@wai/contracts';
import { runWithRequestContext, type WaiLogger } from '@wai/observability';
import { GlobalExceptionFilter } from './global-exception.filter.js';

const silentLogger: WaiLogger = {
  trace: () => undefined,
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  fatal: () => undefined,
  child: () => silentLogger,
};

interface Captured {
  status?: number;
  body?: unknown;
  headers: Record<string, unknown>;
}

function fakeReply(): { reply: FastifyReply; captured: Captured } {
  const captured: Captured = { headers: {} };
  const reply = {
    status(code: number): FastifyReply {
      captured.status = code;
      return reply as unknown as FastifyReply;
    },
    send(body: unknown): FastifyReply {
      captured.body = body;
      return reply as unknown as FastifyReply;
    },
    getHeader(name: string): unknown {
      return captured.headers[name.toLowerCase()];
    },
    header(name: string, value: unknown): FastifyReply {
      captured.headers[name.toLowerCase()] = value;
      return reply as unknown as FastifyReply;
    },
  } as unknown as FastifyReply;
  return { reply, captured };
}

function fakeHost(
  reply: FastifyReply,
  requestHeaders: Record<string, string | string[]> = {},
): ArgumentsHost {
  return {
    switchToHttp: () => ({
      getResponse: () => reply,
      getRequest: () => ({ headers: requestHeaders }),
    }),
  } as unknown as ArgumentsHost;
}

function capturedEnvelope(captured: Captured): ErrorEnvelope {
  const parsed = errorEnvelopeSchema.safeParse(captured.body);
  expect(parsed.success).toBe(true);
  return parsed.success ? parsed.data : ({} as ErrorEnvelope);
}

describe('GlobalExceptionFilter', () => {
  it('maps ZodError to 400 VALIDATION_ERROR with issue details', () => {
    const filter = new GlobalExceptionFilter(silentLogger);
    const { reply, captured } = fakeReply();
    const host = fakeHost(reply);
    let zodError: ZodError | undefined;
    try {
      z.object({ x: z.string() }).parse({ x: 1 });
    } catch (error) {
      zodError = error as ZodError;
    }
    expect(zodError).toBeInstanceOf(ZodError);
    filter.catch(zodError, host);
    expect(captured.status).toBe(400);
    const envelope = capturedEnvelope(captured);
    expect(envelope.code).toBe('VALIDATION_ERROR');
    expect(envelope.details?.length).toBeGreaterThan(0);
  });

  it('maps an unknown error to 500 INTERNAL_ERROR without leaking internals', () => {
    const filter = new GlobalExceptionFilter(silentLogger);
    const { reply, captured } = fakeReply();
    const host = fakeHost(reply);
    const secret = new Error('connection to postgres://user:secret@internal failed');
    (secret as unknown as Record<string, unknown>)['password'] = 'hunter2';
    filter.catch(secret, host);
    expect(captured.status).toBe(500);
    const envelope = capturedEnvelope(captured);
    expect(envelope.code).toBe('INTERNAL_ERROR');
    expect(envelope.message).toBe('Internal server error');
    expect(JSON.stringify(captured.body)).not.toMatch(/secret/);
    expect(JSON.stringify(captured.body)).not.toMatch(/hunter2/);
    expect(envelope.request_id).toBeDefined();
  });

  it('passes through an HttpException carrying an explicit contract error code', () => {
    const filter = new GlobalExceptionFilter(silentLogger);
    const { reply, captured } = fakeReply();
    const host = fakeHost(reply);
    filter.catch(
      new ServiceUnavailableException({
        code: ERROR_CODES.QUEUE_UNAVAILABLE,
        message: 'Queue unavailable',
      }),
      host,
    );
    expect(captured.status).toBe(503);
    const envelope = capturedEnvelope(captured);
    expect(envelope.code).toBe('QUEUE_UNAVAILABLE');
    expect(envelope.message).toBe('Queue unavailable');
  });

  it('maps a 400 with a message array to BAD_REQUEST with details', () => {
    const filter = new GlobalExceptionFilter(silentLogger);
    const { reply, captured } = fakeReply();
    const host = fakeHost(reply);
    filter.catch(new BadRequestException(['message: too long', 'payload: unknown key']), host);
    expect(captured.status).toBe(400);
    const envelope = capturedEnvelope(captured);
    expect(envelope.code).toBe('BAD_REQUEST');
    expect(envelope.details).toEqual(['message: too long', 'payload: unknown key']);
  });

  it('maps plain HttpException without payload info to a generic 400', () => {
    const filter = new GlobalExceptionFilter(silentLogger);
    const { reply, captured } = fakeReply();
    const host = fakeHost(reply);
    filter.catch(new HttpException('custom client error', 422), host);
    expect(captured.status).toBe(422);
    const envelope = capturedEnvelope(captured);
    expect(envelope.code).toBe('BAD_REQUEST');
  });

  it('uses the active request context id when present', () => {
    const filter = new GlobalExceptionFilter(silentLogger);
    const { reply, captured } = fakeReply();
    const host = fakeHost(reply);
    runWithRequestContext({ requestId: 'f0b4f0b4-6b2a-4e12-9a1c-2d3e4f5a6b7c' }, () => {
      filter.catch(new Error('boom'), host);
    });
    const envelope = capturedEnvelope(captured);
    expect(envelope.request_id).toBe('f0b4f0b4-6b2a-4e12-9a1c-2d3e4f5a6b7c');
    expect(captured.headers['x-request-id']).toBe('f0b4f0b4-6b2a-4e12-9a1c-2d3e4f5a6b7c');
  });

  it('echoes an accepted incoming x-request-id when no context store is active (404 case)', () => {
    const filter = new GlobalExceptionFilter(silentLogger);
    const { reply, captured } = fakeReply();
    const incomingId = 'f0b4f0b4-6b2a-4e12-9a1c-2d3e4f5a6b7c';
    const host = fakeHost(reply, { 'x-request-id': incomingId });
    filter.catch(new Error('boom'), host);
    const envelope = capturedEnvelope(captured);
    expect(envelope.request_id).toBe(incomingId);
    expect(captured.headers['x-request-id']).toBe(incomingId);
  });
});
