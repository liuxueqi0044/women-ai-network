import { describe, expect, it } from 'vitest';
import { computeIdleExpiryMs } from './session-expiry.js';

const IDLE_MS = 604_800_000; // 7 days
const ABSOLUTE_MS = 2_592_000_000; // 30 days
const NOW_MS = 1_000_000_000_000;

describe('computeIdleExpiryMs (R1-02)', () => {
  it('extends idle by the configured window when far from the absolute expiry', () => {
    expect(computeIdleExpiryMs(NOW_MS, 604_800, NOW_MS + ABSOLUTE_MS)).toBe(NOW_MS + IDLE_MS);
  });

  it('caps the idle expiry at the absolute expiry when the window would cross it', () => {
    const absolute = NOW_MS + 3_600_000; // 1 hour of life left
    expect(computeIdleExpiryMs(NOW_MS, 604_800, absolute)).toBe(absolute);
  });

  it('caps exactly when the idle window lands on the absolute expiry', () => {
    const absolute = NOW_MS + IDLE_MS;
    expect(computeIdleExpiryMs(NOW_MS, 604_800, absolute)).toBe(absolute);
  });

  it('caps at the absolute expiry even when the absolute is already in the past', () => {
    const absolute = NOW_MS - 1_000;
    expect(computeIdleExpiryMs(NOW_MS, 604_800, absolute)).toBe(absolute);
  });

  it('keeps the exact absolute timestamp — the cap never re-rounds it', () => {
    const absolute = NOW_MS + 123_456_789;
    expect(computeIdleExpiryMs(NOW_MS, 604_800, absolute)).toBe(absolute);
  });
});
