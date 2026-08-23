import { JOB_NAMES, type TranslationRepositoryPort } from '@wai/contracts';
import type { Queue } from 'bullmq';

/**
 * Reconciles PostgreSQL wake intents into BullMQ.  The database row is marked
 * only after queue.add succeeds; a crash in either direction is therefore
 * recoverable, and the deterministic job id makes the replay harmless.
 */
export class TranslationWakeReconciler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running: Promise<void> | null = null;

  constructor(
    private readonly repository: Pick<
      TranslationRepositoryPort,
      'reapExpiredLeases' | 'listDueWakeups' | 'markWakeupEnqueued'
    >,
    private readonly queue: Pick<Queue, 'add'>,
    private readonly intervalMs = 1_000,
    private readonly nowProvider: () => Date = () => new Date(),
  ) {}

  start(): void {
    if (this.timer !== null) return;
    void this.tick().catch(() => undefined);
    this.timer = setInterval(() => void this.tick().catch(() => undefined), this.intervalMs);
    this.timer.unref?.();
  }

  async close(): Promise<void> {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    await this.running?.catch(() => undefined);
  }

  private async tick(): Promise<void> {
    if (this.running !== null) return this.running;
    this.running = this.reconcile().finally(() => {
      this.running = null;
    });
    await this.running;
  }

  private async reconcile(): Promise<void> {
    const now = this.nowProvider();
    await this.repository.reapExpiredLeases({ now, limit: 100 });
    const wakeups = await this.repository.listDueWakeups({ now, limit: 100 });
    for (const wakeup of wakeups) {
      await this.queue.add(
        JOB_NAMES.translationProcess,
        { task_id: wakeup.taskId },
        {
          jobId: `${wakeup.taskId}:wake:${wakeup.attempt}`,
          removeOnComplete: { count: 1000 },
          removeOnFail: { count: 5000 },
        },
      );
      await this.repository.markWakeupEnqueued({
        taskId: wakeup.taskId,
        attempt: wakeup.attempt,
        enqueuedAt: now,
      });
    }
  }
}
