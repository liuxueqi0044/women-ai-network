import { describe, expect, it } from 'vitest';
import { GlobalizationLocaleStore } from './globalization-store.js';

describe('shared SPA locale store', () => {
  it('updates subscribers and document language without reload', () => {
    const store = new GlobalizationLocaleStore('en');
    const observed: string[] = [];
    const unsubscribe = store.subscribe((locale) => observed.push(locale));
    store.setLocale('fr');
    expect(observed).toEqual(['fr']);
    unsubscribe();
  });
});
