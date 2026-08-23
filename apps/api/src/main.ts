import 'reflect-metadata';
import { loadEnv } from '@wai/config';
import { sanitizeText } from '@wai/observability';
import { closeApiApp, createApiApp } from './app.js';
import { APP_LOGGER } from './tokens.js';

/**
 * API entry point. Graceful shutdown mirrors the worker: SIGINT/SIGTERM
 * close the Fastify listener, the infrastructure adapters and the NestJS
 * context — never leaving sockets open.
 */

async function bootstrap(): Promise<void> {
  const config = loadEnv(process.env);
  const app = await createApiApp(config);

  await app.listen(config.apiPort, config.apiHost);

  const logger = app.get(APP_LOGGER);
  logger.info(
    { event: 'api.started', host: config.apiHost, port: config.apiPort },
    'API listening',
  );

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    logger.info({ event: 'api.shutdown.requested', signal }, 'graceful shutdown requested');
    try {
      await closeApiApp(app);
      logger.info({ event: 'api.shutdown.complete' }, 'graceful shutdown complete');
      process.exit(0);
    } catch (error) {
      // Pass the value itself — the shared logger Error policy decides what
      // is safe to emit (production: type/name/stable code only).
      logger.error(
        {
          event: 'api.shutdown.failed',
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
    logger.error(
      {
        event: 'api.unhandled_rejection',
        error: reason instanceof Error ? reason : String(reason),
      },
      'unhandled promise rejection',
    );
    process.exit(1);
  });
  process.on('uncaughtException', (error) => {
    logger.error({ event: 'api.uncaught_exception', error }, 'uncaught exception');
    process.exit(1);
  });
}

bootstrap().catch((error: unknown) => {
  // Bootstrap failure: the structured logger may not exist yet, so the bare
  // message goes through the same content sanitizer before it is printed.
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[wai-api] failed to start: ${sanitizeText(message)}`);
  process.exitCode = 1;
});
