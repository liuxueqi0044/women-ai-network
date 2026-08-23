import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import globalSetup from './real-global-setup.js';

function run(command: string, args: string[], cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: process.env,
      stdio: 'inherit',
      ...(process.platform === 'win32' ? { shell: true } : {}),
    });
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      if (error === undefined) resolve();
      else reject(error);
    };
    child.once('error', (error) =>
      finish(new Error(`${command} failed to start: ${error.message}`)),
    );
    child.once('exit', (code, signal) => {
      if (code === 0) finish();
      else finish(new Error(`${command} exited with ${code ?? `signal ${signal ?? 'unknown'}`}`));
    });
  });
}

async function main() {
  const rootDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
  const apiPort = process.env['WAI_E2E_API_PORT'] ?? '3187';
  const webPort = process.env['WAI_E2E_WEB_PORT'] ?? '3188';
  process.env['NEXT_PUBLIC_API_BASE_URL'] = `http://127.0.0.1:${apiPort}/v1`;
  process.env['WAI_E2E_WEB_ORIGIN'] = `http://127.0.0.1:${webPort}`;
  await run('pnpm', ['build:packages'], rootDirectory);
  await run('pnpm', ['--filter', '@wai/api', 'build'], rootDirectory);
  await run('pnpm', ['--filter', '@wai/web', 'build'], rootDirectory);
  let teardown: (() => Promise<void>) | undefined;
  try {
    teardown = await globalSetup();
    const webDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    await run(
      process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm',
      ['exec', 'playwright', 'test', '--config', 'playwright.real.config.ts'],
      webDirectory,
    );
  } finally {
    await teardown?.();
  }
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'real E2E runner failed';
  console.error(`[glo-real-e2e] ${message}`);
  process.exitCode = 1;
});
