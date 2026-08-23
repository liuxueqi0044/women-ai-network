'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import type {
  CircleList,
  ConnectionListResponse,
  IntroductionListResponse,
  SessionResponse,
} from '@wai/contracts';
import { formatGlobalizationMessage } from '@wai/contracts';
import { MobileIcon } from '../../src/components/mobile-icon';
import { useGlobalization } from '../../src/globalization-store';
import { getWebApiBaseUrl } from '../../src/lib/web-api-base';

const paths = [
  {
    href: '/introductions',
    eyebrow: 'Curated',
    title: 'Introductions',
    copy: 'A small, bounded set of compatible people. No swipe deck, public score or popularity rank.',
  },
  {
    href: '/connections',
    eyebrow: 'Mutual',
    title: 'Connections',
    copy: 'Review requests and active connections. Either person can close a connection at any time.',
  },
  {
    href: '/private-deliveries',
    eyebrow: 'Letter-led',
    title: 'Private letters',
    copy: 'Use a saved private letter to introduce yourself after a permitted connection path opens.',
  },
  {
    href: '/events',
    eyebrow: 'Planned',
    title: 'Events',
    copy: 'Purpose-led gatherings will open after the authoritative events and attendance backend is accepted.',
  },
] as const;

const API = getWebApiBaseUrl();

function shortMember(id: string): string {
  return `Member ${id.slice(0, 4).toUpperCase()}`;
}

async function read<T>(path: string): Promise<T> {
  const response = await fetch(`${API}${path}`, { credentials: 'include' });
  if (!response.ok) throw new Error('Unavailable');
  return (await response.json()) as T;
}

