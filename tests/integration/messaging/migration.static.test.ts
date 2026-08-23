import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
const sql = readFileSync(
  resolve(process.cwd(), 'packages/db/migrations/0014_messaging.sql'),
  'utf8',
);
describe('MSG-01 migration contract', () => {
  it('contains explicit lifecycle and privacy guards', () => {
    expect(sql).toContain('-- +BEGIN UP');
    expect(sql).toContain('-- +BEGIN DOWN');
    expect(sql).toContain('messaging_conversation_epoch_unique');
    expect(sql).toContain('UNIQUE(conversation_id, server_sequence)');
    expect(sql).toContain('UNIQUE(conversation_id, sender_id, client_message_id)');
    expect(sql).toContain('opaque outbox only');
  });
});
