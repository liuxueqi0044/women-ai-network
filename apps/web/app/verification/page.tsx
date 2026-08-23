'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import type { IdentitySessionResponse, VerificationStatus } from '@wai/contracts';
import { describeMemberApiError, makeIdempotencyKey, memberApi } from '../../src/lib/member-api';

const statusCopy: Record<string, string> = {
  not_started: 'Not started',
  session_created: 'Ready to continue',
  pending: 'Pending',
  processing: 'Processing',
  verified: 'Verified',
  retryable: 'Try again',
  requires_input: 'More information needed',
  needs_review: 'Under review',
  failed: 'Not completed',
  expired: 'Expired',
  canceled: 'Canceled',
  unverified: 'Not verified',
  attested: 'Age assured',
  mismatch: 'Needs review',
  insufficient: 'Not enough assurance',
  revoked: 'Revoked',
  not_applied: 'Not applied',
  submitted: 'Submitted',
  under_review: 'Under review',
  approved: 'Approved',
  rejected: 'Not approved',
  withdrawn: 'Withdrawn',
  none: 'None',
  upheld: 'Upheld',
  overturned: 'Overturned',
};

export default function VerificationPage() {
  const [status, setStatus] = useState<VerificationStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [starting, setStarting] = useState(false);
  const [providerReady, setProviderReady] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setStatus(await memberApi<VerificationStatus>('/verification/status'));
    } catch (caught) {
      setError(describeMemberApiError(caught));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function startIdentity() {
    setStarting(true);
    setError(null);
    try {
      const key = makeIdempotencyKey();
      await memberApi<IdentitySessionResponse>('/verification/identity/sessions', 'POST', {
        body: { idempotency_key: key },
        headers: { 'idempotency-key': key },
      });
      setProviderReady(true);
      await load();
    } catch (caught) {
      setError(describeMemberApiError(caught));
    } finally {
      setStarting(false);
    }
  }

  return (
    <div className="page-shell">
      <section className="page-hero">
        <div className="page-hero__copy">
          <p className="eyebrow">Trust without public badges</p>
          <h1>Verification</h1>
          <p>
            Identity, age assurance and community membership are separate checks. Documents and
            exact birth dates are never shown on your profile.
          </p>
        </div>
        <Link className="button" href="/me">
          Back to Me
        </Link>
      </section>

      {loading ? <div className="skeleton section-stack" /> : null}
      {error ? (
        <div className="status-banner status-banner--error section-stack" role="alert">
          {error}
        </div>
      ) : null}
      {status ? (
        <div className="verification-grid section-stack">
          <section className="panel verification-step">
            <span className="verification-step__number">01</span>
            <div>
              <p className="eyebrow">Identity</p>
              <h2>{statusCopy[status.identity] ?? status.identity}</h2>
              <p className="panel-copy">
                A private provider flow confirms identity and liveness. The network stores
                normalized outcomes, not a public document.
              </p>
              {status.identity !== 'verified' ? (
                <button
                  className="button button--primary"
                  disabled={starting}
                  type="button"
                  onClick={startIdentity}
                >
                  {starting ? 'Preparing…' : 'Begin identity check'}
                </button>
              ) : (
                <span className="pill">Complete</span>
              )}
            </div>
          </section>
          <section className="panel verification-step">
            <span className="verification-step__number">02</span>
            <div>
              <p className="eyebrow">Age assurance</p>
              <h2>{statusCopy[status.age_assurance] ?? status.age_assurance}</h2>
              <p className="panel-copy">
                Age is evaluated against current jurisdiction and feature policy. The product is not
                globally hardcoded as 18+.
              </p>
            </div>
          </section>
          <section className="panel verification-step">
            <span className="verification-step__number">03</span>
            <div>
              <p className="eyebrow">Community membership</p>
              <h2>{statusCopy[status.membership] ?? status.membership}</h2>
              <p className="panel-copy">
                Membership uses an explicit policy and consent statement. No valid public
                policy-selection endpoint exists yet, so the web app will not ask you to paste an
                internal policy ID.
              </p>
              <button className="button" type="button" disabled>
                Application temporarily unavailable
              </button>
            </div>
          </section>
        </div>
      ) : null}
      {providerReady ? (
        <div className="status-banner section-stack">
          The secure provider session was created. The production provider widget is not configured
          in this environment, so no document capture has been opened.
        </div>
      ) : null}
      {status?.obligations.length ? (
        <section className="panel section-stack">
          <p className="eyebrow">What remains</p>
          <h2>Current obligations</h2>
          <div className="tag-row">
            {status.obligations.map((item) => (
              <span className="tag" key={item}>
                {item.replaceAll('_', ' ').toLowerCase()}
              </span>
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );
}
