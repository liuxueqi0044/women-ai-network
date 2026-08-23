import React, { type ReactNode } from 'react';

type MobileIconName =
  | 'add-person'
  | 'bell'
  | 'bookmark'
  | 'chevron'
  | 'compose'
  | 'contacts'
  | 'lock'
  | 'mail'
  | 'profile'
  | 'search'
  | 'shield';

const paths: Record<MobileIconName, ReactNode> = {
  'add-person': (
    <>
      <circle cx="9" cy="8" r="3" />
      <path d="M3.5 19c.4-3.2 2.2-5 5.5-5s5.1 1.8 5.5 5M18 6v7M14.5 9.5h7" />
    </>
  ),
  bell: <path d="M6 17h12l-1.5-2v-4.5a4.5 4.5 0 0 0-9 0V15zM10 20h4" />,
  bookmark: <path d="M6 4h12v17l-6-4-6 4z" />,
  chevron: <path d="m9 5 7 7-7 7" />,
  compose: <path d="M5 19h4l10-10a2.8 2.8 0 0 0-4-4L5 15zM13.8 6.2l4 4M4 21h16" />,
  contacts: (
    <>
      <circle cx="9" cy="8" r="3" />
      <path d="M3.5 19c.4-3.2 2.2-5 5.5-5s5.1 1.8 5.5 5M16 7.5a2.5 2.5 0 0 1 0 5M16.5 14c2.5.4 3.8 2 4 4.5" />
    </>
  ),
  lock: (
    <>
      <rect x="4" y="10" width="16" height="11" rx="2" />
      <path d="M8 10V7a4 4 0 0 1 8 0v3" />
    </>
  ),
  mail: (
    <>
      <rect x="3" y="5" width="18" height="14" rx="1.5" />
      <path d="m4 7 8 6 8-6" />
    </>
  ),
  profile: (
    <>
      <circle cx="12" cy="8" r="3.5" />
      <path d="M4.5 20c.5-4.1 3-6.3 7.5-6.3s7 2.2 7.5 6.3" />
    </>
  ),
  search: (
    <>
      <circle cx="10.5" cy="10.5" r="6.5" />
      <path d="m15.3 15.3 4.2 4.2" />
    </>
  ),
  shield: (
    <>
      <path d="M12 3 20 6v5c0 5.3-3.2 8.5-8 10-4.8-1.5-8-4.7-8-10V6z" />
      <path d="m9 12 2 2 4-4" />
    </>
  ),
};

export function MobileIcon({ name, className }: { name: MobileIconName; className?: string }) {
  return (
    <svg
      aria-hidden="true"
      className={`mobile-icon${className ? ` ${className}` : ''}`}
      viewBox="0 0 24 24"
    >
      {paths[name]}
    </svg>
  );
}
