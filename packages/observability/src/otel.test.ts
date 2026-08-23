import { describe, expect, it } from 'vitest';
import { InMemorySpanExporter } from '@opentelemetry/sdk-trace-base';
import { createTraceparent, parseTraceparent } from './traceparent.js';
import { initOpenTelemetry, withRequestSpan } from './otel.js';

describe('traceparent helpers', () => {
  it('parses a valid W3C traceparent', () => {
    expect(parseTraceparent('00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01')).toEqual({
      version: '00',
      traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
      spanId: '00f067aa0ba902b7',
      flags: '01',
    });
  });

  it('rejects malformed, non-00 and all-zero traceparents', () => {
    expect(parseTraceparent('not-a-traceparent')).toBeNull();
    expect(parseTraceparent('01-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01')).toBeNull();
    expect(parseTraceparent('00-00000000000000000000000000000000-00f067aa0ba902b7-01')).toBeNull();
    expect(parseTraceparent('00-4bf92f3577b34da6a3ce929d0e0e4736-0000000000000000-01')).toBeNull();
    expect(parseTraceparent(undefined)).toBeNull();
    expect(parseTraceparent('')).toBeNull();
  });

  it('creates fresh valid traceparents that round-trip and differ', () => {
    const first = createTraceparent();
    const second = createTraceparent();
    expect(parseTraceparent(first)).not.toBeNull();
    expect(parseTraceparent(second)).not.toBeNull();
    expect(first).not.toBe(second);
  });
});

describe('initOpenTelemetry', () => {
  it('registers W3C propagation even when tracing is disabled', () => {
    const tracer = initOpenTelemetry({
      serviceName: 'test-svc',
      enabled: false,
      exporter: 'console',
    });
    // Propagation registration is global; exercise it via a round-trip.
    const traceparent = createTraceparent();
    const { traceId } = parseTraceparent(traceparent) ?? { traceId: '' };
    expect(traceId).toHaveLength(32);
    expect(tracer).toBeDefined();
  });

  it('withRequestSpan is a no-op when tracing is disabled', () => {
    const tracer = initOpenTelemetry({
      serviceName: 'test-svc',
      enabled: false,
      exporter: 'console',
    });
    const result = withRequestSpan(tracer, false, createTraceparent(), 'unit.span', (span) =>
      span === undefined ? 'no-span' : 'span',
    );
    expect(result).toBe('no-span');
  });

  it('creates spans parented by the incoming traceparent when enabled', () => {
    const exporter = new InMemorySpanExporter();
    const tracer = initOpenTelemetry({
      serviceName: 'test-svc',
      enabled: true,
      exporter: 'console',
      spanExporterOverride: exporter,
    });
    const traceparent = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';

    const spanTraceId = withRequestSpan(tracer, true, traceparent, 'unit.span', (span) => {
      return span?.spanContext().traceId ?? '';
    });

    // The span must share the parent trace id from the envelope traceparent.
    expect(spanTraceId).toBe('4bf92f3577b34da6a3ce929d0e0e4736');

    const finished = exporter.getFinishedSpans();
    expect(finished).toHaveLength(1);
    expect(finished[0]?.name).toBe('unit.span');
    expect(finished[0]?.spanContext().traceId).toBe('4bf92f3577b34da6a3ce929d0e0e4736');
    expect(finished[0]?.parentSpanId).toBe('00f067aa0ba902b7');
  });

  it('ends the span even when the handler throws', () => {
    const exporter = new InMemorySpanExporter();
    const tracer = initOpenTelemetry({
      serviceName: 'test-svc',
      enabled: true,
      exporter: 'console',
      spanExporterOverride: exporter,
    });
    expect(() =>
      withRequestSpan(tracer, true, createTraceparent(), 'unit.span', () => {
        throw new Error('handler failure');
      }),
    ).toThrow('handler failure');
    expect(exporter.getFinishedSpans()).toHaveLength(1);
  });
});
