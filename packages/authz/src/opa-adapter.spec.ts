import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type {
  DecisionOutput,
  ModeDecisionInput,
  PartitionDecisionInput,
  PolicyDocument,
} from '@wai/contracts';
import { OpaInputInvalidError, OpaUnavailableError } from './opa-errors.js';
import { OpaDecisionClient, OpaModeDecisionAdapter, OpaPartitionDecisionAdapter } from './index.js';

const BASE_POLICY: PolicyDocument = {
  policy_id: '3f1c7f1e-9a2b-4c3d-8e4f-5a6b7c8d9e0f',
  revision: 3,
  minimum_account_age: 13,
  age_of_majority: 18,
  digital_consent_age: 16,
  parental_consent_required_below: 16,
  youth_launch_state: 'launched',
  allowed_cohorts: ['youth_13', 'youth_14', 'youth_15', 'youth_16', 'youth_17'],
  cross_cohort_contact_policy: 'same_cohort_only',
  mode_rules: {
    mode_enabled: {
      friends: true,
      activities: true,
      professional: true,
      circles: true,
      events: true,
      dating: true,
    },
    platform_minimum_age_by_mode: {
      friends: 0,
      activities: 0,
      professional: 0,
      circles: 0,
      events: 0,
      dating: 18,
    },
    mode_minimum_age: {
      friends: 0,
      activities: 0,
      professional: 0,
      circles: 0,
      events: 0,
      dating: 0,
    },
    required_age_assurance_by_mode: {
      friends: 'self_declared',
      activities: 'self_declared',
      professional: 'self_declared',
      circles: 'self_declared',
      events: 'self_declared',
      dating: 'self_declared',
    },
  },
};

function modeInput(overrides: Partial<ModeDecisionInput> = {}): ModeDecisionInput {
  return {
    policy: structuredClone(BASE_POLICY),
    subject: {
      age_years: 25,
      age_band: 'adult',
      cohort_key: 'adult_25',
      assurance_level: 'self_declared',
    },
    request: { mode: 'friends', effective_at: '2026-08-17T10:00:00+08:00' },
    ...overrides,
  };
}

function partitionInput(overrides: Partial<PartitionDecisionInput> = {}): PartitionDecisionInput {
  return {
    actor_policy: structuredClone(BASE_POLICY),
    subject_policy: structuredClone(BASE_POLICY),
    actor: {
      age_years: 25,
      age_band: 'adult',
      cohort_key: 'adult_25',
      assurance_level: 'self_declared',
    },
    subject: {
      age_years: 25,
      age_band: 'adult',
      cohort_key: 'adult_25',
      assurance_level: 'self_declared',
    },
    request: { capability: 'discover', effective_at: '2026-08-17T10:00:00+08:00' },
    ...overrides,
  };
}

function allowResult(): DecisionOutput {
  return { decision: 'allow', reason_codes: [], obligations: [] };
}

type Handler = (req: IncomingMessage, res: ServerResponse) => void;

