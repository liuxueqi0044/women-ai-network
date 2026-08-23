'use client';
import { useEffect, useState } from 'react';
import './introductions.css';
type Mode = 'friends' | 'activities' | 'professional' | 'circles' | 'events' | 'dating';
type Candidate = {
  id: string;
  mode: Mode;
  subject: { display_name: string };
  reasons: string[];
  explanation: string;
  decision: 'interested' | 'pass' | null;
  outcome: 'mutual' | 'none' | null;
};
const API = process.env['NEXT_PUBLIC_API_BASE_URL'] ?? 'http://127.0.0.1:3100/v1';
function key() {
  return crypto.randomUUID() + '-' + crypto.randomUUID();
}
export default function IntroductionsPage() {
  const [mode, setMode] = useState<Mode>('friends');
  const [items, setItems] = useState<Candidate[]>([]);
  const [batch, setBatch] = useState('');
  const [message, setMessage] = useState('');
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  async function load(cursor?: string | null, append = false) {
    setLoading(true);
    const query = new URLSearchParams({ mode, limit: '10' });
    if (cursor) query.set('cursor', cursor);
    const response = await fetch(API + '/introductions?' + query.toString(), {
      credentials: 'include',
    });
    const value = await response.json();
    if (!response.ok) throw new Error(value.message ?? 'Introductions unavailable');
    setItems((current) =>
      append ? [...current, ...(value.candidates ?? [])] : (value.candidates ?? []),
    );
    setBatch(value.batch_id ?? '');
    setNextCursor(value.next_cursor ?? null);
    setMessage('');
    setLoading(false);
  }
  useEffect(() => {
    setNextCursor(null);
    void load().catch((e: Error) => {
      setLoading(false);
      setMessage(e.message);
    });
  }, [mode]);
  async function decide(item: Candidate, decision: 'interested' | 'pass') {
    const response = await fetch(API + '/introductions/' + item.id + '/' + decision, {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json', 'idempotency-key': key() },
      body: JSON.stringify({ batch_id: batch }),
    });
    const value = await response.json();
    if (!response.ok) {
      setMessage(value.message ?? 'Could not save decision');
      return;
    }
    setItems((current) =>
      current.map((entry) =>
        entry.id === item.id ? { ...entry, decision, outcome: value.outcome } : entry,
      ),
    );
    setMessage(
      value.outcome === 'mutual' ? 'Mutual interest — connection setup is ready.' : 'Saved.',
    );
  }
  return (
    <main className="introductions-shell">
      <header>
        <p className="eyebrow">A small, intentional set</p>
        <h1>Introductions</h1>
        <p>These are bounded, deterministic suggestions with no endless feed.</p>
      </header>
      <label htmlFor="mode">Relationship mode</label>
      <select id="mode" value={mode} onChange={(e) => setMode(e.target.value as Mode)}>
        {(['friends', 'activities', 'professional', 'circles', 'events', 'dating'] as Mode[]).map(
          (v) => (
            <option key={v}>{v}</option>
          ),
        )}
      </select>
      {message && (
        <p role="status" className="status">
          {message}
        </p>
      )}
      <button
        className="refresh"
        type="button"
        onClick={() =>
          void load().catch((e: Error) => {
            setLoading(false);
            setMessage(e.message);
          })
        }
        disabled={loading}
      >
        {loading ? 'Loading…' : 'Refresh batch'}
      </button>
      <section aria-live="polite">
        {items.length === 0 ? (
          <p>No introductions are available right now. Try again after the refresh window.</p>
        ) : (
          items.map((item) => (
            <article key={item.id}>
              <h2>{item.subject.display_name}</h2>
              <p className="mode">{item.mode}</p>
              <p>{item.explanation}</p>
              <p className="reasons">Reasons: {item.reasons.join(' · ')}</p>
              {item.outcome === 'mutual' && <p className="mutual">Mutual interest</p>}
              <div className="actions">
                <button
                  disabled={item.decision !== null}
                  onClick={() => void decide(item, 'interested')}
                >
                  Interested
                </button>
                <button
                  className="secondary"
                  disabled={item.decision !== null}
                  onClick={() => void decide(item, 'pass')}
                >
                  Pass
                </button>
              </div>
            </article>
          ))
        )}
      </section>
      {nextCursor && (
        <button
          className="load-more"
          type="button"
          onClick={() =>
            void load(nextCursor, true).catch((e: Error) => {
              setLoading(false);
              setMessage(e.message);
            })
          }
          disabled={loading}
        >
          Load next introductions
        </button>
      )}
    </main>
  );
}
