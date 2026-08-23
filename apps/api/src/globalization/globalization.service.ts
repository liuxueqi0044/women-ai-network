import {
  BadRequestException,
  ConflictException,
  HttpException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  hmacDigest,
  parsePepper,
  GlobalizationAccountUnavailableError,
  GlobalizationIdempotencyConflictError,
  GlobalizationTimeZoneError,
  GlobalizationVersionConflictError,
} from '@wai/db';
import {
  ERROR_CODES,
  globalizationCatalog,
  globalizationCatalogSchema,
  globalizationPreferencesRequestSchema,
  globalizationPreferencesSchema,
  type GlobalizationRepositoryPort,
} from '@wai/contracts';
import type { AppConfig } from '@wai/config';
import { APP_CONFIG } from '../tokens.js';
import { RATE_LIMITER, type RateLimiter } from '../account/ports.js';
import { GLOBALIZATION_REPOSITORY } from './globalization.tokens.js';

@Injectable()
export class GlobalizationService {
  private readonly digestKey: Buffer;
  constructor(
    @Inject(GLOBALIZATION_REPOSITORY) private readonly repo: GlobalizationRepositoryPort,
    @Inject(APP_CONFIG) config: AppConfig,
    @Inject(RATE_LIMITER) private readonly rateLimiter: RateLimiter,
  ) {
    this.digestKey = parsePepper(config.iam.secretPepper);
  }
  catalog() {
    return globalizationCatalogSchema.parse(globalizationCatalog);
  }
  async read(accountId: string) {
    const value = await this.repo.read(accountId);
    if (value === null)
      throw new NotFoundException({
        code: 'NOT_FOUND',
        message: 'Globalization preferences not found',
      });
    return globalizationPreferencesSchema.parse(value);
  }
  async replace(
    accountId: string,
    value: unknown,
    expectedVersion: number,
    idempotencyKey: string,
  ) {
    const parsed = globalizationPreferencesRequestSchema.parse(value);
    const limit = await this.rateLimiter.consume(`globalization:preferences:${accountId}`, 30, 60);
    if (!limit.allowed)
      throw new HttpException(
        { code: ERROR_CODES.RATE_LIMITED, message: 'Too many preference updates; try again later' },
        429,
      );
    const requestDigest = hmacDigest(
      this.digestKey,
      'globalization:preferences',
      JSON.stringify({ expected_version: expectedVersion, ...parsed }),
    );
    try {
      return globalizationPreferencesSchema.parse(
        (
          await this.repo.replace({
            accountId,
            expectedVersion,
            idempotencyKey,
            requestDigest,
            value: parsed,
            now: new Date(),
          })
        ).value,
      );
    } catch (error) {
      throw mapGlobalizationError(error);
    }
  }
}
function mapGlobalizationError(error: unknown): Error {
  if (error instanceof GlobalizationIdempotencyConflictError)
    return new ConflictException({
      code: ERROR_CODES.IDEMPOTENCY_CONFLICT,
      message: 'Idempotency key conflict',
    });
  if (error instanceof GlobalizationVersionConflictError)
    return new ConflictException({
      code: ERROR_CODES.VERSION_CONFLICT,
      message: 'Preference version is stale',
    });
  if (error instanceof GlobalizationTimeZoneError)
    return new BadRequestException({
      code: ERROR_CODES.INVALID_TIME_ZONE,
      message: 'Time zone is not available',
    });
  if (error instanceof GlobalizationAccountUnavailableError)
    return new NotFoundException({
      code: 'NOT_FOUND',
      message: 'Globalization preferences not found',
    });
  return error instanceof Error ? error : new Error('globalization operation failed');
}
