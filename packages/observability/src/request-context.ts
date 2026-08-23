import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Per-request context shared between the HTTP boundary and the logger.
 * The API middleware populates it from headers; the Worker populates it
 * from the job envelope — so both produce logs with the same
 * request_id/trace_id without threading parameters manually.
 */
export interface RequestContextStore {
  requestId: string;
  /** W3C traceparent propagated across the Web → API → Queue → Worker flow. */
  traceparent?: string;
}

const storage = new AsyncLocalStorage<RequestContextStore>();

export function runWithRequestContext<T>(store: RequestContextStore, fn: () => T): T {
  return storage.run(store, fn);
}

export function getRequestContext(): RequestContextStore | undefined {
  return storage.getStore();
}

export function createRequestContextStore(
  requestId: string,
  traceparent?: string,
): RequestContextStore {
  return traceparent === undefined ? { requestId } : { requestId, traceparent };
}
