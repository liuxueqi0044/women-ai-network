'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import {
  translationFallbackResponseSchema,
  translationReadResponseSchema,
  worldDiscoveryResponseSchema,
  worldLetterSchema,
} from '@wai/contracts';
import { formatGlobalizationMessage } from '@wai/contracts';
import { useGlobalization } from '../../src/globalization-store';
import { getWebApiBaseUrl } from '../../src/lib/web-api-base';
import { MobileIcon } from '../../src/components/mobile-icon';
import type { z } from 'zod';

const API = getWebApiBaseUrl();
const topics = [
  'life_story',
  'family',
  'relationships',
  'migration',
  'values_beliefs',
  'work',
  'friendship',
  'culture',
  'education',
  'language_learning',
  'professional',
  'travel',
  'nature',
  'wellbeing',
  'technology',
];
type Letter = {
  publication_id: string;
  letter_id: string;
  pen_name: string;
  country_code: string;
  locale: string;
  topics: string[];
  content_reminder: string;
  revision: number;
  title: string;
  body: { paragraphs: string[] };
  published_at: string;
  bookmarked: boolean;
};
type Translation = {
  title: string;
  body: { paragraphs: string[] };
  target_locale: string;
};
type TranslationResponse =
  | z.infer<typeof translationReadResponseSchema>
  | z.infer<typeof translationFallbackResponseSchema>;

const previewPublishedLetter: Letter = {
  publication_id: '00000000-0000-4000-8000-000000000051',
  letter_id: '00000000-0000-4000-8000-000000000052',
  pen_name: '林小满',
  country_code: 'CN',
  locale: 'zh-Hans-CN',
  topics: ['life_story', 'culture', 'friendship'],
  content_reminder: 'none',
  revision: 1,
  title: '写给世界：成都清晨的第一束光',
  body: {
    paragraphs: [
      '今天早晨，我沿着府河散步。卖花的人刚刚摆好摊位，空气里有雨后的潮湿味道。我想把这个平凡的清晨写下来，送给正在世界另一端生活的你。',
      '也许我们的语言和日常都不相同，但我们都曾在某个安静的时刻，认真想象过另一种生活。',
    ],
  },
  published_at: '2026-08-21T10:30:00.000Z',
  bookmarked: false,
};

export function acceptsWorldGeneration(
  requestGeneration: number,
  currentGeneration: number,
): boolean {
  return requestGeneration === currentGeneration;
}

export function focusTrapTarget(currentIndex: number, count: number, backwards: boolean): number {
  if (count <= 0) return -1;
  if (backwards) return currentIndex <= 0 ? count - 1 : currentIndex - 1;
  return currentIndex >= count - 1 ? 0 : currentIndex + 1;
}

export function worldLetterDisplay(
  original: Pick<Letter, 'title' | 'body'>,
  translated: Translation | null,
  showTranslated: boolean,
): Pick<Letter, 'title' | 'body'> {
  return showTranslated && translated !== null ? translated : original;
}

