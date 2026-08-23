import {
  translationProviderOutputSchema,
  type LetterRevisionSnapshot,
  type PublishedLetterRevisionSnapshot,
  type TranslationProvider,
  type TranslationRepositoryPort,
  type TranslationTask,
  type TranslationProviderOutput,
} from '@wai/contracts';

export interface TranslationAuthorizationPort {
  authorize(task: TranslationTask): Promise<{
    allowed: boolean;
    source: LetterRevisionSnapshot | PublishedLetterRevisionSnapshot | null;
    reason?: 'denied' | 'unavailable';
  }>;
}

export type TranslationRunResult = 'completed' | 'retry_wait' | 'failed' | 'idle';

/** One durable wake-up. Queue payloads contain only task_id; all source and
 * authorization facts are re-read from PostgreSQL immediately before and
 * immediately after provider execution. */
export class TranslationPipeline {
  constructor(
    private readonly repository: TranslationRepositoryPort,
    private readonly authorization: TranslationAuthorizationPort,
    private readonly providers: ReadonlyMap<string, TranslationProvider>,
    private readonly workerId: string,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async runOnce(taskId?: string): Promise<TranslationRunResult> {
    const now = this.clock();
    const task = await this.repository.claim(
      taskId === undefined
        ? { workerId: this.workerId, now, leaseSeconds: 60 }
        : { workerId: this.workerId, now, leaseSeconds: 60, taskId },
    );
    if (task === null || task.leaseToken === null) return 'idle';
    const fail = async (errorCode: string, now = this.clock()): Promise<TranslationRunResult> => {
      const outcome = await this.repository.fail({
        taskId: task.id,
        leaseToken: task.leaseToken as string,
        errorCode,
        now,
      });
      if (!outcome.accepted) return 'idle';
      return outcome.state === 'retry_wait' ? 'retry_wait' : 'failed';
    };
    const cancel = async (errorCode: string): Promise<TranslationRunResult> => {
      const accepted = await this.repository.cancel({
        taskId: task.id,
        leaseToken: task.leaseToken as string,
        errorCode,
        now: this.clock(),
      });
      return accepted ? 'failed' : 'idle';
    };
    const provider = this.providers.get(task.key.provider_id);
    if (
      provider === undefined ||
      provider.capability.provider_version !== task.key.provider_version
    ) {
      return fail('PROVIDER_UNAVAILABLE', now);
    }
    try {
      const first = await this.authorization.authorize(task);
      if (!first.allowed || first.source === null || !sameSource(task, first.source)) {
        return first.reason === 'unavailable'
          ? fail('AUTHORIZATION_UNAVAILABLE', now)
          : cancel('SOURCE_NOT_AUTHORIZED');
      }
      let output: TranslationProviderOutput;
      let raw: unknown;
      try {
        raw = await provider.translate({
          sourceLocale: first.source.content.locale,
          targetLocale: task.key.target_locale,
          source: {
            title: first.source.content.title,
            body: first.source.content.body,
          },
        });
      } catch {
        return fail('PROVIDER_NETWORK_ERROR');
      }
      try {
        output = translationProviderOutputSchema.parse(raw);
        if (output.target_locale !== task.key.target_locale)
          return fail('PROVIDER_LOCALE_MISMATCH');
      } catch {
        return fail('PROVIDER_OUTPUT_INVALID');
      }
      const second = await this.authorization.authorize(task);
      if (!second.allowed || second.source === null || !sameSource(task, second.source)) {
        return second.reason === 'unavailable'
          ? fail('AUTHORIZATION_UNAVAILABLE', now)
          : cancel('SOURCE_REVOKED');
      }
      const completed = await this.repository.complete({
        taskId: task.id,
        leaseToken: task.leaseToken,
        output,
        now: this.clock(),
      });
      return completed ? 'completed' : 'idle';
    } catch {
      return fail('PROVIDER_ERROR');
    }
  }
}

function sameSource(
  task: TranslationTask,
  source: {
    letterId: string;
    kind: string;
    revisionId: string;
    revision: number;
    sourceHash: string;
  },
) {
  return (
    task.key.letter_id === source.letterId &&
    task.key.source_kind === source.kind &&
    task.key.source_revision_id === source.revisionId &&
    task.key.source_revision === source.revision &&
    task.key.source_hash === source.sourceHash
  );
}
