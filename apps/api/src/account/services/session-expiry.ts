/**
 * Session expiry math (R1-02). The idle window slides on activity but can
 * never extend past the absolute expiry — the DB constraint
 * `idle_expires_at <= absolute_expires_at` is the final backstop, and this
 * function keeps every issue/touch/rotate path inside it.
 */
export function computeIdleExpiryMs(
  nowMs: number,
  idleSeconds: number,
  absoluteExpiresAtMs: number,
): number {
  return Math.min(nowMs + idleSeconds * 1000, absoluteExpiresAtMs);
}
