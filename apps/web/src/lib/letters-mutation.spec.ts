import { describe, expect, it } from 'vitest';
import {
  bindMutationAttempt,
  createLetterPayload,
  patchLetterPayload,
  shouldReuseAfterFailure,
} from '../../app/letters/mutation.js';

describe('letter mutation idempotency binding', () => {
  it('reuses a key only when payload and optimistic version are unchanged', () => {
    const first = bindMutationAttempt(null, { title: 'A' }, 1, () => 'key-a');
    expect(bindMutationAttempt(first, { title: 'A' }, 1, () => 'key-b')).toBe(first);
    expect(bindMutationAttempt(first, { title: 'B' }, 1, () => 'key-b').key).toBe('key-b');
    expect(bindMutationAttempt(first, { title: 'A' }, 2, () => 'key-c').key).toBe('key-c');
    expect(
      bindMutationAttempt(first, { letter_id: 'B', action: 'publish' }, 1, () => 'key-d').key,
    ).toBe('key-d');
  });

  it('keeps an ambiguous network attempt but rotates on validation/conflict', () => {
    expect(shouldReuseAfterFailure(null)).toBe(true);
    expect(shouldReuseAfterFailure(503)).toBe(true);
    expect(shouldReuseAfterFailure(400)).toBe(false);
    expect(shouldReuseAfterFailure(409)).toBe(false);
  });

  it('keeps kind on create but never sends it in a patch payload', () => {
    const content = { title: 'A', topics: ['family'] };
    expect(createLetterPayload('public_letter', content)).toEqual({
      kind: 'public_letter',
      ...content,
    });
    expect(patchLetterPayload(content)).toEqual(content);
    expect(patchLetterPayload(content)).not.toHaveProperty('kind');
  });
});