export default function ConnectPage() {
  const { locale } = useGlobalization();
  const isChinese = locale === 'zh-Hans-CN';
  const [session, setSession] = useState<SessionResponse | null>(null);
  const [connections, setConnections] = useState<ConnectionListResponse['connections']>([]);
  const [introduction, setIntroduction] = useState<
    IntroductionListResponse['candidates'][number] | null
  >(null);
  const [circle, setCircle] = useState<CircleList['items'][number] | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const current = await read<SessionResponse>('/account/session');
        if (controller.signal.aborted) return;
        setSession(current);
        const results = await Promise.allSettled([
          read<ConnectionListResponse>('/connections?limit=20'),
          read<IntroductionListResponse>('/introductions?mode=friends&limit=1'),
          read<CircleList>('/circles?limit=1'),
        ]);
        if (controller.signal.aborted) return;
        if (results[0].status === 'fulfilled') setConnections(results[0].value.connections);
        if (results[1].status === 'fulfilled')
          setIntroduction(results[1].value.candidates[0] ?? null);
        if (results[2].status === 'fulfilled') setCircle(results[2].value.items[0] ?? null);
      } catch {
        // The public shell stays useful; member-only destinations request authentication.
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    })();
    return () => controller.abort();
  }, []);

  const contacts = useMemo(
    () =>
      connections
        .filter((item) => item.state === 'accepted')
        .slice(0, 4)
        .map((item) => {
          const other =
            item.requester_account_id === session?.account_id
              ? item.recipient_account_id
              : item.requester_account_id;
          return {
            id: item.id,
            label: shortMember(other),
            initial: other.slice(0, 1).toUpperCase(),
          };
        }),
    [connections, session],
  );

  return (
    <>
      <main className="mobile-experience mobile-primary-screen mobile-connect-screen">
        <header className="mobile-editorial-header">
          <div>
            <p>CONTACTS · DISCOVERY</p>
            <h1>{formatGlobalizationMessage(locale, 'common.nav.connect')}</h1>
          </div>
          <Link className="mobile-header-icon" href="/introductions" aria-label="Add contact">
            <MobileIcon name="add-person" />
          </Link>
        </header>

        <nav className="mobile-contact-tabs" aria-label="Connect sections">
          <Link href="/connect" aria-current="page">
            {isChinese ? '联系人' : 'Contacts'}
          </Link>
          <Link href="/introductions">{isChinese ? '发现连接' : 'Discover'}</Link>
        </nav>

        <nav className="mobile-quick-actions" aria-label="Contact actions">
          <Link href="/connections">
            <MobileIcon name="add-person" />
            <span>{isChinese ? '新的朋友' : 'New friends'}</span>
            <MobileIcon className="is-chevron" name="chevron" />
          </Link>
          <Link href="/introductions">
            <MobileIcon name="contacts" />
            <span>{isChinese ? '添加联系人' : 'Add contacts'}</span>
            <MobileIcon className="is-chevron" name="chevron" />
          </Link>
        </nav>

        <section className="mobile-approved-section" aria-labelledby="current-contacts-heading">
          <header className="mobile-approved-heading">
            <h2 id="current-contacts-heading">{isChinese ? '当前联系人' : 'Current contacts'}</h2>
            <Link href="/connections">{isChinese ? '查看全部' : 'View all'}</Link>
          </header>
          {loading ? (
            <div className="mobile-profile-skeleton" aria-label="Loading contacts" />
          ) : contacts.length ? (
            <div className="mobile-contact-strip">
              {contacts.map((contact) => (
                <Link href={`/messages?connection=${contact.id}`} key={contact.id}>
                  <span className="mobile-conversation-avatar" aria-hidden="true">
                    {contact.initial}
                  </span>
                  <small>{contact.label}</small>
                </Link>
              ))}
            </div>
          ) : (
            <p className="mobile-inline-notice">
              {isChinese
                ? '互相确认的联系人会显示在这里。'
                : 'Mutual connections will appear here.'}
            </p>
          )}
        </section>

        <section className="mobile-approved-section" aria-labelledby="recommend-heading">
          <header className="mobile-approved-heading">
            <h2 id="recommend-heading">{isChinese ? '可能认识的人' : 'People you may know'}</h2>
          </header>
          <article className="mobile-recommend-card">
            <div className="mobile-recommend-top">
              <div className="mobile-recommend-portrait" aria-hidden="true">
                {introduction?.subject.display_name.slice(0, 1).toUpperCase() ?? 'W'}
              </div>
              <div>
                <h3>
                  {introduction?.subject.display_name ??
                    (isChinese ? '下一位推荐联系人' : 'Your next introduction')}
                </h3>
                <p>{introduction?.mode.toUpperCase() ?? 'CURATED · RECIPROCAL'}</p>
                <span>
                  {isChinese ? '不展示公开分数或热度排名' : 'No public score or popularity rank'}
                </span>
              </div>
            </div>
            <p className="mobile-recommend-reason">
              {introduction?.explanation ??
                (isChinese
                  ? '当双方偏好、当前同意与安全边界相符时，这里会出现经过筛选的推荐。'
                  : 'A considered set appears when reciprocal preferences and current safety boundaries align.')}
            </p>
            <div className="mobile-recommend-actions">
              <Link href="/introductions">{isChinese ? '暂不考虑' : 'Not now'}</Link>
              <Link href="/introductions">{isChinese ? '打招呼' : 'Say hello'}</Link>
            </div>
          </article>
        </section>

        <section className="mobile-approved-section" aria-labelledby="my-circles-heading">
          <header className="mobile-approved-heading">
            <h2 id="my-circles-heading">{isChinese ? '我的圈子' : 'My circles'}</h2>
          </header>
          <Link
            className="mobile-approved-circle-row"
            href={circle ? `/circles/${circle.id}` : '/circles'}
          >
            <span className="mobile-circle-mark" aria-hidden="true">
              ❧
            </span>
            <span>
              <strong>
                {circle?.name ??
                  (isChinese ? '探索有明确主题的圈子' : 'Explore purposeful circles')}
              </strong>
              <small>
                {circle
                  ? `${circle.member_count} ${isChinese ? '位成员' : 'members'}`
                  : isChinese
                    ? '小规模、有治理边界的群体空间'
                    : 'Small, governed group spaces'}
              </small>
            </span>
            <MobileIcon name="chevron" />
          </Link>
        </section>
      </main>

      <div className="page-shell desktop-experience">
        <section className="page-hero">
          <div className="page-hero__copy">
            <p className="eyebrow">Meaningful introductions</p>
            <h1>Connect without the contest.</h1>
            <p>
              Start from shared intentions and explicit consent. AI may help explain a suggestion,
              but it never decides, sends, joins or confirms for you.
            </p>
          </div>
        </section>
        <section className="card-grid connect-grid section-stack">
          {paths.map((path) => (
            <Link className="surface-card" href={path.href} key={path.href}>
              <span className="eyebrow">{path.eyebrow}</span>
              <h2>{path.title}</h2>
              <p>{path.copy}</p>
              <span className="surface-card__action">Continue →</span>
            </Link>
          ))}
        </section>
        <section className="panel section-stack trust-note">
          <p className="eyebrow">Designed for boundaries</p>
          <h2>Eligibility is checked at the moment of action.</h2>
          <p className="panel-copy">
            The network does not make one global 18+ assumption. Current jurisdiction, capability,
            membership, identity and safety policy determine which connection modes are available.
          </p>
        </section>
      </div>
    </>
  );
}
