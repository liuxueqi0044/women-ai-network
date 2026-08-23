import {
  ApiClientError,
  getHealthReady,
  makeRequestId,
  makeTraceparent,
  postFoundationTrace,
} from '../../src/lib/api-client';
import type { HealthReadyResponse } from '@wai/contracts';

export const dynamic = 'force-dynamic';

/**
 * Foundation health page: calls the API readiness endpoint and the
 * foundation trace endpoint with ONE shared Request ID / traceparent, so the
 * page itself demonstrates the Web → API → Queue → Worker correlation chain.
 * API failures render as an error panel — the page never crashes.
 */
interface PageData {
  requestId: string;
  traceId: string;
  ready: HealthReadyResponse | null;
  readyError: string | null;
  traceStatus: 'accepted' | 'failed' | null;
  eventId: string | null;
  acceptedAt: string | null;
  traceError: string | null;
}

async function loadData(): Promise<PageData> {
  const requestId = makeRequestId();
  const traceparent = makeTraceparent();
  const traceId = traceparent.split('-')[1] ?? '';

  let ready: HealthReadyResponse | null = null;
  let readyError: string | null = null;
  try {
    const result = await getHealthReady({ requestId, traceparent });
    ready = result.body;
  } catch (error) {
    readyError = describeError(error);
  }

  let traceStatus: PageData['traceStatus'] = null;
  let eventId: string | null = null;
  let acceptedAt: string | null = null;
  let traceError: string | null = null;
  try {
    const result = await postFoundationTrace({
      message: 'foundation health page smoke',
      requestId,
      traceparent,
    });
    traceStatus = 'accepted';
    eventId = result.body.event_id;
    acceptedAt = result.body.accepted_at;
  } catch (error) {
    traceStatus = 'failed';
    traceError = describeError(error);
  }

  return { requestId, traceId, ready, readyError, traceStatus, eventId, acceptedAt, traceError };
}

function describeError(error: unknown): string {
  if (error instanceof ApiClientError) {
    return `${error.status} ${error.envelope?.code ?? 'UNKNOWN'}: ${error.envelope?.message ?? error.message}`;
  }
  return error instanceof Error ? error.message : String(error);
}

function dependencyLabel(state: string): string {
  return state === 'up' ? '✅ up' : '❌ down';
}

export default async function HealthPage() {
  const data = await loadData();

  return (
    <main>
      <h1>Foundation health</h1>

      <h2>API readiness</h2>
      {data.ready !== null ? (
        <table>
          <tbody>
            <tr>
              <th>status</th>
              <td data-testid="ready-status">{data.ready.status}</td>
            </tr>
            <tr>
              <th>postgres</th>
              <td>{dependencyLabel(data.ready.checks.postgres)}</td>
            </tr>
            <tr>
              <th>valkey</th>
              <td>{dependencyLabel(data.ready.checks.valkey)}</td>
            </tr>
            <tr>
              <th>queue</th>
              <td>{dependencyLabel(data.ready.checks.queue)}</td>
            </tr>
            <tr>
              <th>checked at</th>
              <td>{data.ready.timestamp}</td>
            </tr>
          </tbody>
        </table>
      ) : (
        <p role="alert" data-testid="ready-error">
          API unreachable: {data.readyError}
        </p>
      )}

      <h2>Foundation trace</h2>
      {data.traceStatus === 'accepted' ? (
        <table>
          <tbody>
            <tr>
              <th>status</th>
              <td data-testid="trace-status">accepted</td>
            </tr>
            <tr>
              <th>event id</th>
              <td data-testid="event-id">{data.eventId}</td>
            </tr>
            <tr>
              <th>accepted at</th>
              <td>{data.acceptedAt}</td>
            </tr>
          </tbody>
        </table>
      ) : (
        <p role="alert" data-testid="trace-error">
          Trace failed: {data.traceError}
        </p>
      )}

      <h2>Correlation context</h2>
      <table>
        <tbody>
          <tr>
            <th>request id</th>
            <td data-testid="request-id">{data.requestId}</td>
          </tr>
          <tr>
            <th>trace id</th>
            <td data-testid="trace-id">{data.traceId}</td>
          </tr>
        </tbody>
      </table>

      <p>
        <a href="/">Back to foundation overview</a>
      </p>
    </main>
  );
}
