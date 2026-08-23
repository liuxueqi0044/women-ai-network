'use client';

import Link from 'next/link';
import { formatGlobalizationMessage } from '@wai/contracts';
import { useGlobalization } from '../src/globalization-store';

/** Product entry point for the letter-led global network. */
export default function HomePage() {
  const { locale } = useGlobalization();
  return (
    <div className="home-shell">
      <section className="home-hero">
        <div className="home-hero__copy">
          <p className="eyebrow">{formatGlobalizationMessage(locale, 'home.eyebrow')}</p>
          <h1>{formatGlobalizationMessage(locale, 'home.title')}</h1>
          <p>{formatGlobalizationMessage(locale, 'home.description')}</p>
          <div className="button-row">
            <Link className="button button--primary" href="/world">
              {formatGlobalizationMessage(locale, 'world.action')}
            </Link>
            <Link className="button" href="/letters">
              {formatGlobalizationMessage(locale, 'common.nav.writeLetter')}
            </Link>
          </div>
        </div>
        <aside className="home-letter" aria-label="A letter-led network">
          <span className="home-letter__postmark">Across borders · at your pace</span>
          <blockquote>
            “Tell me about the place that shaped you, the life you are building, and the things you
            hope another woman might understand.”
          </blockquote>
          <div className="home-letter__line" />
          <p>Public letters begin discovery. Private letters open a more personal conversation.</p>
        </aside>
      </section>

      <section className="home-paths" aria-label="Explore Women AI Network">
        <Link href="/world">
          <span>01</span>
          <strong>Read the world</strong>
          <p>Life stories, places and perspectives—not a popularity feed.</p>
        </Link>
        <Link href="/connect">
          <span>02</span>
          <strong>Find a connection</strong>
          <p>Bounded introductions with mutual intent and current safety checks.</p>
        </Link>
        <Link href="/circles">
          <span>03</span>
          <strong>Join a circle</strong>
          <p>Small private spaces with roles, Notes and explicit admission.</p>
        </Link>
      </section>

      <section className="home-principles">
        <p className="eyebrow">What is different here</p>
        <div className="home-principles__grid">
          <h2>Connection is not a performance metric.</h2>
          <p>
            No public match percentage, beauty score, follower race or endless swipe loop. You
            choose what is visible, when a relationship begins, and when it ends.
          </p>
        </div>
      </section>
    </div>
  );
}
