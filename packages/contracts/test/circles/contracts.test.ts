import { describe, expect, it } from 'vitest';
import {
  capabilitySchema,
  circleCreateRequestSchema,
  circlePatchRequestSchema,
  circleNotesQuerySchema,
} from '../../src/index.js';

describe('CIR-01 contracts', () => {
  it('keeps circle writes strict and bounded', () => {
    const value = circleCreateRequestSchema.parse({
      name: 'Women builders',
      visibility: 'approval_required',
      mode: 'friends',
      scope_kind: 'country',
      country_code: 'CN',
      topics: ['culture'],
      member_cap: 20,
    });
    expect(value.lifecycle).toBe('draft');
    expect(circleCreateRequestSchema.safeParse({ ...value, score: 1 }).success).toBe(false);
    expect(circleCreateRequestSchema.safeParse({ ...value, member_cap: 501 }).success).toBe(false);
    expect(circleCreateRequestSchema.safeParse({ ...value, topics: ['unknown'] }).success).toBe(
      false,
    );
    expect(
      circleCreateRequestSchema.safeParse({ ...value, topics: ['culture', 'culture'] }).success,
    ).toBe(false);
    expect(circleCreateRequestSchema.safeParse({ ...value, scope_kind: 'city' }).success).toBe(
      false,
    );
    expect(
      circleCreateRequestSchema.safeParse({ ...value, scope_kind: 'online', country_code: 'CN' })
        .success,
    ).toBe(false);
  });
  it('does not accept private fields in patch or unbounded notes paging', () => {
    expect(circlePatchRequestSchema.safeParse({ owner_account_id: 'x' }).success).toBe(false);
    expect(
      circlePatchRequestSchema.parse({
        scope_kind: 'online',
        country_code: null,
        city_label: null,
      }),
    ).toMatchObject({ scope_kind: 'online' });
    expect(circleNotesQuerySchema.safeParse({ limit: 51 }).success).toBe(false);
  });
  it('keeps the circle partition capability distinct from event visibility', () => {
    expect(capabilitySchema.parse('circles')).toBe('circles');
  });
});
