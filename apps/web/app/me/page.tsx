'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { ProfileSelfView, SessionResponse } from '@wai/contracts';
import { formatGlobalizationMessage } from '@wai/contracts';
import { MobileIcon } from '../../src/components/mobile-icon';
import { useGlobalization } from '../../src/globalization-store';
import { MemberApiError, describeMemberApiError, memberApi } from '../../src/lib/member-api';

const memberAreas = [
  {
    href: '/profile',
    eyebrow: 'Your public presence',
    title: 'Profile & privacy',
    copy: 'Choose what you share, who can see each fact, and which modes may use it.',
  },
  {
    href: '/verification',
    eyebrow: 'Trust layer',
    title: 'Verification',
    copy: 'Review identity, age-assurance and membership status without exposing documents.',
  },
  {
    href: '/account',
    eyebrow: 'Security',
    title: 'Account & devices',
    copy: 'Manage sessions, recognized devices, two-step verification and recovery codes.',
  },
  {
    href: '/onboarding',
    eyebrow: 'Your intentions',
    title: 'Connection preferences',
    copy: 'Tell the network what kinds of connections feel useful to you right now.',
  },
  {
    href: '/settings/language',
    eyebrow: 'Global experience',
    title: 'Language & time',
    copy: 'Set your interface language, content languages, time zone and week format.',
  },
  {
    href: '/safety',
    eyebrow: 'Your boundaries',
    title: 'Safety center',
    copy: 'Review blocks and find reporting controls. Safety actions remain human-confirmed.',
  },
] as const;

const mobileAreas = [
  { href: '/profile', icon: 'profile', label: 'Profile', zhLabel: '个人资料' },
  { href: '/letters', icon: 'mail', label: 'My public letters', zhLabel: '我的公开信' },
  {
    href: '/private-deliveries',
    icon: 'compose',
    label: 'Private letter drafts',
    zhLabel: '私人信草稿',
  },
  { href: '/verification', icon: 'shield', label: 'Identity and safety', zhLabel: '身份与安全' },
  {
    href: '/settings/language',
    icon: 'bell',
    label: 'Language and notifications',
    zhLabel: '语言与通知',
  },
  { href: '/safety', icon: 'lock', label: 'Privacy settings', zhLabel: '隐私设置' },
] as const;

