import type {
  MediaPurpose,
  MediaType,
  ObjectStoragePort,
  MediaAuthorizationPort,
} from '@wai/contracts';

export class UnavailableMediaStorage implements ObjectStoragePort {
  private unavailable(): never {
    throw new Error('media_storage_unavailable');
  }
  createUploadTarget(_key: string, _expiresAt: Date): Promise<string> {
    return Promise.reject(this.unavailable());
  }
  createCleanAccess(_key: string, _expiresAt: Date, _contentType: MediaType): Promise<string> {
    return Promise.reject(this.unavailable());
  }
  stat(_key: string) {
    return Promise.resolve(null);
  }
  read(_key: string, _maxBytes: number): Promise<Uint8Array> {
    return Promise.reject(this.unavailable());
  }
  put(_key: string, _content: Uint8Array, _type: MediaType): Promise<void> {
    return Promise.reject(this.unavailable());
  }
  delete(_key: string): Promise<void> {
    return Promise.reject(this.unavailable());
  }
}

/** Test/dev-only deterministic storage. Never selected by production config. */
export class MemoryMediaStorage implements ObjectStoragePort {
  private readonly objects = new Map<string, Uint8Array>();
  async createUploadTarget(key: string, expiresAt: Date): Promise<string> {
    return `https://media.test/upload/${encodeURIComponent(key)}?expires=${expiresAt.getTime()}`;
  }
  async createCleanAccess(key: string, expiresAt: Date, _contentType: MediaType): Promise<string> {
    return `https://media.test/clean/${encodeURIComponent(key)}?expires=${expiresAt.getTime()}`;
  }
  async stat(key: string) {
    const value = this.objects.get(key);
    return value === undefined ? null : { size: value.byteLength };
  }
  async read(key: string, maxBytes: number) {
    const value = this.objects.get(key);
    if (value === undefined || value.byteLength > maxBytes) throw new Error('object_not_found');
    return value.slice();
  }
  async put(key: string, content: Uint8Array) {
    this.objects.set(key, content.slice());
  }
  async delete(key: string) {
    this.objects.delete(key);
  }
  seed(key: string, content: Uint8Array) {
    this.objects.set(key, content.slice());
  }
}

export class OwnerMediaAuthorization implements MediaAuthorizationPort {
  async canRead(input: {
    viewerId: string;
    ownerId: string;
    assetId: string;
    purpose: MediaPurpose;
  }): Promise<boolean> {
    return input.viewerId === input.ownerId;
  }
  async canDelete(input: { actorId: string; ownerId: string; assetId: string }): Promise<boolean> {
    return input.actorId === input.ownerId;
  }
}
