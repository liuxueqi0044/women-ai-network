import { JOB_NAMES, translationProcessJobSchema } from '@wai/contracts';
import type { TranslationPipeline, TranslationRunResult } from './pipeline.js';

export async function processTranslationWakeup(
  runner: Pick<TranslationPipeline, 'runOnce'>,
  job: { name: string; data: unknown },
): Promise<TranslationRunResult> {
  if (job.name !== JOB_NAMES.translationProcess) throw new Error('translation_invalid_job');
  const { task_id: taskId } = translationProcessJobSchema.parse(job.data);
  const result: unknown = await runner.runOnce(taskId);
  if (result === true) return 'completed';
  if (result === false) return 'idle';
  return result as TranslationRunResult;
}
