import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { Db } from '../client.js';
import { aesGcmEncrypt, aesGcmDecrypt } from '../crypto.js';
import { canonicalJsonHash } from '../eligibility/hashing.js';
import {
  factAudiences,
  factDefinitions,
  factUses,
  idempotencyKeys,
  profileFacts,
  profiles,
  sensitiveAccessAudit,
  snapshots,
} from './schema.js';
import type {
  AgePartition,
  Audience,
  FactSensitivity,
  MatchingMode,
  ProfileRecord,
  ProfileMutationResult,
  ProfileMatchingSafeFact,
  ProfileRepositoryPort,
} from '@wai/contracts';

export class ProfileConcurrencyError extends Error {
  constructor() {
    super('profile version conflict');
    this.name = 'ProfileConcurrencyError';
  }
}
export class ProfileIdempotencyConflictError extends Error {
  constructor() {
    super('idempotency key payload conflict');
    this.name = 'ProfileIdempotencyConflictError';
  }
}
export class ProfileFactError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProfileFactError';
  }
}

type Keyring = ReadonlyMap<string, Buffer>;
type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
type Queryable = Db | Tx;
type StoredFact = {
  fact_key: string;
  state: string;
  source: string;
  sensitivity: FactSensitivity;
  value_json: unknown;
  value_ciphertext: string | null;
  value_nonce: string | null;
  value_key_id: string | null;
  confirmed_at: Date;
};

export class PgProfileRepository implements ProfileRepositoryPort {
  constructor(
    private readonly db: Db,
    private readonly keys: Keyring,
    private readonly keyId: string,
  ) {}

  async getOrCreate(accountId: string): Promise<ProfileRecord> {
    const now = new Date();
    await this.db
      .execute(sql`INSERT INTO ${profiles} (id, account_id, display_name, state, version, created_at, updated_at)
      VALUES (${randomUUID()}, ${accountId}, 'New member', 'draft', 0, ${now}, ${now}) ON CONFLICT (account_id) DO NOTHING`);
    return this.readProfile(accountId);
  }
  async findByProfileId(profileId: string): Promise<ProfileRecord | null> {
    const rows = await this.db.execute<{ account_id: string }>(
      sql`SELECT account_id FROM ${profiles} WHERE id=${profileId}`,
    );
    const accountId = rows.rows[0]?.account_id;
    if (accountId === undefined) return null;
    return this.readProfile(accountId);
  }

  async updateProfile(
    input: Parameters<ProfileRepositoryPort['updateProfile']>[0],
  ): Promise<ProfileMutationResult> {
    return this.mutate(
      input.accountId,
      input.expectedVersion,
      input.idempotencyKey,
      input.payloadDigest,
      async (tx) => {
        const result =
          await tx.execute(sql`UPDATE ${profiles} SET display_name=${input.displayName}, city=${input.city ?? null}, country_code=${input.countryCode ?? null}, version=version+1, updated_at=now()
        WHERE account_id=${input.accountId} AND version=${input.expectedVersion} AND state <> 'deleted' RETURNING id`);
        if (result.rows.length === 0) throw new ProfileConcurrencyError();
        return input.accountId;
      },
    );
  }

