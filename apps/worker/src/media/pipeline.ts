import { createHash, randomUUID } from 'node:crypto';
import type {
  MalwareScannerPort,
  ImageSanitizerPort,
  MediaContentModeratorPort,
  MediaSafeError,
  ObjectStoragePort,
} from '@wai/contracts';
import type { PgMediaRepository } from '@wai/db';
import { detectStaticImageType, MAX_MEDIA_BYTES, MAX_MEDIA_PIXELS } from './magic.js';
import type { MediaObjectKeys } from './keys.js';

export interface MediaPipelineOptions {
  scannerTimeoutMs?: number;
  moderationTimeoutMs?: number;
  maxOutputBytes?: number;
  maxWidth?: number;
  maxHeight?: number;
}

/** One claimed job, with every failure mapped to a safe terminal/retryable code. */
export class MediaPipeline {
  constructor(
    private readonly repository: PgMediaRepository,
    private readonly storage: ObjectStoragePort,
    private readonly scanner: MalwareScannerPort,
    private readonly contentModerator: MediaContentModeratorPort,
    private readonly sanitizer: ImageSanitizerPort,
    private readonly keys: MediaObjectKeys,
    private readonly options: MediaPipelineOptions = {},
  ) {}

  async process(job: {
    jobId: string;
    assetId: string;
    leaseToken: string;
  }): Promise<'clean' | 'rejected' | 'retryable'> {
    const asset = await this.repository.asset(job.assetId);
    if (asset === null || asset.state === 'deleted' || asset.state === 'held') return 'rejected';
    const quarantineKey = this.keys.quarantine(job.assetId);
    const stat = await this.storage.stat(quarantineKey);
    if (stat === null || stat.size > MAX_MEDIA_BYTES) return this.reject(job, 'OBJECT_MISMATCH');
    const bytes = await this.storage.read(quarantineKey, MAX_MEDIA_BYTES);
    if (bytes.byteLength !== stat.size || bytes.byteLength > MAX_MEDIA_BYTES)
      return this.reject(job, 'OBJECT_MISMATCH');
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    if (asset.sha256 !== null && asset.sha256 !== sha256)
      return this.reject(job, 'OBJECT_MISMATCH');
    let type;
    try {
      type = detectStaticImageType(bytes);
    } catch (error) {
      return this.reject(job, this.safeCode(error, 'UNSUPPORTED_TYPE'));
    }
    if (asset.detectedType !== null && asset.detectedType !== type)
      return this.reject(job, 'MAGIC_MISMATCH');
    if (!(await this.repository.advanceStage({ ...job, to: 'scanning' }))) return 'retryable';
    const verdict = await this.scanner.scan(bytes, {
      timeoutMs: this.options.scannerTimeoutMs ?? 5000,
      maxBytes: MAX_MEDIA_BYTES,
    });
    if (verdict.verdict === 'infected') return this.reject(job, 'MALWARE_DETECTED');
    if (verdict.verdict === 'timeout') return this.retry(job, 'SCANNER_TIMEOUT');
    if (verdict.verdict !== 'clean') return this.retry(job, 'SCANNER_UNAVAILABLE');
    if (!(await this.repository.advanceStage({ ...job, to: 'sanitizing' }))) return 'retryable';
    let sanitized;
    try {
      sanitized = await this.sanitizer.sanitize(bytes, {
        maxPixels: MAX_MEDIA_PIXELS,
        maxWidth: this.options.maxWidth ?? 12000,
        maxHeight: this.options.maxHeight ?? 12000,
        maxOutputBytes: this.options.maxOutputBytes ?? MAX_MEDIA_BYTES,
      });
    } catch (error) {
      const code = this.safeCode(error, 'SANITIZER_FAILED');
      return code === 'SANITIZER_LIMIT' || code === 'ANIMATED_IMAGE' || code === 'MULTIPAGE_IMAGE'
        ? this.reject(job, code)
        : this.retry(job, code);
    }
    const cleanKey = this.keys.clean(job.assetId);
    await this.storage.put(cleanKey, sanitized.content, sanitized.type);
    const review = await this.contentModerator.review({
      purpose: asset.purpose,
      contentType: sanitized.type,
      contentUrl: await this.storage.createCleanAccess(
        cleanKey,
        new Date(Date.now() + 2 * 60_000),
        sanitized.type,
      ),
      timeoutMs: this.options.moderationTimeoutMs ?? 15_000,
    });
    if (review.decision !== 'allow') {
      // Never retain or publish an unapproved clean rendition. Provider prose
      // and reason details are deliberately not persisted in the MED-01 table.
      await this.storage.delete(cleanKey);
      return review.decision === 'unavailable'
        ? this.retry(job, 'SCANNER_UNAVAILABLE')
        : this.reject(job);
    }
    const published = await this.repository.publishRendition({
      jobId: job.jobId,
      leaseToken: job.leaseToken,
      assetId: job.assetId,
      renditionId: randomUUID(),
      cleanKeyDigest: this.keys.digest('rendition:clean', job.assetId),
      contentType: sanitized.type,
      width: sanitized.width,
      height: sanitized.height,
      bytes: sanitized.content.byteLength,
      sha256: createHash('sha256').update(sanitized.content).digest('hex'),
      sanitizerVersion: sanitized.sanitizerVersion,
    });
    if (!published) return 'retryable';
    await this.storage.delete(quarantineKey);
    return 'clean';
  }

  private async reject(
    job: { jobId: string; leaseToken: string },
    code?: MediaSafeError,
  ): Promise<'rejected'> {
    await this.repository.finishJob({
      ...job,
      state: 'rejected',
      ...(code === undefined ? {} : { errorCode: code }),
    });
    return 'rejected';
  }
  private async retry(
    job: { jobId: string; leaseToken: string },
    code: string,
  ): Promise<'retryable'> {
    await this.repository.finishJob({ ...job, state: 'retryable', errorCode: code });
    return 'retryable';
  }
  private safeCode(error: unknown, fallback: MediaSafeError): MediaSafeError {
    const code = error instanceof Error ? error.message : '';
    const safe = [
      'SIZE_LIMIT',
      'UNSUPPORTED_TYPE',
      'MAGIC_MISMATCH',
      'TRUNCATED_IMAGE',
      'ANIMATED_IMAGE',
      'MULTIPAGE_IMAGE',
      'POLYGLOT',
      'MALWARE_DETECTED',
      'SCANNER_UNAVAILABLE',
      'SCANNER_TIMEOUT',
      'SANITIZER_FAILED',
      'SANITIZER_LIMIT',
      'OBJECT_MISMATCH',
    ] as const;
    return (safe as readonly string[]).includes(code) ? (code as MediaSafeError) : fallback;
  }
}

/** Durable queue-facing runner. Every invocation claims in PostgreSQL first. */
export class DurableMediaJobRunner {
  constructor(
    private readonly repository: PgMediaRepository,
    private readonly pipeline: MediaPipeline,
  ) {}

  async runOnce(
    workerId: string,
    now = new Date(),
  ): Promise<'clean' | 'rejected' | 'retryable' | 'idle'> {
    const job = await this.repository.claimJob({ workerId, now, leaseSeconds: 60 });
    if (job === null) return 'idle';
    try {
      return await this.pipeline.process(job);
    } catch {
      // Provider failures are safe retryable state; the lease token prevents
      // this catch from mutating a job reclaimed by another worker.
      await this.repository.finishJob({
        jobId: job.jobId,
        leaseToken: job.leaseToken,
        state: 'retryable',
        errorCode: 'SCANNER_UNAVAILABLE',
        now,
      });
      return 'retryable';
    }
  }
}
