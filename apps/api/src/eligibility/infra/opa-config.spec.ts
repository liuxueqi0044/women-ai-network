import { describe, expect, it } from 'vitest';
import { loadOpaConfig } from './opa-config.js';

describe('loadOpaConfig', () => {
  it('defaults to the loopback dev engine with a 3s timeout', () => {
    const config = loadOpaConfig({ NODE_ENV: 'test' });
    expect(config).toEqual({ baseUrl: 'http://127.0.0.1:8181', queryTimeoutMs: 3000 });
  });

  it('accepts explicit overrides', () => {
    const config = loadOpaConfig({
      NODE_ENV: 'test',
      ELG_OPA_URL: 'http://127.0.0.1:9191',
      ELG_OPA_QUERY_TIMEOUT_MS: '500',
    });
    expect(config).toEqual({ baseUrl: 'http://127.0.0.1:9191', queryTimeoutMs: 500 });
  });

  it('rejects a non-URL ELG_OPA_URL', () => {
    expect(() => loadOpaConfig({ NODE_ENV: 'test', ELG_OPA_URL: 'not a url' })).toThrow();
  });

  it('rejects a non-positive timeout', () => {
    expect(() => loadOpaConfig({ NODE_ENV: 'test', ELG_OPA_QUERY_TIMEOUT_MS: '0' })).toThrow();
  });

  it('rejects the development default URL in production', () => {
    expect(() => loadOpaConfig({ NODE_ENV: 'production' })).toThrow(
      /must not use the development OPA URL/,
    );
  });

  it('accepts an explicit URL in production', () => {
    const config = loadOpaConfig({
      NODE_ENV: 'production',
      ELG_OPA_URL: 'http://opa.internal:8181',
    });
    expect(config.baseUrl).toBe('http://opa.internal:8181');
  });
});
