import { z } from 'zod';

export const MEDIA_PURPOSES = ['profile_avatar', 'profile_gallery'] as const;
export const mediaPurposeSchema = z.enum(MEDIA_PURPOSES);
export type MediaPurpose = z.infer<typeof mediaPurposeSchema>;

export const MEDIA_STATES = [
  'reserved',
  'uploaded',
  'scanning',
  'sanitizing',
  'clean',
  'rejected',
  'retryable',
  'deleted',
  'held',
] as const;
export const mediaStateSchema = z.enum(MEDIA_STATES);
export type MediaState = z.infer<typeof mediaStateSchema>;

export const MEDIA_JOB_STAGES = ['scan', 'sanitize', 'publish'] as const;
export const mediaJobStageSchema = z.enum(MEDIA_JOB_STAGES);
export type MediaJobStage = z.infer<typeof mediaJobStageSchema>;

export const MEDIA_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;
export const mediaTypeSchema = z.enum(MEDIA_TYPES);
export type MediaType = z.infer<typeof mediaTypeSchema>;

export const MEDIA_VARIANTS = ['clean'] as const;
export const mediaVariantSchema = z.enum(MEDIA_VARIANTS);
export type MediaVariant = z.infer<typeof mediaVariantSchema>;

export const MEDIA_SAFE_ERRORS = [
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
  'EXPIRED_INTENT',
  'ACCESS_DENIED',
  'LEGAL_HOLD',
] as const;
export const mediaSafeErrorSchema = z.enum(MEDIA_SAFE_ERRORS);
export type MediaSafeError = z.infer<typeof mediaSafeErrorSchema>;

const transitions: Readonly<Record<MediaState, readonly MediaState[]>> = {
  reserved: ['uploaded', 'rejected', 'deleted', 'held'],
  uploaded: ['scanning', 'rejected', 'deleted', 'held'],
  scanning: ['sanitizing', 'rejected', 'retryable', 'deleted', 'held'],
  sanitizing: ['clean', 'rejected', 'retryable', 'deleted', 'held'],
  clean: ['deleted', 'held'],
  rejected: ['deleted', 'held'],
  retryable: ['scanning', 'sanitizing', 'rejected', 'deleted', 'held'],
  deleted: [],
  held: [],
};

export function canTransitionMediaState(from: MediaState, to: MediaState): boolean {
  return transitions[from].includes(to);
}

export function assertMediaTransition(from: MediaState, to: MediaState): void {
  if (!canTransitionMediaState(from, to)) {
    throw new Error(`invalid media state transition: ${from} -> ${to}`);
  }
}
