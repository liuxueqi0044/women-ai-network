import { describe, expect, it } from 'vitest';

import { acceptsWorldGeneration, focusTrapTarget, worldLetterDisplay } from '../app/world/page';

describe('world response ordering and drawer keyboard behavior', () => {
  it('ignores delayed responses from an older request generation', () => {
    expect(acceptsWorldGeneration(4, 5)).toBe(false);
    expect(acceptsWorldGeneration(5, 5)).toBe(true);
  });

  it('wraps focus at both drawer boundaries for Tab and Shift+Tab', () => {
    expect(focusTrapTarget(2, 3, false)).toBe(0);
    expect(focusTrapTarget(0, 3, true)).toBe(2);
    expect(focusTrapTarget(1, 3, false)).toBe(2);
    expect(focusTrapTarget(1, 3, true)).toBe(0);
    expect(focusTrapTarget(0, 0, false)).toBe(-1);
  });

  it('switches title and body together and falls back to original text', () => {
    const original = { title: 'French source', body: { paragraphs: ['French body'] } };
    const french = {
      title: 'French translation',
      body: { paragraphs: ['French translated body'] },
      target_locale: 'fr-FR',
    };
    const spanishFallback = {
      title: 'Spanish source',
      body: { paragraphs: ['Spanish source body'] },
      target_locale: 'es-ES',
    };
    expect(worldLetterDisplay(original, french, true)).toEqual(french);
    expect(worldLetterDisplay(original, spanishFallback, false)).toEqual(original);
    expect(worldLetterDisplay(original, null, true)).toEqual(original);
  });
});