  async putFact(
    input: Parameters<ProfileRepositoryPort['putFact']>[0],
  ): Promise<ProfileMutationResult> {
    return this.mutate(
      input.accountId,
      input.expectedVersion,
      input.idempotencyKey,
      input.payloadDigest,
      async (tx) => {
        const defs = await tx.execute<{ sensitivity: FactSensitivity; value_kind: string }>(
          sql`SELECT sensitivity,value_kind FROM ${factDefinitions} WHERE fact_key=${input.factKey}`,
        );
        const definition = defs.rows[0];
        if (definition === undefined) throw new ProfileFactError('unknown_fact');
        if (
          (definition.value_kind === 'boolean' && typeof input.value !== 'boolean') ||
          (definition.value_kind === 'number' && typeof input.value !== 'number') ||
          (['text', 'enum', 'media_ref'].includes(definition.value_kind) &&
            typeof input.value !== 'string')
        )
          throw new ProfileFactError('fact_value_kind_mismatch');
        const valueText = JSON.stringify(input.value);
        const encrypted =
          definition.sensitivity === 'low'
            ? null
            : aesGcmEncrypt(this.key(input.factKey), valueText);
        const updated = await tx.execute(
          sql`UPDATE ${profiles} SET version=version+1, updated_at=now() WHERE account_id=${input.accountId} AND version=${input.expectedVersion} AND state <> 'deleted' RETURNING id`,
        );
        if (updated.rows.length === 0) throw new ProfileConcurrencyError();
        const row = await tx.execute(
          sql`SELECT id FROM ${profiles} WHERE account_id=${input.accountId}`,
        );
        const profileId = String((row.rows[0] as { id: string }).id);
        await tx.execute(sql`INSERT INTO ${profileFacts} (id, profile_id, fact_key, state, source, value_json, value_ciphertext, value_nonce, value_key_id, confirmed_at, version)
        VALUES (${randomUUID()}, ${profileId}, ${input.factKey}, 'confirmed', ${input.source}, ${encrypted === null ? JSON.stringify(input.value) : null}, ${encrypted?.ciphertext ?? null}, ${encrypted?.nonce ?? null}, ${encrypted === null ? null : this.keyId}, now(), 0)
        ON CONFLICT (profile_id, fact_key) DO UPDATE SET state='confirmed', source=excluded.source, value_json=excluded.value_json, value_ciphertext=excluded.value_ciphertext, value_nonce=excluded.value_nonce, value_key_id=excluded.value_key_id, confirmed_at=excluded.confirmed_at, withdrawn_at=NULL, version=${profileFacts.version}+1`);
        return input.accountId;
      },
    );
  }

  async withdrawFact(
    input: Parameters<ProfileRepositoryPort['withdrawFact']>[0],
  ): Promise<ProfileMutationResult> {
    return this.mutate(
      input.accountId,
      input.expectedVersion,
      input.idempotencyKey,
      input.payloadDigest,
      async (tx) => {
        const fact = await tx.execute(
          sql`SELECT 1 FROM ${profileFacts} f JOIN ${profiles} p ON p.id=f.profile_id WHERE p.account_id=${input.accountId} AND f.fact_key=${input.factKey}`,
        );
        if (fact.rows.length === 0) throw new ProfileFactError('fact_not_found');
        const updated = await tx.execute(
          sql`UPDATE ${profiles} SET version=version+1, updated_at=now() WHERE account_id=${input.accountId} AND version=${input.expectedVersion} AND state <> 'deleted' RETURNING id`,
        );
        if (updated.rows.length === 0) throw new ProfileConcurrencyError();
        await tx.execute(
          sql`UPDATE ${profileFacts} f SET state='withdrawn', withdrawn_at=now(), version=f.version+1 FROM ${profiles} p WHERE f.profile_id=p.id AND p.account_id=${input.accountId} AND f.fact_key=${input.factKey}`,
        );
        return input.accountId;
      },
    );
  }

  async setFactUsage(
    input: Parameters<ProfileRepositoryPort['setFactUsage']>[0],
  ): Promise<ProfileMutationResult> {
    return this.mutate(
      input.accountId,
      input.expectedVersion,
      input.idempotencyKey,
      input.payloadDigest,
      async (tx) => {
        await this.assertMode(tx, input.factKey, input.mode);
        await this.bump(tx, input.accountId, input.expectedVersion);
        const p = await this.profileId(tx, input.accountId);
        await tx.execute(
          sql`INSERT INTO ${factUses} (profile_id,fact_key,mode,matching_enabled,updated_at) VALUES (${p},${input.factKey},${input.mode},${input.matchingEnabled},now()) ON CONFLICT (profile_id,fact_key,mode) DO UPDATE SET matching_enabled=excluded.matching_enabled,updated_at=now()`,
        );
        return input.accountId;
      },
    );
  }

