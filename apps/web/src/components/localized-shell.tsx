'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import { formatGlobalizationMessage } from '@wai/contracts';
import { useGlobalization } from '../globalization-store';
import { getWebApiBaseUrl } from '../lib/web-api-base';

const mainItems = [
  { href: '/world', key: 'common.nav.world' },
  { href: '/connect', key: 'common.nav.connect' },
  { href: '/circles', key: 'common.nav.circles' },
  { href: '/messages', key: 'common.nav.messages' },
  { href: '/me', key: 'common.nav.me' },
] as const;

const mobileItems = [
  {
    href: '/messages',
    key: 'common.nav.messages',
    icon: 'chat',
    roots: ['/messages', '/notifications'],
  },
  {
    href: '/connect',
    key: 'common.nav.connect',
    icon: 'connect',
    roots: [
      '/connect',
      '/connections',
      '/introductions',
      '/private-deliveries',
      '/circles',
      '/events',
    ],
  },
  {
    href: '/world',
    key: 'common.nav.world',
    icon: 'world',
    roots: ['/world', '/letters'],
  },
  {
    href: '/me',
    key: 'common.nav.me',
    icon: 'me',
    roots: ['/me', '/profile', '/verification', '/account', '/onboarding', '/settings', '/safety'],
  },
] as const;

function isCurrent(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`);
}

function MobileNavIcon({ icon }: { icon: (typeof mobileItems)[number]['icon'] }) {
  if (icon === 'chat') {
    return (
      <svg aria-hidden="true" viewBox="0 0 24 24">
        <path d="M20 11.5a7.5 7.5 0 0 1-8 7.5 9.4 9.4 0 0 1-3.4-.7L4 20l1.4-4A7.2 7.2 0 0 1 4 11.5 7.5 7.5 0 0 1 12 4a7.5 7.5 0 0 1 8 7.5Z" />
      </svg>
    );
  }
  if (icon === 'connect') {
    return (
      <svg aria-hidden="true" viewBox="0 0 24 24">
        <circle cx="9" cy="8" r="3.2" />
        <path d="M3.8 18.5c.5-3.3 2.2-5 5.2-5s4.7 1.7 5.2 5M16 6.5a3 3 0 0 1 0 5.8M16.5 14c2.2.4 3.4 1.9 3.7 4.5" />
      </svg>
    );
  }
  if (icon === 'world') {
    return (
      <svg aria-hidden="true" viewBox="0 0 24 24">
        <circle cx="12" cy="12" r="8.2" />
        <path d="M3.9 12h16.2M12 3.8c2.4 2.2 3.6 5 3.6 8.2S14.4 18 12 20.2C9.6 18 8.4 15.2 8.4 12S9.6 6 12 3.8Z" />
      </svg>
    );
  }
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24">
      <circle cx="12" cy="7.8" r="3.5" />
      <path d="M5.3 20c.6-4.2 2.8-6.3 6.7-6.3s6.1 2.1 6.7 6.3" />
    </svg>
  );
}

export function LocalizedNavigation() {
  const { locale } = useGlobalization();
  const pathname = usePathname();
  const [messageUnread, setMessageUnread] = useState(0);

  useEffect(() => {
    let active = true;
    const refresh = async () => {
      try {
        const response = await fetch(`${getWebApiBaseUrl()}/conversations/unread-count`, {
          credentials: 'include',
        });
        if (!response.ok) return;
        const data = (await response.json()) as { unread_count?: number };
        if (active) setMessageUnread(Math.max(0, data.unread_count ?? 0));
      } catch {
        // Navigation remains usable while signed out, offline, or during API recovery.
      }
    };
    const updateFromPage = (event: Event) => {
      const count = (event as CustomEvent<{ unreadCount?: number }>).detail?.unreadCount;
      if (typeof count === 'number') setMessageUnread(Math.max(0, count));
      else void refresh();
    };
    void refresh();
    const timer = globalThis.setInterval(() => void refresh(), 15_000);
    globalThis.addEventListener('wai:messages-unread', updateFromPage);
    return () => {
      active = false;
      globalThis.clearInterval(timer);
      globalThis.removeEventListener('wai:messages-unread', updateFromPage);
    };
  }, []);

  return (
    <>
      <header className="app-header">
        <div className="app-header__inner">
          <Link className="brand" href="/" aria-label="Women AI Network home">
            <span className="brand__seal" aria-hidden="true">
              <span className="desktop-brand-letter">W</span>
              <span className="mobile-brand-letter">N</span>
            </span>
            <span className="brand__words">
              Women AI <span>Network</span>
            </span>
          </Link>
          <nav aria-label="Primary" className="primary-nav">
            {mainItems.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                aria-current={isCurrent(pathname, item.href) ? 'page' : undefined}
              >
                {formatGlobalizationMessage(locale, item.key)}
              </Link>
            ))}
          </nav>
          <div className="header-actions">
            <Link
              className="icon-link"
              href="/notifications"
              aria-label={formatGlobalizationMessage(locale, 'common.nav.notifications')}
              aria-current={isCurrent(pathname, '/notifications') ? 'page' : undefined}
            >
              <svg aria-hidden="true" viewBox="0 0 24 24" width="19" height="19">
                <path
                  d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4"
                  fill="none"
                  stroke="currentColor"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth="1.7"
                />
              </svg>
            </Link>
            <Link className="button button--primary header-write" href="/letters">
              {formatGlobalizationMessage(locale, 'common.nav.writeLetter')}
            </Link>
          </div>
        </div>
      </header>
      <nav aria-label="Mobile primary" className="mobile-nav">
        {mobileItems.map((item) => (
          <Link
            key={item.href}
            href={item.href}
            aria-current={item.roots.some((root) => isCurrent(pathname, root)) ? 'page' : undefined}
          >
            <span className="mobile-nav__icon">
              <MobileNavIcon icon={item.icon} />
              {item.icon === 'chat' && messageUnread > 0 ? (
                <span className="mobile-nav__badge" aria-label={`${messageUnread} unread messages`}>
                  {messageUnread > 99 ? '99+' : messageUnread}
                </span>
              ) : null}
            </span>
            <small>{formatGlobalizationMessage(locale, item.key)}</small>
          </Link>
        ))}
      </nav>
    </>
  );
}
