import { createHmac } from 'node:crypto';

/** Reconstructable service-owned keys; neither client key nor stable URL is accepted. */
export class MediaObjectKeys {
  constructor(private readonly secret: Uint8Array) {}
  quarantine(assetId: string): string {
    return `quarantine/${this.digest('quarantine', assetId)}`;
  }
  clean(assetId: string, variant = 'clean'): string {
    return `clean/${this.digest(`rendition:${variant}`, assetId)}`;
  }
  digest(context: string, assetId: string): string {
    return createHmac('sha256', this.secret).update(`${context}:${assetId}`, 'utf8').digest('hex');
  }
}
