import { describe, expect, it, vi } from 'vitest';
import { ValkeyCacheAdapter } from './adapters.js';

type Status = 'wait' | 'connecting' | 'ready' | 'end';
type Listener = (error?: unknown) => void;

/** Minimal ioredis stand-in: only the surface the adapter touches. */
class FakeRedisClient {
  status: Status = 'connecting';
  private readyListeners: Listener[] = [];
  private errorListeners: Listener[] = [];
  pingCalls: string[] = [];

  once(event: 'ready' | 'error', listener: Listener): void {
    if (event === 'ready') {
      this.readyListeners.push(listener);
    } else {
      this.errorListeners.push(listener);
    }
  }

  removeListener(event: 'ready' | 'error', listener: Listener): void {
    const list = event === 'ready' ? this.readyListeners : this.errorListeners;
    const index = list.indexOf(listener);
    if (index >= 0) {
      list.splice(index, 1);
    }
  }

  async ping(): Promise<string> {
    this.pingCalls.push(this.status);
    return 'PONG';
  }

  disconnect(): void {
    this.status = 'end';
  }

  emitReady(): void {
    this.status = 'ready';
    for (const listener of this.readyListeners.splice(0)) {
      listener();
    }
  }

  emitError(error: Error): void {
    for (const listener of this.errorListeners.splice(0)) {
      listener(error);
    }
  }
}

describe('ValkeyCacheAdapter.ping', () => {
  it('pings immediately when the client is already ready', async () => {
    const client = new FakeRedisClient();
    client.status = 'ready';
    const adapter = new ValkeyCacheAdapter(client);

    await expect(adapter.ping()).resolves.toBe(true);
    expect(client.pingCalls).toEqual(['ready']);
  });

  it('waits for ready instead of pinging a client that is still connecting', async () => {
    const client = new FakeRedisClient();
    const adapter = new ValkeyCacheAdapter(client);

    const pending = adapter.ping();
    await Promise.resolve(); // let the waitUntilReady listeners attach
    expect(client.pingCalls).toHaveLength(0); // no command while connecting

    client.emitReady();
    await expect(pending).resolves.toBe(true);
    expect(client.pingCalls).toEqual(['ready']);
  });

  it('rejects when the client errors while connecting', async () => {
    const client = new FakeRedisClient();
    const adapter = new ValkeyCacheAdapter(client);

    const pending = adapter.ping();
    await Promise.resolve();
    client.emitError(new Error('connection refused'));
    await expect(pending).rejects.toThrow('connection refused');
    expect(client.pingCalls).toHaveLength(0);
  });

  it('gives up after the bounded wait when ready never arrives', async () => {
    vi.useFakeTimers();
    try {
      const client = new FakeRedisClient();
      const adapter = new ValkeyCacheAdapter(client);

      const pending = adapter.ping();
      // Attach the rejection handler BEFORE advancing the clock — the
      // timeout fires during the advance and an unhandled rejection would
      // fail the whole test run.
      const assertion = expect(pending).rejects.toThrow('did not become ready within 5000ms');
      await vi.advanceTimersByTimeAsync(5000);
      await assertion;
      expect(client.pingCalls).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects immediately when the client is closed', async () => {
    const client = new FakeRedisClient();
    client.status = 'end';
    const adapter = new ValkeyCacheAdapter(client);

    await expect(adapter.ping()).rejects.toThrow('cache client is closed');
  });

  it('close disconnects the client', async () => {
    const client = new FakeRedisClient();
    const adapter = new ValkeyCacheAdapter(client);

    await adapter.close();
    expect(client.status).toBe('end');
  });
});
