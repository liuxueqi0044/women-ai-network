import { describe, expect, it } from 'vitest';
import { getWebApiBaseUrl } from './web-api-base.js';

describe('web API base contract', () => {
  it('uses a single versioned base and removes only trailing slashes', () => {
    expect(getWebApiBaseUrl({ NEXT_PUBLIC_API_BASE_URL: 'https://api.example.test/v1/' })).toBe(
      'https://api.example.test/v1',
    );
  });

  it('rejects an origin or an unversioned path instead of guessing', () => {
    expect(() =>
      getWebApiBaseUrl({ NEXT_PUBLIC_API_BASE_URL: 'https://api.example.test' }),
    ).toThrow(/versioned \/v1 base/);
    expect(() =>
      getWebApiBaseUrl({ NEXT_PUBLIC_API_BASE_URL: 'https://api.example.test/v2' }),
    ).toThrow(/versioned \/v1 base/);
  });
});
