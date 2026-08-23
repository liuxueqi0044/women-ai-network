'use client';

import { useEffect, useMemo, useState } from 'react';
import { ZodError } from 'zod';
import {
  globalizationCatalog,
  globalizationHourCycleSchema,
  globalizationUiLocales,
  globalizationWeekStartSchema,
  type GlobalizationPreferences,
  type GlobalizationUiLocale,
} from '@wai/contracts';
import {
  GlobalizationHttpError,
  getGlobalizationPreferences,
  putGlobalizationPreferences,
} from '../../../src/globalization-client';
import { useGlobalization } from '../../../src/globalization-store';

const labels: Record<GlobalizationUiLocale, string> = {
  en: 'English',
  'zh-Hans-CN': '简体中文',
  'es-419': 'Español (Latinoamérica)',
  fr: 'Français',
};
const zoneSuggestions = [
  'UTC',
  'America/Los_Angeles',
  'America/New_York',
  'Europe/London',
  'Europe/Paris',
  'Asia/Shanghai',
  'Asia/Tokyo',
];
const hourCycles = globalizationHourCycleSchema.options;
const weekDays = [0, 1, 2, 3, 4, 5, 6] as const;

function messageForError(error: unknown): string {
  if (
    error instanceof ZodError ||
    (typeof error === 'object' && error !== null && 'name' in error && error.name === 'ZodError')
  )
    return 'Check the language values and try again.';
  if (!(error instanceof GlobalizationHttpError))
    return 'Network unavailable. Your changes are still here; try again.';
  if (error.status === 401 || error.status === 403)
    return 'Please sign in again to manage language settings.';
  if (error.status === 404) return 'These settings are not available for this account.';
  if (error.status === 428) return 'Refresh your settings before saving.';
  if (error.status === 409) return 'Another device changed these settings. Refresh and try again.';
  if (error.code === 'INVALID_TIME_ZONE') return 'Choose a supported time zone.';
  if (error.code === 'RATE_LIMITED') return 'Too many saves. Please wait and try again.';
  return 'We could not save these settings. Try again.';
}

