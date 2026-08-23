'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import './messages.css';
import {
  conversationInitials,
  conversationKind,
  conversationResponse,
  conversationTitle,
  filterConversations,
  messageAction,
  type ConversationFilter,
} from '../../src/messages-state';
import { formatGlobalizationMessage, type GlobalizationMessageKey } from '@wai/contracts';
import { useGlobalization } from '../../src/globalization-store';
import { getWebApiBaseUrl } from '../../src/lib/web-api-base';
import { MobileIcon } from '../../src/components/mobile-icon';

type CircleContext = {
  circle_id: string;
  name: string;
  member_count: number;
  role: 'owner' | 'moderator' | 'member';
};
type Conversation = {
  id: string;
  participant_account_id?: string | null;
  participant_display_name?: string | null;
  conversation_type?: 'direct' | 'circle';
  circle_context?: CircleContext | null;
  mode: string;
  opening_reference: { delivery_id: string; revision: number; source_hash: string } | null;
  opening_context: {
    status: 'delivered_reference';
    original_locale: string | null;
    machine_translation_available: boolean;
  } | null;
  created_at?: string;
  updated_at?: string;
  last_message_preview?: string | null;
  last_message_at?: string;
  last_message?: Message | null;
  unread_count?: number;
};
type Message = {
  id: string;
  sender_account_id: string;
  sender_display_name?: string | null;
  owned_by_actor?: boolean;
  server_sequence: string;
  body: string | null;
  state: 'active' | 'withdrawn';
  created_at: string;
};

const previewConversation: Conversation = {
  id: 'mobile-preview-conversation',
  participant_account_id: '00000000-0000-4000-8000-000000000021',
  participant_display_name: 'Aisha Rahman',
  conversation_type: 'direct',
  mode: 'friends',
  opening_reference: {
    delivery_id: '00000000-0000-4000-8000-000000000031',
    revision: 1,
    source_hash: 'a'.repeat(64),
  },
  opening_context: {
    status: 'delivered_reference',
    original_locale: 'zh-Hans-CN',
    machine_translation_available: true,
  },
  created_at: '2026-08-21T09:38:00.000Z',
  updated_at: '2026-08-21T10:26:00.000Z',
};

const previewInboxConversations: Conversation[] = [
  {
    ...previewConversation,
    last_message_preview: '谢谢你分享成都的生活。你写到清晨散步的那一段……',
    last_message_at: '2026-08-21T10:24:00.000Z',
    unread_count: 2,
  },
  {
    id: 'mobile-preview-circle-conversation',
    participant_account_id: null,
    participant_display_name: null,
    conversation_type: 'circle',
    circle_context: {
      circle_id: '00000000-0000-4000-8000-000000000041',
      name: '晨光书友圈',
      member_count: 8,
      role: 'member',
    },
    mode: 'friends',
    opening_reference: null,
    opening_context: null,
    created_at: '2026-08-18T07:30:00.000Z',
    updated_at: '2026-08-21T09:46:00.000Z',
    last_message_preview: 'Mina：这本书的第二章让我很有共鸣。',
    last_message_at: '2026-08-21T09:46:00.000Z',
    unread_count: 1,
  },
  {
    id: 'mobile-preview-letter-conversation',
    participant_account_id: '00000000-0000-4000-8000-000000000051',
    participant_display_name: 'Leila Haddad',
    conversation_type: 'direct',
    mode: 'friends',
    opening_reference: {
      delivery_id: '00000000-0000-4000-8000-000000000061',
      revision: 1,
      source_hash: 'b'.repeat(64),
    },
    opening_context: {
      status: 'delivered_reference',
      original_locale: 'fr-FR',
      machine_translation_available: true,
    },
    created_at: '2026-08-20T16:12:00.000Z',
    updated_at: '2026-08-20T16:12:00.000Z',
    last_message_preview: '发来一封私人信：关于书、写作与她的城市……',
    last_message_at: '2026-08-20T16:12:00.000Z',
    unread_count: 0,
  },
];

const previewMessages: Message[] = [
  {
    id: 'mobile-preview-message-incoming',
    sender_account_id: '00000000-0000-4000-8000-000000000021',
    owned_by_actor: false,
    server_sequence: '1',
    body: '谢谢你分享成都的生活。你写到清晨散步的那一段，让我想起了自己的城市。',
    state: 'active',
    created_at: '2026-08-21T10:24:00.000Z',
  },
  {
    id: 'mobile-preview-message-sent',
    sender_account_id: '00000000-0000-4000-8000-000000000011',
    owned_by_actor: true,
    server_sequence: '2',
    body: '很高兴这封信让你产生共鸣。下次我想听听你所在城市的故事，也许我们可以从一本共同喜欢的书聊起。',
    state: 'active',
    created_at: '2026-08-21T10:26:00.000Z',
  },
];

const API = getWebApiBaseUrl();
const browserConfirm = (message: string): boolean => {
  const confirmFn = (globalThis as { confirm?: (value: string) => boolean }).confirm;
  return confirmFn?.(message) ?? false;
};
const textareaValue = (event: { currentTarget: unknown }): string => {
  const target = event.currentTarget;
  if (typeof target !== 'object' || target === null || !('value' in target)) return '';
  return typeof target.value === 'string' ? target.value : '';
};
const shortMode = (mode: string): string =>
  mode ? `${mode.slice(0, 1).toLocaleUpperCase()}${mode.slice(1)}` : '';
