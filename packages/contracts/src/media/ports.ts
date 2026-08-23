import type {
  MediaJobStage,
  MediaPurpose,
  MediaSafeError,
  MediaState,
  MediaType,
} from './enums.js';

export interface ObjectStat {
  readonly size: number;
  readonly etag?: string;
  readonly contentType?: string;
}

export interface ObjectStoragePort {
  createUploadTarget(key: string, expiresAt: Date): Promise<string>;
  createCleanAccess(key: string, expiresAt: Date, contentType: MediaType): Promise<string>;
  stat(key: string): Promise<ObjectStat | null>;
  read(key: string, maxBytes: number): Promise<Uint8Array>;
  put(key: string, content: Uint8Array, contentType: MediaType): Promise<void>;
  delete(key: string): Promise<void>;
}

export interface MalwareScanResult {
  readonly verdict: 'clean' | 'infected' | 'error' | 'timeout';
  readonly engineVersion?: string;
}

export interface MalwareScannerPort {
  scan(
    content: Uint8Array,
    options: { timeoutMs: number; maxBytes: number },
  ): Promise<MalwareScanResult>;
}

export const MEDIA_CONTENT_REASON_CODES = [
  'SEXUAL_CONTENT',
  'SEXUALIZED_MINOR',
  'GRAPHIC_VIOLENCE',
  'SELF_HARM',
  'HATE_OR_EXTREMISM',
  'ILLEGAL_GOODS',
  'PERSONAL_DOCUMENT',
  'CONTACT_OR_QR_SPAM',
  'OTHER_UNSAFE_CONTENT',
] as const;

export type MediaContentReasonCode = (typeof MEDIA_CONTENT_REASON_CODES)[number];

export interface MediaContentModerationResult {
  readonly decision: 'allow' | 'block' | 'review' | 'unavailable';
  readonly reasonCodes: readonly MediaContentReasonCode[];
  /** Stable provider/model version only; never free-form provider prose. */
  readonly providerVersion?: string;
}

/**
 * External visual content review. This port is intentionally limited to
 * content-safety classification: implementations must not infer identity,
 * gender, age, ethnicity, health, attractiveness or other personal traits.
 */
export interface MediaContentModeratorPort {
  review(input: {
    purpose: MediaPurpose;
    contentType: MediaType;
    contentUrl: string;
    timeoutMs: number;
  }): Promise<MediaContentModerationResult>;
}

export interface SanitizedImage {
  readonly content: Uint8Array;
  readonly type: MediaType;
  readonly width: number;
  readonly height: number;
  readonly hasMetadata: boolean;
  readonly animated: boolean;
  readonly pages: number;
  readonly sanitizerVersion: string;
}

export interface ImageSanitizerPort {
  sanitize(
    content: Uint8Array,
    options: {
      maxPixels: number;
      maxWidth: number;
      maxHeight: number;
      maxOutputBytes: number;
    },
  ): Promise<SanitizedImage>;
}

export interface MediaAuthorizationPort {
  canRead(input: {
    viewerId: string;
    ownerId: string;
    assetId: string;
    purpose: MediaPurpose;
  }): Promise<boolean>;
  canDelete(input: { actorId: string; ownerId: string; assetId: string }): Promise<boolean>;
}

export interface MediaAccessCapability {
  readonly token: string;
  readonly expiresAt: Date;
  readonly contentType: MediaType;
  readonly bytes: number;
}

export interface MediaDeliveryCapability extends MediaAccessCapability {
  readonly deliveryTarget: string;
}

export interface MediaRepository {
  createIntent(input: {
    assetId: string;
    ownerId: string;
    purpose: MediaPurpose;
    declaredSize: number;
    declaredType: string | null;
    idempotencyDigest: string;
    quarantineKeyDigest: string;
    payloadDigest: string;
    expiresAt: Date;
  }): Promise<{
    created: boolean;
    assetId: string;
    state: MediaState;
    quarantineKeyDigest: string;
    expiresAt: Date;
  }>;
  completeIntent(input: {
    assetId: string;
    ownerId: string;
    completeIdempotencyDigest: string;
    completePayloadDigest: string;
    detectedSize: number;
    detectedType: MediaType;
    sha256: string;
  }): Promise<{ state: MediaState; jobId: string | null }>;
  claimJob(input: { workerId: string; now: Date; leaseSeconds: number }): Promise<{
    jobId: string;
    assetId: string;
    stage: MediaJobStage;
    leaseToken: string;
    quarantineKeyDigest: string;
  } | null>;
  finishJob(input: {
    jobId: string;
    leaseToken: string;
    state: Extract<MediaState, 'clean' | 'rejected' | 'retryable'>;
    errorCode?: MediaSafeError;
  }): Promise<boolean>;
}
