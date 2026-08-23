import { Temporal } from '@js-temporal/polyfill';

/**
 * ELG-01 age arithmetic — Temporal.PlainDate + IANA timezone only.
 * Never `Date.now() - dob`, UTC date diffs, or divide-by-365.
 */

export function parseBirthDate(value: string): Temporal.PlainDate {
  return Temporal.PlainDate.from(value);
}

/** Local calendar date at an instant in the given IANA timezone. */
export function localDateAt(instant: Temporal.Instant, timeZone: string): Temporal.PlainDate {
  return instant.toZonedDateTimeISO(timeZone).toPlainDate();
}

/**
 * Whole years between a birth date and `on`, counting the birthday itself.
 * A Feb-29 birth "ages" on Feb 28 of non-leap years — Temporal's default
 * `constrain` overflow applies that convention without hand-rolled math.
 * `on` before `birthDate` yields a negative value; callers reject future
 * birth dates before computing.
 */
export function ageInYears(birthDate: Temporal.PlainDate, on: Temporal.PlainDate): number {
  const years = on.year - birthDate.year;
  const anniversaryThisYear = birthDate.with({ year: on.year });
  return Temporal.PlainDate.compare(on, anniversaryThisYear) < 0 ? years - 1 : years;
}

/** Instant at which the subject's next birthday begins in the policy zone.
 * The end of a credential is the earlier of this boundary and the policy
 * interval end, so an open-ended policy never creates a perpetual credential. */
export function nextBirthdayInstant(
  birthDate: Temporal.PlainDate,
  at: Temporal.Instant,
  timeZone: string,
): Temporal.Instant {
  const today = localDateAt(at, timeZone);
  let year = today.year;
  let anniversary: Temporal.PlainDate;
  try {
    anniversary = birthDate.with({ year });
  } catch {
    // Feb-29 follows the same Feb-28 convention as ageInYears.
    anniversary = birthDate.with({ year, month: 2, day: 28 });
  }
  if (Temporal.PlainDate.compare(anniversary, today) <= 0) year += 1;
  try {
    anniversary = birthDate.with({ year });
  } catch {
    anniversary = birthDate.with({ year, month: 2, day: 28 });
  }
  return anniversary.toPlainDateTime({ hour: 0 }).toZonedDateTime(timeZone).toInstant();
}

export function isWithinValidity(validFrom: Date, validUntil: Date | number, at: Date): boolean {
  const until = typeof validUntil === 'number' ? Number.POSITIVE_INFINITY : validUntil.getTime();
  return at.getTime() >= validFrom.getTime() && at.getTime() < until;
}
