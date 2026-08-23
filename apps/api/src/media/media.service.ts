import { createHash, createHmac, randomUUID } from 'node:crypto';
import { HttpException } from '@nestjs/common';
import type {
  MediaAccessCapability,
  MediaDeliveryCapability,
  MediaAuthorizationPort,
  MediaPurpose,
  ObjectStoragePort,
} from '@wai/contracts';
import { JOB_NAMES } from '@wai/contracts';
import type { PgMediaRepository } from '@wai/db';
import type { QueueProducerAdapter } from '../infra/adapters.js';

export class MediaAccessTokenService {
  constructor(private readonly secret: Uint8Array) {}
  issue(assetId: string, viewerId: string, purpose: MediaPurpose, expiresAt: Date): string {
    const payload = `${assetId}.${viewerId}.${purpose}.${expiresAt.getTime()}`;
    const signature = createHmac('sha256', this.secret).update(payload).digest('base64url');
    return `${Buffer.from(payload).toString('base64url')}.${signature}`;
  }
  verify(
    token: string,
    now = Date.now(),
  ): { assetId: string; viewerId: string; purpose: MediaPurpose; expiresAt: Date } | null {
    const [encoded, signature] = token.split('.');
    if (!encoded || !signature) return null;
    const payload = Buffer.from(encoded, 'base64url').toString('utf8');
    const expected = createHmac('sha256', this.secret).update(payload).digest('base64url');
    if (
      signature.length !== expected.length ||
      !createHmac('sha256', this.secret)
        .update(payload)
        .digest()
        .equals(Buffer.from(signature, 'base64url'))
    )
      return null;
    const [assetId, viewerId, purpose, rawExpiry] = payload.split('.');
    const expiry = Number(rawExpiry);
    return assetId &&
      viewerId &&
      (purpose === 'profile_avatar' || purpose === 'profile_gallery') &&
      Number.isSafeInteger(expiry) &&
      expiry > now
      ? { assetId, viewerId, purpose, expiresAt: new Date(expiry) }
      : null;
  }
}

export class MediaHttpException extends HttpException {
  constructor(status: number, code: string, message: string) {
    super({ code, message }, status);
  }
}

export class MediaService {
  constructor(
    private readonly repository: PgMediaRepository,
    private readonly storage: ObjectStoragePort,
    private readonly authorization: MediaAuthorizationPort,
    private readonly access: MediaAccessTokenService,
    private readonly keyForAsset: (assetId: string) => string,
    private readonly digest: (value: string) => string,
    private readonly cleanKeyForAsset: (assetId: string) => string = (assetId) =>
      `clean/${assetId}`,
    private readonly queue: QueueProducerAdapter = {
      enqueue: async () => undefined,
      check: async () => true,
      close: async () => undefined,
    },
    private readonly uploadsEnabled = true,
  ) {}

  private requireUploadsEnabled(): void {
    if (!this.uploadsEnabled) {
      throw new MediaHttpException(503, 'MEDIA_PROVIDER_UNAVAILABLE', 'Media service unavailable');
    }
  }

