import {
  BadRequestException,
  Inject,
  Injectable,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from '@nestjs/common';
import { context, propagation, SpanKind, trace, type Span, type Tracer } from '@opentelemetry/api';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { AppConfig } from '@wai/config';
import { requestIdSchema } from '@wai/contracts';
import {
  createTraceparent,
  parseTraceparent,
  runWithRequestContext,
  type WaiLogger,
} from '@wai/observability';
import { APP_CONFIG, APP_LOGGER, APP_TRACER } from '../../tokens.js';
import { randomUUID } from 'node:crypto';
import { Observable } from 'rxjs';

/**
 * Global interceptor that gives every request a traceable identity:
 *
 * 1. Accepts a valid `x-request-id` header or generates one; rejects invalid
 *    values with a 400. The same id is echoed on the response header and
 *    merged into every log line for the request (via RequestContext).
 * 2. Accepts a valid W3C `traceparent` header or creates a fresh trace; the
 *    traceparent string is propagated to the queue envelope downstream.
 * 3. When OpenTelemetry is enabled, wraps the handler in a SERVER span
 *    parented by that trace; the span always ends (success or error).
 */
@Injectable()
export class RequestContextInterceptor implements NestInterceptor {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(APP_LOGGER) private readonly logger: WaiLogger,
    @Inject(APP_TRACER) private readonly tracer: Tracer,
  ) {}

  intercept(executionContext: ExecutionContext, next: CallHandler): Observable<unknown> {
    const http = executionContext.switchToHttp();
    const request = http.getRequest<FastifyRequest>();
    const reply = http.getResponse<FastifyReply>();

    const incomingRequestId = this.firstHeaderValue(request.headers['x-request-id']);
    if (incomingRequestId !== undefined && !requestIdSchema.safeParse(incomingRequestId).success) {
      throw new BadRequestException('x-request-id header must be a lowercase UUID v4');
    }
    const requestId = incomingRequestId ?? randomUUID();

    const incomingTraceparentRaw = this.firstHeaderValue(request.headers['traceparent']);
    const incomingTraceparent = parseTraceparent(incomingTraceparentRaw);
    const traceparent =
      incomingTraceparentRaw !== undefined && incomingTraceparent !== null
        ? incomingTraceparentRaw.toLowerCase()
        : createTraceparent();

    reply.header('x-request-id', requestId);

    const startedAt = Date.now();
    // The ALS context must be entered when the Observable is SUBSCRIBED, not
    // when it is created: Nest subscribes to the interceptor chain only after
    // intercept() returns, so a run() here would already have closed and
    // handlers (e.g. FoundationService reading getRequestContext()) would run
    // without the request context.
    return new Observable<unknown>((subscriber) => {
      return runWithRequestContext({ requestId, traceparent }, () => {
        let span: Span | undefined;
        let otelContext = context.active();
        if (this.config.otel.enabled) {
          const carrier: Record<string, string> = { traceparent };
          const parentContext = propagation.extract(context.active(), carrier);
          span = this.tracer.startSpan('http.request', { kind: SpanKind.SERVER }, parentContext);
          otelContext = trace.setSpan(parentContext, span);
        }
        const finish = (): void => {
          span?.end();
          const durationMs = Date.now() - startedAt;
          this.logger.info(
            {
              event: 'http.request.completed',
              method: request.method,
              // Only the normalized route template (e.g. /v1/health/live) is
              // logged — the raw URL may carry a query string with tokens,
              // emails or other sensitive material, so it is NEVER logged.
              route: request.routeOptions.url ?? this.pathOnly(request.url),
              status_code: reply.statusCode,
              duration_ms: durationMs,
            },
            'request completed',
          );
        };
        return context.with(otelContext, () => {
          const subscription = next.handle().subscribe({
            next: (value) => subscriber.next(value),
            error: (error) => {
              finish();
              subscriber.error(error);
            },
            complete: () => {
              finish();
              subscriber.complete();
            },
          });
          return () => subscription.unsubscribe();
        });
      });
    });
  }

  private firstHeaderValue(value: string | string[] | undefined): string | undefined {
    if (value === undefined) {
      return undefined;
    }
    return Array.isArray(value) ? value[0] : value;
  }

  /** Path portion without the query string — fallback when no route template exists. */
  private pathOnly(rawUrl: string): string {
    const queryIndex = rawUrl.indexOf('?');
    return queryIndex === -1 ? rawUrl : rawUrl.slice(0, queryIndex);
  }
}
