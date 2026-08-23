'use client';
import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { getWebApiBaseUrl } from '../../src/lib/web-api-base';
import './notifications.css';

type Item = {
  id: string;
  message?: string;
  message_key: string;
  read_at: string | null;
  created_at: string;
  resource_kind: string;
  category: string;
};
type Preference = {
  channel: 'in_app' | 'email' | 'push';
  category: string;
  enabled: boolean;
  quiet_start_minute: number;
  quiet_end_minute: number;
  digest_cadence: 'immediate' | 'daily' | 'weekly';
};
type Locale = 'en' | 'zh-Hans-CN' | 'es-419' | 'fr';
const copy = {
  en: {
    title: 'Notifications',
    intro: 'A private, calm place to catch up. No message bodies are previewed here.',
    refresh: 'Refresh',
    markAll: 'Mark all read',
    mark: 'Mark read',
    category: 'Category',
    all: 'All',
    loadMore: 'Load more',
    settings: 'Notification settings',
    save: 'Save preferences',
    saved: 'Preferences saved',
    criticalPolicy: 'Safety alerts cannot be disabled, silenced, or delayed.',
    retry: 'Notifications are temporarily unavailable. Retry when you are back online.',
  },
  'zh-Hans-CN': {
    title: '通知',
    intro: '安静查看通知，不预览消息正文。',
    refresh: '刷新',
    markAll: '全部标为已读',
    mark: '标为已读',
    category: '分类',
    all: '全部',
    loadMore: '加载更多',
    settings: '通知设置',
    save: '保存偏好',
    saved: '偏好已保存',
    criticalPolicy: '安全提醒不可关闭、静音或延迟。',
    retry: '通知暂时不可用，请联网后重试。',
  },
  'es-419': {
    title: 'Notificaciones',
    intro: 'Un lugar privado para ponerte al día. No mostramos cuerpos de mensajes.',
    refresh: 'Actualizar',
    markAll: 'Marcar todo como leído',
    mark: 'Marcar como leído',
    category: 'Categoría',
    all: 'Todas',
    loadMore: 'Cargar más',
    settings: 'Configuración de notificaciones',
    save: 'Guardar preferencias',
    saved: 'Preferencias guardadas',
    criticalPolicy: 'Las alertas de seguridad no se pueden desactivar, silenciar ni aplazar.',
    retry: 'Las notificaciones no están disponibles. Reintenta cuando tengas conexión.',
  },
  fr: {
    title: 'Notifications',
    intro: 'Un espace privé et calme. Aucun contenu de message n’est affiché.',
    refresh: 'Actualiser',
    markAll: 'Tout marquer comme lu',
    mark: 'Marquer comme lu',
    category: 'Catégorie',
    all: 'Toutes',
    loadMore: 'Charger plus',
    settings: 'Réglages des notifications',
    save: 'Enregistrer les préférences',
    saved: 'Préférences enregistrées',
    criticalPolicy:
      'Les alertes de sécurité ne peuvent pas être désactivées, réduites au silence ou différées.',
    retry: 'Notifications indisponibles. Réessayez une fois reconnectée.',
  },
} as const;
export default function NotificationsPage() {
  const [items, setItems] = useState<Item[]>([]);
  const [busy, setBusy] = useState(true);
  const [offline, setOffline] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [unread, setUnread] = useState(0);
  const [category, setCategory] = useState('all');
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [locale, setLocale] = useState<Locale>('en');
  const [timeZone, setTimeZone] = useState('UTC');
  const [preferences, setPreferences] = useState<{ version: number; items: Preference[] } | null>(
    null,
  );
  const [preferenceMessage, setPreferenceMessage] = useState<string | null>(null);
  const text = copy[locale];
  const load = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const [response, unreadResponse, globalizationResponse, preferencesResponse] =
        await Promise.all([
          fetch(
            `${getWebApiBaseUrl()}/notifications?limit=50${category === 'all' ? '' : `&category=${encodeURIComponent(category)}`}`,
            { credentials: 'include' },
          ),
          fetch(`${getWebApiBaseUrl()}/notifications/unread-count`, { credentials: 'include' }),
          fetch(`${getWebApiBaseUrl()}/globalization/preferences`, { credentials: 'include' }),
          fetch(`${getWebApiBaseUrl()}/notifications/preferences`, { credentials: 'include' }),
        ]);
      if (!response.ok) throw new Error('notifications_unavailable');
      const body = (await response.json()) as { items: Item[] };
      setItems(body.items);
      setNextCursor((body as { next_cursor?: string | null }).next_cursor ?? null);
      if (unreadResponse.ok)
        setUnread(((await unreadResponse.json()) as { unread_count: number }).unread_count);
      if (globalizationResponse.ok) {
        const globalization = (await globalizationResponse.json()) as {
          ui_locale?: string;
          time_zone?: string;
        };
        const requested = globalization.ui_locale;
        setLocale(
          requested === 'zh-Hans-CN' || requested === 'es-419' || requested === 'fr'
            ? requested
            : 'en',
        );
        setTimeZone(globalization.time_zone ?? 'UTC');
      }
      if (preferencesResponse.ok)
        setPreferences(
          (await preferencesResponse.json()) as { version: number; items: Preference[] },
        );
      setOffline(false);
    } catch {
      setOffline(true);
      setError(text.retry);
    } finally {
      setBusy(false);
    }
  }, [category, text.retry]);
  const loadMore = async () => {
    if (!nextCursor) return;
    const response = await fetch(
      `${getWebApiBaseUrl()}/notifications?limit=50&cursor=${encodeURIComponent(nextCursor)}${category === 'all' ? '' : `&category=${encodeURIComponent(category)}`}`,
      { credentials: 'include' },
    );
    if (!response.ok) return;
    const body = (await response.json()) as { items: Item[]; next_cursor: string | null };
    setItems((old) => [...old, ...body.items]);
    setNextCursor(body.next_cursor);
  };
  const updatePreference = (index: number, patch: Partial<Preference>) => {
    setPreferences((old) =>
      old
        ? {
            ...old,
            items: old.items.map((item, itemIndex) =>
              itemIndex === index ? { ...item, ...patch } : item,
            ),
          }
        : old,
    );
  };
  const savePreferences = async () => {
    if (!preferences) return;
    setPreferenceMessage(null);
    const response = await fetch(`${getWebApiBaseUrl()}/notifications/preferences`, {
      method: 'PUT',
      credentials: 'include',
      headers: {
        'content-type': 'application/json',
        origin: window.location.origin,
        'idempotency-key': `${crypto.randomUUID()}-notification-preferences`,
      },
      body: JSON.stringify({
        expected_version: preferences.version,
        items: preferences.items.map(
          ({
            channel,
            category,
            enabled,
            quiet_start_minute,
            quiet_end_minute,
            digest_cadence,
          }) => ({
            channel,
            category,
            enabled,
            quiet_start_minute,
            quiet_end_minute,
            digest_cadence,
          }),
        ),
      }),
    });
    if (!response.ok) {
      setPreferenceMessage('Preferences changed elsewhere. Refresh and try again.');
      return;
    }
    const saved = (await response.json()) as { version: number; items: Preference[] };
    setPreferences(saved);
    setPreferenceMessage(text.saved);
  };
  const markAll = async () => {
    try {
      const response = await fetch(`${getWebApiBaseUrl()}/notifications/read-all`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json', origin: window.location.origin },
        body: JSON.stringify({ idempotency_key: `${crypto.randomUUID()}-notification-all` }),
      });
      if (!response.ok) throw new Error('read_all_failed');
      setItems((old) =>
        old.map((item) => ({ ...item, read_at: item.read_at ?? new Date().toISOString() })),
      );
      setUnread(0);
    } catch {
      setOffline(true);
    }
  };
  useEffect(() => {
    void load();
  }, [load]);
  const mark = async (id: string) => {
    const key = `${crypto.randomUUID()}-notification`;
    try {
      const response = await fetch(`${getWebApiBaseUrl()}/notifications/${id}/read`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json', origin: window.location.origin },
        body: JSON.stringify({ idempotency_key: key }),
      });
      if (!response.ok) throw new Error('read_failed');
      const read = (await response.json()) as boolean;
      if (!read) {
        await load();
        return;
      }
      setItems((old) =>
        old.map((item) => (item.id === id ? { ...item, read_at: new Date().toISOString() } : item)),
      );
      setUnread((count) => Math.max(0, count - 1));
    } catch {
      setOffline(true);
    }
  };
  return (
    <main className="notifications-shell">
      <Link href="/">Back to home</Link>
      <header>
        <p className="eyebrow">Your centre</p>
        <h1>{text.title}</h1>
        <p className="intro">{text.intro}</p>
      </header>
      <div className="notifications-toolbar">
        <button type="button" onClick={() => void load()} disabled={busy}>
          {text.refresh}
        </button>
        {offline && <span role="status">Offline recovery mode</span>}
        <span aria-label="Unread notifications">Unread: {unread}</span>
        <button type="button" onClick={() => void markAll()} disabled={busy || unread === 0}>
          {text.markAll}
        </button>
      </div>
      <label className="notification-filter">
        {text.category}
        <select value={category} onChange={(event) => setCategory(event.target.value)}>
          <option value="all">{text.all}</option>
          <option value="letters">Letters</option>
          <option value="messages">Messages</option>
          <option value="connections">Connections</option>
          <option value="introductions">Introductions</option>
          <option value="events">Events</option>
          <option value="circles">Circles</option>
          <option value="critical-safety">Safety</option>
        </select>
      </label>
      {error && <p role="alert">{error}</p>}
      {busy ? (
        <p role="status">Loading…</p>
      ) : (
        <ul className="notification-list">
          {items.map((item) => (
            <li key={item.id} className={item.read_at ? 'is-read' : 'is-unread'}>
              <div>
                <strong>{item.message ?? 'You have a new notification.'}</strong>
                <small>
                  {new Intl.DateTimeFormat(locale, {
                    dateStyle: 'medium',
                    timeStyle: 'short',
                    timeZone,
                  }).format(new Date(item.created_at))}
                </small>
              </div>
              {!item.read_at && (
                <button type="button" onClick={() => void mark(item.id)}>
                  {text.mark}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {nextCursor && (
        <button type="button" onClick={() => void loadMore()}>
          {text.loadMore}
        </button>
      )}
      {preferences && (
        <details className="notification-settings">
          <summary>{text.settings}</summary>
          {preferences.items.map((item, index) => (
            <label key={`${item.channel}:${item.category}`}>
              {item.channel} / {item.category}
              <input
                type="checkbox"
                checked={item.enabled}
                disabled={item.category === 'critical-safety'}
                onChange={(event) => updatePreference(index, { enabled: event.target.checked })}
              />
              {item.category === 'critical-safety' && <small>{text.criticalPolicy}</small>}
              <input
                aria-label={`${item.channel} ${item.category} quiet start`}
                type="number"
                min={0}
                max={1439}
                value={item.quiet_start_minute}
                disabled={item.category === 'critical-safety'}
                onChange={(event) =>
                  updatePreference(index, { quiet_start_minute: Number(event.target.value) })
                }
              />
              <input
                aria-label={`${item.channel} ${item.category} quiet end`}
                type="number"
                min={0}
                max={1439}
                value={item.quiet_end_minute}
                disabled={item.category === 'critical-safety'}
                onChange={(event) =>
                  updatePreference(index, { quiet_end_minute: Number(event.target.value) })
                }
              />
              <select
                aria-label={`${item.channel} ${item.category} digest`}
                value={item.digest_cadence}
                disabled={item.category === 'critical-safety'}
                onChange={(event) =>
                  updatePreference(index, {
                    digest_cadence: event.target.value as Preference['digest_cadence'],
                  })
                }
              >
                <option value="immediate">immediate</option>
                <option value="daily">daily</option>
                <option value="weekly">weekly</option>
              </select>
            </label>
          ))}
          <button type="button" onClick={() => void savePreferences()}>
            {text.save}
          </button>
          {preferenceMessage && <span role="status">{preferenceMessage}</span>}
        </details>
      )}
    </main>
  );
}
