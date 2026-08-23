import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { loadEnv } from '@wai/config';
import { createS3CompatibleClient, DoubaoVisionModerator, S3MediaStorage } from '@wai/media-infra';
import { ClamAvScanner } from '../apps/worker/src/media/scanner.js';

async function main(): Promise<void> {
  const config = loadEnv(process.env);
  const storageConfig = config.media.storage;
  assert(storageConfig, 'complete MEDIA_S3_* configuration is required');
  const storage = new S3MediaStorage(
    {
      quarantine: createS3CompatibleClient({
        endPoint: storageConfig.endpointHost,
        port: storageConfig.endpointPort,
        useSSL: storageConfig.useSsl,
        ...(storageConfig.region === undefined ? {} : { region: storageConfig.region }),
        accessKey: storageConfig.quarantineAccessKey,
        secretKey: storageConfig.quarantineSecretKey,
      }),
      clean: createS3CompatibleClient({
        endPoint: storageConfig.endpointHost,
        port: storageConfig.endpointPort,
        useSSL: storageConfig.useSsl,
        ...(storageConfig.region === undefined ? {} : { region: storageConfig.region }),
        accessKey: storageConfig.cleanAccessKey,
        secretKey: storageConfig.cleanSecretKey,
      }),
    },
    {
      quarantineBucket: storageConfig.quarantineBucket,
      cleanBucket: storageConfig.cleanBucket,
    },
  );

  const id = randomUUID();
  const quarantineKey = `quarantine/provider-smoke-${id}`;
  const cleanKey = `clean/provider-smoke-${id}`;
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z8XcAAAAASUVORK5CYII=',
    'base64',
  );
  try {
    const uploadTarget = await storage.createUploadTarget(
      quarantineKey,
      new Date(Date.now() + 60_000),
    );
    const browserOrigin = process.env['MEDIA_SMOKE_BROWSER_ORIGIN'] ?? 'http://localhost:3000';
    const preflight = await fetch(uploadTarget, {
      method: 'OPTIONS',
      headers: {
        origin: browserOrigin,
        'access-control-request-method': 'PUT',
        'access-control-request-headers': 'content-type',
      },
    });
    assert(preflight.ok, `presigned upload CORS preflight failed (${preflight.status})`);
    assert.equal(
      preflight.headers.get('access-control-allow-origin'),
      browserOrigin,
      'object storage did not authorize the expected browser origin',
    );
    const upload = await fetch(uploadTarget, {
      method: 'PUT',
      headers: { 'content-type': 'image/png' },
      body: png,
    });
    assert(upload.ok, `presigned quarantine upload failed (${upload.status})`);
    assert.equal((await storage.stat(quarantineKey))?.size, png.byteLength);
    assert.deepEqual(await storage.read(quarantineKey, 1_024), new Uint8Array(png));

    await storage.put(cleanKey, png, 'image/png');
    const cleanTarget = await storage.createCleanAccess(
      cleanKey,
      new Date(Date.now() + 60_000),
      'image/png',
    );
    const cleanDownload = await fetch(cleanTarget);
    assert(cleanDownload.ok, `presigned clean download failed (${cleanDownload.status})`);
    assert.deepEqual(new Uint8Array(await cleanDownload.arrayBuffer()), new Uint8Array(png));

    const scanner = new ClamAvScanner(config.media.scanner.host, config.media.scanner.port);
    const cleanScan = await scanner.scan(png, { timeoutMs: 20_000, maxBytes: 1_024 });
    assert.equal(cleanScan.verdict, 'clean');
    const eicar = new TextEncoder().encode(
      'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*',
    );
    const infectedScan = await scanner.scan(eicar, { timeoutMs: 20_000, maxBytes: 1_024 });
    assert.equal(infectedScan.verdict, 'infected');

    let doubao: 'skipped' | 'allow' = 'skipped';
    if (process.env['MEDIA_DOUBAO_SMOKE'] === 'true') {
      const moderation = config.media.contentModeration;
      assert(moderation, 'ARK_API_KEY and ARK_VISION_MODEL are required for Doubao smoke');
      assert(storageConfig.useSsl, 'Doubao smoke requires an HTTPS object-store endpoint');
      const result = await new DoubaoVisionModerator({
        apiBaseUrl: moderation.apiBaseUrl,
        apiKey: moderation.apiKey,
        model: moderation.model,
      }).review({
        purpose: 'profile_avatar',
        contentType: 'image/png',
        contentUrl: cleanTarget,
        timeoutMs: moderation.timeoutMs,
      });
      assert.equal(result.decision, 'allow', 'Doubao did not approve the safe smoke image');
      doubao = 'allow';
    }

    process.stdout.write(
      `${JSON.stringify({ storage: 'pass', browserCors: 'pass', clamavClean: 'pass', clamavEicar: 'pass', doubao })}\n`,
    );
  } finally {
    await Promise.allSettled([storage.delete(quarantineKey), storage.delete(cleanKey)]);
  }
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'media provider smoke failed';
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