  async setFactAudience(
    input: Parameters<ProfileRepositoryPort['setFactAudience']>[0],
  ): Promise<ProfileMutationResult> {
    return this.mutate(
      input.accountId,
      input.expectedVersion,
      input.idempotencyKey,
      input.payloadDigest,
      async (tx) => {
        await this.assertMode(tx, input.factKey, input.mode);
        await this.bump(tx, input.accountId, input.expectedVersion);
        const p = await this.profileId(tx, input.accountId);
        await tx.execute(
          sql`INSERT INTO ${factAudiences} (profile_id,fact_key,mode,audience,age_partition,updated_at) VALUES (${p},${input.factKey},${input.mode},${input.audience},${input.agePartition},now()) ON CONFLICT (profile_id,fact_key,mode) DO UPDATE SET audience=excluded.audience,age_partition=excluded.age_partition,updated_at=now()`,
        );
        return input.accountId;
      },
    );
  }

  async publish(accountId: string, expectedVersion: number, idempotencyKey: string) {
    return this.db.transaction(async (tx) => {
      const publishDigest = canonicalJsonHash({ operation: 'publish', expectedVersion });
      const idempotencyKeyDigest = canonicalJsonHash(idempotencyKey);
      await this.lockIdempotency(tx, accountId, idempotencyKeyDigest);
      const reservation = await tx
        .insert(idempotencyKeys)
        .values({
          accountId,
          idempotencyKeyDigest,
          payloadDigest: publishDigest,
          resultJson: { pending: true },
          createdAt: new Date(),
        })
        .onConflictDoNothing();
      const replay = await tx.execute<{
        payload_digest: string;
        result_json: {
          snapshot_id: string;
          content_hash: string;
          published_at: string;
          profile_version: number;
          profile_state: ProfileRecord['state'];
        };
      }>(
        sql`SELECT payload_digest,result_json FROM ${idempotencyKeys} WHERE account_id=${accountId} AND idempotency_key_digest=${idempotencyKeyDigest} FOR UPDATE`,
      );
      if (reservation.rowCount !== 1 && replay.rows[0] !== undefined) {
        if (replay.rows[0].payload_digest !== publishDigest)
          throw new ProfileIdempotencyConflictError();
        const current = await this.readProfile(accountId, tx);
        return {
          profile: {
            ...current,
            version: replay.rows[0].result_json.profile_version,
            state: replay.rows[0].result_json.profile_state,
          },
          snapshotId: replay.rows[0].result_json.snapshot_id,
          contentHash: replay.rows[0].result_json.content_hash,
          publishedAt: new Date(replay.rows[0].result_json.published_at),
        };
      }
      const p = await this.profileId(tx, accountId);
      const profile = await this.readProfile(accountId, tx);
      if (profile.version !== expectedVersion) throw new ProfileConcurrencyError();
      const payload = {
        profile_id: profile.profileId,
        version: profile.version,
        display_name: profile.displayName,
        ...(profile.city === undefined ? {} : { city: profile.city }),
        ...(profile.countryCode === undefined ? {} : { country_code: profile.countryCode }),
        state: 'active' as const,
        facts: profile.facts
          .filter((f) => f.state === 'confirmed' && f.sensitivity === 'low')
          .map((f) => ({
            fact_key: f.factKey,
            value: f.value,
            confirmed_at: new Date(f.confirmedAt).toISOString(),
          })),
      };
      const hash = canonicalJsonHash(payload);
      const existing = await tx.execute<{ id: string; published_at: Date }>(
        sql`SELECT id,published_at FROM ${snapshots} WHERE profile_id=${p} AND content_hash=${hash}`,
      );
      if (existing.rows[0] !== undefined) {
        const publishedAt = new Date(existing.rows[0].published_at);
        const result = {
          snapshot_id: existing.rows[0].id,
          content_hash: hash,
          published_at: publishedAt.toISOString(),
          profile_version: profile.version,
          profile_state: 'active' as const,
        };
        await tx.execute(
          sql`UPDATE ${idempotencyKeys} SET result_json=${JSON.stringify(result)},created_at=${publishedAt} WHERE account_id=${accountId} AND idempotency_key_digest=${idempotencyKeyDigest}`,
        );
        return {
          profile,
          snapshotId: existing.rows[0].id,
          contentHash: hash,
          publishedAt,
        };
      }
      const snapshotId = randomUUID();
      const publishedAt = new Date();
      await tx.execute(
        sql`INSERT INTO ${snapshots} (id,profile_id,profile_version,content_hash,payload,published_at) VALUES (${snapshotId},${p},${profile.version},${hash},${JSON.stringify(payload)},${publishedAt})`,
      );
      await tx.execute(
        sql`UPDATE ${profiles} SET state='active',updated_at=${publishedAt} WHERE id=${p} AND state='draft'`,
      );
      const result = {
        snapshot_id: snapshotId,
        content_hash: hash,
        published_at: publishedAt.toISOString(),
        profile_version: profile.version,
        profile_state: 'active' as const,
      };
      await tx.execute(
        sql`UPDATE ${idempotencyKeys} SET result_json=${JSON.stringify(result)},created_at=${publishedAt} WHERE account_id=${accountId} AND idempotency_key_digest=${idempotencyKeyDigest}`,
      );
      return {
        profile: { ...profile, state: 'active' as const },
        snapshotId,
        contentHash: hash,
        publishedAt,
      };
    });
  }

