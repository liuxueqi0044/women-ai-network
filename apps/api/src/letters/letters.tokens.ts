import type { InjectionToken } from '@nestjs/common';
import type { LetterRepositoryPort } from '@wai/contracts';
export const LETTER_REPOSITORY: InjectionToken<LetterRepositoryPort> = Symbol('LETTER_REPOSITORY');