export default function WorldPage() {
  const { locale: uiLocale } = useGlobalization();
  const [items, setItems] = useState<Letter[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [country, setCountry] = useState('');
  const [locale, setLocale] = useState('');
  const [topic, setTopic] = useState('');
  const [q, setQ] = useState('');
  const [selected, setSelected] = useState<Letter | null>(null);
  const [busy, setBusy] = useState(false);
  const [detailBusy, setDetailBusy] = useState(false);
  const [translation, setTranslation] = useState<Translation | null>(null);
  const [translationLocale, setTranslationLocale] = useState('fr-FR');
  const [showTranslation, setShowTranslation] = useState(false);
  const [translationBusy, setTranslationBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [mobileCategory, setMobileCategory] = useState<'all' | 'life' | 'letters'>('all');
  const [bookmarkBusy, setBookmarkBusy] = useState<Set<string>>(() => new Set());
  const lastTrigger = useRef<HTMLButtonElement | null>(null);
  const closeButton = useRef<HTMLButtonElement | null>(null);
  const drawer = useRef<HTMLElement | null>(null);
  const feedAbort = useRef<AbortController | null>(null);
  const detailAbort = useRef<AbortController | null>(null);
  const translationAbort = useRef<AbortController | null>(null);
  const feedGeneration = useRef(0);
  const detailGeneration = useRef(0);
  const translationGeneration = useRef(0);
  const query = useMemo(() => {
    const params = new URLSearchParams({ limit: '12' });
    if (country) params.set('country', country);
    if (locale) params.set('locale', locale);
    if (topic) params.set('topic', topic);
    if (q.trim()) params.set('q', q.trim());
    if (cursor) params.set('cursor', cursor);
    return params.toString();
  }, [country, locale, topic, q, cursor]);
  async function load(reset = false) {
    const preview =
      typeof window !== 'undefined' &&
      new URLSearchParams(window.location.search).get('preview') === 'letter-published';
    if (preview) {
      setItems([previewPublishedLetter]);
      setCursor(null);
      setBusy(false);
      setNotice('公开信已发布 · 仅用于手机端视觉预览');
      return;
    }
    const generation = feedGeneration.current + 1;
    feedGeneration.current = generation;
    feedAbort.current?.abort();
    const controller = new AbortController();
    feedAbort.current = controller;
    setBusy(true);
    setNotice('');
    try {
      const requestQuery = reset ? query.replace(/&cursor=[^&]+/, '') : query;
      const response = await fetch(`${API}/world/letters?${requestQuery}`, {
        credentials: 'include',
        signal: controller.signal,
      });
      if (!response.ok) throw new Error('The world desk is unavailable right now.');
      const data = worldDiscoveryResponseSchema.parse(await response.json());
      if (!acceptsWorldGeneration(generation, feedGeneration.current)) return;
      setItems((current) => (reset ? data.items : [...current, ...data.items]));
      setCursor(data.next_cursor);
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return;
      if (!acceptsWorldGeneration(generation, feedGeneration.current)) return;
      setNotice(
        error instanceof Error ? error.message : 'The world desk is unavailable right now.',
      );
    } finally {
      if (acceptsWorldGeneration(generation, feedGeneration.current)) setBusy(false);
    }
  }
  useEffect(() => {
    void load(true);
  }, [country, locale, topic]);
  useEffect(() => {
    if (!selected) return;
    closeButton.current?.focus();
  }, [selected]);
  useEffect(
    () => () => {
      feedAbort.current?.abort();
      detailAbort.current?.abort();
      translationAbort.current?.abort();
      feedGeneration.current += 1;
      detailGeneration.current += 1;
      translationGeneration.current += 1;
    },
    [],
  );
  function closeDetail() {
    detailAbort.current?.abort();
    translationAbort.current?.abort();
    detailGeneration.current += 1;
    translationGeneration.current += 1;
    setSelected(null);
    setTranslation(null);
    setShowTranslation(false);
    setDetailBusy(false);
    setTranslationBusy(false);
    lastTrigger.current?.focus();
  }
  async function openDetail(item: Letter, trigger: HTMLButtonElement) {
    detailAbort.current?.abort();
    translationAbort.current?.abort();
    const generation = detailGeneration.current + 1;
    detailGeneration.current = generation;
    lastTrigger.current = trigger;
    setSelected(null);
    setTranslation(null);
    setShowTranslation(false);
    setDetailBusy(true);
    setNotice('');
    if (item.publication_id === previewPublishedLetter.publication_id) {
      setSelected(item);
      setDetailBusy(false);
      return;
    }
    const controller = new AbortController();
    detailAbort.current = controller;
    try {
      const response = await fetch(`${API}/world/letters/${item.publication_id}`, {
        credentials: 'include',
        signal: controller.signal,
      });
      if (!response.ok) throw new Error('This letter is no longer available.');
      const data = worldLetterSchema.parse(await response.json());
      if (!acceptsWorldGeneration(generation, detailGeneration.current)) return;
      setSelected(data);
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return;
      if (!acceptsWorldGeneration(generation, detailGeneration.current)) return;
      setSelected(null);
      setNotice(error instanceof Error ? error.message : 'This letter is no longer available.');
    } finally {
      if (acceptsWorldGeneration(generation, detailGeneration.current)) setDetailBusy(false);
    }
  }
  async function bookmark(item: Letter) {
    if (bookmarkBusy.has(item.publication_id)) return;
    if (item.publication_id === previewPublishedLetter.publication_id) {
      setItems((all) =>
        all.map((value) =>
          value.publication_id === item.publication_id
            ? { ...value, bookmarked: !value.bookmarked }
            : value,
        ),
      );
      setNotice(item.bookmarked ? '已取消收藏 · 演示状态' : '已收藏 · 演示状态');
      return;
    }
    const method = item.bookmarked ? 'DELETE' : 'PUT';
    setBookmarkBusy((current) => new Set(current).add(item.publication_id));
    setItems((all) =>
      all.map((value) =>
        value.publication_id === item.publication_id
          ? { ...value, bookmarked: !value.bookmarked }
          : value,
      ),
    );
    const idempotencyKey =
      method === 'PUT' ? `world-${item.publication_id}-${crypto.randomUUID()}` : null;
    try {
      let response: Response | null = null;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        response = await fetch(`${API}/world/letters/${item.publication_id}/bookmark`, {
          method,
          credentials: 'include',
          ...(idempotencyKey ? { headers: { 'Idempotency-Key': idempotencyKey } } : {}),
        });
        if (response.ok || attempt === 1) break;
      }
      if (response === null || !response.ok) throw new Error();
    } catch {
      setItems((all) =>
        all.map((value) =>
          value.publication_id === item.publication_id
            ? { ...value, bookmarked: item.bookmarked }
            : value,
        ),
      );
      setNotice('That bookmark could not be saved.');
    } finally {
      setBookmarkBusy((current) => {
        const next = new Set(current);
        next.delete(item.publication_id);
        return next;
      });
    }
  }
  async function requestTranslation() {
    const letter = selected;
    if (letter === null || translationBusy || translationLocale === letter.locale) return;
    translationAbort.current?.abort();
    const generation = translationGeneration.current + 1;
    translationGeneration.current = generation;
    const controller = new AbortController();
    translationAbort.current = controller;
    const key = `world-translation-${crypto.randomUUID()}`;
    setTranslation(null);
    setShowTranslation(false);
    setTranslationBusy(true);
    setNotice('');
    const request = async (
      path: string,
      init: RequestInit,
      idempotencyKey?: string,
    ): Promise<TranslationResponse> => {
      let response: Response | null = null;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        response = await fetch(`${API}${path}`, {
          ...init,
          credentials: 'include',
          signal: controller.signal,
          headers: {
            ...(init.headers ?? {}),
            ...(idempotencyKey === undefined ? {} : { 'Idempotency-Key': idempotencyKey }),
          },
        });
        if (response.ok || attempt === 1) break;
      }
      if (response === null || !response.ok) throw new Error('Translation unavailable.');
      const payload: unknown = await response.json();
      if (typeof payload !== 'object' || payload === null || !('machine_translated' in payload))
        throw new Error('Translation response is invalid.');
      return payload.machine_translated === true
        ? translationReadResponseSchema.parse(payload)
        : translationFallbackResponseSchema.parse(payload);
    };
    const wait = () =>
      new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, 900);
        controller.signal.addEventListener(
          'abort',
          () => {
            clearTimeout(timer);
            reject(new DOMException('translation cancelled', 'AbortError'));
          },
          { once: true },
        );
      });
    try {
      let latest = await request(
        `/letters/${letter.letter_id}/translations`,
        {
          method: 'POST',
          body: JSON.stringify({ target_locale: translationLocale }),
          headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        },
        key,
      );
      if (!latest.machine_translated && latest.original !== undefined) {
        if (acceptsWorldGeneration(generation, translationGeneration.current))
          setNotice('Translation is unavailable; the original remains visible.');
        return;
      }
      for (
        let attempt = 0;
        attempt < 6 &&
        (!('result' in latest) || latest.result === null || latest.result === undefined);
        attempt += 1
      ) {
        await wait();
        latest = await request(
          `/letters/${letter.letter_id}/translations/${encodeURIComponent(translationLocale)}`,
          { method: 'GET' },
        );
      }
      if (!acceptsWorldGeneration(generation, translationGeneration.current)) return;
      const ready = latest.machine_translated === true ? latest : null;
      if (ready === null) {
        setNotice('Translation unavailable; the original remains visible.');
        return;
      }
      if (ready.result !== null && ready.result !== undefined) {
        setTranslation(ready.result);
        setShowTranslation(true);
        setNotice('Machine translated result loaded.');
      } else {
        setNotice('Translation is pending or unavailable; the original remains visible.');
      }
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return;
      if (acceptsWorldGeneration(generation, translationGeneration.current))
        setNotice('Translation unavailable; the original remains visible.');
    } finally {
      if (acceptsWorldGeneration(generation, translationGeneration.current))
        setTranslationBusy(false);
      if (translationAbort.current === controller) translationAbort.current = null;
    }
  }
  function trapDrawerKey(event: KeyboardEvent<HTMLElement>) {
    if (event.key === 'Escape') {
      event.preventDefault();
      closeDetail();
      return;
    }
    if (event.key !== 'Tab' || drawer.current === null) return;
    const focusable = Array.from(
      drawer.current.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ),
    );
    if (focusable.length === 0) return;
    const activeElement = document.activeElement;
    const activeIndex =
      activeElement instanceof HTMLElement ? focusable.indexOf(activeElement) : -1;
    const wrapsAtBoundary = event.shiftKey
      ? activeIndex === 0
      : activeIndex === focusable.length - 1;
    if (wrapsAtBoundary) {
      event.preventDefault();
      focusable[focusTrapTarget(activeIndex, focusable.length, event.shiftKey)]?.focus();
    }
  }
  return (
    <main className="world-shell" aria-busy={busy || detailBusy}>
      <section className="mobile-experience mobile-primary-screen mobile-world-screen">
        <header className="mobile-editorial-header">
          <div>
            <p>LETTERS · LIVES · PLACES</p>
            <h1>{formatGlobalizationMessage(uiLocale, 'common.nav.world')}</h1>
          </div>
          <div className="mobile-header-actions">
            <button
              className="mobile-header-icon"
              type="button"
              aria-label={formatGlobalizationMessage(uiLocale, 'world.search')}
              aria-expanded={filtersOpen}
              aria-controls="mobile-world-letter-filters"
              onClick={() => setFiltersOpen((current) => !current)}
            >
              <MobileIcon name="search" />
            </button>
            <a className="mobile-header-icon" href="/letters" aria-label="Write a public letter">
              <MobileIcon name="compose" />
            </a>
          </div>
        </header>

        <div className="mobile-world-tabs" role="tablist" aria-label="World content">
          {(
            [
              ['all', uiLocale === 'zh-Hans-CN' ? '全部' : 'All'],
              ['life', uiLocale === 'zh-Hans-CN' ? '生活' : 'Life'],
              ['letters', uiLocale === 'zh-Hans-CN' ? '公开信' : 'Public letters'],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              role="tab"
              aria-selected={mobileCategory === value}
              className={mobileCategory === value ? 'is-active' : undefined}
              onClick={() => {
                setMobileCategory(value);
                setTopic(value === 'life' ? 'life_story' : '');
                setCursor(null);
              }}
            >
              {label}
            </button>
          ))}
        </div>

        <div className="mobile-world-intro">
          <p>{formatGlobalizationMessage(uiLocale, 'world.description')}</p>
          <button
            type="button"
            aria-expanded={filtersOpen}
            aria-controls="mobile-world-letter-filters"
            onClick={() => setFiltersOpen((current) => !current)}
          >
            <svg aria-hidden="true" viewBox="0 0 24 24">
              <path d="M4 7h16M7 12h10M10 17h4" />
            </svg>
            {formatGlobalizationMessage(uiLocale, 'world.filters')}
          </button>
        </div>

        <nav
          className="mobile-topic-rail"
          aria-label={formatGlobalizationMessage(uiLocale, 'world.theme')}
        >
          <button
            type="button"
            className={topic === '' ? 'is-active' : undefined}
            onClick={() => {
              setTopic('');
              setCursor(null);
            }}
          >
            {formatGlobalizationMessage(uiLocale, 'world.allThemes')}
          </button>
          {topics.slice(0, 6).map((value) => (
            <button
              type="button"
              key={value}
              className={topic === value ? 'is-active' : undefined}
              onClick={() => {
                setTopic(value);
                setCursor(null);
              }}
            >
              {value.replaceAll('_', ' ')}
            </button>
          ))}
        </nav>

        <section
          id="mobile-world-letter-filters"
          className={`mobile-world-filters${filtersOpen ? ' is-open' : ''}`}
          aria-label={formatGlobalizationMessage(uiLocale, 'world.filters')}
        >
          <label>
            <span>{formatGlobalizationMessage(uiLocale, 'world.search')}</span>
            <input
              value={q}
              onChange={(event) => setQ(event.currentTarget.value)}
              placeholder={formatGlobalizationMessage(uiLocale, 'world.searchPlaceholder')}
              maxLength={120}
            />
          </label>
          <div>
            <label>
              <span>{formatGlobalizationMessage(uiLocale, 'world.country')}</span>
              <input
                value={country}
                onChange={(event) =>
                  setCountry(event.currentTarget.value.toUpperCase().slice(0, 2))
                }
                placeholder={formatGlobalizationMessage(uiLocale, 'world.anyCountry')}
                maxLength={2}
              />
            </label>
            <label>
              <span>{formatGlobalizationMessage(uiLocale, 'world.language')}</span>
              <input
                value={locale}
                onChange={(event) => setLocale(event.currentTarget.value)}
                placeholder="en-US"
              />
            </label>
          </div>
          <button
            type="button"
            onClick={() => {
              setCursor(null);
              void load(true);
            }}
            disabled={busy}
          >
            {formatGlobalizationMessage(uiLocale, 'world.refresh')}
          </button>
        </section>

        {notice ? (
          <p className="mobile-inline-notice" role="alert">
            {notice}
          </p>
        ) : null}

        <section className="mobile-letter-stream" aria-live="polite">
          {busy && items.length === 0 ? (
            <div className="mobile-world-loading" aria-label="Loading world stories">
              <span />
              <span />
            </div>
          ) : null}
          {items.map((item, index) => (
            <article className="mobile-letter-card" key={item.publication_id}>
              <header>
                <span className="mobile-country-seal" aria-hidden="true">
                  {item.country_code}
                </span>
                <div>
                  <p>
                    {item.country_code} · {item.locale}
                  </p>
                  <span>LETTER {String(index + 1).padStart(2, '0')}</span>
                </div>
                <button
                  type="button"
                  className={item.bookmarked ? 'is-saved' : undefined}
                  aria-label={item.bookmarked ? 'Remove bookmark' : 'Bookmark letter'}
                  aria-pressed={item.bookmarked}
                  onClick={() => void bookmark(item)}
                  disabled={bookmarkBusy.has(item.publication_id)}
                >
                  {item.bookmarked ? '◆' : '◇'}
                </button>
              </header>
              <button
                type="button"
                className="mobile-letter-open"
                onClick={(event) => void openDetail(item, event.currentTarget)}
                disabled={detailBusy}
              >
                <h2>{item.title}</h2>
                <p>{item.body.paragraphs[0]}</p>
                <span>
                  {item.pen_name} · {new Date(item.published_at).toLocaleDateString()}
                </span>
              </button>
              <footer>
                {item.topics.slice(0, 3).map((value) => (
                  <span key={value}>{value.replaceAll('_', ' ')}</span>
                ))}
              </footer>
            </article>
          ))}
          {!busy && items.length === 0 ? (
            <section className="mobile-world-empty">
              <span aria-hidden="true">✦</span>
              <p>LETTERS FROM THE WORLD</p>
              <h2>{formatGlobalizationMessage(uiLocale, 'world.empty')}</h2>
              <small>{formatGlobalizationMessage(uiLocale, 'world.description')}</small>
              <a href="/letters">Write the first letter</a>
            </section>
          ) : null}
        </section>

        {cursor ? (
          <button
            type="button"
            className="mobile-load-more"
            onClick={() => void load()}
            disabled={busy}
          >
            {formatGlobalizationMessage(uiLocale, 'world.action')}
          </button>
        ) : null}
      </section>

      <div className="desktop-experience">
        <header className="world-hero">
          <a href="/" className="back-link">
            ← Women AI Network
          </a>
          <p className="eyebrow">{formatGlobalizationMessage(uiLocale, 'world.title')}</p>
          <h1>{formatGlobalizationMessage(uiLocale, 'world.title')}</h1>
          <p className="intro">{formatGlobalizationMessage(uiLocale, 'world.description')}</p>
        </header>
        <button
          type="button"
          className="mobile-world-filter-toggle"
          aria-expanded={filtersOpen}
          aria-controls="world-letter-filters"
          onClick={() => setFiltersOpen((current) => !current)}
        >
          <span>{formatGlobalizationMessage(uiLocale, 'world.filters')}</span>
          <span aria-hidden="true">{filtersOpen ? '−' : '+'}</span>
        </button>
        <section
          id="world-letter-filters"
          className={`world-filters${filtersOpen ? ' is-open' : ''}`}
          aria-label={formatGlobalizationMessage(uiLocale, 'world.filters')}
        >
          <label>
            {formatGlobalizationMessage(uiLocale, 'world.country')}
            <input
              value={country}
              onChange={(event) => {
                setCountry(event.currentTarget.value.toUpperCase().slice(0, 2));
                setCursor(null);
              }}
              placeholder={formatGlobalizationMessage(uiLocale, 'world.anyCountry')}
              maxLength={2}
            />
          </label>
          <label>
            {formatGlobalizationMessage(uiLocale, 'world.language')}
            <input
              value={locale}
              onChange={(event) => {
                setLocale(event.currentTarget.value);
                setCursor(null);
              }}
              placeholder="en-US"
            />
          </label>
          <label>
            {formatGlobalizationMessage(uiLocale, 'world.theme')}
            <select
              value={topic}
              onChange={(event) => {
                setTopic(event.currentTarget.value);
                setCursor(null);
              }}
            >
              <option value="">{formatGlobalizationMessage(uiLocale, 'world.allThemes')}</option>
              {topics.map((value) => (
                <option key={value} value={value}>
                  {value.replaceAll('_', ' ')}
                </option>
              ))}
            </select>
          </label>
          <label className="search-field">
            {formatGlobalizationMessage(uiLocale, 'world.search')}
            <input
              value={q}
              onChange={(event) => setQ(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  setCursor(null);
                  void load(true);
                }
              }}
              placeholder={formatGlobalizationMessage(uiLocale, 'world.searchPlaceholder')}
              maxLength={120}
            />
          </label>
          <button
            type="button"
            onClick={() => {
              setCursor(null);
              void load(true);
            }}
            disabled={busy}
          >
            {formatGlobalizationMessage(uiLocale, 'world.refresh')}
          </button>
        </section>
        {notice && (
          <p className="world-notice" role="alert">
            {notice}
          </p>
        )}
        <section aria-live="polite" className="letter-grid">
          {items.map((item) => (
            <article className="letter-card" key={item.publication_id}>
              <div className="card-meta">
                <span>{item.country_code}</span>
                <span>{item.locale}</span>
                <button
                  type="button"
                  className={`bookmark ${item.bookmarked ? 'is-saved' : ''}`}
                  aria-label={item.bookmarked ? 'Remove bookmark' : 'Bookmark letter'}
                  aria-pressed={item.bookmarked}
                  aria-busy={bookmarkBusy.has(item.publication_id)}
                  onClick={() => void bookmark(item)}
                  disabled={bookmarkBusy.has(item.publication_id)}
                >
                  {item.bookmarked ? 'Saved' : 'Save'}
                </button>
              </div>
              <button
                type="button"
                className="card-open"
                onClick={(event) => void openDetail(item, event.currentTarget)}
                disabled={detailBusy}
              >
                <h2>{item.title}</h2>
                <p>{item.body.paragraphs[0]}</p>
                <span className="card-author">
                  {item.pen_name} · {new Date(item.published_at).toLocaleDateString()}
                </span>
              </button>
              <div className="topic-row">
                {item.topics.map((value) => (
                  <span key={value}>{value.replaceAll('_', ' ')}</span>
                ))}
              </div>
            </article>
          ))}
          {!busy && items.length === 0 && (
            <div className="empty-state">
              <h2>{formatGlobalizationMessage(uiLocale, 'world.empty')}</h2>
              <p>{formatGlobalizationMessage(uiLocale, 'world.description')}</p>
            </div>
          )}
        </section>
        {(busy || detailBusy) && (
          <p className="world-notice" role="status">
            Opening the next page…
          </p>
        )}
        {cursor && (
          <button type="button" className="load-more" onClick={() => void load()} disabled={busy}>
            {formatGlobalizationMessage(uiLocale, 'world.action')}
          </button>
        )}
      </div>
      {selected && (
        <div className="drawer-backdrop" role="presentation" onClick={closeDetail}>
          <aside
            className="letter-drawer"
            role="dialog"
            aria-modal="true"
            aria-labelledby="letter-title"
            ref={drawer}
            onKeyDown={trapDrawerKey}
            onClick={(event) => event.stopPropagation()}
          >
            <button
              type="button"
              className="drawer-close"
              ref={closeButton}
              onClick={closeDetail}
              aria-label="Close letter"
            >
              ×
            </button>
            <p className="eyebrow">
              {selected.country_code} · {selected.locale}
            </p>
            <h2 id="letter-title">
              {worldLetterDisplay(selected, translation, showTranslation).title}
            </h2>
            <p className="drawer-byline">{selected.pen_name}</p>
            {selected.content_reminder !== 'none' && (
              <p className="reminder">
                Content note: {selected.content_reminder.replaceAll('_', ' ')}
              </p>
            )}
            <div className="translation-controls" aria-label="Translation controls">
              <label>
                Translate to
                <input
                  value={translationLocale}
                  onChange={(event) => setTranslationLocale(event.currentTarget.value)}
                  placeholder="fr-FR"
                  disabled={translationBusy}
                />
              </label>
              <button
                type="button"
                onClick={() => void requestTranslation()}
                disabled={translationBusy || translationLocale === selected.locale}
              >
                {translationBusy ? 'Translating…' : 'Request translation'}
              </button>
              {translation && (
                <button type="button" onClick={() => setShowTranslation((value) => !value)}>
                  {showTranslation ? 'View original' : 'View translation'}
                </button>
              )}
            </div>
            {showTranslation && translation && (
              <p className="translation-note" role="status">
                Machine translated · {translation.target_locale}
              </p>
            )}
            {worldLetterDisplay(selected, translation, showTranslation).body.paragraphs.map(
              (paragraph, index) => (
                <p key={index}>{paragraph}</p>
              ),
            )}
            {!showTranslation && <p className="translation-note">Original text shown.</p>}
          </aside>
        </div>
      )}
    </main>
  );
}
