/** ELG clock — the wall-clock instant for declarations and derivations. */
export interface ElgClock {
  now(): Date;
}

export class SystemElgClock implements ElgClock {
  now(): Date {
    return new Date();
  }
}