const formattedDate = (value: string | undefined, locale: string): string => {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric' }).format(date);
};
const formattedTime = (value: string, locale: string): string => {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat(locale, { hour: 'numeric', minute: '2-digit' }).format(date);
};
const conversationActivityAt = (conversation: Conversation): string | undefined =>
  conversation.last_message?.created_at ?? conversation.last_message_at ?? conversation.updated_at;
const conversationPreview = (conversation: Conversation, withdrawnLabel: string): string | null =>
  conversation.last_message?.state === 'withdrawn'
    ? withdrawnLabel
    : (conversation.last_message?.body ?? conversation.last_message_preview ?? null);

export default function MessagesPage() {
  const { locale: uiLocale } = useGlobalization();
  const isChinese = uiLocale === 'zh-Hans-CN';
  const copy = useCallback(
    (key: GlobalizationMessageKey, params?: Readonly<Record<string, string | number>>) =>
      formatGlobalizationMessage(uiLocale, key, params),
    [uiLocale],
  );
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [selected, setSelected] = useState<Conversation | null>(null);
  const [filter, setFilter] = useState<ConversationFilter>('all');
  const [query, setQuery] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const [messages, setMessages] = useState<Message[]>([]);
  const [draft, setDraft] = useState('');
  const [aiDraft, setAiDraft] = useState('');
  const [notice, setNotice] = useState('');
  const [offline, setOffline] = useState(false);
  const [busy, setBusy] = useState(false);
  const [previewConversationData, setPreviewConversationData] = useState(false);
  const [incomingNotice, setIncomingNotice] = useState<Conversation | null>(null);
  const currentConversationId = useRef<string | null>(null);
  const conversationGeneration = useRef(0);
  const historyAbort = useRef<AbortController | null>(null);
  const actionAbort = useRef<AbortController | null>(null);
  const inboxSnapshot = useRef(
    new Map<string, { lastMessageId: string | null; unreadCount: number }>(),
  );
  const readThrough = useRef(new Map<string, string>());
  const pendingSend = useRef<{
    conversationId: string;
    generation: number;
    clientMessageId: string;
    idempotencyKey: string;
    body: string;
  } | null>(null);
  const isCurrent = useCallback(
    (conversationId: string, generation: number) =>
      currentConversationId.current === conversationId &&
      conversationGeneration.current === generation,
    [],
  );
  const request = useCallback(async (path: string, init?: RequestInit) => {
    const response = await fetch(`${API}${path}`, {
      credentials: 'include',
      ...init,
      headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
    });
    if (!response.ok)
      throw new Error(
        ((await response.json().catch(() => ({}))) as { message?: string }).message ??
          'Request unavailable',
      );
    return response.json();
  }, []);

  const publishUnread = useCallback((items: readonly Conversation[]) => {
    const unreadCount = items.reduce((total, item) => total + (item.unread_count ?? 0), 0);
    globalThis.dispatchEvent(new CustomEvent('wai:messages-unread', { detail: { unreadCount } }));
  }, []);

  const updateConversationUnread = useCallback(
    (conversationId: string, unreadCount: number) => {
      setConversations((current) => {
        const next = current.map((item) =>
          item.id === conversationId ? { ...item, unread_count: unreadCount } : item,
        );
        publishUnread(next);
        return next;
      });
    },
    [publishUnread],
  );

  const clearThread = useCallback(() => {
    historyAbort.current?.abort();
    actionAbort.current?.abort();
    currentConversationId.current = null;
    conversationGeneration.current += 1;
    pendingSend.current = null;
    setBusy(false);
    setMessages([]);
    setAiDraft('');
    setDraft('');
    setSelected(null);
  }, []);

  const load = useCallback(
    async (silent = false) => {
      const preview =
        typeof window === 'undefined'
          ? null
          : new URLSearchParams(window.location.search).get('preview');
      if (preview === 'message-sent') {
        setPreviewConversationData(true);
        setIncomingNotice(null);
        setConversations([previewConversation]);
        setSelected(previewConversation);
        setMessages(previewMessages);
        setOffline(false);
        setNotice('消息已发送 · 仅用于手机端视觉预览');
        return;
      }
      if (preview === 'message-incoming') {
        setPreviewConversationData(true);
        setIncomingNotice(previewInboxConversations[0]!);
        setConversations(previewInboxConversations);
        publishUnread(previewInboxConversations);
        setSelected(null);
        setMessages(previewMessages);
        setOffline(false);
        setNotice('');
        return;
      }
      setPreviewConversationData(false);
      if (!silent) setNotice(copy('messages.loading'));
      try {
        const data = (await request('/conversations?limit=50')) as { items: Conversation[] };
        const circleRequested =
          typeof window !== 'undefined' &&
          new URLSearchParams(window.location.search).has('circle');
        const mobileInbox =
          typeof window !== 'undefined' && window.matchMedia('(max-width: 720px)').matches;
        const nextSnapshot = new Map<
          string,
          { lastMessageId: string | null; unreadCount: number }
        >();
        let newestIncoming: Conversation | null = null;
        for (const item of data.items) {
          const unreadCount = item.unread_count ?? 0;
          const lastMessageId = item.last_message?.id ?? null;
          nextSnapshot.set(item.id, { lastMessageId, unreadCount });
          const prior = inboxSnapshot.current.get(item.id);
          const arrived =
            unreadCount > 0 &&
            (prior === undefined ||
              unreadCount > prior.unreadCount ||
              lastMessageId !== prior.lastMessageId);
          if (!newestIncoming && arrived) newestIncoming = item;
        }
        inboxSnapshot.current = nextSnapshot;
        setConversations(data.items);
        publishUnread(data.items);
        if (newestIncoming && newestIncoming.id !== currentConversationId.current)
          setIncomingNotice(newestIncoming);
        if (circleRequested) setFilter('circles');
        setSelected((current) =>
          circleRequested
            ? null
            : current
              ? (data.items.find((item) => item.id === current.id) ?? data.items[0] ?? null)
              : mobileInbox
                ? null
                : (data.items[0] ?? null),
        );
        if (!silent) {
          setOffline(false);
          setNotice(
            circleRequested
              ? copy('messages.circleUnavailable')
              : data.items.length
                ? ''
                : copy('messages.empty'),
          );
        }
      } catch (error) {
        if (!silent) {
          setOffline(true);
          setNotice(error instanceof Error ? error.message : 'Unable to load conversations');
        }
      }
    },
    [copy, publishUnread, request],
  );

  useEffect(() => {
    void load(false);
  }, [load]);

  useEffect(() => {
    if (previewConversationData) return;
    const poll = globalThis.setInterval(() => void load(true), 8_000);
    return () => globalThis.clearInterval(poll);
  }, [load, previewConversationData]);

  useEffect(() => {
    if (!selected) return;
    if (previewConversationData) {
      currentConversationId.current = selected.id;
      setMessages(previewMessages);
      setOffline(false);
      return;
    }
    const controller = new AbortController();
    const conversationId = selected.id;
    if (currentConversationId.current !== conversationId) {
      currentConversationId.current = conversationId;
      conversationGeneration.current += 1;
    }
    const generation = conversationGeneration.current;
    historyAbort.current?.abort();
    historyAbort.current = controller;
    const recover = async () => {
      try {
        const data = (await request(`/conversations/${conversationId}/messages?limit=100`, {
          signal: controller.signal,
        })) as { items: Message[] };
        const currentItems = conversationResponse({
          selectedId: currentConversationId.current,
          generation: conversationGeneration.current,
          responseId: conversationId,
          responseGeneration: generation,
          items: data.items.slice().reverse(),
        });
        if (!currentItems) return;
        setMessages(currentItems);
        setNotice('');
        const latestIncoming = [...currentItems]
          .reverse()
          .find((message) =>
            message.owned_by_actor !== undefined
              ? !message.owned_by_actor
              : selected.participant_account_id === message.sender_account_id,
          );
        if (
          latestIncoming &&
          readThrough.current.get(conversationId) !== latestIncoming.server_sequence
        ) {
          const marked = (await request(`/conversations/${conversationId}/read`, {
            method: 'POST',
            signal: controller.signal,
            body: JSON.stringify({ through_message_id: latestIncoming.id }),
          })) as { unread_count: number };
          if (!isCurrent(conversationId, generation)) return;
          readThrough.current.set(conversationId, latestIncoming.server_sequence);
          updateConversationUnread(conversationId, marked.unread_count);
        }
      } catch (error) {
        if (controller.signal.aborted || !isCurrent(conversationId, generation)) return;
        setNotice(error instanceof Error ? error.message : 'Unable to recover messages');
      }
    };
    void recover();
    const poll = globalThis.setInterval(() => void recover(), 10000);
    return () => {
      controller.abort();
      if (historyAbort.current === controller) historyAbort.current = null;
      globalThis.clearInterval(poll);
    };
  }, [selected, request, isCurrent, previewConversationData, updateConversationUnread]);

  const visibleConversations = useMemo(
    () => filterConversations(conversations, filter, query),
    [conversations, filter, query],
  );
  const directCount = useMemo(
    () => conversations.filter((item) => conversationKind(item) === 'direct').length,
    [conversations],
  );
  const circleCount = conversations.length - directCount;
  const selectedKind = selected ? conversationKind(selected) : null;
  const selectedParticipantId = selected?.participant_account_id ?? null;

  function selectConversation(conversation: Conversation) {
    historyAbort.current?.abort();
    actionAbort.current?.abort();
    currentConversationId.current = conversation.id;
    conversationGeneration.current += 1;
    setBusy(false);
    setMessages([]);
    setAiDraft('');
    setDraft('');
    if (incomingNotice?.id === conversation.id) setIncomingNotice(null);
    setSelected(conversation);
  }

  function selectFilter(next: ConversationFilter) {
    if (next === filter) return;
    clearThread();
    setFilter(next);
  }

  function actionForMessage(message: Message): 'report' | 'withdraw' {
    if (message.owned_by_actor !== undefined) return message.owned_by_actor ? 'withdraw' : 'report';
    if (selectedKind === 'direct' && selectedParticipantId)
      return messageAction(message.sender_account_id, selectedParticipantId);
    return 'report';
  }

  async function send() {
    if (!selected || !draft.trim()) return;
    if (previewConversationData) {
      setMessages((current) => [
        ...current,
        {
          id: crypto.randomUUID(),
          sender_account_id: '00000000-0000-4000-8000-000000000011',
          owned_by_actor: true,
          server_sequence: String(current.length + 1),
          body: draft.trim(),
          state: 'active',
          created_at: new Date().toISOString(),
        },
      ]);
      setDraft('');
      setNotice('消息已发送 · 演示数据不会写入服务器');
      return;
    }
    const conversationId = selected.id;
    const generation = conversationGeneration.current;
    const body = draft;
    const prior = pendingSend.current;
    const operation =
      prior &&
      prior.conversationId === conversationId &&
      prior.generation === generation &&
      prior.body === body
        ? prior
        : {
            conversationId,
            generation,
            body,
            clientMessageId: crypto.randomUUID(),
            idempotencyKey: crypto.randomUUID() + crypto.randomUUID(),
          };
    pendingSend.current = operation;
    const controller = new AbortController();
    actionAbort.current?.abort();
    actionAbort.current = controller;
    setBusy(true);
    try {
      const sent = (await request(`/conversations/${conversationId}/messages`, {
        method: 'POST',
        signal: controller.signal,
        headers: { 'idempotency-key': operation.idempotencyKey },
        body: JSON.stringify({
          client_message_id: operation.clientMessageId,
          body: operation.body,
        }),
      })) as Message;
      if (!isCurrent(conversationId, generation)) return;
      setMessages((all) => [...all, sent]);
      setDraft('');
      setAiDraft('');
      pendingSend.current = null;
      setNotice('Message confirmed by server sequence ' + sent.server_sequence);
    } catch (error) {
      if (controller.signal.aborted || !isCurrent(conversationId, generation)) return;
      setNotice(error instanceof Error ? error.message : 'Message was not sent');
    } finally {
      if (isCurrent(conversationId, generation)) setBusy(false);
      if (actionAbort.current === controller) actionAbort.current = null;
    }
  }

  async function suggest() {
    if (!selected || selectedKind !== 'direct') return;
    const conversationId = selected.id;
    const generation = conversationGeneration.current;
    const controller = new AbortController();
    actionAbort.current?.abort();
    actionAbort.current = controller;
    setBusy(true);
    try {
      const result = (await request(`/conversations/${conversationId}/ai-suggestions`, {
        method: 'POST',
        signal: controller.signal,
        body: JSON.stringify({ consent: { provider: true, retention: 'short_term' } }),
      })) as { draft: string };
      if (!isCurrent(conversationId, generation)) return;
      setAiDraft(result.draft);
      setNotice(copy('messages.aiNotice'));
    } catch (error) {
      if (controller.signal.aborted || !isCurrent(conversationId, generation)) return;
      setNotice(error instanceof Error ? error.message : 'AI suggestion unavailable');
    } finally {
      if (isCurrent(conversationId, generation)) setBusy(false);
      if (actionAbort.current === controller) actionAbort.current = null;
    }
  }

  async function blockSelected() {
    if (
      !selected ||
      selectedKind !== 'direct' ||
      !selectedParticipantId ||
      !browserConfirm('Block this connection? It will close the conversation and realtime channel.')
    )
      return;
    const conversationId = selected.id;
    const generation = conversationGeneration.current;
    actionAbort.current?.abort();
    actionAbort.current = new AbortController();
    try {
      await request('/safety/blocks', {
        method: 'POST',
        signal: actionAbort.current.signal,
        body: JSON.stringify({
          blocked_account_id: selectedParticipantId,
          reason: 'unwanted_contact',
          idempotency_key: crypto.randomUUID() + crypto.randomUUID(),
        }),
      });
      if (!isCurrent(conversationId, generation)) return;
      setConversations((all) => all.filter((item) => item.id !== conversationId));
      clearThread();
      setNotice('Connection blocked.');
    } catch (error) {
      if (!isCurrent(conversationId, generation)) return;
      setNotice(error instanceof Error ? error.message : 'Block failed');
    }
  }

  async function leaveCircle() {
    const circleId = selected?.circle_context?.circle_id;
    if (
      !selected ||
      selectedKind !== 'circle' ||
      !circleId ||
      !browserConfirm('Leave this circle? You will lose access to its conversation.')
    )
      return;
    const conversationId = selected.id;
    const generation = conversationGeneration.current;
    try {
      await request(`/circles/${circleId}/leave`, {
        method: 'POST',
        headers: { 'idempotency-key': crypto.randomUUID() + crypto.randomUUID() },
        body: '{}',
      });
      if (!isCurrent(conversationId, generation)) return;
      setConversations((all) => all.filter((item) => item.id !== conversationId));
      clearThread();
      setNotice('You left the circle.');
    } catch (error) {
      if (isCurrent(conversationId, generation))
        setNotice(error instanceof Error ? error.message : 'Unable to leave the circle');
    }
  }

  async function reportMessage(message: Message) {
    if (
      !selected ||
      !browserConfirm('Report this message? An encrypted safety snapshot will be retained.')
    )
      return;
    const conversationId = selected.id;
    const generation = conversationGeneration.current;
    try {
      await request(`/conversations/${message.id}/report`, {
        method: 'POST',
        body: JSON.stringify({
          subject_account_id: message.sender_account_id,
          category: 'other',
          idempotency_key: crypto.randomUUID() + crypto.randomUUID(),
        }),
      });
      if (isCurrent(conversationId, generation)) setNotice('Report submitted.');
    } catch (error) {
      if (isCurrent(conversationId, generation))
        setNotice(error instanceof Error ? error.message : 'Report failed');
    }
  }

  async function withdrawMessage(message: Message) {
    if (!browserConfirm('Withdraw this message? A minimal tombstone remains.')) return;
    const conversationId = selected?.id;
    const generation = conversationGeneration.current;
    try {
      const result = (await request(`/messages/${message.id}/withdraw`, {
        method: 'POST',
        body: '{}',
      })) as Message;
      if (conversationId && isCurrent(conversationId, generation))
        setMessages((all) => all.map((item) => (item.id === result.id ? result : item)));
    } catch (error) {
      if (conversationId && isCurrent(conversationId, generation))
        setNotice(error instanceof Error ? error.message : 'Withdraw failed');
    }
  }

  function reportLatestIncoming() {
    const message = messages.find(
      (item) => item.state === 'active' && actionForMessage(item) === 'report',
    );
    if (message) void reportMessage(message);
    else setNotice('There is no message to report.');
  }

  const emptyListMessage = query.trim()
    ? copy('messages.noMatches')
    : filter === 'circles'
      ? copy('messages.circleUnavailable')
      : copy('messages.empty');

  return (
    <>
      <main
        className={`mobile-experience mobile-messages-screen${selected ? ' mobile-messages-screen--thread' : ''}`}
        aria-busy={busy}
      >
        {!selected ? (
          <>
            <header className="mobile-editorial-header">
              <div>
                <p>PRIVATE · CIRCLES</p>
                <h1>{copy('common.nav.messages')}</h1>
              </div>
              <div className="mobile-header-actions">
                <button
                  className="mobile-header-icon"
                  type="button"
                  aria-label={copy('messages.search')}
                  aria-expanded={searchOpen}
                  onClick={() => setSearchOpen((value) => !value)}
                >
                  <MobileIcon name="search" />
                </button>
                <a className="mobile-header-icon" href="/connect" aria-label="Find connections">
                  <MobileIcon name="compose" />
                </a>
              </div>
            </header>

            {searchOpen ? (
              <label className="mobile-search-popover">
                <MobileIcon name="search" />
                <span className="sr-only">{copy('messages.search')}</span>
                <input
                  autoFocus
                  type="search"
                  value={query}
                  onChange={(event) => setQuery(event.currentTarget.value)}
                  placeholder={copy('messages.search')}
                />
                <button
                  type="button"
                  onClick={() => {
                    setQuery('');
                    setSearchOpen(false);
                  }}
                >
                  ×
                </button>
              </label>
            ) : null}

            {incomingNotice ? (
              <button
                className="mobile-incoming-toast"
                type="button"
                aria-label={`打开 ${conversationTitle(incomingNotice)} 的新消息`}
                onClick={() => selectConversation(incomingNotice)}
              >
                <span
                  className={`mobile-conversation-avatar is-${conversationKind(incomingNotice)}`}
                  aria-hidden="true"
                >
                  {conversationInitials(incomingNotice)}
                </span>
                <span>
                  <strong>{conversationTitle(incomingNotice)} 发来新消息</strong>
                  <small>
                    {conversationPreview(incomingNotice, '消息已撤回') ?? '打开查看新消息'}
                  </small>
                </span>
                <em>查看</em>
              </button>
            ) : null}

            {visibleConversations.length ? (
              <nav className="mobile-conversation-list" aria-label={copy('messages.connections')}>
                {visibleConversations.map((conversation) => {
                  const kind = conversationKind(conversation);
                  const meta =
                    kind === 'circle'
                      ? copy('messages.memberCount', {
                          count: conversation.circle_context?.member_count ?? 0,
                        })
                      : copy('messages.privateConversation');
                  return (
                    <button
                      key={conversation.id}
                      type="button"
                      className="mobile-conversation-row"
                      onClick={() => selectConversation(conversation)}
                    >
                      <span className={`mobile-conversation-avatar is-${kind}`} aria-hidden="true">
                        {conversationInitials(conversation)}
                      </span>
                      <span className="mobile-conversation-copy">
                        <span>
                          <strong>{conversationTitle(conversation)}</strong>
                          <time>
                            {formattedDate(conversationActivityAt(conversation), uiLocale)}
                          </time>
                        </span>
                        <small>{meta}</small>
                        <em>
                          {conversationPreview(
                            conversation,
                            isChinese ? '消息已撤回' : 'Message withdrawn',
                          ) ??
                            (conversation.opening_reference
                              ? copy('messages.openingLetter')
                              : kind === 'circle'
                                ? copy('messages.privacyCircle')
                                : shortMode(conversation.mode))}
                        </em>
                      </span>
                      {(conversation.unread_count ?? 0) > 0 ? (
                        <span
                          className="mobile-unread-badge"
                          aria-label={`${conversation.unread_count} 条未读消息`}
                        >
                          {(conversation.unread_count ?? 0) > 99
                            ? '99+'
                            : conversation.unread_count}
                        </span>
                      ) : (
                        <span className="mobile-row-chevron" aria-hidden="true">
                          ›
                        </span>
                      )}
                    </button>
                  );
                })}
              </nav>
            ) : (
              <section className="mobile-empty-conversations">
                <div className="mobile-orbit-mark" aria-hidden="true">
                  <span>W</span>
                </div>
                <p>YOUR CONVERSATIONS</p>
                <h2>{isChinese ? '从一次真诚的连接开始。' : 'Begin with intention.'}</h2>
                <span>{emptyListMessage}</span>
                <div>
                  <a href="/connect">{isChinese ? '寻找联系人' : 'Find a connection'}</a>
                  <a href="/world">{isChinese ? '阅读世界来信' : 'Read the world'}</a>
                </div>
              </section>
            )}

            {notice ? (
              <p className="mobile-inline-notice" role={offline ? 'alert' : 'status'}>
                {notice}
              </p>
            ) : null}
          </>
        ) : (
          <section className="mobile-thread-screen" aria-label={copy('messages.conversation')}>
            <header className="mobile-thread-header">
              <button type="button" onClick={clearThread} aria-label="Back to conversations">
                <svg aria-hidden="true" viewBox="0 0 24 24">
                  <path d="m15 5-7 7 7 7" />
                </svg>
              </button>
              <span
                className={`mobile-conversation-avatar is-${selectedKind ?? 'direct'}`}
                aria-hidden="true"
              >
                {conversationInitials(selected)}
              </span>
              <div>
                <h1>{conversationTitle(selected)}</h1>
                <p>
                  {selectedKind === 'circle'
                    ? `${copy('messages.memberCount', { count: selected.circle_context?.member_count ?? 0 })} · ${selected.circle_context?.role ?? 'member'}`
                    : `${copy('messages.privateConversation')} · ${shortMode(selected.mode)}`}
                </p>
              </div>
              <button
                type="button"
                className="mobile-thread-more"
                onClick={
                  selectedKind === 'direct' ? () => void blockSelected() : () => void leaveCircle()
                }
                aria-label={
                  selectedKind === 'direct' ? copy('messages.block') : copy('messages.leaveCircle')
                }
              >
                ···
              </button>
            </header>

            {selected.opening_reference ? (
              <aside className="mobile-opening-letter">
                <span aria-hidden="true">✦</span>
                <div>
                  <strong>{copy('messages.openingLetter')}</strong>
                  <p>Revision {selected.opening_reference.revision} · A deliberate beginning</p>
                </div>
              </aside>
            ) : null}

            <div className="mobile-thread-messages" aria-live="polite">
              <p className="mobile-thread-day">TODAY</p>
              {messages.map((message) => {
                const action = actionForMessage(message);
                return (
                  <article
                    key={message.id}
                    className={`mobile-message-bubble${action === 'withdraw' ? ' is-own' : ''}${message.state === 'withdrawn' ? ' is-withdrawn' : ''}`}
                  >
                    {selectedKind === 'circle' && message.sender_display_name ? (
                      <strong>{message.sender_display_name}</strong>
                    ) : null}
                    <p>{message.body ?? 'Message withdrawn'}</p>
                    <footer>
                      <time>{formattedTime(message.created_at, uiLocale)}</time>
                      {message.state === 'active' ? (
                        <button
                          type="button"
                          onClick={() =>
                            action === 'report'
                              ? void reportMessage(message)
                              : void withdrawMessage(message)
                          }
                        >
                          {action === 'report'
                            ? copy('messages.report')
                            : copy('messages.withdraw')}
                        </button>
                      ) : null}
                    </footer>
                  </article>
                );
              })}
              {!messages.length ? (
                <div className="mobile-thread-empty">
                  <span aria-hidden="true">✦</span>
                  <p>{copy('messages.empty')}</p>
                  <small>
                    {selectedKind === 'circle'
                      ? copy('messages.privacyCircle')
                      : copy('messages.privacyDirect')}
                  </small>
                </div>
              ) : null}
            </div>

            {aiDraft ? (
              <aside className="mobile-ai-draft">
                <strong>{copy('messages.aiNotice')}</strong>
                <p>{aiDraft}</p>
                <div>
                  <button
                    type="button"
                    onClick={() => {
                      setDraft(aiDraft);
                      setAiDraft('');
                    }}
                  >
                    {copy('messages.useDraft')}
                  </button>
                  <button type="button" onClick={() => setAiDraft('')}>
                    {copy('messages.discard')}
                  </button>
                </div>
              </aside>
            ) : null}

            <form
              className="mobile-composer"
              onSubmit={(event) => {
                event.preventDefault();
                void send();
              }}
            >
              {selectedKind === 'direct' ? (
                <button
                  type="button"
                  className="mobile-ai-action"
                  onClick={() => void suggest()}
                  disabled={busy}
                  aria-label={copy('messages.suggestDraft')}
                >
                  ✦
                </button>
              ) : null}
              <textarea
                aria-label={copy('messages.action')}
                value={draft}
                onChange={(event) => setDraft(textareaValue(event))}
                placeholder={
                  selectedKind === 'circle'
                    ? copy('messages.circlePlaceholder')
                    : copy('messages.writePlaceholder')
                }
                rows={1}
              />
              <button type="submit" className="mobile-send-action" disabled={busy || !draft.trim()}>
                <svg aria-hidden="true" viewBox="0 0 24 24">
                  <path d="m4 12 16-8-5 16-3-6-8-2Z" />
                </svg>
                <span className="sr-only">{copy('messages.send')}</span>
              </button>
            </form>
          </section>
        )}
      </main>

      <main className="messages-shell desktop-experience">
        <header className="messages-header">
          <div>
            <a className="messages-back" href="/world">
              ← {copy('common.nav.world')}
            </a>
            <p className="messages-eyebrow">{copy('messages.inboxEyebrow')}</p>
            <h1>{copy('messages.title')}</h1>
          </div>
          <p className="privacy-note">{copy('messages.description')}</p>
        </header>

        <div className={`messages-layout${selected ? ' has-selection' : ''}`}>
          <aside className="inbox-pane">
            <div className="inbox-heading">
              <div>
                <p className="inbox-kicker">{copy('messages.connections')}</p>
                <h2>{copy('messages.title')}</h2>
              </div>
              <span className="inbox-total" aria-label={`${conversations.length} conversations`}>
                {conversations.length}
              </span>
            </div>

            <div className="conversation-tabs" role="tablist" aria-label={copy('messages.title')}>
              {(
                [
                  ['all', 'messages.all', conversations.length],
                  ['private', 'messages.private', directCount],
                  ['circles', 'messages.circles', circleCount],
                ] as const
              ).map(([value, label, count]) => (
                <button
                  key={value}
                  type="button"
                  role="tab"
                  aria-selected={filter === value}
                  className={filter === value ? 'conversation-tab active' : 'conversation-tab'}
                  onClick={() => selectFilter(value)}
                >
                  {copy(label)} <span>{count}</span>
                </button>
              ))}
            </div>

            <label className="conversation-search">
              <span className="sr-only">{copy('messages.search')}</span>
              <span aria-hidden="true">⌕</span>
              <input
                type="search"
                value={query}
                onChange={(event) => setQuery(event.currentTarget.value)}
                placeholder={copy('messages.search')}
              />
            </label>

            <nav aria-label={copy('messages.connections')} className="conversation-list">
              {visibleConversations.map((conversation) => {
                const kind = conversationKind(conversation);
                const meta =
                  kind === 'circle'
                    ? copy('messages.memberCount', {
                        count: conversation.circle_context?.member_count ?? 0,
                      })
                    : shortMode(conversation.mode);
                return (
                  <button
                    key={conversation.id}
                    type="button"
                    className={
                      selected?.id === conversation.id ? 'conversation active' : 'conversation'
                    }
                    aria-current={selected?.id === conversation.id ? 'page' : undefined}
                    onClick={() => selectConversation(conversation)}
                  >
                    <span className={`conversation-avatar ${kind}`} aria-hidden="true">
                      {conversationInitials(conversation)}
                    </span>
                    <span className="conversation-copy">
                      <strong>{conversationTitle(conversation)}</strong>
                      <small>
                        {kind === 'circle'
                          ? copy('messages.circleConversation')
                          : copy('messages.privateConversation')}{' '}
                        · {meta}
                      </small>
                      {conversationPreview(
                        conversation,
                        isChinese ? '消息已撤回' : 'Message withdrawn',
                      ) ? (
                        <em>
                          {conversationPreview(
                            conversation,
                            isChinese ? '消息已撤回' : 'Message withdrawn',
                          )}
                        </em>
                      ) : null}
                    </span>
                    <span className="conversation-trailing">
                      <time>{formattedDate(conversationActivityAt(conversation), uiLocale)}</time>
                      {(conversation.unread_count ?? 0) > 0 ? (
                        <i aria-label={`${conversation.unread_count} unread messages`}>
                          {(conversation.unread_count ?? 0) > 99
                            ? '99+'
                            : conversation.unread_count}
                        </i>
                      ) : null}
                    </span>
                  </button>
                );
              })}
              {!visibleConversations.length && <p className="inbox-empty">{emptyListMessage}</p>}
            </nav>
          </aside>

          <section aria-label={copy('messages.conversation')} className="thread">
            {!selected ? (
              <div className="thread-placeholder">
                <span className="thread-placeholder-mark" aria-hidden="true">
                  ✉
                </span>
                <h2>{copy('messages.selectConversation')}</h2>
                <p>{copy('messages.description')}</p>
              </div>
            ) : (
              <>
                <div className="thread-top">
                  <button type="button" className="mobile-inbox-back" onClick={clearThread}>
                    ← {copy('messages.backToInbox')}
                  </button>
                  <div className="thread-identity">
                    <span
                      className={`thread-avatar ${selectedKind ?? 'direct'}`}
                      aria-hidden="true"
                    >
                      {conversationInitials(selected)}
                    </span>
                    <div>
                      <div className="thread-title-row">
                        <h2>{conversationTitle(selected)}</h2>
                        <span className={`kind-badge ${selectedKind ?? 'direct'}`}>
                          {selectedKind === 'circle'
                            ? copy('messages.circleConversation')
                            : copy('messages.privateConversation')}
                        </span>
                      </div>
                      <p>
                        {selectedKind === 'circle'
                          ? `${copy('messages.memberCount', { count: selected.circle_context?.member_count ?? 0 })} · ${selected.circle_context?.role ?? 'member'}`
                          : shortMode(selected.mode)}
                      </p>
                    </div>
                  </div>
                  <div className="thread-actions">
                    {selectedKind === 'direct' ? (
                      <button type="button" onClick={() => void blockSelected()}>
                        {copy('messages.block')}
                      </button>
                    ) : (
                      <button type="button" onClick={() => void leaveCircle()}>
                        {copy('messages.leaveCircle')}
                      </button>
                    )}
                    <button type="button" onClick={reportLatestIncoming}>
                      {copy('messages.report')}
                    </button>
                  </div>
                </div>

                {selected.opening_reference && (
                  <aside className="opening-letter">
                    <div>
                      <span>{copy('messages.openingLetter')}</span>
                      <strong>Revision {selected.opening_reference.revision}</strong>
                    </div>
                    <p>
                      {selected.opening_context?.original_locale ?? 'Original locale unavailable'} ·{' '}
                      {selected.opening_context?.machine_translation_available
                        ? 'Translation available'
                        : 'Original only'}
                    </p>
                  </aside>
                )}

                <div className="thread-body" aria-live="polite">
                  <p className="thread-privacy">
                    {selectedKind === 'circle'
                      ? copy('messages.privacyCircle')
                      : copy('messages.privacyDirect')}
                  </p>
                  {messages.map((message) => {
                    const action = actionForMessage(message);
                    const bubbleClasses = [
                      'bubble',
                      action === 'withdraw' ? 'bubble-own' : '',
                      message.state === 'withdrawn' ? 'withdrawn' : '',
                    ]
                      .filter(Boolean)
                      .join(' ');
                    return (
                      <article key={message.id} className={bubbleClasses}>
                        {selectedKind === 'circle' && message.sender_display_name && (
                          <strong className="message-author">{message.sender_display_name}</strong>
                        )}
                        <p>{message.body ?? 'Message withdrawn'}</p>
                        <div className="message-meta">
                          <small>
                            {message.state === 'withdrawn'
                              ? copy('messages.withdraw')
                              : formattedTime(message.created_at, uiLocale)}
                          </small>
                          {message.state === 'active' && (
                            <button
                              type="button"
                              onClick={() =>
                                action === 'report'
                                  ? void reportMessage(message)
                                  : void withdrawMessage(message)
                              }
                            >
                              {action === 'report'
                                ? copy('messages.report')
                                : copy('messages.withdraw')}
                            </button>
                          )}
                        </div>
                      </article>
                    );
                  })}
                  {!messages.length && <p className="thread-empty">{copy('messages.empty')}</p>}
                </div>

                <form
                  className="composer"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void send();
                  }}
                >
                  <textarea
                    aria-label={copy('messages.action')}
                    value={draft}
                    onChange={(event) => setDraft(textareaValue(event))}
                    placeholder={
                      selectedKind === 'circle'
                        ? copy('messages.circlePlaceholder')
                        : copy('messages.writePlaceholder')
                    }
                    rows={3}
                  />
                  <div className="composer-actions">
                    <p>
                      {selectedKind === 'circle'
                        ? copy('messages.privacyCircle')
                        : copy('messages.privacyDirect')}
                    </p>
                    <div>
                      {selectedKind === 'direct' && (
                        <button
                          type="button"
                          className="secondary"
                          onClick={() => void suggest()}
                          disabled={busy}
                        >
                          {copy('messages.suggestDraft')}
                        </button>
                      )}
                      <button
                        type="submit"
                        className="send-button"
                        disabled={busy || !draft.trim()}
                      >
                        {copy('messages.send')}
                      </button>
                    </div>
                  </div>
                  {aiDraft && (
                    <aside className="ai-draft">
                      <strong>{copy('messages.aiNotice')}</strong>
                      <p>{aiDraft}</p>
                      <div>
                        <button
                          type="button"
                          onClick={() => {
                            setDraft(aiDraft);
                            setAiDraft('');
                          }}
                        >
                          {copy('messages.useDraft')}
                        </button>
                        <button type="button" className="secondary" onClick={() => setAiDraft('')}>
                          {copy('messages.discard')}
                        </button>
                      </div>
                    </aside>
                  )}
                </form>
              </>
            )}
          </section>
        </div>

        {offline && (
          <p className="offline" role="alert">
            Offline or disconnected. Reconnect to recover messages from the server.
          </p>
        )}
        {notice && (
          <p className="notice" role="status">
            {notice}
          </p>
        )}
      </main>
    </>
  );
}
