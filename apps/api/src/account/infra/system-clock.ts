import type { Clock } from '../ports.js';

/** Production clock — system time is the only expiry authority. */
export class SystemClock implements Clock {
  now(): number {
    return Date.now();
  }
}
