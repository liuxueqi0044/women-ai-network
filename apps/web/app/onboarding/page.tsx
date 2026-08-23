'use client';

import { useEffect, useMemo, useState } from 'react';
import './onboarding.css';

const API = process.env['NEXT_PUBLIC_API_BASE_URL'] ?? 'http://127.0.0.1:3100/v1';
const STORAGE_KEY = 'wai:onboarding:draft:v1';
const modes = ['friends', 'activities', 'professional', 'circles', 'events', 'dating'] as const;
const strengths = [
  'hard_requirement',
  'strong_preference',
  'weak_preference',
  'does_not_matter',
] as const;
type Mode = (typeof modes)[number];
type Purpose = 'discovery' | 'profile';
type Strength = (typeof strengths)[number];
type Preference = {
  mode: Mode;
  criterion:
    | 'communication_style'
    | 'values'
    | 'boundaries'
    | 'community'
    | 'pace'
    | 'availability';
  strength: Strength;
  value: string;
  deal_breaker: boolean;
};
type Session = {
  session_id: string;
  purpose: Purpose;
  modes: Mode[];
  modes_version: number;
  dating_enabled: boolean;
  state: string;
  version: number;
  answer_revision: number;
};
type Proposal = {
  proposal_id: string;
  session_id: string;
  purpose: Purpose;
  mode: Mode;
  answer_revision: number;
  modes_version: number;
  proposal_version: number;
  state: string;
  expires_at: string;
  preferences: Preference[];
};
type Preferences = {
  account_id: string;
  purpose: Purpose;
  version: number;
  modes: Mode[];
  modes_version: number;
  preferences: Preference[];
  confirmed_at: string;
};
type Draft = {
  purpose: Purpose;
  selected: Mode[];
  datingConfirm: boolean;
  importance: Strength;
  step: number;
};
type ResumeState = {
  session: Session;
  preferences: Preferences | null;
  proposal: Proposal | null;
  consent: { consent_id: string; receipt_version: number; granted: boolean } | null;
};

class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
function operationKey() {
  return `${crypto.randomUUID()}-${crypto.randomUUID()}`;
}
async function request<T>(
  path: string,
  init: RequestInit = {},
  idempotencyKey?: string,
): Promise<T> {
  const response = await fetch(`${API}${path}`, {
    ...init,
    credentials: 'include',
    headers: {
      ...(init.body ? { 'content-type': 'application/json' } : {}),
      ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}),
      ...(init.headers ?? {}),
    },
  });
  const payload = (await response.json().catch(() => ({}))) as { message?: string; code?: string };
  if (!response.ok)
    throw new ApiError(
      response.status,
      payload.message ?? payload.code ?? `Request failed (${response.status})`,
    );
  return payload as T;
}