  async getSnapshot(accountId: string, snapshotId: string) {
    const rows = await this.db.execute<{
      payload: {
        profile_id: string;
        version: number;
        display_name: string;
        city?: string;
        country_code?: string;
        state: ProfileRecord['state'];
        facts: Array<{
          fact_key: string;
          value: string | number | boolean;
          sensitivity?: FactSensitivity;
          confirmed_at: string;
        }>;
      };
    }>(
      sql`SELECT s.payload FROM ${snapshots} s JOIN ${profiles} p ON p.id=s.profile_id WHERE p.account_id=${accountId} AND s.id=${snapshotId}`,
    );
    const row = rows.rows[0];
    if (row === undefined) return null;
    return {
      profile_id: row.payload.profile_id,
      account_id: accountId,
      display_name: row.payload.display_name,
      ...(row.payload.city === undefined ? {} : { city: row.payload.city }),
      ...(row.payload.country_code === undefined ? {} : { country_code: row.payload.country_code }),
      state: row.payload.state,
      version: row.payload.version,
      facts: row.payload.facts.map((f) => ({
        fact_key: f.fact_key,
        value: f.value,
        sensitivity: 'low' as const,
        state: 'confirmed' as const,
        source: 'user_confirmed' as const,
        confirmed_at: new Date(f.confirmed_at).toISOString(),
      })),
    };
  }

  async appendSensitiveAudit(
    input: Parameters<ProfileRepositoryPort['appendSensitiveAudit']>[0],
  ): Promise<void> {
    await this.db.insert(sensitiveAccessAudit).values({
      actorAccountId: input.actorAccountId,
      subjectAccountId: input.subjectAccountId,
      factKey: input.factKey,
      purpose: input.purpose,
      decision: input.decision,
      policyVersion: input.policyVersion,
      createdAt: new Date(),
    });
  }

  async getAudience(accountId: string, factKey: string, mode: MatchingMode) {
    const rows = await this.db.execute<{ audience: Audience; age_partition: AgePartition }>(
      sql`SELECT a.audience,a.age_partition FROM ${factAudiences} a JOIN ${profiles} p ON p.id=a.profile_id WHERE p.account_id=${accountId} AND a.fact_key=${factKey} AND a.mode=${mode}`,
    );
    const row = rows.rows[0];
    return row === undefined ? null : { audience: row.audience, agePartition: row.age_partition };
  }
  async isMatchingEnabled(accountId: string, factKey: string, mode: MatchingMode) {
    const rows = await this.db.execute<{ matching_enabled: boolean }>(
      sql`SELECT u.matching_enabled FROM ${factUses} u JOIN ${profiles} p ON p.id=u.profile_id WHERE p.account_id=${accountId} AND u.fact_key=${factKey} AND u.mode=${mode}`,
    );
    return rows.rows[0]?.matching_enabled ?? false;
  }

