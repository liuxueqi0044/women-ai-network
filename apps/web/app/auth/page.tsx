'use client';

import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import type { SessionResponse } from '@wai/contracts';
import { MemberApiError, describeMemberApiError, memberApi } from '../../src/lib/member-api';

type Mode = 'sign-in' | 'create';

export default function AuthPage() {
  const router = useRouter();
  const [mode, setMode] = useState<Mode>('sign-in');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [mfaRequired, setMfaRequired] = useState(false);
  const [mfaCode, setMfaCode] = useState('');
  const [recoveryMode, setRecoveryMode] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function finishAuthentication() {
    await memberApi<SessionResponse>('/account/sessions', 'POST', {
      body: { email: email.trim(), password },
    });
    router.replace('/me');
    router.refresh();
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setNotice(null);
    if (mode === 'create' && password !== confirmPassword) {
      setError('The passwords do not match.');
      return;
    }
    if ([...password].length < 12) {
      setError('Use at least 12 characters for your password.');
      return;
    }
    setBusy(true);
    try {
      if (mode === 'create') {
        await memberApi('/account/registrations', 'POST', {
          body: { email: email.trim(), password },
        });
        setNotice('Your account is ready. Signing you in…');
      }
      await finishAuthentication();
    } catch (caught) {
      if (caught instanceof MemberApiError && caught.code === 'MFA_REQUIRED') {
        setMfaRequired(true);
        setNotice('Enter your authenticator or recovery code to finish signing in.');
      } else {
        setError(describeMemberApiError(caught));
      }
    } finally {
      setBusy(false);
    }
  }

  async function submitMfa(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await memberApi<SessionResponse>('/account/sessions/mfa', 'POST', {
        body: recoveryMode ? { recovery_code: mfaCode } : { totp_code: mfaCode },
      });
      router.replace('/me');
      router.refresh();
    } catch (caught) {
      setError(describeMemberApiError(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="page-shell page-shell--narrow auth-page">
      <section className="auth-intro">
        <p className="eyebrow">A thoughtful global network</p>
        <h1 className="editorial-title">Enter with care.</h1>
        <p className="lede">
          Your account opens the door. Identity, membership, age eligibility and each connection
          mode are checked separately before protected features become available.
        </p>
      </section>

      <section className="panel auth-panel" aria-labelledby="auth-heading">
        {!mfaRequired ? (
          <>
            <div className="segmented-control" aria-label="Account action">
              <button
                type="button"
                className={mode === 'sign-in' ? 'is-active' : ''}
                onClick={() => setMode('sign-in')}
              >
                Sign in
              </button>
              <button
                type="button"
                className={mode === 'create' ? 'is-active' : ''}
                onClick={() => setMode('create')}
              >
                Create account
              </button>
            </div>
            <h2 id="auth-heading">{mode === 'sign-in' ? 'Welcome back' : 'Begin here'}</h2>
            <form className="form-stack" onSubmit={submit}>
              <label className="field">
                <span>Email</span>
                <input
                  type="email"
                  autoComplete="email"
                  required
                  maxLength={320}
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                />
              </label>
              <label className="field">
                <span>Password</span>
                <input
                  type="password"
                  autoComplete={mode === 'create' ? 'new-password' : 'current-password'}
                  required
                  minLength={12}
                  maxLength={128}
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                />
                {mode === 'create' ? (
                  <small className="field-hint">12–128 characters. Unicode is welcome.</small>
                ) : null}
              </label>
              {mode === 'create' ? (
                <label className="field">
                  <span>Confirm password</span>
                  <input
                    type="password"
                    autoComplete="new-password"
                    required
                    minLength={12}
                    maxLength={128}
                    value={confirmPassword}
                    onChange={(event) => setConfirmPassword(event.target.value)}
                  />
                </label>
              ) : null}
              {notice ? <div className="status-banner status-banner--success">{notice}</div> : null}
              {error ? (
                <div className="status-banner status-banner--error" role="alert">
                  {error}
                </div>
              ) : null}
              <button className="button button--primary" disabled={busy} type="submit">
                {busy ? 'Please wait…' : mode === 'sign-in' ? 'Sign in' : 'Create account'}
              </button>
            </form>
          </>
        ) : (
          <>
            <p className="eyebrow">Two-step verification</p>
            <h2 id="auth-heading">One more step</h2>
            <p className="panel-copy">
              The challenge is short-lived and remains in a secure cookie.
            </p>
            <form className="form-stack" onSubmit={submitMfa}>
              <label className="field">
                <span>{recoveryMode ? 'Recovery code' : 'Six-digit code'}</span>
                <input
                  inputMode={recoveryMode ? 'text' : 'numeric'}
                  autoComplete="one-time-code"
                  required
                  value={mfaCode}
                  onChange={(event) => setMfaCode(event.target.value)}
                />
              </label>
              {error ? (
                <div className="status-banner status-banner--error" role="alert">
                  {error}
                </div>
              ) : null}
              <div className="button-row">
                <button className="button button--primary" disabled={busy} type="submit">
                  Verify and continue
                </button>
                <button
                  className="button button--quiet"
                  type="button"
                  onClick={() => {
                    setRecoveryMode((value) => !value);
                    setMfaCode('');
                  }}
                >
                  Use {recoveryMode ? 'authenticator code' : 'recovery code'}
                </button>
              </div>
            </form>
          </>
        )}
      </section>
    </div>
  );
}
