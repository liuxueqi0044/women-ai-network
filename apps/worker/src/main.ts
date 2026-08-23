import 'reflect-metadata';
import { loadEnv } from '@wai/config';
import { sanitizeText } from '@wai/observability';
import { createWorkerApp, type WorkerAppContext } from './worker-app.js';

/**
 * Entry point. Env comes from ../../.env via Node's --env-file-if-exists
 * (see package.json start script) or from the shell.
 *
 * Graceful shutdown contract (FND-01):
 * - SIGINT/SIGTERM stop the BullMQ Worker and the NestJS context;
 * - in-flight jobs are allowed to complete (Worker.close() awaits them);
 * - a hard timeout force-exits if shutdown stalls, so the process never
 *   hangs silently.
 */

const SHUTDOWN_HARD_TIMEOUT_MS = 15_000;

async function bootstrap(): Promise<void> {
  const config = loadEnv(process.env);
  const context: WorkerAppContext = await createWorkerApp(config);
  context.logger.info({ event: 'worker.started', queue: 'foundation' }, 'worker started');

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    context.logger.info(
      { event: 'worker.shutdown.requested', signal },
      'graceful shutdown requested',
    );

    const hardTimeout = setTimeout(() => {
      context.logger.error(
        { event: 'worker.shutdown.forced', timeout_ms: SHUTDOWN_HARD_TIMEOUT_MS },
        'graceful shutdown timed out — forcing exit',
      );
      process.exit(1);
    }, SHUTDOWN_HARD_TIMEOUT_MS);
    hardTimeout.unref();

    try {
      await context.close();
      context.logger.info({ event: 'worker.shutdown.complete' }, 'graceful shutdown complete');
      process.exit(0);
    } catch (error) {
      // Pass the value itself — the shared logger Error policy decides what
      // is safe to emit (production: type/name/stable code only).
      context.logger.error(
        {
          event: 'worker.shutdown.failed',
          error: error instanceof Error ? error : String(error),
        },
        'graceful shutdown failed',
      );
      process.exit(1);
    }
  };

  process.on('SIGINT', () => {
    void shutdown('SIGINT');
  });
  process.on('SIGTERM', () => {
    void shutdown('SIGTERM');
  });

  // Crash signals: log loudly and exit non-zero — never silently swallowed.
  process.on('unhandledRejection', (reason) => {
    context.logger.error(
      {
        event: 'worker.unhandled_rejection',
        error: reason instanceof Error ? reason : String(reason),
      },
      'unhandled promise rejection',
    );
    process.exit(1);
  });
  process.on('uncaughtException', (error) => {
    context.logger.error({ event: 'worker.uncaught_exception', error }, 'uncaught exception');
    process.exit(1);
  });
}

bootstrap().catch((error: unknown) => {
  // Startup failure: the structured logger may not exist yet, so the bare
  // message goes through the same content sanitizer before it is printed.
  console.error(sanitizeText(error instanceof Error ? error.message : String(error)));
  process.exitCode = 1;
});