  /** PRF-owned matching-purpose projection. MCH never reads profile tables or
   * decrypts profile facts; this method is the sole safe-view boundary. */
  async matchingFacts(input: {
    subjectAccountId: string;
    viewerAccountId: string;
    mode: MatchingMode;
    purpose: 'matching';
  }) {
    if (input.purpose !== 'matching')
      return { version: 'prf-matching-safe-v1', facts: [] as ProfileMatchingSafeFact[] };
    const rows = await this.db.execute<{
      fact_key: string;
      value_json: unknown;
      value_ciphertext: string | null;
      value_nonce: string | null;
      value_key_id: string | null;
      policy_version: string;
    }>(sql`SELECT f.fact_key,f.value_json,f.value_ciphertext,f.value_nonce,f.value_key_id,d.policy_version
      FROM profile.profile_facts f
      JOIN profile.profiles p ON p.id=f.profile_id
      JOIN profile.fact_definitions d ON d.fact_key=f.fact_key
      JOIN profile.fact_uses u ON u.profile_id=f.profile_id AND u.fact_key=f.fact_key AND u.mode=${input.mode}
      JOIN profile.fact_audiences a ON a.profile_id=f.profile_id AND a.fact_key=f.fact_key AND a.mode=${input.mode}
      JOIN iam.accounts subject_account ON subject_account.id=p.account_id AND subject_account.state='enabled'
      JOIN iam.accounts viewer_account ON viewer_account.id=${input.viewerAccountId} AND viewer_account.state='enabled'
      JOIN verification.membership_cases vm ON vm.account_id=viewer_account.id AND vm.state='approved'
      JOIN verification.membership_cases sm ON sm.account_id=subject_account.id AND sm.state='approved'
      JOIN verification.identity_bindings vi ON vi.account_id=viewer_account.id AND vi.state='active'
      JOIN verification.identity_bindings si ON si.account_id=subject_account.id AND si.state='active'
      JOIN eligibility.age_credentials va ON va.account_id=viewer_account.id AND va.superseded_at IS NULL AND va.valid_until>now()
      JOIN eligibility.age_credentials sa ON sa.account_id=subject_account.id AND sa.superseded_at IS NULL AND sa.valid_until>now()
      WHERE p.account_id=${input.subjectAccountId} AND p.state='active' AND f.state='confirmed'
        AND va.age_band IN ('adult','youth') AND sa.age_band=va.age_band
        AND (SELECT vm_dec.decision FROM eligibility.mode_decisions vm_dec WHERE vm_dec.account_id=viewer_account.id AND vm_dec.mode=${input.mode} ORDER BY vm_dec.evaluated_at DESC LIMIT 1)='allow'
        AND (SELECT sm_dec.decision FROM eligibility.mode_decisions sm_dec WHERE sm_dec.account_id=subject_account.id AND sm_dec.mode=${input.mode} ORDER BY sm_dec.evaluated_at DESC LIMIT 1)='allow'
        AND (SELECT vm_dec.valid_until FROM eligibility.mode_decisions vm_dec WHERE vm_dec.account_id=viewer_account.id AND vm_dec.mode=${input.mode} ORDER BY vm_dec.evaluated_at DESC LIMIT 1)>now()
        AND (SELECT sm_dec.valid_until FROM eligibility.mode_decisions sm_dec WHERE sm_dec.account_id=subject_account.id AND sm_dec.mode=${input.mode} ORDER BY sm_dec.evaluated_at DESC LIMIT 1)>now()
        AND u.matching_enabled=true AND a.audience='verified_members'
        AND a.age_partition = CASE WHEN va.age_band='adult' THEN 'adult' ELSE 'youth' END`);
    const facts: ProfileMatchingSafeFact[] = [];
    for (const row of rows.rows) {
      try {
        const value =
          row.value_ciphertext === null
            ? (row.value_json as string | boolean | number)
            : (JSON.parse(
                aesGcmDecrypt(this.key(row.fact_key, row.value_key_id ?? this.keyId), {
                  ciphertext: row.value_ciphertext,
                  nonce: row.value_nonce ?? '',
                }),
              ) as string | boolean | number);
        if (
          (typeof value !== 'string' && typeof value !== 'boolean' && typeof value !== 'number') ||
          (typeof value === 'string' && value.length === 0)
        )
          continue;
        facts.push({
          factKey: row.fact_key,
          value,
          visible: true,
          policyVersion: row.policy_version,
        });
      } catch {
        // Missing keys, malformed/withdrawn values, and unsupported facts are
        // deliberately represented as unknown by omission.
      }
    }
    return { version: 'prf-matching-safe-v1', facts };
  }

