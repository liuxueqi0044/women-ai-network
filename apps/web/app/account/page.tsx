'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import type {
  DeviceListResponse,
  DeviceSummary,
  RecoveryRegenerateResponse,
  SessionListResponse,
  SessionResponse,
  TotpEnrollmentConfirmResponse,
  TotpEnrollmentResponse,
} from '@wai/contracts';
import { describeMemberApiError, memberApi } from '../../src/lib/member-api';

export default function AccountPage() {
  const [current, setCurrent] = useState<SessionResponse | null>(null);
  const [sessions, setSessions] = useState<SessionListResponse['sessions']>([]);
  const [devices, setDevices] = useState<DeviceSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [password, setPassword] = useState('');
  const [totp, setTotp] = useState('');
  const [disableCode, setDisableCode] = useState('');
  const [disableRecovery, setDisableRecovery] = useState(false);
  const [enrollment, setEnrollment] = useState<TotpEnrollmentResponse | null>(null);
  const [recoveryCodes, setRecoveryCodes] = useState<string[]>([]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [currentValue, sessionValue, deviceValue] = await Promise.all([
        memberApi<SessionResponse>('/account/session'),
        memberApi<SessionListResponse>('/account/sessions'),
        memberApi<DeviceListResponse>('/account/devices'),
      ]);
      setCurrent(currentValue);
      setSessions(sessionValue.sessions);
      setDevices(deviceValue.devices);
    } catch (caught) {
      setError(describeMemberApiError(caught));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function revokeSession(sessionId: string) {
    setError(null);
    try {
      await memberApi<null>(`/account/sessions/${sessionId}`, 'DELETE');
      setSessions((items) => items.filter((item) => item.session_id !== sessionId));
    } catch (caught) {
      setError(describeMemberApiError(caught));
    }
  }

  async function rotateSession() {
    setError(null);
    try {
      const value = await memberApi<SessionResponse>('/account/session/rotate', 'POST');
      setCurrent(value);
      setNotice('Your current session was securely rotated.');
      await load();
    } catch (caught) {
      setError(describeMemberApiError(caught));
    }
  }

  async function renameDevice(device: DeviceSummary) {
    const next = window.prompt('Name this device', device.label)?.trim();
    if (!next || next === device.label) return;
    try {
      const updated = await memberApi<DeviceSummary>(
        `/account/devices/${device.device_id}`,
        'PATCH',
        {
          body: { label: next },
        },
      );
      setDevices((items) =>
        items.map((item) => (item.device_id === updated.device_id ? updated : item)),
      );
    } catch (caught) {
      setError(describeMemberApiError(caught));
    }
  }

  async function revokeDevice(deviceId: string) {
    if (!window.confirm('Revoke this device and every active session attached to it?')) return;
    try {
      await memberApi<null>(`/account/devices/${deviceId}`, 'DELETE');
      await load();
    } catch (caught) {
      setError(describeMemberApiError(caught));
    }
  }

  async function startMfa(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    try {
      const value = await memberApi<TotpEnrollmentResponse>(
        '/account/mfa/totp/enrollment',
        'POST',
        {
          body: { password },
        },
      );
      setEnrollment(value);
      setPassword('');
    } catch (caught) {
      setError(describeMemberApiError(caught));
    }
  }

  async function confirmMfa(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    try {
      const value = await memberApi<TotpEnrollmentConfirmResponse>(
        '/account/mfa/totp/enrollment/confirm',
        'POST',
        { body: { totp_code: totp } },
      );
      setRecoveryCodes(value.recovery_codes);
      setEnrollment(null);
      setTotp('');
      setNotice('Two-step verification is now enabled. Save the recovery codes below once.');
      await load();
    } catch (caught) {
      setError(describeMemberApiError(caught));
    }
  }

  async function regenerateCodes(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    try {
      const value = await memberApi<RecoveryRegenerateResponse>(
        '/account/mfa/recovery-codes/regenerate',
        'POST',
        { body: { password } },
      );
      setRecoveryCodes(value.recovery_codes);
      setPassword('');
    } catch (caught) {
      setError(describeMemberApiError(caught));
    }
  }

  async function disableMfa(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!window.confirm('Disable two-step verification and revoke your other sessions?')) return;
    try {
      await memberApi<null>('/account/mfa/totp', 'DELETE', {
        body: {
          password,
          ...(disableRecovery ? { recovery_code: disableCode } : { totp_code: disableCode }),
        },
      });
      setPassword('');
      setDisableCode('');
      setNotice('Two-step verification was disabled and the current session was rotated.');
      await load();
    } catch (caught) {
      setError(describeMemberApiError(caught));
    }
  }

  return (
    <div className="page-shell">
      <section className="page-hero">
        <div className="page-hero__copy">
          <p className="eyebrow">Security</p>
          <h1>Account & devices</h1>
          <p>
            Review where you are signed in and strengthen access without exposing session tokens.
          </p>
        </div>
        <Link className="button" href="/me">
          Back to Me
        </Link>
      </section>

      {loading ? (
        <div className="skeleton section-stack" aria-label="Loading security settings" />
      ) : null}
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
          <div className="section-stack account-main">
            <section className="panel">
              <p className="eyebrow">Active sessions</p>
              <h2>Signed-in places</h2>
              <div className="list-stack">
                {sessions.map((session) => (
                  <div className="list-row" key={session.session_id}>
                    <div className="list-row__body">
                      <strong>
                        {session.session_id === current?.session_id
                          ? 'This session'
                          : 'Other session'}
                      </strong>
                      <span className="muted">
                        {session.auth_level.toUpperCase()} · Last active{' '}
                        {new Date(session.last_seen_at).toLocaleString()}
                      </span>
                    </div>
                    {session.session_id !== current?.session_id ? (
                      <button
                        className="button button--danger"
                        type="button"
                        onClick={() => revokeSession(session.session_id)}
                      >
                        Revoke
                      </button>
                    ) : (
                      <span className="pill">current</span>
                    )}
                  </div>
                ))}
              </div>
              <button className="button" type="button" onClick={rotateSession}>
                Rotate current session
              </button>
            </section>

            <section className="panel">
              <p className="eyebrow">Recognized devices</p>
              <h2>Devices</h2>
              {devices.length === 0 ? (
                <p className="muted">No device records are available.</p>
              ) : null}
              <div className="list-stack">
                {devices.map((device) => (
                  <div className="list-row" key={device.device_id}>
                    <div className="list-row__body">
                      <strong>{device.label}</strong>
                      <span className="muted">
                        {device.summary} · Seen {new Date(device.last_seen_at).toLocaleString()}
                      </span>
                    </div>
                    <div className="button-row">
                      <button
                        className="button button--quiet"
                        type="button"
                        onClick={() => renameDevice(device)}
                      >
                        Rename
                      </button>
                      <button
                        className="button button--danger"
                        type="button"
                        onClick={() => revokeDevice(device.device_id)}
                      >
                        Revoke
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </section>
          </div>

          <aside className="panel account-mfa">
            <p className="eyebrow">Two-step verification</p>
            <h2>{current?.auth_level === 'aal2' ? 'Protected by TOTP' : 'Add an authenticator'}</h2>
            {current?.auth_level === 'aal2' ? (
              <div className="form-stack">
                <form className="form-stack" onSubmit={regenerateCodes}>
                  <p className="panel-copy">
                    Regenerating codes invalidates every unused previous recovery code.
                  </p>
                  <label className="field">
                    <span>Current password</span>
                    <input
                      type="password"
                      required
                      minLength={12}
                      value={password}
                      onChange={(event) => setPassword(event.target.value)}
                    />
                  </label>
                  <button className="button" type="submit">
                    Generate new recovery codes
                  </button>
                </form>
                <details className="privacy-details">
                  <summary>Disable two-step verification</summary>
                  <form className="form-stack" onSubmit={disableMfa}>
                    <p className="field-hint">
                      This requires the password above plus a fresh authenticator or recovery code.
                      Other sessions will be revoked.
                    </p>
                    <label className="check-field">
                      <input
                        type="checkbox"
                        checked={disableRecovery}
                        onChange={(event) => setDisableRecovery(event.target.checked)}
                      />
                      Use a recovery code
                    </label>
                    <label className="field">
                      <span>{disableRecovery ? 'Recovery code' : 'Six-digit code'}</span>
                      <input
                        required
                        value={disableCode}
                        onChange={(event) => setDisableCode(event.target.value)}
                      />
                    </label>
                    <button className="button button--danger" type="submit">
                      Disable two-step verification
                    </button>
                  </form>
                </details>
              </div>
            ) : !enrollment ? (
              <form className="form-stack" onSubmit={startMfa}>
                <p className="panel-copy">
                  Re-enter your password before a one-time authenticator secret is created.
                </p>
                <label className="field">
                  <span>Current password</span>
                  <input
                    type="password"
                    required
                    minLength={12}
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                  />
                </label>
                <button className="button button--primary" type="submit">
                  Start setup
                </button>
              </form>
            ) : (
              <form className="form-stack" onSubmit={confirmMfa}>
                <p className="panel-copy">
                  Open this secure setup link in your authenticator, then enter the six-digit code.
                </p>
                <a className="button" href={enrollment.otpauth_uri}>
                  Open authenticator
                </a>
                <label className="field">
                  <span>Six-digit code</span>
                  <input
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    pattern="[0-9]{6}"
                    required
                    value={totp}
                    onChange={(event) => setTotp(event.target.value)}
                  />
                </label>
                <button className="button button--primary" type="submit">
                  Confirm setup
                </button>
              </form>
            )}
            {recoveryCodes.length > 0 ? (
              <div className="recovery-codes">
                <h3>Save these once</h3>
                <p className="muted">
                  They are not stored in readable form and will not be shown again.
                </p>
                <ol>
                  {recoveryCodes.map((code) => (
                    <li key={code}>
                      <code>{code}</code>
                    </li>
                  ))}
                </ol>
                <button
                  className="button"
                  type="button"
                  onClick={() => navigator.clipboard.writeText(recoveryCodes.join('\n'))}
                >
                  Copy codes
                </button>
              </div>
            ) : null}
          </aside>
        </div>
      ) : null}
    </div>
  );
}