export default function OnboardingPage() {
  const [purpose, setPurpose] = useState<Purpose>('discovery');
  const [selected, setSelected] = useState<Mode[]>(['friends']);
  const [activeMode, setActiveMode] = useState<Mode>('friends');
  const [datingConfirm, setDatingConfirm] = useState(false);
  const [answers, setAnswers] = useState<Partial<Record<Mode, string>>>({});
  const [step, setStep] = useState(1);
  const [importance, setImportance] = useState<Strength>('strong_preference');
  const [session, setSession] = useState<Session>();
  const [proposal, setProposal] = useState<Proposal>();
  const [preferences, setPreferences] = useState<Preferences>();
  const [consent, setConsent] = useState<{
    consent_id: string;
    receipt_version: number;
    granted: boolean;
  }>();
  const [correction, setCorrection] = useState('');
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const dating = selected.includes('dating');
  const draft = useMemo<Draft>(
    () => ({
      purpose,
      selected,
      datingConfirm,
      importance,
      step,
    }),
    [datingConfirm, importance, purpose, selected, step],
  );

  async function loadServerState(targetPurpose = purpose) {
    setLoading(true);
    setError('');
    try {
      const value = await request<ResumeState>(`/onboarding/state?purpose=${targetPurpose}`);
      setSession(value.session);
      setPreferences(value.preferences ?? undefined);
      setProposal(value.proposal ?? undefined);
      setConsent(value.consent ?? undefined);
      setSelected(value.session.modes);
      setActiveMode(value.session.modes[0] ?? 'friends');
      setDatingConfirm(value.session.dating_enabled);
      setStep(value.proposal ? 3 : value.preferences ? 4 : value.session.answer_revision ? 3 : 2);
      setStatus('Your server-saved onboarding state is ready.');
    } catch (value) {
      if (value instanceof ApiError && value.status === 404) {
        setSession(undefined);
        setPreferences(undefined);
        setProposal(undefined);
        setConsent(undefined);
        setStep(1);
        setStatus('No saved onboarding session. You can start a new one.');
      } else showError(value);
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    let targetPurpose: Purpose = purpose;
    if (stored) {
      try {
        const value = JSON.parse(stored) as Draft;
        if (
          'answer' in value ||
          'session' in value ||
          'proposal' in value ||
          'preferences' in value ||
          'consent' in value
        ) {
          window.localStorage.removeItem(STORAGE_KEY);
          void loadServerState(targetPurpose);
          return;
        }
        targetPurpose = value.purpose;
        setPurpose(value.purpose);
        setSelected(value.selected);
        setDatingConfirm(value.datingConfirm);
        setImportance(value.importance);
        setStep(value.step);
      } catch {
        window.localStorage.removeItem(STORAGE_KEY);
      }
    }
    void loadServerState(targetPurpose);
  }, []);
  useEffect(() => {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(draft));
  }, [draft]);
  function showError(value: unknown) {
    setStatus('');
    setError(
      value instanceof ApiError ? `${value.status}: ${value.message}` : 'Something went wrong',
    );
  }
  async function run(action: () => Promise<void>) {
    setLoading(true);
    setError('');
    try {
      await action();
    } catch (value) {
      showError(value);
    } finally {
      setLoading(false);
    }
  }

  async function createSession() {
    await run(async () => {
      const value = await request<Session>(
        '/onboarding/sessions',
        {
          method: 'POST',
          body: JSON.stringify({ purpose, modes: selected, dating_enabled: dating }),
        },
        operationKey(),
      );
      setSession(value);
      setActiveMode(value.modes[0] ?? 'friends');
      setStep(2);
      setStatus('Session saved. Your next answer is optional.');
    });
  }
  async function resumeSession() {
    await run(() => loadServerState(purpose));
  }
  async function saveAnswer(skip: boolean) {
    if (!session) return createSession();
    await run(async () => {
      let value = session;
      if (!skip && answers[activeMode]?.trim()) {
        value = await request<Session>(
          `/onboarding/sessions/${session.session_id}/answers`,
          {
            method: 'POST',
            body: JSON.stringify({
              purpose,
              mode: activeMode,
              revision: session.answer_revision,
              text: answers[activeMode],
            }),
          },
          operationKey(),
        );
        setSession(value);
      }
      setStep(3);
      setStatus(
        skip ? 'Manual path selected. Nothing was sent to an AI provider.' : 'Answer saved.',
      );
    });
  }
  function manualPreferences(): Preference[] {
    const existing = preferences?.preferences.filter((item) => item.mode === activeMode) ?? [];
    if (!answers[activeMode]?.trim()) return existing;
    return [
      {
        mode: activeMode,
        criterion: 'communication_style',
        strength: importance,
        value: answers[activeMode]!.trim().slice(0, 160),
        deal_breaker: importance === 'hard_requirement',
      },
    ];
  }
  async function saveManual() {
    if (!session) return;
    await run(async () => {
      const existing = preferences?.preferences.filter((item) => item.mode === activeMode) ?? [];
      if (!answers[activeMode]?.trim() && existing.length > 0) {
        setStep(4);
        setStatus('Existing choices kept. Add a note before replacing this mode.');
        return;
      }
      const value = await request<Preferences>(
        '/onboarding/preferences',
        {
          method: 'PUT',
          body: JSON.stringify({
            purpose,
            modes: session.modes,
            mode: activeMode,
            modes_version: session.modes_version,
            expected_version: preferences?.version ?? 0,
            preferences: manualPreferences(),
            ...(dating ? { confirm_dating: true } : {}),
          }),
        },
        operationKey(),
      );
      setPreferences(value);
      setStep(4);
      setStatus('Saved manually. You remain in control.');
    });
  }
  async function requestAiDraft() {
    if (!session) return;
    await run(async () => {
      const provider = process.env['NEXT_PUBLIC_ONBOARDING_PROVIDER'] ?? 'unconfigured';
      const receipt = await request<{
        consent_id: string;
        receipt_version: number;
        granted: boolean;
      }>(
        '/onboarding/consent',
        {
          method: 'POST',
          body: JSON.stringify({
            purpose,
            provider,
            receipt_version: consent?.receipt_version ?? 1,
            retention: 'session',
            granted: true,
          }),
        },
        operationKey(),
      );
      setConsent(receipt);
      const value = await request<Proposal>(
        `/onboarding/sessions/${session.session_id}/extract`,
        {
          method: 'POST',
          body: JSON.stringify({
            purpose,
            mode: activeMode,
            session_id: session.session_id,
            provider,
            consent_id: receipt.consent_id,
            expected_answer_revision: session.answer_revision,
            modes_version: session.modes_version,
          }),
        },
        operationKey(),
      );
      setProposal(value);
      setActiveMode(value.mode);
      setStatus('AI suggestion loaded for your review. It is not active.');
    });
  }

  function selectMode(mode: Mode) {
    setActiveMode(mode);
  }

  function toggleMode(mode: Mode) {
    setSelected((current) => {
      const next = current.includes(mode)
        ? current.filter((value) => value !== mode)
        : [...current, mode];
      if (next.length > 0 && !next.includes(activeMode)) setActiveMode(next[0]!);
      return next;
    });
  }

  function modeTabs(available: readonly Mode[]) {
    return (
      <div className="mode-tabs" role="tablist" aria-label="Active relationship mode">
        {available.map((mode) => (
          <button
            type="button"
            role="tab"
            aria-selected={activeMode === mode}
            className={activeMode === mode ? 'selected' : 'secondary'}
            key={mode}
            onClick={() => selectMode(mode)}
          >
            {mode.charAt(0).toUpperCase() + mode.slice(1)}
          </button>
        ))}
      </div>
    );
  }
  async function confirmDraft() {
    if (!session || !proposal) return;
    await run(async () => {
      const value = await request<Preferences>(
        '/onboarding/confirm',
        {
          method: 'POST',
          body: JSON.stringify({
            purpose,
            session_id: session.session_id,
            proposal_id: proposal.proposal_id,
            expected_version: preferences?.version ?? 0,
            expected_answer_revision: proposal.answer_revision,
            modes_version: proposal.modes_version,
            modes: session.modes,
            preferences: proposal.preferences,
            ...(dating ? { confirm_dating: true } : {}),
          }),
        },
        operationKey(),
      );
      setPreferences(value);
      setStep(4);
      setStatus('Confirmed only the preferences you reviewed.');
    });
  }
  async function correctDraft() {
    if (!session || !proposal || !correction.trim()) return;
    await run(async () => {
      const value = await request<{ proposal_id: string; proposal_version: number }>(
        '/onboarding/correct',
        {
          method: 'POST',
          body: JSON.stringify({
            purpose,
            session_id: session.session_id,
            proposal_id: proposal.proposal_id,
            expected_version: preferences?.version ?? 0,
            expected_proposal_version: proposal.proposal_version ?? 1,
            field: proposal.preferences[0]?.criterion ?? 'communication_style',
            correction: correction.trim(),
          }),
        },
        operationKey(),
      );
      setProposal(await request<Proposal>(`/onboarding/proposals/${purpose}/${value.proposal_id}`));
      setCorrection('');
      setStatus('Correction saved as a new pending proposal. Review it before confirming.');
    });
  }
  async function withdrawConsent() {
    if (!consent?.granted) return;
    await run(async () => {
      const provider = process.env['NEXT_PUBLIC_ONBOARDING_PROVIDER'] ?? 'unconfigured';
      await request(
        `/onboarding/consent/${purpose}/${provider}`,
        {
          method: 'DELETE',
          headers: { 'x-consent-receipt-version': String(consent.receipt_version + 1) },
        },
        operationKey(),
      );
      setConsent(undefined);
      setStatus('Provider consent withdrawn. Manual onboarding remains available.');
    });
  }

  return (
    <main className="onboarding-shell" aria-busy={loading}>
      <a href="/" className="back-link">
        ← Home
      </a>
      <header>
        <p className="eyebrow">ONBOARDING · YOUR CHOICES</p>
        <h1>Find your pace.</h1>
        <p className="intro">
          A short, member-led setup for intentional connections. You can edit everything later.
        </p>
      </header>
      <div className="progress" aria-label={`Step ${step} of 4`}>
        <span style={{ width: `${step * 25}%` }} />
      </div>
      <div className="status" role="status" aria-live="polite">
        {loading ? 'Saving…' : status}
      </div>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {step === 1 && (
        <section aria-labelledby="mode-title">
          <h2 id="mode-title">What are you open to?</h2>
          <p>Select each relationship mode deliberately. Nothing is activated by a draft.</p>
          <label className="field-label" htmlFor="purpose">
            Purpose
          </label>
          <select
            id="purpose"
            value={purpose}
            onChange={(e) => setPurpose(e.target.value as Purpose)}
          >
            <option value="discovery">Discovery</option>
            <option value="profile">Profile</option>
          </select>
          <div className="mode-grid">
            {modes.map((mode) => (
              <label className={`choice ${selected.includes(mode) ? 'selected' : ''}`} key={mode}>
                <input
                  type="checkbox"
                  checked={selected.includes(mode)}
                  onChange={() => toggleMode(mode)}
                />
                <span>{mode.charAt(0).toUpperCase() + mode.slice(1)}</span>
              </label>
            ))}
          </div>
          {dating && (
            <label className="explicit">
              <input
                type="checkbox"
                checked={datingConfirm}
                onChange={(e) => setDatingConfirm(e.target.checked)}
              />{' '}
              I explicitly want to enable Dating questions and understand this is separate from
              other modes.
            </label>
          )}
          <div className="actions">
            <button
              disabled={loading || selected.length === 0 || (dating && !datingConfirm)}
              onClick={createSession}
            >
              Create session
            </button>
            <button className="secondary" disabled={loading} onClick={resumeSession}>
              Resume saved session
            </button>
          </div>
        </section>
      )}
      {step === 2 && (
        <section aria-labelledby="answer-title">
          <h2 id="answer-title">Tell us in your own words</h2>
          <p>This is optional. The manual path is complete without AI.</p>
          {modeTabs(session?.modes ?? selected)}
          <label htmlFor="answer">What would make a connection feel worthwhile?</label>
          <textarea
            id="answer"
            rows={7}
            maxLength={5000}
            value={answers[activeMode] ?? ''}
            onChange={(e) =>
              setAnswers((current) => ({ ...current, [activeMode]: e.target.value }))
            }
            placeholder="For example: slow conversations, shared creative projects…"
          />
          <div className="actions">
            <button className="secondary" disabled={loading} onClick={() => void saveAnswer(true)}>
              Skip to manual review
            </button>
            <button disabled={loading} onClick={() => void saveAnswer(false)}>
              Save and review
            </button>
          </div>
        </section>
      )}
      {step === 3 && session && (
        <section aria-labelledby="review-title">
          <h2 id="review-title">Review your choices</h2>
          {modeTabs(session.modes)}
          <p className="draft-label">Manual summary · editable</p>
          <label htmlFor="answer">What would make a connection feel worthwhile?</label>
          <textarea
            id="answer"
            rows={4}
            maxLength={5000}
            value={answers[activeMode] ?? ''}
            onChange={(e) =>
              setAnswers((current) => ({ ...current, [activeMode]: e.target.value }))
            }
            placeholder="Add an optional note before replacing this mode…"
          />
          <dl>
            <dt>Modes</dt>
            <dd>{session.modes.join(', ')}</dd>
            <dt>Your note</dt>
            <dd>{answers[activeMode] || 'No note added for this mode'}</dd>
            <dt>Current saved values</dt>
            <dd>
              {preferences?.preferences.filter((item) => item.mode === activeMode).length
                ? preferences.preferences
                    .filter((item) => item.mode === activeMode)
                    .map((item) => (
                      <span key={`${item.mode}-${item.criterion}`}>
                        {item.criterion}: {item.value} · {item.strength}
                      </span>
                    ))
                : 'None yet'}
            </dd>
            <dt>Importance</dt>
            <dd>
              <select
                aria-label="Importance"
                value={importance}
                onChange={(e) => setImportance(e.target.value as Strength)}
              >
                {strengths.map((v) => (
                  <option key={v} value={v}>
                    {v.replaceAll('_', ' ')}
                  </option>
                ))}
              </select>
            </dd>
          </dl>
          <p className="privacy-note">
            AI may suggest editable preferences only when you separately provide provider and
            retention consent. It cannot confirm identity, age, gender, Dating, connections,
            notifications, or publication.
          </p>
          {proposal && proposal.mode === activeMode && (
            <div className="proposal" aria-label="AI suggestion">
              <strong>Pending suggestion</strong>
              {proposal.preferences.map((item) => (
                <p key={item.criterion}>
                  {item.criterion}: {item.value} · {item.strength}
                </p>
              ))}
              <label htmlFor="correction">Correct this suggestion</label>
              <input
                id="correction"
                value={correction}
                onChange={(e) => setCorrection(e.target.value)}
                placeholder="Write the value you want"
              />
              <div className="actions">
                <button
                  className="secondary"
                  disabled={loading || !correction.trim()}
                  onClick={correctDraft}
                >
                  Save correction
                </button>
                <button disabled={loading} onClick={confirmDraft}>
                  Confirm reviewed suggestion
                </button>
              </div>
            </div>
          )}
          <div className="actions">
            <button className="secondary" disabled={loading} onClick={() => void saveManual()}>
              Save manually
            </button>
            <button
              className="secondary"
              disabled={loading || activeMode === 'dating'}
              onClick={requestAiDraft}
            >
              Request editable AI suggestion
            </button>
            {consent?.granted && (
              <button className="danger" disabled={loading} onClick={withdrawConsent}>
                Withdraw provider consent
              </button>
            )}
          </div>
        </section>
      )}
      {step === 4 && preferences && (
        <section aria-labelledby="done-title">
          <h2 id="done-title">Saved, with your control intact.</h2>
          <p>
            Your choices are version {preferences.version} for {preferences.purpose}. You can
            replace or correct them later.
          </p>
          <button className="secondary" onClick={() => setStep(3)}>
            Edit choices
          </button>
        </section>
      )}
    </main>
  );
}
