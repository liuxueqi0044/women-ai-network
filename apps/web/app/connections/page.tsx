'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import type { ConnectionListResponse, ConnectionResponse, SessionResponse } from '@wai/contracts';
import { describeMemberApiError, makeIdempotencyKey, memberApi } from '../../src/lib/member-api';

function shortId(value: string): string {
  return `Member · ${value.slice(0, 4)}…${value.slice(-4)}`;
}

export default function ConnectionsPage() {
  const [accountId, setAccountId] = useState<string | null>(null);
  const [connections, setConnections] = useState<ConnectionResponse[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [session, list] = await Promise.all([
        memberApi<SessionResponse>('/account/session'),
        memberApi<ConnectionListResponse>('/connections?limit=100'),
      ]);
      setAccountId(session.account_id);
      setConnections(list.connections);
    } catch (caught) {
      setError(describeMemberApiError(caught));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function act(
    connection: ConnectionResponse,
    action: 'accept' | 'decline' | 'cancel' | 'disconnect',
  ) {
    setError(null);
    try {
      const path: `/${string}` =
        action === 'disconnect'
          ? `/connections/${connection.id}`
          : `/connections/requests/${connection.id}/${action}`;
      await memberApi<ConnectionResponse>(path, action === 'disconnect' ? 'DELETE' : 'POST', {
        ...(action === 'disconnect' ? {} : { body: {} }),
        headers: { 'idempotency-key': makeIdempotencyKey() },
      });
      await load();
    } catch (caught) {
      setError(describeMemberApiError(caught));
    }
  }

  return (
    <div className="page-shell">
      <section className="page-hero">
        <div className="page-hero__copy">
          <p className="eyebrow">Mutual relationships</p>
          <h1>Connections</h1>
          <p>
            Requests and active connections remain private. No public count is shown on your
            profile.
          </p>
        </div>
        <Link className="button button--primary" href="/introductions">
          View introductions
        </Link>
      </section>
      {loading ? <div className="skeleton section-stack" /> : null}
      {error ? (
        <div className="status-banner status-banner--error section-stack" role="alert">
          {error}
        </div>
      ) : null}
      {!loading && connections.length === 0 ? (
        <div className="empty-state section-stack">
          <h2>No connections yet</h2>
          <p>When an introduction becomes mutual, it will appear here.</p>
          <Link className="button" href="/introductions">
            Browse introductions
          </Link>
        </div>
      ) : null}
      <section className="connection-list section-stack">
        {connections.map((connection) => {
          const isRequester = connection.requester_account_id === accountId;
          const other = isRequester
            ? connection.recipient_account_id
            : connection.requester_account_id;
          return (
            <article className="panel connection-card" key={connection.id}>
              <div className="connection-card__avatar" aria-hidden="true">
                W
              </div>
              <div className="connection-card__body">
                <p className="eyebrow">{connection.mode}</p>
                <h2>{shortId(other)}</h2>
                <p className="muted">
                  {connection.state} · Updated{' '}
                  {new Date(connection.updated_at).toLocaleDateString()}
                </p>
                <p className="field-hint">
                  The Connections API does not yet expose the member’s safe profile projection, so
                  this page intentionally does not invent a name or photo.
                </p>
              </div>
              <div className="button-row">
                {connection.state === 'pending' && !isRequester ? (
                  <>
                    <button
                      className="button button--primary"
                      type="button"
                      onClick={() => act(connection, 'accept')}
                    >
                      Accept
                    </button>
                    <button
                      className="button"
                      type="button"
                      onClick={() => act(connection, 'decline')}
                    >
                      Decline
                    </button>
                  </>
                ) : null}
                {connection.state === 'pending' && isRequester ? (
                  <button
                    className="button"
                    type="button"
                    onClick={() => act(connection, 'cancel')}
                  >
                    Cancel request
                  </button>
                ) : null}
                {connection.state === 'accepted' ? (
                  <>
                    <Link
                      className="button button--primary"
                      href={`/messages?connection=${connection.id}`}
                    >
                      Message
                    </Link>
                    <button
                      className="button button--danger"
                      type="button"
                      onClick={() => act(connection, 'disconnect')}
                    >
                      Disconnect
                    </button>
                  </>
                ) : null}
              </div>
            </article>
          );
        })}
      </section>
    </div>
  );
}
