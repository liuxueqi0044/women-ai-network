import { context, propagation, trace, SpanKind, type Span, type Tracer } from '@opentelemetry/api';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import {
  BasicTracerProvider,
  ConsoleSpanExporter,
  SimpleSpanProcessor,
  type SpanExporter,
} from '@opentelemetry/sdk-trace-base';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';

/**
 * OpenTelemetry initialization.
 *
 * - W3C trace context propagation is always registered (cheap, and required
 *   for the smoke-flow traceparent plumbing).
 * - Span exporting is opt-in: a console exporter for local debugging, or an
 *   OTLP HTTP exporter that is ONLY active when explicitly configured
 *   (never in local/test runs).
 */
export interface OpenTelemetryInitOptions {
  serviceName: string;
  enabled: boolean;
  exporter: 'console' | 'otlp';
  otlpEndpoint?: string;
  /** Test hook: replaces the exporter without registering the global SDK noise. */
  spanExporterOverride?: SpanExporter;
}

let tracer: Tracer | undefined;
let provider: BasicTracerProvider | undefined;

export function initOpenTelemetry(options: OpenTelemetryInitOptions): Tracer {
  // Propagation is idempotent and required regardless of span exporting.
  propagation.setGlobalPropagator(new W3CTraceContextPropagator());

  if (tracer === undefined) {
    tracer = trace.getTracer(options.serviceName);
  }

  if (!options.enabled) {
    return tracer;
  }

  // The OTel API allows setting the global tracer provider only ONCE per
  // process — a second register() is silently ignored. Create and register
  // the provider once, then attach one span processor per exporter so
  // repeated init calls (e.g. tests with fresh exporters) all observe spans.
  if (provider === undefined) {
    provider = new BasicTracerProvider();
    provider.register();
  }

  let exporter: SpanExporter;
  if (options.spanExporterOverride !== undefined) {
    exporter = options.spanExporterOverride;
  } else if (options.exporter === 'otlp') {
    exporter =
      options.otlpEndpoint === undefined
        ? new OTLPTraceExporter()
        : new OTLPTraceExporter({ url: options.otlpEndpoint });
  } else {
    exporter = new ConsoleSpanExporter();
  }
  provider.addSpanProcessor(new SimpleSpanProcessor(exporter));
  // Re-fetch so the tracer is backed by the registered provider.
  tracer = trace.getTracer(options.serviceName);
  return tracer;
}

/**
 * Runs `fn` with an active SERVER span parented by `traceparent` (when the
 * SDK is enabled). The span is always ended, even if `fn` throws.
 */
export function withRequestSpan<T>(
  tracer: Tracer,
  otelEnabled: boolean,
  traceparent: string | undefined,
  spanName: string,
  fn: (span: Span | undefined) => T,
): T {
  if (!otelEnabled) {
    return fn(undefined);
  }
  const carrier: Record<string, string> = traceparent === undefined ? {} : { traceparent };
  const parentContext =
    traceparent === undefined ? context.active() : propagation.extract(context.active(), carrier);
  const span = tracer.startSpan(spanName, { kind: SpanKind.SERVER }, parentContext);
  const ctxWithSpan = trace.setSpan(parentContext, span);
  try {
    return context.with(ctxWithSpan, () => fn(span));
  } finally {
    span.end();
  }
}
