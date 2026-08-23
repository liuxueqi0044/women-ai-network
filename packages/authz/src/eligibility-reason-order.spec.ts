import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { reasonCodes } from '@wai/contracts';

function regoReasonOrder(fileName: string): string[] {
  const source = readFileSync(resolve(__dirname, '..', 'policies', fileName), 'utf8');
  const block = /reason_order\(ctx\) := \[([\s\S]*?)\n\]/.exec(source)?.[1];
  if (block === undefined) throw new Error(`${fileName} has no reason_order array`);
  return [...block.matchAll(/"([A-Z_]+)"/g)].map((match) => match[1] as string);
}

describe('eligibility Rego reason-code order', () => {
  it.each(['eligibility_mode_decision.rego', 'eligibility_partition_decision.rego'])(
    '%s stays aligned with the contract order',
    (fileName) => {
      expect(regoReasonOrder(fileName)).toEqual(reasonCodes);
    },
  );
});
