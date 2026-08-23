'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import type {
  BlockListResponse,
  BlockResponse,
  BlockReason,
  ReportCreateRequest,
  ReportResponse,
} from '@wai/contracts';
import { describeMemberApiError, makeIdempotencyKey, memberApi } from '../../src/lib/member-api';

export default function SafetyPage() {
  const [blocks, setBlocks] = useState<BlockResponse[]>([]);
  const [targetAccount, setTargetAccount] = useState('');
  const [blockReason, setBlockReason] = useState<BlockReason>('unwanted_contact');
  const [report, setReport] = useState({
    subject: '',
    type: 'account',
    target: '',
    category: 'harassment',
  });
  const [reportResult, setReportResult] = useState<ReportResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setBlocks((await memberApi<BlockListResponse>('/safety/blocks')).blocks);
    } catch (caught) {
      setError(describeMemberApiError(caught));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function block(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    try {
      await memberApi<BlockResponse>('/safety/blocks', 'POST', {
        body: {
          blocked_account_id: targetAccount.trim(),
          reason: blockReason,
          idempotency_key: makeIdempotencyKey(),
        },
      });
      setTargetAccount('');
      await load();
    } catch (caught) {
      setError(describeMemberApiError(caught));
    }
  }

  async function unblock(accountId: string) {
    try {
      await memberApi<null>(`/safety/blocks/${accountId}`, 'DELETE');
      setBlocks((items) => items.filter((item) => item.blocked_account_id !== accountId));
    } catch (caught) {
      setError(describeMemberApiError(caught));
    }
  }

  async function submitReport(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    try {
      const body: ReportCreateRequest = {
        subject_account_id: report.subject.trim(),
        target_type: report.type as ReportCreateRequest['target_type'],
        target_id: report.target.trim(),
        category: report.category as ReportCreateRequest['category'],
        idempotency_key: makeIdempotencyKey(),
      };
      setReportResult(await memberApi<ReportResponse>('/safety/reports', 'POST', { body }));
    } catch (caught) {
      setError(describeMemberApiError(caught));
    }
  }

  return (
    <div className="page-shell">
      <section className="page-hero">
        <div className="page-hero__copy">
          <p className="eyebrow">Your boundaries</p>
          <h1>Safety center</h1>
          <p>
            Blocking stops eligible interaction in both directions. Reporting preserves a safe
            evidence snapshot without copying private content into this page.
          </p>
        </div>
        <Link className="button" href="/me">
          Back to Me
        </Link>
      </section>
      {error ? (
        <div className="status-banner status-banner--error section-stack" role="alert">
          {error}
        </div>
      ) : null}
      <div className="split-layout section-stack">
        <div className="section-stack">
          <section className="panel">
            <p className="eyebrow">Active boundaries</p>
            <h2>Blocked accounts</h2>
            {loading ? (
              <div className="skeleton" />
            ) : blocks.length === 0 ? (
              <p className="empty-state">You have no active blocks.</p>
            ) : (
              blocks.map((item) => (
                <div className="list-row" key={item.id}>
                  <div className="list-row__body">
                    <strong>
                      Account · {item.blocked_account_id.slice(0, 4)}…
                      {item.blocked_account_id.slice(-4)}
                    </strong>
                    <span className="muted">
                      Blocked {new Date(item.created_at).toLocaleDateString()}
                    </span>
                  </div>
                  <button
                    className="button"
                    type="button"
                    onClick={() => unblock(item.blocked_account_id)}
                  >
                    Unblock
                  </button>
                </div>
              ))
            )}
          </section>
          <form className="panel form-stack" onSubmit={block}>
            <p className="eyebrow">Add a boundary</p>
            <h2>Block an account</h2>
            <p className="field-hint">
              Most product surfaces provide an in-context Block button. This form is the direct
              fallback when you have a trusted account reference.
            </p>
            <label className="field">
              <span>Account ID</span>
              <input
                required
                pattern="[0-9a-fA-F-]{36}"
                value={targetAccount}
                onChange={(event) => setTargetAccount(event.target.value)}
              />
            </label>
            <label className="field">
              <span>Reason</span>
              <select
                value={blockReason}
                onChange={(event) => setBlockReason(event.target.value as BlockReason)}
              >
                <option value="harassment">Harassment</option>
                <option value="unwanted_contact">Unwanted contact</option>
                <option value="safety_concern">Safety concern</option>
                <option value="privacy">Privacy</option>
                <option value="other">Other</option>
              </select>
            </label>
            <button className="button button--danger" type="submit">
              Block account
            </button>
          </form>
        </div>
        <aside className="panel">
          <p className="eyebrow">Structured report</p>
          <h2>Report a specific resource</h2>
          <p className="panel-copy">
            Use in-context Report controls whenever possible; they bind the correct subject and
            resource automatically. This advanced fallback never accepts a free-form evidence body.
          </p>
          <form className="form-stack safety-report" onSubmit={submitReport}>
            <label className="field">
              <span>Subject account ID</span>
              <input
                required
                value={report.subject}
                onChange={(event) => setReport({ ...report, subject: event.target.value })}
              />
            </label>
            <label className="field">
              <span>Resource type</span>
              <select
                value={report.type}
                onChange={(event) => setReport({ ...report, type: event.target.value })}
              >
                {['account', 'profile', 'message', 'media', 'event', 'circle', 'note'].map(
                  (item) => (
                    <option key={item} value={item}>
                      {item}
                    </option>
                  ),
                )}
              </select>
            </label>
            <label className="field">
              <span>Resource ID</span>
              <input
                required
                maxLength={256}
                value={report.target}
                onChange={(event) => setReport({ ...report, target: event.target.value })}
              />
            </label>
            <label className="field">
              <span>Category</span>
              <select
                value={report.category}
                onChange={(event) => setReport({ ...report, category: event.target.value })}
              >
                {[
                  'harassment',
                  'threats',
                  'sexual_content',
                  'hate_or_discrimination',
                  'scam_or_fraud',
                  'privacy_violation',
                  'other',
                ].map((item) => (
                  <option key={item} value={item}>
                    {item.replaceAll('_', ' ')}
                  </option>
                ))}
              </select>
            </label>
            <button className="button button--primary" type="submit">
              Submit report
            </button>
            {reportResult ? (
              <div className="status-banner status-banner--success">
                Report {reportResult.state}. Reference: {reportResult.id}
              </div>
            ) : null}
          </form>
        </aside>
      </div>
    </div>
  );
}
