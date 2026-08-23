import { Injectable } from '@nestjs/common';
import { createHmac } from 'node:crypto';
import { sql, type Db } from '@wai/db';
import type {
  ConnectionMaterializationPort,
  InteractionGatePort,
  IntroductionMode,
} from '@wai/contracts';
function quote(value: string) {
  return "'" + value.replaceAll("'", "''") + "'";
}
@Injectable()
export class PgMutualMaterialization implements ConnectionMaterializationPort {
  constructor(
    private readonly db: Db,
    private readonly gate: InteractionGatePort,
    private readonly pepper: Buffer,
  ) {}
  async materializeMutualIntroduction(input: {
    introductionId: string;
    actorAccountId: string;
    subjectAccountId: string;
    mode: IntroductionMode;
    actorProof: string;
    subjectProof: string;
    actorDecisionDigest: string;
    subjectDecisionDigest: string;
    subjectIntroductionId: string;
    idempotencyKey: string;
    currentGate: (input: { allowExistingMutual: boolean }) => Promise<boolean>;
  }) {
    return this.db.transaction(async (tx) => {
      const pair = [input.actorAccountId, input.subjectAccountId].sort();
      await tx.execute(
        sql.raw('SELECT pg_advisory_xact_lock(hashtextextended(' + quote(pair.join(':')) + ',0))'),
      );
      const actorExpected = createHmac('sha256', this.pepper)
        .update(
          'decision:' +
            input.actorAccountId +
            ':' +
            input.introductionId +
            ':' +
            input.actorDecisionDigest,
        )
        .digest('hex');
      if (actorExpected !== input.actorProof) throw new Error('CON_PROOF_INVALID');
      const subjectExpected = createHmac('sha256', this.pepper)
        .update(
          'decision:' +
            input.subjectAccountId +
            ':' +
            input.subjectIntroductionId +
            ':' +
            input.subjectDecisionDigest,
        )
        .digest('hex');
      if (subjectExpected !== input.subjectProof) throw new Error('CON_PROOF_INVALID');
      const bridge = await tx.execute<{
        connection_id: string;
        state: string;
        introduction_id: string;
        actor_account_id: string;
        subject_account_id: string;
        actor_proof: string;
        subject_proof: string;
      }>(
        sql.raw(
          'SELECT m.connection_id,c.state,m.introduction_id,m.actor_account_id,m.subject_account_id,m.actor_proof,m.subject_proof FROM connection.mutual_materializations m JOIN connection.connections c ON c.id=m.connection_id WHERE m.pair_key=' +
            quote(pair.join(':')) +
            ' AND m.mode=' +
            quote(input.mode) +
            ' FOR UPDATE',
        ),
      );
      if (bridge.rows[0]) {
        const stored = bridge.rows[0];
        const sameOrientation = stored.actor_account_id === input.actorAccountId;
        const proofMatches = sameOrientation
          ? stored.actor_proof === input.actorProof &&
            stored.subject_proof === input.subjectProof &&
            stored.introduction_id === input.introductionId
          : stored.actor_proof === input.subjectProof &&
            stored.subject_proof === input.actorProof &&
            stored.introduction_id === input.subjectIntroductionId;
        if (!proofMatches) throw new Error('CON_PROOF_INVALID');
        const interactionAllowed = await this.gate.check({
          actorAccountId: input.actorAccountId,
          subjectAccountId: input.subjectAccountId,
          capability: 'introduce',
          mode: input.mode,
          surface: 'matching',
        });
        if (!interactionAllowed.allowed) throw new Error('CON_MATERIALIZATION_GATE_DENIED');
        if (!(await input.currentGate({ allowExistingMutual: true })))
          throw new Error('CON_MATERIALIZATION_GATE_DENIED');
        if (stored.state === 'accepted')
          return { outcome: 'mutual' as const, connectionReference: stored.connection_id };
        throw new Error('CONNECTION_TERMINAL');
      }
      const allowed = await this.gate.check({
        actorAccountId: input.actorAccountId,
        subjectAccountId: input.subjectAccountId,
        capability: 'introduce',
        mode: input.mode,
        surface: 'matching',
      });
      if (!allowed.allowed) throw new Error('CON_MATERIALIZATION_GATE_DENIED');
      if (!(await input.currentGate({ allowExistingMutual: false })))
        throw new Error('CON_MATERIALIZATION_GATE_DENIED');
      const existing = await tx.execute<{ id: string; state: string }>(
        sql.raw(
          'SELECT id,state FROM connection.connections WHERE account_a=' +
            quote(pair[0]!) +
            ' AND account_b=' +
            quote(pair[1]!) +
            " AND state IN ('pending','accepted') FOR UPDATE",
        ),
      );
      if (existing.rows[0]) {
        const prior = await tx.execute<{ reason: string }>(
          sql.raw(
            'SELECT reason FROM connection.transitions WHERE connection_id=' +
              quote(existing.rows[0].id!) +
              " AND reason='mch_mutual' LIMIT 1",
          ),
        );
        if (prior.rows[0])
          return { outcome: 'mutual' as const, connectionReference: existing.rows[0].id };
        throw new Error('CONNECTION_EXISTS');
      }
      const id = crypto.randomUUID();
      await tx.execute(
        sql.raw(
          'INSERT INTO connection.connections(id,account_a,account_b,requester_account_id,recipient_account_id,mode,state,version,created_at,updated_at,accepted_at) VALUES(' +
            [
              id,
              pair[0],
              pair[1],
              input.actorAccountId,
              input.subjectAccountId,
              input.mode,
              'accepted',
              1,
              new Date(),
              new Date(),
              new Date(),
            ]
              .map((value) =>
                value instanceof Date
                  ? "'" + value.toISOString() + "'::timestamptz"
                  : typeof value === 'number'
                    ? String(value)
                    : quote(String(value)),
              )
              .join(',') +
            ')',
        ),
      );
      await tx.execute(
        sql.raw(
          'INSERT INTO connection.mutual_materializations(id,introduction_id,pair_key,mode,actor_account_id,subject_account_id,actor_proof,subject_proof,materialization_key,connection_id,created_at) VALUES(' +
            [
              crypto.randomUUID(),
              input.introductionId,
              pair.join(':'),
              input.mode,
              input.actorAccountId,
              input.subjectAccountId,
              input.actorProof,
              input.subjectProof,
              input.idempotencyKey,
              id,
              new Date(),
            ]
              .map((value) =>
                value instanceof Date
                  ? "'" + value.toISOString() + "'::timestamptz"
                  : quote(String(value)),
              )
              .join(',') +
            ')',
        ),
      );
      await tx.execute(
        sql.raw(
          'INSERT INTO connection.transitions(connection_id,actor_account_id,from_state,to_state,reason,created_at) VALUES(' +
            [id, input.actorAccountId, 'pending', 'accepted', 'mch_mutual', new Date()]
              .map((value) =>
                value instanceof Date
                  ? "'" + value.toISOString() + "'::timestamptz"
                  : value === null
                    ? 'NULL'
                    : quote(String(value)),
              )
              .join(',') +
            ')',
        ),
      );
      return { outcome: 'mutual' as const, connectionReference: id };
    });
  }
}
