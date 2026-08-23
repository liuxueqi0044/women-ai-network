import Link from 'next/link';

export default function EventsPage() {
  return (
    <div className="page-shell page-shell--narrow">
      <section className="page-hero">
        <div className="page-hero__copy">
          <p className="eyebrow">Planned community surface</p>
          <h1>Events</h1>
          <p>
            Small, purpose-led gatherings belong in the product vision, but the authoritative Events
            backend has not been implemented yet.
          </p>
        </div>
      </section>
      <section className="panel section-stack unavailable-feature">
        <span className="unavailable-feature__mark" aria-hidden="true">
          ◇
        </span>
        <h2>Not available yet</h2>
        <p className="panel-copy">
          We will not populate this page with fictional events or accept registrations that cannot
          be enforced. Event creation, attendance, capacity, time-zone handling, safety checks and
          cancellation must be built and independently accepted first.
        </p>
        <div className="button-row">
          <Link className="button button--primary" href="/circles">
            Explore Circles
          </Link>
          <Link className="button" href="/world">
            Read world letters
          </Link>
        </div>
      </section>
      <section className="panel section-stack">
        <p className="eyebrow">What will be required</p>
        <h2>Before Events opens</h2>
        <div className="tag-row">
          <span className="tag">Current eligibility</span>
          <span className="tag">Local time zones</span>
          <span className="tag">Capacity limits</span>
          <span className="tag">Host governance</span>
          <span className="tag">Block-aware visibility</span>
          <span className="tag">Cancellation notices</span>
        </div>
      </section>
    </div>
  );
}
