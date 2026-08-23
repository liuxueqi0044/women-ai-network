'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import type {
  circleJoinRequestsSchema,
  circleMembersSchema,
  circleNotesSchema,
  CircleDetail,
  SessionResponse,
} from '@wai/contracts';
import type { z } from 'zod';
import {
  MemberApiError,
  describeMemberApiError,
  makeIdempotencyKey,
  memberApi,
} from '../../../src/lib/member-api';

type CircleNotes = z.infer<typeof circleNotesSchema>;
type CircleMembers = z.infer<typeof circleMembersSchema>;
type CircleJoinRequests = z.infer<typeof circleJoinRequestsSchema>;

function personLabel(id: string, selfId: string | null) {
  return id === selfId ? 'You' : `Member · ${id.slice(0, 4)}…${id.slice(-4)}`;
}

export default function CircleDetailPage() {
  const params = useParams<{ id: string }>();
  const id = params.id;
  const [circle, setCircle] = useState<CircleDetail | null>(null);
  const [notes, setNotes] = useState<CircleNotes['items']>([]);
  const [members, setMembers] = useState<CircleMembers['items']>([]);
  const [joinRequests, setJoinRequests] = useState<CircleJoinRequests['items']>([]);
  const [accountId, setAccountId] = useState<string | null>(null);
  const [noteBody, setNoteBody] = useState('');
  const [inviteAccount, setInviteAccount] = useState('');
  const [inviteRole, setInviteRole] = useState('member');
  const [joinMessage, setJoinMessage] = useState('');
  const [loading, setLoading] = useState(true);
  const [restricted, setRestricted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setRestricted(false);
    setError(null);
    try {
      const [detail, session] = await Promise.all([
        memberApi<CircleDetail>(`/circles/${id}`),
        memberApi<SessionResponse>('/account/session'),
      ]);
      setCircle(detail);
      setAccountId(session.account_id);
      const [noteList, memberList] = await Promise.all([
        memberApi<CircleNotes>(`/circles/${id}/notes?limit=50`),
        memberApi<CircleMembers>(`/circles/${id}/members?limit=50`),
      ]);
      setNotes(noteList.items);
      setMembers(memberList.items);
      if (detail.role === 'owner' || detail.role === 'moderator') {
        const requests = await memberApi<CircleJoinRequests>(
          `/circles/${id}/join-requests?limit=50`,
        );
        setJoinRequests(requests.items);
      } else setJoinRequests([]);
    } catch (caught) {
      if (caught instanceof MemberApiError && caught.status === 404) setRestricted(true);
      else setError(describeMemberApiError(caught));
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  async function addNote(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    try {
      await memberApi(`/circles/${id}/notes`, 'POST', {
        body: { body: noteBody },
        headers: { 'idempotency-key': makeIdempotencyKey() },
      });
      setNoteBody('');
      await load();
    } catch (caught) {
      setError(describeMemberApiError(caught));
    }
  }

  async function invite(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    try {
      await memberApi(`/circles/${id}/invitations`, 'POST', {
        body: { account_id: inviteAccount.trim(), role: inviteRole },
        headers: { 'idempotency-key': makeIdempotencyKey() },
      });
      setInviteAccount('');
      setNotice('Invitation created. Delivery is handled through the durable notification outbox.');
    } catch (caught) {
      setError(describeMemberApiError(caught));
    }
  }

  async function join(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    try {
      await memberApi(`/circles/${id}/join-requests`, 'POST', {
        body: joinMessage.trim() ? { message: joinMessage.trim() } : {},
        headers: { 'idempotency-key': makeIdempotencyKey() },
      });
      setNotice('Your request was submitted.');
      setJoinMessage('');
    } catch (caught) {
      setError(describeMemberApiError(caught));
    }
  }

  async function memberAction(memberId: string, action: 'approve' | 'decline' | 'remove') {
    try {
      await memberApi(`/circles/${id}/members/${memberId}/${action}`, 'POST', {
        body: {},
        headers: { 'idempotency-key': makeIdempotencyKey() },
      });
      await load();
    } catch (caught) {
      setError(describeMemberApiError(caught));
    }
  }

  async function leave() {
    if (!window.confirm('Leave this circle? You may lose access to its private Notes.')) return;
    try {
      await memberApi(`/circles/${id}/leave`, 'POST', {
        headers: { 'idempotency-key': makeIdempotencyKey() },
      });
      window.location.assign('/circles');
    } catch (caught) {
      setError(describeMemberApiError(caught));
    }
  }

  return (
    <div className="page-shell">
      {loading ? <div className="skeleton" /> : null}
      {error ? (
        <div className="status-banner status-banner--error" role="alert">
          {error}
        </div>
      ) : null}
      {restricted ? (
        <section className="panel restricted-circle">
          <p className="eyebrow">Private circle</p>
          <h1>Membership required</h1>
          <p className="panel-copy">
            Circle details stay hidden until admission. If this trusted link was shared with you,
            you may request access without seeing member or Note data.
          </p>
          <form className="form-stack" onSubmit={join}>
            <label className="field">
              <span>Optional note to the moderators</span>
              <textarea
                maxLength={500}
                value={joinMessage}
                onChange={(event) => setJoinMessage(event.target.value)}
              />
            </label>
            <button className="button button--primary" type="submit">
              Request access
            </button>
          </form>
          <Link className="button button--quiet" href="/circles">
            Back to circles
          </Link>
        </section>
      ) : null}
      {circle ? (
        <>
          <section className="circle-detail-hero">
            <div>
              <Link className="back-link" href="/circles">
                ← Circles
              </Link>
              <p className="eyebrow">
                {circle.mode} · {circle.scope_kind}
              </p>
              <h1>{circle.name}</h1>
              <p>{circle.description ?? 'This circle has no description yet.'}</p>
              <div className="tag-row">
                {circle.topics.map((topic) => (
                  <span className="tag" key={topic}>
                    {topic.replaceAll('_', ' ')}
                  </span>
                ))}
              </div>
            </div>
            <aside>
              <span className="circle-monogram" aria-hidden="true">
                {circle.name.slice(0, 1).toUpperCase()}
              </span>
              <strong>{circle.member_count} members</strong>
              <span className="muted">Your role: {circle.role}</span>
            </aside>
          </section>
          {notice ? (
            <div className="status-banner status-banner--success section-stack">{notice}</div>
          ) : null}
          <nav className="circle-actions section-stack" aria-label="Circle actions">
            <a href="#notes">Notes</a>
            <a href="#members">Members</a>
            {circle.role === 'owner' || circle.role === 'moderator' ? (
              <a href="#requests">Requests</a>
            ) : null}
            <Link href={`/messages?circle=${id}`}>Group chat</Link>
          </nav>
          <div className="split-layout section-stack">
            <div className="section-stack">
              <section className="panel" id="notes">
                <p className="eyebrow">Private shared writing</p>
                <h2>Circle Notes</h2>
                <p className="panel-copy">
                  Notes are encrypted content for current members. They are not the group chat.
                </p>
                <form className="form-stack note-composer" onSubmit={addNote}>
                  <label className="field">
                    <span>Add a Note</span>
                    <textarea
                      required
                      maxLength={10000}
                      value={noteBody}
                      onChange={(event) => setNoteBody(event.target.value)}
                    />
                  </label>
                  <button className="button button--primary" type="submit">
                    Post Note
                  </button>
                </form>
                <div className="note-list">
                  {notes.length === 0 ? (
                    <p className="empty-state">No Notes yet.</p>
                  ) : (
                    notes.map((note) => (
                      <article className="circle-note" key={note.id}>
                        <div>
                          <strong>{personLabel(note.author_account_id, accountId)}</strong>
                          <time>{new Date(note.created_at).toLocaleString()}</time>
                        </div>
                        <p>{note.body}</p>
                      </article>
                    ))
                  )}
                </div>
              </section>
              <section className="panel" id="members">
                <p className="eyebrow">Current membership</p>
                <h2>Members</h2>
                {members.map((member) => (
                  <div className="list-row" key={member.account_id}>
                    <div className="list-row__body">
                      <strong>{personLabel(member.account_id, accountId)}</strong>
                      <span className="muted">{member.role}</span>
                    </div>
                    {(circle.role === 'owner' || circle.role === 'moderator') &&
                    member.account_id !== accountId &&
                    member.role !== 'owner' ? (
                      <button
                        className="button button--danger"
                        type="button"
                        onClick={() => memberAction(member.account_id, 'remove')}
                      >
                        Remove
                      </button>
                    ) : null}
                  </div>
                ))}
              </section>
              {circle.role === 'owner' || circle.role === 'moderator' ? (
                <section className="panel" id="requests">
                  <p className="eyebrow">Admission</p>
                  <h2>Join requests</h2>
                  {joinRequests.length === 0 ? (
                    <p className="muted">No pending requests.</p>
                  ) : (
                    joinRequests.map((request) => (
                      <div className="list-row" key={request.id}>
                        <div className="list-row__body">
                          <strong>{personLabel(request.account_id, accountId)}</strong>
                          <p className="muted">{request.message ?? 'No message provided.'}</p>
                        </div>
                        <div className="button-row">
                          <button
                            className="button button--primary"
                            type="button"
                            onClick={() => memberAction(request.account_id, 'approve')}
                          >
                            Approve
                          </button>
                          <button
                            className="button"
                            type="button"
                            onClick={() => memberAction(request.account_id, 'decline')}
                          >
                            Decline
                          </button>
                        </div>
                      </div>
                    ))
                  )}
                </section>
              ) : null}
            </div>
            <aside className="section-stack">
              <section className="panel group-chat-card">
                <p className="eyebrow">Conversation</p>
                <h2>Group chat</h2>
                <p className="panel-copy">
                  The unified Messages design is ready, but realtime circle messaging is not
                  implemented in the backend. Notes above are fully available now.
                </p>
                <Link className="button" href={`/messages?circle=${id}`}>
                  View Messages boundary
                </Link>
              </section>
              {circle.role === 'owner' || circle.role === 'moderator' ? (
                <form className="panel form-stack" onSubmit={invite}>
                  <p className="eyebrow">Private invitation</p>
                  <h2>Invite a member</h2>
                  <p className="field-hint">
                    Profile lookup is not exposed by the current API. Use an account ID only when it
                    was shared through a trusted product flow.
                  </p>
                  <label className="field">
                    <span>Account ID</span>
                    <input
                      required
                      pattern="[0-9a-fA-F-]{36}"
                      value={inviteAccount}
                      onChange={(event) => setInviteAccount(event.target.value)}
                    />
                  </label>
                  <label className="field">
                    <span>Role</span>
                    <select
                      value={inviteRole}
                      onChange={(event) => setInviteRole(event.target.value)}
                    >
                      <option value="member">Member</option>
                      <option value="moderator">Moderator</option>
                    </select>
                  </label>
                  <button className="button" type="submit">
                    Send invitation
                  </button>
                </form>
              ) : null}
              {circle.role !== 'owner' ? (
                <button className="button button--danger" type="button" onClick={leave}>
                  Leave circle
                </button>
              ) : (
                <p className="field-hint">An owner must transfer ownership before leaving.</p>
              )}
            </aside>
          </div>
        </>
      ) : null}
    </div>
  );
}
