import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { S3MediaStorage } from './s3-media-storage.js';

class FakeClient {
  readonly puts: Array<{ bucket: string; key: string; bytes: Uint8Array; type?: string }> = [];
  async presignedPutObject(bucket: string, key: string, seconds: number) {
    return `https://upload.test/${bucket}/${key}?ttl=${seconds}`;
  }
  async presignedGetObject(bucket: string, key: string, seconds: number) {
    return `https://download.test/${bucket}/${key}?ttl=${seconds}`;
  }
  async statObject(bucket: string, key: string) {
    if (key === 'quarantine/missing')
      throw Object.assign(new Error('missing'), { code: 'NoSuchKey' });
    return { size: 3, etag: 'etag', metaData: { 'content-type': 'image/png' } };
  }
  async getObject(_bucket: string, _key: string) {
    return Readable.from([Buffer.from([1, 2]), Buffer.from([3])]);
  }
  async putObject(
    bucket: string,
    key: string,
    bytes: Uint8Array,
    _size: number,
    metadata?: Record<string, string>,
  ) {
    this.puts.push({
      bucket,
      key,
      bytes,
      ...(metadata?.['Content-Type'] === undefined ? {} : { type: metadata['Content-Type'] }),
    });
  }
  async removeObject() {}
}

describe('S3MediaStorage', () => {
  it('routes quarantine and clean keys to distinct private buckets', async () => {
    const client = new FakeClient();
    const storage = new S3MediaStorage(
      { quarantine: client as never, clean: client as never },
      {
        quarantineBucket: 'private-quarantine',
        cleanBucket: 'private-clean',
      },
    );
    const expires = new Date(Date.now() + 60_000);

    await expect(storage.createUploadTarget('quarantine/a', expires)).resolves.toContain(
      '/private-quarantine/quarantine/a',
    );
    await expect(storage.createCleanAccess('clean/a', expires, 'image/jpeg')).resolves.toContain(
      '/private-clean/clean/a',
    );
    await storage.put('clean/a', new Uint8Array([4, 5]), 'image/jpeg');
    expect(client.puts[0]).toMatchObject({
      bucket: 'private-clean',
      key: 'clean/a',
      type: 'image/jpeg',
    });
  });

  it('performs bounded reads and maps only object-not-found to null', async () => {
    const client = new FakeClient();
    const storage = new S3MediaStorage(
      { quarantine: client as never, clean: client as never },
      {
        quarantineBucket: 'private-quarantine',
        cleanBucket: 'private-clean',
      },
    );
    await expect(storage.read('quarantine/a', 3)).resolves.toEqual(new Uint8Array([1, 2, 3]));
    await expect(storage.read('quarantine/a', 2)).rejects.toThrow('media_object_too_large');
    await expect(storage.stat('quarantine/missing')).resolves.toBeNull();
  });

  it('rejects unknown object prefixes rather than guessing a bucket', async () => {
    const client = new FakeClient();
    const storage = new S3MediaStorage(
      { quarantine: client as never, clean: client as never },
      {
        quarantineBucket: 'private-quarantine',
        cleanBucket: 'private-clean',
      },
    );
    await expect(storage.stat('other/a')).rejects.toThrow('media_object_key_invalid');
  });
});
