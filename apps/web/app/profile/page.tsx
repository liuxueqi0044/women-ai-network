'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import type {
  FactAudience,
  FactUsage,
  ProfileMutationResponse,
  ProfilePublishResponse,
  ProfileSelfView,
} from '@wai/contracts';
import {
  MemberApiError,
  describeMemberApiError,
  makeIdempotencyKey,
  memberApi,
} from '../../src/lib/member-api';

const editableFacts = [
  { key: 'about_me', title: 'About me', hint: 'A short introduction in your own voice.' },
  { key: 'interests', title: 'Interests', hint: 'Ideas, practices and subjects you enjoy.' },
  {
    key: 'availability',
    title: 'Availability',
    hint: 'Sensitive: only intended for professional and event contexts.',
  },
] as const;

export default function ProfilePage() {
  const [profile, setProfile] = useState<ProfileSelfView | null>(null);
  const [displayName, setDisplayName] = useState('');
  const [city, setCity] = useState('');
  const [countryCode, setCountryCode] = useState('');
  const [factValues, setFactValues] = useState<Record<string, string>>({});
  const [mode, setMode] = useState<FactUsage['mode']>('friends');
  const [audience, setAudience] = useState<FactAudience['audience']>('verified_members');
  const [agePartition, setAgePartition] = useState<FactAudience['age_partition']>('unknown');
  const [matchingEnabled, setMatchingEnabled] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const value = await memberApi<ProfileSelfView>('/profile/me');
      setProfile(value);
      setDisplayName(value.display_name);
      setCity(value.city ?? '');
      setCountryCode(value.country_code ?? '');
      setFactValues(
        Object.fromEntries(
          value.facts.map((fact) => [
            fact.fact_key,
            typeof fact.value === 'string' ? fact.value : String(fact.value),
          ]),
        ),
      );
    } catch (caught) {
      if (caught instanceof MemberApiError && caught.status === 404) {
        setProfile(null);
      } else {
        setError(describeMemberApiError(caught));
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  function headers(version: number) {
    return { 'if-match': `"${version}"`, 'idempotency-key': makeIdempotencyKey() };
  }

  async function saveBasics(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusyKey('basics');
    setError(null);
    try {
      await memberApi<ProfileMutationResponse>('/profile/me', 'PUT', {
        body: {
          display_name: displayName.trim(),
          ...(city.trim() ? { city: city.trim() } : {}),
          ...(countryCode.trim() ? { country_code: countryCode.trim().toUpperCase() } : {}),
        },
        headers: headers(profile?.version ?? 0),
      });
      setNotice('Profile details saved. They remain a draft until you publish.');
      await load();
    } catch (caught) {
      setError(describeMemberApiError(caught));
    } finally {
      setBusyKey(null);
    }
  }

  async function saveFact(factKey: string) {
    if (!profile) return;
    const value = factValues[factKey]?.trim();
    if (!value) return;
    setBusyKey(factKey);
    try {
      await memberApi<ProfileMutationResponse>(`/profile/me/facts/${factKey}`, 'PUT', {
        body: { value, source: 'user_confirmed' },
        headers: headers(profile.version),
      });
      await load();
      setNotice('Profile fact saved. Review its audience before publishing.');
    } catch (caught) {
      setError(describeMemberApiError(caught));
    } finally {
      setBusyKey(null);
    }
  }

  async function withdrawFact(factKey: string) {
    if (!profile || !window.confirm('Withdraw this fact from your profile?')) return;
    try {
      await memberApi<ProfileMutationResponse>(`/profile/me/facts/${factKey}`, 'DELETE', {
        headers: headers(profile.version),
      });
      await load();
    } catch (caught) {
      setError(describeMemberApiError(caught));
    }
  }

  async function savePrivacy(factKey: string) {
    if (!profile) return;
    setBusyKey(`privacy:${factKey}`);
    try {
      const usage = await memberApi<ProfileMutationResponse>(
        `/profile/me/facts/${factKey}/usage`,
        'PUT',
        {
          body: { mode, matching_enabled: matchingEnabled },
          headers: headers(profile.version),
        },
      );
      await memberApi<ProfileMutationResponse>(`/profile/me/facts/${factKey}/audience`, 'PUT', {
        body: { mode, audience, age_partition: agePartition },
        headers: headers(usage.version),
      });
      setNotice(`Privacy for ${factKey.replaceAll('_', ' ')} was set for ${mode}.`);
      await load();
    } catch (caught) {
      setError(describeMemberApiError(caught));
    } finally {
      setBusyKey(null);
    }
  }

  async function publish() {
    if (!profile) return;
    setBusyKey('publish');
    try {
      await memberApi<ProfilePublishResponse>('/profile/me/publish', 'POST', {
        headers: headers(profile.version),
      });
      setNotice('Your current profile snapshot is published.');
      await load();
    } catch (caught) {
      setError(describeMemberApiError(caught));
    } finally {
      setBusyKey(null);
    }
  }

  return (
    <div className="page-shell">
      <section className="page-hero">
        <div className="page-hero__copy">
          <p className="eyebrow">Your public presence</p>
          <h1>Profile & privacy</h1>
          <p>
            Build a clear introduction, then choose audience and matching use separately for each
            fact.
          </p>
        </div>
        <div className="button-row">
          <Link className="button" href="/me">
            Back to Me
          </Link>
          <button
            className="button button--primary"
            type="button"
            disabled={!profile || busyKey !== null}
            onClick={publish}
          >
            {busyKey === 'publish' ? 'Publishing…' : 'Publish snapshot'}
          </button>
        </div>
      </section>
      {loading ? <div className="skeleton section-stack" /> : null}
      {notice ? (
        <div className="status-banner status-banner--success section-stack">{notice}</div>
      ) : null}
      {error ? (
        <div className="status-banner status-banner--error section-stack" role="alert">
          {error}
        </div>
      ) : null}

      {!loading ? (
        <div className="split-layout section-stack">
          <div className="section-stack">
            <form className="panel form-stack" onSubmit={saveBasics}>
              <p className="eyebrow">Identity on the network</p>
              <h2>How members know you</h2>
              <label className="field">
                <span>Display name</span>
                <input
                  required
                  maxLength={80}
                  value={displayName}
                  onChange={(event) => setDisplayName(event.target.value)}
                />
              </label>
              <div className="form-grid">
                <label className="field">
                  <span>City (optional)</span>
                  <input
                    maxLength={80}
                    value={city}
                    onChange={(event) => setCity(event.target.value)}
                  />
                </label>
                <label className="field">
                  <span>Country code (optional)</span>
                  <input
                    placeholder="CN"
                    pattern="[A-Za-z]{2}"
                    maxLength={2}
                    value={countryCode}
                    onChange={(event) => setCountryCode(event.target.value)}
                  />
                </label>
              </div>
              <button className="button button--primary" disabled={busyKey !== null} type="submit">
                {busyKey === 'basics' ? 'Saving…' : profile ? 'Save details' : 'Create profile'}
              </button>
            </form>

            {profile
              ? editableFacts.map((definition) => {
                  const existing = profile.facts.find(
                    (fact) => fact.fact_key === definition.key && fact.state !== 'withdrawn',
                  );
                  const readOnly =
                    definition.key === 'availability' && !['professional', 'events'].includes(mode);
                  return (
                    <section className="panel profile-fact" key={definition.key}>
                      <div className="profile-fact__heading">
                        <div>
                          <p className="eyebrow">Profile fact</p>
                          <h2>{definition.title}</h2>
                        </div>
                        {existing ? <span className="pill">{existing.sensitivity}</span> : null}
                      </div>
                      <p className="muted">{definition.hint}</p>
                      <label className="field">
                        <span>Your words</span>
                        <textarea
                          maxLength={500}
                          value={factValues[definition.key] ?? ''}
                          onChange={(event) =>
                            setFactValues((values) => ({
                              ...values,
                              [definition.key]: event.target.value,
                            }))
                          }
                        />
                      </label>
                      <div className="button-row">
                        <button
                          className="button"
                          disabled={busyKey !== null || !factValues[definition.key]?.trim()}
                          type="button"
                          onClick={() => saveFact(definition.key)}
                        >
                          Save fact
                        </button>
                        {existing ? (
                          <button
                            className="button button--danger"
                            type="button"
                            onClick={() => withdrawFact(definition.key)}
                          >
                            Withdraw
                          </button>
                        ) : null}
                      </div>
                      {existing ? (
                        <details className="privacy-details">
                          <summary>Audience & matching use</summary>
                          <div className="form-stack">
                            <label className="field">
                              <span>Mode</span>
                              <select
                                value={mode}
                                onChange={(event) =>
                                  setMode(event.target.value as FactUsage['mode'])
                                }
                              >
                                {[
                                  'friends',
                                  'activities',
                                  'professional',
                                  'circles',
                                  'events',
                                  'dating',
                                ].map((item) => (
                                  <option key={item} value={item}>
                                    {item}
                                  </option>
                                ))}
                              </select>
                            </label>
                            {readOnly ? (
                              <p className="status-banner">
                                Availability may only be used in professional or events mode.
                              </p>
                            ) : null}
                            <label className="field">
                              <span>Audience</span>
                              <select
                                value={audience}
                                onChange={(event) =>
                                  setAudience(event.target.value as FactAudience['audience'])
                                }
                              >
                                <option value="self">Only me</option>
                                <option value="verified_members">Verified members</option>
                                <option value="connections">Connections</option>
                                <option value="nobody">Nobody</option>
                              </select>
                            </label>
                            <label className="field">
                              <span>Age partition</span>
                              <select
                                value={agePartition}
                                onChange={(event) =>
                                  setAgePartition(
                                    event.target.value as FactAudience['age_partition'],
                                  )
                                }
                              >
                                <option value="unknown">Policy decides</option>
                                <option value="youth">Youth partition</option>
                                <option value="adult">Adult partition</option>
                              </select>
                            </label>
                            <label className="check-field">
                              <input
                                type="checkbox"
                                checked={matchingEnabled}
                                onChange={(event) => setMatchingEnabled(event.target.checked)}
                              />{' '}
                              Allow this fact to help matching in this mode
                            </label>
                            <button
                              className="button"
                              disabled={readOnly || busyKey !== null}
                              type="button"
                              onClick={() => savePrivacy(definition.key)}
                            >
                              Save privacy for {mode}
                            </button>
                          </div>
                        </details>
                      ) : null}
                    </section>
                  );
                })
              : null}
          </div>
          <aside className="panel profile-preview">
            <p className="eyebrow">Preview</p>
            <h2>{displayName || 'Your name'}</h2>
            <p className="muted">
              {[city, countryCode.toUpperCase()].filter(Boolean).join(', ') ||
                'Location not shared'}
            </p>
            <div className="profile-preview__facts">
              {editableFacts.map((item) =>
                factValues[item.key]?.trim() ? (
                  <div key={item.key}>
                    <span>{item.title}</span>
                    <p>{factValues[item.key]}</p>
                  </div>
                ) : null,
              )}
            </div>
            <p className="field-hint">
              This is a self preview. Actual member and matching views remain subject to current
              audience, age-partition and relationship checks.
            </p>
            <div className="status-banner profile-media-boundary">
              Profile photo upload will open after production media storage and scanning adapters
              are connected. No local-only image is shown as if it were published.
            </div>
          </aside>
        </div>
      ) : null}
    </div>
  );
}
