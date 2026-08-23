'use client';

import { useEffect, useRef, useState } from 'react';
import {
  bindMutationAttempt,
  createLetterPayload,
  patchLetterPayload,
  shouldReuseAfterFailure,
  type MutationAttempt,
} from './mutation';
import { getWebApiBaseUrl } from '../../src/lib/web-api-base';

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

type OwnerLetter = {
  id: string;
  kind: 'public_letter' | 'private_letter';
  state: 'draft' | 'published' | 'withdrawn' | 'archived';
  version: number;
  title: string;
  body: { paragraphs: string[] };
  locale: string;
  country_code: string;
  topics: string[];
  content_reminder: string;
  pen_name: string;
  revision: number;
};
type Publication = Omit<OwnerLetter, 'kind' | 'state' | 'version'>;
type Letter = OwnerLetter | Publication;
type LetterSummary = Pick<OwnerLetter, 'id' | 'kind' | 'state' | 'version' | 'revision'> & {
  created_at: string;
  updated_at: string;
};
const isOwnerLetter = (value: Letter | null): value is OwnerLetter =>
  value !== null && 'state' in value;
const newKey = () => `web-${crypto.randomUUID()}`;

class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export default function LettersPage() {
  const [kind, setKind] = useState('public_letter');
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [penName, setPenName] = useState('');
  const [country, setCountry] = useState('');
  const [locale, setLocale] = useState('en-US');
  const [selectedTopics, setSelectedTopics] = useState<string[]>(['life_story']);
  const [reminder, setReminder] = useState('none');
  const [letter, setLetter] = useState<Letter | null>(null);
  const [lookup, setLookup] = useState('');
  const [notice, setNotice] = useState('');
  const [translation, setTranslation] = useState<{
    title: string;
    body: { paragraphs: string[] };
    target_locale: string;
  } | null>(null);
  const [translationLocale, setTranslationLocale] = useState('fr-FR');
  const [showTranslation, setShowTranslation] = useState(false);
  const translationAbort = useRef<AbortController | null>(null);
  const [summaries, setSummaries] = useState<LetterSummary[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [autoSavePaused, setAutoSavePaused] = useState(false);
  const [busy, setBusy] = useState(false);
  const [createAttempt, setCreateAttempt] = useState<MutationAttempt | null>(null);
  const [saveAttempt, setSaveAttempt] = useState<MutationAttempt | null>(null);
  const [keys, setKeys] = useState({
    publish: newKey(),
    withdraw: newKey(),
    archive: newKey(),
  });
  const inputValue = (event: { currentTarget: unknown }) =>
    (event.currentTarget as { value: string }).value;

  async function call(path: string, init: RequestInit = {}, idempotencyKey?: string) {
    const response = await fetch(`${API}${path}`, {
      ...init,
      credentials: 'include',
      headers: {
        'content-type': 'application/json',
        ...(idempotencyKey === undefined ? {} : { 'idempotency-key': idempotencyKey }),
        ...(init.headers ?? {}),
      },
    });
    const raw = (await response.json().catch(() => null)) as { message?: string } | null;
    if (!response.ok)
      throw new ApiError(response.status, raw?.message ?? `Request failed (${response.status})`);
    return raw;
  }

  function currentContentPayload() {
    return {
      title,
      body: {
        paragraphs: body
          .split(/\n+/)
          .map((line) => line.trim())
          .filter(Boolean),
      },
      locale,
      country_code: country.toUpperCase(),
      topics: selectedTopics,
      content_reminder: reminder,
      pen_name: penName,
    };
  }

  function hydrate(loaded: Letter) {
    setLetter(loaded);
    setKind('kind' in loaded ? loaded.kind : 'public_letter');
    setTitle(loaded.title ?? '');
    setBody(loaded.body?.paragraphs?.join('\n\n') ?? '');
    setPenName(loaded.pen_name ?? '');
    setCountry(loaded.country_code ?? '');
    setLocale(loaded.locale ?? 'en-US');
    setSelectedTopics(loaded.topics?.slice(0, 4) ?? ['life_story']);
    setReminder(loaded.content_reminder ?? 'none');
    setAutoSavePaused(false);
    setSaveAttempt(null);
    setKeys({ publish: newKey(), withdraw: newKey(), archive: newKey() });
    setTranslation(null);
    setShowTranslation(false);
  }

  async function create() {
    if (busy) return;
    setBusy(true);
    setNotice('Saving your draft…');
    const request = createLetterPayload(kind, currentContentPayload());
    const attempt = bindMutationAttempt(createAttempt, request, null, newKey);
    setCreateAttempt(attempt);
    try {
      const result = await call(
        '/letters',
        {
          method: 'POST',
          body: JSON.stringify(request),
        },
        attempt.key,
      );
      hydrate(result as Letter);
      setCreateAttempt(null);
      setNotice('Draft saved. Your words remain yours until you publish.');
    } catch (error) {
      if (error instanceof ApiError && !shouldReuseAfterFailure(error.status))
        setCreateAttempt(null);
      setNotice(error instanceof Error ? error.message : 'Unable to save draft.');
    } finally {
      setBusy(false);
    }
  }

  async function update() {
    if (!isOwnerLetter(letter) || busy) return;
    setBusy(true);
    setNotice('Autosaving…');
    const request = patchLetterPayload(currentContentPayload());
    const attempt = bindMutationAttempt(saveAttempt, request, letter.version, newKey);
    setSaveAttempt(attempt);
    try {
      const result = await call(
        `/letters/${letter.id}`,
        {
          method: 'PATCH',
          headers: { 'if-match': String(letter.version) },
          body: JSON.stringify(request),
        },
        attempt.key,
      );
      hydrate(result as Letter);
      setSaveAttempt(null);
      setAutoSavePaused(false);
      setNotice('Saved.');
    } catch (error) {
      if (error instanceof ApiError && !shouldReuseAfterFailure(error.status)) setSaveAttempt(null);
      setNotice(error instanceof Error ? error.message : 'Unable to autosave.');
      setAutoSavePaused(true);
    } finally {
      setBusy(false);
    }
  }

  const hasDraftChanges =
    isOwnerLetter(letter) &&
    letter.state === 'draft' &&
    (title !== letter.title ||
      body !== letter.body.paragraphs.join('\n\n') ||
      penName !== letter.pen_name ||
      country.toUpperCase() !== letter.country_code ||
      locale !== letter.locale ||
      JSON.stringify(selectedTopics) !== JSON.stringify(letter.topics) ||
      reminder !== letter.content_reminder);

  useEffect(() => {
    if (!hasDraftChanges || busy || autoSavePaused) return;
    const timer = setTimeout(() => void update(), 900);
    return () => clearTimeout(timer);
  }, [
    hasDraftChanges,
    busy,
    autoSavePaused,
    title,
    body,
    penName,
    country,
    locale,
    selectedTopics,
    reminder,
  ]);

  async function transition(action: 'publish' | 'withdraw' | 'archive') {
    if (!isOwnerLetter(letter) || busy) return;
    setBusy(true);
    try {
      const result = await call(
        `/letters/${letter.id}/${action}`,
        {
          method: 'POST',
          headers: { 'if-match': String(letter.version) },
        },
        keys[action],
      );
      hydrate(result as Letter);
      setKeys((current) => ({ ...current, [action]: newKey() }));
      setNotice(
        action === 'publish'
          ? 'Published for eligible members.'
          : action === 'withdraw'
            ? 'Letter withdrawn.'
            : 'Letter archived.',
      );
    } catch (error) {
      if (error instanceof ApiError && !shouldReuseAfterFailure(error.status))
        setKeys((current) => ({ ...current, [action]: newKey() }));
      setNotice(error instanceof Error ? error.message : 'Unable to update letter.');
    } finally {
      setBusy(false);
    }
  }

  async function read() {
    if (!lookup) return;
    try {
      const result = await call(`/letters/${lookup}`, { method: 'GET', headers: {} });
      hydrate(result as Letter);
      setNotice('Letter loaded.');
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Letter unavailable.');
    }
  }

  async function requestTranslation() {
    if (letter === null || isOwnerLetter(letter) || busy) return;
    translationAbort.current?.abort();
    const controller = new AbortController();
    translationAbort.current = controller;
    setBusy(true);
    try {
      const response = (await call(
        `/letters/${letter.id}/translations`,
        {
          method: 'POST',
          body: JSON.stringify({ target_locale: translationLocale }),
        },
        `translation-${letter.id}-${translationLocale}`,
      )) as {
        machine_translated: boolean;
        task_id?: string;
        state?: string;
        result?: { title: string; body: { paragraphs: string[] }; target_locale: string } | null;
      };
      if (
        response.machine_translated &&
        response.result !== null &&
        response.result !== undefined
      ) {
        setTranslation(response.result);
        setShowTranslation(true);
        setNotice('Machine translated result loaded.');
      } else {
        let latest = response;
        for (
          let attempt = 0;
          attempt < 6 && (latest.result === null || latest.result === undefined);
          attempt += 1
        ) {
          await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(resolve, 1000);
            controller.signal.addEventListener(
              'abort',
              () => {
                clearTimeout(timer);
                reject(new DOMException('translation polling cancelled', 'AbortError'));
              },
              { once: true },
            );
          });
          latest = (await call(
            `/letters/${letter.id}/translations/${encodeURIComponent(translationLocale)}`,
            { method: 'GET', signal: controller.signal },
          )) as typeof latest;
          if (latest.result !== null && latest.result !== undefined) {
            setTranslation(latest.result);
            setShowTranslation(true);
            setNotice('Machine translated result loaded.');
            break;
          }
        }
        if (latest.result === null || latest.result === undefined)
          setNotice('Translation is pending or unavailable; the original remains visible.');
      }
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return;
      setNotice(
        error instanceof Error ? error.message : 'Translation unavailable; original preserved.',
      );
    } finally {
      setBusy(false);
      if (translationAbort.current === controller) translationAbort.current = null;
    }
  }

  useEffect(() => () => translationAbort.current?.abort(), []);

  async function loadMine() {
    if (busy) return;
    setBusy(true);
    try {
      const query =
        nextCursor === null ? 'limit=20' : `limit=20&cursor=${encodeURIComponent(nextCursor)}`;
      const result = (await call(`/letters?${query}`, { method: 'GET' })) as {
        items: LetterSummary[];
        next_cursor: string | null;
      };
      setSummaries((current) =>
        nextCursor === null ? result.items : [...current, ...result.items],
      );
      setNextCursor(result.next_cursor);
      setNotice('Your letters are ready.');
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Your letters are unavailable.');
    } finally {
      setBusy(false);
    }
  }

  async function openLetter(id: string) {
    if (busy) return;
    setBusy(true);
    try {
      const result = await call(`/letters/${id}`, { method: 'GET' });
      hydrate(result as Letter);
      setLookup(id);
      setNotice('Letter loaded.');
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Letter unavailable.');
    } finally {
      setBusy(false);
    }
  }

  function newLetter() {
    setLetter(null);
    setKind('public_letter');
    setTitle('');
    setBody('');
    setPenName('');
    setCountry('');
    setLocale('en-US');
    setSelectedTopics(['life_story']);
    setReminder('none');
    setNotice('');
    setAutoSavePaused(false);
    setCreateAttempt(null);
    setSaveAttempt(null);
    setKeys({ publish: newKey(), withdraw: newKey(), archive: newKey() });
  }

  const editorEnabled = letter === null || (isOwnerLetter(letter) && letter.state === 'draft');

  return (
    <main style={{ maxWidth: '46rem', margin: '0 auto', padding: '2rem 1.1rem 4rem' }}>
      <header style={{ marginBottom: '2.5rem' }}>
        <a href="/" style={{ textDecoration: 'none' }}>
          ← Women AI Network
        </a>
        <p
          style={{
            color: 'var(--terracotta)',
            letterSpacing: '.08em',
            textTransform: 'uppercase',
            marginBottom: '.5rem',
          }}
        >
          The letter desk
        </p>
        <h1
          style={{
            fontFamily: 'Georgia, serif',
            fontSize: 'clamp(2.2rem, 9vw, 4rem)',
            lineHeight: 1.05,
            margin: 0,
          }}
        >
          Write something worth rereading.
        </h1>
        <p style={{ color: 'var(--muted)', lineHeight: 1.6 }}>
          Plain paragraphs only. No anonymous reading. Publication is checked against membership,
          age policy, and safety at the moment you publish.
        </p>
      </header>
      <section
        aria-labelledby="write-heading"
        style={{
          background: 'rgba(255,255,255,.38)',
          border: '1px solid var(--line)',
          padding: '1.1rem',
          borderRadius: '.5rem',
        }}
      >
        <h2 id="write-heading" style={{ fontFamily: 'Georgia, serif' }}>
          Your draft
        </h2>
        <div style={{ display: 'grid', gap: '1rem' }}>
          <label>
            Letter kind
            <select
              value={kind}
              disabled={!editorEnabled || letter !== null}
              onChange={(event) => setKind(inputValue(event))}
              style={{ display: 'block', width: '100%', marginTop: '.35rem' }}
            >
              <option value="public_letter">Public letter for eligible members</option>
              <option value="private_letter">Private letter draft</option>
            </select>
          </label>
          <label>
            Title
            <input
              value={title}
              readOnly={!editorEnabled}
              onChange={(event) => setTitle(inputValue(event))}
              maxLength={160}
              style={{ display: 'block', width: '100%', marginTop: '.35rem' }}
            />
          </label>
          <label>
            Pen name
            <input
              value={penName}
              readOnly={!editorEnabled}
              onChange={(event) => setPenName(inputValue(event))}
              maxLength={80}
              style={{ display: 'block', width: '100%', marginTop: '.35rem' }}
            />
          </label>
          <label>
            Country (ISO alpha-2)
            <input
              value={country}
              readOnly={!editorEnabled}
              onChange={(event) => setCountry(inputValue(event).toUpperCase())}
              maxLength={2}
              placeholder="US"
              style={{ display: 'block', width: '100%', marginTop: '.35rem' }}
            />
          </label>
          <label>
            Language (canonical BCP-47)
            <input
              value={locale}
              readOnly={!editorEnabled}
              onChange={(event) => setLocale(inputValue(event))}
              placeholder="en-US"
              style={{ display: 'block', width: '100%', marginTop: '.35rem' }}
            />
          </label>
          <fieldset disabled={!editorEnabled} style={{ border: 0, padding: 0 }}>
            <legend>Topics (choose up to four)</legend>
            <div style={{ display: 'grid', gap: '.4rem', marginTop: '.35rem' }}>
              {topics.map((value) => {
                const checked = selectedTopics.includes(value);
                return (
                  <label
                    key={value}
                    style={{ display: 'flex', gap: '.5rem', alignItems: 'center' }}
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      disabled={!checked && selectedTopics.length >= 4}
                      onChange={(event) => {
                        if ((event.currentTarget as unknown as { checked: boolean }).checked) {
                          setSelectedTopics((current) =>
                            current.length >= 4 ? current : [...current, value],
                          );
                        } else {
                          setSelectedTopics((current) =>
                            current.length <= 1
                              ? current
                              : current.filter((item) => item !== value),
                          );
                        }
                      }}
                    />
                    {value.replaceAll('_', ' ')}
                  </label>
                );
              })}
            </div>
          </fieldset>
          <label>
            Content reminder
            <select
              value={reminder}
              disabled={!editorEnabled}
              onChange={(event) => setReminder(inputValue(event))}
              style={{ display: 'block', width: '100%', marginTop: '.35rem' }}
            >
              <option value="none">No reminder</option>
              <option value="sensitive_content">Sensitive content</option>
              <option value="personal_data">Personal data</option>
            </select>
          </label>
          <label>
            Letter body
            <textarea
              value={body}
              readOnly={!editorEnabled}
              onChange={(event) => setBody(inputValue(event))}
              rows={10}
              maxLength={20000}
              placeholder="One paragraph at a time…"
              style={{
                display: 'block',
                width: '100%',
                marginTop: '.35rem',
                lineHeight: 1.7,
                padding: '.7rem',
                fontFamily: 'Georgia, serif',
              }}
            />
          </label>
          <div style={{ display: 'flex', gap: '.6rem', flexWrap: 'wrap' }}>
            <button
              onClick={
                letter === null
                  ? create
                  : () => {
                      setAutoSavePaused(false);
                      void update();
                    }
              }
              disabled={
                busy || !editorEnabled || Boolean(isOwnerLetter(letter) && !hasDraftChanges)
              }
              style={{
                background: 'var(--terracotta)',
                color: 'white',
                border: 0,
                padding: '.65rem 1rem',
                borderRadius: '.25rem',
              }}
            >
              {letter === null ? 'Save draft' : 'Save changes'}
            </button>
            {letter !== null && (
              <button
                onClick={newLetter}
                disabled={busy}
                style={{
                  background: 'transparent',
                  color: 'var(--ink)',
                  border: '1px solid var(--line)',
                  padding: '.65rem 1rem',
                  borderRadius: '.25rem',
                }}
              >
                New letter
              </button>
            )}
            {isOwnerLetter(letter) &&
              letter.kind === 'public_letter' &&
              letter.state === 'draft' && (
                <button
                  onClick={() => transition('publish')}
                  disabled={busy || hasDraftChanges || autoSavePaused}
                  style={{
                    background: 'var(--teal)',
                    color: 'white',
                    border: 0,
                    padding: '.65rem 1rem',
                    borderRadius: '.25rem',
                  }}
                >
                  Publish
                </button>
              )}
            {isOwnerLetter(letter) && letter.state === 'published' && (
              <button
                onClick={() => transition('withdraw')}
                disabled={busy}
                style={{
                  background: 'transparent',
                  color: 'var(--ink)',
                  border: '1px solid var(--line)',
                  padding: '.65rem 1rem',
                  borderRadius: '.25rem',
                }}
              >
                Withdraw
              </button>
            )}
            {isOwnerLetter(letter) && letter.state === 'withdrawn' && (
              <button
                onClick={() => transition('archive')}
                disabled={busy}
                style={{
                  background: 'transparent',
                  color: 'var(--ink)',
                  border: '1px solid var(--line)',
                  padding: '.65rem 1rem',
                  borderRadius: '.25rem',
                }}
              >
                Archive
              </button>
            )}
          </div>
        </div>
      </section>
      <section aria-labelledby="read-heading" style={{ marginTop: '2rem' }}>
        <h2 id="read-heading" style={{ fontFamily: 'Georgia, serif' }}>
          Read a letter
        </h2>
        <label>
          Letter ID
          <input
            value={lookup}
            onChange={(event) => setLookup(inputValue(event))}
            placeholder="UUID"
            style={{ display: 'block', width: '100%', marginTop: '.35rem' }}
          />
        </label>
        <button
          onClick={read}
          style={{
            marginTop: '.75rem',
            padding: '.65rem 1rem',
            border: '1px solid var(--teal)',
            color: 'var(--teal)',
            background: 'transparent',
            borderRadius: '.25rem',
          }}
        >
          Load letter
        </button>
      </section>
      <section aria-labelledby="mine-heading" style={{ marginTop: '2rem' }}>
        <h2 id="mine-heading" style={{ fontFamily: 'Georgia, serif' }}>
          My letters
        </h2>
        <button
          onClick={loadMine}
          disabled={busy}
          style={{
            padding: '.65rem 1rem',
            border: '1px solid var(--teal)',
            color: 'var(--teal)',
            background: 'transparent',
            borderRadius: '.25rem',
          }}
        >
          Load my letters
        </button>
        {summaries.length > 0 && (
          <ul>
            {summaries.map((summary) => (
              <li key={summary.id}>
                <button
                  onClick={() => void openLetter(summary.id)}
                  style={{
                    background: 'none',
                    border: 0,
                    color: 'var(--teal)',
                    textDecoration: 'underline',
                    padding: '.5rem 0',
                  }}
                >
                  {summary.kind.replace('_', ' ')} · {summary.state} ·{' '}
                  {new Date(summary.updated_at).toLocaleDateString()}
                </button>
              </li>
            ))}
          </ul>
        )}
        {nextCursor !== null && (
          <button
            onClick={loadMine}
            disabled={busy}
            style={{
              padding: '.55rem .85rem',
              border: '1px solid var(--line)',
              background: 'transparent',
            }}
          >
            Load more
          </button>
        )}
      </section>
      {notice && (
        <p role="status" aria-live="polite" style={{ color: 'var(--muted)', marginTop: '1.25rem' }}>
          {notice}
        </p>
      )}
      {letter && (
        <article
          style={{
            marginTop: '2rem',
            borderTop: '3px solid var(--terracotta)',
            paddingTop: '1.25rem',
          }}
        >
          <p style={{ color: 'var(--muted)' }}>
            {letter.pen_name} · {letter.country_code} · {letter.locale}
          </p>
          {!isOwnerLetter(letter) && (
            <div style={{ display: 'flex', gap: '.5rem', flexWrap: 'wrap', alignItems: 'end' }}>
              <label>
                Translate to
                <input
                  value={translationLocale}
                  onChange={(event) => setTranslationLocale(inputValue(event))}
                  style={{ display: 'block', width: '8rem' }}
                />
              </label>
              <button
                onClick={() => void requestTranslation()}
                disabled={busy}
                style={{
                  padding: '.65rem 1rem',
                  border: '1px solid var(--teal)',
                  background: 'transparent',
                }}
              >
                Request translation
              </button>
              {translation && (
                <button
                  onClick={() => setShowTranslation((value) => !value)}
                  disabled={busy}
                  style={{
                    padding: '.65rem 1rem',
                    border: '1px solid var(--line)',
                    background: 'transparent',
                  }}
                >
                  {showTranslation ? 'View original' : 'View translation'}
                </button>
              )}
            </div>
          )}
          <p style={{ color: 'var(--muted)' }}>
            {showTranslation && translation
              ? `Machine translated · ${translation.target_locale}`
              : 'Original letter'}
          </p>
          <h2 style={{ fontFamily: 'Georgia, serif' }}>
            {showTranslation && translation ? translation.title : letter.title}
          </h2>
          {(showTranslation && translation
            ? translation.body.paragraphs
            : letter.body.paragraphs
          ).map((paragraph, index) => (
            <p
              key={`${letter.id}-${index}`}
              style={{ fontFamily: 'Georgia, serif', fontSize: '1.1rem', lineHeight: 1.8 }}
            >
              {paragraph}
            </p>
          ))}
        </article>
      )}
    </main>
  );
}