describe('OpaModeDecisionAdapter', () => {
  let server: Server;
  let handler: Handler = (_req, res) => {
    res.writeHead(500).end();
  };
  let baseUrl: string;

  beforeEach(async () => {
    handler = (_req, res) => {
      res.writeHead(500).end();
    };
    server = createServer((req, res) => handler(req, res));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterEach(async () => {
    if (!server.listening) return;
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
  });

  function respondJson(status: number, body: unknown) {
    handler = (_req, res) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
  }

  function adapter(timeoutMs = 1000) {
    return new OpaModeDecisionAdapter(baseUrl, timeoutMs);
  }

  it('returns allow from a valid envelope (decision_id tolerated)', async () => {
    respondJson(200, { decision_id: 'abc123', result: allowResult() });
    await expect(adapter().decide(modeInput())).resolves.toEqual(allowResult());
  });

  it('passes deny results and obligations through untouched', async () => {
    respondJson(200, {
      result: {
        decision: 'deny',
        reason_codes: ['MODE_MINIMUM_AGE_NOT_MET', 'AGE_ASSURANCE_REQUIRED'],
        obligations: ['parental_consent_required'],
      },
    });
    await expect(adapter().decide(modeInput())).resolves.toEqual({
      decision: 'deny',
      reason_codes: ['MODE_MINIMUM_AGE_NOT_MET', 'AGE_ASSURANCE_REQUIRED'],
      obligations: ['parental_consent_required'],
    });
  });

  it('fails closed with POLICY_OUTPUT_INVALID on malformed JSON', async () => {
    handler = (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('not json {');
    };
    await expect(adapter().decide(modeInput())).resolves.toEqual({
      decision: 'deny',
      reason_codes: ['POLICY_OUTPUT_INVALID'],
      obligations: [],
    });
  });

  it('fails closed with POLICY_OUTPUT_INVALID on empty body', async () => {
    handler = (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('');
    };
    await expect(adapter().decide(modeInput())).resolves.toEqual({
      decision: 'deny',
      reason_codes: ['POLICY_OUTPUT_INVALID'],
      obligations: [],
    });
  });

  it('fails closed when the envelope is missing result', async () => {
    respondJson(200, { decision_id: 'abc123' });
    await expect(adapter().decide(modeInput())).resolves.toEqual({
      decision: 'deny',
      reason_codes: ['POLICY_OUTPUT_INVALID'],
      obligations: [],
    });
  });

  it('fails closed when result carries an unknown reason code', async () => {
    respondJson(200, {
      result: { decision: 'deny', reason_codes: ['NOT_A_REAL_CODE'], obligations: [] },
    });
    await expect(adapter().decide(modeInput())).resolves.toEqual({
      decision: 'deny',
      reason_codes: ['POLICY_OUTPUT_INVALID'],
      obligations: [],
    });
  });

  it('fails closed when result leaks a sensitive field (account_id)', async () => {
    respondJson(200, {
      result: { ...allowResult(), account_id: 'acct_123', birthday: '2001-01-01' },
    });
    await expect(adapter().decide(modeInput())).resolves.toEqual({
      decision: 'deny',
      reason_codes: ['POLICY_OUTPUT_INVALID'],
      obligations: [],
    });
  });

  it('fails closed when the envelope carries unexpected fields', async () => {
    respondJson(200, { result: allowResult(), input: { policy: {} } });
    await expect(adapter().decide(modeInput())).resolves.toEqual({
      decision: 'deny',
      reason_codes: ['POLICY_OUTPUT_INVALID'],
      obligations: [],
    });
  });

  it('fails closed with POLICY_ENGINE_UNAVAILABLE on 500', async () => {
    handler = (_req, res) => {
      res.writeHead(500).end('boom');
    };
    await expect(adapter().decide(modeInput())).resolves.toEqual({
      decision: 'deny',
      reason_codes: ['POLICY_ENGINE_UNAVAILABLE'],
      obligations: [],
    });
  });

  it('fails closed with POLICY_ENGINE_UNAVAILABLE on connection refused', async () => {
    const port = (server.address() as AddressInfo).port;
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
    const dead = new OpaModeDecisionAdapter(`http://127.0.0.1:${port}`, 1000);
    await expect(dead.decide(modeInput())).resolves.toEqual({
      decision: 'deny',
      reason_codes: ['POLICY_ENGINE_UNAVAILABLE'],
      obligations: [],
    });
  });

  it('fails closed with POLICY_ENGINE_UNAVAILABLE on timeout', async () => {
    handler = (_req, _res) => {
      // never respond
    };
    await expect(adapter(50).decide(modeInput())).resolves.toEqual({
      decision: 'deny',
      reason_codes: ['POLICY_ENGINE_UNAVAILABLE'],
      obligations: [],
    });
  });

  it('throws OpaInputInvalidError for a malformed input (programming error)', async () => {
    const bad = modeInput() as unknown as Record<string, unknown>;
    bad['subject'] = { ...(bad['subject'] as object), account_id: 'acct_1' };
    await expect(adapter().decide(bad as unknown as ModeDecisionInput)).rejects.toBeInstanceOf(
      OpaInputInvalidError,
    );
    expect(server.listening).toBe(true); // engine never contacted
  });
});

describe('OpaPartitionDecisionAdapter', () => {
  let server: Server;
  let handler: Handler = (_req, res) => {
    res.writeHead(500).end();
  };
  let baseUrl: string;

  beforeEach(async () => {
    handler = (_req, res) => {
      res.writeHead(500).end();
    };
    server = createServer((req, res) => handler(req, res));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterEach(async () => {
    if (!server.listening) return;
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
  });

  function adapter(timeoutMs = 1000) {
    return new OpaPartitionDecisionAdapter(baseUrl, timeoutMs);
  }

  it('returns allow from a valid envelope', async () => {
    handler = (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ result: allowResult() }));
    };
    await expect(adapter().decide(partitionInput())).resolves.toEqual(allowResult());
  });

  it('fails closed with POLICY_OUTPUT_INVALID on malformed output', async () => {
    handler = (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ result: { decision: 'maybe' } }));
    };
    await expect(adapter().decide(partitionInput())).resolves.toEqual({
      decision: 'deny',
      reason_codes: ['POLICY_OUTPUT_INVALID'],
      obligations: [],
    });
  });

  it('fails closed with POLICY_ENGINE_UNAVAILABLE on 503', async () => {
    handler = (_req, res) => {
      res.writeHead(503).end();
    };
    await expect(adapter().decide(partitionInput())).resolves.toEqual({
      decision: 'deny',
      reason_codes: ['POLICY_ENGINE_UNAVAILABLE'],
      obligations: [],
    });
  });

  it('throws OpaInputInvalidError for a malformed input', async () => {
    const bad = partitionInput() as unknown as Record<string, unknown>;
    bad['request'] = { capability: 'dating', effective_at: 'not-a-date' };
    await expect(adapter().decide(bad as unknown as PartitionDecisionInput)).rejects.toBeInstanceOf(
      OpaInputInvalidError,
    );
    expect(server.listening).toBe(true);
  });

  it('throws OpaUnavailableError from the raw client for direct callers', async () => {
    handler = (_req, res) => {
      res.writeHead(500).end();
    };
    const client = new OpaDecisionClient(baseUrl, 1000);
    await expect(client.evaluate('mode_decision', {})).rejects.toBeInstanceOf(OpaUnavailableError);
  });
});
