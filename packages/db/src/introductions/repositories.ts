import { createHmac } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { aesGcmDecrypt } from '../crypto.js';
import type { Db } from '../client.js';
import { canonicalJsonHash } from '../eligibility/hashing.js';
import {
  INTRODUCTION_ALGORITHM_VERSION,
  INTRODUCTION_BATCH_LIMIT,
  INTRODUCTION_BATCH_SCAN_CHUNK,
  INTRODUCTION_BATCH_SCAN_LIMIT,
  INTRODUCTION_CONFIG_VERSION,
  INTRODUCTION_PASS_COOLDOWN_MS,
  INTRODUCTION_REFRESH_COOLDOWN_MS,
  rankIntroductionFromSafeFacts,
  safeFactCriterion,
  type IntroductionCandidateRecord,
  type IntroductionDecision,
  type IntroductionMode,
  type IntroductionPolicyGate,
  type ConnectionMaterializationPort,
  type IntroductionRepositoryPort,
  type ProfileMatchingSafeViewPort,
} from '@wai/contracts';
type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
type Keyring = ReadonlyMap<string, Buffer>;
type CandidateRow = {
  id: string;
  batch_id: string;
  actor_account_id: string;
  subject_account_id: string;
  mode: IntroductionMode;
  reasons: string[];
  visible_facts: string[];
  score: number;
  decision: IntroductionDecision | null;
  decision_at: Date | null;
  outcome_id: string | null;
};
export class IntroductionIdempotencyConflictError extends Error {
  constructor() {
    super('introduction idempotency conflict');
  }
}
export class IntroductionDecisionConflictError extends Error {
  constructor() {
    super('introduction decision conflict');
  }
}
export class PgIntroductionRepository implements IntroductionRepositoryPort {
  constructor(
    private readonly db: Db,
    private readonly pepper: Buffer,
    private readonly keys: Keyring,
    private readonly gate: IntroductionPolicyGate,
    private readonly materialize: ConnectionMaterializationPort,
    private readonly safeView: ProfileMatchingSafeViewPort,
  ) {}
  private digest(value: string) {
    return createHmac('sha256', this.pepper).update(value).digest('hex');
  }
  private proof(input: {
    actorAccountId: string;
    introductionId: string;
    batchId: string;
    decision: IntroductionDecision;
    payloadDigest: string;
  }) {
    return this.digest(
      'decision:' +
        input.actorAccountId +
        ':' +
        input.introductionId +
        ':' +
        input.batchId +
        ':' +
        input.decision +
        ':' +
        input.payloadDigest,
    );
  }
  private cursor(input: {
    kind: 'list' | 'history';
    actor: string;
    mode?: IntroductionMode;
    batch?: string;
    score?: number;
    id?: string;
    at?: Date;
  }) {
    const body = Buffer.from(
      JSON.stringify({
        k: input.kind,
        a: input.actor,
        m: input.mode,
        b: input.batch,
        s: input.score,
        i: input.id,
        t: input.at?.toISOString(),
      }),
    ).toString('base64url');
    return body + '.' + this.digest('cursor:' + body).slice(0, 32);
  }
  private parseCursor(
    value: string | undefined,
    expected: {
      kind: 'list' | 'history';
      actor: string;
      mode?: IntroductionMode;
      batch?: string;
    },
  ) {
    if (!value) return null;
    const pair = value.split('.');
    const body = pair[0];
    if (!body || pair[1] !== this.digest('cursor:' + body).slice(0, 32))
      throw new Error('INVALID_CURSOR');
    let data: { k: string; a: string; m?: string; b?: string; s?: number; i?: string; t?: string };
    try {
      data = JSON.parse(Buffer.from(body, 'base64url').toString()) as typeof data;
    } catch {
      throw new Error('INVALID_CURSOR');
    }
    if (
      data.k !== expected.kind ||
      data.a !== expected.actor ||
      (expected.mode !== undefined && data.m !== expected.mode) ||
      (expected.batch !== undefined && data.b !== expected.batch) ||
      typeof data.i !== 'string' ||
      (expected.kind === 'list' && typeof data.s !== 'number') ||
      (expected.kind === 'history' && typeof data.t !== 'string')
    )
      throw new Error('INVALID_CURSOR');
    return data;
  }
  async currentBatch(accountId: string, mode: IntroductionMode, now = new Date()) {
    const result = await this.db.execute<BatchRow>(
      sql.raw(
        'SELECT id,account_id,mode,algorithm_version,config_version,created_at,refresh_after FROM introductions.batches WHERE account_id=' +
          quote(accountId) +
          ' AND mode=' +
          quote(mode) +
          ' AND refresh_after>' +
          quote(now) +
          ' ORDER BY created_at DESC LIMIT 1',
      ),
    );
    return result.rows[0] ? toBatch(result.rows[0]) : null;
  }
  async createBatch(input: {
    accountId: string;
    mode: IntroductionMode;
    limit: number;
    now?: Date;
  }) {
    const now = input.now ?? new Date();
    return this.db.transaction(async (tx) => {
      const actorAccount = await tx.execute<{ id: string }>(
        sql.raw(
          'SELECT id FROM iam.accounts WHERE id=' + quote(input.accountId) + " AND state='enabled'",
        ),
      );
      if (!actorAccount.rows[0]) throw new Error('introduction_account_denied');
      await tx.execute(
        sql.raw(
          'SELECT pg_advisory_xact_lock(hashtextextended(' +
            quote(input.accountId + ':' + input.mode) +
            ',0))',
        ),
      );
      const existing = await tx.execute<BatchRow>(
        sql.raw(
          'SELECT id,account_id,mode,algorithm_version,config_version,created_at,refresh_after FROM introductions.batches WHERE account_id=' +
            quote(input.accountId) +
            ' AND mode=' +
            quote(input.mode) +
            ' AND refresh_after>' +
            quote(now) +
            ' ORDER BY created_at DESC LIMIT 1 FOR UPDATE',
        ),
      );
      if (existing.rows[0]) return toBatch(existing.rows[0]);
      const id = crypto.randomUUID();
      const refreshAfter = new Date(now.getTime() + INTRODUCTION_REFRESH_COOLDOWN_MS);
      const owner = await tx.execute<PreferenceRow>(
        sql.raw(
          'SELECT normalized_json,preferences_ciphertext,preferences_nonce,preferences_key_id FROM onboarding.preference_sets WHERE account_id=' +
            quote(input.accountId) +
            " AND purpose='discovery' AND current LIMIT 1",
        ),
      );
      const actor = this.preferences(owner.rows[0], input.mode);
      const accepted: Array<{
        candidateId: string;
        subjectAccountId: string;
        pair: string;
        reasons: readonly string[];
        visibleFacts: readonly string[];
        score: number;
        reasonDigest: string;
      }> = [];
      const target = Math.min(input.limit, INTRODUCTION_BATCH_LIMIT);
      let lastAccountId: string | undefined;
      let scanned = 0;
      while (accepted.length < target && scanned < INTRODUCTION_BATCH_SCAN_LIMIT) {
        const chunkLimit = Math.min(
          INTRODUCTION_BATCH_SCAN_CHUNK,
          INTRODUCTION_BATCH_SCAN_LIMIT - scanned,
        );
        const after = lastAccountId ? ' AND p.account_id>' + quote(lastAccountId) : '';
        const pool = await tx.execute<PreferenceRow & { account_id: string }>(
          sql.raw(
            "SELECT p.account_id,p.normalized_json,p.preferences_ciphertext,p.preferences_nonce,p.preferences_key_id FROM onboarding.preference_sets p JOIN iam.accounts a ON a.id=p.account_id WHERE p.purpose='discovery' AND p.current AND p.account_id<>" +
              quote(input.accountId) +
              " AND a.state='enabled' AND " +
              quote(input.mode) +
              '=ANY(p.modes)' +
              after +
              " AND NOT EXISTS(SELECT 1 FROM connection.connections c WHERE c.state IN ('pending','accepted') AND ((c.account_a=" +
              quote(input.accountId) +
              ' AND c.account_b=p.account_id) OR (c.account_a=p.account_id AND c.account_b=' +
              quote(input.accountId) +
              '))) AND NOT EXISTS(SELECT 1 FROM introductions.cooldowns cd WHERE cd.pair_key=LEAST(' +
              quote(input.accountId) +
              ",p.account_id::text)||':'||GREATEST(" +
              quote(input.accountId) +
              ',p.account_id::text) AND cd.mode=' +
              quote(input.mode) +
              ' AND cd.until_at>' +
              quote(now) +
              ') ORDER BY p.account_id LIMIT ' +
              String(chunkLimit),
          ),
        );
        if (pool.rows.length === 0) break;
        for (const candidate of pool.rows) {
          scanned += 1;
          lastAccountId = candidate.account_id;
          if (
            !(
              await this.gate.check({
                actorAccountId: input.accountId,
                subjectAccountId: candidate.account_id,
                mode: input.mode,
              })
            ).allowed
          )
            continue;
          const subject = this.preferences(candidate, input.mode);
          const subjectFacts = (
            await this.safeView.matchingFacts({
              subjectAccountId: candidate.account_id,
              viewerAccountId: input.accountId,
              mode: input.mode,
              purpose: 'matching',
            })
          ).facts;
          const actorFacts = (
            await this.safeView.matchingFacts({
              subjectAccountId: input.accountId,
              viewerAccountId: candidate.account_id,
              mode: input.mode,
              purpose: 'matching',
            })
          ).facts;
          const ranked = rankIntroductionFromSafeFacts({
            mode: input.mode,
            actorRequirements: actor,
            subjectRequirements: subject,
            actorFacts: actorFacts
              .filter((fact) => fact.policyVersion === 'prf-1')
              .map((fact) => ({
                criterion: safeFactCriterion[fact.factKey] ?? '',
                value: String(fact.value),
                visible: fact.visible,
              })),
            subjectFacts: subjectFacts
              .filter((fact) => fact.policyVersion === 'prf-1')
              .map((fact) => ({
                criterion: safeFactCriterion[fact.factKey] ?? '',
                value: String(fact.value),
                visible: fact.visible,
              })),
          });
          if (!ranked.eligible) continue;
          accepted.push({
            candidateId: crypto.randomUUID(),
            subjectAccountId: candidate.account_id,
            pair: [input.accountId, candidate.account_id].sort().join(':'),
            reasons: ranked.reasons,
            visibleFacts: ranked.visibleFacts,
            score: ranked.score,
            reasonDigest: canonicalJsonHash({
              reasons: ranked.reasons,
              visibleFacts: ranked.visibleFacts,
              algorithm: INTRODUCTION_ALGORITHM_VERSION,
            }),
          });
          if (accepted.length >= target) break;
        }
        if (pool.rows.length < chunkLimit) break;
      }
      await tx.execute(
        sql.raw(
          'INSERT INTO introductions.batches(id,account_id,mode,algorithm_version,config_version,batch_limit,created_at,refresh_after) VALUES(' +
            [
              id,
              input.accountId,
              input.mode,
              INTRODUCTION_ALGORITHM_VERSION,
              INTRODUCTION_CONFIG_VERSION,
              Math.min(input.limit, INTRODUCTION_BATCH_LIMIT),
              now,
              refreshAfter,
            ]
              .map(quote)
              .join(',') +
            ')',
        ),
      );
      for (const candidate of accepted) {
        await tx.execute(
          sql.raw(
            'INSERT INTO introductions.candidates(id,batch_id,actor_account_id,subject_account_id,mode,pair_key,reasons,visible_facts,score,reason_digest,created_at) VALUES(' +
              [
                candidate.candidateId,
                id,
                input.accountId,
                candidate.subjectAccountId,
                input.mode,
                candidate.pair,
                candidate.reasons,
                candidate.visibleFacts,
                candidate.score,
                candidate.reasonDigest,
                now,
              ]
                .map(quote)
                .join(',') +
              ') ON CONFLICT DO NOTHING',
          ),
        );
      }
      return {
        id,
        accountId: input.accountId,
        mode: input.mode,
        algorithmVersion: INTRODUCTION_ALGORITHM_VERSION,
        configVersion: INTRODUCTION_CONFIG_VERSION,
        createdAt: now,
        refreshAfter,
      };
    });
  }
  async listCandidates(input: {
    accountId: string;
    batchId: string;
    mode: IntroductionMode;
    limit: number;
    cursor?: string;
  }) {
    const batchResult = await this.db.execute<BatchRow>(
      sql.raw(
        'SELECT id,account_id,mode,algorithm_version,config_version,created_at,refresh_after FROM introductions.batches WHERE id=' +
          quote(input.batchId) +
          ' AND account_id=' +
          quote(input.accountId) +
          ' AND mode=' +
          quote(input.mode),
      ),
    );
    if (!batchResult.rows[0]) throw new Error('INTRODUCTION_NOT_FOUND');
    const cursor = this.parseCursor(input.cursor, {
      kind: 'list',
      actor: input.accountId,
      mode: input.mode,
      batch: input.batchId,
    });
    const all = await this.db.execute<CandidateRow>(
      sql.raw(
        'SELECT c.id,c.batch_id,c.actor_account_id,c.subject_account_id,c.mode,c.reasons,c.visible_facts,c.score,d.decision,d.created_at AS decision_at,o.id AS outcome_id FROM introductions.candidates c LEFT JOIN introductions.decisions d ON d.introduction_id=c.id AND d.actor_account_id=' +
          quote(input.accountId) +
          ' LEFT JOIN introductions.outcomes o ON o.pair_key=c.pair_key AND o.mode=c.mode WHERE c.batch_id=' +
          quote(input.batchId) +
          ' ORDER BY c.score DESC,c.id',
      ),
    );
    const rows: IntroductionCandidateRecord[] = [];
    const pageSize = Math.min(input.limit, INTRODUCTION_BATCH_LIMIT);
    let lastScanned: CandidateRow | undefined;
    for (const raw of all.rows) {
      if (cursor && (raw.score > cursor.s! || (raw.score === cursor.s && raw.id <= cursor.i!)))
        continue;
      lastScanned = raw;
      const row = toCandidate(raw);
      if (
        !(
          await this.gate.check({
            actorAccountId: input.accountId,
            subjectAccountId: row.subjectAccountId,
            mode: row.mode,
            allowExistingMutual: row.outcome === 'mutual',
          })
        ).allowed
      )
        continue;
      const subjectCard = await this.safeView.matchingCard({
        subjectAccountId: row.subjectAccountId,
        viewerAccountId: input.accountId,
        mode: row.mode,
        purpose: 'matching',
      });
      if (!subjectCard) continue;
      row.subjectCard = subjectCard;
      rows.push(row);
      if (rows.length >= pageSize) break;
    }
    const exhausted =
      lastScanned === undefined || all.rows.indexOf(lastScanned) === all.rows.length - 1;
    return {
      rows,
      nextCursor:
        !exhausted && lastScanned !== undefined
          ? this.cursor({
              kind: 'list',
              actor: input.accountId,
              mode: input.mode,
              batch: input.batchId,
              score: lastScanned.score,
              id: lastScanned.id,
            })
          : null,
      batch: toBatch(batchResult.rows[0]),
    };
  }
  async findCandidate(actorAccountId: string, introductionId: string) {
    const result = await this.db.execute<CandidateRow>(
      sql.raw(
        'SELECT c.id,c.batch_id,c.actor_account_id,c.subject_account_id,c.mode,c.reasons,c.visible_facts,c.score,d.decision,d.created_at AS decision_at,o.id AS outcome_id FROM introductions.candidates c LEFT JOIN introductions.decisions d ON d.introduction_id=c.id AND d.actor_account_id=' +
          quote(actorAccountId) +
          ' LEFT JOIN introductions.outcomes o ON o.pair_key=c.pair_key AND o.mode=c.mode WHERE c.id=' +
          quote(introductionId) +
          ' AND c.actor_account_id=' +
          quote(actorAccountId),
      ),
    );
    return result.rows[0] ? toCandidate(result.rows[0]) : null;
  }
  async canRecoverMutual(input: {
    actorAccountId: string;
    introductionId: string;
    idempotencyKey: string;
    payloadDigest: string;
  }) {
    const keyDigest = canonicalJsonHash(input.idempotencyKey);
    const result = await this.db.execute<{ ok: boolean }>(
      sql.raw(
        'SELECT EXISTS(SELECT 1 FROM introductions.idempotency_keys i JOIN introductions.candidates c ON c.id=' +
          quote(input.introductionId) +
          ' JOIN connection.mutual_materializations m ON m.pair_key=c.pair_key AND m.mode=c.mode JOIN connection.connections con ON con.id=m.connection_id WHERE i.account_id=' +
          quote(input.actorAccountId) +
          ' AND i.key_digest=' +
          quote(keyDigest) +
          ' AND i.payload_digest=' +
          quote(input.payloadDigest) +
          " AND i.result->>'introduction_id'=" +
          quote(input.introductionId) +
          " AND i.result->>'outcome' IS NULL AND con.state='accepted' AND EXISTS(SELECT 1 FROM introductions.decisions d WHERE d.introduction_id=" +
          quote(input.introductionId) +
          ' AND d.actor_account_id=' +
          quote(input.actorAccountId) +
          " AND d.decision='interested')) AS ok",
      ),
    );
    return result.rows[0]?.ok === true;
  }
  async decide(input: {
    actorAccountId: string;
    introductionId: string;
    batchId: string;
    decision: IntroductionDecision;
    idempotencyKey: string;
    payloadDigest: string;
    actorProof: string;
  }) {
    const prepared = await this.db.transaction(async (tx) => {
      await tx.execute(
        sql.raw(
          'SELECT pg_advisory_xact_lock(hashtextextended(' +
            quote(input.actorAccountId + ':' + input.introductionId) +
            ',0))',
        ),
      );
      const kd = canonicalJsonHash(input.idempotencyKey);
      const replay = await tx.execute<{
        payload_digest: string;
        result: { introduction_id: string; outcome: 'mutual' | null };
      }>(
        sql.raw(
          'SELECT payload_digest,result FROM introductions.idempotency_keys WHERE account_id=' +
            quote(input.actorAccountId) +
            ' AND key_digest=' +
            quote(kd) +
            ' FOR UPDATE',
        ),
      );
      if (replay.rows[0]) {
        if (replay.rows[0].payload_digest !== input.payloadDigest)
          throw new IntroductionIdempotencyConflictError();
        if (replay.rows[0].result.introduction_id !== input.introductionId)
          throw new IntroductionIdempotencyConflictError();
        const row = await this.rowTx(
          tx,
          input.actorAccountId,
          replay.rows[0].result.introduction_id,
        );
        if (!row) throw new Error('INTRODUCTION_NOT_FOUND');
        const frozen = await tx.execute<{
          actor_proof: string;
          subject_proof: string;
          materialized_reference: string;
        }>(
          sql.raw(
            'SELECT actor_proof,subject_proof,materialized_reference FROM introductions.outcomes WHERE pair_key=' +
              quote([row.actorAccountId, row.subjectAccountId].sort().join(':')) +
              ' AND mode=' +
              quote(row.mode) +
              ' LIMIT 1',
          ),
        );
        const recoverable = await tx.execute<{ ok: boolean }>(
          sql.raw(
            'SELECT EXISTS(SELECT 1 FROM connection.mutual_materializations m JOIN connection.connections con ON con.id=m.connection_id WHERE m.pair_key=' +
              quote([row.actorAccountId, row.subjectAccountId].sort().join(':')) +
              ' AND m.mode=' +
              quote(row.mode) +
              " AND con.state='accepted') AS ok",
          ),
        );
        const allowExistingMutual = frozen.rows.length > 0 || recoverable.rows[0]?.ok === true;
        const replayGate = await this.gate.check({
          actorAccountId: row.actorAccountId,
          subjectAccountId: row.subjectAccountId,
          mode: row.mode,
          allowExistingMutual,
        });
        if (!replayGate.allowed) throw new Error('INTRODUCTION_GATE_DENIED');
        if (frozen.rows[0])
          return {
            row,
            outcome: 'mutual' as const,
            actorProof: frozen.rows[0].actor_proof,
            subjectProof: frozen.rows[0].subject_proof,
          };
        const other = await this.findOtherInterested(tx, row);
        if (!other)
          return { row, outcome: null, actorProof: this.proof(input), subjectProof: null };
        const otherRow = other.rows[0];
        if (!otherRow)
          return { row, outcome: null, actorProof: this.proof(input), subjectProof: null };
        const current = await tx.execute<{
          actor_proof: string;
          batch_id: string;
          payload_digest: string;
        }>(
          sql.raw(
            'SELECT actor_proof,batch_id,payload_digest FROM introductions.decisions WHERE introduction_id=' +
              quote(row.id) +
              ' AND actor_account_id=' +
              quote(input.actorAccountId) +
              ' LIMIT 1',
          ),
        );
        return {
          row,
          outcome: null,
          actorProof: current.rows[0]?.actor_proof ?? this.proof(input),
          subjectProof: otherRow.actor_proof,
          plan: {
            subjectIntroductionId: otherRow.introduction_id,
            subjectProof: otherRow.actor_proof,
            actorDecisionDigest:
              (current.rows[0]?.batch_id ?? row.batchId) +
              ':interested:' +
              (current.rows[0]?.payload_digest ?? input.payloadDigest),
            subjectDecisionDigest: otherRow.batch_id + ':interested:' + otherRow.payload_digest,
          },
        };
      }
      const row = await this.rowTx(tx, input.actorAccountId, input.introductionId);
      if (!row || row.batchId !== input.batchId) throw new Error('INTRODUCTION_NOT_FOUND');
      const pair = [row.actorAccountId, row.subjectAccountId].sort().join(':');
      await tx.execute(
        sql.raw('SELECT pg_advisory_xact_lock(hashtextextended(' + quote(pair) + ',0))'),
      );
      const finalGate = await this.gate.check({
        actorAccountId: row.actorAccountId,
        subjectAccountId: row.subjectAccountId,
        mode: row.mode,
      });
      if (!finalGate.allowed) throw new Error('INTRODUCTION_GATE_DENIED');
      const actorProof = this.proof(input);
      let cooldownActive = false;
      const prior = await tx.execute<{ decision: IntroductionDecision; actor_proof: string }>(
        sql.raw(
          'SELECT decision,actor_proof FROM introductions.decisions WHERE introduction_id=' +
            quote(input.introductionId) +
            ' AND actor_account_id=' +
            quote(input.actorAccountId) +
            ' FOR UPDATE',
        ),
      );
      if (prior.rows[0] && prior.rows[0].decision !== input.decision)
        throw new IntroductionDecisionConflictError();
      if (input.decision === 'interested') {
        const cooldown = await tx.execute(
          sql.raw(
            'SELECT 1 FROM introductions.cooldowns WHERE pair_key=' +
              quote(pair) +
              ' AND mode=' +
              quote(row.mode) +
              ' AND until_at>now() LIMIT 1',
          ),
        );
        cooldownActive = cooldown.rows.length > 0;
      }
      if (!prior.rows[0]) {
        if (input.decision === 'pass') {
          const ordered = [row.actorAccountId, row.subjectAccountId].sort();
          await tx.execute(
            sql.raw(
              'INSERT INTO introductions.cooldowns(pair_key,actor_account_id,subject_account_id,mode,until_at,source,created_at) VALUES(' +
                [
                  pair,
                  ordered[0]!,
                  ordered[1]!,
                  row.mode,
                  new Date(Date.now() + INTRODUCTION_PASS_COOLDOWN_MS),
                  'pass',
                  new Date(),
                ]
                  .map(quote)
                  .join(',') +
                ') ON CONFLICT(pair_key,mode) DO NOTHING',
            ),
          );
        }
        await tx.execute(
          sql.raw(
            'INSERT INTO introductions.decisions(id,introduction_id,batch_id,actor_account_id,decision,payload_digest,actor_proof,created_at) VALUES(' +
              [
                crypto.randomUUID(),
                input.introductionId,
                input.batchId,
                input.actorAccountId,
                input.decision,
                input.payloadDigest,
                actorProof,
                new Date(),
              ]
                .map(quote)
                .join(',') +
              ')',
          ),
        );
      }
      let plan:
        | {
            subjectIntroductionId: string;
            subjectProof: string;
            actorDecisionDigest: string;
            subjectDecisionDigest: string;
          }
        | undefined;
      if (input.decision === 'interested' && !cooldownActive) {
        const other = await this.findOtherInterested(tx, row);
        if (other.rows[0]) {
          plan = {
            subjectIntroductionId: other.rows[0].introduction_id,
            subjectProof: other.rows[0].actor_proof,
            actorDecisionDigest: input.batchId + ':interested:' + input.payloadDigest,
            subjectDecisionDigest:
              other.rows[0].batch_id + ':interested:' + other.rows[0].payload_digest,
          };
        }
      }
      const result = { introduction_id: row.id, outcome: null };
      await tx.execute(
        sql.raw(
          'INSERT INTO introductions.idempotency_keys(account_id,key_digest,payload_digest,result,created_at) VALUES(' +
            [input.actorAccountId, kd, input.payloadDigest, JSON.stringify(result), new Date()]
              .map(quote)
              .join(',') +
            ')',
        ),
      );
      return { row, outcome: null, actorProof, subjectProof: plan?.subjectProof ?? null, plan };
    });
    if (!prepared.plan)
      return {
        row: prepared.row,
        outcome: prepared.outcome,
        actorProof: prepared.actorProof,
        subjectProof: prepared.subjectProof,
      };
    const plan = prepared.plan;
    if (!this.materialize) throw new Error('CON_MATERIALIZATION_UNAVAILABLE');
    const pair = [prepared.row.actorAccountId, prepared.row.subjectAccountId].sort().join(':');
    let materialized: { outcome: 'mutual'; connectionReference: string };
    try {
      materialized = await this.materialize.materializeMutualIntroduction({
        introductionId: prepared.row.id,
        actorAccountId: prepared.row.actorAccountId,
        subjectAccountId: prepared.row.subjectAccountId,
        mode: prepared.row.mode,
        actorProof: prepared.actorProof,
        subjectProof: plan.subjectProof,
        actorDecisionDigest: plan.actorDecisionDigest,
        subjectDecisionDigest: plan.subjectDecisionDigest,
        subjectIntroductionId: plan.subjectIntroductionId,
        idempotencyKey: canonicalJsonHash({ pair, mode: prepared.row.mode }),
        currentGate: async ({ allowExistingMutual }) =>
          (
            await this.gate.check({
              actorAccountId: prepared.row.actorAccountId,
              subjectAccountId: prepared.row.subjectAccountId,
              mode: prepared.row.mode,
              allowExistingMutual,
            })
          ).allowed,
      });
    } catch (error) {
      throw error;
    }
    try {
      await this.db.transaction(async (tx) => {
        await tx.execute(
          sql.raw('SELECT pg_advisory_xact_lock(hashtextextended(' + quote(pair) + ',0))'),
        );
        await tx.execute(
          sql.raw(
            'INSERT INTO introductions.outcomes(id,pair_key,mode,introduction_id,subject_introduction_id,actor_account_id,subject_account_id,actor_proof,subject_proof,materialization_key,materialized_reference,created_at) VALUES(' +
              [
                crypto.randomUUID(),
                pair,
                prepared.row.mode,
                prepared.row.id,
                plan.subjectIntroductionId,
                prepared.row.actorAccountId,
                prepared.row.subjectAccountId,
                prepared.actorProof,
                plan.subjectProof,
                canonicalJsonHash({ pair, mode: prepared.row.mode }),
                materialized.connectionReference,
                new Date(),
              ]
                .map(quote)
                .join(',') +
              ') ON CONFLICT(pair_key,mode) DO NOTHING',
          ),
        );
        await tx.execute(
          sql.raw(
            'UPDATE introductions.idempotency_keys SET result=' +
              quote(JSON.stringify({ introduction_id: prepared.row.id, outcome: 'mutual' })) +
              '::jsonb WHERE account_id=' +
              quote(input.actorAccountId) +
              ' AND key_digest=' +
              quote(canonicalJsonHash(input.idempotencyKey)),
          ),
        );
      });
    } catch (error) {
      throw error;
    }
    return {
      row: prepared.row,
      outcome: 'mutual' as const,
      actorProof: prepared.actorProof,
      subjectProof: plan.subjectProof,
    };
  }
  async history(input: { accountId: string; limit: number; cursor?: string }) {
    const cursor = this.parseCursor(input.cursor, { kind: 'history', actor: input.accountId });
    const after = cursor
      ? ' AND (d.created_at<' +
        quote(new Date(cursor.t!)) +
        ' OR (d.created_at=' +
        quote(new Date(cursor.t!)) +
        ' AND c.id>' +
        quote(cursor.i!) +
        '))'
      : '';
    const result = await this.db.execute<CandidateRow>(
      sql.raw(
        'SELECT c.id,c.batch_id,c.actor_account_id,c.subject_account_id,c.mode,c.reasons,c.visible_facts,c.score,d.decision,d.created_at AS decision_at,o.id AS outcome_id FROM introductions.candidates c JOIN introductions.decisions d ON d.introduction_id=c.id AND d.actor_account_id=' +
          quote(input.accountId) +
          ' LEFT JOIN introductions.outcomes o ON o.pair_key=c.pair_key AND o.mode=c.mode WHERE TRUE' +
          after +
          ' ORDER BY d.created_at DESC,c.id',
      ),
    );
    const pageSize = Math.min(input.limit, 50);
    const rows: IntroductionCandidateRecord[] = [];
    let lastScanned: CandidateRow | undefined;
    for (const raw of result.rows) {
      lastScanned = raw;
      if (
        !(
          await this.gate.check({
            actorAccountId: input.accountId,
            subjectAccountId: raw.subject_account_id,
            mode: raw.mode,
            allowExistingMutual: raw.outcome_id !== null,
          })
        ).allowed
      )
        continue;
      const row = toCandidate(raw);
      const subjectCard = await this.safeView.matchingCard({
        subjectAccountId: row.subjectAccountId,
        viewerAccountId: input.accountId,
        mode: row.mode,
        purpose: 'matching',
      });
      if (!subjectCard) continue;
      row.subjectCard = subjectCard;
      rows.push(row);
      if (rows.length >= pageSize) break;
    }
    return {
      items: rows.map((r) => ({
        id: r.id,
        mode: r.mode,
        subject: { display_name: r.subjectCard!.displayName },
        reasons: [...r.reasons],
        explanation: 'Introduction decision recorded.',
        decision: r.decision,
        outcome: r.outcome,
      })),
      next_cursor:
        lastScanned !== undefined && result.rows.indexOf(lastScanned) < result.rows.length - 1
          ? this.cursor({
              kind: 'history',
              actor: input.accountId,
              at: new Date(lastScanned.decision_at!),
              id: lastScanned.id,
            })
          : null,
    };
  }
  private async findOtherInterested(tx: Tx, row: IntroductionCandidateRecord) {
    return tx.execute<{
      actor_proof: string;
      introduction_id: string;
      batch_id: string;
      payload_digest: string;
    }>(
      sql.raw(
        'SELECT d.actor_proof,d.introduction_id,d.batch_id,d.payload_digest FROM introductions.decisions d JOIN introductions.candidates c ON c.id=d.introduction_id WHERE c.pair_key=' +
          quote([row.actorAccountId, row.subjectAccountId].sort().join(':')) +
          ' AND c.mode=' +
          quote(row.mode) +
          ' AND c.actor_account_id=' +
          quote(row.subjectAccountId) +
          ' AND c.subject_account_id=' +
          quote(row.actorAccountId) +
          " AND d.decision='interested' LIMIT 1",
      ),
    );
  }
  private async rowTx(tx: Tx, actor: string, id: string) {
    const result = await tx.execute<CandidateRow>(
      sql.raw(
        'SELECT c.id,c.batch_id,c.actor_account_id,c.subject_account_id,c.mode,c.reasons,c.visible_facts,c.score,d.decision,d.created_at AS decision_at,o.id AS outcome_id FROM introductions.candidates c LEFT JOIN introductions.decisions d ON d.introduction_id=c.id AND d.actor_account_id=' +
          quote(actor) +
          ' LEFT JOIN introductions.outcomes o ON o.pair_key=c.pair_key AND o.mode=c.mode WHERE c.id=' +
          quote(id) +
          ' AND c.actor_account_id=' +
          quote(actor),
      ),
    );
    return result.rows[0] ? toCandidate(result.rows[0]) : null;
  }
  private preferences(row: PreferenceRow | undefined, mode?: IntroductionMode) {
    if (!row) return [];
    const key = this.keys.get(row.preferences_key_id);
    if (!key) return [];
    try {
      const values = JSON.parse(
        aesGcmDecrypt(key, {
          ciphertext: row.preferences_ciphertext,
          nonce: row.preferences_nonce,
        }),
      );
      return (Array.isArray(values) ? values : [])
        .filter(
          (item: Record<string, unknown>) =>
            mode === undefined || String(item['mode'] ?? '') === mode,
        )
        .map((item: Record<string, unknown>) => ({
          criterion: String(item['criterion'] ?? ''),
          value: String(item['value'] ?? ''),
          strength: String(item['strength'] ?? '') as
            | 'hard_requirement'
            | 'strong_preference'
            | 'weak_preference'
            | 'does_not_matter',
          deal_breaker: Boolean(item['deal_breaker']),
          // ONB normalized_json intentionally has no visibility/audience. It is
          // never a source for candidate disclosure.
          visible: false,
        }));
    } catch {
      return [];
    }
  }
}
type BatchRow = {
  id: string;
  account_id: string;
  mode: IntroductionMode;
  algorithm_version: string;
  config_version: string;
  created_at: Date;
  refresh_after: Date;
};
type PreferenceRow = {
  account_id?: string;
  normalized_json: unknown;
  preferences_ciphertext: string;
  preferences_nonce: string;
  preferences_key_id: string;
};
function quote(value: unknown): string {
  if (value instanceof Date)
    return "'" + value.toISOString().replaceAll("'", "''") + "'::timestamptz";
  if (Array.isArray(value)) return 'ARRAY[' + value.map(quote).join(',') + ']::text[]';
  if (typeof value === 'number') return String(value);
  if (typeof value === 'object' && value !== null)
    return "'" + JSON.stringify(value).replaceAll("'", "''") + "'::jsonb";
  return "'" + String(value).replaceAll("'", "''") + "'";
}
function toBatch(row: BatchRow) {
  return {
    id: row.id,
    accountId: row.account_id,
    mode: row.mode,
    algorithmVersion: row.algorithm_version,
    configVersion: row.config_version,
    createdAt: new Date(row.created_at),
    refreshAfter: new Date(row.refresh_after),
  };
}
function toCandidate(row: CandidateRow): IntroductionCandidateRecord {
  return {
    id: row.id,
    batchId: row.batch_id,
    actorAccountId: row.actor_account_id,
    subjectAccountId: row.subject_account_id,
    mode: row.mode,
    reasons: row.reasons as IntroductionCandidateRecord['reasons'],
    visibleFacts: row.visible_facts,
    score: row.score,
    decision: row.decision,
    actorDecisionAt: row.decision_at,
    subjectDecisionAt: null,
    outcome: row.outcome_id ? 'mutual' : null,
  };
}
