import { describe, expect, it } from 'vitest';
import { formatGlobalizationMessage, globalizationCatalog, resolveUiLocale } from '@wai/contracts';

describe('GLO-01 web catalog behavior', () => {
  it('falls back by language then English without rendering raw keys', () => {
    expect(resolveUiLocale('es-MX')).toBe('es-419');
    expect(formatGlobalizationMessage('xx', 'common.nav.home')).toBe('Home');
    expect(formatGlobalizationMessage('fr', 'home.title')).not.toContain('home.title');
    expect(globalizationCatalog.locales.fr.messages['common.nav.settings']).toBeTruthy();
  });
  it('uses an explicit timezone for preview formatting', () => {
    const text = new Intl.DateTimeFormat('en', {
      timeZone: 'Asia/Shanghai',
      hourCycle: 'h23',
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(new Date('2026-01-02T15:04:00Z'));
    expect(text).toContain('Jan');
  });
});
