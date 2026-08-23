'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import type { CircleCreateRequest, CircleList, CircleMetadata } from '@wai/contracts';
import { describeMemberApiError, makeIdempotencyKey, memberApi } from '../../src/lib/member-api';

const topicOptions = [
  'culture',
  'language_exchange',
  'career',
  'study',
  'parenting',
  'wellbeing',
  'creative_practice',
  'local_life',
  'travel',
  'relationships',
  'mutual_aid',
  'books',
] as const;

export default function CirclesPage() {
  const [circles, setCircles] = useState<CircleMetadata[]>([]);
  const [modeFilter, setModeFilter] = useState('');
  const [showCreate, setShowCreate] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState({
    name: '',
    description: '',
    lifecycle: 'active',
    visibility: 'approval_required',
    mode: 'friends',
    scope_kind: 'online',
    country_code: '',
    city_label: '',
    member_cap: '20',
    topics: ['culture'] as string[],
  });

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const query = new URLSearchParams({ limit: '50' });
      if (modeFilter) query.set('mode', modeFilter);
      const value = await memberApi<CircleList>(`/circles?${query.toString()}`);
      setCircles(value.items);
    } catch (caught) {
      setError(describeMemberApiError(caught));
    } finally {
      setLoading(false);
    }
  }, [modeFilter]);

  useEffect(() => {
    void load();
  }, [load]);

  function toggleTopic(topic: string) {
    setForm((value) => ({
      ...value,
      topics: value.topics.includes(topic)
        ? value.topics.filter((item) => item !== topic)
        : [...value.topics, topic],
    }));
  }

  async function createCircle(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const body: CircleCreateRequest = {
        name: form.name.trim(),
        ...(form.description.trim() ? { description: form.description.trim() } : {}),
        lifecycle: form.lifecycle as CircleCreateRequest['lifecycle'],
        visibility: form.visibility as CircleCreateRequest['visibility'],
        mode: form.mode as CircleCreateRequest['mode'],
        scope_kind: form.scope_kind as CircleCreateRequest['scope_kind'],
        ...(form.scope_kind !== 'online'
          ? { country_code: form.country_code.trim().toUpperCase() }
          : {}),
        ...(form.scope_kind === 'city' ? { city_label: form.city_label.trim() } : {}),
        topic_catalog_version: 1,
        topics: form.topics as CircleCreateRequest['topics'],
        member_cap: Number(form.member_cap),
      };
      const created = await memberApi<CircleMetadata>('/circles', 'POST', {
        body,
        headers: { 'idempotency-key': makeIdempotencyKey() },
      });
      window.location.assign(`/circles/${created.id}`);
    } catch (caught) {
      setError(describeMemberApiError(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="page-shell">
      <section className="page-hero">
        <div className="page-hero__copy">
          <p className="eyebrow">Small private spaces</p>
          <h1>Circles</h1>
          <p>
            Gather around a clear purpose with bounded membership, explicit roles and private Notes.
          </p>
        </div>
        <button
          className="button button--primary"
          type="button"
          onClick={() => setShowCreate((value) => !value)}
        >
          {showCreate ? 'Close form' : 'Create a circle'}
        </button>
      </section>

      {showCreate ? (
        <form className="panel form-stack circle-create section-stack" onSubmit={createCircle}>
          <div>
            <p className="eyebrow">New circle</p>
            <h2>Set the room before inviting people.</h2>
            <p className="panel-copy">
              Mode cannot be changed after creation. Changing purpose later requires a new circle
              and fresh consent.
            </p>
          </div>
          <div className="form-grid">
            <label className="field">
              <span>Name</span>
              <input
                required
                maxLength={80}
                value={form.name}
                onChange={(event) => setForm({ ...form, name: event.target.value })}
              />
            </label>
            <label className="field">
              <span>Mode</span>
              <select
                value={form.mode}
                onChange={(event) => setForm({ ...form, mode: event.target.value })}
              >
                <option value="friends">Friends</option>
                <option value="activities">Activities</option>
                <option value="professional">Professional</option>
                <option value="dating">Dating</option>
              </select>
            </label>
            <label className="field">
              <span>Admission</span>
              <select
                value={form.visibility}
                onChange={(event) => setForm({ ...form, visibility: event.target.value })}
              >
                <option value="approval_required">Requests require approval</option>
                <option value="invitation_only">Invitation only</option>
              </select>
            </label>
            <label className="field">
              <span>Start as</span>
              <select
                value={form.lifecycle}
                onChange={(event) => setForm({ ...form, lifecycle: event.target.value })}
              >
                <option value="active">Active</option>
                <option value="draft">Draft</option>
              </select>
            </label>
            <label className="field">
              <span>Scope</span>
              <select
                value={form.scope_kind}
                onChange={(event) => setForm({ ...form, scope_kind: event.target.value })}
              >
                <option value="online">Online</option>
                <option value="country">Country</option>
                <option value="city">City</option>
              </select>
            </label>
            <label className="field">
              <span>Member cap</span>
              <input
                type="number"
                min={2}
                max={500}
                required
                value={form.member_cap}
                onChange={(event) => setForm({ ...form, member_cap: event.target.value })}
              />
            </label>
          </div>
          {form.scope_kind !== 'online' ? (
            <div className="form-grid">
              <label className="field">
                <span>Country code</span>
                <input
                  required
                  maxLength={2}
                  pattern="[A-Za-z]{2}"
                  placeholder="IN"
                  value={form.country_code}
                  onChange={(event) => setForm({ ...form, country_code: event.target.value })}
                />
              </label>
              {form.scope_kind === 'city' ? (
                <label className="field">
                  <span>City</span>
                  <input
                    required
                    maxLength={80}
                    value={form.city_label}
                    onChange={(event) => setForm({ ...form, city_label: event.target.value })}
                  />
                </label>
              ) : null}
            </div>
          ) : null}
          <label className="field">
            <span>Description</span>
            <textarea
              maxLength={2000}
              value={form.description}
              onChange={(event) => setForm({ ...form, description: event.target.value })}
            />
          </label>
          <fieldset className="topic-picker">
            <legend>Topics</legend>
            <div className="tag-row">
              {topicOptions.map((topic) => (
                <label
                  className={form.topics.includes(topic) ? 'topic-chip is-selected' : 'topic-chip'}
                  key={topic}
                >
                  <input
                    type="checkbox"
                    checked={form.topics.includes(topic)}
                    onChange={() => toggleTopic(topic)}
                  />
                  {topic.replaceAll('_', ' ')}
                </label>
              ))}
            </div>
          </fieldset>
          {error ? (
            <div className="status-banner status-banner--error" role="alert">
              {error}
            </div>
          ) : null}
          <button
            className="button button--primary"
            disabled={busy || form.topics.length === 0}
            type="submit"
          >
            {busy ? 'Creating…' : 'Create circle'}
          </button>
        </form>
      ) : null}

      <div className="circle-toolbar section-stack">
        <label className="field">
          <span>Show mode</span>
          <select value={modeFilter} onChange={(event) => setModeFilter(event.target.value)}>
            <option value="">All my circles</option>
            <option value="friends">Friends</option>
            <option value="activities">Activities</option>
            <option value="professional">Professional</option>
            <option value="dating">Dating</option>
          </select>
        </label>
        <p className="muted">Only circles where you are a current member appear here.</p>
      </div>
      {loading ? <div className="skeleton section-stack" /> : null}
      {!loading && !error && circles.length === 0 ? (
        <div className="empty-state section-stack">
          <h2>No circles in this view</h2>
          <p>Create a private room, or follow a trusted invitation link.</p>
        </div>
      ) : null}
      {!showCreate && error ? (
        <div className="status-banner status-banner--error section-stack" role="alert">
          {error}
        </div>
      ) : null}
      <section className="circle-grid section-stack">
        {circles.map((circle) => (
          <Link className="circle-card" href={`/circles/${circle.id}`} key={circle.id}>
            <div className="circle-card__top">
              <span className="eyebrow">
                {circle.mode} · {circle.scope_kind}
              </span>
              <span className="pill">{circle.role ?? 'private'}</span>
            </div>
            <h2>{circle.name}</h2>
            <div className="tag-row">
              {circle.topics.slice(0, 4).map((topic) => (
                <span className="tag" key={topic}>
                  {topic.replaceAll('_', ' ')}
                </span>
              ))}
            </div>
            <div className="circle-card__footer">
              <span>
                {circle.member_count} / {circle.member_cap} members
              </span>
              <span>Open →</span>
            </div>
          </Link>
        ))}
      </section>
    </div>
  );
}