  private async provider<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof MediaHttpException) throw error;
      const reason = error instanceof Error ? error.message : '';
      if (reason === 'media_idempotency_conflict') {
        throw new MediaHttpException(
          409,
          'MEDIA_CONFLICT',
          'Media request conflicts with an earlier request',
        );
      }
      if (reason === 'media_intent_not_found') {
        throw new MediaHttpException(404, 'MEDIA_NOT_FOUND', 'Media not found');
      }
      if (reason === 'media_intent_not_completable' || reason === 'media_intent_expired') {
        throw new MediaHttpException(409, 'MEDIA_CONFLICT', 'Media intent is not completable');
      }
      throw new MediaHttpException(503, 'MEDIA_PROVIDER_UNAVAILABLE', 'Media service unavailable');
    }
  }

  private async wakeWorker(jobId: string | null, assetId: string): Promise<void> {
    if (jobId === null) return;
    const repository = this.repository as PgMediaRepository & {
      wakeJob?: (jobId: string, now?: Date) => Promise<boolean>;
    };
    if (typeof repository.wakeJob === 'function') {
      await this.provider(() => repository.wakeJob!(jobId, new Date()));
    }
    await this.provider(() =>
      this.queue.enqueue(
        JOB_NAMES.mediaProcess,
        { job_id: jobId, asset_id: assetId },
        {
          // A new wake-up identity is intentional: BullMQ retains exhausted
          // failed jobs, so replay must not collide with an old wake record.
          jobId: `media-${jobId}-${randomUUID()}`,
          attempts: 5,
          backoff: { type: 'exponential', delay: 5_000 },
        },
      ),
    );
  }

  async createIntent(input: {
    ownerId: string;
    purpose: MediaPurpose;
    declaredSize: number;
    declaredType?: string;
    idempotencyKey: string;
    now?: Date;
  }) {
    // Reject before allocating an authority row; a disabled launch must not
    // accumulate upload intents that can never be fulfilled.
    this.requireUploadsEnabled();
    const now = input.now ?? new Date();
    const expiresAt = new Date(now.getTime() + 15 * 60_000);
    const assetId = randomUUID();
    const payloadDigest = this.digest(
      `${input.ownerId}:${input.purpose}:${input.declaredSize}:${input.declaredType ?? ''}`,
    );
    const idempotencyDigest = this.digest(`${input.ownerId}:idempotency:${input.idempotencyKey}`);
    const quarantineKey = this.keyForAsset(assetId);
    const result = await this.provider(() =>
      this.repository.createIntent({
        assetId,
        ownerId: input.ownerId,
        purpose: input.purpose,
        declaredSize: input.declaredSize,
        declaredType: input.declaredType ?? null,
        idempotencyDigest,
        quarantineKeyDigest: this.digest(`quarantine:${quarantineKey}`),
        payloadDigest,
        expiresAt,
        now,
      }),
    );
    const actualQuarantineKey = this.keyForAsset(result.assetId);
    return {
      asset_id: result.assetId,
      expires_at: result.expiresAt.toISOString(),
      upload_target: await this.provider(() =>
        this.storage.createUploadTarget(actualQuarantineKey, result.expiresAt),
      ),
    };
  }

  async accessAsset(input: {
    viewerId: string;
    assetId: string;
    purpose: MediaPurpose;
    now?: Date;
  }): Promise<MediaAccessCapability> {
    const row = await this.provider(() => this.repository.status(input.assetId));
    if (row === null) {
      await this.provider(() =>
        this.repository.recordAccess(null, input.viewerId, input.purpose, 'denied', 'NOT_FOUND'),
      );
      throw new MediaHttpException(404, 'MEDIA_NOT_FOUND', 'Media not found');
    }
    const authorized = await this.provider(() =>
      this.authorization.canRead({
        viewerId: input.viewerId,
        ownerId: row.ownerId,
        assetId: row.assetId,
        purpose: input.purpose,
      }),
    );
    if (!authorized) {
      await this.provider(() =>
        this.repository.recordAccess(
          row.assetId,
          input.viewerId,
          input.purpose,
          'denied',
          'IDOR_DENIED',
        ),
      );
      throw new MediaHttpException(403, 'MEDIA_ACCESS_DENIED', 'Media access denied');
    }
    if (row.state !== 'clean' || row.rendition === null) {
      await this.provider(() =>
        this.repository.recordAccess(
          row.assetId,
          input.viewerId,
          input.purpose,
          'denied',
          row.retentionState === 'held'
            ? 'HELD'
            : row.state === 'deleted'
              ? 'DELETED'
              : 'NOT_CLEAN',
        ),
      );
      throw new MediaHttpException(404, 'MEDIA_NOT_FOUND', 'Media not found');
    }
    const expiresAt = new Date((input.now ?? new Date()).getTime() + 60_000);
    await this.provider(() =>
      this.repository.recordAccess(
        row.assetId,
        input.viewerId,
        input.purpose,
        'allowed',
        'AUTHORIZED',
      ),
    );
    const token = this.access.issue(row.assetId, input.viewerId, input.purpose, expiresAt);
    return {
      token,
      expiresAt,
      contentType: row.rendition.contentType,
      bytes: row.rendition.bytes,
    };
  }

  async completeIntent(input: {
    ownerId: string;
    assetId: string;
    idempotencyKey: string;
    now?: Date;
  }) {
    this.requireUploadsEnabled();
    const row = await this.provider(() => this.repository.asset(input.assetId));
    if (row === null || row.ownerId !== input.ownerId)
      throw new MediaHttpException(404, 'MEDIA_NOT_FOUND', 'Media not found');
    const completeIdempotencyDigest = this.digest(
      `${input.ownerId}:complete:${input.idempotencyKey}`,
    );
    const replay = await this.provider(() =>
      this.repository.findCompleteReplay({
        assetId: input.assetId,
        ownerId: input.ownerId,
        completeIdempotencyDigest,
      }),
    );
    if (replay !== null) {
      await this.wakeWorker(replay.jobId, input.assetId);
      return replay;
    }
    if (row.state !== 'reserved')
      throw new MediaHttpException(409, 'MEDIA_CONFLICT', 'Media intent is not completable');
    const key = this.keyForAsset(input.assetId);
    const stat = await this.provider(() => this.storage.stat(key));
    if (stat === null)
      throw new MediaHttpException(409, 'MEDIA_CONFLICT', 'Media intent is not completable');
    if (stat.size > 25 * 1024 * 1024 || stat.size !== row.declaredSize)
      throw new MediaHttpException(400, 'MEDIA_INVALID_UPLOAD', 'Media upload is invalid');
    const bytes = await this.provider(() => this.storage.read(key, 25 * 1024 * 1024));
    if (bytes.byteLength !== stat.size || bytes.byteLength !== row.declaredSize)
      throw new MediaHttpException(400, 'MEDIA_INVALID_UPLOAD', 'Media upload is invalid');
    let type: 'image/jpeg' | 'image/png' | 'image/webp';
    try {
      type = mediaMagic(bytes);
    } catch {
      throw new MediaHttpException(400, 'MEDIA_INVALID_UPLOAD', 'Media upload is invalid');
    }
    if (row.declaredType !== null && row.declaredType !== type)
      throw new MediaHttpException(400, 'MEDIA_INVALID_UPLOAD', 'Media upload is invalid');
    const completePayloadDigest = this.digest(
      `${input.ownerId}:complete-payload:${input.assetId}:${bytes.byteLength}:${type}:${createHash('sha256').update(bytes).digest('hex')}`,
    );
    const result = await this.provider(() =>
      this.repository.completeIntent({
        assetId: input.assetId,
        ownerId: input.ownerId,
        completeIdempotencyDigest,
        completePayloadDigest,
        detectedSize: bytes.byteLength,
        detectedType: type,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        ...(input.now === undefined ? {} : { now: input.now }),
      }),
    );
    await this.wakeWorker(result.jobId, input.assetId);
    return result;
  }

  async status(assetId: string, viewerId: string) {
    const row = await this.provider(() => this.repository.status(assetId));
    if (row === null || row.ownerId !== viewerId)
      throw new MediaHttpException(404, 'MEDIA_NOT_FOUND', 'Media not found');
    return {
      asset_id: row.assetId,
      state: row.state,
      detected_type: row.detectedType,
      rendition:
        row.rendition === null
          ? null
          : {
              variant: row.rendition.variant,
              type: row.rendition.contentType,
              width: row.rendition.width,
              height: row.rendition.height,
              bytes: row.rendition.bytes,
            },
    };
  }

  async delete(assetId: string, actorId: string) {
    return this.provider(() => this.repository.markDeleted(assetId, actorId));
  }

  async redeemAccess(input: {
    viewerId: string;
    assetId: string;
    token: string;
    purpose: MediaPurpose;
    now?: Date;
  }): Promise<MediaDeliveryCapability> {
    const verified = this.access.verify(input.token, (input.now ?? new Date()).getTime());
    if (
      verified === null ||
      verified.assetId !== input.assetId ||
      verified.viewerId !== input.viewerId ||
      verified.purpose !== input.purpose
    ) {
      await this.provider(() =>
        this.repository.recordAccess(
          input.assetId,
          input.viewerId,
          input.purpose,
          'denied',
          'EXPIRED',
        ),
      );
      throw new MediaHttpException(403, 'MEDIA_ACCESS_DENIED', 'Media access denied');
    }
    const row = await this.provider(() => this.repository.status(input.assetId));
    if (row === null || row.state !== 'clean' || row.rendition === null) {
      await this.provider(() =>
        this.repository.recordAccess(
          input.assetId,
          input.viewerId,
          input.purpose,
          'denied',
          'NOT_CLEAN',
        ),
      );
      throw new MediaHttpException(404, 'MEDIA_NOT_FOUND', 'Media not found');
    }
    const authorized = await this.provider(() =>
      this.authorization.canRead({
        viewerId: input.viewerId,
        ownerId: row.ownerId,
        assetId: row.assetId,
        purpose: input.purpose,
      }),
    );
    if (!authorized) {
      await this.provider(() =>
        this.repository.recordAccess(
          input.assetId,
          input.viewerId,
          input.purpose,
          'denied',
          'IDOR_DENIED',
        ),
      );
      throw new MediaHttpException(403, 'MEDIA_ACCESS_DENIED', 'Media access denied');
    }
    const rendition = row.rendition;
    await this.provider(() =>
      this.repository.recordAccess(
        input.assetId,
        input.viewerId,
        input.purpose,
        'allowed',
        'AUTHORIZED',
      ),
    );
    return {
      token: input.token,
      expiresAt: verified.expiresAt,
      contentType: rendition.contentType,
      bytes: rendition.bytes,
      deliveryTarget: await this.provider(() =>
        this.storage.createCleanAccess(
          this.cleanKeyForAsset(row.assetId),
          verified.expiresAt,
          rendition.contentType,
        ),
      ),
    };
  }
}

function mediaMagic(bytes: Uint8Array): 'image/jpeg' | 'image/png' | 'image/webp' {
  if (
    bytes.length > 2 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[2] === 0xff &&
    bytes[bytes.length - 2] === 0xff &&
    bytes[bytes.length - 1] === 0xd9
  )
    return 'image/jpeg';
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes
      .slice(-12)
      .every((v, i) => v === [0, 0, 0, 0, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82][i])
  )
    return 'image/png';
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  )
    return 'image/webp';
  throw new Error('media_unsupported_type');
}
