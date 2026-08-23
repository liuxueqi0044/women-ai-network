import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import './globals.css';
import './mobile-luxe.css';
import './mobile-native.css';
import './mobile-production.css';
import { LocalizedNavigation } from '../src/components/localized-shell';
import { GlobalizationProvider } from '../src/globalization-store';

export const metadata: Metadata = {
  title: 'Women AI Network — Letters from the World',
  description: 'A thoughtful, letter-led way for women around the world to connect.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <GlobalizationProvider>
          <LocalizedNavigation />
          <div id="main-content">{children}</div>
        </GlobalizationProvider>
      </body>
    </html>
  );
}
