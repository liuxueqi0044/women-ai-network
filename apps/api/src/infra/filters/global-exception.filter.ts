import {
  Catch,
  HttpException,
  Inject,
  type ArgumentsHost,
  type ExceptionFilter,
} from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { ZodError } from 'zod';
import {
  CircleDomainError,
  ERROR_CODES,
  errorEnvelopeSchema,
  requestIdSchema,
  type ErrorCode,
} from '@wai/contracts';
import { getRequestContext, type WaiLogger } from '@wai/observability';
import { APP_LOGGER } from '../../tokens.js';
import { randomUUID } from 'node:crypto';

interface MappedException {
  status: number;
  code: ErrorCode;
  message: string;
  details?: string[];
}

interface FastifyEnvelopeError {
  statusCode: number;
  code: ErrorCode;
  message: string;
  request_id: string;
}

/**
 * Global exception filter: every failure leaves the API as a stable
 * @wai/contracts error envelope (code, message, details?, request_id).
 * Internal errors are logged with full context but their messages are never
 * exposed to clients.
 */
@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
  constructor(@Inject(APP_LOGGER) private readonly logger: WaiLogger) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const reply = http.getResponse<FastifyReply>();
    const request = http.getRequest<FastifyRequest>();
    const mapped = this.map(exception);

    // For handler-level errors the interceptor already stored the id and set
    // the reply header; for routing-level errors (404s) the interceptor never
    // ran, so fall back to the accepted incoming header before generating.
    // Fastify-level hook errors carry their own envelope request_id (same
    // rule as this fallback) — reuse it so body and header stay consistent.
    const store = getRequestContext();
    const requestId =
      store !== undefined
        ? store.requestId
        : (this.fastifyEnvelope(exception)?.request_id ??
          this.validHeaderRequestId(request.headers['x-request-id']) ??
          this.validHeaderRequestId(reply.getHeader('x-request-id')) ??
          randomUUID());
    reply.header('x-request-id', requestId);

    if (mapped.status >= 500) {
      const error = exception instanceof Error ? exception : new Error(mapped.message);
      this.logger.error(
        {
          event: 'http.request.error',
          status_code: mapped.status,
          error_code: mapped.code,
          err: error,
        },
        mapped.message,
      );
    }

    const envelope = errorEnvelopeSchema.parse({
      code: mapped.code,
      message: mapped.message,
      ...(mapped.details === undefined ? {} : { details: mapped.details }),
      request_id: requestId,
    });
    reply.status(mapped.status).send(envelope);
  }

  private map(exception: unknown): MappedException {
    const envelope = this.fastifyEnvelope(exception);
    if (envelope !== undefined) {
      return { status: envelope.statusCode, code: envelope.code, message: envelope.message };
    }

    if (exception instanceof ZodError) {
      return {
        status: 400,
        code: ERROR_CODES.VALIDATION_ERROR,
        message: 'Request validation failed',
        details: exception.issues.map(
          (issue) => `${issue.path.join('.') || 'body'}: ${issue.message}`,
        ),
      };
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const response = exception.getResponse();
      if (typeof response === 'object' && response !== null && 'code' in response) {
        const code = (response as { code: unknown }).code;
        if (typeof code === 'string' && Object.values(ERROR_CODES).includes(code as ErrorCode)) {
          const message = this.extractMessage(response);
          return { status, code: code as ErrorCode, message };
        }
      }
      const message = this.extractMessage(response);
      const code =
        status === 404
          ? ERROR_CODES.NOT_FOUND
          : status === 400
            ? ERROR_CODES.BAD_REQUEST
            : status >= 500
              ? ERROR_CODES.INTERNAL_ERROR
              : ERROR_CODES.BAD_REQUEST;
      const details = Array.isArray((response as { message?: unknown }).message)
        ? (response as { message: unknown[] }).message.map((item) => String(item)).slice(0, 50)
        : undefined;
      return { status, code, message, ...(details === undefined ? {} : { details }) };
    }

    if (exception instanceof CircleDomainError) {
      const status =
        exception.kind === 'NOT_FOUND'
          ? 404
          : exception.kind === 'VALIDATION'
            ? 400
            : exception.kind === 'CONFLICT'
              ? 409
              : 500;
      return {
        status,
        code:
          status === 404
            ? ERROR_CODES.NOT_FOUND
            : status === 400
              ? ERROR_CODES.VALIDATION_ERROR
              : status === 409
                ? ERROR_CODES.CIRCLE_CONFLICT
                : ERROR_CODES.INTERNAL_ERROR,
        message:
          status === 404
            ? 'Circle not found'
            : status === 400
              ? 'Request validation failed'
              : status === 409
                ? 'Circle state conflict'
                : 'Internal server error',
      };
    }

    return { status: 500, code: ERROR_CODES.INTERNAL_ERROR, message: 'Internal server error' };
  }

  /**
   * Fastify-level hooks (the rate-limit plugin, the JSON content-type guard)
   * throw plain-object envelopes that bypass Nest's exception zone but reach
   * this filter through Nest's exception-layer proxy. Recognized by the
   * contract envelope fields plus a valid HTTP status — anything else is not
   * one of ours and keeps the 500 default.
   */
  private fastifyEnvelope(exception: unknown): FastifyEnvelopeError | undefined {
    if (typeof exception !== 'object' || exception === null) {
      return undefined;
    }
    const candidate = exception as {
      statusCode?: unknown;
      code?: unknown;
      message?: unknown;
      request_id?: unknown;
    };
    if (
      typeof candidate.statusCode !== 'number' ||
      candidate.statusCode < 400 ||
      candidate.statusCode > 599 ||
      typeof candidate.code !== 'string' ||
      !(Object.values(ERROR_CODES) as string[]).includes(candidate.code) ||
      typeof candidate.message !== 'string' ||
      typeof candidate.request_id !== 'string' ||
      !requestIdSchema.safeParse(candidate.request_id).success
    ) {
      return undefined;
    }
    return {
      statusCode: candidate.statusCode,
      code: candidate.code as ErrorCode,
      message: candidate.message.slice(0, 500),
      request_id: candidate.request_id,
    };
  }

  private extractMessage(response: string | object): string {
    if (typeof response === 'string') {
      return response.slice(0, 500);
    }
    const message = (response as { message?: unknown }).message;
    if (typeof message === 'string') {
      return message.slice(0, 500);
    }
    return 'Request failed';
  }

  private validHeaderRequestId(value: unknown): string | undefined {
    if (typeof value === 'string' && requestIdSchema.safeParse(value).success) {
      return value;
    }
    if (Array.isArray(value)) {
      const first = value[0];
      if (typeof first === 'string' && requestIdSchema.safeParse(first).success) {
        return first;
      }
    }
    return undefined;
  }
}
