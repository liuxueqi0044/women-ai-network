import type { InjectionToken } from '@nestjs/common';
import type {
  ConnectionMaterializationPort,
  IntroductionPolicyGate,
  IntroductionRepositoryPort,
} from '@wai/contracts';
export const INTRODUCTION_REPOSITORY: InjectionToken<IntroductionRepositoryPort> =
  Symbol('INTRODUCTION_REPOSITORY');
export const INTRODUCTION_GATE: InjectionToken<IntroductionPolicyGate> =
  Symbol('INTRODUCTION_GATE');
export const INTRODUCTION_MATERIALIZATION: InjectionToken<ConnectionMaterializationPort> = Symbol(
  'INTRODUCTION_MATERIALIZATION',
);
