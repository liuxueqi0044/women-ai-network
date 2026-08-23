import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { detectStaticImageType } from './magic.js';
import { SharpImageSanitizer } from './sharp-sanitizer.js';

async function fixture(): Promise<Buffer> {
  return sharp({
    create: { width: 4, height: 3, channels: 3, background: { r: 22, g: 44, b: 66 } },
  })
    .jpeg()
    .withMetadata({ exif: { IFD0: { Copyright: 'secret' }, GPS: { GPSLatitude: '1,2' } } as never })
    .toBuffer();
}

describe('SharpImageSanitizer', () => {
  it('detects magic bytes and rejects trailing polyglot payload', async () => {
    const source = await fixture();
    expect(detectStaticImageType(source)).toBe('image/jpeg');
    expect(() => detectStaticImageType(Buffer.concat([source, Buffer.from('<script>')]))).toThrow(
      'POLYGLOT',
    );
    expect(() => detectStaticImageType(Buffer.concat([source, Buffer.from([0xd9])]))).toThrow(
      'POLYGLOT',
    );
  });

  it('actually decodes and re-encodes without metadata', async () => {
    const source = await fixture();
    const sanitized = await new SharpImageSanitizer().sanitize(source, {
      maxPixels: 1000,
      maxWidth: 100,
      maxHeight: 100,
      maxOutputBytes: 1024 * 1024,
    });
    expect(sanitized.width).toBe(4);
    expect(sanitized.height).toBe(3);
    expect(sanitized.hasMetadata).toBe(false);
    expect((await sharp(sanitized.content).metadata()).exif).toBeUndefined();
  });

  it('rejects oversized dimensions before publishing bytes', async () => {
    const source = await sharp({
      create: { width: 100, height: 100, channels: 3, background: 'red' },
    })
      .png()
      .toBuffer();
    await expect(
      new SharpImageSanitizer().sanitize(source, {
        maxPixels: 100,
        maxWidth: 1000,
        maxHeight: 1000,
        maxOutputBytes: 1024 * 1024,
      }),
    ).rejects.toThrow('SANITIZER_LIMIT');
  });
});
