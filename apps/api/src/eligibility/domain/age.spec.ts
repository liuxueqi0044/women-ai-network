import { Temporal } from '@js-temporal/polyfill';
import { describe, expect, it } from 'vitest';
import { ageInYears, localDateAt, parseBirthDate } from './age.js';

describe('ageInYears (Temporal date-only arithmetic)', () => {
  it('counts the birthday itself and nothing before it', () => {
    expect(ageInYears(parseBirthDate('2008-08-16'), parseBirthDate('2026-08-15'))).toBe(17);
    expect(ageInYears(parseBirthDate('2008-08-16'), parseBirthDate('2026-08-16'))).toBe(18);
    expect(ageInYears(parseBirthDate('2008-08-16'), parseBirthDate('2026-08-17'))).toBe(18);
  });

  it('handles year-end and new-year boundaries', () => {
    expect(ageInYears(parseBirthDate('2007-12-31'), parseBirthDate('2026-01-01'))).toBe(18);
    expect(ageInYears(parseBirthDate('2007-12-31'), parseBirthDate('2025-12-31'))).toBe(18);
    expect(ageInYears(parseBirthDate('2007-12-31'), parseBirthDate('2025-12-30'))).toBe(17);
  });

  it('ages a Feb-29 birth on Feb 28 of non-leap years (Temporal constrain)', () => {
    expect(ageInYears(parseBirthDate('2012-02-29'), parseBirthDate('2026-02-27'))).toBe(13);
    expect(ageInYears(parseBirthDate('2012-02-29'), parseBirthDate('2026-02-28'))).toBe(14);
    expect(ageInYears(parseBirthDate('2012-02-29'), parseBirthDate('2026-03-01'))).toBe(14);
    expect(ageInYears(parseBirthDate('2012-02-29'), parseBirthDate('2027-02-28'))).toBe(15);
    expect(ageInYears(parseBirthDate('2012-02-29'), parseBirthDate('2028-02-29'))).toBe(16);
  });

  it('returns zero for a birth on the reference day', () => {
    expect(ageInYears(parseBirthDate('2026-08-16'), parseBirthDate('2026-08-16'))).toBe(0);
  });

  it('is identical across timezone lines (date-only input has no zone)', () => {
    const born = parseBirthDate('2008-08-16');
    const on = parseBirthDate('2026-08-15');
    expect(ageInYears(born, on)).toBe(17);
  });
});

describe('localDateAt (IANA timezone local calendar date)', () => {
  it('maps UTC instants to the local date — never the UTC date', () => {
    // 2026-08-17T03:30Z is still 2026-08-16 evening in New York.
    expect(
      localDateAt(Temporal.Instant.from('2026-08-17T03:30:00Z'), 'America/New_York').toString(),
    ).toBe('2026-08-16');
    // 2026-08-16T23:30Z is already 2026-08-17 in Kiritimati (UTC+14).
    expect(
      localDateAt(Temporal.Instant.from('2026-08-16T23:30:00Z'), 'Pacific/Kiritimati').toString(),
    ).toBe('2026-08-17');
    // Same instant, three zones, three local dates.
    expect(
      localDateAt(Temporal.Instant.from('2026-08-16T12:00:00Z'), 'America/New_York').toString(),
    ).toBe('2026-08-16');
    expect(
      localDateAt(Temporal.Instant.from('2026-08-16T12:00:00Z'), 'Asia/Tokyo').toString(),
    ).toBe('2026-08-16');
    expect(
      localDateAt(Temporal.Instant.from('2026-08-16T12:00:00Z'), 'Pacific/Auckland').toString(),
    ).toBe('2026-08-17');
  });

  it('is stable across the DST spring-forward and fall-back days', () => {
    // US DST transitions in 2026: March 8 (spring) and November 1 (fall).
    expect(
      localDateAt(Temporal.Instant.from('2026-03-08T12:00:00Z'), 'America/New_York').toString(),
    ).toBe('2026-03-08');
    expect(
      localDateAt(Temporal.Instant.from('2026-11-01T12:00:00Z'), 'America/New_York').toString(),
    ).toBe('2026-11-01');
  });

  it('computes age at a DST-transition instant via the local date', () => {
    const born = parseBirthDate('2008-11-02');
    const instant = Temporal.Instant.from('2026-11-01T12:00:00Z'); // Nov 1 in NY
    expect(ageInYears(born, localDateAt(instant, 'America/New_York'))).toBe(17);
    const nextDay = Temporal.Instant.from('2026-11-02T12:00:00Z');
    expect(ageInYears(born, localDateAt(nextDay, 'America/New_York'))).toBe(18);
  });
});
