'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { resolveUiLocale, type GlobalizationUiLocale } from '@wai/contracts';

const STORAGE_KEY = 'wai.ui_locale';
const EVENT_NAME = 'wai-globalization-locale';
type Listener = (locale: GlobalizationUiLocale) => void;

export class GlobalizationLocaleStore {
  private locale: GlobalizationUiLocale;
  private readonly listeners = new Set<Listener>();
  constructor(initial: string = 'en') {
    this.locale = resolveUiLocale(initial);
  }
  getLocale(): GlobalizationUiLocale {
    return this.locale;
  }
  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  setLocale(next: string): void {
    this.locale = resolveUiLocale(next);
    for (const listener of this.listeners) listener(this.locale);
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(STORAGE_KEY, this.locale);
      window.dispatchEvent(new CustomEvent(EVENT_NAME, { detail: this.locale }));
    }
  }
}

const LocaleContext = createContext<{
  locale: GlobalizationUiLocale;
  /** Commits a server-authoritative locale and updates the cross-tab cache. */
  commitLocale: (locale: string) => void;
  /** Backwards-compatible alias for non-settings callers. */
  setLocale: (locale: string) => void;
} | null>(null);

export function GlobalizationProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<GlobalizationUiLocale>('en');
  const store = useMemo(() => new GlobalizationLocaleStore('en'), []);
  useEffect(() => {
    const unsubscribe = store.subscribe(setLocaleState);
    const cached = window.localStorage.getItem(STORAGE_KEY);
    if (cached) store.setLocale(cached);
    const onStorage = (event: StorageEvent) => {
      if (event.key === STORAGE_KEY && event.newValue) store.setLocale(event.newValue);
    };
    const onCustom = (event: Event) => {
      const value = (event as CustomEvent<string>).detail;
      if (value) setLocaleState(resolveUiLocale(value));
    };
    window.addEventListener('storage', onStorage);
    window.addEventListener(EVENT_NAME, onCustom);
    return () => {
      unsubscribe();
      window.removeEventListener('storage', onStorage);
      window.removeEventListener(EVENT_NAME, onCustom);
    };
  }, [store]);
  useEffect(() => {
    document.documentElement.lang = locale;
    document.documentElement.dir = 'ltr';
  }, [locale]);
  const commitLocale = useCallback((next: string) => store.setLocale(next), [store]);
  return (
    <LocaleContext.Provider value={{ locale, commitLocale, setLocale: commitLocale }}>
      {children}
    </LocaleContext.Provider>
  );
}

export function useGlobalization() {
  const context = useContext(LocaleContext);
  if (context === null)
    throw new Error('useGlobalization must be used inside GlobalizationProvider');
  return context;
}