function normalizeLocales(input: string): string[] {
  return [
    ...new Set(
      input
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  ];
}

export default function LanguageSettingsPage() {
  const { locale: committedLocale, commitLocale } = useGlobalization();
  const [draftLocale, setDraftLocale] = useState<GlobalizationUiLocale>(committedLocale);
  const [version, setVersion] = useState(0);
  const [contentLocales, setContentLocales] = useState<string[]>([]);
  const [zone, setZone] = useState('UTC');
  const [hourCycle, setHourCycle] = useState<(typeof hourCycles)[number]>('h23');
  const [weekStart, setWeekStart] = useState(1);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const messages = globalizationCatalog.locales[committedLocale].messages;
  const preview = useMemo(() => {
    try {
      return new Intl.DateTimeFormat(draftLocale, {
        dateStyle: 'medium',
        timeStyle: 'short',
        timeZone: zone,
        hourCycle,
      }).format(new Date('2026-01-02T15:04:00Z'));
    } catch {
      return 'Enter a valid PostgreSQL time zone.';
    }
  }, [draftLocale, zone, hourCycle]);
  useEffect(() => {
    let active = true;
    void getGlobalizationPreferences()
      .then((value) => {
        if (!active) return;
        commitLocale(value.ui_locale);
        hydrate(
          value,
          setDraftLocale,
          setVersion,
          setContentLocales,
          setZone,
          setHourCycle,
          setWeekStart,
        );
        setLoading(false);
      })
      .catch((reason: unknown) => {
        if (active) {
          setError(messageForError(reason));
          setLoading(false);
        }
      });
    return () => {
      active = false;
    };
  }, [commitLocale]);
  async function save(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setError('');
    setNotice('');
    if (contentLocales.length > 8) {
      setError('Choose no more than 8 content languages.');
      setSaving(false);
      return;
    }
    try {
      const result = await putGlobalizationPreferences(
        {
          ui_locale: draftLocale,
          content_locales: contentLocales,
          time_zone: zone,
          hour_cycle: hourCycle,
          week_start: weekStart,
        },
        version,
      );
      commitLocale(result.ui_locale);
      hydrate(
        result,
        setDraftLocale,
        setVersion,
        setContentLocales,
        setZone,
        setHourCycle,
        setWeekStart,
      );
      setNotice(globalizationCatalog.locales[result.ui_locale].messages['settings.language.saved']);
    } catch (reason) {
      setError(messageForError(reason));
    } finally {
      setSaving(false);
    }
  }
  return (
    <main className="settings-shell">
      <p className="eyebrow">{messages['common.nav.settings']}</p>
      <h1>{messages['settings.language.title']}</h1>
      <p className="intro">{messages['settings.language.description']}</p>
      {loading ? (
        <p role="status" aria-live="polite">
          Loading…
        </p>
      ) : (
        <form onSubmit={save} className="language-form" aria-busy={saving}>
          <label>
            {messages['settings.language.uiLocale']}
            <select
              value={draftLocale}
              onChange={(event) => setDraftLocale(event.target.value as GlobalizationUiLocale)}
            >
              {globalizationUiLocales.map((item) => (
                <option key={item} value={item}>
                  {labels[item]}
                </option>
              ))}
            </select>
          </label>
          <label>
            {messages['settings.language.contentLocales']}
            <input
              value={contentLocales.join(', ')}
              onChange={(event) => setContentLocales(normalizeLocales(event.target.value))}
              placeholder="en, fr"
              aria-describedby="content-locale-help"
            />
            <small id="content-locale-help">0–8 languages, in your preferred order.</small>
          </label>
          <label>
            {messages['settings.language.timeZone']}
            <input
              list="globalization-time-zones"
              value={zone}
              onChange={(event) => setZone(event.target.value)}
              aria-describedby="time-zone-help"
            />
            <datalist id="globalization-time-zones">
              {zoneSuggestions.map((item) => (
                <option key={item} value={item}>
                  {item}
                </option>
              ))}
            </datalist>
            <small id="time-zone-help">
              Use any PostgreSQL time zone; the server validates it.
            </small>
          </label>
          <label>
            {messages['settings.language.hourCycle']}
            <select
              value={hourCycle}
              onChange={(event) => setHourCycle(event.target.value as (typeof hourCycles)[number])}
            >
              {hourCycles.map((item) => (
                <option key={item} value={item}>
                  {item}
                </option>
              ))}
            </select>
          </label>
          <label>
            {messages['settings.language.weekStart']}
            <select
              value={weekStart}
              onChange={(event) =>
                setWeekStart(globalizationWeekStartSchema.parse(Number(event.target.value)))
              }
            >
              {weekDays.map((item) => (
                <option key={item} value={item}>
                  {dayLabel(draftLocale, item)}
                </option>
              ))}
            </select>
          </label>
          <p aria-live="polite">{preview}</p>
          <button type="submit" disabled={saving}>
            {saving ? 'Saving…' : messages['settings.language.save']}
          </button>
          {notice && <span role="status">{notice}</span>}
          {error && <p role="alert">{error}</p>}
        </form>
      )}
    </main>
  );
}

function hydrate(
  value: GlobalizationPreferences,
  setLocale: (value: GlobalizationUiLocale) => void,
  setVersion: (value: number) => void,
  setContentLocales: (value: string[]) => void,
  setZone: (value: string) => void,
  setHourCycle: (value: (typeof hourCycles)[number]) => void,
  setWeekStart: (value: number) => void,
) {
  setLocale(value.ui_locale);
  setVersion(value.version);
  setContentLocales(value.content_locales);
  setZone(value.time_zone);
  setHourCycle(value.hour_cycle);
  setWeekStart(value.week_start);
}
function dayLabel(locale: string, day: number): string {
  const base = new Date(Date.UTC(2024, 0, 7 + day));
  return new Intl.DateTimeFormat(locale, { weekday: 'long', timeZone: 'UTC' }).format(base);
}