  /** PRF-owned, viewer- and mode-bound identity projection for a matching card. */
  async matchingCard(input: {
    subjectAccountId: string;
    viewerAccountId: string;
    mode: MatchingMode;
    purpose: 'matching';
  }) {
    if (input.purpose !== 'matching') return null;
    const rows = await this.db.execute<{ display_name: string }>(sql`
      SELECT p.display_name
      FROM profile.profiles p
      JOIN iam.accounts subject_account ON subject_account.id=p.account_id AND subject_account.state='enabled'
      JOIN iam.accounts viewer_account ON viewer_account.id=${input.viewerAccountId} AND viewer_account.state='enabled'
      JOIN verification.membership_cases vm ON vm.account_id=viewer_account.id AND vm.state='approved'
      JOIN verification.membership_cases sm ON sm.account_id=subject_account.id AND sm.state='approved'
      JOIN verification.identity_bindings vi ON vi.account_id=viewer_account.id AND vi.state='active'
      JOIN verification.identity_bindings si ON si.account_id=subject_account.id AND si.state='active'
      JOIN eligibility.age_credentials va ON va.account_id=viewer_account.id AND va.superseded_at IS NULL AND va.valid_until>now()
      JOIN eligibility.age_credentials sa ON sa.account_id=subject_account.id AND sa.superseded_at IS NULL AND sa.valid_until>now()
      WHERE p.account_id=${input.subjectAccountId} AND p.state='active'
        AND va.age_band IN ('adult','youth') AND sa.age_band=va.age_band
        AND (SELECT md.decision FROM eligibility.mode_decisions md WHERE md.account_id=viewer_account.id AND md.mode=${input.mode} ORDER BY md.evaluated_at DESC LIMIT 1)='allow'
        AND (SELECT md.decision FROM eligibility.mode_decisions md WHERE md.account_id=subject_account.id AND md.mode=${input.mode} ORDER BY md.evaluated_at DESC LIMIT 1)='allow'
        AND (SELECT md.valid_until FROM eligibility.mode_decisions md WHERE md.account_id=viewer_account.id AND md.mode=${input.mode} ORDER BY md.evaluated_at DESC LIMIT 1)>now()
        AND (SELECT md.valid_until FROM eligibility.mode_decisions md WHERE md.account_id=subject_account.id AND md.mode=${input.mode} ORDER BY md.evaluated_at DESC LIMIT 1)>now()
      LIMIT 1
    `);
    const displayName = rows.rows[0]?.display_name?.trim();
    return displayName ? { displayName } : null;
  }

