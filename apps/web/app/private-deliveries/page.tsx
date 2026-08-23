'use client';

import Link from 'next/link';
import { useState, type FormEvent } from 'react';
import { describeMemberApiError, makeIdempotencyKey, memberApi } from '../../src/lib/member-api';

export default function PrivateDeliveriesPage() {
  const [recipient, setRecipient] = useState('');
  const [letter, setLetter] = useState('');
  const [revision, setRevision] = useState('1');
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirmed, setConfirmed] = useState(false);

  async function send(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setNotice('');
    setError('');
    try {
      const payload = await memberApi<{ state?: string }>('/private-letter-deliveries', 'POST', {
        headers: { 'idempotency-key': makeIdempotencyKey() },
        body: {
          recipient_id: recipient.trim(),
          letter_id: letter.trim(),
          revision: Number(revision),
          purpose: 'private_letter_delivery',
          consent: { explicit: true },
        },
      });
      setNotice(
        `Revision ${revision} snapshot queued for this connection (${payload.state ?? 'queued'}).`,
      );
      setConfirmed(false);
    } catch (caught) {
      setError(describeMemberApiError(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="page-shell page-shell--narrow">
      <section className="page-hero">
        <div className="page-hero__copy">
          <p className="eyebrow">Private letter delivery</p>
          <h1>Send one exact revision.</h1>
          <p>
            A private letter is an introduction snapshot for one current accepted connection. It
            does not silently start a chat and it never changes after delivery.
          </p>
        </div>
        <Link className="button" href="/letters">
          Letter desk
        </Link>
      </section>
      <div className="split-layout section-stack">
        <form className="panel form-stack" onSubmit={send}>
          <p className="eyebrow">Explicit confirmation</p>
          <h2>Revision snapshot</h2>
          <label className="field">
            <span>Recipient account ID</span>
            <input
              value={recipient}
              onChange={(event) => setRecipient(event.target.value)}
              pattern="[0-9a-fA-F-]{36}"
              required
            />
          </label>
          <label className="field">
            <span>Private letter ID</span>
            <input
              value={letter}
              onChange={(event) => setLetter(event.target.value)}
              pattern="[0-9a-fA-F-]{36}"
              required
            />
          </label>
          <label className="field">
            <span>Revision number</span>
            <input
              type="number"
              min="1"
              value={revision}
              onChange={(event) => setRevision(event.target.value)}
              required
            />
          </label>
          <label className="check-field">
            <input
              type="checkbox"
              checked={confirmed}
              onChange={(event) => setConfirmed(event.target.checked)}
              required
            />
            I understand this sends the selected immutable revision to this connection.
          </label>
          {notice ? <div className="status-banner status-banner--success">{notice}</div> : null}
          {error ? (
            <div className="status-banner status-banner--error" role="alert">
              {error}
            </div>
          ) : null}
          <button
            className="button button--primary"
            type="submit"
            disabled={busy || !recipient || !letter || !confirmed}
          >
            {busy ? 'Sending…' : 'Confirm and send revision'}
          </button>
        </form>
        <aside className="panel">
          <p className="eyebrow">Before sending</p>
          <h2>Nothing is sent by AI.</h2>
          <p className="panel-copy">
            AI may help you draft elsewhere, but only this explicit confirmation creates the
            delivery. Current connection, block and eligibility rules are checked again by the
            server.
          </p>
        </aside>
      </div>
    </div>
  );
}