export default function MePage() {
  const router = useRouter();
  const { locale } = useGlobalization();
  const isChinese = locale === 'zh-Hans-CN';
  const [session, setSession] = useState<SessionResponse | null>(null);
  const [profile, setProfile] = useState<ProfileSelfView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        setSession(
          await memberApi<SessionResponse>('/account/session', 'GET', {
            signal: controller.signal,
          }),
        );
        try {
          setProfile(
            await memberApi<ProfileSelfView>('/profile/me', 'GET', {
              signal: controller.signal,
            }),
          );
        } catch (caught) {
          if (!(caught instanceof MemberApiError && caught.status === 404)) throw caught;
        }
      } catch (caught: unknown) {
        if (caught instanceof DOMException && caught.name === 'AbortError') return;
        if (caught instanceof MemberApiError && caught.status === 401) return;
        setError(describeMemberApiError(caught));
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    })();
    return () => controller.abort();
  }, []);

  const completion = profile
    ? Math.min(
        100,
        30 + (profile.country_code ? 15 : 0) + (profile.city ? 15 : 0) + profile.facts.length * 10,
      )
    : 0;

  async function logout() {
    setError(null);
    try {
      await memberApi<null>('/account/session', 'DELETE');
      router.replace('/auth');
      router.refresh();
    } catch (caught) {
      setError(describeMemberApiError(caught));
    }
  }

  return (
    <>
      <main className="mobile-experience mobile-primary-screen mobile-me-screen">
        <header className="mobile-editorial-header mobile-profile-title">
          <div>
            <p>PRESENCE · PRIVACY · SECURITY</p>
            <h1>{formatGlobalizationMessage(locale, 'common.nav.me')}</h1>
          </div>
          <div className="mobile-postal-mark" aria-hidden="true">
            <b>W</b>
          </div>
        </header>

        {loading ? (
          <div className="mobile-profile-skeleton" aria-label="Loading account" />
        ) : session ? (
          <>
            <section className="mobile-profile-hero">
              <div className="mobile-profile-portrait" aria-hidden="true">
                {profile?.display_name.slice(0, 1).toUpperCase() ?? 'W'}
              </div>
              <div className="mobile-profile-copy">
                <h2>{profile?.display_name ?? (isChinese ? '会员账户' : 'Member account')}</h2>
                <p>{[profile?.country_code, profile?.city, locale].filter(Boolean).join(' · ')}</p>
                <span>
                  ✓&nbsp;&nbsp;{isChinese ? '已验证会话' : 'Verified session'} ·{' '}
                  {session.auth_level.toUpperCase()}
                </span>
              </div>
            </section>
            <Link className="mobile-completion-card" href="/profile">
              <div>
                <span>{isChinese ? '完善个人资料' : 'Complete your profile'}</span>
                <strong>
                  {completion}% {isChinese ? '完成' : 'complete'}
                </strong>
                <MobileIcon name="chevron" />
              </div>
              <div className="mobile-completion-progress">
                <i style={{ width: `${completion}%` }} />
              </div>
            </Link>
          </>
        ) : (
          <section className="mobile-profile-hero">
            <div className="mobile-profile-portrait" aria-hidden="true">
              W
            </div>
            <div className="mobile-profile-copy">
              <h2>{isChinese ? '你的私人空间' : 'Your private space'}</h2>
              <p>
                {isChinese
                  ? '登录后管理你的个人形象、隐私与边界。'
                  : 'Sign in to manage your presence and boundaries.'}
              </p>
              <Link className="mobile-gold-button" href="/auth">
                {isChinese ? '登录或创建账户' : 'Sign in or create account'}
              </Link>
            </div>
          </section>
        )}

        <nav className="mobile-settings-list" aria-label="Profile and settings">
          {mobileAreas.map((area) => (
            <Link
              href={session || area.href === '/settings/language' ? area.href : '/auth'}
              key={area.href}
            >
              <MobileIcon name={area.icon} />
              <span>{isChinese ? area.zhLabel : area.label}</span>
              <MobileIcon name="chevron" />
            </Link>
          ))}
        </nav>

        {session ? (
          <button className="mobile-sign-out" type="button" onClick={logout}>
            Sign out
          </button>
        ) : (
          <Link className="mobile-world-link" href="/world">
            {isChinese ? '继续阅读公开信' : 'Continue reading public letters'}
          </Link>
        )}
        {error ? (
          <p className="mobile-inline-notice" role="alert">
            {error}
          </p>
        ) : null}
      </main>

      <div className="page-shell desktop-experience">
        <section className="page-hero">
          <div className="page-hero__copy">
            <p className="eyebrow">Your space</p>
            <h1>Me</h1>
            <p>
              A quiet control room for your presence, preferences, security and boundaries across
              the network.
            </p>
          </div>
          {session ? (
            <button className="button" type="button" onClick={logout}>
              Sign out
            </button>
          ) : null}
        </section>

        {loading ? <div className="skeleton section-stack" aria-label="Loading account" /> : null}
        {!loading && !session ? (
          <section className="panel section-stack">
            <p className="eyebrow">Account required</p>
            <h2>Sign in to shape your experience.</h2>
            <p className="panel-copy">
              Public letters remain discoverable without an account. Private and member features
              require a secure session.
            </p>
            <div className="button-row">
              <Link className="button button--primary" href="/auth">
                Sign in or create account
              </Link>
              <Link className="button" href="/world">
                Browse public letters
              </Link>
            </div>
          </section>
        ) : null}

        {session ? (
          <>
            <div className="member-summary">
              <span className="member-avatar" aria-hidden="true">
                W
              </span>
              <div>
                <strong>Member account</strong>
                <p className="muted">Session protected at {session.auth_level.toUpperCase()}</p>
              </div>
              <span className="pill">{session.state}</span>
            </div>
            <section className="card-grid section-stack" aria-label="Account areas">
              {memberAreas.map((area) => (
                <Link className="surface-card" href={area.href} key={area.href}>
                  <span className="eyebrow">{area.eyebrow}</span>
                  <h2>{area.title}</h2>
                  <p>{area.copy}</p>
                  <span className="surface-card__action">Open →</span>
                </Link>
              ))}
            </section>
          </>
        ) : null}
        {error ? (
          <div className="status-banner status-banner--error" role="alert">
            {error}
          </div>
        ) : null}
      </div>
    </>
  );
}
