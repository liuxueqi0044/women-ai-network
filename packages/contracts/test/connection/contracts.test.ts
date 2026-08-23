import { describe, expect, it } from 'vitest';
import {
  connectionActionRequestSchema,
  connectionModeSchema,
  connectionRequestSchema,
  connectionStateSchema,
  SAFETY_BLOCK_DECISION,
  type InteractionGatePort,
} from '@wai/contracts';

describe('CON-01 connection contracts', () => {
  it('exports strict state/mode/action schemas and the formal safety token', () => {
    expect(connectionStateSchema.parse('pending')).toBe('pending');
    expect(connectionModeSchema.parse('friends')).toBe('friends');
    expect(
      connectionRequestSchema.safeParse({ recipient_account_id: 'bad', mode: 'friends' }).success,
    ).toBe(false);
    expect(connectionActionRequestSchema.safeParse({ extra: true }).success).toBe(false);
    expect(SAFETY_BLOCK_DECISION).toBeDefined();
  });

  it('types the composite interaction gate', async () => {
    const gate: InteractionGatePort = {
      check: async () => ({ allowed: true }),
    };
    await expect(
      gate.check({
        actorAccountId: '00000000-0000-4000-8000-000000000001',
        subjectAccountId: '00000000-0000-4000-8000-000000000002',
        capability: 'introduce',
        mode: 'friends',
        surface: 'matching',
      }),
    ).resolves.toEqual({ allowed: true });
  });
});
