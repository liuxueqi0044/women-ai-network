import type { Readable } from 'node:stream';
import type { MediaType, ObjectStat, ObjectStoragePort } from '@wai/contracts';
import { Client } from 'minio';

export interface S3CompatibleClient {
  presignedPutObject(bucket: string, key: string, expirySeconds: number): Promise<string>;
  presignedGetObject(bucket: string, key: string, expirySeconds: number): Promise<string>;
  statObject(
    bucket: string,
    key: string,
  ): Promise<{ size: number; etag?: string; metaData?: Record<string, string> }>;
  getObject(bucket: string, key: string): Promise<Readable>;
  putObject(
    bucket: string,
    key: string,
    content: Uint8Array,
    size: number,
    metadata?: Record<string, string>,
  ): Promise<unknown>;
  removeObject(bucket: string, key: string): Promise<unknown>;
}

export interface S3ClientConfig {
  readonly endPoint: string;
  readonly port: number;
  readonly useSSL: boolean;
  readonly region?: string;
  readonly accessKey: string;
  readonly secretKey: string;
}

export interface S3MediaBuckets {
  readonly quarantineBucket: string;
  readonly cleanBucket: string;
}

export interface S3MediaClients {
  readonly quarantine: S3CompatibleClient;
  readonly clean: S3CompatibleClient;
}

export function createS3CompatibleClient(config: S3ClientConfig): S3CompatibleClient {
  return new Client({
    endPoint: config.endPoint,
    port: config.port,
    useSSL: config.useSSL,
    accessKey: config.accessKey,
    secretKey: config.secretKey,
    ...(config.region === undefined ? {} : { region: config.region }),
  }) as unknown as S3CompatibleClient;
}

/** Private quarantine/clean storage routed by server-generated key prefixes. */
export class S3MediaStorage implements ObjectStoragePort {
  constructor(
    private readonly clients: S3MediaClients,
    private readonly buckets: S3MediaBuckets,
  ) {}

  async createUploadTarget(key: string, expiresAt: Date): Promise<string> {
    const bucket = this.bucketFor(key, 'quarantine');
    return this.clients.quarantine.presignedPutObject(bucket, key, this.expirySeconds(expiresAt));
  }

  async createCleanAccess(key: string, expiresAt: Date, _contentType: MediaType): Promise<string> {
    const bucket = this.bucketFor(key, 'clean');
    return this.clients.clean.presignedGetObject(bucket, key, this.expirySeconds(expiresAt));
  }

  async stat(key: string): Promise<ObjectStat | null> {
    const bucket = this.bucketFor(key);
    const client = this.clientFor(key);
    try {
      const value = await client.statObject(bucket, key);
      const contentType = value.metaData?.['content-type'] ?? value.metaData?.['Content-Type'];
      return {
        size: value.size,
        ...(value.etag === undefined ? {} : { etag: value.etag }),
        ...(contentType === undefined ? {} : { contentType }),
      };
    } catch (error) {
      if (this.isNotFound(error)) return null;
      throw new Error('media_storage_unavailable');
    }
  }

  async read(key: string, maxBytes: number): Promise<Uint8Array> {
    let stream: Readable;
    try {
      stream = await this.clientFor(key).getObject(this.bucketFor(key), key);
    } catch (error) {
      if (this.isNotFound(error)) throw new Error('media_object_not_found');
      throw new Error('media_storage_unavailable');
    }
    const chunks: Buffer[] = [];
    let size = 0;
    try {
      for await (const raw of stream) {
        const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as Uint8Array);
        size += chunk.byteLength;
        if (size > maxBytes) {
          stream.destroy();
          throw new Error('media_object_too_large');
        }
        chunks.push(chunk);
      }
    } catch (error) {
      if (error instanceof Error && error.message === 'media_object_too_large') throw error;
      throw new Error('media_storage_unavailable');
    }
    return new Uint8Array(Buffer.concat(chunks, size));
  }

  async put(key: string, content: Uint8Array, contentType: MediaType): Promise<void> {
    try {
      await this.clientFor(key).putObject(this.bucketFor(key), key, content, content.byteLength, {
        'Content-Type': contentType,
        'Cache-Control': 'private, no-store',
      });
    } catch {
      throw new Error('media_storage_unavailable');
    }
  }

  async delete(key: string): Promise<void> {
    try {
      await this.clientFor(key).removeObject(this.bucketFor(key), key);
    } catch {
      throw new Error('media_storage_unavailable');
    }
  }

  private bucketFor(key: string, required?: 'quarantine' | 'clean'): string {
    const kind = key.startsWith('quarantine/')
      ? 'quarantine'
      : key.startsWith('clean/')
        ? 'clean'
        : null;
    if (kind === null || (required !== undefined && required !== kind)) {
      throw new Error('media_object_key_invalid');
    }
    return kind === 'quarantine' ? this.buckets.quarantineBucket : this.buckets.cleanBucket;
  }

  private clientFor(key: string): S3CompatibleClient {
    if (key.startsWith('quarantine/')) return this.clients.quarantine;
    if (key.startsWith('clean/')) return this.clients.clean;
    throw new Error('media_object_key_invalid');
  }

  private expirySeconds(expiresAt: Date): number {
    const seconds = Math.ceil((expiresAt.getTime() - Date.now()) / 1_000);
    return Math.max(1, Math.min(seconds, 7 * 24 * 60 * 60));
  }

  private isNotFound(error: unknown): boolean {
    if (typeof error !== 'object' || error === null) return false;
    const value = error as { code?: unknown; statusCode?: unknown };
    return value.code === 'NoSuchKey' || value.code === 'NotFound' || value.statusCode === 404;
  }
}
