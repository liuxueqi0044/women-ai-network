import sharp from 'sharp';
import type { ImageSanitizerPort, SanitizedImage } from '@wai/contracts';
import { detectStaticImageType } from './magic.js';

export class SharpImageSanitizer implements ImageSanitizerPort {
  constructor(private readonly version = `sharp-${sharp.versions.sharp}`) {}

  async sanitize(
    content: Uint8Array,
    options: { maxPixels: number; maxWidth: number; maxHeight: number; maxOutputBytes: number },
  ): Promise<SanitizedImage> {
    const type = detectStaticImageType(content);
    const image = sharp(content, {
      failOn: 'error',
      limitInputPixels: options.maxPixels,
      sequentialRead: true,
      pages: 1,
    });
    let metadata;
    try {
      metadata = await image.metadata();
    } catch (error) {
      const message = error instanceof Error ? error.message : '';
      throw new Error(
        message.toLowerCase().includes('pixel') ? 'SANITIZER_LIMIT' : 'SANITIZER_FAILED',
      );
    }
    const width = metadata.width ?? 0;
    const height = metadata.height ?? 0;
    const pages = metadata.pages ?? 1;
    if (
      !width ||
      !height ||
      width > options.maxWidth ||
      height > options.maxHeight ||
      width * height > options.maxPixels
    )
      throw new Error('SANITIZER_LIMIT');
    if (
      (metadata.pages !== undefined && metadata.pages > 1) ||
      (metadata.pageHeight !== undefined && metadata.pageHeight !== height)
    )
      throw new Error('MULTIPAGE_IMAGE');
    if ((metadata.delay?.length ?? 0) > 1) throw new Error('ANIMATED_IMAGE');
    const output = await image
      .rotate()
      .toFormat(type === 'image/jpeg' ? 'jpeg' : type === 'image/png' ? 'png' : 'webp', {
        effort: 4,
      })
      .toBuffer();
    if (output.byteLength > options.maxOutputBytes) throw new Error('SANITIZER_LIMIT');
    // Re-run the byte-level check on the output; it must be a complete single image.
    const outputType = detectStaticImageType(output);
    const post = await sharp(output, { failOn: 'error', pages: 1 }).metadata();
    if ((post.pages ?? 1) !== 1 || (post.delay?.length ?? 0) > 1) throw new Error('ANIMATED_IMAGE');
    return {
      content: output,
      type: outputType,
      width,
      height,
      hasMetadata: false,
      animated: false,
      pages,
      sanitizerVersion: this.version,
    };
  }
}
