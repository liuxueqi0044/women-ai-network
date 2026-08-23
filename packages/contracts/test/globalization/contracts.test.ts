import { describe, expect, it } from 'vitest';
import {
  globalizationCatalogSchema,
  globalizationCatalog,
  globalizationPreferencesRequestSchema,
  globalizationUiLocaleSchema,
  formatGlobalizationMessage,
  resolveUiLocale,
} from '../../src/globalization/index.js';

describe('GLO-01 contracts', () => {
  it('accepts only the closed v1 UI catalog', () => {
    expect(globalizationUiLocaleSchema.parse('zh-Hans-CN')).toBe('zh-Hans-CN');
    expect(() => globalizationUiLocaleSchema.parse('de')).toThrow();
  });

  it('normalizes bounded content locales and explicit display settings', () => {
    const parsed = globalizationPreferencesRequestSchema.parse({
      ui_locale: 'en',
      content_locales: ['fr', 'en', 'fr'],
      time_zone: 'UTC',
      hour_cycle: 'h23',
      week_start: 1,
    });
    expect(parsed.content_locales).toEqual(['fr', 'en']);
  });

  it('has deterministic fallback and complete catalog shape', () => {
    expect(resolveUiLocale('es-MX')).toBe('es-419');
    expect(resolveUiLocale('xx')).toBe('en');
    expect(() => globalizationCatalogSchema.parse({ version: 1, locales: {} })).toThrow();
    expect(() => globalizationCatalogSchema.parse({ version: 1, locales: { en: {} } })).toThrow();
    const malformed = structuredClone(globalizationCatalog);
    malformed.locales.en.messages['home.title'] = '';
    expect(() => globalizationCatalogSchema.parse(malformed)).toThrow();
  });

  it('interpolates values as plain text and keeps HTML out of message markup', () => {
    expect(formatGlobalizationMessage('en', 'home.greeting', { name: '<member>' })).toBe(
      'Welcome, <member>',
    );
  });
});
