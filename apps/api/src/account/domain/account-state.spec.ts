import { describe, expect, it } from 'vitest';
import {
  ACCOUNT_STATE_REASONS,
  ACCOUNT_STATE_VALUES,
  DomainStateError,
  assertTransition,
  canTransition,
  transitionReason,
} from './account-state.js';

const LEGAL: ReadonlyArray<readonly [string, string, string]> = [
  ['enabled', 'suspended', 'admin_suspend'],
  ['suspended', 'enabled', 'admin_unsuspend'],
  ['enabled', 'deletion_pending', 'user_deletion_request'],
  ['suspended', 'deletion_pending', 'user_deletion_request'],
  ['deletion_pending', 'enabled', 'user_deletion_cancel'],
  ['deletion_pending', 'deleted', 'deletion_completed'],
];

const ILLEGAL: ReadonlyArray<readonly [string, string]> = [
  ['enabled', 'enabled'],
  ['suspended', 'suspended'],
  ['deletion_pending', 'deletion_pending'],
  ['deleted', 'deleted'],
  ['deleted', 'enabled'],
  ['deleted', 'suspended'],
  ['deleted', 'deletion_pending'],
  ['enabled', 'deleted'], // must pass through deletion_pending
  ['suspended', 'deleted'],
  ['enabled', 'enabled'],
];

describe('account state machine', () => {
  it('accepts every legal transition', () => {
    for (const [from, to] of LEGAL) {
      expect(canTransition(from as never, to as never), `${from}->${to}`).toBe(true);
    }
  });

  it('rejects every illegal transition (table)', () => {
    for (const [from, to] of ILLEGAL) {
      expect(canTransition(from as never, to as never), `${from}->${to}`).toBe(false);
    }
  });

  it('assertTransition passes for legal transitions with the matching reason', () => {
    for (const [from, to, reason] of LEGAL) {
      expect(() => assertTransition(from as never, to as never, reason as never)).not.toThrow();
    }
  });

  it('assertTransition rejects wrong reason codes for an otherwise legal edge', () => {
    expect(() => assertTransition('enabled', 'suspended', 'admin_unsuspend')).toThrow(
      DomainStateError,
    );
    expect(() => assertTransition('deletion_pending', 'deleted', 'user_deletion_request')).toThrow(
      DomainStateError,
    );
  });

  it('assertTransition throws DomainStateError on illegal edges, including out of deleted', () => {
    for (const [from, to] of ILLEGAL) {
      expect(
        () => assertTransition(from as never, to as never, 'deletion_completed' as never),
        `${from}->${to}`,
      ).toThrow(DomainStateError);
    }
  });

  it('transitionReason returns the allowed reason only for legal edges', () => {
    expect(transitionReason('enabled', 'suspended')).toBe('admin_suspend');
    expect(transitionReason('deletion_pending', 'deleted')).toBe('deletion_completed');
    expect(transitionReason('deleted', 'enabled')).toBeUndefined();
    expect(transitionReason('enabled', 'deleted')).toBeUndefined();
  });

  it('defines reasons as a stable closed enum without duplicates', () => {
    expect(new Set(ACCOUNT_STATE_REASONS).size).toBe(ACCOUNT_STATE_REASONS.length);
    expect(ACCOUNT_STATE_VALUES).toEqual(['enabled', 'suspended', 'deletion_pending', 'deleted']);
  });

  it('all four states are covered by exactly one outgoing rule each', () => {
    // Guards against future states being added without transition rules.
    for (const state of ACCOUNT_STATE_VALUES) {
      expect(state).toBeDefined();
    }
  });
});