  private key(_context: string, keyId = this.keyId): Buffer {
    const key = this.keys.get(keyId);
    if (key === undefined) throw new Error('profile_pii_key_unavailable');
    return key;
  }
  private async mutate(
    accountId: string,
    expectedVersion: number,
    idempotencyKey: string,
    digest: string,
    action: (tx: Tx) => Promise<string>,
  ): Promise<ProfileMutationResult> {
    return this.db.transaction(async (tx) => {
      const idempotencyKeyDigest = canonicalJsonHash(idempotencyKey);
      await this.lockIdempotency(tx, accountId, idempotencyKeyDigest);
      const reservation = await tx
        .insert(idempotencyKeys)
        .values({
          accountId,
          idempotencyKeyDigest,
          payloadDigest: digest,
          resultJson: { pending: true },
          createdAt: new Date(),
        })
        .onConflictDoNothing();
      const replay = await tx.execute<{
        payload_digest: string;
        result_json: { profile_id: string; version: number; state: ProfileRecord['state'] };
      }>(
        sql`SELECT payload_digest,result_json FROM ${idempotencyKeys} WHERE account_id=${accountId} AND idempotency_key_digest=${idempotencyKeyDigest} FOR UPDATE`,
      );
      if (reservation.rowCount !== 1 && replay.rows[0] !== undefined) {
        if (replay.rows[0].payload_digest !== digest) throw new ProfileIdempotencyConflictError();
        return {
          profileId: replay.rows[0].result_json.profile_id,
          version: replay.rows[0].result_json.version,
          state: replay.rows[0].result_json.state,
        };
      }
      await this.ensureProfile(tx, accountId);
      await action(tx);
      const profile = await this.readProfile(accountId, tx);
      const result: ProfileMutationResult = {
        profileId: profile.profileId,
        version: profile.version,
        state: profile.state,
      };
      await tx.execute(
        sql`UPDATE ${idempotencyKeys} SET result_json=${JSON.stringify({ profile_id: result.profileId, version: result.version, state: result.state })} WHERE account_id=${accountId} AND idempotency_key_digest=${idempotencyKeyDigest}`,
      );
      return result;
    });
  }
  private async lockIdempotency(
    tx: Tx,
    accountId: string,
    idempotencyKeyDigest: string,
  ): Promise<void> {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${accountId} || ':' || ${idempotencyKeyDigest}, 0))`,
    );
  }
  private async bump(tx: Tx, accountId: string, expected: number): Promise<void> {
    const r = await tx.execute(
      sql`UPDATE ${profiles} SET version=version+1,updated_at=now() WHERE account_id=${accountId} AND version=${expected} AND state <> 'deleted'`,
    );
    if (r.rowCount !== 1) throw new ProfileConcurrencyError();
  }
  private async ensureProfile(tx: Tx, accountId: string): Promise<void> {
    const now = new Date();
    await tx.execute(
      sql`INSERT INTO ${profiles} (id,account_id,display_name,state,version,created_at,updated_at) VALUES (${randomUUID()},${accountId},'New member','draft',0,${now},${now}) ON CONFLICT (account_id) DO NOTHING`,
    );
  }
  private async assertMode(tx: Tx, factKey: string, mode: MatchingMode): Promise<void> {
    const r = await tx.execute<{ allowed_modes: string[] }>(
      sql`SELECT allowed_modes FROM ${factDefinitions} WHERE fact_key=${factKey}`,
    );
    const modes = r.rows[0]?.allowed_modes;
    if (modes === undefined) throw new ProfileFactError('unknown_fact');
    if (!modes.includes(mode)) throw new ProfileFactError('fact_mode_not_allowed');
  }
  private async profileId(tx: Tx, accountId: string): Promise<string> {
    const r = await tx.execute<{ id: string }>(
      sql`SELECT id FROM ${profiles} WHERE account_id=${accountId}`,
    );
    const id = r.rows[0]?.id;
    if (id === undefined) throw new ProfileFactError('profile_not_found');
    return id;
  }
  private async readProfile(accountId: string, tx: Queryable = this.db): Promise<ProfileRecord> {
    const p = await tx.execute<{
      id: string;
      account_id: string;
      display_name: string;
      city: string | null;
      country_code: string | null;
      state: ProfileRecord['state'];
      version: number;
    }>(
      sql`SELECT id,account_id,display_name,city,country_code,state,version FROM ${profiles} WHERE account_id=${accountId}`,
    );
    const row = p.rows[0];
    if (row === undefined) throw new ProfileFactError('profile_not_found');
    const f = await tx.execute<StoredFact>(
      sql`SELECT f.fact_key,f.state,f.source,d.sensitivity,f.value_json,f.value_ciphertext,f.value_nonce,f.value_key_id,f.confirmed_at FROM ${profileFacts} f JOIN ${factDefinitions} d ON d.fact_key=f.fact_key WHERE f.profile_id=${row.id}`,
    );
    return {
      profileId: row.id,
      accountId: row.account_id,
      displayName: row.display_name,
      ...(row.city === null ? {} : { city: row.city }),
      ...(row.country_code === null ? {} : { countryCode: row.country_code }),
      state: row.state,
      version: row.version,
      facts: f.rows.map((x) => ({
        factKey: x.fact_key,
        value:
          x.value_ciphertext === null
            ? (x.value_json as string | boolean | number)
            : JSON.parse(
                aesGcmDecrypt(this.key(x.fact_key, x.value_key_id ?? this.keyId), {
                  ciphertext: x.value_ciphertext,
                  nonce: x.value_nonce ?? '',
                }),
              ),
        sensitivity: x.sensitivity,
        state: x.state as 'proposed' | 'confirmed' | 'withdrawn',
        source: x.source as 'user_confirmed' | 'approved_draft',
        confirmedAt: new Date(x.confirmed_at),
      })),
    };
  }
}

export function createProfileRepository(db: Db, keys: Keyring, keyId: string): PgProfileRepository {
  return new PgProfileRepository(db, keys, keyId);
}
