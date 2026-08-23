import { describe, expect, it } from 'vitest';
import {
  letterCreateRequestSchema,
  letterPublicationSchema,
  letterRevisionSchema,
} from '../../src/letters/index.js';

describe('LTR-01 letter contracts', () => {
  it('rejects arbitrary HTML and unknown fields', () => {
    expect(() =>
      letterCreateRequestSchema.parse({
        kind: 'public_letter',
        title: '<script>alert(1)</script>',
        body: { paragraphs: ['hello'] },
        locale: 'en-US',
        country_code: 'US',
        topics: ['friendship'],
        content_reminder: 'none',
        extra: true,
      }),
    ).toThrow();
  });

  it('requires content-locale grammar, ISO country and closed topics', () => {
    expect(() =>
      letterCreateRequestSchema.parse({
        kind: 'public_letter',
        title: 'Hello',
        body: { paragraphs: ['hello'] },
        locale: 'en-us',
        country_code: 'usa',
        topics: ['unknown-topic'],
        content_reminder: 'none',
      }),
    ).toThrow();
  });

  it('supports only the canonical-casing content-locale subset', () => {
    for (const locale of [
      'fr',
      'en-US',
      'zh-Hans-CN',
      'sr-Latn-RS',
      'es-419',
      'iw',
      'iw-IL',
      'in-ID',
      'ji',
      'en-BU',
      'sh',
      'mo',
    ]) {
      expect(
        letterCreateRequestSchema.parse({
          kind: 'public_letter',
          title: 'Hello',
          body: { paragraphs: ['hello'] },
          pen_name: 'Aurora',
          locale,
          country_code: 'US',
          topics: ['friendship'],
          content_reminder: 'none',
        }).locale,
      ).toBe(locale);
    }
    for (const locale of [
      'en-us',
      'EN-US',
      'en_US',
      'en-u-ca-gregory',
      'en-x-private',
      'en-x-private-Latn',
      'en-US-Latn',
      'en-1901-1901',
      'en-a-aaa-a-bbb',
      'en-u-ca-gregory-a-aaa',
    ]) {
      expect(() =>
        letterCreateRequestSchema.parse({
          kind: 'public_letter',
          title: 'Hello',
          body: { paragraphs: ['hello'] },
          pen_name: 'Aurora',
          locale,
          country_code: 'US',
          topics: ['friendship'],
          content_reminder: 'none',
        }),
      ).toThrow();
    }
  });

  it('keeps revisions encrypted and publications member-safe', () => {
    expect(
      letterRevisionSchema.parse({
        id: '11111111-1111-4111-8111-111111111111',
        revision: 1,
        source_hash: 'a'.repeat(64),
        key_id: 'letters-v1',
        ciphertext: 'ciphertext',
        nonce: 'nonce',
      }),
    ).toHaveProperty('revision', 1);
    expect(
      letterPublicationSchema.parse({
        id: '11111111-1111-4111-8111-111111111111',
        pen_name: 'Aurora',
        country_code: 'US',
        locale: 'en-US',
        topics: ['friendship'],
        content_reminder: 'none',
        revision: 1,
        title: 'Hello',
        body: { paragraphs: ['World'] },
      }),
    ).not.toHaveProperty('account_id');
  });

  it('enforces the server-side 20000-character and 100-paragraph body limits', () => {
    const base = {
      kind: 'private_letter' as const,
      title: 'Hello',
      locale: 'en-US',
      country_code: 'US',
      topics: ['friendship' as const],
      content_reminder: 'none' as const,
      pen_name: 'Aurora',
    };
    expect(() =>
      letterCreateRequestSchema.parse({ ...base, body: { paragraphs: ['x'.repeat(20_001)] } }),
    ).toThrow();
    expect(() =>
      letterCreateRequestSchema.parse({
        ...base,
        body: { paragraphs: Array.from({ length: 101 }, () => 'x') },
      }),
    ).toThrow();
    const accepted = letterCreateRequestSchema.parse({
      ...base,
      body: { paragraphs: Array.from({ length: 10 }, () => 'x'.repeat(2_000)) },
    });
    expect(accepted.body.paragraphs).toHaveLength(10);
  });
});
